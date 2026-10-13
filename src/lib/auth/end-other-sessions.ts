// Depois que o próprio usuário troca a senha (Perfil e o diálogo do menu), encerra as OUTRAS sessões dele: quem tinha a
// senha antiga num outro aparelho sai na hora (revisão de segurança 13/10). Mantém a sessão atual. Módulo de navegador:
// só chama POST /api/me/sessions/revoke-others (rota de servidor, RPC da migration 290).
import { apiFetch } from "@/lib/api-fetch";

/** true = encerrou (ou não havia outras); false = não conseguiu (a senha já foi trocada; o usuário pode sair dos outros pela tela de sessões). */
export async function endOtherSessions(): Promise<boolean> {
  try {
    const res = await apiFetch("/api/me/sessions/revoke-others", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}
