import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  check: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  planning: vi.fn(async () => ({ ok: true, metrics: { total_contatos: 0 } })),
}));

vi.mock("@/lib/auth/account", () => {
  class ForbiddenError extends Error {
    readonly status = 403;
  }
  return {
    ForbiddenError,
    getCurrentAccount: mocks.account,
    toErrorResponse: (err: unknown) =>
      new Response(JSON.stringify({ error: String(err) }), {
        status: (err as { status?: number })?.status ?? 401,
      }),
  };
});
vi.mock("@/lib/disparador/campaign-config-check", () => ({
  checkCampaignConfig: mocks.check,
}));
vi.mock("@/lib/disparador/campaign-planning", () => ({
  syncCampaignPlannedMetrics: mocks.planning,
}));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ limit: async () => mocks.insert(table, row) }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: () => ({ is: async () => mocks.update(table, values) }),
      }),
    }),
  }),
}));

import { POST } from "./route";

const DRAFT = "6f1c2b9e-1d2a-4c3b-9a8e-0f1e2d3c4b5a";

function body(overrides: Record<string, unknown> = {}) {
  return {
    nome: "Cobrança outubro",
    session_ids: ["canal-1"],
    tags_filtro: [],
    mensagens: [{ tipo: "texto", conteudo: "Oi" }],
    janela_inicio: "08:00",
    janela_fim: "18:00",
    batch_size: 999999,
    batch_pause_seconds: 0,
    batch_percent: null,
    intervalo_min: 0,
    intervalo_max: 0,
    dias_permitidos: "sequencia",
    audience_mode: "csv",
    agendamento: null,
    draft_id: DRAFT,
    status: "em_execucao",
    account_id: "outra-conta",
    ...overrides,
  };
}

function post(payload: unknown, query = "") {
  return POST(
    new Request(`https://crm.test/api/disparador/campaigns${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/disparador/campaigns", () => {
  afterEach(() => vi.clearAllMocks());

  it("cria como rascunho sem agendamento; status/conta decididos no servidor", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    mocks.check.mockResolvedValue({ ok: true, provider: "waha", wabaId: null, channels: [] });
    mocks.insert.mockReturnValue({ data: [{ id: "camp-1" }], error: null });
    mocks.update.mockReturnValue({ error: null });

    const res = await post(body());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "camp-1", status: "rascunho" });

    const [table, row] = mocks.insert.mock.calls[0];
    expect(table).toBe("campaigns");
    expect(row).toMatchObject({
      status: "rascunho",
      account_id: "acc-1",
      created_by: "user-1",
      import_draft_id: DRAFT,
      dias_envio: [1, 2, 3, 4, 5],
    });
    expect(mocks.check).toHaveBeenCalledWith(expect.anything(), "acc-1", ["canal-1"], expect.any(Array), {
      templateMode: "sequencia",
      audienceMode: "csv",
    });
    expect(mocks.update.mock.calls.map((c) => c[0]).sort()).toEqual([
      "contact_import_variables",
      "disparador_utm_links",
    ]);
    expect(mocks.planning).toHaveBeenCalledWith(expect.anything(), "acc-1", "camp-1");
  });

  it("com agendamento futuro vira 'agendado'", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    mocks.check.mockResolvedValue({ ok: true, provider: "waha", wabaId: null, channels: [] });
    mocks.insert.mockReturnValue({ data: [{ id: "camp-2" }], error: null });
    mocks.update.mockReturnValue({ error: null });
    const future = new Date(Date.now() + 3 * 3600_000).toISOString();
    const res = await post(body({ agendamento: future }));
    expect((await res.json()).status).toBe("agendado");
    expect(mocks.insert.mock.calls[0][1].status).toBe("agendado");
  });

  it("recusa agendamento no passado e janela invertida, sem gravar", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    const res = await post(
      body({ agendamento: new Date(Date.now() - 60_000).toISOString(), janela_inicio: "18:00", janela_fim: "08:00" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errors).toHaveLength(2);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("conta inteira exige o aceite explícito", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    const res = await post(body({ audience_mode: "account" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/confirme o envio para todos/);
  });

  it("erro do validador de canais/templates volta com o status dele", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    mocks.check.mockResolvedValue({ ok: false, status: 400, error: "Modo Padrão usa exatamente 1 template" });
    const res = await post(body());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exatamente 1 template/);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("aceita import_draft_id (nome do #80) e recusa lote fora da faixa", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    mocks.check.mockResolvedValue({ ok: true, provider: "waha", wabaId: null, channels: [] });
    mocks.insert.mockReturnValue({ data: [{ id: "camp-4" }], error: null });
    mocks.update.mockReturnValue({ error: null });
    const { draft_id: _omit, ...semDraft } = body();
    void _omit;
    await post({ ...semDraft, import_draft_id: DRAFT });
    expect(mocks.insert.mock.calls[0][1].import_draft_id).toBe(DRAFT);
    const res = await post(body({ batch_size: 2_000_000 }));
    expect(res.status).toBe(400);
  });

  it("viewer, agente e supervisor recebem 403 sem validar nem gravar", async () => {
    for (const role of ["viewer", "agent", "supervisor"]) {
      mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role });
      const res = await post(body());
      expect(res.status).toBe(403);
    }
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("dry_run só valida e devolve o status", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    mocks.check.mockResolvedValue({ ok: true, provider: "meta", wabaId: "w", channels: [] });
    const res = await post(body(), "?dry_run=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "rascunho", provider: "meta" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("migration 162 ausente: grava sem agendamento_fim", async () => {
    mocks.account.mockResolvedValue({ userId: "user-1", accountId: "acc-1", role: "admin" });
    mocks.check.mockResolvedValue({ ok: true, provider: "waha", wabaId: null, channels: [] });
    mocks.update.mockReturnValue({ error: null });
    mocks.insert
      .mockReturnValueOnce({
        data: null,
        error: { code: "PGRST204", message: "Could not find the 'agendamento_fim' column of 'campaigns'" },
      })
      .mockReturnValueOnce({ data: [{ id: "camp-3" }], error: null });
    const future = new Date(Date.now() + 3 * 3600_000).toISOString();
    const end = new Date(Date.now() + 30 * 3600_000).toISOString();
    const res = await post(body({ agendamento: future, agendamento_fim: end }));
    expect(res.status).toBe(201);
    expect(mocks.insert.mock.calls[0][1].agendamento_fim).toBe(end);
    expect("agendamento_fim" in mocks.insert.mock.calls[1][1]).toBe(false);
  });
});
