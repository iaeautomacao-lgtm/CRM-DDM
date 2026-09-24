"use client";

import { TemplateManager } from "@/components/settings/template-manager";

// /templates — standalone route hosting TemplateManager, moved out of
// /settings?tab=templates (settings-sections.ts no longer registers a
// 'templates' section). TemplateManager itself is untouched — it
// already owns its own header (SettingsPanelHead); this page only
// supplies the page-level padding, matching /equipes' container
// convention instead of settings' narrower panel context.
export default function TemplatesPage() {
  return (
    <div className="p-4 lg:p-6">
      <TemplateManager />
    </div>
  );
}
