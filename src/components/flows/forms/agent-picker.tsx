"use client";

// "Agente" do nó de IA (Fase 4): escolhe um perfil de Configurações → Agentes. Com agente, modo,
// prompt, modelo, ferramentas, base de conhecimento e proteções vêm dele (versão fixada no run);
// o nó mantém só o fio do fluxo (próximo nó, saída de falha, tags/switch). Só agentes LIGADOS
// aparecem para escolher; um desligado já vinculado aparece com aviso.

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

interface AgentListItem {
  id: string;
  name: string;
  enabled: boolean;
  published_version: { id: string; version: number } | null;
}

export function AgentPicker({
  agentId,
  failureKey,
  allNodes,
  currentKey,
  onChange,
}: {
  agentId: string | undefined;
  failureKey: string | undefined;
  allNodes: BuilderNode[];
  currentKey: string;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/settings/agents", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && Array.isArray(data?.agents)) setAgents(data.agents as AgentListItem[]);
        else setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = agents?.find((a) => a.id === agentId);
  const choices = (agents ?? []).filter((a) => a.enabled || a.id === agentId);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <label className="text-sm font-medium text-foreground">Agente</label>
      <p className="text-xs text-muted-foreground">
        Perfil de Configurações → Agentes. Com agente, modo, prompt, modelo, ferramentas, base de conhecimento e proteções vêm dele
        (versão fixada quando a conversa começa); aqui ficam só o próximo nó e a saída de falha.
      </p>
      {failed && <p className="text-xs text-destructive">Não foi possível carregar a lista de agentes.</p>}

      <select
        className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
        value={agentId ?? ""}
        disabled={!agents}
        onChange={(e) => onChange({ agent_id: e.target.value || undefined })}
      >
        <option value="">Sem agente (configuração legada abaixo)</option>
        {choices.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.published_version ? ` — v${a.published_version.version}` : ""}
            {a.enabled ? "" : " (desligado)"}
          </option>
        ))}
        {agentId && agents && !selected && <option value={agentId}>Agente removido desta conta</option>}
      </select>

      {agentId && selected && !selected.enabled && (
        <p className="text-xs text-amber-600">Desligado: o nó não vai responder e segue pela saída de falha (ou fila humana).</p>
      )}
      {agentId && agents && !selected && (
        <p className="text-xs text-destructive">Este agente não existe mais nesta conta. Escolha outro ou volte para a configuração legada.</p>
      )}
      {agentId && (
        <>
          <a
            href={`/settings?tab=agents&id=${encodeURIComponent(agentId)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-primary hover:underline"
          >
            Editar agente
          </a>
          <NextNodeRow
            value={failureKey ?? ""}
            allNodes={allNodes}
            currentKey={currentKey}
            onChange={(v) => onChange({ failure_next_node_key: v || undefined })}
            label="Se o agente estiver desligado ou indisponível, segue para"
          />
        </>
      )}
    </div>
  );
}
