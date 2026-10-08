// ENV-04: nenhum `new OpenAI(...)` deixa o SDK ler OPENAI_BASE_URL sozinho (isso contornava o gate da bancada).
// Com a variável setada e SEM DISPATCH_LOAD_TEST, os dois clientes do app usam a base real, explicitamente.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const constructed: Array<Record<string, unknown>> = []
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    baseURL: unknown
    constructor(opts: Record<string, unknown>) {
      constructed.push(opts)
      this.baseURL = opts.baseURL
    }
  },
}))

import { getDispatchOpenAiClient, resetDispatchOpenAiClient } from '@/lib/disparador/dispatch-ai'
import { createOpenAiChatClient } from '@/lib/intelligence/chat/openai-client'

const saved = { base: process.env.OPENAI_BASE_URL, flag: process.env.DISPATCH_LOAD_TEST }

beforeEach(() => {
  constructed.length = 0
  resetDispatchOpenAiClient()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const [key, value] of [['OPENAI_BASE_URL', saved.base], ['DISPATCH_LOAD_TEST', saved.flag]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('OpenAI com base fixa (sem DISPATCH_LOAD_TEST)', () => {
  it('OPENAI_BASE_URL setada sem a flag: os dois clientes usam a base real', () => {
    process.env.OPENAI_BASE_URL = 'http://evil.example:9999'
    delete process.env.DISPATCH_LOAD_TEST
    getDispatchOpenAiClient('sk-a')
    createOpenAiChatClient({ apiKey: 'sk-b', model: 'gpt-4o-mini' })
    expect(constructed.map((c) => c.baseURL)).toEqual(['https://api.openai.com/v1', 'https://api.openai.com/v1'])
    expect(JSON.stringify(constructed)).not.toContain('evil.example')
  })

  it('com DISPATCH_LOAD_TEST=1 o simulador é usado (bancada)', () => {
    process.env.OPENAI_BASE_URL = 'http://mock-openai:4020'
    process.env.DISPATCH_LOAD_TEST = '1'
    getDispatchOpenAiClient('sk-a')
    expect(constructed[0].baseURL).toBe('http://mock-openai:4020/v1')
  })

  it('varredura: todo `new OpenAI(` em src/** passa baseURL explícito', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
          // Só código (linhas de comentário podem citar `new OpenAI()` em prosa).
          for (const line of readFileSync(full, 'utf8').split('\n')) {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
            const m = /new OpenAI\((.*)/.exec(line)
            if (m && !/baseURL/.test(m[1])) offenders.push(full)
          }
        }
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
  }, 30_000)
})
