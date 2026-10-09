"use client";

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { Switch } from "@/components/ui/switch";

// Bloco "Ao responder, enviar para o Webchat" do formulário de campanha
// (campaigns.webchat_*, migration 127). Quando ligado, a primeira resposta
// do cliente a esta campanha recebe no WhatsApp o convite para o Webchat,
// e o fluxo escolhido atende lá — com {{vars.campanha_nome}},
// {{vars.template_nome}} e {{vars.mensagem_campanha}} já preenchidas.

export interface CampaignWebchatValue {
  webchat_enabled: boolean;
  webchat_flow_id: string | null;
  webchat_message: string;
  webchat_button_text: string;
}

export const EMPTY_CAMPAIGN_WEBCHAT: CampaignWebchatValue = {
  webchat_enabled: false,
  webchat_flow_id: null,
  webchat_message: "",
  webchat_button_text: "",
};

/** Mesmo limite do botão de URL da Meta (cta_url display_text). */
const BUTTON_MAX = 20;

export function CampaignWebchatSettings({
  value,
  onChange,
}: {
  value: CampaignWebchatValue;
  onChange: (next: CampaignWebchatValue) => void;
}) {
  const [flows, setFlows] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  // Só fluxos ativos: um fluxo em rascunho não roda no Webchat
  // (startWebchatRun recusa) e a conversa ficaria sem resposta.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/flows");
        if (!res.ok) return;
        const json = (await res.json()) as {
          flows?: Array<{ id: string; name: string; status: string }>;
        };
        if (!cancelled) {
          setFlows(
            (json.flows ?? [])
              .filter((f) => f.status === "active")
              .map((f) => ({ id: f.id, name: f.name }))
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (patch: Partial<CampaignWebchatValue>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Globe className="h-3.5 w-3.5 text-primary-text" />
            Ao responder, enviar para o Webchat
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Na primeira resposta, o cliente recebe um botão (Meta) ou link (WAHA) para
            continuar no Webchat. O fluxo receptivo da linha não começa para essa resposta.
          </p>
        </div>
        <Switch
          checked={value.webchat_enabled}
          onCheckedChange={(checked) => set({ webchat_enabled: checked })}
          aria-label="Enviar respostas para o Webchat"
        />
      </div>

      {value.webchat_enabled && (
        <div className="space-y-2 pt-1">
          <div className="space-y-1">
            <label htmlFor="campaign-webchat-flow" className="text-xs font-medium text-muted-foreground">
              Fluxo que atende no Webchat
            </label>
            <select
              id="campaign-webchat-flow"
              value={value.webchat_flow_id ?? ""}
              onChange={(e) => set({ webchat_flow_id: e.target.value || null })}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">{loading ? "Carregando fluxos…" : "Fluxo padrão do Webchat (/canais)"}</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
              No fluxo, use {"{{vars.campanha_nome}}"}, {"{{vars.template_nome}}"} e{" "}
              {"{{vars.mensagem_campanha}}"} para dar o contexto à IA.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="campaign-webchat-message" className="text-xs font-medium text-muted-foreground">
              Mensagem do convite (opcional)
            </label>
            <textarea
              id="campaign-webchat-message"
              value={value.webchat_message}
              onChange={(e) => set({ webchat_message: e.target.value })}
              rows={2}
              placeholder="Para continuarmos seu atendimento, toque no botão abaixo."
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="campaign-webchat-button" className="text-xs font-medium text-muted-foreground">
              Texto do botão ({value.webchat_button_text.length}/{BUTTON_MAX})
            </label>
            <input
              id="campaign-webchat-button"
              value={value.webchat_button_text}
              maxLength={BUTTON_MAX}
              onChange={(e) => set({ webchat_button_text: e.target.value })}
              placeholder="Abrir chat"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {!value.webchat_flow_id && (
            <p className="text-[10px] text-warning">
              Sem fluxo aqui, vale o fluxo padrão do Webchat em /canais. Se não houver padrão, o convite não é enviado.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Campos enviados no insert/PATCH da campanha (strings vazias viram null). */
export function campaignWebchatPayload(value: CampaignWebchatValue) {
  return {
    webchat_enabled: value.webchat_enabled,
    webchat_flow_id: value.webchat_flow_id,
    webchat_message: value.webchat_message.trim() || null,
    webchat_button_text: value.webchat_button_text.trim() || null,
  };
}
