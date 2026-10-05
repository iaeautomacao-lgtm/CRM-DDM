// Checagem de variáveis vazias no enfileiramento da campanha
// (startCampaign). Os dois caminhos continuam separados:
//   - Meta: valores vão como template_variables; a Meta substitui.
//   - WAHA: o texto já chega com {{n}} trocado no código.
// Em ambos, valor vazio (CSV sem a coluna, contato sem nome, UTM não
// gerado) ou {{n}} sem fonte não deve chegar ao cliente.

/** Meta: primeira variável vazia, ou null se todas têm valor. */
export function describeEmptyTemplateVar(values: string[]): string | null {
  const idx = values.findIndex((v) => !String(v ?? "").trim());
  if (idx < 0) return null;
  return `Variável {{${idx + 1}}} vazia para este contato — não enviado`;
}

/**
 * WAHA: `emptyVar` = primeira variável usada no texto que saiu vazia
 * (calculada na substituição); senão, procura {{n}} que sobrou sem fonte.
 */
export function describeUnresolvedPlaceholder(
  resolvedText: string,
  emptyVar: number | null,
): string | null {
  if (emptyVar !== null) return `Variável {{${emptyVar}}} vazia para este contato — não enviado`;
  const leftover = resolvedText.match(/\{\{(\d+)\}\}/);
  if (leftover) return `Variável {{${leftover[1]}}} sem valor mapeado — não enviado`;
  return null;
}
