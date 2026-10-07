// Catálogo local de templates Meta (wacrm.message_templates), chave
// (account_id, waba_id, name, language) — migration 160.
//
// Linhas sem waba_id ("antigas") vêm de antes da migration 073. Elas não
// podem conviver com a linha da WABA para o mesmo nome/idioma: a validação
// da campanha aceitava se QUALQUER uma estivesse aprovada, e uma antiga
// aprovada mascarava a da WABA rejeitada. Regras:
// - submit/sync: a linha da WABA é usada se existir; senão a antiga é
//   ADOTADA (o update grava o waba_id nela); só então insere.
// - sync completo (todas as WABAs lidas, sem truncar): antiga que sobrou
//   com o mesmo nome/idioma de um template sincronizado é REMOVIDA, depois
//   de copiar as permissões de equipe (team_allowed_templates, que tem
//   ON DELETE CASCADE) para as linhas da WABA. Só linhas antigas são
//   apagadas, nunca linhas de WABA. Pasta/tags locais da antiga não são
//   copiadas (a linha da WABA mantém as suas).

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Id da linha a atualizar num submit/sync: a da WABA; senão a antiga sem
 * waba_id (adoção). Undefined = inserir.
 */
export function pickCatalogRowId(
  rows: ReadonlyArray<{ id: string; waba_id: string | null }>,
  wabaId: string | null,
): string | undefined {
  if (wabaId) {
    const specific = rows.find((r) => r.waba_id === wabaId)
    if (specific) return specific.id
  }
  return rows.find((r) => !r.waba_id)?.id
}

export function templateKey(name: string, language: string | null | undefined): string {
  return `${name}\u0000${language ?? ''}`
}

export interface LegacyCleanupResult {
  removed: number
  errors: string[]
}

/**
 * Remove as linhas antigas (waba_id nulo) da conta cujo (name, language)
 * está em `syncedKeys` e já tem linha de WABA. Chamar só depois de um sync
 * completo. Falha em qualquer passo de uma linha = ela fica (a validação
 * já dá precedência à linha da WABA — templateRowsForWaba).
 */
export async function removeSupersededLegacyTemplates(
  supabase: SupabaseClient,
  accountId: string,
  syncedKeys: ReadonlySet<string>,
): Promise<LegacyCleanupResult> {
  const result: LegacyCleanupResult = { removed: 0, errors: [] }
  const { data: legacyRows, error: legacyErr } = await supabase
    .from('message_templates')
    .select('id, name, language')
    .eq('account_id', accountId)
    .is('waba_id', null)
    .limit(1000)
  if (legacyErr) {
    result.errors.push(legacyErr.message)
    return result
  }

  for (const legacy of (legacyRows ?? []) as Array<{ id: string; name: string; language: string | null }>) {
    if (!syncedKeys.has(templateKey(legacy.name, legacy.language))) continue

    let specificQuery = supabase
      .from('message_templates')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', legacy.name)
      .not('waba_id', 'is', null)
    specificQuery = legacy.language === null
      ? specificQuery.is('language', null)
      : specificQuery.eq('language', legacy.language)
    const { data: specificRows, error: specificErr } = await specificQuery.limit(50)
    if (specificErr) {
      result.errors.push(specificErr.message)
      continue
    }
    const specificIds = ((specificRows ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (specificIds.length === 0) continue

    // Permissões de equipe da antiga passam para as linhas da WABA antes do
    // DELETE (o CASCADE as apagaria).
    const { data: teamRows, error: teamErr } = await supabase
      .from('team_allowed_templates')
      .select('team_id')
      .eq('template_id', legacy.id)
    if (teamErr) {
      result.errors.push(teamErr.message)
      continue
    }
    const grants = ((teamRows ?? []) as Array<{ team_id: string }>).flatMap((t) =>
      specificIds.map((templateId) => ({ team_id: t.team_id, template_id: templateId })),
    )
    if (grants.length > 0) {
      const { error: grantErr } = await supabase
        .from('team_allowed_templates')
        .upsert(grants, { onConflict: 'team_id,template_id', ignoreDuplicates: true })
      if (grantErr) {
        result.errors.push(grantErr.message)
        continue
      }
    }

    const { error: deleteErr } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', legacy.id)
      .eq('account_id', accountId)
      .is('waba_id', null)
    if (deleteErr) result.errors.push(deleteErr.message)
    else result.removed++
  }
  return result
}
