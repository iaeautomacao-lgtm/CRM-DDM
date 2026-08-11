// ============================================================
// /api/relatorios/exports — server-only write path for the
// Exportações report (Storage + wacrm.export_history need the
// service-role key: no client INSERT/DELETE policy exists on either,
// see supabase/migrations/055_export_history.sql).
//
// POST   — upload the generated file + record it in export_history.
// DELETE — remove the storage object + the history row.
//
// Auth via getCurrentAccount() (src/lib/auth/account.ts), the same
// pattern every other API route in this project uses — not a
// hand-rolled cookie check.
// ============================================================

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/relatorios/admin-client";

const BUCKET = "relatorio-exports";

const CONTENT_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

const EXPORT_TYPES = ["conversas", "envio-em-lote", "atendimentos"] as const;
type ExportType = (typeof EXPORT_TYPES)[number];

interface ExportUploadBody {
  exportType: ExportType;
  description: string;
  periodFrom?: string;
  periodTo?: string;
  fileName: string;
  fileBase64: string;
  fileSize: number;
}

function isExportType(value: unknown): value is ExportType {
  return typeof value === "string" && (EXPORT_TYPES as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json()) as Partial<ExportUploadBody>;

    if (
      !isExportType(body.exportType) ||
      typeof body.description !== "string" ||
      !body.description.trim() ||
      typeof body.fileName !== "string" ||
      !body.fileName.trim() ||
      typeof body.fileBase64 !== "string" ||
      !body.fileBase64
    ) {
      return NextResponse.json({ error: "Invalid export payload" }, { status: 400 });
    }

    const ext = body.fileName.split(".").pop()?.toLowerCase() ?? "";
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const storagePath = `${ctx.accountId}/${randomUUID()}.${ext || "bin"}`;

    const buffer = Buffer.from(body.fileBase64, "base64");

    // ctx.account is the ACCOUNT's name — the actor's own name lives on
    // their profile row, one extra lookup since AccountContext doesn't
    // carry it.
    const { data: profile } = await ctx.supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", ctx.userId)
      .maybeSingle();

    const admin = supabaseAdmin();
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: false });

    if (uploadError) {
      console.error("[POST /api/relatorios/exports] upload error:", uploadError);
      return NextResponse.json({ error: "Failed to upload export" }, { status: 500 });
    }

    const { data, error: insertError } = await admin
      .from("export_history")
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        user_name: profile?.full_name ?? null,
        export_type: body.exportType,
        description: body.description.trim(),
        period_from: body.periodFrom ?? null,
        period_to: body.periodTo ?? null,
        file_name: body.fileName,
        storage_path: storagePath,
        // buffer.length is the exact decoded size — no reason to trust
        // the client's estimate (fileSize) when this is free and exact.
        file_size: buffer.length,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[POST /api/relatorios/exports] insert error:", insertError);
      // The file is already in storage at this point — leaving it
      // orphaned (no export_history row) is preferable to deleting it
      // out from under a download that might already be in flight;
      // it's just unlisted until someone reconciles storage vs. the
      // table, same trade-off as any two-step write without a
      // transaction spanning both systems.
      return NextResponse.json({ error: "Failed to record export" }, { status: 500 });
    }

    return NextResponse.json({ id: data.id, storage_path: storagePath });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    // Look up storage_path ourselves via the RLS-scoped client rather
    // than trust a client-supplied path — export_history_select only
    // returns rows for the caller's own account, so a cross-account id
    // resolves to no row instead of leaking another account's path.
    const { data: row, error: fetchError } = await ctx.supabase
      .from("export_history")
      .select("id, storage_path")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (fetchError) {
      console.error("[DELETE /api/relatorios/exports] fetch error:", fetchError);
      return NextResponse.json({ error: "Failed to load export" }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ error: "Export not found" }, { status: 404 });
    }

    const admin = supabaseAdmin();
    const { error: removeError } = await admin.storage.from(BUCKET).remove([row.storage_path]);
    if (removeError) {
      console.error("[DELETE /api/relatorios/exports] storage remove error:", removeError);
      return NextResponse.json({ error: "Failed to delete file" }, { status: 500 });
    }

    const { error: deleteError } = await admin.from("export_history").delete().eq("id", id);
    if (deleteError) {
      console.error("[DELETE /api/relatorios/exports] delete error:", deleteError);
      return NextResponse.json({ error: "Failed to delete export record" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
