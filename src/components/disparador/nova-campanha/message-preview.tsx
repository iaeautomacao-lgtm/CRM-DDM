"use client";

import { cn } from "@/lib/utils";
import {
  previewCampaignMessage,
  synthesizeWahaVariableMap,
  type PreviewContact,
} from "@/lib/disparador/preview-message";
import type { ImportColumnMap } from "@/lib/disparador/import-mapping";
import type { WizardMessage } from "./wizard-rules";

// Bolha de prévia de uma mensagem para um contato. A bifurcação Meta × WAHA
// segue o canal da campanha (previewCampaignMessage espelha o
// startCampaign): Meta = template aprovado (a Meta substitui {{n}}); WAHA =
// texto com as variáveis trocadas no código.

export const SAMPLE_PREVIEW_CONTACT: PreviewContact = {
  name: "Maria Silva",
  phone: "5511999990000",
  company: "Empresa Exemplo",
  cpf: "12345678901",
};

export function MessagePreview({
  msg,
  rotulo,
  contact,
  isMeta,
  columnMap,
}: {
  msg: WizardMessage;
  rotulo: string;
  contact: PreviewContact;
  isMeta: boolean;
  columnMap: ImportColumnMap;
}) {
  if (msg.tipo === "ia") {
    return (
      <div className="space-y-1">
        <p className="text-xs font-semibold text-muted-foreground">{rotulo} · IA</p>
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs italic text-muted-foreground">
          Texto gerado pela IA no envio, a partir do prompt: “{msg.prompt ?? ""}”
        </p>
      </div>
    );
  }
  if (msg.tipo === "audio") {
    return (
      <div className="space-y-1">
        <p className="text-xs font-semibold text-muted-foreground">{rotulo} · Áudio</p>
        <p className="break-all rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {msg.url || "(sem arquivo de áudio)"}
        </p>
      </div>
    );
  }

  const effective = isMeta ? msg : synthesizeWahaVariableMap(msg, columnMap);
  const preview = previewCampaignMessage(effective, contact, { isMetaChannel: isMeta });
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-muted-foreground">
        {rotulo}
        {msg.tipo === "imagem" && " · Imagem"}
        {msg.template_name && ` · template ${msg.template_name}`}
      </p>
      {msg.tipo === "imagem" && <p className="break-all text-xs text-muted-foreground">Imagem: {msg.url || "(sem imagem)"}</p>}
      {preview.segments.length > 0 && (
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs text-foreground",
            preview.willSkip ? "bg-danger-soft" : "bg-success-soft"
          )}
        >
          {preview.segments.map((seg, si) =>
            seg.kind === "text" ? (
              <span key={si}>{seg.text}</span>
            ) : seg.empty ? (
              <span key={si} className="rounded bg-danger-soft px-1 font-medium text-danger">
                {seg.token} (vazio)
              </span>
            ) : seg.pending ? (
              <span key={si} className="italic text-muted-foreground">
                [{seg.label}]
              </span>
            ) : (
              <span key={si} className="rounded bg-primary/10 px-0.5">
                {seg.value}
              </span>
            )
          )}
        </div>
      )}
      {preview.willSkip && (
        <p className="text-xs font-medium text-danger">
          Este contato não será enviado: {preview.emptyVars.map((n) => `{{${n}}}`).join(", ")} sem valor.
        </p>
      )}
    </div>
  );
}
