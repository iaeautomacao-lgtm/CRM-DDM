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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-col justify-between gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
            <AlertTriangle className="h-6 w-6 text-primary" aria-hidden="true" />
            Erros do disparador
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Itens que terminaram em erro, com a explicação do código da Meta. Esta tela é só de consulta: não reenvia nem cancela itens.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => void load(filters)} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden="true" />
            Atualizar
          </Button>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => void exportCsv()} disabled={exporting || items.length === 0}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
            Exportar CSV
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-2 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs font-medium">
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
          <label className="flex flex-col gap-1 text-xs font-medium">
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
          <label className="flex flex-col gap-1 text-xs font-medium">
            Código
            <Input
              list="erros-codigos"
              inputMode="numeric"
              className="h-9"
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
          <label className="flex flex-col gap-1 text-xs font-medium">
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
          <label className="flex flex-col gap-1 text-xs font-medium">
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
            className="flex flex-col gap-1 text-xs font-medium"
            onSubmit={(e) => {
              e.preventDefault();
              set({ phone: phoneDraft.trim() });
            }}
          >
            <label htmlFor="erros-telefone">Telefone (número completo)</label>
            <div className="flex gap-1">
              <Input id="erros-telefone" className="h-9" inputMode="tel" placeholder="DDD + número" value={phoneDraft} onChange={(e) => setPhoneDraft(e.target.value)} />
              <Button type="submit" size="icon" variant="outline" className="h-9 w-9 shrink-0" aria-label="Buscar telefone">
                <Search className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </form>
          {hasFilters && (
            <div className="sm:col-span-2 lg:col-span-6">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => {
                  setFilters(EMPTY);
                  setPhoneDraft("");
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" /> Limpar filtros
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}

      {/* Resumo por código */}
      {summary && summary.rows.length > 0 && (
        <section aria-label="Resumo por código" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Resumo por código</h2>
            <p className="text-xs text-muted-foreground">
              {formatInt(summary.total)} {summary.total === 1 ? "item" : "itens"}
              {summary.truncated && (summary.source === "rpc" ? " (a partir de 20.000, contando os mais recentes)" : " (amostra dos 5.000 mais recentes)")}
            </p>
          </div>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {summary.rows.map((r) => {
              const key = codeKey(r.code);
              const active = filters.code === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => set({ code: active ? "" : key, classe: "" })}
                    className={cn(
                      "flex h-full w-full flex-col gap-1 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "border-primary ring-1 ring-primary" : "border-border",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono">
                          {r.code ?? "sem código"}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">{classeLabelPt(r.classe)}</span>
                      </span>
                      <span className="text-sm font-bold tabular-nums">{formatInt(r.count)}</span>
                    </span>
                    {r.significado && <span className="line-clamp-2 text-xs text-muted-foreground">{r.significado}</span>}
                    {r.acao && <span className="line-clamp-2 text-xs">{r.acao}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Lista */}
      {loading && items.length === 0 ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" /> Carregando…
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Nenhum erro encontrado com estes filtros.</CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Quando</th>
                <th className="px-3 py-2 font-medium">Contato</th>
                <th className="px-3 py-2 font-medium">Campanha</th>
                <th className="px-3 py-2 font-medium">Número</th>
                <th className="px-3 py-2 font-medium">Erro</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t border-border/60 hover:bg-muted/40">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{fmtDate(i.updatedAt)}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{i.contactName || "—"}</div>
                    <div className="text-xs text-muted-foreground">{i.phone ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2">{i.campaignNome}</td>
                  <td className="px-3 py-2">{i.numero}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setSelected(i.id)}
                      className="flex flex-col items-start gap-0.5 text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono">
                          {i.erroCodigo ?? "sem código"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{classeLabelPt(i.classe)}</span>
                      </span>
                      <span className="line-clamp-1 max-w-md text-xs text-foreground">{i.significado ?? i.erro ?? "—"}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore} className="gap-2">
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Carregar mais 50
          </Button>
        </div>
      )}

      <DetailSheet itemId={selected} onClose={() => setSelected(null)} />
    </div>
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
    <Sheet open={itemId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Detalhe do erro</SheetTitle>
          <SheetDescription>{item ? `${item.contactName || "Contato"} — ${item.phone ?? "sem telefone"}` : "Carregando o item…"}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6 text-sm">
          {loading && (
            <div className="flex items-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Carregando…
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-800 dark:text-rose-200">
              {error}
            </div>
          )}
          {detail && item && (
            <>
              <section className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {item.erroCodigo ?? "sem código"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{classeLabelPt(item.classe)}</span>
                </div>
                {item.significado ? (
                  <>
                    <p className="text-xs font-semibold">O que significa</p>
                    <p className="mb-2 text-muted-foreground">{item.significado}</p>
                    <p className="text-xs font-semibold">O que fazer</p>
                    <p className="text-muted-foreground">{item.acao}</p>
                  </>
                ) : (
                  <p className="text-muted-foreground">Este erro não trouxe código da Meta (falha local ou do provedor). Veja o texto original abaixo.</p>
                )}
                <p className="mt-2 break-words rounded bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">{item.erro ?? "—"}</p>
              </section>

              {(item.entregaPendente131026 || detail.campanhas131026 !== null) && (
                <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-amber-900 dark:text-amber-200">
                  <p className="text-xs font-semibold">131026 (não entregável)</p>
                  {item.entregaPendente131026 && <p>Aguardando a janela de confirmação de 24 h: se a Meta confirmar a entrega depois, o item deixa de ser erro.</p>}
                  {detail.campanhas131026 !== null && (
                    <p>
                      Este telefone já teve 131026 em {detail.campanhas131026} {detail.campanhas131026 === 1 ? "campanha" : "campanhas"} (a lista de bloqueio
                      entra a partir de 3).
                    </p>
                  )}
                </section>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold">Linha do tempo</h3>
                <ol className="flex flex-col gap-2 border-l border-border pl-4">
                  {detail.timeline.map((e, idx) => (
                    <li key={`${e.key}-${idx}`} className="relative">
                      <span
                        aria-hidden="true"
                        className={cn("absolute -left-[21px] top-1.5 h-2 w-2 rounded-full", e.key === "erro" ? "bg-rose-500" : "bg-primary")}
                      />
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">{e.label}</span>
                        <span className="text-xs text-muted-foreground">{fmtDate(e.at)}</span>
                      </div>
                      {e.detail && <p className="break-words text-xs text-muted-foreground">{e.detail}</p>}
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-[11px] text-muted-foreground">{detail.receiptsRetentionNote}</p>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold">Origem</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Campanha</dt>
                  <dd>
                    <Link href={`/disparador/campanhas/${detail.campaign.id}`} className="text-primary hover:underline">
                      {detail.campaign.nome}
                    </Link>
                  </dd>
                  <dt className="text-muted-foreground">Número</dt>
                  <dd>{item.numero}</dd>
                  <dt className="text-muted-foreground">Template</dt>
                  <dd>{detail.template.name ? `${detail.template.name} (${detail.template.language ?? "—"})` : "Texto livre (WAHA)"}</dd>
                  {detail.template.variables && (
                    <>
                      <dt className="text-muted-foreground">Variáveis</dt>
                      <dd className="break-words">{detail.template.variables.join(" · ")}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Tentativas</dt>
                  <dd>{item.tentativas ?? "—"}</dd>
                </dl>
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function ErrosPage() {
  return (
    <Suspense fallback={null}>
      <ErrosContent />
    </Suspense>
  );
}
