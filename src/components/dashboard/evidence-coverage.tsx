import type { FrontierLead } from '@/types/gmn';
import { resolveEvidenceCoverage } from '@/lib/evidence/coverage';
import type { AuditJobTracker } from './types';

interface EvidenceCoverageProps {
  readonly tracker: AuditJobTracker;
  readonly lead: FrontierLead | null;
}

const SEGMENTS = [
  { key: 'VERIFIED', label: 'Verificados', bar: 'bg-gmn-success', dot: 'bg-gmn-success' },
  { key: 'PARTIALLY_VERIFIED', label: 'Parcialmente verificados', bar: 'bg-gmn-warning', dot: 'bg-gmn-warning' },
  { key: 'NOT_VERIFIED', label: 'Não verificados', bar: 'bg-slate-500', dot: 'bg-slate-500' },
  { key: 'SIMULATED', label: 'Simulados', bar: 'bg-violet-500', dot: 'bg-violet-500' },
] as const;

const fmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Cobertura de evidências do Juiz: quantos critérios têm evidência real e quanto do peso eles
 * representam. Nunca apresenta o score histórico como pontuação totalmente comprovada.
 */
export function EvidenceCoverage({ tracker, lead }: EvidenceCoverageProps): React.JSX.Element | null {
  const { judge, reputation, vitrine, battlefield, rivals } = tracker;
  if (!judge || !lead || !reputation || !vitrine || !battlefield || !rivals) return null;

  const summary = resolveEvidenceCoverage({ lead, reputation, vitrine, battlefield, rivals, judge });
  if (!summary) return null;

  const total = judge.checklist21Items.length;
  const collectedAt = battlefield.executedAt ? dateFmt.format(new Date(battlefield.executedAt)) : null;
  const failures = judge.evidenceBundle?.providerFailures ?? [];
  const pending = summary.buckets.NOT_VERIFIED.count + summary.buckets.PARTIALLY_VERIFIED.count;

  return (
    <div className="space-y-3 border-t border-white/[0.06] pt-5" aria-label="Cobertura de evidências">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gmn-text">Cobertura de evidências</h3>
        <span className="text-xs tabular-nums text-gmn-muted">
          {summary.buckets.VERIFIED.count} de {total} critérios · {fmt.format(summary.verifiedCoveragePercent)}% do peso
        </span>
      </div>

      <div
        role="img"
        aria-label={`Peso por status de evidência: ${SEGMENTS.map((s) => `${s.label} ${fmt.format(summary.buckets[s.key].weightPercent)}%`).join(', ')}`}
        className="flex h-2 w-full overflow-hidden rounded-full bg-gmn-surface"
      >
        {SEGMENTS.map((segment) => (
          <div
            key={segment.key}
            className={segment.bar}
            style={{ width: `${summary.buckets[segment.key].weightPercent}%` }}
          />
        ))}
      </div>

      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-gmn-muted">
        {SEGMENTS.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${segment.dot}`} aria-hidden="true" />
            <span className="truncate">{segment.label}</span>
            <span className="ml-auto tabular-nums text-gmn-text">
              {summary.buckets[segment.key].count} · {fmt.format(summary.buckets[segment.key].weightPercent)}%
            </span>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 text-xs text-gmn-muted">
        {judge.scoreMethod ? (
          <div className="flex justify-between gap-3">
            <dt>Pontuação recalculada (denominador: {fmt.format(summary.scoredWeightPercent)}% do peso)</dt>
            <dd className="tabular-nums text-gmn-text">
              {summary.recalculatedScore === null ? 'Não disponível' : `${fmt.format(summary.recalculatedScore)}%`}
            </dd>
          </div>
        ) : (
          <div className="flex justify-between gap-3">
            <dt>Score Juiz histórico armazenado (21 critérios, denominador 102)</dt>
            <dd className="tabular-nums text-gmn-text">{fmt.format(judge.overallScore)}%</dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt>Desempenho nos critérios verificados</dt>
          <dd className="tabular-nums text-gmn-text">
            {summary.verifiedPerformance === null ? 'Não disponível' : `${fmt.format(summary.verifiedPerformance)}%`}
          </dd>
        </div>
        {summary.partialPerformance !== null && (
          <div className="flex justify-between gap-3">
            <dt>Parcialmente verificados (à parte)</dt>
            <dd className="tabular-nums text-gmn-text">{fmt.format(summary.partialPerformance)}%</dd>
          </div>
        )}
        {collectedAt && (
          <div className="flex justify-between gap-3">
            <dt>Última coleta territorial</dt>
            <dd className="tabular-nums text-gmn-text">{collectedAt}</dd>
          </div>
        )}
      </dl>

      {pending > 0 && (
        <p className="rounded-lg border border-white/[0.06] bg-gmn-tile p-3 text-xs text-gmn-muted">
          {pending} {pending === 1 ? 'critério depende' : 'critérios dependem'} de informação pendente de validação:
          nada foi tratado como aprovado ou reprovado sem evidência. Detalhes no PDF.
        </p>
      )}
      {failures.length > 0 && (
        <p role="status" className="rounded-lg border border-gmn-warning/30 bg-gmn-warning/10 p-3 text-xs text-gmn-warning">
          {failures.length} {failures.length === 1 ? 'falha de coleta registrada' : 'falhas de coleta registradas'}; os
          dados válidos foram preservados e os campos afetados ficaram indisponíveis.
        </p>
      )}
    </div>
  );
}
