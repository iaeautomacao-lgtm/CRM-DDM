'use client';

// Padrão "lista + gaveta" do redesenho DDM (protótipo 09/10): cartão de lista com linhas selecionáveis e uma gaveta
// à direita com o detalhe. A gaveta usa o Sheet (Base UI): foco preso, Esc fecha, devolve o foco ao fechar.
// Compartilhado pelas telas do redesenho (Farol, Lume, Vitral) — combine antes de mudar a API.
//
//   <ListCard>
//     {items.map((it, i) => (
//       <ListRow key={it.id} index={i} selected={it.id === sel} onSelect={() => setSel(it.id)} label={it.name}>…</ListRow>
//     ))}
//   </ListCard>
//   <DetailDrawer open={!!sel} onOpenChange={(o) => !o && setSel(null)} title="…" footer={<Button>Salvar</Button>}>…</DetailDrawer>

import * as React from 'react';

import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';

/** Cartão que agrupa as linhas (borda, raio e divisórias do protótipo). */
export function ListCard({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="ddm-list-card"
      role="list"
      className={cn('divide-border overflow-hidden rounded-xl border bg-card divide-y', className)}
      {...props}
    >
      {children}
    </div>
  );
}

/** Atraso da entrada escalonada das linhas (ms), com teto para listas longas. */
export function rowDelay(index: number | undefined): number | undefined {
  if (index === undefined || index < 0) return undefined;
  return Math.min(index, 12) * 30;
}

export interface ListRowProps extends Omit<React.ComponentProps<'div'>, 'onSelect'> {
  /** Linha aberta na gaveta (fundo de seleção e aria-current). */
  selected?: boolean;
  /** Clique ou Enter/Espaço na linha. Sem ele a linha é só leitura. */
  onSelect?: () => void;
  /** Nome acessível da linha (ex.: o nome do item). */
  label?: string;
  /** Posição na lista, para a entrada escalonada (animate-ddm-row). */
  index?: number;
}

/**
 * Linha selecionável. Controles internos (switch, botões, links) continuam funcionando: o clique neles não abre a
 * gaveta (ficam fora do onSelect via stopPropagation do próprio controle ou pelo filtro abaixo).
 */
export function ListRow({ selected, onSelect, label, index, className, style, children, ...props }: ListRowProps) {
  const interactive = !!onSelect;
  const fromControl = (target: EventTarget | null, row: HTMLElement) => {
    const el = target as HTMLElement | null;
    const control = el?.closest('button, a, input, select, textarea, label, [role="switch"], [role="checkbox"], [data-row-ignore]');
    return !!control && control !== row && row.contains(control);
  };
  return (
    <div
      data-slot="ddm-list-row"
      role="listitem"
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      tabIndex={interactive ? 0 : undefined}
      data-selected={selected ? '' : undefined}
      onClick={
        interactive
          ? (e) => {
              if (fromControl(e.target, e.currentTarget)) return;
              onSelect?.();
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect?.();
              }
            }
          : undefined
      }
      style={{ ...style, animationDelay: rowDelay(index) !== undefined ? `${rowDelay(index)}ms` : undefined }}
      className={cn(
        'animate-ddm-row flex items-center gap-3 px-4 py-3 text-sm transition-colors',
        interactive && 'cursor-pointer hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
        selected && 'bg-selected',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

const DRAWER_WIDTH = {
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
  xl: 'sm:max-w-2xl',
} as const;

export interface DetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Ações curtas ao lado do título (ex.: badge de status, menu). */
  headerExtra?: React.ReactNode;
  /** Rodapé fixo (ex.: Cancelar / Salvar). */
  footer?: React.ReactNode;
  size?: keyof typeof DRAWER_WIDTH;
  className?: string;
  children: React.ReactNode;
}

/** Gaveta da direita com cabeçalho, corpo rolável e rodapé fixo. No celular ocupa a largura toda. */
export function DetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  headerExtra,
  footer,
  size = 'lg',
  className,
  children,
}: DetailDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn('w-full gap-0 p-0 data-[side=right]:w-full', DRAWER_WIDTH[size], className)}
      >
        <div className="flex items-start gap-3 border-b px-5 py-4 pr-12">
          <div className="min-w-0 flex-1">
            <SheetTitle className="font-heading truncate text-[15px] font-semibold">{title}</SheetTitle>
            {description ? <SheetDescription className="mt-0.5 text-xs">{description}</SheetDescription> : null}
          </div>
          {headerExtra ? <div className="flex shrink-0 items-center gap-2">{headerExtra}</div> : null}
        </div>
        <div className="animate-ddm-fade min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</div> : null}
      </SheetContent>
    </Sheet>
  );
}
