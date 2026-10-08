"use client";

// "Ferramentas do catálogo" no nó de IA: seletor múltiplo das ferramentas
// cadastradas em Configurações → Ferramentas. Só as HABILITADAS aparecem para
// adicionar; as desligadas que já estão vinculadas continuam listadas, com
// aviso (o agente não as usa até serem ligadas).

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";

interface CatalogTool {
  id: string;
  name: string;
  display_name: string;
  enabled: boolean;
  http: { method: string };
  host: string;
}

export function ToolCatalogPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (refs: string[]) => void;
}) {
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/settings/tools", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && Array.isArray(data?.tools)) setTools(data.tools as CatalogTool[]);
        else setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const byId = new Map((tools ?? []).map((t) => [t.id, t]));
  const available = (tools ?? []).filter((t) => t.enabled && !selected.includes(t.id));

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">Ferramentas do catálogo</label>
      <p className="text-xs text-muted-foreground">
        Ferramentas reutilizáveis cadastradas em Configurações → Ferramentas (com liga/desliga). Valem junto com as inline abaixo.
      </p>

      {failed && <p className="text-xs text-destructive">Não foi possível carregar o catálogo de ferramentas.</p>}

      {selected.map((id) => {
        const tool = byId.get(id);
        return (
          <div key={id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-foreground">
                {tool ? tool.display_name || tool.name : "Ferramenta removida do catálogo"}
              </div>
              {tool && (
                <div className="truncate text-xs text-muted-foreground">
                  {tool.name} · {tool.http.method} {tool.host}
                </div>
              )}
              {tool && !tool.enabled && (
                <div className="text-xs text-amber-600">Desligada: o agente não vai usar esta ferramenta até ligá-la.</div>
              )}
              {tools && !tool && (
                <div className="text-xs text-destructive">Não existe mais nesta conta. Remova do nó.</div>
              )}
            </div>
            <button
              type="button"
              className="shrink-0 text-xs text-destructive hover:underline"
              onClick={() => onChange(selected.filter((r) => r !== id))}
            >
              Remover
            </button>
          </div>
        );
      })}

      {tools && (
        <select
          className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange([...selected, e.target.value]);
          }}
          disabled={available.length === 0}
        >
          <option value="">
            {available.length === 0 ? "Nenhuma ferramenta ligada disponível" : "+ Adicionar ferramenta do catálogo…"}
          </option>
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {(t.display_name || t.name) + " — " + t.http.method + " " + t.host}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
