import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { toPublicImportList, type ImportJob } from "@/lib/disparador/import-lists";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// GET /api/disparador/imports/lists?q=&limit=&cursor=   → { lists, next_cursor }
//
// Listas importadas reutilizáveis (PRD 24, item 8): as importações CONCLUÍDAS da conta (job da 197, state = done), das mais recentes para
// as mais antigas, com o nome (migration 292) e as contagens que o próprio job já guarda — nada novo é calculado. `q` filtra pelo nome.
// Paginação por cursor "created_at|id". Reutilizar uma lista em outra campanha: POST /api/disparador/imports/[id]/reuse.
const MAX_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await requireDisparadorAccess();
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 20, 1), MAX_LIMIT);
    // Busca segura para o filtro PostgREST: sem vírgula/parênteses/curingas.
    const q = (url.searchParams.get("q") ?? "").replace(/[,()%*\\]/g, " ").trim().slice(0, 80);

    let query = supabaseAdmin()
      .from("dispatch_import_jobs")
      .select("*")
      .eq("account_id", ctx.accountId)
      .eq("state", "done")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (q) query = query.ilike("name", `%${q}%`);

    const cursor = url.searchParams.get("cursor");
    if (cursor) {
      const [at, id] = cursor.split("|");
      if (at && id && UUID.test(id) && !Number.isNaN(Date.parse(at))) {
        query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
      }
    }

    const { data, error } = await query;
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205" || error.code === "42703") {
        return NextResponse.json({ lists: [], next_cursor: null, unavailable: true });
      }
      throw new Error(`Falha ao listar as listas importadas: ${error.message}`);
    }
    const rows = (data ?? []) as ImportJob[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return NextResponse.json({
      lists: page.map(toPublicImportList),
      next_cursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
