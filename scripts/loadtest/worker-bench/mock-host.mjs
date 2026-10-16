// Meta simulada da bancada do worker: a mesma de scripts/loadtest/mock-meta.mjs (lib/meta-mock.mjs), mais a medida da CPU do próprio processo,
// impressa a cada segundo ("CPU <ms acumulados> <lag p99 ms>"), para a bancada contabilizar quanto núcleo a Meta simulada consome e se ela
// própria engasgou (laço de eventos atrasado = latência falsa para o worker). Só 127.0.0.1. Nunca conversa com a Meta real.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createMetaMock, parseErrorRates } from '../lib/meta-mock.mjs';

const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== undefined && value !== '' ? Number(value) : fallback);

const mock = createMetaMock({
  host: '127.0.0.1',
  port: num(process.env.MOCK_PORT, 4010),
  latencyP50Ms: num(process.env.MOCK_LATENCY_P50_MS, 850),
  latencyP95Ms: num(process.env.MOCK_LATENCY_P95_MS, 1000),
  errorRates: parseErrorRates(process.env.MOCK_ERRORS ?? ''),
  timeoutHoldMs: 12_000,
  webhookUrl: '',
});
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const address = await mock.listen();
console.log(`READY ${address.port}`);
setInterval(() => {
  const u = process.cpuUsage();
  console.log(`CPU ${Math.round((u.user + u.system) / 1000)} ${Math.round(lag.percentile(99) / 1e6)}`);
  lag.reset();
}, 1000).unref?.();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await mock.close();
    process.exit(0);
  });
}
// segura o processo vivo (o servidor HTTP já faz isso; o unref acima só libera o relógio)
