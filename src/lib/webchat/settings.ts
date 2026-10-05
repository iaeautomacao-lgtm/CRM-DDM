import type { SupabaseClient } from "@supabase/supabase-js";

// Configuração do Webchat por conta (migration 133, tela /canais).
// Sem linha na tabela — ou sem a migration — valem os padrões abaixo, que
// reproduzem o comportamento anterior.

export const WEBCHAT_SESSION_HOURS_DEFAULT = 24;
export const WEBCHAT_SESSION_HOURS_MAX = 72;
export const WEBCHAT_BUTTON_MAX = 20;

export interface WebchatSettings {
  display_name: string | null;
  welcome_message: string | null;
  accent_color: string | null;
  session_hours: number;
  default_invite_message: string | null;
  default_button_text: string | null;
  default_flow_id: string | null;
}

export const DEFAULT_WEBCHAT_SETTINGS: WebchatSettings = {
  display_name: null,
  welcome_message: null,
  accent_color: null,
  session_hours: WEBCHAT_SESSION_HOURS_DEFAULT,
  default_invite_message: null,
  default_button_text: null,
  default_flow_id: null,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/** Valida/normaliza o que vem do formulário (PUT). Puro, testável. */
export function normalizeWebchatSettings(input: Record<string, unknown>): WebchatSettings {
  const hours = Math.trunc(Number(input.session_hours));
  const color = typeof input.accent_color === "string" ? input.accent_color.trim() : "";
  return {
    display_name: text(input.display_name, 60),
    welcome_message: text(input.welcome_message, 300),
    accent_color: /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null,
    session_hours:
      Number.isFinite(hours) && hours >= 1
        ? Math.min(hours, WEBCHAT_SESSION_HOURS_MAX)
        : WEBCHAT_SESSION_HOURS_DEFAULT,
    default_invite_message: text(input.default_invite_message, 1000),
    default_button_text: text(input.default_button_text, WEBCHAT_BUTTON_MAX),
    default_flow_id:
      typeof input.default_flow_id === "string" && UUID_RE.test(input.default_flow_id)
        ? input.default_flow_id
        : null,
  };
}

/** Boas-vindas da página do cliente, com o primeiro nome no lugar de {nome}. */
export function renderWelcome(template: string | null, firstName: string | null): string {
  if (!template) return `${firstName ? `Olá, ${firstName}! ` : "Olá! "}Já vamos te atender.`;
  return template.replace(/\{nome\}/gi, firstName ?? "").replace(/\s+([,!.?])/g, "$1").trim();
}

export async function loadWebchatSettings(db: SupabaseClient, accountId: string): Promise<WebchatSettings> {
  const { data, error } = await db
    .from("webchat_settings")
    .select(
      "display_name, welcome_message, accent_color, session_hours, default_invite_message, default_button_text, default_flow_id",
    )
    .eq("account_id", accountId)
    .limit(1);
  // Sem a migration 133 (ou sem linha): padrões.
  if (error || !data?.[0]) return DEFAULT_WEBCHAT_SETTINGS;
  return { ...DEFAULT_WEBCHAT_SETTINGS, ...(data[0] as Partial<WebchatSettings>) };
}
