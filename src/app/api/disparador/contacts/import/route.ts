import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";
import { isUniqueViolation, normalizeKey } from "@/lib/contacts/dedupe";
import {
  resolveImportTagIds,
  assignImportedContactTags,
  type ContactTagAssignment,
} from "@/lib/contacts/resolve-import-tags";

function formatBrazilianPhone(raw: string): string {
  if (!raw) return "";
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.startsWith("55")) {
    return `+${cleaned}`;
  }
  return `+55${cleaned}`;
}

// Looks up a value in `row` by trying each of `keys` against the row's
// keys lowercased/trimmed, so CSV/XLSX headers can vary in case, spacing,
// or naming (e.g. "Telefone", "celular", "whatsapp") without breaking import.
function getField(row: Record<string, any>, ...keys: string[]): string | undefined {
  const normalizedRow: Record<string, any> = {};
  for (const rawKey of Object.keys(row)) {
    normalizedRow[rawKey.trim().toLowerCase()] = row[rawKey];
  }
  for (const key of keys) {
    const value = normalizedRow[key.toLowerCase()];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

// Column names recognized as the contact's display name — "var1" last,
// covering the Meta CONTATO;VAR1;VAR2;VAR3 export format when no
// standard name column exists (see tagsArray comment below).
const NAME_FIELD_KEYS = [
  "nome",
  "name",
  "nome completo",
  "full name",
  "cliente",
  "contato",
  "var1",
];

// Telefone principal — colunas numeradas explícitas primeiro, com os
// aliases genéricos já existentes (sem número) como fallback para CSVs
// no formato antigo que não distinguem TELEFONE1/2/3.
const TELEFONE1_KEYS = [
  "telefone1", "telefone 1", "fone1", "fone 1", "celular1", "celular 1",
  "whatsapp1", "whatsapp 1", "tel1", "tel 1",
  "telefone", "phone", "celular", "tel", "fone", "whatsapp", "número", "numero", "cell",
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

export async function POST(request: Request) {
  try {
    // 1. Authenticate user and resolve their account
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const accountId = profile?.account_id;
    if (!accountId) {
      return NextResponse.json(
        { error: "Seu perfil não está vinculado a uma conta." },
        { status: 400 }
      );
    }

    // 2. Parse request FormData
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "Nenhum arquivo enviado" }, { status: 400 });
    }
    const defaultTag = formData.get("defaultTag") as string | null;

    const filename = file.name.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());
    let rows: any[] = [];

    if (filename.endsWith(".csv") || filename.endsWith(".txt")) {
      // Decode content removing BOM (\uFEFF)
      let content = buffer.toString("utf-8").replace(/^\uFEFF/, "");

      // Handle Excel "sep=;" or "sep=," delimiter declarer
      let delimiter: string | undefined;
      const firstLineEnd = content.indexOf("\n");
      const firstLine = firstLineEnd >= 0 ? content.slice(0, firstLineEnd).trim() : content.trim();
      if (/^sep=/i.test(firstLine)) {
        delimiter = firstLine.split("=")[1]?.trim();
        content = content.slice(firstLineEnd + 1);
      }

      const parsed = Papa.parse(content, {
        header: true,
        skipEmptyLines: true,
        ...(delimiter ? { delimiter } : { delimiter: ";" }), // Default to semicolon for Brazilian Excel
      });
      rows = parsed.data;
    } else if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet);
    } else {
      return NextResponse.json({ error: "Formato de arquivo inválido. Envie um CSV ou XLSX." }, { status: 400 });
    }

    // 3. Process imported rows
    const results = { importados: 0, duplicados: 0, invalidos: 0, blacklisted: 0, erros: [] as string[] };

    // Blacklist has no account_id column in the disparador schema — it's a
    // single shared list across every account on this instance, not scoped
    // per-tenant. Left unfiltered here; scoping it requires a migration.
    const { data: blacklist } = await supabaseAdmin().from("blacklist").select("telefone");
    const blacklistSet = new Set((blacklist ?? []).map((b) => b.telefone));

    // Existing contacts for this account, keyed by normalized phone. Used
    // instead of a DB-level upsert because the real unique constraint,
    // idx_contacts_account_phone_normalized, is a *partial* index (WHERE
    // phone_normalized <> ''), which Postgres won't infer as an ON CONFLICT
    // arbiter from a bare column list — the same reason the main contacts
    // CSV importer (import-modal.tsx) pre-checks and inserts rather than
    // upserts.
    const { data: existingRows } = await supabaseAdmin()
      .from("contacts")
      .select("id, name, phone_normalized, cpf")
      .eq("account_id", accountId);
    const existingContactsByKey = new Map<
      string,
      { id: string; name: string | null; cpf: string | null }
    >();
    for (const r of existingRows ?? []) {
      const key = normalizeKey(r.phone_normalized ?? "");
      if (key) existingContactsByKey.set(key, { id: r.id, name: r.name, cpf: r.cpf ?? null });
    }

    // Contatos existentes por CPF — dedup por CPF tem prioridade sobre
    // dedup por telefone quando o CSV traz CPF (o mesmo aluno pode
    // reaparecer com um telefone novo em campanhas diferentes). Reaproveita
    // o mesmo select de existingRows acima, já filtrado por account_id.
    const existingByCpf = new Map<string, { id: string; name: string | null }>();
    for (const r of existingRows ?? []) {
      if (r.cpf) existingByCpf.set(r.cpf, { id: r.id, name: r.name });
    }

    type AltPhoneRow = { phone: string; phone_normalized: string; ordem: number };
    type PendingContact = {
      phone: string;
      name: string | null;
      email: string | null;
      company: string | null;
      cpf: string | null;
      altPhones: AltPhoneRow[];
      tagsArray: string[];
    };
    const pending: PendingContact[] = [];
    // altPhoneAssignments cobre os dois casos: contato já existente
    // (contact_id resolvido na hora, empurrado direto aqui dentro do
    // loop) e contato novo (resolvido depois do insert em lote, igual
    // ao padrão de tagAssignments abaixo).
    const altPhoneAssignments: Array<{ contact_id: string; phone: string; phone_normalized: string; ordem: number }> = [];
    const seenInFile = new Set<string>();
    const seenCpfInFile = new Set<string>();

    for (const row of rows) {
      const t1 = getField(row, ...TELEFONE1_KEYS);
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
      if (blacklistSet.has(normalized)) {
        results.blacklisted++;
        continue;
      }

      const cpfNormalized = normalizeCpf(getField(row, ...CPF_FIELD_KEYS));

      const key = normalizeKey(normalized);
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
        : existingContactsByKey.get(key);
      const matched = existingContact
        ? { id: existingContact.id, name: existingContact.name, cpf: cpfNormalized }
        : existingByPhone
          ? { id: existingByPhone.id, name: existingByPhone.name, cpf: existingByPhone.cpf }
          : null;

      if (matched) {
        // Contato já existe — só preenche o name se estiver vazio no
        // banco, nunca sobrescreve um nome já cadastrado.
        if (!matched.name) {
          const parsedName = getField(row, ...NAME_FIELD_KEYS);
          if (parsedName) {
            const { error: updateErr } = await supabaseAdmin()
              .from("contacts")
              .update({ name: parsedName })
              .eq("id", matched.id);
            if (updateErr) {
              console.error("[Contacts Import] Failed to backfill name:", updateErr);
            }
          }
        }
        // Backfill de CPF: só quando o contato foi encontrado por
        // telefone e ainda não tinha CPF gravado — se foi encontrado
        // por CPF, ele já tem exatamente esse CPF.
        if (!existingContact && cpfNormalized && !matched.cpf) {
          const { error: cpfErr } = await supabaseAdmin()
            .from("contacts")
            .update({ cpf: cpfNormalized })
            .eq("id", matched.id)
            .is("cpf", null);
          if (cpfErr) {
            console.error("[Contacts Import] Failed to backfill cpf:", cpfErr);
          }
        }
        for (const alt of altPhones) {
          altPhoneAssignments.push({ contact_id: matched.id, ...alt });
        }
        results.duplicados++;
        continue;
      }
      seenInFile.add(key);
      if (cpfNormalized) seenCpfInFile.add(cpfNormalized);

      const rawTags = getField(row, "tags", "tag", "etiquetas", "categorias") || "";
      const csvTagNames = rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      // Inclui a tag padrão da campanha (se fornecida) em todo contato —
      // não só nos que já têm tags no CSV, senão formatos externos sem
      // coluna de tags (ex: CONTATO;VAR1;VAR2;VAR3 da Meta) nunca
      // receberiam a marcação da campanha.
      const tagsArray = defaultTag?.trim()
        ? [...csvTagNames, defaultTag.trim()]
        : csvTagNames;

      pending.push({
        phone: normalized,
        name: getField(row, ...NAME_FIELD_KEYS) || null,
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
        tagsArray,
      });
    }

    // 4. Resolve tag names -> ids up front, scoped to this account
    const allTagNames = pending.flatMap((p) => p.tagsArray);
    let tagIdByKey = new Map<string, string>();
    let resolvedNameByKey = new Map<string, string>();
    if (allTagNames.length > 0) {
      ({ tagIdByKey, resolvedNameByKey } = await resolveImportTagIds(supabaseAdmin(), {
        accountId,
        userId: user.id,
        tagNames: allTagNames,
        canCreateTags: true,
      }));
    }

    // 5. Insert contacts in chunks; a chunk failure retries row-by-row so
    // one bad/duplicate row doesn't sink the whole batch.
    const tagAssignments: ContactTagAssignment[] = [];
    const chunkSize = 50;

    for (let i = 0; i < pending.length; i += chunkSize) {
      const chunk = pending.slice(i, i + chunkSize);
      const insertRows = chunk.map((p) => ({
        user_id: user.id,
        account_id: accountId,
        phone: p.phone,
        name: p.name,
        email: p.email,
        company: p.company,
        cpf: p.cpf,
      }));

      const { data, error } = await supabaseAdmin()
        .from("contacts")
        .insert(insertRows)
        .select("id");

      if (error) {
        for (let j = 0; j < insertRows.length; j++) {
          const source = chunk[j];
          const { data: singleData, error: singleErr } = await supabaseAdmin()
            .from("contacts")
            .insert(insertRows[j])
            .select("id")
            .single();

          if (!singleErr && singleData) {
            results.importados++;
            if (source.tagsArray.length > 0) {
              tagAssignments.push({ contactId: singleData.id, tagNames: source.tagsArray });
            }
            for (const alt of source.altPhones) {
              altPhoneAssignments.push({ contact_id: singleData.id, ...alt });
            }
          } else if (isUniqueViolation(singleErr)) {
            results.duplicados++;
          } else {
            results.erros.push(`${source.phone}: ${singleErr?.message}`);
          }
        }
      } else {
        const inserted = data ?? [];
        results.importados += inserted.length;
        for (let j = 0; j < inserted.length; j++) {
          const source = chunk[j];
          if (!source) continue;
          if (source.tagsArray.length > 0) {
            tagAssignments.push({ contactId: inserted[j].id, tagNames: source.tagsArray });
          }
          for (const alt of source.altPhones) {
            altPhoneAssignments.push({ contact_id: inserted[j].id, ...alt });
          }
        }
      }
    }

    // 6. Wire tags onto the contacts we just created. Failure here must not
    // mask a successful contact import.
    if (tagAssignments.length > 0) {
      try {
        await assignImportedContactTags(supabaseAdmin(), tagAssignments, tagIdByKey);
      } catch (err) {
        console.error("[Contacts Import] Failed to assign tags:", err);
      }
    }

    // 7. Save alternate phones (TELEFONE2/3) into wacrm.contact_phones —
    // fundação da escada de números (ver processQueue.ts: tryNextPhone).
    // Best-effort: falha aqui não deve mascarar um import de contatos
    // bem-sucedido, e a tabela pode ainda não existir se a migration 077
    // não tiver sido aplicada.
    if (altPhoneAssignments.length > 0) {
      try {
        const altChunkSize = 100;
        for (let i = 0; i < altPhoneAssignments.length; i += altChunkSize) {
          const chunk = altPhoneAssignments.slice(i, i + altChunkSize);
          const { error: altErr } = await supabaseAdmin()
            .from("contact_phones")
            .upsert(chunk, { onConflict: "contact_id,ordem" });
          if (altErr) throw altErr;
        }
      } catch (err) {
        console.error("[Contacts Import] Failed to save alternate phones:", err);
      }
    }

    // Nome real da tag usada no import — pode diferir de defaultTag quando
    // já existia uma tag com o mesmo nome em outra capitalização
    // (resolveImportTagIds casa por nome case-insensitive, mas
    // tags_filtro em start/route.ts casa contra tags.name de forma
    // case-sensitive). O caller deve usar este valor para preencher
    // tags_filtro, não o nome que ele mesmo enviou.
    const defaultTagTrimmed = defaultTag?.trim() || null;
    const tagName = defaultTagTrimmed
      ? resolvedNameByKey.get(defaultTagTrimmed.toLowerCase()) ?? defaultTagTrimmed
      : null;

    return NextResponse.json({ success: true, results, tagName });
  } catch (err: any) {
    console.error("[Contacts Import] Failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
