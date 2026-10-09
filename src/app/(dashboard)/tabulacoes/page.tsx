"use client";

import { usePermission } from "@/hooks/use-permission";
import { CustomFieldsSettings } from "@/components/settings/custom-fields-settings";
import { TagManager } from "@/components/settings/tag-manager";
import { TabulacoesManager } from "@/components/tabulacoes/tabulacoes-manager";

// /tabulacoes — standalone route, moved out of /settings?tab=fields
// (settings-sections.ts no longer registers a 'fields' section).
//
// TabulacoesManager owns the real "tabulações" CRUD (kind='outcome'
// tags only, with edit/delete/search/team-filter — see that
// component). TagManager is kept below it unchanged: it's the only UI
// anywhere in the app that can create a kind='contact' tag, so
// dropping it here would silently remove that capability. Custom
// fields stayed admin-gated exactly as FieldsAndTagsPanel had it.
export default function TabulacoesPage() {
  const canEditSettings = usePermission("tags.manage");

  return (
    <div className="max-w-3xl space-y-8 p-4 lg:p-6">
      <TabulacoesManager />
      <TagManager />
      {canEditSettings ? <CustomFieldsSettings /> : null}
    </div>
  );
}
