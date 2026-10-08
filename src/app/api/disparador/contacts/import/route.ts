import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";
import { IMPORT_SERVER_MAX_ROWS } from "@/lib/disparador/import-chunks";
import { IMPORT_SYNC_FILE_MAX_ROWS } from "@/lib/disparador/import-jobs";
import { importContactBlock, resolveField, type ColumnMap } from "@/lib/disparador/import-block";

const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    // 1. Sessão + conta + papel (mesmo das rotas de campanha). Antes só
    // exigia login: qualquer papel importava contatos e mexia em vínculos.
    let accountId: string;
    let userId: string;
    try {
      ({ accountId, userId } = await requireDisparadorAccess());
    } catch (err) {
      return toErrorResponse(err);
    }

    // 2. Parse da requisição. Dois formatos:
    //   - JSON (assistente "Nova campanha"): { rows, chunk_index, ... } — um
    //     bloco de linhas já lidas no navegador; o corpo fica bem abaixo do
    //     limite do middleware (10 MB) mesmo para bases de 100 mil linhas.
    //   - FormData com o arquivo (tela de contatos do disparador): a base
    //     inteira numa requisição só.
    const isJsonBody = (request.headers.get("content-type") ?? "").includes("application/json");
    let jsonBody: Record<string, any> | null = null;
    let formData: FormData;
    let file: File | null = null;
    if (isJsonBody) {
      try {
        jsonBody = await request.json();
      } catch {
        return NextResponse.json({ error: "Corpo da requisição inválido." }, { status: 400 });
      }
      if (!jsonBody || !Array.isArray(jsonBody.rows)) {
        return NextResponse.json({ error: "Nenhuma linha enviada" }, { status: 400 });
      }
      if (jsonBody.rows.length > IMPORT_SERVER_MAX_ROWS) {
        return NextResponse.json(
          { error: `Bloco grande demais (máximo ${IMPORT_SERVER_MAX_ROWS} linhas por requisição).` },
          { status: 400 }
        );
      }
      formData = new FormData();
      for (const field of ["campaign_id", "draft_id", "column_map", "mapping_confirmed"] as const) {
        const v = jsonBody[field];
        if (v !== undefined && v !== null) {
          formData.set(field, typeof v === "string" ? v : JSON.stringify(v));
        }
      }
    } else {
      formData = await request.formData();
      file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "Nenhum arquivo enviado" }, { status: 400 });
      }
    }
    if (file && file.size > MAX_IMPORT_FILE_BYTES) {
      return NextResponse.json(
        { error: "Arquivo muito grande (máximo de 20 MB)." },
        { status: 413 }
      );
    }
    // Só o primeiro bloco limpa o vínculo anterior do rascunho/campanha; os
    // seguintes apenas acrescentam. Sem chunk_index (FormData) = bloco único.
    const chunkIndex = isJsonBody ? Math.max(0, Math.floor(Number(jsonBody?.chunk_index ?? 0)) || 0) : 0;
    // campaign_id só vem preenchido quando o import acontece numa edição
    // de campanha já existente; draft_id cobre a criação de campanha nova
    // (import roda no Step 2 do wizard, antes do insert em wacrm.campaigns
    // no Step 3) — mesmo padrão de wacrm.disparador_utm_links (migration
    // 076). Usado só pra persistir VAR1/VAR2/VAR3 (migration 079) — nada
    // aqui depende disso pra continuar funcionando se vier vazio.
    const campaignIdRaw = (formData.get("campaign_id") as string | null)?.trim() || null;
    const draftIdRaw = (formData.get("draft_id") as string | null)?.trim() || null;
    if (
      (campaignIdRaw && !UUID_RE.test(campaignIdRaw)) ||
      (draftIdRaw && !UUID_RE.test(draftIdRaw))
    ) {
      return NextResponse.json({ error: "Identificador inválido." }, { status: 400 });
    }
    // campaign_id vem do cliente: a campanha precisa ser desta conta (outra
    // conta → 404) antes de qualquer escrita com service role.
    if (campaignIdRaw) {
      const { data: ownCampaign } = await supabaseAdmin()
        .from("campaigns")
        .select("id")
        .eq("id", campaignIdRaw)
        .eq("account_id", accountId)
        .limit(1);
      if (!ownCampaign || ownCampaign.length === 0) {
        return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
      }
    }
    // Rascunhos novos ainda não têm campanha. Aceitar UUID não utilizado,
    // mas impedir reaproveitar o de outra conta antes de qualquer escrita.
    if (draftIdRaw) {
      const db = supabaseAdmin();
      const checks = await Promise.all([
        db.from("campaigns").select("id").eq("import_draft_id", draftIdRaw).neq("account_id", accountId).limit(1),
        db.from("disp_import_contacts").select("id").eq("draft_id", draftIdRaw).neq("account_id", accountId).limit(1),
        db.from("disparador_utm_links").select("id").eq("draft_id", draftIdRaw).neq("account_id", accountId).limit(1),
        db.from("contact_import_variables").select("id, contacts!inner(account_id)").eq("draft_id", draftIdRaw).neq("contacts.account_id", accountId).limit(1),
      ]);
      if (checks.some((check) => check.error)) {
        console.error("[Contacts Import] Falha ao verificar rascunho:", checks.map((check) => check.error));
        return NextResponse.json({ error: "Falha ao verificar o rascunho." }, { status: 500 });
      }
      if (checks.some((check) => (check.data?.length ?? 0) > 0)) {
        return NextResponse.json({ error: "Rascunho não encontrado" }, { status: 404 });
      }
    }

    // column_map (Correção 3) — JSON opcional { name, phone, cpf, var1,
    // var2, var3 } vindo do sub-step de mapeamento do wizard. JSON
    // inválido ou ausente cai no comportamento heurístico de sempre.
    const columnMapRaw = (formData.get("column_map") as string | null) || null;
    const mappingConfirmed = formData.get("mapping_confirmed") === "true";
    const mappingConfirmationProvided = formData.has("mapping_confirmed");
    const hasHeader = formData.get("has_header") !== "false";
    const columnHeadersRaw = (formData.get("column_headers") as string | null) || null;
    let columnMap: ColumnMap = {};
    if (columnMapRaw) {
      try {
        const parsed = JSON.parse(columnMapRaw);
        if (parsed && typeof parsed === "object") columnMap = parsed;
      } catch {
        console.error("[Contacts Import] column_map recebido não é JSON válido — ignorando.");
      }
    }
    if (mappingConfirmationProvided && (!mappingConfirmed || !columnMap.phone?.trim())) {
      return NextResponse.json(
        { error: "Selecione e confirme a coluna de contato antes de importar." },
        { status: 400 }
      );
    }
    let columnHeaders: string[] = [];
    if (columnHeadersRaw) {
      try {
        const parsedHeaders = JSON.parse(columnHeadersRaw);
        if (Array.isArray(parsedHeaders)) columnHeaders = parsedHeaders.map(String);
      } catch {
        return NextResponse.json({ error: "Não foi possível ler o cabeçalho do arquivo." }, { status: 400 });
      }
    }

    const filename = file?.name.toLowerCase() ?? "";
    let rows: any[] = [];

    if (jsonBody) {
      // Linhas já lidas pelo assistente (objetos cabeçalho → valor). Valores
      // não-texto viram texto aqui, igual ao que o parse do arquivo daria.
      rows = (jsonBody.rows as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
        .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? "" : String(v)])));
    } else if (filename.endsWith(".csv") || filename.endsWith(".txt")) {
      const buffer = Buffer.from(await file!.arrayBuffer());
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

      // Sem linha sep= — detecta pela primeira linha de dados, contando
      // ocorrências de cada candidato (mesma heurística do preview no
      // cliente, ver parseImportFile em campanhas/page.tsx). Sem isso o
      // servidor sempre assumia ";" fixo, então um CSV separado por vírgula
      // (sem "sep=") era reparseado com um delimitador diferente do usado
      // pelo cliente pra montar column_map — as colunas mapeadas na prévia
      // (ex: columnMap.phone = "contato") nunca batiam com as chaves reais
      // do row aqui, e o import falhava com "nenhum telefone válido" mesmo
      // com o mapeamento correto. Empate ou nenhum encontrado → ";"
      // (compatibilidade com Excel brasileiro, que é o caso mais comum).
      if (!delimiter) {
        const sampleLineEnd = content.indexOf("\n");
        const sampleLine = sampleLineEnd >= 0 ? content.slice(0, sampleLineEnd) : content;
        const semicolons = (sampleLine.match(/;/g) || []).length;
        const commas = (sampleLine.match(/,/g) || []).length;
        delimiter = commas > semicolons ? "," : ";";
      }

      const parsed = Papa.parse(content, {
        header: hasHeader,
        skipEmptyLines: true,
        delimiter,
      });
      rows = hasHeader
        ? parsed.data
        : (parsed.data as string[][]).map((values) =>
            Object.fromEntries((columnHeaders.length > 0 ? columnHeaders : values.map((_, i) => `coluna_${i + 1}`))
              .map((header, index) => [header, values[index] ?? ""]))
          );
    } else if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
      const buffer = Buffer.from(await file!.arrayBuffer());
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      // raw:false + defval:"" — todas as células viram texto (como no
      // navegador). Com raw:true, telefone/CPF numérico chegava como number
      // e quebrava o .replace() mais abaixo (TypeError → 500).
      if (hasHeader) {
        rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" });
      } else {
        const values = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false });
        rows = values.map((row) =>
          Object.fromEntries((columnHeaders.length > 0 ? columnHeaders : row.map((_, i) => `coluna_${i + 1}`))
            .map((header, index) => [header, row[index] ?? ""]))
        );
      }
    } else {
      return NextResponse.json({ error: "Formato de arquivo inválido. Envie um CSV ou XLSX." }, { status: 400 });
    }

    // Arquivo grande numa requisição só = parse e processamento no event loop do servidor (A12/A13). Acima do teto, a
    // importação vira job em segundo plano: o navegador lê o arquivo e manda blocos (POST /api/disparador/imports).
    if (file && rows.length > IMPORT_SYNC_FILE_MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Arquivo grande demais para importar na hora (mais de ${IMPORT_SYNC_FILE_MAX_ROWS} linhas). Use a importação em segundo plano.`,
          code: "import_too_large",
          async_endpoint: "/api/disparador/imports",
          max_sync_rows: IMPORT_SYNC_FILE_MAX_ROWS,
        },
        { status: 409 },
      );
    }

    if (mappingConfirmed && chunkIndex === 0) {
      const hasResolvedContact = rows.some((row) => resolveField(row, columnMap.phone, [])?.trim());
      if (!hasResolvedContact) {
        return NextResponse.json(
          { error: "A coluna de contato selecionada não contém nenhum telefone válido." },
          { status: 400 }
        );
      }
    }

    const outcome = await importContactBlock({ accountId, userId, rows, columnMap, campaignId: campaignIdRaw, draftId: draftIdRaw, chunkIndex });
    if (outcome.failure) {
      return NextResponse.json({ error: outcome.failure.error }, { status: outcome.failure.status });
    }
    return NextResponse.json({ success: true, results: outcome.results, linked: outcome.linked });
  } catch (err: any) {
    console.error("[Contacts Import] Failed:", err);
    return NextResponse.json({ error: "Falha ao importar os contatos." }, { status: 500 });
  }
}
