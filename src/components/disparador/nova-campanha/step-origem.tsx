"use client";

import { AlertTriangle, CheckCircle2, Download, Info, Loader2, Search, Upload, Users, X } from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { validateCampaignChannels } from "@/lib/disparador/campaign-validation";
import { channelOptionState, channelsForTeam, type WizardChannel } from "@/lib/disparador/channel-filter";
import type { ImportColumnMap } from "@/lib/disparador/import-mapping";
import type { ImportSummary } from "@/lib/disparador/import-parse";
import type { WizardForm } from "./wizard-rules";

export interface NamedChannel extends WizardChannel {
  name: string;
}

export interface ImportController {
  fileName: string | null;
  loading: boolean;
  headers: string[];
  columnMap: ImportColumnMap;
  setColumnMap: (map: ImportColumnMap) => void;
  summary: ImportSummary | null;
  /** Válidos/únicos antes de aplicar a blacklist. */
  validBeforeBlacklist: number;
  /** Conferência da blacklist no servidor em andamento / falhou. */
  blacklistStatus: "idle" | "checking" | "ok" | "error";
  onFile: (file: File) => void;
  clear: () => void;
}

export interface AudiencePreviewState {
  loading: boolean;
  total?: number;
  blacklisted?: number;
  error?: string;
}

export interface UtmController {
  visible: boolean;
  loading: boolean;
  done: boolean;
  progress: { total: number; gerados: number; erros: number } | null;
  onGenerate: () => void;
}

const COLUMN_FIELDS: Array<{ key: keyof ImportColumnMap; label: string; required?: boolean }> = [
  { key: "phone", label: "Telefone", required: true },
  { key: "name", label: "Nome" },
  { key: "cpf", label: "CPF" },
  { key: "var1", label: "VAR1" },
  { key: "var2", label: "VAR2" },
  { key: "var3", label: "VAR3" },
];

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div
      className={cn(
        "rounded-md p-2 text-center",
        tone === "ok" ? "bg-success-soft" : tone === "bad" ? "bg-danger-soft" : tone === "warn" ? "bg-warning-soft" : "bg-surface-3"
      )}
    >
      <p
        className={cn(
          "text-base font-bold",
          tone === "ok" ? "text-success" : tone === "bad" ? "text-danger" : tone === "warn" ? "text-warning" : "text-foreground"
        )}
      >
        {value.toLocaleString("pt-BR")}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export function StepOrigem({
  form,
  update,
  teams,
  channels,
  onTeamChange,
  onChannelsChange,
  tags,
  importCtl,
  keepsExistingAudience,
  reusedListName = null,
  audiencePreview,
  utm,
}: {
  form: WizardForm;
  update: (patch: Partial<WizardForm>) => void;
  teams: Array<{ id: string; name: string }>;
  channels: NamedChannel[];
  onTeamChange: (teamId: string) => void;
  onChannelsChange: (ids: string[]) => void;
  tags: Array<{ id: string; name: string }>;
  importCtl: ImportController;
  keepsExistingAudience: boolean;
  /** Nome da lista importada reaproveitada como público (campanha nova). */
  reusedListName?: string | null;
  audiencePreview: AudiencePreviewState | null;
  utm: UtmController;
}) {
  const [tagSearch, setTagSearch] = useState("");
  const offered = channelsForTeam(channels, form.teamId);
  // Canal desabilitado de uma campanha antiga continua na lista para poder
  // ser desmarcado.
  const legacySelected = channels.filter((c) => form.sessionIds.includes(c.id) && !offered.includes(c));
  const channelCheck = validateCampaignChannels(form.sessionIds, channels);
  const summary = importCtl.summary;
  const hasFile = Boolean(importCtl.fileName);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="nc-nome" className="text-xs font-medium text-muted-foreground">
            Nome da campanha
          </label>
          <input
            id="nc-nome"
            type="text"
            maxLength={120}
            value={form.nome}
            onChange={(e) => update({ nome: e.target.value })}
            placeholder="Ex.: Cobrança outubro — faixa 30 dias"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="nc-descricao" className="text-xs font-medium text-muted-foreground">
            Descrição (opcional)
          </label>
          <textarea
            id="nc-descricao"
            value={form.descricao}
            onChange={(e) => update({ descricao: e.target.value })}
            className="h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
      </section>

      {/* Equipe → canais */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Equipe e canal</h4>
        <div className="space-y-1">
          <label id="nc-equipe-label" className="text-xs font-medium text-muted-foreground">
            Equipe
          </label>
          <Select value={form.teamId || "__all__"} onValueChange={(v) => onTeamChange(!v || v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-9 w-full" aria-labelledby="nc-equipe-label">
              <SelectValue>
                {(v: string) => (v === "__all__" ? "Todas as equipes" : (teams.find((t) => t.id === v)?.name ?? v))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas as equipes</SelectItem>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Mostra só os canais da equipe e, se ela tiver templates liberados, só esses templates.
          </p>
        </div>

        <div className="space-y-1">
          <p id="nc-canais-label" className="text-xs font-medium text-muted-foreground">
            Canal
          </p>
          <div role="group" aria-labelledby="nc-canais-label" className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
            {offered.length === 0 && legacySelected.length === 0 ? (
              <p className="col-span-full rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                {channels.length === 0 ? "Nenhum canal de WhatsApp conectado." : "Nenhum canal habilitado para esta equipe."}
              </p>
            ) : (
              [...offered, ...legacySelected].map((c) => {
                const state = channelOptionState(c, form.sessionIds, channels);
                const checked = form.sessionIds.includes(c.id);
                return (
                  <label
                    key={c.id}
                    title={state.disabled ? state.reason : undefined}
                    className={cn(
                      "flex items-start gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                      checked ? "border-primary bg-primary/5" : "border-border",
                      state.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/50"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={checked}
                      disabled={state.disabled}
                      onChange={(e) =>
                        onChannelsChange(
                          e.target.checked ? [...form.sessionIds, c.id] : form.sessionIds.filter((id) => id !== c.id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{c.name}</span>
                      <span className="block text-muted-foreground">
                        {c.provider === "meta" ? "Oficial (Meta) · só templates aprovados" : "WAHA · texto, IA, imagem e áudio"}
                        {c.habilitado === false && " · desabilitado"}
                      </span>
                      {state.disabled && <span className="mt-0.5 block text-muted-foreground">{state.reason}</span>}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <p className="flex items-start gap-1 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            Uma campanha usa um tipo de canal: números oficiais (Meta) de uma mesma conta WhatsApp Business, ou sessões WAHA.
          </p>
          {form.sessionIds.length > 0 && !channelCheck.ok && (
            <p role="alert" className="flex items-start gap-1.5 rounded-md bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {channelCheck.error}
            </p>
          )}
        </div>
      </section>

      {/* Público */}
      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Importação do arquivo</h4>
          <p className="text-xs text-muted-foreground">
            CSV ou XLSX. Telefone é obrigatório; nome, CPF e VAR1–VAR3 são opcionais e podem virar variáveis da mensagem.
          </p>
        </div>

        {keepsExistingAudience && !hasFile && (
          <p className="flex gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {reusedListName
              ? `Público: lista “${reusedListName}”, já importada. Envie um arquivo só se quiser substituí-la.`
              : "Esta campanha mantém a base já importada. Envie um arquivo só se quiser substituí-la."}
          </p>
        )}

        {!hasFile ? (
          <label className="flex h-28 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50 hover:border-primary/50 hover:bg-muted/30">
            <Upload className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm text-muted-foreground">Clique para escolher o arquivo</span>
            <span className="text-xs text-muted-foreground">.csv, .xlsx, .xls, .txt</span>
            <input
              type="file"
              accept=".csv,.xlsx,.xls,.txt"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importCtl.onFile(file);
                e.target.value = "";
              }}
            />
          </label>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
            <span className="truncate font-medium text-foreground">{importCtl.fileName}</span>
            <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={importCtl.clear}>
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Trocar arquivo
            </Button>
          </div>
        )}

        {!hasFile && (
          <a
            href="/modelo_importacao_disparador.csv"
            download
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 gap-1.5 text-xs")}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Baixar modelo de exemplo
          </a>
        )}

        {importCtl.loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Lendo arquivo…
          </p>
        )}

        {hasFile && importCtl.headers.length > 0 && (
          <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
            <p className="text-xs font-medium text-foreground">Mapeamento de colunas</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {COLUMN_FIELDS.map((field) => (
                <div key={field.key} className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
                  <span className="text-xs text-foreground">
                    {field.label}
                    {field.required && <span className="text-danger"> *</span>}
                  </span>
                  <Select
                    value={importCtl.columnMap[field.key] ?? "__none__"}
                    onValueChange={(val) => {
                      const next = { ...importCtl.columnMap };
                      if (!val || val === "__none__") delete next[field.key];
                      else next[field.key] = val;
                      importCtl.setColumnMap(next);
                    }}
                  >
                    <SelectTrigger className="h-8 w-full text-xs" aria-label={`Coluna da planilha para ${field.label}`}>
                      <SelectValue>{(v: string) => (v === "__none__" ? "Nenhuma" : v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Nenhuma</SelectItem>
                      {importCtl.headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              VAR1–VAR3 ficam disponíveis no passo Conteúdo para preencher as variáveis de cada template.
            </p>
          </div>
        )}

        {summary && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Linhas" value={summary.total} />
              <Stat label="Válidos" value={summary.validos} tone="ok" />
              <Stat label="Duplicados" value={summary.duplicados} tone={summary.duplicados > 0 ? "warn" : undefined} />
              <Stat label="Inválidos" value={summary.invalidos} tone={summary.invalidos > 0 ? "bad" : undefined} />
              <Stat label="Na blacklist" value={summary.blacklist} tone={summary.blacklist > 0 ? "bad" : undefined} />
            </div>
            <p className="text-xs text-muted-foreground">
              Duplicados = mesmo telefone (com ou sem o 9) ou mesmo CPF já visto no arquivo. Inválidos = sem telefone com DDD.
              {importCtl.blacklistStatus === "checking" && " Conferindo a blacklist…"}
              {importCtl.blacklistStatus === "error" &&
                " Não foi possível conferir a blacklist agora — ela continua sendo aplicada no envio."}
            </p>
            {importCtl.blacklistStatus === "ok" && summary.blacklist > 0 && (
              <p className="flex items-start gap-2 rounded-md bg-warning-soft p-2 text-xs text-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  De <strong>{importCtl.validBeforeBlacklist.toLocaleString("pt-BR")}</strong> contatos válidos,{" "}
                  <strong>{summary.blacklist.toLocaleString("pt-BR")}</strong>{" "}
                  {summary.blacklist === 1 ? "está" : "estão"} na Blacklist e{" "}
                  {summary.blacklist === 1 ? "será removido" : "serão removidos"} automaticamente.
                  O disparo seguirá com <strong>{summary.validos.toLocaleString("pt-BR")}</strong>{" "}
                  {summary.validos === 1 ? "contato elegível" : "contatos elegíveis"}.
                </span>
              </p>
            )}
            {summary.rows.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-max text-xs">
                  <caption className="sr-only">Primeiros contatos da base com o mapeamento aplicado</caption>
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Telefone</th>
                      {importCtl.columnMap.name && <th className="px-3 py-2 text-left font-medium">Nome</th>}
                      {importCtl.columnMap.cpf && <th className="px-3 py-2 text-left font-medium">CPF</th>}
                      {(["var1", "var2", "var3"] as const).map(
                        (k, i) =>
                          importCtl.columnMap[k] && (
                            <th key={k} className="px-3 py-2 text-left font-medium">
                              VAR{i + 1}
                            </th>
                          )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.slice(0, 5).map((row, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="px-3 py-2 font-mono">{row.phone}</td>
                        {importCtl.columnMap.name && <td className="px-3 py-2">{row.name}</td>}
                        {importCtl.columnMap.cpf && <td className="px-3 py-2 font-mono">{row.cpf}</td>}
                        {(["var1", "var2", "var3"] as const).map(
                          (k, j) =>
                            importCtl.columnMap[k] && (
                              <td key={k} className="px-3 py-2">
                                {row.variables[j]}
                              </td>
                            )
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {utm.visible && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3">
            <div>
              <p className="text-xs font-medium text-foreground">Links de rastreamento (UTM)</p>
              <p className="text-xs text-muted-foreground">
                Gera um link curto por contato a partir do CPF e da URL em VAR3.
                {utm.progress &&
                  ` ${utm.progress.gerados} gerado${utm.progress.gerados === 1 ? "" : "s"}${utm.progress.erros ? ` · ${utm.progress.erros} com erro` : ""}.`}
              </p>
            </div>
            <Button type="button" size="sm" variant={utm.done ? "outline" : "default"} onClick={utm.onGenerate} disabled={utm.loading} className="h-8 gap-1.5 text-xs">
              {utm.loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Gerando…
                </>
              ) : utm.done ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" /> Gerado
                </>
              ) : (
                "Gerar UTM"
              )}
            </Button>
          </div>
        )}

        {/* Tabulação: filtro da base ou público sem arquivo */}
        <div className="space-y-1">
          <p id="nc-tags-label" className="text-xs font-medium text-muted-foreground">
            Filtrar por tabulação (opcional)
          </p>
          <p className="text-xs text-muted-foreground">
            {hasFile || keepsExistingAudience
              ? "Envia só para os contatos da base que têm a tabulação."
              : "Sem arquivo, envia para os contatos da conta com a tabulação."}
          </p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              aria-label="Buscar tabulação"
              placeholder="Buscar tabulação…"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div role="group" aria-labelledby="nc-tags-label" className="flex max-h-24 flex-wrap gap-2 overflow-y-auto rounded-md border border-border p-2">
            {tags.length === 0 ? (
              <span className="text-xs text-muted-foreground">Nenhuma tabulação cadastrada.</span>
            ) : (
              tags
                .filter((t) => t.name.toLowerCase().includes(tagSearch.toLowerCase()))
                .map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-center gap-1.5 rounded border border-border bg-muted/50 px-2.5 py-1 text-xs hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={form.tags.includes(t.name)}
                      onChange={(e) =>
                        update({ tags: e.target.checked ? [...form.tags, t.name] : form.tags.filter((n) => n !== t.name) })
                      }
                    />
                    {t.name}
                  </label>
                ))
            )}
          </div>
        </div>

        {!hasFile && !keepsExistingAudience && (
          <>
            {audiencePreview && (
              audiencePreview.loading || audiencePreview.error ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  {audiencePreview.loading ? "Calculando o público…" : audiencePreview.error}
                </p>
              ) : (audiencePreview.blacklisted ?? 0) > 0 ? (
                <p className="flex items-start gap-2 rounded-md bg-warning-soft p-2 text-xs text-foreground" aria-live="polite">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    De <strong>{(audiencePreview.total ?? 0).toLocaleString("pt-BR")}</strong> contatos válidos,{" "}
                    <strong>{(audiencePreview.blacklisted ?? 0).toLocaleString("pt-BR")}</strong>{" "}
                    {(audiencePreview.blacklisted ?? 0) === 1 ? "está" : "estão"} na Blacklist e{" "}
                    {(audiencePreview.blacklisted ?? 0) === 1 ? "será removido" : "serão removidos"} automaticamente.
                    O disparo seguirá com{" "}
                    <strong>{Math.max(0, (audiencePreview.total ?? 0) - (audiencePreview.blacklisted ?? 0)).toLocaleString("pt-BR")}</strong>{" "}
                    contatos elegíveis.
                  </span>
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  Público: {(audiencePreview.total ?? 0).toLocaleString("pt-BR")} contatos. Nenhum está na Blacklist.
                </p>
              )
            )}
            {form.tags.length === 0 && (
              <label className="flex cursor-pointer items-start gap-2 rounded-md bg-warning-soft p-3 text-xs text-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.confirmAllContacts}
                  onChange={(e) => update({ confirmAllContacts: e.target.checked })}
                />
                <span>
                  Nenhum arquivo e nenhuma tabulação. <strong>Confirmo que quero enviar para todos os contatos da conta.</strong>
                </span>
              </label>
            )}
          </>
        )}
      </section>
    </div>
  );
}
