import { Ban, Info } from 'lucide-react';
import { formatHalfPoints, reasonLabel, safeText } from './labels';
import type { PreviewPayload } from './types';
import { CopyHash } from './ui-bits';

export function BlockersPanel({ blockers }: { readonly blockers: PreviewPayload['blockers'] }): React.JSX.Element {
  if (blockers.length === 0) return <p className="text-xs text-gmn-muted">Nenhum bloqueio aberto.</p>;
  return (
    <ul className="space-y-2">
      {blockers.map((blocker) => (
        <li key={`${blocker.code}-${blocker.decisionIds.join(',')}-${blocker.subcriterionIds.join(',')}`} className="rounded-lg border border-white/[0.06] bg-gmn-tile/50 p-2.5 text-xs">
          <p className="flex items-start gap-2 text-gmn-text">
            {blocker.severity === 'BLOCKING' ? <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-300" aria-hidden="true" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gmn-accent" aria-hidden="true" />}
            <span><strong>{blocker.severity === 'BLOCKING' ? 'Bloqueia' : 'Aviso'}</strong> · {safeText(blocker.message, 400)}</span>
          </p>
          {(blocker.decisionIds.length > 0 || blocker.subcriterionIds.length > 0) && (
            <p className="mt-1 text-gmn-muted">{blocker.decisionIds.length > 0 && <>Decisões: {blocker.decisionIds.map((id) => safeText(id, 12)).join(', ')}. </>}{blocker.subcriterionIds.length > 0 && <>Subcritérios: {blocker.subcriterionIds.map((id) => safeText(id, 8)).join(', ')}.</>}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MissingPanel({ missing }: { readonly missing: PreviewPayload['missing'] }): React.JSX.Element {
  if (missing.length === 0) return <p className="text-xs text-gmn-muted">Nada a acrescentar com os dados disponíveis.</p>;
  return (
    <ul className="space-y-1.5 text-xs">
      {missing.map((item) => (
        <li key={item.family} className="flex justify-between gap-3 border-b border-white/[0.05] pb-1.5">
          <span className="text-gmn-text">{safeText(item.label, 200) || reasonLabel(item.family)}</span>
          <span className="shrink-0 text-gmn-muted">+{formatHalfPoints(item.potentialHalfPoints)} pts</span>
        </li>
      ))}
      <li className="pt-1 text-gmn-muted">Potencial de cobertura, ainda não comprovado: não é nota nem promessa.</li>
    </ul>
  );
}

export function TraceabilityPanel({ preview }: { readonly preview: PreviewPayload }): React.JSX.Element {
  const result = preview.result;
  const rows: Array<[string, React.ReactNode]> = [
    ['Identificador usado pelo motor', <code key="a" className="break-all text-gmn-text">{safeText(preview.scoringAuditId, 80) || '—'}</code>],
    ['Head das decisões confirmadas', preview.decisions.head ? <span key="b">#{preview.decisions.head.seq} <CopyHash value={preview.decisions.head.sha256} label="head das decisões" /></span> : 'sem decisões'],
    ['Hash da entrada do motor', <CopyHash key="c" value={preview.finalization.expectedInputSha256} label="hash da entrada" />],
    ['Data de referência', preview.evidence.referenceDate ?? '—'],
    ['Régua / modelo', result ? `${safeText(result.scoreModelVersion, 60)} · ${safeText(result.methodologyVersion, 60)}` : '—'],
    ['Impressão digital da régua', <CopyHash key="d" value={result?.rulerFingerprint} label="impressão digital da régua" />],
    ['Decisões aplicadas', preview.decisions.applied.length > 0 ? preview.decisions.applied.map((id) => safeText(id, 12)).join(', ') : 'nenhuma'],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dt className="shrink-0 text-gmn-muted">{label}</dt>
          <dd className="min-w-0 text-gmn-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
