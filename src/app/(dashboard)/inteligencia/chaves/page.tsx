"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ApiKeysSettings } from "@/components/settings/api-keys-settings";

// /inteligencia/chaves — "Minhas chaves de API": chaves pessoais do DDM
// Intelligence para o MCP (/api/mcp, PRD-04 Fase 3). Mesmo alcance do
// /inteligencia (owner/admin/supervisor, ROUTE_ALLOWLIST por prefixo):
// cada um vê, cria e revoga só as próprias chaves.

export default function MinhasChavesPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 lg:p-6">
      <Link
        href="/inteligencia"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Voltar para o Intelligence
      </Link>
      <ApiKeysSettings personal />
    </div>
  );
}
