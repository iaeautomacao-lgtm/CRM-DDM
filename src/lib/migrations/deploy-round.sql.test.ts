import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASELINE_REAL_MIGRATIONS, BASELINE_SQL, USER_SESSIONS_290 } from "./deploy-round.baseline";

// "Rodada de deploy": aplica sobre o schema-base da v2 (deploy-round.baseline.ts) as migrations novas NA ORDEM em que o dono vai
// rodá-las no SQL Editor e confere (a) idempotência (2 execuções), (b) que nenhuma depende de outra que venha depois,
// (c) que os ROLLBACKS do cabeçalho rodam e desfazem o que a migration criou.
//
// Para a rodada seguinte, edite só FULL_ROUND e (se preciso) a baseline. Arquivo ausente na base: a rodada roda só com os que existem e avisa;
// com DEPLOY_ROUND_STRICT=1 (ex.: na branch de integração, com tudo mergeado) ausente vira falha.
// A 310 (MFA obrigatório no RLS) é SEMPRE a última: ela põe a policy mfa_aal2_required nas tabelas que já existem.
const PRE_DEPLOY = [
  "262", "297", "298", "300", "301", "302", "302b", "303", "303b",
  "304", "305",
  "311", "312", "313", "314", "314b", "315", "316b", "317", "318", "319", "320",
  "322", "323", "324", "325", "326", "327", "328", "329",
  "330", "330b", "331b", "333", "334",
  "335", "335b", "336", "337", "338", "339", "340", "345", "346", "347", "348", "349", "350", "352",
  "310",
] as const;
/** Migrations que só rodam DEPOIS do deploy do código (o cabeçalho diz "FAZER O DEPLOY ... depois aplicar"): aplicar antes quebra o código antigo. */
const POST_DEPLOY = ["306", "332", "351"] as const;
export const FULL_ROUND = [...PRE_DEPLOY, ...POST_DEPLOY] as const;

const DIR = "supabase/migrations";
const STRICT = process.env.DEPLOY_ROUND_STRICT === "1";
const files = readdirSync(DIR);
const fileOf = (n: string) => files.find((f) => f.startsWith(`${n}_`) && f.endsWith(".sql"));
const missing = FULL_ROUND.filter((n) => !fileOf(n));
const complete = missing.length === 0;
/** O que esta execução aplica: tudo (STRICT) ou só o que existe na base. */
const ROUND: string[] = STRICT ? [...FULL_ROUND] : FULL_ROUND.filter((n) => fileOf(n));
/** Rollback do cabeçalho só em PROSA (sem comando para rodar): em STRICT (integração) é falha; fora dele só avisa, para não travar bases antigas. */
const isProseRollback = (n: string) => {
  try {
    rollbackOf(n);
    return false;
  } catch {
    return true;
  }
};
const sqlOf = (n: string) => readFileSync(`${DIR}/${fileOf(n)}`, "utf8");

// ---------- utilitários de SQL ----------
const stripComments = (sql: string) => sql.split("\n").map((l) => l.replace(/(^|\s)--.*$/, "$1")).join("\n");

/** Separa comandos por ';' respeitando blocos $$ ... $$. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith("$$", i)) {
      inDollar = !inDollar;
      cur += "$$";
      i++;
      continue;
    }
    if (sql[i] === ";" && !inDollar) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const isConcurrently = (sql: string) => /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql);

/** Roda como o dono: arquivo normal inteiro (tem BEGIN/COMMIT); arquivo CONCURRENTLY comando a comando, fora de transação. */
async function applyFile(db: PGlite, n: string) {
  try {
    await applyFileUnsafe(db, n);
  } catch (e) {
    await db.exec("ROLLBACK").catch(() => undefined); // não deixa a transação aberta contaminar os testes seguintes
    throw e;
  }
}
async function applyFileUnsafe(db: PGlite, n: string) {
  const text = sqlOf(n).replace(/NOTIFY pgrst[^;]*;/g, "");
  if (isConcurrently(text)) {
    for (const stmt of splitStatements(stripComments(text))) await db.exec(stmt);
  } else {
    await db.exec(text);
  }
}

// ---------- o que cada migration cria (análise estática) ----------
interface Created {
  tables: string[];
  functions: string[];
  indexes: string[];
  triggers: string[];
  columns: Array<[string, string]>;
}
function createdBy(n: string): Created {
  const sql = stripComments(sqlOf(n));
  const names = (re: RegExp) => [...new Set([...sql.matchAll(re)].map((m) => m[1].toLowerCase()))];
  const columns: Array<[string, string]> = [];
  for (const stmt of splitStatements(sql)) {
    const t = stmt.match(/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?wacrm\.(\w+)/i);
    if (!t) continue;
    for (const c of stmt.matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)) columns.push([t[1].toLowerCase(), c[1].toLowerCase()]);
  }
  return {
    tables: names(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?wacrm\.(\w+)/gi),
    functions: names(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+wacrm\.(\w+)/gi),
    indexes: names(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+wacrm\./gi),
    triggers: names(/CREATE\s+TRIGGER\s+(\w+)/gi),
    columns,
  };
}

async function exists(db: PGlite, c: Created) {
  const found: string[] = [];
  const q = async (sql: string) => ((await db.query<{ ok: boolean }>(sql)).rows[0]?.ok ?? false);
  for (const t of c.tables) if (await q(`SELECT to_regclass('wacrm.${t}') IS NOT NULL AS ok`)) found.push(`tabela ${t}`);
  for (const f of c.functions)
    if (await q(`SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = '${f}') AS ok`))
      found.push(`função ${f}`);
  for (const i of c.indexes) if (await q(`SELECT to_regclass('wacrm.${i}') IS NOT NULL AS ok`)) found.push(`índice ${i}`);
  for (const t of c.triggers) if (await q(`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${t}') AS ok`)) found.push(`trigger ${t}`);
  for (const [t, col] of c.columns)
    if (await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = '${t}' AND column_name = '${col}') AS ok`))
      found.push(`coluna ${t}.${col}`);
  return found;
}

// ---------- rollback do cabeçalho ----------
const SQL_START = /^(BEGIN|COMMIT|DROP|DELETE|ALTER|DO|UPDATE|CREATE|REVOKE|GRANT|END|FOR|EXECUTE|SELECT)\b|^(AS\s+\$\$|RETURNS\s|LANGUAGE\s|SECURITY\s+(DEFINER|INVOKER)|SET\s+search_path)/i; // 2ª parte: cabeça de CREATE FUNCTION de várias linhas ("AS $$" sem \b: "as" é artigo em prosa)
function rollbackOf(n: string): { statements: string[]; reapply: string[] } {
  const lines = sqlOf(n).split("\n");
  const start = lines.findIndex((l) => /^--\s*ROLLBACK/i.test(l));
  if (start < 0) throw new Error(`migration ${n}: sem linha ROLLBACK no cabeçalho`);
  const raw: string[] = [lines[start].replace(/^--\s*ROLLBACK[^:]*:/i, "")];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("--")) break;
    if (/^--\s*={5,}/.test(l) || /^--\s*(Idempotente|ORDEM|PRÉ-CHECK|VERIFICAÇÃO|DEPOIS|CUSTO|COMPATIB)/i.test(l)) break;
    raw.push(l);
  }
  const kept: string[] = [];
  const reapply: string[] = [];
  let inDollar = false;
  raw.forEach((line, idx) => {
    let t = line.replace(/^--/, "").trim();
    if (idx === 0) t = t.replace(/^\([^)]*\)\s*/, ""); // "(só se NENHUM nó send_flow existir) BEGIN;"
    if (!t) return;
    // comando que continua na linha seguinte (ex.: lista de funções num DROP FUNCTION de várias linhas): aceita a continuação
    const open = kept.length > 0 && !/;\s*$/.test(kept[kept.length - 1]);
    if (open && !inDollar && !t.startsWith("(") && !t.startsWith("--")) {
      const cont = t.replace(/\s+--\s.*$/, "");
      kept.push(cont);
      if (((cont.match(/\$\$/g) ?? []).length % 2) === 1) inDollar = !inDollar; // "AS $$" abre o corpo da função na linha de continuação
      return;
    }
    if (t.startsWith("--")) return; // comentário dentro do bloco de rollback
    if (!inDollar) {
      if (t.startsWith("(")) return; // pré-condição em prosa
      const re = t.match(/^reaplicar a (\d+)/i);
      if (re) {
        reapply.push(re[1]);
        return;
      }
      if (!SQL_START.test(t)) return; // prosa
    }
    t = t.replace(/\s+--\s.*$/, ""); // comentário no fim da linha
    t = t.replace(/;\s+\(.*$/, ";"); // observação em parênteses depois do último ; (ex.: "COMMIT;   (antes: reverter o deploy)")
    kept.push(t);
    if (((t.match(/\$\$/g) ?? []).length % 2) === 1) inDollar = !inDollar;
  });
  const statements = splitStatements(kept.join("\n"));
  if (statements.length === 0 && reapply.length === 0) throw new Error(`migration ${n}: rollback do cabeçalho só em prosa (nenhum comando executável)`);
  return { statements, reapply };
}

async function runRollback(db: PGlite, n: string) {
  try {
    await runRollbackUnsafe(db, n);
  } catch (e) {
    await db.exec("ROLLBACK").catch(() => undefined);
    throw e;
  }
}
async function runRollbackUnsafe(db: PGlite, n: string) {
  const { statements, reapply } = rollbackOf(n);
  expect(statements.length, `migration ${n}: rollback do cabeçalho sem nenhum comando executável`).toBeGreaterThan(0);
  for (const stmt of statements) await db.exec(stmt);
  for (const r of reapply) {
    expect(r, "só a 290 (user_sessions) tem reaplicação conhecida neste teste").toBe("290");
    await db.exec(USER_SESSIONS_290);
  }
}

// ---------- a rodada ----------
const suite = describe;
if (!complete) console.warn(`[deploy-round] migrations ausentes nesta base: ${missing.join(", ")} — rodada parcial (DEPLOY_ROUND_STRICT=1 falha)`);

describe("rodada de deploy — presença dos arquivos", () => {
  it("todas as migrations da rodada estão nesta base", () => {
    if (!STRICT) return;
    expect(missing, "arquivos ausentes").toEqual([]);
  });
  it("a ordem da rodada não repete nem inverte o número (b vem logo depois do número)", () => {
    // 310 vai por último DA FASE "antes do deploy" (aplica o RLS de MFA em TODAS as tabelas já criadas); o resto é crescente.
    expect(PRE_DEPLOY[PRE_DEPLOY.length - 1]).toBe("310");
    const pre = PRE_DEPLOY.slice(0, -1).map((n) => parseInt(n, 10));
    expect(pre).toEqual([...pre].sort((a, b) => a - b));
    const post = POST_DEPLOY.map((n) => parseInt(n, 10));
    expect(post).toEqual([...post].sort((a, b) => a - b));
    expect(new Set(FULL_ROUND).size).toBe(FULL_ROUND.length);
  });
  it("a fase DEPOIS do deploy: o cabeçalho avisa a ordem e a migration não cria tabela com RLS (a 310 já passou)", () => {
    const problems: string[] = [];
    for (const n of POST_DEPLOY.filter((x) => fileOf(x))) {
      const header = sqlOf(n).split("\n").filter((l) => l.startsWith("--")).join("\n");
      if (!/DEPLOY[^\n]*(depois|código novo)|depois que|depois do deploy/i.test(header)) problems.push(`${n}: o cabeçalho não diz que roda depois do deploy`);
      if (/ENABLE ROW LEVEL SECURITY/i.test(stripComments(sqlOf(n)))) problems.push(`${n}: liga RLS depois da 310 — precisa chamar wacrm.apply_mfa_policy na própria migration`);
    }
    expect(problems).toEqual([]);
  });
  it("dependências declaradas no cabeçalho (\"Depende da 302\", \"ORDEM: depois da 143, 241\") vêm antes na rodada", () => {
    const problems: string[] = [];
    ROUND.forEach((n, i) => {
      const header = sqlOf(n).split("\n").filter((l) => l.startsWith("--")).join("\n");
      for (const m of header.matchAll(/(?:Depende d[aeo]s?|ORDEM:\s*depois d[aeo]s?|aplique a(?:s)?)\s+(\d{3}b?(?:\s*(?:,|e)\s*\d{3}b?)*)/gi)) {
        for (const dep of m[1].match(/\d{3}b?/g) ?? []) {
          const at = ROUND.indexOf(dep);
          if (at > i) problems.push(`${n} depende da ${dep}, que vem DEPOIS na rodada`);
        }
      }
    });
    expect(problems).toEqual([]);
  });
});

suite("rodada de deploy — PGlite sobre o schema-base da v2", () => {
  let db: PGlite;
  /** O que já existia ANTES de a rodada começar (baseline + migrations reais). */
  const baselineExisting = new Map<string, Set<string>>();
  /** O que já existia imediatamente antes de CADA migration (inclui o que as anteriores da rodada criaram). */
  const preExisting = new Map<string, Set<string>>();
  const created = new Map<string, Created>();

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASELINE_SQL);
    for (const f of BASELINE_REAL_MIGRATIONS) {
      await db.exec(readFileSync(`${DIR}/${f}`, "utf8").replace(/NOTIFY pgrst[^;]*;/g, "")).catch((e) => {
        throw new Error(`baseline: migration real ${f} falhou: ${e instanceof Error ? e.message : e}`);
      });
    }
    for (const n of ROUND) {
      created.set(n, createdBy(n));
      baselineExisting.set(n, new Set(await exists(db, created.get(n)!)));
    }
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("(b) nenhuma migration usa objeto que só uma migration POSTERIOR da rodada cria", () => {
    const problems: string[] = [];
    ROUND.forEach((n, i) => {
      const code = stripComments(sqlOf(n));
      const own = created.get(n)!;
      for (const later of ROUND.slice(i + 1)) {
        const c = created.get(later)!;
        for (const name of [...c.tables, ...c.functions]) {
          if (baselineExisting.get(later)!.has(`tabela ${name}`) || baselineExisting.get(later)!.has(`função ${name}`)) continue; // já existe antes da rodada
          if (own.tables.includes(name) || own.functions.includes(name)) continue;
          // uso CONDICIONAL (só chama se a função já existe: to_regprocedure/pg_proc) não é dependência: a 310, sempre a última, cobre as tabelas
          const guarded = new RegExp(`to_regprocedure\\('wacrm\\.${name}\\(|proname\\s*=\\s*'${name}'`, "i").test(code);
          if (!guarded && new RegExp(`wacrm\\.${name}\\b`, "i").test(code)) problems.push(`${n} usa wacrm.${name}, criado só pela ${later}`);
        }
      }
    });
    expect(problems).toEqual([]);
  });

  it("(a) 1ª execução na ordem da rodada não quebra e registra em schema_migrations", async () => {
    for (const n of ROUND) {
      preExisting.set(n, new Set(await exists(db, created.get(n)!)));
      await applyFile(db, n).catch((e) => {
        throw new Error(`migration ${n} (${fileOf(n)}) falhou na 1ª execução: ${e instanceof Error ? e.message : e}`);
      });
    }
    const reg = (await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations")).rows.map((r) => r.version);
    for (const n of ROUND.filter((x) => !x.endsWith("b"))) {
      expect(reg.some((v) => v.startsWith(`${n}_`)), `${n} não registrou schema_migrations`).toBe(true);
    }
  }, 120_000);

  it("(a) 2ª execução (idempotência) não quebra e não duplica registro", async () => {
    const before = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM wacrm.schema_migrations")).rows[0].n;
    for (const n of ROUND) {
      await applyFile(db, n).catch((e) => {
        throw new Error(`migration ${n} (${fileOf(n)}) falhou na 2ª execução: ${e instanceof Error ? e.message : e}`);
      });
    }
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM wacrm.schema_migrations")).rows[0].n).toBe(before);
  }, 120_000);

  // A 340 põe o DELETE de funis em pipelines.delete (só o proprietário); a 348 (RLS fase 3) roda depois e o devolvia a pipelines.manage; a 352 restaura a regra da 340.
  it.skipIf(!ROUND.includes("352"))("no FIM da rodada, o DELETE de wacrm.pipelines só passa por has_perm('pipelines.delete') (a 348 não desfaz a 340)", async () => {
    const r = await db.query<{ policyname: string; qual: string }>(
      "SELECT policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'pipelines' AND cmd = 'DELETE' AND permissive = 'PERMISSIVE'",
    );
    expect(r.rows.map((x) => x.policyname)).toEqual(["pipelines_delete"]);
    expect(r.rows[0].qual).toContain("pipelines.delete");
    expect(r.rows[0].qual).not.toContain("pipelines.manage");
    expect(ROUND.indexOf("352")).toBeGreaterThan(ROUND.indexOf("348"));
    expect(ROUND.indexOf("352")).toBeGreaterThan(ROUND.indexOf("340"));
  });

  it.skipIf(!ROUND.includes("310"))("a 310 por último cobre as tabelas novas: toda tabela wacrm com RLS tem mfa_aal2_required", async () => {
    const r = await db.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'wacrm' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'wacrm' AND p.tablename = c.relname AND p.policyname = 'mfa_aal2_required')`);
    expect(r.rows.map((x) => x.relname)).toEqual([]);
    const NEW_RLS_TABLES: Array<[string, string]> = [["history_export_jobs", "297"], ["push_subscriptions", "298"], ["quick_reply_usage_daily", "301"], ["internal_chat_reads", "303"], ["cron_heartbeat", "334"]];
    for (const [t] of NEW_RLS_TABLES.filter(([, mig]) => ROUND.includes(mig))) {
      const p = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = '${t}' AND policyname = 'mfa_aal2_required'`);
      expect(p.rows[0].n, `${t} sem a policy de MFA`).toBe(1);
    }
  });

  it("as migrations 32x rodando DEPOIS da 310 não removem a policy mfa_aal2_required", async () => {
    const count = async () =>
      (await db.query<{ tablename: string }>("SELECT tablename FROM pg_policies WHERE schemaname = 'wacrm' AND policyname = 'mfa_aal2_required' ORDER BY 1")).rows.map((r) => r.tablename);
    const before = await count();
    for (const n of ROUND.filter((x) => /^32\d/.test(x))) await applyFile(db, n);
    expect(await count()).toEqual(before);
  }, 60_000);

  it("(c) rollbacks do cabeçalho, em ordem inversa, rodam e removem o que a migration criou", async () => {
    for (const n of [...ROUND].reverse()) {
      if (isProseRollback(n)) {
        expect(STRICT, `rollback da migration ${n} (${fileOf(n)}) só em prosa: torne-o SQL executável no cabeçalho (BEGIN; … COMMIT;)`).toBe(false);
        console.warn(`[deploy-round] rollback da ${n} é só prosa — não executado`);
        continue;
      }
      await runRollback(db, n).catch((e) => {
        throw new Error(`rollback da migration ${n} (${fileOf(n)}) falhou: ${e instanceof Error ? e.message : e}`);
      });
      const left = (await exists(db, created.get(n)!)).filter((o) => !preExisting.get(n)!.has(o));
      expect(left, `rollback da ${n} deixou objetos criados por ela`).toEqual([]);
    }
    const mfa = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'wacrm' AND policyname = 'mfa_aal2_required'");
    expect(mfa.rows[0].n, "rollback da 310 deixou policies").toBe(0);
    // a 315 troca a user_sessions: o rollback dela reaplica a 290 e a função tem de continuar funcionando
    await db.exec("SELECT * FROM wacrm.user_sessions('00000000-0000-0000-0000-000000000001')");
    const flow = await db.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check'");
    expect(flow.rows[0].def).not.toContain("send_flow");
  }, 120_000);

  it("(c) depois do rollback total, reaplicar a rodada inteira volta a funcionar (ida e volta)", async () => {
    for (const n of ROUND) {
      await applyFile(db, n).catch((e) => {
        throw new Error(`migration ${n} falhou ao reaplicar depois do rollback: ${e instanceof Error ? e.message : e}`);
      });
    }
    for (const n of ROUND) {
      const now = new Set(await exists(db, created.get(n)!));
      const wanted = [...created.get(n)!.tables.map((t) => `tabela ${t}`), ...created.get(n)!.functions.map((f) => `função ${f}`)];
      for (const w of wanted.filter((x) => !preExisting.get(n)!.has(x))) expect(now.has(w), `${n}: ${w} não voltou depois do rollback + reaplicação`).toBe(true);
    }
  }, 120_000);
});

suite("rodada de deploy — controle negativo: a 310 fora do fim deixa tabela nova sem MFA", () => {
  it.skipIf(!ROUND.includes("310") || !ROUND.includes("303"))("310 antes da 303 ⇒ internal_chat_reads fica sem a policy (por isso a 310 é a última)", async () => {
    const db = new PGlite();
    try {
      await db.exec(BASELINE_SQL);
      for (const n of ["310", "303"]) await applyFile(db, n);
      const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'internal_chat_reads' AND policyname = 'mfa_aal2_required'");
      expect(r.rows[0].n).toBe(0);
    } finally {
      await db.close();
    }
  }, 60_000);
});

// A 329 tira anon (e PUBLIC) de TODAS as funções/tabelas do wacrm: não pode tirar nada de authenticated nem de service_role, e o anon só mantém peek_invitation.
type FnPriv = { sig: string; auth: boolean; svc: boolean; anon: boolean };
type TblPriv = { tbl: string; a_sel: boolean; a_ins: boolean; s_sel: boolean; s_ins: boolean; anon_sel: boolean };
suite("rodada de deploy — a 329 (REVOKE do anon) não quebra authenticated, service_role nem peek_invitation", () => {
  it.skipIf(!ROUND.includes("329"))("o que authenticated/service_role executavam e acessavam continua igual; anon só peek_invitation", async () => {
    const db = new PGlite();
    try {
      await db.exec(BASELINE_SQL);
      for (const f of BASELINE_REAL_MIGRATIONS) await db.exec(readFileSync(`${DIR}/${f}`, "utf8").replace(/NOTIFY pgrst[^;]*;/g, ""));
      for (const n of ROUND.slice(0, ROUND.indexOf("329"))) await applyFile(db, n);
      // peek_invitation no wacrm (se o banco vivo tiver) nasce com o padrão do Postgres (PUBLIC); a 329 devolve o EXECUTE ao anon
      await db.exec(`CREATE OR REPLACE FUNCTION wacrm.peek_invitation(p_token_hash text) RETURNS json LANGUAGE sql AS $$ SELECT '{"ok":false}'::json $$;`);
      const fnPriv = `SELECT p.oid::regprocedure::text AS sig,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
          has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
        FROM pg_proc p WHERE p.pronamespace = 'wacrm'::regnamespace AND p.prokind IN ('f','p') ORDER BY 1`;
      const tblPriv = `SELECT c.relname AS tbl,
          has_table_privilege('authenticated', c.oid, 'SELECT') AS a_sel, has_table_privilege('authenticated', c.oid, 'INSERT') AS a_ins,
          has_table_privilege('service_role', c.oid, 'SELECT') AS s_sel, has_table_privilege('service_role', c.oid, 'INSERT') AS s_ins,
          has_table_privilege('anon', c.oid, 'SELECT') AS anon_sel
        FROM pg_class c WHERE c.relnamespace = 'wacrm'::regnamespace AND c.relkind IN ('r','v','m') ORDER BY 1`;
      const fnBefore = (await db.query<FnPriv>(fnPriv)).rows;
      const tblBefore = (await db.query<TblPriv>(tblPriv)).rows;
      expect(fnBefore.some((f) => f.auth), "o baseline precisa ter funções executáveis por authenticated").toBe(true);

      await applyFile(db, "329");
      await applyFile(db, "329"); // idempotente

      const fnAfter = (await db.query<FnPriv>(fnPriv)).rows;
      const tblAfter = (await db.query<TblPriv>(tblPriv)).rows;
      const lost: string[] = [];
      for (const b of fnBefore) {
        const a = fnAfter.find((x) => x.sig === b.sig);
        if (!a) continue;
        if (b.auth && !a.auth) lost.push(`authenticated perdeu EXECUTE em ${b.sig}`);
        if (b.svc && !a.svc) lost.push(`service_role perdeu EXECUTE em ${b.sig}`);
        if (!b.auth && a.auth) lost.push(`authenticated GANHOU EXECUTE em ${b.sig}`);
      }
      for (const b of tblBefore) {
        const a = tblAfter.find((x) => x.tbl === b.tbl)!;
        if ((b.a_sel && !a.a_sel) || (b.a_ins && !a.a_ins)) lost.push(`authenticated perdeu acesso à tabela ${b.tbl}`);
        if ((b.s_sel && !a.s_sel) || (b.s_ins && !a.s_ins)) lost.push(`service_role perdeu acesso à tabela ${b.tbl}`);
      }
      expect(lost).toEqual([]);
      // anon: nenhuma tabela e nenhuma função, exceto peek_invitation
      expect(tblAfter.filter((t) => t.anon_sel).map((t) => t.tbl)).toEqual([]);
      expect(fnAfter.filter((f) => f.anon).map((f) => f.sig)).toEqual(["wacrm.peek_invitation(text)"]);
    } finally {
      await db.close();
    }
  }, 120_000);
});

// referência para quem lê o relatório: confirma que o arquivo existe quando a rodada roda
void existsSync;
