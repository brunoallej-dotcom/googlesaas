import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAuditIdAlias } from '../src/lib/link-audit-scoring-runs/audit-id-alias';
import { readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { toPublicRun, verifyRunRecord } from '../src/lib/link-audit-scoring-runs/results-verify';
import { registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, OP_B, resultsEnv, RES_AUDIT, type Spec } from './helpers/link-audit-results-fixtures';

/*
 * Onda 6C, I4 — verificação SEMÂNTICA do registro. O selo e os recibos provam que os bytes são os gravados; aqui se prova que o conteúdo
 * ainda se explica a partir de si mesmo, mesmo quando alguém recalculou o selo (ou controla as duas pastas). Fixtures fictícias.
 */
registerCleanup();

async function recordFor(spec: Spec): Promise<ScoreRun> {
  const e = resultsEnv();
  const auditId = spec.auditId ?? RES_AUDIT;
  const ev = buildEvaluation(spec);
  const finalized = await makeService(e, new FakeEvaluator(ev)).finalize(OP_B, auditId, bodyOf(ev));
  assert.ok(finalized.ok, JSON.stringify(finalized));
  const read = await readRunLog(e.base, auditId, { anchorDir: e.anchors });
  assert.ok(read.ok && read.value.runs.length === 1);
  return structuredClone(read.value.runs[0] as ScoreRun);
}

let scored: ScoreRun;
let otherAudit: ScoreRun;
let inconclusive: ScoreRun;
let withWebsite: ScoreRun;
test('preparo: registros reais (PONTUADO, INCONCLUSIVO, com website) gravados pelo serviço', async () => {
  [scored, inconclusive, withWebsite, otherAudit] = await Promise.all([recordFor({ kind: 'PONTUADO' }), recordFor({ kind: 'INCONCLUSIVO' }), recordFor({ kind: 'PONTUADO', website: true }), recordFor({ kind: 'PONTUADO', auditId: 'auditoria-outra-0009' })]);
  assert.equal(scored.outcome, 'PONTUADO');
  assert.equal(inconclusive.outcome, 'INCONCLUSIVO');
  assert.ok(withWebsite.websiteDerivation);
});

test('registros íntegros passam (e a verificação não altera o registro nem depende de ordem)', () => {
  for (const run of [scored, inconclusive, withWebsite]) {
    const before = JSON.stringify(run);
    assert.deepEqual(verifyRunRecord(run), []);
    assert.deepEqual(verifyRunRecord(run), []);
    assert.equal(JSON.stringify(run), before);
  }
});

type Mutation = readonly [name: string, apply: (run: ScoreRun) => void, base?: () => ScoreRun];
const any = (value: unknown): Record<string, any> => value as Record<string, any>;
const MUTATIONS: readonly Mutation[] = [
  ['resultado: índice trocado', (r) => void (any(r.result).index.shown = 1)],
  ['resultado: hash do resultado trocado', (r) => void (any(r.result).resultSha256 = 'f'.repeat(64))],
  ['resultado: pontos obtidos alterados', (r) => void (any(r.result).totals.obtainedHalfPoints = 1)],
  ['resultado: confiança trocada', (r) => void (any(r.result).confidence = null)],
  ['resultado: removido', (r) => void (r.result = {})],
  ['entrada: valor do perfil alterado', (r) => void (any(r.input).profile.name[0].value = 'Outra Padaria')],
  ['entrada: avaliações inseridas (M-4a)', (r) => void (any(r.input).profile.reviews = [{ evidenceIds: ['capture:c0001'], complete: false, value: { ratingShown: '5.0', reviewCount: 9 } }])],
  ['entrada: campo marcado completo sem prova', (r) => void (any(r.input).profile.phone[0].complete = true)],
  ['entrada: removida', (r) => void (r.input = {})],
  ['entrada: hash da entrada trocado', (r) => void (r.inputSha256 = 'e'.repeat(64))],
  ['hash do resultado do registro trocado', (r) => void (r.resultSha256 = 'd'.repeat(64))],
  ['desfecho: PONTUADO declarado INCONCLUSIVO', (r) => void (r.outcome = 'INCONCLUSIVO')],
  ['desfecho: nível trocado', (r) => void (r.scored = { level: r.scored?.level === 'PUBLICAVEL' ? 'PROVISORIO' : 'PUBLICAVEL' })],
  ['desfecho: PONTUADO com motivo de inconclusivo', (r) => void (r.inconclusive = { reasonCode: 'COBERTURA_INSUFICIENTE', failedGates: [], coveragePercent: 1, minimumCoveragePercent: 40 })],
  ['versão da metodologia trocada', (r) => void (r.methodologyVersion = 'outra-metodologia')],
  ['versão do modelo desconhecida', (r) => void (r.scoreModelVersion = 'modelo-que-nao-existe')],
  ['impressão digital da régua trocada', (r) => void (r.rulerFingerprint = 'c'.repeat(64))],
  ['versão do mapeador desconhecida', (r) => void (r.mapperVersion = 'mapeador-que-nao-existe')],
  ['alias: aplicado sem regra', (r) => void (r.auditIdAlias = { ...r.auditIdAlias, applied: true })],
  ['alias: id de origem diferente da auditoria', (r) => void (r.auditIdAlias = { ...r.auditIdAlias, sourceAuditId: 'auditoria-outra-0009' })],
  ['alias: id do motor diferente do gravado', (r) => void (r.scoringAuditId = 'auditoria-trocada-0009')],
  ['data de referência trocada', (r) => void (r.referenceDate = '2026-10-21')],
  ['fonte da data de referência de outro dia', (r) => void (r.referenceDateSource = { ...r.referenceDateSource, observedAt: '2026-10-20T10:00:00.000Z' })],
  ['fonte da data de referência fora da base', (r) => void (r.referenceDateSource = { ...r.referenceDateSource, ref: 'capture:c0099' })],
  ['base de evidências: item removido', (r) => void r.evidenceBasis.pop()],
  ['base de evidências: hash de uma captura trocado (mesmo número e data)', (r) => void (r.evidenceBasis[1] = { ...r.evidenceBasis[1]!, contentSha256: 'b'.repeat(64) })],
  ['base de evidências: data trocada', (r) => void (r.evidenceBasis[1] = { ...r.evidenceBasis[1]!, observedAt: '2026-10-19T10:00:00.000Z' })],
  ['base de evidências: referência repetida', (r) => void (r.evidenceBasis[1] = { ...r.evidenceBasis[0]! })],
  ['fonte do perfil fora da base', (r) => void (r.profileSource = { ref: 'capture:c0099', observedAt: '2026-10-22T10:00:00.000Z', contentSha256: 'a'.repeat(64), bodySha256: 'a'.repeat(64) })],
  ['decisões aplicadas: id a mais', (r) => void (r.decisions = { ...r.decisions, appliedIds: [...r.decisions.appliedIds, 'op-fantasma'] })],
  ['decisões aplicadas: id trocado por outro (mesmo tamanho)', (r) => void ((r.decisions = { ...r.decisions, appliedIds: ['op-fantasma', ...r.decisions.appliedIds.slice(1)], applied: [{ ...r.decisions.applied[0]!, decisionId: 'op-fantasma' }, ...r.decisions.applied.slice(1)] }))],
  ['decisões aplicadas: id a menos', (r) => void (r.decisions = { ...r.decisions, appliedIds: r.decisions.appliedIds.slice(1) })],
  ['decisões aplicadas: carimbo fora de ordem', (r) => void (r.decisions = { ...r.decisions, applied: [...r.decisions.applied].reverse() })],
  ['registro coerente de OUTRA auditoria rotulado com este auditId/alias (entrada do motor com outro id)', (r) => {
    const alias = deriveAuditIdAlias('auditoria-outra-0009')!;
    r.auditId = alias.sourceAuditId;
    r.auditIdAlias = { applied: alias.applied, rule: alias.rule, reason: alias.reason, sourceAuditId: alias.sourceAuditId };
    r.scoringAuditId = alias.scoringAuditId;
  }],
  ['registro da OUTRA auditoria guardado com o auditId desta (alias de origem diferente)', (r) => void (r.auditId = 'auditoria-res-0001'), () => otherAudit],
  ['fonte da data de referência com data diferente da base (mesmo dia)', (r) => void (r.referenceDateSource = { ...r.referenceDateSource, observedAt: '2026-10-22T11:11:11.000Z' })],
  ['fonte do perfil com hash diferente da base', (r) => void (r.profileSource = { ...r.profileSource!, contentSha256: '9'.repeat(64) })],
  ['derivação do website com hash de origem diferente da base', (r) => void (r.websiteDerivation = { ...r.websiteDerivation!, sourceEvidence: { ...r.websiteDerivation!.sourceEvidence, contentSha256: '8'.repeat(64) } }), () => withWebsite],
  ['contagem de decisões menor que a das aplicadas', (r) => void (r.decisions = { ...r.decisions, count: 1 })],
  ['website completo sem a derivação registrada', (r) => void (r.websiteDerivation = null), () => withWebsite],
  ['website completo com prova de X5 trocada', (r) => void (r.websiteDerivation = { ...r.websiteDerivation!, x5Proof: 'NOT_PROVEN' }), () => withWebsite],
  ['website completo com UTM parcial', (r) => void (r.websiteDerivation = { ...r.websiteDerivation!, utmLevel: 'PARTIAL' }), () => withWebsite],
  ['derivação do website aponta para evidência fora da base', (r) => void (r.websiteDerivation = { ...r.websiteDerivation!, sourceEvidence: { ...r.websiteDerivation!.sourceEvidence, ref: 'capture:c0099' } }), () => withWebsite],
  ['inconclusivo: motivo trocado', (r) => void (r.inconclusive = { ...r.inconclusive!, reasonCode: 'SEM_DADOS_AVALIADOS' }), () => inconclusive],
  ['inconclusivo: cobertura trocada', (r) => void (r.inconclusive = { ...r.inconclusive!, coveragePercent: 99 }), () => inconclusive],
  ['inconclusivo: portões trocados', (r) => void (r.inconclusive = { ...r.inconclusive!, failedGates: [] }), () => inconclusive],
  ['inconclusivo: declarado PONTUADO', (r) => void ((r.outcome = 'PONTUADO'), (r.scored = { level: 'PROVISORIO' })), () => inconclusive],
];

for (const [name, apply, base] of MUTATIONS) {
  test(`adulteração com selo recalculado é denunciada: ${name}`, () => {
    const run = structuredClone(base ? base() : scored);
    assert.deepEqual(verifyRunRecord(run), [], 'o ponto de partida é íntegro');
    apply(run);
    const problems = verifyRunRecord(run);
    assert.ok(problems.length > 0, 'a mutação passou despercebida');
    // texto FIXO: nunca ecoa valores do registro (hash, id, e-mail, data)
    for (const problem of problems) assert.ok(problem.length < 140 && !/[0-9a-f]{20,}|@|auditoria-/.test(problem), problem);
  });
}

test('V12: entrada e resultado REFEITOS com outra data de referência (selo e hashes coerentes) não passam: a data pública é a gravada', async () => {
  const { scoreAudit } = await import('../src/lib/link-audit/scoring/index');
  const { parseScoringInput } = await import('../src/lib/link-audit/scoring/index');
  const r = structuredClone(scored);
  const moved = { ...(r.input as Record<string, unknown>), referenceDate: '2026-10-23' };
  const out = scoreAudit(moved);
  const parsed = parseScoringInput(moved);
  assert.ok(out.ok && parsed.ok);
  r.input = JSON.parse(JSON.stringify(parsed.input));
  r.result = JSON.parse(JSON.stringify(out.result));
  r.inputSha256 = out.result.inputSha256;
  r.resultSha256 = out.result.resultSha256;
  assert.ok(verifyRunRecord(r).length > 0, 'referenceDate de entrada diferente da gravada tem de ser denunciada');
});

test('projeção pública: lista fechada de campos; sem entrada, sem hash bruto, sem e-mail nem justificativa das decisões, sem pontos em INCONCLUSIVO', () => {
  for (const run of [scored, inconclusive, withWebsite]) {
    const { detail, outcomePreview } = toPublicRun(run);
    assert.deepEqual(Object.keys(detail).sort(), ['auditId', 'auditIdAlias', 'decisions', 'definitive', 'evidence', 'finalizedAt', 'finalizedBy', 'hashes', 'inconclusive', 'level', 'outcome', 'result', 'scoringAuditId', 'seq', 'versions', 'website'].sort());
    assert.deepEqual(Object.keys((detail as any).decisions).sort(), ['appliedIds', 'count', 'head'], 'o carimbo interno das decisões não sai');
    const text = JSON.stringify(detail);
    assert.ok(!/Conferido no painel|justification":"Conferido|"input"|rawSha256|operatorEmail/.test(text));
    assert.equal(detail.definitive, true);
    assert.equal(outcomePreview.outcome, run.outcome);
  }
  const publicInconclusive = toPublicRun(inconclusive).detail as Record<string, any>;
  assert.equal(publicInconclusive.result.index, null);
  assert.equal(publicInconclusive.result.confidence, null);
  assert.ok(!/\(\d+(?:[.,]\d+)? de \d+(?:[.,]\d+)? pontos?\)/.test(JSON.stringify(publicInconclusive)), 'razão "(X de Y pontos)" não pode sair em INCONCLUSIVO');
  assert.ok(!('obtainedHalfPoints' in publicInconclusive.result.totals));
  const publicScored = toPublicRun(scored).detail as Record<string, any>;
  assert.ok(publicScored.result.index !== null && publicScored.result.confidence !== null);
  const site = toPublicRun(withWebsite).detail as Record<string, any>;
  assert.deepEqual(Object.keys(site.website).sort(), ['rule', 'utmLevel', 'x5Proof']);
});
