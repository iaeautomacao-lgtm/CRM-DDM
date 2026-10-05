import { redirect } from "next/navigation";

// Cadastro público desativado: o CRM é interno e os usuários são criados
// pelo administrador (Usuários → Convidar, via API de admin do Supabase).
// A rota continua existindo só para links antigos caírem no login.
// O bloqueio de verdade é no Supabase (Authentication → "Allow new users
// to sign up" desligado) — sem ele a API de cadastro continua aberta.
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  redirect(invite ? `/login?invite=${encodeURIComponent(invite)}` : "/login");
}
