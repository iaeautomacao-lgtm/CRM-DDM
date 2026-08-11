"use client";

// ============================================================
// AttendanceTable — generic rows/columns table shared by the Por
// Equipe and Por Agente sections of /relatorios/atendimentos. Header
// tooltips use the same Info-icon + TooltipProvider pattern as
// src/components/pipelines/pipeline-analytics.tsx (no other tooltip
// provider wraps the app, so each table wraps its own).
// ============================================================

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} className={cn(col.align === "right" && "text-right")}>
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
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length}
                className="py-6 text-center text-sm text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={getRowKey(row)} className="hover:bg-[#FFF7F4]">
                {columns.map((col) => (
                  <TableCell key={col.key} className={cn(col.align === "right" && "text-right")}>
                    {col.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
        {rows.length > 0 && (
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              {columns.map((col, i) => (
                <TableCell
                  key={col.key}
                  className={cn("font-semibold", col.align === "right" && "text-right")}
                >
                  {i === 0 ? "Total" : col.total ? col.total(rows) : null}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </TooltipProvider>
  );
}
