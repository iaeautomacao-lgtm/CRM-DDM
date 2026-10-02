import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { WahaService } from '../waha/waha.service';
import { RiskService } from '../risk/risk.service';
import { SupabaseService } from '../common/supabase/supabase.service';

@Injectable()
export class MessageQueueWorker implements OnModuleInit {
  private readonly logger = new Logger(MessageQueueWorker.name);
  private processing = false;
  private openai: OpenAI;

  constructor(
    private config: ConfigService,
    private waha: WahaService,
    private risk: RiskService,
    private supabase: SupabaseService
  ) {
    this.openai = new OpenAI({ apiKey: config.get('OPENAI_API_KEY') });
  }

  // QUEUE_WORKER_MODE define quem consome a fila (explícito, padrão 'cron'):
  // - cron: só processa quando /message-queue/process-tick é chamado;
  // - polling: loop interno a cada 5s (apenas em processo de longa duração);
  // - disabled: não consome (ex.: quando o CRM principal é o consumidor).
  // Valor inválido derruba o boot de propósito, para não rodar no modo errado.
  onModuleInit() {
    const mode = this.config.get<string>('QUEUE_WORKER_MODE') || 'cron';
    if (!['cron', 'polling', 'disabled'].includes(mode)) throw new Error('QUEUE_WORKER_MODE inválido');
    if (mode !== 'polling') {
      this.logger.log(`Worker em modo ${mode} — polling automático desativado`);
      return;
    }
    this.logger.log('Worker de envio iniciado — polling a cada 5s');
    this.loop();
  }

  private loop() {
    setTimeout(async () => {
      if (!this.processing) {
        this.processing = true;
        try {
          await this.processNext();
        } catch (err: any) {
          this.logger.error(`Erro no loop: ${err.message}`);
        } finally {
          this.processing = false;
        }
      }
      this.loop();
    }, 5000);
  }

  async runOnce() {
    if (this.config.get<string>('QUEUE_WORKER_MODE') === 'disabled') return { skipped: true };
    if (this.processing) return { skipped: true };
    this.processing = true;
    try {
      await this.processNext();
      return { processed: true };
    } catch (err: any) {
      this.logger.error(`Erro no cron tick: ${err.message}`);
      return { error: err.message };
    } finally {
      this.processing = false;
    }
  }

  private async processNext() {
    const now = new Date().toISOString();

    // ✅ FIX: usando disp_message_queue (tabela real) em vez da view message_queue
    // A view causava PGRST201 por ambiguidade no relacionamento com contacts
    const { data: item, error: queryError } = await this.supabase.db
      .from('disp_message_queue')
      .select('*, contacts!disp_message_queue_contact_id_fkey(nome, telefone_normalizado)')
      .eq('status', 'agendado')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .single();

    if (queryError && queryError.code !== 'PGRST116') {
      this.logger.error(`Erro na query: ${queryError.message} [${queryError.code}]`);
    }

    if (!item) return;

    this.logger.log(`Processando: ${item.id} | tipo: ${item.tipo} | scheduled: ${item.scheduled_at}`);

    // Claim atômico agendado -> enviando (disparador/database/004). A RPC
    // trava campanha e sessão, confere campanha em execução, até 4 envios
    // simultâneos por sessão e a quota horária. Se outro consumidor venceu
    // ou o limite está cheio, retorna false e o item fica para depois.
    const { data: claimed, error: claimError } = await this.supabase.db
      .rpc('claim_legacy_dispatch_item', { p_item_id: item.id });
    if (claimError) throw claimError;
    if (!claimed) return;

    // externalAttempted: já chamamos o WAHA para este item? A partir daí um
    // erro NÃO pode reagendar o envio (o provedor pode ter aceitado).
    // acceptedMessageId: ID retornado pelo WAHA, guardado para reconciliação.
    let externalAttempted = false;
    let acceptedMessageId: string | undefined;
    try {
      // Verifica se campanha ainda está em execução
      const { data: campaign } = await this.supabase.db
        .from('campaigns')
        .select('status, janela_inicio, janela_fim')
        .eq('id', item.campaign_id)
        .single();

      if (!campaign || campaign.status !== 'em_execucao') {
        await this.supabase.db
          .from('disp_message_queue') // ✅ FIX
          .update({ status: 'pausado' })
          .eq('id', item.id);
        return;
      }

      const janela =
        campaign.janela_inicio &&
        campaign.janela_fim &&
        campaign.janela_inicio !== '00:00:00' &&
        campaign.janela_fim !== '23:59:00' &&
        campaign.janela_inicio !== '00:00' &&
        campaign.janela_fim !== '23:59';

      if (janela && !this.isWithinSendWindow(campaign.janela_inicio, campaign.janela_fim)) {
        this.logger.warn(
          `Fora da janela de envio (${campaign.janela_inicio}-${campaign.janela_fim}). Item ${item.id} adiado.`
        );
        const amanha = new Date();
        amanha.setDate(amanha.getDate() + 1);
        const [h, m] = campaign.janela_inicio.split(':');
        amanha.setHours(parseInt(h), parseInt(m), 0, 0);
        await this.supabase.db
          .from('disp_message_queue') // ✅ FIX
          .update({
            status: 'agendado',
            scheduled_at: amanha.toISOString(),
            updated_at: now,
          })
          .eq('id', item.id);
        return;
      }

      // Verifica se pode enviar pela sessão
      const canSend = await this.waha.canSend(item.session_id);
      if (!canSend.allowed) {
        throw new Error(`Envio bloqueado: ${canSend.reason}`);
      }

      // Busca nome da sessão WAHA
      const { data: session } = await this.supabase.db
        .from('whatsapp_sessions')
        .select('waha_session_name')
        .eq('id', item.session_id)
        .single();

      if (!session) throw new Error('Sessão não encontrada');

      const sessionName = session.waha_session_name;
      const telefone = (item.contacts as any)?.telefone_normalizado || item.mensagem_final;
      const contact = item.contacts as any;
      const tipo: string = item.tipo || 'texto';

      let result: { id: string };

      if (tipo === 'ia') {
        const prompt = item.mensagem_final;
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'Você é um assistente de vendas para WhatsApp. Gere uma mensagem natural, sem parecer spam. Responda APENAS com a mensagem, sem explicações.',
            },
            {
              role: 'user',
              content: `Contato: nome=${contact?.nome || ''}. Prompt: ${prompt}`,
            },
          ],
          max_tokens: 500,
        });
        const textoGerado = completion.choices[0]?.message?.content || prompt;
        externalAttempted = true;
        result = await this.waha.sendText(sessionName, telefone, textoGerado);
      } else if (tipo === 'imagem') {
        externalAttempted = true;
        result = await this.waha.sendImage(sessionName, telefone, item.media_url, item.mensagem_final || undefined);
      } else if (tipo === 'video') {
        externalAttempted = true;
        result = await this.waha.sendVideo(sessionName, telefone, item.media_url, item.mensagem_final || undefined);
      } else if (tipo === 'audio') {
        externalAttempted = true;
        result = await this.waha.sendAudio(sessionName, telefone, item.media_url);
      } else if (tipo === 'arquivo') {
        externalAttempted = true;
        result = await this.waha.sendFile(sessionName, telefone, item.media_url, item.mensagem_final || undefined);
      } else if (tipo === 'ligacao') {
        externalAttempted = true;
        // 1. Inicia a chamada via WaCalls
        const callRes = await this.waha.startCall(sessionName, telefone);
        const callId = callRes.call?.callId;
        if (!callId) {
          throw new Error('Não foi possível gerar um CallID para a ligação');
        }

        // 2. Aguarda a ligação ser atendida (connected)
        let isConnected = false;
        let ended = false;

        // Monitora a cada 2 segundos por no máximo 25 vezes (50 segundos total)
        for (let attempt = 0; attempt < 25; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const callInfo = await this.waha.getCallStatus(sessionName, callId);
            if (callInfo.status === 'connected') {
              isConnected = true;
              break;
            }
            if (callInfo.ended || callInfo.status === 'ended') {
              ended = true;
              break;
            }
          } catch (statusErr) {
            this.logger.warn(`[Queue Worker] Failed to check status for call ${callId}: ${statusErr.message}`);
          }
        }

        if (!isConnected) {
          throw new Error(
            ended ? 'Chamada rejeitada ou encerrada pelo destinatário' : 'Chamada não atendida (tempo esgotado)'
          );
        }

        // 3. Toca o áudio associado na ligação
        await this.waha.playAudio(sessionName, callId, item.media_url);
        result = { id: `call_${callId}` };
      } else {
        externalAttempted = true;
        result = await this.waha.sendText(sessionName, telefone, item.mensagem_final);
      }

      acceptedMessageId = result.id;
      const { error: confirmationError } = await this.supabase.db
        .from('disp_message_queue')
        .update({
          status: 'enviado',
          sent_at: new Date().toISOString(),
          waha_message_id: result.id,
          tentativas: (item.tentativas || 0) + 1,
        })
        .eq('id', item.id);
      if (confirmationError) throw confirmationError;

      await this.supabase.db.from('message_logs').insert({
        queue_id: item.id,
        campaign_id: item.campaign_id,
        contact_id: item.contact_id,
        session_id: item.session_id,
        direcao: 'saida',
        mensagem: item.mensagem_final,
        status: 'enviado',
        waha_message_id: result.id,
      });

      await this.waha.incrementDailyCount(item.session_id);
      await this.updateMetrics(item.campaign_id, 'enviado');

      this.logger.log(`Enviado para ${telefone} (tipo: ${tipo})`);
    } catch (err: any) {
      this.logger.error(`Erro no envio (item ${item.id}): ${err.message}`);

      if (externalAttempted) {
        // No automatic replay after a transport failure or local persistence
        // failure. The provider may already have accepted the operation.
        const { error } = await this.supabase.db
          .from('disp_message_queue')
          .update({
            erro: 'Resultado externo pendente de reconciliação; não reenviar automaticamente',
            ...(acceptedMessageId ? { waha_message_id: acceptedMessageId } : {}),
          })
          .eq('id', item.id)
          .eq('status', 'enviando');
        if (error) this.logger.error(`Falha ao registrar reconciliação: ${error.message}`);
        return;
      }

      const tentativas = (item.tentativas || 0) + 1;
      const novoStatus = tentativas >= 3 ? 'erro' : 'agendado';
      const newScheduled = tentativas < 3 ? new Date(Date.now() + tentativas * 60 * 1000).toISOString() : undefined;

      await this.supabase.db
        .from('disp_message_queue')
        .update({
          // ✅ FIX
          status: novoStatus,
          erro: err.message,
          tentativas,
          ...(newScheduled ? { scheduled_at: newScheduled } : {}),
        })
        .eq('id', item.id);

      await this.updateMetrics(item.campaign_id, 'erro');
    }
  }

  private isWithinSendWindow(inicio: string, fim: string): boolean {
    const now = new Date();
    const [hInicio, mInicio] = inicio.split(':').map(Number);
    const [hFim, mFim] = fim.split(':').map(Number);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= hInicio * 60 + mInicio && nowMinutes <= hFim * 60 + mFim;
  }

  private async updateMetrics(campaignId: string, tipo: 'enviado' | 'erro') {
    const field = tipo === 'enviado' ? 'total_enviados' : 'total_erros';
    await this.supabase.db.rpc('increment_campaign_metric', {
      p_campaign_id: campaignId,
      p_field: field,
    });
  }
}
