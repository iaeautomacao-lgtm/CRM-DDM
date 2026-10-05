"use client";

// ============================================================
// AuditDetailModal — detalhe de um registro de auditoria, aberto pelo
// ícone de olho em /relatorios/auditoria: quem fez (usuário ou ator
// automático), IP, navegador, origem, antes/depois com nomes resolvidos
// pelas triggers (migration 131), detalhes extras (motivo da
// transferência, contato unido...) e o histórico completo do recurso.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Eye, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { apiFetch } from "@/lib/api-fetch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ACTOR_LABEL,
  actionLabel,
  actorLabel,
  displayValue,
  EVENT_LABEL,
  fieldLabel,
  RESOURCE_LABEL,
  type AuditLog,
} from "@/lib/audit/labels";

export type { AuditLog } from "@/lib/audit/labels";

export const EVENT_BADGE: Record<AuditLog["event_type"], string> = {
  created: "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  updated: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  deleted: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  action: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
};

/** Link para abrir o recurso, quando existe uma tela para ele. */
function resourceHref(log: AuditLog): string | null {
  if (log.event_type === "deleted") return null;
  switch (log.resource_type) {
    case "conversation":
      return `/inbox?c=${log.resource_id}`;
    case "flow":
      return `/flows/${log.resource_id}`;
    case "automation":
      return `/automations/${log.resource_id}/edit`;
    default:
      return null;
  }
}

const METADATA_LABEL: Record<string, string> = {
  reason: "Motivo",
  merged_contact_id: "Contato unido (ID)",
  matched_by: "Unido por",
  tag: "Etiqueta",
  status: "Métrica",
  search: "Busca",
  rows: "Linhas",
  phone: "Telefone",
  email: "E-mail",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  );
}

export function AuditDetailModal({
  log,
  open,
  onOpenChange,
  onSelect,
}: {
  log: AuditLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Abre outro registro do histórico no mesmo modal. */
  onSelect?: (log: AuditLog) => void;
}) {
  const resourceId = log?.resource_id ?? null;
  const [history, setHistory] = useState<{ resourceId: string; logs: AuditLog[] } | null>(null);

  useEffect(() => {
    if (!open || !resourceId) return;
    let cancelled = false;
    apiFetch(`/api/audit-logs?resource_id=${resourceId}&pageSize=50`)
      .then((r) => (r.ok ? r.json() : { logs: [] }))
      .then((json) => {
        if (!cancelled) setHistory({ resourceId, logs: json.logs ?? [] });
      })
      .catch(() => {
        if (!cancelled) setHistory({ resourceId, logs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [open, resourceId]);

  if (!log) return null;
  const historyLogs = history && history.resourceId === resourceId ? history.logs : null;
  const changeEntries = log.changes ? Object.entries(log.changes) : [];
  const metaEntries = log.metadata
    ? Object.entries(log.metadata).filter(([k, v]) => METADATA_LABEL[k] && v !== null && v !== "")
    : [];
  const href = resourceHref(log);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4 text-muted-foreground" />
            {actionLabel(log)}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {log.summary && <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-foreground">{log.summary}</p>}

          <div className="space-y-1.5">
            <Row label="Quando">{format(new Date(log.created_at), "dd/MM/yyyy HH:mm:ss")}</Row>
            <Row label="Evento">
              <Badge className={EVENT_BADGE[log.event_type]}>{EVENT_LABEL[log.event_type]}</Badge>
            </Row>
            <Row label="Recurso">
              {RESOURCE_LABEL[log.resource_type] ?? log.resource_type}
              {log.resource_label ? ` — ${log.resource_label}` : ""}
              {href && (
                <Link href={href} className="ml-2 inline-flex items-center gap-0.5 text-xs text-primary hover:underline">
                  abrir <ExternalLink className="size-3" />
                </Link>
              )}
            </Row>
            <Row label="ID do recurso">
              <code className="text-xs">{log.resource_id}</code>
            </Row>
            <Row label="Quem">
              {actorLabel(log)}
              {log.user_id && log.actor_type && log.actor_type !== "user" && (
                <span className="text-muted-foreground"> ({ACTOR_LABEL[log.actor_type] ?? log.actor_type})</span>
              )}
            </Row>
            <Row label="IP">{log.ip_address ?? "—"}</Row>
            <Row label="Origem">{log.source ?? "—"}</Row>
            <Row label="Navegador">
              <span className="text-xs text-muted-foreground">{log.user_agent ?? "—"}</span>
            </Row>
          </div>

          {metaEntries.length > 0 && (
            <div className="space-y-1.5 border-t border-border pt-3">
              <p className="text-xs font-medium text-muted-foreground">Detalhes</p>
              {metaEntries.map(([k, v]) => (
                <Row key={k} label={METADATA_LABEL[k]}>
                  {displayValue(v)}
                </Row>
              ))}
            </div>
          )}

          <div className="border-t border-border pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Alterações</p>
            {changeEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum campo alterado neste evento</p>
            ) : (
              <div className="space-y-3">
                {changeEntries.map(([field, { before, after }]) => (
                  <div key={field}>
                    <p className="mb-1 text-xs font-medium text-foreground">{fieldLabel(field)}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-red-50 px-3 py-2 text-sm break-words text-red-800 dark:bg-red-500/10 dark:text-red-300">
                        {displayValue(before)}
                      </div>
                      <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm break-words text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                        {displayValue(after)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-border pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Histórico deste recurso</p>
            {historyLogs === null ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : historyLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem outros eventos</p>
            ) : (
              <ul className="space-y-1">
                {historyLogs.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(h)}
                      className={`flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted ${
                        h.id === log.id ? "bg-muted" : ""
                      }`}
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {format(new Date(h.created_at), "dd/MM HH:mm")}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{h.summary ?? actionLabel(h)}</span>
                      <span className="shrink-0 text-muted-foreground">{actorLabel(h)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
