import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { checkCampaignConfig } from "@/lib/disparador/campaign-config-check";
import {
  BUSINESS_DAYS,
  decideCampaignStatus,
  parseTemplateMode,
  validateCampaignSettings,
} from "@/lib/disparador/campaign-validation";
import { isMissingColumnError, isUuid, pickCampaignFields } from "@/lib/disparador/campaign-payload";
import { syncCampaignPlannedMetrics } from "@/lib/disparador/campaign-planning";

// POST /api/disparador/campaigns — cria a campanha no servidor.
//
// Server-authoritative (#80, migration 161): o navegador não grava mais em
// wacrm.campaigns. A rota confere a sessão e a conta, valida com a mesma
// regra do PATCH e do startCampaign (campaign-validation.ts) e só então
// grava com o service role. account_id, created_by e status nunca vêm do
// cliente: com agendamento → "agendado"; sem → "rascunho".
//
// ?dry_run=1 só valida (passo Revisão do assistente, antes de importar a
// base) e devolve o status que a campanha teria.
//
// Corpo: os campos graváveis (campaign-payload.ts) + draft_id (UUID usado no
// import da base e na geração de UTM antes de a campanha existir) +
// confirm_all_contacts (aceite explícito de enviar para a conta inteira).

export async function POST(request: Request) {
  try {
    // Sessão + conta + papel (owner/admin, mesmo da página /disparador).
    const { userId, accountId } = await requireDisparadorAccess();
    const dryRun = new URL(request.url).searchParams.get("dry_run") === "1";
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Corpo da requisição inválido." }, { status: 400 });
    }

    const fields = pickCampaignFields(body);
    // Envio só em dia útil (decisão de 06/10): o assistente não oferece mais
    // a escolha de dias; quem chamar sem dias_envio também fica em seg–sex.
    if (fields.dias_envio == null) fields.dias_envio = [...BUSINESS_DAYS];

    const settingsErrors = validateCampaignSettings(fields, {
      requireAudience: true,
      confirmAllContacts: body.confirm_all_contacts === true,
    });
    if (settingsErrors.length > 0) {
      return NextResponse.json({ error: settingsErrors[0], errors: settingsErrors }, { status: 400 });
    }

    const db = supabaseAdmin();
    const check = await checkCampaignConfig(
      db,
      accountId,
      (fields.session_ids as string[] | undefined) ?? [],
      (fields.mensagens as Record<string, unknown>[] | undefined) ?? [],
      {
        templateMode: parseTemplateMode(fields.dias_permitidos),
        audienceMode: (fields.audience_mode as string | undefined) ?? null,
      }
    );
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

    const status = decideCampaignStatus(fields.agendamento);
    if (dryRun) return NextResponse.json({ ok: true, status, provider: check.provider });

    // draft_id (assistente V2) ou import_draft_id (nome usado no #80).
    const draftId = isUuid(body.draft_id) ? body.draft_id : isUuid(body.import_draft_id) ? body.import_draft_id : null;
    const row: Record<string, unknown> = {
      ...fields,
      status,
      account_id: accountId,
      created_by: userId,
      // Migration 080 — startCampaign relinka as VAR1–3 do import por aqui.
      import_draft_id: draftId,
    };

    let insert = await db.from("campaigns").insert(row).select("id").limit(1);
    // Migration 162 ainda não aplicada: grava sem a data final (é só
    // referência; a janela diária e o agendamento continuam valendo).
    if (insert.error && isMissingColumnError(insert.error, "agendamento_fim")) {
      const { agendamento_fim: _semColuna, ...semFim } = row;
      void _semColuna;
      insert = await db.from("campaigns").insert(semFim).select("id").limit(1);
    }
    if (insert.error) {
      console.error("[Campaign Create] insert:", insert.error.message);
      return NextResponse.json({ error: "Não foi possível salvar a campanha." }, { status: 500 });
    }
    const campaignId = (insert.data?.[0] as { id?: string } | undefined)?.id;
    if (!campaignId) return NextResponse.json({ error: "Não foi possível salvar a campanha." }, { status: 500 });

    // Links UTM e VAR1–3 gravados sob o draft_id (antes de a campanha
    // existir) passam para o campaign_id real. O startCampaign repete o
    // relink das variáveis por import_draft_id (rede de segurança).
    if (draftId) {
      const [utm, vars] = await Promise.all([
        db
          .from("disparador_utm_links")
          .update({ campaign_id: campaignId })
          .eq("draft_id", draftId)
          .is("campaign_id", null),
        db
          .from("contact_import_variables")
          .update({ campaign_id: campaignId })
          .eq("draft_id", draftId)
          .is("campaign_id", null),
      ]);
      if (utm.error) console.error("[Campaign Create] relink UTM:", utm.error.message);
      if (vars.error) console.error("[Campaign Create] relink VAR1–3:", vars.error.message);
    }

    // Pré-calcula o público elegível para que o card de uma campanha
    // agendada já mostre "Disparos previstos" e a previsão de término.
    // É melhor esforço: uma falha de métrica não desfaz a campanha salva.
    const planned = await syncCampaignPlannedMetrics(db, accountId, campaignId);
    if (!planned.ok) {
      console.warn("[Campaign Create] planned metrics:", planned.error);
    }

    return NextResponse.json({ ok: true, id: campaignId, status }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
