"use client";

import { apiFetch } from "@/lib/api-fetch";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageBody } from "@/components/ddm/page-toolbar";
import { PageHeader } from "@/components/ddm/page-header";

export default function LeadExtractorPage() {
  const [iframeKey, setIframeKey] = useState(0);
  const [leadExtractorUrl, setLeadExtractorUrl] = useState("https://grupoddmlead.lovable.app/");

  useEffect(() => {
    apiFetch("/api/whatsapp/external-urls")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.leadExtractorUrl) {
          setLeadExtractorUrl(data.leadExtractorUrl);
        }
      })
      .catch((err) => console.warn("Failed to fetch lead extractor URL:", err));
  }, []);

  const handleRefresh = () => {
    setIframeKey((prev) => prev + 1);
  };

  return (
    <PageBody className="h-[calc(100vh-8rem)] min-h-[480px] pb-0 md:pb-0">
      <PageHeader
        actions={
          <Button variant="outline" onClick={handleRefresh}>
            <RefreshCw className="size-3.5" />
            Recarregar extrator
          </Button>
        }
      >
        Extraia contatos diretamente da web e envie para o seu CRM utilizando o fluxo do n8n.
      </PageHeader>

      <div className="relative min-h-0 w-full flex-1 animate-ddm-fade overflow-hidden rounded-card border border-border bg-card">
        <iframe
          key={iframeKey}
          src={leadExtractorUrl}
          className="absolute inset-0 h-full w-full border-0 bg-background"
          allow="clipboard-write; camera; microphone"
          title="Extrator de Leads Lovable"
        />
      </div>
    </PageBody>
  );
}
