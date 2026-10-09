// Pedido de exportação do Histórico (POST /api/historico/exports): o usuário escolhe dias
// (De/Até, inclusivos); a rota espera ISO com o fim EXCLUSIVO e no máximo 366 dias.

export const HISTORY_EXPORT_MAX_DAYS = 366;

export type ExportJobState = "pending" | "running" | "done" | "failed" | "cancelled";

export const EXPORT_STATE_LABEL: Record<ExportJobState, string> = {
  pending: "Na fila",
  running: "Gerando",
  done: "Pronta",
  failed: "Falhou",
  cancelled: "Cancelada",
};

export const EXPORT_STATE_TONE: Record<ExportJobState, "mute" | "info" | "ok" | "bad"> = {
  pending: "mute",
  running: "info",
  done: "ok",
  failed: "bad",
  cancelled: "mute",
};

/** Ainda vai mudar sozinho (vale continuar consultando). */
export function isExportActive(state: ExportJobState): boolean {
  return state === "pending" || state === "running";
}

export type BuildExportBody =
  | { ok: true; body: { period_from: string; period_to: string; tabulacao_id?: string } }
  | { ok: false; error: string };

/** De/Até em "AAAA-MM-DD" (dia local, inclusivos) → corpo do POST. */
export function buildHistoryExportBody(fromYmd: string, toYmd: string, tabulacaoId: string | null): BuildExportBody {
  const from = new Date(`${fromYmd}T00:00:00`);
  const toStart = new Date(`${toYmd}T00:00:00`);
  if (!fromYmd || !toYmd || Number.isNaN(from.getTime()) || Number.isNaN(toStart.getTime())) {
    return { ok: false, error: "Informe as duas datas." };
  }
  if (toStart < from) return { ok: false, error: "A data final deve ser igual ou depois da inicial." };
  const toExclusive = new Date(toStart);
  toExclusive.setDate(toExclusive.getDate() + 1);
  if (toExclusive.getTime() - from.getTime() > HISTORY_EXPORT_MAX_DAYS * 86_400_000) {
    return { ok: false, error: `O período máximo é de ${HISTORY_EXPORT_MAX_DAYS} dias por exportação.` };
  }
  return {
    ok: true,
    body: {
      period_from: from.toISOString(),
      period_to: toExclusive.toISOString(),
      ...(tabulacaoId ? { tabulacao_id: tabulacaoId } : {}),
    },
  };
}
