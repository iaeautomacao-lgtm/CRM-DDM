"use client";

import { TeamsPanel } from "@/components/settings/teams-panel";

// /equipes — standalone page hosting TeamsPanel, moved out of
// /settings?tab=teams (settings-sections.ts no longer registers a
// 'teams' section). TeamsPanel itself is untouched — it already owns
// its own header (SettingsPanelHead) and full CRUD; this page only
// supplies the page-level padding, matching /canais' container
// convention instead of settings' narrower panel context.
export default function EquipesPage() {
  return (
    <div className="p-4 lg:p-6">
      <TeamsPanel />
    </div>
  );
}
