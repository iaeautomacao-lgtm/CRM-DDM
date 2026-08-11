"use client";

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
import { MessageCircle, MoreVertical, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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

function channelName(c: ChannelConfig): string {
  if (c.provider === "waha") return c.waha_session || "Sessão WAHA";
  return c.phone_info?.verified_name || c.phone_info?.display_phone_number || "Meta Config";
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
  const [configs, setConfigs] = useState<ChannelConfig[]>([]);
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toggleBusyKey, setToggleBusyKey] = useState<string | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelConfig | null>(null);
  const [connecting, setConnecting] = useState<ChannelConfig | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<ChannelConfig[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [stopBusyId, setStopBusyId] = useState<string | null>(null);

  const fetchConfigs = useCallback(async (): Promise<ChannelConfig[]> => {
    setLoading(true);
    try {
      const res = await fetch("/api/whatsapp/config");
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
    fetch("/api/flows")
      .then((res) => res.json())
      .then((data) => {
        const list = (data.flows ?? []) as { id: string; name: string }[];
        setFlows(list.map((f) => ({ id: f.id, name: f.name })));
      })
      .catch((err) => console.error("[canais] failed to load flows:", err));
  }, []);

  const flowNameById = useMemo(() => new Map(flows.map((f) => [f.id, f.name])), [flows]);

  const filteredConfigs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return configs;
    return configs.filter((c) => searchHaystack(c).includes(q) || channelName(c).toLowerCase().includes(q));
  }, [configs, search]);

  const allVisibleSelected =
    filteredConfigs.length > 0 && filteredConfigs.every((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        filteredConfigs.forEach((c) => next.delete(c.id));
        return next;
      }
      const next = new Set(prev);
      filteredConfigs.forEach((c) => next.add(c.id));
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
      const res = await fetch("/api/whatsapp/waha/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: c.waha_session, id: c.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to stop session");
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
      const res = await fetch("/api/whatsapp/config", {
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
      await Promise.all(
        deleteTargets.map((c) =>
          fetch(`/api/whatsapp/config?id=${c.id}`, { method: "DELETE" }),
        ),
      );
      toast.success(deleteTargets.length > 1 ? "Canais removidos." : "Canal removido.");
      setSelected((prev) => {
        const next = new Set(prev);
        deleteTargets.forEach((c) => next.delete(c.id));
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
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Canais</h1>
          <p className="text-sm text-muted-foreground">
            Gerenciamento de canais WhatsApp conectados.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90">
          <Plus className="size-4" />
          Novo canal
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar por canal"
            className="pl-8"
          />
        </div>
        {selectedCount > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{selectedCount} selecionado(s)</span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteTargets(configs.filter((c) => selected.has(c.id)))}
            >
              <Trash2 className="size-4" />
              Excluir selecionados
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card">
        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : filteredConfigs.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={MessageCircle}
              title={configs.length === 0 ? "Nenhum canal configurado" : "Nenhum canal encontrado"}
              hint={
                configs.length === 0
                  ? "Clique em “Novo canal” para conectar um número WhatsApp (WAHA ou Meta)."
                  : "Ajuste a pesquisa para ver outros canais."
              }
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 cursor-pointer"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    aria-label="Selecionar todos"
                  />
                </TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Provedor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sessão/Número</TableHead>
                <TableHead>Fluxo</TableHead>
                <TableHead>Receptivo</TableHead>
                <TableHead>Habilitado</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredConfigs.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 cursor-pointer"
                      checked={selected.has(c.id)}
                      onChange={() => toggleRow(c.id)}
                      aria-label={`Selecionar ${channelName(c)}`}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <MessageCircle className="size-4 text-[#25D366]" />
                      <span className="font-medium text-foreground">{channelName(c)}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        c.provider === "waha"
                          ? "bg-[#DBEAFE] text-[#1D4ED8]"
                          : "bg-[#14532D] text-white"
                      }
                    >
                      {c.provider === "waha" ? "WAHA" : "Meta"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.connected ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DCFCE7] px-2 py-0.5 text-xs font-medium text-[#14532D]">
                        <span className="relative flex size-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#14532D] opacity-75" />
                          <span className="relative inline-flex size-2 rounded-full bg-[#14532D]" />
                        </span>
                        Conectado
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-[#FEE2E2] px-2 py-0.5 text-xs font-medium text-[#B91C1C]">
                        Desconectado
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{sessionOrNumber(c)}</TableCell>
                  <TableCell>{c.flow_id ? flowNameById.get(c.flow_id) ?? "—" : "—"}</TableCell>
                  <TableCell>
                    <Switch
                      checked={c.receptivo}
                      onCheckedChange={() => handleToggleField(c, "receptivo")}
                      disabled={toggleBusyKey === `${c.id}:receptivo`}
                      aria-label={`Receptivo — ${channelName(c)}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={c.habilitado}
                      onCheckedChange={() => handleToggleField(c, "habilitado")}
                      disabled={toggleBusyKey === `${c.id}:habilitado`}
                      aria-label={`Habilitado — ${channelName(c)}`}
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
                        {c.provider === "waha" &&
                          (c.connected ? (
                            <DropdownMenuItem
                              onClick={() => handleDisconnect(c)}
                              disabled={stopBusyId === c.id}
                              className="text-popover-foreground"
                            >
                              {stopBusyId === c.id ? "Desconectando…" : "Desconectar"}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => setConnecting(c)}
                              className="text-popover-foreground"
                            >
                              Conectar
                            </DropdownMenuItem>
                          ))}
                        {c.provider === "waha" && <DropdownMenuSeparator className="bg-border" />}
                        <DropdownMenuItem onClick={() => setEditing(c)} className="text-popover-foreground">
                          Editar
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDeleteTargets([c])}
                          className="text-red-500 focus:bg-red-50 focus:text-red-500"
                        >
                          Excluir
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <NewChannelDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={async (provider, wahaSession) => {
          const list = await fetchConfigs();
          if (provider === "waha" && wahaSession) {
            const created = list.find((c) => c.waha_session === wahaSession);
            if (created) setConnecting(created);
          }
        }}
      />

      <EditChannelDialog
        config={editing}
        flows={flows}
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
    </div>
  );
}
