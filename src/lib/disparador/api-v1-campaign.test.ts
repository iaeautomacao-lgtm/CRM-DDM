import { describe, expect, it } from 'vitest';
import {
  INVALID_SAMPLE_LIMIT,
  normalizeApiContacts,
  placeholderIndexes,
  resolveApiDays,
  resolveIdempotency,
  resolveWahaMessage,
  scheduleApiContacts,
  validateApiPhone,
  validateApiWindow,
} from './api-v1-campaign';

const none = new Set<string>();
const JANELA = { inicio: '08:00', fim: '18:00', dias: [1, 2, 3, 4, 5] };

describe('validateApiWindow / resolveApiDays', () => {
  it('exige HH:MM e fim > início', () => {
    expect(validateApiWindow('08:00', '18:00')).toBeNull();
    expect(validateApiWindow('8h', '18:00')).toMatch(/HH:MM/);
    expect(validateApiWindow('24:00', '18:00')).toMatch(/HH:MM/);
    expect(validateApiWindow('18:00', '08:00')).toMatch(/depois/);
    expect(validateApiWindow('08:00', '08:00')).toMatch(/depois/);
    expect(validateApiWindow(undefined, '18:00')).toMatch(/HH:MM/);
  });

  it('dias úteis por padrão, igual à tela; valida lista', () => {
    expect(resolveApiDays(undefined)).toEqual({ days: [1, 2, 3, 4, 5] });
    expect(resolveApiDays([6, 0, 6])).toEqual({ days: [0, 6] });
    expect(resolveApiDays([])).toHaveProperty('error');
    expect(resolveApiDays([7])).toHaveProperty('error');
    expect(resolveApiDays('seg')).toHaveProperty('error');
  });
});

describe('validateApiPhone', () => {
  it('aceita E.164 7–15 dígitos e BR com 55 (12–13)', () => {
    expect(validateApiPhone('+55 11 99999-8888')).toEqual({ digits: '5511999998888' });
    expect(validateApiPhone('11999998888')).toEqual({ digits: '11999998888' });
    expect(validateApiPhone(5511999998888)).toEqual({ digits: '5511999998888' });
    expect(validateApiPhone('+370 63949836')).toEqual({ digits: '37063949836' });
  });
  it('rejeita vazio, lixo, curto, longo e 55 com tamanho errado', () => {
    expect(validateApiPhone('abc')).toEqual({ reason: 'missing_phone' });
    expect(validateApiPhone(null)).toEqual({ reason: 'missing_phone' });
    expect(validateApiPhone({})).toEqual({ reason: 'missing_phone' });
    expect(validateApiPhone('123')).toEqual({ reason: 'invalid_phone' });
    expect(validateApiPhone('1234567890123456')).toEqual({ reason: 'invalid_phone' });
    expect(validateApiPhone('0119999988')).toEqual({ reason: 'invalid_phone' });
    expect(validateApiPhone('551199998')).toEqual({ reason: 'invalid_phone' });
  });
});

describe('resolveWahaMessage (passada única)', () => {
  it('não interpreta $& nem $1 e não reexpande placeholders vindos do valor', () => {
    expect(resolveWahaMessage('Oi {{1}}, total {{2}}', ['$&', 'R$ 10 $1'])).toBe('Oi $&, total R$ 10 $1');
    expect(resolveWahaMessage('Oi {{1}} {{2}}', ['{{2}}', 'x'])).toBe('Oi {{2}} x');
  });
  it('placeholder sem valor → null (nunca sai {{n}} para o cliente)', () => {
    expect(resolveWahaMessage('Oi {{1}} {{2}}', ['Ana'])).toBeNull();
    expect(resolveWahaMessage('Oi {{1}}', [''])).toBeNull();
    expect(resolveWahaMessage('Sem variáveis', [])).toBe('Sem variáveis');
  });
  it('placeholderIndexes', () => {
    expect(placeholderIndexes('{{2}} {{1}} {{2}}')).toEqual([1, 2]);
  });
});

describe('normalizeApiContacts', () => {
  it('dedupe por phoneKey: com/sem 55 e com/sem 9º dígito; conta duplicates', () => {
    const r = normalizeApiContacts(
      [
        { phone: '+55 11 99999-8888' },
        { phone: '11999998888' },
        { phone: '5511 9999-8888' }, // mesmo celular sem o 9º dígito
        { phone: '+55 21 98888-7777' },
      ],
      { blacklist: none }
    );
    expect(r.contacts.map((c) => c.phone)).toEqual(['5511999998888', '5521988887777']);
    expect(r.duplicates).toBe(2);
    expect(r.invalid).toBe(0);
  });

  it('blacklist por phoneKey conta em skipped', () => {
    const r = normalizeApiContacts([{ phone: '11999998888' }, { phone: '11988887777' }], {
      blacklist: new Set(['11' + '99998888']),
    });
    expect(r.skipped).toBe(1);
    expect(r.contacts).toHaveLength(1);
  });

  it('inválidos: null, não-objeto, sem telefone, telefone ruim — com amostra limitada a 20', () => {
    const r = normalizeApiContacts([null, 'x', [], {}, { phone: 'abc' }, { phone: '123' }, { phone: '11999998888' }], {
      blacklist: none,
    });
    expect(r.invalid).toBe(6);
    expect(r.invalidSample.map((s) => s.reason)).toEqual([
      'invalid_contact',
      'invalid_contact',
      'invalid_contact',
      'missing_phone',
      'missing_phone',
      'invalid_phone',
    ]);
    expect(r.contacts).toHaveLength(1);

    const many = normalizeApiContacts(Array.from({ length: 50 }, () => null), { blacklist: none });
    expect(many.invalid).toBe(50);
    expect(many.invalidSample).toHaveLength(INVALID_SAMPLE_LIMIT);
  });

  it('WAHA: variável faltante vira missing_variable e não é enfileirada', () => {
    const r = normalizeApiContacts(
      [
        { phone: '11999998888', variables: ['Ana', 'R$ 5'] },
        { phone: '11988887777', variables: ['Bia'] },
        { phone: '11977776666' },
      ],
      { blacklist: none, wahaMessage: 'Oi {{1}}, {{2}}' }
    );
    expect(r.contacts).toHaveLength(1);
    expect(r.invalid).toBe(2);
    expect(r.invalidSample.every((s) => s.reason === 'missing_variable')).toBe(true);
  });

  it('Meta (sem wahaMessage) não exige variáveis; números viram texto', () => {
    const r = normalizeApiContacts([{ phone: '11999998888', variables: [1, null, 'x'] }], { blacklist: none });
    expect(r.contacts[0].variables).toEqual(['1', '', 'x']);
  });
});

describe('scheduleApiContacts (relógio de janela)', () => {
  const opts = (now: string, over: Partial<{ slotSize: number; slotIntervalMs: number }> = {}) => ({
    now: new Date(now),
    slotSize: 1000,
    slotIntervalMs: 30 * 60_000,
    janela: JANELA,
    ...over,
  });

  it('criada às 20h (BRT) com janela 08–18: 1º slot às 08:00 do próximo dia útil', () => {
    // 2026-10-07 (quarta) 20:00 BRT = 23:00Z
    const [first] = scheduleApiContacts(1, opts('2026-10-07T23:00:00Z'));
    const diffFrom8 = first.getTime() - new Date('2026-10-08T11:00:00Z').getTime();
    expect(diffFrom8).toBeGreaterThanOrEqual(0);
    expect(diffFrom8).toBeLessThan(2000);
  });

  it('sexta à noite → segunda 08:00', () => {
    const [first] = scheduleApiContacts(1, opts('2026-10-09T23:00:00Z'));
    expect(first.toISOString().slice(0, 13)).toBe('2026-10-12T11');
  });

  it('slots espaçados na janela, sem rajada: 08:00, 08:30, 09:00', () => {
    const times = scheduleApiContacts(5, opts('2026-10-07T23:00:00Z', { slotSize: 2 }));
    const base = new Date('2026-10-08T11:00:00Z').getTime();
    const slotOf = (t: Date) => Math.round((t.getTime() - base) / 60_000);
    expect(times.map(slotOf)).toEqual([0, 0, 30, 30, 60]);
  });

  it('o que passa das 18:00 continua no próximo dia útil mantendo o espaçamento', () => {
    // Quarta 17:30 BRT (20:30Z): slot0 17:30, slot1 18:00 → fecha → quinta 08:00 (+0 restante)
    const times = scheduleApiContacts(3, opts('2026-10-07T20:30:00Z', { slotSize: 1, slotIntervalMs: 45 * 60_000 }));
    const ms = times.map((t) => t.getTime());
    expect(new Date(ms[0]).toISOString().slice(0, 16)).toBe('2026-10-07T20:30');
    // 30 min restantes até 18:00 + 15 min depois da abertura de quinta (08:15 BRT = 11:15Z)
    expect(new Date(ms[1]).toISOString().slice(0, 16)).toBe('2026-10-08T11:15');
    expect(new Date(ms[2]).toISOString().slice(0, 16)).toBe('2026-10-08T12:00');
    expect(ms[1]).toBeLessThan(ms[2]);
  });

  it('dentro da janela começa agora', () => {
    const [first] = scheduleApiContacts(1, opts('2026-10-07T15:00:00Z'));
    expect(first.getTime() - new Date('2026-10-07T15:00:00Z').getTime()).toBeLessThan(2000);
  });
});

describe('resolveIdempotency', () => {
  const body = { campaign_name: 'x', contacts: [{ phone: '1' }] };
  it('sem chave: key null (comportamento antigo)', () => {
    expect(resolveIdempotency(null, undefined, body).key).toBeNull();
    expect(resolveIdempotency('', undefined, body).key).toBeNull();
  });
  it('header e external_id (external_id vence); hash estável por conteúdo', () => {
    expect(resolveIdempotency('abcdefgh-1', undefined, body).key).toBe('idem:abcdefgh-1');
    expect(resolveIdempotency('abcdefgh-1', 'PLAN-9', body).key).toBe('ext:PLAN-9');
    const a = resolveIdempotency(null, 'p', { a: 1, b: [1, 2] }).hash;
    expect(resolveIdempotency(null, 'p', { b: [1, 2], a: 1 }).hash).toBe(a);
    expect(resolveIdempotency(null, 'p', { a: 2, b: [1, 2] }).hash).not.toBe(a);
  });
  it('valida formato', () => {
    expect(resolveIdempotency('curta', undefined, body).error).toBeTruthy();
    expect(resolveIdempotency(null, 'com espaço', body).error).toBeTruthy();
    expect(resolveIdempotency(null, 42, body).error).toBeTruthy();
  });
});
