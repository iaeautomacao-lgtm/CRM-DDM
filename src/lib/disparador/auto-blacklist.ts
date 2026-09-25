import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { writeLog, maskPhone } from "@/lib/logger";

// Mesma normalização de contacts.phone (ver formatBrazilianPhone em
// src/app/api/disparador/contacts/import/route.ts) — startCampaign.ts
// compara blacklist.telefone com contact.phone por igualdade EXATA de
// string (sem normalizar na hora do envio), então uma entrada de
// blacklist em formato diferente nunca bloqueia ninguém de verdade.
function formatBrazilianPhone(raw: string): string {
  if (!raw) return "";
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.startsWith("55")) return `+${cleaned}`;
  return `+55${cleaned}`;
}

const ERROR_131026_MOTIVO =
  "Meta: Número inacessível (131026) — adicionado automaticamente";

// Blacklist automática pro código Meta 131026 (janela de 24h encerrada /
// mensagem recorrentemente não entregável) — chamada tanto pelo caminho
// síncrono (processQueue.ts, erro imediato do POST /messages) quanto pelo
// assíncrono (webhook/route.ts, status de entrega "failed" reportado
// depois do envio ter sido aceito). Idempotente: se o número já está
// bloqueado, não insere de novo nem loga de novo — nunca lança, é
// fire-and-forget nos dois call sites (blacklist automática não pode
// derrubar o fluxo de envio/webhook que a disparou).
export async function autoBlacklistOn131026(
  rawPhone: string,
  campaignId: string | null
): Promise<void> {
  const telefone = formatBrazilianPhone(rawPhone);
  if (!telefone) return;

  try {
    const db = supabaseAdmin();
    const { data: existing } = await db
      .from("blacklist")
      .select("id")
      .eq("telefone", telefone)
      .maybeSingle();
    if (existing) return;

    const { error } = await db.from("blacklist").insert({
      telefone,
      motivo: ERROR_131026_MOTIVO,
      campaign_id: campaignId,
      bloqueado_por: "sistema",
      data_bloqueio: new Date().toISOString(),
    });

    if (error) {
      // 23505 = corrida com outra chamada concorrente que já inseriu
      // esse telefone entre o select e o insert acima — já é o estado
      // desejado (bloqueado), não é uma falha de verdade.
      if (error.code !== "23505") {
        console.error("[Disparador] autoBlacklistOn131026: falha ao inserir na blacklist:", error);
      }
      return;
    }

    void writeLog({
      level: "info",
      source: "disparador",
      event: "blacklist_auto",
      message: `Número ${maskPhone(telefone)} adicionado automaticamente à blacklist (erro 131026, campanha ${campaignId ?? "desconhecida"}).`,
      payload: {
        campaign_id: campaignId,
        telefone_mascarado: maskPhone(telefone),
        code: 131026,
      },
    });
  } catch (err) {
    console.error("[Disparador] autoBlacklistOn131026: exceção inesperada:", err);
  }
}
