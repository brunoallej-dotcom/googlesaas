import {
  BarChart3,
  Crown,
  EyeOff,
  Link2,
  MessageCircle,
  Signal,
  Star,
  Target,
  Trophy,
} from 'lucide-react';
import type { FrontierLead, ProspectingOutput } from '@/types/gmn';
import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { RANK_INDEX_HINT } from '@/lib/battlefield-metrics';
import { resolveEvidenceCoverage } from '@/lib/evidence/coverage';
import { describeCoverage } from '@/lib/judge-scoring';
import { MetricCard } from '@/components/ui/metric-card';
import type { MetricDelta } from '@/components/ui/metric-card';
import { Panel } from '@/components/ui/panel';
import { MapLegend } from '@/components/maps/map-legend';
import { NOT_AVAILABLE } from '@/components/ui/labels';
import type { AuditJobTracker } from './types';

interface TerritorySummaryProps {
  readonly campaign: ProspectingOutput | null;
  readonly lead: FrontierLead | null;
  readonly tracker: AuditJobTracker | null;
  /** Mesmo modelo que alimenta o mapa: indicadores e marcadores nunca divergem. */
  readonly model: BattlefieldMapModel;
}

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const ratingFmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pct(value: number | null | undefined): string | null {
  const n = finite(value);
  return n === null ? null : `${nf.format(n)}%`;
}

/**
 * Todas as métricas vêm do lead, da campanha, da auditoria (Score Juiz) ou do modelo do mapa.
 * Sem dado = "Não disponível". Nada é estimado ou preenchido. Os percentuais de posição usam
 * só as leituras válidas no denominador; as leituras ausentes são informadas à parte.
 */
export function TerritorySummary({
  campaign,
  lead,
  tracker,
  model,
}: TerritorySummaryProps): React.JSX.Element {
  const { coverage, counts, percentages } = model;
  const hasData = model.hasData;
  const leads = campaign?.leads ?? [];
  const totalLeads = leads.length;

  const verifiedWhatsApp = leads.filter((l) => l.whatsappStatus === 'VERIFIED_WHATSAPP').length;
  const ownDomain = leads.filter((l) => l.websiteStatus === 'OWN_DOMAIN').length;
  const whatsappShare = totalLeads > 0 ? (verifiedWhatsApp / totalLeads) * 100 : null;
  const domainShare = totalLeads > 0 ? (ownDomain / totalLeads) * 100 : null;

  // Nota: do lead auditado; sem seleção, média dos leads da campanha.
  const selectedRating = finite(tracker?.reputation?.averageRating) ?? finite(lead?.rating);
  const selectedReviews = finite(tracker?.reputation?.totalReviews) ?? finite(lead?.totalReviews);
  const campaignRating =
    totalLeads > 0 ? leads.reduce((sum, l) => sum + l.rating, 0) / totalLeads : null;
  const rating = lead ? selectedRating : campaignRating;
  const ratingSub = lead
    ? selectedReviews === null
      ? null
      : `${nf.format(selectedReviews)} avaliações`
    : 'média dos leads';

  // A evolução só existe com rodada anterior real (o adaptador descarta o baseline sem rodada).
  const positionDelta = finite(model.evolution?.averagePositionDelta);
  const delta: MetricDelta | null =
    positionDelta !== null && positionDelta !== 0
      ? {
          text: `${positionDelta < 0 ? '↓' : '↑'} ${nf.format(positionDelta)}`,
          tone: positionDelta < 0 ? 'good' : 'bad',
        }
      : null;

  const evidenceSummary =
    lead && tracker?.judge && tracker.reputation && tracker.vitrine && tracker.battlefield && tracker.rivals
      ? resolveEvidenceCoverage({
          lead,
          reputation: tracker.reputation,
          vitrine: tracker.vitrine,
          battlefield: tracker.battlefield,
          rivals: tracker.rivals,
          judge: tracker.judge,
        })
      : null;
  const coverageLine = evidenceSummary
    ? describeCoverage(evidenceSummary, tracker?.judge?.checklist21Items.length ?? 21)
    : null;

  const validHint =
    coverage.valid > 0
      ? `sobre ${coverage.valid} ${coverage.valid === 1 ? 'leitura válida' : 'leituras válidas'}`
      : undefined;

  return (
    <Panel
      id="resumo"
      icon={BarChart3}
      title="Resumo do Território"
      subtitle={
        <>
          <span className="block break-words">
            {campaign
              ? `${campaign.city}, ${campaign.stateCode} • ${campaign.nicheKeyword}`
              : 'Execute uma prospecção para ver os indicadores.'}
          </span>
          {lead && <span className="block truncate text-gmn-accent">Auditoria: {lead.businessName}</span>}
        </>
      }
      className="flex h-full flex-col"
      bodyClassName="mt-4 flex flex-1 flex-col"
    >
      <div className="grid grid-cols-2 gap-2.5">
        <MetricCard
          size="lg"
          icon={Crown}
          iconClassName="text-gmn-warning"
          label={tracker?.judge?.scoreMethod ? 'Pontuação do Juiz (Fase 4)' : 'Score Juiz histórico'}
          value={pct(tracker?.judge?.overallScore)}
          sub={coverageLine}
          title={
            tracker?.judge?.scoreMethod
              ? `Recalculada nesta auditoria: média ponderada só dos critérios com pontuação (${nf.format(evidenceSummary?.scoredWeightPercent ?? 0)}% do peso total). Não é comparável ao Score Juiz histórico das auditorias anteriores e não é um score global.`
              : 'Score Juiz histórico armazenado: metodologia original dos 21 itens (denominador 102), preservado como foi gravado. Não é um score global: veja a cobertura de evidências.'
          }
        />
        <MetricCard
          size="lg"
          icon={Target}
          iconClassName="text-gmn-danger"
          label="Índice de posição"
          value={model.averagePosition === null ? null : nf.format(model.averagePosition)}
          delta={delta}
          sub={
            model.averagePosition === null
              ? null
              : `${model.knownPositionAverage === null ? 'nenhuma posição no Top 20' : `média no Top 20: ${nf.format(model.knownPositionAverage)}`}${coverage.valid > 0 ? ` · ${coverage.valid} leituras válidas` : ''}`
          }
          title={RANK_INDEX_HINT}
        />
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <MetricCard
          icon={Trophy}
          iconClassName="text-gmn-success"
          label="Top 3"
          value={hasData ? counts.top3 : null}
          sub={pct(percentages.top3)}
          title={validHint}
        />
        <MetricCard
          icon={Signal}
          iconClassName="text-gmn-warning"
          label="Top 7"
          value={hasData ? counts.top7 : null}
          sub={pct(percentages.top7)}
          title={validHint}
        />
        <MetricCard
          className="col-span-2 sm:col-span-1"
          icon={EyeOff}
          iconClassName="text-gmn-accent"
          label="Fora do Top 20"
          value={hasData ? counts.above20 : null}
          sub={pct(percentages.above20)}
          title={validHint}
        />
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <MetricCard
          icon={Star}
          iconClassName="text-gmn-warning"
          label="Avaliações"
          value={rating === null ? null : ratingFmt.format(rating)}
          sub={ratingSub}
          title="Nota média no Google"
        />
        <MetricCard
          icon={MessageCircle}
          iconClassName="text-gmn-success"
          label="WhatsApp"
          value={pct(whatsappShare)}
          sub="com link WhatsApp"
          title="Leads com link de WhatsApp informado. Celular sem link não conta como verificado."
        />
        <MetricCard
          className="col-span-2 sm:col-span-1"
          icon={Link2}
          iconClassName="text-gmn-accent"
          label="Site Próprio"
          value={pct(domainShare)}
          sub="com domínio"
        />
      </div>

      {hasData && (
        <p className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-gmn-muted">
          Coordenadas processadas:{' '}
          <strong className="font-semibold text-gmn-text">
            {coverage.collected} de {coverage.expected}
          </strong>
          {' · '}Leituras válidas: {coverage.valid}
          {' · '}Sem leitura: {coverage.unreadable}
          {coverage.missing > 0 && ` · Ausentes: ${coverage.missing}`}
          {coverage.invalid > 0 && ` · Sem coordenada válida: ${coverage.invalid}`}. Os percentuais usam
          só as leituras válidas.
        </p>
      )}

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <h3 className="text-sm font-semibold text-gmn-text">Legenda dos Marcadores</h3>
        <div className="mt-3">
          <MapLegend variant="list" counts={hasData ? counts : null} />
        </div>
        {!hasData && (
          <p className="mt-3 text-xs text-gmn-muted/80">
            {NOT_AVAILABLE} até a auditoria ler o território.
          </p>
        )}
      </div>
    </Panel>
  );
}
