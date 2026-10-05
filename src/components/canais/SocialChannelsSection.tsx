"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AtSign, MessageCircle, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ClientOption } from "./ClientsDialog";

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

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/channels");
      const json = await res.json();
      setChannels(json.channels ?? []);
    } catch {
      toast.error("Falha ao carregar Instagram/Messenger");
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
    if (!window.confirm(`Desconectar ${c.name}? As conversas ficam no histórico.`)) return;
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
      aria-label={label}
      className="h-8 max-w-[180px] rounded-md border border-border bg-background px-2 text-xs text-foreground"
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Instagram e Messenger</h2>
          <p className="text-sm text-muted-foreground">
            Conecte pela Meta. No Messenger, a própria Meta pergunta quais páginas liberar.
          </p>
        </div>
        <div className="flex gap-2">
          {/* Navegação completa: o OAuth sai para a Meta e volta em /canais. */}
          <Button variant="outline" onClick={() => (window.location.href = "/api/channels/instagram/connect")}>
            <AtSign className="size-4 text-pink-500" />
            Conectar Instagram
          </Button>
          <Button variant="outline" onClick={() => (window.location.href = "/api/channels/messenger/connect")}>
            <MessageCircle className="size-4 text-blue-500" />
            Conectar Messenger
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Carregando…</p>
        ) : channels.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nenhuma conta de Instagram ou página do Messenger conectada.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Canal</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Fluxo</TableHead>
                <TableHead>Equipe</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Habilitado</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.map((c) => {
                const expiresSoon =
                  c.token_expires_at && Date.parse(c.token_expires_at) - Date.now() < 7 * 86_400_000;
                return (
                  <TableRow key={c.id}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        {c.type === "instagram" ? (
                          <AtSign className="size-4 text-pink-500" />
                        ) : (
                          <MessageCircle className="size-4 text-blue-500" />
                        )}
                        <span className="font-medium text-foreground">{c.name}</span>
                        {c.username && <span className="text-xs text-muted-foreground">@{c.username}</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      {c.status === "connected" && !expiresSoon ? (
                        <span className="rounded-full bg-[#DCFCE7] px-2 py-0.5 text-xs font-medium text-[#14532D]">
                          Conectado
                        </span>
                      ) : (
                        <span
                          className="rounded-full bg-[#FEE2E2] px-2 py-0.5 text-xs font-medium text-[#B91C1C]"
                          title={c.last_error ?? undefined}
                        >
                          {c.status !== "connected" ? "Erro — reconecte" : "Token vence em breve"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{select(c.flow_id, flows, (v) => patch(c.id, { flow_id: v }), "Fluxo")}</TableCell>
                    <TableCell>{select(c.team_id, teams, (v) => patch(c.id, { team_id: v }), "Equipe")}</TableCell>
                    <TableCell>{select(c.client_id, clients, (v) => patch(c.id, { client_id: v }), "Cliente")}</TableCell>
                    <TableCell>
                      <Switch
                        checked={c.habilitado}
                        onCheckedChange={(checked) => patch(c.id, { habilitado: checked })}
                        aria-label={`Habilitado — ${c.name}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-red-400"
                        onClick={() => remove(c)}
                        aria-label={`Desconectar ${c.name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
