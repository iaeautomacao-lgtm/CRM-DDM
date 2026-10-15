import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Rotinas do cron de pausas (/api/pausas/cron, 1 min): (1) fecha a pausa de quem ficou desconectado por mais de 15 min; (2) marca (UMA vez por
// pausa, atômico no banco) as que passaram do tempo máximo do motivo e avisa o SUPERVISOR da equipe do atendente. O limite só alerta: nunca
// retoma nem bloqueia ninguém. Sem a migration 371 as funções não existem e o cron responde 503.
import { sendPauseExceededPush } from "@/lib/push/service";

type Db = any;

export const DISCONNECT_MINUTES = 15;

export interface ExceededPause {
  pause_id: string;
  account_id: string;
  user_id: string;
  reason_name: string;
  max_minutes: number;
}

/** Quem recebe o aviso: supervisores (e só eles) das equipes do atendente; sem equipe ou sem supervisor, owner/admin da conta (para o aviso não se perder). */
export async function alertRecipients(db: Db, pause: Pick<ExceededPause, "account_id" | "user_id">): Promise<string[]> {
  const { data: mine } = await db.from("team_members").select("team_id").eq("user_id", pause.user_id);
  const teamIds = ((mine ?? []) as Array<{ team_id: string }>).map((t) => t.team_id);
  let supervisors: string[] = [];
  if (teamIds.length > 0) {
    const { data: members } = await db.from("team_members").select("user_id").in("team_id", teamIds);
    const candidates = [...new Set(((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id))].filter((id) => id !== pause.user_id);
    if (candidates.length > 0) {
      const { data: sups } = await db.from("profiles").select("user_id").eq("account_id", pause.account_id).eq("account_role", "supervisor").is("deactivated_at", null).in("user_id", candidates);
      supervisors = ((sups ?? []) as Array<{ user_id: string }>).map((s) => s.user_id);
    }
  }
  if (supervisors.length > 0) return supervisors;
  const { data: admins } = await db.from("profiles").select("user_id").eq("account_id", pause.account_id).in("account_role", ["owner", "admin"]).is("deactivated_at", null).neq("user_id", pause.user_id).limit(50);
  return ((admins ?? []) as Array<{ user_id: string }>).map((a) => a.user_id);
}

export interface PauseCronSummary {
  closedByDisconnect: number;
  exceeded: number;
  notified: number;
}

export async function runPauseCron(db: Db, deps: { push?: typeof sendPauseExceededPush } = {}): Promise<PauseCronSummary> {
  const push = deps.push ?? sendPauseExceededPush;
  const summary: PauseCronSummary = { closedByDisconnect: 0, exceeded: 0, notified: 0 };

  const closed = await db.rpc("close_disconnected_pauses", { p_minutes: DISCONNECT_MINUTES });
  if (closed.error) throw closed.error;
  summary.closedByDisconnect = Number(closed.data) || 0;

  const claimed = await db.rpc("claim_exceeded_pauses");
  if (claimed.error) throw claimed.error;
  const rows = (claimed.data ?? []) as ExceededPause[];
  summary.exceeded = rows.length;
  for (const pause of rows) {
    try {
      const userIds = await alertRecipients(db, pause);
      const result = await push(db, { accountId: pause.account_id, userIds, tag: `pause-${pause.pause_id}` });
      summary.notified += result.sent;
    } catch (err) {
      console.error("[pausas] aviso de estouro falhou:", err instanceof Error ? err.message : "erro"); // a pausa já está marcada: não repete
    }
  }
  return summary;
}
