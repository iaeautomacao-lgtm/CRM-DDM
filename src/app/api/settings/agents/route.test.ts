import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { convertAiAgentNode, convertGlobalResponder } from '@/lib/ai/agents/convert';
import { composeAgentPrompt } from '@/lib/ai/agents/compose';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const USER = '00000000-0000-0000-0000-000000000001';
const TOOL = '00000000-0000-0000-0000-000000000002';
const OTHER_TOOL = '00000000-0000-0000-0000-000000000003';
const FILE = '00000000-0000-0000-0000-000000000004';
const OTHER_FILE = '00000000-0000-0000-0000-000000000005';
const state = vi.hoisted(() => ({
  role: 'admin' as AccountRole,
  db: null as PGlite | null,
  failRead: false,
}));
type QueryError = { code?: string };
function builder(table: string) {
  let columns = '*',
    order = 'id',
    first = 0,
    count = 1000;
  let update: Record<string, unknown> | null = null;
  const filters: [string, unknown][] = [];
  const b = {
    select(c: string) {
      columns = c;
      return b;
    },
    eq(k: string, v: unknown) {
      filters.push([k, v]);
      return b;
    },
    in(k: string, v: unknown[]) {
      filters.push([k, v]);
      return b;
    },
    order(k: string) {
      order = k;
      return b;
    },
    range(a: number, z: number) {
      first = a;
      count = z - a + 1;
      return b;
    },
    limit(n: number) {
      count = n;
      return b;
    },
    update(value: Record<string, unknown>) {
      update = value;
      return b;
    },
    async then(resolve: (value: unknown) => unknown) {
      if (state.failRead)
        return resolve({ data: null, error: { code: 'XX000' } });
      const args: unknown[] = [];
      const bind = (value: unknown) => {
        args.push(value);
        return '$' + args.length;
      };
      const set = update
        ? Object.entries(update)
            .map(([k, v]) => `"${k}"=${bind(v)}`)
            .join(',')
        : '';
      const where = filters
        .map(([k, v]) =>
          Array.isArray(v)
            ? `"${k}" IN (${v.map(bind).join(',')})`
            : `"${k}"=${bind(v)}`
        )
        .join(' AND ');
      const sql = update
        ? `UPDATE wacrm."${table}" SET ${set} WHERE ${where} RETURNING ${columns}`
        : `SELECT ${columns} FROM wacrm."${table}" WHERE ${where} ORDER BY "${order}" LIMIT ${count} OFFSET ${first}`;
      try {
        return resolve({
          data: (await state.db!.query(sql, args)).rows,
          error: null,
        });
      } catch (err) {
        return resolve({
          data: null,
          error: { code: (err as QueryError).code },
        });
      }
    },
  };
  return b;
}
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => builder(table),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      const args = Object.values(params).map((v) =>
        v && typeof v === 'object' ? JSON.stringify(v) : v
      );
      const named = Object.keys(params)
        .map((k, i) => `${k}=>$${i + 1}`)
        .join(',');
      try {
        return {
          data: (
            await state.db!.query<{ result: unknown }>(
              `SELECT wacrm.${fn}(${named}) AS result`,
              args
            )
          ).rows[0].result,
          error: null,
        };
      } catch (err) {
        return { data: null, error: { code: (err as QueryError).code, message: (err as Error).message } };
      }
    },
  }),
}));
vi.mock('@/lib/auth/route-guard', () => ({
  guardRole: async (min: AccountRole) =>
    hasMinRole(state.role, min)
      ? { ok: true, ctx: { accountId: A, userId: USER, role: state.role } }
      : {
          ok: false,
          response: Response.json({ error: 'Sem permissão.' }, { status: 403 }),
        },
}));

const { GET: LIST, POST: CREATE } = await import('./route');
const { GET: DETAIL, PATCH, DELETE } = await import('./[id]/route');
const { POST: PUBLISH } = await import('./[id]/versions/route');
const { POST: ROLLBACK } = await import('./[id]/rollback/route');
const { POST: PREVIEW } = await import('./preview/route');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown, method = 'POST', query = '') =>
  new Request('http://localhost/api/settings/agents' + query, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
function input(name = 'Agente') {
  const config = convertGlobalResponder({
    account_id: A,
    api_provider: 'openai',
    enabled: true,
  }).config;
  config.tools = [{ tool_id: TOOL, enabled: false }];
  return {
    name,
    config,
    prompt_content: 'Persona {{cred.LLM_KEY}}',
    composition: 'sections_v1',
    rules: [
      { content: 'Regra obrigatória', enabled: true },
      { content: 'omitida', enabled: false },
    ],
    tool_ids: [TOOL],
    knowledge: { selection_mode: 'explicit', file_ids: [FILE] },
  };
}
function versionBody() {
  const { config, prompt_content, composition, rules, tool_ids, knowledge } =
    input();
  return { config, prompt_content, composition, rules, tool_ids, knowledge };
}
function previewBody() {
  const { config, prompt_content, composition, rules, knowledge } = input();
  return { config, prompt_content, composition, rules, knowledge };
}
let agentId: string, versionId: string;

describe('API perfis e RPC 180 — integração PGlite', () => {
  beforeAll(async () => {
    state.db = new PGlite();
    await state.db
      .exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon,authenticated,service_role;
      CREATE TABLE wacrm.accounts(id uuid PRIMARY KEY); INSERT INTO wacrm.accounts VALUES ('${A}'),('${B}');
      CREATE TABLE wacrm.ai_tools(id uuid PRIMARY KEY,account_id uuid,name text,enabled boolean);
      INSERT INTO wacrm.ai_tools VALUES ('${TOOL}','${A}','consultar',false),('${OTHER_TOOL}','${B}','outra',true);
      CREATE TABLE wacrm.knowledge_base_files(id uuid PRIMARY KEY,account_id uuid,name text,content text);
      INSERT INTO wacrm.knowledge_base_files VALUES ('${FILE}','${A}','KB','conteúdo próprio'),('${OTHER_FILE}','${B}','segredo','não pode aparecer');
      CREATE TABLE wacrm.flows(id uuid PRIMARY KEY,account_id uuid,name text);
      CREATE TABLE wacrm.flow_nodes(id uuid PRIMARY KEY,flow_id uuid,node_key text,node_type text,config jsonb);
      CREATE TABLE wacrm.profiles(user_id uuid PRIMARY KEY,account_id uuid,full_name text);
      INSERT INTO wacrm.profiles VALUES('${USER}','${A}','Administrador');
      GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO service_role;`);
    for (const file of [
      '177_ai_agent_profiles.sql',
      '180_ai_agent_api.sql',
      '180_ai_agent_api.sql',
      '182_ai_agent_publish_legacy.sql',
    ])
      await state.db.exec(
        readFileSync('supabase/migrations/' + file, 'utf8').replace(
          /NOTIFY pgrst[^;]*;/g,
          ''
        )
      );
  }, 30000);
  afterAll(async () => {
    await state.db?.close();
  });

  it('papéis: supervisor lê/prévia; admin/owner escrevem; agent não acessa', async () => {
    for (const role of [
      'agent',
      'supervisor',
      'admin',
      'owner',
    ] as AccountRole[]) {
      state.role = role;
      expect((await LIST()).status).toBe(role === 'agent' ? 403 : 200);
      const body = input('papel-' + role);
      expect((await CREATE(req(body))).status).toBe(
        ['admin', 'owner'].includes(role) ? 201 : 403
      );
      expect((await PREVIEW(req(previewBody()))).status).toBe(
        role === 'agent' ? 403 : 200
      );
      if (!['admin', 'owner'].includes(role)) {
        expect(
          (await PATCH(req({ enabled: false }, 'PATCH'), ctx(TOOL))).status
        ).toBe(403);
        expect((await DELETE(req(undefined, 'DELETE'), ctx(TOOL))).status).toBe(
          403
        );
        expect((await PUBLISH(req({}), ctx(TOOL))).status).toBe(403);
        expect((await ROLLBACK(req({}), ctx(TOOL))).status).toBe(403);
      }
    }
    state.role = 'admin';
  });
  it('criação atômica publica v1, regras separadas e tools desligadas', async () => {
    const response = await CREATE(req(input()));
    expect(response.status).toBe(201);
    ({ agent_id: agentId, version_id: versionId } = await response.json());
    const detail = await (
      await DETAIL(req(undefined, 'GET'), ctx(agentId))
    ).json();
    expect(detail.published.version).toBe(1);
    expect(detail.published.config.llm).not.toHaveProperty('top_p');
    expect(
      detail.published.rules.map((r: { enabled: boolean }) => r.enabled)
    ).toEqual([true, false]);
    expect(detail.published.tools[0]).toMatchObject({
      id: TOOL,
      enabled: false,
      catalog_enabled: false,
    });
    expect(detail.versions[0].created_by_name).toBe('Administrador');
    await expect(
      state.db!.exec(
        `UPDATE wacrm.ai_agent_versions SET prompt_content='mutação' WHERE id='${versionId}'`
      )
    ).rejects.toThrow(/imutável/);
  });
  it('tenancy: tools/KB de outra conta são recusados sem criar agente', async () => {
    const tool = input('tool-alheia');
    tool.tool_ids = [OTHER_TOOL];
    expect((await CREATE(req(tool))).status).toBe(400);
    const file = input('file-alheio');
    file.knowledge.file_ids = [OTHER_FILE];
    expect((await CREATE(req(file))).status).toBe(400);
    expect(
      (
        await state.db!.query(
          "SELECT id FROM wacrm.ai_agents WHERE name IN ('tool-alheia','file-alheio')"
        )
      ).rows
    ).toHaveLength(0);
    expect((await DETAIL(req(undefined, 'GET'), ctx(OTHER_TOOL))).status).toBe(
      404
    );
    expect((await DETAIL(req(undefined, 'GET'), ctx('inválido'))).status).toBe(
      404
    );
  });
  it('validação não coerciva, erros com issues e credenciais literais rejeitadas', async () => {
    const body = input('schema-ruim');
    expect(
      (
        await CREATE(
          req({
            ...body,
            config: { ...body.config, llm: { temperature: null } },
          })
        )
      ).status
    ).toBe(400);
    expect(
      (await (await CREATE(req({ ...body, config: {} }))).json()).issues
    ).toBeDefined();
    body.config.connections.llm = {
      headers: { Authorization: 'Bearer segredo-literal' },
    } as never;
    expect((await CREATE(req(body))).status).toBe(400);
    expect(
      (await PATCH(req({ enabled: 0 }, 'PATCH'), ctx(agentId))).status
    ).toBe(400);
    expect(
      (await CREATE(req({ ...input(), composition: 'legacy_v1' }))).status
    ).toBe(400);
    const unsafe = input('fallback-indevido');
    unsafe.config.connections.llm = {
      platform_env: ['SUPABASE_SERVICE_ROLE_KEY'],
    } as never;
    expect((await CREATE(req(unsafe))).status).toBe(400);
    // REVISAO-113 #6: endpoint de terceiros também é recusado (conexões inertes).
    const custom = input('endpoint-terceiros');
    custom.config.connections.llm = { endpoint: 'https://atacante.com/v1' } as never;
    expect((await CREATE(req(custom))).status).toBe(400);
  });
  it('nova versão e rollback criam versões novas sem alterar v1', async () => {
    const body = versionBody();
    body.prompt_content = 'Persona editada';
    const next = await (await PUBLISH(req(body), ctx(agentId))).json();
    expect(next.version).toBe(2);
    const restored = await (
      await ROLLBACK(req({ version_id: versionId }), ctx(agentId))
    ).json();
    expect(restored.version).toBe(3);
    expect(restored.version_id).not.toBe(versionId);
    const detail = await (
      await DETAIL(req(undefined, 'GET'), ctx(agentId))
    ).json();
    expect(detail.published.prompt_content).toBe('Persona {{cred.LLM_KEY}}');
    expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([
      3, 2, 1,
    ]);
    expect(
      (await ROLLBACK(req({ version_id: OTHER_TOOL }), ctx(agentId))).status
    ).toBe(404);
    expect(
      (
        await PATCH(
          req({ name: 'Renomeado', enabled: false }, 'PATCH'),
          ctx(agentId)
        )
      ).status
    ).toBe(200);
  });
  it('preview compõe regras/KB sem resolver segredo nem fazer rede', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const body = previewBody();
      body.config.knowledge.rag_external = {
        enabled: true,
        url: 'https://rag.test',
        credential: '{{cred.RAG_TOKEN}}',
        top_k: 5,
        timeout_ms: 1000,
      };
      const response = await PREVIEW(req(body));
      expect(response.status).toBe(200);
      const text = (await response.json()).system_prompt;
      expect(text).toContain('{{cred.LLM_KEY}}');
      expect(text).toContain('Regra obrigatória');
      expect(text).toContain('conteúdo próprio');
      expect(text).not.toContain('omitida');
      expect(text).not.toContain('não pode aparecer');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('uso distinto por fluxo, DELETE 409 sem force e exclusão segura', async () => {
    await state.db!
      .exec(`INSERT INTO wacrm.flows VALUES('${FILE}','${A}','Fluxo');
      INSERT INTO wacrm.flow_nodes VALUES('${FILE}','${FILE}','n1','ai_agent','{"agent_id":"${agentId}"}'),('${TOOL}','${FILE}','n2','ai_agent','{"agent_id":"${agentId}"}');`);
    const list = await (await LIST()).json();
    expect(
      list.agents.find((a: { id: string }) => a.id === agentId).used_in_flows
    ).toBe(1);
    expect((await DELETE(req(undefined, 'DELETE'), ctx(agentId))).status).toBe(
      409
    );
    expect(
      (await DELETE(req(undefined, 'DELETE', '?force=true'), ctx(agentId)))
        .status
    ).toBe(400);
    state.failRead = true;
    expect((await DELETE(req(undefined, 'DELETE'), ctx(agentId))).status).toBe(
      500
    );
    state.failRead = false;
    await state.db!.exec('DELETE FROM wacrm.flow_nodes');
    // Agente já fixado num run (179): 409 específico, preserva o histórico (REVISAO-113 #7).
    await state.db!.exec(
      `CREATE TABLE wacrm.flow_run_agent_bindings(run_id uuid,account_id uuid,agent_id uuid);
       INSERT INTO wacrm.flow_run_agent_bindings VALUES('${FILE}','${A}','${agentId}');`
    );
    const used = await DELETE(req(undefined, 'DELETE'), ctx(agentId));
    expect(used.status).toBe(409);
    expect((await used.json()).error).toMatch(/desligue-o em vez de excluir/);
    await state.db!.exec('DROP TABLE wacrm.flow_run_agent_bindings');
    expect((await DELETE(req(undefined, 'DELETE'), ctx(agentId))).status).toBe(
      200
    );
    expect((await DETAIL(req(undefined, 'GET'), ctx(agentId))).status).toBe(
      404
    );
  });
  it('concorrência publica versões diferentes; nenhuma atualização in-place', async () => {
    const created = await (await CREATE(req(input('concorrente')))).json();
    const responses = await Promise.all([
      PUBLISH(req(versionBody()), ctx(created.agent_id)),
      PUBLISH(req(versionBody()), ctx(created.agent_id)),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(results.map((r) => r.version).sort()).toEqual([2, 3]);
    expect(new Set(results.map((r) => r.version_id)).size).toBe(2);
  });
  describe('agente convertido (legacy_v1 + ferramentas inline)', () => {
    const tool = (name: string) => ({
      name,
      description: 'inline ' + name,
      parameters: { type: 'object', properties: {}, required: [] },
      http: { url: 'https://api.exemplo.com/' + name, method: 'GET', headers: {}, body: '' },
    });
    async function seedLegacy(): Promise<string> {
      const converted = convertAiAgentNode(
        { mode: 'loop', system_prompt_override: 'PROMPT ORIGINAL DO FLUXO', tools: [tool('consulta_a'), tool('consulta_b')] } as never,
        { account_id: A, api_provider: 'openai', api_model: 'gpt-4o-mini', enabled: true, system_prompt: 'prompt da conta' },
        { node_key: 'ia' }
      );
      const row = await state.db!.query<{ id: string }>(
        "INSERT INTO wacrm.ai_agents(account_id,name) VALUES($1,$2) RETURNING id", [A, 'Convertido ' + Math.random()]
      );
      const id = row.rows[0].id;
      const v = await state.db!.query<{ id: string }>(
        "INSERT INTO wacrm.ai_agent_versions(account_id,agent_id,version,config,prompt_content,composition,config_hash) VALUES($1,$2,1,$3,$4,'legacy_v1',$5) RETURNING id",
        [A, id, JSON.stringify(converted.config), converted.prompt_content, converted.hash]
      );
      await state.db!.query('UPDATE wacrm.ai_agents SET published_version_id=$1 WHERE id=$2', [v.rows[0].id, id]);
      return id;
    }
    const bodyFrom = (detail: { published: { config: ReturnType<typeof input>['config']; prompt_content: string; composition: string } }) => ({
      config: structuredClone(detail.published.config),
      prompt_content: detail.published.prompt_content,
      composition: detail.published.composition,
      rules: [],
      tool_ids: [TOOL],
      knowledge: { selection_mode: 'legacy_account_all' },
    });
    it('salvar preserva as inline (ordem) e adiciona só a do catálogo', async () => {
      const id = await seedLegacy();
      const detail = await (await DETAIL(req(undefined, 'GET'), ctx(id))).json();
      const body = bodyFrom(detail);
      body.config.tools[1].enabled = false; // liga/desliga da inline é editável
      body.config.tools[0].definition!.description = 'tentativa de editar a definição';
      const response = await PUBLISH(req(body), ctx(id));
      expect(response.status).toBe(200);
      const next = await (await DETAIL(req(undefined, 'GET'), ctx(id))).json();
      const tools = next.published.config.tools;
      expect(tools.map((t: { definition?: { name: string }; tool_id?: string }) => t.definition?.name ?? t.tool_id)).toEqual([
        'consulta_a',
        'consulta_b',
        TOOL,
      ]);
      expect(tools[1].enabled).toBe(false);
      expect(tools[0].definition.description).toBe('inline consulta_a'); // a definição vem da versão anterior
      expect(next.published.tools.map((t: { id: string }) => t.id)).toEqual([TOOL]);
    });
    it('nova versão de agente legacy_v1 continua legacy_v1 com o MESMO prompt composto', async () => {
      const id = await seedLegacy();
      const detail = await (await DETAIL(req(undefined, 'GET'), ctx(id))).json();
      const body = bodyFrom(detail);
      body.config.llm.temperature = 0.3;
      expect((await PUBLISH(req(body), ctx(id))).status).toBe(200);
      const next = await (await DETAIL(req(undefined, 'GET'), ctx(id))).json();
      expect(next.published.version).toBe(2);
      expect(next.published.composition).toBe('legacy_v1');
      expect(next.published.config.llm.temperature).toBe(0.3);
      const compose = (p: typeof detail.published) =>
        composeAgentPrompt({ config: p.config, prompt_content: p.prompt_content, composition: p.composition }, { today_utc: '2026-01-01', current_date: '01/01/2026' });
      expect(compose(next.published)).toBe(compose(detail.published));
      expect(compose(next.published)).toContain('PROMPT ORIGINAL DO FLUXO');
    });
    it('legacy_v1 não vale para agente novo, agente sections_v1 nem com regras; converter para sections_v1 é permitido', async () => {
      expect((await CREATE(req({ ...input('x-legacy'), composition: 'legacy_v1' }))).status).toBe(400);
      const sections = await (await CREATE(req(input('so-sections')))).json();
      expect((await PUBLISH(req({ ...versionBody(), composition: 'legacy_v1' }), ctx(sections.agent_id))).status).toBe(400);
      const id = await seedLegacy();
      const detail = await (await DETAIL(req(undefined, 'GET'), ctx(id))).json();
      const withRules = { ...bodyFrom(detail), rules: [{ content: 'r', enabled: true }] };
      expect((await PUBLISH(req(withRules), ctx(id))).status).toBe(400);
      const converted = { ...bodyFrom(detail), composition: 'sections_v1', rules: [{ content: 'Regra nova', enabled: true }] };
      expect((await PUBLISH(req(converted), ctx(id))).status).toBe(200);
      const next = await (await DETAIL(req(undefined, 'GET'), ctx(id))).json();
      expect(next.published.composition).toBe('sections_v1');
      expect(next.published.config.tools.filter((t: { definition?: unknown }) => t.definition)).toHaveLength(2);
    });
  });
  it('agente de outra conta não pode ser lido, alterado, versionado ou apagado', async () => {
    const body = versionBody();
    body.config.legacy.account_id = B;
    body.config.rules = [];
    body.config.tools = [];
    body.config.knowledge.selection_mode = 'legacy_account_all';
    delete body.config.knowledge.file_ids;
    const row = await state.db!.query<{
      result: { agent_id: string; version_id: string };
    }>('SELECT wacrm.publish_ai_agent($1,$2,NULL,$3,$4) AS result', [
      B,
      USER,
      'outra-conta',
      JSON.stringify({ ...body, rules: [], config_hash: 'b'.repeat(64) }),
    ]);
    const id = row.rows[0].result.agent_id;
    expect((await DETAIL(req(undefined, 'GET'), ctx(id))).status).toBe(404);
    expect(
      (await PATCH(req({ enabled: false }, 'PATCH'), ctx(id))).status
    ).toBe(404);
    expect((await PUBLISH(req(versionBody()), ctx(id))).status).toBe(404);
    expect(
      (
        await ROLLBACK(
          req({ version_id: row.rows[0].result.version_id }),
          ctx(id)
        )
      ).status
    ).toBe(404);
    expect((await DELETE(req(undefined, 'DELETE'), ctx(id))).status).toBe(404);
    expect(
      (await (await LIST()).json()).agents.some(
        (a: { id: string }) => a.id === id
      )
    ).toBe(false);
  });
  it('RPC recusa tool cross-account e aborta todas as escritas intermediárias', async () => {
    const body = versionBody();
    body.config.tools = [{ tool_id: OTHER_TOOL, enabled: true }];
    body.config.rules = [];
    await expect(
      state.db!.query('SELECT wacrm.publish_ai_agent($1,$2,NULL,$3,$4)', [
        A,
        USER,
        'atomicidade',
        JSON.stringify({ ...body, rules: [], config_hash: 'a'.repeat(64) }),
      ])
    ).rejects.toThrow(/foreign key/);
    expect(
      (
        await state.db!.query(
          "SELECT id FROM wacrm.ai_agents WHERE name='atomicidade'"
        )
      ).rows
    ).toHaveLength(0);
  });
  it('RPCs sem execute para navegador; reapply após uso é idempotente', async () => {
    for (const role of ['anon', 'authenticated']) {
      await state.db!.exec('SET ROLE ' + role);
      try {
        await expect(
          state.db!.query('SELECT wacrm.delete_ai_agent($1,$2)', [A, TOOL])
        ).rejects.toThrow(/permission denied/);
        await expect(
          state.db!.query('SELECT wacrm.rollback_ai_agent($1,$2,$3,$4)', [
            A,
            USER,
            TOOL,
            FILE,
          ])
        ).rejects.toThrow(/permission denied/);
        await expect(
          state.db!.query('SELECT wacrm.publish_ai_agent($1,$2,NULL,$3,$4)', [
            A,
            USER,
            'privado',
            '{}',
          ])
        ).rejects.toThrow(/permission denied/);
      } finally {
        await state.db!.exec('RESET ROLE');
      }
    }
    await state.db!.exec('SET ROLE service_role');
    try {
      const body = versionBody();
      body.config.tools = [];
      body.config.rules = [];
      const r = await state.db!.query<{ result: { agent_id: string } }>(
        'SELECT wacrm.publish_ai_agent($1,$2,NULL,$3,$4) AS result',
        [
          A,
          USER,
          'service-role',
          JSON.stringify({ ...body, rules: [], config_hash: 'c'.repeat(64) }),
        ]
      );
      await state.db!.query('SELECT wacrm.delete_ai_agent($1,$2)', [
        A,
        r.rows[0].result.agent_id,
      ]);
    } finally {
      await state.db!.exec('RESET ROLE');
    }
    await state.db!.exec(
      readFileSync('supabase/migrations/180_ai_agent_api.sql', 'utf8').replace(
        /NOTIFY pgrst[^;]*;/g,
        ''
      )
    );
  });
});
