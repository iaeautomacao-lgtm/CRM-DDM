// Migration 187/187b: disp_message_queue.erro_codigo mantido por trigger + backfill em lotes + índice parcial.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { extrairCodigoMetaErro } from './normalize-meta-error';

let db: PGlite;
const file = (name: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const uid = (n: number) => `00000000-0000-0000-0000-${String(1000000 + n).padStart(12, '0')}`;
const camp = '00000000-0000-0000-0000-0000000000c1';

const codeOf = async (n: number) =>
  (await db.query<{ erro_codigo: number | null }>(`SELECT erro_codigo FROM wacrm.disp_message_queue WHERE id='${uid(n)}'`)).rows[0].erro_codigo;
const insert = (n: number, erro: string | null, status = 'erro') =>
  db.query(`INSERT INTO wacrm.disp_message_queue(id, campaign_id, status, erro, updated_at) VALUES ($1,$2,$3,$4, '2026-01-01T00:00:00Z')`, [uid(n), camp, status, erro]);

describe('migration 187 — erro_codigo', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid, status text, erro text, updated_at timestamptz DEFAULT now()
      );
    `);
    const sql = file('187_disp_queue_erro_codigo.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    // O trigger não dispara em TRUNCATE.
    await db.exec('TRUNCATE wacrm.disp_message_queue');
  });

  it('o extrator SQL dá o MESMO resultado de extrairCodigoMetaErro (JS) em todos os formatos de texto', async () => {
    const samples = [
      'Meta: Message undeliverable (code 131026)',
      '(#131049) Mensagem não entregue',
      'Meta: Re-engagement message (code 131047)',
      'WAHA sendText failed (400): inválido',
      'Resultado externo não confirmado; encerrado sem reenvio para evitar duplicidade',
      'Janela de 24h encerrada — use um template aprovado para este contato',
      'Contato sem telefone válido',
      'code 12 e depois (#999)',
      '(#190) token (code 131008)',
      null,
      '',
    ];
    for (const erro of samples) {
      const sql = (await db.query<{ c: number | null }>('SELECT wacrm.extract_meta_error_code($1) AS c', [erro])).rows[0].c;
      expect(sql, String(erro)).toBe(extrairCodigoMetaErro(erro));
    }
  });

  describe('trigger: todo caminho que grava erro preenche erro_codigo', () => {
    it('INSERT (ex.: janela 24h / variável vazia na montagem da fila)', async () => {
      await insert(1, 'Meta: x (code 132001)');
      await insert(2, 'Contato sem telefone válido');
      await insert(3, null, 'agendado');
      expect(await codeOf(1)).toBe(132001);
      expect(await codeOf(2)).toBeNull();
      expect(await codeOf(3)).toBeNull();
    });

    it('UPDATE de erro (markQueueError, watchdog, apply_dispatch_status, 131026…) recalcula; erro limpo zera', async () => {
      await insert(1, null, 'enviando');
      await db.exec(`UPDATE wacrm.disp_message_queue SET status='erro', erro='Meta: Message undeliverable (code 131026)' WHERE id='${uid(1)}'`);
      expect(await codeOf(1)).toBe(131026);
      await db.exec(`UPDATE wacrm.disp_message_queue SET erro='Resultado externo não confirmado; encerrado sem reenvio' WHERE id='${uid(1)}'`);
      expect(await codeOf(1)).toBeNull(); // texto novo sem código não herda o antigo
      await db.exec(`UPDATE wacrm.disp_message_queue SET erro='(#131049) x' WHERE id='${uid(1)}'`);
      expect(await codeOf(1)).toBe(131049);
      await db.exec(`UPDATE wacrm.disp_message_queue SET status='enviado', erro=NULL WHERE id='${uid(1)}'`);
      expect(await codeOf(1)).toBeNull();
    });

    it('UPDATE que não mexe em erro (claim, confirmação, status) não recalcula nem custa nada', async () => {
      await insert(1, 'Meta: x (code 131056)');
      await db.exec(`UPDATE wacrm.disp_message_queue SET status='agendado' WHERE id='${uid(1)}'`);
      expect(await codeOf(1)).toBe(131056);
    });
  });

  describe('backfill em lotes (nunca um UPDATE único)', () => {
    async function seedHistory(n: number) {
      // Linhas "antigas": inseridas antes do trigger (simulado desligando-o durante a carga).
      await db.exec('ALTER TABLE wacrm.disp_message_queue DISABLE TRIGGER trg_disp_queue_erro_codigo');
      for (let i = 1; i <= n; i++) {
        const erro = i % 3 === 0 ? 'Contato sem telefone válido' : i % 3 === 1 ? `Meta: x (code ${131000 + (i % 50)})` : `(#${132000 + (i % 7)}) y`;
        await insert(i, erro);
      }
      await insert(n + 1, null, 'agendado');
      await db.exec('ALTER TABLE wacrm.disp_message_queue ENABLE TRIGGER trg_disp_queue_erro_codigo');
    }

    it('percorre por cursor de id, em lotes, até acabar; preenche só quem tem código; preserva updated_at', async () => {
      await seedHistory(100);
      let after: string | null = null;
      let batches = 0;
      let scanned = 0;
      let updated = 0;
      for (;;) {
        const r: { scanned: number; updated: number; last_id: string | null } = (
          await db.query<{ scanned: number; updated: number; last_id: string | null }>('SELECT * FROM wacrm.backfill_erro_codigo($1, $2)', [30, after])
        ).rows[0];
        batches++;
        scanned += r.scanned;
        updated += r.updated;
        expect(r.scanned).toBeLessThanOrEqual(30); // nunca mais que o lote
        if (!r.last_id || r.scanned < 30) break;
        after = r.last_id;
      }
      expect(batches).toBe(4); // 100 linhas com erro em lotes de 30 (o item sem erro nem entra)
      expect(scanned).toBe(100);
      expect(updated).toBe(100 - 33); // 33 linhas "sem código" ficam NULL
      const nulls = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wacrm.disp_message_queue WHERE erro IS NOT NULL AND erro_codigo IS NULL')).rows[0].n;
      expect(nulls).toBe(33);
      const bumped = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM wacrm.disp_message_queue WHERE updated_at <> '2026-01-01T00:00:00Z'")).rows[0].n;
      expect(bumped).toBe(0);
      expect(await codeOf(1)).toBe(131001);
    });

    it('idempotente: rodar de novo não muda nada e (sem cursor) só reescaneia o que ainda não tem código', async () => {
      await seedHistory(40);
      await db.query('SELECT * FROM wacrm.backfill_erro_codigo($1, NULL)', [1000]);
      const again = (await db.query<{ updated: number }>('SELECT * FROM wacrm.backfill_erro_codigo($1, NULL)', [1000])).rows[0];
      expect(again.updated).toBe(0);
    });

    it('sem nada a fazer: last_id nulo', async () => {
      const r = (await db.query<{ scanned: number; last_id: string | null }>('SELECT * FROM wacrm.backfill_erro_codigo(100, NULL)')).rows[0];
      expect(r).toEqual({ scanned: 0, updated: 0, last_id: null });
    });
  });

  it('só service_role executa as funções novas', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query('SELECT * FROM wacrm.backfill_erro_codigo(10, NULL)')).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('RESET ROLE');
      }
    }
  });

  describe('187b — índice parcial (arquivo próprio, CONCURRENTLY)', () => {
    it('cria o índice válido e parcial em status=erro; idempotente; sem transação no arquivo', async () => {
      const sql = file('187b_disp_queue_erro_codigo_index.sql');
      expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_erro_codigo/);
      expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
      await db.exec(sql);
      await db.exec(sql);
      const idx = (
        await db.query<{ indisvalid: boolean; def: string }>(
          "SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = 'wacrm.idx_dmq_erro_codigo'::regclass",
        )
      ).rows[0];
      expect(idx.indisvalid).toBe(true);
      expect(idx.def).toMatch(/campaign_id, erro_codigo, updated_at DESC/);
      expect(idx.def).toMatch(/WHERE \(status = 'erro'::text\)/);
    });
  });
});
