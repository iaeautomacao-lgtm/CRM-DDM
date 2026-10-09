// Texto e regra de confirmação do "Excluir pipeline". A exclusão apaga, em cascata, o funil, as etapas e TODOS os
// negócios dele (não há arquivamento): o aviso precisa dizer exatamente isso, com a contagem real.

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}

/** `deals` = null quando a contagem não pôde ser lida: o aviso continua verdadeiro, sem inventar número. */
export function pipelineDeleteWarning(input: { name: string; stages: number; deals: number | null }): string {
  const stages = plural(input.stages, "etapa", "etapas");
  const deals = input.deals === null ? "todos os negócios dele (não foi possível contar quantos)" : `os ${plural(input.deals, "negócio", "negócios")}`;
  return `Excluir definitivamente o funil “${input.name}”, as ${stages} e ${deals}. Os dados não ficam arquivados e esta ação não pode ser desfeita.`;
}

/** A exclusão só é liberada quando o nome digitado é igual ao do funil (ignorando espaços nas pontas). */
export function canConfirmPipelineDelete(typed: string, name: string): boolean {
  return typed.trim() === name.trim() && name.trim().length > 0;
}
