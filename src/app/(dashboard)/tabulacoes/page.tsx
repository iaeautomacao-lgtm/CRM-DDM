"use client";

import { FieldsAndTagsPanel } from "@/components/settings/fields-and-tags-panel";

// /tabulacoes — standalone route hosting FieldsAndTagsPanel, moved out
// of /settings?tab=fields (settings-sections.ts no longer registers a
// 'fields' section). Same component as before — its `title` prop
// (added for this move) just swaps the section header from "Campos e
// tags" to "Tabulações" to match how this route is presented in the
// sidebar, without needing two copies of the component.
export default function TabulacoesPage() {
  return (
    <div className="p-4 lg:p-6">
      <FieldsAndTagsPanel title="Tabulações" />
    </div>
  );
}
