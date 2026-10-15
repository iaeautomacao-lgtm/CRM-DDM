import { NextResponse } from "next/server";

import { guardPermission } from "@/lib/auth/route-guard";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { buildChecklist } from "@/lib/utmpay/checklist";
import { readUtmpayConnection } from "@/lib/utmpay/connect";
import { utmpayEventsUrl, viewUtmpayConfig } from "@/lib/utmpay/config-api";
import { loadStoredCredentials } from "@/lib/utmpay/stored-credentials";

export const dynamic = "force-dynamic";

// GET /api/account/utmpay-config/status  → { base_url_ok, api_key_ok, utmpay_alcancavel, utmpay_recebe_avisos, conectado_em, conexao: { estado, url, tem_segredo, atualizado_em, esperado, mensagem }, checklist }   (settings.account)
// Pergunta ao UTMpay ({base_url}/api/integracoes/crm, GET) para onde ele está mandando os avisos e se tem o segredo, e compara com o endereço dos avisos
// do CRM. estado: conectado | divergente | nao_conectado | erro | nao_configurado. O segredo NUNCA vem (só tem_segredo). O checklist já traz os 5 itens
// em português simples para a tela desenhar (verde/amarelo/vermelho/cinza + o que fazer).
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const auth = await guardPermission("settings.account");
  if (!auth.ok) return auth.response;

  const stored = await loadStoredCredentials(supabaseAdmin(), auth.ctx.accountId);
  if (!stored.ok) {
    if (stored.unavailable) return NextResponse.json({ error: "O rastreamento ainda não está disponível neste ambiente. Peça ao suporte para atualizar o banco de dados.", code: "utmpay_unavailable" }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ error: "Não foi possível ler a configuração agora. Tente de novo." }, { status: 500, headers: NO_STORE });
  }
  const { row, baseUrl, apiKey } = stored.value;
  const eventsUrl = utmpayEventsUrl();
  const conexao = await readUtmpayConnection({ baseUrl, apiKey, eventsUrl });
  return NextResponse.json(
    {
      base_url_ok: !!baseUrl,
      api_key_ok: !!apiKey,
      utmpay_alcancavel: conexao.alcancavel,
      utmpay_recebe_avisos: conexao.estado === "conectado",
      conectado_em: conexao.estado === "conectado" ? conexao.atualizado_em : null,
      conexao,
      checklist: buildChecklist(viewUtmpayConfig(row, true, eventsUrl), conexao),
    },
    { headers: NO_STORE },
  );
}
