"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// /canais — table-style view over the existing WhatsApp channel
// CRUD (GET/POST/DELETE/PATCH /api/whatsapp/config, POST
// /api/whatsapp/waha/{start,stop,qr,pairing-code}). This page and its
// dialogs (src/components/canais/*) are an alternate UI over the same
// endpoints src/components/settings/whatsapp-config.tsx already uses.
//
// GET /api/whatsapp/config re-verifies every row against WAHA/Meta
// live on each call — connected/session_status/phone_info are
// computed server-side per request, not raw DB columns. flow_id/
// receptivo/habilitado (migration 056) ARE raw passthrough columns
// the route now also returns. flow_name has no API-side join — it's
// resolved here from a separate GET /api/flows, keyed by flow_id.
//
// PATCH is a new, minimal handler added to config/route.ts alongside
// this feature: there's no PUT on that route, and POST always
// requires Meta's access_token (which the client never holds in
// plaintext), so it can't be reused for a lightweight toggle. PATCH
// only ever touches flow_id/receptivo/habilitado.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, MessageCircle, MoreVertical, Plus, Search, Trash2, Zap } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import type { ChannelConfig } from "@/components/canais/types";
import { NewChannelDialog } from "@/components/canais/NewChannelDialog";
import { EditChannelDialog } from "@/components/canais/EditChannelDialog";
import { ConnectWahaDialog } from "@/components/canais/ConnectWahaDialog";
import { TestChannelDialog } from "@/components/canais/TestChannelDialog";
import { ClientsDialog, type ClientOption } from "@/components/canais/ClientsDialog";
import { SocialChannelsSection } from "@/components/canais/SocialChannelsSection";
import { WebchatSettingsSection } from "@/components/canais/WebchatSettingsSection";
import { Checkbox } from "@/components/ui/checkbox";
import { CountUp } from "@/components/motion/count-up";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { usePermission } from "@/hooks/use-permission";
import { cn } from "@/lib/utils";

function channelName(c: ChannelConfig): string {
  if (c.provider === "waha") return c.waha_session || "Sessão WAHA";
  return c.phone_info?.verified_name || c.phone_info?.display_phone_number || "Meta Config";
}

// Keywords Meta's Graph API error messages use for an expired/invalid
// OAuth token (e.g. "Error validating access token: Session has
// expired...", "Invalid OAuth access token..."). Matched case-
// insensitively against `message` when `reason === "meta_api_error"` —
// that reason also covers other, unrelated Meta API failures, so we
// only treat it as a token problem when the message itself looks like
// one.
const TOKEN_ERROR_KEYWORDS = ["authorization", "access token", "oauth", "expired"];

/**
 * Non-null (and a user-facing label) when this channel is down because
 * its Meta access token is invalid or expired — as opposed to any other
 * "Desconectado" cause (WAHA session stopped, network error, etc.).
 */
function invalidTokenLabel(c: ChannelConfig): string | null {
  if (c.connected) return null;
  if (c.reason === "token_corrupted") return "Token inválido";
  if (c.reason === "meta_api_error") {
    const msg = (c.message ?? "").toLowerCase();
    if (TOKEN_ERROR_KEYWORDS.some((kw) => msg.includes(kw))) return "Token expirado";
  }
  return null;
}

function sessionOrNumber(c: ChannelConfig): string {
  if (c.provider === "waha") return c.waha_session || "-";
  return c.phone_info?.display_phone_number || c.phone_info?.id || "Meta Config";
}

function searchHaystack(c: ChannelConfig): string {
  return [
    c.waha_session,
    c.phone_info?.id,
    c.phone_info?.display_phone_number,
    c.phone_info?.verified_name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export default function CanaisPage() {
  const { accountId } = useAuth();
  const [configs, setConfigs] = useState<ChannelConfig[]>([]);
  const [flows, setFlows] = useState<{ id: string; name: string; status?: string }[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toggleBusyKey, setToggleBusyKey] = useState<string | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelConfig | null>(null);
  const [connecting, setConnecting] = useState<ChannelConfig | null>(null);
  const [testing, setTesting] = useState<ChannelConfig | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<ChannelConfig[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [stopBusyId, setStopBusyId] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientsOpen, setClientsOpen] = useState(false);

  // Clientes (migration 128): leitura direta, a RLS libera para membros.
  const fetchClients = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await createClient()
      .from("clients")
      .select("id, name, color")
      .eq("account_id", accountId)
      .order("name", { ascending: true });
    if (error) console.error("[canais] failed to load clients:", error);
    else setClients((data ?? []) as ClientOption[]);
  }, [accountId]);
  useEffect(() => {
    void fetchClients();
  }, [fetchClients]);

  // Retorno do OAuth da Meta (/api/channels/<tipo>/callback).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("channel_connected");
    const error = params.get("channel_error");
    if (connected) {
      toast.success(`${connected === "instagram" ? "Instagram" : "Messenger"} conectado (${params.get("count") ?? 1}).`);
    }
    if (error) toast.error(error);
    if (connected || error) window.history.replaceState(null, "", "/canais");
  }, []);

  async function handleClientChange(c: ChannelConfig, clientId: string | null) {
    const res = await apiFetch("/api/whatsapp/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: c.id, client_id: clientId }),
    });
    if (!res.ok) {
      toast.error("Falha ao definir o cliente da linha");
      return;
    }
    setConfigs((prev) => prev.map((row) => (row.id === c.id ? { ...row, client_id: clientId } : row)));
  }

  const fetchConfigs = useCallback(async (): Promise<ChannelConfig[]> => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/whatsapp/config");
      const payload = await res.json();
      const list = (payload.configs ?? []) as ChannelConfig[];
      setConfigs(list);
      return list;
    } catch (err) {
      console.error("[canais] failed to load channels:", err);
      toast.error("Falha ao carregar canais");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  useEffect(() => {
    apiFetch("/api/flows")
      .then((res) => res.json())
      .then((data) => {
        const list = (data.flows ?? []) as { id: string; name: string; status?: string }[];
        setFlows(list.map((f) => ({ id: f.id, name: f.name, status: f.status })));
      })
      .catch((err) => console.error("[canais] failed to load flows:", err));
  }, []);

  // Direct Supabase read (teams_select RLS already allows any account
  // member — same pattern TeamsPanel uses), not a new API route.
  // team_id has no join on the GET /api/whatsapp/config response
  // (same reason as flow_id/flow_name — see ChannelConfig comment),
  // so team_name is resolved here too.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    supabase
      .from("teams")
      .select("id, name")
      .eq("account_id", accountId)
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error("[canais] failed to load teams:", error);
          return;
        }
        setTeams((data ?? []) as { id: string; name: string }[]);
      });
  }, [accountId]);

  const flowNameById = useMemo(() => new Map(flows.map((f) => [f.id, f.name])), [flows]);
  const teamNameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);

  const filteredConfigs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return configs;
    return configs.filter((c) => searchHaystack(c).includes(q) || channelName(c).toLowerCase().includes(q));
  }, [configs, search]);

  // Filtro por provedor (Segmented do redesenho) sobre a busca.
  const [providerFilter, setProviderFilter] = useState<"all" | "meta" | "waha">("all");
  const visibleConfigs = useMemo(
    () => (providerFilter === "all" ? filteredConfigs : filteredConfigs.filter((c) => (c.provider === "waha" ? "waha" : "meta") === providerFilter)),
    [filteredConfigs, providerFilter],
  );

  // Linha aberta na gaveta de detalhe (clique na linha, como no protótipo).
  const [detail, setDetail] = useState<ChannelConfig | null>(null);
  const detailRow = detail ? configs.find((c) => c.id === detail.id) ?? null : null;

  // Qualidade, faixa de limite e ritmo por número Meta — o mesmo dado do
  // Disparador › Números (GET /api/disparador/rate-limits, migrations 190/221),
  // só para quem tem campaigns.rate_limit. Sem leitura, a coluna mostra "—".
  const canSeeQuality = usePermission("campaigns.rate_limit");
  const [quality, setQuality] = useState<Map<string, ChannelQuality>>(new Map());
  useEffect(() => {
    if (!canSeeQuality) return;
    let cancelled = false;
    apiFetch("/api/disparador/rate-limits")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { channels?: Array<{ session_id: string; health: ChannelQuality | null; rate: { effective?: number | null } | null }> } | null) => {
        if (cancelled || !json) return;
        const map = new Map<string, ChannelQuality>();
        for (const ch of json.channels ?? []) {
          if (ch.health) map.set(ch.session_id, { ...ch.health, effective_rate: ch.rate?.effective ?? null });
        }
        setQuality(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canSeeQuality]);

  // KPIs só com o que existe: linhas ativas e linhas que pedem atenção.
  const activeCount = configs.filter((c) => c.habilitado && c.connected).length;
  const alertCount = configs.filter(
    (c) => c.status === "warning" || invalidTokenLabel(c) !== null || (c.habilitado && !c.connected) || quality.get(c.id)?.quality_rating === "RED",
  ).length;
  const metaCount = configs.filter((c) => c.provider !== "waha").length;
  const wahaCount = configs.length - metaCount;


  const allVisibleSelected =
    visibleConfigs.length > 0 && visibleConfigs.every((c) => selected.has(c.id));

  const hasInvalidTokenChannel = useMemo(
    () => configs.some((c) => invalidTokenLabel(c) !== null),
    [configs],
  );

  function toggleSelectAll() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleConfigs.forEach((c) => next.delete(c.id));
        return next;
      }
      const next = new Set(prev);
      visibleConfigs.forEach((c) => next.add(c.id));
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDisconnect(c: ChannelConfig) {
    setStopBusyId(c.id);
    try {
      const res = await apiFetch("/api/whatsapp/waha/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: c.waha_session, id: c.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao parar sessão");
      toast.success("Sessão desconectada.");
      await fetchConfigs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao desconectar");
    } finally {
      setStopBusyId(null);
    }
  }

  async function handleToggleField(c: ChannelConfig, field: "receptivo" | "habilitado") {
    const key = `${c.id}:${field}`;
    const next = !c[field];
    setToggleBusyKey(key);
    try {
      const res = await apiFetch("/api/whatsapp/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, [field]: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao atualizar canal");
      setConfigs((prev) => prev.map((row) => (row.id === c.id ? { ...row, [field]: next } : row)));
      toast.success(field === "receptivo" ? "Receptivo atualizado." : "Habilitado atualizado.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao atualizar canal");
    } finally {
      setToggleBusyKey(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTargets || deleteTargets.length === 0) return;
    setDeleteBusy(true);
    try {
      // apiFetch não lança em 4xx/5xx: confere cada resposta para não
      // anunciar "removido" quando a API recusou.
      const responses = await Promise.all(
        deleteTargets.map((c) =>
          apiFetch(`/api/whatsapp/config?id=${c.id}`, { method: "DELETE" }),
        ),
      );
      const removed = deleteTargets.filter((_, i) => responses[i].ok);
      const failed = deleteTargets.length - removed.length;
      if (removed.length > 0) {
        toast.success(removed.length > 1 ? `${removed.length} canais removidos.` : "Canal removido.");
      }
      if (failed > 0) {
        toast.error(failed > 1 ? `${failed} canais não puderam ser removidos.` : "Não foi possível remover o canal.");
      }
      setSelected((prev) => {
        const next = new Set(prev);
        removed.forEach((c) => next.delete(c.id));
        return next;
      });
      await fetchConfigs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao remover canal(is)");
    } finally {
      setDeleteBusy(false);
      setDeleteTargets(null);
    }
  }

  const selectedCount = selected.size;

  return (
    <PageBody>
      {/* Cabeçalho (redesenho DDM) */}
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Canais</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Linhas e canais conectados — WhatsApp, Instagram, Messenger e Webchat, com o cliente de cada linha.
        </p>
      </div>

      {!loading && configs.length > 0 && (
        <KpiStrip
          ariaLabel="Resumo dos canais"
          items={[
            {
              label: "Linhas ativas",
              value: <CountUp value={activeCount} />,
              note: `de ${configs.length}`,
              info: "Linhas WhatsApp habilitadas e conectadas agora.",
            },
            {
              label: "Com alerta",
              value: <CountUp value={alertCount} className={alertCount > 0 ? "text-danger" : undefined} />,
              note: alertCount > 0 ? "veja a coluna Situação" : "tudo em ordem",
              noteTone: alertCount > 0 ? "bad" : "ok",
              info: "Linhas com token inválido, desconectadas estando habilitadas, com aviso de degradação ou com qualidade vermelha na Meta.",
            },
            { label: "Meta Cloud", value: <CountUp value={metaCount} /> },
            { label: "WAHA", value: <CountUp value={wahaCount} /> },
          ]}
        />
      )}

      <PageToolbar
        actions={
          <>
            <Button variant="outline" onClick={() => setClientsOpen(true)}>
              Clientes
            </Button>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="size-3.5" />
              Conectar canal
            </Button>
          </>
        }
      >
        <label className="relative flex min-w-0 flex-[1_1_240px] items-center sm:max-w-[360px]">
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar canal ou número"
            aria-label="Buscar canais"
            className="h-[34px] w-full rounded-md border border-border bg-card pl-[34px] pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
          />
        </label>
        <Segmented
          ariaLabel="Filtrar por provedor"
          size="lg"
          value={providerFilter}
          onChange={setProviderFilter}
          options={[
            { value: "all", label: "Todas", count: filteredConfigs.length },
            { value: "meta", label: "Meta Cloud", count: filteredConfigs.filter((c) => c.provider !== "waha").length },
            { value: "waha", label: "WAHA", count: filteredConfigs.filter((c) => c.provider === "waha").length },
          ]}
        />
      </PageToolbar>

      {selectedCount > 0 && (
        <div className="flex animate-ddm-up flex-wrap items-center gap-2.5 rounded-[10px] bg-foreground py-2 pl-4 pr-2.5 text-background">
          <span className="text-[13px] font-semibold">
            {selectedCount} {selectedCount === 1 ? "canal selecionado" : "canais selecionados"}
          </span>
          <span className="flex-1" />
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteTargets(configs.filter((c) => selected.has(c.id)))}
            className="bg-[#d8362f] text-white hover:bg-[#c42b24]"
          >
            <Trash2 className="size-3.5" />
            Excluir
          </Button>
          <button type="button" onClick={() => setSelected(new Set())} className="h-[30px] rounded-md px-2.5 text-[12.5px] opacity-80 hover:opacity-100">
            Limpar
          </button>
        </div>
      )}

      {hasInvalidTokenChannel && (
        <div className="flex animate-ddm-fade items-center gap-3 rounded-[10px] border border-warning-border bg-warning-soft px-3.5 py-3" role="status">
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-[13px] text-foreground">
            <span className="font-semibold">Token de acesso inválido.</span>{" "}
            <span className="text-foreground-2">
              Um ou mais canais Meta estão com o token inválido. Edite o canal e atualize o Token de acesso para restaurar o funcionamento.
            </span>
          </p>
        </div>
      )}

      <TableCard label="Linhas WhatsApp">
        {loading ? (
          <div className="flex flex-col" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5" aria-hidden="true">
                <Skeleton className="size-[30px] rounded-full" />
                <Skeleton className="h-3 w-40" />
                <Skeleton className="ml-auto h-5 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : visibleConfigs.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={MessageCircle}
              title={configs.length === 0 ? "Nenhum canal configurado" : "Nada encontrado"}
              hint={
                configs.length === 0
                  ? "Clique em “Conectar canal” para conectar um número WhatsApp (WAHA ou Meta)."
                  : "Ajuste a busca ou o filtro."
              }
            />
          </div>
        ) : (
          <DenseTable>
            <thead>
              <tr>
                <Th className="w-11 pl-4 pr-0">
                  <Checkbox checked={allVisibleSelected} onCheckedChange={toggleSelectAll} aria-label="Selecionar todos" />
                </Th>
                <Th>Canal</Th>
                <Th className="hidden md:table-cell">Situação</Th>
                <Th className="hidden lg:table-cell">Número / sessão</Th>
                <Th className="hidden xl:table-cell">Qualidade</Th>
                <Th className="hidden xl:table-cell">Fluxo</Th>
                <Th className="hidden 2xl:table-cell">Equipe</Th>
                <Th className="hidden lg:table-cell">Cliente</Th>
                <Th className="hidden sm:table-cell">Receptivo</Th>
                <Th>Ativo</Th>
                <Th className="w-11" />
              </tr>
            </thead>
            <tbody className="ddm-stagger">
              {visibleConfigs.map((c) => {
                const q = quality.get(c.id);
                return (
                  <Tr key={c.id} onClick={() => setDetail(c)} className={cn("cursor-pointer", selected.has(c.id) && "bg-selected")}>
                    <Td className="pl-4 pr-0" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={() => toggleRow(c.id)}
                        aria-label={`Selecionar ${channelName(c)}`}
                      />
                    </Td>
                    <Td>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-success-soft text-success" aria-hidden="true">
                          <MessageCircle className="size-3.5" />
                        </span>
                        <CellMain title={channelName(c)} sub={`WhatsApp · ${c.provider === "waha" ? "WAHA" : "Meta Cloud"}`} />
                      </span>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <ChannelStatus c={c} />
                    </Td>
                    <Td className="hidden whitespace-nowrap tabular-nums text-foreground lg:table-cell">{sessionOrNumber(c)}</Td>
                    <Td className="hidden xl:table-cell">
                      {c.provider === "waha" ? (
                        <span className="text-muted-foreground" title="Qualidade e limite são da Meta; não se aplicam ao WAHA.">—</span>
                      ) : q ? (
                        <QualityChip q={q} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td className="hidden max-w-[180px] truncate text-foreground-2 xl:table-cell">
                      {c.flow_id ? flowNameById.get(c.flow_id) ?? "—" : "—"}
                    </Td>
                    <Td className="hidden max-w-[180px] truncate text-foreground-2 2xl:table-cell">
                      {c.team_id ? teamNameById.get(c.team_id) ?? "—" : "—"}
                    </Td>
                    <Td className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={c.client_id ?? ""}
                        onChange={(e) => handleClientChange(c, e.target.value || null)}
                        aria-label={`Cliente — ${channelName(c)}`}
                        className="h-8 max-w-[160px] rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary"
                      >
                        <option value="">—</option>
                        {clients.map((cl) => (
                          <option key={cl.id} value={cl.id}>
                            {cl.name}
                          </option>
                        ))}
                      </select>
                    </Td>
                    <Td className="hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={c.receptivo}
                        onCheckedChange={() => handleToggleField(c, "receptivo")}
                        disabled={toggleBusyKey === `${c.id}:receptivo`}
                        aria-label={`Receptivo — ${channelName(c)}`}
                      />
                    </Td>
                    <Td onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={c.habilitado}
                        onCheckedChange={() => handleToggleField(c, "habilitado")}
                        disabled={toggleBusyKey === `${c.id}:habilitado`}
                        aria-label={`Ativo — ${channelName(c)}`}
                      />
                    </Td>
                    <Td className="pr-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <ChannelActions
                        c={c}
                        stopBusy={stopBusyId === c.id}
                        onConnect={() => setConnecting(c)}
                        onDisconnect={() => handleDisconnect(c)}
                        onTest={() => setTesting(c)}
                        onEdit={() => setEditing(c)}
                        onDelete={() => setDeleteTargets([c])}
                      />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </DenseTable>
        )}
      </TableCard>

      {/* Gaveta de detalhe da linha (primitivo DetailDrawer do redesenho). */}
      <DetailDrawer
        open={detailRow !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        title={detailRow ? channelName(detailRow) : ""}
        description={detailRow ? `WhatsApp · ${detailRow.provider === "waha" ? "WAHA" : "Meta Cloud"}` : undefined}
        headerExtra={detailRow ? <ChannelStatus c={detailRow} /> : undefined}
        footer={
          detailRow ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setTesting(detailRow)}>
                <Zap className="size-3.5" />
                Testar
              </Button>
              <Button
                onClick={() => {
                  setEditing(detailRow);
                  setDetail(null);
                }}
              >
                Editar canal
              </Button>
            </div>
          ) : undefined
        }
      >
        {detailRow && (
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
            <dt className="text-muted-foreground">Número / sessão</dt>
            <dd className="tabular-nums text-foreground">{sessionOrNumber(detailRow)}</dd>
            <dt className="text-muted-foreground">Situação</dt>
            <dd><ChannelStatus c={detailRow} /></dd>
            {detailRow.provider !== "waha" && quality.get(detailRow.id) && (
              <>
                <dt className="text-muted-foreground">Qualidade (Meta)</dt>
                <dd><QualityChip q={quality.get(detailRow.id)!} detailed /></dd>
              </>
            )}
            <dt className="text-muted-foreground">Fluxo</dt>
            <dd className="text-foreground">{detailRow.flow_id ? flowNameById.get(detailRow.flow_id) ?? "—" : "—"}</dd>
            <dt className="text-muted-foreground">Equipe</dt>
            <dd className="text-foreground">{detailRow.team_id ? teamNameById.get(detailRow.team_id) ?? "—" : "—"}</dd>
            <dt className="text-muted-foreground">Cliente</dt>
            <dd className="text-foreground">{clients.find((cl) => cl.id === detailRow.client_id)?.name ?? "—"}</dd>
            <dt className="text-muted-foreground">Receptivo</dt>
            <dd className="text-foreground">{detailRow.receptivo ? "Sim" : "Não"}</dd>
            <dt className="text-muted-foreground">Ativo</dt>
            <dd className="text-foreground">{detailRow.habilitado ? "Sim" : "Não"}</dd>
          </dl>
        )}
      </DetailDrawer>

      <SocialChannelsSection flows={flows} teams={teams} clients={clients} />

      {/* Só fluxos ativos: o motor recusa iniciar Webchat em rascunho. */}
      <WebchatSettingsSection flows={flows.filter((f) => f.status === "active")} />

      <ClientsDialog
        accountId={accountId}
        clients={clients}
        open={clientsOpen}
        onOpenChange={setClientsOpen}
        onChanged={fetchClients}
      />

      <NewChannelDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        teams={teams}
        onCreated={async (provider, wahaSession, skipConnect) => {
          const list = await fetchConfigs();
          // Sessão existente já está WORKING — não abre o modal de QR/pairing.
          if (skipConnect) return;
          if (provider === "waha" && wahaSession) {
            const created = list.find((c) => c.waha_session === wahaSession);
            if (created) setConnecting(created);
          }
        }}
      />

      <EditChannelDialog
        config={editing}
        flows={flows}
        teams={teams}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          fetchConfigs();
        }}
      />

      <ConnectWahaDialog
        config={connecting}
        open={connecting !== null}
        onOpenChange={(open) => !open && setConnecting(null)}
        onConnected={() => {
          setConnecting(null);
          fetchConfigs();
        }}
      />

      <TestChannelDialog channel={testing} onClose={() => setTesting(null)} />

      <Dialog open={deleteTargets !== null} onOpenChange={(open) => !open && setDeleteTargets(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Excluir canal{(deleteTargets?.length ?? 0) > 1 ? "is" : ""}?
            </DialogTitle>
            <DialogDescription>
              {deleteTargets && deleteTargets.length === 1
                ? `${channelName(deleteTargets[0])} será removido permanentemente.`
                : `${deleteTargets?.length ?? 0} canais serão removidos permanentemente.`}{" "}
              Essa ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTargets(null)} disabled={deleteBusy}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteBusy}>
              {deleteBusy ? "Excluindo…" : "Excluir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
/** Saúde do número Meta (GET /api/disparador/rate-limits). */
interface ChannelQuality {
  quality_rating: string;
  messaging_limit_tier: string | null;
  daily_limit: number | null;
  effective_rate?: number | null;
}

const QUALITY_TONE: Record<string, { tone: "ok" | "warn" | "bad" | "mute"; label: string }> = {
  GREEN: { tone: "ok", label: "Verde" },
  YELLOW: { tone: "warn", label: "Amarela" },
  RED: { tone: "bad", label: "Vermelha" },
  UNKNOWN: { tone: "mute", label: "Sem leitura" },
};

/** Qualidade da Meta com rótulo (não só cor) e, no detalhe, limite e ritmo. */
function QualityChip({ q, detailed = false }: { q: ChannelQuality; detailed?: boolean }) {
  const t = QUALITY_TONE[q.quality_rating] ?? QUALITY_TONE.UNKNOWN;
  const limit = q.daily_limit != null ? `${q.daily_limit.toLocaleString("pt-BR")}/dia` : q.messaging_limit_tier;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusChip tone={t.tone} dot title={limit ? `Limite: ${limit}` : undefined}>
        {t.label}
      </StatusChip>
      {detailed && limit && <span className="text-xs text-muted-foreground">Limite {limit}</span>}
      {detailed && q.effective_rate != null && (
        <span className="text-xs text-muted-foreground">· ritmo {q.effective_rate}/s</span>
      )}
    </span>
  );
}

/** Situação da linha: conectada, aviso, token inválido ou desconectada. */
function ChannelStatus({ c }: { c: ChannelConfig }) {
  if (c.status === "warning") {
    return (
      <StatusChip tone="warn" dot title={c.warning_message || "Sinal de degradação detectado neste canal."}>
        Atenção
      </StatusChip>
    );
  }
  if (c.connected) {
    return (
      <StatusChip tone="ok" dot>
        Conectado
      </StatusChip>
    );
  }
  const invalid = invalidTokenLabel(c);
  if (invalid) {
    return (
      <StatusChip tone="bad" dot title="O token de acesso deste canal está inválido ou expirado. Edite o canal e atualize o Token de acesso.">
        {invalid}
      </StatusChip>
    );
  }
  return (
    <StatusChip tone="bad" dot>
      Desconectado
    </StatusChip>
  );
}

function ChannelActions({
  c,
  stopBusy,
  onConnect,
  onDisconnect,
  onTest,
  onEdit,
  onDelete,
}: {
  c: ChannelConfig;
  stopBusy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
        aria-label={`Ações — ${channelName(c)}`}
      >
        <MoreVertical className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {c.provider === "waha" &&
          (c.connected ? (
            <DropdownMenuItem onClick={onDisconnect} disabled={stopBusy}>
              {stopBusy ? "Desconectando…" : "Desconectar"}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={onConnect}>Conectar</DropdownMenuItem>
          ))}
        {c.provider === "waha" && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onTest}>
          <Zap className="size-4" />
          Testar
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>Editar</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          Excluir
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
