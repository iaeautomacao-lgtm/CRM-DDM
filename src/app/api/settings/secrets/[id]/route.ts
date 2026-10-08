import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveSecretForWrite } from '@/lib/whatsapp/secret-write'
import {
  isKeepCredential,
  last4Of,
  normalizeAllowedHosts,
  toPublicSecret,
  validateCredentialValue,
  validateDescription,
  validateVariableValue,
  type SecretRow,
} from '@/lib/secrets/secret-input'

// PATCH/DELETE de uma variável ou credencial da conta (owner/admin).
// Nome e tipo são imutáveis (fluxos referenciam o nome). Credencial: valor
// vazio ou máscara = manter o atual; valor novo = substitui (cifrado no
// servidor). Nada do valor volta na resposta.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadOwn(id: string, accountId: string): Promise<SecretRow | null> {
  const { data } = await supabaseAdmin()
    .from('account_secrets')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .limit(1)
  return ((data ?? []) as SecretRow[])[0] ?? null
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await guardPermission('secrets.write')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx
  if (!UUID.test(id)) return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 })
  }
  const existing = await loadOwn(id, accountId)
  if (!existing) return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })

  if (body.name !== undefined && body.name !== existing.name) {
    return NextResponse.json({ error: 'O nome não pode ser alterado (os fluxos usam o nome).' }, { status: 400 })
  }
  if (body.kind !== undefined && body.kind !== existing.kind) {
    return NextResponse.json({ error: 'O tipo não pode ser alterado.' }, { status: 400 })
  }

  const update: Record<string, unknown> = { updated_by: userId, updated_at: new Date().toISOString() }

  if (body.description !== undefined) {
    const description = validateDescription(body.description)
    if ('error' in description) return NextResponse.json({ error: description.error }, { status: 400 })
    update.description = description.value
  }

  if (existing.kind === 'variable') {
    if (body.value !== undefined) {
      const value = validateVariableValue(body.value)
      if ('error' in value) return NextResponse.json({ error: value.error }, { status: 400 })
      update.value_plain = value.value
    }
  } else {
    if (body.allowed_hosts !== undefined) {
      const hosts = normalizeAllowedHosts(body.allowed_hosts)
      if ('error' in hosts) return NextResponse.json({ error: hosts.error }, { status: 400 })
      // Mudar os domínios sem reenviar o valor permitiria apontar a credencial salva para um
      // host controlado por terceiros: trocar domínios exige o valor novamente.
      const current = [...(existing.allowed_hosts ?? [])].sort().join(',')
      const next = [...hosts.hosts].sort().join(',')
      if (current !== next && isKeepCredential(body.value)) {
        return NextResponse.json(
          { error: 'Para mudar os domínios, informe o valor da credencial novamente.' },
          { status: 400 },
        )
      }
      update.allowed_hosts = hosts.hosts
    }
    // Vazio/máscara = manter; valor novo = substituir e recalcular last4.
    if (!isKeepCredential(body.value)) {
      const value = validateCredentialValue(body.value)
      if ('error' in value) return NextResponse.json({ error: value.error }, { status: 400 })
      try {
        const resolved = resolveSecretForWrite(value.value, existing.value_encrypted)
        if (!resolved.ok || !resolved.value) {
          return NextResponse.json({ error: 'Valor da credencial inválido.' }, { status: 400 })
        }
        update.value_encrypted = resolved.value
      } catch {
        console.error('[settings/secrets] falha ao cifrar credencial (ENCRYPTION_KEY?)')
        return NextResponse.json({ error: 'Não foi possível proteger a credencial no servidor.' }, { status: 500 })
      }
      update.last4 = last4Of(value.value)
    }
  }

  const { data, error } = await supabaseAdmin()
    .from('account_secrets')
    .update(update)
    .eq('id', id)
    .eq('account_id', accountId)
    .select('*')
    .limit(1)
  if (error || !data?.length) {
    console.error('[settings/secrets] falha ao atualizar:', error?.code ?? 'sem linha')
    return NextResponse.json({ error: 'Não foi possível salvar.' }, { status: 500 })
  }
  return NextResponse.json({ secret: toPublicSecret((data as SecretRow[])[0]) })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await guardPermission('secrets.write')
  if (!auth.ok) return auth.response
  const { accountId } = auth.ctx
  if (!UUID.test(id)) return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })

  const { data, error } = await supabaseAdmin()
    .from('account_secrets')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id')
  if (error) {
    console.error('[settings/secrets] falha ao apagar:', error.code ?? error.message)
    return NextResponse.json({ error: 'Não foi possível apagar.' }, { status: 500 })
  }
  if (!data?.length) return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
