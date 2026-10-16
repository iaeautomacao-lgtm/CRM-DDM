"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { ArrowLeft, CheckCircle2, CircleAlert, Cloud, Loader2, Plus, RefreshCw, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api-fetch"
import { useAuth } from "@/hooks/use-auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"

type Integration = {
  id:string;name:string;business_id:string;app_id:string|null
  has_app_secret:boolean;source_channel_id:string|null;created_at:string
}
type Channel = {
  id:string;display_phone_number:string|null;waba_id:string|null
  status:string;habilitado:boolean;has_app_secret:boolean
}
type Draft = {
  id:string;integration_id:string;phone_number_id:string;waba_id:string
  display_phone_number:string|null;verified_name:string|null
  former_provider:string;status:string;created_at:string
}
type Phone = {
  id:string;waba_id:string;waba_name:string;display_phone_number:string
  verified_name:string;quality_rating:string|null;code_verification_status:string|null
  crm_status:"available_for_review"|"already_in_this_account"|"already_in_another_account"
  routing_verified:false;number_registered_verified:false
}
type Discovery = { phones:Phone[];wabas:{id:string;name:string;ownership:string}[];warnings:string[];partial:boolean }
type Source = "fortics" | "other" | "new_number"

export default function MetaIntegrationsPage(){
  const {canEditSettings} = useAuth()
  const [integrations,setIntegrations]=useState<Integration[]>([])
  const [channels,setChannels]=useState<Channel[]>([])
  const [drafts,setDrafts]=useState<Draft[]>([])
  const [loading,setLoading]=useState(true)
  const [selectedId,setSelectedId]=useState("")
  const [discovery,setDiscovery]=useState<Discovery|null>(null)
  const [discovering,setDiscovering]=useState(false)
  const [creating,setCreating]=useState(false)
  const [createOpen,setCreateOpen]=useState(false)
  const [mode,setMode]=useState<"existing"|"manual">("existing")
  const [label,setLabel]=useState("")
  const [businessId,setBusinessId]=useState("")
  const [appId,setAppId]=useState("")
  const [token,setToken]=useState("")
  const [appSecret,setAppSecret]=useState("")
  const [sourceChannelId,setSourceChannelId]=useState("")
  const [preparing,setPreparing]=useState(false)
  const [selectedPhone,setSelectedPhone]=useState<Phone|null>(null)
  const [source,setSource]=useState<Source>("fortics")
  const [confirmed,setConfirmed]=useState(false)

  const refresh=useCallback(async()=>{
    setLoading(true)
    try{
      const res=await apiFetch("/api/whatsapp/meta-integrations",{cache:"no-store"})
      const data=await res.json()
      if(!res.ok)throw new Error(data.error||"Falha ao consultar integrações")
      setIntegrations(data.integrations??[])
      setChannels(data.legacy_channels??[])
      setDrafts(data.drafts??[])
      setSelectedId(prev=>prev && data.integrations.some((i:Integration)=>i.id===prev)
        ? prev : (data.integrations[0]?.id??""))
    }catch(e){toast.error(e instanceof Error?e.message:"Falha ao consultar integrações")}
    finally{setLoading(false)}
  },[])
  useEffect(()=>{if(canEditSettings)void refresh()},[canEditSettings,refresh])
  const selected=integrations.find(x=>x.id===selectedId)
  async function createIntegration(){
    setCreating(true)
    try{
      const payload={
        name:label.trim(),business_id:businessId.trim(),app_id:appId.trim()||null,
        ...(mode==="existing"?{source_channel_id:sourceChannelId}:{access_token:token.trim()}),
        ...(appSecret.trim()?{app_secret:appSecret.trim()}:{}),
      }
      const res=await apiFetch("/api/whatsapp/meta-integrations",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),
      })
      const data=await res.json()
      if(!res.ok)throw new Error(data.error||"Falha ao salvar integração")
      toast.success("Integração autorizada cadastrada. Nenhum número foi transferido.")
      setCreateOpen(false)
      // Do not retain credentials in component state after saving.
      setToken("");setAppSecret("");setLabel("");setBusinessId("");setAppId("");setSourceChannelId("")
      await refresh()
      setSelectedId(data.integration.id)
      setDiscovery(null)
    }catch(e){toast.error(e instanceof Error?e.message:"Falha ao cadastrar integração")}
    finally{setCreating(false)}
  }
  async function discover(){
    if(!selectedId)return
    setDiscovering(true)
    setDiscovery(null)
    try{
      const res=await apiFetch("/api/whatsapp/meta-integrations/"+encodeURIComponent(selectedId)+"/discover",{cache:"no-store"})
      const data=await res.json()
      if(!res.ok)throw new Error(data.error||"Falha ao consultar números")
      setDiscovery(data)
      if(data.partial)toast.warning("Listagem parcial: verifique as permissões Meta.")
    }catch(e){toast.error(e instanceof Error?e.message:"Falha na descoberta")}
    finally{setDiscovering(false)}
  }
  async function prepareDraft(){
    if(!selectedId||!selectedPhone||!confirmed)return
    setPreparing(true)
    try{
      const res=await apiFetch(
        "/api/whatsapp/meta-integrations/"+encodeURIComponent(selectedId)+"/drafts",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            waba_id:selectedPhone.waba_id,phone_number_id:selectedPhone.id,
            former_provider:source,ownership_attested:true,acknowledge_no_activation:true,
          }),
        })
      const data=await res.json()
      if(!res.ok)throw new Error(data.error||"Falha ao preparar rascunho")
      toast.success("Rascunho salvo; número não ativado.")
      setSelectedPhone(null);setConfirmed(false)
      await refresh()
      await discover()
    }catch(e){toast.error(e instanceof Error?e.message:"Falha ao criar rascunho")}
    finally{setPreparing(false)}
  }

  if(!canEditSettings)return (
    <main className="space-y-3 p-4 lg:p-6">
      <h1 className="text-xl font-semibold">Integrações Meta</h1>
      <p className="text-sm text-muted-foreground">Esta área é reservada aos administradores da organização.</p>
      <Link href="/canais" className="inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-accent">Voltar aos canais</Link>
    </main>
  )

  return (
    <main className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link href="/canais" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3"/> Canais
          </Link>
          <h1 className="text-xl font-semibold">Integrações Meta</h1>
          <p className="text-sm text-muted-foreground">
            Reutilize credenciais autorizadas, descubra números e prepare migrações de forma controlada.
          </p>
        </div>
        <Button onClick={()=>setCreateOpen(true)}><Plus className="size-4"/> Nova integração</Button>
      </header>

      <div className="flex gap-2 rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
        <ShieldCheck className="size-5 shrink-0 text-primary"/>
        <div>
          <strong className="text-foreground">Modo seguro: somente consulta e pré-cadastro.</strong>{" "}
          Esta tela não desconecta a Fortics, não executa registro de número, não altera webhooks ou rotas da Meta
          e não habilita canais para atendimento. A titularidade precisa ser confirmada antes da ativação.
        </div>
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">1. Integração empresarial autorizada</h2>
        {loading ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin"/> Carregando...</p>
          : integrations.length===0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma integração cadastrada. Cadastre uma credencial autorizada ou reutilize a de um canal Meta existente.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              <div className="min-w-64 flex-1 space-y-1">
                <Label htmlFor="meta-integration-choice">Integração</Label>
                <select id="meta-integration-choice" value={selectedId}
                        onChange={e=>{setSelectedId(e.target.value);setDiscovery(null)}}
                        className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
                  {integrations.map(i=><option key={i.id} value={i.id}>{i.name} — Business ID {i.business_id}</option>)}
                </select>
              </div>
              <div className="flex items-end">
                <Button variant="outline" onClick={()=>void discover()} disabled={!selectedId||discovering}>
                  {discovering?<Loader2 className="size-4 animate-spin"/>:<RefreshCw className="size-4"/>}
                  Consultar números autorizados
                </Button>
              </div>
            </div>
          )}
        {selected && (
          <p className="mt-3 text-xs text-muted-foreground">
            App ID: {selected.app_id||"não informado"} · App Secret: {selected.has_app_secret?"configurado":"não informado"}.
            As credenciais não são exibidas.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">2. Números disponíveis na Meta</h2>
        {!discovery ? (
          <p className="text-sm text-muted-foreground">Selecione uma integração e clique em “Consultar números autorizados”.</p>
        ) : (
          <>
            {discovery.warnings.length>0 && (
              <div role="alert" className="mb-3 rounded-md border border-amber-500/30 p-3 text-xs text-amber-600">
                {discovery.warnings.join(" ")}
              </div>
            )}
            {discovery.phones.length===0 ? (
              <p className="text-sm text-muted-foreground">Nenhum número retornado pela Meta. Verifique Business ID, escopos do token e compartilhamento dos ativos.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border text-muted-foreground">
                    <tr><th className="py-3 pr-3">Número e nome</th><th className="pr-3">Conta Meta</th>
                      <th className="pr-3">Qualidade</th><th className="pr-3">CRM</th><th>Próxima ação</th></tr>
                  </thead>
                  <tbody>
                    {discovery.phones.map(p=>{
                      const alreadyDraft=drafts.some(d=>d.phone_number_id===p.id)
                      return <tr key={p.id} className="border-b border-border/60 last:border-0">
                        <td className="py-3 pr-3">
                          <p className="font-medium">{p.display_phone_number||p.id}</p>
                          <p className="text-muted-foreground">{p.verified_name||"Sem nome verificado"}</p>
                        </td>
                        <td className="pr-3">{p.waba_name}</td>
                        <td className="pr-3">{p.quality_rating||"Não informado"}</td>
                        <td className="pr-3">
                          {p.crm_status==="available_for_review"?"Não cadastrado":
                            p.crm_status==="already_in_this_account"?"Já existe no CRM":"Já utilizado em outra conta"}
                        </td>
                        <td>
                          <Button size="sm" variant="outline"
                            disabled={p.crm_status!=="available_for_review"||alreadyDraft}
                            onClick={()=>{setSelectedPhone(p);setConfirmed(false);setSource("fortics")}}>
                            {alreadyDraft?"Rascunho existente":"Preparar pré-cadastro"}
                          </Button>
                        </td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">3. Rascunhos aguardando validação</h2>
        {drafts.length===0 ? (
          <p className="text-sm text-muted-foreground">Nenhum número preparado ainda.</p>
        ) : (
          <div className="space-y-2">
            {drafts.map(d=>(
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-2 text-sm last:border-0">
                <div>
                  <p className="font-medium">{d.display_phone_number||d.phone_number_id} — {d.verified_name||"WhatsApp"}</p>
                  <p className="text-xs text-muted-foreground">Origem: {d.former_provider} · WABA {d.waba_id}</p>
                </div>
                <span className="text-xs text-amber-600">Aguardando confirmação de titularidade</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Canais Meta já cadastrados</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Os estados abaixo são os registros locais do CRM; não comprovam recebimento, titularidade nem roteamento da Meta.
        </p>
        {channels.length===0?<p className="text-xs text-muted-foreground">Nenhum canal atual.</p>:(
          <div className="space-y-2">
            {channels.map(c=>(
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-2 text-xs last:border-0">
                <span>{c.display_phone_number||"Canal sem número público"} · {c.waba_id?"WABA "+c.waba_id:"WABA não informada"}</span>
                <span className="text-muted-foreground">{c.habilitado?"Habilitado":"Desabilitado"} · {c.status} (local)</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={createOpen} onOpenChange={open=>{if(!creating){setCreateOpen(open);if(!open){setToken("");setAppSecret("")}}}}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle><Cloud className="mr-2 inline size-4"/> Nova integração Meta</DialogTitle>
            <DialogDescription>
              O token fica criptografado no servidor. O cadastro valida permissões de leitura e não ativa nenhum número.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label htmlFor="meta-name">Nome da integração</Label>
              <Input id="meta-name" maxLength={80} placeholder="Planejamento Meta principal" value={label} onChange={e=>setLabel(e.target.value)}/></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label htmlFor="meta-biz">Business Portfolio ID</Label>
                <Input id="meta-biz" inputMode="numeric" placeholder="ID da empresa Meta" value={businessId} onChange={e=>setBusinessId(e.target.value)}/></div>
              <div className="space-y-1"><Label htmlFor="meta-app">App ID (opcional nesta fase)</Label>
                <Input id="meta-app" inputMode="numeric" placeholder="App ID" value={appId} onChange={e=>setAppId(e.target.value)}/></div>
            </div>
            <div className="space-y-1"><Label htmlFor="meta-mode">Credencial</Label>
              <select id="meta-mode" value={mode} onChange={e=>setMode(e.target.value as "existing"|"manual")}
                      className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="existing">Reutilizar token de um canal existente</option>
                <option value="manual">Cadastrar novo token autorizado</option>
              </select>
            </div>
            {mode==="existing" ? (
              <div className="space-y-1"><Label htmlFor="meta-source-channel">Canal Meta da mesma organização</Label>
                <select id="meta-source-channel" value={sourceChannelId} onChange={e=>setSourceChannelId(e.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
                  <option value="">Selecione o canal...</option>
                  {channels.map(c=><option key={c.id} value={c.id}>{c.display_phone_number||c.id}</option>)}
                </select>
              </div>
            ) : (
              <div className="space-y-1"><Label htmlFor="meta-token">Token de usuário de sistema</Label>
                <Input id="meta-token" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}
                       placeholder="Token emitido pela Meta"/></div>
            )}
            <div className="space-y-1"><Label htmlFor="meta-secret">App Secret (opcional para leitura)</Label>
              <Input id="meta-secret" type="password" autoComplete="off" value={appSecret}
                     onChange={e=>setAppSecret(e.target.value)} placeholder="Necessário para validar o webhook numa futura ativação"/>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setCreateOpen(false)} disabled={creating}>Cancelar</Button>
            <Button disabled={creating||!label.trim()||!businessId.trim()||
              (mode==="existing"?!sourceChannelId:!token.trim())} onClick={()=>void createIntegration()}>
              {creating?<Loader2 className="size-4 animate-spin"/>:<CheckCircle2 className="size-4"/>}
              Validar e salvar integração
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedPhone} onOpenChange={open=>{if(!open&&!preparing){setSelectedPhone(null);setConfirmed(false)}}}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle><CircleAlert className="mr-2 inline size-4"/> Preparar número para migração</DialogTitle>
            <DialogDescription>
              A operação cria SOMENTE um rascunho interno; não registra o número na Meta nem altera Fortics, mensagens ou webhooks.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">Número: <strong>{selectedPhone?.display_phone_number}</strong></p>
          <div className="space-y-1">
            <Label htmlFor="meta-former-provider">Origem do número</Label>
            <select id="meta-former-provider" value={source} onChange={e=>setSource(e.target.value as Source)}
                    className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
              <option value="fortics">Fortics</option>
              <option value="other">Outro provedor</option>
              <option value="new_number">Número novo</option>
            </select>
          </div>
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} className="mt-0.5"/>
            <span>Declaro que tenho autorização para consultar este ativo e entendo que nenhum número será ativado, migrado ou removido. A titularidade ainda precisará ser comprovada.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={preparing} onClick={()=>{setSelectedPhone(null);setConfirmed(false)}}>Cancelar</Button>
            <Button disabled={!confirmed||preparing} onClick={()=>void prepareDraft()}>
              {preparing?<Loader2 className="size-4 animate-spin"/>:"Salvar rascunho"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
