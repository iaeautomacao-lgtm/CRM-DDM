'use client';

// Configurações → Integrações (redesenho DDM, protótipo Integracoes.dc.html): tudo que conecta o CRM a outros sistemas
// numa página com abas — chaves da API pública, variáveis e credenciais, ferramentas dos agentes, webhooks de saída,
// provedores de IA e documentação. Cada aba é uma seção própria na URL (?tab=api|secrets|tools|webhooks|ai|api-docs),
// então os links antigos seguem funcionando. Abas sem permissão nem aparecem (o servidor continua bloqueando).

import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { SECTION_META, type IntegrationTab } from '@/components/settings/settings-sections';

// Cada aba é carregada só quando é aberta (chaves, credenciais, ferramentas, webhooks, UTMpay, IA, docs).
const PanelSkeleton = () => <Skeleton className="h-72 w-full rounded-card" aria-busy="true" />;
const lazy = <P extends object>(load: () => Promise<React.ComponentType<P>>) => dynamic(load, { ssr: false, loading: PanelSkeleton });
const ApiKeysSettings = lazy(() => import('@/components/settings/api-keys-settings').then((m) => m.ApiKeysSettings));
const SecretsSettings = lazy(() => import('@/components/settings/secrets-settings').then((m) => m.SecretsSettings));
const ToolsSettings = lazy(() => import('@/components/settings/tools-settings').then((m) => m.ToolsSettings));
const AiProvidersPanel = lazy(() => import('@/components/settings/ai-providers-panel').then((m) => m.AiProvidersPanel));
const ApiDocsPanel = lazy(() => import('@/components/settings/api-docs-panel').then((m) => m.ApiDocsPanel));
const AcorditoSettingsSection = lazy(() => import('@/components/settings/acordito-settings-section').then((m) => m.AcorditoSettingsSection));
const UtmpaySettings = lazy(() => import('@/components/settings/utmpay-settings').then((m) => m.UtmpaySettings));
const WebhooksSettings = lazy(() => import('./webhooks-settings').then((m) => m.WebhooksSettings));

const PANELS: Record<IntegrationTab, () => ReactNode> = {
  api: () => <ApiKeysSettings />,
  secrets: () => <SecretsSettings />,
  tools: () => <ToolsSettings />,
  webhooks: () => <WebhooksSettings />,
  utmpay: () => <UtmpaySettings />,
  ai: () => (
    <>
      <AiProvidersPanel />
      <div className="mt-8">
        <AcorditoSettingsSection />
      </div>
    </>
  ),
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

      <Tabs value={active} onValueChange={(v) => onSelect(v as IntegrationTab)} className="gap-4">
        {/* Em telas estreitas a faixa rola: o degradê à direita indica que há mais abas. */}
        <div className="-mx-1 overflow-x-auto border-b px-1 [scrollbar-width:thin] max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]">
          <TabsList variant="line" className="h-auto justify-start gap-5 p-0 max-sm:pr-6">
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

        <TabsContent key={active} value={active} className="animate-ddm-fade min-w-0 flex-none text-[length:inherit]">
          {PANELS[active]()}
        </TabsContent>
      </Tabs>
    </section>
  );
}
