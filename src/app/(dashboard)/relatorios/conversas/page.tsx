import { redirect } from "next/navigation";

// O relatório Conversas virou o Histórico (situação e período no próprio Histórico). Mantém o endereço antigo funcionando.
export default function ConversasRedirect() {
  redirect("/historico?status=todos");
}
