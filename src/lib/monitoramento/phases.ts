import { Bot, Clock, UserCheck } from "lucide-react";
import type { ComponentType } from "react";
import type { ConversationStatus } from "@/types";

export type MonitorPhase = "navegando" | "espera" | "atendimento";

export const PHASE_ORDER: MonitorPhase[] = ["navegando", "espera", "atendimento"];

export interface PhaseMeta {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Tailwind classes (bg + text) shared by the column header badge and
   *  the per-card phase indicator, so both surfaces stay in lockstep. */
  badgeClass: string;
  emptyTitle: string;
  emptyHint: string;
}

export const PHASE_META: Record<MonitorPhase, PhaseMeta> = {
  navegando: {
    label: "Navegando",
    icon: Bot,
    // Mirrors the "IA Conversando" tag color from migration 036.
    badgeClass: "bg-blue-500/10 text-blue-500",
    emptyTitle: "Nenhuma conversa navegando",
    emptyHint: "Conversas atendidas automaticamente pelo bot aparecem aqui.",
  },
  espera: {
    label: "Em espera",
    icon: Clock,
    // Mirrors the "pending" status color used across the dashboard/inbox.
    badgeClass: "bg-amber-500/10 text-amber-500",
    emptyTitle: "Nenhuma conversa em espera",
    emptyHint: "Conversas repassadas pelo bot, aguardando um atendente, aparecem aqui.",
  },
  atendimento: {
    label: "Em atendimento",
    icon: UserCheck,
    // Mirrors the "Atendimento Humano" tag color from migration 036.
    badgeClass: "bg-emerald-500/10 text-emerald-500",
    emptyTitle: "Nenhuma conversa em atendimento",
    emptyHint: "Conversas com um atendente humano ativo aparecem aqui.",
  },
};

/**
 * Classifies a conversation into a Fortics-style phase from status +
 * assignment alone — the same two signals migration 036's trigger uses
 * to auto-tag contacts as "IA Conversando" / "Atendimento Humano", but
 * evaluated per CONVERSATION here (the tags are per-contact and would
 * ambiguate a contact with more than one conversation in flight).
 *
 * Assignment wins over status: a `pending` conversation that already has
 * an agent (e.g. a flow handoff with `assign_to` set) is "em atendimento",
 * not "em espera" — the human has already been identified, just hasn't
 * necessarily sent the first reply yet.
 */
export function classifyPhase(
  status: ConversationStatus,
  assignedAgentId: string | null | undefined,
): MonitorPhase {
  if (assignedAgentId) return "atendimento";
  if (status === "pending") return "espera";
  return "navegando";
}
