import type { AuditSummary, AuditView, EvidenceItem, IntegrityInfo, VersionEntry, ViewState } from './reader';
import { SIMULATED_SOURCE_LABEL } from './simulated';

/*
 * Objetos de apresentação (Onda 5B): o que o SERVIDOR entrega ao navegador. Planos, tipados e sem o corpo bruto
 * do provedor, sem caminhos do disco, sem chaves. Puro (sem disco, rede ou ambiente): é montado a partir das
 * visões do leitor autorizado, que já passaram por `sanitizeForOutput`.
 */

/** Tetos que mantêm a resposta pequena mesmo com arquivos muito grandes. */
const MAX_EVIDENCES = 40;
const MAX_VERSIONS = 20;

export const EVIDENCE_KIND = 'EVIDENCE_COLLECTION' as const;
export const SOURCE_LABEL = 'Serper /maps (intermediário; não é a API oficial do Google)';

export interface IntegrityDto {
  readonly status: IntegrityInfo['status'];
  readonly algorithm: 'SHA-256';
  readonly checkedFiles: number;
  readonly issues: readonly string[];
  readonly note: string;
}

export interface AuditListItemDto {
  readonly auditId: string;
  readonly companyName: string | null;
  readonly city: string | null;
  readonly stateCode: string | null;
  readonly confirmedCid: string | null;
  readonly collectedAt: string | null;
  readonly sourceLabel: string;
  readonly state: ViewState;
  readonly layout: 'VERSIONED' | 'LEGACY';
  readonly captureCount: number;
  readonly reportRevisions: number;
  readonly integrity: IntegrityDto;
  /** Coleta SIMULADA do ensaio (W5.2b): presente só nela; o `sourceLabel` diz "SIMULADA — ensaio". */
  readonly simulated?: true;
}

export interface EstablishmentDto {
  readonly name: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly category: string | null;
  readonly secondaryCategories: readonly string[];
  readonly rating: number | null;
  readonly ratingCount: number | null;
  readonly openingHours: readonly { readonly day: string; readonly hours: string }[];
  readonly queriedAt: string | null;
}

export interface SiteObservationDto {
  readonly requestedUrl: string | null;
  readonly accessClass: string | null;
  readonly accessNote: string | null;
  readonly httpRequests: number | null;
  readonly checkedAt: string | null;
}

export interface ConfirmedIdentifierDto {
  readonly type: string;
  readonly value: string;
  readonly expectedOrigin: 'LINK' | 'DERIVED_FROM_FID' | null;
  readonly providerFields: readonly string[];
}

export interface IdentifiersDto {
  readonly fromLink: { readonly cid: string | null; readonly featureId: string | null; readonly placeId: string | null };
  readonly derivedCid: { readonly value: string; readonly method: string } | null;
  readonly returnedByProvider: { readonly cid: string | null; readonly featureId: string | null; readonly placeId: string | null } | null;
  readonly confirmed: readonly ConfirmedIdentifierDto[];
}

export interface EvidenceDto {
  readonly id: string;
  readonly criterionId: string;
  readonly attribute: string;
  readonly claim: string;
  readonly status: string;
  readonly origin: string;
  readonly consultedAt: string | null;
  readonly limitation: string | null;
}

export interface DivergenceDto {
  readonly field: string;
  readonly googleMaps: string;
  readonly site: string;
  readonly note: string;
}

export interface VersionDto {
  readonly capture: number | null;
  readonly collectedAt: string | null;
  readonly httpStatus: number | null;
  readonly reportRevisions: readonly { readonly revision: number; readonly generatedAt: string | null; readonly superseded: boolean }[];
}

export interface AuditDetailDto {
  readonly kind: typeof EVIDENCE_KIND;
  readonly auditId: string;
  readonly layout: 'VERSIONED' | 'LEGACY';
  readonly state: ViewState;
  readonly selected: { readonly capture: number | null; readonly revision: number };
  readonly company: { readonly name: string | null; readonly city: string | null; readonly stateCode: string | null };
  readonly collectedAt: string | null;
  readonly methodologyVersion: string | null;
  readonly source: {
    readonly label: string;
    readonly officialGoogleApi: false;
    readonly description: string | null;
    readonly httpStatus: number | null;
    readonly httpAttempts: number | null;
    readonly creditsReportedByApi: number | null;
    readonly resultCount: number | null;
    /** Coleta SIMULADA do ensaio (W5.2b): presente só nela; o `label` diz "SIMULADA — ensaio". */
    readonly simulated?: true;
  };
  readonly located: string | null;
  readonly establishment: EstablishmentDto | null;
  readonly location: { readonly latitude: number; readonly longitude: number } | null;
  readonly site: SiteObservationDto | null;
  readonly identifiers: IdentifiersDto;
  readonly evidences: { readonly verified: readonly EvidenceDto[]; readonly unverified: readonly EvidenceDto[]; readonly other: readonly EvidenceDto[] };
  readonly limitations: readonly string[];
  readonly divergences: readonly DivergenceDto[];
  readonly versions: readonly VersionDto[];
  readonly integrity: IntegrityDto;
  readonly scoring: 'NOT_AVAILABLE_PENDING_D3';
}

const MAX_DISPLAY_URL_INPUT = 2048;

/**
 * Link exibido pela API de evidências: SÓ esquema e host (`https://exemplo.com.br/`). Caminho, consulta,
 * credenciais e fragmento podem carregar segredo (`;jsessionid=`, tokens) e nunca saem (spec 6C §19.2 item 5:
 * URL bruta nunca exibida). O estado de UTM do website aparece na prévia da pontuação, que usa a regra
 * `lumos-url-derive-v1`. O que não é URL http(s) com host não é exibido.
 */
const displayUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DISPLAY_URL_INPUT) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? `${url.protocol}//${url.host}/` : null;
  } catch {
    return null;
  }
};

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);
export const OMITTED_LINK = '[link omitido]';

/** Quantos caracteres de pontuação colam no fim do link (varredura de trás para frente; linear). */
function trailingPunctuationLength(match: string): number {
  let length = 0;
  while (length < match.length && TRAILING_PUNCTUATION.has(match[match.length - 1 - length] as string)) length += 1;
  return length;
}

/**
 * Reduz toda URL http(s) de um texto livre à forma de `displayUrl` (`esquema://host[:porta]/`), mantendo a
 * pontuação colada ao link. URL que não reduz vira `[link omitido]`. Textos livres do coletor (ex.: `Site
 * informado no perfil: <url>`) carregam o caminho completo, que pode ter segredo. Aplicado ANTES de qualquer corte.
 */
export function reduceUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trailingLength = trailingPunctuationLength(match);
    const core = trailingLength > 0 ? match.slice(0, -trailingLength) : match;
    return `${displayUrl(core) ?? OMITTED_LINK}${trailingLength > 0 ? match.slice(-trailingLength) : ''}`;
  });
}

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown, max = 600): string | null => (typeof value === 'string' && value.length > 0 ? reduceUrlsInText(value).slice(0, max) : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strs = (value: unknown, max = 80): string[] => arr(value).filter((v): v is string => typeof v === 'string').slice(0, max).map((v) => reduceUrlsInText(v).slice(0, 600));

const cut = (value: string | null, max = 200): string | null => (value === null ? null : reduceUrlsInText(value).slice(0, max));

const integrityDto = (info: IntegrityInfo): IntegrityDto => ({ status: info.status, algorithm: info.algorithm, checkedFiles: info.checkedFiles, issues: info.issues.slice(0, 20).map((issue) => reduceUrlsInText(issue).slice(0, 300)), note: reduceUrlsInText(info.note).slice(0, 600) });

export function toListItem(summary: AuditSummary): AuditListItemDto {
  return {
    auditId: summary.auditId,
    companyName: cut(summary.company.name),
    city: cut(summary.company.city),
    stateCode: cut(summary.company.stateCode, 10),
    confirmedCid: cut(summary.confirmedCid, 30),
    collectedAt: cut(summary.collectedAt, 40),
    sourceLabel: summary.simulated ? SIMULATED_SOURCE_LABEL : SOURCE_LABEL,
    state: summary.state,
    layout: summary.layout,
    captureCount: summary.captureCount,
    reportRevisions: summary.reportRevisions,
    integrity: integrityDto(summary.integrity),
    ...(summary.simulated ? { simulated: true as const } : {}),
  };
}

const evidenceDto = (item: EvidenceItem): EvidenceDto => ({
  id: item.id.slice(0, 80),
  criterionId: item.criterionId.slice(0, 40),
  attribute: item.attribute.slice(0, 80),
  claim: reduceUrlsInText(item.claim).slice(0, 600),
  status: item.status.slice(0, 30),
  origin: item.origin.slice(0, 30),
  consultedAt: cut(item.consultedAt, 40),
  limitation: item.limitation ? reduceUrlsInText(item.limitation).slice(0, 1200) : null,
});

function establishmentOf(value: unknown): EstablishmentDto | null {
  const g = rec(value);
  if (Object.keys(g).length === 0) return null;
  return {
    name: str(g.name),
    address: str(g.address),
    phone: str(g.phone, 60),
    website: displayUrl(g.website),
    category: str(g.category, 200),
    secondaryCategories: strs(g.secondaryCategories, 10),
    rating: num(g.rating),
    ratingCount: num(g.ratingCount),
    openingHours: arr(g.openingHours)
      .map((entry) => (Array.isArray(entry) ? { day: str(entry[0], 40) ?? '', hours: str(entry[1], 80) ?? '' } : null))
      .filter((entry): entry is { day: string; hours: string } => entry !== null && entry.day.length > 0)
      .slice(0, 14),
    queriedAt: str(g.queriedAt, 40),
  };
}

function siteOf(value: unknown): SiteObservationDto | null {
  const s = rec(value);
  if (Object.keys(s).length === 0) return null;
  return { requestedUrl: displayUrl(s.requestedUrl), accessClass: str(s.accessClass, 60), accessNote: str(s.accessNote, 800), httpRequests: num(s.httpRequests), checkedAt: str(s.checkedAt, 40) };
}

function triple(value: unknown): { cid: string | null; featureId: string | null; placeId: string | null } {
  const v = rec(value);
  return { cid: str(v.cid, 30), featureId: str(v.featureId, 60), placeId: str(v.placeId, 255) };
}

function identifiersOf(value: unknown): IdentifiersDto {
  const ids = rec(value);
  const derived = rec(rec(ids.derived).cid);
  const returned = ids.returnedByProvider;
  return {
    fromLink: triple(ids.fromLink),
    derivedCid: str(derived.value, 30) ? { value: str(derived.value, 30) as string, method: str(derived.method, 80) ?? '' } : null,
    returnedByProvider: returned && typeof returned === 'object' ? triple(returned) : null,
    confirmed: arr(ids.confirmed)
      .map(rec)
      .map((c) => ({
        type: str(c.type, 20) ?? '',
        value: str(c.value, 255) ?? '',
        expectedOrigin: c.expectedOrigin === 'LINK' || c.expectedOrigin === 'DERIVED_FROM_FID' ? (c.expectedOrigin as 'LINK' | 'DERIVED_FROM_FID') : null,
        providerFields: strs(c.providerFields, 6),
      }))
      .filter((c) => c.type && c.value)
      .slice(0, 10),
  };
}

const versionDto = (v: VersionEntry): VersionDto => ({
  capture: v.capture,
  collectedAt: cut(v.collectedAt, 40),
  httpStatus: v.httpStatus,
  reportRevisions: v.reportRevisions.slice(0, MAX_VERSIONS).map((r) => ({ revision: r.revision, generatedAt: cut(r.generatedAt, 40), superseded: r.superseded })),
});

export function toAuditDetailDto(view: AuditView): AuditDetailDto {
  const data = rec(view.data);
  return {
    kind: EVIDENCE_KIND,
    auditId: view.auditId,
    layout: view.layout,
    state: view.state,
    selected: { capture: view.selected.capture, revision: view.selected.revision },
    company: { name: cut(view.company.name), city: cut(view.company.city), stateCode: cut(view.company.stateCode, 10) },
    collectedAt: cut(view.collectedAt, 40),
    methodologyVersion: cut(view.methodologyVersion, 60),
    source: {
      label: view.simulated ? SIMULATED_SOURCE_LABEL : SOURCE_LABEL,
      ...(view.simulated ? { simulated: true as const } : {}),
      officialGoogleApi: false,
      description: cut(view.source.description, 600),
      httpStatus: view.source.httpStatus,
      httpAttempts: view.source.httpAttempts,
      creditsReportedByApi: view.source.creditsReportedByApi,
      resultCount: view.source.resultCount,
    },
    located: cut(view.located, 30),
    establishment: establishmentOf(data.googleMaps),
    location: view.location,
    site: siteOf(data.site),
    identifiers: identifiersOf(view.identifiers),
    evidences: {
      verified: view.evidences.verified.slice(0, MAX_EVIDENCES).map(evidenceDto),
      unverified: view.evidences.unverified.slice(0, MAX_EVIDENCES).map(evidenceDto),
      other: view.evidences.other.slice(0, MAX_EVIDENCES).map(evidenceDto),
    },
    limitations: view.limitations.slice(0, 40).map((l) => reduceUrlsInText(l).slice(0, 1200)),
    divergences: arr(view.divergences)
      .map(rec)
      .map((d) => ({ field: str(d.field, 20) ?? '', googleMaps: str(d.googleMaps, 300) ?? '', site: str(d.site, 300) ?? '', note: str(d.note, 600) ?? '' }))
      .slice(0, 10),
    versions: view.versions.slice(0, MAX_VERSIONS).map(versionDto),
    integrity: integrityDto(view.integrity),
    scoring: 'NOT_AVAILABLE_PENDING_D3',
  };
}
