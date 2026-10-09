'use client';

// Lista de agentes no visual do redesenho DDM (protótipo Agentes.dc.html): faixa de KPIs, busca + filtro
// segmentado e cartões. Só dados reais: as métricas por agente do protótipo (conversas, resolvidas,
// transferidas) não existem no backend e ficaram de fora.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BookOpen, Bot, Cpu, Plus, Repeat, Search, Sparkles, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { KpiStrip } from '@/components/ddm/kpi-strip';
import { PageToolbar } from '@/components/ddm/page-toolbar';
import { Segmented } from '@/components/ddm/segmented';
import { StatusChip } from '@/components/ddm/status-chip';
import { EmptyState, ErrorState, Skeleton } from '@/components/ddm/states';
import { rowDelay } from '@/components/ddm/list-with-drawer';
import { aiProviderLabel, getAiModelDefinition } from '@/lib/ai/models';
import { cn } from '@/lib/utils';
import { AgentApiError, fetchAgents, patchAgent } from './api';
import type { AgentListItem } from './types';

type Filter = 'all' | 'on' | 'off' | 'draft';

const MODE_LABEL: Record<string, string> = {
  once: 'Uma resposta',
  loop: 'Conversa (loop)',
  takeover: 'Assume a conversa',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Chips do cartão a partir do resumo da versão publicada. */
export function agentChips(agent: AgentListItem): Array<{ key: string; icon: typeof Cpu; text: string }> {
  const s = agent.summary;
  if (!s) return [];
  const chips: Array<{ key: string; icon: typeof Cpu; text: string }> = [];
  const model = getAiModelDefinition(s.provider, s.model);
  if (model || s.model || s.provider) {
    chips.push({ key: 'model', icon: Cpu, text: model?.label ?? s.model ?? aiProviderLabel(s.provider) });
  }
  if (s.mode && MODE_LABEL[s.mode]) chips.push({ key: 'mode', icon: Repeat, text: MODE_LABEL[s.mode] });
  chips.push({ key: 'tools', icon: Wrench, text: plural(s.tools, 'ferramenta', 'ferramentas') });
  if (s.knowledge === 'explicit') chips.push({ key: 'kb', icon: BookOpen, text: plural(s.files ?? 0, 'arquivo', 'arquivos') });
  else if (s.knowledge === 'legacy_account_all') chips.push({ key: 'kb', icon: BookOpen, text: 'Todos os arquivos' });
  if (s.vector) chips.push({ key: 'vector', icon: Sparkles, text: 'Busca por trechos' });
  return chips;
}

export function filterAgents(agents: AgentListItem[], filter: Filter, query: string): AgentListItem[] {
  const q = query.trim().toLocaleLowerCase('pt-BR');
  return agents.filter((a) => {
    if (filter === 'on' && !a.enabled) return false;
    if (filter === 'off' && a.enabled) return false;
    if (filter === 'draft' && a.published_version) return false;
    return !q || a.name.toLocaleLowerCase('pt-BR').includes(q);
  });
}

export function AgentList({ canEdit, onOpen }: { canEdit: boolean; onOpen: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchAgents().then(
      (list) => {
        if (!cancelled) setAgents(list);
      },
      (err) => {
        if (cancelled) return;
        setError(err instanceof AgentApiError ? err.message : 'Não foi possível carregar os agentes.');
        setAgents((prev) => prev ?? []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const counts = useMemo(() => {
    const list = agents ?? [];
    return {
      all: list.length,
      on: list.filter((a) => a.enabled).length,
      off: list.filter((a) => !a.enabled).length,
      draft: list.filter((a) => !a.published_version).length,
      inFlows: list.filter((a) => a.used_in_flows > 0).length,
    };
  }, [agents]);
  const visible = useMemo(() => filterAgents(agents ?? [], filter, query), [agents, filter, query]);

  async function toggle(agent: AgentListItem, enabled: boolean) {
    setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) ?? prev);
    try {
      await patchAgent(agent.id, { enabled });
      toast.success(enabled ? `${agent.name} ligado` : `${agent.name} desligado — os nós que o usam seguem pela saída de falha`);
    } catch (err) {
      setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled: !enabled } : a)) ?? prev);
      toast.error(err instanceof AgentApiError ? err.message : 'Não foi possível alterar o agente.');
    }
  }

  const loading = agents === null;

  return (
    <section className="animate-ddm-up flex flex-col gap-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-heading text-[22px] font-semibold tracking-tight text-foreground">Agentes de IA</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-foreground-2">
            Perfis reutilizáveis com prompt, regras, conhecimento, ferramentas, modelo e proteções. Use um agente no nó
            &ldquo;Agente de IA&rdquo; do fluxo; cada publicação cria uma nova versão.
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => onOpen('new')} className="shrink-0">
            <Plus className="size-4" />
            Novo agente
          </Button>
        )}
      </div>

      <KpiStrip
        ariaLabel="Resumo dos agentes"
        loading={loading}
        items={[
          {
            label: 'Agentes ligados',
            value: counts.on,
            note: `de ${counts.all}`,
            noteTone: 'muted',
            onClick: () => setFilter('on'),
            active: filter === 'on',
          },
          {
            label: 'Desligados',
            value: counts.off,
            onClick: () => setFilter('off'),
            active: filter === 'off',
          },
          {
            label: 'Sem versão publicada',
            value: counts.draft,
            noteTone: counts.draft > 0 ? 'warn' : 'muted',
            note: counts.draft > 0 ? 'nós seguem pela falha' : undefined,
            onClick: () => setFilter('draft'),
            active: filter === 'draft',
          },
          { label: 'Usados em fluxos', value: counts.inFlows, note: `de ${counts.all}`, noteTone: 'muted' },
        ]}
      />

      <PageToolbar>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar agente"
            aria-label="Buscar agente"
            className="h-9 pl-8"
          />
        </div>
        <Segmented<Filter>
          ariaLabel="Filtrar agentes"
          size="lg"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todos', count: counts.all },
            { value: 'on', label: 'Ligados', count: counts.on },
            { value: 'off', label: 'Desligados', count: counts.off },
            { value: 'draft', label: 'Sem versão', count: counts.draft },
          ]}
        />
      </PageToolbar>

      {!canEdit && !loading && (
        <p className="text-sm text-muted-foreground">Você pode ver os agentes. Só quem tem permissão de edição cria ou altera.</p>
      )}

      {error ? (
        <ErrorState title="Não foi possível carregar os agentes" hint={error} onRetry={() => {
            setError(null);
            setAgents(null);
            setReload((n) => n + 1);
          }} />
      ) : loading ? (
        <div className="grid gap-3 md:grid-cols-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 rounded-[10px]" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={counts.all === 0 ? 'Nenhum agente criado ainda' : 'Nenhum agente encontrado'}
          hint={counts.all === 0 ? (canEdit ? 'Crie o primeiro em “Novo agente”.' : undefined) : 'Ajuste a busca ou o filtro.'}
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Agentes">
          {visible.map((agent, i) => (
            <li key={agent.id} className="animate-ddm-row" style={{ animationDelay: `${rowDelay(i)}ms` }}>
              <AgentCard agent={agent} canEdit={canEdit} onOpen={() => onOpen(agent.id)} onToggle={(v) => void toggle(agent, v)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentCard({
  agent,
  canEdit,
  onOpen,
  onToggle,
}: {
  agent: AgentListItem;
  canEdit: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const chips = agentChips(agent);
  return (
    <div
      className={cn(
        'group flex h-full flex-col gap-3 rounded-[10px] border bg-card p-4 transition-colors hover:border-border-strong',
        !agent.enabled && 'bg-card/70',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            agent.enabled ? 'bg-primary-soft text-primary-text' : 'bg-surface-3 text-muted-foreground',
          )}
        >
          <Bot className="size-[18px]" />
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-foreground group-hover:text-primary-text">{agent.name}</span>
            {agent.published_version ? (
              <StatusChip tone="mute" dot={false}>
                v{agent.published_version.version}
              </StatusChip>
            ) : (
              <StatusChip tone="warn">Sem versão publicada</StatusChip>
            )}
            {!agent.enabled && <StatusChip tone="mute">Desligado</StatusChip>}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Usado em {plural(agent.used_in_flows, 'fluxo', 'fluxos')} · atualizado em {formatDate(agent.updated_at)}
          </span>
        </button>
        <Switch
          checked={agent.enabled}
          onCheckedChange={onToggle}
          disabled={!canEdit}
          aria-label={`${agent.enabled ? 'Desligar' : 'Ligar'} ${agent.name}`}
        />
      </div>
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Configuração de ${agent.name}`}>
          {chips.map((c) => (
            <li
              key={c.key}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-card-2 px-2 text-xs text-foreground-2"
            >
              <c.icon className="size-3.5 text-muted-foreground" aria-hidden />
              {c.text}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto flex justify-end">
        <Button variant="outline" size="sm" onClick={onOpen}>
          {canEdit ? 'Editar' : 'Ver'}
        </Button>
      </div>
    </div>
  );
}
