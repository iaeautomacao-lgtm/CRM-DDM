// ============================================================
// GET /api/ai/prompt-versions?scope=account
// GET /api/ai/prompt-versions?scope=flow_node&flow_id=<uuid>&node_key=<key>
//
// Histórico de versões do prompt da IA (migration 148): prompt geral
// (Configurações → IA) ou "Instruções da IA para este nó" de um nó
// ai_agent. Mais recentes primeiro. Só owner/admin — o mesmo público das
// telas /settings e /flows (role-utils). Restaurar é feito no cliente:
// o texto volta para o campo e o usuário salva/publica.
//
// Tabela ausente (148 não aplicada) → lista vazia.
// ============================================================

import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import {
  listPromptVersions,
  shortPromptVersion,
  type PromptVersionTarget,
} from "@/lib/ai/prompt-versions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await requirePermission("ai.config");
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope");

    let target: PromptVersionTarget;
    if (scope === "account") {
      target = { scope: "account" };
    } else if (scope === "flow_node") {
      const flowId = params.get("flow_id") ?? "";
      const nodeKey = params.get("node_key") ?? "";
      if (!UUID_RE.test(flowId) || !nodeKey.trim()) {
        return NextResponse.json({ error: "flow_id e node_key são obrigatórios" }, { status: 400 });
      }
      target = { scope: "flow_node", flowId, nodeKey };
    } else {
      return NextResponse.json({ error: "scope deve ser 'account' ou 'flow_node'" }, { status: 400 });
    }

    // Sessão do usuário: a RLS (148) já restringe à conta e a admin+.
    const { rows, error } = await listPromptVersions(ctx.supabase, ctx.accountId, target);
    if (error) {
      console.error("[GET /api/ai/prompt-versions]", error);
      return NextResponse.json({ error: "Falha ao carregar o histórico" }, { status: 500 });
    }

    // Nome de quem salvou (profiles é legível por membros da conta).
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.created_by, r.last_saved_by]).filter((v): v is string => !!v)),
    ];
    const names = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: profiles } = await ctx.supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .eq("account_id", ctx.accountId)
        .in("user_id", userIds);
      for (const p of (profiles ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null }>) {
        names.set(p.user_id, p.full_name?.trim() || p.email || "");
      }
    }

    return NextResponse.json({
      versions: rows.map((r) => ({
        id: r.id,
        version: shortPromptVersion(r.content_hash),
        content: r.content,
        source: r.source,
        created_at: r.created_at,
        created_by_name: r.created_by ? names.get(r.created_by) || null : null,
        last_saved_at: r.last_saved_at,
        last_saved_by_name: r.last_saved_by ? names.get(r.last_saved_by) || null : null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
