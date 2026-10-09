import { findRedChannels, RED_QUALITY_CODE, redBlockedMessage } from "@/lib/disparador/red-quality-gate";
import { requireApiKey } from "@/lib/auth/api-context";
import {
  ok,
  badRequest,
  badRequestWith,
  conflict,
  payloadTooLarge,
  ApiError,
  toApiErrorResponse,
  type ApiCallLogContext,
} from "@/lib/api/v1/respond";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { sanitizePhoneForMeta } from "@/lib/whatsapp/phone-utils";
import { assertWahaUrlIsSafe } from "@/lib/whatsapp/waha-api";
import { EXTERNAL_WAHA_TEXT_MARKER } from "@/lib/disparador/processQueue";
import { chatMediaReference } from "@/lib/storage/chat-media";
import { randomUUID } from "crypto";
import { loadBlacklistKeySet } from "@/lib/disparador/blacklist-keys";
import {
  INVALID_SAMPLE_LIMIT,
  MAX_BODY_BYTES,
  MAX_CONTACTS_PER_REQUEST,
  normalizeApiContacts,
  resolveApiDays,
  resolveIdempotency,
  resolveWahaMessage,
  scheduleApiContacts,
  validateApiWindow,
} from "@/lib/disparador/api-v1-campaign";

const CAMPAIGN_IMAGE_BASE64_MAX_BYTES = 5 * 1024 * 1024;
const CAMPAIGN_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type CampaignImageMimeType = (typeof CAMPAIGN_IMAGE_MIME_TYPES)[number];

function isCampaignImageMimeType(value: unknown): value is CampaignImageMimeType {
  return typeof value === "string" && CAMPAIGN_IMAGE_MIME_TYPES.includes(value as CampaignImageMimeType);
}

function extensionForCampaignImage(mime: CampaignImageMimeType): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  return "webp";
}

function decodeCampaignImageBase64(value: string): Buffer {
  // Fase 1 segue o mesmo contrato da API de mensagem avulsa: base64 puro,
  // sem prefixo data:. Buffer.from é permissivo, então validamos alfabeto,
  // padding e round-trip para não aceitar lixo silenciosamente.
  if (!value || value.startsWith("data:")) {
    throw badRequest("'media.base64' deve ser Base64 puro, sem prefixo data:");
  }
  const compact = value.replace(/\s+/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    throw badRequest("'media.base64' é inválido");
  }
  const buffer = Buffer.from(compact, "base64");
  if (buffer.length === 0 || buffer.toString("base64") !== compact) {
    throw badRequest("'media.base64' é inválido");
  }
  if (buffer.length > CAMPAIGN_IMAGE_BASE64_MAX_BYTES) {
    throw badRequest(
      `Imagem excede o limite de 5 MB (recebido: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`
    );
  }
  return buffer;
}

function imageMagicMatches(buffer: Buffer, mime: CampaignImageMimeType): boolean {
  if (mime === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === "image/png") {
    return buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  }
  return buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

// Payload esperado pelo sistema externo (Planejamento)
interface ExternalCampaignPayload {
  campaign_name: string;                  // obrigatório
  external_id?: string;                   // opcional — idempotência por id do sistema externo
  template_name?: string;                 // obrigatório para canais Meta — nome do template aprovado
  template_language?: string;             // padrão: "pt_BR"
  message?: string;                       // obrigatório para canais WAHA — texto livre com {{1}}, {{2}}...
  media?: {                                 // Fase 1: imagem, somente WAHA
    type: "image";
    url?: string;                             // URL pública HTTPS
    base64?: string;                          // Base64 puro, sem data:
    mime_type?: CampaignImageMimeType;        // obrigatório com base64
  };
  channel?: string;                       // UUID do canal OU número de telefone (ex: "+55 21 3030-9159")
  contacts: Array<{
    phone: string;                        // obrigatório — número do contato (com ou sem +)
    variables: string[];                  // variáveis posicionais {{1}}, {{2}}, {{3}}...
  }>;
  slot_size?: number;                     // qtd de contatos por slot (padrão: 1000)
  slot_interval_minutes?: number;         // intervalo entre slots em minutos (padrão: 30)
  janela_inicio?: string;                 // ex: "08:00" (padrão: "08:00")
  janela_fim?: string;                    // ex: "18:00" (padrão: "18:00")
  dias_envio?: number[];                  // 0=dom … 6=sáb (padrão: dias úteis, igual à tela)
  objective?: string;
  callback_url?: string;                  // URL para receber webhook ao finalizar
}

type CreationResult = {
  campaign_id: string;
  provider: "meta" | "waha";
  message_type: "text" | "image";
  enqueued: number;
  skipped: number;
  duplicates: number;
  invalid: number;
  invalid_sample: Array<{ index: number; phone: string | null; reason: string }>;
  slots: number;
  slot_size: number;
  slot_interval_minutes: number;
  estimated_completion_minutes: number;
};

type Db = ReturnType<typeof supabaseAdmin>;

/** Desfaz uma criação interrompida: apaga a fila, encerra a campanha e libera a chave. */
async function rollbackCampaign(db: Db, campaignId: string, accountId: string): Promise<void> {
  const steps: Array<[string, PromiseLike<{ error: { message: string } | null }>]> = [
    ["fila", db.from("disp_message_queue").delete().eq("campaign_id", campaignId).eq("account_id", accountId)],
    ["métricas", db.from("campaign_metrics").delete().eq("campaign_id", campaignId)],
    // Deltas pendentes (migration 183): sem isto a consolidação recriaria a linha de métricas.
    ["deltas de métricas", db.from("campaign_metric_deltas").delete().eq("campaign_id", campaignId)],
    [
      "campanha",
      db
        .from("campaigns")
        .update({ status: "encerrada", idempotency_key: null, idempotency_response: null })
        .eq("id", campaignId)
        .eq("account_id", accountId),
    ],
  ];
  for (const [label, step] of steps) {
    const { error } = await step;
    if (error) console.error(`[v1/disparador] rollback (${label}) falhou para ${campaignId}:`, error.message);
  }
}

function creationFailure(campaignId: string): ApiError {
  return new ApiError(
    "internal",
    "Falha ao enfileirar a campanha; ela foi cancelada. Pode repetir a requisição.",
    500,
    undefined,
    undefined,
    { campaign_id: campaignId }
  );
}

/** Repetição da mesma chave: devolve a campanha existente ou 409. */
async function replayExisting(
  db: Db,
  accountId: string,
  key: string,
  hash: string,
  logCtx: ApiCallLogContext
) {
  const { data: rows, error } = await db
    .from("campaigns")
    .select("id, idempotency_hash, idempotency_response")
    .eq("account_id", accountId)
    .eq("idempotency_key", key)
    .limit(1);
  if (error) throw error;
  const existing = rows?.[0];
  if (!existing) return null;
  if (existing.idempotency_hash !== hash) {
    throw conflict("Chave de idempotência/external_id já utilizada com outro conteúdo");
  }
  if (!existing.idempotency_response) {
    throw conflict("Criação desta campanha ainda em andamento; aguarde e repita a requisição");
  }
  return ok(existing.idempotency_response as CreationResult, 200, logCtx);
}

export async function POST(request: Request) {
  const logCtx: ApiCallLogContext = {
    method: "POST",
    route: "/api/v1/disparador/campaigns",
    startedAt: Date.now(),
  };
  try {
    const ctx = await requireApiKey(request, "campaigns:write");
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const db = supabaseAdmin();

    // Tamanho do corpo antes de carregar/parsear tudo.
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw payloadTooLarge("Corpo da requisição acima de 15 MB; divida os contatos em várias campanhas");
    }
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      throw payloadTooLarge("Corpo da requisição acima de 15 MB; divida os contatos em várias campanhas");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw badRequest("Corpo da requisição não é um JSON válido");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw badRequest("Corpo da requisição deve ser um objeto JSON");
    }
    const body = parsed as ExternalCampaignPayload;

    // Validações obrigatórias
    if (typeof body.campaign_name !== "string" || !body.campaign_name.trim()) {
      throw badRequest("'campaign_name' é obrigatório");
    }
    if (body.campaign_name.trim().length > 120) {
      throw badRequest("'campaign_name' pode ter no máximo 120 caracteres");
    }
    if (!Array.isArray(body.contacts) || body.contacts.length === 0) {
      throw badRequest("'contacts' é obrigatório e não pode ser vazio");
    }
    if (body.contacts.length > MAX_CONTACTS_PER_REQUEST) {
      throw payloadTooLarge(
        `Máximo de ${MAX_CONTACTS_PER_REQUEST} contatos por requisição (recebido: ${body.contacts.length}); divida em várias campanhas`
      );
    }
    if (body.channel != null && typeof body.channel !== "string") {
      throw badRequest("'channel' deve ser texto (UUID, sessão WAHA ou número Meta)");
    }

    let media:
      | { type: "image"; source: "url"; url: string }
      | { type: "image"; source: "base64"; base64: string; mimeType: CampaignImageMimeType; buffer: Buffer }
      | null = null;

    if (body.media != null) {
      if (typeof body.media !== "object" || Array.isArray(body.media)) {
        throw badRequest("'media' deve ser um objeto");
      }
      const candidate = body.media as {
        type?: unknown;
        url?: unknown;
        base64?: unknown;
        mime_type?: unknown;
      };
      if (candidate.type !== "image") {
        throw badRequest("'media.type' deve ser 'image' nesta versão da API");
      }

      const hasUrl = typeof candidate.url === "string" && candidate.url.trim().length > 0;
      const hasBase64 = typeof candidate.base64 === "string" && candidate.base64.trim().length > 0;
      if (hasUrl === hasBase64) {
        throw badRequest("Informe exatamente um de 'media.url' ou 'media.base64'");
      }

      if (hasUrl) {
        const mediaUrl = (candidate.url as string).trim();
        if (mediaUrl.length > 4096) {
          throw badRequest("'media.url' pode ter no máximo 4096 caracteres");
        }
        let parsedMediaUrl: URL;
        try {
          parsedMediaUrl = new URL(mediaUrl);
        } catch {
          throw badRequest("'media.url' deve ser uma URL HTTPS válida");
        }
        if (parsedMediaUrl.protocol !== "https:") {
          throw badRequest("'media.url' deve usar HTTPS");
        }
        media = { type: "image", source: "url", url: parsedMediaUrl.toString() };
      } else {
        if (!isCampaignImageMimeType(candidate.mime_type)) {
          throw badRequest(
            `'media.mime_type' é obrigatório com Base64 e deve ser: ${CAMPAIGN_IMAGE_MIME_TYPES.join(", ")}`
          );
        }
        const rawBase64 = (candidate.base64 as string).replace(/\s+/g, "");
        const buffer = decodeCampaignImageBase64(rawBase64);
        if (!imageMagicMatches(buffer, candidate.mime_type)) {
          throw badRequest("'media.base64' não corresponde ao 'media.mime_type' informado");
        }
        media = {
          type: "image",
          source: "base64",
          base64: rawBase64,
          mimeType: candidate.mime_type,
          buffer,
        };
      }
    }

    const janela_inicio = body.janela_inicio ?? "08:00";
    const janela_fim = body.janela_fim ?? "18:00";
    const windowError = validateApiWindow(janela_inicio, janela_fim);
    if (windowError) throw badRequest(windowError);
    const daysResult = resolveApiDays(body.dias_envio);
    if ("error" in daysResult) throw badRequest(daysResult.error);

    for (const [field, value] of [
      ["slot_size", body.slot_size],
      ["slot_interval_minutes", body.slot_interval_minutes],
    ] as const) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 1)) {
        throw badRequest(`'${field}' deve ser um número maior ou igual a 1`);
      }
    }

    const callbackUrl = body.callback_url?.trim() || null;
    if (callbackUrl) {
      // Mesma checagem de SSRF usada para waha_url — callback_url é
      // buscado (fetch) pelo servidor ao final da campanha, então não
      // pode apontar para endereços internos/privados.
      try {
        await assertWahaUrlIsSafe(callbackUrl);
      } catch {
        throw badRequest("'callback_url' inválida ou aponta para um destino não permitido");
      }
    }

    // Idempotência opcional (header Idempotency-Key ou external_id): quem
    // não manda nenhuma das duas segue exatamente como antes.
    const idem = resolveIdempotency(request.headers.get("idempotency-key"), body.external_id, parsed);
    if (idem.error) throw badRequest(idem.error);
    if (idem.key) {
      const replay = await replayExisting(db, ctx.accountId, idem.key, idem.hash, logCtx);
      if (replay) return replay;
    }

    // Resolver canal por UUID, waha_session estável ou número Meta.
    let channelId: string | null = null;
    let provider: "meta" | "waha" = "meta";
    if (body.channel) {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (uuidPattern.test(body.channel)) {
        const { data: chRows } = await db
          .from("whatsapp_config")
          .select("id, provider, created_at")
          .eq("id", body.channel)
          .eq("account_id", ctx.accountId)
          .eq("habilitado", true)
          .limit(1);
        let ch = chRows?.[0] ?? null;

        // Compatibilidade para integrações que guardaram o UUID de um
        // canal WAHA e depois o operador removeu/reconectou a linha. O
        // audit_log prova que o UUID antigo pertenceu a esta mesma conta;
        // só redirecionamos quando há exatamente um WAHA habilitado criado
        // depois da exclusão. UUID aleatório/da outra conta continua 400.
        if (!ch) {
          const { data: deleted } = await db
            .from("audit_logs")
            .select("created_at")
            .eq("account_id", ctx.accountId)
            .eq("resource_type", "whatsapp_line")
            .eq("resource_id", body.channel)
            .eq("action", "whatsapp_line.deleted")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (deleted?.created_at) {
            const deletedAt = Date.parse(deleted.created_at);
            const { data: currentWaha } = await db
              .from("whatsapp_config")
              .select("id, provider, created_at")
              .eq("account_id", ctx.accountId)
              .eq("habilitado", true)
              .eq("provider", "waha");

            const replacements = (currentWaha ?? []).filter((candidate) => {
              const createdAt = Date.parse(candidate.created_at ?? "");
              return Number.isFinite(deletedAt) && Number.isFinite(createdAt) && createdAt > deletedAt;
            });

            if (replacements.length === 1) {
              ch = replacements[0];
              console.warn(
                `[v1/disparador] canal WAHA antigo ${body.channel} remapeado para ${ch.id} após reconexão`
              );
            }
          }
        }

        if (!["meta", "waha"].includes(ch?.provider ?? "")) {
          throw badRequest("Canal não encontrado, desabilitado ou provider não suportado");
        }
        channelId = ch!.id;
        provider = ch!.provider as "meta" | "waha";
      } else {
        // Primeiro tenta o identificador estável da sessão WAHA. Isso evita
        // acoplar integrações externas ao UUID da linha, que pode mudar se
        // a configuração for removida e recriada.
        // .limit(1): sessão duplicada na conta não pode virar erro silencioso (maybeSingle falha com 2+ linhas).
        const { data: wahaRows } = await db
          .from("whatsapp_config")
          .select("id, provider")
          .eq("account_id", ctx.accountId)
          .eq("habilitado", true)
          .eq("provider", "waha")
          .eq("waha_session", body.channel)
          .limit(1);
        const wahaBySession = wahaRows?.[0] ?? null;

        if (wahaBySession) {
          channelId = wahaBySession.id;
          provider = "waha";
        } else {
          // Número de telefone continua sendo identificador de canal Meta.
          const digitsOnly = sanitizePhoneForMeta(body.channel);
          const { data: metaChannels } = await db
            .from("whatsapp_config")
            .select("id, provider, display_phone_number")
            .eq("account_id", ctx.accountId)
            .eq("habilitado", true)
            .eq("provider", "meta");

          const match = (metaChannels ?? []).find(
            (c) =>
              c.display_phone_number &&
              sanitizePhoneForMeta(c.display_phone_number) === digitsOnly
          );
          if (!match) {
            throw badRequest(`Canal não encontrado para o identificador: ${body.channel}`);
          }
          channelId = match.id;
          provider = "meta";
        }
      }
    } else {
      // Se não informou canal, usa o único canal habilitado (Meta ou WAHA) da conta
      const { data: channels } = await db
        .from("whatsapp_config")
        .select("id, provider")
        .eq("account_id", ctx.accountId)
        .eq("habilitado", true)
        .in("provider", ["meta", "waha"]);
      if (!channels || channels.length === 0) {
        throw badRequest("Nenhum canal habilitado encontrado nesta conta");
      }
      if (channels.length > 1) {
        throw badRequest("Conta com múltiplos canais habilitados — informe 'channel' (UUID, sessão WAHA ou número Meta)");
      }
      channelId = channels[0].id;
      provider = channels[0].provider as "meta" | "waha";
    }

    if (provider === "meta" && !body.template_name?.trim()) {
      throw badRequest("Campo 'template_name' é obrigatório para canais Meta");
    }
    if (provider === "waha" && !body.message?.trim()) {
      throw badRequest("Campo 'message' é obrigatório para canais WAHA");
    }
    // Número Meta em qualidade vermelha: campanha nova exige confirmação do owner no painel — chave de API não confirma.
    if (provider === "meta") {
      const red = await findRedChannels(db, ctx.accountId, [channelId]);
      if (red.length > 0) {
        throw new ApiError("conflict", redBlockedMessage(red), 409, undefined, undefined, {
          reason: RED_QUALITY_CODE,
          channels: red,
        });
      }
    }
    if (media && provider !== "waha") {
      throw badRequest("'media' nesta versão é suportada apenas para canais WAHA");
    }
    if (media?.source === "url") {
      // A WAHA baixa a URL diretamente. Validamos o destino aqui para
      // impedir que uma integração use o canal como ponte para acessar
      // localhost/redes privadas (SSRF).
      try {
        await assertWahaUrlIsSafe(media.url);
      } catch {
        throw badRequest("'media.url' inválida ou aponta para um destino não permitido");
      }
    }

    // Validar template aprovado — só se aplica a Meta; WAHA não tem
    // conceito de template, o texto vem direto de body.message.
    let templateLanguage = body.template_language ?? "pt_BR";

    if (provider === "meta") {
      // O canal define a WABA. A API pública segue a mesma regra do wizard:
      // somente template APPROVED explicitamente vinculado à WABA do canal.
      // Linhas legadas sem waba_id nunca autorizam um envio novo.
      const { data: channelRows } = await db
        .from("whatsapp_config")
        .select("waba_id")
        .eq("id", channelId!)
        .eq("account_id", ctx.accountId)
        .limit(1);
      const channelWabaId: string | null = channelRows?.[0]?.waba_id ?? null;
      if (!channelWabaId) {
        throw badRequest("Canal Meta sem WABA configurada; reconecte o canal antes de criar campanhas");
      }

      let tplQuery = db
        .from("message_templates")
        .select("id, name, language, waba_id, status")
        .eq("name", body.template_name!)
        .eq("account_id", ctx.accountId)
        .eq("waba_id", channelWabaId)
        .eq("status", "APPROVED");
      if (body.template_language) tplQuery = tplQuery.eq("language", body.template_language);
      const { data: tplRows } = await tplQuery.limit(50);
      const tpl = tplRows?.[0] ?? null;

      if (!tpl) {
        throw badRequest(
          `Template '${body.template_name}' não encontrado ou não aprovado na WABA do canal selecionado`
        );
      }
      templateLanguage = body.template_language ?? tpl.language ?? "pt_BR";
    }

    const slotSize = Math.min(MAX_CONTACTS_PER_REQUEST, Math.max(1, Math.floor(body.slot_size ?? 1000)));
    const slotIntervalMinutes = Math.min(10_080, Math.max(1, body.slot_interval_minutes ?? 30));
    const slotIntervalMs = slotIntervalMinutes * 60 * 1000;

    // Buscar blacklist — paginada (antes parava em 1000 linhas).
    const blacklistSet = await loadBlacklistKeySet(db);

    // Valida, deduplica por phoneKey (com/sem 55, com/sem 9º dígito) e
    // aplica a blacklist. WAHA: variável faltante → contato inválido.
    const normalized = normalizeApiContacts(body.contacts, {
      blacklist: blacklistSet,
      wahaMessage: provider === "waha" ? body.message ?? "" : null,
    });
    const { contacts: validContacts, duplicates, skipped, invalid, invalidSample } = normalized;
    if (validContacts.length === 0 && invalid > 0) {
      throw badRequestWith("Nenhum contato válido para enfileirar", {
        invalid,
        duplicates,
        skipped,
        invalid_sample: invalidSample,
      });
    }

    // URL externa é usada diretamente. Base64 é persistido UMA vez no
    // bucket privado e a fila guarda apenas a referência interna — nunca
    // replicamos megabytes de Base64 para cada contato.
    let queuedMediaUrl: string | null = media?.source === "url" ? media.url : null;
    let uploadedMediaPath: string | null = null;
    if (media?.source === "base64") {
      const ext = extensionForCampaignImage(media.mimeType);
      uploadedMediaPath = `account-${ctx.accountId}/api-campaigns/${randomUUID()}.${ext}`;
      const { error: uploadError } = await db.storage
        .from("chat-media")
        .upload(uploadedMediaPath, media.buffer, {
          contentType: media.mimeType,
          cacheControl: "31536000",
          upsert: false,
        });
      if (uploadError) {
        throw new ApiError("internal", "Não foi possível armazenar a imagem da campanha", 500);
      }
      queuedMediaUrl = chatMediaReference(uploadedMediaPath);
    }

    const cleanupUploadedMedia = async () => {
      if (!uploadedMediaPath) return;
      const { error } = await db.storage.from("chat-media").remove([uploadedMediaPath]);
      if (error) {
        console.error("[v1/disparador] falha ao remover mídia órfã:", error.message);
      }
    };

    // scheduled_at pelo relógio de janela: o que cai fora da janela/dia
    // permitido continua na próxima abertura, mantendo o espaçamento.
    const scheduleTimes = scheduleApiContacts(validContacts.length, {
      now: new Date(),
      slotSize,
      slotIntervalMs,
      janela: { inicio: janela_inicio, fim: janela_fim, dias: daysResult.days },
    });

    // Criar campanha
    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .insert({
        nome: body.campaign_name.trim(),
        objetivo: body.objective ?? null,
        status: "rascunho",
        // Necessário pra migration 040 (RLS do Disparador) poder ser
        // aplicada — ctx.accountId já vem resolvido por requireApiKey.
        account_id: ctx.accountId,
        // Migration 100 — distingue de campanhas criadas pelo wizard do
        // dashboard (startCampaign.ts, que não seta este campo e cai no
        // DEFAULT 'dashboard'). Usado pelo teste 12 do health check.
        source: "api_v1",
        session_ids: [channelId],
        janela_inicio,
        janela_fim,
        dias_envio: daysResult.days,
        intervalo_min: 0,
        intervalo_max: 0,
        callback_url: callbackUrl,
        // Migration 173 — só quando o cliente mandou chave/external_id.
        ...(idem.key ? { idempotency_key: idem.key, idempotency_hash: idem.hash } : {}),
        mensagens:
          provider === "meta"
            ? [
                {
                  tipo: "texto",
                  conteudo: `[Template: ${body.template_name}]`,
                  template_name: body.template_name,
                  template_language: templateLanguage,
                },
              ]
            : [
                {
                  tipo: media ? "imagem" : "texto",
                  conteudo: body.message ?? "",
                  ...(queuedMediaUrl ? { url: queuedMediaUrl } : {}),
                },
              ],
        created_by: ctx.createdBy,
      })
      .select("id")
      .single();

    if (campaignError?.code === "23505" && idem.key) {
      // Corrida: outra requisição com a mesma chave criou a campanha primeiro.
      await cleanupUploadedMedia();
      const replay = await replayExisting(db, ctx.accountId, idem.key, idem.hash, logCtx);
      if (replay) return replay;
    }
    if (campaignError || !campaign) {
      console.error("[v1/disparador] campaign insert error:", campaignError);
      await cleanupUploadedMedia();
      throw badRequest("Falha ao criar campanha");
    }

    const campaignId = campaign.id as string;

    // Montar fila (contatos já validados/deduplicados) e inserir em
    // blocos; qualquer falha desfaz tudo (fila + campanha encerrada) e
    // devolve o campaign_id para reconciliação.
    try {
      const queueRows: object[] = validContacts.map((contact, i) => {
        const scheduledAt = scheduleTimes[i].toISOString();
        if (provider === "meta") {
          return {
            campaign_id: campaignId,
            account_id: ctx.accountId,
            contact_id: null,           // contato externo — não existe no CRM
            session_id: channelId,
            // Armazena o telefone em mensagem_final como fallback para
            // o worker resolver o destinatário (contact_id é null)
            mensagem_final: contact.phone,
            status: "agendado",
            tipo: "texto",
            media_url: null,
            scheduled_at: scheduledAt,
            template_name: body.template_name,
            template_language: templateLanguage,
            template_variables: contact.variables,
          };
        }
        // WAHA — texto livre com variáveis {{1}}, {{2}}... resolvidas em
        // passada única. mensagem_final continua guardando o telefone
        // (contact_id é null); o texto já resolvido vai em
        // template_variables[0], sinalizado por EXTERNAL_WAHA_TEXT_MARKER.
        const resolvedMessage = resolveWahaMessage(body.message ?? "", contact.variables);
        if (resolvedMessage === null) throw new Error("variável sem valor após a validação");
        return {
          campaign_id: campaignId,
          account_id: ctx.accountId,
          contact_id: null,
          session_id: channelId,
          mensagem_final: contact.phone,
          status: "agendado",
          tipo: media ? "imagem" : "texto",
          media_url: queuedMediaUrl,
          scheduled_at: scheduledAt,
          template_name: EXTERNAL_WAHA_TEXT_MARKER,
          template_language: null,
          template_variables: [resolvedMessage],
        };
      });

      // Inserir fila em chunks de 500
      const chunkSize = 500;
      for (let k = 0; k < queueRows.length; k += chunkSize) {
        const { error: insertError } = await db
          .from("disp_message_queue")
          .insert(queueRows.slice(k, k + chunkSize));
        if (insertError) throw insertError;
      }

      // Métricas iniciais (antes de ativar: se falhar, nada saiu).
      const { error: metricsError } = await db
        .from("campaign_metrics")
        .upsert(
          { campaign_id: campaignId, account_id: ctx.accountId, total_contatos: validContacts.length },
          { onConflict: "campaign_id" }
        );
      if (metricsError) throw metricsError;

      // Ativa a campanha por último.
      const { error: activateError } = await db
        .from("campaigns")
        .update({ status: "em_execucao", agendamento: new Date().toISOString() })
        .eq("id", campaignId)
        .eq("account_id", ctx.accountId);
      if (activateError) throw activateError;
    } catch (err) {
      console.error("[v1/disparador] falha ao enfileirar; desfazendo campanha", campaignId, err);
      await rollbackCampaign(db, campaignId, ctx.accountId);
      await cleanupUploadedMedia();
      throw creationFailure(campaignId);
    }

    const enqueued = validContacts.length;
    const totalSlots = Math.ceil(enqueued / slotSize);
    const estimatedMinutes = Math.max(0, totalSlots - 1) * slotIntervalMinutes;
    const result: CreationResult = {
      campaign_id: campaignId,
      provider,
      message_type: media ? "image" : "text",
      enqueued,
      skipped,
      duplicates,
      invalid,
      invalid_sample: invalidSample.slice(0, INVALID_SAMPLE_LIMIT),
      slots: totalSlots,
      slot_size: slotSize,
      slot_interval_minutes: slotIntervalMinutes,
      estimated_completion_minutes: estimatedMinutes,
    };

    if (idem.key) {
      // Resposta guardada para a repetição. Falha aqui não desfaz a
      // campanha (já está em execução): a repetição cairá em 409 "em andamento".
      const { error: saveError } = await db
        .from("campaigns")
        .update({ idempotency_response: result })
        .eq("id", campaignId)
        .eq("account_id", ctx.accountId);
      if (saveError) console.error("[v1/disparador] falha ao guardar resposta idempotente:", saveError.message);
    }

    return ok(result, 201, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
