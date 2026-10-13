"use client";

import { PageBody } from "@/components/ddm/page-toolbar";
import { TabulacoesManager } from "@/components/tabulacoes/tabulacoes-manager";

// /tabulacoes — só tabulações (tags kind='outcome'). As tags de contato e os campos personalizados
// vivem em Contatos (abas Tags e Campos personalizados).
export default function TabulacoesPage() {
  return (
    <PageBody className="gap-8">
      <TabulacoesManager />
    </PageBody>
  );
}
