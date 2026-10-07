import { NextResponse } from 'next/server'
import { guardRole } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveSecretForWrite } from '@/lib/whatsapp/secret-write'
import {
  last4Of,
  normalizeAllowedHosts,
  toPublicSecret,
  validateCredentialValue,
  validateDescription,
  validateSecretName,
  validateVariableValue,
  type SecretRow,
} from '@/lib/secrets/secret-input'

// ============================================================
// /api/settings/secrets — variáveis e credenciais da conta (migration 175).
//
//   GET  supervisor+ : lista. Variáveis com valor; credenciais SÓ máscara
//                      (nome, last4, hosts, descrição) — nunca o valor nem o
//                      texto cifrado.
//   POST owner/admin : cria variável ou credencial (valor cifrado no servidor).
//
// Service role (a tabela não tem acesso direto do navegador), sempre filtrando
// por ctx.accountId. Valores nunca são logados nem devolvidos em erro.
// ============================================================

export async function GET() {
  const auth = await guardRole('supervisor')
  if (!auth.ok) return auth.response
  const { accountId } = auth.ctx

  const { data, error } = await supabaseAdmin()
    .from('account_secrets')
    .select('*')
    .eq('account_id', accountId)
    .order('name', { ascending: true })
  if (error) {
    console.error('[settings/secrets] falha ao listar:', error.message)
    return NextResponse.json({ error: 'Não foi possível carregar as variáveis e credenciais.' }, { status: 500 })
  }
  return NextResponse.json({ secrets: ((data ?? []) as SecretRow[]).map(toPublicSecret) })
}

export async function POST(request: Request) {
  const auth = await guardRole('admin')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 })
  }

  const nameError = validateSecretName(body.name)
  if (nameError) return NextResponse.json({ error: nameError }, { status: 400 })
  const name = body.name as string
  if (body.kind !== 'variable' && body.kind !== 'credential') {
    return NextResponse.json({ error: "O tipo deve ser 'variable' ou 'credential'." }, { status: 400 })
  }
  const kind = body.kind
  const description = validateDescription(body.description)
  if ('error' in description) return NextResponse.json({ error: description.error }, { status: 400 })

  let row: Record<string, unknown>
  if (kind === 'variable') {
    const value = validateVariableValue(body.value)
    if ('error' in value) return NextResponse.json({ error: value.error }, { status: 400 })
    row = { value_plain: value.value, value_encrypted: null, last4: null, allowed_hosts: null }
  } else {
    const value = validateCredentialValue(body.value)
    if ('error' in value) return NextResponse.json({ error: value.error }, { status: 400 })
    const hosts = normalizeAllowedHosts(body.allowed_hosts)
    if ('error' in hosts) return NextResponse.json({ error: hosts.error }, { status: 400 })
    let encrypted: string | null
    try {
      const resolved = resolveSecretForWrite(value.value, null)
      encrypted = resolved.ok ? resolved.value : null
    } catch {
      console.error('[settings/secrets] falha ao cifrar credencial (ENCRYPTION_KEY?)')
      return NextResponse.json({ error: 'Não foi possível proteger a credencial no servidor.' }, { status: 500 })
    }
    if (!encrypted) return NextResponse.json({ error: 'Informe o valor da credencial.' }, { status: 400 })
    row = {
      value_plain: null,
      value_encrypted: encrypted,
      last4: last4Of(value.value),
      allowed_hosts: hosts.hosts,
    }
  }

  const { data, error } = await supabaseAdmin()
    .from('account_secrets')
    .insert({
      account_id: accountId,
      name,
      kind,
      description: description.value,
      created_by: userId,
      updated_by: userId,
      ...row,
    })
    .select('*')
    .limit(1)

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `Já existe uma variável ou credencial chamada ${name}.` }, { status: 409 })
    }
    console.error('[settings/secrets] falha ao criar:', error.code ?? error.message)
    return NextResponse.json({ error: 'Não foi possível salvar.' }, { status: 500 })
  }
  return NextResponse.json({ secret: toPublicSecret((data as SecretRow[])[0]) }, { status: 201 })
}
