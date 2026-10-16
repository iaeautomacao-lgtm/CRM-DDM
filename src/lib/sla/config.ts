// SLA de primeira resposta (migration 381): ponto ÚNICO das regras. Puro (sem I/O): serve ao servidor, ao navegador e aos testes.
// Precedência: SLA da equipe (teams.first_response_sla_min) > padrão da conta (account_settings.first_response_sla_min) > 15 min (o valor fixo de antes).

/** Valor de fábrica: o que valia fixo no Monitoramento antes da configuração por equipe. */
export const SLA_FALLBACK_MINUTES = 15;
export const SLA_MIN_MINUTES = 1;
export const SLA_MAX_MINUTES = 1440;

export const SLA_RANGE_ERROR = "O SLA da primeira resposta deve ser um número inteiro de 1 a 1440 minutos, ou vazio para usar o padrão da conta.";

/** Minutos válidos (inteiro de 1 a 1440)? */
export function isValidSlaMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= SLA_MIN_MINUTES && value <= SLA_MAX_MINUTES;
}

/** Valor gravado → minutos válidos ou null (lixo no banco nunca vira meta: cai no próximo nível). */
export function slaMinutesOrNull(value: unknown): number | null {
  return isValidSlaMinutes(value) ? value : null;
}

export interface SlaConfig {
  /** Padrão efetivo da conta (15 quando a conta não configurou). */
  defaultMin: number;
  defaultSource: "account" | "default";
  /** Valor PRÓPRIO de cada equipe (null = usa o padrão). Só equipes com a coluna lida. */
  teams: Record<string, number | null>;
}

/** Meta efetiva de uma equipe; sem equipe (null/"none") ou equipe desconhecida = padrão da conta. */
export function effectiveSlaMinutes(config: SlaConfig, teamId: string | null | undefined): number {
  if (!teamId) return config.defaultMin;
  return config.teams[teamId] ?? config.defaultMin;
}

/** Mapa equipe → meta efetiva (já resolvida). */
export function effectiveByTeam(config: SlaConfig): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, own] of Object.entries(config.teams)) out[id] = own ?? config.defaultMin;
  return out;
}

/** Configuração sem nada gravado (também o que vale sem a migration 381 / sem a 231). */
export const DEFAULT_SLA_CONFIG: SlaConfig = { defaultMin: SLA_FALLBACK_MINUTES, defaultSource: "default", teams: {} };
