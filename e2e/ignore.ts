// Ruído de console que NÃO reprova a tela. Mantenha curto e justificado: cada item aqui esconde um possível defeito.
// Respostas 4xx de API (ex.: 403 por escopo) são esperadas em alguns papéis; 5xx são tratadas à parte no teste.
// Extra por ambiente: E2E_IGNORE_CONSOLE="regex1|regex2".
const extra = process.env.E2E_IGNORE_CONSOLE ? [new RegExp(process.env.E2E_IGNORE_CONSOLE, "i")] : [];

export const IGNORED_CONSOLE: RegExp[] = [
  /Failed to load resource: the server responded with a status of 4\d\d/i,
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/i, // escrita bloqueada pelo próprio teste (somente leitura)
  ...extra,
];
