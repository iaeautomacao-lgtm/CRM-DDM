import {
  KeyRound,
  LayoutGrid,
  Palette,
  Shield,
  User,
  Bot,
  type LucideIcon,
} from 'lucide-react';

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
  'profile',
  'security',
  'appearance',
  'api',
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
  group: 'top' | 'account' | 'workspace';
  ownerOnly?: boolean;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Visão geral', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Seu perfil', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login e segurança', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Aparência', icon: Palette, group: 'account' },
  api: { id: 'api', label: 'Chaves de API', icon: KeyRound, group: 'workspace' },
  ai: { id: 'ai', label: 'Agente de IA', icon: Bot, group: 'workspace', ownerOnly: true },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Conta', group: 'account' },
  { label: 'Espaço de trabalho', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Anything unknown — including
 * 'tags'/'custom-fields'/'fields'/'whatsapp'/'templates'/'deals'/'members',
 * all legacy values from before those sections moved to their own
 * routes — falls back to the Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
