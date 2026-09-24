'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { AiAgentSettings } from '@/components/settings/ai-agent-settings';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency, accountRole, profileLoading } = useAuth();
  const { mode } = useTheme();

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const rawSection = resolveSection(searchParams.get('tab'));

  // "ai" is owner-only (SECTION_META.ai.ownerOnly) — a non-owner who
  // deep-links ?tab=ai (or clicked it before this rolled out) lands on
  // Overview instead of the panel. Gated on profileLoading so an owner
  // whose role hasn't resolved yet doesn't flash onto Overview first.
  const aiRestricted = !profileLoading && accountRole !== 'owner';
  const section = rawSection === 'ai' && aiRestricted ? 'overview' : rawSection;

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    api: <ApiKeysSettings />,
    ai: <AiAgentSettings />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Configurações
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tudo em um só lugar — sua conta e seu espaço de trabalho. Escolha uma
          seção para gerenciá-la.
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={go} hints={hints} role={accountRole} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsContent />
    </Suspense>
  );
}
