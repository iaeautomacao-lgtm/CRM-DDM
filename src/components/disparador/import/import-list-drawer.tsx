"use client";

// Gaveta "Importar lista": o navegador lê o arquivo (CSV/XLSX), a pessoa confirma as colunas e dá um nome; os
// blocos vão para o job em segundo plano (POST /imports → PUT /blocks/[n] → POST /start) e o progresso segue
// pelo GET /imports/[id]. Depois do start, fechar a gaveta (ou a aba) não interrompe a importação.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { StatusChip } from "@/components/ddm/status-chip";
import { suggestImportColumnMap, type ImportColumnMap } from "@/lib/disparador/import-mapping";
import { parseImportCsv, tableFromMatrix, type ParsedImportTable } from "@/lib/disparador/import-parse";
import {
  IMPORT_MAX_BLOCKS,
  firstMissingBlock,
  IMPORT_STATE_LABEL,
  importPercent,
  isActiveImport,
  mappingIsValid,
  planImportBlocks,
  tableToRowObjects,
  type PublicImportJob,
} from "@/lib/disparador/import-client";
import { ImportJobSummary } from "./import-job-summary";

const POLL_MS = 3000;

const FIELDS: ReadonlyArray<{ key: keyof ImportColumnMap; label: string; required?: boolean }> = [
  { key: "phone", label: "Contato (telefone)", required: true },
  { key: "name", label: "Nome" },
  { key: "cpf", label: "CPF" },
  { key: "var1", label: "VAR1" },
  { key: "var2", label: "VAR2" },
  { key: "var3", label: "VAR3" },
];

type Phase =
  | { kind: "pick" }
  | { kind: "map" }
  | { kind: "upload"; sent: number; total: number }
  | { kind: "upload-error"; failedAt: number; total: number; message: string }
  | { kind: "tracking" };

async function readBody(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Erro HTTP ${res.status}`) as Error & { code?: string };
    err.code = body?.code;
    throw err;
  }
  return body;
}

export function ImportListDrawer({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Avisado quando o job é liberado e a cada mudança de estado (para a lista atualizar). */
  onStarted: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState<ParsedImportTable | null>(null);
  const [map, setMap] = useState<ImportColumnMap>({});
  const [name, setName] = useState("");
  const [reading, setReading] = useState(false);
  const [job, setJob] = useState<PublicImportJob | null>(null);
  const blocksRef = useRef<Record<string, string>[][]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setPhase({ kind: "pick" });
    setFile(null);
    setTable(null);
    setMap({});
    setName("");
    setJob(null);
    blocksRef.current = [];
  }, []);

  // Ao fechar depois de iniciado, começa do zero na próxima vez (o job segue no servidor).
  const close = (o: boolean) => {
    if (!o && phase.kind === "upload") return; // não fecha no meio do envio dos blocos
    onOpenChange(o);
    if (!o && (phase.kind === "tracking" || phase.kind === "pick")) reset();
  };

  const onFile = async (f: File) => {
    setReading(true);
    try {
      let parsed: ParsedImportTable;
      if (/\.xlsx?$/i.test(f.name)) {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await f.arrayBuffer(), { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        parsed = tableFromMatrix(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false }));
      } else {
        parsed = parseImportCsv(await f.text());
      }
      if (parsed.rows.length === 0) {
        toast.error("Arquivo vazio ou sem dados.");
        return;
      }
      const blocks = planImportBlocks(tableToRowObjects(parsed));
      if (blocks.length > IMPORT_MAX_BLOCKS) {
        toast.error(`Arquivo grande demais: o limite é de ${IMPORT_MAX_BLOCKS} blocos de até 10.000 linhas.`);
        return;
      }
      blocksRef.current = blocks;
      setFile(f);
      setTable(parsed);
      setMap(suggestImportColumnMap(parsed.headers));
      setName(f.name.replace(/\.[^.]+$/, "").slice(0, 120));
      setPhase({ kind: "map" });
    } catch {
      toast.error("Não foi possível ler o arquivo.");
    } finally {
      setReading(false);
    }
  };

  /** Envia os blocos a partir de `from` (reenviar é idempotente) e libera o job. */
  const sendFrom = async (jobId: string, from: number) => {
    const blocks = blocksRef.current;
    for (let n = from; n < blocks.length; n++) {
      setPhase({ kind: "upload", sent: n, total: blocks.length });
      try {
        await readBody(
          await apiFetch(`/api/disparador/imports/${jobId}/blocks/${n}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: blocks[n] }),
          }),
        );
      } catch (err) {
        setPhase({ kind: "upload-error", failedAt: n, total: blocks.length, message: err instanceof Error ? err.message : "Falha ao enviar o bloco" });
        return;
      }
    }
    setPhase({ kind: "upload", sent: blocks.length, total: blocks.length });
    try {
      const body = await readBody(
        await apiFetch(`/api/disparador/imports/${jobId}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ total_blocks: blocks.length }),
        }),
      );
      setJob(body.job as PublicImportJob);
      setPhase({ kind: "tracking" });
      onStarted();
    } catch (err) {
      const e = err as Error & { code?: string };
      // blocks_missing: reenvia a partir do primeiro que faltou.
      const first = e.code === "blocks_missing" ? firstMissingBlock(e.message) : 0;
      setPhase({ kind: "upload-error", failedAt: first, total: blocks.length, message: e.message });
    }
  };

  const start = async () => {
    if (!table || !mappingIsValid(map, table.headers)) return;
    setPhase({ kind: "upload", sent: 0, total: blocksRef.current.length });
    try {
      // Rascunho próprio da lista (sem campanha): é o vínculo que permite reutilizá-la depois.
      const body = await readBody(
        await apiFetch("/api/disparador/imports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draft_id: crypto.randomUUID(),
            column_map: map,
            mapping_confirmed: true,
            ...(name.trim() ? { name: name.trim() } : {}),
          }),
        }),
      );
      const created = body.job as PublicImportJob;
      setJob(created);
      await sendFrom(created.id, 0);
    } catch (err) {
      setPhase({ kind: "map" });
      toast.error(err instanceof Error ? err.message : "Não foi possível criar a importação.");
    }
  };

  // Acompanha o job enquanto a gaveta mostra o progresso.
  useEffect(() => {
    if (phase.kind !== "tracking" || !job || !isActiveImport(job.state)) return;
    const t = setInterval(async () => {
      try {
        const body = await readBody(await apiFetch(`/api/disparador/imports/${job.id}`));
        const next = body.job as PublicImportJob;
        setJob(next);
        if (!isActiveImport(next.state)) onStarted();
      } catch {
        // rede: tenta de novo no próximo ciclo
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [phase.kind, job, onStarted]);

  const valid = table ? mappingIsValid(map, table.headers) : false;
  const sending = phase.kind === "upload";

  return (
    <DetailDrawer
      open={open}
      onOpenChange={close}
      title="Importar lista"
      description="CSV ou XLSX. A importação roda em segundo plano: depois de enviada, pode fechar esta janela."
      size="lg"
      footer={
        phase.kind === "map" ? (
          <>
            <Button variant="outline" onClick={reset}>
              Trocar arquivo
            </Button>
            <Button onClick={() => void start()} disabled={!valid}>
              <Upload className="size-3.5" aria-hidden="true" /> Importar {table?.rows.length.toLocaleString("pt-BR")} linhas
            </Button>
          </>
        ) : phase.kind === "upload-error" && job ? (
          <>
            <Button variant="outline" onClick={() => close(false)}>
              Fechar
            </Button>
            <Button onClick={() => void sendFrom(job.id, phase.failedAt)}>
              <RotateCcw className="size-3.5" aria-hidden="true" /> Retomar do bloco {phase.failedAt + 1}
            </Button>
          </>
        ) : phase.kind === "tracking" ? (
          <Button variant="outline" onClick={() => close(false)}>
            {job && isActiveImport(job.state) ? "Fechar (continua em segundo plano)" : "Fechar"}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {phase.kind === "pick" && (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={reading}
            className="flex flex-col items-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-border-strong bg-surface-3 px-6 py-8 text-center transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
          >
            {reading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            ) : (
              <FileSpreadsheet className="size-5 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="text-[13px] font-semibold text-foreground">{reading ? "Lendo o arquivo…" : "Escolher arquivo"}</span>
            <span className="text-xs text-muted-foreground">CSV ou XLSX, com uma coluna de telefone</span>
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onFile(f);
          }}
        />

        {table && file && phase.kind !== "pick" && (
          <div className="flex items-center gap-2.5 rounded-lg bg-surface-3 px-3 py-2.5 text-[12.5px]">
            <FileSpreadsheet className="size-4 shrink-0 text-foreground-2" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{file.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {table.rows.length.toLocaleString("pt-BR")} linhas · {blocksRef.current.length} bloco{blocksRef.current.length === 1 ? "" : "s"}
            </span>
          </div>
        )}

        {phase.kind === "map" && table && (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
              Nome da lista
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Base de outubro" />
              <span className="font-normal text-muted-foreground">Ajuda a achar a lista depois. Pode deixar em branco.</span>
            </label>
            <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="mb-1 text-[13px] font-semibold text-foreground">Colunas do arquivo</legend>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {FIELDS.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
                    <span>
                      {f.label}
                      {f.required && <span className="text-danger"> *</span>}
                    </span>
                    <select
                      value={map[f.key] ?? ""}
                      onChange={(e) => setMap((m) => ({ ...m, [f.key]: e.target.value || undefined }))}
                      className={cn(
                        "h-8 w-full rounded-[6px] border bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        f.required && !map[f.key] ? "border-danger" : "border-input",
                      )}
                    >
                      <option value="">{f.required ? "Escolha a coluna" : "Não usar"}</option>
                      {table.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {!valid && <p className="m-0 text-xs font-medium text-danger">Escolha a coluna de contato (telefone).</p>}
            </fieldset>
            <div>
              <p className="m-0 mb-1.5 text-xs font-semibold text-foreground-2">Prévia (primeiras linhas)</p>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {table.headers.map((h) => (
                        <th key={h} scope="col" className="whitespace-nowrap border-b border-border bg-surface-3 px-2.5 py-1.5 text-left font-semibold text-muted-foreground">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, 3).map((r, i) => (
                      <tr key={i}>
                        {table.headers.map((h, j) => (
                          <td key={h} className="max-w-[160px] truncate border-b border-border px-2.5 py-1.5 text-foreground-2">
                            {r[j] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {(phase.kind === "upload" || phase.kind === "upload-error") && (
          <section aria-live="polite" className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span className="font-semibold text-foreground">
                {phase.kind === "upload" ? (phase.sent < phase.total ? "Enviando o arquivo" : "Liberando a importação") : "Envio interrompido"}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {phase.kind === "upload" ? Math.min(phase.sent, phase.total) : phase.failedAt} de {phase.total} blocos
              </span>
            </div>
            <ProgressBar pct={phase.kind === "upload" ? (phase.sent / Math.max(1, phase.total)) * 100 : (phase.failedAt / Math.max(1, phase.total)) * 100} tone={phase.kind === "upload-error" ? "bad" : "brand"} />
            {phase.kind === "upload" ? (
              <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Mantenha esta janela aberta até o envio terminar.
              </p>
            ) : (
              <p role="alert" className="m-0 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
                {phase.message} Os blocos já enviados ficam guardados; retome para continuar (reenviar não duplica).
              </p>
            )}
          </section>
        )}

        {phase.kind === "tracking" && job && (
          <section aria-live="polite" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <StatusChip tone={job.state === "done" ? "ok" : job.state === "failed" || job.state === "cancelled" ? "bad" : "brand"}>
                {IMPORT_STATE_LABEL[job.state]}
              </StatusChip>
              <span className="text-[13px] font-semibold tabular-nums text-foreground">{importPercent(job)}%</span>
            </div>
            <ProgressBar pct={importPercent(job)} tone={job.state === "failed" ? "bad" : job.state === "done" ? "ok" : "brand"} />
            <p className="m-0 text-xs tabular-nums text-muted-foreground">
              {job.rows_done.toLocaleString("pt-BR")} de {job.rows_total.toLocaleString("pt-BR")} linhas processadas
            </p>
            {job.state === "done" && (
              <p className="m-0 flex items-center gap-1.5 text-[13px] font-medium text-success">
                <CheckCircle2 className="size-4" aria-hidden="true" /> Lista importada.
              </p>
            )}
            <ImportJobSummary job={job} />
          </section>
        )}
      </div>
    </DetailDrawer>
  );
}

export function ProgressBar({ pct, tone = "brand" }: { pct: number; tone?: "brand" | "ok" | "bad" }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(w)}
      className="block h-2 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-500 ease-out",
          tone === "ok" ? "bg-success" : tone === "bad" ? "bg-danger" : "bg-primary",
        )}
        style={{ width: `${w}%` }}
      />
    </span>
  );
}
