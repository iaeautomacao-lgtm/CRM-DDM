// Chamadas às rotas de pausas (cookie de sessão). Erros vêm como { error, code }.
import { apiFetch } from "@/lib/api-fetch";
import type { Pause, PauseReason, TeamPause } from "./pause";

export interface PauseApiError {
  code: string;
  message: string;
  /** Pausa em andamento, quando o erro é already_paused. */
  pause?: Pause;
  startedByName?: string | null;
}

export type PauseResult<T> = { ok: true; data: T } | { ok: false; error: PauseApiError };

async function call<T>(url: string, init?: RequestInit): Promise<PauseResult<T>> {
  try {
    const res = await apiFetch(url, init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: {
          code: typeof json.code === "string" ? json.code : `http_${res.status}`,
          message: typeof json.error === "string" ? json.error : "",
          pause: json.pause,
          startedByName: json.started_by_name ?? null,
        },
      };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: { code: "network", message: "Sem conexão. Tente de novo." } };
  }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const pausasApi = {
  myPause: () => call<{ pause: Pause | null }>("/api/pausas/atual"),
  reasons: (all = false) => call<{ reasons: PauseReason[] }>(`/api/pausas/motivos${all ? "?todos=1" : ""}`),
  createReason: (body: { name: string; max_minutes: number | null }) =>
    call<{ reason: PauseReason }>("/api/pausas/motivos", jsonInit("POST", body)),
  updateReason: (id: string, body: Partial<Pick<PauseReason, "name" | "max_minutes" | "active" | "sort_order">>) =>
    call<{ reason: PauseReason }>(`/api/pausas/motivos/${id}`, jsonInit("PATCH", body)),
  start: (reasonId: string, userId?: string) =>
    call<{ pause: Pause }>("/api/pausas", jsonInit("POST", { reason_id: reasonId, ...(userId ? { user_id: userId } : {}) })),
  resume: (userId?: string) =>
    call<{ pause: Pause }>("/api/pausas/retomar", jsonInit("POST", userId ? { user_id: userId } : {})),
  team: () => call<{ pauses: TeamPause[] }>("/api/pausas/equipe"),
  pausedIds: () => call<{ user_ids: string[] }>("/api/pausas/em-pausa"),
};
