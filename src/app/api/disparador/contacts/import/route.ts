import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { db: { schema: "wacrm" } }
);

function formatBrazilianPhone(raw: string): string {
  if (!raw) return "";
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.startsWith("55")) {
    return `+${cleaned}`;
  }
  return `+55${cleaned}`;
}

export async function POST(request: Request) {
  try {
    // 1. Authenticate user
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    // 2. Parse request FormData
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "Nenhum arquivo enviado" }, { status: 400 });
    }

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
    
    // Fetch current blacklist
    const { data: blacklist } = await supabaseAdmin.from("blacklist").select("telefone");
    const blacklistSet = new Set((blacklist ?? []).map((b) => b.telefone));

    for (const row of rows) {
      const rawPhone = row.telefone || row.phone;
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

      const rawTags: string = row.tags || "";
      const tagsArray = rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : [];

      // Upsert contact
      const contactData = {
        user_id: user.id,
        phone: normalized,
        name: row.nome || row.name || null,
        email: row.email || null,
        company: row.origem || row.company || null,
      };

      const { data: contact, error: upsertError } = await supabaseAdmin
        .from("contacts")
        .upsert(contactData, { onConflict: "phone" })
        .select("id")
        .single();

      if (upsertError) {
        results.erros.push(`${normalized}: ${upsertError.message}`);
        continue;
      }

      if (contact && tagsArray.length > 0) {
        // Tag association
        for (const tagName of tagsArray) {
          try {
            // Find or create tag for this user
            let { data: tag } = await supabaseAdmin
              .from("tags")
              .select("id")
              .eq("user_id", user.id)
              .eq("name", tagName)
              .maybeSingle();

            if (!tag) {
              const { data: newTag, error: tagErr } = await supabaseAdmin
                .from("tags")
                .insert({ user_id: user.id, name: tagName })
                .select("id")
                .single();
              if (tagErr) throw tagErr;
              tag = newTag;
            }

            if (tag) {
              await supabaseAdmin
                .from("contact_tags")
                .upsert({ contact_id: contact.id, tag_id: tag.id }, { onConflict: "contact_id,tag_id" });
            }
          } catch (err: any) {
            console.error(`Failed to assign tag ${tagName} to contact ${contact.id}:`, err);
          }
        }
      }

      results.importados++;
    }

    return NextResponse.json({ success: true, results });
  } catch (err: any) {
    console.error("[Contacts Import] Failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
