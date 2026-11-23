import type { CompanyIdentity } from '../audit';
import type { Evidence } from '../evidence';
import type { MapsIdentifiers } from '../maps-link';
import type { CallLedger, CollectionMode, LedgerSummary } from './budget';
import { MAPS_ORIGIN_LIMITATION } from './capabilities';
import { SIMULATED_ORIGIN_NOTE, simulatedText } from './capture-report';
import type { CostEstimate } from './cost';
import type { CollectionInput, CollectionResult, Divergence, IdentifierReport, IdentityBasis, LocateState, ProfileSummary, ProviderId, SiteObservation } from './types';

/*
 * Relatório estruturado de uma coleta (Onda 4B). Puro. Não tem pontos, índice, classificação nem confiança.
 * O que não foi comprovado aparece como "não verificado"; nunca como "ausente" ou "não existe".
 */

export interface UnverifiedItem {
  readonly id: string;
  readonly attribute: string;
  readonly criterionId: string;
  readonly reason: string;
}

export interface CallsSummary {
  readonly planned: number;
  readonly simulated: number;
  readonly sent: number;
  readonly denied: number;
  readonly byProvider: Readonly<Record<ProviderId, LedgerSummary>>;
}

export interface CollectionReport {
  readonly schemaVersion: 1;
  readonly kind: 'COLLECTION_REPORT';
  readonly mode: CollectionMode;
  /** `true` somente se alguma chamada foi realmente enviada a um provedor externo. */
  readonly externalTraffic: boolean;
  readonly generatedAt: string;
  readonly scoring: 'NOT_AVAILABLE_PENDING_D3';
  readonly identity: {
    readonly snapshotId: string;
    readonly originalLink: string;
    readonly effectiveLink: string;
    readonly identifiers: MapsIdentifiers;
    readonly confirmedBy: string;
    readonly confirmedAt: string;
    /** Digitados pelo operador: NÃO são evidência do Google. */
    readonly operatorProvided: { readonly name?: string; readonly city?: string; readonly stateCode?: string };
  };
  readonly provenIdentifiers: MapsIdentifiers;
  /** CID esperado (com origem LINK ou DERIVED_FROM_FID) e por qual identificador o perfil foi aceito. */
  readonly identityBasis: IdentityBasis;
  /** link × derivado × retornado pelo provedor × efetivamente confirmado. */
  readonly identifiers: IdentifierReport;
  readonly located: LocateState;
  readonly found: {
    readonly googleMaps: (ProfileSummary & { readonly source: 'serper-maps' | 'SIMULATED'; readonly queriedAt: string | null; readonly originNote: string }) | null;
    readonly site: (SiteObservation & { readonly source: 'site-check' }) | null;
  };
  readonly evidences: readonly Evidence[];
  readonly unverified: readonly UnverifiedItem[];
  readonly limitations: readonly string[];
  readonly divergences: readonly Divergence[];
  readonly calls: CallsSummary;
  readonly cost: CostEstimate;
}

function callsSummary(ledger: CallLedger | null): CallsSummary {
  const empty: LedgerSummary = { planned: 0, simulated: 0, sent: 0, ok: 0, failed: 0, denied: 0 };
  const byProvider = ledger ? ledger.summary() : { 'serper-maps': empty, 'serper-reviews': empty, 'site-check': empty };
  const providers = Object.values(byProvider);
  const total = (key: keyof LedgerSummary): number => providers.reduce((sum, item) => sum + item[key], 0);
  return { planned: total('planned'), simulated: total('simulated'), sent: total('sent'), denied: total('denied'), byProvider };
}

export function buildCollectionReport(params: {
  readonly mode: CollectionMode;
  readonly input: CollectionInput;
  readonly identity: CompanyIdentity;
  readonly result: CollectionResult;
  readonly ledger: CallLedger | null;
  readonly cost: CostEstimate;
  readonly generatedAt: string;
}): CollectionReport {
  const { input, identity, result } = params;
  const operatorProvided = {
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.city ? { city: identity.city } : {}),
    ...(identity.stateCode ? { stateCode: identity.stateCode } : {}),
  };
  return {
    schemaVersion: 1,
    kind: 'COLLECTION_REPORT',
    mode: params.mode,
    externalTraffic: params.ledger?.externalTraffic ?? false,
    generatedAt: params.generatedAt,
    scoring: 'NOT_AVAILABLE_PENDING_D3',
    identity: {
      snapshotId: input.snapshotId,
      originalLink: input.link.originalLink,
      effectiveLink: input.link.resolved?.url ?? input.link.originalLink,
      identifiers: identity.identifiers,
      confirmedBy: identity.confirmation?.confirmedBy ?? '',
      confirmedAt: identity.confirmation?.confirmedAt ?? '',
      operatorProvided,
    },
    provenIdentifiers: result.provenIdentifiers,
    identityBasis: result.identityBasis,
    identifiers: result.identifiers,
    located: result.located,
    found: {
      googleMaps: result.profile
        ? { ...result.profile, source: 'serper-maps', queriedAt: result.queriedAt.maps, originNote: MAPS_ORIGIN_LIMITATION }
        : null,
      site: result.siteObservation ? { ...result.siteObservation, source: 'site-check' } : null,
    },
    evidences: result.evidences,
    unverified: result.evidences
      .filter((evidence) => evidence.status === 'NOT_VERIFIED')
      .map((evidence) => ({ id: evidence.id, attribute: evidence.attribute, criterionId: evidence.criterionId, reason: evidence.limitation ?? 'sem motivo registrado' })),
    limitations: result.limitations,
    divergences: result.divergences,
    calls: callsSummary(params.ledger),
    cost: params.cost,
  };
}

/**
 * W5.2b (revisão do PR #62): o relatório em memória da coleta SIMULADA GRAVADA (ensaio) atribui os dados ao gerador sintético, nunca ao Serper
 * (fonte, nota de origem, limitações e evidências). O SIMULATED com provedores de teste da Onda 4B não passa por aqui.
 */
export function asSimulatedReport(report: CollectionReport): CollectionReport {
  const googleMaps = report.found.googleMaps ? { ...report.found.googleMaps, source: 'SIMULATED' as const, originNote: SIMULATED_ORIGIN_NOTE } : null;
  return {
    ...report,
    found: { ...report.found, googleMaps },
    evidences: report.evidences.map((e) => (e.limitation ? { ...e, limitation: simulatedText(e.limitation) } : e)),
    unverified: report.unverified.map((item) => ({ ...item, reason: simulatedText(item.reason) })),
    limitations: report.limitations.map(simulatedText),
  };
}
