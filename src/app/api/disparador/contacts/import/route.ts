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

    if (filename.endsWith(".csv")) {
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
      .select("phone_normalized")
      .eq("account_id", accountId);
    const existingPhones = new Set(
      (existingRows ?? [])
        .map((r: { phone_normalized: string | null }) => r.phone_normalized)
        .filter((p): p is string => !!p)
    );

    type PendingContact = {
      phone: string;
      name: string | null;
      email: string | null;
      company: string | null;
      tagsArray: string[];
    };
    const pending: PendingContact[] = [];
    const seenInFile = new Set<string>();

    for (const row of rows) {
      const rawPhone = getField(
        row,
        "telefone",
        "phone",
        "celular",
        "tel",
        "fone",
        "whatsapp",
        "número",
        "numero",
        "cell"
      );
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

      const key = normalizeKey(normalized);
      if (existingPhones.has(key) || seenInFile.has(key)) {
        results.duplicados++;
        continue;
      }
      seenInFile.add(key);

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
        name:
          getField(row, "nome", "name", "nome completo", "full name", "cliente", "contato") ||
          null,
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
        tagsArray,
      });
    }

    // 4. Resolve tag names -> ids up front, scoped to this account
    const allTagNames = pending.flatMap((p) => p.tagsArray);
    let tagIdByKey = new Map<string, string>();
    if (allTagNames.length > 0) {
      ({ tagIdByKey } = await resolveImportTagIds(supabaseAdmin(), {
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
          if (!source || source.tagsArray.length === 0) continue;
          tagAssignments.push({ contactId: inserted[j].id, tagNames: source.tagsArray });
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

    return NextResponse.json({ success: true, results });
  } catch (err: any) {
    console.error("[Contacts Import] Failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
