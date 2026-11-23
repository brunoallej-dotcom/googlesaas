import { canonicalJson, sha256Hex } from '../link-audit/canonical';
import { formatDay, parseDayFromIso } from '../link-audit/scoring/dates';
import { parseScoringInput, type OperatorRecord, type ProfileInput, type ScoringInput } from '../link-audit/scoring/input';
import { RULES } from '../link-audit/scoring/ruler';
import type { SubcriterionId } from '../link-audit/scoring/types';
import { SCORING_INPUT_SCHEMA_VERSION } from '../link-audit/scoring/versions';
import type { BasisEvidence, BasisProfile, EvidenceFieldStatus, ScoringBasis } from '../link-audit-evidence/scoring-basis';
import { deriveAuditIdAlias } from './audit-id-alias';
import { classifyOperatorRecord, CRITERIA_SOURCES, decisionTargets, type MappedField } from './criteria-sources';
import {
  MAPPER_VERSION,
  REFERENCE_DATE_RULE,
  type AssembleOptions,
  type AssembleResult,
  type BlockerCode,
  type BlockerSeverity,
  type CompletenessBasis,
  type CriterionSourceView,
  type FactOmittedReason,
  type FactTrace,
  type MapperBlocker,
  type ProfileTrace,
  type TraceEvidence,
  type TraceSource,
  type Traceability,
  type WebsiteTrace,
  type X5ProofReason,
} from './types';

/*
 * Mapeador determinístico das evidências verificadas (base do I1) para o `ScoringInput` do Motor Lumos (Onda 6C, I2).
 * PURO: sem rede, disco, banco, ambiente, aleatoriedade nem relógio (o único instante, `options.now`, é injetado e nunca
 * entra na entrada). NÃO calcula nem guarda pontos, NÃO decide nada: só descreve o que foi observado, com proveniência.
 *
 * Política (spec §9, M-1…M-12):
 *  - Só o OBSERVADO sobe ao motor. Campo ausente, relatório incompleto ou evidência não verificada ⇒ o fato é OMITIDO (o motor
 *    responde Não verificado, nunca zero). Nunca `null`+`complete:true`, nunca lista vazia fabricada, nunca ausência provada.
 *  - `complete` é `false` em tudo. A única exceção é o website com a PROVA POSITIVA de UTM completo (X5): UTM observado NO
 *    BRUTO, valores não vazios, regra e proveniência conferidas contra a captura. A URL derivada (valores `x`) sozinha NÃO prova.
 *  - Endereço cru não é endereço estruturado (sem `parsed`); horários em texto não são estruturados (`TEXT`).
 *  - M-4a estrita: nota e contagem de avaliações NÃO sobem ao motor. Este módulo nunca lê a parte informativa da base.
 *  - `referenceDate` = dia (como escrito) da evidência verificada mais recente da base; nunca do cliente nem do relógio.
 *  - As decisões do operador passam SEM alteração (cópia), mas decisões fora do contrato aprovado, que citam evidência fora da
 *    base ou datadas no futuro bloqueiam a finalização.
 */

const MAX_EVIDENCES = 500;
const MAX_RECORDS = 200;
const MAX_ISSUES = 10;
const MAX_ISSUE_CHARS = 300;
const LIMITS = { name: 300, phone: 60, primaryCategory: 200, website: 2048, addressRaw: 500, hoursRaw: 500, additionalItem: 200, additionalCount: 50 } as const;
const REF = /^(?:capture:c\d{4}|report:c\d{4}-r\d{4})$/;
const HEX64 = /^[a-f0-9]{64}$/;
const RECORD_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const KNOWN_UTM: readonly string[] = ['utm_campaign', 'utm_content', 'utm_id', 'utm_medium', 'utm_source', 'utm_term'];
const URL_DERIVATION_RULE = 'lumos-url-derive-v1';
const BASIS_VERSION = 'scoring-basis-v1';
const REPORT_STATUSES: readonly string[] = ['VERIFIED', 'PARTIAL', 'NOT_VERIFIED', 'NOT_FOUND'];
const UNAVAILABLE_REASONS: readonly string[] = ['NO_USABLE_CAPTURE', 'BODY_UNREADABLE', 'IDENTITY_NOT_CONFIRMED', 'NOT_LOCATED', 'AMBIGUOUS_IDENTITY'];

const MESSAGES: Readonly<Record<BlockerCode, string>> = {
  MAPPER_INTERNAL_ERROR: 'Falha interna do mapeador: nenhuma entrada foi gerada.',
  INVALID_OPTIONS: 'As opções do mapeador são inválidas: nenhuma entrada foi gerada.',
  BASIS_INVALID: 'A base de pontuação não é coerente: nenhuma entrada foi gerada.',
  AUDIT_ID_INVALID: 'O identificador da auditoria não é válido: nenhuma entrada foi gerada.',
  EVIDENCE_DATED_IN_FUTURE: 'Há evidência datada depois do instante atual do servidor: nenhuma entrada foi gerada.',
  OPERATOR_RECORDS_INVALID: 'Os registros do operador não têm a forma esperada: nenhuma entrada foi gerada.',
  DECISION_DATED_IN_FUTURE: 'Há decisão do operador datada depois do instante atual do servidor: nenhuma entrada foi gerada.',
  DECISION_EVIDENCE_NOT_IN_BASE: 'A decisão cita evidência que não está na base verificada. Revogue ou substitua a decisão.',
  DECISION_NOT_SUPPORTED: 'A decisão está fora do contrato aprovado da Onda 6C e não pode ser finalizada. Revogue a decisão.',
  DECISION_HAS_NO_EFFECT: 'A decisão não tem efeito com os fatos enviados ao motor nesta auditoria.',
  ENGINE_CONTRACT_REJECTED: 'O contrato de entrada do motor recusou a entrada montada: nenhuma entrada foi gerada.',
  PROFILE_UNAVAILABLE: 'O perfil elegível ao motor não está disponível: nenhum fato do perfil foi enviado.',
  PROFILE_EVIDENCE_AGED: 'A captura que sustenta o perfil já é antiga em relação à data de referência.',
  PROFILE_EVIDENCE_TOO_OLD: 'A captura que sustenta o perfil é antiga demais para fundamentar pontos (os fatos do perfil ficarão Não verificados).',
  FIELD_CONTRADICTED_BY_REPORT: 'O relatório e a captura se contradizem neste campo: o fato não foi enviado ao motor.',
  FIELD_NOT_EMITTED: 'Um campo observado não pôde ser enviado ao motor com segurança.',
};

/* ---------------------------------------------------------------- utilidades */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hex = (value: unknown): string => (typeof value === 'string' && HEX64.test(value) ? value : '');
const uniqueSorted = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

function blocker(code: BlockerCode, severity: BlockerSeverity, extra: { reasonCode?: string; decisionIds?: readonly string[]; subcriterionIds?: readonly SubcriterionId[] } = {}): MapperBlocker {
  return { code, severity, message: MESSAGES[code], reasonCode: extra.reasonCode ?? null, decisionIds: uniqueSorted(extra.decisionIds ?? []), subcriterionIds: uniqueSorted(extra.subcriterionIds ?? []) };
}

const sortBlockers = (items: readonly MapperBlocker[]): MapperBlocker[] =>
  [...items].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'BLOCKING' ? -1 : 1) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || ((a.reasonCode ?? '') < (b.reasonCode ?? '') ? -1 : (a.reasonCode ?? '') > (b.reasonCode ?? '') ? 1 : 0));

const FIELD_ORDER: readonly MappedField[] = ['name', 'address', 'phone', 'hours', 'primaryCategory', 'additionalCategories', 'website'];
const REPORT_ID: Readonly<Record<MappedField, string | null>> = {
  name: 'maps-name',
  address: 'maps-address',
  phone: 'maps-phone',
  hours: 'maps-hours',
  primaryCategory: 'maps-category',
  additionalCategories: null,
  website: 'maps-website',
};
const subcriteriaOf = (field: MappedField): SubcriterionId[] => CRITERIA_SOURCES.filter((row) => row.fact === field).map((row) => row.id);

function emptyTrace(): Traceability {
  return {
    mapperVersion: MAPPER_VERSION,
    basisVersion: null,
    layout: null,
    auditId: null,
    referenceDate: null,
    referenceDateSource: null,
    evidences: [],
    profile: { state: 'NOT_EVALUATED' },
    facts: [],
    websiteDerivation: null,
    excluded: { reviews: 'EXCLUDED_M4A' },
    operatorRecords: { count: 0, ids: [] },
    inputSha256: null,
  };
}

function refuse(trace: Traceability, blockers: readonly MapperBlocker[], criteriaView: readonly CriterionSourceView[] = [], contractIssues: readonly string[] = []): AssembleResult {
  return { input: null, inputSha256: null, finalizable: false, traceability: trace, blockers: sortBlockers(blockers), criteriaView, contractIssues };
}

/* ---------------------------------------------------------------- validação estrutural da base (defesa em profundidade) */

function basisProblem(basis: unknown): string | null {
  if (!isRecord(basis)) return 'BASIS_NOT_AN_OBJECT';
  if (basis.version !== BASIS_VERSION) return 'BASIS_VERSION_UNSUPPORTED';
  if (basis.layout !== 'VERSIONED' && basis.layout !== 'LEGACY') return 'LAYOUT_INVALID';
  if (!Array.isArray(basis.evidences) || basis.evidences.length === 0 || basis.evidences.length > MAX_EVIDENCES) return 'EVIDENCES_INVALID';
  const refs = new Set<string>();
  let captures = 0;
  for (const raw of basis.evidences) {
    if (!isRecord(raw)) return 'EVIDENCE_NOT_AN_OBJECT';
    const { ref, kind, observedAt, contentSha256, bodySha256 } = raw;
    if (typeof ref !== 'string' || !REF.test(ref) || refs.has(ref)) return 'EVIDENCE_REF_INVALID';
    refs.add(ref);
    if (kind !== (ref.startsWith('capture:') ? 'CAPTURE' : 'REPORT')) return 'EVIDENCE_KIND_MISMATCH';
    if (kind === 'CAPTURE') captures += 1;
    if (typeof contentSha256 !== 'string' || !HEX64.test(contentSha256)) return 'EVIDENCE_HASH_INVALID';
    if (bodySha256 !== null && (typeof bodySha256 !== 'string' || !HEX64.test(bodySha256))) return 'EVIDENCE_BODY_HASH_INVALID';
    if (typeof observedAt !== 'string' || parseDayFromIso(observedAt) === null) return 'EVIDENCE_DATE_INVALID';
    // W5.2b: o provedor SIMULATED só vale junto da marca `simulated: true` (e a marca só com ele); a prévia bloqueia a simulada fora da homologação
    const providerOk = raw.simulated === true ? raw.provider === 'SIMULATED' : raw.simulated === undefined && raw.provider === 'serper-maps';
    if (raw.origin !== 'GOOGLE_NATIVE' || !providerOk || raw.intermediary !== true) return 'EVIDENCE_ORIGIN_UNSUPPORTED';
    if (typeof raw.legacy !== 'boolean' || typeof raw.superseded !== 'boolean') return 'EVIDENCE_FLAGS_INVALID';
  }
  if (captures === 0) return 'NO_CAPTURE';
  if (!isRecord(basis.profile) || (basis.profile.state !== 'AVAILABLE' && basis.profile.state !== 'UNAVAILABLE')) return 'PROFILE_INVALID';
  return null;
}

/* ---------------------------------------------------------------- extração dos valores (sem inferir nada) */

type Extracted =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'TOO_LONG' }
  | { readonly state: 'UNPARSABLE' }
  | { readonly state: 'NOT_MINIMAL' }
  | { readonly state: 'OK'; readonly value: string | string[] | { raw: string } | { kind: 'TEXT'; raw: string } };

function textOf(raw: unknown, max: number): { state: 'ABSENT' | 'TOO_LONG' } | { state: 'OK'; value: string } {
  if (typeof raw !== 'string') return { state: 'ABSENT' };
  const value = raw.trim();
  if (value === '') return { state: 'ABSENT' };
  return value.length > max ? { state: 'TOO_LONG' } : { state: 'OK', value };
}

function extract(profile: Extract<BasisProfile, { state: 'AVAILABLE' }>, field: MappedField): Extracted {
  switch (field) {
    case 'name':
      return textOf(profile.name, LIMITS.name);
    case 'phone':
      return textOf(profile.phone, LIMITS.phone);
    case 'primaryCategory':
      return textOf(profile.primaryCategory, LIMITS.primaryCategory);
    case 'address': {
      const text = textOf(isRecord(profile.address) ? profile.address.raw : null, LIMITS.addressRaw);
      return text.state === 'OK' ? { state: 'OK', value: { raw: text.value } } : text;
    }
    case 'hours': {
      const text = textOf(profile.hoursRaw, LIMITS.hoursRaw);
      return text.state === 'OK' ? { state: 'OK', value: { kind: 'TEXT', raw: text.value } } : text;
    }
    case 'additionalCategories': {
      const list = profile.additionalCategories;
      if (!Array.isArray(list) || list.length === 0) return { state: 'ABSENT' };
      if (list.length > LIMITS.additionalCount) return { state: 'TOO_LONG' };
      const items: string[] = [];
      for (const item of list) {
        const text = textOf(item, LIMITS.additionalItem);
        if (text.state === 'TOO_LONG') return text;
        if (text.state === 'OK') items.push(text.value);
      }
      return items.length === 0 ? { state: 'ABSENT' } : { state: 'OK', value: items };
    }
    case 'website': {
      const website = profile.website;
      if (!isRecord(website)) return { state: 'ABSENT' };
      if (website.state !== 'DERIVED' || typeof website.derived !== 'string' || website.derived.trim() === '') return { state: 'UNPARSABLE' };
      if (website.derived.length > LIMITS.website) return { state: 'TOO_LONG' };
      return minimalDerivedNames(website.derived) === null ? { state: 'NOT_MINIMAL' } : { state: 'OK', value: website.derived };
    }
  }
}

/* ---------------------------------------------------------------- prova positiva de UTM (X5) */

/**
 * A URL derivada tem EXATAMENTE a forma que a regra `lumos-url-derive-v1` produz: `esquema://host[:porta]/` mais, no máximo,
 * `?` + `utm_*` conhecidos, ordenados, cada um com o valor `x`. A conferência é por IGUALDADE com essa renderização canônica
 * (refeita aqui a partir dos nomes presentes), o que recusa de uma vez caminho, credenciais, fragmento, outro parâmetro, outro
 * valor, repetição, ordem e grafia diferentes. O mapeador não confia em que a base cumpriu o contrato: o que entra aqui é
 * gravado no registro. Devolve os nomes `utm_*` presentes, ou `null` se a forma não é a mínima.
 */
function minimalDerivedNames(derived: string): string[] | null {
  let url: URL;
  try {
    url = new URL(derived);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const names = [...new Set([...url.searchParams.keys()].filter((key) => KNOWN_UTM.includes(key)))].sort();
  const canonical = `${url.protocol}//${url.host}/${names.length > 0 ? `?${names.map((name) => `${name}=x`).join('&')}` : ''}`;
  return canonical === derived ? names : null;
}

/**
 * Prova positiva de UTM completo. NÃO é "a URL derivada tem utm_source e utm_medium" (os valores `x` foram colocados pela
 * derivação): é "o leitor observou, NO BRUTO da captura íntegra, `utm_source` e `utm_medium` com valor não vazio" (`utm.level`
 * e `names`, calculados sobre o bruto), com regra conhecida, hash do bruto e referência à evidência de origem conferidos.
 */
function utmProof(profile: Extract<BasisProfile, { state: 'AVAILABLE' }>, evidences: ReadonlyMap<string, BasisEvidence>, reportStatus: EvidenceFieldStatus | 'NOT_LISTED' | 'NOT_APPLICABLE'): X5ProofReason {
  const website = profile.website;
  if (!isRecord(website) || website.state !== 'DERIVED' || typeof website.derived !== 'string') return 'WEBSITE_NOT_EMITTED';
  const utm = website.utm;
  if (!isRecord(utm) || utm.level !== 'COMPLETE' || !Array.isArray(utm.names) || !utm.names.includes('utm_source') || !utm.names.includes('utm_medium')) return 'UTM_NOT_COMPLETE';
  const derivation = website.derivation;
  if (!isRecord(derivation) || derivation.rule !== URL_DERIVATION_RULE) return 'DERIVATION_RULE_UNKNOWN';
  const origin = isRecord(derivation.sourceEvidence) ? derivation.sourceEvidence : null;
  const capture = origin && typeof origin.ref === 'string' ? evidences.get(origin.ref) : undefined;
  if (
    typeof derivation.rawSha256 !== 'string' ||
    !HEX64.test(derivation.rawSha256) ||
    !origin ||
    !capture ||
    capture.kind !== 'CAPTURE' ||
    origin.ref !== profile.source.ref ||
    origin.observedAt !== capture.observedAt ||
    origin.contentSha256 !== capture.contentSha256 ||
    origin.bodySha256 !== capture.bodySha256
  ) {
    return 'PROVENANCE_MISMATCH';
  }
  const present = minimalDerivedNames(website.derived);
  const declared = utm.names as string[];
  if (present === null || present.length !== declared.length || !declared.every((name) => present.includes(name)) || !present.includes('utm_source') || !present.includes('utm_medium')) return 'DERIVED_URL_INCONSISTENT';
  if (reportStatus !== 'VERIFIED') return 'REPORT_NOT_VERIFIED';
  return 'PROVEN';
}

/* ---------------------------------------------------------------- a montagem */

export function assembleScoringInput(basis: ScoringBasis, operatorRecords: readonly OperatorRecord[], options: AssembleOptions): AssembleResult {
  try {
    return assemble(basis, operatorRecords, options);
  } catch {
    // falha fechada: nada de detalhe da exceção (poderia carregar dado da fonte)
    return refuse(emptyTrace(), [blocker('MAPPER_INTERNAL_ERROR', 'BLOCKING')]);
  }
}

function assemble(rawBasis: ScoringBasis, operatorRecords: readonly OperatorRecord[], options: AssembleOptions): AssembleResult {
  const trace = emptyTrace();
  // instantâneo: cada campo é lido UMA vez (um getter não pode mudar de valor entre a verificação e o uso); a parte informativa nem é tocada
  const basisInput = (isRecord(rawBasis) ? structuredClone({ version: rawBasis.version, auditId: rawBasis.auditId, layout: rawBasis.layout, evidences: rawBasis.evidences, profile: rawBasis.profile }) : rawBasis) as ScoringBasis;
  const nowDay = isRecord(options) && typeof options.now === 'string' ? parseDayFromIso(options.now) : null;
  if (nowDay === null) return refuse(trace, [blocker('INVALID_OPTIONS', 'BLOCKING')]);

  const problem = basisProblem(basisInput);
  if (problem !== null) return refuse(trace, [blocker('BASIS_INVALID', 'BLOCKING', { reasonCode: problem })]);
  const basis = basisInput;

  const alias = deriveAuditIdAlias(basis.auditId);
  if (alias === null) return refuse({ ...trace, basisVersion: basis.version, layout: basis.layout }, [blocker('AUDIT_ID_INVALID', 'BLOCKING')]);

  /* evidências: todas verificadas pelo leitor; a referenceDate nasce delas */
  const byRef = new Map<string, BasisEvidence>(basis.evidences.map((evidence) => [evidence.ref, evidence]));
  const days = basis.evidences.map((evidence) => parseDayFromIso(evidence.observedAt) as number);
  const refDay = Math.max(...days);
  const referenceDate = formatDay(refDay);
  const latest = basis.evidences.filter((_, index) => days[index] === refDay).sort((a, b) => (a.kind === b.kind ? (a.ref < b.ref ? -1 : 1) : a.kind === 'CAPTURE' ? -1 : 1))[0] as BasisEvidence;
  const traceEvidences: TraceEvidence[] = [...basis.evidences]
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((evidence) => ({ ref: evidence.ref, kind: evidence.kind, observedAt: evidence.observedAt, contentSha256: evidence.contentSha256, bodySha256: evidence.bodySha256, legacy: evidence.legacy, superseded: evidence.superseded }));
  const baseTrace: Traceability = {
    ...trace,
    basisVersion: basis.version,
    layout: basis.layout,
    auditId: alias,
    referenceDate,
    referenceDateSource: { ref: latest.ref, observedAt: latest.observedAt, rule: REFERENCE_DATE_RULE },
    evidences: traceEvidences,
  };
  if (refDay > nowDay) return refuse(baseTrace, [blocker('EVIDENCE_DATED_IN_FUTURE', 'BLOCKING')]);

  const blockers: MapperBlocker[] = [];
  const evidences: ScoringInput['evidences'] = traceEvidences.map((evidence) => ({ id: evidence.ref, origin: 'GOOGLE_NATIVE', capture: 'STORED_CAPTURE', status: 'VERIFIED', observedAt: evidence.observedAt, contentSha256: evidence.contentSha256 }));

  /* perfil: só da captura que o leitor entregou, e só o observado */
  const profileIn = basis.profile;
  const profile: ProfileInput = {};
  const facts: FactTrace[] = [];
  const emitted = new Set<MappedField>();
  const omitted = new Map<MappedField, FactOmittedReason>();
  const contradicted: MappedField[] = [];
  let profileTrace: ProfileTrace;
  let source: TraceSource | null = null;
  let websiteTrace: WebsiteTrace | null = null;
  let proofReason: X5ProofReason = 'WEBSITE_NOT_EMITTED';

  if (profileIn.state === 'AVAILABLE') {
    const src = profileIn.source;
    const sourceEvidence = isRecord(src) && typeof src.ref === 'string' ? byRef.get(src.ref) : undefined;
    const consistent =
      sourceEvidence !== undefined &&
      sourceEvidence.kind === 'CAPTURE' &&
      src.observedAt === sourceEvidence.observedAt &&
      src.contentSha256 === sourceEvidence.contentSha256 &&
      typeof src.bodySha256 === 'string' &&
      src.bodySha256 === sourceEvidence.bodySha256 &&
      isRecord(profileIn.identity) &&
      profileIn.identity.state === 'PROVEN' &&
      isRecord(profileIn.identity.matchedBy) &&
      (profileIn.identity.matchedBy.cid === true || profileIn.identity.matchedBy.placeId === true) &&
      isRecord(profileIn.reportEvidence);
    if (!consistent) return refuse(baseTrace, [blocker('BASIS_INVALID', 'BLOCKING', { reasonCode: 'PROFILE_SOURCE_INCONSISTENT' })]);
    source = { ref: src.ref, observedAt: src.observedAt, contentSha256: src.contentSha256, bodySha256: src.bodySha256 };
    const ageDays = refDay - (parseDayFromIso(src.observedAt) as number);
    profileTrace = { state: 'AVAILABLE', source, ageDays, ageStatus: ageDays > RULES.evidenceCannotGroundAfterDays ? 'TOO_OLD' : ageDays > RULES.evidenceAgedAfterDays ? 'AGED' : 'CURRENT' };

    for (const field of FIELD_ORDER) {
      const reportId = REPORT_ID[field];
      const rawStatus = reportId === null ? undefined : profileIn.reportEvidence[reportId];
      // um status que o leitor não produz é tratado como NÃO verificado (e nunca copiado para o rastro)
      const reportStatus: EvidenceFieldStatus | 'NOT_LISTED' | 'NOT_APPLICABLE' =
        reportId === null ? 'NOT_APPLICABLE' : rawStatus === undefined ? 'NOT_LISTED' : REPORT_STATUSES.includes(rawStatus) ? rawStatus : 'NOT_VERIFIED';
      const extracted = extract(profileIn, field);
      let reason: FactOmittedReason | null = null;
      let complete = false;
      let basisOfCompleteness: CompletenessBasis = 'NOT_PROVEN';

      if (extracted.state === 'ABSENT') {
        reason = 'FIELD_ABSENT';
        if (reportStatus === 'VERIFIED') contradicted.push(field); // o relatório afirma o que a captura não tem
      } else if (extracted.state === 'TOO_LONG') reason = 'VALUE_EXCEEDS_CONTRACT_LIMIT';
      else if (extracted.state === 'UNPARSABLE') reason = 'WEBSITE_UNPARSABLE';
      else if (extracted.state === 'NOT_MINIMAL') reason = 'WEBSITE_DERIVED_NOT_MINIMAL';
      else if (reportStatus === 'NOT_LISTED' && field === 'website') reason = 'REPORT_EVIDENCE_REQUIRED'; // §9.6 (4)
      else if (reportStatus !== 'VERIFIED' && reportStatus !== 'NOT_LISTED' && reportStatus !== 'NOT_APPLICABLE') {
        reason = 'REPORT_STATUS_CONTRADICTS';
        contradicted.push(field);
      }

      if (field === 'website' && profileIn.website !== null && isRecord(profileIn.website)) {
        proofReason = reason === null ? utmProof(profileIn, byRef, reportStatus) : 'WEBSITE_NOT_EMITTED';
        const derivation: Record<string, unknown> = isRecord(profileIn.website.derivation) ? profileIn.website.derivation : {};
        const origin: Record<string, unknown> = isRecord(derivation.sourceEvidence) ? derivation.sourceEvidence : {};
        const utm = isRecord(profileIn.website.utm) ? profileIn.website.utm : null;
        websiteTrace = {
          rule: derivation.rule === URL_DERIVATION_RULE ? URL_DERIVATION_RULE : '',
          rawSha256: hex(derivation.rawSha256),
          sourceEvidence: { ref: typeof origin.ref === 'string' && REF.test(origin.ref) ? origin.ref : '', contentSha256: hex(origin.contentSha256), bodySha256: hex(origin.bodySha256) },
          utmLevel: utm !== null && (utm.level === 'COMPLETE' || utm.level === 'PARTIAL' || utm.level === 'NOT_OBSERVED') ? utm.level : null,
          x5Proof: proofReason,
        };
        if (proofReason === 'PROVEN') {
          complete = true;
          basisOfCompleteness = 'POSITIVE_UTM_PROOF';
        }
      }

      if (reason === null && extracted.state === 'OK') {
        emitted.add(field);
        const observation = { evidenceIds: [src.ref], complete, value: extracted.value };
        (profile as Record<string, unknown>)[field] = [observation];
      } else if (reason !== null) omitted.set(field, reason);
      facts.push({
        field,
        subcriteria: subcriteriaOf(field),
        emitted: reason === null && extracted.state === 'OK',
        complete,
        completenessBasis: basisOfCompleteness,
        evidenceRefs: reason === null && extracted.state === 'OK' ? [src.ref] : [],
        reportStatus,
        omittedReason: reason,
      });
    }
    if (profileTrace.ageStatus !== 'CURRENT') {
      const affected = [...emitted].flatMap(subcriteriaOf);
      blockers.push(blocker(profileTrace.ageStatus === 'TOO_OLD' ? 'PROFILE_EVIDENCE_TOO_OLD' : 'PROFILE_EVIDENCE_AGED', 'WARNING', { subcriterionIds: affected }));
    }
  } else {
    const reason = typeof profileIn.reason === 'string' && UNAVAILABLE_REASONS.includes(profileIn.reason) ? profileIn.reason : 'UNKNOWN';
    profileTrace = { state: 'UNAVAILABLE', reason };
    blockers.push(blocker('PROFILE_UNAVAILABLE', 'WARNING', { reasonCode: reason }));
    for (const field of FIELD_ORDER) {
      omitted.set(field, 'PROFILE_UNAVAILABLE');
      facts.push({ field, subcriteria: subcriteriaOf(field), emitted: false, complete: false, completenessBasis: 'NOT_PROVEN', evidenceRefs: [], reportStatus: 'NOT_LISTED', omittedReason: 'PROFILE_UNAVAILABLE' });
    }
  }
  if (contradicted.length > 0) blockers.push(blocker('FIELD_CONTRADICTED_BY_REPORT', 'WARNING', { subcriterionIds: contradicted.flatMap(subcriteriaOf) }));
  const notEmitted = [...omitted].filter(([, why]) => why === 'VALUE_EXCEEDS_CONTRACT_LIMIT' || why === 'WEBSITE_UNPARSABLE' || why === 'WEBSITE_DERIVED_NOT_MINIMAL' || why === 'REPORT_EVIDENCE_REQUIRED');
  for (const reason of uniqueSorted(notEmitted.map(([, why]) => why))) {
    const fields = notEmitted.filter(([, why]) => why === reason).map(([field]) => field);
    blockers.push(blocker('FIELD_NOT_EMITTED', 'WARNING', { reasonCode: reason, subcriterionIds: fields.flatMap(subcriteriaOf) }));
  }

  /* decisões do operador: sem alteração; só se verifica o que é do mapeador (forma, data, evidência na base, contrato aprovado) */
  if (!Array.isArray(operatorRecords) || operatorRecords.length > MAX_RECORDS) return refuse({ ...baseTrace, profile: profileTrace, facts }, [...blockers, blocker('OPERATOR_RECORDS_INVALID', 'BLOCKING')]);
  try {
    canonicalJson(operatorRecords); // recusa o que não é JSON puro (função, ciclo, número não finito, instância de classe…)
  } catch {
    return refuse({ ...baseTrace, profile: profileTrace, facts }, [...blockers, blocker('OPERATOR_RECORDS_INVALID', 'BLOCKING')]);
  }
  const records = operatorRecords as readonly OperatorRecord[]; // sem alteração (M-9); a entrada devolvida é a saída NOVA do contrato
  if (records.some((record) => !isRecord(record) || typeof record.id !== 'string' || !RECORD_ID.test(record.id) || typeof record.kind !== 'string')) {
    return refuse({ ...baseTrace, profile: profileTrace, facts }, [...blockers, blocker('OPERATOR_RECORDS_INVALID', 'BLOCKING')]);
  }
  const recordIds = records.map((record) => record.id);
  const richTrace: Traceability = { ...baseTrace, profile: profileTrace, facts, websiteDerivation: websiteTrace, operatorRecords: { count: records.length, ids: uniqueSorted(recordIds) } };

  const future = records.filter((record) => typeof record.recordedAt === 'string' && (parseDayFromIso(record.recordedAt) ?? -Infinity) > nowDay);
  if (future.length > 0) return refuse(richTrace, [...blockers, blocker('DECISION_DATED_IN_FUTURE', 'BLOCKING', { decisionIds: future.map((record) => record.id), subcriterionIds: future.flatMap(decisionTargets) })]);

  const notInBase: OperatorRecord[] = [];
  const unsupported: OperatorRecord[] = [];
  const noEffect: OperatorRecord[] = [];
  for (const record of records) {
    const cited = record.kind === 'NOT_APPLICABLE' ? record.causeEvidenceIds : record.kind === 'IMAGES_CONFIRMATION' ? record.evidenceIds : [];
    if (Array.isArray(cited) && cited.some((ref) => typeof ref !== 'string' || !byRef.has(ref))) notInBase.push(record);
    const support = classifyOperatorRecord(record);
    if (support === 'NOT_SUPPORTED') unsupported.push(record);
    else if (support === 'SUPPORTED_NO_EFFECT_TODAY' || (record.kind === 'JUDGEMENT' && (!emitted.has('primaryCategory') || profileTrace.state !== 'AVAILABLE' || profileTrace.ageStatus === 'TOO_OLD'))) noEffect.push(record);
  }
  const of = (code: BlockerCode, severity: BlockerSeverity, list: readonly OperatorRecord[], reasonCode?: string): void => {
    if (list.length > 0) blockers.push(blocker(code, severity, { decisionIds: list.map((record) => record.id), subcriterionIds: list.flatMap(decisionTargets), ...(reasonCode ? { reasonCode } : {}) }));
  };
  of('DECISION_EVIDENCE_NOT_IN_BASE', 'BLOCKING', notInBase);
  of('DECISION_NOT_SUPPORTED', 'BLOCKING', unsupported);
  of('DECISION_HAS_NO_EFFECT', 'WARNING', noEffect);

  /* monta e valida pelo CONTRATO do motor (nunca pelo motor que calcula) */
  const raw = {
    schemaVersion: SCORING_INPUT_SCHEMA_VERSION,
    auditId: alias.scoringAuditId,
    referenceDate,
    evidences,
    ...(Object.keys(profile).length > 0 ? { profile } : {}),
    ...(records.length > 0 ? { operatorRecords: [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) } : {}),
  };
  const decisionsByTarget = new Map<SubcriterionId, string[]>();
  for (const record of records) for (const target of decisionTargets(record)) decisionsByTarget.set(target, [...(decisionsByTarget.get(target) ?? []), record.id]);
  const tooOld = profileTrace.state === 'AVAILABLE' && profileTrace.ageStatus === 'TOO_OLD';
  const criteriaView = buildCriteriaView(CRITERIA_SOURCES, { emitted, omitted, source, proofReason, decisionsByTarget, records, tooOld });

  const parsed = parseScoringInput(raw);
  if (!parsed.ok) {
    const issues = [...parsed.issues].map((issue) => String(issue).slice(0, MAX_ISSUE_CHARS)).sort().slice(0, MAX_ISSUES);
    // atribuição por token exato (op-1 não é op-10)
    const blamed = records.filter((record) => parsed.issues.some((issue) => new RegExp(`(?<![A-Za-z0-9_-])${record.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(issue)));
    blockers.push(blocker('ENGINE_CONTRACT_REJECTED', 'BLOCKING', { decisionIds: blamed.map((record) => record.id), subcriterionIds: blamed.flatMap(decisionTargets) }));
    // se a entrada SEM os registros também é recusada, o defeito é do mapeador (nunca deve acontecer)
    if (!parseScoringInput({ ...raw, operatorRecords: undefined }).ok) blockers.push(blocker('MAPPER_INTERNAL_ERROR', 'BLOCKING', { reasonCode: 'OUTPUT_REJECTED_BY_CONTRACT' }));
    return refuse(richTrace, blockers, criteriaView, issues);
  }
  const inputSha256 = sha256Hex(canonicalJson(parsed.input));
  return { input: parsed.input, inputSha256, finalizable: !blockers.some((b) => b.severity === 'BLOCKING'), traceability: { ...richTrace, inputSha256 }, blockers: sortBlockers(blockers), criteriaView, contractIssues: [] };
}

/* ---------------------------------------------------------------- visão por subcritério (matriz de critérios, spec §8) */

interface ViewContext {
  readonly emitted: ReadonlySet<MappedField>;
  readonly omitted: ReadonlyMap<MappedField, FactOmittedReason>;
  readonly source: TraceSource | null;
  readonly proofReason: X5ProofReason;
  readonly decisionsByTarget: ReadonlyMap<SubcriterionId, readonly string[]>;
  readonly records: readonly OperatorRecord[];
  /** A captura do perfil é velha demais para fundamentar pontos: o motor devolverá Não verificado. */
  readonly tooOld: boolean;
}

function buildCriteriaView(rows: typeof CRITERIA_SOURCES, ctx: ViewContext): CriterionSourceView[] {
  return rows.map((row) => {
    const decisionIds = uniqueSorted(ctx.decisionsByTarget.get(row.id) ?? []);
    const factEmitted = row.fact !== null && ctx.emitted.has(row.fact);
    const refs = factEmitted && ctx.source ? [ctx.source.ref] : [];
    const base = { id: row.id, criterionId: row.criterionId, maxHalfPoints: row.maxHalfPoints, decisionIds };
    const noData = (reasonCode: CriterionSourceView['reasonCode']): CriterionSourceView => ({ ...base, source: 'SEM_DADO', reasonCode, factEmitted, evidenceRefs: refs });
    if (ctx.tooOld && factEmitted && (row.channel === 'AUTOMATIC' || row.channel === 'AUTOMATIC_CONDITIONAL')) return noData('EVIDENCE_TOO_OLD');
    if (ctx.tooOld && row.channel === 'HUMAN_JUDGEMENT') return { ...base, source: 'BLOQUEADO', reasonCode: 'EVIDENCE_TOO_OLD', factEmitted, evidenceRefs: refs };
    switch (row.channel) {
      case 'AUTOMATIC':
        return factEmitted ? { ...base, source: 'AUTOMATICO', reasonCode: null, factEmitted: true, evidenceRefs: refs } : noData(row.fact ? (ctx.omitted.get(row.fact) ?? 'FIELD_ABSENT') : 'FIELD_ABSENT');
      case 'AUTOMATIC_CONDITIONAL':
        if (!factEmitted) return noData(row.fact ? (ctx.omitted.get(row.fact) ?? 'FIELD_ABSENT') : 'FIELD_ABSENT');
        return ctx.proofReason === 'PROVEN' ? { ...base, source: 'AUTOMATICO', reasonCode: null, factEmitted: true, evidenceRefs: refs } : noData('UTM_NOT_PROVEN');
      case 'HUMAN_JUDGEMENT': {
        if (!factEmitted) return { ...base, source: 'BLOQUEADO', reasonCode: 'BASIS_MISSING', factEmitted: false, evidenceRefs: [] };
        const judged = ctx.records.some((record) => record.kind === 'JUDGEMENT' && record.subcriterionId === row.id && classifyOperatorRecord(record) === 'SUPPORTED');
        return { ...base, source: 'DECISAO_HUMANA', reasonCode: judged ? null : 'AWAITING_OPERATOR_DECISION', factEmitted: true, evidenceRefs: refs };
      }
      case 'HUMAN_NOT_APPLICABLE': {
        const applied = ctx.records.some((record) => record.kind === 'NOT_APPLICABLE' && decisionTargets(record).includes(row.id) && classifyOperatorRecord(record) === 'SUPPORTED');
        return applied ? { ...base, source: 'DECISAO_HUMANA', reasonCode: null, factEmitted: false, evidenceRefs: [] } : { ...base, source: 'BLOQUEADO', reasonCode: row.blockedReason, factEmitted: false, evidenceRefs: [] };
      }
      case 'BLOCKED':
        return { ...base, source: 'BLOQUEADO', reasonCode: row.blockedReason, factEmitted: row.observedOnly && factEmitted, evidenceRefs: row.observedOnly ? refs : [] };
    }
  });
}
