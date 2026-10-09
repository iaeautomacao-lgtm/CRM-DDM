// Processa UM bloco de linhas da importação de contatos do Disparador (dedupe, contatos, tags, telefones alternativos,
// VAR1–VAR3 e vínculo com a campanha/rascunho). Movido da rota POST /api/disparador/contacts/import SEM mudar regra:
// a rota (um bloco por requisição) e o job de importação em segundo plano (import-jobs.ts, migration 197) chamam a MESMA
// função — por isso o resultado é idêntico nos dois caminhos.
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { isUniqueViolation, normalizeKey } from "@/lib/contacts/dedupe";
import {
  resolveImportTagIds,
  assignImportedContactTags,
  type ContactTagAssignment,
} from "@/lib/contacts/resolve-import-tags";
import { formatBrazilianPhone, phoneKey } from "@/lib/disparador/phone-key";
import { loadBlacklistKeysForPhones } from "@/lib/disparador/blacklist-keys";
import {
  dedupeAltPhoneAssignments,
  dedupeImportVariables,
  importPhoneKey,
  writeInBatches,
} from "@/lib/disparador/import-dedupe";
import { processWithConcurrency } from "@/lib/disparador/concurrency";
import { contactLookupDigits, sliceInto } from "@/lib/disparador/import-chunks";
import { writeLog } from "@/lib/logger";
import { safeDbError } from "@/lib/privacy/mask";

// Lotes de escrita (um import de 100 mil linhas fazia ~2.700 idas ao banco:
// contatos de 50 em 50, VARs de 100 em 100). Até WRITE_CONCURRENCY lotes
// gravam ao mesmo tempo.
const CONTACT_INSERT_CHUNK = 500;
const CONTACT_FALLBACK_CHUNK = 50;
const BULK_WRITE_CHUNK = 1000;
const WRITE_CONCURRENCY = 3;
// Consultas .in() de contatos existentes: valores curtos (dígitos/CPF), 200
// por consulta cabem na URL com folga.
const LOOKUP_IN_CHUNK = 200;
const LOOKUP_CONCURRENCY = 6;
const BACKFILL_CONCURRENCY = 10;

// Looks up a value in `row` by trying each of `keys` against the row's
// keys lowercased/trimmed, so CSV/XLSX headers can vary in case, spacing,
// or naming (e.g. "Telefone", "celular", "whatsapp") without breaking import.
//
// O mapa de cabeçalhos normalizados é montado uma vez por linha (cache por
// objeto) — antes era refeito a cada getField, ~15 vezes por linha.
const normalizedRowCache = new WeakMap<object, Record<string, any>>();
// Cabeçalho cru → normalizado, memorizado: as linhas de um arquivo repetem as mesmas poucas
// colunas, então trim/toLowerCase de cada cabeçalho roda uma vez por arquivo, não por linha.
const headerNormCache = new Map<string, string>();
function normalizeHeader(raw: string): string {
  let norm = headerNormCache.get(raw);
  if (norm === undefined) {
    norm = raw.trim().toLowerCase();
    if (headerNormCache.size >= 2000) headerNormCache.clear();
    headerNormCache.set(raw, norm);
  }
  return norm;
}

export function getField(row: Record<string, any>, ...keys: string[]): string | undefined {
  let normalizedRow = normalizedRowCache.get(row);
  if (!normalizedRow) {
    normalizedRow = {};
    for (const rawKey of Object.keys(row)) {
      normalizedRow[normalizeHeader(rawKey)] = row[rawKey];
    }
    normalizedRowCache.set(row, normalizedRow);
  }
  for (const key of keys) {
    const value = normalizedRow[key.toLowerCase()];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

// column_map opcional enviado pelo wizard (Step 2 do campanhas/page.tsx) —
// cada chave é um campo DDM, o valor é o nome exato da coluna do CSV que o
// usuário escolheu para ele (case-insensitive, mesma normalização de
// getField). Quando presente para um campo, substitui a heurística daquele
// campo por completo (não é fallback por linha) — é uma escolha explícita
// do usuário, não deve voltar a adivinhar. Ausente/omitido em um campo
// específico → mantém a heurística de sempre (retrocompatibilidade total
// com imports que nunca mandaram column_map).
export type ColumnMap = Partial<Record<"name" | "phone" | "cpf" | "var1" | "var2" | "var3", string>>;

export function resolveField(
  row: Record<string, any>,
  mappedKey: string | undefined,
  fallbackKeys: string[]
): string | undefined {
  if (mappedKey && mappedKey.trim()) return getField(row, mappedKey);
  return getField(row, ...fallbackKeys);
}

// Column names recognized as the contact's display name — "var1" last,
// covering the Meta CONTATO;VAR1;VAR2;VAR3 export format when no
// standard name column exists (see tagsArray comment below).
//
// "contato" NÃO entra aqui — nesse mesmo formato Meta, CONTATO é o
// telefone (ver TELEFONE1_KEYS), não o nome. Incluí-lo faria getField
// devolver o telefone como nome sempre que ambas as colunas existirem,
// já que a ordem desta lista é a ordem de prioridade.
const NAME_FIELD_KEYS = [
  "nome",
  "name",
  "nome completo",
  "full name",
  "cliente",
  "var1",
];

// Telefone principal — colunas numeradas explícitas primeiro, com os
// aliases genéricos já existentes (sem número) como fallback para CSVs
// no formato antigo que não distinguem TELEFONE1/2/3.
const TELEFONE1_KEYS = [
  "telefone1", "telefone 1", "fone1", "fone 1", "celular1", "celular 1",
  "whatsapp1", "whatsapp 1", "tel1", "tel 1",
  "contato", "telefone", "phone", "celular", "tel", "fone", "whatsapp", "número", "numero", "cell",
];
// TELEFONE2/3 são só para a escada de números alternativos (ver
// wacrm.contact_phones, migration 077) — não têm fallback genérico
// porque não existiam antes deste recurso.
const TELEFONE2_KEYS = [
  "telefone2", "telefone 2", "fone2", "fone 2", "celular2", "celular 2",
  "whatsapp2", "whatsapp 2", "tel2", "tel 2",
];
const TELEFONE3_KEYS = [
  "telefone3", "telefone 3", "fone3", "fone 3", "celular3", "celular 3",
  "whatsapp3", "whatsapp 3", "tel3", "tel 3",
];
const CPF_FIELD_KEYS = ["cpf", "cpf_aluno", "documento", "doc"];

// Normaliza CPF pra só dígitos; só trata como presente se sobrarem
// exatamente 11 dígitos (tamanho de um CPF válido) — um valor truncado
// ou obviamente errado não deve virar chave de dedup nem sobrescrever
// o CPF de um contato existente.
function normalizeCpf(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

export interface ImportBlockInput {
  accountId: string;
  userId: string;
  rows: any[];
  columnMap: ColumnMap;
  campaignId: string | null;
  draftId: string | null;
  /** 0 = primeiro bloco (limpa o vínculo anterior do rascunho/campanha); os demais acrescentam. */
  chunkIndex: number;
}

export interface ImportBlockResults {
  importados: number;
  duplicados: number;
  invalidos: number;
  blacklisted: number;
  variaveis_falhas: number;
  erros: string[];
}

export type ImportBlockOutcome =
  | { results: ImportBlockResults; linked: number; failure?: undefined }
  | { failure: { error: string; status: number }; results?: undefined; linked?: undefined };

export async function importContactBlock(input: ImportBlockInput): Promise<ImportBlockOutcome> {
  const { accountId, userId, rows, columnMap, chunkIndex } = input;
  const campaignIdRaw = input.campaignId;
  const draftIdRaw = input.draftId;

  // 3. Process imported rows
  // variaveis_falhas: linhas de VAR1/VAR2/VAR3 que NÃO foram gravadas
  // (lote com erro no banco). > 0 significa que a campanha sairia com
  // variável vazia para esses contatos — o wizard avisa para reimportar.
  const results = {
    importados: 0,
    duplicados: 0,
    invalidos: 0,
    blacklisted: 0,
    variaveis_falhas: 0,
    erros: [] as string[],
  };

  // Blacklist has no account_id column in the disparador schema — it's a
  // single shared list across every account on this instance, not scoped
  // per-tenant. Left unfiltered here; scoping it requires a migration.
  // Carregada mais abaixo, só para os telefones DESTE bloco (loadBlacklistKeysForPhones).

  // Existing contacts for this account, keyed by normalized phone. Used
  // instead of a DB-level upsert because the real unique constraint,
  // idx_contacts_account_phone_normalized, is a *partial* index (WHERE
  // phone_normalized <> ''), which Postgres won't infer as an ON CONFLICT
  // arbiter from a bare column list — the same reason the main contacts
  // CSV importer (import-modal.tsx) pre-checks and inserts rather than
  // upserts.
  // Em vez de carregar a conta inteira (100 mil contatos = 100+ páginas a
  // cada bloco), busca só os contatos que podem coincidir com as linhas
  // deste bloco: por phone_normalized (todas as formas do número, ver
  // contactLookupDigits) e por CPF. Ambas as consultas são `.in()` em
  // fatias curtas, indexadas, em paralelo. Erro de leitura lança — seguir
  // sem os existentes criaria contatos duplicados.
  const lookupDigits = new Set<string>();
  const lookupCpfs = new Set<string>();
  const blockPhoneKeys = new Set<string>();
  for (const row of rows) {
    const rawPhone =
      resolveField(row, columnMap.phone, TELEFONE1_KEYS) ||
      getField(row, ...TELEFONE2_KEYS) ||
      getField(row, ...TELEFONE3_KEYS);
    if (rawPhone) {
      const formatted = formatBrazilianPhone(rawPhone);
      if (formatted) {
        for (const d of contactLookupDigits(formatted)) lookupDigits.add(d);
        if (formatted.length >= 10) blockPhoneKeys.add(phoneKey(formatted));
      }
    }
    const cpf = normalizeCpf(resolveField(row, columnMap.cpf, CPF_FIELD_KEYS));
    if (cpf) lookupCpfs.add(cpf);
  }
  // Blacklist só dos telefones do bloco (RPC por chaves; sem ela, a lista inteira em cache curto).
  const blacklistSet = await loadBlacklistKeysForPhones(supabaseAdmin(), blockPhoneKeys);
  const existingById = new Map<string, any>();
  {
    const lookups: Array<{ column: "phone_normalized" | "cpf"; values: string[] }> = [
      ...sliceInto([...lookupDigits], LOOKUP_IN_CHUNK).map((values) => ({ column: "phone_normalized" as const, values })),
      ...sliceInto([...lookupCpfs], LOOKUP_IN_CHUNK).map((values) => ({ column: "cpf" as const, values })),
    ];
    await processWithConcurrency(lookups, LOOKUP_CONCURRENCY, async ({ column, values }) => {
      const { data, error } = await supabaseAdmin()
        .from("contacts")
        .select("id, name, phone_normalized, cpf")
        .eq("account_id", accountId)
        .in(column, values);
      if (error) throw new Error(`Erro ao consultar contatos existentes: ${error.message}`);
      for (const r of data ?? []) existingById.set(r.id, r);
    });
  }
  const existingRows: any[] = [...existingById.values()];
  type ExistingByPhone = {
    id: string;
    name: string | null;
    cpf: string | null;
    phone_normalized: string | null;
  };
  // Duas chaves: a exata (dígitos, igual ao índice único do banco) tem
  // prioridade; a de phoneKey (com/sem 55 e com/sem o 9º dígito — mesma
  // regra da blacklist) cobre o mesmo celular gravado no formato antigo,
  // que antes virava um contato novo duplicado.
  const existingContactsByKey = new Map<string, ExistingByPhone>();
  const existingContactsByPhoneKey = new Map<string, ExistingByPhone>();
  for (const r of existingRows ?? []) {
    const key = normalizeKey(r.phone_normalized ?? "");
    if (key) {
      const entry: ExistingByPhone = {
        id: r.id,
        name: r.name,
        cpf: r.cpf ?? null,
        phone_normalized: r.phone_normalized ?? null,
      };
      existingContactsByKey.set(key, entry);
      const looseKey = importPhoneKey(key);
      if (looseKey && !existingContactsByPhoneKey.has(looseKey)) {
        existingContactsByPhoneKey.set(looseKey, entry);
      }
    }
  }

  // Contatos existentes por CPF — dedup por CPF tem prioridade sobre
  // dedup por telefone quando o CSV traz CPF (o mesmo aluno pode
  // reaparecer com um telefone novo em campanhas diferentes). Reaproveita
  // o mesmo select de existingRows acima, já filtrado por account_id.
  const existingByCpf = new Map<
    string,
    { id: string; name: string | null; phone_normalized: string | null }
  >();
  for (const r of existingRows ?? []) {
    if (r.cpf) {
      existingByCpf.set(r.cpf, { id: r.id, name: r.name, phone_normalized: r.phone_normalized ?? null });
    }
  }

  type AltPhoneRow = { phone: string; phone_normalized: string; ordem: number };
  type PendingContact = {
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    cpf: string | null;
    altPhones: AltPhoneRow[];
    csvVars: (string | undefined)[];
    tagsArray: string[];
  };
  const pending: PendingContact[] = [];
  // altPhoneAssignments cobre os dois casos: contato já existente
  // (contact_id resolvido na hora, empurrado direto aqui dentro do
  // loop) e contato novo (resolvido depois do insert em lote, igual
  // ao padrão de tagAssignments abaixo). csvVarAssignments segue o
  // mesmo padrão para VAR1/VAR2/VAR3 (migration 079).
  const altPhoneAssignments: Array<{ contact_id: string; phone: string; phone_normalized: string; ordem: number }> = [];
  const csvVarAssignments: Array<{ contact_id: string; var_index: number; value: string }> = [];
  // Todo contato deste import (novo ou já existente) — vínculo do import
  // com a campanha (disp_import_contacts, migration 132). Independe de o
  // CSV ter VARn: sem ele a campanha não sabe quem é "do CSV".
  const importedContactIds = new Set<string>();
  // Dedup dentro do arquivo: a PRIMEIRA linha de cada pessoa vale e as
  // repetições contam como "duplicados" (mesma regra para contato novo e
  // já existente). seenInFile usa phoneKey (com/sem 9º dígito = mesmo
  // número); seenContactIds pega duas linhas que caem no mesmo contato
  // existente por caminhos diferentes (ex.: telefone numa, CPF na outra).
  const seenInFile = new Set<string>();
  const seenCpfInFile = new Set<string>();
  const seenContactIds = new Set<string>();
  // Preenchimento de nome/CPF de contatos que já existiam: coletado no
  // laço e gravado depois, em paralelo (antes: um UPDATE por linha, em
  // série, dentro do laço — uma reimportação de 100 mil linhas levava
  // horas). Só entram contatos que realmente precisam do preenchimento.
  const nameBackfills: Array<{ id: string; name: string }> = [];
  const cpfBackfills: Array<{ id: string; cpf: string }> = [];

  for (const row of rows) {
    // t2/t3 (telefones alternativos) não fazem parte dos campos do
    // mapeamento manual (Correção 3 só cobre Nome/Telefone
    // Principal/CPF/VAR1-3) — seguem 100% heurísticos.
    const t1 = resolveField(row, columnMap.phone, TELEFONE1_KEYS);
    const t2 = getField(row, ...TELEFONE2_KEYS);
    const t3 = getField(row, ...TELEFONE3_KEYS);
    // TELEFONE1 é o principal por padrão; se estiver vazio mas TELEFONE2
    // ou TELEFONE3 tiver algo, usa o primeiro preenchido como principal
    // (ver PASSO A4) — o resto vira telefone alternativo.
    const rawPhone = t1 || t2 || t3;
    if (!rawPhone) {
      results.invalidos++;
      continue;
    }

    const normalized = formatBrazilianPhone(rawPhone);
    if (!normalized || normalized.length < 10) {
      results.invalidos++;
      continue;
    }

    // Check Blacklist
    if (blacklistSet.has(phoneKey(normalized))) {
      results.blacklisted++;
      continue;
    }

    const cpfNormalized = normalizeCpf(resolveField(row, columnMap.cpf, CPF_FIELD_KEYS));
    // VAR1/VAR2/VAR3 — sem column_map, cai no literal "var1"/"var2"/"var3"
    // (getField já compara case-insensitive, então "VAR1"/"Var1" batem
    // sem precisar listar as duas formas).
    const csvVars = [
      resolveField(row, columnMap.var1, ["var1"]),
      resolveField(row, columnMap.var2, ["var2"]),
      resolveField(row, columnMap.var3, ["var3"]),
    ];

    const exactKey = normalizeKey(normalized);
    const key = importPhoneKey(normalized);
    const isDuplicateInFile =
      seenInFile.has(key) || (cpfNormalized !== null && seenCpfInFile.has(cpfNormalized));
    if (isDuplicateInFile) {
      results.duplicados++;
      continue;
    }

    // Telefones alternativos (TELEFONE2/3) — exclui o que virou
    // principal (rawPhone) pra não duplicar o mesmo número como
    // "alternativo" de si mesmo quando TELEFONE1 estava vazio.
    const altCandidates: Array<{ raw: string; ordem: number }> = [];
    if (t2 && t2 !== rawPhone) altCandidates.push({ raw: t2, ordem: 2 });
    if (t3 && t3 !== rawPhone) altCandidates.push({ raw: t3, ordem: 3 });
    const altPhones: AltPhoneRow[] = altCandidates
      .map(({ raw, ordem }) => {
        const altNormalized = formatBrazilianPhone(raw);
        if (!altNormalized || altNormalized.length < 10) return null;
        return { phone: altNormalized, phone_normalized: normalizeKey(altNormalized), ordem };
      })
      .filter((v): v is AltPhoneRow => v !== null);

    // Dedup por CPF tem prioridade sobre dedup por telefone.
    const existingContact = cpfNormalized
      ? existingByCpf.get(cpfNormalized)
      : undefined;
    const existingByPhone = existingContact
      ? undefined
      : (existingContactsByKey.get(exactKey) ?? existingContactsByPhoneKey.get(key));
    const matched = existingContact
      ? {
          id: existingContact.id,
          name: existingContact.name,
          cpf: cpfNormalized,
          phone_normalized: existingContact.phone_normalized,
        }
      : existingByPhone
        ? {
            id: existingByPhone.id,
            name: existingByPhone.name,
            cpf: existingByPhone.cpf,
            phone_normalized: existingByPhone.phone_normalized,
          }
        : null;

    if (matched) {
      // Mesmo contato existente já veio numa linha anterior do arquivo
      // (outro formato de telefone, ou CPF numa linha e telefone na
      // outra): não reprocessa. Sem isso as VARs dele entravam duas vezes
      // no upsert em lote e derrubavam o lote inteiro (import-dedupe.ts).
      if (seenContactIds.has(matched.id)) {
        results.duplicados++;
        continue;
      }
      seenContactIds.add(matched.id);
      seenInFile.add(key);
      if (cpfNormalized) seenCpfInFile.add(cpfNormalized);

      // Contato já existe — preenche o name se estiver vazio, ou se o
      // valor atual parece ser o telefone (import antigo com o alias
      // CONTATO lido como nome, antes de virar TELEFONE1_KEYS — ver
      // NAME_FIELD_KEYS acima). Nunca sobrescreve um nome que já parece
      // um nome de verdade.
      const nomePareceTelefone =
        !!matched.name &&
        (matched.name === matched.phone_normalized || /^\d{10,13}$/.test(matched.name));
      if (!matched.name || nomePareceTelefone) {
        const parsedName = resolveField(row, columnMap.name, NAME_FIELD_KEYS);
        if (parsedName) nameBackfills.push({ id: matched.id, name: parsedName });
      }
      // Backfill de CPF: só quando o contato foi encontrado por
      // telefone e ainda não tinha CPF gravado — se foi encontrado
      // por CPF, ele já tem exatamente esse CPF.
      if (!existingContact && cpfNormalized && !matched.cpf) {
        cpfBackfills.push({ id: matched.id, cpf: cpfNormalized });
      }
      for (const alt of altPhones) {
        altPhoneAssignments.push({ contact_id: matched.id, ...alt });
      }
      csvVars.forEach((v, idx) => {
        if (v) csvVarAssignments.push({ contact_id: matched.id, var_index: idx, value: v });
      });
      importedContactIds.add(matched.id);
      results.duplicados++;
      continue;
    }
    seenInFile.add(key);
    if (cpfNormalized) seenCpfInFile.add(cpfNormalized);

    const rawTags = getField(row, "tags", "tag", "etiquetas", "categorias") || "";
    const tagsArray = rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : [];

    pending.push({
      phone: normalized,
      name: resolveField(row, columnMap.name, NAME_FIELD_KEYS) || null,
      email: getField(row, "email", "e-mail", "emaill", "correio") || null,
      company:
        getField(
          row,
          "origem",
          "company",
          "empresa",
          "organização",
          "organizacao",
          "institution"
        ) || null,
      cpf: cpfNormalized,
      altPhones,
      csvVars,
      tagsArray,
    });
  }

  // 3b. Backfill dos contatos existentes (nome / CPF), em paralelo. Falha
  // numa linha só é registrada — não derruba o import.
  // Um UPDATE … FROM por fatia de 1.000 contatos (RPC import_backfill_contacts, migration 181).
  // Se a RPC não existir ou a fatia for recusada (ex.: CPF já usado por outro contato), refaz a
  // fatia linha a linha — como antes — para que uma linha ruim não derrube as outras.
  if (nameBackfills.length > 0 || cpfBackfills.length > 0) {
    const backfillById = new Map<string, { id: string; name?: string; cpf?: string }>();
    for (const { id, name } of nameBackfills) backfillById.set(id, { ...backfillById.get(id), id, name });
    for (const { id, cpf } of cpfBackfills) backfillById.set(id, { ...backfillById.get(id), id, cpf });
    await processWithConcurrency(sliceInto([...backfillById.values()], BULK_WRITE_CHUNK), WRITE_CONCURRENCY, async (slice) => {
      const { error } = await supabaseAdmin().rpc("import_backfill_contacts", { p_account_id: accountId, p_items: slice });
      if (!error) return;
      console.warn("[Contacts Import] Backfill em lote indisponível; gravando linha a linha:", error.message);
      await processWithConcurrency(slice, BACKFILL_CONCURRENCY, async ({ id, name, cpf }) => {
        if (name) {
          const { error: nameErr } = await supabaseAdmin().from("contacts").update({ name }).eq("id", id);
          if (nameErr) console.error("[Contacts Import] Failed to backfill name:", safeDbError(nameErr));
        }
        if (cpf) {
          const { error: cpfErr } = await supabaseAdmin().from("contacts").update({ cpf }).eq("id", id).is("cpf", null);
          if (cpfErr) console.error("[Contacts Import] Failed to backfill cpf:", safeDbError(cpfErr));
        }
      });
    });
  }

  // 4. Resolve tag names -> ids up front, scoped to this account
  const allTagNames = pending.flatMap((p) => p.tagsArray);
  let tagIdByKey = new Map<string, string>();
  if (allTagNames.length > 0) {
    ({ tagIdByKey } = await resolveImportTagIds(supabaseAdmin(), {
      accountId,
      userId: userId,
      tagNames: allTagNames,
      canCreateTags: true,
    }));
  }

  // 5. Insert contacts em blocos de 500, até 3 em paralelo. Um bloco com
  // erro é refeito em fatias de 50 e, se ainda falhar, linha a linha — uma
  // linha ruim/duplicada não derruba as outras.
  const tagAssignments: ContactTagAssignment[] = [];

  const insertedNowIds = new Set<string>();
  const onInserted = (source: PendingContact, contactId: string) => {
    results.importados++;
    insertedNowIds.add(contactId);
    if (source.tagsArray.length > 0) {
      tagAssignments.push({ contactId, tagNames: source.tagsArray });
    }
    for (const alt of source.altPhones) {
      altPhoneAssignments.push({ contact_id: contactId, ...alt });
    }
    source.csvVars.forEach((v, idx) => {
      if (v) csvVarAssignments.push({ contact_id: contactId, var_index: idx, value: v });
    });
    importedContactIds.add(contactId);
  };

  const toInsertRow = (p: PendingContact) => ({
    user_id: userId,
    account_id: accountId,
    phone: p.phone,
    name: p.name,
    email: p.email,
    company: p.company,
    cpf: p.cpf,
  });

  const insertOneByOne = async (chunk: PendingContact[]) => {
    for (const source of chunk) {
      const row = toInsertRow(source);
      const { data: singleData, error: singleErr } = await supabaseAdmin()
        .from("contacts")
        .insert(row)
        .select("id")
        .single();

      if (!singleErr && singleData) {
        onInserted(source, singleData.id);
      } else if (isUniqueViolation(singleErr)) {
        results.duplicados++;
        // Já existia (corrida ou chave normalizada diferente): continua
        // sendo um contato do CSV, então entra no vínculo do import.
        const digits = String(row.phone ?? "").replace(/\D/g, "");
        if (digits) {
          const { data: existing } = await supabaseAdmin()
            .from("contacts")
            .select("id")
            .eq("account_id", accountId)
            .eq("phone_normalized", digits)
            .limit(1);
          if (existing?.[0]?.id) importedContactIds.add(existing[0].id);
        }
      } else {
        console.error("[Contacts Import] Falha ao salvar contato:", safeDbError(singleErr));
        results.erros.push(`${source.phone}: não foi possível salvar o contato.`);
      }
    }
  };

  const insertChunk = async (chunk: PendingContact[], canSplit: boolean): Promise<void> => {
    const { data, error } = await supabaseAdmin()
      .from("contacts")
      .insert(chunk.map(toInsertRow))
      .select("id");
    if (!error) {
      const inserted = data ?? [];
      for (let j = 0; j < inserted.length; j++) {
        const source = chunk[j];
        if (source) onInserted(source, inserted[j].id);
      }
      return;
    }
    if (canSplit && chunk.length > CONTACT_FALLBACK_CHUNK) {
      for (const slice of sliceInto(chunk, CONTACT_FALLBACK_CHUNK)) await insertChunk(slice, false);
      return;
    }
    await insertOneByOne(chunk);
  };

  await processWithConcurrency(
    sliceInto(pending, CONTACT_INSERT_CHUNK),
    WRITE_CONCURRENCY,
    (chunk) => insertChunk(chunk, true)
  );

  // 6. Wire tags onto the contacts we just created. Failure here must not
  // mask a successful contact import.
  if (tagAssignments.length > 0) {
    try {
      await assignImportedContactTags(supabaseAdmin(), tagAssignments, tagIdByKey);
    } catch (err) {
      console.error("[Contacts Import] Failed to assign tags:", safeDbError(err));
    }
  }

  // 7. Save alternate phones (TELEFONE2/3) into wacrm.contact_phones —
  // fundação da escada de números (ver processQueue.ts: tryNextPhone).
  // Best-effort: falha aqui não deve mascarar um import de contatos
  // bem-sucedido, e a tabela pode ainda não existir se a migration 077
  // não tiver sido aplicada. Deduplicado por (contact_id, ordem) — duas
  // linhas iguais no mesmo lote derrubariam o upsert inteiro — e um lote
  // com erro não pula os seguintes (writeInBatches).
  if (altPhoneAssignments.length > 0) {
    const altSummary = await writeInBatches(
      dedupeAltPhoneAssignments(altPhoneAssignments),
      BULK_WRITE_CHUNK,
      async (chunk) => {
        const { error: altErr } = await supabaseAdmin()
          .from("contact_phones")
          .upsert(chunk, { onConflict: "contact_id,ordem" });
        return altErr;
      },
      WRITE_CONCURRENCY
    );
    if (altSummary.failedBatches > 0) {
      console.error("[Contacts Import] Failed to save alternate phones:", safeDbError(altSummary.firstError));
      results.erros.push(
        `Telefones alternativos: ${altSummary.failedRows} não foram salvos. Tente importar de novo.`
      );
    }
  }

  // 8. Save VAR1/VAR2/VAR3 into wacrm.contact_import_variables —
  // permite que template_variable_map resolva `{ type: "csv_var" }` por
  // contato em startCampaign.ts (migration 079). Não derruba o import,
  // mas também não falha mais em silêncio: linhas deduplicadas pela chave
  // de conflito (o mesmo contato duas vezes no lote fazia o upsert falhar
  // com "ON CONFLICT DO UPDATE command cannot affect row a second time" e
  // o try/catch pulava TODOS os lotes seguintes), cada lote é gravado
  // independente e as falhas voltam em results.variaveis_falhas/erros e
  // em system_logs.
  if (csvVarAssignments.length > 0) {
    const varChunkSize = BULK_WRITE_CHUNK;
    const varRows = dedupeImportVariables(csvVarAssignments);
    let varFailedRows = 0;
    let varFirstError: string | null = null;
    if (!campaignIdRaw && !draftIdRaw) {
      // Import standalone (disparador/contatos, sem wizard de campanha)
      // — grava com campaign_id/draft_id NULL em vez de descartar, pra
      // aparecer no painel de perfil do contato (contact-detail-view.tsx).
      // Não dá pra usar upsert com onConflict aqui: as constraints
      // UNIQUE(contact_id, campaign_id, var_index) e
      // UNIQUE(contact_id, draft_id, var_index) nunca consideram duas
      // linhas NULL/NULL como conflitantes (semântica padrão de UNIQUE
      // no Postgres), então um upsert nunca faria merge — só acumularia
      // uma linha nova a cada reimport do mesmo contato. Substitui
      // explicitamente (delete das linhas NULL/NULL existentes desses
      // contatos + insert) pra manter só a versão mais recente.
      const affectedContactIds = Array.from(new Set(varRows.map((v) => v.contact_id)));
      let deleteErrMessage: string | null = null;
      for (let i = 0; i < affectedContactIds.length && !deleteErrMessage; i += 500) {
        const { error: deleteErr } = await supabaseAdmin()
          .from("contact_import_variables")
          .delete()
          .in("contact_id", affectedContactIds.slice(i, i + 500))
          .is("campaign_id", null)
          .is("draft_id", null);
        if (deleteErr) deleteErrMessage = deleteErr.message;
      }
      if (deleteErrMessage) {
        // Sem a limpeza, inserir acumularia versões antigas e novas.
        varFailedRows = varRows.length;
        varFirstError = deleteErrMessage;
      } else {
        const summary = await writeInBatches(varRows, varChunkSize, async (chunk) => {
          const { error: insertErr } = await supabaseAdmin()
            .from("contact_import_variables")
            .insert(
              chunk.map((v) => ({
                contact_id: v.contact_id,
                campaign_id: null,
                draft_id: null,
                var_index: v.var_index,
                value: v.value,
              }))
            );
          return insertErr;
        }, WRITE_CONCURRENCY);
        varFailedRows = summary.failedRows;
        varFirstError = summary.firstError;
      }
    } else {
      const onConflict = campaignIdRaw
        ? "contact_id,campaign_id,var_index"
        : "contact_id,draft_id,var_index";
      const summary = await writeInBatches(varRows, varChunkSize, async (chunk) => {
        const { error: varErr } = await supabaseAdmin()
          .from("contact_import_variables")
          .upsert(
            chunk.map((v) => ({
              contact_id: v.contact_id,
              campaign_id: campaignIdRaw,
              draft_id: campaignIdRaw ? null : draftIdRaw,
              var_index: v.var_index,
              value: v.value,
            })),
            { onConflict }
          );
        return varErr;
      }, WRITE_CONCURRENCY);
      varFailedRows = summary.failedRows;
      varFirstError = summary.firstError;
    }

    if (varFailedRows > 0) {
      results.variaveis_falhas = varFailedRows;
      results.erros.push(
        `Variáveis VAR1–VAR3: ${varFailedRows} de ${varRows.length} valores não foram salvos — reimporte o arquivo antes de iniciar a campanha.`
      );
      console.error("[Contacts Import] Failed to save csv import variables:", safeDbError(varFirstError));
      await writeLog({
        account_id: accountId,
        level: "error",
        source: "import",
        event: "import_variables_failed",
        message: `${varFailedRows} de ${varRows.length} variáveis do CSV não foram gravadas`,
        payload: {
          campaign_id: campaignIdRaw,
          draft_id: draftIdRaw,
          failed_rows: varFailedRows,
          total_rows: varRows.length,
          error: varFirstError,
        },
      });
    }
  }

  // 9. Vínculo import → campanha (migration 132). Diferente dos passos
  // acima, NÃO é best-effort: sem ele a campanha de CSV não pode iniciar
  // (startCampaign recusa), então a falha volta como erro do import.
  // Reimportar o CSV substitui o vínculo anterior do mesmo rascunho/campanha:
  // em import por blocos, só o primeiro (chunk_index 0) limpa; os demais
  // acrescentam.
  if (campaignIdRaw || draftIdRaw) {
    const idColumn = campaignIdRaw ? "campaign_id" : "draft_id";
    const idValue = (campaignIdRaw ?? draftIdRaw) as string;
    let clearErr: { message: string } | null = null;
    if (chunkIndex === 0) {
      ({ error: clearErr } = await supabaseAdmin()
        .from("disp_import_contacts")
        .delete()
        .eq("account_id", accountId)
        .eq(idColumn, idValue));
    }
    // Reimport ao editar: o vínculo antigo da criação (por rascunho) sai
    // também — a lista nova substitui a antiga, nunca soma.
    if (chunkIndex === 0 && !clearErr && campaignIdRaw) {
      const { data: camp } = await supabaseAdmin()
        .from("campaigns")
        .select("import_draft_id")
        .eq("id", campaignIdRaw)
        .eq("account_id", accountId)
        .limit(1);
      const draftOfCampaign = camp?.[0]?.import_draft_id;
      if (draftOfCampaign) {
        ({ error: clearErr } = await supabaseAdmin()
          .from("disp_import_contacts")
          .delete()
          .eq("account_id", accountId)
          .eq("draft_id", draftOfCampaign));
      }
    }
    if (clearErr) {
      console.error("[Contacts Import] Failed to clear import link:", safeDbError(clearErr));
      return { failure: { error: "Contatos importados, mas não foi possível vinculá-los à campanha. Tente importar de novo.", status: 500 } };
    }
    // Reenvio do mesmo bloco (ou contato repetido em blocos diferentes): não reinserir vínculos que já
    // existem — o INSERT em lote falharia por unicidade e o fallback linha a linha custaria 1 ida por linha.
    // O bloco 0 acabou de limpar os vínculos, então só os seguintes precisam da checagem.
    const alreadyLinked = new Set<string>();
    // Contatos criados agora neste bloco ainda não podem estar vinculados: só os pré-existentes entram na checagem.
    const preExistingIds = [...importedContactIds].filter((id) => !insertedNowIds.has(id));
    if (chunkIndex > 0 && preExistingIds.length > 0) {
      await processWithConcurrency(sliceInto(preExistingIds, LOOKUP_IN_CHUNK), LOOKUP_CONCURRENCY, async (ids) => {
        const { data: linked, error: linkedErr } = await supabaseAdmin()
          .from("disp_import_contacts")
          .select("contact_id")
          .eq("account_id", accountId)
          .eq(idColumn, idValue)
          .in("contact_id", ids);
        if (linkedErr) return; // sem a checagem, o INSERT/fallback abaixo continua correto, só mais lento
        for (const r of linked ?? []) alreadyLinked.add(r.contact_id);
      });
    }
    const linkRows = [...importedContactIds].filter((id) => !alreadyLinked.has(id)).map((contact_id) => ({
      account_id: accountId,
      contact_id,
      campaign_id: campaignIdRaw,
      draft_id: campaignIdRaw ? null : draftIdRaw,
    }));
    let linkFailed = false;
    await processWithConcurrency(sliceInto(linkRows, BULK_WRITE_CHUNK), WRITE_CONCURRENCY, async (slice) => {
      if (linkFailed) return;
      const { error: linkErr } = await supabaseAdmin().from("disp_import_contacts").insert(slice);
      if (!linkErr) return;
      if (isUniqueViolation(linkErr)) {
        // Mesmo contato já vinculado por um bloco anterior (duas linhas de
        // blocos diferentes caíram no mesmo contato existente): refaz o
        // lote linha a linha ignorando só as repetidas.
        for (const row of slice) {
          const { error: rowErr } = await supabaseAdmin().from("disp_import_contacts").insert(row);
          if (rowErr && !isUniqueViolation(rowErr)) {
            console.error("[Contacts Import] Failed to link import contacts:", safeDbError(rowErr));
            linkFailed = true;
            return;
          }
        }
        return;
      }
      console.error("[Contacts Import] Failed to link import contacts:", safeDbError(linkErr));
      linkFailed = true;
    });
    if (linkFailed) {
      return { failure: { error: "Contatos importados, mas não foi possível vinculá-los à campanha. Tente importar de novo.", status: 500 } };
    }
  }


  return { results, linked: importedContactIds.size };
}
