import { CircleCheck, CircleDashed, CircleX, Gauge } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatHalfPoints, GATE_LABELS, INCONCLUSIVE_HEADLINE, LEVEL_LABELS, safeText } from './labels';
import type { OutcomePreview, PreviewCriterion, PublicResult } from './types';
import { CopyHash } from './ui-bits';

function Gates({ result }: { readonly result: PublicResult | null }): React.JSX.Element | null {
  const gates = result?.publication?.gates;
  if (!gates || gates.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gmn-muted">Portões da metodologia</h3>
      <ul className="mt-2 space-y-1.5">
        {gates.map((gate) => (
          <li key={gate.id} className="flex items-start gap-2 text-xs">
            {gate.passed ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-300" aria-hidden="true" /> : <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-300" aria-hidden="true" />}
            <span className="text-gmn-text"><strong>{GATE_LABELS[gate.id] ?? gate.id}</strong>: {gate.passed ? 'atendido' : 'não atendido'} — <span className="text-gmn-muted">{safeText(gate.text, 240)}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
function Limitations({ result }: { readonly result: PublicResult | null }): React.JSX.Element | null {
  const items = result?.limitations;
  if (!items || items.length === 0) return null;
  return (
    <details className="rounded-lg border border-white/[0.06] bg-gmn-tile/40">
      <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-xs font-semibold text-gmn-text focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70">Limitações do cálculo ({items.length})</summary>
      <ul className="list-disc space-y-1 px-8 pb-3 text-xs text-gmn-muted">
        {items.map((item) => (
          <li key={item.code}>{safeText(item.text, 400)}</li>
        ))}
      </ul>
    </details>
  );
}

/** Registro técnico SEM nota: componente DISTINTO do pontuado. Nenhum número de pontuação, selo ou cor de sucesso. */
export function InconclusiveRecordPanel({ outcome, result, context }: { readonly outcome: OutcomePreview | null; readonly result: PublicResult | null; readonly context: 'preview' | 'record' }): React.JSX.Element {
  const percent = outcome && Number.isFinite(outcome.coveragePercent) ? Math.max(0, Math.min(100, outcome.coveragePercent)) : null;
  return (
    <div className="space-y-4 rounded-xl border border-dashed border-white/20 bg-white/[0.02] p-4">
      <p className="flex items-start gap-2 text-sm font-semibold text-gmn-text"><CircleDashed className="mt-0.5 h-5 w-5 shrink-0 text-gmn-muted" aria-hidden="true" />{INCONCLUSIVE_HEADLINE}</p>
      {outcome && percent !== null && (
        <div>
          <p className="text-xs text-gmn-muted">Cobertura verificada <strong className="text-gmn-text">{outcome.coveragePercent}%</strong> · mínimo exigido <strong className="text-gmn-text">{outcome.minimumCoveragePercent}%</strong></p>
          <div role="img" aria-label={`Cobertura verificada ${outcome.coveragePercent} por cento de um mínimo de ${outcome.minimumCoveragePercent} por cento`} className="relative mt-1.5 h-2 max-w-md rounded-full bg-white/[0.08]">
            <div className="h-2 rounded-full bg-gmn-muted/70" style={{ width: `${percent}%` }} />
            <div aria-hidden="true" className="absolute top-[-3px] h-[14px] w-0.5 bg-white/80" style={{ left: `${outcome.minimumCoveragePercent}%` }} />
          </div>
        </div>
      )}
      <p className="text-xs text-gmn-muted">
        {context === 'preview' ? 'Esta é uma prévia técnica. Registrá-la guarda apenas a constatação de que as evidências são insuficientes; nenhum número é atribuído.' : 'Registro técnico: guarda a constatação de que as evidências eram insuficientes; nenhum número foi atribuído.'}
      </p>
      <Gates result={result} />
      <Limitations result={result} />
    </div>
  );
}

/** Resultado PONTUADO: exibe SOMENTE campos que a API entrega; nada é calculado nem somado aqui. */
export function ScoredResultPanel({ outcome, result, criteria, context }: { readonly outcome: OutcomePreview; readonly result: PublicResult; readonly criteria: readonly PreviewCriterion[]; readonly context: 'preview' | 'record' }): React.JSX.Element {
  const level = outcome.level ? (LEVEL_LABELS[outcome.level] ?? outcome.level) : null;
  return (
    <div className="space-y-4 rounded-xl border border-gmn-accent/40 bg-gmn-accent/[0.05] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-gmn-text"><Gauge className="h-5 w-5 text-gmn-accent" aria-hidden="true" />{context === 'preview' ? 'Prévia pontuada (ainda não registrada)' : 'Resultado pontuado confirmado'}</p>
        {level && <StatusBadge tone="info" label={level.toUpperCase()} icon={Gauge} />}
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <p className="text-xs text-gmn-muted">Índice Lumos</p>
          <p className="text-3xl font-semibold text-gmn-text">{safeText(result.index?.decimal2, 12) || '—'}</p>
          {result.index?.classificationLabel && <p className="text-xs text-gmn-muted">{safeText(result.index.classificationLabel, 60)}</p>}
        </div>
        <div>
          <p className="text-xs text-gmn-muted">Confiança</p>
          <p className="text-lg font-semibold text-gmn-text">{safeText(result.confidence?.levelLabel, 40) || '—'}</p>
        </div>
        <div>
          <p className="text-xs text-gmn-muted">Cobertura</p>
          <p className="text-lg font-semibold text-gmn-text">{outcome.coveragePercent}%</p>
        </div>
      </div>
      {criteria.some((criterion) => criterion.obtainedHalfPoints !== undefined) && (
        <ul className="grid gap-1.5 text-xs sm:grid-cols-2">
          {criteria.map((criterion) => (
            <li key={criterion.id} className="flex justify-between gap-3 rounded-lg border border-white/[0.06] px-3 py-1.5">
              <span className="text-gmn-text">{criterion.label}</span>
              <span className="shrink-0 text-gmn-muted">{criterion.obtainedHalfPoints == null ? '—' : `${formatHalfPoints(criterion.obtainedHalfPoints)} de ${criterion.maxPoints}`}</span>
            </li>
          ))}
        </ul>
      )}
      <Gates result={result} />
      <Limitations result={result} />
      <p className="text-xs text-gmn-muted">Valores exatamente como a API os entrega; a página não recalcula índice nem pontos. <CopyHash value={result.resultSha256 ?? result.inputSha256} label="hash do resultado" /></p>
    </div>
  );
}

/** Escolhe o componente certo. Pontuado só se a API trouxe `outcome=PONTUADO` E um índice; senão, o registro técnico. */
export function ResultPanel({ outcome, result, criteria, context = 'preview' }: { readonly outcome: OutcomePreview | null; readonly result: PublicResult | null; readonly criteria: readonly PreviewCriterion[]; readonly context?: 'preview' | 'record' }): React.JSX.Element {
  if (!outcome) return <p className="text-sm text-gmn-muted">Nada foi calculado: não há entrada válida para o motor.</p>;
  if (outcome.outcome === 'PONTUADO' && result && result.index) return <ScoredResultPanel outcome={outcome} result={result} criteria={criteria} context={context} />;
  return <InconclusiveRecordPanel outcome={outcome} result={result} context={context} />;
}
