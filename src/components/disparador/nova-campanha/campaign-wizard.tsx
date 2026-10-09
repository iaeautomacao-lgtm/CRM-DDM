"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-fetch";
import { createClient } from "@/lib/supabase/client";
import { useDialogA11y } from "@/hooks/use-dialog-a11y";
import { trackAction } from "@/hooks/use-telemetry";
import { usePermission } from "@/hooks/use-permission";
import { campaignChannelGroupKey } from "@/lib/disparador/campaign-validation";
import { inferTeamFromChannels, keepChannelsInTeam } from "@/lib/disparador/channel-filter";
import { suggestImportColumnMap, type ImportColumnMap } from "@/lib/disparador/import-mapping";
import { parseImportCsv, summarizeImport, tableFromMatrix, type ParsedImportTable } from "@/lib/disparador/import-parse";
import { phoneKey } from "@/lib/disparador/phone-key";
import { resolveProviderThroughput, type RitmoResponse } from "@/lib/disparador/ritmo";
import {
  chunkImportRows,
  EMPTY_IMPORT_RESULTS,
  mergeImportResults,
  type ImportChunkResults,
} from "@/lib/disparador/import-chunks";
import { TEMPLATE_VALIDATION_COLUMNS } from "@/lib/disparador/template-validation";
import { importTokenField, type ReusedList } from "@/lib/disparador/import-client";
import { utmCpfKey, utmPhoneKey } from "@/lib/disparador/utm-links";
import { SAMPLE_PREVIEW_CONTACT } from "./message-preview";
import { StepConfiguracoes } from "./step-configuracoes";
import { StepConteudo, type CatalogTemplate, type PreviewTarget, type TemplateCatalogState } from "./step-conteudo";
import { StepOrigem, type AudiencePreviewState, type NamedChannel } from "./step-origem";
import { StepRevisao, type ServerCheck } from "./step-revisao";
import {
  WIZARD_STEPS,
  audienceModeOf,
  brasiliaDate,
  buildCampaignPayload,
  campaignWabaId,
  csvColumnsAvailable,
  emptyWizardForm,
  firstInvalidStep,
  forecastForForm,
  formFromCampaign,
  resetMessagesForChannelChange,
  selectedProvider,
  validateWizardStep,
  type SavedCampaign,
  type WizardContext,
  type WizardForm,
  type WizardStep,
} from "./wizard-rules";

export interface EditableCampaign extends SavedCampaign {
  id: string;
  import_draft_id?: string | null;
}

interface CampaignWizardProps {
  open: boolean;
  /** Campanha em edição (rascunho ou agendada); null = nova. */
  editing: EditableCampaign | null;
  accountId: string | null;
  channels: NamedChannel[];
  teams: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
  /**
   * Lista importada reaproveitada (POST /imports/[id]/reuse): campanha NOVA cujo público é o rascunho devolvido
   * pelo servidor (draft_id), tratado como base já importada — o mesmo caminho da edição com base existente.
   */
  reusedList?: ReusedList | null;
}

const DRAFT_VERSION = 2;

// Envia um bloco da base. Reenviar é seguro (o servidor reconhece os contatos
// que já gravou e o vínculo ignora repetidos), então falha de rede ou 5xx
// (reinício do Passenger, 504) tenta de novo até 3 vezes; erro 4xx não.
async function sendImportChunk(body: Record<string, unknown>): Promise<{ results?: Partial<ImportChunkResults> }> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    let retryable = false;
    let message = "Erro ao importar contatos";
    try {
      const res = await apiFetch("/api/disparador/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      message = json.error || message;
      retryable = res.status >= 500;
    } catch {
      message = "Sem resposta do servidor ao importar contatos";
      retryable = true;
    }
    if (!retryable || attempt >= maxAttempts) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

function draftKey(accountId: string | null): string | null {
  return accountId ? `disparador:campaign-draft:v${DRAFT_VERSION}:${accountId}` : null;
}

function isBlankForm(form: WizardForm): boolean {
  return !form.nome.trim() && !form.descricao.trim() && form.sessionIds.length === 0 && form.mensagens.length === 0;
}

const UTM_LINK_TYPE = "utm_link";

export function CampaignWizard({ open, editing, accountId, channels, teams, tags, onClose, onSaved, reusedList = null }: CampaignWizardProps) {
  // Lista reaproveitada só vale para campanha nova.
  const reuse = editing ? null : reusedList;
  const [form, setForm] = useState<WizardForm>(() => emptyWizardForm(new Date()));
  const update = useCallback((patch: Partial<WizardForm>) => setForm((prev) => ({ ...prev, ...patch })), []);
  const [step, setStep] = useState<WizardStep>(1);
  const [maxVisited, setMaxVisited] = useState<WizardStep>(1);
  const [errorStep, setErrorStep] = useState<WizardStep | null>(null);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [pendingDraft, setPendingDraft] = useState<WizardForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const canManage = usePermission("campaigns.manage");
  // Progresso do envio da base em blocos (linhas já enviadas / total).
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Base importada nesta sessão
  const [importFile, setImportFile] = useState<File | null>(null);
  // import_token (A15) do arquivo atual; null sem arquivo; vai em todos os blocos (importTokenField).
  const [importToken, setImportToken] = useState<string | null>(null);
  const [table, setTable] = useState<ParsedImportTable | null>(null);
  const [columnMap, setColumnMapState] = useState<ImportColumnMap>({});
  const [importLoading, setImportLoading] = useState(false);
  const [blacklistKeys, setBlacklistKeys] = useState<Set<string> | null>(null);
  const [blacklistStatus, setBlacklistStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");

  // UTM
  const [utmLoading, setUtmLoading] = useState(false);
  const [utmDone, setUtmDone] = useState(false);
  const [utmProgress, setUtmProgress] = useState<{ total: number; gerados: number; erros: number } | null>(null);

  // Público sem arquivo / base já vinculada
  const [audiencePreview, setAudiencePreview] = useState<AudiencePreviewState | null>(null);
  const [existingAudience, setExistingAudience] = useState<number | null>(null);

  // Catálogo de templates da WABA
  const [catalogRows, setCatalogRows] = useState<CatalogTemplate[]>([]);
  const [catalogKey, setCatalogKey] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [pendingChannels, setPendingChannels] = useState<string[] | null>(null);
  const lastGroupRef = useRef<string | null>(null);
  const [serverCheck, setServerCheck] = useState<ServerCheck>({ state: "idle" });

  const keepsExistingAudience =
    Boolean(reuse) ||
    Boolean(editing && (editing.audience_mode === "csv" || (editing.audience_mode == null && editing.import_draft_id)));

  // ---- Abertura / reinício ----
  useEffect(() => {
    if (!open) return;
    const at = new Date();
    setNow(at);
    setStep(1);
    setMaxVisited(1);
    setErrorStep(null);
    setImportFile(null);
    setTable(null);
    setColumnMapState({});
    setBlacklistKeys(null);
    setBlacklistStatus("idle");
    setUtmLoading(false);
    setUtmDone(false);
    setUtmProgress(null);
    setAudiencePreview(null);
    setExistingAudience(reuse ? reuse.contacts : null);
    setServerCheck({ state: "idle" });
    // Lista reaproveitada: o rascunho já existe no servidor (vínculos e VAR1–3 copiados pelo reuse).
    setDraftId(reuse ? reuse.draftId : crypto.randomUUID());
    if (editing) {
      const team = inferTeamFromChannels(editing.session_ids ?? [], channels);
      const next = formFromCampaign(editing, at, team);
      setForm(next);
      lastGroupRef.current = campaignChannelGroupKey(next.sessionIds, channels);
      setPendingDraft(null);
    } else {
      setForm(emptyWizardForm(at));
      lastGroupRef.current = null;
      const key = draftKey(accountId);
      let saved: WizardForm | null = null;
      if (key) {
        try {
          const raw = localStorage.getItem(key);
          saved = raw ? (JSON.parse(raw) as WizardForm) : null;
        } catch {
          saved = null;
        }
      }
      // Com lista reaproveitada não oferece restaurar o rascunho local (ele não tinha esse público).
      setPendingDraft(saved && !isBlankForm(saved) && !reuse ? saved : null);
    }
    // Reinicia só quando o modal abre (ou troca a campanha em edição).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id, reuse?.draftId]);

  // Rascunho local (só criação): guarda o formulário inteiro, menos o arquivo.
  useEffect(() => {
    const key = draftKey(accountId);
    if (!open || editing || reuse || pendingDraft || !key) return;
    try {
      if (isBlankForm(form)) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(form));
    } catch {
      // Armazenamento indisponível (modo privado): segue sem rascunho.
    }
  }, [open, editing, reuse, pendingDraft, accountId, form]);

  // Relógio da validação de agendamento (data no passado) e da previsão.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  // ---- Base importada ----
  const baseSummary = useMemo(() => (table ? summarizeImport(table, columnMap, null) : null), [table, columnMap]);
  const summary = useMemo(
    () => (table ? summarizeImport(table, columnMap, blacklistKeys) : null),
    [table, columnMap, blacklistKeys]
  );

  // Blacklist conferida no servidor (a lista não sai de lá).
  useEffect(() => {
    if (!baseSummary || baseSummary.rows.length === 0) {
      setBlacklistStatus("idle");
      return;
    }
    let cancelled = false;
    setBlacklistStatus("checking");
    const phones = baseSummary.rows.map((r) => r.phone);
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch("/api/disparador/audience/blacklist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones }),
        });
        const json = (await res.json()) as { blacklisted?: number[] };
        if (cancelled) return;
        if (!res.ok || !Array.isArray(json.blacklisted)) throw new Error();
        setBlacklistKeys(new Set(json.blacklisted.map((i) => phoneKey(phones[i] ?? ""))));
        setBlacklistStatus("ok");
      } catch {
        if (!cancelled) setBlacklistStatus("error");
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [baseSummary]);

  const setColumnMap = (next: ImportColumnMap) => {
    setColumnMapState(next);
    setUtmDone(false);
    // {{n}} de template ainda como valor fixo vazio → coluna VARn recém-mapeada.
    setForm((prev) => ({
      ...prev,
      mensagens: prev.mensagens.map((m) =>
        Array.isArray(m.template_variable_map)
          ? {
              ...m,
              template_variable_map: m.template_variable_map.map((entry, idx) =>
                entry.type === "static" && !entry.value.trim() && idx < 3 && next[(["var1", "var2", "var3"] as const)[idx]]
                  ? { type: "csv_var" as const, index: idx as 0 | 1 | 2 }
                  : entry
              ),
            }
          : m
      ),
    }));
  };

  const onFile = async (file: File) => {
    setImportLoading(true);
    setUtmDone(false);
    setUtmProgress(null);
    try {
      let parsed: ParsedImportTable;
      if (/\.xlsx?$/i.test(file.name)) {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        parsed = tableFromMatrix(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false }));
      } else {
        parsed = parseImportCsv(await file.text());
      }
      if (parsed.rows.length === 0) {
        toast.error("Arquivo vazio ou sem dados.");
        return;
      }
      setImportFile(file);
      // Um import_token por arquivo escolhido (A15): o mesmo em todos os blocos e nos reenvios.
      setImportToken(crypto.randomUUID());
      setTable(parsed);
      setBlacklistKeys(null);
      setColumnMap(suggestImportColumnMap(parsed.headers));
    } catch {
      toast.error("Não foi possível ler o arquivo.");
    } finally {
      setImportLoading(false);
    }
  };

  const clearImport = () => {
    setImportFile(null);
    setImportToken(null);
    setTable(null);
    setColumnMapState({});
    setBlacklistKeys(null);
    setUtmDone(false);
    setUtmProgress(null);
  };

  // ---- Contexto das regras ----
  const ctx: WizardContext = useMemo(() => {
    const provider = selectedProvider(form, { channels });
    const names = new Set(form.mensagens.map((m) => m.template_name).filter(Boolean));
    const key = provider === "meta" ? campaignWabaId(form, { channels }) : null;
    return {
      channels,
      importState: {
        hasFile: Boolean(importFile),
        loading: importLoading,
        validos: summary?.validos ?? 0,
        columnMap,
      },
      keepsExistingAudience: keepsExistingAudience && !importFile,
      templateRows: catalogRows.filter((r) => names.has(r.name)),
      // Catálogo com erro também conta como "pronto": vazio, a validação
      // acusa o template fora do catálogo em vez de esperar para sempre.
      catalogReady: provider !== "meta" || catalogKey === key,
      now,
    };
  }, [form, channels, importFile, importLoading, summary, columnMap, keepsExistingAudience, catalogRows, catalogKey, now]);

  const provider = selectedProvider(form, ctx);
  const wabaId = campaignWabaId(form, ctx);

  // ---- Catálogo de templates (Meta): WABA do canal selecionado ----
  useEffect(() => {
    if (!open || provider !== "meta" || !wabaId || !accountId) return;
    let cancelled = false;
    const key = wabaId;
    setCatalogError(null);
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("message_templates")
        .select(`id, category, ${TEMPLATE_VALIDATION_COLUMNS}`)
        .eq("account_id", accountId)
        // O canal selecionado já define a WABA. Não misture linhas legadas
        // sem WABA nem templates sincronizados para outro canal.
        .eq("waba_id", wabaId)
        .order("name", { ascending: true });
      if (cancelled) return;
      if (error) {
        setCatalogError("Não foi possível carregar os templates do número.");
        setCatalogRows([]);
      } else {
        setCatalogRows((data ?? []) as unknown as CatalogTemplate[]);
      }
      setCatalogKey(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, provider, wabaId, accountId]);

  const catalogState: TemplateCatalogState = useMemo(() => {
    const approved = catalogRows.filter((r) => (r.status ?? "").toUpperCase() === "APPROVED");
    return {
      loading: provider === "meta" && catalogKey !== wabaId,
      error: catalogError,
      // Campanha é restringida pelo canal/WABA. A allowlist de equipe é
      // destinada ao uso de templates por operadores no Inbox e não reduz
      // o catálogo de campanhas administrativas.
      available: approved,
      teamRestricted: false,
    };
  }, [catalogRows, provider, catalogKey, wabaId, catalogError]);

  // ---- Público sem arquivo (tabulação/conta inteira) ----
  const needsAudiencePreview = open && !importFile && !keepsExistingAudience && (form.tags.length > 0 || form.confirmAllContacts);
  const tagsKey = form.tags.join("|");
  useEffect(() => {
    if (!needsAudiencePreview) {
      setAudiencePreview(null);
      return;
    }
    let cancelled = false;
    setAudiencePreview({ loading: true });
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch("/api/disparador/audience/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags_filtro: tagsKey ? tagsKey.split("|") : [] }),
        });
        const json = await res.json();
        if (cancelled) return;
        setAudiencePreview(
          json?.ok ? { loading: false, total: json.total, blacklisted: json.blacklisted } : { loading: false, error: json?.error ?? "Não foi possível calcular o público." }
        );
      } catch {
        if (!cancelled) setAudiencePreview({ loading: false, error: "Não foi possível calcular o público." });
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsAudiencePreview, tagsKey]);

  // Edição com base já vinculada: mesmo cálculo do modal de início.
  useEffect(() => {
    if (!open || !editing || !keepsExistingAudience) return;
    let cancelled = false;
    apiFetch(`/api/disparador/campaigns/${editing.id}/audience`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled && json?.ok) setExistingAudience(Number(json.total) || 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, editing, keepsExistingAudience]);

  const [ritmoData, setRitmoData] = useState<RitmoResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch("/api/disparador/ritmo")
      .then((r) => r.json())
      .then((data: RitmoResponse) => {
        if (!cancelled && data?.ok) setRitmoData(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const knownContacts: number | null = importFile
    ? (summary?.validos ?? null)
    : keepsExistingAudience
      ? existingAudience
      : audiencePreview && !audiencePreview.loading && audiencePreview.total != null
        ? Math.max(0, audiencePreview.total - (audiencePreview.blacklisted ?? 0))
        : null;

  const throughput = useMemo(() => {
    if (!ritmoData) return undefined;
    return resolveProviderThroughput(ritmoData, provider);
  }, [ritmoData, provider]);

  const forecast = useMemo(
    () => forecastForForm(form, knownContacts, now, throughput),
    [form, knownContacts, now, throughput]
  );
  const forecastReason =
    knownContacts == null
      ? "Importe a base (ou escolha o público) no passo Origem para calcular quando o envio termina."
      : !form.dispatchMode
        ? "Escolha o modo de disparo."
        : form.endTime <= form.startTime
          ? "Ajuste a hora final para depois da hora inicial."
          : undefined;

  // ---- Canais ----
  const applyChannels = (next: string[], reset: boolean) => {
    const nextKey = campaignChannelGroupKey(next, channels);
    if (reset) {
      const nextProvider = nextKey === "waha" ? "waha" : nextKey?.startsWith("meta:") ? "meta" : null;
      setForm((prev) => ({ ...prev, sessionIds: next, mensagens: resetMessagesForChannelChange(prev.mensagens, nextProvider) }));
    } else {
      update({ sessionIds: next });
    }
    if (nextKey) lastGroupRef.current = nextKey;
  };

  const groupChanges = (next: string[]) => {
    const prevKey = campaignChannelGroupKey(form.sessionIds, channels) ?? lastGroupRef.current;
    const nextKey = campaignChannelGroupKey(next, channels);
    return Boolean(prevKey && nextKey && prevKey !== nextKey);
  };

  const onChannelsChange = (next: string[]) => {
    if (groupChanges(next) && form.mensagens.length > 0) setPendingChannels(next);
    else applyChannels(next, groupChanges(next));
  };

  const onTeamChange = (teamId: string) => {
    const kept = keepChannelsInTeam(form.sessionIds, channels, teamId);
    const removed = form.sessionIds.length - kept.length;
    setForm((prev) => ({ ...prev, teamId, sessionIds: kept }));
    if (removed > 0) {
      toast.info(`${removed} canal${removed === 1 ? "" : "is"} fora da equipe ${removed === 1 ? "saiu" : "saíram"} da seleção.`);
    }
  };

  // ---- UTM (links por CPF, VAR3 = URL destino) ----
  const utmVisible = Boolean(summary?.rows.some((r) => r.cpf) && summary.rows.some((r) => r.variables[2]));
  const handleGerarUTM = async () => {
    const source = summary?.rows ?? [];
    if (source.length === 0) return;
    if (!form.nome.trim()) {
      toast.error("Preencha o nome da campanha antes de gerar os links UTM.");
      return;
    }
    setUtmLoading(true);
    try {
      const groups = new Map<string, typeof source>();
      for (const c of source) {
        const url = c.variables[2] || "";
        if (!url || !c.cpf) continue;
        if (!groups.has(url)) groups.set(url, []);
        groups.get(url)!.push(c);
      }
      const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
      setUtmProgress({ total, gerados: 0, erros: 0 });
      const linkMap = new Map<string, string>();
      for (const [urlDestino, contacts] of groups) {
        const alunos = contacts.map((c) => c.cpf!);
        const res = await fetch("/api/disparador/utm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            canal: "whatsapp",
            campanha: form.nome.trim(),
            url_destino: urlDestino.startsWith("http") ? urlDestino : `https://${urlDestino}`,
            alunos,
          }),
        });
        if (!res.ok) {
          toast.error(
            res.status === 401 || res.status === 403
              ? "Serviço de UTM recusou a chave (confira UTM_API_KEY no servidor)"
              : `Falha ao gerar links UTM (HTTP ${res.status})`
          );
          setUtmProgress((p) => (p ? { ...p, erros: p.erros + alunos.length } : p));
          continue;
        }
        const data = (await res.json()) as { links?: Array<{ aluno_id: string; link_curto: string }> };
        const links = data.links ?? [];
        for (const l of links) linkMap.set(l.aluno_id, l.link_curto);
        const ok = links.filter((l) => l.link_curto).length;
        setUtmProgress((p) => (p ? { ...p, gerados: p.gerados + ok, erros: p.erros + alunos.length - ok } : p));
      }
      if (linkMap.size === 0) {
        toast.error("Nenhum link UTM foi gerado. Verifique os CPFs e a URL em VAR3.");
        return;
      }
      // disparador_utm_links alimenta o envio: draft_id até a campanha
      // existir (o POST relinka), campaign_id na edição.
      const rows = source
        .filter((c) => c.cpf && linkMap.has(c.cpf))
        .map((c) => ({
          campaign_id: editing?.id ?? null,
          draft_id: editing ? null : draftId,
          phone_normalized: utmPhoneKey(c.phone),
          cpf: utmCpfKey(c.cpf),
          link_curto: linkMap.get(c.cpf!)!,
        }))
        .filter((r) => r.phone_normalized || r.cpf);
      const supabase = createClient();
      const idColumn = editing ? "campaign_id" : "draft_id";
      await supabase.from("disparador_utm_links").delete().eq(idColumn, editing?.id ?? draftId);
      if (rows.length > 0) {
        const { error } = await supabase.from("disparador_utm_links").insert(rows);
        if (error) throw error;
      }
      setUtmDone(true);
      toast.success(`${linkMap.size} links UTM gerados.`);
    } catch (err) {
      toast.error(`Erro ao gerar links UTM: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUtmLoading(false);
    }
  };

  // ---- Prévia ----
  const previewTargets: PreviewTarget[] = useMemo(() => {
    if (summary && summary.rows.length > 0) {
      return summary.rows.slice(0, 3).map((row, idx) => ({
        key: `csv-${idx}`,
        titulo: `${row.name ?? "Contato"} · ${row.phone}`,
        contact: {
          name: columnMap.name ? (row.name ?? null) : undefined,
          phone: row.phone,
          cpf: row.cpf ?? null,
          company: undefined,
          csvVars: row.variables,
          utmLink: utmDone ? undefined : null,
        },
      }));
    }
    return [
      {
        key: "exemplo",
        titulo: `${SAMPLE_PREVIEW_CONTACT.name} (exemplo)`,
        contact: {
          ...SAMPLE_PREVIEW_CONTACT,
          csvVars: keepsExistingAudience ? undefined : [],
          utmLink: keepsExistingAudience ? undefined : null,
        },
      },
    ];
  }, [summary, columnMap, utmDone, keepsExistingAudience]);

  // ---- Navegação ----
  const stepErrors = (s: WizardStep) => validateWizardStep(s, form, ctx);
  const currentErrors = errorStep === step ? stepErrors(step) : [];
  const reviewErrors = step === 4 ? stepErrors(4) : [];

  const goTo = (target: WizardStep) => {
    if (target <= step) {
      setStep(target);
      setErrorStep(null);
      return;
    }
    const bad = firstInvalidStep(target, form, ctx);
    if (bad) {
      setStep(bad);
      setErrorStep(bad);
      toast.error(stepErrors(bad)[0]);
      return;
    }
    setStep(target);
    setErrorStep(null);
    setMaxVisited((m) => (target > m ? target : m));
  };

  // Revisão: as mesmas regras de novo, no servidor (sem gravar nada).
  const payloadKey = JSON.stringify(buildCampaignPayload(form, ctx, null));
  const reviewOk = step === 4 && reviewErrors.length === 0;
  useEffect(() => {
    if (!reviewOk) {
      setServerCheck({ state: "idle" });
      return;
    }
    let cancelled = false;
    setServerCheck({ state: "checking" });
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch("/api/disparador/campaigns?dry_run=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadKey,
        });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        setServerCheck(res.ok ? { state: "ok", status: json.status } : { state: "error", error: json.error ?? `HTTP ${res.status}` });
      } catch {
        if (!cancelled) setServerCheck({ state: "error", error: "sem resposta do servidor" });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reviewOk, payloadKey]);

  const submit = async () => {
    // Criar/editar campanha: campaigns.manage (o servidor também recusa sem ela).
    if (submitting || !canManage) return;
    const bad = firstInvalidStep(4, form, ctx);
    if (bad) {
      setStep(bad);
      setErrorStep(bad);
      toast.error(stepErrors(bad)[0]);
      return;
    }
    if (form.mensagens.some((m) => m.template_variable_map?.some((e) => e.type === UTM_LINK_TYPE)) && !utmDone && importFile) {
      toast.warning('Uma variável usa "Link UTM", mas os links ainda não foram gerados neste arquivo. Esses contatos sairão sem link.');
    }
    setSubmitting(true);
    try {
      if (importFile) {
        // A base já está lida no navegador: vai em blocos JSON (5.000 linhas)
        // em vez do arquivo inteiro, que estourava o limite de corpo (10 MB)
        // do middleware. Linhas inválidas/duplicadas/da blacklist já foram
        // descartadas no resumo; o servidor confere de novo cada bloco.
        const chunks = chunkImportRows((summary?.rows ?? []).map((row) => row.raw));
        const totalRows = chunks.reduce((n, c) => n + c.length, 0);
        let r: ImportChunkResults = { ...EMPTY_IMPORT_RESULTS };
        setImportProgress({ done: 0, total: totalRows });
        let sent = 0;
        for (let i = 0; i < chunks.length; i++) {
          const json = await sendImportChunk({
            rows: chunks[i],
            chunk_index: i,
            total_chunks: chunks.length,
            ...(editing ? { campaign_id: editing.id } : { draft_id: draftId }),
            column_map: columnMap,
            mapping_confirmed: true,
            ...importTokenField(importToken),
          });
          r = mergeImportResults(r, json.results);
          sent += chunks[i].length;
          setImportProgress({ done: sent, total: totalRows });
        }
        const invalidos = r.invalidos + (summary?.invalidos ?? 0);
        const duplicados = r.duplicados + (summary?.duplicados ?? 0);
        toast.success(
          [`${r.importados} importados`, duplicados ? `${duplicados} duplicados` : "", invalidos ? `${invalidos} inválidos` : ""]
            .filter(Boolean)
            .join(" · ")
        );
        if (r.variaveis_falhas > 0) {
          toast.error(`${r.variaveis_falhas} valores de VAR1–VAR3 não foram salvos. Importe o arquivo de novo antes de iniciar.`, {
            duration: 15000,
          });
        }
        trackAction("csv_imported", { total_rows: r.importados + duplicados + invalidos });
      }

      const payload = buildCampaignPayload(form, ctx, editing ? null : draftId);
      const res = editing
        ? await apiFetch(`/api/disparador/campaigns/${editing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiFetch("/api/disparador/campaigns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Erro ao salvar a campanha");
      const status = json.status as string | undefined;
      toast.success(
        status === "agendado" ? "Campanha agendada!" : editing ? "Campanha atualizada!" : "Campanha salva como rascunho."
      );
      trackAction(editing ? "campaign_updated" : "campaign_created", {
        campaign_id: editing?.id ?? json.id,
        nome: form.nome,
        total_contatos: knownContacts,
      });
      const key = draftKey(accountId);
      if (!editing && key) {
        try {
          localStorage.removeItem(key);
        } catch {
          // ignore
        }
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar a campanha");
    } finally {
      setSubmitting(false);
      setImportProgress(null);
    }
  };

  const a11y = useDialogA11y(open);
  if (!open) return null;

  const channelNames = channels.filter((c) => form.sessionIds.includes(c.id)).map((c) => c.name);
  const audienceMode = audienceModeOf(form, ctx);
  const audienceLabel =
    audienceMode === "csv"
      ? importFile
        ? `base importada (${importFile.name})${form.tags.length ? ` com a tabulação ${form.tags.join(", ")}` : ""}`
        : reuse
          ? `lista “${reuse.name}”`
          : "base já importada na campanha"
      : audienceMode === "tags"
        ? `contatos com a tabulação ${form.tags.join(", ")}`
        : "todos os contatos da conta";
  const submitLabel = form.startMode === "agendar" ? "Agendar campanha" : editing ? "Salvar alterações" : "Salvar rascunho";

  return (
    <div className="fixed inset-0 z-50 flex animate-ddm-fade items-stretch justify-center bg-scrim p-0 sm:items-center sm:p-4">
      <div
        ref={a11y.ref}
        tabIndex={-1}
        onKeyDown={a11y.onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nc-title"
        className="flex h-full w-full max-w-5xl animate-ddm-pop flex-col overflow-hidden bg-background shadow-overlay outline-none sm:h-auto sm:max-h-[92vh] sm:rounded-[10px] sm:border sm:border-border"
      >
        {/* Barra de passos (protótipo): número em círculo, separador e o passo atual em destaque. */}
        <header className="shrink-0 border-b border-border bg-card px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <h3 id="nc-title" className="m-0 shrink-0 font-sans text-sm font-semibold text-foreground">
              {editing ? `Editar campanha${editing.status === "agendado" ? " agendada" : ""}` : "Nova campanha"}
            </h3>
            <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:block" />
            <nav aria-label="Passos do assistente" className="min-w-0 flex-1">
              <ol className="m-0 flex list-none items-center gap-1.5 overflow-x-auto p-0 [scrollbar-width:none]">
                {WIZARD_STEPS.map(({ step: s, label }, i) => {
                  const current = step === s;
                  const done = s < step;
                  return (
                    <li key={s} className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => goTo(s)}
                        aria-current={current ? "step" : undefined}
                        className={cn(
                          "flex h-8 items-center gap-2 rounded-[6px] pl-1.5 pr-2.5 transition-colors",
                          current ? "bg-selected" : "hover:bg-surface-hover",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-[22px] items-center justify-center rounded-full text-[11.5px] font-bold tabular-nums",
                            current
                              ? "bg-primary text-primary-foreground"
                              : done
                                ? "bg-success-soft text-success"
                                : s <= maxVisited
                                  ? "bg-surface-3 text-foreground"
                                  : "bg-surface-3 text-muted-foreground",
                          )}
                        >
                          {done ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : s}
                        </span>
                        <span
                          className={cn(
                            "whitespace-nowrap text-[13px]",
                            current ? "font-semibold text-foreground" : "font-medium text-foreground-2",
                          )}
                        >
                          {label}
                        </span>
                      </button>
                      {i < WIZARD_STEPS.length - 1 && <span aria-hidden="true" className="h-px w-5 bg-border-strong" />}
                    </li>
                  );
                })}
              </ol>
            </nav>
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="Fechar" className="shrink-0 text-muted-foreground">
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </header>

        {pendingDraft && !editing && (
          <div className="mx-4 mt-4 flex shrink-0 animate-ddm-fade flex-wrap items-center justify-between gap-3 rounded-lg bg-warning-soft px-3.5 py-2.5 text-[12.5px] text-foreground sm:mx-6">
            <span>Rascunho anterior encontrado (o arquivo da base precisa ser escolhido de novo).</span>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const key = draftKey(accountId);
                  if (key) localStorage.removeItem(key);
                  setPendingDraft(null);
                }}
              >
                Descartar
              </Button>
              <Button
                type="button"
                onClick={() => {
                  // Datas salvas podem ter ficado no passado: a validação avisa.
                  setForm({ ...emptyWizardForm(now), ...pendingDraft });
                  lastGroupRef.current = campaignChannelGroupKey(pendingDraft.sessionIds ?? [], channels);
                  setPendingDraft(null);
                }}
              >
                Restaurar
              </Button>
            </div>
          </div>
        )}

        {currentErrors.length > 0 && (
          <div role="alert" className="mx-4 mt-4 shrink-0 animate-ddm-fade rounded-lg bg-danger-soft px-3.5 py-2.5 text-[12.5px] text-foreground sm:mx-6">
            <p className="m-0 mb-1 flex items-center gap-1.5 font-semibold text-danger">
              <AlertTriangle className="size-3.5" aria-hidden="true" /> Corrija antes de avançar:
            </p>
            <ul className="m-0 list-disc space-y-0.5 pl-5">
              {currentErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div key={step} className="min-h-0 flex-1 animate-ddm-fade overflow-y-auto px-4 py-5 sm:px-6">
          {step === 1 && (
            <StepOrigem
              form={form}
              update={update}
              teams={teams}
              channels={channels}
              onTeamChange={onTeamChange}
              onChannelsChange={onChannelsChange}
              tags={tags}
              importCtl={{
                fileName: importFile?.name ?? null,
                loading: importLoading,
                headers: table?.headers ?? [],
                columnMap,
                setColumnMap,
                summary,
                validBeforeBlacklist: baseSummary?.validos ?? 0,
                blacklistStatus,
                onFile: (f) => void onFile(f),
                clear: clearImport,
              }}
              keepsExistingAudience={ctx.keepsExistingAudience}
              reusedListName={reuse && !importFile ? reuse.name : null}
              audiencePreview={audiencePreview}
              utm={{ visible: utmVisible, loading: utmLoading, done: utmDone, progress: utmProgress, onGenerate: () => void handleGerarUTM() }}
            />
          )}
          {step === 2 && (
            <StepConfiguracoes
              form={form}
              update={update}
              provider={provider}
              todayBrasilia={brasiliaDate(now)}
              knownContacts={knownContacts}
              forecast={forecast}
              forecastUnavailableReason={forecastReason}
              errorsVisible={errorStep === 2}
            />
          )}
          {step === 3 && (
            <StepConteudo
              form={form}
              update={update}
              provider={provider}
              catalog={catalogState}
              catalogRows={catalogRows}
              columnMap={columnMap}
              hasFile={Boolean(importFile)}
              csvAvailable={csvColumnsAvailable(ctx)}
              // O reuse não copia links UTM: com lista reaproveitada, só depois de gerar neste arquivo.
              utmAvailable={utmDone || (ctx.keepsExistingAudience && !reuse)}
              previewTargets={previewTargets}
            />
          )}
          {step === 4 && (
            <StepRevisao
              form={form}
              provider={provider}
              channelNames={channelNames}
              audienceLabel={audienceLabel}
              audienceCount={knownContacts}
              forecast={forecast}
              forecastUnavailableReason={forecastReason}
              columnMap={columnMap}
              errors={reviewErrors}
              serverCheck={serverCheck}
            />
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-card px-4 py-3 sm:px-6">
          <span className="text-xs tabular-nums text-muted-foreground">
            Passo {step} de {WIZARD_STEPS.length}
          </span>
          <span className="flex-1" />
          <Button type="button" variant="outline" onClick={() => (step === 1 ? onClose() : goTo((step - 1) as WizardStep))}>
            {step === 1 ? "Cancelar" : "Voltar"}
          </Button>
          {step < 4 ? (
            <Button type="button" onClick={() => goTo((step + 1) as WizardStep)}>
              Avançar
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={!canManage || submitting || reviewErrors.length > 0 || serverCheck.state === "error"}
            >
              {submitting && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              {submitting
                ? importProgress
                  ? `Importando contatos… ${importProgress.done.toLocaleString("pt-BR")} de ${importProgress.total.toLocaleString("pt-BR")}`
                  : "Salvando…"
                : submitLabel}
            </Button>
          )}
        </footer>
      </div>

      <AlertDialog open={pendingChannels !== null} onOpenChange={(o) => !o && setPendingChannels(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trocar o tipo de canal?</AlertDialogTitle>
            <AlertDialogDescription>
              Os templates são da conta WhatsApp Business (WABA) de cada número. Mudar entre Meta e WAHA, ou para um número de
              outra WABA, apaga os templates e o mapeamento de variáveis já escolhidos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Manter canais</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingChannels) applyChannels(pendingChannels, true);
                setPendingChannels(null);
              }}
            >
              Trocar e limpar conteúdo
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
