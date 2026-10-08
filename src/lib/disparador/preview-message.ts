// Prévia e validação de variáveis das mensagens de campanha, usadas pelo
// assistente de criação (campanhas/page.tsx). Funções puras, sem I/O.
//
// Espelham o que startCampaign.ts faz no enfileiramento — os dois caminhos
// continuam separados:
//   - Meta (canal oficial + template aprovado): os valores de
//     template_variable_map viram o array template_variables e a própria
//     Meta substitui {{1}}, {{2}}... no corpo. QUALQUER variável vazia
//     derruba o contato (describeEmptyTemplateVar).
//   - Texto livre (WAHA, ou Meta sem template): {{n}} é trocado no código
//     pelo valor do mapa; {{n}} usado no texto que sai vazio, ou sem fonte,
//     derruba o contato (describeUnresolvedPlaceholder). {{nome}},
//     {{primeiro_nome}}, {{empresa}} e {{data_hoje}} são resolvidos no envio
//     (applyTemplateVars) e nunca bloqueiam.

import type { ImportColumnMap } from "./import-mapping";

export type VariableSource =
  | { type: "contact_field"; field: "name" | "phone" | "company" | "cpf" }
  | { type: "static"; value: string }
  | { type: "utm_link" }
  | { type: "csv_var"; index: 0 | 1 | 2 };

export interface PreviewableMessage {
  tipo?: string;
  conteudo?: string | null;
  prompt?: string | null;
  template_name?: string | null;
  template_variable_map?: VariableSource[] | null;
}

/**
 * Dados de um contato para a prévia. `undefined` = valor só conhecido no
 * envio (ex: nome do cadastro, link UTM gerado no servidor) — aparece como
 * "preenchido no envio", nunca como vazio. `null`/"" = sabidamente vazio.
 */
export interface PreviewContact {
  name?: string | null;
  phone?: string | null;
  company?: string | null;
  cpf?: string | null;
  /** VAR1..VAR3 da linha do CSV; undefined = sem CSV nesta sessão. */
  csvVars?: readonly (string | null | undefined)[];
  utmLink?: string | null;
}

export type PreviewSegment =
  | { kind: "text"; text: string }
  | {
      kind: "var";
      /** Rótulo do placeholder, ex: "{{2}}" ou "{{nome}}". */
      token: string;
      value: string;
      /** Sairia vazio — o backend não envia para este contato (só {{n}}). */
      empty: boolean;
      /** Valor só conhecido no envio. */
      pending: boolean;
      /** Descrição da fonte, usada quando `pending`. */
      label: string;
    };

export interface MessagePreview {
  /** "template" = Meta faz a substituição; "texto" = substituído no código. */
  mode: "template" | "texto";
  segments: PreviewSegment[];
  /** Números das variáveis {{n}} que sairiam vazias para este contato. */
  emptyVars: number[];
  /** true quando o backend marcaria este contato como erro (não enviado). */
  willSkip: boolean;
}

// Template Meta: a Meta resolve {{ 1 }} também.
const NUMERIC_PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;
// Texto livre: o envio (startCampaign) só troca {{N}} exato — "{{ 1 }}" vai
// literal, então a prévia também não o trata como variável.
const STRICT_NUMERIC = /\{\{(\d+)\}\}/g;
const ANY_PLACEHOLDER = /\{\{(\d+)\}\}|\{\{\s*(nome|primeiro_nome|empresa|data_hoje)\s*\}\}/gi;
const SPACED_NUMERIC = /\{\{\s+\d+\s*\}\}|\{\{\s*\d+\s+\}\}/;

/** {{n}} distintos usados no texto, em ordem crescente. */
export function placeholderNumbers(text: string | null | undefined): number[] {
  const found = new Set<number>();
  for (const m of (text ?? "").matchAll(STRICT_NUMERIC)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * Mesma síntese que handleSubmit sempre fez para texto livre com {{n}}
 * digitado à mão (sem template e sem mapa): {{1}}..{{3}} apontam para as
 * colunas VAR1..VAR3 mapeadas no CSV; coluna não mapeada vira valor fixo
 * vazio. Devolve a própria mensagem quando não se aplica.
 */
export function synthesizeWahaVariableMap<T extends PreviewableMessage>(
  msg: T,
  columnMap: ImportColumnMap
): T {
  if (msg.template_name || Array.isArray(msg.template_variable_map)) return msg;
  if (!msg.conteudo?.includes("{{")) return msg;
  if (!columnMap.var1 && !columnMap.var2 && !columnMap.var3) return msg;

  const map: VariableSource[] = [
    columnMap.var1 ? { type: "csv_var", index: 0 } : { type: "static", value: "" },
    columnMap.var2 ? { type: "csv_var", index: 1 } : { type: "static", value: "" },
    columnMap.var3 ? { type: "csv_var", index: 2 } : { type: "static", value: "" },
  ];
  return { ...msg, template_variable_map: map };
}

function sourceLabel(entry: VariableSource | undefined): string {
  if (!entry) return "sem fonte";
  switch (entry.type) {
    case "contact_field":
      return entry.field === "name"
        ? "nome do contato"
        : entry.field === "phone"
          ? "telefone"
          : entry.field === "cpf"
            ? "CPF"
            : "empresa";
    case "utm_link":
      return "link UTM do contato";
    case "csv_var":
      return `VAR${entry.index + 1} do CSV`;
    default:
      return "valor fixo";
  }
}

/** Valor de uma fonte para o contato; undefined = só conhecido no envio. */
function resolveSource(entry: VariableSource | undefined, contact: PreviewContact): string | undefined {
  if (!entry) return "";
  switch (entry.type) {
    case "contact_field": {
      const v = contact[entry.field];
      return v === undefined ? undefined : String(v ?? "");
    }
    case "utm_link":
      return contact.utmLink === undefined ? undefined : String(contact.utmLink ?? "");
    case "csv_var":
      return contact.csvVars === undefined ? undefined : String(contact.csvVars[entry.index] ?? "");
    case "static":
      return String(entry.value ?? "");
    default:
      return "";
  }
}

function namedValue(
  key: string,
  contact: PreviewContact,
  today: string
): { value: string | undefined; label: string } {
  const name = contact.name === undefined ? undefined : (contact.name ?? "").trim();
  switch (key) {
    case "nome":
      return { value: name, label: "nome do contato" };
    case "primeiro_nome":
      return { value: name === undefined ? undefined : name.split(/\s+/)[0] ?? "", label: "primeiro nome" };
    case "empresa":
      return {
        value: contact.company === undefined ? undefined : (contact.company ?? "").trim(),
        label: "empresa",
      };
    default:
      return { value: today, label: "data de hoje" };
  }
}

/**
 * Monta a mensagem como o contato vai recebê-la. `isMetaChannel` decide o
 * caminho (igual ao startCampaign: bifurca pelo canal, não pela mensagem).
 * `today` é injetável para os testes.
 */
export function previewCampaignMessage(
  msg: PreviewableMessage,
  contact: PreviewContact,
  opts: { isMetaChannel: boolean; today?: string }
): MessagePreview {
  const today =
    opts.today ?? new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const body = msg.conteudo ?? "";
  const map = Array.isArray(msg.template_variable_map) ? msg.template_variable_map : null;
  const isTemplate = opts.isMetaChannel && !!msg.template_name && map !== null;

  const segments: PreviewSegment[] = [];
  const emptyVars = new Set<number>();
  const pattern = isTemplate ? NUMERIC_PLACEHOLDER : ANY_PLACEHOLDER;
  let last = 0;

  for (const m of body.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: body.slice(last, start) });
    last = start + m[0].length;
    const key = (m[1] ?? m[2] ?? "").toLowerCase();

    if (/^\d+$/.test(key)) {
      const n = Number(key);
      const entry = map?.[n - 1];
      const value = map ? resolveSource(entry, contact) : "";
      const empty = value !== undefined && !value.trim();
      if (empty) emptyVars.add(n);
      segments.push({
        kind: "var",
        token: `{{${n}}}`,
        value: value ?? "",
        empty,
        pending: value === undefined,
        label: sourceLabel(entry),
      });
    } else {
      const { value, label } = namedValue(key, contact, today);
      segments.push({
        kind: "var",
        token: `{{${key}}}`,
        value: value ?? "",
        // Variáveis nomeadas não bloqueiam o envio (applyTemplateVars
        // apenas remove o placeholder).
        empty: false,
        pending: value === undefined,
        label,
      });
    }
  }
  if (last < body.length) segments.push({ kind: "text", text: body.slice(last) });

  // Meta confere TODAS as variáveis do template, mesmo as que não aparecem
  // no corpo (describeEmptyTemplateVar sobre o array inteiro).
  if (isTemplate && map) {
    map.forEach((entry, idx) => {
      const value = resolveSource(entry, contact);
      if (value !== undefined && !value.trim()) emptyVars.add(idx + 1);
    });
  }

  const sortedEmpty = [...emptyVars].sort((a, b) => a - b);
  return {
    mode: isTemplate ? "template" : "texto",
    segments,
    emptyVars: sortedEmpty,
    willSkip: sortedEmpty.length > 0,
  };
}

/**
 * Problemas de mapeamento de variáveis de uma mensagem, antes de salvar:
 * {{n}} usado sem fonte, valor fixo vazio ou coluna VARn do CSV não
 * mapeada. `hasCsv` = há um CSV lido nesta sessão (columnMap confiável);
 * sem ele, csv_var é aceito (a base pode ter sido importada antes, na
 * edição de uma campanha existente).
 */
export function findVariableProblems(
  msg: PreviewableMessage,
  ctx: { columnMap: ImportColumnMap; hasCsv: boolean }
): string[] {
  if (msg.tipo === "ia") return [];
  const effective = synthesizeWahaVariableMap(msg, ctx.columnMap);
  const map = Array.isArray(effective.template_variable_map) ? effective.template_variable_map : null;
  const used = placeholderNumbers(effective.conteudo);
  // Template Meta: todas as entradas do mapa vão para a Meta.
  const toCheck = new Set<number>(used);
  if (effective.template_name && map) map.forEach((_, idx) => toCheck.add(idx + 1));

  const problems: string[] = [];
  if (!effective.template_name && SPACED_NUMERIC.test(effective.conteudo ?? "")) {
    problems.push("Escreva as variáveis sem espaços, como {{1}} — \"{{ 1 }}\" chegaria literal ao cliente.");
  }
  for (const n of [...toCheck].sort((a, b) => a - b)) {
    const entry = map?.[n - 1];
    if (!entry) {
      problems.push(
        map
          ? `{{${n}}} não tem fonte definida.`
          : `{{${n}}} não tem fonte: mapeie a coluna VAR${n} do CSV no passo Origem.`
      );
      continue;
    }
    if (entry.type === "static" && !String(entry.value ?? "").trim()) {
      problems.push(
        effective.template_name
          ? `{{${n}}} está como valor fixo vazio — preencha o valor ou escolha outra fonte.`
          : `{{${n}}} não tem fonte: mapeie a coluna VAR${n} do CSV no passo Origem.`
      );
      continue;
    }
    if (entry.type === "csv_var" && ctx.hasCsv) {
      const key = (["var1", "var2", "var3"] as const)[entry.index];
      if (!ctx.columnMap[key]) {
        problems.push(`{{${n}}} usa a VAR${entry.index + 1} do CSV, mas essa coluna não foi mapeada no passo Origem.`);
      }
    }
  }
  return problems;
}
