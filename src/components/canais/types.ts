// Shape of one item in GET /api/whatsapp/config's `configs` array —
// NOT the raw wacrm.whatsapp_config row. The route re-verifies each
// config against WAHA/Meta live on every call and returns only the
// fields below (see src/app/api/whatsapp/config/route.ts:116-211) —
// notably `phone_number_id` is absent whenever a Meta config fails
// its health check (token_corrupted / meta_api_error), since Meta's
// own verify call is what supplies it (as `phone_info.id`) and that
// call didn't succeed.
//
// flow_id/receptivo/habilitado (migration 056) are plain passthrough
// columns the route now includes in every branch — no live
// verification needed for those three. flow_name is NOT part of the
// API response (no join there); it's resolved client-side in
// page.tsx from a separate GET /api/flows call, keyed by flow_id.
export interface ChannelConfig {
  id: string;
  connected: boolean;
  provider: "waha" | "meta";
  session_status?: string;
  waha_session?: string;
  waha_url?: string;
  phone_info?: {
    id?: string;
    display_phone_number?: string;
    verified_name?: string;
  };
  reason?: string;
  message?: string;
  needs_reset?: boolean;
  flow_id: string | null;
  receptivo: boolean;
  habilitado: boolean;
  /** Resolved client-side, not returned by the API — see comment above. */
  flow_name?: string;
}

export const MASKED_TOKEN = "••••••••••••••••";

// Mirrors normalizeSessionName in whatsapp-config.tsx (not exported
// there, so reimplemented here rather than modifying that file).
export function normalizeSessionName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}
