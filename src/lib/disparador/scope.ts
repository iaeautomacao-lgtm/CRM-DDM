import type { SupabaseClient } from "@supabase/supabase-js";

// wacrm.campaigns.account_id exists and is populated in production —
// scope tenancy directly through it instead of the old created_by ->
// profiles.account_id workaround.
export async function getDisparadorScope(supabase: SupabaseClient) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { campaignIds: [], accountId: null as string | null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const accountId = profile?.account_id ?? null;

  if (!accountId) return { campaignIds: [], accountId };

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id")
    .eq("account_id", accountId);

  const campaignIds = (campaigns ?? []).map((c) => c.id as string);

  return { campaignIds, accountId };
}
