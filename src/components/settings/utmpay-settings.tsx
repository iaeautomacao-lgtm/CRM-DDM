"use client";

// Integrações → Rastreamento (UTMpay). Requisito do dono (15/10): "bater o olho e entender o que fazer". Por isso:
//  - checklist no topo (verde / amarelo / vermelho / cinza) montado pelo SERVIDOR, com o que fazer em cada item;
//  - na primeira vez, um passo a passo (1 → 2 → 3) em vez do formulário cheio;
//  - botões óbvios: Conectar, Testar, Salvar, com resultado claro na hora (e o que fazer se falhar);
//  - sem jargão: "chave de acesso", "segredo dos avisos", "avisos para o CRM" (o termo técnico só em ajuda pequena);
//  - chave e segredo nunca voltam do servidor: aparece "Configurada (salva em …)" e o botão Trocar.
// API: GET/PUT /api/account/utmpay-config (o PUT já conecta), POST …/connect, GET …/status, POST …/test (settings.account).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Circle, Loader2, Wand2, X } from "lucide-react";

import { ErrorState } from "@/components/ddm/states";
import { StatusChip } from "@/components/ddm/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  connectUtmpay,
  fetchConfig,
  fetchStatus,
  saveConfig,
  testConfig,
  type Checklist,
  type ChecklistItem,
  type ChecklistTone,
  type UtmpayConfig,
  type UtmpayConfigInput,
} from "@/lib/utmpay/api-client";
import { cn } from "@/lib/utils";

export const MIN_SEGREDO = 16;

interface Form {
  enabled: boolean;
  base_url: string;
  api_key: string;
  webhook_secret: string;
  janela_dias: string;
  send_without_tracking: boolean;
}

function toForm(c: UtmpayConfig): Form {
  return {
    enabled: c.enabled,
    base_url: c.base_url,
    api_key: "",
    webhook_secret: "",
    janela_dias: String(c.janela_dias),
    send_without_tracking: c.send_without_tracking,
  };
}

/** Monta o PUT só com o que mudou; chave/segredo vazios ficam de fora (o servidor mantém o atual). Mensagens dizem o que fazer. */
export function buildInput(form: Form, saved: UtmpayConfig): { input: UtmpayConfigInput; error: string | null } {
  const dias = Number(form.janela_dias);
  if (!Number.isInteger(dias) || dias < 1 || dias > 90) return { input: {}, error: "A janela de atribuição vai de 1 a 90 dias. Exemplo: 7." };
  const base = form.base_url.trim();
  if (base && !/^https:\/\/[^/\s]+\/?$/i.test(base)) return { input: {}, error: "Use o endereço do UTMpay com https e sem caminho. Exemplo: https://utmpay.suaempresa.com.br" };
  if (form.enabled && !base) return { input: {}, error: "Informe o endereço do UTMpay para ligar o rastreamento." };
  const input: UtmpayConfigInput = {
    enabled: form.enabled,
    base_url: base.replace(/\/$/, ""),
    janela_dias: dias,
    send_without_tracking: form.send_without_tracking,
  };
  if (form.api_key.trim()) input.api_key = form.api_key.trim();
  if (form.webhook_secret.trim()) {
    if (form.webhook_secret.trim().length < MIN_SEGREDO) return { input: {}, error: `O segredo dos avisos precisa ter pelo menos ${MIN_SEGREDO} letras ou números. Use "Gerar um segredo" para criar um.` };
    input.webhook_secret = form.webhook_secret.trim();
  }
  if (form.enabled && !saved.has_api_key && !input.api_key) return { input: {}, error: "Informe a chave de acesso do UTMpay (copie em Configurações do UTMpay) para ligar o rastreamento." };
  if (form.enabled && !saved.has_webhook_secret && !input.webhook_secret) return { input: {}, error: "Crie o segredo dos avisos (botão \"Gerar um segredo\") para ligar o rastreamento." };
  return { input, error: null };
}

/** Segredo aleatório de 32 caracteres (a pessoa não precisa copiá-lo: o CRM entrega ao UTMpay no Conectar). */
export function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "a").replace(/\//g, "b").replace(/=+$/, "");
}

const TONE_ICON: Record<ChecklistTone, { icon: typeof Check; cls: string; label: string }> = {
  ok: { icon: Check, cls: "bg-success-fill text-white", label: "Pronto" },
  atencao: { icon: AlertTriangle, cls: "bg-warning-fill text-white", label: "Atenção" },
  erro: { icon: X, cls: "bg-danger-fill text-white", label: "Precisa de você" },
  pendente: { icon: Circle, cls: "bg-surface-3 text-muted-foreground", label: "Ainda não" },
};

function ChecklistCard({ checklist, busy, onAction }: { checklist: Checklist; busy: boolean; onAction: (item: ChecklistItem) => void }) {
  const buttonLabel = (i: ChecklistItem) =>
    i.acao_id === "conectar" ? "Conectar" : i.acao_id === "ligar" ? "Ligar" : i.acao_id === "salvar" ? "Salvar" : i.acao_id ? "Preencher" : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Como está o rastreamento</CardTitle>
        <CardDescription>
          {checklist.prontos} de {checklist.total} passos prontos. Verde está pronto, amarelo pede atenção, vermelho precisa de você.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2" aria-label="Passos do rastreamento">
          {checklist.itens.map((i) => {
            const t = TONE_ICON[i.estado];
            const Icon = t.icon;
            const label = buttonLabel(i);
            return (
              <li key={i.id} className="flex items-start gap-3 rounded-field border border-border-soft bg-card px-3 py-2.5">
                <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full", t.cls)} aria-hidden="true">
                  <Icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-foreground">
                    {i.titulo} <span className="sr-only">: {t.label}</span>
                  </p>
                  <p className="text-[13px] text-foreground-2">{i.detalhe}</p>
                  {i.acao && i.estado !== "ok" && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{i.acao}</p>}
                </div>
                {label && i.estado !== "ok" && (
                  <Button type="button" size="sm" variant={i.acao_id === "conectar" ? "default" : "outline"} disabled={busy} onClick={() => onAction(i)}>
                    {label}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

type Banner = { tone: "ok" | "erro"; text: string } | null;

function ResultBanner({ banner }: { banner: Banner }) {
  if (!banner) return null;
  return (
    <p
      role="status"
      className={cn(
        "rounded-field border px-3 py-2.5 text-[13.5px]",
        banner.tone === "ok" ? "border-success/30 bg-success-soft text-success" : "border-danger/30 bg-danger-soft text-danger",
      )}
    >
      {banner.text}
    </p>
  );
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Campo de segredo/chave: nunca mostra o valor; "Configurada (salva em …)" + Trocar. */
function SecretField({
  id, label, help, example, configured, savedAt, value, onChange, extra,
}: {
  id: string; label: string; help: string; example: string; configured: boolean; savedAt: string | null;
  value: string; onChange: (v: string) => void; extra?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const showInput = !configured || editing || value !== "";
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <p className="text-xs text-muted-foreground">{help}</p>
      {configured && !showInput ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="ok">Configurada{savedAt ? ` (salva em ${savedAt})` : ""}</StatusChip>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            Trocar
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Input id={id} type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={configured ? "Digite a nova" : "Ainda não informada"} className="min-w-[240px] flex-1" />
          {extra}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Exemplo: {example}</p>
    </div>
  );
}

export function UtmpaySettings() {
  const [saved, setSaved] = useState<UtmpayConfig | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "connect" | "test">(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [step, setStep] = useState(1);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchConfig().then(
      (c) => {
        setSaved(c);
        setForm(toForm(c));
        setChecklist(c.checklist);
        setLoading(false);
        // O item "UTMpay mandando avisos" só tem o estado real perguntando ao UTMpay: busca em segundo plano.
        if (c.configured) void fetchStatus().then((s) => s.checklist && setChecklist(s.checklist), () => {});
      },
      (e: unknown) => {
        setError((e as Error)?.message ?? "Não foi possível carregar. Tente de novo.");
        setLoading(false);
      },
    );
  }, []);
  useEffect(load, [load]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-primary" aria-label="Carregando" />
      </div>
    );
  }
  // Falha de carga não vira formulário vazio: salvar sobrescreveria a configuração real.
  if (error || !saved || !form) return <ErrorState title="Não foi possível carregar o rastreamento" hint={error ?? undefined} onRetry={load} />;

  if (!saved.available) {
    return (
      <section className="max-w-3xl">
        <SettingsPanelHead className="mb-0" title="Rastreamento (UTMpay)" description="Ainda não está disponível neste ambiente. Peça ao suporte para atualizar o banco de dados." />
      </section>
    );
  }

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(saved));
  const first = checklist?.primeira_vez ?? !saved.configured;

  async function onSave(next?: Form) {
    if (!saved) return;
    const f = next ?? form;
    if (!f) return;
    const { input, error: invalid } = buildInput(f, saved);
    if (invalid) {
      setBanner({ tone: "erro", text: invalid });
      return;
    }
    setBusy("save");
    setBanner(null);
    try {
      const res = await saveConfig(input);
      setSaved(res);
      setForm(toForm(res));
      setChecklist(res.checklist);
      if (res.conexao?.tentou) {
        setBanner(res.conexao.ok ? { tone: "ok", text: "Salvo e conectado. O UTMpay já sabe para onde mandar os avisos." } : { tone: "erro", text: `Salvo, mas ainda não conectou: ${res.conexao.mensagem}` });
      } else {
        setBanner({ tone: "ok", text: "Salvo." });
      }
    } catch (e) {
      setBanner({ tone: "erro", text: (e as Error)?.message ?? "Não foi possível salvar agora. Tente de novo." });
    } finally {
      setBusy(null);
    }
  }

  async function onConnect() {
    setBusy("connect");
    setBanner(null);
    try {
      const r = await connectUtmpay();
      if (r.checklist) setChecklist(r.checklist);
      setBanner(r.ok ? { tone: "ok", text: `Conectado agora há pouco. ${r.message}` } : { tone: "erro", text: r.message });
      if (r.ok) toast.success("Conectado!");
    } catch (e) {
      setBanner({ tone: "erro", text: (e as Error)?.message ?? "Não foi possível conectar agora. Tente de novo." });
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    setBanner(null);
    try {
      const r = await testConfig();
      setBanner({ tone: r.ok ? "ok" : "erro", text: r.message });
    } catch (e) {
      setBanner({ tone: "erro", text: (e as Error)?.message ?? "Não foi possível testar agora. Tente de novo." });
    } finally {
      setBusy(null);
    }
  }

  function onChecklistAction(item: ChecklistItem) {
    if (item.acao_id === "conectar") return void onConnect();
    if (item.acao_id === "ligar") {
      const next = { ...form!, enabled: true };
      setForm(next);
      return void onSave(next);
    }
    if (item.acao_id === "salvar") return void onSave();
    const target = item.acao_id === "informar_endereco" ? "utmpay-base" : item.acao_id === "informar_chave" ? "utmpay-key" : "utmpay-secret";
    document.getElementById(target)?.focus();
  }

  const savedAt = fmtDate(saved.atualizado_em);
  const secretGenerator = (
    <Button type="button" variant="outline" onClick={() => set({ webhook_secret: generateSecret() })}>
      <Wand2 className="mr-1.5 size-4" aria-hidden="true" />
      Gerar um segredo
    </Button>
  );

  // ---------- Primeira vez: passo a passo ----------
  if (first) {
    const steps = [
      {
        n: 1,
        title: "Endereço do UTMpay",
        body: (
          <div className="space-y-1.5">
            <Label htmlFor="utmpay-base">Qual é o endereço do seu UTMpay?</Label>
            <p className="text-xs text-muted-foreground">É o site onde o UTMpay está instalado. O CRM usa para criar os links rastreados.</p>
            <Input id="utmpay-base" value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://utmpay.suaempresa.com.br" inputMode="url" autoComplete="off" />
            <p className="text-xs text-muted-foreground">Exemplo: https://utmpay.suaempresa.com.br</p>
          </div>
        ),
        ok: () => /^https:\/\/[^/\s]+\/?$/i.test(form.base_url.trim()),
        erro: "Digite o endereço completo, começando com https://. Exemplo: https://utmpay.suaempresa.com.br",
      },
      {
        n: 2,
        title: "Chave de acesso",
        body: (
          <SecretField
            id="utmpay-key" label="Cole a chave de acesso do UTMpay" example="utm_AbC123… (a chave é longa)"
            help="No UTMpay, abra Configurações e clique em Gerar nova chave. Copie e cole aqui. Ela aparece só uma vez lá."
            configured={saved.has_api_key} savedAt={savedAt} value={form.api_key} onChange={(v) => set({ api_key: v })}
          />
        ),
        ok: () => saved.has_api_key || form.api_key.trim().length > 0,
        erro: "Cole a chave de acesso. Ela fica em Configurações do UTMpay, no botão Gerar nova chave.",
      },
      {
        n: 3,
        title: "Segredo dos avisos",
        body: (
          <SecretField
            id="utmpay-secret" label="Crie o segredo dos avisos" example="uma frase longa e só sua (16 letras ou mais)"
            help="É a senha que o UTMpay usa para o CRM ter certeza de que o aviso veio dele. Clique em Gerar um segredo: você não precisa copiar, o CRM entrega ao UTMpay sozinho."
            configured={saved.has_webhook_secret} savedAt={savedAt} value={form.webhook_secret} onChange={(v) => set({ webhook_secret: v })} extra={secretGenerator}
          />
        ),
        ok: () => saved.has_webhook_secret || form.webhook_secret.trim().length >= MIN_SEGREDO,
        erro: `O segredo precisa ter pelo menos ${MIN_SEGREDO} letras ou números. Clique em Gerar um segredo.`,
      },
    ];
    const current = steps[step - 1];
    return (
      <section className="max-w-3xl space-y-6">
        <SettingsPanelHead
          className="mb-0"
          title="Rastreamento (UTMpay)"
          description="Cada contato recebe um link rastreado, e o CRM mostra quem clicou, fechou acordo e pagou. Vamos configurar em 3 passos, leva uns 2 minutos."
          action={<StatusChip tone="mute">Não configurado</StatusChip>}
        />
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">
              Passo {step} de 3: {current.title}
            </CardTitle>
            <div className="flex gap-1.5" aria-hidden="true">
              {steps.map((s) => (
                <span key={s.n} className={cn("h-1.5 flex-1 rounded-full", s.n <= step ? "bg-primary-solid" : "bg-surface-3")} />
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {current.body}
            <ResultBanner banner={banner} />
            <div className="flex flex-wrap gap-2">
              {step > 1 && (
                <Button type="button" variant="outline" onClick={() => { setStep(step - 1); setBanner(null); }}>
                  Voltar
                </Button>
              )}
              {step < 3 ? (
                <Button
                  type="button"
                  onClick={() => (current.ok() ? (setStep(step + 1), setBanner(null)) : setBanner({ tone: "erro", text: current.erro }))}
                  className="bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover"
                >
                  Continuar
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => (current.ok() ? void onSave() : setBanner({ tone: "erro", text: current.erro }))}
                  className="bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover"
                >
                  {busy === "save" ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                  Salvar e conectar
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Detalhe técnico: a chave de acesso é a X-API-Key do UTMpay; o segredo assina os avisos (HMAC).</p>
          </CardContent>
        </Card>
      </section>
    );
  }

  // ---------- Já configurado: checklist + formulário ----------
  return (
    <section className="max-w-3xl space-y-6">
      <SettingsPanelHead
        className="mb-0"
        title="Rastreamento (UTMpay)"
        description="Cada contato recebe um link rastreado, e o CRM mostra quem clicou, fechou acordo e pagou. O link que a operação informa na campanha vira o destino."
        action={<StatusChip tone={saved.enabled ? "ok" : "mute"}>{saved.enabled ? "Ligado" : "Desligado"}</StatusChip>}
      />

      {checklist && <ChecklistCard checklist={checklist} busy={busy !== null} onAction={onChecklistAction} />}
      <ResultBanner banner={banner} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        className="space-y-6"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Conexão com o UTMpay</CardTitle>
            <CardDescription>Onde está o UTMpay e como o CRM entra nele. Chave e segredo ficam guardados com segurança e não aparecem de novo.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="utmpay-base">Endereço do UTMpay</Label>
              <p className="text-xs text-muted-foreground">O site onde o UTMpay está instalado.</p>
              <Input id="utmpay-base" value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://utmpay.suaempresa.com.br" inputMode="url" autoComplete="off" />
              <p className="text-xs text-muted-foreground">Exemplo: https://utmpay.suaempresa.com.br</p>
            </div>
            <SecretField
              id="utmpay-key" label="Chave de acesso" example="utm_AbC123… (copie em Configurações do UTMpay)"
              help="É como o CRM entra no UTMpay. Se a chave mudar lá, cole a nova aqui."
              configured={saved.has_api_key} savedAt={savedAt} value={form.api_key} onChange={(v) => set({ api_key: v })}
            />
            <SecretField
              id="utmpay-secret" label="Segredo dos avisos" example="uma frase longa e só sua (16 letras ou mais)"
              help="Senha que o CRM usa para confiar nos avisos do UTMpay. Ao salvar ou trocar, o CRM já entrega o novo segredo ao UTMpay."
              configured={saved.has_webhook_secret} savedAt={savedAt} value={form.webhook_secret} onChange={(v) => set({ webhook_secret: v })} extra={secretGenerator}
            />
            <div className="flex items-center justify-between gap-4 border-t border-border-soft pt-4">
              <div className="space-y-0.5">
                <Label htmlFor="utmpay-enabled" className="text-sm font-medium text-foreground">
                  Rastrear todos os disparos
                </Label>
                <p className="text-xs text-muted-foreground">Ligado, todo disparo sai com link rastreado. Não há opção por campanha.</p>
              </div>
              <Switch id="utmpay-enabled" checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Atribuição e falhas</CardTitle>
            <CardDescription>Quem fechou: Direto (o contato não escreveu), IA (só a IA ou o fluxo respondeu) ou Humano (algum atendente respondeu; vale o último).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-[240px] space-y-1.5">
              <Label htmlFor="utmpay-janela">Por quantos dias contar (janela)</Label>
              <p className="text-xs text-muted-foreground">Cliques e pagamentos até esse prazo depois do envio contam para a campanha.</p>
              <Input id="utmpay-janela" type="number" min={1} max={90} value={form.janela_dias} onChange={(e) => set({ janela_dias: e.target.value })} />
              <p className="text-xs text-muted-foreground">Exemplo: 7</p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="utmpay-fallback" className="text-sm font-medium text-foreground">
                  Enviar sem rastreio se o UTMpay cair
                </Label>
                <p className="text-xs text-muted-foreground">Desligado (recomendado): o envio espera e tenta de novo, com o erro à vista na campanha. Ligado: sai sem rastreio.</p>
              </div>
              <Switch id="utmpay-fallback" checked={form.send_without_tracking} onCheckedChange={(v) => set({ send_without_tracking: v })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Como funciona o link</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>O destino do link precisa começar com https e ser de um site permitido no UTMpay (Configurações do UTMpay → Sites permitidos). Se não for, o envio espera e o erro aparece no item.</li>
              <li>Só o primeiro endereço (link) da mensagem é rastreado.</li>
              <li>Em modelo (template) da Meta, o endereço precisa estar numa variável ({"{{n}}"}); endereço escrito direto no texto aprovado não é trocado e fica sem rastreio.</li>
            </ul>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy !== null || !dirty} className="bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover">
            {busy === "save" ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Salvar
          </Button>
          <Button type="button" variant="outline" disabled={busy !== null || dirty} onClick={() => void onConnect()} title={dirty ? "Salve antes de conectar" : "O CRM entrega ao UTMpay o endereço e o segredo dos avisos"}>
            {busy === "connect" ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Conectar
          </Button>
          <Button type="button" variant="outline" disabled={busy !== null || dirty} onClick={() => void onTest()} title={dirty ? "Salve antes de testar" : "Confere se o UTMpay responde"}>
            {busy === "test" ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Testar
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">Você tem mudanças sem salvar.</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          Conectar: o CRM manda ao UTMpay {saved.events_url ? <>o endereço dos avisos (<span className="font-mono">{saved.events_url}</span>)</> : "o endereço dos avisos"} e o segredo. Testar: só confere se o UTMpay responde.
          Detalhe técnico: a chave de acesso é a X-API-Key; o segredo assina os avisos (HMAC).
        </p>
      </form>
    </section>
  );
}
