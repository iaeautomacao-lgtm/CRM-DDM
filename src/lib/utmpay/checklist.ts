// Checklist de status da tela Integrações → Rastreamento (UTMpay) — requisito do dono (15/10): "bater o olho e entender o que fazer".
// O SERVIDOR monta os textos (fonte única do vocabulário; a tela só desenha). Português simples, sem jargão: "chave de acesso", "avisos para o CRM",
// "segredo dos avisos", "código do envio". Cada item tem uma cor (ok = verde, atencao = amarelo, erro = vermelho, pendente = cinza ○), o que
// aconteceu e o que fazer. PURO: nunca recebe nem devolve segredo.
import type { ConnectionState } from "@/lib/utmpay/connect";
import type { UtmpayConfigView } from "@/lib/utmpay/config-api";

export type ChecklistTone = "ok" | "atencao" | "erro" | "pendente";
/** Ação que a tela deve oferecer como botão (ou foco no campo) para resolver o item. */
export type ChecklistAction = "informar_endereco" | "informar_chave" | "informar_segredo" | "conectar" | "ligar" | "salvar" | null;

export interface ChecklistItem {
  id: "endereco" | "chave" | "segredo" | "avisos" | "ligado";
  /** Ex.: "1. Endereço do UTMpay". */
  titulo: string;
  estado: ChecklistTone;
  /** O que está acontecendo, em uma frase. */
  detalhe: string;
  /** O que fazer (vazio quando está tudo certo). */
  acao: string | null;
  acao_id: ChecklistAction;
}

export interface Checklist {
  itens: ChecklistItem[];
  /** Primeira vez (nada configurado): a tela mostra o passo a passo 1 → 2 → 3 em vez do formulário cheio. */
  primeira_vez: boolean;
  /** Id do primeiro item que ainda precisa de ação (null = tudo pronto). */
  proximo_passo: ChecklistItem["id"] | null;
  /** Quantos itens estão verdes e o total (para "4 de 5 prontos"). */
  prontos: number;
  total: number;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function buildChecklist(config: Pick<UtmpayConfigView, "configured" | "enabled" | "base_url" | "has_api_key" | "has_webhook_secret" | "atualizado_em">, connection: ConnectionState | null): Checklist {
  const hasBase = !!config.base_url;
  const saved = formatDate(config.atualizado_em);

  const endereco: ChecklistItem = hasBase
    ? { id: "endereco", titulo: "1. Endereço do UTMpay", estado: "ok", detalhe: config.base_url as string, acao: null, acao_id: null }
    : { id: "endereco", titulo: "1. Endereço do UTMpay", estado: "erro", detalhe: "Ainda não informado.", acao: "Digite o endereço do seu UTMpay. Exemplo: https://utmpay.suaempresa.com.br", acao_id: "informar_endereco" };

  const chave: ChecklistItem = config.has_api_key
    ? { id: "chave", titulo: "2. Chave de acesso", estado: "ok", detalhe: `Configurada${saved ? ` (salva em ${saved})` : ""}. Por segurança ela não aparece de novo.`, acao: null, acao_id: null }
    : { id: "chave", titulo: "2. Chave de acesso", estado: "erro", detalhe: "Ainda não informada.", acao: "Copie a chave de acesso no UTMpay (Configurações) e cole aqui.", acao_id: "informar_chave" };

  const segredo: ChecklistItem = config.has_webhook_secret
    ? { id: "segredo", titulo: "3. Segredo dos avisos", estado: "ok", detalhe: `Configurado${saved ? ` (salvo em ${saved})` : ""}. Por segurança ele não aparece de novo.`, acao: null, acao_id: null }
    : { id: "segredo", titulo: "3. Segredo dos avisos", estado: "erro", detalhe: "Ainda não criado.", acao: "Crie um texto longo e difícil de adivinhar. Ele protege os avisos que o UTMpay manda para o CRM.", acao_id: "informar_segredo" };

  const ready = hasBase && config.has_api_key && config.has_webhook_secret;
  let avisos: ChecklistItem;
  if (!ready) {
    avisos = { id: "avisos", titulo: "4. UTMpay mandando avisos para o CRM", estado: "pendente", detalhe: "Vem depois dos passos 1 a 3.", acao: null, acao_id: null };
  } else if (!connection) {
    avisos = { id: "avisos", titulo: "4. UTMpay mandando avisos para o CRM", estado: "pendente", detalhe: "Ainda não verificado.", acao: "Clique em Conectar para o UTMpay passar a avisar o CRM.", acao_id: "conectar" };
  } else if (connection.estado === "conectado") {
    avisos = { id: "avisos", titulo: "4. UTMpay mandando avisos para o CRM", estado: "ok", detalhe: connection.mensagem, acao: null, acao_id: null };
  } else if (connection.estado === "divergente") {
    avisos = { id: "avisos", titulo: "4. UTMpay mandando avisos para o CRM", estado: "atencao", detalhe: connection.mensagem, acao: "Clique em Conectar para corrigir o endereço dos avisos.", acao_id: "conectar" };
  } else if (connection.estado === "erro") {
    avisos = { id: "avisos", titulo: "4. UTMpay mandando avisos para o CRM", estado: "erro", detalhe: connection.mensagem, acao: "Confira o endereço e a chave de acesso e clique em Conectar.", acao_id: "conectar" };
  } else {
    avisos = { id: "avisos", titulo: "4. UTMpay mandando avisos para o CRM", estado: "erro", detalhe: connection.mensagem, acao: "Clique em Conectar.", acao_id: "conectar" };
  }

  const ligado: ChecklistItem = config.enabled
    ? { id: "ligado", titulo: "5. Rastreamento ligado", estado: "ok", detalhe: "Todo disparo sai com link rastreado.", acao: null, acao_id: null }
    : { id: "ligado", titulo: "5. Rastreamento ligado", estado: "pendente", detalhe: "Desligado: os disparos saem sem rastreio.", acao: "Ligue quando quiser começar a rastrear.", acao_id: "ligar" };

  const itens = [endereco, chave, segredo, avisos, ligado];
  const next = itens.find((i) => i.estado === "erro" || i.estado === "atencao") ?? itens.find((i) => i.estado === "pendente" && i.acao_id !== null) ?? null;
  return {
    itens,
    primeira_vez: !config.configured,
    proximo_passo: next ? next.id : null,
    prontos: itens.filter((i) => i.estado === "ok").length,
    total: itens.length,
  };
}
