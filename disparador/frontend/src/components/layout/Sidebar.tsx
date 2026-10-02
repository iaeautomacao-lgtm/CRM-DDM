'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DDM_LOGO_WHITE } from '@/lib/brand';
import { useEffect, useState, useRef } from 'react';
import {
  LayoutDashboard, Users, Megaphone, Smartphone,
  MessageSquare, ShieldOff, LogOut, Menu, X,
} from 'lucide-react';
import clsx from 'clsx';

const navItems = [
  { href: '/dashboard',  label: 'Dashboard',    icon: LayoutDashboard },
  { href: '/campaigns',  label: 'Campanhas',    icon: Megaphone },
  { href: '/contacts',   label: 'Contatos',     icon: Users },
  { href: '/sessions',   label: 'Sessões WAHA', icon: Smartphone },
  { href: '/attendance', label: 'Atendimento',  icon: MessageSquare },
  { href: '/blacklist',  label: 'Blacklist',    icon: ShieldOff },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isIframe, setIsIframe] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => { drawer.current?.close(); }, [pathname]);

  useEffect(() => {
    setIsIframe(window.self !== window.top);
  }, []);

  if (isIframe) return null;

  const handleLogout = () => {
    localStorage.removeItem('access_token');
    document.cookie = 'access_token=;path=/;max-age=0';
    window.location.href = '/auth/login';
  };

  const sidebar = (
    <aside
      className="w-64 max-w-full flex-shrink-0 flex flex-col h-screen max-h-[90dvh] md:max-h-none sticky top-0"
      style={{ background: 'var(--sidebar-bg)', borderRight: '1px solid var(--sidebar-border)' }}
    >
      {/* ── Logo DDM ── */}
      <div className="px-6 py-5" style={{ borderBottom: '1px solid var(--sidebar-border)' }}>
        <div className="flex items-center gap-3">
          <img
            src={DDM_LOGO_WHITE}
            alt="Grupo DDM"
            className="h-8 w-auto flex-shrink-0"
          />
          <p className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--ddm-primary-light)', fontSize: '10px' }}>
            Disparador IA
          </p>
        </div>
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p
          className="px-3 mb-3 font-semibold uppercase tracking-widest"
          style={{ color: 'var(--sidebar-border)', fontSize: '10px', fontFamily: 'Poppins, sans-serif' }}
        >
          Menu
        </p>

        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));

          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
              )}
              style={
                active
                  ? {
                      background: 'rgba(255,87,6,0.12)',
                      color: 'var(--ddm-primary-light)',
                      fontFamily: 'Poppins, sans-serif',
                    }
                  : {
                      color: '#94A3B8',
                      fontFamily: 'Inter, sans-serif',
                    }
              }
              onMouseEnter={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,255,255,0.05)';
                  (e.currentTarget as HTMLAnchorElement).style.color = '#E2E8F0';
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
                  (e.currentTarget as HTMLAnchorElement).style.color = '#94A3B8';
                }
              }}
            >
              <Icon
                size={17}
                style={{ color: active ? 'var(--ddm-primary)' : '#64748B', flexShrink: 0 }}
              />
              {label}
              {active && (
                <span
                  className="ml-auto w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: 'var(--ddm-primary)' }}
                />
              )}
            </Link>
          );
        })}
      </nav>

      {/* ── Footer / Logout ── */}
      <div className="px-3 py-4" style={{ borderTop: '1px solid var(--sidebar-border)' }}>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-all"
          style={{ color: '#64748B', fontFamily: 'Inter, sans-serif', background: 'transparent' }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
            (e.currentTarget as HTMLButtonElement).style.color = '#E2E8F0';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            (e.currentTarget as HTMLButtonElement).style.color = '#64748B';
          }}
        >
          <LogOut size={16} />
          Sair da conta
        </button>
      </div>
    </aside>
  );
  return <>
    <div className="hidden md:block">{sidebar}</div>
    <button type="button" aria-label="Abrir menu" aria-haspopup="dialog" onClick={() => drawer.current?.showModal()} className="fixed left-2 top-2 z-40 rounded bg-slate-900 p-3 text-white md:hidden"><Menu size={20} /></button>
    <dialog ref={drawer} aria-label="Menu de navegação" className="m-0 h-dvh max-h-dvh max-w-[90vw] overflow-auto bg-slate-900 p-0 text-white backdrop:bg-black/50">
      <button type="button" aria-label="Fechar menu" onClick={() => drawer.current?.close()} className="absolute right-2 top-2 z-10 p-3"><X size={20} /></button>
      {sidebar}
    </dialog>
  </>;
}
