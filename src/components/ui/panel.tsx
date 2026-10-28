import type { LucideIcon } from 'lucide-react';

interface PanelProps {
  readonly id?: string;
  readonly icon: LucideIcon;
  readonly iconClassName?: string;
  readonly title: string;
  readonly subtitle?: React.ReactNode;
  /** Conteúdo alinhado à direita do cabeçalho. */
  readonly actions?: React.ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly children: React.ReactNode;
}

/** Container padrão das seções do dashboard (cabeçalho de ícone + título + subtítulo). */
export function Panel({
  id,
  icon: Icon,
  iconClassName = 'text-gmn-primary',
  title,
  subtitle,
  actions,
  className = '',
  bodyClassName = '',
  children,
}: PanelProps): React.JSX.Element {
  const titleId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={`scroll-mt-6 rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#121F36] to-gmn-card p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className={`mt-0.5 h-[22px] w-[22px] shrink-0 ${iconClassName}`} aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold leading-tight text-gmn-text">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-xs text-gmn-muted">{subtitle}</div>}
          </div>
        </div>
        {actions}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
