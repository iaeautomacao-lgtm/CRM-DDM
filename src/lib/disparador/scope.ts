import type { SupabaseClient } from "@supabase/supabase-js";

// wacrm.campaigns/disp_message_queue have no account_id yet (migration 040
// is not applied — see supabase/migrations/040_disparador_account_scoping.sql).
// Until it lands, client-side reads scope tenancy through
// created_by -> profiles.account_id instead, matching every other member of
// the caller's account (not just the caller) since accounts are multi-user.
export async function getDisparadorScope(supabase: SupabaseClient) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { userIds: [], campaignIds: [] };

  const { data: profile } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const accountId = profile?.account_id;

  // No account on the profile: fall back to scoping by the caller alone
  // rather than failing open (showing everything).
  if (!accountId) return { userIds: [user.id], campaignIds: [] };

  const { data: members } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("account_id", accountId);

  const userIds = (members ?? []).map((m) => m.user_id as string);
  if (userIds.length === 0) userIds.push(user.id);

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id")
    .in("created_by", userIds);

  const campaignIds = (campaigns ?? []).map((c) => c.id as string);

  return { userIds, campaignIds };
}
