// Contatos na API pública (bloco C): acesso ao banco. Sempre escopado pela conta da chave (service-role não tem RLS: o filtro por account_id é obrigatório).
// Nada aqui loga telefone, CPF ou e-mail.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest, unprocessable } from '@/lib/api/v1/respond';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { phonesMatch } from '@/lib/whatsapp/phone-utils';
import {
  CONTACT_SELECT,
  EMPTY_EXTRAS,
  MAX_ALT_PHONES,
  isBlank,
  likeEscape,
  looksLikePlaceholderName,
  type ContactDbRow,
  type ContactExtras,
  type ContactWrite,
  type ContactsQuery,
  contactsCursor,
} from '@/lib/api/v1/contacts';

type Db = SupabaseClient;
const unavailable = (what: string) => new ApiError('unavailable', `Não foi possível ${what}; tente novamente`, 503);
const chunks = <T,>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// ── Leitura ──────────────────────────────────────────────────────────────────

/** Telefones alternativos, etiquetas e campos personalizados de uma lista de contatos (em blocos, sem passar do teto de linhas do PostgREST). */
export async function loadExtras(db: Db, rows: ContactDbRow[]): Promise<Map<string, ContactExtras>> {
  const map = new Map<string, ContactExtras>(rows.map((r) => [r.id, { phones: [], tags: [], customFields: {}, owner: null }]));
  for (const ids of chunks(rows.map((r) => r.id), 50)) {
    const [phones, tags, values] = await Promise.all([
      db.from('contact_phones').select('contact_id, phone, status, label, ordem').in('contact_id', ids).gte('ordem', 2).order('ordem', { ascending: true }).limit(1000),
      db.from('contact_tags').select('contact_id, tags(name, kind)').in('contact_id', ids).limit(1000),
      db.from('contact_custom_values').select('contact_id, value, custom_fields(field_name)').in('contact_id', ids).limit(1000),
    ]);
    if (phones.error || tags.error || values.error) throw unavailable('consultar os dados do contato');
    for (const p of (phones.data ?? []) as Array<{ contact_id: string; phone: string; status: string | null; label: string | null }>) {
      map.get(p.contact_id)?.phones.push({ phone: p.phone, status: p.status ?? null, label: p.label ?? null });
    }
    for (const t of (tags.data ?? []) as unknown as Array<{ contact_id: string; tags: { name: string; kind: string | null } | null }>) {
      if (t.tags && t.tags.kind !== 'outcome') map.get(t.contact_id)?.tags.push(t.tags.name);
    }
    for (const v of (values.data ?? []) as unknown as Array<{ contact_id: string; value: string | null; custom_fields: { field_name: string } | null }>) {
      if (v.custom_fields && v.value !== null) map.get(v.contact_id)!.customFields[v.custom_fields.field_name] = v.value;
    }
  }
  for (const e of map.values()) e.tags.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  await attachOwners(db, rows, map);
  return map;
}

/**
 * Carteira fixa (migration 372): dono de cada contato. Lido à parte para que a API de contatos continue funcionando sem a migration (coluna ausente = sem dono).
 * Segurança (revisão de 16/10, M2): o perfil do dono é lido SEMPRE da mesma conta do contato; um owner_user_id que aponte para alguém de outra conta
 * não aparece (nem o id nem o nome), em vez de devolver o nome de um usuário de fora.
 */
async function attachOwners(db: Db, rows: ContactDbRow[], map: Map<string, ContactExtras>): Promise<void> {
  const owners = new Map<string, { userId: string; accountId: string }>();
  for (const ids of chunks(rows.map((r) => r.id), 100)) {
    const { data, error } = await db.from('contacts').select('id, account_id, owner_user_id').in('id', ids);
    if (error) return;
    for (const r of (data ?? []) as Array<{ id: string; account_id: string; owner_user_id?: string | null }>) {
      if (r.owner_user_id && r.account_id) owners.set(r.id, { userId: r.owner_user_id, accountId: r.account_id });
    }
  }
  if (owners.size === 0) return;
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, account_id, full_name')
    .in('user_id', [...new Set([...owners.values()].map((o) => o.userId))])
    .in('account_id', [...new Set([...owners.values()].map((o) => o.accountId))]);
  const names = new Map(
    ((profiles ?? []) as Array<{ user_id: string; account_id: string; full_name: string | null }>).map((p) => [`${p.account_id}:${p.user_id}`, (p.full_name ?? '').trim() || 'Atendente']),
  );
  for (const [contactId, o] of owners) {
    const name = names.get(`${o.accountId}:${o.userId}`);
    if (name === undefined) continue; // dono sem perfil nesta conta (ex.: usuário de outra conta): não expõe
    const extras = map.get(contactId);
    if (extras) extras.owner = { id: o.userId, name };
  }
}

export async function getContactRow(db: Db, accountId: string, id: string): Promise<ContactDbRow | null> {
  const { data, error } = await db.from('contacts').select(CONTACT_SELECT).eq('id', id).eq('account_id', accountId).limit(1);
  if (error) throw unavailable('consultar o contato');
  return ((data ?? [])[0] as ContactDbRow | undefined) ?? null;
}

export async function extrasOf(db: Db, row: ContactDbRow): Promise<ContactExtras> {
  return (await loadExtras(db, [row])).get(row.id) ?? EMPTY_EXTRAS;
}

export async function listContacts(db: Db, accountId: string, q: ContactsQuery): Promise<{ rows: ContactDbRow[]; hasMore: boolean }> {
  let onlyId: string | null = null;
  if (q.phone) {
    const found = await findExistingContact(db, accountId, q.phone);
    if (!found) return { rows: [], hasMore: false };
    onlyId = found.id;
  }
  let tagId: string | null = null;
  if (q.tag) {
    const { data, error } = await db.from('tags').select('id').eq('account_id', accountId).ilike('name', likeEscape(q.tag)).limit(1);
    if (error) throw unavailable('consultar as etiquetas');
    tagId = (data ?? [])[0]?.id ?? null;
    if (!tagId) return { rows: [], hasMore: false };
  }

  let query = db.from('contacts').select(tagId ? `${CONTACT_SELECT}, contact_tags!inner(tag_id)` : CONTACT_SELECT).eq('account_id', accountId);
  if (onlyId) query = query.eq('id', onlyId);
  if (tagId) query = query.eq('contact_tags.tag_id', tagId);
  if (q.cpf) query = query.eq('cpf', q.cpf);
  if (q.email) query = query.ilike('email', likeEscape(q.email));
  if (q.q) query = query.ilike('name', `${likeEscape(q.q)}%`);
  if (q.updatedFrom) query = query.gte('updated_at', q.updatedFrom);
  if (q.updatedTo) query = query.lt('updated_at', q.updatedTo);
  if (q.cursor) {
    const [ts, id] = q.cursor;
    query = query.or(`updated_at.gt.${ts},and(updated_at.eq.${ts},id.gt.${id})`);
  }
  const { data, error } = await query.order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(q.limit + 1);
  if (error) throw unavailable('consultar os contatos');
  const all = ((data ?? []) as unknown as Array<ContactDbRow & { contact_tags?: unknown }>).map(({ contact_tags: _ignored, ...row }) => row as ContactDbRow);
  return { rows: all.slice(0, q.limit), hasMore: all.length > q.limit };
}

export { contactsCursor };

// ── Quem grava ───────────────────────────────────────────────────────────────

/** user_id exigido pelas tabelas: quem criou a chave; senão o dono da conta. */
export async function resolveActorUserId(db: Db, accountId: string, createdBy: string | null, userId: string | null): Promise<string> {
  if (createdBy) return createdBy;
  if (userId) return userId;
  const { data } = await db.from('accounts').select('owner_user_id').eq('id', accountId).limit(1);
  const owner = (data ?? [])[0]?.owner_user_id as string | undefined;
  if (!owner) throw new ApiError('unavailable', 'A conta não tem um usuário responsável para registrar o contato', 503);
  return owner;
}

// ── Campos personalizados e etiquetas ───────────────────────────────────────

export interface FieldDef {
  id: string;
  name: string;
}

/** Resolve nomes de campos personalizados da CONTA. Nome inexistente → 422 `unprocessable` com a lista (nada é gravado). */
export async function resolveCustomFields(db: Db, accountId: string, names: string[]): Promise<Map<string, FieldDef>> {
  const out = new Map<string, FieldDef>();
  if (names.length === 0) return out;
  const { data, error } = await db.from('custom_fields').select('id, field_name').eq('account_id', accountId).limit(1000);
  if (error) throw unavailable('consultar os campos personalizados');
  const byLower = new Map(((data ?? []) as Array<{ id: string; field_name: string }>).map((f) => [f.field_name.trim().toLowerCase(), f]));
  const unknown: string[] = [];
  for (const name of names) {
    const f = byLower.get(name.toLowerCase());
    if (f) out.set(name, { id: f.id, name: f.field_name });
    else unknown.push(name);
  }
  if (unknown.length > 0) {
    throw unprocessable(`Campo(s) personalizado(s) inexistente(s) nesta conta: ${unknown.join(', ')}. Crie-os em Configurações antes.`, { unknown_custom_fields: unknown });
  }
  return out;
}

export async function writeCustomValues(db: Db, contactId: string, defs: Map<string, FieldDef>, values: Record<string, string | null>, onlyIfEmpty: boolean): Promise<string[]> {
  const changed: string[] = [];
  let current = new Map<string, string | null>();
  if (onlyIfEmpty) {
    const { data } = await db.from('contact_custom_values').select('custom_field_id, value').eq('contact_id', contactId).limit(1000);
    current = new Map(((data ?? []) as Array<{ custom_field_id: string; value: string | null }>).map((r) => [r.custom_field_id, r.value]));
  }
  for (const [name, value] of Object.entries(values)) {
    const def = defs.get(name)!;
    if (value === null) {
      if (onlyIfEmpty) continue;
      const { error } = await db.from('contact_custom_values').delete().eq('contact_id', contactId).eq('custom_field_id', def.id);
      if (error) throw unavailable('apagar o campo personalizado');
      changed.push(def.name);
      continue;
    }
    if (onlyIfEmpty && !isBlank(current.get(def.id))) continue;
    const { error } = await db.from('contact_custom_values').upsert({ contact_id: contactId, custom_field_id: def.id, value }, { onConflict: 'contact_id,custom_field_id' });
    if (error) throw unavailable('gravar o campo personalizado');
    changed.push(def.name);
  }
  return changed;
}

interface TagRow {
  id: string;
  name: string;
  kind: string | null;
}

async function accountTags(db: Db, accountId: string): Promise<TagRow[]> {
  const { data, error } = await db.from('tags').select('id, name, kind').eq('account_id', accountId).limit(1000);
  if (error) throw unavailable('consultar as etiquetas');
  return (data ?? []) as TagRow[];
}

/** Ids das etiquetas de contato pelos nomes; com `create`, as que não existem são criadas (kind 'contact'). */
export async function resolveTagIds(db: Db, accountId: string, actor: string, names: string[], create: boolean): Promise<TagRow[]> {
  if (names.length === 0) return [];
  let tags = await accountTags(db, accountId);
  const out: TagRow[] = [];
  for (const name of names) {
    let hit = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit && hit.kind === 'outcome') throw badRequest(`O nome '${name}' é de uma tabulação de conversa e não pode ser usado como etiqueta de contato`);
    if (!hit && create) {
      const { data, error } = await db.from('tags').insert({ account_id: accountId, user_id: actor, name, kind: 'contact' }).select('id, name, kind').limit(1);
      if (error && isUniqueViolation(error)) {
        tags = await accountTags(db, accountId);
        hit = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      } else if (error) throw unavailable('criar a etiqueta');
      else hit = (data ?? [])[0] as TagRow | undefined;
      if (hit && !tags.includes(hit)) tags.push(hit);
    }
    if (hit) out.push(hit);
  }
  return out;
}

export async function addTags(db: Db, accountId: string, actor: string, contactId: string, names: string[]): Promise<string[]> {
  const tags = await resolveTagIds(db, accountId, actor, names, true);
  if (tags.length === 0) return [];
  const { data: links } = await db.from('contact_tags').select('tag_id').eq('contact_id', contactId).limit(1000);
  const have = new Set(((links ?? []) as Array<{ tag_id: string }>).map((l) => l.tag_id));
  const fresh = tags.filter((t) => !have.has(t.id));
  if (fresh.length === 0) return [];
  const { error } = await db.from('contact_tags').upsert(fresh.map((t) => ({ contact_id: contactId, tag_id: t.id })), { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
  if (error) throw unavailable('aplicar as etiquetas');
  return fresh.map((t) => t.name);
}

export async function removeTags(db: Db, accountId: string, contactId: string, names: string[]): Promise<string[]> {
  const tags = (await accountTags(db, accountId)).filter((t) => t.kind !== 'outcome' && names.some((n) => n.toLowerCase() === t.name.toLowerCase()));
  if (tags.length === 0) return [];
  const { data: links } = await db.from('contact_tags').select('tag_id').eq('contact_id', contactId).in('tag_id', tags.map((t) => t.id));
  const present = new Set(((links ?? []) as Array<{ tag_id: string }>).map((l) => l.tag_id));
  const toRemove = tags.filter((t) => present.has(t.id));
  if (toRemove.length === 0) return [];
  const { error } = await db.from('contact_tags').delete().eq('contact_id', contactId).in('tag_id', toRemove.map((t) => t.id));
  if (error) throw unavailable('remover as etiquetas');
  return toRemove.map((t) => t.name);
}

// ── Telefones alternativos ──────────────────────────────────────────────────

interface AltPhone {
  id: string;
  phone: string;
  phone_normalized: string;
  ordem: number;
}

async function altPhonesOf(db: Db, contactId: string): Promise<AltPhone[]> {
  const { data, error } = await db.from('contact_phones').select('id, phone, phone_normalized, ordem').eq('contact_id', contactId).gte('ordem', 2).order('ordem', { ascending: true }).limit(100);
  if (error) throw unavailable('consultar os telefones do contato');
  return (data ?? []) as AltPhone[];
}

/** Telefone (só dígitos com DDI) pertence a outro contato da conta? */
async function ownerOfPhone(db: Db, accountId: string, phone: string): Promise<string | null> {
  const found = await findExistingContact(db, accountId, phone);
  return found?.id ?? null;
}

/** Acrescenta alternativos livres (os que já são deste contato ou de outro contato são ignorados). Devolve os adicionados e os ignorados. */
export async function addAltPhones(db: Db, accountId: string, contact: ContactDbRow, phones: string[]): Promise<{ added: string[]; ignored: string[] }> {
  const added: string[] = [];
  const ignored: string[] = [];
  const current = await altPhonesOf(db, contact.id);
  let ordem = current.length > 0 ? Math.max(...current.map((p) => p.ordem)) + 1 : 2;
  let count = current.length;
  for (const phone of phones) {
    if (count >= MAX_ALT_PHONES || (await ownerOfPhone(db, accountId, phone))) {
      ignored.push(phone);
      continue;
    }
    const { error } = await db.from('contact_phones').insert({ contact_id: contact.id, phone: `+${phone}`, phone_normalized: phone, ordem });
    if (error) {
      if (isUniqueViolation(error)) {
        ignored.push(phone);
        continue;
      }
      throw unavailable('gravar o telefone alternativo');
    }
    added.push(phone);
    ordem += 1;
    count += 1;
  }
  return { added, ignored };
}

/** PATCH: a lista vira EXATAMENTE os alternativos do contato. Número de OUTRO contato = 409. Devolve se algo mudou. */
export async function replaceAltPhones(db: Db, accountId: string, contact: ContactDbRow, phones: string[]): Promise<boolean> {
  const current = await altPhonesOf(db, contact.id);
  const wanted = phones.filter((p) => !phonesMatch(contact.phone, p));
  for (const phone of wanted) {
    if (current.some((c) => c.phone_normalized === phone)) continue;
    const owner = await ownerOfPhone(db, accountId, phone);
    if (owner && owner !== contact.id) {
      throw new ApiError('conflict', 'Um dos telefones já pertence a outro contato desta conta', 409, undefined, undefined, { reason: 'phone_in_use' });
    }
  }
  const toRemove = current.filter((c) => !wanted.includes(c.phone_normalized));
  const toAdd = wanted.filter((p) => !current.some((c) => c.phone_normalized === p));
  if (toRemove.length === 0 && toAdd.length === 0) return false;
  if (toRemove.length > 0) {
    const { error } = await db.from('contact_phones').delete().eq('contact_id', contact.id).in('id', toRemove.map((r) => r.id));
    if (error) throw unavailable('atualizar os telefones do contato');
  }
  let ordem = Math.max(1, ...current.filter((c) => !toRemove.includes(c)).map((c) => c.ordem)) + 1;
  for (const phone of toAdd) {
    const { error } = await db.from('contact_phones').insert({ contact_id: contact.id, phone: `+${phone}`, phone_normalized: phone, ordem });
    if (error) {
      if (isUniqueViolation(error)) throw new ApiError('conflict', 'Um dos telefones já pertence a outro contato desta conta', 409, undefined, undefined, { reason: 'phone_in_use' });
      throw unavailable('gravar o telefone alternativo');
    }
    ordem += 1;
  }
  return true;
}

// ── Upsert (POST) ────────────────────────────────────────────────────────────

async function findByCpf(db: Db, accountId: string, cpf: string): Promise<ContactDbRow | null> {
  const { data, error } = await db.from('contacts').select(CONTACT_SELECT).eq('account_id', accountId).eq('cpf', cpf).order('created_at', { ascending: true }).limit(1);
  if (error) throw unavailable('consultar o contato');
  return ((data ?? [])[0] as ContactDbRow | undefined) ?? null;
}

export interface UpsertResult {
  contact: ContactDbRow;
  created: boolean;
  updatedFields: string[];
  ignoredPhones: string[];
}

export async function upsertContact(db: Db, args: { accountId: string; actor: string; write: ContactWrite }): Promise<UpsertResult> {
  const { accountId, actor, write } = args;
  const phone = write.phone!;
  // Campos personalizados inexistentes: 422 antes de gravar qualquer coisa.
  const defs = write.customFields ? await resolveCustomFields(db, accountId, Object.keys(write.customFields)) : new Map<string, FieldDef>();

  // Identidade: CPF primeiro, depois telefone (mesma regra de "mesmo número" do webhook e da importação).
  let existing: ContactDbRow | null = write.cpf ? await findByCpf(db, accountId, write.cpf) : null;
  if (!existing) existing = (await findExistingContact(db, accountId, phone)) as ContactDbRow | null;

  let created = false;
  const updated: string[] = [];
  let contact: ContactDbRow;

  if (!existing) {
    const { data, error } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: actor,
        phone,
        name: write.name ?? phone,
        ...(write.email ? { email: write.email } : {}),
        ...(write.company ? { company: write.company } : {}),
        ...(write.institution ? { instituicao: write.institution } : {}),
        ...(write.cpf ? { cpf: write.cpf } : {}),
      })
      .select(CONTACT_SELECT)
      .limit(1);
    if (error) {
      // Corrida: o mesmo número foi criado entre a busca e o INSERT (índice único da conta) → refaz a leitura e segue como existente.
      if (!isUniqueViolation(error)) throw unavailable('criar o contato');
      existing = (await findExistingContact(db, accountId, phone)) as ContactDbRow | null;
      if (!existing) throw new ApiError('conflict', 'Conflito ao criar o contato; tente novamente', 409);
    } else {
      const row = (data ?? [])[0] as ContactDbRow | undefined;
      if (!row) throw unavailable('criar o contato');
      contact = row;
      created = true;
    }
  }

  if (!created) {
    const current = (await getContactRow(db, accountId, existing!.id))!;
    // Preenche SÓ o que está vazio; nunca troca o telefone principal.
    const patch: Record<string, unknown> = {};
    if (write.name && looksLikePlaceholderName(current.name)) (patch.name = write.name), updated.push('name');
    if (write.email && isBlank(current.email)) (patch.email = write.email), updated.push('email');
    if (write.company && isBlank(current.company)) (patch.company = write.company), updated.push('company');
    if (write.institution && isBlank(current.instituicao)) (patch.instituicao = write.institution), updated.push('institution');
    if (write.cpf && isBlank(current.cpf)) (patch.cpf = write.cpf), updated.push('cpf');
    contact = current;
    if (Object.keys(patch).length > 0) {
      const { error } = await db.from('contacts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', current.id).eq('account_id', accountId);
      if (error) throw unavailable('atualizar o contato');
      contact = (await getContactRow(db, accountId, current.id)) ?? current;
    }
  }

  let ignoredPhones: string[] = [];
  if (write.phones && write.phones.length > 0) {
    const r = await addAltPhones(db, accountId, contact!, write.phones.filter((p) => !phonesMatch(contact!.phone, p)));
    ignoredPhones = r.ignored;
    if (r.added.length > 0 && !created) updated.push('phones');
  }
  if (write.tagsAdd && write.tagsAdd.length > 0) {
    const added = await addTags(db, accountId, actor, contact!.id, write.tagsAdd);
    if (added.length > 0 && !created) updated.push('tags');
  }
  if (write.customFields && Object.keys(write.customFields).length > 0) {
    const changed = await writeCustomValues(db, contact!.id, defs, write.customFields, true);
    if (changed.length > 0 && !created) updated.push('custom_fields');
  }
  return { contact: contact!, created, updatedFields: updated, ignoredPhones };
}

// ── PATCH ────────────────────────────────────────────────────────────────────

export async function patchContact(db: Db, args: { accountId: string; actor: string; id: string; write: ContactWrite }): Promise<{ contact: ContactDbRow; updatedFields: string[] } | null> {
  const { accountId, actor, id, write } = args;
  const current = await getContactRow(db, accountId, id);
  if (!current) return null;
  if (write.phone && !phonesMatch(current.phone, write.phone)) {
    throw badRequest('O telefone principal não pode ser alterado por esta rota; use "phones" para os telefones alternativos');
  }
  const defs = write.customFields ? await resolveCustomFields(db, accountId, Object.keys(write.customFields)) : new Map<string, FieldDef>();
  const updated: string[] = [];

  // Sobrescreve; null/'' limpa e-mail, empresa e instituição. Nome vazio NÃO limpa (o contato precisa de um nome).
  const patch: Record<string, unknown> = {};
  if (write.name) (patch.name = write.name), updated.push('name');
  if (write.email !== undefined) (patch.email = write.email), updated.push('email');
  if (write.company !== undefined) (patch.company = write.company), updated.push('company');
  if (write.institution !== undefined) (patch.instituicao = write.institution), updated.push('institution');
  if (write.cpf !== undefined) (patch.cpf = write.cpf), updated.push('cpf');
  if (Object.keys(patch).length > 0) {
    const { error } = await db.from('contacts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('account_id', accountId);
    if (error) throw unavailable('atualizar o contato');
  }
  if (write.phones && (await replaceAltPhones(db, accountId, current, write.phones))) updated.push('phones');
  if (write.tagsAdd && write.tagsAdd.length > 0 && (await addTags(db, accountId, actor, id, write.tagsAdd)).length > 0) updated.push('tags');
  if (write.tagsRemove && write.tagsRemove.length > 0 && (await removeTags(db, accountId, id, write.tagsRemove)).length > 0 && !updated.includes('tags')) updated.push('tags');
  if (write.customFields && Object.keys(write.customFields).length > 0 && (await writeCustomValues(db, id, defs, write.customFields, false)).length > 0) updated.push('custom_fields');

  if (updated.length > 0 && Object.keys(patch).length === 0) {
    await db.from('contacts').update({ updated_at: new Date().toISOString() }).eq('id', id).eq('account_id', accountId);
  }
  return { contact: (await getContactRow(db, accountId, id)) ?? current, updatedFields: updated };
}
