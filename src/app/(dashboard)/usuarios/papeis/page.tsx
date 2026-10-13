"use client";

import { PapeisView } from "@/components/usuarios/papeis-view";

// /usuarios/papeis — papéis de sistema (somente leitura) e personalizados (só o proprietário edita).
export default function PapeisPage() {
  return <PapeisView />;
}
