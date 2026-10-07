"use client";

// Editor de UMA ferramenta HTTP do agente de IA (nome, descrição, método, URL,
// body, headers e parâmetros). Reaproveitado pelo editor inline do nó (legado)
// e pelo cadastro Configurações → Ferramentas (catálogo).
//
// Credencial: não digite tokens aqui — use {{cred.NOME}} (Configurações →
// Variáveis e credenciais). A rota recusa credencial em texto.

import type { AiAgentTool, AiAgentToolParameter } from "@/lib/flows/types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function AiToolEditor({
  tool,
  onChange,
  showTimeout = false,
  lockName = false,
}: {
  tool: AiAgentTool;
  onChange: (next: AiAgentTool) => void;
  /** Mostra o campo de tempo limite (catálogo). */
  showTimeout?: boolean;
  /** Nome da função não editável (ferramenta já salva no catálogo). */
  lockName?: boolean;
}) {
  const setParams = (properties: AiAgentTool["parameters"]["properties"], required?: string[]) =>
    onChange({ ...tool, parameters: { ...tool.parameters, properties, ...(required ? { required } : {}) } });
  const headers = Object.entries(tool.http.headers ?? {});
  const setHeaders = (entries: Array<[string, string]>) =>
    onChange({ ...tool, http: { ...tool.http, headers: Object.fromEntries(entries) } });

  return (
    <div className="space-y-3">
      {/* name */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Nome da função (sem espaços)</label>
        <input
          type="text"
          className="w-full rounded border border-input bg-background px-2 py-1 text-xs disabled:opacity-60"
          placeholder="ex: buscar_cpf"
          value={tool.name}
          disabled={lockName}
          onChange={(e) => onChange({ ...tool, name: e.target.value.replace(/\s+/g, "_") })}
        />
      </div>

      {/* description */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Descrição (instrui o agente quando usar)</label>
        <textarea
          rows={2}
          className="w-full rounded border border-input bg-background px-2 py-1 text-xs resize-none"
          placeholder="Descreva quando e como o agente deve usar esta ferramenta"
          value={tool.description}
          onChange={(e) => onChange({ ...tool, description: e.target.value })}
        />
      </div>

      {/* HTTP config */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Método</label>
        <select
          className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
          value={tool.http.method}
          onChange={(e) => onChange({ ...tool, http: { ...tool.http, method: e.target.value as AiAgentTool["http"]["method"] } })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          URL (use {`{{param}}`} para parâmetros, {`{{var.NOME}}`} para variáveis e {`{{cred.NOME}}`} para credenciais)
        </label>
        <input
          type="text"
          className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono"
          placeholder="https://api.exemplo.com/endpoint?cpf={{cpf}}"
          value={tool.http.url}
          onChange={(e) => onChange({ ...tool, http: { ...tool.http, url: e.target.value } })}
        />
      </div>

      {/* headers */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Headers (ex.: Authorization: Bearer {`{{cred.NOME}}`})</label>
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setHeaders([...headers, [`X-Header-${headers.length + 1}`, ""]])}
          >
            + Header
          </button>
        </div>
        {headers.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              className="w-2/5 rounded border border-input bg-background px-2 py-0.5 text-xs font-mono"
              value={k}
              onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [e.target.value, h[1]] : h)))}
            />
            <input
              type="text"
              className="flex-1 rounded border border-input bg-background px-2 py-0.5 text-xs font-mono"
              placeholder="valor ou {{cred.NOME}}"
              value={v}
              onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [h[0], e.target.value] : h)))}
            />
            <button
              type="button"
              className="shrink-0 text-xs text-destructive hover:underline"
              onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* body — only for POST/PUT/PATCH */}
      {["POST", "PUT", "PATCH"].includes(tool.http.method) && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Body JSON (use {`{{param}}`} para interpolar)</label>
          <textarea
            rows={3}
            className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono resize-none"
            placeholder={`{"cpf": "{{cpf}}"}`}
            value={tool.http.body ?? ""}
            onChange={(e) => onChange({ ...tool, http: { ...tool.http, body: e.target.value } })}
          />
        </div>
      )}

      {showTimeout && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Tempo limite (ms, 1.000–60.000)</label>
          <input
            type="number"
            min={1000}
            max={60000}
            className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
            value={tool.timeout_ms ?? 30000}
            onChange={(e) => onChange({ ...tool, timeout_ms: Number(e.target.value) })}
          />
        </div>
      )}

      {/* Parameters */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Parâmetros</label>
          <button
            type="button"
            onClick={() => {
              const props = { ...(tool.parameters.properties ?? {}) };
              props[`param${Object.keys(props).length + 1}`] = { type: "string", description: "" };
              setParams(props);
            }}
            className="text-xs text-primary hover:underline"
          >
            + Parâmetro
          </button>
        </div>

        {Object.entries(tool.parameters.properties ?? {}).map(([paramKey, paramVal]) => (
          <div key={paramKey} className="rounded border border-border bg-background p-2 space-y-1">
            <div className="flex items-center gap-2">
              <input
                type="text"
                className="flex-1 rounded border border-input bg-muted px-2 py-0.5 text-xs font-mono"
                placeholder="nome_param"
                value={paramKey}
                onChange={(e) => {
                  const props = { ...(tool.parameters.properties ?? {}) };
                  const val = props[paramKey];
                  delete props[paramKey];
                  props[e.target.value || paramKey] = val;
                  setParams(props);
                }}
              />
              <select
                className="rounded border border-input bg-muted px-1 py-0.5 text-xs"
                value={(paramVal as AiAgentToolParameter).type ?? "string"}
                onChange={(e) => {
                  const props = { ...(tool.parameters.properties ?? {}) };
                  props[paramKey] = { ...(props[paramKey] as AiAgentToolParameter), type: e.target.value };
                  setParams(props);
                }}
              >
                <option value="string">texto</option>
                <option value="number">número</option>
                <option value="boolean">sim/não</option>
              </select>
              <button
                type="button"
                onClick={() => {
                  const props = { ...(tool.parameters.properties ?? {}) };
                  delete props[paramKey];
                  setParams(props);
                }}
                className="text-xs text-destructive hover:underline shrink-0"
              >
                ✕
              </button>
            </div>
            <input
              type="text"
              className="w-full rounded border border-input bg-muted px-2 py-0.5 text-xs"
              placeholder="Descrição do parâmetro (instrui o agente)"
              value={(paramVal as AiAgentToolParameter).description ?? ""}
              onChange={(e) => {
                const props = { ...(tool.parameters.properties ?? {}) };
                props[paramKey] = { ...(props[paramKey] as AiAgentToolParameter), description: e.target.value };
                setParams(props);
              }}
            />
            {/* Required toggle */}
            <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={(tool.parameters.required ?? []).includes(paramKey)}
                onChange={(e) => {
                  const req = tool.parameters.required ?? [];
                  const newReq = e.target.checked ? [...req, paramKey] : req.filter((k) => k !== paramKey);
                  setParams(tool.parameters.properties, newReq);
                }}
              />
              Obrigatório
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
