// Transcrição (STT) de áudio recebido — feita na ENTRADA da mensagem (inbound-message.ts), com a chave de IA DA CONTA.
//
// Regras:
//   - a chave é a da conta (wacrm.ai_config.api_key, cifrada, provider "openai"); NUNCA a OPENAI_API_KEY do .env — o custo é do cliente e a
//     conta é quem liga/desliga (ai_config.enabled + multimodal_enabled, os mesmos interruptores que o responder já usava para o Whisper);
//   - o texto fica junto da mensagem: messages.transcription_text (bruto), transcription_status e content_text no formato que o inbox
//     e o responder já usam ("🎙️ _Áudio transcrito:_ "…"");
//   - nunca lança: qualquer falha vira status 'failed' e a mensagem entra normalmente (o responder ainda tenta pelo caminho antigo).

import { openAiUrl } from '@/lib/loadtest/gate'
import { tryDecrypt } from '@/lib/whatsapp/encryption'

export const TRANSCRIPT_PREFIX = '🎙️ _Áudio transcrito:_ '
export const STT_MODEL = 'whisper-1'
export const STT_TIMEOUT_MS = 20_000

export type TranscriptionStatus = 'done' | 'failed' | 'skipped'
export interface TranscriptionResult {
  status: TranscriptionStatus
  text: string | null
}

/** Texto como o inbox mostra e o responder lê. */
export function formatTranscript(text: string): string {
  return `${TRANSCRIPT_PREFIX}"${text}"`
}

/** Inverso de formatTranscript: devolve o texto transcrito se `contentText` já é uma transcrição; senão null. */
export function parseTranscript(contentText: string | null | undefined): string | null {
  if (!contentText?.startsWith(TRANSCRIPT_PREFIX)) return null
  const rest = contentText.slice(TRANSCRIPT_PREFIX.length)
  const m = /^"([\s\S]*)"$/.exec(rest.trim())
  const text = (m ? m[1] : rest).trim()
  return text || null
}

type Db = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: { message?: string } | null }> }
    }
  }
}

interface AiConfigRow {
  enabled?: boolean | null
  multimodal_enabled?: boolean | null
  api_provider?: string | null
  api_key?: string | null
}

/** Chave OpenAI da conta se a conta liga a IA multimodal; null (= não transcrever) em qualquer outro caso. Sem fallback para o .env. */
export async function resolveAccountSttKey(db: Db, accountId: string): Promise<string | null> {
  try {
    const { data, error } = await db
      .from('ai_config')
      .select('enabled, multimodal_enabled, api_provider, api_key')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error || !data) return null
    const cfg = data as AiConfigRow
    if (!cfg.enabled || !cfg.multimodal_enabled || cfg.api_provider !== 'openai') return null
    const raw = cfg.api_key?.trim()
    if (!raw) return null
    const key = tryDecrypt(raw).trim()
    return key || null
  } catch {
    return null
  }
}

/** Envia o áudio ao endpoint de transcrição da OpenAI com a chave da conta. */
export async function transcribeWithKey(
  audio: ArrayBuffer | Uint8Array,
  apiKey: string,
  opts: { mimeType?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<TranscriptionResult> {
  try {
    const form = new FormData()
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
    form.append('file', new Blob([bytes as BlobPart], { type: opts.mimeType || 'audio/ogg' }), 'audio.ogg')
    form.append('model', STT_MODEL)
    form.append('language', 'pt')
    const res = await (opts.fetchImpl ?? fetch)(openAiUrl('/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[stt] transcrição recusada: status=${res.status}`)
      return { status: 'failed', text: null }
    }
    const data = (await res.json()) as { text?: unknown }
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    return text ? { status: 'done', text } : { status: 'failed', text: null }
  } catch (e) {
    console.error('[stt] falha na transcrição:', e instanceof Error ? e.name : 'erro')
    return { status: 'failed', text: null }
  }
}

/** Atalho do inbound: resolve a chave da conta e transcreve. Sem chave/consentimento da conta ⇒ 'skipped' (nada é enviado a terceiros). */
export async function transcribeInboundAudio(
  db: Db,
  accountId: string,
  audio: ArrayBuffer | Uint8Array,
  mimeType?: string | null,
): Promise<TranscriptionResult> {
  const key = await resolveAccountSttKey(db, accountId)
  if (!key) return { status: 'skipped', text: null }
  return transcribeWithKey(audio, key, { mimeType })
}
