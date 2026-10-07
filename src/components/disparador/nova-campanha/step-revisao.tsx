"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { TEMPLATE_MODE_LABELS, type CampaignProvider } from "@/lib/disparador/campaign-validation";
import type { ForecastResult } from "@/lib/disparador/dispatch-forecast";
import type { VariableSource } from "@/lib/disparador/preview-message";
import type { ImportColumnMap } from "@/lib/disparador/import-mapping";
import { formatDateLabel } from "./date-time-field";
import { ForecastSummary } from "./forecast-summary";
import { scheduleIso, type WizardForm } from "./wizard-rules";

export type ServerCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; status: "agendado" | "rascunho" }
  | { state: "error"; error: string };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground sm:text-right">{children}</dd>
    </div>
  );
}

function describeSource(entry: VariableSource, columnMap: ImportColumnMap): string {
  switch (entry.type) {
    case "contact_field":
      return entry.field === "name" ? "nome" : entry.field === "phone" ? "telefone" : entry.field === "cpf" ? "CPF" : "empresa";
    case "csv_var": {
      const col = columnMap[(["var1", "var2", "var3"] as const)[entry.index]];
      return `VAR${entry.index + 1}${col ? ` (${col})` : ""}`;
    }
    case "utm_link":
      return "link UTM";
    default:
      return `fixo “${entry.value}”`;
  }
}

function countLabel(form: WizardForm, provider: CampaignProvider | null): string {
  const n = form.mensagens.length;
  if (provider === "meta") return `${n} template${n === 1 ? "" : "s"}`;
  if (form.templateMode === "sequencia" && n > 1) return `sequência de ${n} partes`;
  return form.templateMode === "sequencia" ? `${n} mensagem` : `${n} variaç${n === 1 ? "ão" : "ões"}`;
}

export function StepRevisao({
  form,
  provider,
  channelNames,
  audienceLabel,
  audienceCount,
  forecast,
  forecastUnavailableReason,
  columnMap,
  errors,
  serverCheck,
}: {
  form: WizardForm;
  provider: CampaignProvider | null;
  channelNames: string[];
  audienceLabel: string;
  audienceCount: number | null;
  forecast: ForecastResult | null;
  forecastUnavailableReason?: string;
  columnMap: ImportColumnMap;
  errors: string[];
  serverCheck: ServerCheck;
}) {
  const endTarget = form.startMode === "agendar" ? scheduleIso(form.endDate, form.endTime) : null;
  return (
    <div className="space-y-4">
      {errors.length > 0 ? (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-600 dark:text-red-400">
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Corrija antes de salvar:
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p
          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-400"
          aria-live="polite"
        >
          {serverCheck.state === "checking" ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Conferindo no servidor…
            </>
          ) : serverCheck.state === "error" ? (
            <span className="text-red-600 dark:text-red-400">Servidor recusou: {serverCheck.error}</span>
          ) : (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Tudo certo
              {serverCheck.state === "ok" && " — conferido também no servidor"}.
            </>
          )}
        </p>
      )}

      <dl className="space-y-2 rounded-lg border border-border bg-muted/20 p-4 text-sm">
        <Row label="Nome">{form.nome || "—"}</Row>
        <Row label="Canal">
          {provider === "meta" ? "Oficial (Meta)" : provider === "waha" ? "WAHA" : "—"} · {channelNames.join(", ") || "—"}
        </Row>
        <Row label="Público real">
          {audienceCount != null ? `${audienceCount.toLocaleString("pt-BR")} contatos · ` : ""}
          {audienceLabel}
        </Row>
        <Row label="Início">
          {form.startMode === "agendar"
            ? `Agendado: ${formatDateLabel(form.startDate)} às ${form.startTime}`
            : "Manual (clique em Iniciar na lista)"}
        </Row>
        <Row label="Janela">
          Dias úteis, {form.startTime}–{form.endTime}
          {form.startMode === "agendar" && ` · data final ${formatDateLabel(form.endDate)} ${form.endTime}`}
        </Row>
        <Row label="Modo de disparo">
          {form.dispatchMode === "segmentado"
            ? `Segmentado: ${form.batchPercent}% da base a cada ${form.pauseMinutes} min`
            : form.dispatchMode === "imediato"
              ? "Imediato"
              : "—"}
        </Row>
        <Row label="Modo de templates">
          {TEMPLATE_MODE_LABELS[form.templateMode]} · {countLabel(form, provider)}
        </Row>
        {provider === "meta" &&
          form.mensagens.map((m, i) => (
            <Row key={i} label={form.mensagens.length > 1 ? `Template ${i + 1}` : "Template"}>
              {m.template_name} ({m.template_language ?? "pt_BR"})
              {(m.template_variable_map ?? []).length > 0 && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {(m.template_variable_map ?? []).map((e, idx) => `{{${idx + 1}}} = ${describeSource(e, columnMap)}`).join(" · ")}
                </span>
              )}
            </Row>
          ))}
        <Row label="Webchat ao responder">{form.webchat.webchat_enabled ? "Ativado" : "Desativado"}</Row>
      </dl>

      <ForecastSummary forecast={forecast} unavailableReason={forecastUnavailableReason} endTarget={endTarget} />
    </div>
  );
}
