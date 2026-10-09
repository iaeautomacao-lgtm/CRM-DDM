// Confere os select(...) de whatsapp_config / channel_health das rotas e libs do disparador contra as colunas REAIS (extraídas das migrations).
// O hotfix #143 nasceu de colunas inexistentes (phone_number, display_name) que os mocks não pegaram.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_CONFIG_COLUMNS, CHANNEL_HEALTH_COLUMNS, CHANNEL_HEALTH_COLUMNS_LEGACY } from './channel-label';
import { INBOX_CHANNEL_COLUMNS } from '../whatsapp/message-inbox-runner';
import { columnsOf, selectColumns } from '../../test/db-columns';

const ROOT = process.cwd();
// Extrator de colunas (migrations) compartilhado com os mocks de banco: src/test/db-columns.ts.
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
    // Inbox de mensagens da Meta (migration 201): o drenador lê estas colunas de whatsapp_config.
    for (const c of selectColumns(INBOX_CHANNEL_COLUMNS)) expect(whatsappConfig.has(c), `whatsapp_config.${c}`).toBe(true);
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
