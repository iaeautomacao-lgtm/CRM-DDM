// Extraído de src/app/(dashboard)/disparador/page.tsx (era local àquele
// componente) para ser reaproveitado também no relatório de Envio em Lote
// (src/app/(dashboard)/relatorios/envio-em-lote/page.tsx) — mesmo texto
// cru de erro (disp_message_queue.erro), mesma tradução pro usuário nos
// dois lugares.
export function normalizarErroMeta(erro: string | null | undefined): string {
  if (!erro) return "Falha desconhecida";

  const codigoMatch = erro.match(/code (\d+)/);
  const codigo = codigoMatch ? parseInt(codigoMatch[1]) : null;

  const mensagens: Record<number, string> = {
    // Elegibilidade e pagamento
    131042: "Pendência de pagamento na conta Meta. Verifique o faturamento no Meta Business Manager.",
    131031: "Conta do WhatsApp Business bloqueada pela Meta.",
    131053: "Limite de envio do tier atingido. Aguarde ou solicite aumento de tier.",

    // Janela e template
    131026: "Janela de 24h encerrada. Use um template aprovado para este contato.",
    132000: "Template não encontrado. Verifique o nome do template.",
    132001: "Template pausado ou desativado pela Meta.",
    132005: "Tradução do template não aprovada pela Meta.",
    132007: "Template com conteúdo que viola as políticas da Meta.",
    132012: "Parâmetros do template excedem o limite permitido.",

    // Parâmetros e formato
    131008: "Parâmetro obrigatório ausente. Verifique as variáveis do template.",
    131051: "Tipo de mensagem não suportado para este número.",
    131052: "Mídia inválida ou inacessível. Verifique a URL da mídia.",

    // Número do destinatário
    131030: "Número de telefone inválido ou não registrado no WhatsApp.",
    131045: "Número de telefone não registrado no WhatsApp Business.",
    131047: "Mensagem não entregue. O número pode estar inválido ou bloqueado.",
    131021: "Remetente e destinatário são o mesmo número.",
    131048: "Muitas mensagens enviadas para este número. Aguarde antes de tentar novamente.",
    131049: "Número do remetente não registrado no WhatsApp Business.",

    // Erros de sistema Meta
    131500: "Erro interno da Meta. Tente novamente em alguns minutos.",
    131501: "Serviço da Meta temporariamente indisponível. Tente novamente.",
    131000: "Erro genérico da Meta. Tente novamente.",
    1: "Erro desconhecido da Meta. Verifique o Meta Business Manager.",
  };

  if (codigo && mensagens[codigo]) {
    return mensagens[codigo];
  }

  // Erros não-Meta (ex: "WhatsApp WAHA connection is not active")
  return erro;
}

// Código Meta cru extraído do texto de erro (mesma regex de
// normalizarErroMeta) — usado pelo filtro "Tipo de erro" do relatório de
// Envio em Lote pra classificar itens sem duplicar a regex.
export function extrairCodigoMetaErro(erro: string | null | undefined): number | null {
  if (!erro) return null;
  const match = erro.match(/code (\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
