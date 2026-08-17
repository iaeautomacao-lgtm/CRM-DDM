// ============================================================
// POST /api/account/members/bulk-invite
//
// Owner only. Creates one Supabase Auth user per row of a bulk
// import (CSV/XLSX parsed client-side — the Bulk Import dialog
// sends the parsed rows as JSON, not the raw file) and attaches
// each new user to the caller's account with the given role.
//
// Bulk-invite can create 'owner'-role rows (confirmed product
// decision — an account can end up with more than one owner-role
// profile this way). Because of that, this route is gated at
// requireRole("owner") rather than the admin+ every other
// account/members route uses — letting a mere admin ('Supervisor')
// self-grant 'owner' via a spreadsheet upload would be a privilege
// escalation, since every other path to 'owner' (Transfer Ownership)
// requires the existing owner's explicit action.
//
// Why this can't reuse `redeem_invitation`
//   That RPC moves an EXISTING authenticated caller into an
//   inviter's account. Here there is no caller session for the
//   imported user — we create the auth.users row ourselves via
//   the service-role admin API, so we do the same "move off the
//   personal account created at signup" dance by hand:
//
//     1. admin.createUser() → auth.users INSERT fires the
//        `handle_new_user` trigger (migration 017), which
//        synchronously creates a fresh personal `accounts` row
//        and an owner-role `profiles` row for the new user.
//     2. We immediately read that profile's account_id (the
//        orphan personal account) …
//     3. … repoint profiles.account_id / account_role at the
//        caller's account and the requested role, then
//     4. delete the now-empty personal account (nothing else
//        references it, since step 3 already moved the profile).
//
// Per-row failures (bad email, duplicate email, invalid role,
// weak password) are collected into `errors` rather than aborting
// the whole batch — one bad row in a 200-row spreadsheet shouldn't
// sink the other 199.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole, type AccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/account/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const MAX_MEMBERS_PER_IMPORT = 200;
const MIN_PASSWORD_LENGTH = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The CSV/XLSX template and the PT-BR role labels (role-meta.ts) both
// use friendlier names than the DB enum. Accept either so a
// spreadsheet built from the "Baixar modelo" template or hand-edited
// with the labels users see on-screen both work. 'administrador' maps
// to 'owner' — see the file header for why this route (alone, among
// account/members routes) is allowed to produce 'owner' rows and why
// it's gated at owner-only rather than admin+.
//
// Matching is case-insensitive and whitespace-trimmed (see
// resolveRole) so "Administrador", " SUPERVISOR ", "supervisor" etc.
// all resolve the same way — the raw cell text from the spreadsheet
// is sent as-is by the client (bulk-import-members-dialog.tsx), so
// this is the only place casing/whitespace gets normalized.
const ROLE_ALIASES: Record<string, AccountRole> = {
  owner: "owner",
  administrador: "owner",
  admin: "admin",
  supervisor: "admin",
  agent: "agent",
  operador: "agent",
  viewer: "viewer",
  visualizador: "viewer",
};

function resolveRole(raw: unknown): AccountRole | null {
  if (raw === undefined || raw === null || raw === "") return "agent";
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return "agent";
  return ROLE_ALIASES[normalized] ?? null;
}

interface ImportRow {
  name: string;
  email: string;
  role: AccountRole;
}

interface ImportError {
  email: string;
  reason: string;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `admin:bulkInviteMembers:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | {
          members?: unknown;
          password?: unknown;
        }
      | null;

    const password = body?.password;
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        {
          error: `'password' must be a string with at least ${MIN_PASSWORD_LENGTH} characters`,
        },
        { status: 400 },
      );
    }

    const rawMembers = body?.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      return NextResponse.json(
        { error: "'members' must be a non-empty array" },
        { status: 400 },
      );
    }
    if (rawMembers.length > MAX_MEMBERS_PER_IMPORT) {
      return NextResponse.json(
        {
          error: `A single import is capped at ${MAX_MEMBERS_PER_IMPORT} members`,
        },
        { status: 400 },
      );
    }

    // Validate every row up front so an obviously-bad file fails fast
    // (as `errors`) without spending an auth.admin.createUser() call.
    const valid: ImportRow[] = [];
    const errors: ImportError[] = [];
    const seenEmails = new Set<string>();

    for (const raw of rawMembers) {
      const row = raw as { name?: unknown; email?: unknown; role?: unknown };
      const email = typeof row.email === "string" ? row.email.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";

      if (!email || !EMAIL_RE.test(email)) {
        errors.push({ email: email || "(vazio)", reason: "E-mail inválido" });
        continue;
      }
      const normalizedEmail = email.toLowerCase();
      if (seenEmails.has(normalizedEmail)) {
        errors.push({ email, reason: "E-mail duplicado no arquivo" });
        continue;
      }
      if (!name) {
        errors.push({ email, reason: "Nome é obrigatório" });
        continue;
      }
      const role = resolveRole(row.role);
      if (!role || !isAccountRole(role)) {
        errors.push({
          email,
          reason: "Papel inválido (use administrador, supervisor, operador ou visualizador)",
        });
        continue;
      }

      seenEmails.add(normalizedEmail);
      valid.push({ name, email, role });
    }

    const admin = supabaseAdmin();
    let imported = 0;

    for (const row of valid) {
      try {
        const { data: createdUser, error: createErr } =
          await admin.auth.admin.createUser({
            email: row.email,
            password,
            email_confirm: true,
            user_metadata: { full_name: row.name },
          });

        if (createErr || !createdUser?.user) {
          errors.push({
            email: row.email,
            reason: createErr?.message || "Falha ao criar usuário",
          });
          continue;
        }

        const newUserId = createdUser.user.id;

        // The signup trigger (migration 017) already gave this user a
        // fresh personal account + owner profile — find it so we can
        // clean it up after repointing the profile.
        const { data: freshProfile, error: profileErr } = await admin
          .from("profiles")
          .select("account_id")
          .eq("user_id", newUserId)
          .maybeSingle();

        if (profileErr || !freshProfile) {
          errors.push({
            email: row.email,
            reason: "Usuário criado, mas o perfil não foi encontrado para vincular à conta",
          });
          continue;
        }

        const orphanAccountId = freshProfile.account_id as string | null;

        const { error: updateErr } = await admin
          .from("profiles")
          .update({ account_id: ctx.accountId, account_role: row.role })
          .eq("user_id", newUserId);

        if (updateErr) {
          errors.push({
            email: row.email,
            reason: "Usuário criado, mas falhou ao vincular à conta",
          });
          continue;
        }

        if (orphanAccountId && orphanAccountId !== ctx.accountId) {
          // Best-effort cleanup — the orphan account is empty (the
          // profile just moved off it) so a failure here just leaves
          // an unused row, not an inconsistent one.
          await admin.from("accounts").delete().eq("id", orphanAccountId);
        }

        imported += 1;
      } catch (err) {
        console.error("[bulk-invite] row failed:", err);
        errors.push({ email: row.email, reason: "Erro inesperado ao importar" });
      }
    }

    return NextResponse.json({ success: true, imported, errors });
  } catch (err) {
    return toErrorResponse(err);
  }
}
