import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec, openApiSpec } from './openapi';

const V1_DIR = resolve(process.cwd(), 'src/app/api/v1');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

/** `src/app/api/v1/disparador/campaigns/[id]/route.ts` → `/disparador/campaigns/{id}`. */
function toOpenApiPath(file: string): string {
  const rel = relative(V1_DIR, file).split(sep).slice(0, -1).join('/');
  return `/${rel}`.replace(/\[([^\]]+)\]/g, '{$1}');
}

function exportedMethods(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1].toLowerCase());
}

describe('OpenAPI da API pública', () => {
  it('é uma OpenAPI 3.1 com a estrutura mínima', () => {
    expect(openApiSpec.openapi).toBe('3.1.0');
    expect(openApiSpec.info.title).toBeTruthy();
    expect(openApiSpec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(0);
    expect(openApiSpec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });

    for (const [path, item] of Object.entries(openApiSpec.paths) as Array<[string, Record<string, any>]>) {
      expect(path.startsWith('/')).toBe(true);
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        expect(op.operationId, `${method} ${path} sem operationId`).toBeTruthy();
        expect(op.summary, `${method} ${path} sem summary`).toBeTruthy();
        expect(Object.keys(op.responses).length, `${method} ${path} sem respostas`).toBeGreaterThan(0);
        // Toda rota autenticada documenta 401 e 429 (chave + rate limit).
        expect(op.responses['401'], `${method} ${path} sem 401`).toBeTruthy();
        expect(op.responses['429'], `${method} ${path} sem 429`).toBeTruthy();
        for (const m of String(path).matchAll(/\{(\w+)\}/g)) {
          expect(op.parameters?.some((p: any) => p.in === 'path' && p.name === m[1])).toBe(true);
        }
      }
    }
  });

  it('todo $ref aponta para um componente que existe', () => {
    const json = JSON.stringify(openApiSpec);
    const refs = [...json.matchAll(/"\$ref":"#\/components\/(\w+)\/([^"]+)"/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const [, kind, name] of refs) {
      const group = (openApiSpec.components as Record<string, Record<string, unknown>>)[kind];
      expect(group?.[name], `#/components/${kind}/${name}`).toBeTruthy();
    }
  });

  it('documenta TODAS as rotas de src/app/api/v1 (exceto o próprio openapi.json)', () => {
    const files = routeFiles(V1_DIR).filter((f) => !toOpenApiPath(f).startsWith('/openapi.json'));
    expect(files.length).toBeGreaterThan(0);
    const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
    for (const file of files) {
      const path = toOpenApiPath(file);
      const methods = exportedMethods(file);
      expect(methods.length, `${file} não exporta método HTTP`).toBeGreaterThan(0);
      expect(paths[path], `rota ${path} (${relative(process.cwd(), file)}) não está documentada em openapi.ts`).toBeTruthy();
      for (const method of methods) {
        expect(paths[path][method], `${method.toUpperCase()} ${path} não está documentado em openapi.ts`).toBeTruthy();
      }
    }
  });

  it('não documenta rota que não existe mais', () => {
    const real = new Set(
      routeFiles(V1_DIR).flatMap((f) => exportedMethods(f).map((m) => `${m} ${toOpenApiPath(f)}`))
    );
    for (const [path, item] of Object.entries(openApiSpec.paths) as Array<[string, Record<string, unknown>]>) {
      for (const method of METHODS) {
        if (item[method]) expect(real.has(`${method} ${path}`), `${method.toUpperCase()} ${path} documentado mas sem route.ts`).toBe(true);
      }
    }
  });

  it('send exige Idempotency-Key; campanha tem a chave opcional; códigos de erro reais', () => {
    const send = (openApiSpec.paths as any)['/whatsapp/send'].post;
    const campaign = (openApiSpec.paths as any)['/disparador/campaigns'].post;
    expect(send.parameters.find((p: any) => p.name === 'Idempotency-Key').required).toBe(true);
    expect(campaign.parameters.find((p: any) => p.name === 'Idempotency-Key').required).toBe(false);
    expect(Object.keys(campaign.responses)).toEqual(expect.arrayContaining(['200', '201', '400', '409', '413', '500']));
    expect(Object.keys(send.responses)).toEqual(expect.arrayContaining(['200', '202', '400', '409', '422', '503']));
    const codes = (openApiSpec.components.schemas.ErrorCode as any).enum as string[];
    for (const code of ['unauthorized', 'forbidden', 'rate_limited', 'bad_request', 'not_found', 'conflict', 'payload_too_large', 'recipient_blocked', 'internal']) {
      expect(codes).toContain(code);
    }
  });

  it('buildOpenApiSpec usa NEXT_PUBLIC_APP_URL como servidor e não vaza segredo', () => {
    expect((buildOpenApiSpec('https://crm.ddm.com.br/') as any).servers[0].url).toBe('https://crm.ddm.com.br/api/v1');
    expect((buildOpenApiSpec(undefined) as any).servers[0].url).toBe('/api/v1');
    const text = JSON.stringify(buildOpenApiSpec('https://crm.ddm.com.br'));
    expect(text).not.toMatch(/wacrm_live_[A-Za-z0-9_-]{20,}/);
    expect(text).not.toMatch(/service_role|SUPABASE|ENCRYPTION_KEY/i);
  });
});
