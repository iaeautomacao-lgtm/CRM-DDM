// Papéis do teste e variáveis de ambiente. Nenhum segredo no repositório: tudo vem de E2E_* (GitHub Secrets no CI).
//   E2E_BASE_URL                       ex.: https://omnicrmv2dev.grupoddm.ia.br
//   E2E_<PAPEL>_EMAIL / _PASSWORD / _TOTP_SECRET   PAPEL = PROPRIETARIO | ADMIN | SUPERVISOR | OPERADOR
//   E2E_ROLES (opcional)               subconjunto separado por vírgula, ex.: "admin,operador" (padrão: os 4)
import type { UserRole } from "@/lib/role-utils";

export interface E2ERole {
  /** Chave curta usada em nomes de teste e arquivos. */
  key: "proprietario" | "admin" | "supervisor" | "operador";
  /** Papel do app (a fonte da verdade de acesso é canAccessRoute). */
  role: UserRole;
  label: string;
  envPrefix: string;
}

export const ALL_ROLES: readonly E2ERole[] = [
  { key: "proprietario", role: "owner", label: "Proprietário", envPrefix: "E2E_PROPRIETARIO" },
  { key: "admin", role: "admin", label: "Admin", envPrefix: "E2E_ADMIN" },
  { key: "supervisor", role: "supervisor", label: "Supervisor", envPrefix: "E2E_SUPERVISOR" },
  { key: "operador", role: "agent", label: "Operador", envPrefix: "E2E_OPERADOR" },
];

export function selectedRoles(env: NodeJS.ProcessEnv = process.env): readonly E2ERole[] {
  const raw = env.E2E_ROLES?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!raw || raw.length === 0) return ALL_ROLES;
  const unknown = raw.filter((k) => !ALL_ROLES.some((r) => r.key === k));
  if (unknown.length) throw new Error(`E2E_ROLES com papel desconhecido: ${unknown.join(", ")}`);
  return ALL_ROLES.filter((r) => raw.includes(r.key));
}

export interface Credentials {
  email: string;
  password: string;
  totpSecret: string | null;
}

export function credentialsFor(r: E2ERole, env: NodeJS.ProcessEnv = process.env): Credentials {
  const email = env[`${r.envPrefix}_EMAIL`];
  const password = env[`${r.envPrefix}_PASSWORD`];
  if (!email || !password) {
    throw new Error(`Faltam ${r.envPrefix}_EMAIL e ${r.envPrefix}_PASSWORD (ou tire "${r.key}" de E2E_ROLES).`);
  }
  return { email, password, totpSecret: env[`${r.envPrefix}_TOTP_SECRET`] || null };
}

export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.E2E_BASE_URL;
  if (!url) throw new Error("Defina E2E_BASE_URL (ex.: https://omnicrmv2dev.grupoddm.ia.br).");
  return url.replace(/\/+$/, "");
}

export function authFile(r: E2ERole): string {
  return `e2e/.auth/${r.key}.json`;
}
