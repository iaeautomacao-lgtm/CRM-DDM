"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Square, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, ErrorState } from "@/components/ddm/states";
import { billingFetch, errorMessage } from "@/lib/billing/client-api";
import {
  ENROLLMENT_STATUS_LABEL,
  STOP_REASON_LABEL,
  formatCents,
  formatCivilDate,
  type EnrollmentRow,
  type EnrollmentStatus,
  type Ruler,
  type StopReason,
} from "@/lib/billing/client-types";

const SELECT_CLASS =
  "h-[34px] rounded-md border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/20";

const STATUS_TONE: Record<EnrollmentStatus, StatusTone> = { active: "ok", paused: "warn", stopped: "mute", completed: "info" };

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
}

type Action = "pause" | "resume" | "stop";
const ACTION_DONE: Record<Action, string> = { pause: "Cobrança pausada", resume: "Cobrança retomada", stop: "Cobrança parada" };

/** Inscrições (uma por dívida e régua): lista paginada por cursor com pausa, retomada e parada manual (billing.manage). */
export function EnrollmentsTab({ rulers, canManage }: { rulers: Ruler[]; canManage: boolean }) {
  const [status, setStatus] = useState("");
  const [motivo, setMotivo] = useState("");
  const [rulerId, setRulerId] = useState("");
  const [rows, setRows] = useState<EnrollmentRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stopTarget, setStopTarget] = useState<EnrollmentRow | null>(null);
  const [stopReason, setStopReason] = useState("");
  const reqRef = useRef(0);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const req = ++reqRef.current;
      if (after) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: "50" });
        if (status) qs.set("status", status);
        if (motivo) qs.set("motivo", motivo);
        if (rulerId) qs.set("ruler_id", rulerId);
        if (after) qs.set("cursor", after);
        const res = await billingFetch<{ enrollments: EnrollmentRow[]; next_cursor: string | null }>(`/enrollments?${qs.toString()}`);
        if (req !== reqRef.current) return;
        setRows((prev) => (after ? [...prev, ...res.enrollments] : res.enrollments));
        setCursor(res.next_cursor);
      } catch (err) {
        if (req !== reqRef.current) return;
        setError(errorMessage(err));
      } finally {
        if (req === reqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [status, motivo, rulerId],
  );

  useEffect(() => {
    void fetchPage(null);
  }, [fetchPage]);

  async function act(row: EnrollmentRow, action: Action, reason?: string) {
    setBusyId(row.id);
    try {
      await billingFetch(`/enrollments/${row.id}/${action}`, { method: "POST", body: reason ? { motivo: reason } : {} });
      toast.success(ACTION_DONE[action]);
      // Recarrega a primeira página: o status mudou e o filtro ativo pode excluir a linha.
      await fetchPage(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  const rulerName = (id: string) => rulers.find((r) => r.id === id)?.name ?? "—";

  return (
    <div className="flex flex-col gap-3.5">
      <PageToolbar>
        <select className={SELECT_CLASS} aria-label="Filtrar por status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          {(Object.keys(ENROLLMENT_STATUS_LABEL) as EnrollmentStatus[]).map((s) => (
            <option key={s} value={s}>
              {ENROLLMENT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select className={SELECT_CLASS} aria-label="Filtrar por motivo de parada" value={motivo} onChange={(e) => setMotivo(e.target.value)}>
          <option value="">Todos os motivos</option>
          {(Object.keys(STOP_REASON_LABEL) as StopReason[]).map((m) => (
            <option key={m} value={m}>
              {STOP_REASON_LABEL[m]}
            </option>
          ))}
        </select>
        <select className={SELECT_CLASS} aria-label="Filtrar por régua" value={rulerId} onChange={(e) => setRulerId(e.target.value)}>
          <option value="">Todas as réguas</option>
          {rulers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </PageToolbar>

      {error && !loading ? (
        <ErrorState className="min-h-0" title="Não foi possível carregar as inscrições" hint={error} onRetry={() => void fetchPage(null)} />
      ) : (
        <TableCard label="Inscrições na régua">
          <DenseTable minWidth={900} aria-busy={loading || undefined}>
            <thead>
              <tr>
                <Th>Contato</Th>
                <Th>Régua</Th>
                <Th>Vencimento</Th>
                <Th align="right">Valor</Th>
                <Th>Situação</Th>
                <Th>Próxima etapa</Th>
                {canManage && <Th align="right">Ações</Th>}
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: canManage ? 7 : 6 }).map((__, j) => (
                      <Td key={j}>
                        <Skeleton className="h-3 w-24" />
                      </Td>
                    ))}
                  </tr>
                ))}
              {!loading &&
                rows.map((r, i) => (
                  <Tr key={r.id} interactive={false} className="animate-ddm-row" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                    <Td>
                      <CellMain title={r.contact?.name?.trim() || "Contato sem nome"} sub={r.debt?.external_ref} />
                    </Td>
                    <Td>{rulerName(r.ruler_id)}</Td>
                    <Td className="tabular-nums">{formatCivilDate(r.debt?.due_date)}</Td>
                    <Td align="right">{formatCents(r.debt?.amount_cents)}</Td>
                    <Td>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <StatusChip tone={STATUS_TONE[r.status]}>{ENROLLMENT_STATUS_LABEL[r.status]}</StatusChip>
                        {r.stop_reason && <span className="text-xs text-muted-foreground">{STOP_REASON_LABEL[r.stop_reason]}</span>}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{fmtDateTime(r.next_step_at)}</Td>
                    {canManage && (
                      <Td align="right">
                        <span className="inline-flex gap-1">
                          {r.status === "active" && (
                            <Button type="button" size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => void act(r, "pause")}>
                              <Pause className="size-3.5" />
                              Pausar
                            </Button>
                          )}
                          {r.status === "paused" && (
                            <Button type="button" size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => void act(r, "resume")}>
                              <Play className="size-3.5" />
                              Retomar
                            </Button>
                          )}
                          {(r.status === "active" || r.status === "paused") && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-danger"
                              disabled={busyId === r.id}
                              onClick={() => {
                                setStopReason("");
                                setStopTarget(r);
                              }}
                            >
                              <Square className="size-3.5" />
                              Parar
                            </Button>
                          )}
                        </span>
                      </Td>
                    )}
                  </Tr>
                ))}
            </tbody>
          </DenseTable>
          {!loading && rows.length === 0 && (
            <EmptyState icon={Users} title="Nenhuma inscrição" hint="As dívidas entram na régua quando ela está ligada." className="m-4 min-h-32" />
          )}
        </TableCard>
      )}

      {cursor && !loading && !error && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void fetchPage(cursor)}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}

      <AlertDialog open={!!stopTarget} onOpenChange={(o) => !o && setStopTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Parar a cobrança desta dívida?</AlertDialogTitle>
            <AlertDialogDescription>
              Nenhuma etapa futura será enviada e as que ainda não saíram serão canceladas. A dívida em si não é alterada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex flex-col gap-1 text-xs text-foreground-2">
            Motivo (opcional, não escreva CPF nem telefone)
            <Input value={stopReason} maxLength={200} onChange={(e) => setStopReason(e.target.value)} />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = stopTarget;
                setStopTarget(null);
                if (target) void act(target, "stop", stopReason.trim() || undefined);
              }}
            >
              Parar cobrança
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
