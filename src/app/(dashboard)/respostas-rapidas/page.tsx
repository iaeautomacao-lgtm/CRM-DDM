"use client";

import { QuickRepliesManager } from "@/components/quick-replies/quick-replies-manager";

// /respostas-rapidas — cadastro das respostas rápidas do Inbox (owner/admin,
// ver ROUTE_ALLOWLIST em src/lib/role-utils.ts).
export default function QuickRepliesPage() {
  return (
    <div className="max-w-3xl p-4 lg:p-6">
      <QuickRepliesManager />
    </div>
  );
}
