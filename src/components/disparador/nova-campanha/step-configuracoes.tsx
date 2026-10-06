"use client";

import { CalendarClock, Hand, Layers, Rocket, Shuffle, Repeat, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { CampaignWebchatSettings } from "@/components/disparador/campaign-webchat-settings";
import type { CampaignProvider, TemplateMode } from "@/lib/disparador/campaign-validation";
import type { ForecastResult } from "@/lib/disparador/dispatch-forecast";
import { DatePickerField, TimeSelectField, formatDateLabel } from "./date-time-field";
import { ForecastSummary } from "./forecast-summary";
import { scheduleIso, type DispatchMode, type StartMode, type WizardForm } from "./wizard-rules";

function OptionCard({
  selected,
  onClick,
  icon: Icon,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  icon: typeof Rocket;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors",
        selected ? "border-primary bg-primary/10" : "border-input bg-background hover:bg-muted/50"
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Icon className={cn("h-4 w-4", selected ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}

const TEMPLATE_MODE_CARDS: Array<{ key: TemplateMode; icon: typeof Rocket; title: string; meta: string; waha: string }> = [
  {
    key: "sequencia",
    icon: FileText,
    title: "Padrão",
    meta: "Um único template para todos os contatos.",
    waha: "Mesma mensagem para todos. Pode ter várias partes (sequência), enviadas em ordem.",
  },
  {
    key: "rotacao",
    icon: Repeat,
    title: "Rotação",
    meta: "2 ou mais templates; cada contato recebe 1, alternando na ordem.",
    waha: "2 ou mais variações; cada contato recebe 1, alternando na ordem.",
  },
  {
    key: "aleatorio",
    icon: Shuffle,
    title: "Aleatório",
    meta: "2 ou mais templates; cada contato recebe 1, sorteado.",
    waha: "2 ou mais variações; cada contato recebe 1, sorteada.",
  },
];

export function StepConfiguracoes({
  form,
  update,
  provider,
  todayBrasilia,
  knownContacts,
  forecast,
  forecastUnavailableReason,
  errorsVisible,
}: {
  form: WizardForm;
  update: (patch: Partial<WizardForm>) => void;
  provider: CampaignProvider | null;
  todayBrasilia: string;
  knownContacts: number | null;
  forecast: ForecastResult | null;
  forecastUnavailableReason?: string;
  errorsVisible: boolean;
}) {
  const invalidWindow = errorsVisible && form.endTime <= form.startTime;
  const perRound =
    knownContacts != null && knownContacts > 0 ? Math.max(1, Math.ceil((knownContacts * form.batchPercent) / 100)) : null;
  const endTarget = form.startMode === "agendar" ? scheduleIso(form.endDate, form.endTime) : null;

  const setStartMode = (mode: StartMode) => update({ startMode: mode });
  const setDispatch = (mode: DispatchMode) => update({ dispatchMode: mode });

  return (
    <div className="space-y-6">
      {/* Agendamento */}
      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Agendamento</h4>
          <p className="text-xs text-muted-foreground">Horário de Brasília. O envio acontece só em dia útil (segunda a sexta).</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Quando começar">
          <OptionCard
            selected={form.startMode === "agendar"}
            onClick={() => setStartMode("agendar")}
            icon={CalendarClock}
            title="Agendar"
            description="Começa sozinha na data e hora inicial."
          />
          <OptionCard
            selected={form.startMode === "manual"}
            onClick={() => setStartMode("manual")}
            icon={Hand}
            title="Iniciar manualmente"
            description="Fica como rascunho até você clicar em Iniciar."
          />
        </div>

        {form.startMode === "agendar" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
              <DatePickerField
                id="nc-data-inicial"
                label="Data inicial"
                value={form.startDate}
                min={todayBrasilia}
                onChange={(d) => update({ startDate: d, endDate: form.endDate < d ? d : form.endDate })}
              />
              <TimeSelectField id="nc-hora-inicial" label="Hora inicial" value={form.startTime} onChange={(t) => update({ startTime: t })} />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
              <DatePickerField
                id="nc-data-final"
                label="Data final"
                value={form.endDate}
                min={form.startDate || todayBrasilia}
                onChange={(d) => update({ endDate: d })}
              />
              <TimeSelectField
                id="nc-hora-final"
                label="Hora final"
                value={form.endTime}
                onChange={(t) => update({ endTime: t })}
                invalid={invalidWindow}
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
            <TimeSelectField id="nc-hora-inicial" label="Hora inicial" value={form.startTime} onChange={(t) => update({ startTime: t })} />
            <TimeSelectField
              id="nc-hora-final"
              label="Hora final"
              value={form.endTime}
              onChange={(t) => update({ endTime: t })}
              invalid={invalidWindow}
            />
          </div>
        )}

        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-foreground">
          {form.endTime > form.startTime ? (
            <>
              Envio todo dia útil das <strong>{form.startTime}</strong> às <strong>{form.endTime}</strong>
              {form.startMode === "agendar" ? (
                <>
                  , a partir de <strong>{formatDateLabel(form.startDate)}</strong>. Se a base não terminar até{" "}
                  {formatDateLabel(form.endDate)} às {form.endTime}, continua no próximo dia útil, no mesmo horário.
                </>
              ) : (
                <>, a partir do clique em Iniciar. Se a base não terminar no dia, continua no próximo dia útil.</>
              )}
            </>
          ) : (
            <span className="text-red-600 dark:text-red-400">A hora final precisa ser depois da hora inicial.</span>
          )}
        </p>
      </section>

      {/* Modo de disparo */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Modo de disparo</h4>
        {form.dispatchMode === null && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Esta campanha usava um modo antigo (Balanceado, Cauteloso ou Personalizado). Escolha Imediato ou Segmentado.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Modo de disparo">
          <OptionCard
            selected={form.dispatchMode === "imediato"}
            onClick={() => setDispatch("imediato")}
            icon={Rocket}
            title="Imediato"
            description="Envia tudo o mais rápido que o motor permite, dentro do horário."
          />
          <OptionCard
            selected={form.dispatchMode === "segmentado"}
            onClick={() => setDispatch("segmentado")}
            icon={Layers}
            title="Segmentado"
            description="Envia uma parte da base a cada intervalo."
          />
        </div>
        {form.dispatchMode === "segmentado" && (
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Enviar</span>
              <label className="sr-only" htmlFor="nc-percent">
                Percentual da base por rodada
              </label>
              <input
                id="nc-percent"
                type="number"
                min={1}
                max={50}
                value={form.batchPercent}
                onChange={(e) => update({ batchPercent: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                className="h-9 w-20 rounded-md border border-input bg-background px-2 text-center"
              />
              <span>% da base a cada</span>
              <label className="sr-only" htmlFor="nc-pausa">
                Intervalo entre rodadas, em minutos
              </label>
              <input
                id="nc-pausa"
                type="number"
                min={1}
                max={1440}
                value={form.pauseMinutes}
                onChange={(e) => update({ pauseMinutes: Math.min(1440, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                className="h-9 w-20 rounded-md border border-input bg-background px-2 text-center"
              />
              <span>min</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {perRound
                ? `${perRound.toLocaleString("pt-BR")} contatos por rodada (de ${knownContacts!.toLocaleString("pt-BR")}), ~${Math.ceil(
                    knownContacts! / perRound
                  )} rodadas. O intervalo só conta dentro do horário de envio — não acumula rodadas para a manhã seguinte.`
                : "De 1% a 50% da base por rodada; intervalo de 1 a 1.440 min. O tamanho exato da rodada é calculado no início, com a base real."}
            </p>
          </div>
        )}
        <ForecastSummary forecast={forecast} unavailableReason={forecastUnavailableReason} endTarget={endTarget} />
      </section>

      {/* Modo de templates */}
      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Modo de templates</h4>
          <p className="text-xs text-muted-foreground">
            Define quantos templates (ou mensagens) você escolhe no passo Conteúdo e como cada contato recebe.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Modo de templates">
          {TEMPLATE_MODE_CARDS.map((card) => (
            <OptionCard
              key={card.key}
              selected={form.templateMode === card.key}
              onClick={() => update({ templateMode: card.key })}
              icon={card.icon}
              title={card.title}
              description={provider === "waha" ? card.waha : card.meta}
            />
          ))}
        </div>
      </section>

      {/* Webchat de campanha (migration 127) */}
      <CampaignWebchatSettings value={form.webchat} onChange={(webchat) => update({ webchat })} />
    </div>
  );
}
