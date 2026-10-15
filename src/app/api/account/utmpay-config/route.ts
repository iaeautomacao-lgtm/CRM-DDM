import { NextResponse } from "next/server";

import { guardPermission } from "@/lib/auth/route-guard";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { resolveSecretForWrite } from "@/lib/whatsapp/secret-write";
import { resetUtmpayConfigCache } from "@/lib/utmpay/config";
import { utmpayEventsUrl, validateUtmpayConfigBody, viewUtmpayConfig, type UtmpayConfigRow } from "@/lib/utmpay/config-api";
import { buildChecklist } from "@/lib/utmpay/checklist";
import { connectUtmpay, connectionFromResult } from "@/lib/utmpay/connect";
import { plainSecretFor } from "@/lib/utmpay/credentials";

export const dynamic = "force-dynamic";

// GET/PUT /api/account/utmpay-config — configuração do UTMpay por conta (decisões do dono, 14/10). Permissão: settings.account (admin+).
// Os segredos (api_key e webhook_secret) são WRITE-ONLY: gravados CIFRADOS no servidor (resolveSecretForWrite) e nunca devolvidos (só has_*).
// Vazio, omitido ou só bolinhas em api_key/webhook_secret = manter o atual. Contrato: prd-v2/contrato-api-utmpay-crm.md.
const NO_STORE = { "Cache-Control": "no-store" };
const COLUMNS = "enabled, base_url, api_key_enc, webhook_secret_enc, janela_dias, send_without_tracking, updated_at";

const isMissingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";

/** A visão + o checklist (sem consultar o UTMpay: o passo "avisos" vem do GET .../connection). */
const withChecklist = (view: ReturnType<typeof viewUtmpayConfig>) => ({ ...view, checklist: buildChecklist(view, null) });

export async function GET() {
  const auth = await guardPermission("settings.account");
  if (!auth.ok) return auth.response;
  const { data, error } = await supabaseAdmin().from("utmpay_config").select(COLUMNS).eq("account_id", auth.ctx.accountId).maybeSingle();
  if (error) {
    if (isMissingTable(error.code)) return NextResponse.json(withChecklist(viewUtmpayConfig(null, false, utmpayEventsUrl())), { headers: NO_STORE });
    console.error("[utmpay-config] GET falhou:", error.code ?? "erro");
    return NextResponse.json({ error: "Falha ao carregar a configuração do UTMpay" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json(withChecklist(viewUtmpayConfig((data ?? null) as UtmpayConfigRow | null, true, utmpayEventsUrl())), { headers: NO_STORE });
}

export async function PUT(request: Request) {
  const auth = await guardPermission("settings.account");
  if (!auth.ok) return auth.response;
  const { accountId, userId } = auth.ctx;

  const raw = (await request.json().catch(() => null)) as unknown;
  const db = supabaseAdmin();
  const { data: existing, error: readError } = await db.from("utmpay_config").select(COLUMNS).eq("account_id", accountId).maybeSingle();
  if (readError) {
    if (isMissingTable(readError.code)) return NextResponse.json({ error: "UTMpay indisponível neste ambiente (falta a migration 356).", code: "utmpay_unavailable" }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ error: "Falha ao carregar a configuração do UTMpay" }, { status: 500, headers: NO_STORE });
  }
  const current = (existing ?? null) as UtmpayConfigRow | null;

  const checked = validateUtmpayConfigBody(raw, current);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 422, headers: NO_STORE });
  const body = checked.value;

  let apiKey: ReturnType<typeof resolveSecretForWrite>;
  let webhookSecret: ReturnType<typeof resolveSecretForWrite>;
  try {
    apiKey = resolveSecretForWrite(body.api_key, current?.api_key_enc);
    webhookSecret = resolveSecretForWrite(body.webhook_secret, current?.webhook_secret_enc);
  } catch {
    return NextResponse.json({ error: "Não foi possível cifrar o segredo (ENCRYPTION_KEY inválida)" }, { status: 500, headers: NO_STORE });
  }
  if (!apiKey.ok || !webhookSecret.ok) return NextResponse.json({ error: "Segredo deve ser texto" }, { status: 422, headers: NO_STORE });

  const row = {
    account_id: accountId,
    enabled: body.enabled,
    base_url: body.base_url,
    api_key_enc: apiKey.value,
    webhook_secret_enc: webhookSecret.value,
    janela_dias: body.janela_dias,
    send_without_tracking: body.send_without_tracking,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  const { error } = await db.from("utmpay_config").upsert(row, { onConflict: "account_id" });
  if (error) {
    console.error("[utmpay-config] PUT falhou:", error.code ?? "erro");
    return NextResponse.json({ error: "Falha ao salvar a configuração do UTMpay" }, { status: 500, headers: NO_STORE });
  }
  resetUtmpayConfigCache(accountId);

  // Auditoria SEM segredos: só o que mudou (ligado, endereço, janela, política) e se as chaves foram trocadas.
  await logAuditEvent({
    accountId,
    eventType: "updated",
    resourceType: "utmpay_config",
    resourceId: accountId,
    resourceLabel: "UTMpay",
    action: "utmpay.config_updated",
    summary: `Configuração do UTMpay ${current ? "alterada" : "criada"}${body.enabled ? "" : " (desligado)"}`,
    changes: {
      enabled: { before: current?.enabled ?? null, after: body.enabled },
      janela_dias: { before: current?.janela_dias ?? null, after: body.janela_dias },
      send_without_tracking: { before: current?.send_without_tracking ?? null, after: body.send_without_tracking },
    },
    metadata: { api_key_changed: apiKey.value !== (current?.api_key_enc ?? null), webhook_secret_changed: webhookSecret.value !== (current?.webhook_secret_enc ?? null) },
  });
  // "Conectar com um clique": ao salvar, o CRM entrega ao UTMpay o endereço dos avisos e o segredo (também quando o segredo é trocado). Falha aqui NÃO desfaz
  // o que foi salvo: a configuração fica gravada e a resposta traz o resultado claro (e o que fazer) para a tela.
  const eventsUrl = utmpayEventsUrl();
  const conexao = await connectUtmpay({
    baseUrl: body.base_url,
    apiKey: plainSecretFor(body.api_key, current?.api_key_enc),
    secret: plainSecretFor(body.webhook_secret, current?.webhook_secret_enc),
    eventsUrl,
  });
  if (conexao.tentou) {
    await logAuditEvent({
      accountId,
      eventType: "action",
      resourceType: "utmpay_config",
      resourceId: accountId,
      resourceLabel: "UTMpay",
      action: conexao.ok ? "utmpay.connected" : "utmpay.connect_failed",
      summary: conexao.ok ? "UTMpay conectado ao CRM (avisos ligados)" : "Tentativa de conectar o UTMpay ao CRM falhou",
      metadata: { ok: conexao.ok, reason: conexao.reason },
    });
  }
  const view = viewUtmpayConfig({ ...row, updated_at: row.updated_at } as UtmpayConfigRow, true, eventsUrl);
  return NextResponse.json({ ...view, conexao, checklist: buildChecklist(view, connectionFromResult(conexao, eventsUrl)) }, { headers: NO_STORE });
}
