import { apiFetch } from "@/lib/api-fetch";
"use client";

import { Globe, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

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
    <div className="flex h-[calc(100vh-4rem)] flex-col space-y-4 p-4 lg:p-6 overflow-hidden">
      {/* Premium Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-border/40 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Globe className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Extrator de Leads
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Extraia contatos diretamente da web e envie para o seu CRM utilizando o fluxo do n8n.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            className="gap-2 text-xs"
          >
            <RefreshCw className="h-3 w-3" />
            Recarregar Extrator
          </Button>
        </div>
      </div>

      {/* Glassmorphic Iframe Container */}
      <div className="relative flex-1 w-full overflow-hidden rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm shadow-xl">
        <iframe
          key={iframeKey}
          src={leadExtractorUrl}
          className="absolute inset-0 h-full w-full border-0 rounded-xl bg-background"
          allow="clipboard-write; camera; microphone"
          title="Extrator de Leads Lovable"
        />
      </div>
    </div>
  );
}
