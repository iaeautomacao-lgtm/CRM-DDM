"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Bot, Download, DollarSign, Loader2, MessageSquare, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { CostRate, MonthlyCostReport } from "@/lib/billing/report"
import { reportTotals } from "@/lib/billing/report"

const CATEGORIES = [
  { value: "BR:marketing", label: "Brasil · Marketing" },
  { value: "BR:utility", label: "Brasil · Utilidade" },
  { value: "BR:authentication", label: "Brasil · Autenticação" },
  { value: "BR:service", label: "Brasil · Serviço" },
]
const monthNow = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",
  }).formatToParts(new Date())
  return (parts.find(x=>x.type==="year")?.value ?? "2026")+"-"+(parts.find(x=>x.type==="month")?.value ?? "01")
}
const currency = (value: number, code: "USD" | "BRL") =>
  new Intl.NumberFormat("pt-BR", {
    style:"currency",currency:code,minimumFractionDigits:2,
    maximumFractionDigits:value>0 && value<0.01 ? 6 : 2,
  }).format(value)
const intFormat = (value: number) => value.toLocaleString("pt-BR")
const emptyRate = { input: "", cached:"", output:"", unit:"" }

export function MonthlyCostsDashboard() {
  const [month,setMonth] = useState(monthNow)
  const [report,setReport] = useState<MonthlyCostReport|null>(null)
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState<string|null>(null)
  const [source,setSource] = useState<"ai"|"meta">("meta")
  const [metaSku,setMetaSku] = useState("BR:marketing")
  const [aiSku,setAiSku] = useState("openai:gpt-4.1")
  const [draft,setDraft] = useState(emptyRate)
  const [saving,setSaving] = useState(false)
  const [notice,setNotice] = useState<string|null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/dashboard/costs?month="+encodeURIComponent(month), {
        credentials:"same-origin",cache:"no-store",signal,
      })
      if (!response.ok) {
        const data = await response.json().catch(()=>({}))
        throw new Error(data.error || "Não foi possível carregar os custos")
      }
      const data = await response.json() as MonthlyCostReport
      if (!signal?.aborted) setReport(data)
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : "Falha ao buscar custos")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  },[month])

  useEffect(()=>{
    const controller = new AbortController()
    void load(controller.signal)
    return ()=>controller.abort()
  },[load])

  const sku = source==="ai" ? aiSku.trim().toLowerCase() : metaSku
  const totals = report ? reportTotals(report) : null

  useEffect(()=>{
    const matching = (report?.rates ?? [])
      .filter(r=>r.source===source && r.sku===sku && r.effective_from<=month+"-01")
      .sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]
    const show = (n: number | null | undefined) => n===null || n===undefined ? "" : String(n)
    setDraft(matching ? {
      input:show(matching.input_per_million),cached:show(matching.cached_input_per_million),
      output:show(matching.output_per_million),unit:show(matching.per_message),
    } : emptyRate)
  },[report,source,sku,month])

  const aiRows = useMemo(()=>report?.ai ?? [],[report])
  const metaRows = useMemo(()=>report?.meta ?? [],[report])
  const coverageMissing = !!totals && (totals.aiUnpriced>0 || totals.metaUnpriced>0)
  const aiUnavailable = !!totals && totals.aiCalls===0
  const metaUnavailable = !!totals && totals.metaMessages===0

  async function saveRate(){
    setNotice(null)
    if (!report || saving) return
    const numeric = (x:string) => x.trim() === "" ? null : Number(x.replace(",","."))
    const body = {
      source, sku, effective_from:month+"-01",
      input_per_million:numeric(draft.input),
      cached_input_per_million:numeric(draft.cached),
      output_per_million:numeric(draft.output),
      per_message:numeric(draft.unit),
    }
    setSaving(true)
    try {
      const response = await fetch("/api/dashboard/costs",{
        method:"PUT",credentials:"same-origin",
        headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
      })
      const data = await response.json().catch(()=>({}))
      if (!response.ok) throw new Error(data.error || "Falha ao salvar tarifa")
      setNotice("Tarifa salva para a competência "+month+". Valores estimados recalculados.")
      await load()
    } catch(err) {
      setNotice(err instanceof Error ? err.message : "Falha ao salvar tarifa")
    } finally {setSaving(false)}
  }

  return (
    <section className="space-y-4" aria-label="Custos da IA e mensagens Meta">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Custos operacionais · IA e Meta
          </h3>
          <p className="text-xs text-muted-foreground">
            Estimativas por consumo registrado e tarifas cadastradas. Não substitui as faturas dos fornecedores.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="cost-month" className="text-xs text-muted-foreground">Competência</Label>
          <Input
            id="cost-month" type="month" value={month} onChange={e=>setMonth(e.target.value)}
            className="h-9 w-40" min="2025-01" max="2100-12"
          />
          <Button asChild variant="outline" size="sm" disabled={loading || !report}>
            <a href={"/api/dashboard/costs?month="+encodeURIComponent(month)+"&format=csv"}
               aria-label={"Exportar custos de "+month+" em CSV"}>
              <Download className="size-4" /> Exportar mês (CSV)
            </a>
          </Button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
          {error} <button onClick={()=>void load()} className="ml-2 text-primary underline">Tentar novamente</button>
        </div>
      ) : loading && !report ? (
        <div className="flex items-center gap-2 rounded-xl border border-border p-5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Carregando custos...
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Bot className="size-4" /> IA · USD</div>
              <p className="mt-2 text-2xl font-semibold">
                {totals && totals.aiCalls>0 && totals.aiUnpriced<totals.aiCalls ? currency(totals.aiUsd,"USD") : "Sem preço"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {intFormat(totals?.aiCalls ?? 0)} chamadas com uso registrado
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><MessageSquare className="size-4" /> Meta · BRL</div>
              <p className="mt-2 text-2xl font-semibold">
                {totals && totals.metaMessages>0 && totals.metaUnpriced<totals.metaMessages ? currency(totals.metaBrl,"BRL") : "Sem preço"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{intFormat(totals?.metaMessages ?? 0)} entregas identificadas</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><DollarSign className="size-4" /> Tokens de IA</div>
              <p className="mt-2 text-xl font-semibold">{intFormat(totals?.inputTokens ?? 0)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Entrada · {intFormat(totals?.outputTokens ?? 0)} saída</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Settings2 className="size-4" /> Cobertura</div>
              <p className="mt-2 text-xl font-semibold">{coverageMissing ? "Parcial" : "A conferir"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {intFormat(totals?.aiUnpriced ?? 0)} chamadas IA e {intFormat(totals?.metaUnpriced ?? 0)} entregas sem precificação
              </p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4">
              <h4 className="text-sm font-semibold">IA por modelo</h4>
              {aiRows.length===0 ? (
                <p className="mt-4 text-xs text-muted-foreground">Ainda não há uso de tokens registrado para esta competência.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {aiRows.map(row=>(
                    <div key={row.sku} className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-2 last:border-b-0">
                      <div>
                        <p className="text-xs font-medium">{row.sku}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {intFormat(row.requests)} chamadas · {intFormat(row.input_tokens)} entrada · {intFormat(row.output_tokens)} saída
                        </p>
                        {row.unpriced>0 && <p className="text-[11px] text-amber-600">{row.unpriced} sem tarifa</p>}
                      </div>
                      <p className="text-xs font-semibold">{currency(row.priced_usd,"USD")}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <h4 className="text-sm font-semibold">Meta por categoria e país</h4>
              {metaRows.length===0 ? (
                <p className="mt-4 text-xs text-muted-foreground">Não há entregas identificadas da Meta nesta competência.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {metaRows.map(row=>(
                    <div key={row.sku} className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-2 last:border-b-0">
                      <div>
                        <p className="text-xs font-medium">{row.sku}</p>
                        <p className="text-[11px] text-muted-foreground">{intFormat(row.delivered)} entregues</p>
                        {row.inferred>0 && <p className="text-[11px] text-muted-foreground">{row.inferred} registros históricos reconstituídos</p>}
                        {row.unpriced>0 && <p className="text-[11px] text-amber-600">{row.unpriced} sem tarifa/categoria/país válido</p>}
                      </div>
                      <p className="text-xs font-semibold">{currency(row.priced_brl,"BRL")}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {aiUnavailable ? "IA: sem telemetria histórica antes da ativação deste módulo. " : ""}
            {metaUnavailable ? "Meta: sem entregas confirmadas nos dados disponíveis. " : ""}
            A Meta pode aplicar franquias, janelas gratuitas, descontos por volume, impostos e ajustes por fatura.
            Mensagens sem canal Meta identificável ou categoria de cobrança não são precificadas.
            USD e BRL são exibidos separadamente.
          </p>

          <details className="rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium">Configurar tarifas para cálculo de custos</summary>
            <p className="mt-3 text-xs text-muted-foreground">
              Tarifas vigentes a partir do primeiro dia do mês selecionado. Para IA, informe USD por 1 milhão de tokens;
              para Meta, BRL por mensagem entregue a números do Brasil. Utilize a tabela de preços e a moeda da sua conta de faturamento.
              As mudanças recalculam os valores estimados de períodos cobertos pela mesma tarifa.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1">
                <Label>Origem</Label>
                <select className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={source}
                        onChange={e=>setSource(e.target.value as "ai"|"meta")}>
                  <option value="meta">Meta · BRL</option>
                  <option value="ai">IA · USD</option>
                </select>
              </div>
              {source==="meta" ? (
                <div className="space-y-1">
                  <Label>Categoria / país</Label>
                  <select className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={metaSku}
                          onChange={e=>setMetaSku(e.target.value)}>
                    {CATEGORIES.map(c=><option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor="cost-ai-sku">Provedor:modelo</Label>
                  <Input id="cost-ai-sku" value={aiSku} onChange={e=>setAiSku(e.target.value)}
                         placeholder="openai:gpt-4.1" className="h-9"/>
                </div>
              )}
              {source==="meta" ? (
                <div className="space-y-1">
                  <Label htmlFor="cost-unit-price">BRL por mensagem</Label>
                  <Input id="cost-unit-price" inputMode="decimal" value={draft.unit}
                         onChange={e=>setDraft({...draft,unit:e.target.value})} placeholder="0,0000" className="h-9"/>
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="cost-input-price">Entrada / 1M</Label>
                    <Input id="cost-input-price" inputMode="decimal" value={draft.input}
                           onChange={e=>setDraft({...draft,input:e.target.value})} placeholder="USD" className="h-9"/>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cost-output-price">Saída / 1M</Label>
                    <Input id="cost-output-price" inputMode="decimal" value={draft.output}
                           onChange={e=>setDraft({...draft,output:e.target.value})} placeholder="USD" className="h-9"/>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cost-cached-price">Cache / 1M (opcional)</Label>
                    <Input id="cost-cached-price" inputMode="decimal" value={draft.cached}
                           onChange={e=>setDraft({...draft,cached:e.target.value})} placeholder="USD" className="h-9"/>
                  </div>
                </>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={()=>void saveRate()} disabled={saving || loading}>
                {saving ? <Loader2 className="size-4 animate-spin"/> : <Settings2 className="size-4"/>}
                Salvar tarifa ({month})
              </Button>
              {notice && <span role="status" className="text-xs text-muted-foreground">{notice}</span>}
            </div>
            {(report?.rates ?? []).length>0 && (
              <div className="mt-3 text-[11px] text-muted-foreground">
                {(report?.rates ?? []).slice(0,12).map((r:CostRate)=>(
                  <p key={r.source+r.sku+r.effective_from}>
                    {r.effective_from}: {r.sku} · {r.currency} · {r.source==="meta"
                      ? String(r.per_message ?? "—")+"/mensagem"
                      : String(r.input_per_million)+"/entrada · "+String(r.output_per_million)+"/saída · "+String(r.cached_input_per_million??"—")+"/cache"}
                  </p>
                ))}
              </div>
            )}
          </details>
        </>
      )}
    </section>
  )
}
