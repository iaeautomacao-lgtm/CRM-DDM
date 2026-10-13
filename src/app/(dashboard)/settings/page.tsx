'use client';

import { PanelHeadingLevel } from "@/components/settings/settings-panel-head";
import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { OrganizationPanel } from '@/components/settings/organization-panel';
import { AgentsSettings } from '@/components/settings/agents/agents-settings';
import { IntegrationsSettings } from '@/components/settings/integrations/integrations-settings';
import {
  canSeeSection,
  isIntegrationTab,
  LEGACY_ACCOUNT_TABS,
  resolveSection,
  SECTION_META,
  visibleIntegrationTabs,
  type SettingsSection,
} from '@/components/settings/settings-sections';
import { PageBody } from '@/components/ddm/page-toolbar';
import { PageHeader } from '@/components/ddm/page-header';

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accountRole, profileLoading } = useAuth();

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const rawTab = searchParams.get('tab');
  // Links antigos (?tab=profile|security|appearance) seguem para a aba certa de /perfil.
  const accountRedirect = rawTab ? LEGACY_ACCOUNT_TABS[rawTab] : undefined;
  useEffect(() => {
    if (accountRedirect) router.replace(accountRedirect);
  }, [accountRedirect, router]);
  const requested = resolveSection(rawTab);
  // "Integrações" no menu abre a primeira aba visível; as abas têm URL própria (?tab=api|secrets|…).
  const integrationTabs = visibleIntegrationTabs(accountRole);
  const rawSection: SettingsSection =
    requested === 'integrations' ? (integrationTabs[0] ?? (profileLoading ? 'integrations' : 'overview')) : requested;

  // "ai" is owner-only (SECTION_META.ai.ownerOnly) — a non-owner who
  // deep-links ?tab=ai (or clicked it before this rolled out) lands on
  // Overview instead of the panel. Gated on profileLoading so an owner
  // whose role hasn't resolved yet doesn't flash onto Overview first.
  const aiRestricted = !profileLoading && accountRole !== 'owner';
  const section =
    (rawSection === 'ai' && aiRestricted) || (!profileLoading && !canSeeSection(rawSection, accountRole))
      ? 'overview'
      : rawSection;

  // Foco no painel só depois de uma troca feita pelo usuário (clique/teclado no menu), nunca na carga inicial.
  // Trocar de aba dentro de Integrações não conta: o foco precisa ficar na aba para a navegação por setas.
  const panelRef = useRef<HTMLDivElement>(null);
  const userNavigated = useRef(false);
  const panelKey = isIntegrationTab(section) ? 'integrations' : section;
  useEffect(() => {
    if (!userNavigated.current) return;
    userNavigated.current = false;
    panelRef.current?.focus({ preventScroll: true });
  }, [panelKey]);

  const go = (next: SettingsSection) => {
    const nextKey = isIntegrationTab(next) ? 'integrations' : next;
    if (nextKey !== panelKey) userNavigated.current = true;
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  const panel: Partial<Record<SettingsSection, ReactNode>> = {
    overview: <SettingsOverview onSelect={go} />,
    organization: <OrganizationPanel />,
    agents: <AgentsSettings />,
  };
  const integrationActive = isIntegrationTab(section);

  return (
    <PageBody>
      <PageHeader>
        Tudo em um só lugar — sua conta e seu espaço de trabalho. Escolha uma
        seção para gerenciá-la.
      </PageHeader>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={integrationActive ? 'integrations' : section} onSelect={go} role={accountRole} />
        <div
          ref={panelRef}
          tabIndex={-1}
          role="region"
          aria-label={SECTION_META[panelKey].label}
          className="min-w-0 outline-none"
        >
          <PanelHeadingLevel level={3}>
            {isIntegrationTab(section) ? (
              <IntegrationsSettings active={section} tabs={integrationTabs} onSelect={go} />
            ) : (
              panel[section] ?? null
            )}
          </PanelHeadingLevel>
        </div>
      </div>
    </PageBody>
  );
}

function SettingsSkeleton() {
  return (
    <PageBody aria-busy="true" aria-label="Carregando configurações">
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <Skeleton className="h-64 w-full rounded-card" />
        <Skeleton className="h-96 w-full rounded-card" />
      </div>
    </PageBody>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsContent />
    </Suspense>
  );
}
