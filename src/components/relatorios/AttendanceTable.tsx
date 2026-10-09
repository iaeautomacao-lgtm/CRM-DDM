"use client";

// ============================================================
// AttendanceTable — generic rows/columns table shared by the Por
// Equipe and Por Agente sections of /relatorios/atendimentos. Header
// tooltips use the same Info-icon + TooltipProvider pattern as
// src/components/pipelines/pipeline-analytics.tsx (no other tooltip
// provider wraps the app, so each table wraps its own).
// Visual: tabela densa do redesenho DDM (components/ddm/table-card).
// ============================================================

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { DenseTable, Td, Th, Tr } from "@/components/ddm/table-card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface AttendanceTableColumn<T> {
  key: string;
  header: string;
  /** Explains an acronym (TTA, TMA, ...) via an Info icon next to the header label. */
  tooltip?: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
  /** Footer cell for this column. Omit for columns with no meaningful total (e.g. a name column). */
  total?: (rows: T[]) => ReactNode;
}

export function AttendanceTable<T>({
  rows,
  columns,
  getRowKey,
  emptyMessage = "Nenhum dado no período selecionado.",
}: {
  rows: T[];
  columns: AttendanceTableColumn<T>[];
  getRowKey: (row: T) => string;
  emptyMessage?: string;
}) {
  return (
    <TooltipProvider>
      <div className="overflow-x-auto">
        <DenseTable>
          <thead>
            <tr>
              {columns.map((col) => (
                <Th key={col.key} align={col.align === "right" ? "right" : "left"}>
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.tooltip && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground"
                              aria-label={`Sobre ${col.header}`}
                            />
                          }
                        >
                          <Info className="h-3 w-3" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-left">
                          {col.tooltip}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <Tr interactive={false}>
                <Td colSpan={columns.length} align="center" className="py-6 text-muted-foreground">
                  {emptyMessage}
                </Td>
              </Tr>
            ) : (
              rows.map((row) => (
                <Tr key={getRowKey(row)}>
                  {columns.map((col) => (
                    <Td key={col.key} align={col.align === "right" ? "right" : "left"}>
                      {col.render(row)}
                    </Td>
                  ))}
                </Tr>
              ))
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <Tr interactive={false}>
                {columns.map((col, i) => (
                  <Td key={col.key} align={col.align === "right" ? "right" : "left"} className="bg-surface-3 font-semibold">
                    {i === 0 ? "Total" : col.total ? col.total(rows) : null}
                  </Td>
                ))}
              </Tr>
            </tfoot>
          )}
        </DenseTable>
      </div>
    </TooltipProvider>
  );
}
