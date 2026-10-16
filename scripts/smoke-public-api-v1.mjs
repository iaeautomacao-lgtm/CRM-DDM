#!/usr/bin/env node
/**
 * Smoke test SEGURO e somente leitura da API pública V1.
 *
 * Executar depois de aplicar migration e deploy, preferencialmente no servidor:
 *   API_SMOKE_BASE_URL=https://omnicrm.grupoddm.ia.br API_SMOKE_KEY=... node scripts/smoke-public-api-v1.mjs
 *
 * Nunca imprime a chave, contatos, mensagens nem dados de cliente.
 * POST é exercitado SOMENTE sem autenticação (deve retornar 401 antes de escrever).
 * Sem API_SMOKE_KEY, verifica contrato publico e bloqueio de acesso, mas nao faz consultas autenticadas.
 */
const base = (process.env.API_SMOKE_BASE_URL || 'https://omnicrm.grupoddm.ia.br').replace(/\/+$/, '');
const key = process.env.API_SMOKE_KEY || '';
const campaignId = process.env.API_SMOKE_CAMPAIGN_ID || '';
const checks = [];

function check(name, pass, note = '') {
  checks.push({ name, pass, note });
  process.stdout.write((pass ? 'PASS' : 'FAIL') + ' ' + name + (note ? ' - ' + note : '') + '\n');
}

async function request(method, path, auth = false) {
  const headers = auth && key ? { Authorization: 'Bearer ' + key } : {};
  const response = await fetch(base + path, {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(16000),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, code: data?.error?.code, data: data?.data, raw: data };
}

async function run() {
  const spec = await request('GET', '/api/v1/openapi.json');
  // /openapi.json devolve o documento OpenAPI na raiz, sem envelope data.
  const operations = Object.values(spec.raw?.paths || {}).flatMap((item) =>
    Object.values(item).filter((operation) => operation && typeof operation === 'object' && 'operationId' in operation)
  );
  check('OpenAPI public', spec.status === 200 && spec.raw?.openapi === '3.1.0' && operations.length === 12,
    'HTTP ' + spec.status + ', operacoes ' + operations.length);

  const anon = [
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/reports/operations/current'],
    ['GET', '/api/v1/reports/operations/summary'],
    ['GET', '/api/v1/reports/teams'],
    ['GET', '/api/v1/reports/agents'],
    ['GET', '/api/v1/reports/tabulations'],
    ['GET', '/api/v1/conversations'],
    ['GET', '/api/v1/conversations/11111111-1111-4111-8111-111111111111/messages'],
    ['GET', '/api/v1/messages'],
    ['GET', '/api/v1/disparador/campaigns/11111111-1111-4111-8111-111111111111'],
    ['POST', '/api/v1/disparador/campaigns'],
    ['POST', '/api/v1/whatsapp/send'],
  ];
  for (const [method, path] of anon) {
    const response = await request(method, path);
    check('Autenticacao ' + method + ' ' + path.split('?')[0], response.status === 401 && response.code === 'unauthorized', 'HTTP ' + response.status);
  }

  if (!key) {
    process.stdout.write('SKIP leitura autenticada: API_SMOKE_KEY nao definida.\n');
    return;
  }

  const me = await request('GET', '/api/v1/me', true);
  check('Identidade com chave', me.status === 200 && Boolean(me.data?.account?.id), 'HTTP ' + me.status);
  if (me.status !== 200) return;
  const scopes = new Set(me.data?.key?.scopes || []);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const period = '?from=' + encodeURIComponent(day) + '&to=' + encodeURIComponent(day);
  const readOnly = [
    ['reports:read', '/api/v1/reports/operations/current'],
    ['reports:read', '/api/v1/reports/operations/summary' + period],
    ['reports:read', '/api/v1/reports/teams' + period],
    ['reports:read', '/api/v1/reports/agents' + period],
    ['reports:read', '/api/v1/reports/tabulations' + period],
    ['conversations:read', '/api/v1/conversations?limit=1'],
    ['messages:read', '/api/v1/messages?from=' + encodeURIComponent(new Date(Date.now() - 3600000).toISOString()) + '&to=' + encodeURIComponent(new Date().toISOString()) + '&limit=1'],
  ];
  for (const [scope, path] of readOnly) {
    if (!scopes.has(scope)) {
      process.stdout.write('SKIP ' + path.split('?')[0] + ': sem escopo ' + scope + '.\n');
      continue;
    }
    const res = await request('GET', path, true);
    check('Leitura ' + path.split('?')[0], res.status === 200 && res.data !== undefined, 'HTTP ' + res.status + (res.code ? ' ' + res.code : ''));
    if (path.startsWith('/api/v1/conversations?') && res.status === 200) {
      const id = res.data?.items?.[0]?.id;
      if (id && scopes.has('messages:read')) {
        const detail = await request('GET', '/api/v1/conversations/' + encodeURIComponent(id) + '/messages?limit=1', true);
        check('Historico individual', detail.status === 200 && Array.isArray(detail.data?.items), 'HTTP ' + detail.status);
      }
    }
  }
  if (campaignId && (scopes.has('campaigns:read') || scopes.has('campaigns:write'))) {
    const res = await request('GET', '/api/v1/disparador/campaigns/' + encodeURIComponent(campaignId), true);
    check('Consulta de campanha', res.status === 200, 'HTTP ' + res.status);
  }
}

try {
  await run();
  const passed = checks.filter((c) => c.pass).length;
  console.log('RESULTADO ' + passed + '/' + checks.length + ' PASS');
  if (passed !== checks.length) process.exitCode = 1;
} catch (error) {
  console.error('SMOKE FALHOU: ' + (error instanceof Error ? error.message : 'erro desconhecido'));
  process.exitCode = 1;
}
