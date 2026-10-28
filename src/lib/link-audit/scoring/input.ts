import { z } from 'zod';
import { canonicalJson } from '../canonical';
import { parseDay, parseDayFromIso } from './dates';
import { NA_RULES } from './ruler';
import { NA_CODES, SUBCRITERION_IDS, type SubcriterionId } from './types';
import { SCORING_INPUT_SCHEMA_VERSION } from './versions';

/**
 * Entrada do motor: FATOS e EVIDÊNCIAS, nunca pontos. O schema é `.strict()`: qualquer campo de pontuação, índice,
 * cobertura, classificação ou confiança enviado pelo cliente é recusado (o motor é o único que calcula).
 */

export const SCORING_ORIGINS = ['GOOGLE_NATIVE', 'OFFICIAL_SITE', 'OFFICIAL_SOCIAL', 'THIRD_PARTY', 'INSTITUTIONAL'] as const;
export type ScoringOrigin = (typeof SCORING_ORIGINS)[number];
export const SCORING_EVIDENCE_STATUSES = ['VERIFIED', 'PARTIAL', 'NOT_VERIFIED', 'NOT_FOUND'] as const;
export const CAPTURE_KINDS = ['STORED_CAPTURE', 'OPERATOR_ATTACHMENT', 'OPERATOR_STATEMENT', 'AGGREGATOR', 'PREVIOUS_AUDIT_PDF'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export const SITE_SCOPE_KINDS = ['NONE', 'ROOT_ONLY', 'PARTIAL', 'FIRST_LEVEL_COMPLETE', 'SITEMAP_COMPLETE', 'DOCUMENTED_FULL_REVIEW'] as const;
export const AUTHORITY_CLASSES = ['OFFICIAL_SITE', 'SOCIAL', 'OFFICIAL_REGISTRY', 'INDEPENDENT_THIRD_PARTY'] as const;
export const SITE_ATTESTABLE: readonly SubcriterionId[] = ['S5', 'V5', 'X4'];
export const OBSERVATION_CONFIRMABLE: readonly SubcriterionId[] = ['S5', 'X4'];

const idStr = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'id inválido');
const hex64 = z.string().regex(/^[a-f0-9]{64}$/, 'SHA-256 deve ter 64 hexadecimais minúsculos');
const isoDay = z.string().refine((value) => parseDay(value) !== null, 'data inválida (use YYYY-MM-DD)');
const isoWhen = z.string().refine((value) => parseDayFromIso(value) !== null, 'data/hora inválida (use YYYY-MM-DD ou ISO com offset)');
const count = z.number().int().min(0).max(1_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);
const ratingStr = z
  .string()
  .regex(/^[0-5](?:\.\d{1,2})?$/, 'nota deve ser texto decimal de 0 a 5 (ex.: "4.8")')
  .refine((value) => ratingToCents(value) <= 500, 'nota acima de 5');
const email = z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'e-mail inválido');
const justification = z.string().trim().min(20, 'a justificativa exige pelo menos 20 caracteres').max(2000);

/** "4.8" -> 480 (centésimos inteiros; sem ponto flutuante). */
export function ratingToCents(value: string): number {
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export const scoredDateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('EXACT'), date: isoDay }).strict(),
  z.object({ kind: z.literal('RELATIVE'), amount: z.number().int().min(0).max(1200), unit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']) }).strict(),
]);
export type ScoredDate = z.infer<typeof scoredDateSchema>;

export const evidenceSchema = z
  .object({
    id: idStr,
    origin: z.enum(SCORING_ORIGINS),
    capture: z.enum(CAPTURE_KINDS),
    status: z.enum(SCORING_EVIDENCE_STATUSES),
    observedAt: isoWhen,
    contentSha256: hex64.optional(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.capture === 'AGGREGATOR' && evidence.origin !== 'THIRD_PARTY') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origin'], message: 'AGGREGATOR só pode ter origem THIRD_PARTY (um agregador não é o perfil do Google)' });
    }
    if ((evidence.capture === 'STORED_CAPTURE' || evidence.capture === 'OPERATOR_ATTACHMENT') && evidence.contentSha256 === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentSha256'], message: `${evidence.capture} exige contentSha256 (captura armazenada ou anexo com hash)` });
    }
  });
export type ScoringEvidence = z.infer<typeof evidenceSchema>;

/** Uma observação de um campo: evidência(s) + se a leitura do campo/lista foi COMPLETA + o valor. */
const observed = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ evidenceIds: z.array(idStr).min(1).max(20), complete: z.boolean(), value }).strict();
const observedList = <T extends z.ZodTypeAny>(value: T) => z.array(observed(value)).max(10);

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const hoursValueSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('STRUCTURED'),
      alwaysOpen: z.boolean().optional(),
      days: z
        .array(z.object({ day: z.number().int().min(0).max(6), closed: z.boolean(), intervals: z.array(z.tuple([hhmm, hhmm])).max(6) }).strict())
        .max(7),
    })
    .strict(),
  z.object({ kind: z.literal('TEXT'), raw: text(500) }).strict(),
]);
export type HoursValue = z.infer<typeof hoursValueSchema>;

const addressValue = z
  .object({
    raw: text(500),
    parsed: z
      .object({
        street: z.string().max(200).optional(),
        number: z.string().max(40).optional(),
        city: z.string().max(120).optional(),
        state: z.string().max(40).optional(),
        cep: z.string().max(12).optional(),
        serviceArea: z.boolean().optional(),
        /** `true` somente quando o perfil declara que NÃO há endereço nem área (zero comprovado). */
        none: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ACTION_KINDS = ['PHONE', 'WHATSAPP', 'MESSAGES', 'BOOKING_OR_ORDER'] as const;
const profileSchema = z
  .object({
    name: observedList(z.string().max(300).nullable()).optional(),
    address: observedList(addressValue).optional(),
    phone: observedList(z.string().max(60).nullable()).optional(),
    hours: observedList(hoursValueSchema).optional(),
    website: observedList(z.string().max(2048).nullable()).optional(),
    primaryCategory: observedList(z.string().max(200).nullable()).optional(),
    additionalCategories: observedList(z.array(z.string().max(200)).max(50)).optional(),
    description: observedList(z.object({ lengthChars: count }).strict()).optional(),
    services: observedList(count).optional(),
    attributes: observedList(count).optional(),
    products: observedList(count).optional(),
    logoCover: observedList(z.object({ logo: z.boolean(), cover: z.boolean() }).strict()).optional(),
    photos: observedList(count).optional(),
    videos: observedList(count).optional(),
    latestMedia: observedList(scoredDateSchema.nullable()).optional(),
    reviews: observedList(z.object({ ratingShown: ratingStr.nullable(), reviewCount: count }).strict()).optional(),
    latestReviewDate: observedList(scoredDateSchema.nullable()).optional(),
    replies: observedList(
      z
        .object({
          ownerReplyFieldExposed: z.boolean(),
          reviewsRead: count,
          allReviewsRead: z.boolean(),
          repliedCount: count,
          pairs: z.array(z.object({ reviewDate: isoDay, replyDate: isoDay }).strict()).max(500),
        })
        .strict(),
    ).optional(),
    posts: observedList(
      z
        .object({
          exposed: z.boolean(),
          items: z.array(z.object({ date: scoredDateSchema.nullable(), expiresOn: isoDay.optional() }).strict()).max(200),
        })
        .strict(),
    ).optional(),
    actions: observedList(z.object({ kinds: z.array(z.enum(ACTION_KINDS)).max(4) }).strict()).optional(),
  })
  .strict();
export type ProfileInput = z.infer<typeof profileSchema>;
export type ProfileKey = keyof ProfileInput;

const pageRead = z
  .object({
    url: z.string().min(8).max(2048).regex(/^https?:\/\//i, 'a página lida precisa de URL http(s)'),
    status: z.number().int().min(100).max(599),
    sha256: hex64,
    fetchedAt: isoWhen,
  })
  .strict();
const siteScopeSchema = z
  .object({
    kind: z.enum(SITE_SCOPE_KINDS),
    pagesRead: z.array(pageRead).max(200),
    requestCap: z.number().int().min(1).max(1000),
    capReached: z.boolean(),
    blockers: z.array(z.string().trim().min(1).max(100)).max(20),
    sitemap: z.object({ urlsListed: count, urlsRead: count }).strict().optional(),
    limitations: z.array(text(300)).max(20),
  })
  .strict();
const determinationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('VALIDATED_DETECTOR'), detectorId: idStr, detectorVersion: text(40) }).strict(),
  z.object({ method: z.literal('OPERATOR_CONFIRMED'), operatorRecordId: idStr }).strict(),
]);
export const JOURNEY_ELEMENTS = ['CTA', 'CATALOG_OR_SERVICE', 'CONTACT_OR_PURCHASE'] as const;
const siteSchema = z
  .object({
    scope: siteScopeSchema,
    accessibility: z
      .object({
        evidenceIds: z.array(idStr).min(1).max(20),
        outcome: z.enum(['OK', 'HTTP_ERROR', 'BLOCKED', 'TIMEOUT', 'NOT_READ']),
        status: z.number().int().min(100).max(599).optional(),
        persistent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    offers: z
      .object({ evidenceIds: z.array(idStr).min(1).max(20), distinctNamedOffers: count, determination: determinationSchema })
      .strict()
      .optional(),
    journey: z
      .object({ evidenceIds: z.array(idStr).min(1).max(20), elements: z.array(z.enum(JOURNEY_ELEMENTS)).max(3), determination: determinationSchema })
      .strict()
      .optional(),
  })
  .strict();
export type SiteInput = z.infer<typeof siteSchema>;

const napSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            sourceId: idStr,
            kind: z.enum(['SITE', 'SOCIAL', 'DIRECTORY']),
            evidenceIds: z.array(idStr).min(1).max(20),
            name: z.string().max(300).optional(),
            address: z.string().max(500).optional(),
            phone: z.string().max(60).optional(),
            hours: hoursValueSchema.optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type NapInput = z.infer<typeof napSchema>;

const competitorSchema = z
  .object({
    id: idStr,
    name: text(200),
    region: text(200),
    equivalenceCriterion: text(300),
    verifiableElements: z.number().int().min(0).max(20),
    evidenceIds: z.array(idStr).min(1).max(20),
    rating: ratingStr.nullable(),
    reviewCount: count,
  })
  .strict();
export type CompetitorInput = z.infer<typeof competitorSchema>;

const authoritySchema = z
  .object({
    findings: z.array(z.object({ class: z.enum(AUTHORITY_CLASSES), corroborated: z.boolean(), evidenceIds: z.array(idStr).min(1).max(20) }).strict()).max(20),
    protocol: z
      .object({
        searched: z
          .array(z.object({ class: z.enum(AUTHORITY_CLASSES), method: text(200), query: text(300), searchedAt: isoDay, evidenceIds: z.array(idStr).min(1).max(20) }).strict())
          .max(20),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AuthorityInput = z.infer<typeof authoritySchema>;

const recordBase = { id: idStr, operatorEmail: email, recordedAt: isoWhen, justification, attachmentSha256: hex64.optional() };
const subId = z.enum(SUBCRITERION_IDS);
export const JUDGEMENT_VALUES = {
  C2: ['COMPATIBLE', 'PARTIAL', 'INCOMPATIBLE'],
  C3: ['ALL_RELEVANT', 'MOSTLY_RELEVANT', 'MOSTLY_IRRELEVANT', 'MISSING_NEEDED'],
  P3: ['SPECIFIC', 'GENERIC_OR_MIXED', 'INAPPROPRIATE'],
} as const;
export const IMAGE_TYPES = ['PLACE', 'PRODUCT_OR_SERVICE', 'TEAM_OR_PROCESS'] as const;

/** Contrato da confirmação humana (aprovado). O armazenamento definitivo só existe na Onda 6B. */
export const operatorRecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...recordBase, kind: z.literal('JUDGEMENT'), subcriterionId: z.enum(['C2', 'C3', 'P3']), value: z.string().max(40), sampleSize: count.optional() }).strict(),
  z
    .object({ ...recordBase, kind: z.literal('NOT_APPLICABLE'), subcriterionIds: z.array(subId).min(1).max(8), code: z.enum(NA_CODES), causeEvidenceIds: z.array(idStr).max(20).default([]) })
    .strict(),
  z.object({ ...recordBase, kind: z.literal('SITE_SCOPE_ATTESTATION'), subcriterionIds: z.array(subId).min(1).max(3), scopeDescription: z.string().trim().min(20).max(1000) }).strict(),
  z.object({ ...recordBase, kind: z.literal('IMAGES_CONFIRMATION'), imageTypes: z.array(z.enum(IMAGE_TYPES)).max(3), evidenceIds: z.array(idStr).max(20) }).strict(),
  z.object({ ...recordBase, kind: z.literal('OBSERVATION_CONFIRMATION'), subcriterionIds: z.array(subId).min(1).max(2) }).strict(),
  z.object({ ...recordBase, kind: z.literal('NAME_EQUIVALENCE'), nameA: text(300), nameB: text(300) }).strict(),
]);
export type OperatorRecord = z.infer<typeof operatorRecordSchema>;

export const scoringInputSchema = z
  .object({
    schemaVersion: z.literal(SCORING_INPUT_SCHEMA_VERSION),
    auditId: z.string().regex(/^[a-z0-9][a-z0-9-]{5,63}$/, 'auditId inválido'),
    referenceDate: isoDay,
    evidences: z.array(evidenceSchema).max(500),
    profile: profileSchema.optional(),
    site: siteSchema.optional(),
    nap: napSchema.optional(),
    competitors: z.array(competitorSchema).max(50).optional(),
    authority: authoritySchema.optional(),
    operatorRecords: z.array(operatorRecordSchema).max(200).optional(),
  })
  .strict();
export type ScoringInput = z.infer<typeof scoringInputSchema>;

/* ---------------------------------------------------------------- recusa de pontos fornecidos pelo cliente */

const FORBIDDEN_KEYS = new Set([
  'points', 'point', 'pontos', 'score', 'scores', 'obtained', 'obtainedpoints', 'obtainedhalfpoints', 'evaluated', 'evaluatedpoints',
  'evaluatedhalfpoints', 'halfpoints', 'index', 'indice', 'coverage', 'coveragepercent', 'cobertura', 'classification', 'classificacao',
  'confidence', 'confianca', 'publication', 'status', 'result', 'resultsha256', 'tier',
]);

export const MAX_SCAN_NODES = 200_000;
export const MAX_SCAN_FINDINGS = 20;

/**
 * Procura, em qualquer profundidade, chaves que representem pontuação/resultado vindos do cliente. Iterativa (sem
 * recursão nem spread), com limite de nós visitados e de achados: entrada gigante é recusada, nunca derruba o motor.
 * Retorna `null` quando a entrada excede o limite de nós.
 */
export function findClientProvidedScoreKeys(raw: unknown): string[] | null {
  const found: string[] = [];
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value: raw, path: '', depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;
    if (visited > MAX_SCAN_NODES) return null;
    const { value, path, depth } = current;
    if (depth > 12 || value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) stack.push({ value: value[index], path: `${path}[${index}]`, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(value)) {
      const here = path === '' ? key : `${path}.${key}`;
      // `status` é campo legítimo apenas dentro de evidências, páginas lidas e acessibilidade do site.
      const legitStatus = key === 'status' && /(?:^|\.)(?:evidences\[\d+\]|pagesRead\[\d+\]|accessibility)\.$/.test(`${path}.`);
      if (FORBIDDEN_KEYS.has(key.toLowerCase()) && !legitStatus && found.length < MAX_SCAN_FINDINGS) found.push(here);
      stack.push({ value: (value as Record<string, unknown>)[key], path: here, depth: depth + 1 });
    }
  }
  return found;
}

/* ---------------------------------------------------------------- validação semântica cruzada */

function allEvidenceRefs(input: ScoringInput): string[] {
  const refs: string[] = [];
  const profile = input.profile;
  if (profile) {
    for (const list of Object.values(profile)) {
      if (Array.isArray(list)) for (const item of list) refs.push(...(item as { evidenceIds: string[] }).evidenceIds);
    }
  }
  const site = input.site;
  if (site) {
    refs.push(...(site.accessibility?.evidenceIds ?? []), ...(site.offers?.evidenceIds ?? []), ...(site.journey?.evidenceIds ?? []));
  }
  for (const source of input.nap?.sources ?? []) refs.push(...source.evidenceIds);
  for (const competitor of input.competitors ?? []) refs.push(...competitor.evidenceIds);
  for (const finding of input.authority?.findings ?? []) refs.push(...finding.evidenceIds);
  for (const search of input.authority?.protocol?.searched ?? []) refs.push(...search.evidenceIds);
  for (const record of input.operatorRecords ?? []) {
    if (record.kind === 'NOT_APPLICABLE') refs.push(...record.causeEvidenceIds);
    if (record.kind === 'IMAGES_CONFIRMATION') refs.push(...record.evidenceIds);
  }
  return refs;
}

export function crossValidateInput(input: ScoringInput): string[] {
  const issues: string[] = [];
  const refDay = parseDay(input.referenceDate);
  if (refDay === null) return ['referenceDate inválida'];

  const evidenceIds = new Set<string>();
  for (const evidence of input.evidences) {
    if (evidenceIds.has(evidence.id)) issues.push(`evidência duplicada: ${evidence.id}`);
    evidenceIds.add(evidence.id);
    const day = parseDayFromIso(evidence.observedAt);
    if (day !== null && day > refDay) issues.push(`evidência ${evidence.id} é posterior à data de referência do snapshot (${input.referenceDate})`);
  }
  for (const ref of new Set(allEvidenceRefs(input))) {
    if (!evidenceIds.has(ref)) issues.push(`evidência citada e inexistente: ${ref}`);
  }

  const profile = input.profile;
  for (const item of profile?.hours ?? []) {
    if (item.value.kind !== 'STRUCTURED') continue;
    const seen = new Set<number>();
    for (const day of item.value.days) {
      if (seen.has(day.day)) issues.push(`horários: dia ${day.day} repetido`);
      seen.add(day.day);
      if (day.closed && day.intervals.length > 0) issues.push(`horários: dia ${day.day} fechado não pode ter intervalos`);
      if (!day.closed && day.intervals.length === 0) issues.push(`horários: dia ${day.day} aberto exige intervalos`);
    }
  }
  for (const item of profile?.reviews ?? []) {
    if (item.value.reviewCount === 0 && item.value.ratingShown !== null) issues.push('reviews: nota informada com 0 avaliações');
  }
  const exactDateAfterRef = (value: ScoredDateLike | null | undefined): boolean => {
    if (!value || value.kind !== 'EXACT') return false;
    const day = parseDay(value.date);
    return day !== null && day > refDay;
  };
  for (const item of profile?.latestReviewDate ?? []) if (exactDateAfterRef(item.value)) issues.push('latestReviewDate posterior à data de referência');
  for (const item of profile?.latestMedia ?? []) if (exactDateAfterRef(item.value)) issues.push('latestMedia posterior à data de referência');
  for (const item of profile?.posts ?? []) {
    for (const post of item.value.items) if (exactDateAfterRef(post.date)) issues.push('publicação com data posterior à data de referência');
  }
  for (const item of profile?.replies ?? []) {
    const value = item.value;
    if (value.repliedCount > value.reviewsRead) issues.push('replies: respondidas maiores que as avaliações lidas');
    if (value.pairs.length > value.repliedCount) issues.push('replies: pares de datas maiores que as respostas');
    for (const pair of value.pairs) {
      const a = parseDay(pair.reviewDate);
      const b = parseDay(pair.replyDate);
      if (a === null || b === null || b < a || b > refDay) issues.push('replies: par de datas inconsistente (resposta antes da avaliação ou depois da referência)');
    }
    if (!value.ownerReplyFieldExposed && (value.repliedCount > 0 || value.pairs.length > 0)) issues.push('replies: campo de resposta não exposto, mas há respostas informadas');
  }
  // a quantidade de avaliações lidas não pode exceder o total quando o total é conhecido e exato
  const exactReviews = (profile?.reviews ?? []).filter((item) => item.complete);
  if (exactReviews.length === 1) {
    const total = exactReviews[0]?.value.reviewCount ?? 0;
    for (const item of profile?.replies ?? []) {
      if (item.value.reviewsRead > total) issues.push('replies: avaliações lidas maiores que o total de avaliações');
      if (item.value.allReviewsRead && item.value.reviewsRead !== total) issues.push('replies: "todas as avaliações lidas" não confere com o total');
    }
  }
  for (const item of profile?.actions ?? []) {
    if (new Set(item.value.kinds).size !== item.value.kinds.length) issues.push('actions: tipos de canal repetidos');
  }

  // site
  const site = input.site;
  if (site) {
    const scope = site.scope;
    const pages = scope.pagesRead.length;
    if (scope.kind === 'NONE' && pages !== 0) issues.push('site.scope NONE não pode ter páginas lidas');
    if (scope.kind === 'ROOT_ONLY' && pages !== 1) issues.push('site.scope ROOT_ONLY exige exatamente 1 página lida');
    if (scope.kind === 'PARTIAL' && pages < 2) issues.push('site.scope PARTIAL exige pelo menos 2 páginas lidas');
    if (scope.kind === 'FIRST_LEVEL_COMPLETE' && (pages < 1 || scope.capReached || scope.blockers.length > 0)) {
      issues.push('site.scope FIRST_LEVEL_COMPLETE exige páginas lidas, limite não atingido e nenhum bloqueio');
    }
    if (scope.kind === 'SITEMAP_COMPLETE') {
      const sitemap = scope.sitemap;
      if (!sitemap || sitemap.urlsListed < 1 || sitemap.urlsRead !== sitemap.urlsListed || scope.capReached || scope.blockers.length > 0 || pages < 1) {
        issues.push('site.scope SITEMAP_COMPLETE exige sitemap lido, todas as URLs listadas lidas, limite não atingido e nenhum bloqueio');
      } else if (sitemap.urlsRead > scope.requestCap) {
        issues.push('site.scope SITEMAP_COMPLETE: URLs lidas excedem o limite de requisições do coletor (escopo incoerente)');
      }
    }
    if (scope.kind === 'DOCUMENTED_FULL_REVIEW' && scope.limitations.length === 0) {
      issues.push('site.scope DOCUMENTED_FULL_REVIEW exige limitações documentadas (o escopo e o que ficou de fora)');
    }
    const access = site.accessibility;
    if (access) {
      if (access.outcome === 'OK' && !(access.status !== undefined && access.status >= 200 && access.status <= 399)) issues.push('site.accessibility OK exige status 200–399');
      if (access.outcome === 'HTTP_ERROR' && !(access.status !== undefined && access.status >= 400)) issues.push('site.accessibility HTTP_ERROR exige status 400–599');
      if ((access.outcome === 'OK' || access.outcome === 'HTTP_ERROR') && pages < 1) issues.push('site.accessibility lida exige ao menos uma página lida no escopo');
    }
    if (scope.kind === 'NONE') {
      if ((site.offers?.distinctNamedOffers ?? 0) > 0) issues.push('site.offers com ofertas observadas, mas o escopo é NONE');
      if ((site.journey?.elements.length ?? 0) > 0) issues.push('site.journey com elementos observados, mas o escopo é NONE');
    }
    if (site.journey && new Set(site.journey.elements).size !== site.journey.elements.length) issues.push('site.journey: elementos repetidos');
  }

  // concorrentes e autoridade
  const competitorIds = new Set<string>();
  for (const competitor of input.competitors ?? []) {
    if (competitorIds.has(competitor.id)) issues.push(`concorrente duplicado: ${competitor.id}`);
    competitorIds.add(competitor.id);
    if (competitor.reviewCount === 0 && competitor.rating !== null) issues.push(`concorrente ${competitor.id}: nota informada com 0 avaliações`);
  }
  const protocolClasses = (input.authority?.protocol?.searched ?? []).map((entry) => entry.class);
  if (new Set(protocolClasses).size !== protocolClasses.length) issues.push('authority.protocol: classe repetida');
  const sourceIds = new Set<string>();
  for (const source of input.nap?.sources ?? []) {
    if (sourceIds.has(source.sourceId)) issues.push(`nap: fonte duplicada ${source.sourceId}`);
    sourceIds.add(source.sourceId);
    if (source.name === undefined && source.address === undefined && source.phone === undefined && source.hours === undefined) {
      issues.push(`nap: a fonte ${source.sourceId} não traz nenhum campo`);
    }
  }

  // registros do operador
  const recordIds = new Set<string>();
  const seenJudgement = new Set<string>();
  const seenNa = new Set<string>();
  const seenAttestation = new Set<string>();
  const seenObservation = new Set<string>();
  let imagesRecords = 0;
  for (const record of input.operatorRecords ?? []) {
    if (recordIds.has(record.id)) issues.push(`registro do operador duplicado: ${record.id}`);
    recordIds.add(record.id);
    switch (record.kind) {
      case 'JUDGEMENT': {
        const allowed: readonly string[] = JUDGEMENT_VALUES[record.subcriterionId];
        if (!allowed.includes(record.value)) issues.push(`juízo ${record.id}: valor "${record.value}" inválido para ${record.subcriterionId}`);
        if (seenJudgement.has(record.subcriterionId)) issues.push(`mais de um juízo para ${record.subcriterionId}`);
        seenJudgement.add(record.subcriterionId);
        if (record.subcriterionId === 'P3' && (record.sampleSize === undefined || record.sampleSize < 1)) issues.push(`juízo ${record.id}: P3 exige sampleSize (respostas revisadas)`);
        break;
      }
      case 'NOT_APPLICABLE': {
        const rule = NA_RULES[record.code];
        if (rule.derived) issues.push(`registro ${record.id}: ${record.code} é derivado pelos fatos e não é aceito como entrada`);
        for (const id of record.subcriterionIds) {
          if (!rule.subcriteria.includes(id)) issues.push(`registro ${record.id}: ${record.code} não se aplica a ${id}`);
          if (seenNa.has(id)) issues.push(`mais de um N/A para ${id}`);
          seenNa.add(id);
        }
        if (record.code === 'FEATURE_UNAVAILABLE' && record.causeEvidenceIds.length === 0) {
          issues.push(`registro ${record.id}: FEATURE_UNAVAILABLE exige evidência da causa (causeEvidenceIds aterradas em evidência armazenada)`);
        }
        break;
      }
      case 'SITE_SCOPE_ATTESTATION': {
        for (const id of record.subcriterionIds) {
          if (!SITE_ATTESTABLE.includes(id)) issues.push(`atestado ${record.id}: ${id} não depende do escopo do site`);
          if (seenAttestation.has(id)) issues.push(`mais de um atestado de escopo para ${id}`);
          seenAttestation.add(id);
        }
        const kind = site?.scope.kind;
        if (kind !== 'SITEMAP_COMPLETE' && kind !== 'DOCUMENTED_FULL_REVIEW') {
          issues.push(`atestado ${record.id}: só vale para escopo SITEMAP_COMPLETE ou DOCUMENTED_FULL_REVIEW`);
        }
        break;
      }
      case 'OBSERVATION_CONFIRMATION':
        for (const id of record.subcriterionIds) {
          if (!OBSERVATION_CONFIRMABLE.includes(id)) issues.push(`confirmação ${record.id}: ${id} não aceita confirmação de observação`);
          if (seenObservation.has(id)) issues.push(`mais de uma confirmação de observação para ${id}`);
          seenObservation.add(id);
        }
        break;
      case 'IMAGES_CONFIRMATION':
        imagesRecords += 1;
        if (new Set(record.imageTypes).size !== record.imageTypes.length) issues.push(`confirmação ${record.id}: tipos de imagem repetidos`);
        if (record.evidenceIds.length === 0) issues.push(`confirmação ${record.id}: a confirmação de imagens exige a evidência (páginas/imagens revisadas) de origem, inclusive para zero tipos`);
        break;
      case 'NAME_EQUIVALENCE':
        break;
    }
  }
  if (imagesRecords > 1) issues.push('mais de uma confirmação de imagens (V5)');
  if (site?.scope.kind === 'DOCUMENTED_FULL_REVIEW' && seenAttestation.size === 0) {
    issues.push('site.scope DOCUMENTED_FULL_REVIEW exige ao menos um atestado do operador');
  }
  const confirmations = (id: SubcriterionId): boolean => seenObservation.has(id);
  for (const [label, determination, sid] of [
    ['offers', site?.offers?.determination, 'S5'],
    ['journey', site?.journey?.determination, 'X4'],
  ] as const) {
    if (determination?.method === 'OPERATOR_CONFIRMED') {
      const referenced = (input.operatorRecords ?? []).find((record) => record.id === determination.operatorRecordId);
      if (!referenced || referenced.kind !== 'OBSERVATION_CONFIRMATION' || !referenced.subcriterionIds.includes(sid) || !confirmations(sid)) {
        issues.push(`site.${label}: operatorRecordId não aponta para uma confirmação de observação de ${sid}`);
      }
    }
  }
  return issues;
}

type ScoredDateLike = { readonly kind: 'EXACT'; readonly date: string } | { readonly kind: 'RELATIVE'; readonly amount: number; readonly unit: string };

/* ---------------------------------------------------------------- normalização (independe da ordem dos arrays) */

const byKey = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

export function normalizeInput(input: ScoringInput): ScoringInput {
  const profile = input.profile;
  const normalizedProfile = profile
    ? (Object.fromEntries(
        Object.entries(profile).map(([key, list]) => [key, Array.isArray(list) ? byKey(list as readonly unknown[], (item) => canonicalJson(item)) : list]),
      ) as ProfileInput)
    : undefined;
  const site = input.site;
  const normalizedSite = site
    ? { ...site, scope: { ...site.scope, pagesRead: byKey(site.scope.pagesRead, (page) => page.url), blockers: [...site.scope.blockers].sort(), limitations: [...site.scope.limitations].sort() } }
    : undefined;
  return {
    ...input,
    evidences: byKey(input.evidences, (item) => item.id),
    ...(normalizedProfile ? { profile: normalizedProfile } : {}),
    ...(normalizedSite ? { site: normalizedSite } : {}),
    ...(input.nap ? { nap: { sources: byKey(input.nap.sources, (item) => item.sourceId) } } : {}),
    ...(input.competitors ? { competitors: byKey(input.competitors, (item) => item.id) } : {}),
    ...(input.authority
      ? {
          authority: {
            findings: byKey(input.authority.findings, (item) => canonicalJson(item)),
            ...(input.authority.protocol ? { protocol: { searched: byKey(input.authority.protocol.searched, (item) => item.class) } } : {}),
          },
        }
      : {}),
    ...(input.operatorRecords ? { operatorRecords: byKey(input.operatorRecords, (item) => item.id) } : {}),
  };
}

export type ParsedInput = { readonly ok: true; readonly input: ScoringInput } | { readonly ok: false; readonly issues: readonly string[] };

/** Valida (schema estrito + consistência cruzada) e normaliza. Nunca lança. */
export function parseScoringInput(raw: unknown): ParsedInput {
  try {
    const forbidden = findClientProvidedScoreKeys(raw);
    if (forbidden === null) return { ok: false, issues: ['entrada grande demais para ser analisada'] };
    if (forbidden.length > 0) {
      return { ok: false, issues: forbidden.map((path) => `pontuação/resultado fornecido pelo cliente não é aceito (${path}); envie apenas fatos e evidências`) };
    }
    const parsed = scoringInputSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.slice(0, 50).map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`) };
    }
    const issues = crossValidateInput(parsed.data);
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, input: normalizeInput(parsed.data) };
  } catch (error) {
    return { ok: false, issues: [`entrada não pôde ser analisada: ${error instanceof Error ? error.name : 'erro'}`] };
  }
}
