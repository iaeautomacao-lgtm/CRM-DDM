import type { Session } from "@supabase/supabase-js";

type TemporalPayload = {
  iat?: number;
  exp?: number;
};

type CookieSummary = {
  name: string;
  bytes: number;
};

type CookieTotals = {
  cookies: CookieSummary[];
  count: number;
  totalBytes: number;
};

const TAB_ID_KEY = "wacrm:auth-fx-tab-id";
let memoryTabId: string | null = null;
let cookieProbeStarted = false;
let lastCookieSnapshot = new Map<string, number>();
let fetchSeq = 0;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function base64UrlDecode(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return atob(padded);
  } catch {
    return null;
  }
}

export function getAuthFxTabId() {
  if (typeof window === "undefined") return "server";
  if (memoryTabId) return memoryTabId;

  try {
    const existing = window.sessionStorage.getItem(TAB_ID_KEY);
    if (existing) {
      memoryTabId = existing;
      return existing;
    }

    const next = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.sessionStorage.setItem(TAB_ID_KEY, next);
    memoryTabId = next;
    return next;
  } catch {
    memoryTabId = memoryTabId ?? `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return memoryTabId;
  }
}

export function logAuthFx(scope: string, data: Record<string, unknown>) {
  if (typeof window === "undefined") return;

  console.log(`[AUTH-FX][${scope}]`, {
    t: new Date().toISOString(),
    perf: Math.round(performance.now()),
    path: window.location.pathname,
    tab: getAuthFxTabId(),
    ...data,
  });
}

export function decodeAccessTokenTemporal(accessToken?: string | null): TemporalPayload | null {
  if (!accessToken) return null;
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  const decoded = base64UrlDecode(payload);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as TemporalPayload;
    return {
      iat: typeof parsed.iat === "number" ? parsed.iat : undefined,
      exp: typeof parsed.exp === "number" ? parsed.exp : undefined,
    };
  } catch {
    return null;
  }
}

export function summarizeSession(session?: Session | null) {
  const browserNow = nowSeconds();
  const temporal = decodeAccessTokenTemporal(session?.access_token);
  return {
    session: !!session,
    user: !!session?.user,
    expires_at: session?.expires_at ?? null,
    browser_now: browserNow,
    secondsToExpiry: session?.expires_at ? session.expires_at - browserNow : null,
    iat: temporal?.iat ?? null,
    exp: temporal?.exp ?? null,
    expMinusBrowserNow: temporal?.exp ? temporal.exp - browserNow : null,
    browserNowMinusIat: temporal?.iat ? browserNow - temporal.iat : null,
  };
}

export function getSupabaseCookieSnapshot(): Map<string, number> {
  const result = new Map<string, number>();
  if (typeof document === "undefined") return result;

  document.cookie
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .forEach((cookie) => {
      const eq = cookie.indexOf("=");
      const name = eq >= 0 ? cookie.slice(0, eq) : cookie;
      const value = eq >= 0 ? cookie.slice(eq + 1) : "";
      if (name.startsWith("sb-")) {
        result.set(name, new Blob([value]).size);
      }
    });

  return result;
}

export function summarizeSupabaseCookies(): CookieTotals {
  const snapshot = getSupabaseCookieSnapshot();
  const cookies = [...snapshot.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => ({ name, bytes }));
  return {
    cookies,
    count: cookies.length,
    totalBytes: cookies.reduce((sum, cookie) => sum + cookie.bytes, 0),
  };
}

function logCookieDiff(next: Map<string, number>, reason: string) {
  const changed: CookieSummary[] = [];
  const deleted: CookieSummary[] = [];

  next.forEach((bytes, name) => {
    if (lastCookieSnapshot.get(name) !== bytes) changed.push({ name, bytes });
  });
  lastCookieSnapshot.forEach((bytes, name) => {
    if (!next.has(name)) deleted.push({ name, bytes });
  });

  if (changed.length || deleted.length) {
    logAuthFx("COOKIE", {
      reason,
      changed,
      deleted,
      totals: summarizeSupabaseCookies(),
    });
  }

  lastCookieSnapshot = next;
}

export function startAuthCookieForensics() {
  if (typeof window === "undefined" || cookieProbeStarted) return;
  cookieProbeStarted = true;
  lastCookieSnapshot = getSupabaseCookieSnapshot();

  logAuthFx("TAB", {
    hasCookieStore: "cookieStore" in window,
    hasBroadcastChannel: "BroadcastChannel" in window,
    hasNavigatorLocks: !!(navigator as Navigator & { locks?: unknown }).locks,
    initialCookies: summarizeSupabaseCookies(),
  });

  const cookieStore = (window as typeof window & {
    cookieStore?: {
      addEventListener?: (type: "change", listener: (event: unknown) => void) => void;
    };
  }).cookieStore;

  if (cookieStore?.addEventListener) {
    cookieStore.addEventListener("change", (event: unknown) => {
      const e = event as {
        changed?: Array<{ name: string }>;
        deleted?: Array<{ name: string }>;
      };
      const changed = (e.changed ?? []).map((cookie) => cookie.name).filter((name) => name.startsWith("sb-"));
      const deleted = (e.deleted ?? []).map((cookie) => cookie.name).filter((name) => name.startsWith("sb-"));
      if (changed.length || deleted.length) {
        logAuthFx("COOKIE", {
          reason: "cookieStore",
          changed: changed.map((name) => ({ name, bytes: getSupabaseCookieSnapshot().get(name) ?? 0 })),
          deleted: deleted.map((name) => ({ name, bytes: 0 })),
          totals: summarizeSupabaseCookies(),
        });
      }
      lastCookieSnapshot = getSupabaseCookieSnapshot();
    });
    return;
  }

  let ticks = 0;
  const fast = window.setInterval(() => {
    ticks += 1;
    logCookieDiff(getSupabaseCookieSnapshot(), "poll-50ms");
    if (ticks >= 100) window.clearInterval(fast);
  }, 50);

  window.setInterval(() => {
    logCookieDiff(getSupabaseCookieSnapshot(), "poll-250ms");
  }, 250);
}

export async function authForensicsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const seq = ++fetchSeq;
  const requestUrl = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const isAuthToken = requestUrl.includes("/auth/v1/token");
  const grantType = isAuthToken ? new URL(requestUrl).searchParams.get("grant_type") : null;
  const startedAt = performance.now?.() ?? Date.now();

  if (isAuthToken) {
    logAuthFx("AUTH-NET", {
      seq,
      phase: "start",
      grantType,
    });
  }

  const response = await fetch(input, init);

  if (isAuthToken) {
    logAuthFx("AUTH-NET", {
      seq,
      phase: "end",
      grantType,
      status: response.status,
      ok: response.ok,
      date: response.headers.get("date"),
      elapsedMs: Math.round((performance.now?.() ?? Date.now()) - startedAt),
    });
  }

  return response;
}