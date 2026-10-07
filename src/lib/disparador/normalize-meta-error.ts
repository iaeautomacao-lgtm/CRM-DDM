import { lookupMetaError } from "./meta-error-catalog";

// Extraído de src/app/(dashboard)/disparador/page.tsx (era local àquele
// componente) para ser reaproveitado também no relatório de Envio em Lote
// (src/app/(dashboard)/relatorios/envio-em-lote/page.tsx) — mesmo texto
// cru de erro (disp_message_queue.erro), mesma tradução pro usuário nos
// dois lugares.
export function normalizarErroMeta(erro: string | null | undefined): string {
  if (!erro) return "Falha desconhecida";

  const codigo = extrairCodigoMetaErro(erro);
  // Texto em português vem do catálogo único (meta-error-catalog.ts).
  const entry = lookupMetaError(codigo);
  if (entry) return entry.significado;

  // Erros não-Meta (ex: "WhatsApp WAHA connection is not active") e códigos fora do catálogo.
  return erro;
}

// Código Meta cru extraído do texto de erro (mesma regex de
// normalizarErroMeta) — usado pelo filtro "Tipo de erro" do relatório de
// Envio em Lote pra classificar itens sem duplicar a regex.
export function extrairCodigoMetaErro(erro: string | null | undefined): number | null {
  if (!erro) return null;
  const match = erro.match(/code (\d+)/) ?? erro.match(/\(#(\d+)\)/);
  return match ? parseInt(match[1], 10) : null;
}

// Classificação curta de "tipo de erro" para a coluna correspondente no
// drilldown de métricas do Disparador (campanhas/page.tsx). Mais grosseira
// que normalizarErroMeta — não tenta cobrir todo código Meta, só os casos
// pedidos + um fallback "Outro" pra qualquer coisa não reconhecida.
export function classificarTipoErro(erro: string | null | undefined): string {
  if (!erro) return "Outro";

  const codigo = extrairCodigoMetaErro(erro);
  if (codigo === 131008) return "Variável vazia";
  if (codigo === 131026 || codigo === 131047) return "Janela 24h";
  if (/^Variável \{\{\d+\}\} vazia|sem valor mapeado/.test(erro)) return "Variável vazia";
  if (/timeout/i.test(erro)) return "Timeout";
  if (erro.includes("Canal não encontrado")) return "Canal offline";
  return "Outro";
}
