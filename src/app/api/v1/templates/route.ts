// ============================================================
// GET /api/v1/templates — catálogo de templates da Meta da conta da chave, para o integrador saber nome, idioma, nº de variáveis
// e se o template pode ser enviado por POST /whatsapp/send-template. Somente leitura, sem dado pessoal.
//
// Escopo: 'templates:read' (ou 'messages:send' / 'campaigns:write', que já usam templates). Padrão: só APPROVED.
// Filtros: status (APPROVED|PENDING|…|all), language, name (prefixo), channel (UUID ou número Meta → filtra pela WABA do canal).
// Paginação por cursor keyset (name, id): limit 1..200, padrão 50.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse, ApiError, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { TEMPLATE_SELECT, isUuid, parseTemplatesQuery, serializeTemplate, templatesCursor, type ChannelRef, type TemplateRow } from '@/lib/api/v1/templates';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/templates', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ['templates:read', 'messages:send', 'campaigns:write']);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const q = parseTemplatesQuery(new URL(request.url).searchParams);

    // Canais Meta da conta (rótulo por WABA e filtro por canal).
    const { data: channelData, error: channelError } = await ctx.supabase
      .from('whatsapp_config')
      .select('id, waba_id, display_phone_number')
      .eq('account_id', ctx.accountId)
      .eq('habilitado', true)
      .eq('provider', 'meta');
    if (channelError) throw new ApiError('unavailable', 'Não foi possível consultar os canais; tente novamente', 503);
    const channels = (channelData ?? []) as Array<{ id: string; waba_id: string | null; display_phone_number: string | null }>;

    let wabaFilter: string | null = null;
    if (q.channel) {
      const digits = sanitizePhoneForMeta(q.channel);
      const chosen = isUuid(q.channel)
        ? channels.find((c) => c.id.toLowerCase() === q.channel!.toLowerCase())
        : channels.find((c) => c.display_phone_number && sanitizePhoneForMeta(c.display_phone_number) === digits);
      if (!chosen) throw badRequest('Canal Meta não encontrado ou desabilitado nesta conta');
      if (!chosen.waba_id) throw badRequest('O canal Meta não tem a WABA identificada; sincronize os templates do canal');
      wabaFilter = chosen.waba_id;
    }

    let query = ctx.supabase.from('message_templates').select(TEMPLATE_SELECT).eq('account_id', ctx.accountId);
    if (wabaFilter) query = query.eq('waba_id', wabaFilter);
    if (q.status) query = query.ilike('status', q.status);
    if (q.language) query = query.eq('language', q.language);
    if (q.namePrefix) query = query.ilike('name', `${q.namePrefix.replace(/_/g, '\\_')}%`);
    if (q.cursor) {
      const [name, id] = q.cursor;
      query = query.or(`name.gt.${name},and(name.eq.${name},id.gt.${id})`);
    }
    const { data, error } = await query.order('name', { ascending: true }).order('id', { ascending: true }).limit(q.limit + 1);
    if (error) throw new ApiError('unavailable', 'Não foi possível consultar os templates; tente novamente', 503);

    const rows = (data ?? []) as TemplateRow[];
    const page = rows.slice(0, q.limit);
    const byWaba = new Map<string, ChannelRef[]>();
    for (const c of channels) {
      if (!c.waba_id) continue;
      const list = byWaba.get(c.waba_id) ?? [];
      list.push({ id: c.id, label: c.display_phone_number });
      byWaba.set(c.waba_id, list);
    }
    const last = page[page.length - 1];
    return ok(
      {
        items: page.map((row) => serializeTemplate(row, row.waba_id ? (byWaba.get(row.waba_id) ?? []) : [])),
        next_cursor: rows.length > q.limit && last ? templatesCursor(last) : null,
      },
      200,
      logCtx
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
