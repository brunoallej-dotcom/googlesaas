import { CircleCheck, CircleDashed, FileClock, History, ShieldAlert } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateTime, LEVEL_LABELS, OUTCOME_LABELS, safeText } from './labels';
import { ResultPanel } from './result-panel';
import type { DetailState } from './state';
import { latestRun, runObsolescence } from './status';
import type { ResultsConfirmation, ResultsList, RunDetail, RunSummary } from './types';
import { BUTTON_QUIET, CopyHash } from './ui-bits';

const pad = (seq: number): string => `s${String(seq).padStart(4, '0')}`;

/** O selo diz O QUE confirma (R1.5, D-23): o livro de cabeças, objeto a objeto; ou só o recibo, sem prova do livro (legado ou sem livro) — nunca o mesmo selo para os dois. */
function ConfirmationBadge({ confirmation }: { readonly confirmation: ResultsConfirmation }): React.JSX.Element {
  return confirmation === 'LEDGER' ? <StatusBadge tone="success" label="Confirmado pelo livro" icon={CircleCheck} /> : <StatusBadge tone="warning" label="Confirmado só por recibo (sem prova do livro)" icon={ShieldAlert} dashed />;
}

function RunBadges({ run, changedAfter, confirmation }: { readonly run: RunSummary; readonly changedAfter: boolean | null; readonly confirmation: ResultsConfirmation }): React.JSX.Element {
  const o = runObsolescence(run, changedAfter);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <ConfirmationBadge confirmation={confirmation} />
      {run.superseded && <StatusBadge tone="neutral" label="Substituído" icon={History} dashed />}
      {!run.superseded && o.historical && <StatusBadge tone="warning" label="Histórico" icon={FileClock} dashed />}
      {!run.superseded && run.stale === true && <StatusBadge tone="warning" label="Entrada mudou (stale)" icon={FileClock} dashed />}
      {!run.superseded && run.decisionsChanged === true && <StatusBadge tone="warning" label="Decisões mudaram" icon={FileClock} dashed />}
      {!run.superseded && o.unknown && <StatusBadge tone="neutral" label="Sem comparação atual" icon={CircleDashed} dashed />}
    </span>
  );
}

export interface ResultsPanelProps {
  readonly results: ResultsList;
  readonly detail: DetailState;
  readonly changedAfter: boolean | null;
  readonly onSelect: (seq: number | null) => void;
}

export function ResultsPanel({ results, detail, changedAfter, onSelect }: ResultsPanelProps): React.JSX.Element {
  const runs = [...results.results].reverse();
  const latest = latestRun(results);
  return (
    <div className="space-y-4">
      {results.pending && (
        <div className="rounded-xl border border-dashed border-gmn-warning/60 bg-gmn-warning/[0.06] p-3 text-xs">
          <StatusBadge tone="warning" label="Pendente — não vale" icon={CircleDashed} dashed />
          <p className="mt-2 text-gmn-muted">
            {pad(results.pending.seq)} · {results.pending.outcome ? OUTCOME_LABELS[results.pending.outcome] : 'origem não comprovada'} · {formatDateTime(results.pending.finalizedAt)}.{' '}
            {results.pending.receipt === 'PRESENT' ? 'O recibo existe, mas o livro de cabeças ainda não registrou a confirmação: não é um resultado confirmado e não aparece como atual; só o autor o conclui.' : 'Gravado sem recibo: não é um resultado confirmado e não aparece como atual.'}
            {results.pending.origin === 'PROVEN' ? '' : ' A origem deste arquivo não foi comprovada pelo servidor; ele não pode ser concluído.'}
          </p>
        </div>
      )}
      {results.confirmation === 'RECEIPT_ONLY' && runs.length > 0 && (
        <p role="note" className="rounded-xl border border-dashed border-gmn-warning/60 bg-gmn-warning/[0.06] p-3 text-xs text-amber-200" data-testid="results-receipt-only">
          Estes resultados estão confirmados só por recibo, sem prova do livro de cabeças (auditoria legada ou sem o livro): a remoção ou a troca coordenada das pastas de resultados e de recibos não seria detectada. Não servem como registro atestado.
        </p>
      )}
      {runs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/15 p-4 text-center text-xs text-gmn-muted">Nenhum resultado registrado. A prévia acima não é um resultado definitivo.</p>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => {
            const selected = detail.seq === run.seq;
            return (
              <li key={run.seq} className={`rounded-xl border p-3 text-xs ${selected ? 'border-gmn-accent/50 bg-gmn-accent/[0.05]' : 'border-white/[0.06] bg-gmn-tile/50'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-gmn-text">{pad(run.seq)} · {OUTCOME_LABELS[run.outcome]}{run.level ? ` ${LEVEL_LABELS[run.level] ?? ''}` : ''}{run === latest ? ' · mais recente' : ''}</p>
                  <button type="button" aria-expanded={selected} onClick={() => onSelect(selected ? null : run.seq)} className={BUTTON_QUIET}>{selected ? 'Ocultar detalhe' : 'Ver detalhe verificado'}</button>
                </div>
                <p className="mt-1 text-gmn-muted">{formatDateTime(run.finalizedAt)} · por {safeText(run.finalizedBy, 120)} · cobertura {run.coveragePercent}%</p>
                <div className="mt-2"><RunBadges run={run} changedAfter={run === latest ? changedAfter : null} confirmation={results.confirmation} /></div>
                <p className="mt-2 text-gmn-muted">entrada <CopyHash value={run.inputSha256} label="hash da entrada" /> · registro <CopyHash value={run.contentSha256} label="hash do registro" /></p>
                {selected && <DetailView detail={detail} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DetailView({ detail }: { readonly detail: DetailState }): React.JSX.Element {
  if (detail.phase === 'loading' || detail.phase === 'idle') return <p role="status" className="mt-3 text-gmn-muted">Lendo e verificando o registro…</p>;
  if (detail.phase === 'integrity') return <p role="alert" className="mt-3 flex items-start gap-2 text-red-300"><ShieldAlert className="mt-0.5 h-4 w-4" aria-hidden="true" />Falha de integridade: nenhum dado é exibido.</p>;
  if (detail.phase === 'error' || !detail.data) return <p role="alert" className="mt-3 text-amber-300">{detail.message ?? 'Não foi possível ler o registro.'}</p>;
  const { run } = detail.data;
  return (
    <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
      {(detail.data.superseded || detail.data.stale === true || detail.data.decisionsChanged === true) && (
        <p role="note" className="rounded-lg border border-gmn-warning/40 px-3 py-2 text-amber-200">Registro histórico: {detail.data.superseded ? 'existe um registro mais novo.' : 'a entrada ou as decisões mudaram depois dele.'} Ele continua válido para o estado que registrou, mas pode não representar a situação atual.</p>
      )}
      {run.outcome === 'INCONCLUSIVO' && !run.inconclusive ? <p role="alert" className="text-amber-200">Os dados deste registro vieram incompletos (motivo e cobertura ausentes); nada é exibido como se fosse um fato.</p> : <ResultPanel context="record" outcome={outcomeOf(run)} result={run.result} criteria={[]} />}
      {(detail.data.stale === null || detail.data.decisionsChanged === null) && !detail.data.superseded && <p className="text-gmn-muted">Não foi possível comparar este registro com o estado atual.</p>}
      <RunFacts run={run} />
    </div>
  );
}

function outcomeOf(run: RunDetail): { outcome: 'PONTUADO' | 'INCONCLUSIVO'; level: 'PROVISORIO' | 'PUBLICAVEL' | null; reasonCode: string | null; failedGates: readonly string[]; coveragePercent: number; minimumCoveragePercent: number } {
  const inconclusive = run.inconclusive;
  return {
    outcome: run.outcome,
    level: run.level === 'PROVISORIO' || run.level === 'PUBLICAVEL' ? run.level : null,
    reasonCode: inconclusive?.reasonCode ?? null,
    failedGates: inconclusive?.failedGates ?? [],
    coveragePercent: inconclusive?.coveragePercent ?? run.result.totals?.coveragePercent ?? Number.NaN,
    minimumCoveragePercent: inconclusive?.minimumCoveragePercent ?? 40,
  };
}

function RunFacts({ run }: { readonly run: RunDetail }): React.JSX.Element {
  return (
    <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
      <Fact label="Data de referência" value={run.evidence.referenceDate} />
      <Fact label="Decisões aplicadas" value={run.decisions.appliedIds.length > 0 ? run.decisions.appliedIds.map((id) => safeText(id, 12)).join(', ') : 'nenhuma'} />
      <Fact label="Head das decisões" value={run.decisions.head ? <>#{run.decisions.head.seq} <CopyHash value={run.decisions.head.sha256} label="head das decisões" /></> : 'sem decisões'} />
      <Fact label="Régua / metodologia" value={`${safeText(run.versions.scoreModel, 60)} · ${safeText(run.versions.methodology, 60)}`} />
      <Fact label="Mapeador" value={safeText(run.versions.mapper, 60)} />
      <Fact label="Impressão digital da régua" value={<CopyHash value={run.versions.rulerFingerprint} label="impressão digital da régua" />} />
      <Fact label="Hash do resultado" value={<CopyHash value={run.hashes.resultSha256} label="hash do resultado" />} />
      <Fact label="Registro anterior" value={run.hashes.prevSha256 ? <CopyHash value={run.hashes.prevSha256} label="hash do registro anterior" /> : 'primeiro registro'} />
    </dl>
  );
}
function Fact({ label, value }: { readonly label: string; readonly value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <dt className="shrink-0 text-gmn-muted">{label}</dt>
      <dd className="min-w-0 break-words text-gmn-text">{value}</dd>
    </div>
  );
}
