import type { LucideIcon } from 'lucide-react';
import { NOT_AVAILABLE } from './labels';

export interface MetricDelta {
  readonly text: string;
  readonly tone: 'good' | 'bad';
}

interface MetricCardProps {
  readonly label: string;
  /** null/undefined mostram "Não disponível": nunca inventamos valores. */
  readonly value: string | number | null | undefined;
  readonly sub?: string | null;
  readonly icon: LucideIcon;
  readonly iconClassName?: string;
  readonly delta?: MetricDelta | null;
  readonly title?: string;
  /** lg = indicadores principais; md = secundários. */
  readonly size?: 'lg' | 'md';
  readonly className?: string;
}

export function MetricCard({
  label,
  value,
  sub,
  icon: Icon,
  iconClassName = 'text-gmn-accent',
  delta,
  title,
  size = 'md',
  className = '',
}: MetricCardProps): React.JSX.Element {
  const available = value !== null && value !== undefined && value !== '';
  return (
    <div
      title={title}
      className={`min-w-0 rounded-xl border border-white/[0.04] bg-gmn-tile p-3.5 transition-colors hover:bg-[#101D33] ${className}`}
    >
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-gmn-muted">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      {available ? (
        <>
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2">
            <p
              className={`font-semibold leading-none tracking-tight text-gmn-text tabular-nums ${
                size === 'lg' ? 'text-[32px]' : 'text-2xl'
              }`}
            >
              {value}
            </p>
            {delta && (
              <span
                className={`text-xs font-medium tabular-nums ${
                  delta.tone === 'good' ? 'text-gmn-success' : 'text-gmn-danger'
                }`}
              >
                {delta.text}
              </span>
            )}
          </div>
          {sub && <p className="mt-1.5 text-xs text-gmn-muted tabular-nums">{sub}</p>}
        </>
      ) : (
        <>
          <p
            aria-hidden="true"
            className={`mt-2.5 font-semibold leading-none text-gmn-muted/80 ${
              size === 'lg' ? 'text-[32px]' : 'text-2xl'
            }`}
          >
            —
          </p>
          <p className="mt-1.5 text-xs text-gmn-muted/80">{NOT_AVAILABLE}</p>
        </>
      )}
    </div>
  );
}
