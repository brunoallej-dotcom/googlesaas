'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardHeader } from './dashboard-header';
import { NAV_ITEMS, Sidebar } from './sidebar';

const COLLAPSE_KEY = 'gmn:sidebar-collapsed';

/** Ordem em que as seções aparecem na página (difere da ordem do menu). */
const SECTION_IDS: readonly string[] = ['visao-geral', 'leads', 'auditoria', 'relatorios', 'concorrentes'];

const SECTION_LABEL: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.flatMap((item) => (item.sectionId ? [[item.sectionId, item.label]] : []))
);

export function DashboardShell({
  children,
  onLogout,
  activeRoute,
  sectionLabel,
  hideSystemStatus,
}: {
  readonly children: React.ReactNode;
  readonly onLogout?: () => void;
  /** Rota de uma página fora do dashboard (ex.: "/auditoria-por-link"). Sem ela, tudo funciona como sempre. */
  readonly activeRoute?: string;
  readonly sectionLabel?: string;
  readonly hideSystemStatus?: boolean;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const [activeSectionId, setActiveSectionId] = useState<string>('visao-geral');

  // Preferência por-visitante; pode falhar em janela privada, então é opcional.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* sem persistência */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* sem persistência */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  // Seção ativa = a seção visível mais próxima do topo da viewport.
  useEffect(() => {
    if (activeRoute) return; // fora do dashboard não há seções para observar
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = SECTION_IDS.find((id) => visible.has(id));
        if (first) setActiveSectionId(first);
      },
      { rootMargin: '-10% 0px -60% 0px' }
    );
    for (const id of SECTION_IDS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [activeRoute]);

  return (
    <div className="flex min-h-screen bg-gmn-bg">
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        activeSectionId={activeRoute ? '' : activeSectionId}
        {...(activeRoute ? { activeRoute } : {})}
        onToggleCollapsed={toggleCollapsed}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="min-w-0 flex-1 px-4 py-6 lg:px-7">
        <div className="w-full max-w-[1680px] space-y-5">
          <DashboardHeader
            sectionLabel={sectionLabel ?? SECTION_LABEL[activeSectionId] ?? 'Visão Geral'}
            onOpenMobileMenu={() => setMobileOpen(true)}
            {...(onLogout ? { onLogout } : {})}
            {...(hideSystemStatus ? { hideSystemStatus } : {})}
          />
          {children}
        </div>
      </div>
    </div>
  );
}
