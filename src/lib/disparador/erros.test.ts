import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  classeOfCode,
  codesOfClasse,
  csvCell,
  decodeCursor,
  encodeCursor,
  ErrosInputError,
  errosToCsv,
  listErros,
  loadErroDetail,
  loadErrosSummary,
  parseErrosFilters,
  periodoSince,
  resolveFilters,
  type ErroItem,
  type ErrosDb,
} from "./erros";

const ACC = "00000000-0000-0000-0000-0000000000a1";
const OTHER = "00000000-0000-0000-0000-0000000000b2";
const CAMP = "00000000-0000-0000-0000-0000000000c1";
const SESS = "00000000-0000-0000-0000-0000000000d1";
const ITEM = "00000000-0000-0000-0000-0000000000e1";
const ITEM2 = "00000000-0000-0000-0000-0000000000e2";

type Op = [string, ...unknown[]];
interface Call {
  table: string;
  ops: Op[];
}
type Handler = (call: Call) => { data: unknown; error?: { message: string; code?: string } | null };

/** Banco falso: grava cada chamada encadeada e devolve o que o handler da tabela mandar. */
function fakeDb(
  handlers: Record<string, Handler>,
  rpc?: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null },
) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const proxy: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "not", "gte", "or", "order", "limit"]) {
        proxy[m] = (...args: unknown[]) => {
          call.ops.push([m, ...args]);
          return proxy;
        };
      }
      proxy.then = (resolve: (v: unknown) => unknown) => {
        const r = handlers[table]?.(call) ?? { data: [] };
        return resolve({ data: r.data, error: r.error ?? null });
      };
      return proxy;
    },
    rpc: async (fn: string, args: Record<string, unknown>) =>
      rpc ? rpc(fn, args) : { data: null, error: { message: "x", code: "PGRST202" } },
  };
  return { db: db as unknown as ErrosDb, calls };
}
const has = (call: Call, ...op: Op) => call.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));
const params = (s: string) => new URLSearchParams(s);

describe("parseErrosFilters", () => {
  it("padrão: 24h, sem filtros", () => {
    expect(parseErrosFilters(params(""))).toEqual({ campaign: null, session: null, code: null, classe: null, periodo: "24h", phone: null });
  });
  it("aceita código numérico, sem_codigo, classe e período", () => {
    const f = parseErrosFilters(params(`campaign=${CAMP.toUpperCase()}&session=${SESS}&code=131026&classe=limite&periodo=7d`));
    expect(f).toMatchObject({ campaign: CAMP, session: SESS, code: 131026, classe: "limite", periodo: "7d" });
    expect(parseErrosFilters(params("code=sem_codigo")).code).toBe("sem_codigo");
  });
  it("rejeita valores inválidos (nada de texto livre indo para a consulta)", () => {
    for (const q of ["campaign=abc", "session=1;drop", "code=12x", "code=%27or%271", "classe=qualquer", "periodo=ano", "phone=123", "phone=abcdefghij"]) {
      expect(() => parseErrosFilters(params(q)), q).toThrow(ErrosInputError);
    }
  });
  it("telefone vira só dígitos", () => {
    expect(parseErrosFilters(params("phone=%2B55%20(11)%2099999-8888")).phone).toBe("5511999998888");
  });
});

describe("cursor keyset", () => {
  it("ida e volta", () => {
    const c = { u: "2026-10-06T15:00:00.123456+00:00", i: ITEM };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(null)).toBeNull();
  });
  it("rejeita cursor adulterado (entra num filtro .or())", () => {
    const bad = (s: string) => Buffer.from(s).toString("base64url");
    expect(() => decodeCursor(bad(`2026-10-06T15:00:00Z|${ITEM},id.gt.0`))).toThrow(ErrosInputError);
    expect(() => decodeCursor(bad(`x"),status.eq.enviado|${ITEM}`))).toThrow(ErrosInputError);
    expect(() => decodeCursor("%%%")).toThrow(ErrosInputError);
  });
});

describe("classes e período", () => {
  it("classe de um código vem do catálogo", () => {
    expect(classeOfCode(131026)).toBe("destinatario");
    expect(classeOfCode(null)).toBe("sem_codigo");
    expect(classeOfCode(999999)).toBe("desconhecido");
    expect(codesOfClasse("destinatario")).toContain(131026);
  });
  it("período", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(periodoSince("1h", now)).toBe("2026-10-07T11:00:00.000Z");
    expect(periodoSince("all", now)).toBeNull();
  });
});

describe("listErros — filtros, tenancy e keyset", () => {
  const row = (n: number) => ({
    id: `00000000-0000-0000-0000-00000000f${String(n).padStart(3, "0")}`,
    campaign_id: CAMP,
    session_id: SESS,
    contact_id: null,
    erro: "Meta: x (code 131026)",
    erro_codigo: 131026,
    updated_at: `2026-10-06T15:00:${String(59 - n).padStart(2, "0")}.000000+00:00`,
    scheduled_at: null,
    sent_at: null,
    tentativas: 1,
    template_name: "t",
    entrega_pendente_131026: false,
    contacts: { name: "Ana", phone: "+5511999998888" },
    campaigns: { nome: "Camp" },
  });
  const numbers = [{ id: SESS, label: "Principal" }];
  const base = {
    campaign: null,
    session: null,
    code: null,
    classe: null,
    periodo: "24h" as const,
    phone: null,
    since: "2026-10-06T00:00:00.000Z",
    contactIds: null,
  };

  it("sempre filtra status=erro e a conta pela junção com campaigns", async () => {
    const { db, calls } = fakeDb({ disp_message_queue: () => ({ data: [] }) });
    await listErros(db, ACC, base, numbers, null);
    const c = calls[0];
    expect(has(c, "eq", "status", "erro")).toBe(true);
    expect(has(c, "eq", "campaigns.account_id", ACC)).toBe(true);
    expect(has(c, "gte", "updated_at", base.since)).toBe(true);
    expect(JSON.stringify(c.ops)).toContain("campaigns!campaign_id!inner");
  });

  it("pagina 50 e lê 51 para saber se há próxima; cursor aponta para a última linha da página", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(i));
    const { db, calls } = fakeDb({ disp_message_queue: () => ({ data: rows }) });
    const page = await listErros(db, ACC, base, numbers, null, 50);
    expect(page.items).toHaveLength(50);
    expect(has(calls[0], "limit", 51)).toBe(true);
    expect(has(calls[0], "order", "updated_at", { ascending: false })).toBe(true);
    expect(has(calls[0], "order", "id", { ascending: false })).toBe(true);
    expect(decodeCursor(page.nextCursor)).toEqual({ u: rows[49].updated_at, i: rows[49].id });
    expect(page.items[0]).toMatchObject({ numero: "Principal", classe: "destinatario", campaignNome: "Camp" });
    expect(page.items[0].significado).toMatch(/entreg/i);
  });

  it("última página não devolve cursor; com cursor aplica (updated_at, id) < cursor sem OFFSET", async () => {
    const { db, calls } = fakeDb({ disp_message_queue: () => ({ data: [row(1), row(2)] }) });
    const cur = { u: "2026-10-06T15:00:30.000000+00:00", i: ITEM };
    const page = await listErros(db, ACC, base, numbers, cur, 50);
    expect(page.nextCursor).toBeNull();
    const or = calls[0].ops.find((o) => o[0] === "or")?.[1] as string;
    expect(or).toBe(`updated_at.lt."${cur.u}",and(updated_at.eq."${cur.u}",id.lt.${ITEM})`);
    expect(calls[0].ops.some((o) => o[0] === "range")).toBe(false);
    expect(JSON.stringify(calls[0].ops)).not.toContain("exact");
  });

  it("código, classe e sem código viram filtros de erro_codigo", async () => {
    const run = async (extra: object) => {
      const { db, calls } = fakeDb({ disp_message_queue: () => ({ data: [] }) });
      await listErros(db, ACC, { ...base, ...extra }, numbers, null);
      return calls[0];
    };
    expect(has(await run({ code: 131026 }), "eq", "erro_codigo", 131026)).toBe(true);
    expect(has(await run({ code: "sem_codigo" }), "is", "erro_codigo", null)).toBe(true);
    const cls = await run({ classe: "limite" });
    expect(cls.ops.find((o) => o[0] === "in" && o[1] === "erro_codigo")?.[2]).toEqual(codesOfClasse("limite"));
    const desc = await run({ classe: "desconhecido" });
    expect(desc.ops.some((o) => o[0] === "not" && o[1] === "erro_codigo" && o[2] === "in")).toBe(true);
  });

  it("telefone sem contato na conta: lista vazia, sem tocar a fila", async () => {
    const { db, calls } = fakeDb({ contacts: () => ({ data: [] }), whatsapp_config: () => ({ data: [] }) });
    const r = await resolveFilters(db, ACC, { ...base, phone: "5511999998888", periodo: "24h" }, numbers);
    expect(r.contactIds).toEqual([]);
    expect(has(calls[0], "eq", "account_id", ACC)).toBe(true);
    const page = await listErros(db, ACC, r, numbers, null);
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(calls.some((c) => c.table === "disp_message_queue")).toBe(false);
  });

  it("telefone: busca exata por variações (9º dígito/55) e confere a chave; nunca LIKE", async () => {
    const { db, calls } = fakeDb({
      contacts: () => ({
        data: [
          { id: "c1", phone: "+5511999998888" },
          { id: "c2", phone: "+5511999997777" }, // outro número que voltou: descartado
        ],
      }),
    });
    const r = await resolveFilters(db, ACC, { ...base, phone: "11999998888" }, numbers);
    expect(r.contactIds).toEqual(["c1"]);
    const inOp = calls[0].ops.find((o) => o[0] === "in") as Op;
    expect(inOp[1]).toBe("phone");
    expect(inOp[2] as string[]).toEqual(expect.arrayContaining(["+5511999998888", "+551199998888"]));
    expect(JSON.stringify(calls[0].ops)).not.toMatch(/like/i);
  });

  it("campanha ou número de outra conta: 404 (nada vaza)", async () => {
    const { db } = fakeDb({ campaigns: () => ({ data: [] }) });
    await expect(resolveFilters(db, ACC, { ...base, campaign: CAMP }, numbers)).rejects.toMatchObject({ status: 404 });
    await expect(resolveFilters(db, ACC, { ...base, session: OTHER }, numbers)).rejects.toMatchObject({ status: 404 });
    const { db: db2, calls } = fakeDb({ campaigns: () => ({ data: [{ id: CAMP, nome: "C" }] }) });
    await expect(resolveFilters(db2, ACC, { ...base, campaign: CAMP, session: SESS }, numbers)).resolves.toBeTruthy();
    expect(has(calls[0], "eq", "account_id", ACC)).toBe(true);
  });
});

describe("resumo por código", () => {
  const f = { campaign: null, session: null, code: null, classe: null, periodo: "24h" as const, phone: null, since: null, contactIds: null };

  it("usa a função 191 e ordena por contagem", async () => {
    const { db } = fakeDb({}, (fn, args) => {
      expect(fn).toBe("dispatch_errors_summary");
      expect(args.p_account_id).toBe(ACC);
      return { data: { codes: [{ erro_codigo: 131026, n: 5 }, { erro_codigo: null, n: 9 }], total: 14, truncated: false }, error: null };
    });
    const s = await loadErrosSummary(db, ACC, f);
    expect(s).toMatchObject({ total: 14, truncated: false, source: "rpc" });
    expect(s.rows.map((r) => r.code)).toEqual([null, 131026]);
    expect(s.rows[1]).toMatchObject({ classe: "destinatario" });
  });

  it("sem a função 191: amostra por keyset, marcada como amostra", async () => {
    const { db, calls } = fakeDb({
      disp_message_queue: () => ({
        data: [
          { id: ITEM, erro_codigo: 131049, updated_at: "2026-10-06T15:00:00+00:00" },
          { id: ITEM2, erro_codigo: 131049, updated_at: "2026-10-06T14:00:00+00:00" },
        ],
      }),
    });
    const s = await loadErrosSummary(db, ACC, f);
    expect(s).toMatchObject({ total: 2, source: "amostra", truncated: false });
    expect(s.rows[0]).toMatchObject({ code: 131049, count: 2 });
    expect(has(calls[0], "eq", "campaigns.account_id", ACC)).toBe(true);
  });

  it("erro real do banco (não 'função inexistente') é propagado", async () => {
    const { db } = fakeDb({}, () => ({ data: null, error: { message: "boom", code: "XX000" } }));
    await expect(loadErrosSummary(db, ACC, f)).rejects.toThrow(/boom/);
  });
});

describe("detalhe do item", () => {
  const queueRow = {
    id: ITEM,
    campaign_id: CAMP,
    session_id: SESS,
    contact_id: "c1",
    erro: "Meta: Message undeliverable (code 131026)",
    erro_codigo: 131026,
    updated_at: "2026-10-06T15:05:00+00:00",
    scheduled_at: "2026-10-06T15:00:00+00:00",
    sent_at: "2026-10-06T15:01:00+00:00",
    tentativas: 1,
    template_name: "cobranca",
    template_language: "pt_BR",
    template_variables: ["Ana", 100],
    entrega_pendente_131026: true,
    waha_message_id: "wamid.X",
    contacts: { name: "Ana", phone: "+5511999998888" },
    campaigns: { nome: "Camp", status: "em_execucao", account_id: ACC },
  };
  const handlers = (rowForQueue: unknown): Record<string, Handler> => ({
    whatsapp_config: () => ({ data: [{ id: SESS, phone_number: "5511", display_name: "Principal" }] }),
    disp_message_queue: () => ({ data: rowForQueue ? [rowForQueue] : [] }),
    webhook_status_inbox: () => ({
      data: [
        { status: "delivered", event_ts: "2026-10-06T15:02:00+00:00", received_at: "2026-10-06T15:02:01+00:00", processed_at: null, error_text: null, account_id: ACC },
        // De outra conta: descartado.
        { status: "read", event_ts: "2026-10-06T15:03:00+00:00", received_at: "x", processed_at: null, error_text: null, account_id: OTHER },
      ],
    }),
    dispatch_meta_131026_failures: () => ({ data: [{ campaign_id: "a" }, { campaign_id: "b" }, { campaign_id: "a" }] }),
  });

  it("monta linha do tempo, template, recibos da conta e 131026 pendente", async () => {
    const { db, calls } = fakeDb(handlers(queueRow));
    const d = await loadErroDetail(db, ACC, ITEM);
    expect(d.item).toMatchObject({ numero: "Principal", classe: "destinatario", entregaPendente131026: true });
    expect(d.template).toEqual({ name: "cobranca", language: "pt_BR", variables: ["Ana", "100"] });
    expect(d.receipts).toHaveLength(1);
    expect(d.timeline.map((e) => e.key)).toEqual(["agendado", "enviado", "entregue", "erro"]);
    expect(d.campanhas131026).toBe(2);
    const q = calls.find((c) => c.table === "disp_message_queue")!;
    expect(has(q, "eq", "campaigns.account_id", ACC)).toBe(true);
    const inbox = calls.find((c) => c.table === "webhook_status_inbox")!;
    expect(has(inbox, "eq", "message_id", "wamid.X")).toBe(true);
  });

  it("item de outra conta ou inexistente: 404; id malformado: 404", async () => {
    const none = fakeDb(handlers(null));
    await expect(loadErroDetail(none.db, ACC, ITEM)).rejects.toMatchObject({ status: 404 });
    // Mesmo que o banco devolvesse a linha, a conta da campanha é conferida de novo.
    const foreign = fakeDb(handlers({ ...queueRow, campaigns: { ...queueRow.campaigns, account_id: OTHER } }));
    await expect(loadErroDetail(foreign.db, ACC, ITEM)).rejects.toMatchObject({ status: 404 });
    await expect(loadErroDetail(none.db, ACC, "1 or 1=1")).rejects.toMatchObject({ status: 404 });
  });

  it("sem a tabela de recibos (185) o detalhe continua", async () => {
    const h = handlers(queueRow);
    const { db } = fakeDb({ ...h, webhook_status_inbox: () => ({ data: null, error: { message: "relation does not exist", code: "42P01" } }) });
    const d = await loadErroDetail(db, ACC, ITEM);
    expect(d.receipts).toEqual([]);
    expect(d.timeline.map((e) => e.key)).toEqual(["agendado", "enviado", "erro"]);
  });
});

describe("buildTimeline", () => {
  it("ordena por horário e mantém a falha do webhook com o texto", () => {
    const t = buildTimeline(
      { scheduledAt: "2026-10-06T15:00:00Z", sentAt: "2026-10-06T15:01:00Z", updatedAt: "2026-10-06T15:03:00Z", erro: "x (code 131049)", erroCodigo: 131049 },
      [{ status: "failed", event_ts: "2026-10-06T15:02:00Z", received_at: null, processed_at: null, error_text: "ruim" }],
    );
    expect(t.map((e) => e.key)).toEqual(["agendado", "enviado", "erro", "erro"]);
    expect(t[2]).toMatchObject({ label: "Falha informada pela Meta", detail: "ruim" });
    expect(t[3].label).toBe("Erro 131049");
  });
});

describe("CSV", () => {
  it("neutraliza fórmulas e escapa separador/aspas/quebra de linha", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+55")).toBe("'+55");
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(131026)).toBe("131026");
  });
  it("cabeçalho + BOM + uma linha por item", () => {
    const item = {
      updatedAt: "2026-10-06T15:00:00Z",
      campaignNome: "C",
      numero: "N",
      contactName: "Ana",
      phone: "+5511999998888",
      erroCodigo: 131026,
      classe: "destinatario",
      significado: "s",
      acao: "a",
      erro: "e",
      tentativas: 1,
    } as ErroItem;
    const csv = errosToCsv([item]);
    expect(csv.startsWith("﻿Data/hora;Campanha")).toBe(true);
    expect(csv.trim().split("\r\n")).toHaveLength(2);
    expect(csv).toContain("'+5511999998888");
  });
});
