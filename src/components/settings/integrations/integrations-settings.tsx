'use client';

// Configurações → Integrações (redesenho DDM, protótipo Integracoes.dc.html): tudo que conecta o CRM a outros sistemas
// numa página com abas — chaves da API pública, variáveis e credenciais, ferramentas dos agentes, webhooks de saída,
// provedores de IA e documentação. Cada aba é uma seção própria na URL (?tab=api|secrets|tools|webhooks|ai|api-docs),
// então os links antigos seguem funcionando. Abas sem permissão nem aparecem (o servidor continua bloqueando).

import type { ReactNode } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { SecretsSettings } from '@/components/settings/secrets-settings';
import { ToolsSettings } from '@/components/settings/tools-settings';
import { AiAgentSettings } from '@/components/settings/ai-agent-settings';
import { ApiDocsPanel } from '@/components/settings/api-docs-panel';
import { SECTION_META, type IntegrationTab } from '@/components/settings/settings-sections';
import { WebhooksSettings } from './webhooks-settings';

const PANELS: Record<IntegrationTab, () => ReactNode> = {
  api: () => <ApiKeysSettings />,
  secrets: () => <SecretsSettings />,
  tools: () => <ToolsSettings />,
  webhooks: () => <WebhooksSettings />,
  ai: () => <AiAgentSettings />,
  'api-docs': () => <ApiDocsPanel />,
};

export function IntegrationsSettings({
  active,
  tabs,
  onSelect,
}: {
  active: IntegrationTab;
  /** Abas visíveis para o papel, na ordem do protótipo. */
  tabs: IntegrationTab[];
  onSelect: (tab: IntegrationTab) => void;
}) {
  return (
    <section className="animate-ddm-up flex flex-col gap-4">
      <div className="min-w-0">
        <h2 className="font-heading text-[22px] font-semibold tracking-tight text-foreground">Integrações</h2>
        <p className="mt-1 max-w-[75ch] text-sm text-foreground-2">
          Tudo que conecta o CRM a outros sistemas, num só lugar: chaves da API pública, credenciais usadas pelas
          ferramentas, ferramentas dos agentes, webhooks de saída e provedores de IA.
        </p>
      </div>

      <Tabs value={active} onValueChange={(v) => onSelect(v as IntegrationTab)}>
        <div className="-mx-1 overflow-x-auto border-b px-1 [scrollbar-width:thin]">
          <TabsList variant="line" className="h-auto justify-start gap-5 p-0">
            {tabs.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="flex-none px-0 pb-2.5 pt-1 text-[13.5px] data-active:text-foreground after:bg-primary after:!bottom-[-1px]"
              >
                {SECTION_META[t].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      <div key={active} className="animate-ddm-fade min-w-0">
        {PANELS[active]()}
      </div>
    </section>
  );
}
