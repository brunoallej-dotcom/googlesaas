import { LogOut, Menu } from 'lucide-react';
import { SystemStatus } from './system-status';

interface DashboardHeaderProps {
  readonly sectionLabel: string;
  readonly onOpenMobileMenu: () => void;
  readonly onLogout?: () => void;
  /** Esconde o indicador de saúde (que consulta Redis/Supabase), p. ex. em telas que não precisam dele. */
  readonly hideSystemStatus?: boolean;
}

export function DashboardHeader({
  sectionLabel,
  onOpenMobileMenu,
  onLogout,
  hideSystemStatus = false,
}: DashboardHeaderProps): React.JSX.Element {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Abrir menu"
          aria-controls="gmn-sidebar"
          className="mt-1 rounded-lg border border-white/[0.08] bg-gmn-card p-2 text-gmn-muted hover:text-gmn-text lg:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-gmn-text md:text-[26px]">
            GMN Intelligence Platform
          </h1>
          <p className="mt-0.5 text-sm text-gmn-muted">
            Inteligência territorial e posicionamento no Google Meu Negócio
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onLogout && !hideSystemStatus && <SystemStatus />}
        <p
          aria-live="polite"
          className="hidden shrink-0 rounded-full border border-white/[0.06] bg-gmn-card px-3.5 py-1.5 text-xs text-gmn-muted sm:block"
        >
          Seção: <span className="font-medium text-gmn-text">{sectionLabel}</span>
        </p>
        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-gmn-card px-3 py-1.5 text-xs text-gmn-muted transition-colors hover:text-gmn-text"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sair
          </button>
        )}
      </div>
    </header>
  );
}
