// Catálogo ÚNICO de erros da Meta (código → classe, significado, ação e como o motor reage).
//
// Antes havia 4 listas que discordavam entre si:
//   - normalize-meta-error.ts  (texto para o usuário; vários textos errados)
//   - processQueue.ts          (META_PERMANENT_CODES / META_INVALID_PHONE_CODES: retenta ou não)
//   - provider-signals.ts      (META_RATE_LIMIT_CODES: freio/cooldown do número)
//   - auto-pause.ts            (AUTO_PAUSE_META_CODES: pausa automática da campanha)
//   - desempenho.ts            (RATE_LIMIT_ERROR_CODES do painel)
// Agora todas DERIVAM daqui (metaCodesWhere): mudar o comportamento de um código é editar UMA linha.
//
// REGRA DESTE ARQUIVO: as flags reproduzem EXATAMENTE o comportamento anterior à criação do catálogo
// (retry/pausa/freio), exceto o que o dono já decidiu (#131: 8 códigos de campanha contam na pausa
// automática). Código fora do catálogo = classe "desconhecido" e comportamento atual (nenhuma flag),
// com aviso "código novo" no log (reportUnknownMetaCode).
//
// Textos marcados `validar: true` vêm da doc pública da Meta de memória do time e devem ser conferidos
// na documentação vigente (a Meta renomeia/atualiza códigos).

export type MetaErrorClass =
  | "destinatario" // problema do contato: não insistir
  | "campanha_template" // template/parâmetros/mídia: corrigir a campanha
  | "canal_conta" // token, pagamento, bloqueio, registro do número
  | "limite" // limite de taxa/qualidade: reduzir o ritmo
  | "transitorio" // erro interno da Meta: tentar de novo
  | "janela24h" // fora da janela de 24 h: exige template
  | "desconhecido";

export interface MetaErrorEntry {
  code: number;
  classe: MetaErrorClass;
  /** Texto em português do que significa (é o que o operador vê no lugar do texto cru). */
  significado: string;
  /** O que fazer. */
  acao: string;
  /** Rejeição definitiva sem retry (antes: META_PERMANENT_CODES). */
  permanente?: boolean;
  /** Número inválido/sem WhatsApp: vai para a escada de telefones (antes: META_INVALID_PHONE_CODES). */
  numeroInvalido?: boolean;
  /** Sinal de limite de taxa: freio/cooldown do número (antes: META_RATE_LIMIT_CODES). */
  freio?: boolean;
  /** Conta para a pausa automática da campanha (antes: AUTO_PAUSE_META_CODES). */
  pausaAutomatica?: boolean;
  /** Significado/ação a conferir na documentação vigente da Meta. */
  validar?: boolean;
}

export const META_ERROR_CATALOG: readonly MetaErrorEntry[] = [
  // ── Janela de 24 h e entrega ────────────────────────────────────────────
  {
    code: 131026,
    classe: "destinatario",
    significado:
      "Mensagem não entregável: a Meta aceitou o envio, mas não conseguiu entregar (número sem WhatsApp, aplicativo desatualizado, aparelho desligado ou termos não aceitos). Se chegar a confirmação de entrega depois, era falso positivo.",
    acao: "Não reenviar. O sistema espera a janela de confirmação (24 h) antes de tratar como erro definitivo; revise a base de contatos.",
    permanente: true,
  },
  {
    code: 131047,
    classe: "janela24h",
    significado: "Fora da janela de 24h: o contato não respondeu nas últimas 24h. Use um template aprovado.",
    acao: "Use um template aprovado (a janela de 24 h só permite texto livre depois de uma resposta do cliente).",
    permanente: true,
    pausaAutomatica: true,
  },
  {
    code: 131049,
    classe: "destinatario",
    significado:
      "A Meta decidiu não entregar esta mensagem para manter o ecossistema saudável (limite de mensagens de marketing por usuário ou baixo engajamento do contato).",
    acao: "Não insista no mesmo contato: espace as campanhas, reduza marketing para quem não interage e prefira a categoria Utility para cobrança/lembrete.",
    validar: true,
  },
  {
    code: 131050,
    classe: "destinatario",
    significado: "O contato optou por não receber mensagens de marketing deste número.",
    acao: "Não enviar marketing a este contato (considere opt-out).",
    validar: true,
  },
  {
    code: 130472,
    classe: "destinatario",
    significado: "O número do contato faz parte de um experimento da Meta e não recebeu a mensagem.",
    acao: "Nenhuma ação: não é falha do envio.",
    validar: true,
  },

  // ── Limites de taxa e qualidade (freio do número) ───────────────────────
  {
    code: 131056,
    classe: "limite",
    significado:
      "Limite por par remetente/destinatário: mensagens muito próximas para o mesmo contato. O intervalo entre mensagens da mesma sequência é de 7 s para evitar isso.",
    acao: "Aumente o intervalo entre mensagens ao mesmo contato; o número entra em cooldown automático.",
    freio: true,
  },
  {
    code: 131048,
    classe: "limite",
    significado: "Muitas mensagens enviadas para este número. Aguarde antes de tentar novamente.",
    acao: "Pause/reduza o ritmo, revise template e lista e confira a qualidade do número.",
    freio: true,
  },
  {
    code: 130429,
    classe: "limite",
    significado: "Limite de vazão (mensagens por segundo) da API excedido para este número.",
    acao: "Reduza as vagas simultâneas do número; aguarde o cooldown.",
    freio: true,
    validar: true,
  },
  {
    code: 80007,
    classe: "limite",
    significado: "Limite de taxa da conta WhatsApp Business (WABA) excedido.",
    acao: "Reduza o ritmo global e revise os outros números da mesma conta.",
    freio: true,
    validar: true,
  },
  {
    code: 4,
    classe: "limite",
    significado: "Limite de chamadas do aplicativo Meta excedido.",
    acao: "Reduza a concorrência global do disparador.",
    freio: true,
    validar: true,
  },

  // ── Template, parâmetros e mídia ────────────────────────────────────────
  {
    code: 131008,
    classe: "campanha_template",
    significado: "Parâmetro obrigatório ausente. Verifique as variáveis do template.",
    acao: "Corrija o mapeamento/dados das variáveis do template (a validação prévia aponta variáveis vazias).",
    permanente: true,
    pausaAutomatica: true,
  },
  {
    code: 131009,
    classe: "campanha_template",
    significado: "Valor de parâmetro inválido. Verifique o formato das variáveis do template.",
    acao: "Corrija o formato do valor da variável (ex.: limites de tamanho, quebras de linha).",
    permanente: true,
    pausaAutomatica: true,
  },
  {
    code: 131051,
    classe: "campanha_template",
    significado: "Tipo de mensagem não suportado para este número.",
    acao: "Revise o tipo de mensagem/mídia da campanha.",
    permanente: true,
    pausaAutomatica: true,
  },
  {
    code: 131052,
    classe: "campanha_template",
    significado: "Mídia inválida ou inacessível. Verifique a URL da mídia.",
    acao: "Corrija a URL/arquivo de mídia.",
  },
  {
    code: 131053,
    classe: "campanha_template",
    significado: "Falha ao baixar ou enviar a mídia (arquivo inacessível, tipo ou tamanho não suportado).",
    acao: "Valide a URL, o tipo e o tamanho do arquivo de mídia e reenvie.",
    validar: true,
  },
  {
    code: 132000,
    classe: "campanha_template",
    significado: "O número de parâmetros enviados é diferente do esperado pelo template. Revise as variáveis da campanha.",
    acao: "Revise o template e o mapeamento de variáveis; a pausa automática age se ≥ 30% falharem.",
    permanente: true,
    pausaAutomatica: true,
  },
  {
    code: 132001,
    classe: "campanha_template",
    significado: "Template inexistente para este nome e idioma. Confira o nome e o idioma aprovados na Meta.",
    acao: "Confira o nome e o idioma do template aprovado.",
    permanente: true,
    pausaAutomatica: true,
  },
  {
    code: 132005,
    classe: "campanha_template",
    significado: "Tradução do template não aprovada pela Meta (ou texto traduzido longo demais).",
    acao: "Corrija/reaprove o template no idioma usado.",
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 132007,
    classe: "campanha_template",
    significado: "Template com conteúdo que viola as políticas de formato da Meta.",
    acao: "Reescreva o template conforme as políticas.",
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 132012,
    classe: "campanha_template",
    significado: "Formato do parâmetro do template inválido (excede o permitido).",
    acao: "Corrija o formato/tamanho da variável.",
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 132015,
    classe: "campanha_template",
    significado: "Template pausado pela Meta (baixa qualidade).",
    acao: "Recrie ou reaprove o template; a pausa automática protege a campanha.",
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 132016,
    classe: "campanha_template",
    significado: "Template desativado pela Meta.",
    acao: "Recrie o template e troque na campanha.",
    pausaAutomatica: true,
    validar: true,
  },

  // ── Canal e conta ───────────────────────────────────────────────────────
  {
    code: 131042,
    classe: "canal_conta",
    significado: "Pendência de pagamento na conta Meta. Verifique o faturamento no Meta Business Manager.",
    acao: "Regularize o faturamento e retome a campanha.",
    pausaAutomatica: true,
  },
  {
    code: 131031,
    classe: "canal_conta",
    significado: "Conta do WhatsApp Business bloqueada pela Meta.",
    acao: "Escale ao responsável pela conta Meta e pause as campanhas do canal.",
    permanente: true,
    pausaAutomatica: true,
  },
  {
    code: 131005,
    classe: "canal_conta",
    significado: "Acesso negado: o token não tem permissão para esta operação.",
    acao: "Revise as permissões do token do canal.",
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 133010,
    classe: "canal_conta",
    significado: "Número remetente não registrado na Cloud API.",
    acao: "Registre o número do canal.",
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 133005,
    classe: "canal_conta",
    significado: "Falha na verificação em duas etapas (PIN) ao registrar o número. Também aparece quando o número já está registrado neste app.",
    acao: "Confira o PIN de verificação em duas etapas do número ao registrar o canal.",
    validar: true,
  },
  {
    code: 190,
    classe: "canal_conta",
    significado: "Token de acesso expirado ou inválido.",
    acao: "Reconecte o canal (renovar o token).",
    permanente: true,
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 368,
    classe: "canal_conta",
    significado: "Bloqueio temporário da conta por violação de política.",
    acao: "Pause as campanhas do canal e revise as políticas da Meta.",
    permanente: true,
    pausaAutomatica: true,
    validar: true,
  },
  {
    code: 131045,
    classe: "canal_conta",
    significado:
      "Falha de certificado/registro do número REMETENTE (o número do canal não está registrado/verificado para envio). Não é problema do contato.",
    acao: "Verifique o registro do número remetente na Meta. (O sistema segue tratando como telefone inválido e tenta o próximo telefone do contato, como antes.)",
    numeroInvalido: true,
    validar: true,
  },

  // ── Número do destinatário ──────────────────────────────────────────────
  {
    code: 131030,
    classe: "destinatario",
    significado: "Número de telefone inválido ou não registrado no WhatsApp.",
    acao: "Marca o telefone como inválido e tenta o próximo da escada (TELEFONE2/3).",
    numeroInvalido: true,
  },
  {
    code: 131021,
    classe: "destinatario",
    significado: "Remetente e destinatário são o mesmo número.",
    acao: "Remova este contato da base.",
    numeroInvalido: true,
  },

  // ── Erros internos da Meta (retentam) ───────────────────────────────────
  { code: 131500, classe: "transitorio", significado: "Erro interno da Meta. Tente novamente em alguns minutos.", acao: "Aguarde: o sistema tenta de novo." },
  { code: 131501, classe: "transitorio", significado: "Serviço da Meta temporariamente indisponível. Tente novamente.", acao: "Aguarde: o sistema tenta de novo." },
  { code: 131000, classe: "transitorio", significado: "Erro genérico da Meta. Tente novamente.", acao: "Aguarde: o sistema tenta de novo." },
  { code: 1, classe: "transitorio", significado: "Erro desconhecido da Meta. Verifique o Meta Business Manager.", acao: "Se persistir, verifique o status da Meta e o Meta Business Manager." },
];

const BY_CODE: ReadonlyMap<number, MetaErrorEntry> = new Map(META_ERROR_CATALOG.map((e) => [e.code, e]));

/** Entrada do catálogo para o código, ou null se for desconhecido. */
export function lookupMetaError(code: number | null | undefined): MetaErrorEntry | null {
  return typeof code === "number" ? (BY_CODE.get(code) ?? null) : null;
}

/** Descrição segura (desconhecido vira classe "desconhecido" sem flags: comportamento atual). */
export function describeMetaError(code: number | null | undefined): MetaErrorEntry {
  return (
    lookupMetaError(code) ?? {
      code: typeof code === "number" ? code : 0,
      classe: "desconhecido",
      significado: "Erro não catalogado da Meta.",
      acao: "Consulte a documentação de erros da Meta; avise o suporte para catalogar este código.",
    }
  );
}

/** Conjunto de códigos que satisfazem o predicado (as listas do motor derivam daqui). */
export function metaCodesWhere(predicate: (entry: MetaErrorEntry) => boolean): Set<number> {
  return new Set(META_ERROR_CATALOG.filter(predicate).map((e) => e.code));
}

// ── "Código novo" ────────────────────────────────────────────────────────
// Código que a Meta devolveu e não está no catálogo: comportamento atual (sem flags) + 1 aviso por
// processo e por código, para alguém catalogar. Nunca lança.
const reportedUnknown = new Set<number>();

export function reportUnknownMetaCode(
  code: number | null | undefined,
  emit: (code: number) => void = (c) => console.warn(`[Disparador] código novo da Meta fora do catálogo: ${c}`),
): boolean {
  if (typeof code !== "number" || lookupMetaError(code) || reportedUnknown.has(code)) return false;
  reportedUnknown.add(code);
  try {
    emit(code);
  } catch {
    /* aviso nunca derruba o envio */
  }
  return true;
}

/** Só para testes. */
export function resetUnknownMetaCodes(): void {
  reportedUnknown.clear();
}
