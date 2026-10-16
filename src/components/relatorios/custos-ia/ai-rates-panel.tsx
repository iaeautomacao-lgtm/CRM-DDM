"use client";

import { useId, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState } from "@/components/ddm/states";
import { DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import {
  AI_RATES_PATH,
  RATE_STATUS_LABEL,
  formatUsd,
  rateStatuses,
  todaySP,
  validateRateForm,
  type AiRatesResponse,
  type RateStatus,
} from "@/lib/costs/ai-costs-ui";

const OTHER = "__outro__";

const STATUS_VARIANT: Record<RateStatus, "default" | "secondary" | "outline"> = {
  current: "default",
  previous: "secondary",
  scheduled: "outline",
};

const perMillion = (v: number | null) => (v === null ? "—" : formatUsd(v));

export function AiRatesPanel({
  data,
  loading,
  error,
  onRetry,
  canEdit,
  onSaved,
}: {
  data: AiRatesResponse | undefined;
  loading: boolean;
  error: Error | undefined;
  onRetry: () => void;
  /** settings.account (admin/owner): é a permissão que o PUT exige. */
  canEdit: boolean;
  /** Chamado após gravar uma vigência (revalida tarifas e relatório). */
  onSaved: () => void | Promise<unknown>;
}) {
  const uid = useId();
  const rates = useMemo(() => data?.rates ?? [], [data]);
  const statuses = useMemo(() => rateStatuses(rates), [rates]);
  const skus = data?.skus ?? [];

  const [skuChoice, setSkuChoice] = useState<string>("");
  const [skuCustom, setSkuCustom] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [input, setInput] = useState("");
  const [cached, setCached] = useState("");
  const [output, setOutput] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const today = todaySP();
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const sku = skuChoice === OTHER || (skuChoice === "" && skus.length === 0) ? skuCustom : skuChoice;
  const failed = error !== undefined && data === undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const checked = validateRateForm({ sku, effective_from: effectiveFrom, input, cached, output }, today);
    if (!checked.ok) {
      setFormError(checked.error);
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(AI_RATES_PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checked.body),
      });
      if (res.ok) {
        toast.success("Tarifa salva");
        setInput("");
        setCached("");
        setOutput("");
        await onSaved();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 403) setFormError("Você não tem permissão para alterar tarifas.");
      else if (res.status === 503) setFormError(body.error ?? "Custos de IA indisponíveis: a migration 378 ainda não foi aplicada.");
      else setFormError(body.error ?? "Não foi possível salvar a tarifa.");
    } catch {
      setFormError("Não foi possível conectar ao servidor. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <form onSubmit={submit} className="rounded-card border border-border bg-card p-5" aria-label="Nova vigência de tarifa">
          <h3 className="m-0 text-sm font-semibold text-foreground">Nova vigência</h3>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">
            Valores em USD por 1 milhão de tokens. Uma vigência que já começou não pode ser alterada: para corrigir, crie outra com data posterior.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="space-y-1 lg:col-span-2">
              <label htmlFor={`${uid}-sku`} className="text-xs font-medium text-muted-foreground">
                Modelo
              </label>
              {skus.length > 0 ? (
                <Select value={skuChoice || undefined} onValueChange={(v) => v && setSkuChoice(v)}>
                  <SelectTrigger id={`${uid}-sku`} className="w-full">
                    <SelectValue placeholder="Escolha o modelo">{(v: string) => (v === OTHER ? "Outro…" : v)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {skus.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                    <SelectItem value={OTHER}>Outro…</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {skuChoice === OTHER || skus.length === 0 ? (
                <Input
                  id={skus.length === 0 ? `${uid}-sku` : undefined}
                  aria-label="Modelo (provedor:modelo)"
                  placeholder="openai:gpt-4o-mini"
                  value={skuCustom}
                  onChange={(e) => setSkuCustom(e.target.value)}
                  autoComplete="off"
                />
              ) : null}
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-data`} className="text-xs font-medium text-muted-foreground">
                Vigência a partir de
              </label>
              <Input id={`${uid}-data`} type="date" min={firstOfMonth} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-in`} className="text-xs font-medium text-muted-foreground">
                Entrada
              </label>
              <Input id={`${uid}-in`} inputMode="decimal" placeholder="0,15" value={input} onChange={(e) => setInput(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-cache`} className="text-xs font-medium text-muted-foreground">
                Entrada em cache <span className="font-normal">(opcional)</span>
              </label>
              <Input id={`${uid}-cache`} inputMode="decimal" placeholder="0,075" value={cached} onChange={(e) => setCached(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-out`} className="text-xs font-medium text-muted-foreground">
                Saída
              </label>
              <Input id={`${uid}-out`} inputMode="decimal" placeholder="0,60" value={output} onChange={(e) => setOutput(e.target.value)} />
            </div>
          </div>
          {formError ? (
            <p role="alert" className="m-0 mt-3 text-[12.5px] font-medium text-danger">
              {formError}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
              Adicionar vigência
            </Button>
          </div>
        </form>
      ) : (
        <p className="m-0 text-[12.5px] text-muted-foreground">Só administradores e proprietários da organização alteram tarifas.</p>
      )}

      {failed ? (
        <ErrorState title="Não foi possível carregar as tarifas" onRetry={onRetry} />
      ) : (
        <TableCard title="Tarifas por vigência" hint="USD por 1 milhão de tokens. A tarifa usada em cada chamada é a vigente no dia dela.">
          {!loading && rates.length === 0 ? (
            <EmptyState title="Nenhuma tarifa cadastrada." hint="Sem tarifa, as chamadas aparecem como “sem tarifa” no relatório (nunca como zero)." />
          ) : (
            <DenseTable minWidth={720}>
              <thead>
                <tr>
                  <Th>Modelo</Th>
                  <Th>Vigência desde</Th>
                  <Th align="right">Entrada</Th>
                  <Th align="right">Em cache</Th>
                  <Th align="right">Saída</Th>
                  <Th>Situação</Th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r, i) => (
                  <Tr key={`${r.sku}|${r.effective_from}`} interactive={false}>
                    <Td className="font-medium text-foreground">{r.sku}</Td>
                    <Td>{r.effective_from.split("-").reverse().join("/")}</Td>
                    <Td align="right">{perMillion(r.input_per_million)}</Td>
                    <Td align="right">{perMillion(r.cached_input_per_million)}</Td>
                    <Td align="right">{perMillion(r.output_per_million)}</Td>
                    <Td>
                      <Badge variant={STATUS_VARIANT[statuses[i]]}>{RATE_STATUS_LABEL[statuses[i]]}</Badge>
                    </Td>
                  </Tr>
                ))}
                {loading && !data
                  ? Array.from({ length: 3 }).map((_, i) => (
                      <tr key={i} aria-hidden="true">
                        <td colSpan={6} className="border-b border-border px-5 py-3.5">
                          <div className="h-4 w-full animate-pulse rounded bg-muted" />
                        </td>
                      </tr>
                    ))
                  : null}
              </tbody>
            </DenseTable>
          )}
        </TableCard>
      )}
    </div>
  );
}
