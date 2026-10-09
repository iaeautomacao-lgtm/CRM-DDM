"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("pt-BR", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Iniciais (primeiro + último nome), como nos avatares do protótipo DDM. */
function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return ((parts[0][0] ?? "") + last).toUpperCase();
}

/** Cartão de negócio no quadro do funil (redesenho DDM). */
export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const contactLabel = deal.contact?.name || deal.contact?.phone || "Sem contato";
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      aria-label={`${deal.title} — ${contactLabel}`}
      data-no-ripple
      className={cn(
        "relative flex w-full cursor-grab flex-col gap-2 rounded-lg border border-border bg-card py-[11px] pl-[15px] pr-3 text-left shadow-[0_1px_2px_rgba(20,16,12,.06)] transition-[border-color,box-shadow,transform] duration-200 ease-ddm",
        isOverlay
          ? "rotate-[1.5deg] cursor-grabbing border-border-strong shadow-overlay"
          : "hover:border-border-strong hover:shadow-overlay",
      )}
    >
      {/* Fio de 3px na cor da etapa */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-lg"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-snug text-foreground">
          {deal.title}
        </span>
        {deal.status === "won" && (
          <span className="inline-flex h-[22px] shrink-0 items-center gap-[3px] rounded-full bg-success-soft px-[7px] text-[11px] font-semibold text-success">
            <Check className="size-3" aria-hidden="true" />
            Ganho
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex h-[22px] shrink-0 items-center gap-[3px] rounded-full bg-danger-soft px-[7px] text-[11px] font-semibold text-danger">
            <X className="size-3" aria-hidden="true" />
            Perdido
          </span>
        )}
      </span>

      <span className="flex min-w-0 items-center gap-[7px]">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-card-2 text-[10px] font-bold text-foreground-2" aria-hidden="true">
          {initials(deal.contact?.name, deal.contact?.phone ?? undefined)}
        </span>
        <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
      </span>

      <span className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-bold tabular-nums text-foreground">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        <span className="flex items-center gap-1.5">
          {deal.expected_close_date && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Calendar className="size-3" aria-hidden="true" />
              {formatDate(deal.expected_close_date)}
            </span>
          )}
          {assigneeLabel && (
            <span
              title={assigneeLabel}
              className="flex size-5 items-center justify-center rounded-full bg-primary-soft text-[10px] font-bold text-primary-text"
            >
              {initials(assigneeLabel)}
              <span className="sr-only"> — responsável: {assigneeLabel}</span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
