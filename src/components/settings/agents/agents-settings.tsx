'use client';

// Configurações → Agentes (Fase 4): perfis de agente de IA reutilizáveis pelos nós de IA do fluxo.
// Lista + editor em abas. Supervisor vê; owner/admin edita. Salvar = publica uma NOVA versão (as
// conversas em andamento continuam na versão anterior). Credenciais nunca aparecem: só marcadores
// {{cred.NOME}}. Deep link: /settings?tab=agents&id=<agente> (usado pelo botão "Editar agente" do nó).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Plus, Save, Sparkles, Trash2 } from 'lucide-react';

import { can } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { LEGACY_AGENT_DEFAULTS } from '@/lib/ai/agents/schema';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettingsPanelHead } from '../settings-panel-head';
import {
  AgentApiError,
  createAgent,
  createAgentVersion,
  deleteAgent,
  fetchAccountSecrets,
  fetchAgent,
  fetchAgents,
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
  AgentListItem,
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
] as const;

const SAVE_CONFIRM = 'Salvar publica uma nova versão do agente.\n\nConversas em andamento continuam na versão anterior.';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof AgentApiError) {
    const first = err.issues?.[0];
    return first ? `${err.message} (${first.path}: ${first.message})` : err.message;
  }
  return fallback;
}

export function AgentsSettings() {
  const { accountRole, accountId } = useAuth();
  const canEdit = !!accountRole && hasMinRole(accountRole, 'admin');
  const canManageTools = !!accountRole && can({ role: accountRole }, 'ai.tools.edit');
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
        accountId={accountId}
        onBack={() => select(null)}
        onCreated={(id) => select(id)}
      />
    );
  }
  return <AgentList canEdit={canEdit} onOpen={select} />;
}

/* ───────────────────────────── Lista ───────────────────────────── */

function AgentList({ canEdit, onOpen }: { canEdit: boolean; onOpen: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAgents().then(
      (list) => {
        if (!cancelled) setAgents(list);
      },
      (err) => {
        if (cancelled) return;
        setError(errorMessage(err, 'Não foi possível carregar os agentes.'));
        setAgents([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(agent: AgentListItem, enabled: boolean) {
    setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) ?? prev);
    try {
      await patchAgent(agent.id, { enabled });
      toast.success(enabled ? `${agent.name} ligado` : `${agent.name} desligado — os nós que o usam seguem pela saída de falha`);
    } catch (err) {
      setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled: !enabled } : a)) ?? prev);
      toast.error(errorMessage(err, 'Não foi possível alterar o agente.'));
    }
  }

  if (!agents) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Agentes"
        description="Perfis de IA reutilizáveis: prompt, regras, base de conhecimento, ferramentas, modelo e proteções. Escolha um agente no nó de IA do fluxo; cada alteração publica uma nova versão."
        action={
          canEdit ? (
            <Button onClick={() => onOpen('new')}>
              <Plus className="size-4" />
              Novo agente
            </Button>
          ) : undefined
        }
      />

      {!canEdit && <p className="text-muted-foreground text-sm">Você pode ver os agentes. Só owner e admin criam ou editam.</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {agents.length === 0 && !error ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm">
            <Sparkles className="size-6" />
            Nenhum agente criado ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <Card key={agent.id}>
              <CardContent className="flex flex-wrap items-center gap-3 py-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(agent.id)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{agent.name}</span>
                    {agent.published_version ? (
                      <Badge variant="secondary">v{agent.published_version.version}</Badge>
                    ) : (
                      <Badge variant="outline">Sem versão publicada</Badge>
                    )}
                    {!agent.enabled && <Badge variant="outline">Desligado</Badge>}
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    Usado em {agent.used_in_flows} fluxo{agent.used_in_flows === 1 ? '' : 's'} · atualizado em{' '}
                    {formatDate(agent.updated_at)}
                  </div>
                </button>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={agent.enabled}
                    onCheckedChange={(v) => void toggle(agent, v)}
                    disabled={!canEdit}
                    aria-label={`${agent.enabled ? 'Desligar' : 'Ligar'} ${agent.name}`}
                  />
                  <Button variant="outline" size="sm" onClick={() => onOpen(agent.id)}>
                    {canEdit ? 'Editar' : 'Ver'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/* ───────────────────────────── Editor ───────────────────────────── */

function AgentEditor({
  agentId,
  canEdit,
  canManageTools,
  accountId,
  onBack,
  onCreated,
}: {
  agentId: string | null;
  canEdit: boolean;
  canManageTools: boolean;
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
    void fetchKnowledgeBaseFiles(accountId).then((v) => mounted.current && setKbFiles(v));
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

  async function preview(): Promise<string> {
    const result = await previewAgentPrompt(formDataToPreviewPayload(form, existingConfig));
    return result.system_prompt;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <section className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Agentes
        </Button>
        <p className="text-destructive text-sm">{loadError}</p>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Agentes
        </Button>
        <div className="flex items-center gap-2">
          {detail?.published && <Badge variant="secondary">Publicada: v{detail.published.version}</Badge>}
          {dirty && <Badge variant="outline">Alterações não salvas</Badge>}
          {canEdit && agentId && (
            <Button variant="ghost" size="sm" onClick={() => void remove()} aria-label="Excluir agente">
              <Trash2 className="size-4" />
            </Button>
          )}
          {canEdit && (
            <Button onClick={() => void save()} disabled={saving || (!dirty && agentId !== null)}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {agentId ? 'Publicar nova versão' : 'Criar e publicar'}
            </Button>
          )}
        </div>
      </div>

      {!canEdit && <p className="text-muted-foreground text-sm">Somente leitura: só owner e admin editam agentes.</p>}
      {agentId && detail && !detail.published && (
        <p className="text-sm text-amber-600">Este agente ainda não tem versão publicada: os nós que o usam seguem pela saída de falha.</p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general" className="pt-4">
          <GeneralTab data={form} onChange={patch} readOnly={readOnly} usedIn={detail?.used_in ?? []} />
        </TabsContent>
        <TabsContent value="prompt" className="pt-4">
          <PromptTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="rules" className="pt-4">
          <RulesTab data={form} onChange={patch} readOnly={readOnly || converting} onConvert={() => void startConvert()} />
        </TabsContent>
        <TabsContent value="knowledge" className="pt-4">
          <KnowledgeTab data={form} onChange={patch} kbFiles={kbFiles} secrets={secrets} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="tools" className="pt-4">
          <ToolsTab
            data={form}
            onChange={patch}
            catalog={catalog}
            readOnly={readOnly}
            canManageTools={canManageTools}
            onToolCreated={(tool) => setCatalog((prev) => [...prev.filter((t) => t.id !== tool.id), tool])}
          />
        </TabsContent>
        <TabsContent value="model" className="pt-4">
          <ModelTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="behavior" className="pt-4">
          <BehaviorTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="protections" className="pt-4">
          <ProtectionsTab data={form} onChange={patch} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="versions" className="pt-4">
          <VersionsTab
            versions={detail?.versions ?? []}
            publishedVersionId={detail?.published?.version_id}
            onRestore={restore}
            readOnly={readOnly}
            busy={saving}
          />
        </TabsContent>
        <TabsContent value="preview" className="pt-4">
          <PreviewTab onPreview={preview} readOnly={readOnly} />
        </TabsContent>
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
