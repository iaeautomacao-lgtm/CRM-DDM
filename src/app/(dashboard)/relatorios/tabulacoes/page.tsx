'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCheck, Download, ListChecks, Search } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { AccountMember, Team } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorState } from '@/components/dashboard/error-state';
import { Skeleton } from '@/components/dashboard/skeleton';
import { MetricCard } from '@/components/relatorios/MetricCard';
import { PeriodFilter } from '@/components/relatorios/period-filter';
import { startOfDayIso, endOfDayIso } from '@/lib/relatorios/date-range';
import {
  loadSharedPeriod,
  saveSharedPeriod,
  presetRange,
  type PeriodRange,
} from '@/lib/relatorios/period';
import { exportWithHistory } from '@/lib/relatorios/export-with-history';
import {
  normalizeTabulacoes,
  summarizeTabulacoes,
  type RawTabulacaoRow,
  type TabulacaoRow,
} from '@/lib/relatorios/tabulacoes';

const ALL = 'all';
interface Filters extends PeriodRange {
  teamId: string;
  agentId: string;
}
const columns = [
  { key: 'codigo_tabulacao', label: 'Código' },
  { key: 'nome', label: 'Tabulação' },
  { key: 'total', label: 'Encerradas' },
  { key: 'human', label: 'Humano' },
  { key: 'ai_auto', label: 'IA automática' },
  { key: 'automation', label: 'Automação' },
  { key: 'com_sugestao', label: 'Com sugestão' },
  { key: 'aceitas', label: 'Aceitas' },
  { key: 'trocadas', label: 'Trocadas' },
] as const;
const percent = (value: number) =>
  `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export default function TabulacoesPage() {
  const { accountId } = useAuth();
  const [draft, setDraft] = useState<Filters>(() => ({
    ...presetRange('mes'),
    teamId: ALL,
    agentId: ALL,
  }));
  const [applied, setApplied] = useState<Filters | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [rows, setRows] = useState<TabulacaoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    async function init() {
      const filters = {
        ...(loadSharedPeriod() ?? presetRange('mes')),
        teamId: ALL,
        agentId: ALL,
      };
      try {
        const [teamResult, response] = await Promise.all([
          createClient()
            .from('teams')
            .select('*')
            .eq('account_id', accountId)
            .order('name')
            .range(0, 999),
          apiFetch('/api/account/members', { cache: 'no-store' }),
        ]);
        if (teamResult.error) throw teamResult.error;
        if (!response.ok) throw new Error('Falha ao carregar agentes');
        const data = (await response.json()) as { members?: AccountMember[] };
        if (!cancelled) {
          setTeams((teamResult.data ?? []) as Team[]);
          setMembers(data.members ?? []);
        }
      } catch (err) {
        console.error('[tabulacoes] filtros:', err);
        if (!cancelled)
          toast.error('Não foi possível carregar os filtros de equipe/agente.');
      } finally {
        if (!cancelled) {
          setDraft(filters);
          setApplied(filters);
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !applied) return;
    const filters = applied;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const { data, error } = await createClient().rpc('report_tabulacoes', {
          p_account_id: accountId,
          p_from: startOfDayIso(filters.dateFrom),
          p_to: endOfDayIso(filters.dateTo),
          p_team_id: filters.teamId === ALL ? null : filters.teamId,
          p_agent_id: filters.agentId === ALL ? null : filters.agentId,
        });
        if (error) throw error;
        if (!cancelled)
          setRows(normalizeTabulacoes((data ?? []) as RawTabulacaoRow[]));
      } catch (err) {
        console.error('[tabulacoes] relatório:', err);
        if (!cancelled) {
          setRows([]);
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accountId, applied, retry]);

  const summary = useMemo(() => summarizeTabulacoes(rows), [rows]);

  async function exportCsv() {
    if (!applied) return;
    setExporting(true);
    try {
      await exportWithHistory({
        data: rows.map((row) => ({ ...row })),
        columns: [...columns],
        exportType: 'tabulacoes',
        description: `Tabulações - ${applied.dateFrom} a ${applied.dateTo}`,
        periodFrom: new Date(startOfDayIso(applied.dateFrom)),
        periodTo: new Date(endOfDayIso(applied.dateTo)),
        format: 'csv',
      });
    } catch (err) {
      console.error('[tabulacoes] exportação:', err);
      toast.error('Falha ao exportar as tabulações. Tente novamente.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-[-0.015em] text-foreground">Tabulações</h1>
        <p className="text-muted-foreground text-sm">
          Conversas encerradas no período, por tabulação e origem.
        </p>
      </div>
      <div className="border-border bg-card space-y-3 rounded-xl border p-4">
        <PeriodFilter
          value={draft}
          onChange={(range) =>
            setDraft((previous) => ({ ...previous, ...range }))
          }
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">Equipe</span>
            <Select
              value={draft.teamId}
              onValueChange={(value) =>
                setDraft((previous) => ({ ...previous, teamId: value ?? ALL }))
              }
            >
              <SelectTrigger className="w-48" aria-label="Equipe">
                <SelectValue>
                  {draft.teamId === ALL
                    ? 'Todas'
                    : teams.find((t) => t.id === draft.teamId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas</SelectItem>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-muted-foreground text-xs">Agente</span>
            <Select
              value={draft.agentId}
              onValueChange={(value) =>
                setDraft((previous) => ({ ...previous, agentId: value ?? ALL }))
              }
            >
              <SelectTrigger className="w-48" aria-label="Agente">
                <SelectValue>
                  {draft.agentId === ALL
                    ? 'Todos'
                    : members.find((m) => m.user_id === draft.agentId)
                        ?.full_name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos</SelectItem>
                {members.map((member) => (
                  <SelectItem key={member.user_id} value={member.user_id}>
                    {member.full_name ?? member.user_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={!applied || !draft.dateFrom || !draft.dateTo || loading}
            onClick={() => {
              saveSharedPeriod(draft);
              setApplied({ ...draft });
            }}
          >
            <Search className="size-4" />
            Pesquisar
          </Button>
          <Button
            variant="outline"
            disabled={loading || loadError || !summary.total || exporting}
            onClick={exportCsv}
          >
            <Download className="size-4" />
            {exporting ? 'Exportando…' : 'CSV'}
          </Button>
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : loadError ? (
        <ErrorState onRetry={() => setRetry((value) => value + 1)} />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <MetricCard
              title="Total encerradas"
              icon={ListChecks}
              metrics={[{ label: 'Conversas', value: summary.total }]}
            />
            <MetricCard
              title="Sem tabulação"
              icon={ListChecks}
              metrics={[
                {
                  label: 'Percentual',
                  value: percent(summary.semTabulacaoPct),
                },
                { label: 'Conversas', value: summary.semTabulacao },
              ]}
            />
            <MetricCard
              title="Sugestões aceitas"
              icon={CheckCheck}
              metrics={[
                {
                  label: 'Decisões humanas',
                  value: percent(summary.aceitasPct),
                },
                {
                  label: 'Aceitas / trocadas',
                  value: `${summary.aceitas} / ${summary.trocadas}`,
                },
              ]}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Aceite = aceitas ÷ (aceitas + trocadas pelo humano). Sugestões
            registradas incluem IA, fluxo e regras. Origens legadas não
            informadas entram no total, sem atribuição de origem. Equipe/agente
            refletem a atribuição atual.
          </p>
          {summary.total === 0 && (
            <p className="text-muted-foreground text-sm">
              Nenhuma conversa encerrada neste período e escopo.
            </p>
          )}
          <div className="border-border bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column.key}>{column.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={`${row.codigo_tabulacao ?? 'custom'}:${row.nome}`}
                  >
                    {columns.map((column) => (
                      <TableCell key={column.key}>
                        {row[column.key] ?? '—'}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
