"use client";

// /disparador/contatos — "Listas importadas" (PRD 22, PR 8). A importação deixa de ser um formulário síncrono e vira
// um job em segundo plano (POST /api/disparador/imports, blocos, start; docs/disparador-importacao-assincrona.md):
// importações em andamento com barra de progresso, listas concluídas (GET /imports/lists, paginado) e o detalhe de
// cada uma com totais, erros por linha, renomear e "Usar em nova campanha" (POST /imports/[id]/reuse → assistente
// em Campanhas com o rascunho devolvido como público).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, FileSpreadsheet, Loader2, Megaphone, Pencil, RefreshCw, Search, Upload, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api-fetch";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ddm/states";
import { ImportListDrawer, ProgressBar } from "@/components/disparador/import/import-list-drawer";
import { ImportJobSummary } from "@/components/disparador/import/import-job-summary";
import {
  IMPORT_STATE_LABEL,
  importListLabel,
  importPercent,
  isActiveImport,
  type PublicImportJob,
  type PublicImportList,
  reuseCampaignHref,
} from "@/lib/disparador/import-client";

const POLL_MS = 3000;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Erro HTTP ${res.status}`);
  return body as T;
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

export default function ListasImportadasPage() {
  const [jobs, setJobs] = useState<PublicImportJob[] | null>(null);
  const [lists, setLists] = useState<PublicImportList[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const body = await getJson<{ jobs: PublicImportJob[]; unavailable?: boolean }>("/api/disparador/imports");
      setJobs(body.jobs);
      if (body.unavailable) setUnavailable(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar as importações");
    }
  }, []);

  const loadLists = useCallback(async (search: string) => {
    try {
      const qs = new URLSearchParams({ limit: "20" });
      if (search) qs.set("q", search);
      const body = await getJson<{ lists: PublicImportList[]; next_cursor: string | null; unavailable?: boolean }>(
        `/api/disparador/imports/lists?${qs.toString()}`,
      );
      setLists(body.lists);
      setCursor(body.next_cursor);
      if (body.unavailable) setUnavailable(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar as listas");
    }
  }, []);

  const reload = useCallback(() => {
    void loadJobs();
    void loadLists(query);
  }, [loadJobs, loadLists, query]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // Busca pelo nome com espera curta (uma chamada por pausa na digitação).
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      void loadLists(q.trim());
    }, 350);
    return () => clearTimeout(t);
  }, [q, loadLists]);

  const active = useMemo(() => (jobs ?? []).filter((j) => isActiveImport(j.state)), [jobs]);
  // Falhas recentes também aparecem (com o motivo), para não sumirem em silêncio.
  const recentFailed = useMemo(
    () => (jobs ?? []).filter((j) => j.state === "failed" || j.state === "cancelled").slice(0, 3),
    [jobs],
  );

  // Enquanto houver importação em andamento, atualiza a cada 3 s com a aba visível.
  useEffect(() => {
    if (active.length === 0) return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadJobs().then(() => void loadLists(query));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [active.length, loadJobs, loadLists, query]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ limit: "20", cursor });
      if (query) qs.set("q", query);
      const body = await getJson<{ lists: PublicImportList[]; next_cursor: string | null }>(
        `/api/disparador/imports/lists?${qs.toString()}`,
      );
      setLists((prev) => {
        const seen = new Set((prev ?? []).map((l) => l.id));
        return [...(prev ?? []), ...body.lists.filter((l) => !seen.has(l.id))];
      });
      setCursor(body.next_cursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao carregar mais listas");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <PageBody>
      <PageToolbar
        actions={
          <>
            <a href="/modelo_importacao_disparador.csv" download className={buttonVariants({ variant: "outline" })}>
              <Download className="size-3.5" aria-hidden="true" /> Baixar modelo
            </a>
            <Link href="/contacts" className={buttonVariants({ variant: "outline" })}>
              <Users className="size-3.5" aria-hidden="true" /> Ver contatos
            </Link>
            <Button onClick={() => setImportOpen(true)} disabled={unavailable}>
              <Upload className="size-3.5" aria-hidden="true" /> Importar lista
            </Button>
          </>
        }
      >
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Buscar lista pelo nome"
            placeholder="Buscar lista pelo nome"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
        <Button variant="ghost" size="icon" onClick={reload} aria-label="Atualizar" title="Atualizar">
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </Button>
      </PageToolbar>

      {unavailable && (
        <p className="m-0 rounded-lg bg-warning-soft px-3.5 py-2.5 text-[13px] text-foreground">
          A importação em segundo plano ainda não está disponível neste banco (migration 197). Fale com o administrador.
        </p>
      )}

      {(active.length > 0 || recentFailed.length > 0) && (
        <TableCard title="Em andamento" hint="Atualiza sozinho. Pode sair desta tela: a importação continua no servidor.">
          <ul className="m-0 flex list-none flex-col p-0">
            {[...active, ...recentFailed].map((j) => (
              <li key={j.id} className="flex flex-col gap-2 border-t border-border px-[18px] py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setSelected(j.id)}
                    className="min-w-0 truncate text-left text-[13px] font-semibold text-foreground hover:underline"
                  >
                    {importListLabel(j)}
                  </button>
                  <span className="flex items-center gap-2">
                    <StatusChip tone={j.state === "failed" || j.state === "cancelled" ? "bad" : "brand"}>
                      {IMPORT_STATE_LABEL[j.state]}
                    </StatusChip>
                    <span className="w-10 text-right text-[13px] font-semibold tabular-nums text-foreground">{importPercent(j)}%</span>
                  </span>
                </div>
                <ProgressBar pct={importPercent(j)} tone={j.state === "failed" || j.state === "cancelled" ? "bad" : "brand"} />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {j.state === "receiving"
                    ? `${j.blocks_received} bloco(s) recebido(s)`
                    : `${j.rows_done.toLocaleString("pt-BR")} de ${j.rows_total.toLocaleString("pt-BR")} linhas`}
                  {j.errors.length > 0 ? ` · ${j.errors.length.toLocaleString("pt-BR")} erro(s) por linha` : ""}
                  {j.error ? ` · ${j.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </TableCard>
      )}

      <TableCard title="Listas importadas" hint="Importações concluídas desta conta, das mais recentes para as mais antigas.">
        {error && lists === null ? (
          <ErrorState className="m-4 mt-0" title="Não foi possível carregar as listas" hint={error} onRetry={reload} />
        ) : lists === null ? (
          <div className="flex flex-col gap-2 px-[18px] pb-4" aria-busy="true" aria-label="Carregando listas">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : lists.length === 0 ? (
          <EmptyState
            className="m-4 mt-0"
            icon={FileSpreadsheet}
            title={query ? "Nenhuma lista com esse nome" : "Nenhuma lista importada ainda"}
            hint={query ? "Tente outro termo." : "Importe um CSV ou XLSX em “Importar lista”."}
          />
        ) : (
          <DenseTable minWidth={820}>
            <thead>
              <tr>
                <Th>Lista</Th>
                <Th align="right">Linhas</Th>
                <Th align="right">Importados</Th>
                <Th align="right">Duplicados</Th>
                <Th align="right">Inválidos</Th>
                <Th align="right">Blacklist</Th>
                <Th align="right">Vinculados</Th>
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <Tr key={l.id} className={cn("cursor-pointer", selected === l.id && "bg-selected")} onClick={() => setSelected(l.id)}>
                  <Td className="max-w-[18rem]">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(l.id);
                      }}
                      className="block w-full text-left focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <CellMain title={importListLabel(l)} sub={`Concluída em ${fmtDate(l.finished_at ?? l.created_at)}`} />
                    </button>
                  </Td>
                  <Td align="right">{l.rows_total.toLocaleString("pt-BR")}</Td>
                  <Td align="right" className="font-semibold text-foreground">{l.totals.importados.toLocaleString("pt-BR")}</Td>
                  <Td align="right">{l.totals.duplicados.toLocaleString("pt-BR")}</Td>
                  <Td align="right">{l.totals.invalidos.toLocaleString("pt-BR")}</Td>
                  <Td align="right">{l.totals.blacklisted.toLocaleString("pt-BR")}</Td>
                  <Td align="right">{l.linked.toLocaleString("pt-BR")}</Td>
                </Tr>
              ))}
            </tbody>
          </DenseTable>
        )}
        {cursor && (
          <div className="flex justify-center border-t border-border px-[18px] py-3">
            <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              Carregar mais
            </Button>
          </div>
        )}
      </TableCard>

      <ImportListDrawer open={importOpen} onOpenChange={setImportOpen} onStarted={reload} />
      <ImportDetailDrawer id={selected} onClose={() => setSelected(null)} onRenamed={reload} />
    </PageBody>
  );
}

/** Detalhe de uma importação: estado, totais, erros por linha e renomear. */
function ImportDetailDrawer({ id, onClose, onRenamed }: { id: string | null; onClose: () => void; onRenamed: () => void }) {
  const [job, setJob] = useState<PublicImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setJob(null);
    setError(null);
    setEditing(false);
    getJson<{ job: PublicImportJob }>(`/api/disparador/imports/${id}`)
      .then((b) => {
        if (!cancelled) {
          setJob(b.job);
          setName(b.job.name ?? "");
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Falha ao carregar a importação"));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // "Usar em nova campanha": o servidor copia vínculos e VAR1–3 para um rascunho novo (a lista de origem não muda) e
  // o assistente abre em Campanhas com esse rascunho como público.
  const [reusing, setReusing] = useState(false);
  const reuse = async () => {
    if (!job) return;
    setReusing(true);
    try {
      const b = await getJson<{ draft_id: string; contacts: number; variables: number }>(
        `/api/disparador/imports/${job.id}/reuse`,
        { method: "POST" },
      );
      router.push(reuseCampaignHref({ draftId: b.draft_id, name: importListLabel(job), contacts: b.contacts, variables: b.variables }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível reutilizar a lista.");
      setReusing(false);
    }
  };

  const rename = async () => {
    if (!job) return;
    setSaving(true);
    try {
      const b = await getJson<{ job: PublicImportJob }>(`/api/disparador/imports/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || null }),
      });
      setJob(b.job);
      setEditing(false);
      toast.success("Nome da lista salvo.");
      onRenamed();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível renomear.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailDrawer
      open={id !== null}
      onOpenChange={(o) => !o && onClose()}
      title={job ? importListLabel(job) : "Importação"}
      description={job ? `Criada em ${fmtDate(job.created_at)}${job.finished_at ? ` · concluída em ${fmtDate(job.finished_at)}` : ""}` : "Carregando…"}
      headerExtra={
        job ? (
          <StatusChip tone={job.state === "done" ? "ok" : job.state === "failed" || job.state === "cancelled" ? "bad" : "brand"}>
            {IMPORT_STATE_LABEL[job.state]}
          </StatusChip>
        ) : null
      }
      size="lg"
    >
      {error ? (
        <ErrorState title="Não foi possível carregar a importação" hint={error} />
      ) : !job ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {editing ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void rename();
              }}
            >
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-foreground-2">
                Nome da lista
                <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                Salvar
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {job.state === "done" && (
                <Button onClick={() => void reuse()} disabled={reusing}>
                  {reusing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Megaphone className="size-3.5" aria-hidden="true" />}
                  Usar em nova campanha
                </Button>
              )}
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" aria-hidden="true" /> Renomear lista
              </Button>
            </div>
          )}
          {isActiveImport(job.state) && (
            <div className="flex flex-col gap-2">
              <ProgressBar pct={importPercent(job)} />
              <span className="text-xs tabular-nums text-muted-foreground">
                {job.rows_done.toLocaleString("pt-BR")} de {job.rows_total.toLocaleString("pt-BR")} linhas processadas
              </span>
            </div>
          )}
          <ImportJobSummary job={job} />
        </div>
      )}
    </DetailDrawer>
  );
}
