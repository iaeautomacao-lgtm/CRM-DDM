// Cliente do copiloto interno (Acordito). Contrato (backend do Cinzel):
//   POST /api/ai/copilot/suggestions {conversationId, force?} -> {suggestions:[{id,text}], basedOnMessageId, cached}
//   POST /api/ai/copilot/feedback    {suggestionId, action}   -> 204
//   GET/PUT /api/account/copilot-config {enabled, guidance}
// Nada aqui envia mensagem: o texto só vai para o campo do compositor.
import { apiFetch } from "@/lib/api-fetch";

/** Orientação padrão NEUTRA, exibida só como dica; o texto de verdade vem da operação. */
export const ACORDITO_DEFAULT_GUIDANCE = "Sugira respostas curtas, educadas e objetivas em português.";
export const ACORDITO_GUIDANCE_MAX = 1_000;

export type AcorditoErrorCode = "ai_not_configured" | "copilot_disabled" | "quota_exceeded" | "forbidden" | "unknown";
export type AcorditoFeedbackAction = "used" | "edited" | "ignored";

export interface AcorditoSuggestion {
  id: string;
  text: string;
}
export interface AcorditoSuggestions {
  suggestions: AcorditoSuggestion[];
  basedOnMessageId: string | null;
  cached: boolean;
}

export class AcorditoError extends Error {
  readonly code: AcorditoErrorCode;
  constructor(code: AcorditoErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const KNOWN: ReadonlySet<string> = new Set(["ai_not_configured", "copilot_disabled", "quota_exceeded", "forbidden"]);

/** Microcopy curta e amigável por código de erro. */
export const ACORDITO_MESSAGES: Record<AcorditoErrorCode, string> = {
  ai_not_configured: "A IA ainda não está configurada nesta conta. Peça a um administrador para cadastrar a chave.",
  copilot_disabled: "O Acordito está desligado no atendimento desta conta.",
  quota_exceeded: "A cota de IA de hoje acabou. O Acordito volta amanhã.",
  forbidden: "Você não tem permissão para pedir sugestões nesta conversa.",
  unknown: "Não consegui pensar em sugestões agora. Tente de novo.",
};

export function errorCodeOf(value: unknown): AcorditoErrorCode {
  return typeof value === "string" && KNOWN.has(value) ? (value as AcorditoErrorCode) : "unknown";
}

async function readCode(res: Response): Promise<AcorditoErrorCode> {
  try {
    const body = (await res.json()) as { code?: unknown };
    const code = errorCodeOf(body?.code);
    return code === "unknown" && res.status === 403 ? "forbidden" : code;
  } catch {
    return res.status === 403 ? "forbidden" : "unknown";
  }
}

export function parseSuggestions(raw: unknown): AcorditoSuggestions {
  const o = (raw ?? {}) as Partial<AcorditoSuggestions>;
  const suggestions = Array.isArray(o.suggestions)
    ? o.suggestions.filter(
        (s): s is AcorditoSuggestion => !!s && typeof s.id === "string" && typeof s.text === "string" && s.text.trim() !== "",
      )
    : [];
  return {
    suggestions: suggestions.slice(0, 3),
    basedOnMessageId: typeof o.basedOnMessageId === "string" ? o.basedOnMessageId : null,
    cached: o.cached === true,
  };
}

export async function fetchSuggestions(conversationId: string, opts: { force?: boolean } = {}): Promise<AcorditoSuggestions> {
  let res: Response;
  try {
    res = await apiFetch("/api/ai/copilot/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, ...(opts.force ? { force: true } : {}) }),
    });
  } catch {
    throw new AcorditoError("unknown", ACORDITO_MESSAGES.unknown);
  }
  if (!res.ok) {
    const code = await readCode(res);
    throw new AcorditoError(code, ACORDITO_MESSAGES[code]);
  }
  return parseSuggestions(await res.json().catch(() => null));
}

/** Fire-and-forget: falha de métrica nunca atrapalha o atendimento. */
export function sendFeedback(suggestionId: string, action: AcorditoFeedbackAction): void {
  void apiFetch("/api/ai/copilot/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suggestionId, action }),
  }).catch(() => {});
}

export interface CopilotConfig {
  enabled: boolean;
  guidance: string;
}

export async function fetchCopilotConfig(): Promise<CopilotConfig> {
  const res = await apiFetch("/api/account/copilot-config");
  if (!res.ok) throw new AcorditoError(await readCode(res), "Não foi possível carregar a configuração do Acordito.");
  const b = (await res.json().catch(() => ({}))) as Partial<CopilotConfig>;
  return { enabled: b.enabled === true, guidance: typeof b.guidance === "string" ? b.guidance : "" };
}

export async function saveCopilotConfig(config: CopilotConfig): Promise<CopilotConfig> {
  const res = await apiFetch("/api/account/copilot-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const code = await readCode(res);
    throw new AcorditoError(code, code === "forbidden" ? "Só quem configura a IA pode alterar o Acordito." : "Não foi possível salvar o Acordito.");
  }
  const b = (await res.json().catch(() => null)) as Partial<CopilotConfig> | null;
  return { enabled: b?.enabled ?? config.enabled, guidance: b?.guidance ?? config.guidance };
}
