// ============================================================
// POST /api/whatsapp/flows/data/{channelId} — endpoint de Data Exchange dos WhatsApp Flows (PRD 21, PR 21.2). PÚBLICO, chamado pela Meta.
//
// A URL (com o id do canal) é a que se cadastra como "endpoint" do Flow no Meta Business. Ordem de defesa, do mais barato ao mais caro:
//   1. corpo com TETO (256 KB) e limite local por canal (a decifragem RSA tem custo de CPU);
//   2. canal inexistente / sem par de chaves ⇒ 404 / 421 (421 = "busque a chave pública de novo", o que a Meta faz);
//   3. ASSINATURA (X-Hub-Signature-256, app_secret do canal) sobre o corpo BRUTO, antes de qualquer parse ⇒ 432;
//   4. decifra (RSA-OAEP + AES-128-GCM) ⇒ falha = 421; o conteúdo vai para o despacho (flows-data.ts) e a resposta volta cifrada.
// Nunca registra o conteúdo decifrado (pode ter CPF/valores): só canal, ação, tempo e o MOTIVO de uma rejeição.
// Sem env: o recurso liga por CANAL, ao gerar o par de chaves (rota /api/whatsapp/flows/keys).
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { writeLog } from "@/lib/logger";
import { checkRateLimitLocal } from "@/lib/rate-limit";
import { readCappedBody } from "@/lib/security/webhook-body";
import { decryptStoredSecret } from "@/lib/whatsapp/encryption";
import { decryptFlowRequest, encryptFlowResponse, FlowCryptoError, isFlowEncryptedRequest } from "@/lib/whatsapp/flows-crypto";
import { handleFlowData } from "@/lib/whatsapp/flows-data";
import { loadFlowsPrivateKey } from "@/lib/whatsapp/flows-keys";
import { verifyMetaWebhookSignature } from "@/lib/whatsapp/webhook-signature";

export const maxDuration = 10;

const MAX_BODY_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = { limit: 600, windowMs: 60_000 };

const reject = (status: number) => new NextResponse(null, { status });

export async function POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const startedAt = Date.now();
  const { channelId } = await params;
  if (!UUID_RE.test(channelId)) return reject(404);
  if (!checkRateLimitLocal(`flows-data:${channelId}`, LIMIT).success) return reject(429);

  const body = await readCappedBody(request, MAX_BODY_BYTES);
  if (!body.ok) return reject(body.status);

  const db = supabaseAdmin();
  const { data: rows, error } = await db.from("whatsapp_config").select("id, account_id, app_secret").eq("id", channelId).limit(1);
  const channel = (rows as Array<{ id: string; account_id: string; app_secret: string | null }> | null)?.[0];
  if (error || !channel) return reject(404);

  const log = (level: "info" | "warn", event: string, payload: Record<string, unknown>) =>
    void writeLog({ account_id: channel.account_id, level, source: "webhook_meta", event, message: "WhatsApp Flow — Data Exchange", payload: { channel_id: channelId, ...payload } });

  let secret: string | null = null;
  try {
    secret = channel.app_secret ? decryptStoredSecret(channel.app_secret, "whatsapp_config.app_secret") : (process.env.META_APP_SECRET ?? null);
  } catch {
    secret = process.env.META_APP_SECRET ?? null;
  }
  if (!verifyMetaWebhookSignature(body.text, request.headers.get("x-hub-signature-256"), secret)) {
    log("warn", "flow_data_rejected", { reason: "signature" });
    return reject(432);
  }

  const privateKey = await loadFlowsPrivateKey(db, channelId).catch(() => null);
  if (!privateKey) {
    log("warn", "flow_data_rejected", { reason: "no_key" });
    return reject(421);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return reject(400);
  }
  if (!isFlowEncryptedRequest(parsed)) return reject(400);

  try {
    const decrypted = decryptFlowRequest(parsed, privateKey);
    const { action, response } = await handleFlowData(decrypted.body, { accountId: channel.account_id, channelId });
    const encrypted = encryptFlowResponse(response, decrypted.aesKey, decrypted.iv);
    log("info", "flow_data_exchange", { action, ms: Date.now() - startedAt });
    return new Response(encrypted, { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof FlowCryptoError) {
      log("warn", "flow_data_rejected", { reason: "decrypt" });
      return reject(421); // a Meta busca a chave pública de novo
    }
    log("warn", "flow_data_rejected", { reason: "handler_error" });
    return reject(500);
  }
}
