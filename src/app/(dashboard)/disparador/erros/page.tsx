"use client";

// /disparador/erros — tela de erros navegável (P2-1). Só leitura: filtros (campanha, número, código,
// classe, período, telefone exato), resumo por código clicável, lista keyset de 50 por página, exportação
// CSV da lista filtrada e o detalhe do item num painel lateral. Reenviar/cancelar em lote NÃO existe aqui
// (risco de duplicidade; fica para um PR próprio).

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Download, Loader2, RefreshCw, Search, X } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { EmptyState, Skeleton } from "@/components/ddm/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { classeLabelPt, formatInt } from "@/lib/disparador/monitor-format";
import { META_ERROR_CATALOG } from "@/lib/disparador/meta-error-catalog";
import type { ErroDetail, ErroItem, ErrosSummary, NumberInfo } from "@/lib/disparador/erros";

const PERIODOS = [
  { value: "1h", label: "Última hora" },
  { value: "24h", label: "Últimas 24 h" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "all", label: "Todo o período" },
] as const;

const CLASSES = [
  "destinatario",
  "campanha_template",
  "canal_conta",
  "limite",
  "transitorio",
  "janela24h",
  "desconhecido",
  "sem_codigo",
] as const;

interface Filters {
  campaign: string;
  session: string;
  code: string;
  classe: string;
  periodo: string;
  phone: string;
}

const EMPTY: Filters = { campaign: "", session: "", code: "", classe: "", periodo: "24h", phone: "" };
const SELECT_CLASS =
  "h-8 w-full rounded-[6px] border border-input bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function toQuery(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === "periodo" && v === "24h")) p.set(k, v);
  return p;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error || `Erro HTTP ${res.status}`;
}

function ErrosContent() {
  const router = useRouter();
  const search = useSearchParams();

  const initial = useMemo<Filters>(
    () => ({
      campaign: search.get("campaign") ?? "",
      session: search.get("session") ?? "",
      code: search.get("code") ?? "",
      classe: search.get("classe") ?? "",
      periodo: search.get("periodo") ?? "24h",
      phone: search.get("phone") ?? "",
    }),
    // Só a leitura inicial: depois os filtros vivem no estado e são refletidos na URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [filters, setFilters] = useState<Filters>(initial);
  const [phoneDraft, setPhoneDraft] = useState(initial.phone);
  const [items, setItems] = useState<ErroItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<ErrosSummary | null>(null);
  const [numbers, setNumbers] = useState<NumberInfo[]>([]);
  const [campaigns, setCampaigns] = useState<Array<{ id: string; nome: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (f: Filters) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const q = toQuery(f);
      q.set("summary", "1");
      const res = await apiFetch(`/api/disparador/erros?${q.toString()}`);
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      if (mine !== seq.current) return;
      setItems(data.items ?? []);
      setNextCursor(data.nextCursor ?? null);
      setSummary(data.summary ?? null);
      setNumbers(data.numbers ?? []);
      setCampaigns(data.campaigns ?? []);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : "Falha ao carregar os erros");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters);
    const q = toQuery(filters).toString();
    router.replace(q ? `/disparador/erros?${q}` : "/disparador/erros", { scroll: false });
  }, [filters, load, router]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const q = toQuery(filters);
      q.set("cursor", nextCursor);
      const res = await apiFetch(`/api/disparador/erros?${q.toString()}`);
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...(data.items as ErroItem[]).filter((i) => !seen.has(i.id))];
      });
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar mais erros");
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const q = toQuery(filters);
      q.set("format", "csv");
      const res = await apiFetch(`/api/disparador/erros?${q.toString()}`);
      if (!res.ok) throw new Error(await readError(res));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "erros-disparador.csv";
      a.click();
      URL.revokeObjectURL(url);
      if (res.headers.get("X-Export-Truncated") === "1") setError("A exportação foi limitada a 10.000 linhas. Restrinja os filtros para exportar o restante.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao exportar");
    } finally {
      setExporting(false);
    }
  };

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY);
  const codeKey = (c: number | null) => (c === null ? "sem_codigo" : String(c));

  return (
    <PageBody>
      <PageToolbar
        actions={
          <>
            <Button variant="outline" onClick={() => void load(filters)} disabled={loading}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
              Atualizar
            </Button>
            <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting || items.length === 0}>
              {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}
              Exportar CSV
            </Button>
          </>
        }
      >
        <p className="m-0 max-w-3xl text-[12.5px] text-muted-foreground">
          Itens que terminaram em erro, com a explicação do código da Meta. Esta tela é só de consulta: não reenvia nem
          cancela itens.
        </p>
      </PageToolbar>

      {/* Filtros */}
      <section
        aria-label="Filtros"
        className="grid grid-cols-1 gap-3 rounded-[10px] border border-border bg-card px-[18px] py-4 sm:grid-cols-2 lg:grid-cols-6"
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
          Campanha
          <select className={SELECT_CLASS} value={filters.campaign} onChange={(e) => set({ campaign: e.target.value })}>
            <option value="">Todas</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
          Número
          <select className={SELECT_CLASS} value={filters.session} onChange={(e) => set({ session: e.target.value })}>
            <option value="">Todos</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
          Código
          <Input
            list="erros-codigos"
            inputMode="numeric"
            className="h-8"
            placeholder="Ex.: 131026"
            value={filters.code === "sem_codigo" ? "sem código" : filters.code}
            onChange={(e) => {
              const v = e.target.value.trim();
              set({ code: /^\d{0,9}$/.test(v) ? v : v === "sem código" ? "sem_codigo" : filters.code });
            }}
          />
          <datalist id="erros-codigos">
            {META_ERROR_CATALOG.map((e) => (
              <option key={e.code} value={String(e.code)}>
                {classeLabelPt(e.classe)}
              </option>
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
          Tipo de erro
          <select className={SELECT_CLASS} value={filters.classe} onChange={(e) => set({ classe: e.target.value })}>
            <option value="">Todos</option>
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {classeLabelPt(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground-2">
          Período
          <select className={SELECT_CLASS} value={filters.periodo} onChange={(e) => set({ periodo: e.target.value })}>
            {PERIODOS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex flex-col gap-1 text-xs font-medium text-foreground-2"
          onSubmit={(e) => {
            e.preventDefault();
            set({ phone: phoneDraft.trim() });
          }}
        >
          <label htmlFor="erros-telefone">Telefone (número completo)</label>
          <div className="flex gap-1">
            <Input
              id="erros-telefone"
              className="h-8"
              inputMode="tel"
              placeholder="DDD + número"
              value={phoneDraft}
              onChange={(e) => setPhoneDraft(e.target.value)}
            />
            <Button type="submit" size="icon" variant="outline" className="shrink-0" aria-label="Buscar telefone">
              <Search className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </form>
        {hasFilters && (
          <div className="sm:col-span-2 lg:col-span-6">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters(EMPTY);
                setPhoneDraft("");
              }}
            >
              <X className="size-3.5" aria-hidden="true" /> Limpar filtros
            </Button>
          </div>
        )}
      </section>

      {error && (
        <div role="alert" className="flex animate-ddm-fade items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-2.5 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          {error}
        </div>
      )}

      {/* Resumo por código: cada célula filtra a lista. */}
      {summary && summary.rows.length > 0 && (
        <section aria-label="Resumo por código" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="m-0 text-sm font-semibold text-foreground">Resumo por código</h2>
            <p className="m-0 text-xs text-muted-foreground">
              {formatInt(summary.total)} {summary.total === 1 ? "item" : "itens"}
              {summary.truncated &&
                (summary.source === "rpc" ? " (a partir de 20.000, contando os mais recentes)" : " (amostra dos 5.000 mais recentes)")}
            </p>
          </div>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-px overflow-hidden rounded-[10px] border border-border bg-border p-0">
            {summary.rows.map((r) => {
              const key = codeKey(r.code);
              const active = filters.code === key;
              return (
                <li key={key} className="bg-card">
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => set({ code: active ? "" : key, classe: "" })}
                    className={cn(
                      "flex h-full w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      active && "bg-selected shadow-[inset_0_-2px_0_var(--primary)]",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <CodeTag code={r.code} />
                        <span className="text-[11.5px] text-muted-foreground">{classeLabelPt(r.classe)}</span>
                      </span>
                      <span className="text-lg font-semibold tabular-nums text-foreground">{formatInt(r.count)}</span>
                    </span>
                    {r.significado && <span className="line-clamp-2 text-xs text-muted-foreground">{r.significado}</span>}
                    {r.acao && <span className="line-clamp-2 text-xs text-foreground-2">{r.acao}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Lista */}
      <TableCard title="Itens com erro" hint="Clique no erro para ver a explicação, a linha do tempo e a origem.">
        {loading && items.length === 0 ? (
          <div className="flex flex-col gap-2 px-[18px] pb-4" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState className="m-4 mt-0" title="Nenhum erro encontrado com estes filtros" />
        ) : (
          <DenseTable minWidth={760}>
            <thead>
              <tr>
                <Th>Quando</Th>
                <Th>Contato</Th>
                <Th>Campanha</Th>
                <Th>Número</Th>
                <Th>Erro</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <Tr key={i.id} className={cn(selected === i.id && "bg-selected")}>
                  <Td className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(i.updatedAt)}</Td>
                  <Td>
                    <CellMain title={i.contactName || "—"} sub={i.phone ?? "—"} />
                  </Td>
                  <Td className="max-w-[14rem] truncate">{i.campaignNome}</Td>
                  <Td>{i.numero}</Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setSelected(i.id)}
                      className="flex flex-col items-start gap-0.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span className="flex items-center gap-2">
                        <CodeTag code={i.erroCodigo} />
                        <span className="text-xs text-muted-foreground">{classeLabelPt(i.classe)}</span>
                      </span>
                      <span className="line-clamp-1 max-w-md text-xs font-medium text-primary-text hover:underline">
                        {i.significado ?? i.erro ?? "—"}
                      </span>
                    </button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DenseTable>
        )}
      </TableCard>

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Carregar mais 50
          </Button>
        </div>
      )}

      <DetailSheet itemId={selected} onClose={() => setSelected(null)} />
    </PageBody>
  );
}

/** Código da Meta em fonte mono (ou "sem código"). */
function CodeTag({ code }: { code: number | null }) {
  return (
    <span className="rounded-[4px] bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-foreground">{code ?? "sem código"}</span>
  );
}

function DetailSheet({ itemId, onClose }: { itemId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<ErroDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const res = await apiFetch(`/api/disparador/erros/${itemId}`);
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        if (!cancelled) setDetail(data.detail as ErroDetail);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Falha ao carregar o item");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const item = detail?.item;
  return (
    <DetailDrawer
      open={itemId !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Detalhe do erro"
      description={item ? `${item.contactName || "Contato"} — ${item.phone ?? "sem telefone"}` : "Carregando o item…"}
      headerExtra={item ? <CodeTag code={item.erroCodigo} /> : null}
      size="lg"
    >
      <div className="flex flex-col gap-5 text-[13px]">
        {loading && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            {error}
          </div>
        )}
        {detail && item && (
          <>
            <section className="flex flex-col gap-2 rounded-lg bg-surface-3 p-3">
              <span className="text-xs text-muted-foreground">{classeLabelPt(item.classe)}</span>
              {item.significado ? (
                <>
                  <div>
                    <p className="m-0 text-xs font-semibold text-foreground">O que significa</p>
                    <p className="m-0 text-foreground-2">{item.significado}</p>
                  </div>
                  <div>
                    <p className="m-0 text-xs font-semibold text-foreground">O que fazer</p>
                    <p className="m-0 text-foreground-2">{item.acao}</p>
                  </div>
                </>
              ) : (
                <p className="m-0 text-foreground-2">
                  Este erro não trouxe código da Meta (falha local ou do provedor). Veja o texto original abaixo.
                </p>
              )}
              <p className="m-0 break-words rounded-[6px] bg-card p-2 font-mono text-[11px] text-muted-foreground">{item.erro ?? "—"}</p>
            </section>

            {(item.entregaPendente131026 || detail.campanhas131026 !== null) && (
              <section className="flex flex-col gap-1 rounded-lg bg-warning-soft p-3 text-foreground">
                <p className="m-0 text-xs font-semibold">131026 (não entregável)</p>
                {item.entregaPendente131026 && (
                  <p className="m-0">
                    Aguardando a janela de confirmação de 24 h: se a Meta confirmar a entrega depois, o item deixa de ser erro.
                  </p>
                )}
                {detail.campanhas131026 !== null && (
                  <p className="m-0">
                    Este telefone já teve 131026 em {detail.campanhas131026} {detail.campanhas131026 === 1 ? "campanha" : "campanhas"} (a lista
                    de bloqueio entra a partir de 3).
                  </p>
                )}
              </section>
            )}

            <section>
              <h3 className="m-0 mb-2 font-sans text-[13px] font-semibold text-foreground">Linha do tempo</h3>
              <ol className="m-0 flex list-none flex-col gap-2.5 border-l border-border pl-4">
                {detail.timeline.map((e, idx) => (
                  <li key={`${e.key}-${idx}`} className="relative animate-ddm-row" style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }}>
                    <span
                      aria-hidden="true"
                      className={cn("absolute -left-[21px] top-1.5 size-2 rounded-full", e.key === "erro" ? "bg-danger" : "bg-primary")}
                    />
                    <div className="flex justify-between gap-2">
                      <span className="font-medium text-foreground">{e.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{fmtDate(e.at)}</span>
                    </div>
                    {e.detail && <p className="m-0 break-words text-xs text-muted-foreground">{e.detail}</p>}
                  </li>
                ))}
              </ol>
              <p className="m-0 mt-2 text-[11px] text-muted-foreground">{detail.receiptsRetentionNote}</p>
            </section>

            <section>
              <h3 className="m-0 mb-2 font-sans text-[13px] font-semibold text-foreground">Origem</h3>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-muted-foreground">Campanha</dt>
                <dd className="m-0">
                  <Link href={`/disparador/campanhas/${detail.campaign.id}`} className="font-semibold text-primary-text hover:underline">
                    {detail.campaign.nome}
                  </Link>
                </dd>
                <dt className="text-muted-foreground">Número</dt>
                <dd className="m-0">{item.numero}</dd>
                <dt className="text-muted-foreground">Template</dt>
                <dd className="m-0">
                  {detail.template.name ? `${detail.template.name} (${detail.template.language ?? "—"})` : "Texto livre (WAHA)"}
                </dd>
                {detail.template.variables && (
                  <>
                    <dt className="text-muted-foreground">Variáveis</dt>
                    <dd className="m-0 break-words">{detail.template.variables.join(" · ")}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Tentativas</dt>
                <dd className="m-0 tabular-nums">{item.tentativas ?? "—"}</dd>
              </dl>
            </section>
          </>
        )}
      </div>
    </DetailDrawer>
  );
}

export default function ErrosPage() {
  return (
    <Suspense fallback={null}>
      <ErrosContent />
    </Suspense>
  );
}
