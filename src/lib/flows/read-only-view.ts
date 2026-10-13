// Decisão do dono (13/10, item 11): quem tem só `flows.view_runs` abre o editor em MODO LEITURA (GET /api/flows/[id]); salvar, publicar e apagar
// continuam exigindo `flows.edit`. Na leitura sem edição a rota devolve o desenho do fluxo, mas NÃO os valores de cabeçalhos do nó http_fetch
// (fluxos antigos podem ter token no cabeçalho; as credenciais novas são marcadores {{cred.X}}, que continuam visíveis): só os NOMES dos cabeçalhos.
export const REDACTED_HEADER_VALUE = "••••";

type NodeLike = { node_type?: unknown; config?: unknown } & Record<string, unknown>;

export function redactNodesForReadOnly<T extends NodeLike>(nodes: T[]): T[] {
  return nodes.map((node) => {
    if (node.node_type !== "http_fetch" || !node.config || typeof node.config !== "object") return node;
    const cfg = node.config as Record<string, unknown>;
    const headers = cfg.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return node;
    const redacted = Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" && /^\s*\{\{\s*(?:cred|var|secret)\.[\w.-]+\s*\}\}\s*$/.test(v) ? v : REDACTED_HEADER_VALUE]));
    return { ...node, config: { ...cfg, headers: redacted } };
  });
}
