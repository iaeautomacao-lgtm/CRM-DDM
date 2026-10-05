import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GRAPH_VERSION, graphFetch, type SocialChannelType } from "./graph";

// Conexão de contas por OAuth. Endpoints conferidos na documentação da
// Meta (out/2026):
//
// Instagram (Instagram API com Instagram Login, sem página do Facebook):
//   autorizar: https://www.instagram.com/oauth/authorize
//              ?client_id&redirect_uri&response_type=code&scope&state
//   token curto: POST https://api.instagram.com/oauth/access_token
//   token longo (60 dias): GET https://graph.instagram.com/access_token
//              ?grant_type=ig_exchange_token
//   renovar:   GET https://graph.instagram.com/refresh_access_token
//              ?grant_type=ig_refresh_token
//   assinar webhooks: POST /me/subscribed_apps?subscribed_fields=messages
//
// Messenger (Facebook Login; o próprio diálogo da Meta pergunta quais
// Páginas liberar):
//   autorizar: https://www.facebook.com/<v>/dialog/oauth
//   token:     GET https://graph.facebook.com/<v>/oauth/access_token
//   token longo do usuário: grant_type=fb_exchange_token (os tokens de
//              Página obtidos a partir dele não expiram)
//   páginas:   GET /me/accounts?fields=id,name,access_token,picture
//   assinar:   POST /<page-id>/subscribed_apps?subscribed_fields=messages,messaging_postbacks
//
// Variáveis: INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET (app do Instagram) e
// META_APP_ID / META_APP_SECRET (app do Facebook), NEXT_PUBLIC_APP_URL.

const STATE_TTL_MS = 10 * 60 * 1000;

export const INSTAGRAM_SCOPES = "instagram_business_basic,instagram_business_manage_messages";
export const MESSENGER_SCOPES = "pages_show_list,pages_messaging,pages_manage_metadata";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} precisa estar configurada para conectar canais`);
  return value;
}

/**
 * Variáveis de ambiente que faltam para conectar cada canal. A tela de
 * /canais usa para desabilitar o botão com a explicação, em vez de mandar
 * o usuário para uma página de erro.
 */
export function socialConnectMissingEnv(type: SocialChannelType): string[] {
  const needed =
    type === "instagram"
      ? ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "NEXT_PUBLIC_APP_URL"]
      : ["META_APP_ID", "META_APP_SECRET", "NEXT_PUBLIC_APP_URL"];
  return needed.filter((name) => !process.env[name]);
}

export function oauthRedirectUri(type: SocialChannelType): string {
  return new URL(`/api/channels/${type}/callback`, requireEnv("NEXT_PUBLIC_APP_URL")).toString();
}

// ------------------------------------------------------------------
// state assinado: amarra o callback à conta e ao usuário que iniciou,
// e expira em 10 min (proteção CSRF do OAuth).
// ------------------------------------------------------------------

export interface OAuthState {
  accountId: string;
  userId: string;
  type: SocialChannelType;
  exp: number;
}

function stateKey(): Buffer {
  return Buffer.from(requireEnv("ENCRYPTION_KEY"), "utf8");
}

export function signOAuthState(state: Omit<OAuthState, "exp">): string {
  const payload = Buffer.from(
    JSON.stringify({ ...state, exp: Date.now() + STATE_TTL_MS, n: randomBytes(8).toString("hex") }),
  ).toString("base64url");
  const sig = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyOAuthState(raw: string | null): OAuthState | null {
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    return state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Instagram
// ------------------------------------------------------------------

export function instagramAuthorizeUrl(state: string): string {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", requireEnv("INSTAGRAM_APP_ID"));
  url.searchParams.set("redirect_uri", oauthRedirectUri("instagram"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface ConnectedAccount {
  externalId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  accessToken: string;
  expiresAt: string | null;
}

export async function exchangeInstagramCode(code: string): Promise<ConnectedAccount> {
  const form = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    client_secret: requireEnv("INSTAGRAM_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: oauthRedirectUri("instagram"),
    code,
  });
  const short = await graphFetch<{ access_token: string }>("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: form,
  });
  const long = await graphFetch<{ access_token: string; expires_in?: number }>(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(
      requireEnv("INSTAGRAM_APP_SECRET"),
    )}&access_token=${encodeURIComponent(short.access_token)}`,
  );
  // `user_id` de /me é o id da conta profissional — o mesmo que chega
  // como entry.id no webhook.
  const me = await graphFetch<{ user_id: string; username?: string; name?: string; profile_picture_url?: string }>(
    `https://graph.instagram.com/${GRAPH_VERSION}/me?fields=user_id,username,name,profile_picture_url&access_token=${encodeURIComponent(long.access_token)}`,
  );
  await graphFetch(
    `https://graph.instagram.com/${GRAPH_VERSION}/me/subscribed_apps?subscribed_fields=messages&access_token=${encodeURIComponent(long.access_token)}`,
    { method: "POST" },
  );
  return {
    externalId: String(me.user_id),
    name: me.name || (me.username ? `@${me.username}` : "Instagram"),
    username: me.username ?? null,
    avatarUrl: me.profile_picture_url ?? null,
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
  };
}

/** Renova o token longo (válido por 60 dias; renovar antes de vencer). */
export async function refreshInstagramToken(
  accessToken: string,
): Promise<{ accessToken: string; expiresAt: string | null }> {
  const res = await graphFetch<{ access_token: string; expires_in?: number }>(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`,
  );
  return {
    accessToken: res.access_token,
    expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000).toISOString() : null,
  };
}

// ------------------------------------------------------------------
// Messenger
// ------------------------------------------------------------------

export function messengerAuthorizeUrl(state: string): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", requireEnv("META_APP_ID"));
  url.searchParams.set("redirect_uri", oauthRedirectUri("messenger"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", MESSENGER_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Troca o code e devolve as Páginas que o usuário liberou, já assinadas. */
export async function exchangeMessengerCode(code: string): Promise<ConnectedAccount[]> {
  const appId = requireEnv("META_APP_ID");
  const appSecret = requireEnv("META_APP_SECRET");
  const short = await graphFetch<{ access_token: string }>(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(
      oauthRedirectUri("messenger"),
    )}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`,
  );
  const long = await graphFetch<{ access_token: string }>(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${encodeURIComponent(
      appSecret,
    )}&fb_exchange_token=${encodeURIComponent(short.access_token)}`,
  );
  const pages = await graphFetch<{
    data: Array<{ id: string; name: string; access_token: string; picture?: { data?: { url?: string } } }>;
  }>(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,picture&access_token=${encodeURIComponent(long.access_token)}`,
  );
  const connected: ConnectedAccount[] = [];
  for (const page of pages.data ?? []) {
    await graphFetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${page.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${encodeURIComponent(page.access_token)}`,
      { method: "POST" },
    );
    connected.push({
      externalId: page.id,
      name: page.name,
      username: null,
      avatarUrl: page.picture?.data?.url ?? null,
      accessToken: page.access_token,
      expiresAt: null,
    });
  }
  return connected;
}
