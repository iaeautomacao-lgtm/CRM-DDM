"use client";

import { useParams } from "next/navigation";
import { ContactDetailView } from "@/components/contacts/contact-detail-view";

// /contacts/[id] — página completa do contato (redesenho DDM). Usa o mesmo
// ContactDetailView da gaveta da lista (mesmos dados e ações), só que no
// layout de página; a gaveta tem o atalho "Abrir página completa".
export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ContactDetailView
      key={id}
      variant="page"
      open
      onOpenChange={() => {}}
      contactId={id ?? null}
      onUpdated={() => {}}
    />
  );
}
