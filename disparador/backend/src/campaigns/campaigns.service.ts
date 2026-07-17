import { Injectable, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';
import { MessageQueueService } from '../message-queue/message-queue.service';

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private supabase: SupabaseService,
    private queueService: MessageQueueService,
  ) {}

  async create(body: any, userId: string) {
    const { data, error } = await this.supabase.db
      .from('campaigns')
      .insert({ ...body, created_by: userId, status: 'rascunho' })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    // Inicializa métricas
    await this.supabase.db
      .from('campaign_metrics')
      .insert({ campaign_id: data.id });

    return data;
  }

  async findAll(filters: { status?: string; page?: number; limit?: number }) {
    const { status, page = 1, limit = 20 } = filters;
    const offset = (page - 1) * limit;

    let query = this.supabase.db
      .from('campaigns')
      .select(`
        *,
        campaign_metrics(*),
        whatsapp_sessions(nome_sessao, status)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, count, error } = await query;
    if (error) throw new BadRequestException(error.message);
    return { data, total: count, page, limit };
  }

  async findOne(id: string) {
    const { data } = await this.supabase.db
      .from('campaigns')
      .select(`*, campaign_metrics(*), message_variations(*), whatsapp_sessions(*)`)
      .eq('id', id)
      .single();
    return data;
  }

  async update(id: string, body: any) {
    const { data, error } = await this.supabase.db
      .from('campaigns')
      .update(body)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async approve(id: string, userId: string) {
    const campaign = await this.findOne(id);
    if (!campaign) throw new BadRequestException('Campanha não encontrada');
    if (campaign.status !== 'aguardando_aprovacao') {
      throw new ForbiddenException('Campanha não está aguardando aprovação');
    }

    return this.update(id, {
      status: 'aprovada',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    });
  }

  async start(id: string) {
    const campaign = await this.findOne(id);
    if (!campaign) throw new BadRequestException('Campanha não encontrada');
    if (!['rascunho', 'aprovada', 'pausada'].includes(campaign.status)) {
      throw new ForbiddenException('Campanha não pode ser iniciada no status atual');
    }

    // Aceita mensagens diretas (campo mensagens JSONB) ou variações de IA aprovadas
    const temMensagensDiretas = Array.isArray(campaign.mensagens) && campaign.mensagens.length > 0;

    if (!temMensagensDiretas) {
      const { data: variations } = await this.supabase.db
        .from('message_variations')
        .select('id')
        .eq('campaign_id', id)
        .eq('aprovada', true);

      if (!variations || variations.length === 0) {
        throw new ForbiddenException('Campanha precisa ter mensagens configuradas');
      }
    }

    await this.update(id, {
      status: 'em_execucao',
      approved_at: campaign.approved_at ?? new Date().toISOString(),
    });

    // Enfileira contatos
    await this.queueService.enqueueCampaignContacts(id);

    return { started: true };
  }

  async requeue(id: string) {
    const campaign = await this.findOne(id);
    if (!campaign) throw new BadRequestException('Campanha não encontrada');

    // Remove itens pendentes/agendados/erro para evitar duplicatas
    await this.supabase.db
      .from('disp_message_queue')
      .delete()
      .eq('campaign_id', id)
      .in('status', ['pendente', 'agendado', 'erro']);

    // Garante status em execução
    await this.update(id, { status: 'em_execucao' });

    await this.queueService.enqueueCampaignContacts(id);
    return { requeued: true };
  }

  async pause(id: string) {
    return this.update(id, { status: 'pausada' });
  }

  async stop(id: string) {
    await this.update(id, { status: 'encerrada' });
    await this.supabase.db
      .from('disp_message_queue')
      .update({ status: 'cancelado' })
      .eq('campaign_id', id)
      .in('status', ['pendente', 'agendado']);
    return { stopped: true };
  }

  async addContacts(campaignId: string, contactIds: string[]) {
    const rows = contactIds.map((contact_id) => ({ campaign_id: campaignId, contact_id }));
    const { data, error } = await this.supabase.db
      .from('campaign_contacts')
      .upsert(rows, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true });
    if (error) throw new BadRequestException(error.message);

    // Atualiza métrica
    const { count } = await this.supabase.db
      .from('campaign_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId);

    await this.supabase.db
      .from('campaign_metrics')
      .update({ total_contatos: count })
      .eq('campaign_id', campaignId);

    return { added: contactIds.length };
  }

  async delete(id: string) {
    this.logger.log(`Deletando campanha ${id}`);

    // 1. Busca todos os IDs da fila desta campanha
    const { data: queueItems } = await this.supabase.db
      .from('disp_message_queue').select('id').eq('campaign_id', id);
    const queueIds = (queueItems || []).map((q: any) => q.id);
    this.logger.log(`Queue items encontrados: ${queueIds.length}`);

    // 2. Nula queue_id em message_logs pelos IDs da fila (independente do campaign_id)
    if (queueIds.length > 0) {
      const { error: e } = await this.supabase.db
        .from('message_logs').update({ queue_id: null }).in('queue_id', queueIds);
      if (e) this.logger.warn(`message_logs queue_id null: ${e.message}`);
    }

    // 3. Nula campaign_id em message_logs
    await this.supabase.db.from('message_logs').update({ campaign_id: null }).eq('campaign_id', id);

    // 4. Deleta fila
    const { error: mqErr } = await this.supabase.db.from('disp_message_queue').delete().eq('campaign_id', id);
    if (mqErr) this.logger.warn(`message_queue delete: ${mqErr.message}`);

    // 5. Anula campaign_id nas demais tabelas
    await Promise.all([
      this.supabase.db.from('incoming_messages').update({ campaign_id: null }).eq('campaign_id', id),
      this.supabase.db.from('optout_records').update({ campaign_id: null }).eq('campaign_id', id),
      this.supabase.db.from('risk_events').update({ campaign_id: null }).eq('campaign_id', id),
      this.supabase.db.from('ai_generation_logs').update({ campaign_id: null }).eq('campaign_id', id),
      this.supabase.db.from('attendance_cards').update({ campaign_id: null }).eq('campaign_id', id),
    ]);

    // 6. Deleta campanha (campaign_metrics e campaign_contacts têm ON DELETE CASCADE)
    const { error } = await this.supabase.db.from('campaigns').delete().eq('id', id);
    if (error) {
      this.logger.error(`Erro ao deletar campanha: ${error.message} | code: ${error.code}`);
      throw new BadRequestException(error.message);
    }
    this.logger.log(`Campanha ${id} deletada com sucesso`);
    return { deleted: true };
  }

  async duplicate(id: string, userId: string) {
    const original = await this.findOne(id);
    const { id: _id, created_at, updated_at, ...rest } = original;
    return this.create({ ...rest, nome: `${rest.nome} (cópia)`, status: 'rascunho' }, userId);
  }
}
