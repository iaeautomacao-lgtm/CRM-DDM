// Meta simulada para a bancada de carga do disparador. NUNCA use com canal/token reais.
//
//   node scripts/loadtest/mock-meta.mjs
//
// Configuração (variáveis de ambiente):
//   MOCK_PORT=4010  MOCK_HOST=127.0.0.1
//   MOCK_LATENCY_P50_MS=850  MOCK_LATENCY_P95_MS=1000     (lognormal: média ≈ 0,85 s, p95 1,0 s — audit §4)
//   MOCK_ERRORS="5xx=0.01,429=0.005,131056=0.002,async_131026=0.003,timeout=0.005"   (padrão do audit; taxa por requisição)
//   MOCK_TIMEOUT_HOLD_MS=12000   (quanto o mock segura a conexão no "timeout"; > META_TIMEOUT_MS=10000 do app)
//   MOCK_QUALITY_INTERVAL_MS=0   (>0: emite phone_number_quality_update periódico por número)
//   MOCK_WEBHOOK_URL=http://localhost:3000/api/whatsapp/webhook    (opcional: sent/delivered/read/failed assinados; 1% duplicados, 2% fora de ordem)
//   MOCK_APP_SECRET=mock-app-secret   (o MESMO app_secret cadastrado nos canais fictícios de teste)
//   MOCK_WABA_ID=mock-waba  MOCK_READ_RATE=0.6
//
// O app em teste (STAGING) aponta para cá com DISPATCH_LOAD_TEST=1 + META_API_BASE_URL=http://<host-do-mock>:4010.
// Estatísticas: GET /__stats (por número e por segundo) · zerar: /__reset · mudar em tempo real: POST /__control
//   {"latencyP50Ms":..,"errorRates":{"429":0.2},"phoneLatency":{"<phone_id>":{"p50":3000,"p95":3500}},"quality":{"phone":"<phone_id>","event":"FLAGGED"}}

import { AUDIT_ERROR_RATES, createMetaMock, parseErrorRates } from './lib/meta-mock.mjs';
import { formatMockStats } from './lib/load-metrics.mjs';

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const mock = createMetaMock({
  host: process.env.MOCK_HOST ?? '127.0.0.1',
  port: num(process.env.MOCK_PORT, 4010),
  latencyP50Ms: num(process.env.MOCK_LATENCY_P50_MS, 850),
  latencyP95Ms: num(process.env.MOCK_LATENCY_P95_MS, 1000),
  errorRates: process.env.MOCK_ERRORS === undefined ? AUDIT_ERROR_RATES : parseErrorRates(process.env.MOCK_ERRORS),
  timeoutHoldMs: num(process.env.MOCK_TIMEOUT_HOLD_MS, 12_000),
  qualityIntervalMs: num(process.env.MOCK_QUALITY_INTERVAL_MS, 0),
  webhookUrl: process.env.MOCK_WEBHOOK_URL ?? '',
  appSecret: process.env.MOCK_APP_SECRET ?? 'mock-app-secret',
  wabaId: process.env.MOCK_WABA_ID ?? 'mock-waba',
  readRate: num(process.env.MOCK_READ_RATE, 0.6),
});

const address = await mock.listen();
const c = mock.config;
console.log(`[meta-mock] ouvindo em http://${address.address}:${address.port}  (latência p50=${c.latencyP50Ms}ms p95=${c.latencyP95Ms}ms)`);
console.log(`[meta-mock] erros: ${JSON.stringify(c.errorRates)}  webhook: ${c.webhookUrl || '(desligado)'}`);
console.log('[meta-mock] ⚠️  Meta SIMULADA: nada chega ao WhatsApp. Use só com canais/tokens fictícios.');

setInterval(() => {
  const text = formatMockStats(mock.snapshot());
  if (text) console.log(text);
}, 5000).unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await mock.close();
    process.exit(0);
  });
}
