// PRD 14, 14.7 — logs sem PII. Varre todo `console.(log|info|warn|error)` de src/** (menos testes) e reprova a interpolação/passagem de
// variável com nome de dado pessoal (cpf, phone, telefone, email, resText, body…) sem passar por um mascarador de src/lib/privacy/mask.ts.
// Código de navegador ("use client") fica de fora: o console de lá é do próprio usuário, não log de servidor.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import * as logger from "../logger";
import { maskCpfForLog, maskEmailForLog, maskPhone, maskPhoneForLog, maskTextForLog, maskUrlForLog, safeDbError } from "./mask";

const ROOT = process.cwd();

// Nome que indica dado pessoal ou corpo de resposta de parceiro (pode trazer CPF/nome/telefone).
const PII_NAME = /\b[\w$]*(?:cpf|cnpj|phone|telefone|email|restext|wa_?id)[\w$]*\b|\bbody\b|\bresponseText\b|\braw(?:Body|Text)\b/i;

/**
 * Exceções explícitas (curtas): `arquivo:trecho` que NÃO é dado pessoal apesar do nome. Cada uma com o motivo.
 * Manter curta — o caminho certo é mascarar, não listar aqui.
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  { file: "app/api/v1/disparador/campaigns/route.ts", contains: "body.channel", why: "id (uuid) do canal pedido na API, não dado pessoal" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Argumentos de cada console.x( ... ) com balanceamento de parênteses, respeitando strings e templates. */
export function consoleCalls(source: string): { line: number; args: string }[] {
  const calls: { line: number; args: string }[] = [];
  const re = /console\.(?:log|info|warn|error)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    let quote: string | null = null;
    const tpl: number[] = []; // profundidade de `${` abertos dentro de template
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (quote === "`" && c === "$" && source[i + 1] === "{") {
          tpl.push(depth);
          depth++;
          i++;
          quote = null;
        } else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "}") {
        depth--;
        if (tpl.length && tpl[tpl.length - 1] === depth) {
          tpl.pop();
          quote = "`";
        }
      }
    }
    calls.push({ line: source.slice(0, m.index).split("\n").length, args: source.slice(start, i - 1) });
  }
  return calls;
}

/** Remove o texto fixo das strings (só o que é variável interessa) e o que já passa por um mascarador. */
export function riskyExpression(args: string): string | null {
  const code = args
    .replace(/`(?:\\.|[^`\\$]|\$(?!\{))*`/g, "``") // template sem interpolação
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""') // strings simples
    .replace(/`((?:\\.|[^`\\])*)`/g, (_m, inner: string) => (inner.match(/\$\{[^}]*\}/g) ?? []).join(" ")) // só as interpolações
    .replace(/\b(?:mask|safe)\w*\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "") // maskCpfForLog(cpf), maskPhoneForLog(x.phone), safeDbError(e) …
    .replace(/[\w$.?]+\.length\b/g, "") // tamanho não é dado pessoal
    .replace(/\bphone_?number_?id\b/gi, "") // id do número da EMPRESA na Meta, não telefone de pessoa
    .replace(/\b(?:typeof|instanceof)\s+[\w$.]+/g, "");
  const m = PII_NAME.exec(code);
  if (m) return m[0];
  // Corpo inteiro de resposta (parceiro/Meta/IA) ou objeto serializado: pode trazer CPF, nome e telefone que regex nenhuma pega.
  const dump = /JSON\.stringify\s*\(|\.(?:text|json)\s*\(\s*\)/.exec(code);
  return dump ? dump[0] : null;
}

describe("console.* sem PII (PRD 14.7)", () => {
  it("nenhum console.(log|info|warn|error) de servidor interpola cpf/phone/telefone/email/body sem mascarar", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source)) continue;
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      for (const call of consoleCalls(source)) {
        const hit = riskyExpression(call.args);
        if (!hit) continue;
        if (ALLOWED.some((a) => rel.endsWith(a.file) && call.args.includes(a.contains))) continue;
        offenders.push(`${rel}:${call.line} → ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a exceção explícita é curta e justificada", () => {
    expect(ALLOWED.length).toBeLessThanOrEqual(5);
    for (const a of ALLOWED) expect(a.why.length).toBeGreaterThan(10);
  });
});

describe("o scanner (para não virar teste que aprova tudo)", () => {
  it("pega variável PII crua, em template e em argumento solto", () => {
    expect(riskyExpression("`[x] cpf ${cpf}`")).toBe("cpf");
    expect(riskyExpression('"[x] resposta", resText')).toBe("resText");
    expect(riskyExpression("`[x] ${contact.phone}`")).toBe("phone");
    expect(riskyExpression('"[x] falha", email')).toBe("email");
    expect(riskyExpression('"[x]", body')).toBe("body");
    expect(riskyExpression('"[x] falhou:", await res.text()')).toBe(".text()");
    expect(riskyExpression('"[x]", JSON.stringify(row)')).toBe("JSON.stringify(");
  });

  it("não acusa texto fixo, tamanho nem valor mascarado", () => {
    expect(riskyExpression('"[x] falha ao buscar telefone do contato"')).toBeNull();
    expect(riskyExpression("`[x] bytes=${resText.length}`")).toBeNull();
    expect(riskyExpression("`[x] ${maskCpfForLog(cpf)}`")).toBeNull();
    expect(riskyExpression("`[x] ${maskPhoneForLog(contact.phone)}`")).toBeNull();
    expect(riskyExpression('"[x]", maskEmailForLog(email)')).toBeNull();
    expect(riskyExpression('"[x] falhou:", maskTextForLog(await res.text())')).toBeNull();
    expect(riskyExpression('"[x] canal", phoneNumberId')).toBeNull();
    expect(riskyExpression('"[x]", safeDbError(cpfError)')).toBeNull();
  });

  it("consoleCalls acha chamadas multilinha e com template aninhado", () => {
    const calls = consoleCalls("console.error(\n  `a ${f(`b ${c}`)}`,\n  err,\n);\nfoo();\nconsole.log('x')");
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain("err");
  });
});

describe("mascaradores de log", () => {
  it("telefone: só os 4 últimos dígitos (mesma regra do logger.maskPhone)", () => {
    expect(maskPhoneForLog("+55 (21) 99999-1234")).toBe("****1234");
    expect(maskPhoneForLog("")).toBe("****");
    expect(maskPhone("")).toBeNull();
    expect(logger.maskPhone).toBe(maskPhone);
  });
  it("erro do banco: só code e message, sem details/hint (que trazem o valor da chave)", () => {
    const out = safeDbError({ code: "23505", message: "duplicate key", details: "Key (phone)=(5511999998888) already exists.", hint: "x" });
    expect(out).toEqual({ code: "23505", message: "duplicate key" });
    expect(JSON.stringify(out)).not.toContain("5511");
    expect(safeDbError(new Error("falhou 123.456.789-01")).message).toBe("falhou ***.***.***-01");
  });
  it("e-mail: some o usuário, mantém o domínio", () => {
    expect(maskEmailForLog("maria.silva@ddm.com.br")).toBe("m***@ddm.com.br");
    expect(maskEmailForLog("sem-arroba")).toBe("***");
  });
  it("texto livre: CPF mascarado e corte em tamanho", () => {
    expect(maskTextForLog("devedor 123.456.789-01 ok")).toBe("devedor ***.***.***-01 ok");
    expect(maskTextForLog("a".repeat(500), 20)).toHaveLength(21);
  });
  it("URL: sem query string nem credenciais", () => {
    expect(maskUrlForLog("https://user:senha@cliente.com.br/hook?token=abc#x")).toBe("https://cliente.com.br/hook");
    expect(maskUrlForLog("não é url")).toBe("***");
  });
  it("CPF segue igual", () => {
    expect(maskCpfForLog("12345678901")).toBe("***01");
  });
});
