'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Nível do título dos painéis. O cabeçalho do app já tem o h1 (título da rota); a página usa h2 para o próprio título
 * e, quando ela mostra painéis abaixo desse h2 (Configurações, Meu perfil), os painéis devem ser h3. Padrão: h2.
 */
const PanelHeadingLevelContext = createContext<2 | 3>(2);

export function PanelHeadingLevel({ level, children }: { level: 2 | 3; children: ReactNode }) {
  return <PanelHeadingLevelContext.Provider value={level}>{children}</PanelHeadingLevelContext.Provider>;
}

/**
 * Section header shown at the top of every settings panel — a title,
 * a one-line description, and an optional right-aligned action (e.g.
 * "New template", "Invite member"). Mirrors the mockup's `.panel-head`.
 */
export function SettingsPanelHead({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Heading = useContext(PanelHeadingLevelContext) === 3 ? 'h3' : 'h2';
  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <Heading className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </Heading>
        {description ? (
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
