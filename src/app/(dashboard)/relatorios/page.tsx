import { redirect } from "next/navigation";

// /relatorios não tem tela própria: o layout só traz as abas. Quem abre o endereço direto (favorito, link antigo,
// título "Relatórios") cai em Atendimentos, a primeira aba e a que o menu já usa. Supervisores só veem os relatórios de
// atendimento; o gate de cada aba continua sendo o de ROUTE_ALLOWLIST.
export default function RelatoriosIndexPage() {
  redirect("/relatorios/atendimentos");
}
