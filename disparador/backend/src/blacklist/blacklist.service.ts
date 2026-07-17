import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';

@Injectable()
export class BlacklistService {
  constructor(private supabase: SupabaseService) {}

  async isBlacklisted(telefone: string): Promise<boolean> {
    const { data } = await this.supabase.db
      .from('blacklist')
      .select('id')
      .eq('telefone', telefone)
      .maybeSingle();
    return !!data;
  }

  async add(
    telefone: string,
    motivo: string,
    extra?: { campaign_id?: string; mensagem_detectada?: string; bloqueado_por?: string },
  ) {
    await this.supabase.db
      .from('blacklist')
      .upsert({ telefone, motivo, ...extra }, { onConflict: 'telefone' });

    // Atualiza contato
    await this.supabase.db
      .from('contacts')
      .update({ status_contato: 'removido' })
      .eq('telefone_normalizado', telefone);

    // Cancela mensagens pendentes
    await this.supabase.db
      .from('disp_message_queue')
      .update({ status: 'cancelado' })
      .eq('status', 'pendente')
      .in('contact_id',
        this.supabase.db
          .from('contacts')
          .select('id')
          .eq('telefone_normalizado', telefone) as any,
      );
  }

  async findAll(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const { data, count } = await this.supabase.db
      .from('blacklist')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    return { data, total: count, page, limit };
  }

  async remove(id: string) {
    await this.supabase.db.from('blacklist').delete().eq('id', id);
    return { removed: true };
  }
}
