"use client";

// ============================================================
// TransferDialog — "Transferir para" action from a ConversationCard's
// ⋮ menu. Agent and team are independent fields (investigation:
// conversations_update RLS — 017_account_sharing.sql:416 — is a
// whole-row, agent+ policy with no column restriction, so there's no
// authorization reason to couple them). Either, both, or neither can
// change; only fields that actually changed get written.
//
// Writes go through src/lib/conversations/actions.ts — the SAME
// functions message-thread.tsx's assign dropdown now calls too, not a
// second implementation.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { assignConversationAgent, assignConversationTeam } from "@/lib/conversations/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import type { MonitorConversation } from "@/lib/monitoramento/queries";
import type { MultiSelectOption } from "./multi-select-filter";

const NO_AGENT = "__none__";
const NO_TEAM = "__none__";

export function TransferDialog({
  conversation,
  onOpenChange,
  agentOptions,
  teamOptions,
  onTransferred,
}: {
  /** null = closed. Non-null opens the dialog for this conversation. */
  conversation: MonitorConversation | null;
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!conversation) return;
    setAgentId(conversation.assigned_agent_id ?? NO_AGENT);
    setTeamId(conversation.team_id ?? NO_TEAM);
  }, [conversation]);

  async function handleTransfer() {
    if (!conversation) return;
    setSaving(true);
    try {
      const db = createClient();
      const nextAgentId = agentId === NO_AGENT ? null : agentId;
      const nextTeamId = teamId === NO_TEAM ? null : teamId;

      if (nextAgentId !== (conversation.assigned_agent_id ?? null)) {
        const agentName = agentOptions.find((o) => o.id === nextAgentId)?.label;
        const { error } = await assignConversationAgent(
          db,
          conversation.id,
          nextAgentId,
          agentName,
        );
        if (error) throw new Error(error);
      }

      if (nextTeamId !== (conversation.team_id ?? null)) {
        const { error } = await assignConversationTeam(db, conversation.id, nextTeamId);
        if (error) throw new Error(error);
      }

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
            Escolha um agente e/ou uma equipe — os dois são independentes, mude
            só o que precisar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Agente</Label>
            <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
              <SelectTrigger className="w-full">
                {/* Bare <SelectValue /> shows the raw id once selected —
                    same Base UI quirk fixed in members-tab.tsx. Resolve
                    the label ourselves. */}
                <SelectValue>
                  {(v: string) =>
                    v === NO_AGENT ? "Sem agente" : agentOptions.find((o) => o.id === v)?.label ?? "Sem agente"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_AGENT}>Sem agente</SelectItem>
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
