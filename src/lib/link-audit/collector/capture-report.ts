import type { CompanyIdentity } from '../audit';
import type { MapsIdentifiers } from '../maps-link';
import type { Evidence } from '../evidence';
import { collectEvidence } from './collect';
import { METHODOLOGY_VERSION } from '../methodology';
import { MAPS_ORIGIN_LIMITATION } from './capabilities';
import { cleanText } from './maps-place';
import type { SiteCheckOutcome } from './site-access';
import type { CollectionInput, CollectionResult, Divergence, IdentifierReport, IdentityBasis, MapsProvider, ProfileSummary, SiteObservation, SiteProvider } from './types';

/*
 * Relatório estruturado a partir de uma captura JÁ FEITA (Onda 4D). Módulo PURO: não lê arquivos, não usa rede,
 * ambiente nem relógio. Reproduz a coleta com o pipeline de produção alimentado por provedores de REPLAY (a
 * resposta bruta capturada), de modo que nenhuma chamada externa acontece. Sem pontos, índice ou Lumos.
 */

export interface CaptureFileRef {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** O que o run original observou do site (a requisição ao site não é refeita). */
export interface OriginalSiteObservation {
  readonly requestedUrl: string;
  readonly checkedAt: string;
  /** Texto de falha exatamente como o run original registrou. */
  readonly originalFailureReason: string;
  readonly httpRequests: number | null;
}

export interface CaptureReportInput {
  /** Corpo original da resposta do Serper /maps (texto). */
  readonly rawBody: string;
  readonly body: CaptureFileRef;
  readonly otherFiles: readonly CaptureFileRef[];
  readonly httpStatus: number;
  readonly httpAttempts: number;
  /** Momento da consulta ao Serper, conforme registrado no run original. */
  readonly collectedAt: string;
  readonly input: CollectionInput;
  /** Observação legada (só texto de falha). Ignorada se `siteOutcome` vier. */
  readonly site: OriginalSiteObservation | null;
  /** Resultado COMPLETO da verificação do site feita na coleta (coletas a partir da Onda 5A). */
  readonly siteOutcome?: SiteCheckOutcome | null;
  readonly generatedAt: string;
  /** Captura SIMULADA do ensaio em homologação (W5.2b, spec do P1 §5.7): o relatório leva a marca e a limitação explícita. */
  readonly simulated?: boolean;
}

export interface ProviderResultFields {
  readonly position: number | null;
  readonly title: string | null;
  readonly address: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly rating: number | null;
  readonly ratingCount: number | null;
  readonly type: string | null;
  readonly types: readonly string[];
  readonly website: string | null;
  readonly phoneNumber: string | null;
  readonly openingHours: Readonly<Record<string, string>>;
  readonly cid: string | null;
  readonly fid: string | null;
  readonly placeId: string | null;
  /** O resultado trazia uma miniatura; o endereço dela não é copiado. */
  readonly thumbnailPresent: boolean;
}

export interface CaptureReport {
  readonly schemaVersion: 1;
  readonly kind: 'COLLECTION_REPORT_FROM_CAPTURE';
  readonly generatedAt: string;
  readonly scoring: 'NOT_AVAILABLE_PENDING_D3';
  readonly methodologyVersion: string;
  /** Este relatório foi gerado offline: nenhuma chamada externa. */
  readonly externalCallsMadeByThisReport: 0;
  readonly source: {
    readonly provider: 'serper-maps' | 'SIMULATED';
    /** Só na coleta SIMULADA (ausente nas reais). */
    readonly simulated?: true;
    readonly description: string;
    readonly officialGoogleApi: false;
    readonly collectedAt: string;
    readonly httpStatus: number;
    readonly httpAttempts: number;
    readonly creditsReportedByApi: number | null;
    readonly searchParameters: { readonly q: string | null; readonly gl: string | null; readonly hl: string | null; readonly type: string | null; readonly num: number | null; readonly page: number | null } | null;
    readonly resultCount: number;
    readonly capture: CaptureFileRef;
    readonly otherFiles: readonly CaptureFileRef[];
  };
  readonly identity: {
    readonly snapshotId: string;
    readonly originalLink: string;
    readonly confirmedBy: string;
    readonly confirmedAt: string;
    readonly operatorProvided: { readonly name?: string; readonly city?: string; readonly stateCode?: string };
  };
  readonly located: CollectionResult['located'];
  readonly identifiers: IdentifierReport;
  readonly identityBasis: IdentityBasis;
  readonly providerResult: ProviderResultFields | null;
  readonly data: {
    /** `SIMULATED` só na coleta SIMULADA do ensaio (W5.2b): os dados vêm do gerador sintético, não do Serper. */
    readonly googleMaps: (ProfileSummary & { readonly source: 'serper-maps' | 'SIMULATED'; readonly queriedAt: string | null }) | null;
    readonly site: (SiteObservation & { readonly source: 'site-check'; readonly observedInOriginalRun: true; readonly note: string }) | null;
  };
  readonly evidences: readonly Evidence[];
  readonly verified: readonly { readonly id: string; readonly attribute: string; readonly claim: string; readonly origin: string; readonly consultedAt: string; readonly limitation: string | null; readonly viaSerper: boolean; readonly originNote: string | null }[];
  readonly unverified: readonly { readonly id: string; readonly criterionId: string; readonly reason: string }[];
  readonly limitations: readonly string[];
  readonly divergences: readonly Divergence[];
  /** Na coleta SIMULADA do ensaio (W5.2b), `simulatedMaps` (o gerador sintético) no lugar das chamadas ao Serper. */
  readonly calls:
    | { readonly serperMaps: { readonly attempts: number; readonly httpStatus: number }; readonly serperReviews: 0; readonly siteHttpRequests: number | null }
    | { readonly simulatedMaps: { readonly attempts: number; readonly httpStatus: number }; readonly reviews: 0; readonly siteHttpRequests: number | null };
}

export type CaptureReportResult = { readonly ok: true; readonly report: CaptureReport } | { readonly ok: false; readonly reason: string };

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown, max = 300): string | null => cleanText(value, max);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function pickProviderResult(raw: Record<string, unknown>): ProviderResultFields {
  const hours: Record<string, string> = Object.create(null) as Record<string, string>;
  if (isRecord(raw.openingHours)) {
    for (const [day, value] of Object.entries(raw.openingHours).slice(0, 14)) {
      const d = str(day, 30);
      const v = str(value, 60);
      if (d && v) hours[d] = v;
    }
  }
  const id = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 && value.length <= 255 ? value.trim() : null);
  return {
    position: num(raw.position),
    title: str(raw.title, 200),
    address: str(raw.address, 300),
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    rating: num(raw.rating),
    ratingCount: num(raw.ratingCount),
    type: str(raw.type, 120),
    types: Array.isArray(raw.types) ? raw.types.map((t) => str(t, 120)).filter((t): t is string => t !== null).slice(0, 10) : [],
    website: typeof raw.website === 'string' && raw.website.length <= 2048 ? raw.website.trim() : null,
    phoneNumber: str(raw.phoneNumber, 40),
    openingHours: hours,
    cid: id(raw.cid),
    fid: id(raw.fid) ?? id(raw.featureId),
    placeId: id(raw.placeId),
    thumbnailPresent: typeof raw.thumbnailUrl === 'string' && raw.thumbnailUrl.length > 0,
  };
}

function sameResult(raw: Record<string, unknown>, returned: MapsIdentifiers): boolean {
  const cid = typeof raw.cid === 'string' ? raw.cid : null;
  const fid = typeof raw.fid === 'string' ? raw.fid.toLowerCase() : typeof raw.featureId === 'string' ? raw.featureId.toLowerCase() : null;
  return (returned.cid !== undefined && cid !== null && cid === returned.cid) || (returned.featureId !== undefined && fid === returned.featureId);
}

const REAL_SOURCE_DESCRIPTION = 'Dados coletados via Serper /maps (intermediário de coleta da listagem pública do Google Maps). NÃO vêm da API oficial do Google Business Profile e o perfil não foi aberto diretamente no Google.';
const SIMULATED_SOURCE_DESCRIPTION = 'SIMULADA — ensaio: dados SINTÉTICOS gerados pelo modo SIMULATED do coletor na homologação. Nenhuma consulta foi feita ao Serper nem ao Google; nunca é evidência real.';
const SIMULATED_LIMITATION = 'SIMULADA — ensaio: captura sintética de homologação (nenhuma consulta foi feita); não descreve nenhuma empresa real e nunca é evidência real.';
/** No simulado, a origem de cada dado do perfil é o gerador sintético (nenhum texto atribui o dado a um provedor; revisão do PR #62). */
export const SIMULATED_ORIGIN_NOTE = 'SIMULADA — ensaio: dado sintético do gerador da homologação; nenhuma consulta externa foi feita.';
const SIMULATED_NOT_PROVIDED = 'SIMULADA — ensaio: o gerador sintético não traz este dado; nenhuma consulta externa foi feita.';
const PROVIDER_ATTRIBUTION = /Serper/;
const PROVIDER_NOT_PROVIDED = /não disponibiliza/;

/** Texto do pipeline (feito para a coleta real) que atribui o dado ao provedor ⇒ a mesma informação, atribuída ao gerador sintético. */
export function simulatedText(text: string): string {
  if (!PROVIDER_ATTRIBUTION.test(text)) return text;
  return PROVIDER_NOT_PROVIDED.test(text) ? SIMULATED_NOT_PROVIDED : SIMULATED_ORIGIN_NOTE;
}
/** Evidências da coleta simulada: só a `limitation` muda de origem (status, ids e datas são os do pipeline). */
const simulatedEvidences = (evidences: readonly Evidence[]): Evidence[] => evidences.map((e) => (e.limitation ? { ...e, limitation: simulatedText(e.limitation) } : e));

const SITE_NOT_RUN = /^Verificação do site não executada: (?:nenhum provedor configurado|orçamento igual a zero)\.$/;
const validIso = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && !Number.isNaN(Date.parse(value));

export async function buildReportFromCapture(params: CaptureReportInput): Promise<CaptureReportResult> {
  if (!validIso(params.collectedAt) || !validIso(params.generatedAt) || (params.site && !validIso(params.site.checkedAt)) || (params.siteOutcome && !validIso(params.siteOutcome.checkedAt))) {
    return { ok: false, reason: 'Data inválida na captura (esperado ISO 8601 em UTC).' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch {
    return { ok: false, reason: 'O corpo capturado não é JSON válido.' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.places)) return { ok: false, reason: 'O corpo capturado não traz a lista "places" esperada.' };
  if (params.httpStatus < 200 || params.httpStatus > 299) return { ok: false, reason: 'A captura registra uma resposta HTTP que não é de sucesso.' };
  const rawPlaces = parsed.places as readonly unknown[];

  const maps: MapsProvider = { search: async () => ({ state: 'OK', value: rawPlaces, fetchedAt: params.collectedAt }) };
  const siteReplay: SiteProvider | undefined = params.siteOutcome
    ? { check: async (): Promise<SiteCheckOutcome> => params.siteOutcome as SiteCheckOutcome }
    : params.site
    ? {
        check: async (): Promise<SiteCheckOutcome> => ({
          requestedUrl: params.site?.requestedUrl ?? null,
          finalUrl: null,
          status: 'BLOCKED',
          httpStatus: null,
          redirects: [],
          checkedAt: params.site?.checkedAt ?? params.collectedAt,
          title: null,
          noindex: null,
          robotsTxt: 'UNKNOWN',
          localBusiness: null,
          telLinks: [],
          whatsappLinks: [],
          emailLinks: [],
          failureReason: params.site?.originalFailureReason ?? null,
        }),
      }
    : undefined;

  const outcome = await collectEvidence(
    params.input,
    { maps, ...(siteReplay ? { site: siteReplay } : {}) },
    // O "agora" da reprodução é o instante mais tardio observado no run original, para que nenhuma data registrada
    // seja tratada como futura e ajustada.
    { budget: { maps: 1, reviews: 0, site: siteReplay ? 1 : 0 }, now: () => new Date(Math.max(Date.parse(params.collectedAt), params.siteOutcome ? Date.parse(params.siteOutcome.checkedAt) : params.site ? Date.parse(params.site.checkedAt) : 0)) },
  );
  if (!outcome.ok) return { ok: false, reason: outcome.issues.join(' ') };
  const result = outcome.result;

  const returned = result.identifiers.returnedByProvider;
  const rawMatch = returned ? rawPlaces.find((item): item is Record<string, unknown> => isRecord(item) && sameResult(item, returned)) : undefined;
  const sp = isRecord(parsed.searchParameters) ? parsed.searchParameters : null;
  const identity: CompanyIdentity = params.input.identity;
  const limitations = [...result.limitations];
  if (result.siteObservation?.accessClass === 'RESTRICTED_RESPONSE_UNSPECIFIED') {
    limitations.push('O código HTTP exato da resposta do site não foi gravado na coleta original; o site não foi consultado de novo.');
  }
  if (!params.site && !params.siteOutcome) {
    // A coleta original não deixou um resultado de verificação do site que possa ser reproduzido: a ausência é da CAPTURA.
    for (let i = limitations.length - 1; i >= 0; i--) if (SITE_NOT_RUN.test(limitations[i] ?? '')) limitations.splice(i, 1);
    limitations.push('A coleta original não registrou o resultado da verificação do site (ou o motivo não pôde ser recuperado da captura); o site não foi consultado de novo.');
  }
  if (identity.name === undefined) limitations.push('O nome da empresa não foi informado pelo operador; a busca usou a dica do link.');
  const simulated = params.simulated === true;
  if (simulated) {
    for (let i = 0; i < limitations.length; i++) limitations[i] = simulatedText(limitations[i] ?? '');
    limitations.unshift(SIMULATED_LIMITATION);
  }
  const evidences = simulated ? simulatedEvidences(result.evidences) : result.evidences;

  const report: CaptureReport = {
    schemaVersion: 1,
    kind: 'COLLECTION_REPORT_FROM_CAPTURE',
    generatedAt: params.generatedAt,
    scoring: 'NOT_AVAILABLE_PENDING_D3',
    methodologyVersion: METHODOLOGY_VERSION,
    externalCallsMadeByThisReport: 0,
    source: {
      provider: simulated ? 'SIMULATED' : 'serper-maps',
      ...(simulated ? { simulated: true as const } : {}),
      description: simulated ? SIMULATED_SOURCE_DESCRIPTION : REAL_SOURCE_DESCRIPTION,
      officialGoogleApi: false,
      collectedAt: params.collectedAt,
      httpStatus: params.httpStatus,
      httpAttempts: params.httpAttempts,
      creditsReportedByApi: num(parsed.credits),
      searchParameters: sp
        ? { q: str(sp.q, 200), gl: str(sp.gl, 10), hl: str(sp.hl, 10), type: str(sp.type, 20), num: num(sp.num), page: num(sp.page) }
        : null,
      resultCount: rawPlaces.length,
      capture: params.body,
      otherFiles: params.otherFiles,
    },
    identity: {
      snapshotId: params.input.snapshotId,
      originalLink: params.input.link.originalLink,
      confirmedBy: identity.confirmation?.confirmedBy ?? '',
      confirmedAt: identity.confirmation?.confirmedAt ?? '',
      operatorProvided: {
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.city ? { city: identity.city } : {}),
        ...(identity.stateCode ? { stateCode: identity.stateCode } : {}),
      },
    },
    located: result.located,
    identifiers: result.identifiers,
    identityBasis: result.identityBasis,
    providerResult: rawMatch ? pickProviderResult(rawMatch) : null,
    data: {
      googleMaps: result.profile ? { ...result.profile, source: simulated ? 'SIMULATED' : 'serper-maps', queriedAt: result.queriedAt.maps } : null,
      site: result.siteObservation
        ? {
            ...result.siteObservation,
            httpRequests: params.siteOutcome?.access?.requests ?? params.site?.httpRequests ?? result.siteObservation.httpRequests,
            source: 'site-check',
            observedInOriginalRun: true,
            note: 'Observação feita na coleta original; o site não foi consultado novamente.',
          }
        : null,
    },
    evidences,
    verified: evidences
      .filter((e) => e.status === 'VERIFIED')
      .map((e) => ({
        id: e.id,
        attribute: e.attribute,
        claim: e.claim,
        origin: e.origin,
        consultedAt: e.consultedAt,
        limitation: e.limitation ?? null,
        // `GOOGLE_NATIVE` aqui significa "atributo nativo do perfil", mas o dado veio do Serper (intermediário); no simulado, do gerador sintético.
        viaSerper: !simulated && e.id.startsWith('maps-'),
        originNote: e.id.startsWith('maps-') ? (simulated ? SIMULATED_ORIGIN_NOTE : MAPS_ORIGIN_LIMITATION) : null,
      })),
    unverified: evidences
      .filter((e) => e.status === 'NOT_VERIFIED')
      .map((e) => ({ id: e.id, criterionId: e.criterionId, reason: e.limitation ?? 'sem motivo registrado' })),
    limitations: [...new Set(limitations)],
    divergences: result.divergences,
    calls: simulated
      ? { simulatedMaps: { attempts: params.httpAttempts, httpStatus: params.httpStatus }, reviews: 0, siteHttpRequests: params.siteOutcome?.access?.requests ?? params.site?.httpRequests ?? null }
      : { serperMaps: { attempts: params.httpAttempts, httpStatus: params.httpStatus }, serperReviews: 0, siteHttpRequests: params.siteOutcome?.access?.requests ?? params.site?.httpRequests ?? null },
  };
  return { ok: true, report };
}

