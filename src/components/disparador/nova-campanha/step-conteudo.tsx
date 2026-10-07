"use client";

import { useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, FileText, Loader2, Plus, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { MessageTemplatePicker } from "@/components/disparador/message-template-picker";
import { TEMPLATE_VARS } from "@/lib/disparador/template-vars";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import type { CampaignProvider, TemplateMode } from "@/lib/disparador/campaign-validation";
import type { ImportColumnMap } from "@/lib/disparador/import-mapping";
import type { PreviewContact, VariableSource } from "@/lib/disparador/preview-message";
import { templateComponentProblem, type LocalTemplateRow } from "@/lib/disparador/template-validation";
import { MessagePreview } from "./message-preview";
import { messageFromTemplate, type WizardForm, type WizardMessage } from "./wizard-rules";

export interface CatalogTemplate extends LocalTemplateRow {
  id: string;
  category?: string | null;
}

export interface TemplateCatalogState {
  loading: boolean;
  error: string | null;
  /** Aprovados da WABA, já filtrados pela equipe. */
  available: CatalogTemplate[];
  /** A equipe tem lista de templates liberados (team_allowed_templates). */
  teamRestricted: boolean;
}

export interface PreviewTarget {
  key: string;
  titulo: string;
  contact: PreviewContact;
}

const VAR_KEYS = ["var1", "var2", "var3"] as const;

function sourceValue(entry: VariableSource | undefined): string {
  if (!entry) return "static";
  if (entry.type === "contact_field") return entry.field;
  if (entry.type === "csv_var") return `csv_${entry.index}`;
  if (entry.type === "utm_link") return "utm_link";
  return "static";
}

function sourceFromValue(value: string): VariableSource {
  if (value.startsWith("csv_")) return { type: "csv_var", index: Number(value.slice(4)) as 0 | 1 | 2 };
  if (value === "utm_link") return { type: "utm_link" };
  if (value === "name" || value === "phone" || value === "cpf" || value === "company") {
    return { type: "contact_field", field: value };
  }
  return { type: "static", value: "" };
}

function modeRule(mode: TemplateMode, provider: CampaignProvider): string {
  if (provider === "meta") {
    return mode === "sequencia"
      ? "Modo Padrão: escolha 1 template aprovado. Todos os contatos recebem o mesmo."
      : mode === "rotacao"
        ? "Modo Rotação: escolha 2 ou mais templates. Cada contato recebe 1, na ordem da lista (1º contato o 1º template, 2º contato o 2º…)."
        : "Modo Aleatório: escolha 2 ou mais templates. Cada contato recebe 1, sorteado.";
  }
  return mode === "sequencia"
    ? "Modo Padrão: a mesma mensagem para todos. Adicione partes (texto, imagem, áudio…) para enviar uma sequência, em ordem, a cada contato."
    : mode === "rotacao"
      ? "Modo Rotação: crie 2 ou mais variações. Cada contato recebe só 1, na ordem da lista."
      : "Modo Aleatório: crie 2 ou mais variações. Cada contato recebe só 1, sorteada.";
}

export function StepConteudo({
  form,
  update,
  provider,
  catalog,
  catalogRows,
  columnMap,
  hasFile,
  csvAvailable,
  utmAvailable,
  previewTargets,
}: {
  form: WizardForm;
  update: (patch: Partial<WizardForm>) => void;
  provider: CampaignProvider | null;
  catalog: TemplateCatalogState;
  /** Linhas do catálogo da WABA (todas as situações), para validar os escolhidos. */
  catalogRows: readonly LocalTemplateRow[];
  columnMap: ImportColumnMap;
  hasFile: boolean;
  /** Há base (arquivo novo ou já vinculada): oferecer colunas VAR1–3. */
  csvAvailable: boolean;
  utmAvailable: boolean;
  previewTargets: PreviewTarget[];
}) {
  const mensagens = form.mensagens;
  const setMensagens = (next: WizardMessage[]) => update({ mensagens: next });
  const rotulo = form.templateMode === "sequencia" ? (provider === "meta" ? "Template" : "Parte") : "Variação";

  if (!provider) {
    return <p className="text-sm text-muted-foreground">Escolha os canais no passo Origem para montar o conteúdo.</p>;
  }

  return (
    <div className="space-y-5">
      <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">{modeRule(form.templateMode, provider)}</p>

      {provider === "meta" ? (
        <MetaTemplates
          form={form}
          setMensagens={setMensagens}
          catalog={catalog}
          catalogRows={catalogRows}
          columnMap={columnMap}
          hasFile={hasFile}
          csvAvailable={csvAvailable}
          utmAvailable={utmAvailable}
        />
      ) : (
        <WahaMessages
          form={form}
          setMensagens={setMensagens}
          columnMap={columnMap}
          hasFile={hasFile}
          rotulo={rotulo}
        />
      )}

      {mensagens.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">Prévia por contato</h4>
          <p className="text-xs text-muted-foreground">
            {hasFile
              ? "Como os primeiros contatos da base vão receber."
              : "Contato de exemplo. Os dados de cada contato são preenchidos no envio."}
          </p>
          {previewTargets.map((target, ci) => {
            const list =
              form.templateMode === "sequencia"
                ? mensagens.map((msg, idx) => ({ msg, idx }))
                : [{ msg: mensagens[ci % mensagens.length], idx: ci % mensagens.length }];
            return (
              <div key={target.key} className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-xs font-medium text-foreground">{target.titulo}</p>
                {list.map(({ msg, idx }) => (
                  <MessagePreview
                    key={idx}
                    msg={msg}
                    rotulo={`${rotulo} ${idx + 1}`}
                    contact={target.contact}
                    isMeta={provider === "meta"}
                    columnMap={columnMap}
                  />
                ))}
              </div>
            );
          })}
          {form.templateMode === "aleatorio" && mensagens.length > 1 && (
            <p className="text-xs text-muted-foreground">No modo Aleatório a variação de cada contato é sorteada no envio.</p>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------- Meta: templates aprovados da WABA ----------------

function MetaTemplates({
  form,
  setMensagens,
  catalog,
  catalogRows,
  columnMap,
  hasFile,
  csvAvailable,
  utmAvailable,
}: {
  form: WizardForm;
  setMensagens: (next: WizardMessage[]) => void;
  catalog: TemplateCatalogState;
  catalogRows: readonly LocalTemplateRow[];
  columnMap: ImportColumnMap;
  hasFile: boolean;
  csvAvailable: boolean;
  utmAvailable: boolean;
}) {
  const [search, setSearch] = useState("");
  const mensagens = form.mensagens;
  const single = form.templateMode === "sequencia";
  const isSelected = (t: CatalogTemplate) =>
    mensagens.some((m) => m.template_name === t.name && (m.template_language ?? "pt_BR") === (t.language ?? "pt_BR"));

  const toggle = (t: CatalogTemplate) => {
    if (isSelected(t)) {
      setMensagens(mensagens.filter((m) => !(m.template_name === t.name && (m.template_language ?? "pt_BR") === (t.language ?? "pt_BR"))));
      return;
    }
    const msg = messageFromTemplate(t, columnMap, hasFile);
    setMensagens(single ? [msg] : [...mensagens, msg]);
  };

  const filtered = catalog.available.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()));

  const move = (idx: number, delta: number) => {
    const next = [...mensagens];
    const [item] = next.splice(idx, 1);
    next.splice(idx + delta, 0, item);
    setMensagens(next);
  };

  const setVar = (msgIdx: number, varIdx: number, source: VariableSource) => {
    const next = [...mensagens];
    const map = [...(next[msgIdx].template_variable_map ?? [])];
    map[varIdx] = source;
    next[msgIdx] = { ...next[msgIdx], template_variable_map: map };
    setMensagens(next);
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">
            Templates aprovados {single ? "(escolha 1)" : "(escolha 2 ou mais)"}
          </h4>
          <span className="text-xs text-muted-foreground">
            {mensagens.length} selecionado{mensagens.length === 1 ? "" : "s"}
          </span>
        </div>
        {catalog.teamRestricted && (
          <p className="text-xs text-muted-foreground">Mostrando só os templates liberados para a equipe escolhida.</p>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            aria-label="Buscar template"
            placeholder="Buscar template…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border p-2" role="group" aria-label="Templates aprovados">

          {catalog.loading ? (
            <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Carregando templates do número…
            </p>
          ) : catalog.error ? (
            <p className="p-2 text-xs text-red-600">{catalog.error}</p>
          ) : filtered.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              Nenhum template aprovado {search ? "com esse nome " : ""}nesta conta WhatsApp Business. Sincronize em Configurações → Templates.
            </p>
          ) : (
            filtered.map((t) => {
              const problem = templateComponentProblem(t);
              const selected = isSelected(t);
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={Boolean(problem) && !selected}
                  onClick={() => toggle(t)}
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors",
                    selected ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/50",
                    problem && !selected && "cursor-not-allowed opacity-60"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
                      single ? "rounded-full" : "rounded",
                      selected ? "border-primary bg-primary text-primary-foreground" : "border-input"
                    )}
                    aria-hidden="true"
                  >
                    {selected && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">
                      {t.name} <span className="font-normal text-muted-foreground">· {t.language}{t.category ? ` · ${t.category}` : ""}</span>
                    </span>
                    <span className="line-clamp-2 block text-muted-foreground">{t.body_text}</span>
                    {problem && <span className="mt-0.5 block text-amber-700 dark:text-amber-400">{problem}</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {mensagens.map((msg, i) => {
        const missing = !catalogRows.some((r) => r.name === msg.template_name);
        return (
          <section key={`${msg.template_name}-${i}`} className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-foreground">
                {single ? "Template" : `Template ${i + 1}`} · {msg.template_name}{" "}
                <span className="font-normal text-muted-foreground">({msg.template_language ?? "pt_BR"})</span>
              </p>
              <div className="flex gap-1">
                {!single && (
                  <>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Subir template ${i + 1}`}>
                      <ArrowUp className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={i === mensagens.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label={`Descer template ${i + 1}`}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-red-500 hover:bg-red-500/10"
                  onClick={() => setMensagens(mensagens.filter((_, idx) => idx !== i))}
                  aria-label={`Remover template ${msg.template_name}`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
            {missing && (
              <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Este template não está no catálogo deste número. Remova-o e escolha um template da lista.
              </p>
            )}
            <p className="whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground" aria-label="Corpo do template (somente leitura)">
              {msg.conteudo}
            </p>
            {(msg.template_variable_map ?? []).length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Variáveis</p>
                {(msg.template_variable_map ?? []).map((entry, varIdx) => (
                  <VariableRow
                    key={varIdx}
                    index={varIdx}
                    entry={entry}
                    columnMap={columnMap}
                    hasFile={hasFile}
                    csvAvailable={csvAvailable}
                    utmAvailable={utmAvailable}
                    onChange={(source) => setVar(i, varIdx, source)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function VariableRow({
  index,
  entry,
  columnMap,
  hasFile,
  csvAvailable,
  utmAvailable,
  onChange,
}: {
  index: number;
  entry: VariableSource;
  columnMap: ImportColumnMap;
  hasFile: boolean;
  csvAvailable: boolean;
  utmAvailable: boolean;
  onChange: (source: VariableSource) => void;
}) {
  const value = sourceValue(entry);
  // Com arquivo novo, só as colunas mapeadas; com base antiga (edição), as
  // três (o mapeamento ficou no servidor).
  const csvOptions = csvAvailable
    ? VAR_KEYS.map((k, i) => ({ i, column: columnMap[k] })).filter((o) => !hasFile || o.column)
    : [];
  const label = (v: string) =>
    v === "name"
      ? "Nome do contato"
      : v === "phone"
        ? "Telefone"
        : v === "cpf"
          ? "CPF"
          : v === "company"
            ? "Empresa"
            : v === "utm_link"
              ? "Link UTM"
              : v.startsWith("csv_")
                ? `VAR${Number(v.slice(4)) + 1}${columnMap[VAR_KEYS[Number(v.slice(4))]] ? ` (${columnMap[VAR_KEYS[Number(v.slice(4))]]})` : ""}`
                : "Valor fixo";
  const staticEmpty = entry.type === "static" && !entry.value.trim();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{`{{${index + 1}}}`}</span>
      <Select value={value} onValueChange={(v) => v && onChange(sourceFromValue(v))}>
        <SelectTrigger className="h-8 w-48 text-xs" aria-label={`Origem da variável ${index + 1}`}>
          <SelectValue>{(v: string) => label(v)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="name">Nome do contato</SelectItem>
          <SelectItem value="phone">Telefone</SelectItem>
          <SelectItem value="cpf">CPF</SelectItem>
          {csvOptions.map((o) => (
            <SelectItem key={o.i} value={`csv_${o.i}`}>
              {label(`csv_${o.i}`)}
            </SelectItem>
          ))}
          {(utmAvailable || value === "utm_link") && <SelectItem value="utm_link">Link UTM</SelectItem>}
          {value === "company" && <SelectItem value="company">Empresa</SelectItem>}
          <SelectItem value="static">Valor fixo</SelectItem>
        </SelectContent>
      </Select>
      {entry.type === "static" && (
        <Input
          value={entry.value}
          onChange={(e) => onChange({ type: "static", value: e.target.value })}
          placeholder="Valor fixo para todos"
          aria-label={`Valor fixo da variável ${index + 1}`}
          aria-invalid={staticEmpty || undefined}
          className={cn("h-8 min-w-32 flex-1 text-xs", staticEmpty && "border-red-500")}
        />
      )}
      {entry.type === "csv_var" && !csvAvailable && (
        <span className="text-xs text-red-600 dark:text-red-400">Sem base importada: escolha outra origem.</span>
      )}
    </div>
  );
}

// ---------------- WAHA: texto, IA, imagem, áudio ----------------

const WAHA_TYPES: Array<{ key: string; label: string }> = [
  { key: "texto", label: "Texto" },
  { key: "ia", label: "IA" },
  { key: "imagem", label: "Imagem" },
  { key: "audio", label: "Áudio" },
];

function WahaMessages({
  form,
  setMensagens,
  columnMap,
  hasFile,
  rotulo,
}: {
  form: WizardForm;
  setMensagens: (next: WizardMessage[]) => void;
  columnMap: ImportColumnMap;
  hasFile: boolean;
  rotulo: string;
}) {
  const mensagens = form.mensagens;
  const refs = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);

  const patch = (i: number, values: Partial<WizardMessage>) => {
    const next = [...mensagens];
    next[i] = { ...next[i], ...values };
    setMensagens(next);
  };

  const insertVar = (key: string, i: number, token: string) => {
    const el = refs.current[key];
    const current = mensagens[i]?.conteudo ?? "";
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    patch(i, { conteudo: current.slice(0, start) + token + current.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const csvButtons = hasFile
    ? VAR_KEYS.map((k, idx) => ({ token: `{{${idx + 1}}}`, label: `VAR${idx + 1}: ${columnMap[k] ?? ""}`, on: Boolean(columnMap[k]) })).filter(
        (b) => b.on
      )
    : [];

  const varButtons = (key: string, i: number) => (
    <div className="flex flex-wrap gap-1">
      {[...TEMPLATE_VARS.map((v) => ({ token: v.value, label: v.label })), ...csvButtons].map((v) => (
        <button
          key={v.token}
          type="button"
          onClick={() => insertVar(key, i, v.token)}
          className="rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
        >
          {v.label}
        </button>
      ))}
    </div>
  );

  const upload = async (i: number, file: File, kind: "imagem" | "audio") => {
    const id = toast.loading(kind === "imagem" ? "Enviando imagem…" : "Enviando áudio…");
    try {
      const res = await uploadAccountMedia("chat-media", file);
      patch(i, { url: res.publicUrl });
      toast.success("Arquivo enviado.", { id });
    } catch (err) {
      toast.error(`Erro no upload: ${err instanceof Error ? err.message : String(err)}`, { id });
    }
  };

  return (
    <div className="space-y-3">
      {mensagens.map((msg, i) => (
        <section key={i} className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">
              {rotulo} {i + 1}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setMensagens(mensagens.filter((_, idx) => idx !== i))}
              aria-label={`Remover ${rotulo.toLowerCase()} ${i + 1}`}
              className="h-8 w-8 text-red-500 hover:bg-red-500/10"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          {msg.tipo === "ligacao" && (
            <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Ligação não é mais enviada pelo disparador. Escolha outro tipo ou remova.
            </p>
          )}
          <div className="grid grid-cols-4 gap-2 text-xs" role="group" aria-label={`Tipo da ${rotulo.toLowerCase()} ${i + 1}`}>
            {WAHA_TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={msg.tipo === t.key}
                onClick={() => patch(i, { tipo: t.key })}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-md border py-1.5 font-medium",
                  msg.tipo === t.key ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground"
                )}
              >
                {t.key === "ia" && <Sparkles className="h-3 w-3" aria-hidden="true" />}
                {t.label}
              </button>
            ))}
          </div>

          {msg.tipo === "texto" && (
            <div className="space-y-1.5">
              <textarea
                ref={(el) => {
                  refs.current[`t-${i}`] = el;
                }}
                value={msg.conteudo ?? ""}
                onChange={(e) => patch(i, { conteudo: e.target.value })}
                placeholder="Escreva a mensagem…"
                aria-label={`Texto da ${rotulo.toLowerCase()} ${i + 1}`}
                className="min-h-[72px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <div className="flex flex-wrap items-start justify-between gap-2">
                {varButtons(`t-${i}`, i)}
                <button
                  type="button"
                  onClick={() => setPickerIndex(i)}
                  className="flex items-center gap-1 rounded-full border border-dashed border-border bg-card px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary"
                >
                  <FileText className="h-3 w-3" aria-hidden="true" /> Carregar texto salvo
                </button>
              </div>
            </div>
          )}

          {msg.tipo === "ia" && (
            <div className="space-y-1">
              <textarea
                value={msg.prompt ?? ""}
                onChange={(e) => patch(i, { prompt: e.target.value })}
                placeholder="Ex.: Lembre o cliente do acordo com tom cordial e ofereça o link de pagamento."
                aria-label={`Prompt da IA da ${rotulo.toLowerCase()} ${i + 1}`}
                className="min-h-[72px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <p className="text-xs text-muted-foreground">O nome do contato já vai para a IA; variáveis {"{{ }}"} não se aplicam aqui.</p>
            </div>
          )}

          {(msg.tipo === "imagem" || msg.tipo === "audio") && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="url"
                  value={msg.url ?? ""}
                  onChange={(e) => patch(i, { url: e.target.value })}
                  placeholder={msg.tipo === "imagem" ? "Link da imagem…" : "Link do áudio OGG/MP3…"}
                  aria-label={`Link do arquivo da ${rotulo.toLowerCase()} ${i + 1}`}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <Button type="button" variant="secondary" className="h-9 shrink-0 text-xs" onClick={() => fileRefs.current[i]?.click()}>
                  Carregar
                </Button>
                <input
                  ref={(el) => {
                    fileRefs.current[i] = el;
                  }}
                  type="file"
                  accept={msg.tipo === "imagem" ? "image/*" : "audio/ogg,audio/mpeg,audio/mp3,audio/wav"}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void upload(i, file, msg.tipo === "imagem" ? "imagem" : "audio");
                    e.target.value = "";
                  }}
                />
              </div>
              {msg.tipo === "imagem" && (
                <>
                  <input
                    type="text"
                    ref={(el) => {
                      refs.current[`l-${i}`] = el;
                    }}
                    value={msg.conteudo ?? ""}
                    onChange={(e) => patch(i, { conteudo: e.target.value })}
                    placeholder="Legenda (opcional)…"
                    aria-label={`Legenda da imagem ${i + 1}`}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                  {varButtons(`l-${i}`, i)}
                </>
              )}
            </div>
          )}
        </section>
      ))}

      <Button
        type="button"
        variant="outline"
        onClick={() => setMensagens([...mensagens, { tipo: "texto", conteudo: "" }])}
        className="w-full gap-1 border-dashed"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {form.templateMode === "sequencia"
          ? mensagens.length === 0
            ? "Escrever a mensagem"
            : "Adicionar parte à sequência"
          : "Adicionar variação"}
      </Button>
      {form.templateMode === "sequencia" && mensagens.length > 1 && (
        <p className="text-xs text-muted-foreground">
          Sequência: cada contato recebe as {mensagens.length} partes, nesta ordem, com poucos segundos entre elas.
        </p>
      )}

      <MessageTemplatePicker
        open={pickerIndex !== null}
        hasMeta={false}
        onOpenChange={(next) => {
          if (!next) setPickerIndex(null);
        }}
        onSelect={(template) => {
          if (pickerIndex === null) return;
          // Texto salvo entra como cópia (sem vínculo com template da Meta).
          patch(pickerIndex, {
            tipo: "texto",
            conteudo: template.conteudo || "",
            template_name: undefined,
            template_language: undefined,
            template_variable_map: undefined,
          });
          setPickerIndex(null);
        }}
      />
    </div>
  );
}
