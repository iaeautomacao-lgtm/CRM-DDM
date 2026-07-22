import type { MediaKind } from './meta-api';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

interface WahaConfig {
  waha_url: string;
  waha_session: string;
  waha_api_key?: string | null;
}

/** Thrown by assertWahaUrlIsSafe; message is safe to show to the caller. */
export class WahaUrlBlockedError extends Error {
  constructor() {
    super('WAHA server URL is not allowed.');
    this.name = 'WahaUrlBlockedError';
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateOrReservedIP(ip: string): boolean {
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) return isPrivateOrReservedIPv4(v4Mapped[1]);
    return false;
  }
  return isPrivateOrReservedIPv4(ip);
}

/**
 * Blocks the WAHA server URL from pointing at private/reserved network
 * ranges or localhost, so a malicious `waha_url` can't be used to probe
 * or reach internal services (SSRF). Resolves DNS for non-IP hosts
 * rather than only checking the literal hostname, so a public domain
 * that resolves to an internal address is blocked too. There's no
 * practical domain allowlist here — waha_url is a per-account,
 * self-hosted WAHA instance, so the host isn't known in advance.
 */
export async function assertWahaUrlIsSafe(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WahaUrlBlockedError();
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WahaUrlBlockedError();
  }

  const hostname = stripBrackets(parsed.hostname).toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new WahaUrlBlockedError();
  }

  if (isIP(hostname)) {
    if (isPrivateOrReservedIP(hostname)) throw new WahaUrlBlockedError();
    return;
  }

  try {
    const results = await lookup(hostname, { all: true });
    if (results.some((r) => isPrivateOrReservedIP(r.address))) {
      throw new WahaUrlBlockedError();
    }
  } catch (err) {
    if (err instanceof WahaUrlBlockedError) throw err;
    // Unresolvable host — let the actual fetch fail with its own error
    // rather than treating a DNS hiccup as a security block.
  }
}

async function wahaFetch(
  config: WahaConfig,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  await assertWahaUrlIsSafe(config.waha_url);

  const baseUrl = config.waha_url.replace(/\/$/, '');
  const url = `${baseUrl}${path}`;
  const headers = new Headers(options.headers || {});

  if (config.waha_api_key) {
    // WAHA supports both X-Api-Key header and Bearer token
    headers.set('X-Api-Key', config.waha_api_key);
    headers.set('Authorization', `Bearer ${config.waha_api_key}`);
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

export interface WahaSessionInfo {
  name: string;
  status: 'STOPPED' | 'STARTING' | 'SCAN_QR' | 'WORKING' | 'FAILED' | 'UNKNOWN';
}

export async function getWahaSessionStatus(
  config: WahaConfig
): Promise<WahaSessionInfo['status']> {
  try {
    const res = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}`);
    if (res.status === 404) {
      return 'STOPPED';
    }
    if (!res.ok) {
      throw new Error(`WAHA API error: ${res.status}`);
    }
    const data = await res.json();
    return data.status || 'UNKNOWN';
  } catch (err) {
    console.error('[waha-api] getWahaSessionStatus error:', err);
    return 'UNKNOWN';
  }
}

export async function getWahaSessionInfo(
  config: WahaConfig
): Promise<any> {
  try {
    const res = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`WAHA API error: ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.error('[waha-api] getWahaSessionInfo error:', err);
    return null;
  }
}

export async function startWahaSession(config: WahaConfig, webhookUrl?: string): Promise<void> {
  // If webhookUrl is provided, we stop and delete the session first to recreate it with the webhook config
  if (webhookUrl) {
    try {
      await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/stop`, { method: 'POST' });
    } catch (e) {}
    try {
      await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}`, { method: 'DELETE' });
    } catch (e) {}
  }

  const sessionPayload: Record<string, any> = { name: config.waha_session };
  if (webhookUrl) {
    sessionPayload.config = {
      webhooks: [
        {
          url: webhookUrl,
          events: ['message', 'message.any', 'message.reaction', 'message.ack', 'message.revoked'],
        }
      ]
    };
  }

  let createRes = await wahaFetch(config, '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionPayload),
  });

  if (!createRes.ok) {
    console.warn(`[waha-api] Failed to create session with config (status ${createRes.status}), retrying with name-only body`);
    console.warn('[TEMP DEBUG] Payload enviado:', JSON.stringify(sessionPayload));
    console.warn('[TEMP DEBUG] Resposta do WAHA:', await createRes.clone().text());
    createRes = await wahaFetch(config, '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: config.waha_session }),
    });
  }

  if (!createRes.ok) {
    // If creation fails (e.g. session already exists and shouldn't be deleted), try to start it directly
    const startRes = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/start`, {
      method: 'POST',
    });
    if (!startRes.ok) {
      throw new Error(`Failed to start/create WAHA session: ${createRes.status}`);
    }
    return;
  }

  const startRes = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/start`, {
    method: 'POST',
  });
  if (!startRes.ok) {
    throw new Error(`Failed to start WAHA session: ${startRes.status}`);
  }
}

export async function stopWahaSession(config: WahaConfig): Promise<void> {
  // Try path-based stop endpoint
  const res = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/stop`, {
    method: 'POST',
  });
  if (!res.ok) {
    // Fall back to legacy stop endpoint
    const fallbackRes = await wahaFetch(config, '/api/sessions/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: config.waha_session }),
    });
    if (!fallbackRes.ok) {
      throw new Error(`Failed to stop WAHA session: ${res.status}`);
    }
  }
}

export async function getWahaQrCode(config: WahaConfig): Promise<Response> {
  // Try the new auth/qr endpoint first
  const res = await wahaFetch(config, `/api/${encodeURIComponent(config.waha_session)}/auth/qr?format=image`, {
    headers: {
      'Accept': 'image/png',
    }
  });
  if (res.ok) return res;

  // Fall back to /api/sessions/{session}/qr if the session version requires it
  const fallback = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/qr`);
  if (!fallback.ok) {
    throw new Error(`Failed to fetch QR code: ${fallback.status}`);
  }
  return fallback;
}

export interface WahaSendResult {
  messageId: string;
}

export async function sendWahaTextMessage(
  config: WahaConfig,
  to: string,
  text: string,
  replyToId?: string
): Promise<WahaSendResult> {
  // Format phone number to WAHA expected format: 5511999999999@c.us
  const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;

  const payload: Record<string, any> = {
    chatId,
    text,
    session: config.waha_session,
  };

  if (replyToId) {
    payload.reply_to = replyToId;
  }

  const res = await wahaFetch(config, '/api/sendText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WAHA sendText failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    messageId: data.id || '',
  };
}

export async function sendWahaMediaMessage(
  config: WahaConfig,
  to: string,
  mediaUrl: string,
  mediaType: MediaKind,
  filename: string,
  caption?: string
): Promise<WahaSendResult> {
  const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;

  const payload = {
    chatId,
    file: {
      url: mediaUrl,
      name: filename || `file_${Date.now()}`,
    },
    caption: caption || '',
    session: config.waha_session,
  };

  const res = await wahaFetch(config, '/api/sendFile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WAHA sendFile failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    messageId: data.id || '',
  };
}

export async function getWahaProfilePicture(
  config: WahaConfig,
  phone: string
): Promise<string | null> {
  try {
    const contactId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
    const res = await wahaFetch(
      config,
      `/api/contacts/profile-picture?contactId=${encodeURIComponent(contactId)}&session=${encodeURIComponent(config.waha_session)}`
    );

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    return data.profilePictureURL || null;
  } catch (err) {
    console.error('[waha-api] getWahaProfilePicture error:', err);
    return null;
  }
}

export async function requestWahaPairingCode(
  config: WahaConfig,
  phoneNumber: string
): Promise<{ code: string }> {
  const res = await wahaFetch(
    config,
    `/api/${encodeURIComponent(config.waha_session)}/auth/request-code`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phoneNumber }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to request pairing code: ${res.status} - ${errorText}`);
  }

  const data = await res.json();
  return {
    code: data.code || '',
  };
}

export async function sendWahaReaction(
  config: WahaConfig,
  messageId: string,
  emoji: string
): Promise<void> {
  const res = await wahaFetch(config, '/api/reaction', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: config.waha_session,
      messageId: messageId,
      reaction: emoji,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to send reaction to WAHA: ${res.status} - ${errorText}`);
  }
}

export async function startWacallsCall(
  config: WahaConfig,
  phone: string
): Promise<{ callId: string }> {
  const res = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/calls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to start WaCalls call: ${res.status} - ${errorText}`);
  }

  const data = await res.json();
  return {
    callId: data.call?.callId || '',
  };
}

export async function playWacallsAudio(
  config: WahaConfig,
  callId: string,
  url: string
): Promise<void> {
  const res = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/calls/${callId}/play`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to play WaCalls audio: ${res.status} - ${errorText}`);
  }
}

export async function getWacallsCallStatus(
  config: WahaConfig,
  callId: string
): Promise<{ status: string; ended: boolean }> {
  const res = await wahaFetch(config, `/api/sessions/${encodeURIComponent(config.waha_session)}/calls/${callId}`, {
    method: 'GET',
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get WaCalls call status: ${res.status} - ${errorText}`);
  }

  return res.json();
}

export async function sendWahaVoiceMessage(
  config: WahaConfig,
  to: string,
  mediaUrl: string
): Promise<WahaSendResult> {
  const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;

  const payload = {
    chatId,
    file: {
      url: mediaUrl,
    },
    session: config.waha_session,
  };

  const res = await wahaFetch(config, '/api/sendVoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WAHA sendVoice failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    messageId: data.id || '',
  };
}



