import { describe, expect, it, vi } from 'vitest';
import {
  LOADTEST_FORBIDDEN_SUPABASE_REFS,
  LoadTestGateError,
  META_REAL_BASE,
  OPENAI_REAL_BASE,
  assertLoadTestGate,
  resolveMetaApiBaseUrl,
  resolveOpenAiBaseUrl,
} from './gate';

const ok = { DISPATCH_LOAD_TEST: '1', NEXT_PUBLIC_SUPABASE_URL: 'https://staging-abc.supabase.co' };

describe('gate da bancada de carga — META_API_BASE_URL', () => {
  it('sem a variável: Meta real (em qualquer ambiente)', () => {
    expect(resolveMetaApiBaseUrl({})).toBe(META_REAL_BASE);
    expect(resolveMetaApiBaseUrl({ NODE_ENV: 'production' })).toBe(META_REAL_BASE);
    expect(resolveMetaApiBaseUrl({ DISPATCH_LOAD_TEST: '1' })).toBe(META_REAL_BASE);
  });

  it('COM DISPATCH_LOAD_TEST=1: aceita o mock (origem, sem barra final)', () => {
    expect(resolveMetaApiBaseUrl({ ...ok, META_API_BASE_URL: 'http://mock-meta.staging:4010/' })).toBe('http://mock-meta.staging:4010');
    expect(resolveMetaApiBaseUrl({ ...ok, META_API_BASE_URL: 'http://127.0.0.1:4010' })).toBe('http://127.0.0.1:4010');
  });

  it('SEM DISPATCH_LOAD_TEST=1 (ou com outro valor): ignora a variável e usa o serviço real — nunca derruba a produção', () => {
    for (const flag of [undefined, '', '0', 'true', 'yes']) {
      expect(resolveMetaApiBaseUrl({ NODE_ENV: 'production', META_API_BASE_URL: 'http://127.0.0.1:4010', DISPATCH_LOAD_TEST: flag })).toBe(META_REAL_BASE);
    }
  });

  it('recusa o endereço real da Meta e subdomínios', () => {
    for (const url of ['https://graph.facebook.com', 'https://graph.facebook.com/v21.0', 'https://GRAPH.FACEBOOK.COM', 'https://x.graph.facebook.com']) {
      expect(() => resolveMetaApiBaseUrl({ ...ok, META_API_BASE_URL: url })).toThrow(/REAL/);
    }
  });

  it('recusa URL inválida, protocolo estranho e credencial na URL', () => {
    expect(() => resolveMetaApiBaseUrl({ ...ok, META_API_BASE_URL: 'não é url' })).toThrow(/URL válida/);
    expect(() => resolveMetaApiBaseUrl({ ...ok, META_API_BASE_URL: 'ftp://mock' })).toThrow(/http/);
    expect(() => resolveMetaApiBaseUrl({ ...ok, META_API_BASE_URL: 'http://u:p@mock:4010' })).toThrow(/usuário/);
  });

  it('recusa o Supabase de PRODUÇÃO no ambiente (ref cyftbffhgjmsfogxawrl)', () => {
    expect(LOADTEST_FORBIDDEN_SUPABASE_REFS).toContain('cyftbffhgjmsfogxawrl');
    for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
      expect(() =>
        resolveMetaApiBaseUrl({ DISPATCH_LOAD_TEST: '1', [key]: 'https://cyftbffhgjmsfogxawrl.supabase.co', META_API_BASE_URL: 'http://mock:4010' }),
      ).toThrow(/PRODUÇÃO/);
    }
  });
});

describe('gate da bancada de carga — OPENAI_BASE_URL e boot', () => {
  it('mesmo gate para a OpenAI', () => {
    expect(resolveOpenAiBaseUrl({})).toBe(OPENAI_REAL_BASE);
    expect(resolveOpenAiBaseUrl({ ...ok, OPENAI_BASE_URL: 'http://mock-openai:4020' })).toBe('http://mock-openai:4020');
    expect(resolveOpenAiBaseUrl({ OPENAI_BASE_URL: 'http://mock-openai:4020' })).toBe(OPENAI_REAL_BASE);
    expect(() => resolveOpenAiBaseUrl({ ...ok, OPENAI_BASE_URL: 'https://api.openai.com' })).toThrow(/REAL/);
  });

  it('assertLoadTestGate (boot): passa limpo, avisa com a bancada ativa e só aborta com a bancada ligada apontando para produção', () => {
    const warn = vi.fn();
    expect(assertLoadTestGate({}, { warn })).toEqual({ active: false });
    expect(warn).not.toHaveBeenCalled();
    expect(assertLoadTestGate({ ...ok, META_API_BASE_URL: 'http://mock:4010' }, { warn })).toEqual({ active: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BANCADA DE CARGA ATIVA'));
    expect(assertLoadTestGate({ META_API_BASE_URL: 'http://mock:4010' }, { warn })).toEqual({ active: false }); // ignorada sem a bancada ligada
    expect(() => assertLoadTestGate({ DISPATCH_LOAD_TEST: '1', SUPABASE_URL: 'https://cyftbffhgjmsfogxawrl.supabase.co' }, { warn })).toThrow(/PRODUÇÃO/);
  });
});

describe('openAiSdkBaseUrl (ENV-04)', () => {
  it('sem DISPATCH_LOAD_TEST a variável é ignorada: base real com /v1', async () => {
    const { openAiSdkBaseUrl } = await import('./gate')
    expect(openAiSdkBaseUrl({ OPENAI_BASE_URL: 'http://evil.example:9999' })).toBe('https://api.openai.com/v1')
    expect(openAiSdkBaseUrl({})).toBe('https://api.openai.com/v1')
  })
  it('com a bancada ligada usa o simulador (com /v1)', async () => {
    const { openAiSdkBaseUrl } = await import('./gate')
    expect(openAiSdkBaseUrl({ DISPATCH_LOAD_TEST: '1', OPENAI_BASE_URL: 'http://mock-openai:4020' })).toBe('http://mock-openai:4020/v1')
  })
})
