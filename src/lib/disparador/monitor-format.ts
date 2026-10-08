// Apresentação do Monitor ao vivo (textos em português). Puro e testável.

const NF = new Intl.NumberFormat("pt-BR");
export const formatInt = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : NF.format(Math.round(n)));

/** "agora", "35 min", "2 h 10 min", "1 d 3 h" — texto curto em português. */
export function formatEtaPt(minutes: number | null): string {
  if (minutes === null) return "sem ritmo";
  if (minutes <= 0) return "concluído";
  if (minutes < 1) return "menos de 1 min";
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours < 24) return mins ? `${hours} h ${mins} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days} d ${remH} h` : `${days} d`;
}

/** "há 5 s", "há 3 min", "há 2 h". */
export function timeAgoPt(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 5) return "agora";
  if (seconds < 60) return `há ${Math.round(seconds)} s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

export function secondsSince(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
}

export const CLASSE_LABELS: Record<string, string> = {
  destinatario: "Problema do contato",
  campanha_template: "Campanha / template",
  canal_conta: "Canal / conta Meta",
  limite: "Limite de envio",
  transitorio: "Instabilidade da Meta",
  janela24h: "Janela de 24 h",
  desconhecido: "Código não catalogado",
  sem_codigo: "Sem código da Meta",
};
export const classeLabelPt = (classe: string): string => CLASSE_LABELS[classe] ?? classe;

export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  em_execucao: "Em execução",
  pausada: "Pausada",
  agendado: "Agendada",
  preparando: "Preparando",
  concluida: "Concluída",
  encerrada: "Encerrada",
  rascunho: "Rascunho",
};
export const campaignStatusLabelPt = (status: string): string => CAMPAIGN_STATUS_LABELS[status] ?? status;

export const NUMBER_STATUS_LABELS = {
  ok: "Normal",
  freio: "Com freio",
  cooldown: "Em cooldown",
  desligado: "Desligado",
} as const;

/** Href da lista de itens de uma campanha filtrada por código de erro (migration 187). */
export function errorItemsHref(campaignId: string, code: number | null): string {
  const params = new URLSearchParams({ status: "erro" });
  if (code !== null) params.set("codigo", String(code));
  return `/disparador/campanhas/${campaignId}?${params.toString()}`;
}
