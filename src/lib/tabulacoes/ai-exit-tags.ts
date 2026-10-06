/**
 * Descrições legíveis em pt-BR das tags de saída da IA conhecidas pelo sistema.
 */
export const AI_EXIT_TAG_DESCRIPTIONS: Record<string, string> = {
  "#ACORDOFORMALIZADO": "Acordo aceito e formalizado pelo cliente",
  "#EQUIPEHUMANA": "Transferência necessária para atendimento humano",
  "#RECUSA": "Cliente recusou a proposta inicial apresentada",
  "#RECUSA_CONFIRMADA": "Cliente confirmou recusa explícita e definitiva da proposta",
  "#RECUPERADO": "Contato ou recuperação realizada com sucesso",
  "#AGENDAMENTO": "Cliente agendou data para retorno ou pagamento",
  "#NAOENVIACPF": "Cliente não enviou ou recusou-se a informar o CPF",
  "#INSTABILIDADE": "Instabilidade momentânea no sistema durante o atendimento",
  "#CLIENTE_PEDIU_HUMANO": "Cliente solicitou expressamente falar com atendente humano",
  "#CPF_NAO_LOCALIZADO": "CPF informado não foi encontrado na base de clientes",
  "#CPF_INVALIDO": "CPF digitado é inválido",
  "#ACORDO_EXISTENTE": "Cliente já possui um acordo vigente ativo",
  "#ERRO_EFETIVACAO": "Falha técnica ao efetivar o acordo no sistema",
  "#CONTESTACAO_DIVIDA": "Cliente contesta o débito ou alega desconhecer a dívida",
  "#FALLBACK_EXAURIDO": "Assistente esgotou tentativas de entendimento sem sucesso",
  "#OPT_OUT": "Cliente solicitou descadastro e não receber mais mensagens",
  "#CONTATO_DIVERGENTE": "Pessoa que atendeu afirma não ser o titular procurado",
  "#NEGOCIACAO": "Cliente em negociação de condições (legado)",
  "#ANIMA": "Fluxo específico de negociação Ânima (legado)",
  "#NAOLOCALIZADO": "Cliente não localizado após tentativas (legado)",
};

/**
 * Retorna a descrição amigável de uma tag de saída da IA em pt-BR.
 */
export function getExitTagDescription(tag: string): string {
  return AI_EXIT_TAG_DESCRIPTIONS[tag] ?? "Tag de encerramento da IA";
}

/**
 * Retorna a lista de tags conhecidas da IA que ainda não foram mapeadas na conta.
 */
export function getAvailableExitTags(
  knownTags: readonly string[],
  currentMappedTags: Iterable<string>
): string[] {
  const mappedSet = new Set(currentMappedTags);
  return knownTags.filter((tag) => !mappedSet.has(tag));
}
