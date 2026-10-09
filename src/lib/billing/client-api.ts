"use client";

import { apiFetch } from "@/lib/api-fetch";

/** Erro das rotas /api/billing/* (envelope v1: { error: { code, message, problems? } }). */
export class BillingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Lista de problemas por etapa quando o PUT de etapas é recusado (400). */
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "BillingApiError";
  }
}

export async function billingFetch<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await apiFetch(`/api/billing${path}`, {
    method: init?.method ?? "GET",
    cache: "no-store",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; problems?: unknown };
  };
  if (!res.ok) {
    const e = body.error;
    throw new BillingApiError(
      e?.message ?? "Não foi possível concluir a operação.",
      res.status,
      e?.code ?? "error",
      Array.isArray(e?.problems) ? (e.problems as string[]) : [],
    );
  }
  return body as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Não foi possível concluir a operação.";
}
