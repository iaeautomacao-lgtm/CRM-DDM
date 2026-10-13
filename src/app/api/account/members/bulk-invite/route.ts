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
// requirePermission("members.bulk_invite") (owner) rather than the admin+ every other
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
// SENHA (revisão de segurança 13/10, plano aprovado): não existe mais senha padrão compartilhada. Cada usuário é criado
// com uma senha aleatória que ninguém vê, e a resposta traz um LINK DE DEFINIÇÃO DE SENHA por pessoa (`links`), mostrado
// uma única vez para o proprietário baixar em CSV e repassar. No primeiro acesso a pessoa define a própria senha (tela de
// recuperação, via /auth/callback?token_hash=…&type=recovery). Link vencido: "Esqueci minha senha" no login. Um
// `password` no corpo (front antigo) é IGNORADO.
//
// Per-row failures (bad email, duplicate email, invalid role) are collected into `errors` rather than aborting
// the whole batch — one bad row in a 200-row spreadsheet shouldn't
// sink the other 199.
// ============================================================

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole, type AccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/account/admin-client";
import { maskEmailForLog } from "@/lib/privacy/mask";
// Senha mínima única (decisão do dono 13/10: 8 em tudo, para senhas novas).
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { isUuid } from "@/lib/auth/sessions";
import { CustomRoleError } from "@/lib/roles/custom-roles";
import { resolveInviteRole } from "@/lib/roles/invite-role";
import { InviteBaseUrlError, resolveInviteBaseUrl } from "@/lib/invitations/base-url";

// Best-effort rollback for the "auth user created, but a later step in
// the same row failed" window (profile lookup or the account_id/role
// repoint below) — without this, a failed row still left a valid login
// stranded on its auto-created personal account: invisible in this
// account's Members tab, but re-importing the same email later fails
// on Auth's own duplicate-email constraint with no way to recover it
// from here. Never throws — a failed rollback just means a stray user
// to clean up manually, which is strictly better than silently leaving
// no trace that one exists.
async function rollbackOrphanedAuthUser(
  admin: ReturnType<typeof supabaseAdmin>,
  userId: string,
  email: string,
  reason: string,
): Promise<void> {
  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
  if (deleteErr) {
    console.error(
      `[bulk-invite] rollback failed for ${maskEmailForLog(email)} (user_id=${userId}) after ${reason} — orphaned auth user left behind:`,
      deleteErr,
    );
  } else {
    console.error(`[bulk-invite] rolled back auth user for ${maskEmailForLog(email)} after ${reason}`);
  }
}

const MAX_MEMBERS_PER_IMPORT = 200;
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
  supervisor: "supervisor",
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
  /** Cargo escolhido (TASK5, migrations 318/319): sistema ou personalizado desta organização. */
  roleId: string | null;
}

interface ImportError {
  email: string;
  reason: string;
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePermission("members.bulk_invite");

    const limit = await checkRateLimit(
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

    // Base dos links de definição de senha: só de configuração do servidor (nunca do Host desta requisição). Sem host
    // confiável, falha ANTES de criar qualquer usuário.
    let baseUrl: string;
    try {
      baseUrl = resolveInviteBaseUrl(request);
    } catch (err) {
      if (err instanceof InviteBaseUrlError) {
        console.error("[bulk-invite]", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
      throw err;
    }

    const rawMembers = body?.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      return NextResponse.json(
        { error: "'members' deve ser uma lista não vazia" },
        { status: 400 },
      );
    }
    if (rawMembers.length > MAX_MEMBERS_PER_IMPORT) {
      return NextResponse.json(
        {
          error: `Uma importação aceita no máximo ${MAX_MEMBERS_PER_IMPORT} membros`,
        },
        { status: 400 },
      );
    }

    // Validate every row up front so an obviously-bad file fails fast
    // (as `errors`) without spending an auth.admin.createUser() call.
    const valid: ImportRow[] = [];
    const errors: ImportError[] = [];
    const seenEmails = new Set<string>();

    // TASK5: cargo escolhido para todos (role_id no topo) ou por linha (members[i].role_id, que vence). Cada cargo é
    // conferido UMA vez (só abaixo de quem importa, sem escalada); o `role` gravado é o compat efetivo do cargo.
    const topRoleId = (body as { role_id?: unknown } | null)?.role_id;
    if (topRoleId !== undefined && topRoleId !== null && !isUuid(topRoleId)) {
      return NextResponse.json({ error: "'role_id' inválido.", code: "invalid" }, { status: 400 });
    }
    const roleCache = new Map<string, AccountRole | null>();
    const compatFor = async (roleId: string): Promise<AccountRole | null> => {
      if (!roleCache.has(roleId)) {
        try {
          roleCache.set(roleId, (await resolveInviteRole(supabaseAdmin(), { accountId: ctx.accountId, actorId: ctx.userId, roleId, role: null })).role);
        } catch (err) {
          if (!(err instanceof CustomRoleError)) throw err;
          roleCache.set(roleId, null);
        }
      }
      return roleCache.get(roleId) ?? null;
    };

    for (const raw of rawMembers) {
      const row = raw as { name?: unknown; email?: unknown; role?: unknown; role_id?: unknown };
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
      const rowRoleId = row.role_id ?? topRoleId ?? null;
      if (rowRoleId !== null) {
        const compat = isUuid(rowRoleId) ? await compatFor(rowRoleId) : null;
        if (!compat) {
          errors.push({ email, reason: "Cargo inválido, de outra organização ou acima do seu" });
          continue;
        }
        seenEmails.add(normalizedEmail);
        valid.push({ name, email, role: compat, roleId: rowRoleId as string });
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
      valid.push({ name, email, role, roleId: null });
    }

    const admin = supabaseAdmin();
    let imported = 0;
    // Um link por usuário criado; null quando a geração falhou (a pessoa usa "Esqueci minha senha").
    const links: { email: string; name: string; link: string | null }[] = [];

    for (const row of valid) {
      try {
        const { data: createdUser, error: createErr } =
          await admin.auth.admin.createUser({
            email: row.email,
            // Aleatória e descartada: ninguém (nem o proprietário) conhece. A pessoa define a dela pelo link.
            password: randomBytes(32).toString("base64url"),
            email_confirm: true,
            user_metadata: { full_name: row.name },
          });

        if (createErr || !createdUser?.user) {
          if (createErr) console.error("[bulk-invite] createUser falhou:", createErr.status ?? "", createErr.code ?? "");
          errors.push({
            email: row.email,
            // Mensagem do GoTrue não vai ao navegador: só o caso útil (e-mail já cadastrado) tem texto próprio; o resto fica no log.
            reason: /already|registered|exists/i.test(createErr?.message ?? "") ? "E-mail já cadastrado." : "Falha ao criar usuário.",
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
          await rollbackOrphanedAuthUser(
            admin,
            newUserId,
            row.email,
            "falha ao buscar o perfil recém-criado",
          );
          errors.push({
            email: row.email,
            reason: "Falha ao vincular usuário à conta (usuário revertido, pode reimportar)",
          });
          continue;
        }

        const orphanAccountId = freshProfile.account_id as string | null;

        const { error: updateErr } = await admin
          .from("profiles")
          // role_id (cargo escolhido) vence: a sincronia (318) acerta o account_role para o compat efetivo.
          .update(row.roleId ? { account_id: ctx.accountId, account_role: row.role, role_id: row.roleId } : { account_id: ctx.accountId, account_role: row.role })
          .eq("user_id", newUserId);

        if (updateErr) {
          await rollbackOrphanedAuthUser(
            admin,
            newUserId,
            row.email,
            "falha ao vincular o perfil à conta (UPDATE account_id/account_role)",
          );
          errors.push({
            email: row.email,
            reason: "Falha ao vincular usuário à conta (usuário revertido, pode reimportar)",
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

        // Link de definição de senha (não envia e-mail: o proprietário repassa). Nunca vai para log.
        let link: string | null = null;
        try {
          const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email: row.email });
          const hashed = (linkData as { properties?: { hashed_token?: string } } | null)?.properties?.hashed_token;
          if (!linkErr && hashed) {
            link = `${baseUrl}/auth/callback?token_hash=${encodeURIComponent(hashed)}&type=recovery&next=/reset-password`;
          } else if (linkErr) {
            console.error(`[bulk-invite] falha ao gerar o link de ${maskEmailForLog(row.email)}:`, linkErr.message);
          }
        } catch (err) {
          console.error(`[bulk-invite] falha ao gerar o link de ${maskEmailForLog(row.email)}:`, err);
        }
        links.push({ email: row.email, name: row.name, link });
      } catch (err) {
        console.error("[bulk-invite] row failed:", err);
        errors.push({ email: row.email, reason: "Erro inesperado ao importar" });
      }
    }

    // Os links valem pelo prazo do e-mail de recuperação do Supabase (Authentication → Email OTP expiration).
    return NextResponse.json({ success: true, imported, errors, links }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
