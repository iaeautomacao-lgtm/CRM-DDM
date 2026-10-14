"use client";

import { Fragment } from "react";

import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { ATRIBUICAO_LABEL, type Atribuicao, type PorAtendente, type PorAtribuicao } from "@/lib/utmpay/api-client";
import { cn } from "@/lib/utils";

const ORDER: Atribuicao[] = ["direto", "ia", "humano"];
// Matizes distintos e legíveis nos dois temas, com rótulo de texto ao lado (nunca só cor).
const SEG_CLASS: Record<Atribuicao, string> = { direto: "bg-info-fill", ia: "bg-primary-solid", humano: "bg-success-fill" };

/** Barra "quem fechou" (Direto / IA / Humano) com legenda e números. */
export function AttributionBar({ titulo, valores }: { titulo: string; valores: PorAtribuicao }) {
  const total = valores.direto + valores.ia + valores.humano;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[12.5px] font-semibold text-foreground">
        {titulo} <span className="font-normal tabular-nums text-muted-foreground">· {total.toLocaleString("pt-BR")}</span>
      </p>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${titulo}: ${ORDER.map((k) => `${ATRIBUICAO_LABEL[k]} ${valores[k]}`).join(", ")}`}>
        {total > 0 &&
          ORDER.map((k) => (valores[k] > 0 ? <span key={k} className={cn("h-full", SEG_CLASS[k])} style={{ width: `${(valores[k] / total) * 100}%` }} /> : null))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-2">
        {ORDER.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 tabular-nums">
            <span aria-hidden="true" className={cn("size-2 rounded-[2px]", SEG_CLASS[k])} />
            {ATRIBUICAO_LABEL[k]} · {valores[k].toLocaleString("pt-BR")}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Ranking de atendentes por acordos fechados e pagos (a API já manda ordenado). */
export function AttendantRanking({ items }: { items: PorAtendente[] }) {
  if (items.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Nenhum atendente humano fechou acordo neste período.</p>;
  }
  return (
    <TableCard>
      <DenseTable minWidth={360}>
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Atendente</Th>
            <Th align="right">Fechou</Th>
            <Th align="right">Pagou</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <Fragment key={a.atendente_id || i}>
              <Tr interactive={false}>
                <Td className="tabular-nums text-muted-foreground">{i + 1}</Td>
                <Td>
                  <CellMain title={a.atendente_nome} />
                </Td>
                <Td align="right" className="tabular-nums">
                  {a.fechou.toLocaleString("pt-BR")}
                </Td>
                <Td align="right" className="tabular-nums font-semibold">
                  {a.pagou.toLocaleString("pt-BR")}
                </Td>
              </Tr>
            </Fragment>
          ))}
        </tbody>
      </DenseTable>
    </TableCard>
  );
}
