import type { LucideIcon } from 'lucide-react';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-gmn-success/10 text-green-300 ring-gmn-success/25 border-gmn-success/40',
  warning: 'bg-gmn-warning/10 text-amber-300 ring-gmn-warning/25 border-gmn-warning/50',
  danger: 'bg-gmn-danger/10 text-red-300 ring-gmn-danger/25 border-gmn-danger/40',
  info: 'bg-gmn-accent/10 text-sky-300 ring-gmn-accent/25 border-gmn-accent/40',
  neutral: 'bg-white/[0.04] text-gmn-muted ring-white/10 border-white/20',
};

interface StatusBadgeProps {
  readonly tone: StatusTone;
  readonly label: string;
  /** Ícone obrigatório: o estado nunca depende somente de cor. */
  readonly icon: LucideIcon;
  readonly title?: string;
  /** Borda tracejada no lugar do anel: sinaliza estado incerto/não confirmado. */
  readonly dashed?: boolean;
  readonly spin?: boolean;
}

export function StatusBadge({
  tone,
  label,
  icon: Icon,
  title,
  dashed = false,
  spin = false,
}: StatusBadgeProps): React.JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ${
        TONE_CLASS[tone]
      } ${dashed ? 'border border-dashed' : 'ring-1 ring-inset'}`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      {label}
    </span>
  );
}
