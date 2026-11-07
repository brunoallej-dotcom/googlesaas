'use client';

import Link from 'next/link';
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Clock,
  FileText,
  HeartPulse,
  History,
  House,
  Link2,
  MapPin,
  Settings,
  UsersRound,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Id da seção na própria página. Sem sectionId (nem href) = funcionalidade futura. */
  readonly sectionId?: string;
  /** Rota própria (outra página). Itens com `href` não usam âncora. */
  readonly href?: string;
}

/** Ordem idêntica ao mockup aprovado. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', label: 'Visão Geral', icon: House, sectionId: 'visao-geral' },
  { id: 'audits', label: 'Auditorias', icon: ClipboardList, sectionId: 'auditoria' },
  { id: 'link-audit', label: 'Auditoria por Link', icon: Link2, href: '/auditoria-por-link' },
  { id: 'leads', label: 'Leads de Fronteira', icon: HeartPulse, sectionId: 'leads' },
  { id: 'reports', label: 'Relatórios PDF', icon: FileText, sectionId: 'relatorios' },
  { id: 'rivals', label: 'Concorrentes', icon: UsersRound, sectionId: 'concorrentes' },
  { id: 'history', label: 'Histórico', icon: History },
  { id: 'settings', label: 'Configurações', icon: Settings },
];

interface SidebarProps {
  readonly collapsed: boolean;
  readonly mobileOpen: boolean;
  readonly activeSectionId: string;
  /** Rota da página atual quando NÃO é o dashboard. Sem ela, o comportamento é o de sempre. */
  readonly activeRoute?: string;
  readonly onToggleCollapsed: () => void;
  readonly onCloseMobile: () => void;
}

export function Sidebar({
  collapsed,
  mobileOpen,
  activeSectionId,
  activeRoute,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps): React.JSX.Element {
  // No mobile o drawer sempre mostra os rótulos; o recolhimento vale só no desktop.
  const labelClass = collapsed ? 'lg:sr-only' : '';
  // Fora do dashboard as âncoras precisam apontar de volta para ele ("/#auditoria").
  const anchorPrefix = activeRoute ? '/' : '';

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}
      <aside
        id="gmn-sidebar"
        aria-label="Navegação principal"
        className={`fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-white/[0.06] bg-gmn-sidebar transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:transition-[width] ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full invisible lg:visible' // fechado no celular: fora da tabulação e dos leitores de tela
        } ${collapsed ? 'lg:w-[76px]' : 'lg:w-56'}`}
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-6 pt-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <MapPin
              className="h-9 w-9 shrink-0 fill-gmn-primary text-gmn-accent"
              aria-hidden="true"
            />
            <span className={`min-w-0 leading-tight ${labelClass}`}>
              <span className="block text-xl font-bold tracking-tight text-gmn-text">GMN</span>
              <span className="block truncate text-xs text-gmn-text">Intelligence Platform</span>
            </span>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Fechar menu"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gmn-muted hover:bg-gmn-surface hover:text-gmn-text focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70 lg:hidden"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav aria-label="Menu principal" className="flex-1 overflow-y-auto px-3">
          <ul className="space-y-1.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const base =
                'flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors';
              if (item.href) {
                const routeActive = item.href === activeRoute;
                const linkClass = `${base} ${
                  routeActive
                    ? 'bg-gmn-primary/[0.18] text-white'
                    : 'text-gmn-muted hover:bg-gmn-surface hover:text-gmn-text'
                }`;
                const inner = (
                  <>
                    <Icon className={`h-5 w-5 shrink-0 ${routeActive ? 'text-gmn-accent' : ''}`} aria-hidden="true" />
                    <span className={`truncate ${labelClass}`}>{item.label}</span>
                  </>
                );
                // O item da PÁGINA ATUAL é um link de documento (<a>), não do roteador do Next: ele reinicia a tela já coerente com o endereço.
                // Pelo roteador, o endereço perderia o `?auditId=` sem que a tela mudasse (e o F5 abriria outra empresa).
                return (
                  <li key={item.id}>
                    {routeActive ? (
                      <a href={item.href} onClick={onCloseMobile} aria-current="page" title={collapsed ? item.label : undefined} className={linkClass}>
                        {inner}
                      </a>
                    ) : (
                      <Link href={item.href} onClick={onCloseMobile} title={collapsed ? item.label : undefined} className={linkClass}>
                        {inner}
                      </Link>
                    )}
                  </li>
                );
              }
              if (!item.sectionId) {
                return (
                  <li key={item.id}>
                    <span
                      aria-disabled="true"
                      title="Em breve"
                      className={`${base} cursor-not-allowed text-gmn-muted/80`}
                    >
                      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                      <span className={`min-w-0 flex-1 truncate ${labelClass}`}>{item.label}</span>
                      <Clock
                        className={`h-3.5 w-3.5 shrink-0 ${collapsed ? 'lg:hidden' : ''}`}
                        aria-hidden="true"
                      />
                      <span className="sr-only">(em breve)</span>
                    </span>
                  </li>
                );
              }
              const active = item.sectionId === activeSectionId;
              return (
                <li key={item.id}>
                  <a
                    href={`${anchorPrefix}#${item.sectionId}`}
                    onClick={onCloseMobile}
                    aria-current={active ? 'location' : undefined}
                    title={collapsed ? item.label : undefined}
                    className={`${base} ${
                      active
                        ? 'bg-gmn-primary/[0.18] text-white'
                        : 'text-gmn-muted hover:bg-gmn-surface hover:text-gmn-text'
                    }`}
                  >
                    <Icon
                      className={`h-5 w-5 shrink-0 ${active ? 'text-gmn-accent' : ''}`}
                      aria-hidden="true"
                    />
                    <span className={`truncate ${labelClass}`}>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="space-y-3 p-3">
          <div
            className={`rounded-2xl border border-white/[0.06] bg-gradient-to-br from-gmn-primary/[0.12] to-gmn-card p-4 ${
              collapsed ? 'lg:hidden' : ''
            }`}
          >
            <BarChart3 className="h-7 w-7 text-gmn-primary" aria-hidden="true" />
            <p className="mt-4 text-sm leading-snug text-gmn-text">
              Mais visibilidade.
              <br />
              Mais clientes.
              <br />
              Mais resultados.
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
            aria-expanded={!collapsed}
            aria-controls="gmn-sidebar"
            className="hidden w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm text-gmn-muted transition-colors hover:bg-gmn-surface hover:text-gmn-text lg:flex"
          >
            {collapsed ? (
              <ChevronsRight className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronsLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <span className={collapsed ? 'sr-only' : ''}>Recolher menu</span>
          </button>
        </div>
      </aside>
    </>
  );
}
