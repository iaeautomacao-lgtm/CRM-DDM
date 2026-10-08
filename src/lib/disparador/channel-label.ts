// Nome e telefone dos números nas telas do disparador (Números/Controles, Monitor, Erros, Desempenho) — iguais à tela Canais (TASK24).
//
// A tela Canais lê AO VIVO da Meta (verified_name / display_phone_number). Aqui usamos o último valor que o poll/webhook de saúde gravou em
// channel_health (migration 193) e, só como reserva, whatsapp_config. Regras:
//   nome     = channel_health.verified_name → (Meta) "Meta sem nome" | (WAHA) waha_session → "WAHA sem nome"   (nunca o começo do UUID)
//   telefone = channel_health.display_phone_number → whatsapp_config.display_phone_number → phone_number_id
//   conexão  = último poll falhou (channel_health.last_error) → "Desconectado"; poll ok → "Conectado"; sem leitura → null (desconhecido)
//
// Colunas usadas: ver CHANNEL_CONFIG_COLUMNS / CHANNEL_HEALTH_COLUMNS (um teste as confere contra as migrations — o #143 nasceu de colunas
// inexistentes que os mocks não pegaram).

export const CHANNEL_CONFIG_COLUMNS = "id, display_phone_number, phone_number_id, waha_session, provider, habilitado";
export const CHANNEL_HEALTH_COLUMNS = "session_id, verified_name, display_phone_number, last_error, checked_at";
/** Antes da migration 193 (sem nome/telefone da Meta em channel_health). */
export const CHANNEL_HEALTH_COLUMNS_LEGACY = "session_id, last_error, checked_at";

export interface ChannelConfigRow {
  id: string;
  display_phone_number?: string | null;
  phone_number_id?: string | null;
  waha_session?: string | null;
  provider?: string | null;
  habilitado?: boolean | null;
}

export interface ChannelHealthRow {
  session_id?: string;
  verified_name?: string | null;
  display_phone_number?: string | null;
  last_error?: string | null;
  checked_at?: string | null;
}

export interface ChannelIdentity {
  id: string;
  provider: "meta" | "waha" | "unknown";
  enabled: boolean;
  /** Nome para exibir (nunca vazio, nunca pedaço de UUID). */
  name: string;
  /** Telefone para exibir, ou null. */
  phone: string | null;
  /** "Nome · telefone" (ou só o nome) — para telas que têm um campo só. */
  label: string;
  /** true = último poll ok; false = último poll falhou; null = sem leitura. */
  connected: boolean | null;
  connectionError: string | null;
  checkedAt: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : null;
};

export function channelLabel(config: ChannelConfigRow, health?: ChannelHealthRow | null): ChannelIdentity {
  const provider = config.provider === "meta" || config.provider === "waha" ? config.provider : "unknown";
  const name =
    clean(health?.verified_name) ?? (provider === "waha" ? (clean(config.waha_session) ?? "WAHA sem nome") : "Meta sem nome");
  const phone = clean(health?.display_phone_number) ?? clean(config.display_phone_number) ?? clean(config.phone_number_id);
  const hasReading = !!health && !!clean(health.checked_at);
  const error = clean(health?.last_error);
  return {
    id: config.id,
    provider,
    enabled: config.habilitado !== false,
    name,
    phone,
    label: phone ? `${name} · ${phone}` : name,
    connected: hasReading ? !error : null,
    connectionError: error,
    checkedAt: clean(health?.checked_at),
  };
}

/** Habilitados primeiro; depois por nome (pt-BR). Estável. */
export function sortChannels<T extends Pick<ChannelIdentity, "enabled" | "name">>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "pt-BR"));
}

type DbResult<T> = { data: T | null; error: { message: string; code?: string } | null };
// Qualquer cliente do tipo Supabase (os módulos do disparador tipam o seu de formas diferentes).
type AnyDb = { from(table: string): unknown };
const run = async <T>(q: unknown): Promise<DbResult<T>> => (await (q as PromiseLike<DbResult<T>>)) as DbResult<T>;

const unavailable = (e: { message: string; code?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "42703" || e.code === "PGRST205" || e.code === "PGRST204" || /does not exist|schema cache|column/i.test(e.message));

async function loadHealth(db: AnyDb, accountId: string): Promise<Map<string, ChannelHealthRow>> {
  const query = (columns: string) =>
    (db.from("channel_health") as { select(c: string): { eq(c: string, v: string): { limit(n: number): unknown } } })
      .select(columns)
      .eq("account_id", accountId)
      .limit(1000);
  let res = await run<ChannelHealthRow[]>(query(CHANNEL_HEALTH_COLUMNS));
  if (res.error && unavailable(res.error)) res = await run<ChannelHealthRow[]>(query(CHANNEL_HEALTH_COLUMNS_LEGACY));
  // Sem a tabela/colunas (migration 190/193 pendentes) ou falha de leitura: segue só com whatsapp_config — nunca derruba a tela.
  if (res.error) return new Map();
  return new Map((res.data ?? []).map((h) => [String(h.session_id), h]));
}

/** Canais da conta (ou só `sessionId`) com nome/telefone/conexão resolvidos, habilitados primeiro. */
export async function loadChannelIdentities(db: AnyDb, accountId: string, options: { sessionId?: string } = {}): Promise<ChannelIdentity[]> {
  type ConfigQuery = { select(c: string): { eq(c: string, v: string): { eq(c: string, v: string): unknown; limit(n: number): unknown } } };
  const q = (db.from("whatsapp_config") as ConfigQuery).select(CHANNEL_CONFIG_COLUMNS).eq("account_id", accountId) as {
    eq(c: string, v: string): { limit(n: number): unknown };
    limit(n: number): unknown;
  };
  const query = options.sessionId ? q.eq("id", options.sessionId).limit(1) : q.limit(500);
  const { data, error } = await run<ChannelConfigRow[]>(query);
  if (error) throw new Error(`Falha ao ler números: ${error.message}`);
  const health = await loadHealth(db, accountId);
  return sortChannels((data ?? []).map((c) => channelLabel(c, health.get(c.id))));
}
