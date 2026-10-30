import { CircleCheck, CircleDashed, History, Info, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/components/ui/status-badge';
import { StatusBadge } from '@/components/ui/status-badge';
import type { Headline, RegistryLine } from './status';

const BORDER: Readonly<Record<StatusTone, string>> = {
  success: 'border-gmn-success/40',
  warning: 'border-gmn-warning/50',
  danger: 'border-gmn-danger/50',
  info: 'border-gmn-accent/40',
  neutral: 'border-white/15 border-dashed',
};
const ICON: Readonly<Record<string, LucideIcon>> = { integrity: ShieldAlert, unavailable: TriangleAlert, pending: TriangleAlert, refused: ShieldAlert, blocked: TriangleAlert, scored: CircleCheck, inconclusive: CircleDashed, loading: Info, no_evidence: CircleDashed };

/** Faixa de estado fixa no topo: `aria-live` educado; estado nunca só por cor (ícone + texto). */
export function StatusStrip({ headline, registry, notice }: { readonly headline: Headline; readonly registry: RegistryLine | null; readonly notice: { readonly tone: StatusTone; readonly text: string } | null }): React.JSX.Element {
  const Icon = ICON[headline.kind] ?? Info;
  const percent = headline.coverage ? Math.max(0, Math.min(100, headline.coverage.percent)) : null;
  return (
    <div className={`z-20 rounded-2xl border bg-gmn-sidebar/95 p-4 shadow-lg backdrop-blur md:sticky md:top-2 ${BORDER[headline.tone]}`}>
      <div role="status" aria-live="polite" className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-gmn-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug text-gmn-text">{headline.title}</p>
          {headline.lines.map((line) => (
            <p key={line} className="mt-0.5 text-xs text-gmn-muted">{line}</p>
          ))}
          {headline.coverage && percent !== null && (
            <div className="mt-2 max-w-md">
              <p className="text-xs text-gmn-muted">
                Cobertura verificada <strong className="text-gmn-text">{headline.coverage.percent}%</strong> · mínimo exigido <strong className="text-gmn-text">{headline.coverage.minimum}%</strong>
              </p>
              <div role="img" aria-label={`Cobertura verificada ${headline.coverage.percent} por cento; mínimo exigido ${headline.coverage.minimum} por cento`} className="relative mt-1 h-2 rounded-full bg-white/[0.08]">
                <div className="h-2 rounded-full bg-gmn-accent/80" style={{ width: `${percent}%` }} />
                <div aria-hidden="true" className="absolute top-[-3px] h-[14px] w-0.5 bg-white/80" style={{ left: `${Math.max(0, Math.min(100, headline.coverage.minimum))}%` }} />
              </div>
            </div>
          )}
          {registry && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gmn-muted">
              <StatusBadge tone={registry.tone} label={registry.historical ? 'Histórico' : 'Registro'} icon={registry.historical ? History : CircleCheck} dashed={registry.historical} />
              <span>{registry.text}</span>
            </p>
          )}
        </div>
      </div>
      {notice && (
        <p role="status" className={`mt-3 rounded-lg border px-3 py-2 text-xs ${notice.tone === 'success' ? 'border-gmn-success/40 text-green-200' : notice.tone === 'danger' ? 'border-gmn-danger/40 text-red-200' : notice.tone === 'warning' ? 'border-gmn-warning/40 text-amber-200' : 'border-white/15 text-gmn-muted'}`}>
          {notice.text}
        </p>
      )}
    </div>
  );
}
