"use client";

import { TemplateManager } from "@/components/settings/template-manager";

// /templates — standalone route hosting TemplateManager, moved out of
// /settings?tab=templates (settings-sections.ts no longer registers a
// 'templates' section). O TemplateManager traz o próprio PageBody
// (redesenho DDM), então a página não adiciona padding: o shell já tem.
export default function TemplatesPage() {
  return <TemplateManager />;
}
