import { Ban, CircleCheck, CircleDashed, Hand, Minus, PencilLine } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import type { StatusTone } from '@/components/ui/status-badge';
import { formatHalfPoints, reasonLabel, safeText, SOURCE_LABELS, STATE_LABELS } from './labels';
import type { OptionKey } from './state';
import type { PreviewCriterion, PreviewPayload, PreviewSubcriterion } from './types';
import { BUTTON_QUIET } from './ui-bits';

const OPTION_BY_SUBCRITERION: Readonly<Record<string, OptionKey>> = { C2: 'C2', S4: 'S4' };

function stateBadge(sub: PreviewSubcriterion): React.JSX.Element {
  const label = sub.state ? (STATE_LABELS[sub.state] ?? sub.state) : 'Não calculado';
  const tone: StatusTone = sub.state === 'SCORED' || sub.state === 'ABSENCE_PROVEN' ? 'success' : sub.state === 'NOT_APPLICABLE' ? 'neutral' : 'warning';
  const Icon = sub.state === 'SCORED' || sub.state === 'ABSENCE_PROVEN' ? CircleCheck : sub.state === 'NOT_APPLICABLE' ? Minus : CircleDashed;
  return <StatusBadge tone={tone} label={label} icon={Icon} dashed={tone === 'warning'} />;
}
function sourceBadge(sub: PreviewSubcriterion): React.JSX.Element {
  const label = SOURCE_LABELS[sub.source] ?? sub.source;
  if (sub.source === 'BLOQUEADO') return <StatusBadge tone="danger" label={label} icon={Ban} />;
  if (sub.source === 'DECISAO_HUMANA') return <StatusBadge tone="info" label={label} icon={Hand} />;
  return <StatusBadge tone="neutral" label={label} icon={sub.source === 'SEM_DADO' ? CircleDashed : CircleCheck} dashed={sub.source === 'SEM_DADO'} />;
}
const potentialText = (sub: PreviewSubcriterion): string | null => (sub.potential.halfPoints > 0 ? `potencial de cobertura: +${formatHalfPoints(sub.potential.halfPoints)} pts (não comprovado)` : null);

interface MatrixProps {
  readonly preview: PreviewPayload;
  readonly canAct: boolean;
  readonly onRegister: (key: OptionKey) => void;
}

function Action({ sub, preview, canAct, onRegister }: { readonly sub: PreviewSubcriterion } & MatrixProps): React.JSX.Element | null {
  const key = OPTION_BY_SUBCRITERION[sub.id];
  const option = key ? preview.decisionOptions.find((item) => item.subcriterionId === sub.id) : undefined;
  if (!key || !option) return null;
  if (!option.available) return <span className="text-xs text-gmn-muted">Decisão indisponível: {reasonLabel(option.reasonCode) || 'sem base'}</span>;
  return (
    <button type="button" disabled={!canAct} onClick={() => onRegister(key)} className={BUTTON_QUIET} aria-label={`Registrar decisão para ${sub.id} ${safeText(sub.label, 80)}`}>
      <PencilLine className="h-4 w-4" aria-hidden="true" />
      {option.reasonCode === 'EXISTING_DECISION_REPLACE' ? 'Substituir decisão' : 'Registrar decisão'}
    </button>
  );
}

function CriterionTable({ criterion, hasPoints, ...rest }: { readonly criterion: PreviewCriterion; readonly hasPoints: boolean } & MatrixProps): React.JSX.Element {
  return (
    <details open={criterion.subcriteria.some((sub) => sub.source === 'DECISAO_HUMANA' || sub.state === 'SCORED')} className="group rounded-xl border border-white/[0.06] bg-gmn-tile/40">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70 [&::-webkit-details-marker]:hidden">
        <h3 className="text-sm font-semibold text-gmn-text">{criterion.label} <span className="font-normal text-gmn-muted">· peso máx. {criterion.maxPoints}</span></h3>
        <span className="text-xs text-gmn-muted">{criterion.subcriteria.length} subcritérios · {criterion.status === 'PARTIAL' ? 'parcialmente avaliado' : criterion.status === 'EVALUATED' ? 'avaliado' : 'sem avaliação suficiente'}</span>
      </summary>
      {/* desktop: tabela */}
      <div className="hidden overflow-x-auto px-4 pb-3 md:block">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Subcritérios de {criterion.label}</caption>
          <thead className="text-gmn-muted">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">Subcritério</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Situação</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Origem</th>
              {hasPoints && <th scope="col" className="py-1.5 pr-3 font-medium">Pontos</th>}
              <th scope="col" className="py-1.5 font-medium">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {criterion.subcriteria.map((sub) => (
              <tr key={sub.id} className="align-top">
                <th scope="row" className="py-2 pr-3 font-medium text-gmn-text"><span className="font-mono text-gmn-muted">{sub.id}</span> {safeText(sub.label, 100)}</th>
                <td className="py-2 pr-3"><div className="flex flex-col items-start gap-1">{stateBadge(sub)}{sub.tier && <span className="text-gmn-muted">faixa: {safeText(sub.tier, 60)}</span>}</div></td>
                <td className="py-2 pr-3"><div className="flex flex-col items-start gap-1">{sourceBadge(sub)}{sub.sourceReason && <span className="text-gmn-muted">{reasonLabel(sub.sourceReason)}</span>}{potentialText(sub) && <span className="text-gmn-muted">{potentialText(sub)}</span>}</div></td>
                {hasPoints && <td className="py-2 pr-3 text-gmn-text">{sub.obtainedHalfPoints == null ? '—' : `${formatHalfPoints(sub.obtainedHalfPoints)} de ${formatHalfPoints(sub.maxHalfPoints)}`}</td>}
                <td className="py-2"><Action sub={sub} {...rest} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* celular: cartões */}
      <ul className="space-y-2 px-3 pb-3 md:hidden">
        {criterion.subcriteria.map((sub) => (
          <li key={sub.id} className="rounded-lg border border-white/[0.06] bg-gmn-card/60 p-3 text-xs">
            <p className="font-medium text-gmn-text"><span className="font-mono text-gmn-muted">{sub.id}</span> {safeText(sub.label, 100)}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">{stateBadge(sub)}{sourceBadge(sub)}</div>
            {sub.tier && <p className="mt-1 text-gmn-muted">faixa: {safeText(sub.tier, 60)}</p>}
            {sub.sourceReason && <p className="mt-1 text-gmn-muted">{reasonLabel(sub.sourceReason)}</p>}
            {potentialText(sub) && <p className="mt-1 text-gmn-muted">{potentialText(sub)}</p>}
            {hasPoints && sub.obtainedHalfPoints != null && <p className="mt-1 text-gmn-text">{formatHalfPoints(sub.obtainedHalfPoints)} de {formatHalfPoints(sub.maxHalfPoints)} pts</p>}
            <div className="mt-2"><Action sub={sub} {...rest} /></div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function CriteriaMatrix(props: MatrixProps): React.JSX.Element {
  const hasPoints = props.preview.criteria.some((criterion) => criterion.subcriteria.some((sub) => sub.obtainedHalfPoints !== undefined));
  return (
    <div className="space-y-3">
      <p className="text-xs text-gmn-muted">“Não verificado” não é zero: o subcritério fica fora do cálculo até haver evidência. Origem rotulada: dados do perfil vêm da Serper, um intermediário (não é a API oficial do Google).</p>
      {props.preview.criteria.map((criterion) => (
        <CriterionTable key={criterion.id} criterion={criterion} hasPoints={hasPoints} {...props} />
      ))}
    </div>
  );
}
