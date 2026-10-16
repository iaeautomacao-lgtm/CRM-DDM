/** User identity fields edited by admins on /usuarios. */
export type MemberIdentity = { full_name: string; email: string };

export function validateMemberIdentity(value: unknown):
  | { valid: true; data: MemberIdentity }
  | { valid: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, message: "Dados inválidos" };
  }
  const row = value as Record<string, unknown>;
  if (typeof row.full_name !== "string") {
    return { valid: false, message: "Informe o nome completo" };
  }
  const full_name = row.full_name.trim().replace(/\s+/g, " ");
  if (full_name.length < 2 || full_name.length > 120 || /[\x00-\x1f\x7f]/.test(full_name)) {
    return { valid: false, message: "O nome deve ter entre 2 e 120 caracteres" };
  }

  if (typeof row.email !== "string") {
    return { valid: false, message: "Informe o e-mail" };
  }
  const email = row.email.trim().toLowerCase();
  if (email.length > 254 || email.length < 6 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    return { valid: false, message: "Informe um e-mail válido" };
  }
  return { valid: true, data: { full_name, email } };
}
