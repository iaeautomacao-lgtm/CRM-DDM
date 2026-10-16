// Tudo que o navegador guarda de um usuário e precisa sumir quando a sessão acaba (LGPD): logout, sessão expirada e
// troca de conta/usuário. Um único gancho, chamado de use-auth e do SwrProvider.
import { clearAllDrafts } from "@/lib/inbox/drafts";
import { clearOriginCache } from "@/lib/inbox/origin-cache";
import { clearCachedThread } from "@/lib/inbox/thread-pages";
import { clearSwrCache } from "@/lib/swr/cache";

export function clearSessionData(): void {
  clearSwrCache(); // cache SWR (respostas das telas)
  clearCachedThread(); // mensagens das últimas conversas abertas (Inbox)
  clearOriginCache(); // origem das conversas abertas (Inbox)
  clearAllDrafts(); // rascunhos do operador (localStorage)
}
