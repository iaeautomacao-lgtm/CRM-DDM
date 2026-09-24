'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight, FileText, Loader2, PlugZap, Tags, UsersRound, type LucideIcon } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { THEMES } from '@/lib/themes';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { SECTION_META, type SettingsSection } from './settings-sections';
import { SettingsChip, StatusDot } from './settings-chip';
import { ROLE_META } from './role-meta';

interface OverviewCounts {
  members: number | null;
  pendingInvites: number | null;
  templates: number | null;
  templatesPending: number | null;
  tags: number | null;
  customFields: number | null;
}

interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
}

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const { user, profile, accountId, accountRole, canManageMembers } = useAuth();
  const { mode, theme } = useTheme();

  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiLoading, setAiLoading] = useState(true);

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    const userId = user.id;
    const acctId = accountId;

    // Cheap counts — resolve fast, render immediately.
    (async () => {
      setCountsLoading(true);
      const [membersRes, invitesRes, templatesTotal, templatesPending, tagsRes, fieldsRes] =
        await Promise.allSettled([
          fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
          canManageMembers
            ? fetch('/api/account/invitations', { cache: 'no-store' }).then((r) =>
                r.json(),
              )
            : Promise.resolve(null),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'PENDING'),
          supabase
            .from('tags')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase.from('custom_fields').select('id', { count: 'exact', head: true }),
        ]);

      if (cancelled) return;

      const members =
        membersRes.status === 'fulfilled' && Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : null;
      const pendingInvites =
        invitesRes.status === 'fulfilled' &&
        invitesRes.value &&
        Array.isArray(invitesRes.value.invitations)
          ? invitesRes.value.invitations.length
          : null;

      setCounts({
        members,
        pendingInvites,
        templates:
          templatesTotal.status === 'fulfilled'
            ? templatesTotal.value.count ?? null
            : null,
        templatesPending:
          templatesPending.status === 'fulfilled'
            ? templatesPending.value.count ?? null
            : null,
        tags: tagsRes.status === 'fulfilled' ? tagsRes.value.count ?? null : null,
        customFields:
          fieldsRes.status === 'fulfilled' ? fieldsRes.value.count ?? null : null,
      });
      setCountsLoading(false);
    })();

    // WhatsApp connection status & AI Config — slower, independent.
    (async () => {
      setWhatsappLoading(true);
      setAiLoading(true);
      const [row, health, aiRow] = await Promise.allSettled([
        supabase
          .from('whatsapp_config')
          .select('phone_number_id')
          .eq('account_id', acctId)
          .maybeSingle(),
        fetch('/api/whatsapp/config', { cache: 'no-store' }).then((r) => r.json()),
        supabase
          .from('ai_config')
          .select('enabled')
          .eq('account_id', acctId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setWhatsapp({
        configured: row.status === 'fulfilled' && !!row.value.data?.phone_number_id,
        connected: health.status === 'fulfilled' && !!health.value?.connected,
      });
      if (aiRow.status === 'fulfilled' && aiRow.value?.data) {
        setAiEnabled(!!aiRow.value.data.enabled);
      }
      setWhatsappLoading(false);
      setAiLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, accountId, canManageMembers]);

  const displayName = profile?.full_name || profile?.email || 'Sua conta';
  const initial = (profile?.full_name || profile?.email || 'U').charAt(0).toUpperCase();
  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const themeName = THEMES.find((t) => t.id === theme)?.name ?? theme;

  // Tiles still living inside /settings navigate the rail (onSelect);
  // members/templates/fields moved to their own top-level routes
  // (/membros, /templates, /tabulacoes — see sidebar.tsx + role-utils.ts)
  // so those are plain links instead. whatsapp links out to /canais,
  // the page that already fully replaced WhatsAppConfig's role. deals
  // (Negócios e moeda) had no replacement route — dropped entirely,
  // per this task's "remove from /settings" instruction for it.
  type OverviewTile =
    | { kind: 'section'; key: SettingsSection; section: SettingsSection; loading: boolean; subtitle: ReactNode }
    | { kind: 'link'; key: string; href: string; icon: LucideIcon; label: string; loading: boolean; subtitle: ReactNode };

  // Per-tile loading + subtitle. `null` counts render as a graceful
  // fallback so a single failed query never blanks a tile.
  const tiles: OverviewTile[] = [
    {
      kind: 'link',
      key: 'whatsapp',
      href: '/canais',
      icon: PlugZap,
      label: 'WhatsApp',
      loading: whatsappLoading,
      subtitle: !whatsapp?.configured ? (
        'Não configurado'
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> Conectado
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> Necessita reconexão
        </>
      ),
    },
    {
      kind: 'link',
      key: 'members',
      href: '/membros',
      icon: UsersRound,
      label: 'Membros da equipe',
      loading: countsLoading,
      subtitle:
        counts?.members == null
          ? 'Ver membros da equipe'
          : `${counts.members} membro${counts.members === 1 ? '' : 's'}${
              counts.pendingInvites
                ? ` · ${counts.pendingInvites} convite${
                    counts.pendingInvites === 1 ? '' : 's'
                  } pendente${counts.pendingInvites === 1 ? '' : 's'}`
                : ''
            }`,
    },
    {
      kind: 'link',
      key: 'templates',
      href: '/templates',
      icon: FileText,
      label: 'Templates',
      loading: countsLoading,
      subtitle:
        counts?.templates == null
          ? 'Gerenciar modelos de mensagens'
          : `${counts.templates} modelo${counts.templates === 1 ? '' : 's'}${
              counts.templatesPending
                ? ` · ${counts.templatesPending} aguardando revisão`
                : ''
            }`,
    },
    {
      kind: 'link',
      key: 'fields',
      href: '/tabulacoes',
      icon: Tags,
      label: 'Tabulações',
      loading: countsLoading,
      subtitle:
        counts?.tags == null && counts?.customFields == null
          ? 'Tags e campos personalizados'
          : `${counts?.tags ?? 0} tag${counts?.tags === 1 ? '' : 's'} · ${
              counts?.customFields ?? 0
            } campo${counts?.customFields === 1 ? '' : 's'} personalizado${counts?.customFields === 1 ? '' : 's'}`,
    },
    {
      kind: 'section',
      key: 'appearance',
      section: 'appearance',
      loading: false,
      subtitle: `Modo ${mode === 'dark' ? 'escuro' : mode === 'light' ? 'claro' : mode} · destaque ${themeName}`,
    },
    {
      kind: 'section',
      key: 'ai',
      section: 'ai',
      loading: aiLoading,
      subtitle: aiEnabled ? 'Ativo e respondendo' : 'Desativado',
    },
  ];

  return (
    <section className="animate-in fade-in-50 duration-200">
      {/* Identity */}
      <Card className="flex-row items-center gap-4 px-5 py-5">
        <Avatar size="lg" className="size-14">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-xl text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">
            {displayName}
          </div>
          {profile?.email ? (
            <div className="truncate text-sm text-muted-foreground">
              {profile.email}
            </div>
          ) : null}
        </div>
        {roleMeta && RoleIcon ? (
          <SettingsChip variant={roleMeta.variant}>
            <RoleIcon />
            {roleMeta.label}
          </SettingsChip>
        ) : null}
      </Card>

      {/* Status tiles */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => {
          const Icon = tile.kind === 'section' ? SECTION_META[tile.section].icon : tile.icon;
          const label = tile.kind === 'section' ? SECTION_META[tile.section].label : tile.label;
          const inner = (
            <>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">{label}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {tile.loading ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> Carregando…
                    </>
                  ) : (
                    tile.subtitle
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </>
          );
          const className = cn(
            'group flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors',
            'hover:border-primary-soft-2 hover:bg-card-2',
          );
          if (tile.kind === 'link') {
            return (
              <Link key={tile.key} href={tile.href} className={className}>
                {inner}
              </Link>
            );
          }
          return (
            <button
              key={tile.key}
              type="button"
              onClick={() => onSelect(tile.section)}
              className={className}
            >
              {inner}
            </button>
          );
        })}
      </div>
    </section>
  );
}
