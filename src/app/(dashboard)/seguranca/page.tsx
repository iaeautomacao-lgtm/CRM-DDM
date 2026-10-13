import { redirect } from "next/navigation";

// A segurança da conta vive em /perfil (aba Segurança). Mantém o endereço antigo funcionando.
export default function PersonalSecurityRedirect() {
  redirect("/perfil?tab=seguranca");
}
