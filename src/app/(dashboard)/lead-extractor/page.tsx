"use client";

import { apiFetch } from "@/lib/api-fetch";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageBody } from "@/components/ddm/page-toolbar";

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
      <div className="flex flex-wrap items-end gap-3 pt-1">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
          <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Extrator de leads</h2>
          <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
            Extraia contatos diretamente da web e envie para o seu CRM utilizando o fluxo do n8n.
          </p>
        </div>
        <Button variant="outline" onClick={handleRefresh}>
          <RefreshCw className="size-3.5" />
          Recarregar extrator
        </Button>
      </div>

      <div className="relative min-h-0 w-full flex-1 animate-ddm-fade overflow-hidden rounded-[10px] border border-border bg-card">
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
