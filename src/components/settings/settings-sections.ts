import {
  Building2,
  KeyRound,
  LayoutGrid,
  Bot,
  LockKeyhole,
  Wrench,
  Sparkles,
  BookOpen,
  Plug,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 *
 * whatsapp/templates/fields/deals/members moved out to their own
 * top-level routes (/canais already existed; /templates, /tabulacoes,
 * /membros are new — see sidebar.tsx + role-utils.ts) — 'whatsapp' and
 * 'deals' have no new route at all, just removed from here per this
 * task. The underlying components (WhatsAppConfig, TemplateManager,
 * FieldsAndTagsPanel, DealsSettings, MembersTab) are untouched; only
 * unlinked from /settings.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'organization',
  'api',
  'secrets',
  'tools',
  'agents',
  'integrations',
  'webhooks',
  'api-docs',
  'ai',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `ownerOnly` items are hidden (and their `?tab=`
 *  resolved back to Overview) for any role below owner — currently
 *  just "Agente de IA". */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'workspace';
  ownerOnly?: boolean;
  /** Papel mínimo para ver a seção (some do menu e a URL volta à Visão geral). */
  minRole?: AccountRole;
  /** Aba da página Integrações (redesenho DDM): não aparece no menu; o menu mostra "Integrações". */
  integrationTab?: boolean;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Visão geral', icon: LayoutGrid, group: 'top' },
  organization: { id: 'organization', label: 'Organização', icon: Building2, group: 'workspace', minRole: 'admin' },
  api: { id: 'api', label: 'Chaves de API', icon: KeyRound, group: 'workspace', integrationTab: true },
  secrets: {
    id: 'secrets',
    label: 'Variáveis e credenciais',
    icon: LockKeyhole,
    group: 'workspace',
    minRole: 'supervisor',
    integrationTab: true,
  },
  tools: {
    id: 'tools',
    label: 'Ferramentas',
    icon: Wrench,
    group: 'workspace',
    integrationTab: true,
    minRole: 'supervisor',
  },
  agents: {
    id: 'agents',
    label: 'Agentes',
    icon: Sparkles,
    group: 'workspace',
    minRole: 'supervisor',
  },
  integrations: { id: 'integrations', label: 'Integrações', icon: Plug, group: 'workspace' },
  webhooks: { id: 'webhooks', label: 'Webhooks', icon: Webhook, group: 'workspace', minRole: 'admin', integrationTab: true },
  'api-docs': { id: 'api-docs', label: 'Documentação da API', icon: BookOpen, group: 'workspace', minRole: 'supervisor', integrationTab: true },
  ai: { id: 'ai', label: 'Provedores de IA', icon: Bot, group: 'workspace', ownerOnly: true, integrationTab: true },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Espaço de trabalho', group: 'workspace' },
];

/** O papel enxerga a seção? (ownerOnly e minRole). */
export function canSeeSection(section: SettingsSection, role: AccountRole | null | undefined): boolean {
  const meta = SECTION_META[section];
  if (meta.ownerOnly && role !== 'owner') return false;
  if (meta.minRole && !(role && hasMinRole(role, meta.minRole))) return false;
  return true;
}

/** Abas da página Integrações, na ordem do protótipo. */
export const INTEGRATION_TABS = ['api', 'secrets', 'tools', 'webhooks', 'ai', 'api-docs'] as const satisfies readonly SettingsSection[];
export type IntegrationTab = (typeof INTEGRATION_TABS)[number];

export function isIntegrationTab(section: SettingsSection): section is IntegrationTab {
  return (INTEGRATION_TABS as readonly string[]).includes(section);
}

/** Abas de Integrações que o papel enxerga. */
export function visibleIntegrationTabs(role: AccountRole | null | undefined): IntegrationTab[] {
  return INTEGRATION_TABS.filter((t) => canSeeSection(t, role));
}

/** Seção aparece no menu lateral? As abas de Integrações não; "Integrações" só se alguma aba for visível. */
export function showInRail(section: SettingsSection, role: AccountRole | null | undefined): boolean {
  if (SECTION_META[section].integrationTab) return false;
  if (section === 'integrations') return visibleIntegrationTabs(role).length > 0;
  return canSeeSection(section, role);
}

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Anything unknown — including
 * 'tags'/'custom-fields'/'fields'/'whatsapp'/'templates'/'deals'/'members',
 * all legacy values from before those sections moved to their own
 * routes — falls back to the Overview landing. 'profile'/'security'/'appearance'
 * (grupo Conta) agora vivem em /perfil; a página redireciona (ver LEGACY_ACCOUNT_TABS).
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}

/** Abas antigas do grupo "Conta": hoje são abas de /perfil (?tab=perfil|seguranca|aparencia). */
export const LEGACY_ACCOUNT_TABS: Record<string, string> = {
  profile: '/perfil?tab=perfil',
  security: '/perfil?tab=seguranca',
  appearance: '/perfil?tab=aparencia',
};
