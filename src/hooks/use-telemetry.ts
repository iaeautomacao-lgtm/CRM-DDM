"use client";

// Hook central de telemetria de frontend — todas as chamadas batem em
// POST /api/telemetry (autenticada via sessão CRM normal, ver
// src/app/api/telemetry/route.ts). Fire-and-forget por design: nenhuma
// função aqui lança, e nenhuma é aguardada pelos chamadores — uma
// falha de rede/telemetria nunca pode derrubar ou atrasar uma ação de
// verdade do usuário.
//
// Chave compartilhada do localStorage onde use-auth.tsx guarda o id da
// sessão de telemetria atual (distinto da sessão do Supabase Auth) —
// exportada daqui pra dashboard-shell.tsx (page views) e use-auth.tsx
// (session_start/session_end) lerem/gravarem o mesmo valor sem
// duplicar a string em cada arquivo.
export const DDM_SESSION_STORAGE_KEY = "ddm-session-id";

async function postTelemetry(body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Fire-and-forget — erro de rede/CSP/etc. nunca propaga pro chamador.
    return null;
  }
}

/**
 * Registra a entrada numa página. `duration_ms` é o tempo gasto na
 * página ANTERIOR (calculado pelo chamador, ver dashboard-shell.tsx),
 * não nesta — por isso é opcional e ausente na primeira chamada de
 * cada sessão de navegador.
 */
export function trackPageView(
  path: string,
  title?: string,
  referrer?: string,
  sessionId?: string,
  duration_ms?: number,
): void {
  void postTelemetry({
    type: "page_view",
    path,
    title: title ?? null,
    referrer: referrer ?? null,
    session_id: sessionId ?? null,
    duration_ms: duration_ms ?? null,
  });
}

/**
 * Registra uma ação de negócio (criar campanha, enviar mensagem,
 * etc.). `payload` nunca deve carregar dado sensível (CPF, telefone,
 * conteúdo de mensagem) — só identificadores e contagens.
 */
export function trackAction(
  action: string,
  payload?: Record<string, unknown>,
  page?: string,
): void {
  void postTelemetry({
    type: "action",
    action,
    payload: payload ?? null,
    path: page ?? null,
  });
}

/** Registra um erro de frontend (error boundary, listener global, etc.).
 *  `payload` é opcional — usado por components/error-boundary.tsx para
 *  anexar o componentStack do React, que error.tsx/global-error.tsx
 *  (baseados no `error` prop do Next.js) nunca recebem. */
export function trackError(
  message: string,
  stack?: string,
  page?: string,
  payload?: Record<string, unknown>,
): void {
  void postTelemetry({
    type: "error",
    error_message: message,
    error_stack: stack ?? null,
    path: page ?? null,
    payload: payload ?? null,
  });
}

/**
 * Inicia uma sessão de telemetria (linha em wacrm.user_sessions) e
 * devolve o id gerado, ou null em qualquer falha. Não faz parte de
 * useTelemetry() — só use-auth.tsx chama isto, no SIGNED_IN.
 */
export async function startTelemetrySession(): Promise<string | null> {
  const res = await postTelemetry({ type: "session_start" });
  if (!res || !res.ok) return null;
  try {
    const data = await res.json();
    return typeof data?.id === "string" ? data.id : null;
  } catch {
    return null;
  }
}

/**
 * Encerra a sessão de telemetria iniciada por startTelemetrySession.
 * Só use-auth.tsx chama isto, no SIGNED_OUT.
 */
export function endTelemetrySession(sessionId: string): void {
  void postTelemetry({ type: "session_end", session_id: sessionId });
}

export function useTelemetry() {
  return { trackPageView, trackAction, trackError };
}
