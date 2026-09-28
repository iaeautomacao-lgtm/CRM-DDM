"use client";

import { MembersTab } from "@/components/settings/members-tab";

// /usuarios — standalone route hosting MembersTab, replacing /membros
// (see membros/page.tsx, now just a redirect here so old links/bookmarks
// still resolve). MembersTab itself is untouched — it already owns its
// own header (SettingsPanelHead); this page only supplies the
// page-level padding, matching /equipes' container convention instead
// of settings' narrower panel context.
export default function UsuariosPage() {
  return (
    <div className="p-4 lg:p-6">
      <MembersTab />
    </div>
  );
}
