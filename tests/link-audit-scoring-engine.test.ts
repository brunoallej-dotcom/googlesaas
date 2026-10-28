import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import {
  checkResultConsistency as checkResult,
  isEngineResult,
  RULER_FINGERPRINT,
  SCORE_MODEL_VERSION,
  SCORE_MODELS,
  scoreAudit,
  verifyScoreResult,
  type ScoreResult,
} from '../src/lib/link-audit/scoring';
import type { Mutable } from './helpers/link-audit-fixtures';
import * as scoring from '../src/lib/link-audit/scoring';
import { sha256OfCanonical } from '../src/lib/link-audit/scoring/fingerprint';
import { NA_RULES, RULER_DATA, RULES, SUBCRITERIA, TIERS, VALIDATED_DETECTORS } from '../src/lib/link-audit/scoring/ruler';
import { clone, evidence, obs, record, richInput, run, sub } from './helpers/link-audit-scoring-fixtures';

/** Hashes dourados: se a lógica mudar sem nova scoreModelVersion, estes testes falham (mudança silenciosa de resultado). */
export const GOLDEN_RICH_RESULT_SHA256 = '436d788aaae1066416c6a48bf0f32aa3579426865dd06442c99ac1fd0d7f1f73';
export const GOLDEN_MIXED_RESULT_SHA256 = 'df61ca1711693dacdaf1055ab125956d58ad407c156b61f3620d571c0fe73009';

const rejects = (mutate: (d: Mutable) => void, pattern: RegExp): void => {
  const draft = clone(richInput());
  mutate(draft);
  const outcome = scoreAudit(draft);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.ok(outcome.issues.some((issue) => pattern.test(issue)), `esperava ${pattern}: ${outcome.issues.join(' | ')}`);
};

/** Entrada com vários estados ao mesmo tempo (para o hash dourado e para a reprodutibilidade). */
function mixedInput(): Mutable {
  const draft = clone(richInput());
  draft.profile.reviews = [obs({ ratingShown: '4.7', reviewCount: 3 })]; // amostra insuficiente em R1/L1
  delete draft.profile.replies;
  delete draft.profile.attributes;
  draft.profile.photos = [obs(0)];
  draft.profile.website = [obs('https://exemplo.com.br/')]; // sem UTM
  delete draft.profile.hours;
  draft.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-s3', { subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['n1'] }));
  draft.site.offers.distinctNamedOffers = 3;
  return draft;
}

test('perfil completo fictício: 100 pontos avaliados, índice 100, publicável com confiança alta e versões separadas', () => {
  const result = run();
  assert.equal(result.kind, 'LUMOS_SCORE_RESULT');
  assert.equal(result.methodologyVersion, 'lumos-reconstruida-v1');
  assert.equal(result.scoreModelVersion, 'regua-d3b-r2');
  assert.equal(result.rulerFingerprint, RULER_FINGERPRINT);
  assert.equal(result.totals.evaluatedHalfPoints, 200);
  assert.equal(result.totals.obtainedHalfPoints, 200);
  assert.equal(result.totals.coveragePercent, 100);
  assert.equal(result.publication.status, 'PUBLISHED');
  assert.equal(result.index?.shown, 100);
  assert.equal(result.index?.decimal2, '100.00');
  assert.deepEqual(result.index?.exact, { num: 100, den: 1 });
  assert.equal(result.index?.classification, 'LOCAL_REFERENCE');
  assert.equal(result.confidence?.level, 'HIGH');
  assert.equal(result.confidence?.factors.length, 6);
  assert.deepEqual(result.confidence?.limitingFactors.length, 6);
  assert.equal(result.criteria.length, 9);
  assert.ok(result.criteria.every((c) => c.status === 'EVALUATED'));
  assert.equal(result.criteria.reduce((sum, c) => sum + c.weight, 0), 100);
  assert.equal(result.subcriteria.length, 35);
  assert.deepEqual(checkResult(result), []);
  assert.match(result.inputSha256, /^[a-f0-9]{64}$/);
  assert.match(result.resultSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.notices.some((notice) => /não é uma nota oficial do Google/.test(notice)));
  assert.ok(result.notices.some((notice) => /Metodologia reconstruída/.test(notice)));
  assert.equal(result.naSensitivity, null);
});

test('cada ponto é rastreável: evidências e registros do operador citados, com grau e idade', () => {
  const result = run();
  for (const s of result.subcriteria) {
    assert.ok(s.evidenceIds.length > 0 || s.operatorRecordIds.length > 0, `${s.id} sem rastreabilidade`);
    assert.equal(s.grade, 'PRIMARY');
  }
  assert.deepEqual(sub(result, 'C2').operatorRecordIds, ['op-c2']);
  assert.ok(sub(result, 'C2').evidenceIds.includes('n1'));
  assert.equal(sub(result, 'R3').maxEvidenceAgeDays, 2);
});

test('o resultado é imutável e só o motor produz resultados "do motor"', () => {
  const result = run();
  assert.ok(isEngineResult(result));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.subcriteria) && Object.isFrozen(result.subcriteria[0]));
  assert.throws(() => { (result as unknown as Mutable).index = null; }, TypeError);
  const copy = JSON.parse(JSON.stringify(result)) as ScoreResult;
  assert.equal(isEngineResult(copy), false, 'um JSON clonado não é resultado do motor');
  assert.equal(isEngineResult({ ...result }), false);
});

test('determinismo: mesma entrada => mesmo resultado, byte a byte; a ordem dos arrays não importa', () => {
  const first = run();
  const second = run();
  assert.equal(canonicalJson(first), canonicalJson(second));
  const shuffled = clone(richInput());
  shuffled.evidences.reverse();
  shuffled.operatorRecords.reverse();
  shuffled.competitors.reverse();
  shuffled.nap.sources.reverse();
  shuffled.authority.findings.reverse();
  shuffled.profile.name = [obs('Padaria Exemplo'), obs('Padaria Exemplo')];
  const outcome = scoreAudit(shuffled);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.totals.obtainedHalfPoints, first.totals.obtainedHalfPoints);
    assert.equal(canonicalJson(outcome.result.subcriteria), canonicalJson(first.subcriteria));
  }
  const reordered = clone(richInput());
  reordered.evidences.reverse();
  reordered.operatorRecords.reverse();
  const again = scoreAudit(reordered);
  assert.equal(again.ok && again.result.resultSha256, first.resultSha256, 'a ordem dos arrays não altera nem o hash do resultado');
});

test('hash dourado: nenhuma mudança silenciosa de lógica sem nova scoreModelVersion', () => {
  assert.equal(run().resultSha256, GOLDEN_RICH_RESULT_SHA256);
  const mixed = scoreAudit(mixedInput());
  assert.equal(mixed.ok, true);
  if (mixed.ok) assert.equal(mixed.result.resultSha256, GOLDEN_MIXED_RESULT_SHA256);
});

test('reprodutibilidade: verifyScoreResult recalcula com a mesma versão e as mesmas evidências', () => {
  const draft = mixedInput();
  const outcome = scoreAudit(draft);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const roundTrip = JSON.parse(JSON.stringify(outcome.result));
  const verified = verifyScoreResult(roundTrip, draft);
  assert.equal(verified.ok, true);
  if (verified.ok) assert.ok(isEngineResult(verified.result));

  const tampered = clone(roundTrip) as Mutable;
  tampered.index.shown = 99;
  assert.equal(verifyScoreResult(tampered, draft).ok, false, 'pontuação alterada à mão');
  const forgedPoints = clone(roundTrip) as Mutable;
  forgedPoints.subcriteria[0].obtainedHalfPoints = 0;
  assert.equal(verifyScoreResult(forgedPoints, draft).ok, false);
  const otherInput = clone(draft);
  otherInput.profile.photos = [obs(30)];
  assert.equal(verifyScoreResult(roundTrip, otherInput).ok, false, 'outro conjunto de evidências não reproduz o resultado');
  const unknownModel = { ...roundTrip, scoreModelVersion: 'regua-d3b-r9' };
  const refused = verifyScoreResult(unknownModel, draft);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.issues.join(' '), /não está registrado/);
  assert.equal(verifyScoreResult({ ...roundTrip, methodologyVersion: 'outra' }, draft).ok, false);
  assert.equal(verifyScoreResult(null, draft).ok, false);
  assert.equal(verifyScoreResult({}, draft).ok, false);
});

test('versionamento: modelos antigos permanecem registrados e versões desconhecidas são recusadas', () => {
  assert.deepEqual(Object.keys(SCORE_MODELS), [SCORE_MODEL_VERSION]);
  const refused = scoreAudit(richInput(), { scoreModelVersion: 'regua-d3b-r1' });
  assert.equal(refused.ok, false);
  const explicit = scoreAudit(richInput(), { scoreModelVersion: SCORE_MODEL_VERSION });
  assert.ok(explicit.ok);
  assert.throws(() => { (SCORE_MODELS as Mutable)['regua-nova'] = {}; }, TypeError);
});

test('o cliente não pode fornecer pontos, índice, cobertura, classificação, confiança nem resultado', () => {
  for (const [label, mutate] of [
    ['score na raiz', (d: Mutable) => { d.score = 100; }],
    ['points na raiz', (d: Mutable) => { d.points = 100; }],
    ['index na raiz', (d: Mutable) => { d.index = 99; }],
    ['coverage na raiz', (d: Mutable) => { d.coverage = 100; }],
    ['classification na raiz', (d: Mutable) => { d.classification = 'STRONG'; }],
    ['confidence na raiz', (d: Mutable) => { d.confidence = 'HIGH'; }],
    ['result na raiz', (d: Mutable) => { d.result = {}; }],
    ['obtainedHalfPoints aninhado', (d: Mutable) => { d.profile.reviews[0].value.obtainedHalfPoints = 12; }],
    ['points dentro de uma evidência', (d: Mutable) => { d.evidences[0].points = 5; }],
    ['pontos dentro de um registro', (d: Mutable) => { d.operatorRecords[0].pontos = 5; }],
    ['status de publicação enviado na raiz', (d: Mutable) => { d.status = 'PUBLISHED'; }],
  ] as const) {
    const draft = clone(richInput());
    mutate(draft);
    const outcome = scoreAudit(draft);
    assert.equal(outcome.ok, false, label);
    if (!outcome.ok) assert.match(outcome.issues.join(' '), /fornecido pelo cliente/, label);
  }
  const unknown = clone(richInput());
  unknown.profile.campoInventado = [];
  const outcome = scoreAudit(unknown);
  assert.equal(outcome.ok, false, 'chaves desconhecidas são recusadas pelo schema estrito');
  // campos legítimos com nomes parecidos continuam aceitos (status da evidência, UF do endereço)
  assert.equal(scoreAudit(richInput()).ok, true);
});

test('entradas inconsistentes são recusadas, nunca "consertadas"', () => {
  rejects((d) => { d.profile.name[0].evidenceIds = ['inexistente']; }, /evidência citada e inexistente: inexistente/);
  rejects((d) => { d.evidences.push(evidence('n1')); }, /evidência duplicada: n1/);
  rejects((d) => { d.evidences[0].observedAt = '2026-11-01T10:00:00-03:00'; }, /posterior à data de referência/);
  rejects((d) => { delete d.evidences[0].contentSha256; }, /exige contentSha256/);
  rejects((d) => { d.referenceDate = '2026-02-30'; }, /data inválida/);
  rejects((d) => { d.auditId = 'Inválido!'; }, /auditId inválido/);
  rejects((d) => { d.schemaVersion = 2; }, /schemaVersion|Invalid literal/);
  rejects((d) => { d.profile.reviews = [obs({ ratingShown: '4.9', reviewCount: -1 })]; }, /reviewCount/);
  rejects((d) => { d.profile.reviews = [obs({ ratingShown: '5.1', reviewCount: 10 })]; }, /nota/);
  rejects((d) => { d.profile.reviews = [obs({ ratingShown: 4.9, reviewCount: 10 })]; }, /ratingShown.*expected string/i);
  rejects((d) => { d.profile.reviews = [obs({ ratingShown: '4.9', reviewCount: 130.5 })]; }, /reviewCount.*expected int/i);
  rejects((d) => { d.profile.reviews = [obs({ ratingShown: '4.9', reviewCount: 0 })]; delete d.profile.replies; }, /nota informada com 0 avaliações/);
  rejects((d) => { d.profile.latestReviewDate = [obs({ kind: 'EXACT', date: '2026-12-01' })]; }, /posterior à data de referência/);
  rejects((d) => { d.profile.hours = [obs({ kind: 'STRUCTURED', days: [{ day: 1, closed: true, intervals: [['08:00', '12:00']] }] })]; }, /fechado não pode ter intervalos/);
  rejects((d) => { d.profile.hours = [obs({ kind: 'STRUCTURED', days: [{ day: 1, closed: false, intervals: [] }] })]; }, /aberto exige intervalos/);
  rejects((d) => { d.competitors.push(clone(d.competitors[0])); }, /concorrente duplicado/);
  rejects((d) => { d.competitors[0].rating = '4.8'; d.competitors[0].reviewCount = 0; }, /nota informada com 0 avaliações/);
  rejects((d) => { d.nap.sources.push(clone(d.nap.sources[0])); }, /fonte duplicada/);
  rejects((d) => { d.nap.sources[0] = { sourceId: 'x', kind: 'SITE', evidenceIds: ['site1'] }; }, /não traz nenhum campo/);
  rejects((d) => { d.site.scope.pagesRead[0].url = 'ftp://exemplo.com.br'; }, /http\(s\)/);
  rejects((d) => { d.site.scope.pagesRead[0].sha256 = 'abc'; }, /SHA-256/);
});

test('fundamento da evidência: não verificada, histórica, antiga e fonte externa para atributo nativo', () => {
  const withEvidence = (over: Mutable) => (d: Mutable) => { Object.assign(d.evidences.find((e: Mutable) => e.id === 'n1'), over); };
  let r = run(withEvidence({ status: 'PARTIAL' }));
  assert.equal(sub(r, 'N1').reasonCode, 'EVIDENCE_NOT_VERIFIED');
  assert.equal(sub(r, 'N1').state, 'NOT_VERIFIED');
  r = run(withEvidence({ status: 'NOT_FOUND' }));
  assert.equal(sub(r, 'N1').state, 'NOT_VERIFIED');
  r = run(withEvidence({ capture: 'PREVIOUS_AUDIT_PDF', contentSha256: undefined }));
  assert.equal(sub(r, 'N1').reasonCode, 'HISTORICAL_ONLY', 'relatório antigo em PDF é histórico: não fundamenta pontos');
  assert.equal(sub(r, 'N1').evaluatedHalfPoints, 0);
  r = run(withEvidence({ observedAt: '2026-04-20T10:00:00-03:00' }));
  assert.equal(sub(r, 'N1').reasonCode, 'EVIDENCE_TOO_OLD', 'mais de 180 dias não fundamenta pontos');
  r = run(withEvidence({ observedAt: '2026-06-24T10:00:00-03:00' })); // 120 dias: ainda fundamenta
  assert.equal(sub(r, 'N1').state, 'SCORED');
  assert.equal(sub(r, 'N1').maxEvidenceAgeDays, 120);
  r = run((d) => { d.profile.photos = [obs(30, { ids: ['site1'] })]; });
  assert.equal(sub(r, 'V2').reasonCode, 'EVIDENCE_SOURCE_NOT_ALLOWED', 'fotos do site não comprovam fotos do Google');
  assert.equal(sub(r, 'V2').state, 'NOT_VERIFIED');
  r = run((d) => { d.profile.services = [obs(10, { ids: ['site1'] })]; d.profile.products = [obs(10, { ids: ['soc1'] })]; });
  assert.equal(sub(r, 'S2').state, 'NOT_VERIFIED');
  assert.equal(sub(r, 'S4').state, 'NOT_VERIFIED');
  r = run((d) => { d.profile.reviews = [obs({ ratingShown: '5.0', reviewCount: 400 }, { ids: ['soc1'] })]; delete d.profile.replies; });
  assert.equal(sub(r, 'R1').state, 'NOT_VERIFIED', 'avaliações em rede social não comprovam avaliações do Google');
  assert.equal(sub(r, 'R2').state, 'NOT_VERIFIED');
});

test('fontes conflitantes: a captura mais recente prevalece; mesma data com valores distintos é conflito aberto', () => {
  const later = (d: Mutable) => {
    d.evidences.push(evidence('n-old', { observedAt: '2026-09-01T10:00:00-03:00' }));
    d.profile.phone = [obs('(62) 9999-0000', { ids: ['n-old'] }), obs('(62) 3233-7847')];
  };
  const r = run(later);
  assert.equal(sub(r, 'N3').state, 'SCORED', 'a captura antiga fica no histórico; a recente prevalece');
  assert.equal(r.conflicts.length, 0);

  const conflict = run((d) => { d.evidences.push(evidence('n2')); d.profile.phone = [obs('(62) 3233-7847'), obs('(62) 9999-0000', { ids: ['n2'] })]; });
  assert.equal(sub(conflict, 'N3').state, 'NOT_VERIFIED');
  assert.equal(sub(conflict, 'N3').reasonCode, 'CONFLICT_OPEN');
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0]?.field, 'profile.phone');
  assert.deepEqual(conflict.conflicts[0]?.subcriteria, ['N3', 'N5']);
  assert.equal(conflict.conflicts[0]?.observations.length, 2);
  assert.ok(conflict.conflicts[0]?.observations.every((o) => o.evidenceIds.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(o.observedAt)), 'o conflito guarda só evidências e datas, nunca os valores nem hashes deles');
  assert.ok(!JSON.stringify(conflict).includes('9999-0000'), 'os valores conflitantes não são repetidos no resultado');
  assert.equal(conflict.confidence?.factors.find((f) => f.id === 'CONFLICTS')?.level, 'MEDIUM');
  assert.equal(conflict.confidence?.level, 'MEDIUM');
  assert.match(conflict.limitations.map((l) => l.text).join(' '), /Conflito aberto em profile\.phone/);

  const same = run((d) => { d.evidences.push(evidence('n3')); d.profile.phone = [obs('(62) 3233-7847'), obs('(62) 3233-7847', { ids: ['n3'] })]; });
  assert.equal(same.conflicts.length, 0, 'valores iguais na mesma data não são conflito');
  assert.equal(sub(same, 'N3').state, 'SCORED');

  const three = run((d) => {
    d.evidences.push(evidence('n4'), evidence('n5'));
    d.profile.phone = [obs('1111-1111'), obs('2222-2222', { ids: ['n4'] })];
    d.profile.name = [obs('Um'), obs('Dois', { ids: ['n5'] })];
    d.profile.website = [obs('https://a.com.br'), obs('https://b.com.br', { ids: ['n4'] })];
  });
  assert.equal(three.conflicts.length, 3);
  assert.equal(three.confidence?.factors.find((f) => f.id === 'CONFLICTS')?.level, 'LOW');
  assert.equal(three.confidence?.level, 'LOW');
  assert.deepEqual(three.conflicts.map((c) => c.field), ['profile.name', 'profile.phone', 'profile.website'], 'ordem estável');
});

test('N/A é neutro: cobertura e índice idênticos aos de Não verificado; o peso N/A é exibido e há sensibilidade', () => {
  const asNa = run((d) => {
    delete d.profile.attributes;
    d.profile.reviews = [obs({ ratingShown: '4.0', reviewCount: 130 })]; // índice abaixo de 100 para a comparação ser significativa
    d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-s3', { subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['n1'] }));
  });
  const asNv = run((d) => {
    delete d.profile.attributes;
    d.profile.reviews = [obs({ ratingShown: '4.0', reviewCount: 130 })];
  });
  assert.equal(sub(asNa, 'S3').state, 'NOT_APPLICABLE');
  assert.equal(sub(asNv, 'S3').state, 'NOT_VERIFIED');
  assert.equal(asNa.totals.evaluatedHalfPoints, asNv.totals.evaluatedHalfPoints);
  assert.equal(asNa.totals.obtainedHalfPoints, asNv.totals.obtainedHalfPoints);
  assert.equal(asNa.totals.coveragePercent, asNv.totals.coveragePercent, 'N/A não soma à cobertura');
  assert.deepEqual(asNa.index, asNv.index, 'N/A não altera o índice em relação a N/V');
  assert.equal(asNa.totals.notApplicableHalfPoints, 4);
  assert.equal(asNa.naRegistry.length, 1);
  assert.equal(asNa.naRegistry[0]?.code, 'FEATURE_UNAVAILABLE');
  assert.equal(asNa.naRegistry[0]?.operatorRecordId, 'op-na-s3');
  assert.equal(asNa.naRegistry[0]?.recordedBy, 'OPERATOR_RECORD');
  assert.ok(!JSON.stringify(asNa).includes('ana@empresa.com'), 'o e-mail do operador não é repetido no resultado');
  assert.ok(asNa.naSensitivity);
  assert.ok((asNa.naSensitivity?.shown ?? 100) < (asNa.index?.shown ?? 0), 'tratar o N/A como zero daria um índice menor');
  assert.equal(asNv.naSensitivity, null);
  assert.deepEqual(asNa.totals.eligibleCoverage, { n: 1, d: 1 }, 'cobertura dos elegíveis (196 de 196) informada à parte, sem alterar a cobertura global');
  assert.equal(asNa.totals.coveragePercent, 98);
  // o oposto: ausência comprovada (0) entra no denominador e reduz o índice
  const asZero = run((d) => {
    d.profile.attributes = [obs(0)];
    d.profile.reviews = [obs({ ratingShown: '4.0', reviewCount: 130 })];
  });
  assert.ok((asZero.index?.shown ?? 100) < (asNv.index?.shown ?? 0));
});

test('N/A derivado pelo motor: 0 avaliações, website vazio e nenhuma resposta (registro automático)', () => {
  const none = run((d) => {
    d.profile.reviews = [obs({ ratingShown: null, reviewCount: 0 })];
    delete d.profile.replies;
    delete d.profile.latestReviewDate;
    d.profile.website = [obs(null)];
  });
  const codes = Object.fromEntries(none.naRegistry.map((entry) => [entry.subcriterionId, entry.code]));
  assert.deepEqual(codes, { R1: 'NO_REVIEWS_PROVEN', R3: 'NO_REVIEWS_PROVEN', L1: 'NO_REVIEWS_PROVEN', P1: 'NO_REVIEWS_PROVEN', P2: 'NO_REVIEWS_PROVEN', P3: 'NO_REVIEWS_PROVEN', X2: 'NO_WEBSITE_PROVEN', X4: 'NO_WEBSITE_PROVEN', X5: 'NO_WEBSITE_PROVEN' });
  assert.ok(none.naRegistry.every((entry) => entry.recordedBy === 'DERIVED_BY_ENGINE' && entry.operatorRecordId === null && entry.justification.length >= 20));
  assert.equal(sub(none, 'R2').state, 'ABSENCE_PROVEN', 'o volume 0 é o zero comprovado que sobra');
  assert.equal(none.criteria.find((c) => c.id === 'REVIEW_REPLIES')?.status, 'NOT_APPLICABLE', 'todo o peso das respostas é não aplicável');
  assert.equal(none.criteria.find((c) => c.id === 'REVIEW_REPLIES')?.notApplicableHalfPoints, 16);
  assert.equal(sub(none, 'X1').state, 'ABSENCE_PROVEN');
});

test('Amostra insuficiente é um estado próprio: dado exibido, fora do denominador, sem virar N/V, N/A ou zero', () => {
  const r = run((d) => { d.profile.reviews = [obs({ ratingShown: '4.7', reviewCount: 3 })]; delete d.profile.replies; });
  const r1 = sub(r, 'R1');
  assert.equal(r1.state, 'SAMPLE_INSUFFICIENT');
  assert.notEqual(r1.state, 'NOT_VERIFIED');
  assert.equal(r1.evaluatedHalfPoints, 0);
  assert.equal(r1.obtainedHalfPoints, 0);
  assert.deepEqual(r.displayData.reviews, { ratingShown: '4.7', reviewCount: 3 });
  assert.equal(r.totals.sampleInsufficientHalfPoints, 18);
  assert.equal(r.totals.notApplicableHalfPoints, 0, 'amostra insuficiente não é peso N/A');
  assert.equal(r.criteria.find((c) => c.id === 'REVIEWS')?.status, 'PARTIAL', 'R2 pontua, R1 não: critério parcial');
  assert.match(r.limitations.map((l) => l.text).join(' '), /R1: .*Amostra insuficiente/);
  assert.deepEqual(checkResult(r), []);
});

test('base zero: sem nenhum ponto avaliado o índice é indisponível, nunca zero', () => {
  const empty = scoreAudit({ schemaVersion: 1, auditId: 'audit-vazio-01', referenceDate: '2026-10-22', evidences: [] });
  assert.ok(empty.ok);
  if (!empty.ok) return;
  const r = empty.result;
  assert.equal(r.publication.status, 'NO_DATA');
  assert.equal(r.index, null);
  assert.equal(r.confidence, null);
  assert.equal(r.naSensitivity, null);
  assert.equal(r.totals.evaluatedHalfPoints, 0);
  assert.equal(r.totals.coveragePercent, 0);
  assert.equal(r.totals.eligibleCoverage?.n, 0);
  assert.ok(r.subcriteria.every((s) => s.state === 'NOT_VERIFIED' && s.obtainedHalfPoints === 0 && s.evaluatedHalfPoints === 0), 'nenhum Não verificado recebe zero');
  assert.ok(r.criteria.every((c) => c.status === 'NOT_VERIFIED'), 'critério sem nenhum ponto avaliado é Não verificado (exibe N/V, nunca 0)');
  assert.match(r.publication.statusText, /Índice indisponível.*nunca é zero/);
  const nothingUsable = run((d) => {
    d.evidences.forEach((e: Mutable) => { e.status = 'NOT_VERIFIED'; });
  });
  assert.equal(nothingUsable.publication.status, 'NO_DATA', 'evidências não verificadas não geram pontos');
  assert.equal(nothingUsable.index, null);
});

test('propriedade: nenhum Não verificado, N/A ou Amostra insuficiente vira zero, em 300 perfis incompletos', () => {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const keys = Object.keys(richInput().profile);
  for (let round = 0; round < 300; round++) {
    const draft = clone(richInput());
    for (const key of keys) if (next() < 0.45) delete draft.profile[key];
    if (next() < 0.3) delete draft.site;
    if (next() < 0.3) delete draft.competitors;
    if (next() < 0.3) delete draft.nap;
    if (next() < 0.3) delete draft.authority;
    // registros que dependem de escopo/fatos removidos
    draft.operatorRecords = draft.operatorRecords.filter((r: Mutable) => draft.site || (r.kind !== 'SITE_SCOPE_ATTESTATION' && r.kind !== 'OBSERVATION_CONFIRMATION'));
    const outcome = scoreAudit(draft);
    if (!outcome.ok) continue; // combinações inconsistentes são recusadas (ex.: determinação sem registro)
    const r = outcome.result;
    assert.deepEqual(checkResult(r), [], `rodada ${round}`);
    for (const s of r.subcriteria) {
      if (s.state === 'NOT_VERIFIED' || s.state === 'NOT_APPLICABLE' || s.state === 'SAMPLE_INSUFFICIENT') {
        assert.equal(s.obtainedHalfPoints, 0);
        assert.equal(s.evaluatedHalfPoints, 0);
      } else {
        assert.equal(s.evaluatedHalfPoints, s.maxHalfPoints);
        assert.ok(s.obtainedHalfPoints >= 0 && s.obtainedHalfPoints <= s.evaluatedHalfPoints);
      }
    }
    const partition = r.totals.evaluatedHalfPoints + r.totals.notApplicableHalfPoints + r.totals.sampleInsufficientHalfPoints + r.totals.notVerifiedHalfPoints;
    assert.equal(partition, 200);
    for (const c of r.criteria) assert.ok(c.obtainedHalfPoints <= c.evaluatedHalfPoints && c.evaluatedHalfPoints <= c.weight * 2);
    if (r.totals.evaluatedHalfPoints === 0) assert.equal(r.index, null);
  }
});

test('checkResult detecta adulteração de qualquer parte derivada do resultado', () => {
  const base = JSON.parse(JSON.stringify(run())) as Mutable;
  const cases: Array<[string, (r: Mutable) => void]> = [
    ['ponto acima do máximo', (r) => { r.subcriteria[0].obtainedHalfPoints = 99; }],
    ['avaliado diferente do máximo', (r) => { r.subcriteria[1].evaluatedHalfPoints = 1; }],
    ['pontos em item Não verificado', (r) => { r.subcriteria[2].state = 'NOT_VERIFIED'; }],
    ['totais adulterados', (r) => { r.totals.obtainedHalfPoints = 1; }],
    ['critério adulterado', (r) => { r.criteria[0].obtainedHalfPoints = 0; }],
    ['índice adulterado', (r) => { r.index.shown = 12; }],
    ['classificação adulterada', (r) => { r.index.classification = 'CRITICAL'; }],
    ['publicação adulterada', (r) => { r.publication.status = 'PROVISIONAL'; }],
    ['confiança adulterada', (r) => { r.confidence.level = 'LOW'; }],
    ['ponto sem rastreabilidade', (r) => { r.subcriteria[3].evidenceIds = []; r.subcriteria[3].operatorRecordIds = []; }],
    ['subcritério ausente', (r) => { r.subcriteria.pop(); }],
  ];
  for (const [label, tamper] of cases) {
    const copy = clone(base);
    tamper(copy);
    assert.notDeepEqual(checkResult(copy as ScoreResult), [], label);
  }
});

/* ---------------------------------------------------------------- TUVAPLAST (somente leitura; sem publicar índice) */

const TUVA_DIR = process.env.GMN_TUVAPLAST_EVIDENCE_DIR ?? '/mnt/d/gmn-evidencias-privadas/link-audit/tuvaplast-20261022-maps01';
const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('TUVAPLAST (captura preservada, somente leitura): 28–30 pontos avaliáveis, índice indisponível, nenhuma nota', { skip: !fs.existsSync(path.join(TUVA_DIR, 'report.json')) }, () => {
  const files = fs.readdirSync(TUVA_DIR).map((name) => path.join(TUVA_DIR, name)).filter((file) => fs.statSync(file).isFile());
  const before = files.map((file) => sha(file));
  const report = JSON.parse(fs.readFileSync(path.join(TUVA_DIR, 'report.json'), 'utf8')) as {
    data: { googleMaps: { name: string; address: string; phone: string; website: string; category: string; rating: number; ratingCount: number; openingHours: unknown[] } };
    evidences: Array<{ id: string; status: string }>;
  };
  const maps = report.data.googleMaps;
  const verified = new Set(report.evidences.filter((e) => e.status === 'VERIFIED').map((e) => e.id));
  assert.equal(verified.size, 8);
  const captureSha = sha(path.join(TUVA_DIR, 'serper-body.json'));
  const input: Mutable = {
    schemaVersion: 1,
    auditId: 'tuvaplast-leitura-01',
    referenceDate: '2026-10-22',
    evidences: [{ id: 'maps', origin: 'GOOGLE_NATIVE', capture: 'STORED_CAPTURE', status: 'VERIFIED', observedAt: '2026-10-22T12:54:48.079Z', contentSha256: captureSha }],
    profile: {
      name: [obs(maps.name, { ids: ['maps'] })],
      address: [obs({ raw: maps.address, parsed: { street: 'x', number: '1', city: 'x', state: 'SP' } }, { ids: ['maps'] })],
      phone: [obs(maps.phone, { ids: ['maps'] })],
      hours: [obs({ kind: 'STRUCTURED', days: [0, 1, 2, 3, 4, 5, 6].slice(0, maps.openingHours.length).map((day) => ({ day, closed: false, intervals: [['08:00', '17:00']] })) }, { ids: ['maps'] })],
      website: [obs(maps.website, { ids: ['maps'] })],
      primaryCategory: [obs(maps.category, { ids: ['maps'] })],
      reviews: [obs({ ratingShown: String(maps.rating), reviewCount: maps.ratingCount }, { ids: ['maps'] })],
    },
    site: { scope: { kind: 'NONE', pagesRead: [], requestCap: 8, capReached: false, blockers: ['401/403/desafio'], limitations: [] }, accessibility: { evidenceIds: ['maps'], outcome: 'BLOCKED' } },
  };
  input.site.accessibility.evidenceIds = ['maps'];
  input.evidences.push({ id: 'site-blocked', origin: 'OFFICIAL_SITE', capture: 'STORED_CAPTURE', status: 'VERIFIED', observedAt: '2026-10-22T12:54:48.079Z', contentSha256: captureSha });
  input.site.accessibility.evidenceIds = ['site-blocked'];
  const outcome = scoreAudit(input);
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join(' | '));
  if (!outcome.ok) return;
  const r = outcome.result;
  assert.equal(r.index, null, 'nenhum índice é publicado para a TUVAPLAST');
  assert.equal(r.confidence, null);
  assert.equal(r.publication.status, 'INSUFFICIENT');
  assert.ok(r.totals.coveragePercent >= 28 && r.totals.coveragePercent <= 30, `cobertura ${r.totals.coveragePercent}`);
  assert.equal(sub(r, 'R1').state, 'SCORED', '49 avaliações: nota elegível');
  assert.deepEqual(r.displayData.reviews, { ratingShown: String(maps.rating), reviewCount: maps.ratingCount });
  for (const id of ['N5', 'C2', 'C3', 'S5', 'V5', 'R3', 'P1', 'X2', 'X4', 'A1', 'L1', 'L3'] as const) {
    assert.notEqual(sub(r, id).state, 'SCORED', `${id} não pode pontuar sem evidência`);
  }
  assert.equal(sub(r, 'X2').state, 'NOT_VERIFIED', 'site com 401/403/desafio: acesso Não verificado, nunca zero');
  assert.deepEqual(files.map((file) => sha(file)), before, 'a captura preservada não foi alterada');
});

/* ---------------------------------------------------------------- achados da revisão independente */
test('a régua é imutável em tempo de execução e a impressão digital confere com os dados atuais', () => {
  assert.ok(Object.isFrozen(TIERS) && Object.isFrozen(TIERS.R2) && Object.isFrozen(TIERS.R2[0]));
  assert.throws(() => { (TIERS.R2[0] as unknown as Mutable).halfPoints = 0; }, TypeError);
  assert.throws(() => { (RULES as unknown as Mutable).minCoveragePercent = 0; }, TypeError);
  assert.throws(() => { (NA_RULES.BUSINESS_MODEL.subcriteria as unknown as string[]).push('R1'); }, TypeError);
  assert.throws(() => { (SUBCRITERIA[0] as unknown as Mutable).maxHalfPoints = 99; }, TypeError);
  assert.throws(() => { (VALIDATED_DETECTORS as unknown as string[]).push('x'); }, TypeError);
  assert.equal(sha256OfCanonical(RULER_DATA), RULER_FINGERPRINT);
});

test('N/A "recurso indisponível" não esconde um zero comprovado: lista exposta/lida, mesmo vazia, contradiz a causa', () => {
  const na = (ids: string[], code = 'FEATURE_UNAVAILABLE') => (d: Mutable) => { d.operatorRecords.push(record('NOT_APPLICABLE', 'op-na-z', { subcriterionIds: ids, code, causeEvidenceIds: ['n1'] })); };
  rejects((d) => { d.profile.posts = [obs({ exposed: true, items: [] })]; na(['A1', 'A2', 'A3'])(d); }, /causa é contrariada/);
  rejects((d) => { d.profile.attributes = [obs(0)]; na(['S3'])(d); }, /causa é contrariada/);
  const ok = run((d) => { d.profile.posts = [obs({ exposed: false, items: [] })]; na(['A1', 'A2', 'A3'])(d); });
  assert.equal(sub(ok, 'A1').state, 'NOT_APPLICABLE', 'campo não exposto pela fonte: o N/A com causa documentada é aceito');
  rejects((d) => { delete d.profile.attributes; d.operatorRecords.push({ ...record('NOT_APPLICABLE', 'op-na-z', { subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE' }), attachmentSha256: 'a'.repeat(64) }); }, /exige evidência da causa/);
});

test('entrada gigante ou hostil nunca derruba o motor, nem gera saída gigante', () => {
  const started = Date.now();
  const huge = scoreAudit({ evidences: Array.from({ length: 150_000 }, () => ({ points: 1 })) });
  assert.equal(huge.ok, false);
  const many = scoreAudit({ evidences: Array.from({ length: 100 }, () => ({ points: 1 })) });
  assert.equal(many.ok, false);
  if (!many.ok) assert.ok(many.issues.length <= 20, 'achados limitados');
  const deep: Mutable = {};
  let cursor = deep;
  for (let i = 0; i < 5000; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.equal(scoreAudit(deep).ok, false);
  assert.equal(scoreAudit(JSON.parse('{"__proto__": {"polluted": true}}')).ok, false);
  assert.equal(({} as Mutable).polluted, undefined);
  for (const bad of [null, undefined, 42, 'x', [], () => 1]) assert.equal(scoreAudit(bad).ok, false);
  assert.ok(Date.now() - started < 10_000);
});

test('sitemap incoerente com o limite do coletor, data/hora impossível e agregador como perfil do Google são recusados', () => {
  rejects((d) => { d.site.scope.sitemap = { urlsListed: 5000, urlsRead: 5000 }; }, /excedem o limite de requisições/);
  rejects((d) => { d.evidences[0].observedAt = '2026-10-20T99:99:99-03:00'; }, /data\/hora inválida/);
  rejects((d) => { d.evidences[0].capture = 'AGGREGATOR'; delete d.evidences[0].contentSha256; }, /AGGREGATOR só pode ter origem THIRD_PARTY/);
});

test('revisão completa documentada rebaixa a evidência a secundária (S5, X4, V5)', () => {
  const r = run((d) => {
    d.site.scope = { kind: 'DOCUMENTED_FULL_REVIEW', pagesRead: [d.site.scope.pagesRead[0]], requestCap: 8, capReached: true, blockers: [], limitations: ['Áreas logadas não foram revisadas.'] };
  });
  for (const id of ['S5', 'X4', 'V5'] as const) assert.equal(sub(r, id).grade, 'SECONDARY', id);
  assert.equal(sub(run(), 'S5').grade, 'PRIMARY', 'sitemap + atestado segue primária');
});

test('R3 com leitura incompleta não decide pela data vista (pode haver avaliação mais nova)', () => {
  const r = run((d) => { d.profile.latestReviewDate = [obs({ kind: 'EXACT', date: '2026-03-01' }, { complete: false })]; });
  assert.equal(sub(r, 'R3').state, 'NOT_VERIFIED');
  assert.equal(sub(r, 'R3').reasonCode, 'INDECISIVE_RANGE');
  const top = run((d) => { d.profile.latestReviewDate = [obs({ kind: 'EXACT', date: '2026-10-10' }, { complete: false })]; });
  assert.equal(sub(top, 'R3').obtainedHalfPoints, 12);
});

test('X5: nomes de parâmetros desconhecidos não são ecoados e valor vazio não é "sem chaves"', () => {
  const r = run((d) => { d.profile.website = [obs('https://exemplo.com.br/?utm_segredo123=1')]; });
  assert.equal(sub(r, 'X5').obtainedHalfPoints, 2);
  assert.ok(!JSON.stringify(r).includes('segredo123'));
  const empty = run((d) => { d.profile.website = [obs('https://exemplo.com.br/?utm_source=&utm_medium=')]; });
  assert.match(sub(empty, 'X5').reason, /com valor preenchido/);
});

test('registro de modelos: chaves herdadas não são versões; checkResult não é exportado como verificação', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const outcome = scoreAudit(richInput(), { scoreModelVersion: key });
    assert.equal(outcome.ok, false, key);
    if (!outcome.ok) assert.match(outcome.issues.join(' '), /desconhecida/);
  }
  assert.equal(verifyScoreResult({ scoreModelVersion: 'constructor', methodologyVersion: 'lumos-reconstruida-v1' }, richInput()).ok, false);
  assert.equal(typeof checkResult, 'function');
  assert.equal('checkResult' in scoring, false);
});

test('N2: texto não decomposto vira Não verificado; só a declaração explícita de ausência é zero', () => {
  const r = run((d) => { d.profile.address = [obs({ raw: 'Rua das Flores, 100, Centro, GO', parsed: {} })]; });
  assert.equal(sub(r, 'N2').state, 'NOT_VERIFIED');
  assert.equal(sub(r, 'N2').reasonCode, 'ADDRESS_UNPARSED');
});
