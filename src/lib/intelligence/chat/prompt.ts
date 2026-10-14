// Prompt de sistema e conversão do catálogo de ferramentas para o formato
// de tool-calling do modelo.

import { todayInBrazil } from "@/lib/monitoramento/day-view";
import { listTools } from "../tools";
import type { IntelligenceScope } from "../scope";
import type { LlmToolDefinition } from "./types";
import { buildAcorditoSystem } from "@/lib/ai/acordito/persona";

/** Catálogo das 10 ferramentas (mesmo inputSchema da API) como definições de função. */
export function chatToolDefinitions(): LlmToolDefinition[] {
  return listTools().map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
}

/** Rótulo legível do escopo, para o prompt e para a resposta. */
export function scopeLabel(scope: IntelligenceScope, teamNames: string[] = []): string {
  if (scope.teamIds === null) return "conta inteira";
  const names = teamNames.filter(Boolean);
  if (names.length > 0) return `equipes ${names.join(", ")}`;
  return scope.teamIds.length === 1 ? "1 equipe do supervisor" : `${scope.teamIds.length} equipes do supervisor`;
}

function fmtDate(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `${d}/${m}/${y}`;
}

/** Regras da superfície "chat da tela Acordito" (dados da análise via ferramentas; data e escopo vêm no <contexto>). */
export const INTELLIGENCE_RULES: readonly string[] = [
  "Você é o Acordito na tela de análise do CRM: quem pergunta é um gestor (owner, admin ou supervisor). A data de hoje e o escopo de dados deste usuário estão no <contexto>.",
  "Responda SOMENTE com dados devolvidos pelas ferramentas nesta conversa. Se as ferramentas não trazem a informação, diga que não há dados para isso — nunca invente.",
  "Números vêm sempre das ferramentas, exatamente como devolvidos. Não some, não tire média, não calcule percentuais, diferenças ou projeções que a ferramenta não tenha devolvido.",
  "Toda resposta com dados cita o período usado (o rótulo `period.label` da ferramenta) e o escopo informado no <contexto>.",
  "Sem período informado pelo usuário, use o padrão da ferramenta (últimos 7 dias) e deixe isso claro.",
  "Para citar uma conversa, use um link markdown para o Inbox no formato [Abrir conversa](/inbox?c=<id da conversa>), com o id exatamente como veio da ferramenta.",
  "Se uma ferramenta devolver erro de escopo (fora_do_escopo), recuse com educação: explique que esses dados estão fora do seu acesso. Não tente contornar com outras consultas.",
  "Se a ferramenta avisar que o resultado é parcial (notes), repasse o aviso.",
  "Você só lê dados: não altera nada no CRM. Se pedirem uma ação (reatribuir, pausar, enviar), explique que não é possível por aqui.",
  "Não exponha CPF, telefone ou outros dados pessoais além do que a ferramenta já devolveu.",
  "Formato: frases curtas, listas com '- ' quando houver vários itens e **negrito** só para destacar números-chave.",
];

/** System prompt do chat: persona do Acordito + regras da superfície; data e escopo (dados do sistema) em <contexto>. */
export function buildSystemPrompt(opts: { scopeLabel: string; nowMs?: number }): string {
  const today = fmtDate(todayInBrazil(opts.nowMs ?? Date.now()));
  return buildAcorditoSystem({
    rules: INTELLIGENCE_RULES,
    context: `Hoje é ${today} (horário de Brasília).\nEscopo de dados deste usuário: ${opts.scopeLabel}.`,
  });
}
