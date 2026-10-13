// Content-Security-Policy da aplicação (revisão de segurança 13/10, item 12 — passo 1: política REAL, ainda em Report-Only).
// Módulo puro, SEM alias "@/": é importado pelo next.config.ts (e, no passo 2, pelo middleware para gerar o nonce por requisição).
//
// De onde o NAVEGADOR realmente carrega/chama coisas (levantado no código, 13/10):
//   - scripts/estilos próprios + Next (hidratação inline) + o script de tema do layout (inline);
//   - docs públicas /docs/api: renderizadas pelo próprio app (sem CDN; o Scalar saiu no redesenho de 13/10);
//   - Supabase (REST, realtime em wss, storage público de avatares/áudio/vídeo): https://*.supabase.co e wss://*.supabase.co;
//   - Meta/WhatsApp/OpenAI/ElevenLabs/WAHA/DDM NÃO são chamados pelo navegador (só pelo servidor): ficam de fora de propósito;
//   - mídia do chat e avatares passam pelo próprio servidor (/api/chat-media, /api/whatsapp/*) → 'self'; avatares de contato podem ser
//     https arbitrário → img-src https:;
//   - VoIP pelo proxy /api/calls (mesma origem); gravação de áudio com Worker em /opus + AudioWorklet em /worklets (worker-src 'self' blob:,
//     WebAssembly → 'wasm-unsafe-eval');
//   - iframes: o Extrator de Leads (LEAD_EXTRACTOR_URL, padrão lovable.app) e pré-visualização de arquivo do chat (mesma origem/Supabase);
//   - fontes: next/font/google já é auto-hospedada no build → 'self'.
// 'unsafe-eval' SÓ em desenvolvimento (React/Turbopack dev). Em produção nunca.

/** Origem do Extrator de Leads quando LEAD_EXTRACTOR_URL não está definida (mesmo padrão de /api/whatsapp/external-urls). */
export const DEFAULT_LEAD_EXTRACTOR_URL = "https://grupoddmlead.lovable.app";

/** Endpoint que recebe as violações (POST). */
export const CSP_REPORT_PATH = "/api/security/csp-report";

export interface CspOptions {
  /** Desenvolvimento: libera 'unsafe-eval' e o websocket do HMR. */
  isDev?: boolean;
  /** URL do Extrator de Leads (vira frame-src). */
  leadExtractorUrl?: string | null;
  /** Passo 2: nonce por requisição — troca 'unsafe-inline' por 'nonce-…' + 'strict-dynamic' em script-src. */
  nonce?: string;
  /** Endereço para onde o navegador manda as violações. */
  reportUri?: string | null;
}

/** `https://host[:porta]` de uma URL válida http(s); null se inválida ou de outro esquema. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(options: CspOptions = {}): string {
  const { isDev = false, nonce, reportUri = CSP_REPORT_PATH } = options;
  const leadOrigin = originOf(options.leadExtractorUrl ?? DEFAULT_LEAD_EXTRACTOR_URL);

  const scriptSrc = ["'self'"];
  if (nonce) scriptSrc.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  else scriptSrc.push("'unsafe-inline'");
  scriptSrc.push("'wasm-unsafe-eval'");
  if (isDev) scriptSrc.push("'unsafe-eval'");

  const connectSrc = ["'self'", "https://*.supabase.co", "wss://*.supabase.co"];
  if (isDev) connectSrc.push("ws://localhost:*", "ws://127.0.0.1:*");

  const frameSrc = ["'self'", "https://*.supabase.co"];
  if (leadOrigin) frameSrc.push(leadOrigin);

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    // atributos style="" de dezenas de componentes e Tailwind: 'unsafe-inline' em estilo segue necessário (o risco de XSS por CSS é baixo)
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["media-src", ["'self'", "blob:", "https://*.supabase.co"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connectSrc],
    ["frame-src", frameSrc],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
  ];
  const parts = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (reportUri) parts.push(`report-uri ${reportUri}`);
  return parts.join("; ");
}
