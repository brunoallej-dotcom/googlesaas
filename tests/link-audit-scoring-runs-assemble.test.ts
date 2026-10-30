import assert from 'node:assert/strict';
import { deriveAuditIdAlias } from '../src/lib/link-audit-scoring-runs/audit-id-alias';
import test from 'node:test';
import { parseScoringInput, scoreAudit, type OperatorRecord, type ScoringInput, type ScoreResult, type SubcriterionId } from '../src/lib/link-audit/scoring';
import { SUBCRITERIA } from '../src/lib/link-audit/scoring/ruler';
import { assembleScoringInput } from '../src/lib/link-audit-scoring-runs/assemble';
import { CRITERIA_SOURCES } from '../src/lib/link-audit-scoring-runs/criteria-sources';
import { MAPPER_VERSION, type AssembleResult, type MapperBlocker } from '../src/lib/link-audit-scoring-runs/types';
import type { BasisProfile } from '../src/lib/link-audit-evidence/scoring-basis';
import {
  ALL_VERIFIED,
  AUDIT,
  BODY_HASH,
  c2Judgement,
  CAPTURE_HASH,
  captureEvidence,
  hash,
  makeBasis,
  NO_UTM_WEBSITE,
  NOW,
  OBSERVED,
  PARTIAL_UTM_WEBSITE,
  RAW_WEBSITE_HASH,
  reportEvidence,
  richProfile,
  s4NotApplicable,
  UNPARSABLE_WEBSITE,
  unavailable,
  website,
} from './helpers/link-audit-mapper-fixtures';

/*
 * Onda 6C, I2 — o mapeador determinístico. Dados 100% FICTÍCIOS. O mapeador é puro e não pontua; aqui o motor REAL (6A) é
 * usado só como árbitro: a saída do mapeador precisa ser aceita pelo contrato e produzir exatamente o que a matriz promete.
 */
const run = (basis = makeBasis(), records: readonly OperatorRecord[] = [], now = NOW): AssembleResult => assembleScoringInput(basis, records, { now });
const inputOf = (out: AssembleResult): ScoringInput => {
  assert.ok(out.input, `sem entrada: ${JSON.stringify(out.blockers)} ${JSON.stringify(out.contractIssues)}`);
  return out.input;
};
const scoreOf = (out: AssembleResult): ScoreResult => {
  const outcome = scoreAudit(inputOf(out));
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('; '));
  return outcome.result;
};
const sub = (result: ScoreResult, id: string) => result.subcriteria.find((item) => item.id === id) as ScoreResult['subcriteria'][number];
const codes = (out: AssembleResult): string[] => out.blockers.map((b) => `${b.severity}:${b.code}`);
const find = (out: AssembleResult, code: string): MapperBlocker | undefined => out.blockers.find((b) => b.code === code);
const withProfile = (over: Partial<Extract<BasisProfile, { state: 'AVAILABLE' }>>) => makeBasis({ profile: richProfile(over) });
const clone = <T,>(value: T): T => structuredClone(value);
const deepKeys = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((item) => deepKeys(item, found));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) (found.push(key), deepKeys(child, found));
  return found;
};

/* ---------------------------------------------------------------- 1. contrato */
test('base completa ⇒ entrada aceita pelo contrato do motor, idempotente, sem nenhum campo além dos fatos observados', () => {
  const out = run();
  const input = inputOf(out);
  assert.deepEqual(Object.keys(input).sort(), ['auditId', 'evidences', 'profile', 'referenceDate', 'schemaVersion']);
  assert.deepEqual(Object.keys(input.profile ?? {}).sort(), ['additionalCategories', 'address', 'hours', 'name', 'phone', 'primaryCategory', 'website']);
  const reparsed = parseScoringInput(input);
  assert.ok(reparsed.ok);
  assert.deepEqual(reparsed.input, input, 'a entrada devolvida já é a normalizada');
  assert.deepEqual(out.blockers, []);
  assert.deepEqual(out.contractIssues, []);
  assert.equal(out.traceability.mapperVersion, MAPPER_VERSION);
  assert.equal(MAPPER_VERSION, 'lumos-map-v1');
  assert.equal(out.traceability.basisVersion, 'scoring-basis-v1');
});

test('o hash da entrada é o MESMO que o motor grava no resultado (e o do rastro)', () => {
  const out = run(makeBasis(), [c2Judgement()]);
  const result = scoreOf(out);
  assert.equal(out.inputSha256, result.inputSha256);
  assert.equal(out.traceability.inputSha256, result.inputSha256);
  assert.match(out.inputSha256 as string, /^[a-f0-9]{64}$/);
});

/* ---------------------------------------------------------------- 2. mapeador × matriz (35 subcritérios) */
type Expectation = { state: 'SCORED' | 'NOT_VERIFIED'; evaluated: number; reason?: string; source: string; why: string | null; emitted: boolean };
const NV = (reason: string, why: string, emitted = false): Expectation => ({ state: 'NOT_VERIFIED', evaluated: 0, reason, source: 'BLOQUEADO', why, emitted });
const NOBS = (why: string): Expectation => NV('NO_OBSERVATION', why);
const MATRIX: Readonly<Record<SubcriterionId, Expectation>> = {
  N1: { state: 'SCORED', evaluated: 6, source: 'AUTOMATICO', why: null, emitted: true },
  N2: NV('ADDRESS_UNPARSED', 'ADDRESS_NOT_STRUCTURED', true),
  N3: { state: 'SCORED', evaluated: 6, source: 'AUTOMATICO', why: null, emitted: true },
  N4: NV('HOURS_UNSTRUCTURED', 'HOURS_NOT_STRUCTURED', true),
  N5: NV('NAP_NOT_COMPARABLE', 'NO_EXTERNAL_SOURCE'),
  C1: { state: 'SCORED', evaluated: 6, source: 'AUTOMATICO', why: null, emitted: true },
  C2: { state: 'NOT_VERIFIED', evaluated: 0, reason: 'OPERATOR_CONFIRMATION_REQUIRED', source: 'DECISAO_HUMANA', why: 'AWAITING_OPERATOR_DECISION', emitted: true },
  C3: NV('FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'COMPLETENESS_NOT_PROVEN', true),
  S1: NOBS('NOT_COLLECTED'),
  S2: NOBS('NOT_COLLECTED'),
  S3: NOBS('NOT_COLLECTED'),
  S4: NOBS('NOT_COLLECTED'),
  S5: NV('SITE_NOT_READ', 'SITE_NOT_READ'),
  R1: NOBS('M4A_EXCLUDED'),
  R2: NOBS('M4A_EXCLUDED'),
  R3: NOBS('NOT_COLLECTED'),
  P1: NOBS('NOT_COLLECTED'),
  P2: NOBS('NOT_COLLECTED'),
  P3: NOBS('NOT_COLLECTED'),
  V1: NOBS('NOT_COLLECTED'),
  V2: NOBS('NOT_COLLECTED'),
  V3: NOBS('NOT_COLLECTED'),
  V4: NOBS('NOT_COLLECTED'),
  V5: NV('OPERATOR_CONFIRMATION_REQUIRED', 'SITE_NOT_READ'),
  A1: NOBS('NOT_COLLECTED'),
  A2: NOBS('NOT_COLLECTED'),
  A3: NOBS('NOT_COLLECTED'),
  X1: { state: 'SCORED', evaluated: 4, source: 'AUTOMATICO', why: null, emitted: true },
  X2: NV('SITE_NOT_READ', 'SITE_NOT_READ'),
  X3: NOBS('NOT_COLLECTED'),
  X4: NV('SITE_NOT_READ', 'SITE_NOT_READ'),
  X5: { state: 'SCORED', evaluated: 4, source: 'AUTOMATICO', why: null, emitted: true },
  L1: NOBS('COMPETITORS_NOT_COLLECTED'),
  L2: NOBS('COMPETITORS_NOT_COLLECTED'),
  L3: NOBS('AUTHORITY_NOT_COLLECTED'),
};

test('MATRIZ ×35: perfil rico com UTM completo comprovado ⇒ cada subcritério tem a fonte, o motivo e o estado do motor previstos', () => {
  const out = run();
  const result = scoreOf(out);
  assert.equal(out.criteriaView.length, 35);
  assert.deepEqual(out.criteriaView.map((row) => row.id), SUBCRITERIA.map((def) => def.id));
  for (const def of SUBCRITERIA) {
    const want = MATRIX[def.id];
    const view = out.criteriaView.find((row) => row.id === def.id);
    const engine = sub(result, def.id);
    assert.deepEqual([view?.source, view?.reasonCode, view?.factEmitted, view?.criterionId, view?.maxHalfPoints], [want.source, want.why, want.emitted, def.criterionId, def.maxHalfPoints], `${def.id}: visão`);
    assert.equal(engine.state, want.state, `${def.id}: estado do motor`);
    assert.equal(engine.evaluatedHalfPoints, want.evaluated, `${def.id}: avaliado`);
    if (want.state === 'NOT_VERIFIED') {
      assert.equal(engine.obtainedHalfPoints, 0, `${def.id}: N/V nunca vira zero obtido`);
      if (want.reason) assert.equal(engine.reasonCode, want.reason, `${def.id}: motivo do motor`);
    }
  }
  assert.equal(result.totals.evaluatedHalfPoints, 26);
  assert.equal(result.totals.coveragePercent, 13);
});

test('MATRIZ: cada subcritério AUTOMÁTICO perde exatamente o seu peso quando o fato não existe (e vira "sem dado", nunca zero)', () => {
  const cases: Array<[string, Partial<Extract<BasisProfile, { state: 'AVAILABLE' }>>, SubcriterionId, number]> = [
    ['name', { name: null }, 'N1', 6],
    ['phone', { phone: null }, 'N3', 6],
    ['primaryCategory', { primaryCategory: null }, 'C1', 6],
    ['website', { website: null }, 'X1', 4],
  ];
  for (const [field, over, id, weight] of cases) {
    const out = run(withProfile(over));
    const result = scoreOf(out);
    const engine = sub(result, id);
    assert.deepEqual([engine.state, engine.evaluatedHalfPoints, engine.obtainedHalfPoints, engine.reasonCode], ['NOT_VERIFIED', 0, 0, 'NO_OBSERVATION'], `${id}: sem ${field}`);
    const view = out.criteriaView.find((row) => row.id === id);
    assert.deepEqual([view?.source, view?.reasonCode, view?.factEmitted], ['SEM_DADO', 'FIELD_ABSENT', false], id);
    assert.equal(result.totals.evaluatedHalfPoints, 26 - weight - (field === 'website' ? 4 : 0) - (field === 'primaryCategory' ? 0 : 0), `cobertura sem ${field}`);
    assert.ok(!(profileKeys(out)).includes(field), `${field} não foi inventado`);
  }
});
const profileKeys = (out: AssembleResult): string[] => Object.keys(out.input?.profile ?? {});

test('MATRIZ: C2 depende de decisão — COMPATIBLE 8, PARTIAL 4, INCOMPATIBLE 0, todas AVALIADAS (8 hp) e rastreadas ao registro', () => {
  for (const [value, obtained] of [['COMPATIBLE', 8], ['PARTIAL', 4], ['INCOMPATIBLE', 0]] as const) {
    const out = run(makeBasis(), [c2Judgement('op-0007', value)]);
    const c2 = sub(scoreOf(out), 'C2');
    assert.deepEqual([c2.state, c2.obtainedHalfPoints, c2.evaluatedHalfPoints, c2.operatorRecordIds], ['SCORED', obtained, 8, ['op-0007']], value);
    const view = out.criteriaView.find((row) => row.id === 'C2');
    assert.deepEqual([view?.source, view?.reasonCode, view?.decisionIds], ['DECISAO_HUMANA', null, ['op-0007']]);
  }
  const without = run();
  assert.deepEqual([without.criteriaView.find((row) => row.id === 'C2')?.reasonCode, sub(scoreOf(without), 'C2').state], ['AWAITING_OPERATOR_DECISION', 'NOT_VERIFIED']);
});

test('MATRIZ: N/A só entra por registro do operador aprovado (S4/BUSINESS_MODEL); o mapeador nunca fabrica N/A e N/A não soma cobertura', () => {
  const none = scoreOf(run());
  assert.deepEqual(none.naRegistry, []);
  const out = run(makeBasis(), [s4NotApplicable()]);
  const result = scoreOf(out);
  assert.deepEqual(result.naRegistry.map((entry) => [entry.subcriterionId, entry.code, entry.recordedBy, entry.operatorRecordId]), [['S4', 'BUSINESS_MODEL', 'OPERATOR_RECORD', 'op-0002']]);
  assert.equal(sub(result, 'S4').state, 'NOT_APPLICABLE');
  assert.equal(result.totals.evaluatedHalfPoints, none.totals.evaluatedHalfPoints, 'N/A não ajuda a chegar a 40 %');
  const view = out.criteriaView.find((row) => row.id === 'S4');
  assert.deepEqual([view?.source, view?.reasonCode, view?.decisionIds], ['DECISAO_HUMANA', null, ['op-0002']]);
  assert.deepEqual(out.blockers, []);
});

test('COBERTURA: 22 hp (11 %) automáticos · 26 hp (13 %) com UTM completo comprovado · 34 hp (17 %) com C2 — o teto de hoje', () => {
  const measure = (basis = makeBasis(), records: OperatorRecord[] = []) => scoreOf(run(basis, records)).totals;
  const noUtm = measure(withProfile({ website: NO_UTM_WEBSITE() }));
  assert.deepEqual([noUtm.evaluatedHalfPoints, noUtm.coveragePercent], [22, 11]);
  const utm = measure();
  assert.deepEqual([utm.evaluatedHalfPoints, utm.coveragePercent], [26, 13]);
  const ceiling = measure(makeBasis(), [c2Judgement()]);
  assert.deepEqual([ceiling.evaluatedHalfPoints, ceiling.coveragePercent], [34, 17]);
  const result = scoreOf(run(makeBasis(), [c2Judgement(), s4NotApplicable()]));
  assert.equal(result.publication.status, 'INSUFFICIENT');
  assert.equal(result.index, null);
  assert.equal(result.confidence, null);
  assert.equal(result.publication.gates.find((gate) => gate.id === 'COVERAGE_MIN')?.passed, false, 'abaixo de 40 %');
});

test('D3B: o terceiro critério com ≥ 3 pontos avaliados só existe com UTM completo comprovado (Conversão = X1 + X5)', () => {
  const withUtm = scoreOf(run(makeBasis(), [c2Judgement()])).totals.criteriaWithMinPoints;
  const withoutUtm = scoreOf(run(withProfile({ website: NO_UTM_WEBSITE() }), [c2Judgement()])).totals.criteriaWithMinPoints;
  assert.deepEqual([...withUtm].sort(), ['CATEGORIES', 'CONVERSION', 'NAP']);
  assert.deepEqual([...withoutUtm].sort(), ['CATEGORIES', 'NAP']);
});

/* ---------------------------------------------------------------- 3. UTM (D6C-3 / X5 assimétrico / D3B) */
const x5 = (out: AssembleResult) => sub(scoreOf(out), 'X5');
const websiteObservation = (out: AssembleResult) => inputOf(out).profile?.website?.[0];

test('UTM comprovada ⇒ complete:true SOMENTE no website, base registrada, X5 pontua 4 hp; todo o resto segue complete:false', () => {
  const out = run();
  const input = inputOf(out);
  for (const [field, list] of Object.entries(input.profile ?? {})) {
    for (const item of list as Array<{ complete: boolean }>) assert.equal(item.complete, field === 'website', `${field}.complete`);
  }
  assert.deepEqual(out.traceability.facts.filter((fact) => fact.complete).map((fact) => [fact.field, fact.completenessBasis]), [['website', 'POSITIVE_UTM_PROOF']]);
  assert.deepEqual(out.traceability.facts.filter((fact) => !fact.complete).map((fact) => fact.completenessBasis), Array(6).fill('NOT_PROVEN'));
  assert.deepEqual([x5(out).state, x5(out).obtainedHalfPoints, x5(out).tier], ['SCORED', 4, 'UTM completo']);
  assert.equal(out.traceability.websiteDerivation?.x5Proof, 'PROVEN');
  assert.equal(out.criteriaView.find((row) => row.id === 'X5')?.source, 'AUTOMATICO');
});

test('UTM incompleta, não observada ou vazia ⇒ complete:false e X5 Não verificado — NUNCA ausência comprovada nem zero', () => {
  const variants: Array<[string, ReturnType<typeof website>, string]> = [
    ['parcial (só utm_source)', PARTIAL_UTM_WEBSITE(), 'UTM_NOT_COMPLETE'],
    ['não observada (sem query)', NO_UTM_WEBSITE(), 'UTM_NOT_COMPLETE'],
    ['só utm_medium', website({ derived: 'https://padaria.example/?utm_medium=x', utm: { level: 'PARTIAL', names: ['utm_medium'] } }), 'UTM_NOT_COMPLETE'],
    ['só parâmetros utm desconhecidos (nível parcial, sem nomes conhecidos)', website({ derived: 'https://padaria.example/', utm: { level: 'PARTIAL', names: [] } }), 'UTM_NOT_COMPLETE'],
  ];
  for (const [name, site, proof] of variants) {
    const out = run(withProfile({ website: site }));
    const observation = websiteObservation(out);
    assert.equal(observation?.complete, false, name);
    const engine = x5(out);
    assert.deepEqual([engine.state, engine.reasonCode, engine.evaluatedHalfPoints, engine.obtainedHalfPoints], ['NOT_VERIFIED', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 0, 0], name);
    assert.equal(out.traceability.websiteDerivation?.x5Proof, proof, name);
    const view = out.criteriaView.find((row) => row.id === 'X5');
    assert.deepEqual([view?.source, view?.reasonCode, view?.factEmitted], ['SEM_DADO', 'UTM_NOT_PROVEN', true], name);
    assert.equal(sub(scoreOf(out), 'X1').state, 'SCORED', `${name}: X1 continua pontuando (presença)`);
  }
});

test('A URL derivada (valores "x") NÃO é prova: sem o nível COMPLETE calculado sobre o bruto, utm_source=x&utm_medium=x não vale; e o inverso também não', () => {
  const lookalike = website({ utm: { level: 'NOT_OBSERVED', names: [] } }); // derivada com utm_source/medium, mas o bruto não tinha
  assert.equal(websiteObservation(run(withProfile({ website: lookalike })))?.complete, false);
  assert.equal(run(withProfile({ website: lookalike })).traceability.websiteDerivation?.x5Proof, 'UTM_NOT_COMPLETE');
  const partialLevel = website({ utm: { level: 'PARTIAL', names: ['utm_medium', 'utm_source'] } });
  assert.equal(websiteObservation(run(withProfile({ website: partialLevel })))?.complete, false, 'nível PARTIAL com os dois nomes ainda não é prova');
  const claimsComplete = website({ derived: 'https://padaria.example/' }); // diz COMPLETE, mas a derivada não carrega
  const out = run(withProfile({ website: claimsComplete }));
  assert.equal(websiteObservation(out)?.complete, false);
  assert.equal(out.traceability.websiteDerivation?.x5Proof, 'DERIVED_URL_INCONSISTENT');
  assert.equal(x5(out).state, 'NOT_VERIFIED');
});

test('prova de UTM exige proveniência íntegra: regra, hash do bruto e a evidência de origem conferem com a captura da base', () => {
  const tamper: Array<[string, (w: ReturnType<typeof website>) => void, string]> = [
    ['regra desconhecida', (w) => { (w.derivation as { rule: string }).rule = 'outra-regra-v9'; }, 'DERIVATION_RULE_UNKNOWN'],
    ['hash do bruto inválido', (w) => { (w.derivation as { rawSha256: string }).rawSha256 = 'zz'; }, 'PROVENANCE_MISMATCH'],
    ['hash do bruto ausente', (w) => { (w.derivation as { rawSha256: unknown }).rawSha256 = undefined; }, 'PROVENANCE_MISMATCH'],
    ['evidência de origem de outra captura', (w) => { (w.derivation.sourceEvidence as { ref: string }).ref = 'capture:c0002'; }, 'PROVENANCE_MISMATCH'],
    ['data de observação da origem diferente', (w) => { (w.derivation.sourceEvidence as { observedAt: string }).observedAt = '2026-10-21T00:00:00.000Z'; }, 'PROVENANCE_MISMATCH'],
    ['hash do conteúdo da origem diferente', (w) => { (w.derivation.sourceEvidence as { contentSha256: string }).contentSha256 = hash('9'); }, 'PROVENANCE_MISMATCH'],
    ['hash do corpo da origem diferente', (w) => { (w.derivation.sourceEvidence as { bodySha256: string }).bodySha256 = hash('9'); }, 'PROVENANCE_MISMATCH'],
    ['origem ausente', (w) => { (w.derivation as { sourceEvidence: unknown }).sourceEvidence = null; }, 'PROVENANCE_MISMATCH'],
  ];
  for (const [name, change, proof] of tamper) {
    const site = website();
    change(site);
    const out = run(withProfile({ website: site }));
    assert.equal(websiteObservation(out)?.complete, false, name);
    assert.equal(out.traceability.websiteDerivation?.x5Proof, proof, name);
    assert.equal(x5(out).state, 'NOT_VERIFIED', name);
  }
});

test('a URL derivada só vai ao motor se tiver EXATAMENTE a forma da regra (sem caminho, credenciais, fragmento, valor ≠ "x", chave desconhecida/repetida, grafia diferente)', () => {
  const shapes: Array<[string, string]> = [
    ['com caminho', 'https://padaria.example/loja/?utm_medium=x&utm_source=x'],
    ['com caminho e token', 'https://padaria.example/p/SEGREDO8/sk-abcdefghijklmnopqrstuvwxyz0123/?utm_medium=x&utm_source=x'],
    ['com credenciais', 'https://u:p@padaria.example/?utm_medium=x&utm_source=x'],
    ['com fragmento', 'https://padaria.example/?utm_medium=x&utm_source=x#topo'],
    ['valor diferente de x', 'https://padaria.example/?utm_medium=email&utm_source=x'],
    ['parâmetro desconhecido', 'https://padaria.example/?utm_medium=x&utm_source=x&token=x'],
    ['parâmetro repetido', 'https://padaria.example/?utm_medium=x&utm_source=x&utm_source=x'],
    ['esquema não http', 'ftp://padaria.example/?utm_medium=x&utm_source=x'],
    ['nome com caixa alta', 'https://padaria.example/?UTM_MEDIUM=x&utm_source=x'],
    ['fora da ordem canônica', 'https://padaria.example/?utm_source=x&utm_medium=x'],
    ['sem a barra final', 'https://padaria.example'],
    ['com espaços', ' https://padaria.example/ '],
    ['host em maiúsculas', 'https://PADARIA.example/'],
    ['porta inválida', 'https://padaria.example:99999/'],
    ['não é URL', 'isto não é uma url'],
    ['URL hostil completa', 'http://evil.example/?token=SEGREDO'],
  ];
  for (const [name, derived] of shapes) {
    const out = run(withProfile({ website: website({ derived }) }));
    assert.ok(!profileKeys(out).includes('website'), `${name}: a URL fora do mínimo NÃO pode ir ao motor`);
    assert.equal(out.traceability.facts.find((fact) => fact.field === 'website')?.omittedReason, 'WEBSITE_DERIVED_NOT_MINIMAL', name);
    assert.equal(out.traceability.websiteDerivation?.x5Proof, 'WEBSITE_NOT_EMITTED', name);
    assert.equal(find(out, 'FIELD_NOT_EMITTED')?.reasonCode, 'WEBSITE_DERIVED_NOT_MINIMAL', name);
    assert.ok(!JSON.stringify(out).includes('SEGREDO') && !JSON.stringify(out).includes('evil.example'), `${name}: vazou`);
    assert.deepEqual([sub(scoreOf(out), 'X1').state, sub(scoreOf(out), 'X5').state], ['NOT_VERIFIED', 'NOT_VERIFIED'], name);
  }
  // nomes declarados que não batem com a derivada (derivada mínima, declaração incoerente): enviada, mas sem prova
  const mismatch = website({ utm: { level: 'COMPLETE', names: ['utm_medium', 'utm_source', 'utm_term'] } });
  const out = run(withProfile({ website: mismatch }));
  assert.equal(websiteObservation(out)?.complete, false);
  assert.equal(out.traceability.websiteDerivation?.x5Proof, 'DERIVED_URL_INCONSISTENT');
  // porta e subdomínio são parte legítima da forma da regra
  for (const derived of ['https://padaria.example:8443/?utm_medium=x&utm_source=x', 'http://loja.padaria.example/?utm_campaign=x&utm_medium=x&utm_source=x']) {
    const names = [...derived.matchAll(/(utm_[a-z]+)=x/g)].map((m) => m[1] as string);
    const ok = run(withProfile({ website: website({ derived, utm: { level: 'COMPLETE', names } }) }));
    assert.equal(ok.traceability.websiteDerivation?.x5Proof, 'PROVEN', derived);
  }
});

test('website ilegível (sem esquema http, malformado, vazio) ⇒ NÃO é enviado: X1 e X5 Não verificados; aviso explica; nada é inventado', () => {
  const out = run(withProfile({ website: UNPARSABLE_WEBSITE() }));
  assert.ok(!profileKeys(out).includes('website'));
  const result = scoreOf(out);
  for (const id of ['X1', 'X5']) assert.deepEqual([sub(result, id).state, sub(result, id).evaluatedHalfPoints], ['NOT_VERIFIED', 0], id);
  const warning = find(out, 'FIELD_NOT_EMITTED');
  assert.deepEqual([warning?.severity, warning?.reasonCode, warning?.subcriterionIds], ['WARNING', 'WEBSITE_UNPARSABLE', ['X1', 'X5']]);
  assert.equal(out.traceability.websiteDerivation?.x5Proof, 'WEBSITE_NOT_EMITTED');
  assert.deepEqual(out.criteriaView.filter((row) => row.id === 'X1' || row.id === 'X5').map((row) => [row.source, row.reasonCode]), [['SEM_DADO', 'WEBSITE_UNPARSABLE'], ['SEM_DADO', 'WEBSITE_UNPARSABLE']]);
});

test('o website exige a evidência maps-website do relatório VERIFIED (§9.6): ausente do relatório ou não verificada ⇒ não é enviado', () => {
  const noReport = withProfile({ reportEvidence: {} });
  const outA = run(noReport);
  assert.ok(!profileKeys(outA).includes('website'));
  assert.equal(outA.traceability.facts.find((fact) => fact.field === 'website')?.omittedReason, 'REPORT_EVIDENCE_REQUIRED');
  assert.equal(find(outA, 'FIELD_NOT_EMITTED')?.reasonCode, 'REPORT_EVIDENCE_REQUIRED');
  assert.equal(sub(scoreOf(outA), 'X1').evaluatedHalfPoints, 0);
  for (const status of ['NOT_VERIFIED', 'NOT_FOUND', 'PARTIAL'] as const) {
    const out = run(withProfile({ reportEvidence: { ...ALL_VERIFIED, 'maps-website': status } }));
    assert.ok(!profileKeys(out).includes('website'), status);
    assert.equal(out.traceability.facts.find((fact) => fact.field === 'website')?.omittedReason, 'REPORT_STATUS_CONTRADICTS', status);
  }
});

test('os outros campos NÃO exigem entrada no relatório (a captura íntegra basta, §10 E-cap): relatório sem entrada não é prova de ausência nem bloqueio', () => {
  const out = run(withProfile({ reportEvidence: { 'maps-website': 'VERIFIED' } }));
  assert.deepEqual(profileKeys(out).sort(), ['additionalCategories', 'address', 'hours', 'name', 'phone', 'primaryCategory', 'website']);
  assert.deepEqual(out.traceability.facts.filter((fact) => fact.field !== 'website' && fact.reportStatus !== 'NOT_APPLICABLE').map((fact) => fact.reportStatus), ['NOT_LISTED', 'NOT_LISTED', 'NOT_LISTED', 'NOT_LISTED', 'NOT_LISTED']);
  assert.equal(scoreOf(out).totals.evaluatedHalfPoints, 26);
  assert.deepEqual(out.blockers, []);
});

test('nenhum valor sensível chega a lugar algum: a saída inteira não contém a URL bruta, parâmetros, caminho, e-mail do operador na rastreabilidade', () => {
  const out = run(makeBasis(), [c2Judgement()]);
  const text = JSON.stringify({ ...out, input: undefined });
  for (const leak of ['SEGREDO', 'token=', 'sessionid', 'utm_source=ORIGEM', 'ana@empresa.com', 'Padaria Exemplo', '3000-9999']) assert.ok(!text.includes(leak), `vazou ${leak}`);
  assert.ok(JSON.stringify(inputOf(out)).includes('https://padaria.example/?utm_medium=x&utm_source=x'), 'só a URL derivada mínima está na entrada');
});

/* ---------------------------------------------------------------- 4. proveniência, hashes e versões */
test('PROVENIÊNCIA: toda evidência da base vira evidência da entrada, com o MESMO id e o MESMO hash; nenhuma é inventada', () => {
  const basis = makeBasis({
    evidences: [captureEvidence(1), reportEvidence(1, 1, { superseded: true, contentSha256: hash('1') }), reportEvidence(1, 2, { contentSha256: hash('2') }), captureEvidence(2, { contentSha256: hash('3'), bodySha256: hash('4'), observedAt: '2026-09-30T08:00:00.000Z' })],
  });
  const out = run(basis);
  const input = inputOf(out);
  assert.deepEqual(input.evidences.map((e) => e.id), ['capture:c0001', 'capture:c0002', 'report:c0001-r0001', 'report:c0001-r0002']);
  for (const evidence of input.evidences) {
    const origin = basis.evidences.find((candidate) => candidate.ref === evidence.id);
    assert.ok(origin, evidence.id);
    assert.deepEqual([evidence.contentSha256, evidence.observedAt, evidence.origin, evidence.capture, evidence.status], [origin.contentSha256, origin.observedAt, 'GOOGLE_NATIVE', 'STORED_CAPTURE', 'VERIFIED']);
  }
  assert.deepEqual(out.traceability.evidences.map((e) => [e.ref, e.kind, e.contentSha256, e.bodySha256, e.legacy, e.superseded]), [
    ['capture:c0001', 'CAPTURE', CAPTURE_HASH, BODY_HASH, false, false],
    ['capture:c0002', 'CAPTURE', hash('3'), hash('4'), false, false],
    ['report:c0001-r0001', 'REPORT', hash('1'), null, false, true],
    ['report:c0001-r0002', 'REPORT', hash('2'), null, false, false],
  ]);
  assert.deepEqual(inputOf(out).profile?.name?.[0]?.evidenceIds, ['capture:c0001'], 'o fato cita só a captura de onde veio');
});

test('PROVENIÊNCIA: o fato cita APENAS a captura do perfil; a derivação do website preserva o hash do bruto e a evidência de origem', () => {
  const out = run();
  for (const list of Object.values(inputOf(out).profile ?? {})) for (const item of list as Array<{ evidenceIds: string[] }>) assert.deepEqual(item.evidenceIds, ['capture:c0001']);
  assert.deepEqual(out.traceability.websiteDerivation, {
    rule: 'lumos-url-derive-v1',
    rawSha256: RAW_WEBSITE_HASH,
    sourceEvidence: { ref: 'capture:c0001', contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH },
    utmLevel: 'COMPLETE',
    x5Proof: 'PROVEN',
  });
  assert.deepEqual(out.traceability.profile, { state: 'AVAILABLE', source: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH }, ageDays: 0, ageStatus: 'CURRENT' });
  assert.deepEqual(out.traceability.excluded, { reviews: 'EXCLUDED_M4A' });
});

test('PROVENIÊNCIA: layout legado preservado (legacy:true, hash do legado = corpo do provedor) e a mesma política de fatos', () => {
  const legacyHash = hash('7');
  const basis = makeBasis({
    layout: 'LEGACY',
    evidences: [captureEvidence(1, { legacy: true, contentSha256: legacyHash, bodySha256: legacyHash }), reportEvidence(1, 1, { legacy: true, superseded: true, contentSha256: hash('1') }), reportEvidence(1, 2, { legacy: true, contentSha256: hash('2') })],
    profile: richProfile({ source: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: legacyHash, bodySha256: legacyHash }, website: website({ derivation: { rule: 'lumos-url-derive-v1', rawSha256: RAW_WEBSITE_HASH, sourceEvidence: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: legacyHash, bodySha256: legacyHash } } }) }),
  });
  const out = run(basis);
  assert.equal(out.traceability.layout, 'LEGACY');
  assert.deepEqual(out.traceability.evidences.map((e) => e.legacy), [true, true, true]);
  assert.equal(scoreOf(out).totals.evaluatedHalfPoints, 26);
  assert.equal(inputOf(out).evidences.find((e) => e.id === 'capture:c0001')?.contentSha256, legacyHash);
});

test('VERSÕES: schema do contrato, versão do mapeador e da base são registrados; o resultado do motor usa a régua homologada', () => {
  const out = run();
  assert.equal(inputOf(out).schemaVersion, 1);
  const result = scoreOf(out);
  assert.deepEqual([result.scoreModelVersion, result.methodologyVersion], ['regua-d3b-r2', 'lumos-reconstruida-v1']);
  assert.equal(result.rulerFingerprint, '957f88fd2928b0f0bb99c2689adb400eeb15b64c504bc72a26c1df40b22b387d');
});

/* ---------------------------------------------------------------- 5. referenceDate */
test('REFERENCE DATE: é o dia (como escrito) da evidência verificada mais recente e nunca depende do relógio injetado', () => {
  const basis = makeBasis({ evidences: [captureEvidence(1, { observedAt: '2026-10-22T23:59:59.999Z' }), reportEvidence(1, 1, { observedAt: '2026-10-22T23:59:59.999Z' })], profile: richProfile({ source: { ref: 'capture:c0001', observedAt: '2026-10-22T23:59:59.999Z', contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH } }) });
  for (const now of ['2026-10-23T00:00:00.000Z', '2026-10-23T10:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-10-22T23:59:59.999Z']) {
    const out = run(basis, [], now);
    assert.equal(inputOf(out).referenceDate, '2026-10-22', `now=${now}`);
    assert.equal(out.inputSha256, run(basis).inputSha256, 'o instante injetado nunca altera a entrada');
  }
  assert.deepEqual(run(basis).traceability.referenceDateSource, { ref: 'capture:c0001', observedAt: '2026-10-22T23:59:59.999Z', rule: 'LATEST_VERIFIED_EVIDENCE_DAY' });
});

test('REFERENCE DATE: perto da meia-noite o dia é o escrito na evidência (sem conversão de fuso) e fica ≥ de toda observedAt', () => {
  for (const observedAt of ['2026-10-22T00:00:00.000Z', '2026-10-22T23:59:59.999Z', '2026-10-23T00:00:00.000Z', '2026-12-31T23:59:59.000Z', '2026-10-22T23:30:00-03:00', '2026-10-22T02:00:00+05:00']) {
    const basis = makeBasis({ evidences: [captureEvidence(1, { observedAt }), reportEvidence(1, 1, { observedAt })], profile: richProfile({ source: { ref: 'capture:c0001', observedAt, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH } }) });
    const out = run(basis, [], '2027-06-01T00:00:00.000Z');
    const input = inputOf(out);
    assert.equal(input.referenceDate, observedAt.slice(0, 10), observedAt);
    for (const evidence of input.evidences) assert.ok(evidence.observedAt.slice(0, 10) <= input.referenceDate);
  }
});

test('REFERENCE DATE: com várias capturas vale a mais recente de TODA a base (também uma posterior sem resposta utilizável); a fonte fica registrada', () => {
  const second = { ref: 'capture:c0002', observedAt: OBSERVED, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH };
  const profile = richProfile({ source: second, website: website({ derivation: { rule: 'lumos-url-derive-v1', rawSha256: RAW_WEBSITE_HASH, sourceEvidence: second } }) });
  const basis = makeBasis({ profile, evidences: [captureEvidence(1, { observedAt: '2026-09-01T10:00:00.000Z', contentSha256: hash('5'), bodySha256: hash('6') }), captureEvidence(2), reportEvidence(2, 1), captureEvidence(3, { observedAt: '2026-10-25T08:00:00.000Z', contentSha256: hash('8'), bodySha256: null })] });
  const out = run(basis, [], '2026-10-26T00:00:00.000Z');
  assert.equal(inputOf(out).referenceDate, '2026-10-25');
  assert.deepEqual(out.traceability.referenceDateSource, { ref: 'capture:c0003', observedAt: '2026-10-25T08:00:00.000Z', rule: 'LATEST_VERIFIED_EVIDENCE_DAY' });
  assert.deepEqual([out.traceability.profile.state === 'AVAILABLE' ? out.traceability.profile.ageDays : -1], [3]);
  for (const evidence of inputOf(out).evidences) assert.ok(evidence.observedAt.slice(0, 10) <= '2026-10-25', 'nenhuma evidência posterior à referência (o contrato recusaria)');
  assert.deepEqual(inputOf(out).profile?.name?.[0]?.evidenceIds, ['capture:c0002'], 'os fatos citam a captura de onde vieram, não a mais recente');
  assert.equal(scoreOf(out).totals.evaluatedHalfPoints, 26);
});

test('REFERENCE DATE: empate entre capturas do mesmo dia é resolvido de forma estável (captura antes de relatório, menor referência)', () => {
  const same = '2026-10-22T08:00:00.000Z';
  const basis = makeBasis({ evidences: [reportEvidence(2, 1, { observedAt: same }), captureEvidence(2, { observedAt: same, contentSha256: hash('3'), bodySha256: hash('4') }), captureEvidence(1, { observedAt: '2026-10-22T20:00:00.000Z' })], profile: richProfile() });
  const a = run(basis);
  const b = run(makeBasis({ evidences: [...basis.evidences].reverse(), profile: richProfile() }));
  assert.equal(a.traceability.referenceDateSource?.ref, 'capture:c0001');
  assert.deepEqual(a.traceability.referenceDateSource, b.traceability.referenceDateSource);
});

test('REFERENCE DATE: evidência velha demais para fundamentar (>180 dias) vira Não verificado pelo motor e o mapeador avisa; entre 91 e 180 dias só avisa', () => {
  const aged = makeBasis({ evidences: [captureEvidence(1, { observedAt: '2026-06-01T10:00:00.000Z' }), reportEvidence(1, 1, { observedAt: '2026-06-01T10:00:00.000Z' }), captureEvidence(2, { observedAt: '2026-10-22T10:00:00.000Z', contentSha256: hash('3'), bodySha256: null })], profile: richProfile({ source: { ref: 'capture:c0001', observedAt: '2026-06-01T10:00:00.000Z', contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH } }) });
  const outAged = run(aged); // 143 dias
  assert.deepEqual(find(outAged, 'PROFILE_EVIDENCE_AGED')?.severity, 'WARNING');
  assert.equal(outAged.traceability.profile.state === 'AVAILABLE' && outAged.traceability.profile.ageStatus, 'AGED');
  assert.equal(sub(scoreOf(outAged), 'N1').state, 'SCORED');
  const old = makeBasis({ evidences: [captureEvidence(1, { observedAt: '2026-03-01T10:00:00.000Z' }), reportEvidence(1, 1, { observedAt: '2026-03-01T10:00:00.000Z' }), captureEvidence(2, { observedAt: '2026-10-22T10:00:00.000Z', contentSha256: hash('3'), bodySha256: null })], profile: richProfile({ source: { ref: 'capture:c0001', observedAt: '2026-03-01T10:00:00.000Z', contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH } }) });
  const outOld = run(old); // 235 dias
  const warning = find(outOld, 'PROFILE_EVIDENCE_TOO_OLD');
  assert.deepEqual([warning?.severity, warning?.subcriterionIds], ['WARNING', ['C1', 'C2', 'C3', 'N1', 'N2', 'N3', 'N4', 'X1', 'X5']]);
  const result = scoreOf(outOld);
  assert.equal(sub(result, 'N1').reasonCode, 'EVIDENCE_TOO_OLD');
  assert.equal(result.totals.evaluatedHalfPoints, 0, 'evidência velha não fundamenta pontos, e não vira zero');
});

test('REFERENCE DATE: evidência datada no futuro do servidor ⇒ nenhuma entrada; data inválida na base ⇒ base inválida', () => {
  const out = run(makeBasis(), [], '2026-10-21T10:00:00.000Z');
  assert.equal(out.input, null);
  assert.deepEqual(codes(out), ['BLOCKING:EVIDENCE_DATED_IN_FUTURE']);
  assert.equal(out.traceability.referenceDate, '2026-10-22', 'o rastro mostra o que foi lido');
  const same = run(makeBasis(), [], '2026-10-22T00:00:01.000Z');
  assert.ok(same.input, 'mesmo dia não é futuro');
  for (const observedAt of ['2026-13-45T99:99:99Z', 'ontem', '', '22/10/2026', null]) {
    const bad = run(makeBasis({ evidences: [captureEvidence(1, { observedAt: observedAt as never }), reportEvidence(1, 1)] }));
    assert.equal(bad.input, null, String(observedAt));
    assert.equal(find(bad, 'BASIS_INVALID')?.reasonCode, 'EVIDENCE_DATE_INVALID', String(observedAt));
  }
});

/* ---------------------------------------------------------------- 6. evidências inexistentes, parciais e contraditórias */
test('INEXISTENTE: perfil não disponível (qualquer motivo) ⇒ nenhum fato do perfil vai ao motor; o resultado é NO_DATA, nunca zero', () => {
  for (const reason of ['NO_USABLE_CAPTURE', 'BODY_UNREADABLE', 'IDENTITY_NOT_CONFIRMED', 'NOT_LOCATED', 'AMBIGUOUS_IDENTITY'] as const) {
    const out = run(makeBasis({ profile: unavailable(reason) }));
    const input = inputOf(out);
    assert.equal(input.profile, undefined, reason);
    assert.deepEqual(input.evidences.map((e) => e.id), ['capture:c0001', 'report:c0001-r0001'], 'a proveniência da coleta continua íntegra');
    const warning = find(out, 'PROFILE_UNAVAILABLE');
    assert.deepEqual([warning?.severity, warning?.reasonCode], ['WARNING', reason]);
    const result = scoreOf(out);
    assert.deepEqual([result.publication.status, result.totals.evaluatedHalfPoints, result.index], ['NO_DATA', 0, null], reason);
    for (const row of out.criteriaView) assert.ok(row.source === 'SEM_DADO' || row.source === 'BLOQUEADO', `${reason} ${row.id}`);
    assert.ok(out.traceability.facts.every((fact) => !fact.emitted && fact.omittedReason === 'PROFILE_UNAVAILABLE'));
    assert.deepEqual(out.traceability.profile, { state: 'UNAVAILABLE', reason });
  }
});

test('PARCIAL: cada campo ausente some do perfil sem afetar os demais; relatório incompleto nunca derruba um fato presente', () => {
  const out = run(withProfile({ name: null, phone: null, additionalCategories: null, address: null, hoursRaw: null, reportEvidence: { 'maps-category': 'VERIFIED', 'maps-website': 'VERIFIED' } }));
  assert.deepEqual(profileKeys(out).sort(), ['primaryCategory', 'website']);
  const result = scoreOf(out);
  assert.equal(result.totals.evaluatedHalfPoints, 6 + 4 + 4);
  assert.equal(sub(result, 'N1').state, 'NOT_VERIFIED');
  assert.equal(sub(result, 'C1').state, 'SCORED');
});

test('CONTRADITÓRIA: relatório diz NOT_VERIFIED/NOT_FOUND/PARTIAL mas a captura tem o valor ⇒ o campo NÃO é enviado e há aviso; os outros seguem', () => {
  for (const status of ['NOT_VERIFIED', 'NOT_FOUND', 'PARTIAL'] as const) {
    const out = run(withProfile({ reportEvidence: { ...ALL_VERIFIED, 'maps-phone': status, 'maps-name': status } }));
    assert.deepEqual(profileKeys(out).sort(), ['additionalCategories', 'address', 'hours', 'primaryCategory', 'website'], status);
    const warning = find(out, 'FIELD_CONTRADICTED_BY_REPORT');
    assert.deepEqual([warning?.severity, warning?.subcriterionIds], ['WARNING', ['N1', 'N3']], status);
    const facts = out.traceability.facts.filter((fact) => fact.field === 'name' || fact.field === 'phone');
    assert.deepEqual(facts.map((fact) => [fact.emitted, fact.omittedReason, fact.reportStatus]), [[false, 'REPORT_STATUS_CONTRADICTS', status], [false, 'REPORT_STATUS_CONTRADICTS', status]]);
    const result = scoreOf(out);
    assert.equal(sub(result, 'N1').obtainedHalfPoints, 0);
    assert.equal(sub(result, 'N1').state, 'NOT_VERIFIED', 'contradição ⇒ Não verificado, jamais zero');
  }
});

test('CONTRADITÓRIA: relatório afirma VERIFIED para um campo que a captura não tem ⇒ nada é inventado e há aviso', () => {
  const out = run(withProfile({ phone: null, reportEvidence: { ...ALL_VERIFIED } }));
  assert.ok(!profileKeys(out).includes('phone'));
  assert.deepEqual([find(out, 'FIELD_CONTRADICTED_BY_REPORT')?.subcriterionIds], [['N3']]);
  assert.equal(out.traceability.facts.find((fact) => fact.field === 'phone')?.omittedReason, 'FIELD_ABSENT');
  assert.equal(sub(scoreOf(out), 'N3').state, 'NOT_VERIFIED');
});

test('CONTRADITÓRIA: valor vazio/espaços na captura é ausência (não string vazia enviada) — e o relatório NOT_FOUND coerente não gera aviso', () => {
  const out = run(withProfile({ name: '   ', phone: '', primaryCategory: '\t', reportEvidence: { ...ALL_VERIFIED, 'maps-name': 'NOT_FOUND', 'maps-phone': 'NOT_VERIFIED', 'maps-category': 'NOT_FOUND' } }));
  assert.ok(!profileKeys(out).includes('name') && !profileKeys(out).includes('phone') && !profileKeys(out).includes('primaryCategory'));
  assert.equal(find(out, 'FIELD_CONTRADICTED_BY_REPORT'), undefined);
  assert.equal(sub(scoreOf(out), 'N1').state, 'NOT_VERIFIED');
});

test('VALORES ACIMA DO LIMITE DO CONTRATO não são truncados nem alterados: o campo não é enviado e há aviso', () => {
  const out = run(withProfile({ name: 'N'.repeat(301), address: { raw: 'R'.repeat(501) }, hoursRaw: 'H'.repeat(501), phone: 'P'.repeat(61), primaryCategory: 'C'.repeat(201), additionalCategories: ['A'.repeat(201)] }));
  assert.deepEqual(profileKeys(out), ['website']);
  assert.deepEqual([find(out, 'FIELD_NOT_EMITTED')?.reasonCode, find(out, 'FIELD_NOT_EMITTED')?.subcriterionIds], ['VALUE_EXCEEDS_CONTRACT_LIMIT', ['C1', 'C2', 'C3', 'N1', 'N2', 'N3', 'N4']]);
  const edge = run(withProfile({ name: 'N'.repeat(300), address: { raw: 'R'.repeat(500) }, hoursRaw: 'H'.repeat(500), phone: 'P'.repeat(60), primaryCategory: 'C'.repeat(200) }));
  assert.deepEqual(profileKeys(edge).sort(), ['additionalCategories', 'address', 'hours', 'name', 'phone', 'primaryCategory', 'website']);
});

test('ENDEREÇO CRU não é endereço estruturado e HORÁRIOS em texto não são horários estruturados: N2 e N4 ficam Não verificados', () => {
  const out = run(withProfile({ address: { raw: 'Rua A, 100, Centro, Cidade Exemplo - GO, 74000-000' }, hoursRaw: 'segunda: 08:00–18:00; terça: 08:00–18:00; quarta: 08:00–18:00; quinta: 08:00–18:00; sexta: 08:00–18:00; sábado: 08:00–12:00; domingo: Fechado' }));
  const input = inputOf(out);
  assert.deepEqual(Object.keys(input.profile?.address?.[0]?.value ?? {}), ['raw'], 'sem `parsed`');
  assert.equal(input.profile?.hours?.[0]?.value.kind, 'TEXT');
  const result = scoreOf(out);
  assert.deepEqual([sub(result, 'N2').state, sub(result, 'N2').reasonCode, sub(result, 'N4').state, sub(result, 'N4').reasonCode], ['NOT_VERIFIED', 'ADDRESS_UNPARSED', 'NOT_VERIFIED', 'HOURS_UNSTRUCTURED']);
});

test('CATEGORIAS ADICIONAIS: lista observada, nunca completa; o motor mantém C3 Não verificado e a lista não é usada para N/A', () => {
  const out = run();
  assert.deepEqual(inputOf(out).profile?.additionalCategories?.[0]?.complete, false);
  assert.equal(sub(scoreOf(out), 'C3').reasonCode, 'FIELD_NOT_EXPOSED_OR_INCOMPLETE');
  const none = run(withProfile({ additionalCategories: null }));
  assert.ok(!profileKeys(none).includes('additionalCategories'), 'sem lista observada não se fabrica lista vazia');
  const empty = run(withProfile({ additionalCategories: [] }));
  assert.ok(!profileKeys(empty).includes('additionalCategories'), 'lista vazia do leitor também é "nenhuma observada"');
});

/* ---------------------------------------------------------------- 7. propriedade: ausência de informação nunca vira zero, ausência provada ou N/A */
test('PROPRIEDADE (640 combinações): sem prova explícita nunca há ABSENCE_PROVEN, N/A derivado, complete:true ou zero por falta de dado', () => {
  const FIELD_KEYS = ['name', 'phone', 'primaryCategory', 'additionalCategories', 'address', 'hoursRaw'] as const;
  const WEBSITES: Array<[string, ReturnType<typeof website> | null]> = [['sem website', null], ['sem UTM', NO_UTM_WEBSITE()], ['UTM parcial', PARTIAL_UTM_WEBSITE()], ['UTM completo', website()], ['ilegível', UNPARSABLE_WEBSITE()]];
  const REPORTS: Array<[string, Record<string, 'VERIFIED'>]> = [['relatório completo', { ...ALL_VERIFIED } as Record<string, 'VERIFIED'>], ['sem relatório', {}]];
  const VALUES = { name: 'Padaria Exemplo', phone: '(62) 3000-9999', primaryCategory: 'Padaria', additionalCategories: ['Confeitaria'], address: { raw: 'Rua Fictícia, 1' }, hoursRaw: 'segunda: 08:00–18:00' };
  const FACT_WEIGHT: Record<(typeof FIELD_KEYS)[number], number> = { name: 6, phone: 6, primaryCategory: 6, additionalCategories: 0, address: 0, hoursRaw: 0 };
  let combos = 0;
  for (let mask = 0; mask < 1 << FIELD_KEYS.length; mask += 1) {
    for (const [websiteName, site] of WEBSITES) {
      for (const [reportName, report] of REPORTS) {
        const present = FIELD_KEYS.filter((_, index) => (mask >> index) & 1);
        const over: Record<string, unknown> = { website: site, reportEvidence: report };
        for (const key of FIELD_KEYS) over[key] = present.includes(key) ? VALUES[key] : null;
        const label = `${present.join('+') || 'nenhum'} | ${websiteName} | ${reportName}`;
        const out = run(withProfile(over as never));
        const input = inputOf(out);
        combos += 1;
        assert.ok(parseScoringInput(input).ok, label);
        const result = scoreOf(out);
        // 1. nenhuma ausência provada, nenhum N/A derivado
        assert.ok(result.subcriteria.every((s) => s.state !== 'ABSENCE_PROVEN'), `${label}: ABSENCE_PROVEN`);
        assert.deepEqual(result.naRegistry, [], `${label}: N/A`);
        // 2. complete:true só para o website com prova
        const completeFields = Object.entries(input.profile ?? {}).filter(([, list]) => (list as Array<{ complete: boolean }>).some((item) => item.complete)).map(([key]) => key);
        const proven = websiteName === 'UTM completo' && reportName === 'relatório completo';
        assert.deepEqual(completeFields, proven ? ['website'] : [], label);
        // 3. a cobertura é exatamente a soma dos fatos automáticos emitidos
        const siteEmitted = site !== null && site.state === 'DERIVED' && reportName === 'relatório completo';
        const expected = present.reduce((total, key) => total + FACT_WEIGHT[key], 0) + (siteEmitted ? 4 : 0) + (proven ? 4 : 0);
        assert.equal(result.totals.evaluatedHalfPoints, expected, `${label}: cobertura`);
        // 4. tudo que não foi avaliado está Não verificado com 0 avaliado e 0 obtido (nunca zero fabricado)
        for (const s of result.subcriteria) if (s.state === 'NOT_VERIFIED') assert.deepEqual([s.evaluatedHalfPoints, s.obtainedHalfPoints], [0, 0], `${label}: ${s.id}`);
        // 5. campo ausente ⇒ chave ausente (nunca null/lista vazia)
        for (const key of FIELD_KEYS) {
          const field = key === 'hoursRaw' ? 'hours' : key;
          assert.equal(Object.hasOwn(input.profile ?? {}, field), present.includes(key), `${label}: ${field}`);
        }
        // 6. nunca avaliações
        assert.ok(!Object.hasOwn(input.profile ?? {}, 'reviews'), label);
        assert.equal(result.displayData.reviews, null, label);
      }
    }
  }
  assert.equal(combos, 64 * 5 * 2);
});

/* ---------------------------------------------------------------- 8. M-4a estrita */
const WEIRD_COUNTS: ReadonlyArray<unknown> = [0, 1, 4, 5, 99, 100, 999, 1000, 1001, 123456, '120', '1,2 mil', '1.2K', '1k+', '1.200', '', 'muitas', 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, [1000]];
const WEIRD_RATINGS: ReadonlyArray<unknown> = [4.9, 5, 0, 3.14159, '4,8', null, undefined, Number.NaN, -2, 7];

test('M-4A ESTRITA: nenhuma contagem ou nota de avaliações (0, 999, 1000, 1001, abreviadas, texto, fracionária, negativa, NaN, Infinity, nula) chega à entrada — a entrada é IDÊNTICA', () => {
  const baseline = run();
  assert.ok(baseline.inputSha256);
  for (const ratingCount of WEIRD_COUNTS) {
    for (const rating of WEIRD_RATINGS) {
      const reviews = { rating, ratingCount, scoringUse: 'EXCLUDED_M4A', reason: 'informativo', source: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH } };
      const out = run(makeBasis({ reviews }));
      assert.equal(out.inputSha256, baseline.inputSha256, `ratingCount=${String(ratingCount)} rating=${String(rating)}: a entrada mudou`);
      assert.deepEqual(out.input, baseline.input);
    }
  }
  const noReviews = run(makeBasis({ reviews: null }));
  assert.equal(noReviews.inputSha256, baseline.inputSha256, 'sem avaliações informativas também não muda nada');
});

test('M-4A ESTRITA: o motor trata R1 e R2 como Não verificado (NO_OBSERVATION), nunca NO_REVIEWS_PROVEN, ABSENCE_PROVEN ou zero — mesmo com 0 e 1000 avaliações informativas', () => {
  for (const ratingCount of [0, 999, 1000, 1001]) {
    const out = run(makeBasis({ reviews: { rating: ratingCount === 0 ? null : 4.9, ratingCount, scoringUse: 'EXCLUDED_M4A', reason: 'informativo', source: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH } } }));
    const result = scoreOf(out);
    for (const id of ['R1', 'R2', 'R3', 'L1', 'L2', 'P1', 'P2', 'P3']) {
      assert.deepEqual([sub(result, id).state, sub(result, id).evaluatedHalfPoints, sub(result, id).obtainedHalfPoints], ['NOT_VERIFIED', 0, 0], `${id} com ${ratingCount}`);
    }
    assert.deepEqual([sub(result, 'R1').reasonCode, sub(result, 'R2').reasonCode], ['NO_OBSERVATION', 'NO_OBSERVATION']);
    assert.equal(result.displayData.reviews, null, 'o motor não exibe contagem que não recebeu');
    assert.deepEqual(result.naRegistry, []);
    assert.equal(JSON.stringify(result).includes('NO_REVIEWS_PROVEN'), false);
  }
});

test('M-4A ESTRITA: o mapeador NÃO LÊ a parte informativa da base (um acesso à propriedade falharia), e a entrada nunca tem chave de avaliações', () => {
  const basis = makeBasis();
  let reads = 0;
  Object.defineProperty(basis, 'informational', { enumerable: true, get() { reads += 1; throw new Error('informational lido pelo mapeador'); } });
  const out = run(basis, [c2Judgement()]);
  assert.equal(reads, 0);
  assert.equal(find(out, 'MAPPER_INTERNAL_ERROR'), undefined);
  const keys = deepKeys(out.input);
  for (const forbidden of ['reviews', 'ratingShown', 'reviewCount', 'rating', 'ratingCount', 'latestReviewDate', 'replies']) assert.ok(!keys.includes(forbidden), `chave ${forbidden} na entrada`);
  assert.ok(!JSON.stringify(out).includes('4.9') || !JSON.stringify(out).includes('ratingCount'));
});

/* ---------------------------------------------------------------- 9. decisões do operador */
test('DECISÕES: passam SEM alteração (cópia fiel, na ordem normalizada do contrato) e a lista original não é modificada', () => {
  const records = Object.freeze([Object.freeze(s4NotApplicable('op-0002')), Object.freeze(c2Judgement('op-0001', 'PARTIAL'))]) as unknown as OperatorRecord[];
  const before = JSON.stringify(records);
  const out = run(makeBasis(), records);
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(inputOf(out).operatorRecords, [c2Judgement('op-0001', 'PARTIAL'), s4NotApplicable('op-0002')]);
  assert.deepEqual(out.traceability.operatorRecords, { count: 2, ids: ['op-0001', 'op-0002'] });
  assert.notEqual(inputOf(out).operatorRecords?.[0], records[1], 'cópia, não referência');
});

test('DECISÕES: decisão fora do contrato aprovado BLOQUEIA a finalização (e a entrada continua inspecionável quando o contrato do motor a aceita)', () => {
  const na = (code: string, ids: string[], causes: string[] = []): OperatorRecord => ({ id: 'op-0003', kind: 'NOT_APPLICABLE', subcriterionIds: ids, code, causeEvidenceIds: causes, operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' }) as unknown as OperatorRecord;
  const unsupported: Array<[string, OperatorRecord]> = [
    ['N/A FEATURE_UNAVAILABLE de S3 (exige anexo)', na('FEATURE_UNAVAILABLE', ['S3'], ['capture:c0001'])],
    ['N/A BUSINESS_MODEL de S3', na('BUSINESS_MODEL', ['S3'])],
    ['N/A NO_ADDITIONAL_NEEDED de C3', na('NO_ADDITIONAL_NEEDED', ['C3'])],
    ['juízo C3', { ...c2Judgement('op-0003'), subcriterionId: 'C3', value: 'ALL_RELEVANT' } as unknown as OperatorRecord],
    ['confirmação de observação', { id: 'op-0003', kind: 'OBSERVATION_CONFIRMATION', subcriterionIds: ['S5'], operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord],
  ];
  for (const [name, record] of unsupported) {
    const out = run(makeBasis(), [record]);
    const blocker = find(out, 'DECISION_NOT_SUPPORTED');
    assert.deepEqual([blocker?.severity, blocker?.decisionIds], ['BLOCKING', ['op-0003']], name);
    assert.ok(out.blockers.some((b) => b.severity === 'BLOCKING'), name);
  }
  // o N/A de S3 passaria pelo motor (por isso o bloqueio é necessário): a causa é uma evidência qualquer da base
  const out = run(makeBasis(), [na('FEATURE_UNAVAILABLE', ['S3'], ['capture:c0001'])]);
  assert.equal(sub(scoreOf(out), 'S3').state, 'NOT_APPLICABLE');
  // NO_ADDITIONAL_NEEDED seria recusado pelo motor (contrariado): o bloqueio avisa antes
  const contradicted = scoreAudit(inputOf(run(makeBasis(), [na('NO_ADDITIONAL_NEEDED', ['C3'])])));
  assert.equal(contradicted.ok, false);
});

test('DECISÕES: N/A derivado pelo motor (NO_REVIEWS_PROVEN, NO_REPLIES_PROVEN, NO_WEBSITE_PROVEN) informado como entrada é recusado pelo contrato e bloqueia', () => {
  for (const code of ['NO_REVIEWS_PROVEN', 'NO_REPLIES_PROVEN', 'NO_WEBSITE_PROVEN']) {
    const record = { id: 'op-0004', kind: 'NOT_APPLICABLE', subcriterionIds: ['R1'], code, causeEvidenceIds: [], operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord;
    const out = run(makeBasis(), [record]);
    assert.equal(out.input, null, code);
    assert.deepEqual(codes(out).sort(), ['BLOCKING:DECISION_NOT_SUPPORTED', 'BLOCKING:ENGINE_CONTRACT_REJECTED'], code);
    assert.ok(out.contractIssues.length > 0 && out.contractIssues.length <= 10);
    assert.equal(out.criteriaView.length, 35, 'a visão continua disponível para mostrar o bloqueio');
  }
});

test('DECISÕES: evidência citada fora da base (inclusive site:cNNNN, que segue recusado) ⇒ bloqueio ligado à decisão e nenhuma entrada', () => {
  for (const cited of ['site:c0001', 'capture:c0099', 'report:c0001-r0009', '', 'x']) {
    const record = { id: 'op-0005', kind: 'NOT_APPLICABLE', subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: [cited], operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord;
    const out = run(makeBasis(), [record]);
    assert.equal(out.input, null, cited);
    const blocker = find(out, 'DECISION_EVIDENCE_NOT_IN_BASE');
    assert.deepEqual([blocker?.severity, blocker?.decisionIds, blocker?.subcriterionIds], ['BLOCKING', ['op-0005'], ['S3']], cited);
  }
  const images = { id: 'op-0006', kind: 'IMAGES_CONFIRMATION', imageTypes: ['PLACE'], evidenceIds: ['site:c0001'], operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord;
  assert.deepEqual(find(run(makeBasis(), [images]), 'DECISION_EVIDENCE_NOT_IN_BASE')?.decisionIds, ['op-0006']);
});

test('DECISÕES: citar evidência que ESTÁ na base (captura ou relatório, inclusive uma antiga) é aceito pelo contrato', () => {
  const basis = makeBasis({ evidences: [captureEvidence(1), reportEvidence(1, 1), captureEvidence(2, { observedAt: '2026-09-01T10:00:00.000Z', contentSha256: hash('3'), bodySha256: hash('4') })] });
  const record = { id: 'op-0005', kind: 'NOT_APPLICABLE', subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['capture:c0002', 'report:c0001-r0001'], operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord;
  const out = run(basis, [record]);
  assert.ok(out.input);
  assert.equal(find(out, 'DECISION_EVIDENCE_NOT_IN_BASE'), undefined);
  assert.ok(find(out, 'DECISION_NOT_SUPPORTED'), 'continua fora do contrato aprovado');
});

test('DECISÕES: atestado de escopo do site (o mapeador não envia site) ⇒ bloqueio e o contrato recusa; decisão datada no futuro ⇒ nenhuma entrada', () => {
  const attestation = { id: 'op-0008', kind: 'SITE_SCOPE_ATTESTATION', subcriterionIds: ['S5'], scopeDescription: 'Escopo descrito com mais de vinte caracteres.', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord;
  const out = run(makeBasis(), [attestation]);
  assert.equal(out.input, null);
  assert.deepEqual(codes(out).sort(), ['BLOCKING:DECISION_NOT_SUPPORTED', 'BLOCKING:ENGINE_CONTRACT_REJECTED']);
  assert.deepEqual(find(out, 'ENGINE_CONTRACT_REJECTED')?.decisionIds, ['op-0008'], 'a decisão responsável é apontada');
  const future = run(makeBasis(), [c2Judgement('op-0001', 'COMPATIBLE', '2026-10-24T09:00:00.000Z')], NOW);
  assert.equal(future.input, null);
  assert.deepEqual([find(future, 'DECISION_DATED_IN_FUTURE')?.severity, find(future, 'DECISION_DATED_IN_FUTURE')?.decisionIds], ['BLOCKING', ['op-0001']]);
  assert.ok(run(makeBasis(), [c2Judgement('op-0001', 'COMPATIBLE', '2026-10-23T09:59:59.000Z')], NOW).input, 'mesmo dia que o servidor não é futuro');
});

test('DECISÕES: sem efeito com os fatos enviados ⇒ aviso (C2 sem categoria; equivalência de nomes sem fonte NAP externa); nunca altera o cálculo', () => {
  const noCategory = run(withProfile({ primaryCategory: null }), [c2Judgement()]);
  assert.equal(find(noCategory, 'DECISION_HAS_NO_EFFECT')?.severity, 'WARNING');
  assert.deepEqual(find(noCategory, 'DECISION_HAS_NO_EFFECT')?.decisionIds, ['op-0001']);
  const c2 = sub(scoreOf(noCategory), 'C2');
  assert.deepEqual([c2.state, c2.reasonCode, c2.evaluatedHalfPoints], ['NOT_VERIFIED', 'BASIS_MISSING', 0], 'o motor não pontua C2 sem categoria');
  assert.deepEqual(noCategory.criteriaView.find((row) => row.id === 'C2')?.source, 'BLOQUEADO');
  const equivalence = { id: 'op-0010', kind: 'NAME_EQUIVALENCE', nameA: 'Padaria Exemplo', nameB: 'Padaria Exemplo LTDA', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord;
  const out = run(makeBasis(), [equivalence]);
  assert.deepEqual([find(out, 'DECISION_HAS_NO_EFFECT')?.severity, find(out, 'DECISION_NOT_SUPPORTED')], ['WARNING', undefined]);
  assert.equal(scoreOf(out).totals.evaluatedHalfPoints, 26);
});

test('DECISÕES: pontos, índice, cobertura ou resultado enviados dentro de um registro (o cliente não fornece pontuação) ⇒ entrada recusada', () => {
  for (const key of ['points', 'obtainedHalfPoints', 'index', 'coveragePercent', 'classification', 'score', 'tier']) {
    const record = { ...c2Judgement(), [key]: 8 } as unknown as OperatorRecord;
    const out = run(makeBasis(), [record]);
    assert.equal(out.input, null, key);
    assert.ok(find(out, 'ENGINE_CONTRACT_REJECTED'), key);
    assert.equal(out.inputSha256, null);
  }
});

test('DECISÕES: formas inválidas (não é lista, mais de 200, sem id/tipo, valor que não é JSON) ⇒ OPERATOR_RECORDS_INVALID sem exceção', () => {
  const bad: unknown[] = [null, 'x', {}, Array.from({ length: 201 }, (_, i) => ({ ...c2Judgement(`op-${String(i).padStart(4, '0')}`) })), [null], [{}], [{ id: 5, kind: 'JUDGEMENT' }], [{ id: 'op-1' }], [{ ...c2Judgement(), fn: () => 1 }], [{ ...c2Judgement(), n: Number.NaN }]];
  for (const records of bad) {
    const out = assembleScoringInput(makeBasis(), records as never, { now: NOW });
    assert.equal(out.input, null);
    assert.equal(out.blockers[0]?.code, 'OPERATOR_RECORDS_INVALID', JSON.stringify(records).slice(0, 60));
  }
});

test('DECISÕES: dois juízos de C2 / ids repetidos violam o contrato ⇒ recusa com mensagens limitadas (≤10 × 300)', () => {
  const out = run(makeBasis(), [c2Judgement('op-0001'), c2Judgement('op-0001', 'PARTIAL')]);
  assert.equal(out.input, null);
  assert.ok(find(out, 'ENGINE_CONTRACT_REJECTED'));
  assert.ok(out.contractIssues.length >= 1 && out.contractIssues.length <= 10);
  assert.ok(out.contractIssues.every((issue) => issue.length <= 300));
});

/* ---------------------------------------------------------------- 10. identificador (alias) */
test('AUDIT ID: com "_" o motor recebe o alias determinístico e o rastro guarda regra, motivo e o id real; sem "_" nada muda', () => {
  const plain = run();
  assert.deepEqual(plain.traceability.auditId, { applied: false, rule: 'IDENTITY', reason: null, sourceAuditId: AUDIT, scoringAuditId: AUDIT });
  assert.equal(inputOf(plain).auditId, AUDIT);
  const out = run(makeBasis({ auditId: 'tuvaplast_20261022_maps01' }));
  const alias = out.traceability.auditId;
  assert.deepEqual([alias?.applied, alias?.rule, alias?.reason, alias?.sourceAuditId], [true, 'lumos-audit-id-alias-v1', 'CONTAINS_UNDERSCORE', 'tuvaplast_20261022_maps01']);
  assert.equal(inputOf(out).auditId, alias?.scoringAuditId);
  assert.equal(scoreOf(out).auditId, alias?.scoringAuditId);
  assert.ok(!JSON.stringify(inputOf(out)).includes('tuvaplast_20261022_maps01'), 'o id real não entra no motor');
});

test('AUDIT ID: "a_b" e "a-b" (e o próprio alias como id comum) geram entradas com identificadores distintos', () => {
  const a = run(makeBasis({ auditId: 'padaria_exemplo_01' }));
  const b = run(makeBasis({ auditId: 'padaria-exemplo-01' }));
  assert.notEqual(inputOf(a).auditId, inputOf(b).auditId);
  const forged = run(makeBasis({ auditId: inputOf(a).auditId }));
  assert.notEqual(inputOf(forged).auditId, inputOf(a).auditId);
  assert.equal(forged.traceability.auditId?.reason, 'RESERVED_SHAPE');
});

test('AUDIT ID inválido para o armazenamento ⇒ nenhuma entrada', () => {
  for (const auditId of ['', 'curto', 'COM MAIUSCULA', '../fora', 'a'.repeat(65), 5, null, undefined]) {
    const basis = makeBasis();
    (basis as { auditId: unknown }).auditId = auditId;
    const out = run(basis);
    assert.equal(out.input, null, String(auditId));
    assert.ok(['AUDIT_ID_INVALID', 'BASIS_INVALID'].includes(out.blockers[0]?.code ?? ''), String(auditId));
  }
});

/* ---------------------------------------------------------------- 11. determinismo, imutabilidade, independência do relógio */
test('DETERMINISMO: entradas idênticas ⇒ saídas idênticas (profundamente), repetidas vezes', () => {
  const records = [c2Judgement(), s4NotApplicable()];
  const first = JSON.stringify(run(makeBasis(), records));
  for (let i = 0; i < 25; i += 1) assert.equal(JSON.stringify(run(makeBasis(), records)), first);
});

test('DETERMINISMO: a ordem das evidências e das decisões na entrada não muda a entrada, o hash, o rastro nem os bloqueios', () => {
  const evidences = [captureEvidence(1), reportEvidence(1, 1, { superseded: true, contentSha256: hash('1') }), reportEvidence(1, 2), captureEvidence(2, { contentSha256: hash('3'), bodySha256: hash('4'), observedAt: '2026-09-30T08:00:00.000Z' })];
  const records = [c2Judgement('op-0001'), s4NotApplicable('op-0002')];
  const reference = run(makeBasis({ evidences }), records);
  const shuffles: Array<[typeof evidences, typeof records]> = [[[...evidences].reverse(), [...records].reverse()], [[evidences[2] as never, evidences[0] as never, evidences[3] as never, evidences[1] as never], records], [evidences, [...records].reverse()]];
  for (const [e, r] of shuffles) {
    const out = run(makeBasis({ evidences: e }), r);
    assert.equal(out.inputSha256, reference.inputSha256);
    assert.deepEqual(out.input, reference.input);
    assert.deepEqual(out.traceability, reference.traceability);
    assert.deepEqual(out.blockers, reference.blockers);
    assert.deepEqual(out.criteriaView, reference.criteriaView);
  }
});

test('IMUTABILIDADE: base, decisões e opções congeladas não quebram o mapeador, e a saída não compartilha objetos com a entrada', () => {
  const deepFreeze = <T,>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  const basis = deepFreeze(makeBasis());
  const records = deepFreeze([c2Judgement(), s4NotApplicable()]);
  const options = deepFreeze({ now: NOW });
  const out = assembleScoringInput(basis, records, options);
  assert.ok(out.input && out.blockers.length === 0);
  const second = assembleScoringInput(basis, records, options);
  (out.input.evidences[0] as { id: string }).id = 'adulterado';
  (out.traceability.evidences[0] as { ref: string }).ref = 'adulterado';
  assert.equal(second.input?.evidences[0]?.id, 'capture:c0001', 'chamadas independentes');
  assert.equal(basis.evidences[0]?.ref, 'capture:c0001');
  assert.notEqual(out.traceability.profile, basis.profile);
});

test('O INSTANTE INJETADO só serve às verificações de "data futura": qualquer `now` ≥ evidências e decisões produz a MESMA entrada', () => {
  const reference = run(makeBasis(), [c2Judgement()], '2026-10-22T13:10:00.000Z');
  for (const now of ['2026-10-23T00:00:00.000Z', '2026-11-30T12:00:00.000Z', '2030-01-01T00:00:00.000Z', '2026-10-22']) {
    const out = run(makeBasis(), [c2Judgement()], now);
    assert.equal(out.inputSha256, reference.inputSha256, now);
    assert.deepEqual(out.traceability, reference.traceability);
  }
});

test('OPÇÕES inválidas (sem `now`, não textual, data impossível) ⇒ nenhuma entrada, sem exceção', () => {
  for (const options of [undefined, null, {}, { now: 5 }, { now: '' }, { now: 'hoje' }, { now: '2026-13-40T00:00:00Z' }, { now: null }] as unknown[]) {
    const out = assembleScoringInput(makeBasis(), [], options as never);
    assert.equal(out.input, null);
    assert.deepEqual(codes(out), ['BLOCKING:INVALID_OPTIONS']);
    assert.equal(out.traceability.mapperVersion, 'lumos-map-v1');
  }
});

/* ---------------------------------------------------------------- 12. robustez: base malformada nunca derruba nem engana */
test('BASE malformada ⇒ BASE_INVALID com motivo fixo, sem exceção e sem entrada', () => {
  const good = makeBasis();
  const cases: Array<[string, (b: Record<string, unknown>) => void, string]> = [
    ['versão desconhecida', (b) => { b.version = 'scoring-basis-v2'; }, 'BASIS_VERSION_UNSUPPORTED'],
    ['layout inválido', (b) => { b.layout = 'OUTRO'; }, 'LAYOUT_INVALID'],
    ['sem evidências', (b) => { b.evidences = []; }, 'EVIDENCES_INVALID'],
    ['evidências não é lista', (b) => { b.evidences = 'x'; }, 'EVIDENCES_INVALID'],
    ['mais de 500 evidências', (b) => { b.evidences = Array.from({ length: 501 }, (_, i) => captureEvidence(i + 1)); }, 'EVIDENCES_INVALID'],
    ['só relatórios', (b) => { b.evidences = [reportEvidence(1, 1)]; }, 'NO_CAPTURE'],
    ['ref duplicada', (b) => { b.evidences = [captureEvidence(1), captureEvidence(1)]; }, 'EVIDENCE_REF_INVALID'],
    ['ref inválida', (b) => { b.evidences = [captureEvidence(1, { ref: 'capture:abc' })]; }, 'EVIDENCE_REF_INVALID'],
    ['ref de site', (b) => { b.evidences = [captureEvidence(1), { ...captureEvidence(1), ref: 'site:c0001' }]; }, 'EVIDENCE_REF_INVALID'],
    ['tipo ≠ prefixo', (b) => { b.evidences = [captureEvidence(1, { kind: 'REPORT' })]; }, 'EVIDENCE_KIND_MISMATCH'],
    ['hash inválido', (b) => { b.evidences = [captureEvidence(1, { contentSha256: 'xyz' })]; }, 'EVIDENCE_HASH_INVALID'],
    ['hash em maiúsculas', (b) => { b.evidences = [captureEvidence(1, { contentSha256: 'A'.repeat(64) })]; }, 'EVIDENCE_HASH_INVALID'],
    ['hash do corpo inválido', (b) => { b.evidences = [captureEvidence(1, { bodySha256: 'xyz' })]; }, 'EVIDENCE_BODY_HASH_INVALID'],
    ['origem que não é Google nativo', (b) => { b.evidences = [captureEvidence(1, { origin: 'OFFICIAL_SITE' as never })]; }, 'EVIDENCE_ORIGIN_UNSUPPORTED'],
    ['provedor desconhecido', (b) => { b.evidences = [captureEvidence(1, { provider: 'outro' as never })]; }, 'EVIDENCE_ORIGIN_UNSUPPORTED'],
    ['sem marca de intermediário', (b) => { b.evidences = [captureEvidence(1, { intermediary: false as never })]; }, 'EVIDENCE_ORIGIN_UNSUPPORTED'],
    ['flags inválidas', (b) => { b.evidences = [captureEvidence(1, { legacy: 'sim' as never })]; }, 'EVIDENCE_FLAGS_INVALID'],
    ['perfil ausente', (b) => { delete b.profile; }, 'PROFILE_INVALID'],
    ['estado de perfil inventado', (b) => { b.profile = { state: 'OUTRO' }; }, 'PROFILE_INVALID'],
  ];
  for (const [name, change, reason] of cases) {
    const basis = clone(good) as unknown as Record<string, unknown>;
    change(basis);
    const out = assembleScoringInput(basis as never, [], { now: NOW });
    assert.equal(out.input, null, name);
    assert.deepEqual([out.blockers[0]?.code, out.blockers[0]?.reasonCode], ['BASIS_INVALID', reason], name);
  }
  for (const junk of [null, undefined, 'x', 5, [], () => 1]) {
    const out = assembleScoringInput(junk as never, [], { now: NOW });
    assert.equal(out.input, null);
    assert.equal(out.blockers[0]?.code, 'BASIS_INVALID');
  }
});

test('BASE incoerente com o perfil: fonte do perfil que não é uma captura da base, hashes diferentes ou identidade não provada ⇒ recusa', () => {
  const source = (change: Record<string, unknown>) => richProfile({ source: { ref: 'capture:c0001', observedAt: OBSERVED, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH, ...change } });
  const bad: Array<[string, BasisProfile]> = [
    ['fonte fora da base', source({ ref: 'capture:c0009' })],
    ['fonte é relatório', source({ ref: 'report:c0001-r0001' })],
    ['fonte é relatório com os MESMOS hashes e data da captura (só o tipo da evidência a denuncia)', source({ ref: 'report:c0001-r0002' })],
    ['hash do conteúdo diferente', source({ contentSha256: hash('9') })],
    ['hash do corpo diferente', source({ bodySha256: hash('9') })],
    ['data da fonte diferente', source({ observedAt: '2026-10-21T00:00:00.000Z' })],
    ['identidade não provada', richProfile({ identity: { state: 'PROVEN', matchedBy: { cid: false, placeId: false }, expectedCidOrigin: null } })],
    ['identidade com estado inválido', richProfile({ identity: { state: 'UNPROVEN' as never, matchedBy: { cid: true, placeId: false }, expectedCidOrigin: null } })],
    ['sem status de relatório', { ...richProfile(), reportEvidence: undefined } as never],
  ];
  for (const [name, profile] of bad) {
    const sameHashesReport = reportEvidence(1, 2, { contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH, observedAt: OBSERVED });
    const out = run(makeBasis({ profile, evidences: [captureEvidence(1), reportEvidence(1, 1), sameHashesReport] }));
    assert.equal(out.input, null, name);
    assert.deepEqual([out.blockers[0]?.code, out.blockers[0]?.reasonCode], ['BASIS_INVALID', 'PROFILE_SOURCE_INCONSISTENT'], name);
  }
});

test('FUZZ determinístico (1.500 bases adulteradas): nunca lança, nunca envia complete:true sem prova, nunca inventa avaliações — e toda entrada devolvida passa no contrato', () => {
  let seed = 90210;
  const next = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);
  const junk: unknown[] = [null, undefined, 0, -1, 1e9, '', ' ', 'x'.repeat(5000), true, false, [], {}, [1, 2], { a: 1 }, Number.NaN, 'VERIFIED', 'http://evil.example/?token=SEGREDO'];
  const paths: string[][] = [['auditId'], ['layout'], ['evidences'], ['profile'], ['profile', 'name'], ['profile', 'phone'], ['profile', 'primaryCategory'], ['profile', 'additionalCategories'], ['profile', 'address'], ['profile', 'hoursRaw'], ['profile', 'website'], ['profile', 'website', 'derived'], ['profile', 'website', 'utm'], ['profile', 'website', 'derivation'], ['profile', 'reportEvidence'], ['profile', 'source'], ['profile', 'identity'], ['informational']];
  for (let i = 0; i < 1500; i += 1) {
    const basis = clone(makeBasis()) as unknown as Record<string, unknown>;
    for (let k = 0; k < 1 + Math.floor(next() * 3); k += 1) {
      const path = paths[Math.floor(next() * paths.length)] as string[];
      let holder = basis;
      for (const key of path.slice(0, -1)) holder = (holder[key] && typeof holder[key] === 'object' ? holder[key] : (holder[key] = {})) as Record<string, unknown>;
      holder[path[path.length - 1] as string] = junk[Math.floor(next() * junk.length)];
    }
    let out: AssembleResult | undefined;
    assert.doesNotThrow(() => { out = assembleScoringInput(basis as never, [c2Judgement()], { now: NOW }); }, `iteração ${i}`);
    const result = out as AssembleResult;
    assert.equal(find(result, 'MAPPER_INTERNAL_ERROR'), undefined, `erro interno na iteração ${i}`);
    if (result.input) {
      assert.ok(parseScoringInput(result.input).ok, `iteração ${i}`);
      const input = result.input;
      const completes = Object.entries(input.profile ?? {}).flatMap(([key, list]) => (list as Array<{ complete: boolean }>).filter((item) => item.complete).map(() => key));
      assert.ok(completes.every((key) => key === 'website'), `iteração ${i}: complete:true fora do website`);
      if (completes.length > 0) assert.equal(result.traceability.websiteDerivation?.x5Proof, 'PROVEN', `iteração ${i}`);
      assert.ok(!Object.hasOwn(input.profile ?? {}, 'reviews'));
      const sent = input.profile?.website?.[0]?.value;
      if (sent !== undefined) assert.match(String(sent), /^https?:\/\/[^/?#@\s]+\/(?:\?utm_[a-z]+=x(?:&utm_[a-z]+=x)*)?$/, `iteração ${i}: website fora da forma mínima`);
      const engine = scoreAudit(input);
      if (engine.ok) {
        assert.ok(engine.result.subcriteria.every((s) => s.state !== 'ABSENCE_PROVEN'), `iteração ${i}`);
        assert.deepEqual(engine.result.naRegistry, [], `iteração ${i}`);
      }
    } else assert.ok(result.blockers.some((b) => b.severity === 'BLOCKING'), `iteração ${i}: sem entrada exige bloqueio`);
  }
});

/* ---------------------------------------------------------------- 13. rastreabilidade e sanidade da visão */
test('VISÃO: sempre 35 linhas na ordem da régua, com fonte entre as 4 permitidas, sem pontos e sem texto livre da fonte', () => {
  for (const out of [run(), run(makeBasis({ profile: unavailable('NOT_LOCATED') })), run(makeBasis(), [c2Judgement(), s4NotApplicable()]), run(withProfile({ website: NO_UTM_WEBSITE(), name: null }))]) {
    assert.equal(out.criteriaView.length, 35);
    assert.deepEqual(out.criteriaView.map((row) => row.id), CRITERIA_SOURCES.map((row) => row.id));
    for (const row of out.criteriaView) {
      assert.ok(['AUTOMATICO', 'DECISAO_HUMANA', 'BLOQUEADO', 'SEM_DADO'].includes(row.source), row.id);
      assert.deepEqual(Object.keys(row).sort(), ['criterionId', 'decisionIds', 'evidenceRefs', 'factEmitted', 'id', 'maxHalfPoints', 'reasonCode', 'source']);
    }
  }
});

test('BLOQUEIOS: ordenados (BLOCKING primeiro), mensagens fixas sem valores da fonte, ids de decisão e subcritérios ordenados e únicos', () => {
  const na = { id: 'op-0003', kind: 'NOT_APPLICABLE', subcriterionIds: ['S3', 'A1'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['capture:c0001'], operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-22T13:30:00.000Z', justification: 'Justificativa com mais de vinte caracteres.' } as unknown as OperatorRecord;
  const out = run(withProfile({ name: 'N'.repeat(400), reportEvidence: { ...ALL_VERIFIED, 'maps-phone': 'NOT_VERIFIED' } }), [na, c2Judgement('op-0001')]);
  const severities = out.blockers.map((b) => b.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => (a === b ? 0 : a === 'BLOCKING' ? -1 : 1)));
  for (const b of out.blockers) {
    assert.deepEqual([...b.decisionIds], [...new Set(b.decisionIds)].sort());
    assert.deepEqual([...b.subcriterionIds], [...new Set(b.subcriterionIds)].sort());
    assert.ok(!b.message.includes('N'.repeat(10)) && !b.message.includes('3000'), b.code);
  }
  assert.ok(out.blockers.length >= 3);
});

test('valores desconhecidos da base nunca são copiados: status de relatório que o leitor não produz vira NÃO verificado; motivo de perfil indisponível desconhecido vira UNKNOWN', () => {
  const out = run(withProfile({ reportEvidence: { ...ALL_VERIFIED, 'maps-phone': 'TALVEZ<script>alert(1)</script>' as never } }));
  assert.ok(!profileKeys(out).includes('phone'), 'status desconhecido não verifica o fato');
  assert.equal(out.traceability.facts.find((fact) => fact.field === 'phone')?.reportStatus, 'NOT_VERIFIED');
  assert.ok(!JSON.stringify(out).includes('TALVEZ') && !JSON.stringify(out).includes('script'));
  assert.deepEqual([find(out, 'FIELD_CONTRADICTED_BY_REPORT')?.severity, find(out, 'FIELD_CONTRADICTED_BY_REPORT')?.subcriterionIds], ['WARNING', ['N3']]);
  const unknown = run(makeBasis({ profile: { state: 'UNAVAILABLE', reason: `http://evil.example/${'x'.repeat(500)}` } as never }));
  assert.deepEqual(unknown.traceability.profile, { state: 'UNAVAILABLE', reason: 'UNKNOWN' });
  assert.equal(find(unknown, 'PROFILE_UNAVAILABLE')?.reasonCode, 'UNKNOWN');
  assert.ok(!JSON.stringify(unknown).includes('evil.example'));
});

test('registros do operador malformados (campos de tipo errado) nunca viram erro interno: o contrato recusa e a entrada não é gerada', () => {
  const junk: unknown[] = [5, 'S4', null, {}, [], ['S4', 7]];
  for (const value of junk) {
    for (const kind of ['NOT_APPLICABLE', 'JUDGEMENT', 'SITE_SCOPE_ATTESTATION', 'IMAGES_CONFIRMATION']) {
      const record = { id: 'op-0001', kind, code: 'BUSINESS_MODEL', subcriterionIds: value, subcriterionId: value, evidenceIds: value, causeEvidenceIds: value } as unknown as OperatorRecord;
      const out = run(makeBasis(), [record]);
      assert.equal(out.input, null, `${kind}/${JSON.stringify(value)}`);
      assert.equal(find(out, 'MAPPER_INTERNAL_ERROR'), undefined, `${kind}/${JSON.stringify(value)}`);
      assert.ok(find(out, 'ENGINE_CONTRACT_REJECTED'), `${kind}/${JSON.stringify(value)}`);
    }
  }
});

test('REVISÃO: rastro só com formatos válidos; id de registro validado; TOO_OLD na visão; finalizable; atribuição exata (op-1 ≠ op-10); fronteiras de idade 90/91/180/181', () => {
  const evil = 'http://evil.example/p?token=SEGREDO';
  const site = website();
  (site.derivation as { rule: string }).rule = evil;
  (site.derivation as { rawSha256: string }).rawSha256 = evil;
  const out = run(withProfile({ website: site }));
  assert.ok(!JSON.stringify(out.traceability).includes('evil.example'));
  const longId = run(makeBasis(), [c2Judgement(`op-${'9'.repeat(3000)}`)]);
  assert.equal(longId.input, null);
  assert.ok(!JSON.stringify(longId).includes('9999999999'));
  assert.equal(run().finalizable, true);
  assert.equal(run(makeBasis(), [{ ...c2Judgement('op-0003'), subcriterionId: 'C3', value: 'ALL_RELEVANT' } as unknown as OperatorRecord]).finalizable, false);
  assert.equal(run(makeBasis({ profile: unavailable('NOT_LOCATED') })).finalizable, true);
  const two = run(makeBasis(), [c2Judgement('op-1'), c2Judgement('op-10', 'PARTIAL')]);
  assert.equal(two.input, null);
  assert.ok(two.finalizable === false);
  const age = (days: number) => {
    const day = new Date(Date.UTC(2026, 9, 22) - days * 86_400_000).toISOString();
    const second = '2026-10-22T10:00:00.000Z';
    return run(makeBasis({ evidences: [captureEvidence(1, { observedAt: day }), reportEvidence(1, 1, { observedAt: day }), captureEvidence(2, { observedAt: second, contentSha256: hash('3'), bodySha256: null })], profile: richProfile({ source: { ref: 'capture:c0001', observedAt: day, contentSha256: CAPTURE_HASH, bodySha256: BODY_HASH } }) }));
  };
  const status = (days: number) => (age(days).traceability.profile.state === 'AVAILABLE' ? (age(days).traceability.profile as { ageStatus: string }).ageStatus : '');
  assert.deepEqual([90, 91, 180, 181].map(status), ['CURRENT', 'AGED', 'AGED', 'TOO_OLD']);
  assert.equal(scoreOf(age(180)).totals.evaluatedHalfPoints, 22, 'em 180 dias o motor ainda pontua (sem prova de UTM nesta fixture)');
  const old = age(181);
  assert.equal(scoreOf(old).totals.evaluatedHalfPoints, 0);
  assert.ok(old.criteriaView.filter((row) => ['N1', 'N3', 'C1', 'X1'].includes(row.id)).every((row) => row.source === 'SEM_DADO' && row.reasonCode === 'EVIDENCE_TOO_OLD'));
});

test('GOLDEN (M-12): alias e hash de entrada fixados; mudar a política muda estes valores', () => {
  assert.equal(deriveAuditIdAlias('tuvaplast_20261022_maps01')?.scoringAuditId, 'tuvaplast-20261022-maps01-ux48cf1572f15dc5462676d619ff59df9d');
  assert.equal(run(makeBasis(), [c2Judgement()]).inputSha256, '48d6add1ce58a897ecfb99d661b291b338cd8c2a873caaf606c77cc2b0433f0b');
});
