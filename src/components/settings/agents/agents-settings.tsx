'use client';

// Configurações → Agentes (Fase 4): perfis de agente de IA reutilizáveis pelos nós de IA do fluxo.
// Lista + editor em abas. Supervisor vê; owner/admin edita. Salvar = publica uma NOVA versão (as
// conversas em andamento continuam na versão anterior). Credenciais nunca aparecem: só marcadores
// {{cred.NOME}}. Deep link: /settings?tab=agents&id=<agente> (usado pelo botão "Editar agente" do nó).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, Loader2, Trash2, Upload } from 'lucide-react';

import { usePermissions } from '@/hooks/use-permission';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusChip } from '@/components/ddm/status-chip';
import { ErrorState, Skeleton } from '@/components/ddm/states';
import { LEGACY_AGENT_DEFAULTS } from '@/lib/ai/agents/schema';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AgentApiError,
  createAgent,
  createAgentVersion,
  deleteAgent,
  fetchAccountSecrets,
  fetchAgent,
  fetchKnowledgeBaseFiles,
  fetchToolsCatalog,
  patchAgent,
  previewAgentPrompt,
  rollbackAgentVersion,
} from './api';
import {
  createInitialAgentFormData,
  formDataFromPublished,
  formDataToPreviewPayload,
  formDataToSavePayload,
} from './defaults';
import type {
  AgentDetailResponse,
  AgentFormData,
  KnowledgeBaseFileItem,
  SecretItem,
  ToolCatalogItem,
} from './types';
import { GeneralTab } from './tabs/general-tab';
import { PromptTab } from './tabs/prompt-tab';
import { RulesTab } from './tabs/rules-tab';
import { KnowledgeTab } from './tabs/knowledge-tab';
import { ToolsTab } from './tabs/tools-tab';
import { ModelTab } from './tabs/model-tab';
import { BehaviorTab } from './tabs/behavior-tab';
import { ProtectionsTab } from './tabs/protections-tab';
import { VersionsTab } from './tabs/versions-tab';
import { PreviewTab } from './tabs/preview-tab';
import { TestTab, type TestTabTool } from './tabs/test-tab';
import { AgentList } from './agent-list';

const TABS = [
  ['general', 'Geral'],
  ['prompt', 'Prompt'],
  ['rules', 'Regras'],
  ['knowledge', 'Conhecimento'],
  ['tools', 'Ferramentas'],
  ['model', 'Modelo'],
  ['behavior', 'Comportamento'],
  ['protections', 'Proteções'],
  ['versions', 'Versões'],
  ['preview', 'Prévia'],
  ['test', 'Testar'],
] as const;

const SAVE_CONFIRM = 'Salvar publica uma nova versão do agente.\n\nConversas em andamento continuam na versão anterior.';

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof AgentApiError) {
    const first = err.issues?.[0];
    return first ? `${err.message} (${first.path}: ${first.message})` : err.message;
  }
  return fallback;
}

export function AgentsSettings() {
  const { accountId } = useAuth();
  const { can } = usePermissions();
  const canEdit = can('ai.agents.edit');
  // Criar/vincular ferramenta na aba do agente (Farol, #217): ai.tools.edit.
  const canManageTools = can('ai.tools.edit');
  // "Testar agente" usa o simulador de fluxo: flows.simulate + ai.agents.view; consulta real exige secrets.write.
  const canSimulate = can('flows.simulate') && can('ai.agents.view');
  const canRealRead = can('secrets.write');
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get('id');

  const select = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'agents');
      if (id) params.set('id', id);
      else params.delete('id');
      router.replace(`/settings?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  if (selectedId) {
    return (
      <AgentEditor
        key={selectedId}
        agentId={selectedId === 'new' ? null : selectedId}
        canEdit={canEdit}
        canManageTools={canManageTools}
        canSimulate={canSimulate}
        canRealRead={canRealRead}
        accountId={accountId}
        onBack={() => select(null)}
        onCreated={(id) => select(id)}
      />
    );
  }
  return <AgentList canEdit={canEdit} onOpen={select} />;
}

/* ───────────────────────────── Editor ───────────────────────────── */

function AgentEditor({
  agentId,
  canEdit,
  canManageTools,
  canSimulate,
  canRealRead,
  accountId,
  onBack,
  onCreated,
}: {
  agentId: string | null;
  canEdit: boolean;
  canManageTools: boolean;
  canSimulate: boolean;
  canRealRead: boolean;
  accountId: string | null;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const [detail, setDetail] = useState<AgentDetailResponse | null>(null);
  const [form, setForm] = useState<AgentFormData>(() => createInitialAgentFormData());
  const [saved, setSaved] = useState<string>(() => JSON.stringify(createInitialAgentFormData()));
  const [loading, setLoading] = useState(agentId !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<string>('general');
  const [convertPreview, setConvertPreview] = useState<{ before: string; after: string; form: AgentFormData } | null>(null);
  const [converting, setConverting] = useState(false);
  const [catalog, setCatalog] = useState<ToolCatalogItem[]>([]);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [kbFiles, setKbFiles] = useState<KnowledgeBaseFileItem[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyDetail = useCallback((next: AgentDetailResponse) => {
    const data = formDataFromPublished(next.agent, next.published);
    setDetail(next);
    setForm(data);
    setSaved(JSON.stringify(data));
  }, []);

  const reload = useCallback(
    async (id: string) => {
      try {
        applyDetail(await fetchAgent(id));
        setLoadError(null);
      } catch (err) {
        setLoadError(errorMessage(err, 'Não foi possível carregar o agente.'));
      } finally {
        setLoading(false);
      }
    },
    [applyDetail],
  );

  useEffect(() => {
    if (agentId) void reload(agentId);
  }, [agentId, reload]);

  // Listas auxiliares (falha em uma não derruba o editor).
  useEffect(() => {
    void fetchToolsCatalog().then((v) => mounted.current && setCatalog(v)).catch(() => undefined);
    void fetchAccountSecrets().then((v) => mounted.current && setSecrets(v)).catch(() => undefined);
    void fetchKnowledgeBaseFiles().then((v) => mounted.current && setKbFiles(v)).catch(() => undefined);
  }, [accountId]);

  const dirty = useMemo(() => JSON.stringify(form) !== saved, [form, saved]);
  const readOnly = !canEdit;
  const existingConfig = detail?.published?.config ?? null;
  const patch = useCallback((p: Partial<AgentFormData>) => setForm((prev) => ({ ...prev, ...p })), []);

  async function save() {
    if (!form.name.trim()) {
      toast.error('Dê um nome ao agente.');
      setTab('general');
      return;
    }
    if (!window.confirm(SAVE_CONFIRM)) return;
    setSaving(true);
    try {
      const payload = formDataToSavePayload(form, existingConfig);
      if (!agentId) {
        const created = await createAgent(payload);
        if (!form.enabled) await patchAgent(created.agent_id, { enabled: false });
        toast.success('Agente criado e publicado (v1).');
        onCreated(created.agent_id);
        return;
      }
      const { name, ...versionPayload } = payload;
      const meta: { name?: string; enabled?: boolean } = {};
      if (name !== detail?.agent.name) meta.name = name;
      if (form.enabled !== detail?.agent.enabled) meta.enabled = form.enabled;
      if (Object.keys(meta).length > 0) await patchAgent(agentId, meta);
      const version = await createAgentVersion(agentId, versionPayload);
      toast.success(`Versão v${version.version} publicada. Conversas em andamento continuam na versão anterior.`);
      await reload(agentId);
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível salvar o agente.'));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function restore(versionId: string) {
    if (!agentId) return;
    setSaving(true);
    try {
      const result = await rollbackAgentVersion(agentId, versionId);
      toast.success(`Versão restaurada como v${result.version}.`);
      await reload(agentId);
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível restaurar a versão.'));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  /** Legacy → seções: mostra a Prévia antes/depois e só publica após a confirmação. */
  async function startConvert() {
    if (!agentId || !existingConfig) return;
    setConverting(true);
    try {
      const prompt = existingConfig.prompt;
      const base = prompt.legacy_override_present
        ? form.prompt_content
        : prompt.account_content || LEGACY_AGENT_DEFAULTS.fallback_prompt;
      const converted: AgentFormData = { ...form, composition: 'sections_v1', prompt_content: base, rules: [] };
      const [before, after] = await Promise.all([
        previewAgentPrompt(formDataToPreviewPayload(form, existingConfig)),
        previewAgentPrompt(formDataToPreviewPayload(converted, existingConfig)),
      ]);
      setConvertPreview({ before: before.system_prompt, after: after.system_prompt, form: converted });
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível gerar a prévia da conversão.'));
    } finally {
      setConverting(false);
    }
  }

  async function confirmConvert() {
    if (!agentId || !convertPreview) return;
    setSaving(true);
    try {
      const { name: _name, ...versionPayload } = formDataToSavePayload(convertPreview.form, existingConfig);
      void _name;
      const version = await createAgentVersion(agentId, versionPayload);
      toast.success(`Convertido para prompt em seções (v${version.version}). Conversas em andamento continuam na versão anterior.`);
      setConvertPreview(null);
      await reload(agentId);
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível converter o agente.'));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function remove() {
    if (!agentId || !detail) return;
    if (!window.confirm(`Excluir o agente "${detail.agent.name}"? Não dá para desfazer.`)) return;
    try {
      await deleteAgent(agentId);
      toast.success('Agente excluído.');
      onBack();
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível excluir o agente.'));
    }
  }

  /** Rascunho atual no formato de "Publicar nova versão" (sem o nome): o que o teste usa. */
  function testDraft(): Record<string, unknown> {
    const { name: _name, ...draft } = formDataToSavePayload(form, existingConfig);
    void _name;
    return draft as Record<string, unknown>;
  }

  const testTools = useMemo<TestTabTool[]>(() => {
    const byId = new Map(catalog.map((t) => [t.id, t]));
    const out: TestTabTool[] = [];
    for (const link of form.tools) {
      const tool = byId.get(link.tool_id);
      if (link.enabled && tool?.enabled) out.push({ name: tool.name, method: tool.http?.method ?? 'GET' });
    }
    for (const legacy of form.legacyTools) if (legacy.enabled) out.push({ name: legacy.name, method: legacy.method });
    return out;
  }, [catalog, form.tools, form.legacyTools]);

  async function preview(): Promise<string> {
    const result = await previewAgentPrompt(formDataToPreviewPayload(form, existingConfig));
    return result.system_prompt;
  }

  if (loading) {
    return (
      <section className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full rounded-[10px]" />
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="self-start">
          <ArrowLeft className="size-4" />
          Agentes
        </Button>
        <ErrorState
          title="Não foi possível carregar o agente"
          hint={loadError}
          onRetry={agentId ? () => void reload(agentId) : undefined}
        />
      </section>
    );
  }

  return (
    <section className="animate-ddm-up flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft className="size-4" />
          Agentes
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <StatusChip tone="warn">Alterações não salvas</StatusChip>}
          {detail?.published ? (
            <StatusChip tone="mute" dot={false}>
              Publicada: v{detail.published.version}
            </StatusChip>
          ) : agentId ? (
            <StatusChip tone="warn">Sem versão publicada</StatusChip>
          ) : null}
          {canEdit && agentId && (
            <Button variant="ghost" size="icon-sm" onClick={() => void remove()} aria-label="Excluir agente" title="Excluir agente">
              <Trash2 className="size-4" />
            </Button>
          )}
          {canEdit && (
            <Button onClick={() => void save()} disabled={saving || (!dirty && agentId !== null)}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {agentId ? 'Publicar nova versão' : 'Criar e publicar'}
            </Button>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <h2 className="font-heading truncate text-[22px] font-semibold tracking-tight text-foreground">
          {form.name.trim() || (agentId ? 'Agente sem nome' : 'Novo agente')}
        </h2>
        {!canEdit && (
          <p className="mt-1 text-sm text-muted-foreground">Somente leitura: você pode ver o agente, mas não editar.</p>
        )}
      </div>

      {agentId && detail && !detail.published && (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          Este agente ainda não tem versão publicada: os nós que o usam seguem pela saída de falha.
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <div className="-mx-1 overflow-x-auto border-b px-1 [scrollbar-width:thin]">
          <TabsList variant="line" className="h-auto justify-start gap-5 p-0">
            {TABS.filter(([value]) => value !== 'test' || canSimulate).map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="flex-none px-0 pb-2.5 pt-1 text-[13.5px] data-active:text-foreground after:bg-primary after:!bottom-[-1px]"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="general" className="animate-ddm-fade pt-5">
          <GeneralTab data={form} onChange={patch} readOnly={readOnly} usedIn={detail?.used_in ?? []} />
        </TabsContent>
        <TabsContent value="prompt" className="animate-ddm-fade pt-5">
          <PromptTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="rules" className="animate-ddm-fade pt-5">
          <RulesTab data={form} onChange={patch} readOnly={readOnly || converting} onConvert={() => void startConvert()} />
        </TabsContent>
        <TabsContent value="knowledge" className="animate-ddm-fade pt-5">
          <KnowledgeTab
            data={form}
            onChange={patch}
            kbFiles={kbFiles}
            onFilesChange={setKbFiles}
            maxChars={existingConfig?.knowledge.max_chars ?? LEGACY_AGENT_DEFAULTS.knowledge.max_chars}
            secrets={secrets}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="tools" className="animate-ddm-fade pt-5">
          <ToolsTab
            data={form}
            onChange={patch}
            catalog={catalog}
            readOnly={readOnly}
            canManageTools={canManageTools}
            onToolCreated={(tool) => setCatalog((prev) => [...prev.filter((t) => t.id !== tool.id), tool])}
          />
        </TabsContent>
        <TabsContent value="model" className="animate-ddm-fade pt-5">
          <ModelTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="behavior" className="animate-ddm-fade pt-5">
          <BehaviorTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="protections" className="animate-ddm-fade pt-5">
          <ProtectionsTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="versions" className="animate-ddm-fade pt-5">
          <VersionsTab
            versions={detail?.versions ?? []}
            publishedVersionId={detail?.published?.version_id}
            onRestore={restore}
            readOnly={readOnly}
            busy={saving}
          />
        </TabsContent>
        <TabsContent value="preview" className="animate-ddm-fade pt-5">
          <PreviewTab onPreview={preview} readOnly={readOnly} />
        </TabsContent>
        {canSimulate && (
          <TabsContent value="test" className="animate-ddm-fade pt-5">
            <TestTab agentId={agentId} buildDraft={testDraft} tools={testTools} canRealRead={canRealRead} />
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={convertPreview !== null} onOpenChange={(open) => !open && setConvertPreview(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Converter para prompt em seções</DialogTitle>
            <DialogDescription>
              Publica uma nova versão em seções (permite regras separadas). As instruções automáticas por instituição/CPF do
              prompt original deixam de ser acrescentadas. Conversas em andamento continuam na versão anterior.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase">Antes (original)</div>
              <pre className="bg-muted/40 max-h-80 overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap">{convertPreview?.before}</pre>
            </div>
            <div>
              <div className="text-muted-foreground mb-1 text-xs font-semibold uppercase">Depois (em seções)</div>
              <pre className="bg-muted/40 max-h-80 overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap">{convertPreview?.after}</pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertPreview(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void confirmConvert()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Converter e publicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
