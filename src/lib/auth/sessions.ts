import "server-only";
// PRD 24, item 7 — sessões por dispositivo e status do 2FA do PRÓPRIO usuário (migration 290).
// O user_id vem sempre da sessão validada (getCurrentAccount), nunca do corpo/URL; o id da sessão atual vem do claim `session_id` do
// access token só para MARCAR o dispositivo ("este aparelho") — decisão de segurança nenhuma depende dele.
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/v1/respond";

type Db = Pick<SupabaseClient, "rpc">;

export interface SessionView {
  id: string;
  current: boolean;
  device: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_active_at: string;
  aal: string | null;
  expires_at: string | null;
}

export interface MfaFactorView {
  id: string;
  type: string;
  name: string | null;
  status: string;
  created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** `session_id` do JWT (sem validar assinatura: uso cosmético). null se ausente/ilegível. */
export function sessionIdFromAccessToken(token: string | null | undefined): string | null {
  try {
    const payload = token?.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { session_id?: unknown };
    return isUuid(claims.session_id) ? claims.session_id : null;
  } catch {
    return null;
  }
}

/** "Chrome em Windows", "Safari em iPhone"… Só reconhece o comum; o resto vira "Dispositivo desconhecido". */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Dispositivo desconhecido";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} em ${os}`;
  return browser ?? os ?? "Dispositivo desconhecido";
}

/** 42883/PGRST202 = a migration 290 ainda não foi aplicada: 503 em vez de 500. */
function check<T>(result: { data: T | null; error: { code?: string; message?: string } | null }): T | null {
  if (result.error) {
    if (result.error.code === "42883" || result.error.code === "PGRST202" || /could not find the function/i.test(result.error.message ?? "")) {
      throw new ApiError("unavailable", "Sessões e 2FA indisponíveis: aplique a migration 290", 503);
    }
    throw result.error;
  }
  return result.data;
}

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  user_agent: string | null;
  ip: string | null;
  aal: string | null;
  not_after: string | null;
}

export async function listSessions(db: Db, userId: string, currentSessionId: string | null): Promise<SessionView[]> {
  const rows = (check(await db.rpc("user_sessions", { p_user: userId })) ?? []) as SessionRow[];
  return rows.map((r) => ({
    id: r.id,
    current: currentSessionId !== null && r.id === currentSessionId,
    device: describeUserAgent(r.user_agent),
    user_agent: r.user_agent,
    ip: r.ip,
    created_at: r.created_at,
    last_active_at: r.updated_at,
    aal: r.aal,
    expires_at: r.not_after,
  }));
}

/** true = encerrou; false = não existe ou não é deste usuário (indistinguíveis de propósito). */
export async function revokeSession(db: Db, userId: string, sessionId: string): Promise<boolean> {
  return check(await db.rpc("revoke_user_session", { p_user: userId, p_session: sessionId })) === true;
}

export async function revokeOtherSessions(db: Db, userId: string, keepSessionId: string | null): Promise<number> {
  return Number(check(await db.rpc("revoke_other_user_sessions", { p_user: userId, p_keep: keepSessionId })) ?? 0);
}

export async function listMfaFactors(db: Db, userId: string): Promise<{ enabled: boolean; factors: MfaFactorView[] }> {
  const rows = (check(await db.rpc("user_mfa_factors", { p_user: userId })) ?? []) as Array<{ id: string; factor_type: string; friendly_name: string | null; status: string; created_at: string }>;
  const factors = rows.map((r) => ({ id: r.id, type: r.factor_type, name: r.friendly_name, status: r.status, created_at: r.created_at }));
  return { enabled: factors.some((f) => f.status === "verified"), factors };
}
