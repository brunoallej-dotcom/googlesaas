import type { CriterionId } from '../link-audit/methodology';
import type { OperatorRecord } from '../link-audit/scoring/input';
import { SUBCRITERIA } from '../link-audit/scoring/ruler';
import type { SubcriterionId } from '../link-audit/scoring/types';

/*
 * Matriz dos 35 subcritérios (spec §10) como DADOS: de onde vem o fato que cada um lê, se o mapeador pode fornecê-lo HOJE
 * com a coleta atual (Serper `/maps` armazenado) e por que não, quando não pode. Não há pontos aqui: só pesos de referência
 * (copiados e conferidos contra `SUBCRITERIA` por teste) e a classificação de canal. Quem calcula é o motor.
 *
 * Totais da matriz (M-4a estrita): automático certo 22 hp (N1 6, N3 6, C1 6, X1 4) · + X5 (UTM completo COMPROVADO) 4 = 26 ·
 * + C2 (decisão humana) 8 = 34 hp. R1 e R2 (24 hp) estão fora porque a contagem de avaliações não alimenta o motor.
 */
export type MappedField = 'name' | 'address' | 'phone' | 'hours' | 'primaryCategory' | 'additionalCategories' | 'website';

export type SourceChannel =
  /** O mapeador emite o fato a partir de evidência armazenada e íntegra. */
  | 'AUTOMATIC'
  /** Idem, mas só pontua com prova positiva adicional (X5: UTM completo observado no bruto). */
  | 'AUTOMATIC_CONDITIONAL'
  /** Depende de um juízo registrado do operador sobre um fato emitido (C2). */
  | 'HUMAN_JUDGEMENT'
  /** Só o registro do operador de N/A (S4, BUSINESS_MODEL) é aceito; o subcritério em si não tem fonte. */
  | 'HUMAN_NOT_APPLICABLE'
  /** Sem fonte comprovável hoje. */
  | 'BLOCKED';

export type BlockedReason =
  | 'M4A_EXCLUDED'
  | 'ADDRESS_NOT_STRUCTURED'
  | 'HOURS_NOT_STRUCTURED'
  | 'NO_EXTERNAL_SOURCE'
  | 'COMPLETENESS_NOT_PROVEN'
  | 'NOT_COLLECTED'
  | 'SITE_NOT_READ'
  | 'COMPETITORS_NOT_COLLECTED'
  | 'AUTHORITY_NOT_COLLECTED';

export interface CriterionSource {
  readonly id: SubcriterionId;
  readonly criterionId: CriterionId;
  /** Peso de referência em meios-pontos (conferido contra a régua por teste; o motor é a fonte). */
  readonly maxHalfPoints: number;
  readonly channel: SourceChannel;
  /** Campo do perfil que o subcritério lê (o mapeador o emite quando comprovado). */
  readonly fact: MappedField | null;
  /** O fato é emitido só como OBSERVAÇÃO (o motor não decide com ele): endereço cru, horários em texto, adicionais incompletas. */
  readonly observedOnly: boolean;
  readonly blockedReason: BlockedReason | null;
  /** Meios-pontos que o subcritério pode avaliar HOJE com a coleta atual, se o dado existir (0 = bloqueado). */
  readonly evaluableTodayHalfPoints: number;
}

type Row = readonly [SubcriterionId, CriterionId, number, SourceChannel, MappedField | null, boolean, BlockedReason | null];
const ROWS: readonly Row[] = [
  ['N1', 'NAP', 6, 'AUTOMATIC', 'name', false, null],
  ['N2', 'NAP', 6, 'BLOCKED', 'address', true, 'ADDRESS_NOT_STRUCTURED'],
  ['N3', 'NAP', 6, 'AUTOMATIC', 'phone', false, null],
  ['N4', 'NAP', 4, 'BLOCKED', 'hours', true, 'HOURS_NOT_STRUCTURED'],
  ['N5', 'NAP', 8, 'BLOCKED', null, false, 'NO_EXTERNAL_SOURCE'],
  ['C1', 'CATEGORIES', 6, 'AUTOMATIC', 'primaryCategory', false, null],
  ['C2', 'CATEGORIES', 8, 'HUMAN_JUDGEMENT', 'primaryCategory', false, null],
  ['C3', 'CATEGORIES', 6, 'BLOCKED', 'additionalCategories', true, 'COMPLETENESS_NOT_PROVEN'],
  ['S1', 'SERVICES', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['S2', 'SERVICES', 6, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['S3', 'SERVICES', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['S4', 'SERVICES', 4, 'HUMAN_NOT_APPLICABLE', null, false, 'NOT_COLLECTED'],
  ['S5', 'SERVICES', 6, 'BLOCKED', null, false, 'SITE_NOT_READ'],
  ['R1', 'REVIEWS', 12, 'BLOCKED', null, false, 'M4A_EXCLUDED'],
  ['R2', 'REVIEWS', 12, 'BLOCKED', null, false, 'M4A_EXCLUDED'],
  ['R3', 'REVIEWS', 12, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['P1', 'REVIEW_REPLIES', 8, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['P2', 'REVIEW_REPLIES', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['P3', 'REVIEW_REPLIES', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['V1', 'VISUALS', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['V2', 'VISUALS', 6, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['V3', 'VISUALS', 2, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['V4', 'VISUALS', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['V5', 'VISUALS', 4, 'BLOCKED', null, false, 'SITE_NOT_READ'],
  ['A1', 'POSTS_ACTIVITY', 6, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['A2', 'POSTS_ACTIVITY', 6, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['A3', 'POSTS_ACTIVITY', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['X1', 'CONVERSION', 4, 'AUTOMATIC', 'website', false, null],
  ['X2', 'CONVERSION', 2, 'BLOCKED', null, false, 'SITE_NOT_READ'],
  ['X3', 'CONVERSION', 4, 'BLOCKED', null, false, 'NOT_COLLECTED'],
  ['X4', 'CONVERSION', 6, 'BLOCKED', null, false, 'SITE_NOT_READ'],
  ['X5', 'CONVERSION', 4, 'AUTOMATIC_CONDITIONAL', 'website', false, null],
  ['L1', 'LOCAL_AUTHORITY', 6, 'BLOCKED', null, false, 'COMPETITORS_NOT_COLLECTED'],
  ['L2', 'LOCAL_AUTHORITY', 6, 'BLOCKED', null, false, 'COMPETITORS_NOT_COLLECTED'],
  ['L3', 'LOCAL_AUTHORITY', 6, 'BLOCKED', null, false, 'AUTHORITY_NOT_COLLECTED'],
];

export const CRITERIA_SOURCES: readonly CriterionSource[] = ROWS.map(([id, criterionId, maxHalfPoints, channel, fact, observedOnly, blockedReason]) => ({
  id,
  criterionId,
  maxHalfPoints,
  channel,
  fact,
  observedOnly,
  blockedReason,
  evaluableTodayHalfPoints: channel === 'BLOCKED' || channel === 'HUMAN_NOT_APPLICABLE' ? 0 : maxHalfPoints,
}));

export const CRITERIA_SOURCES_BY_ID: ReadonlyMap<SubcriterionId, CriterionSource> = new Map(CRITERIA_SOURCES.map((row) => [row.id, row]));

const sumBy = (channels: readonly SourceChannel[]): number => CRITERIA_SOURCES.filter((row) => channels.includes(row.channel)).reduce((total, row) => total + row.evaluableTodayHalfPoints, 0);
/** 22 hp: o que a coleta atual entrega de forma automática e certa. */
export const AUTOMATIC_HALF_POINTS = sumBy(['AUTOMATIC']);
/** 26 hp: com a prova positiva de UTM completo (X5). */
export const WITH_UTM_PROOF_HALF_POINTS = sumBy(['AUTOMATIC', 'AUTOMATIC_CONDITIONAL']);
/** 34 hp (17 %): com o juízo humano C2. É o teto de hoje. */
export const CEILING_TODAY_HALF_POINTS = sumBy(['AUTOMATIC', 'AUTOMATIC_CONDITIONAL', 'HUMAN_JUDGEMENT']);

/** Confere a tabela contra a régua carregada: mesmos 35 ids, na mesma ordem, com o mesmo critério e o mesmo peso. Lista vazia = ok. */
export function validateCriteriaSources(sources: readonly CriterionSource[] = CRITERIA_SOURCES): string[] {
  const issues: string[] = [];
  if (sources.length !== SUBCRITERIA.length) issues.push(`a tabela tem ${sources.length} linhas e a régua ${SUBCRITERIA.length} subcritérios`);
  SUBCRITERIA.forEach((def, index) => {
    const row = sources[index];
    if (!row || row.id !== def.id) issues.push(`posição ${index}: esperado ${def.id}, encontrado ${row?.id ?? '(nada)'}`);
    else {
      if (row.criterionId !== def.criterionId) issues.push(`${def.id}: critério ${row.criterionId} ≠ ${def.criterionId}`);
      if (row.maxHalfPoints !== def.maxHalfPoints) issues.push(`${def.id}: peso ${row.maxHalfPoints} ≠ ${def.maxHalfPoints}`);
    }
  });
  for (const row of sources) {
    if (row.channel === 'BLOCKED' && row.blockedReason === null) issues.push(`${row.id}: canal bloqueado sem motivo`);
    if ((row.channel === 'AUTOMATIC' || row.channel === 'AUTOMATIC_CONDITIONAL') && (row.blockedReason !== null || row.fact === null)) issues.push(`${row.id}: canal automático incoerente (motivo de bloqueio ou campo ausente)`);
  }
  return issues;
}

/* ---------------------------------------------------------------- decisões humanas aceitas pelo contrato aprovado (D6C-4, §11.2) */

export type DecisionSupport =
  /** Juízo C2 ou N/A de S4 (BUSINESS_MODEL): o que o formulário inicial oferece. */
  | 'SUPPORTED'
  /** Aceita, mas sem efeito hoje (equivalência de nomes só age com fonte NAP externa, que a coleta atual não tem). */
  | 'SUPPORTED_NO_EFFECT_TODAY'
  /** Fora do contrato aprovado da 6C: bloqueia a finalização até ser revogada. */
  | 'NOT_SUPPORTED';

const KNOWN_IDS: ReadonlySet<string> = new Set(SUBCRITERIA.map((def) => def.id));
const knownIds = (value: unknown): SubcriterionId[] => (Array.isArray(value) ? value.filter((id): id is SubcriterionId => typeof id === 'string' && KNOWN_IDS.has(id)) : []);

/** Subcritérios que um registro do operador atinge (para rastreabilidade e bloqueios). Defensivo: lixo vira lista vazia, nunca exceção. */
export function decisionTargets(record: OperatorRecord): SubcriterionId[] {
  switch (record.kind) {
    case 'JUDGEMENT':
      return knownIds([record.subcriterionId]);
    case 'NOT_APPLICABLE':
    case 'SITE_SCOPE_ATTESTATION':
    case 'OBSERVATION_CONFIRMATION':
      return knownIds(record.subcriterionIds);
    case 'IMAGES_CONFIRMATION':
      return ['V5'];
    case 'NAME_EQUIVALENCE':
      return ['N5'];
    default:
      return [];
  }
}

export function classifyOperatorRecord(record: OperatorRecord): DecisionSupport {
  switch (record.kind) {
    case 'JUDGEMENT':
      return record.subcriterionId === 'C2' ? 'SUPPORTED' : 'NOT_SUPPORTED';
    case 'NOT_APPLICABLE':
      return record.code === 'BUSINESS_MODEL' && Array.isArray(record.subcriterionIds) && record.subcriterionIds.length === 1 && record.subcriterionIds[0] === 'S4' ? 'SUPPORTED' : 'NOT_SUPPORTED';
    case 'NAME_EQUIVALENCE':
      return 'SUPPORTED_NO_EFFECT_TODAY';
    default:
      return 'NOT_SUPPORTED';
  }
}
