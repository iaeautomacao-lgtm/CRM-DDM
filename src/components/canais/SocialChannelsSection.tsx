"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AtSign, MessageCircle, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ClientOption } from "./ClientsDialog";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { StatusChip } from "@/components/ddm/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usePermission } from "@/hooks/use-permission";
import { ErrorState } from "@/components/dashboard/error-state";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Linhas de Instagram e Messenger (wacrm.channels, migration 128). A
// conexão é por OAuth da Meta (/api/channels/<tipo>/connect); aqui se
// escolhe equipe, fluxo receptivo e cliente de cada linha, e liga/desliga.

interface SocialChannel {
  id: string;
  type: "instagram" | "messenger" | "sms";
  name: string;
  username: string | null;
  avatar_url: string | null;
  team_id: string | null;
  flow_id: string | null;
  client_id: string | null;
  habilitado: boolean;
  status: string;
  last_error: string | null;
  token_expires_at: string | null;
}

type Option = { id: string; name: string };

export function SocialChannelsSection({
  flows,
  teams,
  clients,
}: {
  flows: Option[];
  teams: Option[];
  clients: ClientOption[];
}) {
  const [channels, setChannels] = useState<SocialChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SocialChannel | null>(null);
  // Conectar, ligar/desligar, fluxo, equipe, cliente e desconectar: channels.manage (o mesmo de /api/channels/*).
  const canManage = usePermission("channels.manage");
  // Variáveis que faltam no servidor por canal (GET /api/channels).
  const [setup, setSetup] = useState<{
    instagram: { missing: string[] };
    messenger: { missing: string[] };
    webhook_verify_token: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/channels");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Erro HTTP ${res.status}`);
      setChannels(json.channels ?? []);
      setSetup(json.setup ?? null);
      setLoadError(null);
    } catch {
      setLoadError("Não foi possível carregar Instagram e Messenger.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(id: string, body: Partial<SocialChannel>) {
    const res = await apiFetch(`/api/channels/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? "Falha ao atualizar canal");
      return;
    }
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...json.channel } : c)));
  }

  async function remove(c: SocialChannel) {
    setRemoveTarget(null);
    const res = await apiFetch(`/api/channels/${c.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Falha ao remover canal");
      return;
    }
    setChannels((prev) => prev.filter((x) => x.id !== c.id));
  }

  const select = (
    value: string | null,
    options: Option[],
    onChange: (v: string | null) => void,
    label: string,
  ) => (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={!canManage}
      aria-label={label}
      className="h-8 max-w-[180px] rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary"
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );

  return (
    <TableCard
      title="Instagram e Messenger"
      hint="Conecte pela Meta. No Messenger, a própria Meta pergunta quais páginas liberar."
      action={canManage && (
        <div className="flex flex-wrap gap-2">
          {/* Navegação completa: o OAuth sai para a Meta e volta em /canais. */}
          <Button
            variant="outline"
            disabled={!!setup && setup.instagram.missing.length > 0}
            title={setup?.instagram.missing.length ? `Faltam no servidor: ${setup.instagram.missing.join(", ")}` : undefined}
            onClick={() => (window.location.href = "/api/channels/instagram/connect")}
          >
            <AtSign className="size-3.5 text-pink-500" />
            Conectar Instagram
          </Button>
          <Button
            variant="outline"
            disabled={!!setup && setup.messenger.missing.length > 0}
            title={setup?.messenger.missing.length ? `Faltam no servidor: ${setup.messenger.missing.join(", ")}` : undefined}
            onClick={() => (window.location.href = "/api/channels/messenger/connect")}
          >
            <MessageCircle className="size-3.5 text-blue-500" />
            Conectar Messenger
          </Button>
        </div>
      )}
    >
      {setup && (setup.instagram.missing.length > 0 || setup.messenger.missing.length > 0 || !setup.webhook_verify_token) && (
        <div className="mx-[18px] mb-3.5 rounded-[10px] border border-warning-border bg-warning-soft px-3.5 py-3 text-[12.5px] text-foreground-2" role="status">
          <p className="font-semibold text-foreground">Configuração pendente no servidor (.env)</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {setup.instagram.missing.length > 0 && <li>Instagram: {setup.instagram.missing.join(", ")}</li>}
            {setup.messenger.missing.length > 0 && <li>Messenger: {setup.messenger.missing.join(", ")}</li>}
            {!setup.webhook_verify_token && (
              <li>Webhook da Meta: META_WEBHOOK_VERIFY_TOKEN (sem ele as mensagens não chegam)</li>
            )}
          </ul>
          <p className="mt-1">Depois de configurar, reinicie o app e recarregue esta página.</p>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col border-t border-border" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5" aria-hidden="true">
              <Skeleton className="size-[30px] rounded-full" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <div className="border-t border-border p-4">
          <ErrorState className="min-h-0" title={loadError} onRetry={() => void load()} />
        </div>
      ) : channels.length === 0 ? (
        <p className="border-t border-border px-[18px] py-6 text-center text-[13px] text-muted-foreground">
          Nenhuma conta de Instagram ou página do Messenger conectada.
        </p>
      ) : (
        <DenseTable>
          <thead>
            <tr>
              <Th>Canal</Th>
              <Th className="hidden md:table-cell">Situação</Th>
              <Th className="hidden lg:table-cell">Fluxo</Th>
              <Th className="hidden xl:table-cell">Equipe</Th>
              <Th className="hidden lg:table-cell">Cliente</Th>
              <Th>Ativo</Th>
              <Th className="w-11" />
            </tr>
          </thead>
          <tbody className="ddm-stagger">
            {channels.map((c) => {
              const expiresSoon =
                c.token_expires_at && Date.parse(c.token_expires_at) - Date.now() < 7 * 86_400_000;
              return (
                <Tr key={c.id} interactive={false}>
                  <Td>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={cn(
                          "flex size-[30px] shrink-0 items-center justify-center rounded-full",
                          c.type === "instagram" ? "bg-pink-500/12 text-pink-500" : "bg-blue-500/12 text-blue-500",
                        )}
                        aria-hidden="true"
                      >
                        {c.type === "instagram" ? <AtSign className="size-3.5" /> : <MessageCircle className="size-3.5" />}
                      </span>
                      <CellMain
                        title={c.name}
                        sub={`${c.type === "instagram" ? "Instagram" : "Messenger"}${c.username ? ` · @${c.username}` : ""}`}
                      />
                    </span>
                  </Td>
                  <Td className="hidden md:table-cell">
                    {c.status === "connected" && !expiresSoon ? (
                      <StatusChip tone="ok" dot>Conectado</StatusChip>
                    ) : (
                      <StatusChip tone={c.status !== "connected" ? "bad" : "warn"} dot title={c.last_error ?? undefined}>
                        {c.status !== "connected" ? "Erro — reconecte" : "Token vence em breve"}
                      </StatusChip>
                    )}
                  </Td>
                  <Td className="hidden lg:table-cell">{select(c.flow_id, flows, (v) => patch(c.id, { flow_id: v }), `Fluxo — ${c.name}`)}</Td>
                  <Td className="hidden xl:table-cell">{select(c.team_id, teams, (v) => patch(c.id, { team_id: v }), `Equipe — ${c.name}`)}</Td>
                  <Td className="hidden lg:table-cell">{select(c.client_id, clients, (v) => patch(c.id, { client_id: v }), `Cliente — ${c.name}`)}</Td>
                  <Td>
                    <Switch
                      checked={c.habilitado}
                      onCheckedChange={(checked) => patch(c.id, { habilitado: checked })}
                      disabled={!canManage}
                      aria-label={`Ativo — ${c.name}`}
                    />
                  </Td>
                  <Td className="pr-2 text-right">
                    {canManage && <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-danger-soft hover:text-danger"
                      onClick={() => setRemoveTarget(c)}
                      aria-label={`Desconectar ${c.name}`}
                      title="Desconectar"
                    >
                      <Trash2 className="size-4" />
                    </button>}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </DenseTable>
      )}

      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>As conversas ficam no histórico.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <Button variant="destructive" onClick={() => removeTarget && void remove(removeTarget)}>
              Desconectar
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TableCard>
  );
}
