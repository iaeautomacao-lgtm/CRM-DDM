// Testes de fluxo das telas novas (16/10), com o MESMO login do teste de telas (papel admin, auth.setup.ts) e o que cada tela lê
// simulado por page.route (ver e2e/fluxos/mocks.ts). Cobrem: Custos de IA, apelido @operador (Usuários e Equipe), selos de reserva
// no Inbox e o cache SWR (Painel → Contatos → Painel; logout). Rodar: E2E_ROLES=admin npm run e2e:fluxos (docs/e2e-telas.md).
import { expect, test, type Page } from "@playwright/test";

import { authFile, ALL_ROLES } from "./roles";
import { blockUnmockedWrites, currentUserId, mockApi, mockPermissions, mockTable, navTo } from "./fluxos/mocks";
import { currentMonthSP, monthLabel, monthOptions, todaySP } from "@/lib/costs/ai-costs-ui";

const admin = ALL_ROLES.find((r) => r.key === "admin")!;
test.use({ storageState: authFile(admin) });

let blocked: string[] = [];
test.beforeEach(async ({ page }) => {
  blocked = [];
  await blockUnmockedWrites(page, blocked); // registrada primeiro: as simulações de cada teste (depois) têm prioridade
});
test.afterEach(() => {
  expect(blocked, "escrita não simulada foi bloqueada").toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// 1) Relatórios → Custos de IA
// ------------------------------------------------------------------------------------------------
const row = (o: Record<string, unknown>) => ({ requests: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, priced_usd: 0, unpriced: 0, ...o });

function costReport(month: string) {
  const ai = [
    row({ sku: "openai:gpt-4o-mini", requests: 120, input_tokens: 90_000, output_tokens: 30_000, cached_input_tokens: 10_000, priced_usd: 1.2345 }),
    row({ sku: "gemini:gemini-2.0-flash", requests: 10, input_tokens: 5_000, output_tokens: 1_000, unpriced: 10 }),
  ];
  const by_feature = [
    row({ feature: "responder", requests: 100, input_tokens: 80_000, output_tokens: 25_000, priced_usd: 1.1 }),
    row({ feature: "nova_coisa", requests: 30, input_tokens: 15_000, output_tokens: 6_000, priced_usd: 0.1345, unpriced: 10 }),
  ];
  const by_feature_model = [
    row({ feature: "responder", sku: "openai:gpt-4o-mini", requests: 100, priced_usd: 1.1 }),
    row({ feature: "nova_coisa", sku: "gemini:gemini-2.0-flash", requests: 10, unpriced: 10 }),
  ];
  return {
    month,
    estimate: true,
    currency: "USD",
    ai,
    rates: [],
    totals: row({ requests: 130, input_tokens: 95_000, output_tokens: 31_000, cached_input_tokens: 10_000, priced_usd: 1.2345, unpriced: 10 }),
    notice: "Valores estimados: tarifa configurada × tokens informados pelo provedor. Não equivalem à fatura.",
    by_feature,
    by_feature_model,
  };
}

const RATES = {
  rates: [{ sku: "openai:gpt-4o-mini", currency: "USD", effective_from: "2026-01-01", input_per_million: 0.15, cached_input_per_million: 0.075, output_per_million: 0.6, locked: true }],
  skus: [],
};

test.describe("Relatórios → Custos de IA", () => {
  test("mês, aviso de estimativa, 'Sem tarifa' e agrupar por modelo/funcionalidade", async ({ page }) => {
    const months: string[] = [];
    await mockApi(page, "/api/costs/ai", (req) => {
      const month = new URL(req.url()).searchParams.get("month") ?? "";
      months.push(month);
      return { body: costReport(month) };
    });
    await mockApi(page, "/api/costs/ai/rates", () => ({ body: RATES }));

    await page.goto("/relatorios/custos-ia");
    const current = currentMonthSP();

    // Aviso fixo de estimativa e visão por modelo (padrão).
    await expect(page.getByText("Estimativa, não é a fatura")).toBeVisible();
    await expect(page.getByText(`Por modelo — ${monthLabel(current)}`)).toBeVisible();
    await expect(page.getByText("openai:gpt-4o-mini")).toBeVisible();
    // Modelo sem nenhuma tarifa: "Sem tarifa", nunca US$ 0.
    await expect(page.getByText("Sem tarifa", { exact: true })).toBeVisible();

    // Troca de mês: pede o mês escolhido e atualiza o título da tabela.
    const previous = monthOptions(current, 2)[1];
    await page.locator("#custos-ia-mes").click();
    await page.getByRole("option", { name: monthLabel(previous) }).click();
    await expect(page.getByText(`Por modelo — ${monthLabel(previous)}`)).toBeVisible();
    expect(months).toContain(previous);

    // Agrupar por funcionalidade: rótulo em pt-br, chave desconhecida como veio, detalhe por modelo.
    await page.getByRole("button", { name: "Funcionalidade", exact: true }).click();
    await expect(page.getByText(`Por funcionalidade — ${monthLabel(previous)}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Respostas automáticas" })).toBeVisible();
    await expect(page.getByText("nova_coisa", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Respostas automáticas" }).click();
    await expect(page.getByText("openai:gpt-4o-mini")).toBeVisible();
    await expect(page.getByText("Estimativa, não é a fatura")).toBeVisible(); // o aviso continua nesta visão

    // Voltar ao modelo.
    await page.getByRole("button", { name: "Modelo", exact: true }).click();
    await expect(page.getByText(`Por modelo — ${monthLabel(previous)}`)).toBeVisible();
  });

  test("rota antiga (sem by_feature) esconde o seletor de agrupamento", async ({ page }) => {
    await mockApi(page, "/api/costs/ai", (req) => {
      const { by_feature, by_feature_model, ...old } = costReport(new URL(req.url()).searchParams.get("month") ?? "");
      void by_feature;
      void by_feature_model;
      return { body: old };
    });
    await mockApi(page, "/api/costs/ai/rates", () => ({ body: RATES }));
    await page.goto("/relatorios/custos-ia");
    await expect(page.getByText("openai:gpt-4o-mini")).toBeVisible();
    await expect(page.getByRole("button", { name: "Funcionalidade", exact: true })).toHaveCount(0);
  });

  test("aba Tarifas: nova vigência recusada com 409 mostra a mensagem em pt-br", async ({ page }) => {
    await mockApi(page, "/api/costs/ai", (req) => ({ body: costReport(new URL(req.url()).searchParams.get("month") ?? "") }));
    const puts: unknown[] = [];
    await mockApi(page, "/api/costs/ai/rates", (req) => {
      if (req.method() === "PUT") {
        puts.push(req.postDataJSON());
        return { status: 409, body: { error: "Já existe uma vigência em vigor para este modelo nesta data. Crie uma com data posterior." } };
      }
      return { body: RATES };
    });

    await page.goto("/relatorios/custos-ia");
    await page.getByRole("button", { name: "Tarifas", exact: true }).click();
    await expect(page.getByText("Em vigor")).toBeVisible();

    await page.getByLabel("Modelo (provedor:modelo)").fill("openai:gpt-4o-mini");
    await page.getByLabel("Vigência a partir de").fill(todaySP());
    await page.getByLabel("Entrada", { exact: true }).fill("0,15");
    await page.getByLabel("Saída", { exact: true }).fill("0,60");
    await page.getByRole("button", { name: "Adicionar vigência" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Já existe uma vigência em vigor" })).toBeVisible();
    expect(puts).toEqual([
      { sku: "openai:gpt-4o-mini", effective_from: todaySP(), input_per_million: 0.15, cached_input_per_million: null, output_per_million: 0.6 },
    ]);
  });

  test("valor inválido não chega ao servidor", async ({ page }) => {
    await mockApi(page, "/api/costs/ai", (req) => ({ body: costReport(new URL(req.url()).searchParams.get("month") ?? "") }));
    let puts = 0;
    await mockApi(page, "/api/costs/ai/rates", (req) => {
      if (req.method() === "PUT") puts += 1;
      return { body: RATES };
    });
    await page.goto("/relatorios/custos-ia");
    await page.getByRole("button", { name: "Tarifas", exact: true }).click();
    await page.getByLabel("Modelo (provedor:modelo)").fill("gpt-4o");
    await page.getByRole("button", { name: "Adicionar vigência" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Modelo inválido" })).toBeVisible();
    expect(puts).toBe(0);
  });

  test("sem reports.view_all: acesso negado e nenhuma chamada de custos", async ({ page }) => {
    let calls = 0;
    await mockPermissions(page, { remove: ["reports.view_all"] });
    await mockApi(page, "/api/costs/ai", () => ((calls += 1), { body: {} }));
    await mockApi(page, "/api/costs/ai/rates", () => ((calls += 1), { body: {} }));
    await page.goto("/relatorios/custos-ia");
    await expect(page.getByText("Você não tem permissão para ver os custos de IA")).toBeVisible();
    expect(calls).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
// 2) Apelido @operador — Usuários e Equipe
// ------------------------------------------------------------------------------------------------
const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const OP_ID = "22222222-2222-4222-8222-222222222222";
const OP2_ID = "33333333-3333-4333-8333-333333333333";

function member(over: Record<string, unknown>) {
  return {
    user_id: OP_ID,
    full_name: "Operador Teste",
    email: "operador.teste@exemplo.com",
    avatar_url: null,
    role: "agent",
    joined_at: "2026-01-10T12:00:00Z",
    team_id: TEAM_ID,
    max_simultaneous_chats: null,
    active: true,
    deactivated_at: null,
    last_sign_in_at: null,
    last_active_at: null,
    mention_alias: null,
    ...over,
  };
}

const ALIAS_RULE = "Use de 2 a 32 caracteres: letras sem acento, números ou _ (não pode começar com número).";
const ALIAS_IN_USE = "Esse apelido já está em uso por outro operador desta conta.";

async function mockUsuarios(page: Page, members: unknown[]) {
  await mockApi(page, "/api/account/members", () => ({ body: { members } }));
  await mockApi(page, "/api/account/invitations", () => ({ body: { invitations: [] } }));
  await mockApi(page, "/api/account/roles", () => ({ body: { roles: [] } }));
  await mockTable(page, "teams", () => ({ rows: [{ id: TEAM_ID, name: "Equipe Teste" }] }));
}

test.describe("Apelido @operador", () => {
  test("Usuários: validação, 409 apelido em uso e salvar", async ({ page }) => {
    await mockUsuarios(page, [member({})]);
    const patches: unknown[] = [];
    let respondWith: { status: number; body: unknown } = { status: 409, body: { error: "duplicado" } };
    await mockApi(page, `/api/account/members/${OP_ID}`, (req) => {
      patches.push(req.postDataJSON());
      return respondWith;
    });

    await page.goto("/usuarios");
    await page.getByRole("row", { name: /Abrir Operador Teste/ }).click();
    await expect(page.getByText("Sem apelido")).toBeVisible();
    await page.getByRole("button", { name: "Editar apelido de Operador Teste" }).click();

    const dialog = page.getByRole("dialog", { name: "Apelido de atendimento" });
    const input = dialog.getByLabel("Apelido");

    // Formato inválido: mensagem da regra e nenhuma chamada ao servidor.
    await input.fill("Maria-X");
    await dialog.getByRole("button", { name: "Salvar apelido" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(ALIAS_RULE);
    expect(patches).toHaveLength(0);

    // Apelido em uso por outro operador: 409 vira mensagem em pt-br e o diálogo fica aberto.
    await input.fill("@Maria_Op");
    await dialog.getByRole("button", { name: "Salvar apelido" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(ALIAS_IN_USE);
    expect(patches).toEqual([{ mention_alias: "maria_op" }]);

    // Salvar de verdade: fecha, mostra o apelido e avisa.
    respondWith = { status: 200, body: { success: true } };
    await dialog.getByRole("button", { name: "Salvar apelido" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("@maria_op")).toBeVisible();
    await expect(page.getByText("Apelido @maria_op salvo")).toBeVisible();
  });

  test("Usuários: sem members.manage não edita (vê o apelido, sem botão)", async ({ page }) => {
    await mockUsuarios(page, [member({ mention_alias: "adriana" }), member({ user_id: OP2_ID, full_name: "Outro Operador", email: "outro@exemplo.com" })]);
    await mockPermissions(page, { remove: ["members.manage"] });
    await page.goto("/usuarios");

    await page.getByRole("row", { name: /Abrir Operador Teste/ }).click();
    await expect(page.getByText("@adriana")).toBeVisible();
    await expect(page.getByRole("button", { name: /Editar apelido de/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Definir apelido" })).toHaveCount(0);
  });

  async function mockEquipe(page: Page, members: unknown[]) {
    const team = { id: TEAM_ID, account_id: "acc", name: "Equipe Teste", session_timeout_minutes: null, overflow_team_id: null, color: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
    await mockTable(page, "teams", () => ({ rows: [team] }));
    for (const t of ["whatsapp_config", "tags", "team_outcome_tags", "message_templates", "team_allowed_templates"]) {
      await mockTable(page, t, () => ({ rows: [] }));
    }
    await mockApi(page, "/api/account/members", () => ({ body: { members } }));
    await mockApi(page, `/api/account/teams/${TEAM_ID}/members`, () => ({ body: { userIds: [OP_ID] } }));
  }

  test("Equipe: campo inline valida, trata 409 e salva", async ({ page }) => {
    await mockEquipe(page, [member({})]);
    const patches: unknown[] = [];
    let respondWith: { status: number; body: unknown } = { status: 409, body: {} };
    await mockApi(page, `/api/account/members/${OP_ID}`, (req) => {
      patches.push(req.postDataJSON());
      return respondWith;
    });

    await page.goto(`/equipes/${TEAM_ID}`);
    const field = page.getByLabel("Apelido de atendimento de Operador Teste");
    await expect(field).toBeVisible();

    await field.fill("@Maria-X");
    await field.blur();
    await expect(page.getByText(ALIAS_RULE)).toBeVisible();
    expect(patches).toHaveLength(0);

    await field.fill("maria_op");
    await field.blur();
    await expect(page.getByText(ALIAS_IN_USE)).toBeVisible();
    expect(patches).toEqual([{ mention_alias: "maria_op" }]);

    respondWith = { status: 200, body: { success: true } };
    await field.fill("maria_op");
    await field.blur();
    await expect(page.getByText("Apelido @maria_op salvo")).toBeVisible();
  });

  test("Equipe: sem members.manage o campo de apelido não aparece", async ({ page }) => {
    await mockEquipe(page, [member({ mention_alias: "adriana" })]);
    await mockPermissions(page, { remove: ["members.manage"] });
    await page.goto(`/equipes/${TEAM_ID}`);
    await expect(page.getByText("Operador Teste")).toBeVisible();
    await expect(page.getByLabel("Apelido de atendimento de Operador Teste")).toHaveCount(0);
  });
});

// ------------------------------------------------------------------------------------------------
// 3) Inbox — selo de reserva por menção na lista e no cabeçalho
// ------------------------------------------------------------------------------------------------
function conversation(over: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    user_id: "u",
    contact_id: "k0000000-0000-4000-8000-000000000001",
    status: "pending",
    unread_count: 1,
    last_message_text: "Oi, preciso de ajuda",
    last_message_at: now,
    last_customer_message_at: now,
    created_at: now,
    updated_at: now,
    channel_type: "whatsapp",
    requested_agent_id: null,
    requested_agent: null,
    contact: { id: "k0000000-0000-4000-8000-000000000001", name: "Cliente Um", phone: "5511999990001", created_at: now },
    ...over,
  };
}

test.describe("Inbox — reserva por menção", () => {
  test("lista e cabeçalho mostram 'Aguardando @apelido' e 'Cliente pediu você'", async ({ page }) => {
    // O id do usuário logado vem da sessão: a conversa reservada para ele ganha o selo "Cliente pediu você".
    await page.goto("/dashboard");
    const me = await currentUserId(page);
    const now = new Date().toISOString();
    const conversations = [
      conversation({
        id: "c0000000-0000-4000-8000-000000000001",
        requested_agent_id: OP_ID,
        requested_agent: { user_id: OP_ID, full_name: "Adriana Souza", mention_alias: "adriana" },
      }),
      conversation({
        id: "c0000000-0000-4000-8000-000000000002",
        contact_id: "k0000000-0000-4000-8000-000000000002",
        contact: { id: "k0000000-0000-4000-8000-000000000002", name: "Cliente Dois", phone: "5511999990002", created_at: now },
        requested_agent_id: me,
        requested_agent: { user_id: me, full_name: "Eu Mesmo", mention_alias: "eu" },
      }),
      conversation({
        id: "c0000000-0000-4000-8000-000000000003",
        contact_id: "k0000000-0000-4000-8000-000000000003",
        contact: { id: "k0000000-0000-4000-8000-000000000003", name: "Cliente Três", phone: "5511999990003", created_at: now },
      }),
    ];
    await mockApi(page, "/api/inbox/conversations", () => ({ body: { conversations, next_cursor: null } }));
    await mockApi(page, "/api/inbox/counts", () => ({ body: { unread: {}, status: { open: 0, pending: 3 } } }));
    await mockTable(page, "messages", () => ({ rows: [] }));

    await page.goto("/inbox");

    // Na lista: reservada para outro operador, reservada para mim e sem reserva (sem selo).
    await expect(page.getByText("Aguardando @adriana")).toBeVisible();
    await expect(page.getByText("Cliente pediu você")).toBeVisible();
    await expect(page.getByText("Cliente Três")).toBeVisible();
    await expect(page.getByText(/Aguardando @|Cliente pediu você/)).toHaveCount(2);

    // No cabeçalho da conversa aberta o selo aparece de novo (lista + cabeçalho).
    await page.getByText("Cliente Um").first().click();
    await expect(page.getByText("Aguardando @adriana")).toHaveCount(2);

    await page.getByText("Cliente Dois").first().click();
    await expect(page.getByText("Cliente pediu você")).toHaveCount(2);
  });
});

// ------------------------------------------------------------------------------------------------
// 4) Cache SWR — Painel → Contatos → Painel e logout
// ------------------------------------------------------------------------------------------------
const FILA = "7 na fila sem atendente.";
const CONTATO = "Maria Teste Silva";

async function persisted(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    const dbs = (await indexedDB.databases?.()) ?? [];
    parts.push(JSON.stringify(dbs.map((d) => d.name)));
    return parts.join("\n");
  });
}

test.describe("Cache SWR", () => {
  test("Painel → Contatos → Painel mostra o dado na hora; nada fica em storage; logout limpa tudo", async ({ page }) => {
    let slaCalls = 0;
    let contactCalls = 0;
    await mockApi(page, "/api/monitoramento/sla", () => {
      slaCalls += 1;
      // 1ª carga rápida; as seguintes demoram: se o dado aparece antes, veio do cache.
      return { body: { total: { queued: 7, longestWaitMin: 42 } }, delayMs: slaCalls === 1 ? 0 : 4000 };
    });
    await mockTable(page, "contacts", () => {
      contactCalls += 1;
      return {
        rows: [{ id: "k1111111-1111-4111-8111-111111111111", user_id: "u", account_id: "a", name: CONTATO, phone: "5511988887777", email: "maria@exemplo.com", created_at: "2026-10-01T12:00:00Z" }],
        delayMs: contactCalls === 1 ? 0 : 4000,
      };
    });
    for (const t of ["contact_tags", "tags"]) await mockTable(page, t, () => ({ rows: [] }));
    await page.route(/\/auth\/v1\/logout/, (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } }));

    // Painel (carga inicial).
    await page.goto("/dashboard");
    await expect(page.getByText(FILA)).toBeVisible();

    // Contatos (carga inicial) e de volta ao Painel: o cartão da fila aparece sem esperar a rota lenta.
    await navTo(page, "/contacts");
    await expect(page.getByText(CONTATO)).toBeVisible();
    await navTo(page, "/dashboard");
    await expect(page.getByText(FILA)).toBeVisible({ timeout: 1000 });
    expect(slaCalls).toBeGreaterThanOrEqual(2); // revalidou ao fundo, e ainda assim mostrou antes (4 s de atraso)

    // Contatos de novo: a lista aparece na hora, com a revalidação ainda pendente.
    await navTo(page, "/contacts");
    await expect(page.getByText(CONTATO)).toBeVisible({ timeout: 1000 });

    // LGPD: nada da resposta foi gravado em localStorage / sessionStorage / IndexedDB.
    const stored = await persisted(page);
    expect(stored).not.toContain(CONTATO);
    expect(stored).not.toContain("5511988887777");
    expect(stored).not.toContain("maria@exemplo.com");

    // Logout: vai ao login e o dado do usuário anterior não aparece nem fica guardado.
    const callsBefore = contactCalls;
    await page.getByLabel("Abrir menu da conta").click();
    await page.getByRole("menuitem", { name: "Sair" }).click();
    await page.waitForURL((u) => u.pathname === "/login");
    await expect(page.getByText(CONTATO)).toHaveCount(0);
    expect(await persisted(page)).not.toContain(CONTATO);

    // Sem sessão, abrir Contatos leva ao login: nenhuma resposta antiga é mostrada nem pedida.
    await page.goto("/contacts");
    await page.waitForURL((u) => u.pathname === "/login");
    await expect(page.getByText(CONTATO)).toHaveCount(0);
    expect(contactCalls).toBe(callsBefore);
  });
});
