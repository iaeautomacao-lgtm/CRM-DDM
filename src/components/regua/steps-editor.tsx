"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/ddm/status-chip";
import { BillingApiError, billingFetch, errorMessage } from "@/lib/billing/client-api";
import {
  VARIABLE_OPTIONS,
  describeOffset,
  formatOffset,
  maxPlaceholder,
  variableKey,
  type Ruler,
  type RulerStep,
  type VariableSource,
} from "@/lib/billing/client-types";

export interface TemplateOption {
  id: string;
  name: string;
  body_text: string | null;
}

interface StepDraft {
  /** Chave estável só da tela (React). */
  key: string;
  id?: string;
  kind: "offset" | "status";
  offset: string;
  status_trigger: string;
  template_id: string;
  message_text: string;
  variable_map: VariableSource[];
  active: boolean;
}

let draftSeq = 0;
const nextKey = () => `d${++draftSeq}`;

function toDraft(s: RulerStep): StepDraft {
  return {
    key: s.id,
    id: s.id,
    kind: s.kind,
    offset: s.offset_days == null ? "" : String(s.offset_days),
    status_trigger: s.status_trigger ?? "",
    template_id: s.template_id ?? "",
    message_text: s.message_text ?? "",
    variable_map: s.variable_map ?? [],
    active: s.active,
  };
}

/** Rascunho sem a chave só da tela, para comparar com o salvo. */
function comparable(d: StepDraft) {
  return { id: d.id, kind: d.kind, offset: d.offset, status_trigger: d.status_trigger, template_id: d.template_id, message_text: d.message_text, variable_map: d.variable_map, active: d.active };
}

function emptyDraft(): StepDraft {
  return { key: nextKey(), kind: "offset", offset: "0", status_trigger: "", template_id: "", message_text: "", variable_map: [], active: true };
}

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Editor das etapas da régua (PUT /api/billing/rulers/:id/steps substitui a lista inteira). O CONTEÚDO (quando, qual template ou
 * texto, quais variáveis) é da operação: aqui só se monta a estrutura. O canal define o caminho: Meta = template aprovado,
 * WAHA = texto livre com {{n}} — os dois nunca se misturam na mesma validação do servidor.
 */
export function StepsEditor({
  ruler,
  steps,
  templates,
  provider,
  canManage,
  onSaved,
}: {
  ruler: Ruler;
  steps: RulerStep[];
  templates: TemplateOption[];
  provider: "meta" | "waha" | null;
  canManage: boolean;
  onSaved: (steps: RulerStep[]) => void;
}) {
  const [drafts, setDrafts] = useState<StepDraft[]>(() => steps.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    setDrafts(steps.map(toDraft));
    setProblems([]);
  }, [steps]);

  const templateById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  const dirty = useMemo(() => JSON.stringify(drafts.map(comparable)) !== JSON.stringify(steps.map(toDraft).map(comparable)), [drafts, steps]);

  const update = (key: string, patch: Partial<StepDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  async function save() {
    setSaving(true);
    setProblems([]);
    try {
      const payload = drafts.map((d) => ({
        ...(d.id ? { id: d.id } : {}),
        kind: d.kind,
        offset_days: d.kind === "offset" ? Number(d.offset) : null,
        status_trigger: d.kind === "status" ? d.status_trigger.trim() : null,
        template_id: d.template_id || null,
        message_text: d.message_text.trim() ? d.message_text : null,
        variable_map: d.variable_map,
        active: d.active,
      }));
      const res = await billingFetch<{ steps: RulerStep[] }>(`/rulers/${ruler.id}/steps`, { method: "PUT", body: { steps: payload } });
      toast.success("Etapas salvas");
      onSaved(res.steps);
    } catch (err) {
      if (err instanceof BillingApiError && err.problems.length > 0) setProblems(err.problems);
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const showTemplate = provider !== "waha";
  const showText = provider !== "meta";

  return (
    <div className="flex flex-col gap-3">
      {provider === null && (
        <p className="rounded-md bg-surface-3 px-3 py-2 text-xs text-foreground-2">
          Defina o canal na aba Configuração: canal Meta usa template aprovado; canal WAHA usa texto livre.
        </p>
      )}

      {drafts.length === 0 && (
        <p className="rounded-[10px] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Esta régua ainda não tem etapas.
        </p>
      )}

      {drafts.map((d, i) => {
        const tpl = d.template_id ? templateById.get(d.template_id) : undefined;
        const needed = Math.max(showTemplate ? maxPlaceholder(tpl?.body_text) : 0, showText ? maxPlaceholder(d.message_text) : 0);
        const offsetNum = Number(d.offset);
        return (
          <section key={d.key} className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4">
            <header className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">
                {d.kind === "offset" && d.offset !== "" && Number.isInteger(offsetNum)
                  ? `${formatOffset(offsetNum)} · ${describeOffset(offsetNum)}`
                  : `Etapa ${i + 1}`}
              </span>
              {!d.active && <StatusChip tone="mute">Inativa</StatusChip>}
              <span className="flex-1" />
              <label className="flex items-center gap-2 text-xs text-foreground-2">
                Ativa
                <Switch
                  checked={d.active}
                  disabled={!canManage}
                  onCheckedChange={(v) => update(d.key, { active: v })}
                  aria-label={`Etapa ${i + 1} ativa`}
                />
              </label>
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remover etapa ${i + 1}`}
                  onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </header>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-foreground-2">
                Gatilho
                <select
                  className={SELECT_CLASS}
                  value={d.kind}
                  disabled={!canManage}
                  onChange={(e) => update(d.key, { kind: e.target.value as "offset" | "status" })}
                >
                  <option value="offset">Dias em relação ao vencimento</option>
                  <option value="status">Mudança de status da dívida</option>
                </select>
              </label>
              {d.kind === "offset" ? (
                <label className="flex flex-col gap-1 text-xs text-foreground-2">
                  Dias (negativo = antes do vencimento)
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={-60}
                    max={365}
                    value={d.offset}
                    disabled={!canManage}
                    onChange={(e) => update(d.key, { offset: e.target.value })}
                  />
                </label>
              ) : (
                <label className="flex flex-col gap-1 text-xs text-foreground-2">
                  Status que dispara a etapa
                  <Input
                    value={d.status_trigger}
                    maxLength={60}
                    disabled={!canManage}
                    onChange={(e) => update(d.key, { status_trigger: e.target.value })}
                  />
                </label>
              )}
            </div>

            {showTemplate && (
              <label className="flex flex-col gap-1 text-xs text-foreground-2">
                Template aprovado (canal Meta)
                <select
                  className={SELECT_CLASS}
                  value={d.template_id}
                  disabled={!canManage}
                  onChange={(e) => update(d.key, { template_id: e.target.value })}
                >
                  <option value="">Nenhum</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {tpl?.body_text && (
                  <span className="whitespace-pre-wrap rounded-md bg-surface-3 px-2.5 py-2 text-xs text-foreground-2">{tpl.body_text}</span>
                )}
              </label>
            )}

            {showText && (
              <label className="flex flex-col gap-1 text-xs text-foreground-2">
                Texto da mensagem (canal WAHA; use {"{{1}}"}, {"{{2}}"}…)
                <Textarea
                  rows={4}
                  maxLength={4096}
                  value={d.message_text}
                  disabled={!canManage}
                  onChange={(e) => update(d.key, { message_text: e.target.value })}
                />
              </label>
            )}

            {needed > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs font-medium text-foreground-2">De onde vem cada variável</legend>
                {Array.from({ length: needed }).map((_, idx) => {
                  const src = d.variable_map[idx];
                  const setSrc = (next: VariableSource) =>
                    update(d.key, {
                      variable_map: Array.from({ length: Math.max(needed, d.variable_map.length) }, (__, j) =>
                        j === idx ? next : (d.variable_map[j] ?? VARIABLE_OPTIONS[0].source),
                      ),
                    });
                  return (
                    <div key={idx} className="flex flex-wrap items-center gap-2">
                      <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{`{{${idx + 1}}}`}</span>
                      <select
                        className={`${SELECT_CLASS} max-w-[260px]`}
                        aria-label={`Fonte da variável ${idx + 1}`}
                        value={variableKey(src)}
                        disabled={!canManage}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "static") return setSrc({ type: "static", value: src?.type === "static" ? src.value : "" });
                          const opt = VARIABLE_OPTIONS.find((o) => o.value === v);
                          if (opt) setSrc(opt.source);
                        }}
                      >
                        <option value="" disabled>
                          Escolha…
                        </option>
                        {VARIABLE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                        <option value="static">Texto fixo</option>
                      </select>
                      {src?.type === "static" && (
                        <Input
                          className="max-w-[260px]"
                          aria-label={`Texto fixo da variável ${idx + 1}`}
                          value={src.value}
                          disabled={!canManage}
                          onChange={(e) => setSrc({ type: "static", value: e.target.value })}
                        />
                      )}
                    </div>
                  );
                })}
              </fieldset>
            )}
          </section>
        );
      })}

      {problems.length > 0 && (
        <ul role="alert" className="list-disc rounded-md bg-danger-soft py-2 pl-7 pr-3 text-xs text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setDrafts((prev) => [...prev, emptyDraft()])}>
            <Plus className="size-4" />
            Adicionar etapa
          </Button>
          <span className="flex-1" />
          <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Salvando…" : "Salvar etapas"}
          </Button>
        </div>
      )}
    </div>
  );
}
