"use client";

// ============================================================
// TransferDialog — "Transferir para" action from a ConversationCard's
// ⋮ menu. Agent and team are independent fields (investigation:
// conversations_update RLS — 017_account_sharing.sql:416 — is a
// whole-row, agent+ policy with no column restriction, so there's no
// authorization reason to couple them). Either, both, or neither can
// change; only fields that actually changed get written.
//
// Writes go through transferConversation (src/lib/conversations/actions.ts)
// → POST /api/conversations/[id]/transfer: um único UPDATE e o motivo
// gravado no histórico conversation_assignments. Usado no Monitoramento e
// no cabeçalho da conversa no inbox.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { transferConversation } from "@/lib/conversations/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MultiSelectOption } from "./multi-select-filter";

const NO_AGENT = "__none__";
const NO_TEAM = "__none__";

/** O mínimo que o diálogo precisa (MonitorConversation e Conversation servem). */
export interface TransferTarget {
  id: string;
  assigned_agent_id: string | null;
  team_id: string | null;
}

export function TransferDialog({
  conversation,
  onOpenChange,
  agentOptions,
  teamOptions,
  onTransferred,
}: {
  /** null = closed. Non-null opens the dialog for this conversation. */
  conversation: TransferTarget | null;
  onOpenChange: (open: boolean) => void;
  agentOptions: MultiSelectOption[];
  teamOptions: MultiSelectOption[];
  /** Called after a successful transfer — page updates its own Map
   *  optimistically via the same realtime patch path, this is just
   *  for the dialog's own toast/close bookkeeping. */
  onTransferred?: () => void;
}) {
  const [agentId, setAgentId] = useState(NO_AGENT);
  const [teamId, setTeamId] = useState(NO_TEAM);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!conversation) return;
    setAgentId(conversation.assigned_agent_id ?? NO_AGENT);
    setTeamId(conversation.team_id ?? NO_TEAM);
    setReason("");
  }, [conversation]);

  async function handleTransfer() {
    if (!conversation) return;
    setSaving(true);
    try {
      const nextAgentId = agentId === NO_AGENT ? null : agentId;
      const nextTeamId = teamId === NO_TEAM ? null : teamId;
      const agentChanged = nextAgentId !== (conversation.assigned_agent_id ?? null);
      const teamChanged = nextTeamId !== (conversation.team_id ?? null);
      if (!agentChanged && !teamChanged) {
        onOpenChange(false);
        return;
      }

      const { error } = await transferConversation(
        conversation.id,
        {
          agentId: agentChanged ? nextAgentId : undefined,
          teamId: teamChanged ? nextTeamId : undefined,
          reason,
        },
        agentOptions.find((o) => o.id === nextAgentId)?.label,
      );
      if (error) throw new Error(error);

      toast.success("Conversa transferida");
      onTransferred?.();
      onOpenChange(false);
    } catch (err) {
      console.error("[TransferDialog] transfer error:", err);
      const msg = err instanceof Error ? err.message : "Falha ao transferir conversa";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={conversation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transferir para</DialogTitle>
          <DialogDescription>
            Escolha um atendente e/ou uma equipe — os dois são independentes, mude
            só o que precisar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Atendente</Label>
            <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
              <SelectTrigger className="w-full">
                {/* Bare <SelectValue /> shows the raw id once selected —
                    same Base UI quirk fixed in members-tab.tsx. Resolve
                    the label ourselves. */}
                <SelectValue>
                  {(v: string) =>
                    v === NO_AGENT ? "Sem atendente" : agentOptions.find((o) => o.id === v)?.label ?? "Sem atendente"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_AGENT}>Sem atendente</SelectItem>
                {agentOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Equipe</Label>
            <Select value={teamId} onValueChange={(v) => v && setTeamId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v: string) =>
                    v === NO_TEAM ? "Sem equipe" : teamOptions.find((o) => o.id === v)?.label ?? "Sem equipe"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEAM}>Sem equipe</SelectItem>
                {teamOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="transfer-reason">Motivo (opcional)</Label>
            <Textarea
              id="transfer-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Ex.: cliente pediu negociação, fora do meu horário…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleTransfer} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Transferindo…
              </>
            ) : (
              "Transferir"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
