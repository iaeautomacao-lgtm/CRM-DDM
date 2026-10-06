// Marcadores são referências ao ambiente, nunca valores resolvidos.
const PLACEHOLDER = /^\{\{\s*secret\.[A-Za-z0-9_]+\s*\}\}$/;
const SECRET_KEY = /^(?:authorization|proxy_authorization|(?:x_)?(?:api_?key|auth_?token)|(?:[a-z0-9]+_)*(?:token|secret|password|passwd|credential|credentials|private_key|api_key)|tk|apikey)$/i;

function isSecretKey(key) {
  return SECRET_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]/g, "_"));
}

function maskSecret(value) {
  return typeof value === "string" && PLACEHOLDER.test(value.trim()) ? value : "***";
}

function maskText(text) {
  // Valores opacos longos também podem ser credenciais sem uma chave conhecida.
  // UUIDs identificam fluxos/recursos e não são credenciais por si só.
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(text)
    && /^(?:[a-f0-9]{32,}|(?=[A-Za-z0-9_+/=-]{32,}$)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9_+/=-]+)$/i.test(text)) {
    return "***";
  }
  // Mesma ideia de findInlineSecrets em tool-secrets.ts, sem limite mínimo:
  // até tokens curtos precisam ficar fora de um arquivo versionado.
  return text
    .replace(/([?&])([^=&#\s]+)=([^&#\r\n]*)/g, (match, prefix, key, value) => {
      try {
        const decodedKey = decodeURIComponent(key);
        if (!isSecretKey(decodedKey) && decodedKey.toLowerCase() !== "key") return match;
        return `${prefix}${key}=${PLACEHOLDER.test(decodeURIComponent(value).trim()) ? value : "***"}`;
      } catch {
        // Parâmetro malformado: não conservar um possível segredo.
        return `${prefix}${key}=***`;
      }
    })
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1***@")
    .replace(/\b(Bearer|Basic)\s+(\{\{\s*secret\.[A-Za-z0-9_]+\s*\}\}[^\s,;"']*|[^\s,;"']+)/gi,
      (_match, scheme, value) => `${scheme} ${maskSecret(value)}`)
    .replace(/\b((?:proxy-)?authorization|x-api-key)\s*:\s*([^\r\n]+)/gi,
      (_match, key, value) => `${key}: ${maskSecret(value)}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "***")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|EA[A-Za-z0-9]{30,})\b/g, "***");
}

/** Mascara recursivamente campos, URLs e headers, sem alterar a entrada. */
export function maskSecrets(value) {
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value === null || typeof value !== "object") return value;

  // Headers também podem ser representados como [{ name: 'Authorization', value: ... }].
  const namedSecret = [value.name, value.key].some((name) => typeof name === "string" && isSecretKey(name));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSecretKey(key) || (namedSecret && key === "value") ? maskSecret(item) : maskSecrets(item),
  ]));
}

/** Ordena chaves em todos os níveis; a ordem de arrays de configuração é significativa. */
export function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
}

/** Só inclui definição do fluxo; timestamps e contadores não entram no diff. */
export function serializeFlowExport(flow, nodes) {
  const payload = {
    version: "1.0",
    flow: Object.fromEntries([
      "id", "name", "description", "status", "trigger_type", "trigger_config", "entry_node_id", "fallback_policy",
    ].map((key) => [key, flow[key]])),
    nodes: [...nodes]
      .sort((a, b) => a.node_key < b.node_key ? -1 : a.node_key > b.node_key ? 1 : 0)
      .map((node) => Object.fromEntries([
        "node_key", "node_type", "config", "position_x", "position_y",
      ].map((key) => [key, node[key]]))),
  };
  return `${JSON.stringify(sortObjectKeys(maskSecrets(payload)), null, 2)}\n`;
}
