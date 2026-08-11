"use client";

// ============================================================
// AuditDetailModal — detail view for a single audit_logs row,
// opened from the Eye icon in /relatorios/auditoria's table.
// ============================================================

import { Eye } from "lucide-react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

export interface AuditLog {
  id: string;
  account_id: string;
  event_type: "created" | "updated" | "deleted";
  resource_type: string;
  resource_id: string;
  resource_label: string | null;
  user_id: string | null;
  user_name: string | null;
  ip_address: string | null;
  changes: Record<string, { before: unknown; after: unknown }> | null;
  created_at: string;
}

const RESOURCE_LABEL: Record<string, string> = {
  contact: "Contato",
  conversation: "Conversa",
};

const EVENT_BADGE: Record<AuditLog["event_type"], { label: string; className: string }> = {
  created: { label: "Criado", className: "bg-[#CCFBF1] text-[#0F766E]" },
  updated: { label: "Atualizado", className: "bg-[#DBEAFE] text-[#1D4ED8]" },
  deleted: { label: "Deletado", className: "bg-[#FEE2E2] text-[#B91C1C]" },
};

// Matches the column names the trigger functions in
// supabase/migrations/050_audit_logs.sql actually diff — contacts:
// name/phone/email/company; conversations: status/assigned_agent_id/
// team_id/waha_session.
const FIELD_LABEL: Record<string, string> = {
  name: "Nome",
  phone: "Telefone",
  email: "E-mail",
  company: "Empresa",
  status: "Status",
  assigned_agent_id: "Agente responsável",
  team_id: "Equipe",
  waha_session: "Canal (WAHA)",
};

function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(vazio)";
  return String(value);
}

export function AuditDetailModal({
  log,
  open,
  onOpenChange,
}: {
  log: AuditLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!log) return null;

  const badge = EVENT_BADGE[log.event_type];
  const changeEntries = log.changes ? Object.entries(log.changes) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4 text-muted-foreground" />
            Auditoria
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-foreground">
              {RESOURCE_LABEL[log.resource_type] ?? log.resource_type}
              {log.resource_label ? ` — ${log.resource_label}` : ""}
            </span>
            <span className="text-muted-foreground">
              {format(new Date(log.created_at), "dd/MM/yyyy HH:mm:ss")}
            </span>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Badge className={badge.className}>{badge.label}</Badge>
            <span>pelo usuário {log.user_name ?? "-"}</span>
          </div>

          <div className="text-sm text-muted-foreground">{log.ip_address ?? "-"}</div>

          <div className="border-t border-border pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Campo alterado:</p>
            {changeEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma alteração registrada</p>
            ) : (
              <div className="space-y-3">
                {changeEntries.map(([field, { before, after }]) => (
                  <div key={field}>
                    <p className="mb-1 text-xs font-medium text-foreground">{fieldLabel(field)}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B] break-words">
                        {displayValue(before)}
                      </div>
                      <div className="rounded-lg bg-[#F0FDF4] px-3 py-2 text-sm text-[#166534] break-words">
                        {displayValue(after)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
