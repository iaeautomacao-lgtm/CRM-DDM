// "Meta simulada" para a bancada de carga do disparador (docs/disparador-bancada-carga.md, §S0–S11).
//
// Imita o envio da Graph API (POST /{versão}/{phone_number_id}/messages) com latência lognormal e injeção de
// falhas (5xx, 429/130429, 131056, 131026 assíncrono, timeout), conta requisições por phone_number_id (por segundo)
// e devolve webhooks ASSINADOS (HMAC-SHA256 com um app_secret DE TESTE): sent/delivered/read/failed, com duplicados e
// fora de ordem, e phone_number_quality_update periódico/sob comando (teste do limite por qualidade).
//
// NUNCA use com canal/token reais. Escuta só em 127.0.0.1 por padrão. Sem dependências (node:http / node:crypto).

import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/** Latência lognormal que respeita p50 e p95 (z = 1,645 no percentil 95). `random` injetável p/ teste. */
export function sampleLatencyMs(p50, p95, random = Math.random) {
  if (!(p50 > 0)) return 0;
  const sigma = p95 > p50 ? Math.log(p95 / p50) / 1.645 : 0;
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.round(p50 * Math.exp(sigma * z)));
}

/** "5xx=0.01,429=0.005,131056=0.002,async_131026=0.003,timeout=0.005" → { '5xx': .01, … }. Inválidos são ignorados. */
export function parseErrorRates(text) {
  const rates = {};
  for (const part of String(text ?? '').split(',')) {
    const [key, value] = part.split('=').map((s) => s.trim());
    const rate = Number(value);
    if (key && Number.isFinite(rate) && rate > 0) rates[key] = Math.min(rate, 1);
  }
  return rates;
}

/** Perfil de falhas do audit §4: 1% 5xx, 0,5% 429/130429, 0,2% 131056, 0,3% 131026 assíncrono, 0,5% timeout. */
export const AUDIT_ERROR_RATES = { '5xx': 0.01, 429: 0.005, 131056: 0.002, async_131026: 0.003, timeout: 0.005 };

const HTTP_ERRORS = {
  429: { status: 429, code: 130429, message: '(#130429) Rate limit hit', type: 'OAuthException' },
  131056: { status: 400, code: 131056, message: '(#131056) (Business Account, Consumer Account) pair rate limit hit', type: 'OAuthException' },
  '5xx': { status: 500, code: 2, message: 'An unexpected error has occurred. Please retry your request later.', type: 'OAuthException' },
};
const KNOWN_FAILURES = new Set([...Object.keys(HTTP_ERRORS), 'async_131026', 'timeout']);

/** Sorteia uma falha segundo as taxas (soma ≤ 1 por requisição). Devolve a chave ou null. */
export function pickError(rates, random = Math.random) {
  let roll = random();
  for (const [key, rate] of Object.entries(rates)) {
    if (!KNOWN_FAILURES.has(key)) continue;
    if (roll < rate) return key;
    roll -= rate;
  }
  return null;
}

export function signWebhookBody(rawBody, appSecret) {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/** @param {{wabaId: string, phoneNumberId: string, displayPhone?: string, messageId: string, status: string, recipient: string, errorCode?: number, now?: number}} p */
export function buildStatusPayload({ wabaId, phoneNumberId, displayPhone, messageId, status, recipient, errorCode, now = Date.now() }) {
  const entry = { id: messageId, status, timestamp: String(Math.floor(now / 1000)), recipient_id: recipient };
  if (status === 'failed') {
    entry.errors = [{ code: errorCode ?? 131026, title: errorCode === 131026 || !errorCode ? 'Message undeliverable' : 'Message failed', message: 'Mock failure' }];
  }
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: displayPhone ?? phoneNumberId, phone_number_id: phoneNumberId },
              statuses: [entry],
            },
          },
        ],
      },
    ],
  };
}

/** @param {{wabaId: string, phoneNumberId: string, displayPhone?: string, event: string, currentLimit?: string}} p */
export function buildQualityPayload({ wabaId, phoneNumberId, displayPhone, event, currentLimit = 'TIER_10K' }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'phone_number_quality_update',
            value: { display_phone_number: displayPhone ?? phoneNumberId, event, current_limit: currentLimit },
          },
        ],
      },
    ],
  };
}

/**
 * @param {object} options
 *  port, host, latencyP50Ms, latencyP95Ms, errorRates, phoneLatency {phone:{p50,p95}}, webhookUrl, appSecret, wabaId,
 *  readRate, failedRate, duplicateRate, outOfOrderRate, statusDelaysMs {sent,delivered,read}, timeoutHoldMs,
 *  qualityIntervalMs, qualitySequence, webhookMaxInFlight, random, fetchImpl
 */
export function createMetaMock(options = {}) {
  const cfg = {
    host: '127.0.0.1',
    port: 4010,
    latencyP50Ms: 850,
    latencyP95Ms: 1000,
    errorRates: {},
    phoneLatency: {},
    webhookUrl: '',
    appSecret: 'mock-app-secret',
    wabaId: 'mock-waba',
    readRate: 0.6,
    failedRate: 0.02,
    duplicateRate: 0.01,
    outOfOrderRate: 0.02,
    statusDelaysMs: { sent: 1000, delivered: 3000, read: 30_000 },
    timeoutHoldMs: 12_000,
    qualityIntervalMs: 0,
    qualitySequence: ['UPGRADE', 'FLAGGED', 'UPGRADE'],
    webhookMaxInFlight: 100,
    random: Math.random,
    fetchImpl: globalThis.fetch,
    ...options,
  };

  const phones = new Map();
  const webhooks = { sent: 0, failed: 0, dropped: 0, inFlight: 0, duplicates: 0, outOfOrder: 0, quality: 0 };
  const startedAt = Date.now();
  const qualityIndex = new Map();

  const phoneStats = (id) => {
    let s = phones.get(id);
    if (!s) {
      s = { total: 0, ok: 0, errors: {}, perSecond: new Map(), inFlight: 0, maxInFlight: 0, latencies: [] };
      phones.set(id, s);
    }
    return s;
  };

  function snapshot() {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = {};
    for (const [id, s] of phones) {
      let peak = 0;
      for (const n of s.perSecond.values()) peak = Math.max(peak, n);
      const timeline = [];
      for (let t = nowSec - 60; t < nowSec; t++) timeline.push(s.perSecond.get(t) ?? 0);
      out[id] = {
        total: s.total,
        ok: s.ok,
        errors: { ...s.errors },
        rps_last_second: s.perSecond.get(nowSec - 1) ?? 0,
        rps_peak: peak,
        in_flight: s.inFlight,
        max_in_flight: s.maxInFlight,
        latency_samples: s.latencies.length,
        timeline_last_60s: timeline,
      };
    }
    return {
      started_at: new Date(startedAt).toISOString(),
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      latency: { p50_ms: cfg.latencyP50Ms, p95_ms: cfg.latencyP95Ms },
      error_rates: { ...cfg.errorRates },
      phones: out,
      webhooks: { ...webhooks },
    };
  }

  function sendWebhook(payload) {
    if (!cfg.webhookUrl) return;
    if (webhooks.inFlight >= cfg.webhookMaxInFlight) {
      webhooks.dropped++;
      return;
    }
    const raw = JSON.stringify(payload);
    webhooks.inFlight++;
    Promise.resolve(
      cfg.fetchImpl(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signWebhookBody(raw, cfg.appSecret) },
        body: raw,
      }),
    )
      .then((res) => {
        if (res.ok) webhooks.sent++;
        else webhooks.failed++;
      })
      .catch(() => {
        webhooks.failed++;
      })
      .finally(() => {
        webhooks.inFlight--;
      });
  }

  /** Agenda os webhooks de status de UMA mensagem aceita. */
  function scheduleStatuses(phoneNumberId, messageId, recipient, { asyncFailure }) {
    if (!cfg.webhookUrl) return;
    const base = { wabaId: cfg.wabaId, phoneNumberId, messageId, recipient };
    const d = cfg.statusDelaysMs;
    const plan = [['sent', d.sent]];
    if (asyncFailure) {
      plan.push(['failed', d.delivered, 131026]);
    } else if (cfg.random() < cfg.failedRate) {
      plan.push(['failed', d.delivered, 131049]);
    } else {
      plan.push(['delivered', d.delivered]);
      if (cfg.random() < cfg.readRate) plan.push(['read', d.read]);
    }
    // ~2% fora de ordem: o 2º status chega antes do 1º.
    if (plan.length > 1 && cfg.random() < cfg.outOfOrderRate) {
      const swap = plan[0][1];
      plan[0][1] = plan[1][1];
      plan[1][1] = swap;
      webhooks.outOfOrder++;
    }
    for (const [status, delay, errorCode] of plan) {
      const fire = () => sendWebhook(buildStatusPayload({ ...base, status, errorCode }));
      const timer = setTimeout(() => {
        fire();
        if (cfg.random() < cfg.duplicateRate) {
          webhooks.duplicates++;
          fire();
        }
      }, delay);
      timer.unref?.();
    }
  }

  function emitQuality(phoneNumberId, event, currentLimit) {
    webhooks.quality++;
    sendWebhook(buildQualityPayload({ wabaId: cfg.wabaId, phoneNumberId, event, currentLimit }));
  }

  let qualityTimer = null;
  function startQualityTimer() {
    if (!(cfg.qualityIntervalMs > 0) || qualityTimer) return;
    qualityTimer = setInterval(() => {
      for (const id of phones.keys()) {
        const i = qualityIndex.get(id) ?? 0;
        qualityIndex.set(id, i + 1);
        emitQuality(id, cfg.qualitySequence[i % cfg.qualitySequence.length]);
      }
    }, cfg.qualityIntervalMs);
    qualityTimer.unref?.();
  }

  const json = (res, status, body, extraHeaders = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...extraHeaders });
    res.end(text);
  };

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
        } catch {
          resolve(null);
        }
      });
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname.replace(/\/+$/, '');

    if (req.method === 'GET' && path === '/__stats') return json(res, 200, snapshot());
    if (path === '/__reset') {
      phones.clear();
      qualityIndex.clear();
      Object.assign(webhooks, { sent: 0, failed: 0, dropped: 0, duplicates: 0, outOfOrder: 0, quality: 0 });
      return json(res, 200, { ok: true });
    }
    // Controle em tempo de execução (cenários S4/S11): muda latência, taxas de erro, latência de UM número e emite qualidade.
    if (req.method === 'POST' && path === '/__control') {
      const body = (await readBody(req)) ?? {};
      if (Number.isFinite(body.latencyP50Ms)) cfg.latencyP50Ms = body.latencyP50Ms;
      if (Number.isFinite(body.latencyP95Ms)) cfg.latencyP95Ms = body.latencyP95Ms;
      if (body.errorRates && typeof body.errorRates === 'object') cfg.errorRates = parseErrorRates(Object.entries(body.errorRates).map(([k, v]) => `${k}=${v}`).join(','));
      if (body.phoneLatency && typeof body.phoneLatency === 'object') cfg.phoneLatency = { ...cfg.phoneLatency, ...body.phoneLatency };
      if (body.quality?.phone && body.quality?.event) emitQuality(String(body.quality.phone), String(body.quality.event), body.quality.current_limit);
      return json(res, 200, { ok: true, latency: { p50_ms: cfg.latencyP50Ms, p95_ms: cfg.latencyP95Ms }, error_rates: cfg.errorRates, phone_latency: cfg.phoneLatency });
    }

    // POST /{versão}/{phone_number_id}/messages
    const send = path.match(/^\/(v\d+\.\d+)\/([^/]+)\/messages$/);
    if (req.method === 'POST' && send) {
      const phoneNumberId = decodeURIComponent(send[2]);
      const stats = phoneStats(phoneNumberId);
      startQualityTimer();
      const startedAtMs = Date.now();
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      const body = await readBody(req);
      const own = cfg.phoneLatency[phoneNumberId];
      const delay = sampleLatencyMs(own?.p50 ?? cfg.latencyP50Ms, own?.p95 ?? cfg.latencyP95Ms, cfg.random);
      const failure = pickError(cfg.errorRates, cfg.random);
      const finish = () => {
        stats.inFlight--;
        stats.total++;
        const sec = Math.floor(Date.now() / 1000);
        stats.perSecond.set(sec, (stats.perSecond.get(sec) ?? 0) + 1);
        stats.latencies.push(Date.now() - startedAtMs);
        if (stats.latencies.length > 20_000) stats.latencies.splice(0, 10_000);
        if (stats.perSecond.size > 600) for (const k of [...stats.perSecond.keys()].slice(0, stats.perSecond.size - 600)) stats.perSecond.delete(k);
      };
      const timer = setTimeout(() => {
        // Timeout: segura a conexão além do timeout do cliente (META_TIMEOUT_MS) e não responde.
        if (failure === 'timeout') {
          stats.errors.timeout = (stats.errors.timeout ?? 0) + 1;
          const hold = setTimeout(() => {
            finish();
            if (!res.writableEnded) res.destroy();
          }, cfg.timeoutHoldMs);
          hold.unref?.();
          return;
        }
        finish();
        const to = body && typeof body.to === 'string' ? body.to : '';
        if (!body || !to) {
          stats.errors.bad_request = (stats.errors.bad_request ?? 0) + 1;
          return json(res, 400, { error: { message: '(#100) Invalid parameter', type: 'OAuthException', code: 100, fbtrace_id: randomUUID() } });
        }
        const shape = failure ? HTTP_ERRORS[failure] : undefined;
        if (shape) {
          stats.errors[failure] = (stats.errors[failure] ?? 0) + 1;
          return json(
            res,
            shape.status,
            { error: { message: shape.message, type: shape.type, code: shape.code, fbtrace_id: randomUUID() } },
            shape.status === 429 ? { 'Retry-After': '1' } : {},
          );
        }
        stats.ok++;
        const asyncFailure = failure === 'async_131026';
        if (asyncFailure) stats.errors.async_131026 = (stats.errors.async_131026 ?? 0) + 1;
        const messageId = `wamid.MOCK.${randomUUID()}`;
        scheduleStatuses(phoneNumberId, messageId, to, { asyncFailure });
        return json(res, 200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: to, wa_id: to.replace(/\D/g, '') }],
          messages: [{ id: messageId }],
        });
      }, delay);
      timer.unref?.();
      return;
    }

    // GET /{versão}/{phone_number_id} — informações do número (verificação de canal).
    const info = path.match(/^\/(v\d+\.\d+)\/([^/]+)$/);
    if (req.method === 'GET' && info) {
      return json(res, 200, { id: decodeURIComponent(info[2]), display_phone_number: '+55 00 00000-0000', verified_name: 'Meta simulada', quality_rating: 'GREEN' });
    }
    return json(res, 404, { error: { message: 'Meta simulada: rota não implementada', code: 404 } });
  });

  return {
    server,
    config: cfg,
    snapshot,
    emitQuality,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        if (qualityTimer) clearInterval(qualityTimer);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
