'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Bot, Loader2, Plus, Trash2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { PageToolbar } from '@/components/ddm/page-toolbar';
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from '@/components/ddm/table-card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ddm/states';
import { KNOWN_AI_EXIT_TAGS } from '@/lib/ai/exit-tags';
import {
  getAvailableExitTags,
  getExitTagDescription,
} from '@/lib/tabulacoes/ai-exit-tags';
import type { Tag } from '@/types';

/**
 * Flag de produto: mantém a coluna e os controles de "Encerrar automaticamente" (auto_close)
 * ocultos na interface até haver decisão definitiva de produto sobre o comportamento.
 * Motivo: ligar auto_close encerra a conversa enquanto o fluxo do bot ainda pode
 * estar rodando o ramo da tag (mensagens de despedida/encerramento ou handoff).
 * Não apagar o código de suporte a auto_close.
 */
const SHOW_AUTO_CLOSE = false;

export interface AiExitTagOutcomeMapRow {
  id: string;
  account_id: string;
  exit_tag: string;
  outcome_tag_id: string;
  auto_close: boolean;
  created_at?: string;
  updated_at?: string;
}

interface AiOutcomeMapSectionProps {
  /** Tabulações kind='outcome' disponíveis na conta. */
  tabulacoes: Tag[];
}

export function AiOutcomeMapSection({ tabulacoes }: AiOutcomeMapSectionProps) {
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mappings, setMappings] = useState<AiExitTagOutcomeMapRow[]>([]);

  // Create modal state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedOutcomeId, setSelectedOutcomeId] = useState('');
  const [addAutoClose, setAddAutoClose] = useState(false);
  const [savingNew, setSavingNew] = useState(false);

  // Auto-close confirmation state (quando o usuário ativa o switch na tabela)
  const [confirmAutoCloseTarget, setConfirmAutoCloseTarget] =
    useState<AiExitTagOutcomeMapRow | null>(null);
  const [togglingAutoClose, setTogglingAutoClose] = useState(false);

  // Delete modal state
  const [deleteTarget, setDeleteTarget] =
    useState<AiExitTagOutcomeMapRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const tabulacaoById = useMemo(() => {
    return new Map(tabulacoes.map((t) => [t.id, t] as const));
  }, [tabulacoes]);

  const availableTags = useMemo(() => {
    return getAvailableExitTags(
      KNOWN_AI_EXIT_TAGS,
      mappings.map((m) => m.exit_tag)
    );
  }, [mappings]);

  const fetchMappings = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchErr } = await supabase
        .from('ai_exit_tag_outcome_map')
        .select('*')
        .eq('account_id', accountId)
        .order('exit_tag', { ascending: true });

      if (fetchErr) throw fetchErr;
      setMappings((data ?? []) as AiExitTagOutcomeMapRow[]);
    } catch (err: unknown) {
      console.error('[AiOutcomeMapSection] fetch error:', err);
      setError('Não foi possível carregar os mapeamentos da IA');
      toast.error('Falha ao carregar mapeamentos da IA');
    } finally {
      setLoading(false);
    }
  }, [accountId, supabase]);

  useEffect(() => {
    void fetchMappings();
  }, [fetchMappings]);

  function openAddDialog() {
    if (availableTags.length === 0) {
      toast.info('Todas as tags conhecidas da IA já foram mapeadas');
      return;
    }
    if (tabulacoes.length === 0) {
      toast.error(
        'Crie ao menos uma tabulação de desfecho antes de mapear tags'
      );
      return;
    }
    setSelectedTag(availableTags[0] ?? '');
    setSelectedOutcomeId(tabulacoes[0]?.id ?? '');
    setAddAutoClose(false);
    setAddDialogOpen(true);
  }

  async function handleCreateMapping() {
    if (!accountId) return;
    if (!selectedTag) {
      toast.error('Selecione uma tag de saída da IA');
      return;
    }
    if (!selectedOutcomeId) {
      toast.error('Selecione a tabulação correspondente');
      return;
    }

    setSavingNew(true);
    try {
      const { data, error: insertErr } = await supabase
        .from('ai_exit_tag_outcome_map')
        .insert({
          account_id: accountId,
          exit_tag: selectedTag,
          outcome_tag_id: selectedOutcomeId,
          auto_close: addAutoClose,
        })
        .select('*')
        .single();

      if (insertErr) throw insertErr;

      setMappings((prev) => [...prev, data as AiExitTagOutcomeMapRow]);
      setAddDialogOpen(false);
      toast.success(`Tag ${selectedTag} mapeada com sucesso`);
    } catch (err: unknown) {
      console.error('[AiOutcomeMapSection] insert error:', err);
      toast.error('Falha ao salvar mapeamento da tag');
    } finally {
      setSavingNew(false);
    }
  }

  async function handleOutcomeChange(
    row: AiExitTagOutcomeMapRow,
    newOutcomeId: string
  ) {
    if (row.outcome_tag_id === newOutcomeId) return;

    try {
      const { error: updateErr } = await supabase
        .from('ai_exit_tag_outcome_map')
        .update({
          outcome_tag_id: newOutcomeId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      if (updateErr) throw updateErr;

      setMappings((prev) =>
        prev.map((m) =>
          m.id === row.id ? { ...m, outcome_tag_id: newOutcomeId } : m
        )
      );
      toast.success(`Tabulação da tag ${row.exit_tag} atualizada`);
    } catch (err: unknown) {
      console.error('[AiOutcomeMapSection] update outcome error:', err);
      toast.error('Falha ao atualizar tabulação');
    }
  }

  function handleAutoCloseSwitchClick(
    row: AiExitTagOutcomeMapRow,
    nextChecked: boolean
  ) {
    if (!canEditSettings) return;

    if (nextChecked) {
      // Ao ligar o auto_close, solicita confirmação com aviso explícito
      setConfirmAutoCloseTarget(row);
    } else {
      // Desligar é operação segura imediata
      void updateAutoClose(row.id, row.exit_tag, false);
    }
  }

  async function updateAutoClose(id: string, tag: string, value: boolean) {
    setTogglingAutoClose(true);
    try {
      const { error: updateErr } = await supabase
        .from('ai_exit_tag_outcome_map')
        .update({
          auto_close: value,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (updateErr) throw updateErr;

      setMappings((prev) =>
        prev.map((m) => (m.id === id ? { ...m, auto_close: value } : m))
      );
      toast.success(
        value
          ? `Encerramento automático ativado para ${tag}`
          : `Encerramento automático desativado para ${tag}`
      );
    } catch (err: unknown) {
      console.error('[AiOutcomeMapSection] toggle auto_close error:', err);
      toast.error('Falha ao alterar encerramento automático');
    } finally {
      setTogglingAutoClose(false);
      setConfirmAutoCloseTarget(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error: deleteErr } = await supabase
        .from('ai_exit_tag_outcome_map')
        .delete()
        .eq('id', deleteTarget.id);

      if (deleteErr) throw deleteErr;

      setMappings((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      toast.success(`Mapeamento de ${deleteTarget.exit_tag} removido`);
      setDeleteTarget(null);
    } catch (err: unknown) {
      console.error('[AiOutcomeMapSection] delete error:', err);
      toast.error('Falha ao remover mapeamento');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="space-y-3.5 border-t border-border pt-6">
      <PageToolbar
        actions={
          canEditSettings ? (
            <Button
              onClick={openAddDialog}
              disabled={
                loading || availableTags.length === 0 || tabulacoes.length === 0
              }
            >
              <Plus className="size-4" aria-hidden="true" />
              Mapear tag da IA
            </Button>
          ) : null
        }
      >
        <p className="m-0 max-w-3xl text-[12.5px] text-muted-foreground">
          {SHOW_AUTO_CLOSE
            ? 'Associe tags de saída emitidas pelo fluxo da IA às tabulações de desfecho da conta. Opcionalmente, configure o encerramento automático da conversa ao emitir cada tag.'
            : 'Associe tags de saída emitidas pelo fluxo da IA às tabulações de desfecho da conta para classificar conversas automaticamente.'}
        </p>
      </PageToolbar>

      {!canEditSettings && (
        <p className="m-0 text-xs text-muted-foreground">
          Visualização somente leitura. Apenas administradores e proprietários
          da conta podem gerenciar as regras de tabulação automática.
          Supervisores e demais usuários têm acesso apenas para consulta.
        </p>
      )}

      <TableCard
        title="Tabulação automática pela IA"
        hint="Tag de saída emitida pelo fluxo da IA → tabulação de desfecho sugerida."
      >
        {loading ? (
          <div className="flex flex-col gap-2 px-[18px] pb-4" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            className="m-4 mt-0"
            title={error}
            onRetry={() => void fetchMappings()}
          />
        ) : mappings.length === 0 ? (
          <EmptyState
            className="m-4 mt-0"
            icon={Bot}
            title="Nenhuma tag da IA mapeada ainda"
            hint={
              tabulacoes.length === 0
                ? 'Cadastre ao menos uma tabulação de desfecho acima para começar a mapear.'
                : 'Mapeie as tags de saída dos fluxos (como #ACORDOFORMALIZADO ou #RECUSA_CONFIRMADA) para que as conversas recebam a tabulação sugerida correspondente.'
            }
          />
        ) : (
          <DenseTable minWidth={560}>
            <thead>
              <tr>
                <Th>Tag de saída da IA</Th>
                <Th>Tabulação sugerida</Th>
                {SHOW_AUTO_CLOSE && <Th align="center">Encerrar automaticamente</Th>}
                {canEditSettings && (
                  <Th align="right">
                    <span className="sr-only">Ações</span>
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {mappings.map((row) => {
                const matchedTag = tabulacaoById.get(row.outcome_tag_id);
                const tagDesc = getExitTagDescription(row.exit_tag);

                return (
                  <Tr key={row.id}>
                    {/* Tag IA */}
                    <Td>
                      <CellMain
                        title={<span className="font-mono text-xs">{row.exit_tag}</span>}
                        sub={tagDesc}
                      />
                    </Td>

                    {/* Tabulação */}
                    <Td>
                      {canEditSettings ? (
                        <div className="w-56 max-w-full">
                          <Select
                            value={row.outcome_tag_id}
                            onValueChange={(val) => {
                              if (val) void handleOutcomeChange(row, val);
                            }}
                          >
                            <SelectTrigger
                              className="h-8 text-xs"
                              aria-label={`Tabulação sugerida para ${row.exit_tag}`}
                            >
                              <SelectValue>
                                {(currentVal: string) => {
                                  const tag = tabulacaoById.get(currentVal);
                                  if (!tag) {
                                    return (
                                      <span className="text-muted-foreground italic">
                                        Selecione uma tabulação
                                      </span>
                                    );
                                  }
                                  return (
                                    <span className="flex items-center gap-1.5 truncate">
                                      <span
                                        className="size-2 shrink-0 rounded-full"
                                        style={{ backgroundColor: tag.color }}
                                        aria-hidden="true"
                                      />
                                      <span className="truncate">{tag.name}</span>
                                    </span>
                                  );
                                }}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {tabulacoes.map((t) => (
                                <SelectItem
                                  key={t.id}
                                  value={t.id}
                                  className="text-xs"
                                >
                                  <span className="flex items-center gap-1.5">
                                    <span
                                      className="size-2 shrink-0 rounded-full"
                                      style={{ backgroundColor: t.color }}
                                      aria-hidden="true"
                                    />
                                    <span>{t.name}</span>
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : matchedTag ? (
                        <Badge
                          className="border-border gap-1.5 border px-2 py-0.5 text-xs font-normal"
                          style={{
                            backgroundColor: `${matchedTag.color}15`,
                            borderColor: `${matchedTag.color}40`,
                            color: matchedTag.color,
                          }}
                        >
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: matchedTag.color }}
                            aria-hidden="true"
                          />
                          {matchedTag.name}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs italic">
                          Não configurada
                        </span>
                      )}
                    </Td>

                    {/* Encerrar automaticamente (Switch) — oculto por decisão de produto (SHOW_AUTO_CLOSE) */}
                    {SHOW_AUTO_CLOSE && (
                      <Td align="center">
                        <div className="flex flex-col items-center justify-center gap-1">
                          <Switch
                            id={`switch-auto-close-${row.id}`}
                            checked={row.auto_close}
                            onCheckedChange={(checked) =>
                              handleAutoCloseSwitchClick(row, checked)
                            }
                            disabled={!canEditSettings || togglingAutoClose}
                            aria-label={`Encerrar conversa automaticamente para ${row.exit_tag}`}
                          />
                          <span
                            className={`text-[10px] font-medium ${
                              row.auto_close
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-muted-foreground'
                            }`}
                          >
                            {row.auto_close ? 'Ativo' : 'Inativo'}
                          </span>
                        </div>
                      </Td>
                    )}

                    {/* Ações */}
                    {canEditSettings && (
                      <Td align="right">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setDeleteTarget(row)}
                          title={`Remover mapeamento da tag ${row.exit_tag}`}
                          aria-label={`Remover mapeamento da tag ${row.exit_tag}`}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </tbody>
          </DenseTable>
        )}
      </TableCard>

      {/* Modal: Adicionar Mapeamento */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mapear tag da IA</DialogTitle>
            <DialogDescription>
              Selecione uma tag de saída da IA e defina qual tabulação de
              desfecho deve ser registrada quando o fluxo emitir essa decisão.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Tag da IA */}
            <div className="space-y-2">
              <Label htmlFor="select-exit-tag">Tag de saída da IA</Label>
              <Select
                value={selectedTag}
                onValueChange={(val) => val && setSelectedTag(val)}
                disabled={savingNew}
              >
                <SelectTrigger id="select-exit-tag" className="w-full">
                  <SelectValue>
                    {(val: string) => (val ? val : 'Selecione uma tag')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {availableTags.map((t) => (
                    <SelectItem key={t} value={t}>
                      <span className="font-mono font-medium">{t}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTag && (
                <p className="text-muted-foreground text-xs">
                  {getExitTagDescription(selectedTag)}
                </p>
              )}
            </div>

            {/* Tabulação */}
            <div className="space-y-2">
              <Label htmlFor="select-outcome-tag">Tabulação sugerida</Label>
              <Select
                value={selectedOutcomeId}
                onValueChange={(val) => val && setSelectedOutcomeId(val)}
                disabled={savingNew}
              >
                <SelectTrigger id="select-outcome-tag" className="w-full">
                  <SelectValue>
                    {(val: string) => {
                      const tag = tabulacaoById.get(val);
                      if (!tag) return 'Selecione uma tabulação';
                      return (
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: tag.color }}
                            aria-hidden="true"
                          />
                          <span>{tag.name}</span>
                        </span>
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tabulacoes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: t.color }}
                          aria-hidden="true"
                        />
                        <span>{t.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Switch auto_close */}
            {SHOW_AUTO_CLOSE && (
              <div className="space-y-2 pt-2">
                <div className="border-border flex items-center justify-between gap-2 rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label
                      htmlFor="modal-auto-close"
                      className="text-foreground text-sm font-medium"
                    >
                      Encerrar automaticamente
                    </Label>
                    <p className="text-muted-foreground text-xs">
                      Finaliza e tabula a conversa sem necessidade de um
                      atendente humano.
                    </p>
                  </div>
                  <Switch
                    id="modal-auto-close"
                    checked={addAutoClose}
                    onCheckedChange={setAddAutoClose}
                    disabled={savingNew}
                  />
                </div>

                {addAutoClose && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      Aviso: Ao emitir esta tag, a conversa será encerrada e
                      tabulada imediatamente.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddDialogOpen(false)}
              disabled={savingNew}
            >
              Cancelar
            </Button>
            <Button onClick={handleCreateMapping} disabled={savingNew}>
              {savingNew ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando…
                </>
              ) : (
                'Mapear tag'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal: Confirmação de Ativação do Encerramento Automático */}
      {SHOW_AUTO_CLOSE && (
        <Dialog
          open={confirmAutoCloseTarget !== null}
          onOpenChange={(open) => !open && setConfirmAutoCloseTarget(null)}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-amber-600 dark:text-amber-400" />
                Confirmar encerramento automático?
              </DialogTitle>
              <DialogDescription className="text-muted-foreground space-y-2 pt-2 text-left text-sm">
                <span className="block">
                  Ao ativar esta opção para a tag{' '}
                  <strong className="text-foreground font-mono font-semibold">
                    {confirmAutoCloseTarget?.exit_tag}
                  </strong>
                  , qualquer conversa em que a IA emitir essa tag será{' '}
                  <strong>encerrada e tabulada imediatamente</strong> como
                  &quot;
                  {confirmAutoCloseTarget
                    ? (tabulacaoById.get(confirmAutoCloseTarget.outcome_tag_id)
                        ?.name ?? 'Tabulação configurada')
                    : ''}
                  &quot; <strong>sem passar por um atendente humano</strong>.
                </span>
                <span className="block text-xs font-medium text-amber-700 dark:text-amber-400">
                  Certifique-se de que o fluxo do bot já envia todas as
                  mensagens de despedida e conclusão necessárias antes de emitir
                  a tag.
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setConfirmAutoCloseTarget(null)}
                disabled={togglingAutoClose}
              >
                Cancelar
              </Button>
              <Button
                onClick={() => {
                  if (confirmAutoCloseTarget) {
                    void updateAutoClose(
                      confirmAutoCloseTarget.id,
                      confirmAutoCloseTarget.exit_tag,
                      true
                    );
                  }
                }}
                disabled={togglingAutoClose}
              >
                {togglingAutoClose ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Salvando…
                  </>
                ) : (
                  'Confirmar encerramento'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Modal: Exclusão de Mapeamento */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remover mapeamento</DialogTitle>
            <DialogDescription>
              Deseja remover o mapeamento da tag{' '}
              <strong className="text-foreground font-mono">
                {deleteTarget?.exit_tag}
              </strong>
              ? A IA não sugerirá mais essa tabulação ao emitir essa tag.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removendo…
                </>
              ) : (
                'Remover mapeamento'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
