import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));

import {
  campaignUsesTemplate,
  pauseCampaignsForTemplate,
  resumeCampaignsForTemplate,
  templatePauseReason,
  templatesOfCampaign,
} from "./template-pause";

type Row = Record<string, unknown>;

// Fake em memória: from(t).select().eq()… filtra; update().eq()… altera; rpc registra a pausa.
function makeDb(tables: Record<string, Row[]>, opts: { missing336?: boolean } = {}) {
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const db = {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      const run = () => {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (patch) {
          if (opts.missing336 && ("pausa_template_nome" in patch || "pausa_template_idioma" in patch)) {
            return { data: null, error: { code: "42703", message: "column pausa_template_nome does not exist" } };
          }
          hit.forEach((r) => Object.assign(r, patch));
          return { data: hit, error: null };
        }
        if (opts.missing336 && table === "campaigns" && filters.length && (builder as { usesMark?: boolean }).usesMark) {
          return { data: null, error: { code: "42703", message: "column campaigns.pausa_template_nome does not exist" } };
        }
        return { data: hit, error: null };
      };
      const builder: Record<string, unknown> & { usesMark?: boolean } = {
        select: () => builder,
        update: (p: Row) => ((patch = p), builder),
        eq: (c: string, v: unknown) => {
          if (c === "pausa_template_nome") builder.usesMark = true;
          filters.push((r) => r[c] === v);
          return builder;
        },
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
      };
      return builder;
    },
    rpc: (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      const c = (tables.campaigns ?? []).find((r) => r.id === args.p_campaign_id);
      if (c && c.status === "em_execucao") {
        c.status = "pausada";
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: false, error: null });
    },
  };
  return { db: db as never, rpcCalls };
}

const msgs = (...names: string[]) => names.map((n) => ({ template_name: n, template_language: "pt_BR" }));

describe("helpers", () => {
  it("templatesOfCampaign ignora mensagens sem template e repetidas", () => {
    expect(templatesOfCampaign([{ texto: "oi" }, ...msgs("a", "a", "b")])).toEqual([
      { name: "a", language: "pt_BR" },
      { name: "b", language: "pt_BR" },
    ]);
    expect(templatesOfCampaign(null)).toEqual([]);
  });
  it("campaignUsesTemplate compara nome e idioma (padrão pt_BR)", () => {
    expect(campaignUsesTemplate(msgs("a"), "a", undefined)).toBe(true);
    expect(campaignUsesTemplate(msgs("a"), "a", "en_US")).toBe(false);
    expect(campaignUsesTemplate(msgs("a"), "b", "pt_BR")).toBe(false);
  });
  it("motivo legível cita o template e o motivo da Meta", () => {
    expect(templatePauseReason("promo", "PAUSED")).toContain('"promo"');
    expect(templatePauseReason("promo", "DISABLED", "baixa qualidade")).toContain("baixa qualidade");
  });
});

describe("pauseCampaignsForTemplate", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("pausa só a campanha em execução da conta que usa o template, com motivo e marca", async () => {
    const tables = {
      campaigns: [
        { id: "c1", account_id: "A", status: "em_execucao", nome: "um", mensagens: msgs("promo") },
        { id: "c2", account_id: "A", status: "em_execucao", nome: "dois", mensagens: msgs("outro") },
        { id: "c3", account_id: "A", status: "pausada", nome: "tres", mensagens: msgs("promo") },
        { id: "c4", account_id: "B", status: "em_execucao", nome: "quatro", mensagens: msgs("promo") },
      ] as Row[],
    };
    const { db, rpcCalls } = makeDb(tables);
    const r = await pauseCampaignsForTemplate(db, { accountId: "A", name: "promo", language: "pt_BR", status: "PAUSED" });
    expect(r.paused).toEqual(["c1"]);
    expect(rpcCalls).toHaveLength(1);
    expect(tables.campaigns[0]).toMatchObject({ status: "pausada", pausa_template_nome: "promo", pausa_template_idioma: "pt_BR" });
    expect(String(tables.campaigns[0].pausa_automatica_motivo)).toContain("promo");
    expect(tables.campaigns[1].status).toBe("em_execucao");
    expect(tables.campaigns[3].status).toBe("em_execucao");
  });

  it("sem a migration 336 ainda pausa e grava o motivo", async () => {
    const tables = { campaigns: [{ id: "c1", account_id: "A", status: "em_execucao", mensagens: msgs("promo") }] as Row[] };
    const { db } = makeDb(tables, { missing336: true });
    const r = await pauseCampaignsForTemplate(db, { accountId: "A", name: "promo", language: null, status: "DISABLED" });
    expect(r.paused).toEqual(["c1"]);
    expect(tables.campaigns[0].status).toBe("pausada");
    expect(String(tables.campaigns[0].pausa_automatica_motivo)).toContain("desativado");
  });

  it("nunca lança quando o banco falha", async () => {
    const db = { from: () => { throw new Error("boom"); }, rpc: vi.fn() } as never;
    await expect(pauseCampaignsForTemplate(db, { accountId: "A", name: "x", language: null, status: "PAUSED" })).resolves.toEqual({ paused: [] });
  });
});

describe("resumeCampaignsForTemplate", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  const base = () => ({
    campaigns: [
      { id: "c1", account_id: "A", status: "pausada", nome: "um", mensagens: msgs("promo"), pausa_template_nome: "promo", pausa_template_idioma: "pt_BR" },
      // pausada pelo operador (sem marca): não retoma
      { id: "c2", account_id: "A", status: "pausada", nome: "dois", mensagens: msgs("promo"), pausa_template_nome: null, pausa_template_idioma: null },
      // pausada pelo template "promo" mas usa também "outro", ainda pausado
      { id: "c3", account_id: "A", status: "pausada", nome: "tres", mensagens: msgs("promo", "outro"), pausa_template_nome: "promo", pausa_template_idioma: "pt_BR" },
    ] as Row[],
    message_templates: [
      { account_id: "A", name: "promo", language: "pt_BR", status: "APPROVED" },
      { account_id: "A", name: "outro", language: "pt_BR", status: "PAUSED" },
    ] as Row[],
  });

  it("retoma só as pausadas pelo template com todos os templates aprovados e limpa a marca", async () => {
    const tables = base();
    const { db } = makeDb(tables);
    const resume = vi.fn(async () => ({ ok: true }));
    const r = await resumeCampaignsForTemplate(db, { accountId: "A", name: "promo", language: "pt_BR" }, resume);
    expect(r.resumed).toEqual(["c1"]);
    expect(r.waiting).toEqual(["c3"]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("c1", "A");
    expect(tables.campaigns[0].pausa_template_nome).toBeNull();
    expect(tables.campaigns[2].pausa_template_nome).toBe("promo");
  });

  it("mantém a marca quando a retomada falha (ex.: qualidade RED)", async () => {
    const tables = base();
    const { db } = makeDb(tables);
    const resume = vi.fn(async () => ({ ok: false, error: "qualidade RED" }));
    const r = await resumeCampaignsForTemplate(db, { accountId: "A", name: "promo", language: "pt_BR" }, resume);
    expect(r.resumed).toEqual([]);
    expect(r.waiting).toContain("c1");
    expect(tables.campaigns[0].pausa_template_nome).toBe("promo");
  });

  it("sem a migration 336 não retoma nada e não lança", async () => {
    const tables = base();
    const { db } = makeDb(tables, { missing336: true });
    const resume = vi.fn(async () => ({ ok: true }));
    const r = await resumeCampaignsForTemplate(db, { accountId: "A", name: "promo", language: "pt_BR" }, resume);
    expect(r).toEqual({ resumed: [], waiting: [] });
    expect(resume).not.toHaveBeenCalled();
  });
});
