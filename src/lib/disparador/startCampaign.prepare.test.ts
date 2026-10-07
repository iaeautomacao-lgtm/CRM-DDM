import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// startCampaign (B9): janela de 24h sem erro silencioso, recuperação para
// 'agendado', inserção em blocos de 1.000 e updated_at renovado.
// Banco em memória só com o que a preparação usa.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  campaign: {} as Row,
  campaignUpdates: [] as Row[],
  queueInserts: [] as number[],
  queuePayloads: [] as Row[],
  messageQueries: 0,
  messagesError: null as { message: string } | null,
  messagesRows: [] as Row[],
  messagesFilters: [] as Array<[string, unknown]>,
  failInsertAt: 0,
}));

function builder(table: string, viaSchema = false) {
  const filters: Array<[string, unknown]> = [];
  let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  let payload: any = null;
  let single = false;
  const b: Record<string, any> = {};
  for (const m of ["order", "limit", "in", "not", "gt", "lt", "range"]) {
    b[m] = (...args: unknown[]) => {
      filters.push([m, args]);
      return b;
    };
  }
  b.select = () => b;
  b.eq = (c: string, v: unknown) => (filters.push([`eq:${c}`, v]), b);
  b.single = () => ((single = true), b);
  b.insert = (p: any) => ((op = "insert"), (payload = p), b);
  b.update = (p: any) => ((op = "update"), (payload = p), b);
  b.delete = () => ((op = "delete"), b);
  b.upsert = (p: any) => ((op = "upsert"), (payload = p), b);
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    try {
      return Promise.resolve(run()).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  };
  function run() {
    if (table === "campaigns") {
      if (op === "update") {
        state.campaignUpdates.push(payload);
        return { data: [{ id: "camp-1" }], error: null };
      }
      return { data: single ? state.campaign : [state.campaign], error: null };
    }
    if (table === "messages") {
      state.messageQueries++;
      state.messagesFilters.push(...filters);
      void viaSchema;
      return state.messagesError ? { data: null, error: state.messagesError } : { data: state.messagesRows, error: null };
    }
    if (table === "disp_message_queue") {
      if (op === "insert") {
        const rows = payload as Row[];
        state.queueInserts.push(rows.length);
        state.queuePayloads.push(...rows);
        if (state.failInsertAt && state.queueInserts.length === state.failInsertAt) {
          return { data: null, error: { message: "insert falhou" } };
        }
        return { data: null, error: null };
      }
      return { data: [], error: null };
    }
    return { data: [], error: null };
  }
  return b;
}

vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (t: string) => builder(t),
    schema: () => ({ from: (t: string) => builder(t, true) }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
const audienceMock = vi.hoisted(() => ({ contacts: [] as Row[] }));
vi.mock("@/lib/disparador/audience", () => ({
  loadCampaignAudience: async () => ({ ok: true, contacts: audienceMock.contacts, source: "csv", importCount: null }),
}));
vi.mock("@/lib/disparador/blacklist-keys", () => ({ loadBlacklistKeySet: async () => new Set<string>() }));
vi.mock("@/lib/disparador/campaign-config-check", () => ({
  checkCampaignConfig: async () => ({ ok: true, channels: [{ id: "meta-1", provider: "meta" }] }),
}));
vi.mock("@/lib/disparador/queue-reflow", () => ({ resumeBatchedCampaign: vi.fn() }));
vi.mock("@/lib/logger", () => ({ writeLog: async () => {} }));

const { startCampaign } = await import("./startCampaign");

const contacts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `N${i}`, phone: `+55119${String(10000000 + i)}`, cpf: null }));

const templateMsg = { tipo: "texto", template_name: "t1", template_language: "pt_BR", template_variable_map: [], conteudo: "x" };
const freeTextMsg = { tipo: "texto", conteudo: "Olá livre" };

function setCampaign(over: Row = {}) {
  state.campaign = {
    id: "camp-1",
    account_id: "acc",
    status: "preparando",
    mensagens: [templateMsg],
    session_ids: ["meta-1"],
    agendamento: "2026-10-08T11:00:00.000Z",
    batch_size: 1,
    intervalo_min: 0,
    intervalo_max: 0,
    ...over,
  };
}

describe("startCampaign — preparação (B9)", () => {
  beforeEach(() => {
    state.campaignUpdates = [];
    state.queueInserts = [];
    state.queuePayloads = [];
    state.messageQueries = 0;
    state.messagesError = null;
    state.messagesRows = [];
    state.messagesFilters = [];
    state.failInsertAt = 0;
    audienceMock.contacts = contacts(3);
    setCampaign();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("todas as mensagens são template: nem consulta o histórico de 24h", async () => {
    const result = await startCampaign("camp-1", "acc");
    expect(result).toEqual({ ok: true, enqueued: 3 });
    expect(state.messageQueries).toBe(0);
  });

  it("bulk misto: linhas agendadas enviam erro_permanente=false e inválidas=true", async () => {
    setCampaign({
      mensagens: [
        {
          tipo: "texto",
          template_name: "t1",
          template_language: "pt_BR",
          template_variable_map: [{ type: "contact_field", field: "name" }],
          conteudo: "Olá {{1}}",
        },
      ],
    });
    audienceMock.contacts = [
      { id: "c0", name: "Ana", phone: "+5511910000000", cpf: null },
      { id: "c1", name: "", phone: "+5511910000001", cpf: null },
      { id: "c2", name: "Bia", phone: "+5511910000002", cpf: null },
    ];

    const result = await startCampaign("camp-1", "acc");
    expect(result).toEqual({ ok: true, enqueued: 3 });
    expect(state.queuePayloads.map((r) => r.erro_permanente)).toEqual([false, true, false]);
    expect(state.queuePayloads.every((r) => typeof r.erro_permanente === "boolean")).toBe(true);
  });

  it("texto livre em canal Meta: consulta só inbound dos últimos 24h (received_at > agora-24h)", async () => {
    setCampaign({ mensagens: [freeTextMsg] });
    state.messagesRows = [
      { id: "m1", received_at: new Date().toISOString(), conversations: { contact_id: "c0", config_id: "meta-1" } },
    ];
    const result = await startCampaign("camp-1", "acc");
    expect(result.ok).toBe(true);
    expect(state.messageQueries).toBe(1);
    const gt = state.messagesFilters.find(([k, args]) => k === "gt" && (args as unknown[])[0] === "received_at");
    expect(gt).toBeTruthy();
    const since = new Date(String((gt![1] as unknown[])[1])).getTime();
    expect(Math.abs(Date.now() - 24 * 3600_000 - since)).toBeLessThan(60_000);
  });

  it("falha na consulta das 24h ABORTA: nenhum erro permanente, nada enfileirado, campanha volta a 'agendado'", async () => {
    setCampaign({ mensagens: [freeTextMsg] });
    state.messagesError = { message: "statement timeout" };
    const result = await startCampaign("camp-1", "acc");
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect((result as { error: string }).error).toMatch(/janela de 24h/);
    expect(state.queueInserts).toEqual([]); // nenhum contato virou erro "Janela de 24h encerrada"
    expect(state.campaignUpdates.some((u) => u.status === "agendado")).toBe(true);
    expect(state.campaignUpdates.some((u) => u.status === "rascunho")).toBe(false);
  });

  it("falha transitória SEM agendamento volta para 'rascunho'", async () => {
    setCampaign({ mensagens: [freeTextMsg], agendamento: null });
    state.messagesError = { message: "timeout" };
    await startCampaign("camp-1", "acc");
    expect(state.campaignUpdates.some((u) => u.status === "rascunho")).toBe(true);
    expect(state.campaignUpdates.some((u) => u.status === "agendado")).toBe(false);
  });

  it("falha ao inserir a fila: volta para 'agendado' (agendamento preservado)", async () => {
    audienceMock.contacts = contacts(1200);
    state.failInsertAt = 2;
    const result = await startCampaign("camp-1", "acc");
    expect(result.ok).toBe(false);
    expect(state.campaignUpdates.some((u) => u.status === "agendado")).toBe(true);
  });

  it("fila inserida em blocos de 1.000 (2.500 contatos = 1000 + 1000 + 500) e updated_at renovado a cada bloco", async () => {
    audienceMock.contacts = contacts(2500);
    const result = await startCampaign("camp-1", "acc");
    expect(result).toEqual({ ok: true, enqueued: 2500 });
    expect([...state.queueInserts].sort((a, b) => b - a)).toEqual([1000, 1000, 500]);
    const touches = state.campaignUpdates.filter((u) => Object.keys(u).length === 1 && "updated_at" in u);
    // Janela/audience/csv + 3 blocos: ao menos um toque por bloco gravado.
    expect(touches.length).toBeGreaterThanOrEqual(3);
  });
});
