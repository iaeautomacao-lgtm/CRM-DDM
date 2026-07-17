import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';

@Injectable()
export class DashboardService {
  constructor(private supabase: SupabaseService) {}

  async getOverview() {
    const [contacts, sessions, campaigns, queueStats, attendance] = await Promise.all([
      this.getContactStats(),
      this.getSessionStats(),
      this.getCampaignStats(),
      this.getQueueStats(),
      this.getAttendanceStats(),
    ]);

    return { contacts, sessions, campaigns, queue: queueStats, attendance };
  }

  private async getContactStats() {
    const { count: total } = await this.supabase.db
      .from('contacts').select('id', { count: 'exact', head: true });

    const { count: aptos } = await this.supabase.db
      .from('contacts').select('id', { count: 'exact', head: true })
      .eq('status_contato', 'apto_para_envio');

    const { count: bloqueados } = await this.supabase.db
      .from('contacts').select('id', { count: 'exact', head: true })
      .in('status_contato', ['bloqueado', 'removido']);

    const { count: blacklisted } = await this.supabase.db
      .from('blacklist').select('id', { count: 'exact', head: true });

    return { total, aptos, bloqueados, blacklisted };
  }

  private async getSessionStats() {
    const { data } = await this.supabase.db
      .from('whatsapp_sessions').select('status, envios_hoje, limite_diario');

    const conectadas = data?.filter(s => s.status === 'conectada').length || 0;
    const instaveis = data?.filter(s => s.status === 'instavel').length || 0;
    const total = data?.length || 0;
    const enviosHoje = data?.reduce((acc, s) => acc + (s.envios_hoje || 0), 0) || 0;

    return { total, conectadas, instaveis, enviosHoje };
  }

  private async getCampaignStats() {
    const { data } = await this.supabase.db
      .from('campaigns').select('status, score_risco');

    const ativas = data?.filter(c => c.status === 'em_execucao').length || 0;
    const pausadas = data?.filter(c => c.status === 'pausada').length || 0;
    const total = data?.length || 0;

    const { data: metrics } = await this.supabase.db
      .from('campaign_metrics')
      .select('total_enviados, total_respostas, total_optout, total_convertidos, taxa_resposta, taxa_optout');

    const totals = (metrics || []).reduce((acc, m) => ({
      enviados: acc.enviados + (m.total_enviados || 0),
      respostas: acc.respostas + (m.total_respostas || 0),
      optout: acc.optout + (m.total_optout || 0),
      convertidos: acc.convertidos + (m.total_convertidos || 0),
    }), { enviados: 0, respostas: 0, optout: 0, convertidos: 0 });

    return { total, ativas, pausadas, ...totals };
  }

  private async getQueueStats() {
    const today = new Date().toISOString().slice(0, 10);

    const { data } = await this.supabase.db
      .from('disp_message_queue')
      .select('status')
      .gte('created_at', today);

    const summary = (data || []).reduce((acc: any, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});

    return summary;
  }

  private async getAttendanceStats() {
    const { data } = await this.supabase.db
      .from('attendance_cards').select('status');

    const novos = data?.filter(a => a.status === 'novo').length || 0;
    const emAtendimento = data?.filter(a => a.status === 'em_atendimento').length || 0;
    const total = data?.length || 0;

    return { total, novos, emAtendimento };
  }

  async getCampaignReport(campaignId: string) {
    const [campaign, metrics, riskEvents, queueStatus] = await Promise.all([
      this.supabase.db.from('campaigns').select('*').eq('id', campaignId).single(),
      this.supabase.db.from('campaign_metrics').select('*').eq('campaign_id', campaignId).single(),
      this.supabase.db.from('risk_events').select('*').eq('campaign_id', campaignId).order('created_at', { ascending: false }).limit(20),
      this.supabase.db.from('disp_message_queue').select('status').eq('campaign_id', campaignId),
    ]);

    const queueSummary = (queueStatus.data || []).reduce((acc: any, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});

    return {
      campaign: campaign.data,
      metrics: metrics.data,
      riskEvents: riskEvents.data,
      queue: queueSummary,
    };
  }
}
