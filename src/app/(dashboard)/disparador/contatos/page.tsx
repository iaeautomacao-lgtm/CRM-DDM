import { redirect } from "next/navigation";

// As listas importadas viraram a aba "Importações" de Contatos. Mantém o endereço antigo funcionando.
export default function ListasImportadasRedirect() {
  redirect("/contacts?tab=importacoes");
}
