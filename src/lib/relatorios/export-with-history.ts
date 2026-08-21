import * as XLSX from "xlsx";

export interface ExportColumn {
  key: string;
  label: string;
}

export interface ExportOptions {
  data: Record<string, unknown>[];
  columns: ExportColumn[];
  exportType: "conversas" | "envio-em-lote" | "atendimentos";
  description: string;
  periodFrom?: Date;
  periodTo?: Date;
  format: "xlsx" | "csv";
}

// Generates the file exactly as the existing export buttons already
// do (SheetJS, download via XLSX.writeFile — behavior unchanged), and
// additionally uploads it + records it in export_history via
// /api/relatorios/exports so it's downloadable again later from
// /relatorios/exportacoes. The download always happens; the history
// write is best-effort and never blocks it (see the catch below).
export async function exportWithHistory(options: ExportOptions): Promise<void> {
  const sheetRows = options.data.map((row) =>
    Object.fromEntries(options.columns.map((c) => [c.label, row[c.key]])),
  );
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dados");

  const ext = options.format === "csv" ? "csv" : "xlsx";
  const fileName = `${options.exportType}_${new Date().toISOString().slice(0, 10)}.${ext}`;

  const wbout = XLSX.write(wb, {
    bookType: options.format === "csv" ? "csv" : "xlsx",
    type: "base64",
  }) as string;

  try {
    await apiFetch("/api/relatorios/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exportType: options.exportType,
        description: options.description,
        periodFrom: options.periodFrom?.toISOString(),
        periodTo: options.periodTo?.toISOString(),
        fileName,
        fileBase64: wbout,
        fileSize: Math.round(wbout.length * 0.75),
      }),
    });
  } catch (err) {
    console.error("[export] falha ao registrar histórico:", err);
    // Non-blocking: the download below still happens even if the
    // history write failed (network error, server hiccup, etc.) —
    // the export itself is more important than its own record.
  }

  XLSX.writeFile(wb, fileName, {
    bookType: options.format === "csv" ? "csv" : "xlsx",
  });
}
import { apiFetch } from "@/lib/api-fetch";