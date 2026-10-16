// Banco da bancada LOCAL do worker, em processo próprio, com um mini "PostgREST" em socket local (JSON por linha). Só 127.0.0.1; nada aqui
// conversa com Supabase, rede externa ou segredo.
//
// Dois modos (BENCH_DB):
//   pglite (padrão)  PGlite (Postgres em WASM) com as migrations REAIS do claim, dos leases e do balde (118, 125, 159, 164, 167, 188, 366,
//                    367, 368). É o SQL de produção, mas PGlite tem UMA conexão (chamadas em série) e é mais lento que Postgres nativo:
//                    por isso o tempo de SERVIÇO (dentro do banco, sem fila) é medido à parte do tempo visto pelo cliente (com fila).
//   memory           as mesmas RPCs em JS (balde GCRA, fencing, vagas, confirmação), sem custo de banco. Serve para isolar a CPU do worker
//                    da CPU do PGlite (quantos números cabem por núcleo). NÃO prova o SQL.
//
// Protocolo: cada linha é {id, op, ...}; a resposta é {id, ...}. op = 'rpc' {fn, args} | 'seed' {...} | 'summary' | 'stats' {reset}.
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PGlite } from '@electric-sql/pglite';

const MEMORY = process.env.BENCH_DB === 'memory';

const MIGRATIONS = [
  '118_dispatch_safety.sql',
  '125_pending_dispatch_receipts.sql',
  '159_dispatch_auto_pause_receipts_cleanup.sql',
  '164_dispatch_throughput.sql',
  '167_dispatch_claim_o1_retry_receipts.sql',
  '188_dispatch_batch_claim_confirm.sql',
  '366_dispatch_engine_flags.sql',
  '367_dispatch_worker_leases.sql',
  '368_dispatch_send_bucket.sql',
];

// Tabelas que as migrations assumem (mesmo molde dos testes PGlite 188/368). As funções e índices vêm das migrations reais.
const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA wacrm;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
  CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY);
  CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION wacrm.has_perm(p_key text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE TABLE wacrm.campaigns (
    id uuid PRIMARY KEY, account_id uuid, status text, limite_por_hora int,
    batch_pause_seconds int, updated_at timestamptz, next_batch_at timestamptz
  );
  CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, name text, phone text, company text);
  CREATE TABLE wacrm.disp_message_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid REFERENCES wacrm.campaigns, account_id uuid,
    session_id uuid, contact_id uuid, mensagem_final text,
    status text, scheduled_at timestamptz, updated_at timestamptz, sent_at timestamptz,
    created_at timestamptz DEFAULT now(), waha_message_id text, tentativas int DEFAULT 0,
    erro_permanente boolean DEFAULT false, erro text
  );
  CREATE TABLE wacrm.blacklist (id serial PRIMARY KEY, account_id uuid, telefone text);
  CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text, message_id text UNIQUE);
  CREATE TABLE wacrm.contact_import_variables (id serial PRIMARY KEY, campaign_id uuid, draft_id uuid);
  CREATE TABLE wacrm.message_logs (queue_id uuid, campaign_id uuid, contact_id uuid, session_id uuid, direcao text, mensagem text, status text, waha_message_id text);
  CREATE TABLE wacrm.campaign_metrics (campaign_id uuid PRIMARY KEY, total_enviados int DEFAULT 0, total_entregues int DEFAULT 0, total_lidos int DEFAULT 0, total_erros int DEFAULT 0);
  CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES (p_campaign_id) ON CONFLICT DO NOTHING;
    EXECUTE format('UPDATE wacrm.campaign_metrics SET %I=%I+1 WHERE campaign_id=$1', p_field, p_field) USING p_campaign_id;
  END $$;
  CREATE TABLE wacrm.meta_131026_calls (account_id uuid, telefone text, campaign_id uuid);
  CREATE FUNCTION wacrm.record_meta_131026_failure(p_account_id uuid, p_telefone text, p_campaign_id uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO wacrm.meta_131026_calls VALUES (p_account_id, p_telefone, p_campaign_id); $$;
`;

let db = null;
let retSet = new Map();
if (!MEMORY) {
  db = new PGlite();
  await db.exec(BOOTSTRAP);
  for (const file of MIGRATIONS) {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
  }
  // Funções que devolvem conjunto (PostgREST responde lista) × escalar (responde o valor).
  retSet = new Map(
    (await db.query(`SELECT p.proname, p.proretset FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm'`)).rows.map((r) => [r.proname, r.proretset]),
  );
}

// Fila única de execução (o PGlite é uma conexão): o tempo de serviço é medido só dentro do turno de cada chamada.
let chain = Promise.resolve();
const service = new Map(); // fn -> number[] (ms)
let busyMs = 0;
let startedAt = performance.now();
const exclusive = (task) => {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
};
const record = (key, ms) => {
  busyMs += ms;
  let list = service.get(key);
  if (!list) service.set(key, (list = []));
  if (list.length < 200_000) list.push(ms);
};

// Vetor de texto vira literal de array do Postgres; qualquer outra coisa estruturada vai como JSON (jsonb).
const encode = (value) => {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return `{${value.map((v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
};

const err = (e) => ({ message: e instanceof Error ? e.message : String(e), code: e?.code });
const FN = /^[a-z_0-9]+$/;

// ── modo memory: as RPCs do worker em JS ────────────────────────────────────
const mem = { numbers: new Map(), leases: new Map(), confirmedIds: new Set(), duplicates: 0, confirmed: 0 };
const memory = {
  seed({ numbers, rowsPerNumber }) {
    for (const n of numbers) mem.numbers.set(n.sessionId, { campaignId: n.campaignId, pending: rowsPerNumber, seq: 0, inFlight: 0, nextSlotMs: 0, unclaimed: 0 });
  },
  acquire_dispatch_leases: ({ p_owner, p_session_ids }) => (p_session_ids.forEach((id) => mem.leases.set(id, p_owner)), p_session_ids),
  renew_dispatch_leases: ({ p_owner, p_session_ids }) => p_session_ids.filter((id) => mem.leases.get(id) === p_owner),
  release_dispatch_leases: ({ p_owner }) => {
    let n = 0;
    for (const [id, owner] of mem.leases) if (owner === p_owner) (mem.leases.delete(id), n++);
    return n;
  },
  count_due_dispatch_items: ({ p_campaign_ids, p_limit }) =>
    [...mem.numbers].filter(([, s]) => p_campaign_ids.includes(s.campaignId)).map(([sessionId, s]) => ({ campaign_id: s.campaignId, session_id: sessionId, n: Math.min(p_limit, s.pending) })),
  // Mesma regra de reserve_send_slots (368): GCRA, rajada de 1 s; ficha não usada volta ao balde.
  claim_dispatch_batch_rated: ({ p_session_id, p_n, p_default_max_in_flight, p_rate, p_owner }) => {
    const s = mem.numbers.get(p_session_id);
    if (!s || (p_owner && mem.leases.get(p_session_id) !== p_owner)) return [{ item: null, outcome: 'not_owner' }];
    const now = Date.now();
    const n = Math.min(Math.max(p_n ?? 1, 1), 200);
    let granted = n;
    if (p_rate > 0) {
      const start = Math.max(s.nextSlotMs, now - 1000);
      granted = Math.min(n, Math.floor(((now - start) / 1000) * p_rate));
      if (granted <= 0) return [{ item: null, outcome: 'throttled' }];
      s.nextSlotMs = start + (granted / p_rate) * 1000;
    }
    const free = Math.max(0, (p_default_max_in_flight ?? 4) - s.inFlight);
    const take = Math.min(granted, free, s.pending);
    if (p_rate > 0 && granted > take) s.nextSlotMs = Math.max(s.nextSlotMs - ((granted - take) / p_rate) * 1000, now - 1000);
    if (take <= 0) return [{ item: null, outcome: 'empty' }];
    const rows = [];
    for (let i = 0; i < take; i++) {
      s.seq++;
      rows.push({ item: { id: `${p_session_id}:${s.seq}`, campaign_id: s.campaignId, session_id: p_session_id, contact_id: null, mensagem_final: `5511${String(s.seq).padStart(9, '0')}`, tentativas: 0, status: 'enviando' }, outcome: 'claimed' });
    }
    s.pending -= take;
    s.inFlight += take;
    return rows;
  },
  confirm_dispatch_items_sent: ({ p_items }) =>
    p_items.map((it) => {
      const s = mem.numbers.get(it.p_session_id);
      if (s) s.inFlight--;
      if (mem.confirmedIds.has(it.p_item_id)) mem.duplicates++;
      mem.confirmedIds.add(it.p_item_id);
      mem.confirmed++;
      return { item_id: it.p_item_id, ok: true, error: null };
    }),
  unclaim_dispatch_items: ({ p_ids }) => {
    for (const id of p_ids) {
      const s = mem.numbers.get(id.slice(0, id.lastIndexOf(':')));
      if (s) (s.inFlight--, s.pending++, s.unclaimed++);
    }
    return p_ids.length;
  },
};

async function handle(req) {
  if (req.op === 'rpc') {
    if (MEMORY) {
      const impl = memory[req.fn];
      if (!impl) return { error: { message: `função desconhecida: ${req.fn}`, code: 'PGRST202' } };
      const t = performance.now();
      const data = impl(req.args ?? {});
      record(req.fn, performance.now() - t);
      return { data, error: null };
    }
    if (!FN.test(req.fn) || !retSet.has(req.fn)) return { error: { message: `função desconhecida: ${req.fn}`, code: 'PGRST202' } };
    const keys = Object.keys(req.args ?? {}).filter((k) => FN.test(k));
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const params = keys.map((k) => encode(req.args[k]));
    const sql = retSet.get(req.fn) ? `SELECT * FROM wacrm.${req.fn}(${named})` : `SELECT wacrm.${req.fn}(${named}) AS v`;
    return exclusive(async () => {
      const t = performance.now();
      try {
        const res = await db.query(sql, params);
        record(req.fn, performance.now() - t);
        return { data: retSet.get(req.fn) ? res.rows : (res.rows[0]?.v ?? null), error: null };
      } catch (e) {
        record(`${req.fn}:erro`, performance.now() - t);
        return { data: null, error: err(e) };
      }
    });
  }
  if (req.op === 'seed') {
    if (MEMORY) return memory.seed(req), { error: null };
    return exclusive(async () => {
      try {
        await db.exec(`INSERT INTO wacrm.accounts VALUES ('${req.account}')`);
        for (const n of req.numbers) {
          await db.exec(`
            INSERT INTO wacrm.whatsapp_config VALUES ('${n.sessionId}');
            INSERT INTO wacrm.campaigns(id, account_id, status, limite_por_hora) VALUES ('${n.campaignId}', '${req.account}', 'em_execucao', NULL);
            INSERT INTO wacrm.dispatch_channel_ownership (session_id, account_id, mode) VALUES ('${n.sessionId}', '${req.account}', 'worker');
            INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, scheduled_at, mensagem_final)
              SELECT gen_random_uuid(), '${n.campaignId}', '${req.account}', '${n.sessionId}', 'agendado', now() - interval '1 hour' + g * interval '1 millisecond', '5511' || lpad(g::text, 9, '0')
              FROM generate_series(1, ${Number(req.rowsPerNumber)}) g;`);
        }
        await db.exec('ANALYZE wacrm.disp_message_queue');
        return { error: null };
      } catch (e) {
        return { error: err(e) };
      }
    });
  }
  if (req.op === 'summary') {
    if (MEMORY) {
      const pending = [...mem.numbers.values()].reduce((a, s) => a + s.pending, 0);
      return { statuses: [{ status: 'agendado', n: pending }, { status: 'enviando', n: [...mem.numbers.values()].reduce((a, s) => a + s.inFlight, 0) }, { status: 'confirmado', n: mem.confirmed }], duplicates: mem.duplicates };
    }
    return exclusive(async () => {
      const statuses = (await db.query('SELECT status, count(*)::int AS n FROM wacrm.disp_message_queue GROUP BY 1 ORDER BY 1')).rows;
      const dup = await db.query('SELECT count(*)::int AS n FROM (SELECT waha_message_id FROM wacrm.disp_message_queue WHERE waha_message_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d');
      return { statuses, duplicates: dup.rows[0].n };
    });
  }
  if (req.op === 'stats') {
    const usage = process.cpuUsage();
    const out = {
      mode: MEMORY ? 'memory' : 'pglite',
      uptime_s: (performance.now() - startedAt) / 1000,
      busy_s: busyMs / 1000,
      cpu_ms: (usage.user + usage.system) / 1000,
      rss_mb: process.memoryUsage().rss / 1048576,
      service: Object.fromEntries([...service].map(([k, v]) => [k, v])),
    };
    if (req.reset) {
      service.clear();
      busyMs = 0;
      startedAt = performance.now();
    }
    return out;
  }
  return { error: { message: `op desconhecida: ${req.op}` } };
}

const server = createServer((socket) => {
  socket.setNoDelay(true);
  const lines = createInterface({ input: socket });
  lines.on('line', (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    Promise.resolve(handle(req)).then(
      (res) => !socket.destroyed && socket.write(`${JSON.stringify({ id: req.id, ...res })}\n`),
      (e) => !socket.destroyed && socket.write(`${JSON.stringify({ id: req.id, error: err(e) })}\n`),
    );
  });
  socket.on('error', () => undefined);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`READY ${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
