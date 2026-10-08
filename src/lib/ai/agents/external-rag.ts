// RAG externo (conector) — OPCIONAL, desligado por padrão e por flag.
//
// Só roda quando TODAS as condições valem: flag de ambiente AI_EXTERNAL_RAG_ENABLED=true,
// agente com `knowledge.rag_external.enabled` e credencial {{cred.X}} cadastrada na conta
// cujo allowed_hosts cobre o host da URL. Qualquer falha (timeout, HTTP, host não
// permitido, corpo inválido) devolve "" e o turno SEGUE sem o RAG (política
// continue_without_rag) — loga só o motivo, nunca URL, credencial ou conteúdo.
//
// Contrato da resposta aceito: { context: string } ou { results: [{ text | content: string }] }.

import { safeFetch } from "@/lib/security/ssrf-guard";
import { hostAllowedFor, type AccountSecretsContext } from "@/lib/ai/tool-secrets";
import { sanitizeResponseBody } from "@/lib/ai-tools/tool-request";
import type { AgentConfig } from "./schema";

type Rag = AgentConfig["knowledge"]["rag_external"];

export function externalRagEnabledByFlag(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AI_EXTERNAL_RAG_ENABLED ?? "").trim().toLowerCase() === "true";
}

const CRED = /^\{\{cred\.([A-Z][A-Z0-9_]{1,63})\}\}$/;

export async function fetchExternalRagContext(input: {
  rag: Rag;
  query: string;
  account: AccountSecretsContext | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof safeFetch;
}): Promise<string> {
  const { rag } = input;
  if (!externalRagEnabledByFlag(input.env) || !rag.enabled) return "";
  const log = (reason: string) => console.warn("[ai-rag] RAG externo ignorado neste turno:", reason);
  try {
    const credName = rag.credential ? CRED.exec(rag.credential)?.[1] : undefined;
    const cred = credName ? input.account?.creds.get(credName) : undefined;
    if (!rag.url || !cred) {
      log("credencial ou URL ausente");
      return "";
    }
    if (!hostAllowedFor(rag.url, cred.hosts)) {
      log("host fora dos hosts permitidos da credencial");
      return "";
    }
    const fetcher = input.fetchImpl ?? safeFetch;
    const res = await fetcher(
      rag.url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.value}` },
        body: JSON.stringify({ query: input.query, top_k: rag.top_k ?? 5 }),
      },
      {
        timeoutMs: rag.timeout_ms ?? 5000,
        maxBytes: rag.max_bytes ?? 262_144,
        maxRedirects: rag.max_redirects ?? 0,
        failOnCrossOriginRedirect: true,
      },
    );
    if (!res.ok) {
      log(`HTTP ${res.status}`);
      return "";
    }
    const raw = await res.text();
    const json = JSON.parse(raw) as { context?: unknown; results?: Array<{ text?: unknown; content?: unknown }> };
    let text = "";
    if (typeof json.context === "string") text = json.context;
    else if (Array.isArray(json.results)) {
      text = json.results
        .map((r) => (typeof r.text === "string" ? r.text : typeof r.content === "string" ? r.content : ""))
        .filter(Boolean)
        .join("\n---\n");
    }
    // Eco de credencial nunca entra no prompt.
    text = sanitizeResponseBody(text, [cred.value], Number.MAX_SAFE_INTEGER);
    const max = rag.max_context_chars ?? 8000;
    return text.length > max ? text.slice(0, max) : text;
  } catch (err) {
    log(err instanceof Error ? err.name : "erro");
    return "";
  }
}
