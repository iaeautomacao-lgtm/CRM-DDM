"use client";

// ============================================================
// /relatorios/exportacoes — reusable download history for every
// export generated across /relatorios (Conversas, Envio em Lote, ...
// via src/lib/relatorios/export-with-history.ts). Backed by
// wacrm.get_export_history (supabase/migrations/055_export_history.sql).
//
// Download uses createSignedUrl against the private `relatorio-exports`
// bucket — the first signed-URL usage in this codebase (Passo 0: every
// existing Storage read is getPublicUrl on a public bucket). Delete
// goes through /api/relatorios/exports (service-role — no client
// DELETE policy exists on either the table or the bucket).
//
// No AlertDialog primitive exists in this project's ui/ — the delete
// confirmation reuses the plain Dialog component (same as
// AuditDetailModal / TeamFormDialog / MessageModal).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  Download,
  MoreVertical,
  RefreshCw,
  Search,
  Square,
  SquareCheck,
  Trash2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";

const BUCKET = "relatorio-exports";

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  completed: { label: "Concluído", className: "bg-[#CCFBF1] text-[#0F766E]" },
};

interface RawExportRow {
  id: string;
  user_name: string | null;
  export_type: string;
  description: string;
  period_from: string | null;
  period_to: string | null;
  file_name: string;
  storage_path: string;
  file_size: string | number | null;
  status: string;
  created_at: string;
}

interface ExportRow {
  id: string;
  userName: string | null;
  exportType: string;
  description: string;
  periodFrom: string | null;
  periodTo: string | null;
  fileName: string;
  storagePath: string;
  fileSize: number;
  status: string;
  createdAt: string;
}

function normalizeRows(rows: RawExportRow[]): ExportRow[] {
  return rows.map((r) => ({
    id: r.id,
    userName: r.user_name,
    exportType: r.export_type,
    description: r.description,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    fileName: r.file_name,
    storagePath: r.storage_path,
    fileSize: Number(r.file_size ?? 0) || 0,
    status: r.status,
    createdAt: r.created_at,
  }));
}

function formatPeriod(from: string | null, to: string | null): string {
  if (!from && !to) return "-";
  const f = from ? format(new Date(from), "dd/MM/yyyy") : "-";
  const t = to ? format(new Date(to), "dd/MM/yyyy") : "-";
  return `${f} - ${t}`;
}

export default function ExportacoesPage() {
  const { accountId } = useAuth();

  const [draftSearch, setDraftSearch] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ExportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const db = createClient();
      const { data, error } = await db.rpc("get_export_history", {
        p_account_id: accountId,
        p_search: search.trim() ? search.trim() : null,
      });
      if (error) throw error;
      setRows(normalizeRows((data ?? []) as RawExportRow[]));
    } catch (err) {
      console.error("[exportacoes] failed to load export history:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId, search]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // Debounce: search auto-applies 300ms after typing settles, same as
  // the "Identificador" field on /relatorios/conversas.
  useEffect(() => {
    const t = setTimeout(() => setSearch(draftSearch), 300);
    return () => clearTimeout(t);
  }, [draftSearch]);

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  async function handleDownload(row: ExportRow) {
    setDownloadingId(row.id);
    try {
      const db = createClient();
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(row.storagePath, 3600);
      if (error) throw error;
      if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    } catch (err) {
      console.error("[exportacoes] failed to create signed url:", err);
    } finally {
      setDownloadingId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDeleteIds || pendingDeleteIds.length === 0) return;
    setDeleting(true);
    try {
      await Promise.all(
        pendingDeleteIds.map((id) =>
          fetch(`/api/relatorios/exports?id=${id}`, { method: "DELETE" }),
        ),
      );
      setSelected((prev) => {
        const next = new Set(prev);
        pendingDeleteIds.forEach((id) => next.delete(id));
        return next;
      });
      await runSearch();
    } catch (err) {
      console.error("[exportacoes] failed to delete export(s):", err);
    } finally {
      setDeleting(false);
      setPendingDeleteIds(null);
    }
  }

  const selectedCount = selected.size;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Exportações</h1>
        <p className="text-sm text-muted-foreground">
          Histórico de arquivos exportados nos relatórios — baixe novamente sem gerar de novo.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={draftSearch}
          onChange={(e) => setDraftSearch(e.target.value)}
          placeholder="Pesquisar por descrição ou solicitante"
          className="pl-8"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => runSearch()} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
        <Button variant="outline" size="sm" onClick={toggleSelectAll} disabled={rows.length === 0}>
          {allSelected ? <SquareCheck className="size-4" /> : <Square className="size-4" />}
          {allSelected ? "Desmarcar todos" : "Selecionar todos"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={selectedCount === 0}
          onClick={() => setPendingDeleteIds(Array.from(selected))}
        >
          <Trash2 className="size-4" />
          Excluir selecionados{selectedCount > 0 ? ` (${selectedCount})` : ""}
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Download}
              title="Nenhuma exportação ainda"
              hint="Arquivos exportados nos relatórios aparecem aqui para download posterior."
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data solicitação</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead>Período</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Solicitante</TableHead>
                <TableHead>Seleção</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const badge = STATUS_BADGE[row.status] ?? {
                  label: row.status,
                  className: "bg-muted text-muted-foreground",
                };
                return (
                  <TableRow key={row.id}>
                    <TableCell>{format(new Date(row.createdAt), "dd/MM/yyyy HH:mm")}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{row.description}</span>
                        <span className="text-xs text-muted-foreground">{row.fileName}</span>
                      </div>
                    </TableCell>
                    <TableCell>{formatPeriod(row.periodFrom, row.periodTo)}</TableCell>
                    <TableCell>
                      <Badge className={badge.className}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell>{row.userName ?? "-"}</TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 cursor-pointer"
                        checked={selected.has(row.id)}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          });
                        }}
                        aria-label={`Selecionar exportação ${row.description}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label="Mais ações"
                        >
                          <MoreVertical className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-popover text-popover-foreground">
                          <DropdownMenuItem
                            onClick={() => handleDownload(row)}
                            disabled={downloadingId === row.id}
                            className="text-popover-foreground"
                          >
                            <Download className="size-4" />
                            {downloadingId === row.id ? "Gerando link…" : "Download"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setPendingDeleteIds([row.id])}
                            className="text-red-500 focus:bg-red-50 focus:text-red-500"
                          >
                            <Trash2 className="size-4" />
                            Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={pendingDeleteIds !== null} onOpenChange={(open) => !open && setPendingDeleteIds(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir exportação{(pendingDeleteIds?.length ?? 0) > 1 ? "ões" : ""}?</DialogTitle>
            <DialogDescription>
              {(pendingDeleteIds?.length ?? 0) > 1
                ? `${pendingDeleteIds?.length} arquivos exportados serão removidos permanentemente.`
                : "O arquivo exportado será removido permanentemente."}{" "}
              Essa ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDeleteIds(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Excluindo…" : "Excluir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
