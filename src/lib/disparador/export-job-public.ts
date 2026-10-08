import type { ExportJob } from "@/lib/disparador/export-jobs";

/** Formato público do job (contrato com o front): sem caminho de arquivo, dono nem lease. */
export function toPublicExportJob(job: ExportJob) {
  return {
    id: job.id,
    campaign_id: job.campaign_id,
    status_key: job.status_key,
    format: job.format,
    state: job.state,
    rows_done: job.rows_done,
    total_rows: job.total_rows,
    progress: job.total_rows && job.total_rows > 0 ? Math.min(1, job.rows_done / job.total_rows) : null,
    truncated: job.truncated,
    file_size: job.file_size,
    created_at: job.created_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    error: job.state === "failed" ? job.last_error : null,
  };
}
