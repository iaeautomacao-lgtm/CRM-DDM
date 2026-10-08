import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_POLICY,
  autoTargetRate,
  dailyLimitForTier,
  derivedSlots,
  effectiveRate,
  isDowngrade,
  nextAutoState,
  normalizeQuality,
  phoneDigits,
  policyFromRow,
  rampedAuto,
} from './channel-rate';

const P = DEFAULT_RATE_POLICY;
const T0 = Date.parse('2026-10-08T12:00:00Z');
const sec = (n: number) => T0 + n * 1000;

describe('política e alvo por qualidade (decisões do dono)', () => {
  it('verde 80/s, amarelo 40/s, vermelho 8/s, desconhecido 5/s', () => {
    expect(autoTargetRate(P, 'GREEN')).toBe(80);
    expect(autoTargetRate(P, 'YELLOW')).toBe(40);
    expect(autoTargetRate(P, 'RED')).toBe(8);
    expect(autoTargetRate(P, 'UNKNOWN')).toBe(5);
  });
  it('qualidade fora da lista = UNKNOWN (nunca assume verde)', () => {
    expect(normalizeQuality('green')).toBe('GREEN');
    expect(normalizeQuality(' Red ')).toBe('RED');
    for (const v of [null, undefined, '', 'NA', 'PURPLE', 5]) expect(normalizeQuality(v)).toBe('UNKNOWN');
  });
  it('respeita teto físico e piso da política; linha ausente = padrão', () => {
    expect(autoTargetRate({ ...P, max: 50 }, 'GREEN')).toBe(50);
    expect(autoTargetRate({ ...P, floor: 10, red: 3 }, 'RED')).toBe(10);
    expect(policyFromRow(null)).toEqual(P);
    expect(policyFromRow({ green_rate: '120', red_requires_owner_confirmation: false, max_rate_per_second: 200 })).toMatchObject({
      green: 120, max: 200, red: 8, redRequiresOwnerConfirmation: false,
    });
  });
  it('rebaixamento: GREEN→YELLOW→RED piora; UNKNOWN só conta vindo de cor conhecida', () => {
    expect(isDowngrade('GREEN', 'YELLOW')).toBe(true);
    expect(isDowngrade('YELLOW', 'RED')).toBe(true);
    expect(isDowngrade('RED', 'GREEN')).toBe(false);
    expect(isDowngrade('GREEN', 'GREEN')).toBe(false);
    expect(isDowngrade(null, 'RED')).toBe(false);
    expect(isDowngrade('GREEN', 'UNKNOWN')).toBe(true);
  });
});

describe('rampa: sobe +25% a cada 60 s e nunca salta para 80; desce na hora', () => {
  it('número novo começa devagar (5/s) e sobe em degraus', () => {
    const state = nextAutoState(null, 80, P, T0);
    expect(state).toMatchObject({ auto_rate_per_second: 80, auto_ramp_from: 5 });
    const at = (s: number) => rampedAuto(state, P, sec(s));
    expect(at(0)).toBe(5);
    expect(at(59)).toBe(5);
    expect(at(60)).toBe(6.25);
    expect(at(120)).toBe(7.81);
    expect(at(600)).toBeLessThan(80);
    expect(at(60 * 13)).toBe(80); // chega no alvo e para
    expect(at(60 * 60)).toBe(80);
  });

  it('melhora de YELLOW(40) para GREEN(80): parte do efetivo atual, não do alvo', () => {
    const yellow = nextAutoState({ auto_rate_per_second: 40 }, 40, P, T0);
    const up = nextAutoState(yellow, 80, P, T0);
    expect(up).toMatchObject({ auto_rate_per_second: 80, auto_ramp_from: 40 });
    expect(rampedAuto(up, P, sec(0))).toBe(40);
    expect(rampedAuto(up, P, sec(60))).toBe(50);
    expect(rampedAuto(up, P, sec(120))).toBe(62.5);
    expect(rampedAuto(up, P, sec(180))).toBe(78.13);
    expect(rampedAuto(up, P, sec(240))).toBe(80);
  });

  it('piora: desce imediatamente, sem rampa', () => {
    const green = { auto_rate_per_second: 80 };
    const down = nextAutoState(green, 8, P, T0);
    expect(down).toEqual({ auto_rate_per_second: 8, auto_ramp_from: null, auto_ramp_started_at: null });
    expect(rampedAuto(down, P, sec(0))).toBe(8);
  });

  it('a mesma leitura não reinicia a rampa em andamento', () => {
    const state = nextAutoState(null, 80, P, T0);
    const again = nextAutoState(state, 80, P, sec(120));
    expect(again).toMatchObject({ auto_rate_per_second: 80, auto_ramp_from: 5 });
    expect(Date.parse(again.auto_ramp_started_at!)).toBe(T0);
  });

  it('durante a queda de um alvo ainda em rampa, o efetivo atual (não o alvo antigo) é a referência', () => {
    const state = nextAutoState(null, 80, P, T0); // efetivo ~7,81 em 120 s
    const mid = nextAutoState(state, 40, P, sec(120)); // alvo 40 > efetivo 7,81: continua subindo, agora até 40
    expect(mid).toMatchObject({ auto_rate_per_second: 40, auto_ramp_from: 7.81 });
    const drop = nextAutoState(state, 5, P, sec(120)); // alvo 5 < 7,81: cai já
    expect(drop.auto_ramp_from).toBeNull();
  });
});

describe('efetivo = manual ?? auto, com a trava de segurança', () => {
  const state = (over: Record<string, unknown> = {}) => ({ auto_rate_per_second: 80, ...over });

  it('sem manual: vale o automático (com rampa)', () => {
    const e = effectiveRate(state({ auto_ramp_from: 20, auto_ramp_started_at: new Date(T0).toISOString() }), P, sec(60));
    expect(e).toMatchObject({ rate: 25, source: 'auto', ramping: true, target: 80 });
  });

  it('manual abaixo do automático vale (admin reduz)', () => {
    expect(effectiveRate(state({ manual_rate_per_second: 30 }), P, sec(0))).toMatchObject({ rate: 30, source: 'manual' });
  });

  it('qualidade piora e auto < manual: vale min(manual, auto) — a trava', () => {
    const e = effectiveRate(state({ auto_rate_per_second: 8, manual_rate_per_second: 60 }), P, sec(0));
    expect(e).toMatchObject({ rate: 8, source: 'manual_capped_by_quality' });
  });

  it('force_above_quality (só owner decide) mantém o manual acima da qualidade — mas nunca acima do teto físico', () => {
    const e = effectiveRate(state({ auto_rate_per_second: 8, manual_rate_per_second: 60, force_above_quality: true }), P, sec(0));
    expect(e).toMatchObject({ rate: 60, source: 'manual' });
    expect(effectiveRate(state({ auto_rate_per_second: 8, manual_rate_per_second: 500, force_above_quality: true }), P, sec(0)).rate).toBe(80);
  });

  it('o sistema nunca sobe sozinho acima de um manual: ao melhorar, a rampa sobe mas o efetivo para no manual', () => {
    const improving = state({ manual_rate_per_second: 30, auto_ramp_from: 8, auto_ramp_started_at: new Date(T0).toISOString() });
    expect(effectiveRate(improving, P, sec(0)).rate).toBe(8); // manual 30 limitado pelo auto 8 (ainda subindo)
    expect(effectiveRate(improving, P, sec(60)).rate).toBe(10);
    const later = effectiveRate(improving, P, sec(60 * 20));
    expect(later.rate).toBe(30); // chegou no manual e NÃO passa (auto já é 80)
    expect(later.source).toBe('manual');
  });

  it('cooldown por rate limit reduz também o limite/s (metade)', () => {
    expect(effectiveRate(state(), P, sec(0), { inCooldown: true })).toMatchObject({ rate: 40, inCooldown: true });
    expect(effectiveRate(state({ manual_rate_per_second: 30 }), P, sec(0), { inCooldown: true }).rate).toBe(15);
  });

  it('nunca passa do teto físico da política', () => {
    expect(effectiveRate(state({ auto_rate_per_second: 80 }), { ...P, max: 50 }, sec(0)).rate).toBe(50);
  });
});

describe('vagas derivadas e utilidades', () => {
  it('vagas = ceil(rate × p95 × 1,2), entre 1 e o teto', () => {
    expect(derivedSlots(80, 1, 150)).toBe(96);
    expect(derivedSlots(80, 1.5, 150)).toBe(144);
    expect(derivedSlots(80, 3, 150)).toBe(150); // teto
    expect(derivedSlots(0.1, 0.1, 150)).toBe(1);
  });
  it('telefone comparável e limite diário do tier', () => {
    expect(phoneDigits('+55 21 3030-9159')).toBe('552130309159');
    expect(dailyLimitForTier('TIER_10K')).toBe(10_000);
    expect(dailyLimitForTier('TIER_UNLIMITED')).toBeNull();
    expect(dailyLimitForTier('QUALQUER')).toBeNull();
    expect(dailyLimitForTier(null)).toBeNull();
  });
});
