"use client";

import { MembersTab } from "@/components/settings/members-tab";

// /membros — standalone route hosting MembersTab, moved out of
// /settings?tab=members (settings-sections.ts no longer registers a
// 'members' section). MembersTab itself is untouched — it already owns
// its own header (SettingsPanelHead); this page only supplies the
// page-level padding, matching /equipes' container convention instead
// of settings' narrower panel context.
export default function MembrosPage() {
  return (
    <div className="p-4 lg:p-6">
      <MembersTab />
    </div>
  );
}
