import { AlertTriangle, CloudOff, Loader2, Map as MapIcon, MapPin, RotateCcw } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { FrontierLead } from '@/types/gmn';
import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { TIER_META, formatCoordinate } from '@/lib/battlefield-map-utils';
import { AGENT_LABEL, STAGE_LABEL } from '@/components/ui/labels';
import { Panel } from '@/components/ui/panel';
import { BattlefieldMapLoader } from '@/components/maps/battlefield-map-loader';
import { MapLegend } from '@/components/maps/map-legend';
import type { AuditJobTracker } from './types';

interface BattlefieldCardProps {
  readonly model: BattlefieldMapModel;
  readonly lead: FrontierLead | null;
  readonly tracker: AuditJobTracker | null;
  /** O mapa mostra o resultado de uma auditoria anterior (a atual falhou ou está em andamento). */
  readonly isStaleResult: boolean;
}

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

function formatExecutedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormatter.format(date);
}

const NOTICE_BASE = 'flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs';

function Notice({
  tone,
  children,
}: {
  readonly tone: 'warning' | 'danger' | 'info';
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const toneClass =
    tone === 'danger'
      ? 'border-gmn-danger/30 bg-gmn-danger/10 text-red-200'
      : tone === 'warning'
        ? 'border-gmn-warning/30 bg-gmn-warning/10 text-amber-200'
        : 'border-gmn-accent/25 bg-gmn-accent/10 text-sky-200';
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`${NOTICE_BASE} ${toneClass}`}>
      {children}
    </div>
  );
}

function EmptyMapState({
  tracker,
}: {
  readonly tracker: AuditJobTracker | null;
}): React.JSX.Element {
  const failed = tracker?.status === 'FAILED';
  const inProgress = tracker && !failed && tracker.status !== 'COMPLETED';

  if (failed && tracker) {
    return (
      <div
        role="alert"
        className="gmn-grid-bg flex min-h-[380px] flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gmn-danger/30 bg-gmn-sidebar px-6 text-center"
      >
        <AlertTriangle className="h-8 w-8 text-gmn-danger" aria-hidden="true" />
        <p className="text-sm font-medium text-gmn-text">A auditoria foi interrompida antes do mapa</p>
        <p className="max-w-md break-words text-sm text-red-200">
          {tracker.errorMessage ?? 'Consulte o terminal do Worker para detalhes.'}
        </p>
      </div>
    );
  }

  if (inProgress && tracker) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="gmn-grid-bg flex min-h-[380px] flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/10 bg-gmn-sidebar px-6 text-center"
      >
        <Loader2 className="h-8 w-8 animate-spin text-gmn-accent" aria-hidden="true" />
        <p className="text-sm font-medium text-gmn-text">Auditoria em andamento</p>
        <p className="text-xs text-gmn-muted">
          {STAGE_LABEL[tracker.status]} · Etapa: {AGENT_LABEL[tracker.currentAgent]}
        </p>
        <div
          role="progressbar"
          aria-label="Progresso da auditoria"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={tracker.progressPercent}
          className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-gmn-surface"
        >
          <div className="h-full bg-gmn-primary transition-[width]" style={{ width: `${tracker.progressPercent}%` }} />
        </div>
        <p className="text-xs tabular-nums text-gmn-muted">{tracker.progressPercent}%</p>
        <p className="max-w-sm text-xs text-gmn-muted">
          O mapa aparece assim que a leitura dos 49 pontos terminar.
        </p>
      </div>
    );
  }

  return (
    <div className="gmn-grid-bg flex min-h-[380px] flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/10 bg-gmn-sidebar px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gmn-primary/10 ring-1 ring-gmn-primary/20">
        <MapIcon className="h-7 w-7 text-gmn-accent" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-gmn-text">Sem dados de território</p>
      <p className="max-w-md text-sm text-gmn-muted">
        Conclua uma auditoria para visualizar o território: o mapa mostra os 49 pontos lidos e a
        posição da empresa em cada um. Nenhuma auditoria é iniciada ao selecionar um lead.
      </p>
    </div>
  );
}

function PointsList({ model }: { readonly model: BattlefieldMapModel }): React.JSX.Element {
  return (
    <details className="group rounded-lg border border-white/[0.06] bg-gmn-tile">
      <summary className="cursor-pointer select-none rounded-lg px-3.5 py-2.5 text-xs font-medium text-gmn-muted hover:text-gmn-text">
        Ver pontos em lista ({model.markers.length})
      </summary>
      <div className="max-h-72 overflow-auto border-t border-white/[0.06]">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Pontos do Campo de Batalha com posição e coordenadas</caption>
          <thead className="sticky top-0 bg-gmn-tile text-[11px] uppercase tracking-wide text-gmn-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Ponto</th>
              <th scope="col" className="px-3 py-2">Posição</th>
              <th scope="col" className="px-3 py-2">Classificação</th>
              <th scope="col" className="px-3 py-2">Latitude</th>
              <th scope="col" className="px-3 py-2">Longitude</th>
              <th scope="col" className="px-3 py-2">Líder</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05] tabular-nums">
            {model.markers.map((marker) => (
              <tr key={marker.pointIndex}>
                <td className="px-3 py-1.5">#{marker.pointNumber}</td>
                <td className="px-3 py-1.5 font-semibold">{marker.label}</td>
                <td className="px-3 py-1.5">{TIER_META[marker.tier].classification}</td>
                <td className="px-3 py-1.5 font-mono">{formatCoordinate(marker.latitude)}</td>
                <td className="px-3 py-1.5 font-mono">{formatCoordinate(marker.longitude)}</td>
                <td className="px-3 py-1.5">{marker.leaderName ?? 'Não informado'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function BattlefieldCard({
  model,
  lead,
  tracker,
  isStaleResult,
}: BattlefieldCardProps): React.JSX.Element {
  const [baseMapFailed, setBaseMapFailed] = useState(false);
  const [tileKey, setTileKey] = useState(0);
  const handleBaseMapStatus = useCallback(
    (status: 'ok' | 'failed') => setBaseMapFailed(status === 'failed'),
    []
  );

  const hasPlottable = model.hasData && (model.markers.length > 0 || model.company !== null);
  const inProgress = tracker && tracker.status !== 'COMPLETED' && tracker.status !== 'FAILED';
  const failed = tracker?.status === 'FAILED';
  const { coverage } = model;
  const executedAt = formatExecutedAt(model.executedAt);

  return (
    <Panel
      id="battlefield"
      icon={MapPin}
      iconClassName="fill-gmn-primary text-gmn-accent"
      title="Campo de Batalha Geográfico"
      subtitle="Entenda o posicionamento da empresa e seus concorrentes no território."
      actions={
        model.hasData && (
          <span className="text-xs tabular-nums text-gmn-muted">
            {coverage.collected} {coverage.collected === 1 ? 'ponto analisado' : 'pontos analisados'}
          </span>
        )
      }
      className="flex h-full flex-col"
      bodyClassName="mt-4 flex flex-1 flex-col gap-3"
    >
      {!hasPlottable ? (
        model.hasData ? (
          <Notice tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              A auditoria retornou {coverage.collected} {coverage.collected === 1 ? 'ponto' : 'pontos'}, mas
              nenhum com coordenadas válidas para exibir no mapa.
            </span>
          </Notice>
        ) : (
          <EmptyMapState tracker={tracker} />
        )
      ) : (
        <>
          {failed && tracker && (
            <Notice tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-words">
                A auditoria foi interrompida: {tracker.errorMessage ?? 'consulte o terminal do Worker.'}{' '}
                O mapa mostra o resultado já salvo.
              </span>
            </Notice>
          )}
          {isStaleResult && !failed && (
            <Notice tone="info">
              <RotateCcw className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Resultado de uma auditoria anterior
                {inProgress ? ' (nova auditoria em andamento)' : ''}.
              </span>
            </Notice>
          )}
          {inProgress && !isStaleResult && tracker && (
            <Notice tone="info">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
              <span>
                Auditoria em andamento ({tracker.progressPercent}% · {AGENT_LABEL[tracker.currentAgent]}). Os
                pontos abaixo já são reais; os indicadores completos chegam ao final.
              </span>
            </Notice>
          )}
          {(coverage.missing > 0 || coverage.invalid > 0) && (
            <Notice tone="warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {coverage.collected} de {coverage.expected} pontos coletados
                {coverage.missing > 0 ? ` · ${coverage.missing} ausentes` : ''}
                {coverage.invalid > 0 ? ` · ${coverage.invalid} sem coordenada válida (não exibidos)` : ''}.
                Só os pontos realmente disponíveis são mostrados.
              </span>
            </Notice>
          )}
          {baseMapFailed && (
            <Notice tone="warning">
              <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">
                O mapa-base não pôde ser carregado. As posições continuam disponíveis nos marcadores e na lista de pontos.
              </span>
              <button
                type="button"
                onClick={() => setTileKey((n) => n + 1)}
                className="shrink-0 rounded-md border border-gmn-warning/40 px-2.5 py-1 font-semibold text-amber-100 transition-colors hover:bg-gmn-warning/15"
              >
                Tentar novamente
              </button>
            </Notice>
          )}

          <div className="relative min-h-[380px] flex-1 overflow-hidden rounded-xl border border-white/[0.06] bg-gmn-sidebar">
            <BattlefieldMapLoader
              model={model}
              businessName={lead?.businessName ?? model.company?.name ?? null}
              tileKey={tileKey}
              onBaseMapStatus={handleBaseMapStatus}
            />
          </div>

          <div className="xl:hidden">
            <MapLegend variant="inline" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-gmn-muted">
            <p className="min-w-0">
              {(lead?.businessName ?? model.company?.name) && (
                <strong className="font-medium text-gmn-text">{lead?.businessName ?? model.company?.name}</strong>
              )}
              {model.keyword && <> · Palavra-chave: “{model.keyword}”</>}
            </p>
            {executedAt && <p className="tabular-nums">Leitura em {executedAt}</p>}
          </div>

          {model.evolution && (
            <p className="text-xs leading-relaxed text-gmn-muted">{model.evolution.summaryText}</p>
          )}

          <PointsList model={model} />
        </>
      )}
    </Panel>
  );
}
