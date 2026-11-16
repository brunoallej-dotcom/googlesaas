import { ClipboardList, Download, FileText, History, PauseCircle, Play, RotateCcw, Swords } from 'lucide-react';
import type { FrontierLead } from '@/types/gmn';
import { AGENT_LABEL, PHASE_LABEL, RECOVERED_LABEL, STAGE_LABEL } from '@/components/ui/labels';
import { Panel } from '@/components/ui/panel';
import { EvidenceCoverage } from './evidence-coverage';
import type { AuditJobTracker } from './types';

interface AuditPanelProps {
  readonly tracker: AuditJobTracker | null;
  readonly lead: FrontierLead | null;
  readonly onRetry: (lead: FrontierLead) => void;
  readonly onResume: (tracker: AuditJobTracker) => void;
}

const DASHED_EMPTY =
  'mt-4 rounded-xl border border-dashed border-white/10 bg-gmn-tile px-4 py-8 text-center text-sm text-gmn-muted';

export function AuditPanel({ tracker, lead, onRetry, onResume }: AuditPanelProps): React.JSX.Element {
  const failed = tracker?.status === 'FAILED';
  const interrupted = tracker?.phase === 'INTERRUPTED' && !failed;

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2 xl:grid-cols-3">
      <Panel
        id="auditoria"
        icon={ClipboardList}
        title="Auditoria Maestro"
        subtitle={
          tracker && lead ? (
            <>
              <span className="block truncate text-sm text-gmn-text">{lead.businessName}</span>
              <span className="block break-all font-mono">Job: {tracker.auditId}</span>
            </>
          ) : (
            'Nenhuma auditoria selecionada. Use “Gerar Auditoria” na tabela de leads.'
          )
        }
        bodyClassName="space-y-5"
      >
        {tracker ? (
          <div className="mt-4 space-y-3">
            <p className="font-mono text-xs text-gmn-muted">
              Status: {tracker.recovered ? RECOVERED_LABEL : tracker.phase ? PHASE_LABEL[tracker.phase] : STAGE_LABEL[tracker.status]} ·
              Etapa: {AGENT_LABEL[tracker.currentAgent]} · Progresso: {tracker.progressPercent}%
            </p>
            {tracker.recovered && (
              <p className="flex items-start gap-2 rounded-lg border border-gmn-accent/20 bg-gmn-accent/10 p-3 text-xs text-sky-200">
                <History className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Auditoria salva anteriormente{tracker.createdAt ? ` (coletada em ${new Date(tracker.createdAt).toLocaleString('pt-BR')})` : ''}. Nenhuma consulta foi feita agora.
              </p>
            )}
            <div
              role="progressbar"
              aria-label="Progresso da auditoria"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={tracker.progressPercent}
              className="h-2 w-full overflow-hidden rounded-full bg-gmn-surface"
            >
              <div
                className={`h-full transition-[width] ${failed ? 'bg-gmn-danger' : 'bg-gmn-primary'}`}
                style={{ width: `${tracker.progressPercent}%` }}
              />
            </div>
            {interrupted && (
              <div role="alert" className="space-y-3 rounded-xl border border-gmn-warning/30 bg-gmn-warning/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                  <PauseCircle className="h-4 w-4" aria-hidden="true" />
                  Auditoria interrompida
                </p>
                <p className="break-words text-sm text-amber-100">
                  {tracker.phaseReason ?? 'O processamento parou antes de terminar.'}
                  {tracker.workerAlive === false ? ' Inicie o Worker (npm run worker) e retome.' : ''}
                </p>
                {tracker.resumable ? (
                  <>
                    <p className="text-xs text-amber-100/80">
                      Retomar reaproveita o que já foi coletado e gravado; não repete as consultas pagas já feitas.
                    </p>
                    <button
                      type="button"
                      onClick={() => onResume(tracker)}
                      className="inline-flex items-center gap-2 rounded-lg bg-gmn-warning px-4 py-2 text-xs font-semibold text-black transition-opacity hover:opacity-90"
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      Retomar auditoria
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-amber-100/80">
                      Nenhum dado pago foi gravado antes da interrupção: não há o que retomar. Uma nova coleta consome 49 consultas.
                    </p>
                    {lead && (
                      <button
                        type="button"
                        onClick={() => onRetry(lead)}
                        className="inline-flex items-center gap-2 rounded-lg bg-gmn-warning px-4 py-2 text-xs font-semibold text-black transition-opacity hover:opacity-90"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        Nova coleta
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {failed && (
              <div
                role="alert"
                className="space-y-3 rounded-xl border border-gmn-danger/30 bg-gmn-danger/10 p-4"
              >
                <p className="text-sm font-semibold text-red-300">A auditoria falhou.</p>
                <p className="break-words text-sm text-red-200">
                  {tracker.errorMessage ?? 'Consulte o registro do Worker para detalhes.'}
                </p>
                {tracker.resumable && (
                  <button
                    type="button"
                    onClick={() => onResume(tracker)}
                    className="mr-2 inline-flex items-center gap-2 rounded-lg bg-gmn-warning px-4 py-2 text-xs font-semibold text-black transition-opacity hover:opacity-90"
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    Retomar (reaproveita dados já gravados)
                  </button>
                )}
                {lead && (
                  <button
                    type="button"
                    onClick={() => onRetry(lead)}
                    className="inline-flex items-center gap-2 rounded-lg bg-gmn-danger-strong px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    Tentar novamente
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className={DASHED_EMPTY}>O progresso da auditoria aparece aqui.</p>
        )}

        {tracker?.judge && (
          <div className="space-y-4 border-t border-white/[0.06] pt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gmn-text">
                {tracker.judge.scoreMethod
                  ? 'Pontuação do Juiz (Fase 4, critérios pontuados)'
                  : 'Score Juiz histórico (armazenado, 21 itens)'}
              </h3>
              <span
                className="text-2xl font-semibold tabular-nums text-gmn-text"
                title={
                  tracker.judge.scoreMethod
                    ? 'Recalculada: só os critérios com pontuação entram no denominador. Não é o score histórico.'
                    : 'Valor armazenado pela metodologia original (denominador 102); não indica que todos os critérios foram comprovados.'
                }
              >
                {tracker.judge.overallScore}%
              </span>
            </div>
            <p className="rounded-lg border border-gmn-accent/20 bg-gmn-accent/10 p-3 text-xs text-sky-200">
              {tracker.judge.businessModelContext.contextJustification}
            </p>
            <div className="space-y-2.5">
              {tracker.judge.categoryScores.map((cat) => (
                <div key={cat.category} className="text-xs">
                  <div className="mb-1 flex justify-between text-gmn-muted">
                    <span>{cat.categoryLabel}</span>
                    <span className="font-mono tabular-nums">
                      {cat.scorePercent === null ? 'sem pontuação' : `${cat.scorePercent}%`}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-gmn-surface">
                    <div className="h-full bg-gmn-primary" style={{ width: `${cat.scorePercent ?? 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <EvidenceCoverage tracker={tracker} lead={lead} />
          </div>
        )}
      </Panel>

      <Panel
        id="relatorios"
        icon={FileText}
        title="Relatório PDF"
        subtitle="Dossiê de auditoria gerado pelo Diagramador."
      >
        {tracker?.diagrammer ? (
          <div className="mt-4 space-y-3">
            <p className="break-all font-mono text-xs text-gmn-muted">
              {tracker.diagrammer.pdfFileName} · {tracker.diagrammer.pageCount} páginas ·{' '}
              {Math.round(tracker.diagrammer.fileSizeBytes / 1024)} KB
            </p>
            <a
              href={`/api/audit/${tracker.diagrammer.auditId}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-gmn-primary-strong px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-gmn-primary/25 transition-colors hover:bg-gmn-primary-strong-hover"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Baixar relatório PDF
            </a>
          </div>
        ) : (
          <p className={DASHED_EMPTY}>O PDF fica disponível aqui quando a auditoria for concluída.</p>
        )}
      </Panel>

    <Panel
        id="concorrentes"
        className="lg:col-span-2 xl:col-span-1"
        icon={Swords}
        title="Concorrentes Dominantes"
        subtitle="Empresas que lideram o território, calculadas a partir dos pontos da grade."
      >
        {tracker?.rivals && tracker.rivals.topDominators.length > 0 ? (
          <>
            <p className="mt-4 text-sm text-gmn-text">{tracker.rivals.competitiveGapHeadline}</p>
            <ol className="mt-4 space-y-2.5">
              {tracker.rivals.topDominators.map((rival) => (
                <li
                  key={rival.placeId}
                  className="rounded-xl border border-white/[0.04] bg-gmn-tile p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-gmn-text">
                      {rival.rankPosition}º · {rival.businessName}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-gmn-accent">
                      {rival.dominanceSharePercent}% do território
                    </span>
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-gmn-muted">
                    #1 em {rival.pointsWonAsNumberOne} pontos · Nota {rival.rating} ·{' '}
                    {rival.totalReviews} avaliações
                  </p>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className={`${DASHED_EMPTY} flex flex-col items-center gap-3`}>
            <Swords className="h-7 w-7 text-gmn-muted/80" aria-hidden="true" />
            Os concorrentes aparecem aqui quando a auditoria concluir a análise de rivais.
          </div>
        )}
      </Panel>
    </div>
  );
}
