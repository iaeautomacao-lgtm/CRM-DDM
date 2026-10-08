// Confere os select(...) de whatsapp_config / channel_health das rotas e libs do disparador contra as colunas REAIS (extraídas das migrations).
// O hotfix #143 nasceu de colunas inexistentes (phone_number, display_name) que os mocks não pegaram.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_CONFIG_COLUMNS, CHANNEL_HEALTH_COLUMNS, CHANNEL_HEALTH_COLUMNS_LEGACY } from './channel-label';

const ROOT = process.cwd();
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const migrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8').replace(/--.*$/gm, ''));

const TABLE = (name: string) => `(?:wacrm\\.)?${name}`;

/** Colunas de um CREATE TABLE (primeira definição) + todos os ADD COLUMN dos ALTER TABLE da tabela. */
function columnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  for (const sql of migrations) {
    const create = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${TABLE(table)}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
    if (create) {
      for (const line of create[1].split('\n')) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s+(?:uuid|text|bigint|integer|int|boolean|numeric|timestamptz|timestamp|jsonb|bytea)/i.exec(line);
        if (m) cols.add(m[1].toLowerCase());
      }
    }
    for (const alter of sql.matchAll(new RegExp(`ALTER TABLE(?: ONLY)? ${TABLE(table)}\\b([^;]*);`, 'gi'))) {
      for (const add of alter[1].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) cols.add(add[1].toLowerCase());
    }
  }
  return cols;
}

const whatsappConfig = columnsOf('whatsapp_config');
const channelHealth = columnsOf('channel_health');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|test-helper/.test(name)) out.push(full);
  }
  return out;
}

/** Tokens de um select("a, b:c, d") → colunas reais (alias `b:c` conta `c`); ignora `*` e relações `x(...)`. */
function selectColumns(list: string): string[] {
  return list
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && t !== '*' && !t.includes('(') && !t.includes(')'))
    .map((t) => (t.includes(':') ? t.split(':')[1].trim() : t));
}

describe('colunas reais (migrations)', () => {
  it('o extrator enxerga as colunas conhecidas', () => {
    for (const c of ['id', 'phone_number_id', 'waba_id', 'account_id', 'provider', 'waha_session', 'habilitado', 'display_phone_number', 'team_id']) {
      expect(whatsappConfig.has(c), `whatsapp_config.${c}`).toBe(true);
    }
    for (const c of ['session_id', 'quality_rating', 'last_error', 'checked_at', 'verified_name', 'display_phone_number']) {
      expect(channelHealth.has(c), `channel_health.${c}`).toBe(true);
    }
    // As colunas que quebraram o #143 NÃO existem.
    expect(whatsappConfig.has('phone_number')).toBe(false);
    expect(whatsappConfig.has('display_name')).toBe(false);
  });

  it('as constantes do channel-label só usam colunas reais', () => {
    for (const c of selectColumns(CHANNEL_CONFIG_COLUMNS)) expect(whatsappConfig.has(c), `whatsapp_config.${c}`).toBe(true);
    for (const c of selectColumns(CHANNEL_HEALTH_COLUMNS)) expect(channelHealth.has(c), `channel_health.${c}`).toBe(true);
    for (const c of selectColumns(CHANNEL_HEALTH_COLUMNS_LEGACY)) expect(channelHealth.has(c), `channel_health.${c}`).toBe(true);
  });

  it('todo select de whatsapp_config / channel_health no disparador usa colunas reais', () => {
    const files = [...sourceFiles(resolve(ROOT, 'src/lib/disparador')), ...sourceFiles(resolve(ROOT, 'src/app/api/disparador')), ...sourceFiles(resolve(ROOT, 'src/app/api/v1/disparador'))];
    const re = /\.from\(\s*["'](whatsapp_config|channel_health)["']\s*\)\s*\.select\(\s*(["'`])([^"'`]*)\2/g;
    let checked = 0;
    const bad: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(re)) {
        checked++;
        const real = m[1] === 'whatsapp_config' ? whatsappConfig : channelHealth;
        for (const col of selectColumns(m[3])) {
          if (!real.has(col)) bad.push(`${file.replace(ROOT, '')}: ${m[1]}.${col}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(3);
    expect(bad).toEqual([]);
  });
});
