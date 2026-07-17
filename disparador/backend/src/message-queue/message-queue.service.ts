import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';
import { BlacklistService } from '../blacklist/blacklist.service';

@Injectable()
export class MessageQueueService {
  private readonly logger = new Logger(MessageQueueService.name);

  constructor(
    private supabase: SupabaseService,
    private blacklist: BlacklistService,
  ) {}

  private interpolate(text: string, contact: any): string {
    return (text || '')
      .replace(/\{\{nome\}\}/gi, contact.nome || '')
      .replace(/\{\{telefone\}\}/gi, contact.telefone_normalizado || '')
      .replace(/\{\{curso\}\}/gi, contact.curso || '')
      .replace(/\{\{categoria\}\}/gi, contact.categoria || '');
  }

  /** Enfileira todos os contatos de uma campanha */
  async enqueueCampaignContacts(campaignId: string) {
    const { data: campaign } = await this.supabase.db
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (!campaign) return;

    const mensagens: any[] = Array.isArray(campaign.mensagens) ? campaign.mensagens : [];
    if (mensagens.length === 0) {
      throw new BadRequestException('Campanha sem mensagens configuradas. Verifique se a migração de banco (002) foi executada.');
    }

    const sessionIds: string[] = Array.isArray(campaign.session_ids) ? campaign.session_ids : [];
    if (sessionIds.length === 0) {
      throw new BadRequestException('Campanha sem sessões configuradas. Verifique se a migração de banco (002) foi executada e se a campanha foi criada com instâncias selecionadas.');
    }

    // Carrega contatos filtrados por tags (ou todos se sem filtro)
    const tagsFiltro: string[] = Array.isArray(campaign.tags_filtro) ? campaign.tags_filtro : [];

    const { data: allContacts, error: contactsError } = await this.supabase.db
      .from('contacts')
      .select('id, nome, telefone_normalizado, tags, status_contato, curso, categoria')
      .neq('status_contato', 'removido')
      .neq('status_contato', 'bloqueado');

    if (contactsError) {
      throw new BadRequestException(`Erro ao carregar contatos: ${contactsError.message}`);
    }

    if (!allContacts || allContacts.length === 0) {
      throw new BadRequestException('Nenhum contato ativo encontrado. Cadastre contatos antes de disparar.');
    }

    const contacts = tagsFiltro.length > 0
      ? allContacts.filter(c => {
          const contactTags: string[] = Array.isArray(c.tags) ? c.tags : [];
          return tagsFiltro.some(t => contactTags.includes(t));
        })
      : allContacts;

    if (contacts.length === 0) {
      throw new BadRequestException(`Nenhum contato com as tags [${tagsFiltro.join(', ')}]. Verifique os contatos ou remova o filtro de TAG.`);
    }

    const minDelay = (campaign.intervalo_min || 90) * 1000;
    const maxDelay = (campaign.intervalo_max || 300) * 1000;
    const intraDelay = 3000; // 3s entre mensagens do mesmo contato

    let contactDelay = 0;
    let enqueued = 0;

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];

      const blocked = await this.blacklist.isBlacklisted(contact.telefone_normalizado);
      if (blocked) continue;

      // Sorteia sessão aleatória para este contato
      const sessionId = sessionIds[Math.floor(Math.random() * sessionIds.length)];

      // Pausas anti-spam
      if (i > 0 && i % 100 === 0) contactDelay += 60 * 60 * 1000;
      else if (i > 0 && i % 20 === 0) contactDelay += 10 * 60 * 1000;

      for (let j = 0; j < mensagens.length; j++) {
        const msg = mensagens[j];
        const msgDelay = contactDelay + j * intraDelay;
        const scheduledAt = new Date(Date.now() + msgDelay).toISOString();

        const mensagemFinal = msg.tipo === 'texto' || msg.tipo === 'ia'
          ? this.interpolate(msg.conteudo || msg.prompt || '', contact)
          : msg.conteudo || '';

        const { data: queueItem, error: insertError } = await this.supabase.db
          .from('disp_message_queue')
          .insert({
            campaign_id: campaignId,
            contact_id: contact.id,
            session_id: sessionId,
            mensagem_final: mensagemFinal,
            status: 'agendado',
            tipo: msg.tipo || 'texto',
            media_url: msg.url || null,
            scheduled_at: scheduledAt,
          })
          .select()
          .single();

        if (insertError) {
          this.logger.error(`Erro DB (contato ${contact.id}, msg ${j}, tipo ${msg.tipo}): ${insertError.message}`);
        } else if (queueItem) {
          enqueued++;
        }
      }

      // Avança o contactDelay para DEPOIS da última mensagem deste contato,
      // depois adiciona o intervalo randômico — garante que o próximo contato
      // começa pelo menos intervalo_min após o fim da sequência anterior.
      contactDelay += (mensagens.length - 1) * intraDelay + minDelay + Math.random() * (maxDelay - minDelay);
    }

    if (enqueued === 0) {
      throw new BadRequestException('Nenhuma mensagem foi enfileirada. Verifique se a migração de banco (002) foi executada completamente (incluindo colunas media_url e constraint de tipo).');
    }

    // Atualiza total de contatos nas métricas
    await this.supabase.db
      .from('campaign_metrics')
      .update({ total_contatos: contacts.length })
      .eq('campaign_id', campaignId);

    this.logger.log(`Enfileiradas ${enqueued} mensagens para ${contacts.length} contatos na campanha ${campaignId}`);
  }

  async cancelCampaignQueue(campaignId: string) {
    await this.supabase.db
      .from('disp_message_queue')
      .update({ status: 'cancelado' })
      .eq('campaign_id', campaignId)
      .in('status', ['pendente', 'agendado']);
  }

  async getQueueStatus(campaignId: string) {
    const { data } = await this.supabase.db
      .from('disp_message_queue')
      .select('status')
      .eq('campaign_id', campaignId)
      .neq('status', 'cancelado');

    return (data || []).reduce((acc: any, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});
  }

  async getQueueDetails(campaignId: string) {
    const { data } = await this.supabase.db
      .from('disp_message_queue')
      .select('id, status, tipo, mensagem_final, scheduled_at, sent_at, erro, tentativas, contact_id, contacts(nome, telefone_normalizado)')
      .eq('campaign_id', campaignId)
      .neq('status', 'cancelado')
      .order('scheduled_at', { ascending: true })
      .limit(500);

    return data || [];
  }
}
