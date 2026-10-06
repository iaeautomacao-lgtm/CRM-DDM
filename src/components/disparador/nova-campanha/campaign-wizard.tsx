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
import { campaignChannelGroupKey } from "@/lib/disparador/campaign-validation";
import { inferTeamFromChannels, keepChannelsInTeam } from "@/lib/disparador/channel-filter";
import { suggestImportColumnMap, type ImportColumnMap } from "@/lib/disparador/import-mapping";
import { parseImportCsv, summarizeImport, tableFromMatrix, type ParsedImportTable } from "@/lib/disparador/import-parse";
import { phoneKey } from "@/lib/disparador/phone-key";
import { TEMPLATE_VALIDATION_COLUMNS } from "@/lib/disparador/template-validation";
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
}

const DRAFT_VERSION = 2;

function draftKey(accountId: string | null): string | null {
  return accountId ? `disparador:campaign-draft:v${DRAFT_VERSION}:${accountId}` : null;
}

function isBlankForm(form: WizardForm): boolean {
  return !form.nome.trim() && !form.descricao.trim() && form.sessionIds.length === 0 && form.mensagens.length === 0;
}

const UTM_LINK_TYPE = "utm_link";

export function CampaignWizard({ open, editing, accountId, channels, teams, tags, onClose, onSaved }: CampaignWizardProps) {
  const [form, setForm] = useState<WizardForm>(() => emptyWizardForm(new Date()));
  const update = useCallback((patch: Partial<WizardForm>) => setForm((prev) => ({ ...prev, ...patch })), []);
  const [step, setStep] = useState<WizardStep>(1);
  const [maxVisited, setMaxVisited] = useState<WizardStep>(1);
  const [errorStep, setErrorStep] = useState<WizardStep | null>(null);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [pendingDraft, setPendingDraft] = useState<WizardForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Base importada nesta sessão
  const [importFile, setImportFile] = useState<File | null>(null);
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
  const [allowedIds, setAllowedIds] = useState<Set<string> | null>(null);
  const [catalogKey, setCatalogKey] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [pendingChannels, setPendingChannels] = useState<string[] | null>(null);
  const lastGroupRef = useRef<string | null>(null);
  const [serverCheck, setServerCheck] = useState<ServerCheck>({ state: "idle" });

  const keepsExistingAudience = Boolean(
    editing && (editing.audience_mode === "csv" || (editing.audience_mode == null && editing.import_draft_id))
  );

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
    setExistingAudience(null);
    setServerCheck({ state: "idle" });
    setDraftId(crypto.randomUUID());
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
      setPendingDraft(saved && !isBlankForm(saved) ? saved : null);
    }
    // Reinicia só quando o modal abre (ou troca a campanha em edição).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  // Rascunho local (só criação): guarda o formulário inteiro, menos o arquivo.
  useEffect(() => {
    const key = draftKey(accountId);
    if (!open || editing || pendingDraft || !key) return;
    try {
      if (isBlankForm(form)) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(form));
    } catch {
      // Armazenamento indisponível (modo privado): segue sem rascunho.
    }
  }, [open, editing, pendingDraft, accountId, form]);

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
    const key = provider === "meta" ? `${campaignWabaId(form, { channels })}#${form.teamId}` : null;
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

  // ---- Catálogo de templates (Meta): WABA da campanha + equipe ----
  useEffect(() => {
    if (!open || provider !== "meta" || !wabaId || !accountId) return;
    let cancelled = false;
    const key = `${wabaId}#${form.teamId}`;
    setCatalogError(null);
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("message_templates")
        .select(`id, category, ${TEMPLATE_VALIDATION_COLUMNS}`)
        .eq("account_id", accountId)
        .or(`waba_id.eq.${wabaId},waba_id.is.null`)
        .order("name", { ascending: true });
      let allowed: Set<string> | null = null;
      if (form.teamId) {
        const { data: rows } = await supabase.from("team_allowed_templates").select("template_id").eq("team_id", form.teamId);
        allowed = new Set((rows ?? []).map((r: { template_id: string }) => r.template_id));
      }
      if (cancelled) return;
      if (error) {
        setCatalogError("Não foi possível carregar os templates do número.");
        setCatalogRows([]);
      } else {
        setCatalogRows((data ?? []) as unknown as CatalogTemplate[]);
      }
      setAllowedIds(allowed);
      setCatalogKey(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, provider, wabaId, form.teamId, accountId]);

  const catalogState: TemplateCatalogState = useMemo(() => {
    const approved = catalogRows.filter((r) => (r.status ?? "").toUpperCase() === "APPROVED");
    const restricted = Boolean(allowedIds && allowedIds.size > 0);
    return {
      loading: provider === "meta" && catalogKey !== `${wabaId}#${form.teamId}`,
      error: catalogError,
      available: restricted ? approved.filter((r) => allowedIds!.has(r.id)) : approved,
      teamRestricted: restricted,
    };
  }, [catalogRows, allowedIds, provider, catalogKey, wabaId, form.teamId, catalogError]);

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

  const knownContacts: number | null = importFile
    ? (summary?.validos ?? null)
    : keepsExistingAudience
      ? existingAudience
      : audiencePreview && !audiencePreview.loading && audiencePreview.total != null
        ? Math.max(0, audiencePreview.total - (audiencePreview.blacklisted ?? 0))
        : null;
  const forecast = useMemo(() => forecastForForm(form, knownContacts, now), [form, knownContacts, now]);
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
    if (submitting) return;
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
        const fd = new FormData();
        fd.append("file", importFile);
        if (editing) fd.append("campaign_id", editing.id);
        else fd.append("draft_id", draftId);
        fd.append("column_map", JSON.stringify(columnMap));
        fd.append("mapping_confirmed", "true");
        fd.append("has_header", table?.hasHeader ? "true" : "false");
        fd.append("column_headers", JSON.stringify(table?.headers ?? []));
        const res = await apiFetch("/api/disparador/contacts/import", { method: "POST", body: fd });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Erro ao importar contatos");
        const r = json.results ?? {};
        toast.success(
          [`${r.importados ?? 0} importados`, r.duplicados ? `${r.duplicados} duplicados` : "", r.invalidos ? `${r.invalidos} inválidos` : ""]
            .filter(Boolean)
            .join(" · ")
        );
        if (Number(r.variaveis_falhas ?? 0) > 0) {
          toast.error(`${r.variaveis_falhas} valores de VAR1–VAR3 não foram salvos. Importe o arquivo de novo antes de iniciar.`, {
            duration: 15000,
          });
        }
        trackAction("csv_imported", { total_rows: Number(r.importados ?? 0) + Number(r.duplicados ?? 0) + Number(r.invalidos ?? 0) });
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
        : "base já importada na campanha"
      : audienceMode === "tags"
        ? `contatos com a tabulação ${form.tags.join(", ")}`
        : "todos os contatos da conta";
  const submitLabel = form.startMode === "agendar" ? "Agendar campanha" : editing ? "Salvar alterações" : "Salvar rascunho";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        ref={a11y.ref}
        tabIndex={-1}
        onKeyDown={a11y.onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nc-title"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl outline-none sm:max-h-[90vh]"
      >
        <header className="border-b border-border bg-muted/20 px-4 py-3 sm:px-6 sm:py-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 id="nc-title" className="font-bold text-foreground">
              {editing ? `Editar campanha${editing.status === "agendado" ? " agendada" : ""}` : "Nova campanha"}
            </h3>
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="Fechar" className="h-9 w-9 shrink-0 text-muted-foreground">
              <X className="h-5 w-5" aria-hidden="true" />
            </Button>
          </div>
          <nav aria-label="Passos do assistente" className="flex flex-wrap gap-2">
            {WIZARD_STEPS.map(({ step: s, label }) => (
              <button
                key={s}
                type="button"
                onClick={() => goTo(s)}
                aria-current={step === s ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  step === s
                    ? "bg-primary text-primary-foreground"
                    : s <= maxVisited
                      ? "bg-muted text-foreground hover:bg-muted/70"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full text-xs font-bold",
                    step === s ? "bg-primary-foreground/20" : "bg-muted-foreground/20"
                  )}
                >
                  {s < step ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : s}
                </span>
                {label}
              </button>
            ))}
          </nav>
        </header>

        {pendingDraft && !editing && (
          <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400 sm:mx-6">
            <span>Rascunho anterior encontrado (o arquivo da base precisa ser escolhido de novo).</span>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 text-xs"
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
                size="sm"
                className="h-9 text-xs"
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
          <div role="alert" className="mx-4 mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-400 sm:mx-6">
            <p className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Corrija antes de avançar:
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {currentErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
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
              utmAvailable={utmDone || ctx.keepsExistingAudience}
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

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-4 py-3 sm:px-6 sm:py-4">
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
              disabled={submitting || reviewErrors.length > 0 || serverCheck.state === "error"}
              className="gap-1.5"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? "Salvando…" : submitLabel}
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
