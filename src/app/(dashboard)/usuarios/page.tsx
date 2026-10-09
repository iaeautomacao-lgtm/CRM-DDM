"use client";

import { UsuariosView } from "@/components/usuarios/usuarios-view";

// /usuarios — lista de usuários no visual do redesenho DDM (tabela + gaveta).
// /membros redireciona para cá (membros/page.tsx).
export default function UsuariosPage() {
  return <UsuariosView />;
}
