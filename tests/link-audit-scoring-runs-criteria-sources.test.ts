import assert from 'node:assert/strict';
import test from 'node:test';
import { CRITERIA } from '../src/lib/link-audit/methodology';
import type { OperatorRecord } from '../src/lib/link-audit/scoring/input';
import { SUBCRITERIA } from '../src/lib/link-audit/scoring/ruler';
import { METHODOLOGY_VERSION, RULER_FINGERPRINT, SCORE_MODEL_VERSION, SCORING_INPUT_SCHEMA_VERSION } from '../src/lib/link-audit/scoring';
import {
  AUTOMATIC_HALF_POINTS,
  CEILING_TODAY_HALF_POINTS,
  classifyOperatorRecord,
  CRITERIA_SOURCES,
  decisionTargets,
  validateCriteriaSources,
  WITH_UTM_PROOF_HALF_POINTS,
  type CriterionSource,
} from '../src/lib/link-audit-scoring-runs/criteria-sources';
import { c2Judgement, s4NotApplicable } from './helpers/link-audit-mapper-fixtures';

/*
 * Onda 6C, I2 — a matriz dos 35 subcritérios como dados. A tabela precisa coincidir com a régua carregada (`SUBCRITERIA`, D3B
 * `regua-d3b-r2`): se a régua ganhar, perder ou mudar um subcritério, estes testes falham e a classificação tem de ser revista.
 */
const ids = (rows: readonly CriterionSource[]): string[] => rows.map((row) => row.id);

test('a tabela coincide com a régua: os mesmos 35 subcritérios, na mesma ordem, com o mesmo critério e o mesmo peso', () => {
  assert.deepEqual(validateCriteriaSources(), []);
  assert.equal(CRITERIA_SOURCES.length, 35);
  assert.deepEqual(ids(CRITERIA_SOURCES), SUBCRITERIA.map((def) => def.id));
  for (const [index, def] of SUBCRITERIA.entries()) {
    assert.equal(CRITERIA_SOURCES[index]?.criterionId, def.criterionId, def.id);
    assert.equal(CRITERIA_SOURCES[index]?.maxHalfPoints, def.maxHalfPoints, def.id);
  }
});

test('o validador pega divergências: peso trocado, linha faltando, ordem trocada, critério trocado, canal incoerente', () => {
  const clone = (change: (rows: CriterionSource[]) => CriterionSource[]): string[] => validateCriteriaSources(change([...CRITERIA_SOURCES]));
  assert.ok(clone((rows) => rows.map((row) => (row.id === 'N1' ? { ...row, maxHalfPoints: 7 } : row))).length > 0, 'peso');
  assert.ok(clone((rows) => rows.slice(1)).length > 0, 'linha faltando');
  assert.ok(clone((rows) => [rows[1] as CriterionSource, rows[0] as CriterionSource, ...rows.slice(2)]).length > 0, 'ordem');
  assert.ok(clone((rows) => rows.map((row) => (row.id === 'C1' ? { ...row, criterionId: 'NAP' as const } : row))).length > 0, 'critério');
  assert.ok(clone((rows) => rows.map((row) => (row.id === 'S1' ? { ...row, blockedReason: null } : row))).length > 0, 'bloqueado sem motivo');
  assert.ok(clone((rows) => rows.map((row) => (row.id === 'N1' ? { ...row, blockedReason: 'NOT_COLLECTED' as const } : row))).length > 0, 'automático com motivo de bloqueio');
});

test('a soma dos pesos é 200 hp e cada critério soma o peso aprovado (em meios-pontos)', () => {
  assert.equal(CRITERIA_SOURCES.reduce((total, row) => total + row.maxHalfPoints, 0), 200);
  for (const criterion of CRITERIA) {
    const sum = CRITERIA_SOURCES.filter((row) => row.criterionId === criterion.id).reduce((total, row) => total + row.maxHalfPoints, 0);
    assert.equal(sum, criterion.maxWeight * 2, criterion.id);
  }
});

test('cobertura potencial de hoje (M-4a estrita): 22 hp automáticos, 26 com UTM completo comprovado, 34 com o juízo C2 (17 % de 100)', () => {
  assert.equal(AUTOMATIC_HALF_POINTS, 22);
  assert.equal(WITH_UTM_PROOF_HALF_POINTS, 26);
  assert.equal(CEILING_TODAY_HALF_POINTS, 34);
  assert.equal(CEILING_TODAY_HALF_POINTS / 2, 17, 'percentual do teto');
  assert.deepEqual(ids(CRITERIA_SOURCES.filter((row) => row.channel === 'AUTOMATIC')), ['N1', 'N3', 'C1', 'X1']);
  assert.deepEqual(ids(CRITERIA_SOURCES.filter((row) => row.channel === 'AUTOMATIC_CONDITIONAL')), ['X5']);
  assert.deepEqual(ids(CRITERIA_SOURCES.filter((row) => row.channel === 'HUMAN_JUDGEMENT')), ['C2']);
  assert.deepEqual(ids(CRITERIA_SOURCES.filter((row) => row.channel === 'HUMAN_NOT_APPLICABLE')), ['S4']);
  assert.equal(CRITERIA_SOURCES.filter((row) => row.channel === 'BLOCKED').length, 35 - 4 - 1 - 1 - 1, '28 bloqueados');
});

test('M-4a: R1 e R2 (24 hp) estão excluídos por política, e a exclusão não depende de nenhum fato', () => {
  const excluded = CRITERIA_SOURCES.filter((row) => row.blockedReason === 'M4A_EXCLUDED');
  assert.deepEqual(ids(excluded), ['R1', 'R2']);
  assert.equal(excluded.reduce((total, row) => total + row.maxHalfPoints, 0), 24);
  for (const row of excluded) assert.deepEqual([row.channel, row.fact, row.evaluableTodayHalfPoints], ['BLOCKED', null, 0]);
});

test('fontes da régua: tudo que é de SITE, CROSS (NAP externo), COMPETITORS ou EXTERNAL está bloqueado (o mapeador não tem essas fontes)', () => {
  for (const def of SUBCRITERIA) {
    const row = CRITERIA_SOURCES.find((candidate) => candidate.id === def.id) as CriterionSource;
    if (['SITE', 'CROSS', 'COMPETITORS', 'EXTERNAL'].includes(def.source)) assert.equal(row.channel, 'BLOCKED', `${def.id} (${def.source})`);
    if (row.channel === 'AUTOMATIC' || row.channel === 'AUTOMATIC_CONDITIONAL') assert.equal(def.source, 'NATIVE', `${def.id}: automático só para fato nativo`);
  }
});

test('campos observados só como observação (não decidem): endereço cru, horários em texto, categorias adicionais; nenhum deles avalia nada hoje', () => {
  const observedOnly = CRITERIA_SOURCES.filter((row) => row.observedOnly);
  assert.deepEqual(ids(observedOnly), ['N2', 'N4', 'C3']);
  for (const row of observedOnly) assert.deepEqual([row.channel, row.evaluableTodayHalfPoints], ['BLOCKED', 0]);
  assert.deepEqual(observedOnly.map((row) => row.blockedReason), ['ADDRESS_NOT_STRUCTURED', 'HOURS_NOT_STRUCTURED', 'COMPLETENESS_NOT_PROVEN']);
});

test('todo subcritério tem exatamente uma classificação e um canal conhecido', () => {
  const channels = new Set(['AUTOMATIC', 'AUTOMATIC_CONDITIONAL', 'HUMAN_JUDGEMENT', 'HUMAN_NOT_APPLICABLE', 'BLOCKED']);
  assert.equal(new Set(ids(CRITERIA_SOURCES)).size, 35);
  for (const row of CRITERIA_SOURCES) assert.ok(channels.has(row.channel), row.id);
});

/* ---------------------------------------------------------------- política de decisões (D6C-4, §11.2) */
const rec = (over: Record<string, unknown>): OperatorRecord => ({ id: 'op-0009', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:00:00.000Z', justification: 'Justificativa com mais de vinte caracteres.', ...over }) as unknown as OperatorRecord;

test('decisões aceitas pelo contrato aprovado: juízo C2 e N/A de S4 (BUSINESS_MODEL); equivalência de nomes aceita mas sem efeito hoje', () => {
  assert.equal(classifyOperatorRecord(c2Judgement()), 'SUPPORTED');
  assert.equal(classifyOperatorRecord(s4NotApplicable()), 'SUPPORTED');
  assert.equal(classifyOperatorRecord(rec({ kind: 'NAME_EQUIVALENCE', nameA: 'Padaria A', nameB: 'Padaria B' })), 'SUPPORTED_NO_EFFECT_TODAY');
});

test('N/A só é sustentado pelo contrato aprovado: qualquer outro código ou subcritério NÃO é suportado', () => {
  const na = (code: string, subcriterionIds: string[], causeEvidenceIds: string[] = []) => rec({ kind: 'NOT_APPLICABLE', code, subcriterionIds, causeEvidenceIds });
  assert.equal(classifyOperatorRecord(na('FEATURE_UNAVAILABLE', ['S3'], ['capture:c0001'])), 'NOT_SUPPORTED', 'exige anexo do painel');
  assert.equal(classifyOperatorRecord(na('FEATURE_UNAVAILABLE', ['A1', 'A2', 'A3'], ['capture:c0001'])), 'NOT_SUPPORTED');
  assert.equal(classifyOperatorRecord(na('NO_ADDITIONAL_NEEDED', ['C3'])), 'NOT_SUPPORTED', 'seria contrariado pelo motor');
  assert.equal(classifyOperatorRecord(na('BUSINESS_MODEL', ['S3'])), 'NOT_SUPPORTED', 'BUSINESS_MODEL só para S4');
  assert.equal(classifyOperatorRecord(na('BUSINESS_MODEL', ['S4', 'S3'])), 'NOT_SUPPORTED', 'S4 sozinho');
  for (const code of ['FEATURE_UNAVAILABLE', 'NO_REVIEWS_PROVEN', 'NO_REPLIES_PROVEN', 'NO_WEBSITE_PROVEN', 'NO_ADDITIONAL_NEEDED', 'CODIGO_NOVO']) {
    assert.equal(classifyOperatorRecord(na(code, ['S4'], ['capture:c0001'])), 'NOT_SUPPORTED', `S4 com ${code}: só BUSINESS_MODEL é aceito`);
  }
  for (const derived of ['NO_REVIEWS_PROVEN', 'NO_REPLIES_PROVEN', 'NO_WEBSITE_PROVEN']) assert.equal(classifyOperatorRecord(na(derived, ['R1'])), 'NOT_SUPPORTED', `${derived} é derivado pelo motor, nunca informado`);
});

test('juízos C3/P3, atestado de escopo, confirmação de observação e de imagens ficam fora do contrato aprovado', () => {
  assert.equal(classifyOperatorRecord(rec({ kind: 'JUDGEMENT', subcriterionId: 'C3', value: 'ALL_RELEVANT' })), 'NOT_SUPPORTED');
  assert.equal(classifyOperatorRecord(rec({ kind: 'JUDGEMENT', subcriterionId: 'P3', value: 'SPECIFIC', sampleSize: 5 })), 'NOT_SUPPORTED');
  assert.equal(classifyOperatorRecord(rec({ kind: 'SITE_SCOPE_ATTESTATION', subcriterionIds: ['S5'], scopeDescription: 'Escopo descrito com mais de vinte caracteres.' })), 'NOT_SUPPORTED');
  assert.equal(classifyOperatorRecord(rec({ kind: 'OBSERVATION_CONFIRMATION', subcriterionIds: ['S5'] })), 'NOT_SUPPORTED');
  assert.equal(classifyOperatorRecord(rec({ kind: 'IMAGES_CONFIRMATION', imageTypes: ['PLACE'], evidenceIds: ['capture:c0001'] })), 'NOT_SUPPORTED');
  assert.equal(classifyOperatorRecord(rec({ kind: 'ALGO_NOVO' })), 'NOT_SUPPORTED', 'tipo desconhecido');
});

test('alvos das decisões: defensivos (lixo vira lista vazia, nunca exceção)', () => {
  assert.deepEqual(decisionTargets(c2Judgement()), ['C2']);
  assert.deepEqual(decisionTargets(s4NotApplicable()), ['S4']);
  assert.deepEqual(decisionTargets(rec({ kind: 'IMAGES_CONFIRMATION', imageTypes: [], evidenceIds: [] })), ['V5']);
  assert.deepEqual(decisionTargets(rec({ kind: 'NAME_EQUIVALENCE', nameA: 'a', nameB: 'b' })), ['N5']);
  assert.deepEqual(decisionTargets(rec({ kind: 'NOT_APPLICABLE', subcriterionIds: 'S4' })), []);
  assert.deepEqual(decisionTargets(rec({ kind: 'NOT_APPLICABLE', subcriterionIds: ['S4', 'ZZ', 7, null] })), ['S4']);
  assert.deepEqual(decisionTargets(rec({ kind: 'DESCONHECIDO' })), []);
});

/* ---------------------------------------------------------------- compatibilidade com a régua D3B */
test('compatibilidade D3B: o mapeador usa a régua homologada, sem tocá-la (impressão digital, versões e schema fixados)', () => {
  assert.equal(RULER_FINGERPRINT, '957f88fd2928b0f0bb99c2689adb400eeb15b64c504bc72a26c1df40b22b387d', 'a régua mudou: exige NOVA scoreModelVersion e revisão da matriz');
  assert.equal(SCORE_MODEL_VERSION, 'regua-d3b-r2');
  assert.equal(METHODOLOGY_VERSION, 'lumos-reconstruida-v1');
  assert.equal(SCORING_INPUT_SCHEMA_VERSION, 1);
});
