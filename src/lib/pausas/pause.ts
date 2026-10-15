// Pausas de atendimento — tipos e regras puras do front.
// Contrato das rotas: prd-v2/pausas-contrato-api.md (backend: Cinzel).

export type PauseEndKind = "manual" | "supervisor" | "desconexao";

export interface Pause {
  id: string;
  user_id: string;
  user_name?: string | null;
  reason_id: string | null;
  reason_name: string;
  max_minutes: number | null;
  started_at: string;
  ended_at: string | null;
  end_kind: PauseEndKind | null;
  started_by: string;
  started_by_name?: string | null;
  by_supervisor: boolean;
  ended_by: string | null;
  alerted_at: string | null;
  elapsed_seconds: number;
  exceeded: boolean;
}

export interface TeamPause extends Pause {
  team_ids: string[];
}

export interface PauseReason {
  id: string;
  name: string;
  max_minutes: number | null;
  active: boolean;
  sort_order: number;
}

/** Atendente em pausa que recebeu uma atribuição manual (409 agent_paused do /transfer). */
export interface PausedAgentInfo {
  agentName: string;
  reasonName: string;
  startedAt: string;
}

export type PauseLevel = "ok" | "late" | "critical";

/** Segundos desde o início da pausa (nunca negativo). */
export function pauseElapsedSeconds(startedAt: string, nowMs: number): number {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((nowMs - start) / 1000));
}

/** Passou do tempo do motivo = atrasada (âmbar); passou do dobro = crítica (vermelho). Sem limite = ok. */
export function pauseLevel(elapsedSeconds: number, maxMinutes: number | null): PauseLevel {
  if (maxMinutes === null || maxMinutes <= 0) return "ok";
  const limit = maxMinutes * 60;
  if (elapsedSeconds > limit * 2) return "critical";
  if (elapsedSeconds > limit) return "late";
  return "ok";
}

/** Cronômetro: "07:05" ou "1:02:09". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Duração legível para selos e relatório: "45 s", "23 min", "1 h 05", "2 h". */
export function formatPauseDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${h} h` : `${h} h ${String(rest).padStart(2, "0")}`;
}

const END_KIND_LABEL: Record<PauseEndKind, string> = {
  manual: "Voltou sozinho",
  supervisor: "Retomada por supervisor",
  desconexao: "Encerrada por desconexão",
};

export function endKindLabel(kind: PauseEndKind | null): string {
  return kind ? END_KIND_LABEL[kind] : "Em andamento";
}

/** Mensagem em português para os códigos de erro das rotas de pausas. */
export function pauseErrorMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "already_paused":
      return "Esta pessoa já está em pausa.";
    case "forbidden":
      return "Você não tem permissão para fazer isso.";
    case "other_team":
      return "Você só pode pausar atendentes das suas equipes.";
    case "paused_by_supervisor":
      return fallback ?? "Esta pausa foi aplicada por um supervisor; só ele pode retomar.";
    case "not_paused":
      return "Não há pausa em andamento.";
    case "reason_inactive":
      return "Este motivo foi desativado. Escolha outro.";
    case "reason_name_taken":
      return "Já existe um motivo com esse nome.";
    case "reason_not_found":
    case "user_not_found":
    case "not_found":
      return "Não encontrado. Atualize a página e tente de novo.";
    case "invalid_reason":
    case "invalid_request":
      return fallback ?? "Confira os campos e tente de novo.";
    default:
      return fallback ?? "Não foi possível concluir. Tente de novo.";
  }
}

export const MAX_REASON_NAME_LEN = 40;
const MAX_REASON_MINUTES = 1440;

/** Valida o formulário e devolve o corpo da requisição ou a mensagem de erro. */
export function parseReasonForm(
  name: string,
  minutes: string,
): { ok: true; body: { name: string; max_minutes: number | null } } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Dê um nome ao motivo.' };
  if (trimmed.length > MAX_REASON_NAME_LEN) return { ok: false, error: `O nome pode ter até ${MAX_REASON_NAME_LEN} caracteres.` };
  const raw = minutes.trim();
  if (raw === '') return { ok: true, body: { name: trimmed, max_minutes: null } };
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'O tempo máximo deve ser um número de minutos.' };
  const n = Number(raw);
  if (n < 1 || n > MAX_REASON_MINUTES) return { ok: false, error: `O tempo máximo deve ficar entre 1 e ${MAX_REASON_MINUTES} minutos.` };
  return { ok: true, body: { name: trimmed, max_minutes: n } };
}

