import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Agent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_AGENT_OPTIONS, getMetaDispatcher } from './meta-dispatcher';
import { sendTextMessage } from './meta-api';

describe('Agent da Meta (conexões reaproveitadas)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Agent único com 128 conexões, keep-alive de 30 s e sem pipelining', () => {
    expect(META_AGENT_OPTIONS).toEqual({ connections: 128, keepAliveTimeout: 30_000, pipelining: 1 });
    expect(getMetaDispatcher()).toBeInstanceOf(Agent);
    expect(getMetaDispatcher()).toBe(getMetaDispatcher());
  });

  it('as chamadas à Meta passam o Agent como dispatcher', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendTextMessage({ phoneNumberId: 'p1', accessToken: 't', to: '5511999990000', text: 'oi' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { dispatcher?: unknown }];
    expect(String(url)).toContain('/p1/messages');
    expect(init.dispatcher).toBe(getMetaDispatcher());
  });

  it('só meta-dispatcher.ts e meta-api.ts conhecem o Agent: nenhum outro destino (WAHA, OpenAI…) o usa', () => {
    const root = join(process.cwd(), 'src');
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (/from ['"]undici['"]|meta-dispatcher|getMetaDispatcher/.test(text)) users.push(relative(root, full).split(sep).join('/'));
        }
      }
    };
    walk(root);
    expect(users.sort()).toEqual(['lib/whatsapp/meta-api.ts', 'lib/whatsapp/meta-dispatcher.ts']);
  });
});
