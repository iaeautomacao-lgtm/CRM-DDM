"use client";

// ============================================================
// /historico — conversas encerradas (visual do protótipo DDM).
// Lista paginada de `conversations` com status 'closed' (período e busca
// por contato) e gaveta com o resumo + a linha do tempo completa do
// contato (ContactTimeline), que era a função original desta tela.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, History, Search } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permission";
import { HistoryExportDialog } from "@/components/historico/export-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ddm/segmented";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, Td, Th, TableCard, Tr } from "@/components/ddm/table-card";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { EmptyState, ErrorState } from "@/components/ddm/states";
import { ContactTimeline } from "@/components/contact-timeline/ContactTimeline";
import { formatDuration, type HistoryPeriod } from "@/lib/historico/format";
import { loadClosedConversations, type ClosedConversation } from "@/lib/historico/queries";
import type { AccountMember, Team } from "@/types";

const ALL_TABS = "__all__";

const PERIOD_OPTIONS = [
  { value: "hoje", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "todas", label: "Todas" },
] as const;

function contactLabel(c: ClosedConversation["contact"]) {
  return c?.name?.trim() || c?.phone || "Contato sem nome";
}

function channelLabel(c: ClosedConversation) {
  if (c.channel_type === "webchat") return "Webchat";
  return c.waha_session ? c.waha_session : "WhatsApp";
}

function fmtDate(iso: string | null) {
  return iso ? format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR }) : "—";
}

export default function HistoricoPage() {
  const { accountId } = useAuth();
  const [period, setPeriod] = useState<HistoryPeriod>("7d");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ClosedConversation[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<ClosedConversation | null>(null);

  const [members, setMembers] = useState<AccountMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);

  // Filtro por tabulação (tags de desfecho da conta) e exportação (só exports.manage; o servidor revalida).
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [tabulacao, setTabulacao] = useState<string>(ALL_TABS);
  const [exportOpen, setExportOpen] = useState(false);
  const canExport = usePermissions().can("exports.manage");

  // Busca com atraso de 300 ms, como era a busca de contato.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/account/members", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { members?: AccountMember[] }) => {
        if (!cancelled) setMembers(data.members ?? []);
      })
      .catch((err) => console.error("[historico] failed to load members:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("teams")
      .select("id, name")
      .eq("account_id", accountId)
      .order("name")
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) console.error("[historico] failed to load teams:", err);
        else setTeams((data ?? []) as Team[]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("tags")
      .select("id, name")
      .eq("kind", "outcome")
      .order("name")
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) console.error("[historico] failed to load tags:", err);
        else setTags((data ?? []) as { id: string; name: string }[]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const reqRef = useRef(0);
  const fetchPage = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!accountId) return;
      const req = ++reqRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(false);
      try {
        const res = await loadClosedConversations(createClient(), {
          accountId,
          period,
          search,
          page: nextPage,
          tabulacao: tabulacao === ALL_TABS ? null : tabulacao,
        });
        if (req !== reqRef.current) return;
        setRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
        setHasMore(res.hasMore);
        setPage(nextPage);
      } catch (err) {
        if (req !== reqRef.current) return;
        console.error("[historico] failed to load conversations:", err);
        setError(true);
      } finally {
        if (req === reqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [accountId, period, search, tabulacao],
  );

  useEffect(() => {
    void fetchPage(0, false);
  }, [fetchPage]);

  const agentName = useMemo(() => {
    const map = new Map(members.map((m) => [m.user_id, m.full_name || m.email || "Sem nome"]));
    return (id: string | null) => (id ? map.get(id) ?? "—" : "—");
  }, [members]);
  const teamName = useMemo(() => {
    const map = new Map(teams.map((t) => [t.id, t.name]));
    return (id: string | null) => (id ? map.get(id) ?? "—" : "—");
  }, [teams]);

  return (
    <PageBody>
      <div className="flex animate-ddm-up flex-col gap-1.5 pt-1">
        <h1 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">
          Histórico
        </h1>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">Conversas encerradas.</p>
      </div>

      <PageToolbar
        actions={
          canExport ? (
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              <Download className="size-3.5" />
              Exportar
            </Button>
          ) : undefined
        }
      >
        <label className="relative flex max-w-[360px] flex-1 basis-60 items-center">
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar contato por nome ou telefone"
            aria-label="Buscar contato por nome ou telefone"
            className="h-[34px] pl-9"
          />
        </label>
        <Segmented<HistoryPeriod>
          ariaLabel="Período de encerramento"
          options={PERIOD_OPTIONS}
          value={period}
          onChange={setPeriod}
          size="lg"
        />
        <Select value={tabulacao} onValueChange={(v) => v && setTabulacao(v)}>
          <SelectTrigger aria-label="Filtrar por tabulação" className="h-[34px] w-full sm:w-56">
            <SelectValue>
              {(v: string) => (v === ALL_TABS ? "Todas as tabulações" : tags.find((t) => t.id === v)?.name ?? "Tabulação")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TABS}>Todas as tabulações</SelectItem>
            {tags.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageToolbar>

      {error && !loading ? (
        <ErrorState
          className="min-h-0"
          title="Não foi possível carregar o histórico"
          onRetry={() => void fetchPage(0, false)}
        />
      ) : (
        <TableCard label="Conversas encerradas">
          <DenseTable minWidth={880} aria-busy={loading || undefined}>
            <thead>
              <tr>
                <Th>Contato</Th>
                <Th>Canal</Th>
                <Th>Tabulação</Th>
                <Th>Atendente</Th>
                <Th>Equipe</Th>
                <Th align="right">Duração</Th>
                <Th>Encerrada em</Th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <Td key={j}>
                        <Skeleton className="h-3 w-24" />
                      </Td>
                    ))}
                  </tr>
                ))}
              {!loading &&
                rows.map((c, i) => (
                  <Tr
                    key={c.id}
                    className="animate-ddm-row cursor-pointer"
                    style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                    tabIndex={0}
                    onClick={() => setSelected(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(c);
                      }
                    }}
                    aria-label={`Abrir conversa de ${contactLabel(c.contact)}`}
                  >
                    <Td>
                      <CellMain title={contactLabel(c.contact)} sub={c.contact?.name ? c.contact.phone : undefined} />
                    </Td>
                    <Td>{channelLabel(c)}</Td>
                    <Td>
                      {c.outcome_tag ? (
                        <StatusChip tone="mute">{c.outcome_tag.name}</StatusChip>
                      ) : (
                        <span className="text-muted-foreground">Sem tabulação</span>
                      )}
                    </Td>
                    <Td>{agentName(c.assigned_agent_id)}</Td>
                    <Td>{teamName(c.team_id)}</Td>
                    <Td align="right">{formatDuration(c.created_at, c.closed_at) ?? "—"}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{fmtDate(c.closed_at ?? c.updated_at)}</Td>
                  </Tr>
                ))}
            </tbody>
          </DenseTable>
          {!loading && rows.length === 0 && (
            <EmptyState
              icon={History}
              title="Nada encontrado"
              hint="Ajuste a busca ou o período."
              className="m-4 min-h-32"
            />
          )}
        </TableCard>
      )}

      {hasMore && !loading && !error && (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loadingMore} onClick={() => void fetchPage(page + 1, true)}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}

      {canExport && (
        <HistoryExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          tags={tags}
          defaultTabulacaoId={tabulacao === ALL_TABS ? null : tabulacao}
        />
      )}

      <DetailDrawer
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected ? contactLabel(selected.contact) : ""}
        description={selected ? `Encerrada em ${fmtDate(selected.closed_at ?? selected.updated_at)}` : undefined}
        size="xl"
      >
        {selected && (
          <div className="flex flex-col gap-4 p-5">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Tabulação</dt>
                <dd className="font-medium">{selected.outcome_tag?.name ?? "Sem tabulação"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Duração</dt>
                <dd className="font-medium tabular-nums">{formatDuration(selected.created_at, selected.closed_at) ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Atendente</dt>
                <dd className="font-medium">{agentName(selected.assigned_agent_id)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Equipe</dt>
                <dd className="font-medium">{teamName(selected.team_id)}</dd>
              </div>
            </dl>
            <ContactTimeline
              contactId={selected.contact_id}
              contactName={contactLabel(selected.contact)}
              contactInitial={contactLabel(selected.contact).charAt(0).toUpperCase()}
            />
          </div>
        )}
      </DetailDrawer>
    </PageBody>
  );
}
