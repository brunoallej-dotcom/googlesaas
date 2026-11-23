import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { scoreAudit, type OperatorRecord, type ScoreResult } from '../src/lib/link-audit/scoring';
import { SCORING_BASIS_VERSION } from '../src/lib/link-audit-evidence/scoring-basis';
import { assembleScoringInput } from '../src/lib/link-audit-scoring-runs/assemble';
import { AUDIT as _AUDIT_UNUSED, registerCleanup } from './helpers/link-audit-evidence-fixtures';
import { c2Judgement, NOW } from './helpers/link-audit-mapper-fixtures';
import { addCapture, legacyReplica, readBasis, treeState, versioned } from './helpers/link-audit-mapper-real-basis';

/*
 * Onda 6C, I2 — cadeia completa com o LEITOR REAL do I1: pasta de evidências fictícia → base verificada → mapeador → contrato do
 * motor → motor real. Prova que o que o leitor entrega é exatamente o que o mapeador sabe usar (e nada além).
 */
registerCleanup();
void _AUDIT_UNUSED;
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const SECRET_WEBSITE = 'https://www.padaria-exemplo.example/loja/SEGREDO8/CAMINHO-SECRETO;jsessionid=SEGREDO9?utm_source=ORIGEM-S&utm_medium=MEIO-M&utm_campaign=CAMPANHA-C&sid=SEGREDO12&igsh=SEGREDO-IG#frag-SEGREDO'; // (sem `token=`: o próprio pipeline de relatórios recusa gravar isso)

async function chain(base: string, auditId: string, records: OperatorRecord[] = [], now = NOW) {
  const basis = await readBasis(base, auditId);
  const out = assembleScoringInput(basis, records, { now });
  assert.ok(out.input, JSON.stringify(out.blockers) + JSON.stringify(out.contractIssues));
  const outcome = scoreAudit(out.input);
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join(';'));
  return { basis, out, result: outcome.result as ScoreResult };
}
const state = (result: ScoreResult, id: string) => result.subcriteria.find((item) => item.id === id)?.state;

test('CADEIA REAL (UTM completo no bruto, com segredos no caminho/consulta/fragmento): 26 hp, prova positiva, e NENHUM segredo, parâmetro ou caminho chega à entrada, ao rastro ou ao resultado', async () => {
  const { base, auditId, body } = await versioned({ place: { website: SECRET_WEBSITE } });
  const { basis, out, result } = await chain(base, auditId);
  assert.equal(basis.version, SCORING_BASIS_VERSION, 'a versão literal do mapeador acompanha a do leitor');
  assert.equal(result.totals.evaluatedHalfPoints, 26);
  assert.deepEqual([state(result, 'X1'), state(result, 'X5')], ['SCORED', 'SCORED']);
  assert.equal(out.input?.profile?.website?.[0]?.value, 'https://www.padaria-exemplo.example/?utm_campaign=x&utm_medium=x&utm_source=x');
  assert.equal(out.input?.profile?.website?.[0]?.complete, true);
  assert.equal(out.traceability.websiteDerivation?.rawSha256, sha(SECRET_WEBSITE), 'o hash do bruto confere com o website da captura armazenada');
  assert.ok(body.includes(SECRET_WEBSITE.replace(/"/g, '\\"')) || body.includes('SEGREDO8'), 'o bruto está de fato na captura (a fixture é válida)');
  const everything = JSON.stringify({ input: out.input, trace: out.traceability, blockers: out.blockers, view: out.criteriaView, issues: out.contractIssues, result });
  for (const leak of ['SEGREDO', 'ORIGEM-S', 'MEIO-M', 'CAMPANHA-C', 'jsessionid', 'token=', 'igsh', 'frag-', 'loja/', 'CAMINHO-SECRETO', 'Bearer']) assert.ok(!everything.includes(leak), `vazou ${leak}`);
});

test('CADEIA REAL: UTM vazia, parcial, não observada ou sem esquema ⇒ 22 hp (ou 18 sem website legível); X5 sempre Não verificado, nunca zero', async () => {
  const cases: Array<[string, string, number, string]> = [
    ['valores vazios', 'https://padaria.example/?utm_source=&utm_medium=', 22, 'NOT_OBSERVED'],
    ['só espaços', 'https://padaria.example/?utm_source=%20&utm_medium=%20%20', 22, 'NOT_OBSERVED'],
    ['parcial', 'https://padaria.example/?utm_source=google', 22, 'PARTIAL'],
    ['só campanha', 'https://padaria.example/?utm_campaign=verao', 22, 'PARTIAL'],
    ['não observada', 'https://padaria.example/', 22, 'NOT_OBSERVED'],
    ['só parâmetros não utm', 'https://padaria.example/?igsh=SEGREDO-IG&ref=abc', 22, 'NOT_OBSERVED'],
    ['UTM só no fragmento', 'https://padaria.example/#utm_source=a&utm_medium=b', 22, 'NOT_OBSERVED'],
  ];
  for (const [name, website, hp, level] of cases) {
    const { base, auditId } = await versioned({ place: { website } });
    const { out, result } = await chain(base, auditId);
    assert.equal(result.totals.evaluatedHalfPoints, hp, name);
    assert.equal(out.traceability.websiteDerivation?.utmLevel, level, name);
    assert.equal(out.input?.profile?.website?.[0]?.complete, false, name);
    const x5 = result.subcriteria.find((item) => item.id === 'X5');
    assert.deepEqual([x5?.state, x5?.obtainedHalfPoints, x5?.evaluatedHalfPoints], ['NOT_VERIFIED', 0, 0], name);
    assert.ok(result.subcriteria.every((item) => item.state !== 'ABSENCE_PROVEN'), name);
  }
  for (const website of ['www.padaria.example/?utm_source=a&utm_medium=b', 'padaria.example', 'ftp://padaria.example/?utm_source=a&utm_medium=b', 'javascript:alert(1)']) {
    const { base, auditId } = await versioned({ place: { website } });
    const { out, result } = await chain(base, auditId);
    assert.equal(result.totals.evaluatedHalfPoints, 18, website);
    assert.equal(out.input?.profile?.website, undefined, website);
    assert.equal(out.traceability.facts.find((fact) => fact.field === 'website')?.omittedReason, 'WEBSITE_UNPARSABLE', website);
  }
});

test('CADEIA REAL (M-4a): 0, 999, 1000, 1001, 50.000 avaliações no provedor ⇒ os FATOS da entrada são idênticos e R1/R2 seguem Não verificados', async () => {
  const profiles = new Set<string>();
  for (const ratingCount of [0, 999, 1000, 1001, 50_000]) {
    const { base, auditId } = await versioned({ place: { ratingCount, rating: ratingCount === 0 ? undefined : 4.9 } });
    const { basis, out, result } = await chain(base, auditId);
    assert.equal(basis.informational.reviews?.ratingCount ?? null, ratingCount, 'o leitor preserva o dado informativo');
    assert.deepEqual([state(result, 'R1'), state(result, 'R2')], ['NOT_VERIFIED', 'NOT_VERIFIED'], String(ratingCount));
    assert.deepEqual(result.naRegistry, [], String(ratingCount));
    assert.equal(result.displayData.reviews, null);
    assert.ok(!JSON.stringify(out.input).includes('reviews') && !JSON.stringify(out.input).includes('ratingCount'));
    profiles.add(JSON.stringify(out.input?.profile));
  }
  assert.equal(profiles.size, 1, 'a contagem de avaliações não participa dos fatos (os hashes das evidências diferem porque os corpos diferem)');
});

test('CADEIA REAL: layout LEGADO (réplica fictícia) ⇒ mesma política, hashes do legado e rastro com legacy:true', async () => {
  const { base, bodyText: body } = await legacyReplica();
  const { basis, out, result } = await chain(base, 'auditoria-teste-0001');
  assert.equal(basis.layout, 'LEGACY');
  assert.equal(out.traceability.layout, 'LEGACY');
  assert.deepEqual(out.traceability.evidences.map((e) => [e.ref, e.legacy, e.superseded]), [['capture:c0001', true, false], ['report:c0001-r0001', true, true], ['report:c0001-r0002', true, false]]);
  assert.equal(out.traceability.evidences[0]?.contentSha256, sha(body), 'legado: o hash da captura é o do corpo bruto do provedor');
  assert.equal(result.totals.evaluatedHalfPoints, 26, 'o legado tem UTM completo');
  assert.equal(out.traceability.websiteDerivation?.x5Proof, 'PROVEN');
  const text = JSON.stringify({ input: out.input, trace: out.traceability });
  for (const leak of ['TOKEN-LEGADO', 'ORIGEM-LEGADO', 'MEIO-LEGADO', 'serper-body', base]) assert.ok(!text.includes(leak), `vazou ${leak}`);
});

test('CADEIA REAL: auditId com "_" ⇒ alias no motor, id real no rastro, referências de evidência inalteradas; a leitura não escreve nada', async () => {
  const { base, auditId } = await versioned({ auditId: 'aud_001_autorizacao_01' });
  const before = treeState(base);
  const { out, result } = await chain(base, auditId);
  assert.equal(out.traceability.auditId?.sourceAuditId, 'aud_001_autorizacao_01');
  assert.match(out.input?.auditId ?? '', /^aud-001-autorizacao-01-ux[0-9a-f]{32}$/);
  assert.equal(result.auditId, out.input?.auditId);
  assert.deepEqual(out.input?.evidences.map((e) => e.id), ['capture:c0001', 'report:c0001-r0001']);
  assert.deepEqual(treeState(base), before, 'leitor + mapeador são só leitura');
});

test('CADEIA REAL: uma captura POSTERIOR sem resposta utilizável não troca o perfil, mas empurra a referenceDate (a evidência continua verificada e citável)', async () => {
  const { base, auditId } = await versioned();
  await addCapture(base, auditId, { collectedAt: '2026-10-25T08:00:00.000Z', status: 500, body: '{"erro":"x"}' });
  const { basis, out, result } = await chain(base, auditId, [], '2026-10-26T00:00:00.000Z');
  assert.equal(basis.profile.state === 'AVAILABLE' && basis.profile.source.ref, 'capture:c0001');
  assert.equal(out.input?.referenceDate, '2026-10-25');
  assert.deepEqual(out.traceability.referenceDateSource?.ref, 'capture:c0002');
  assert.deepEqual(out.input?.profile?.name?.[0]?.evidenceIds, ['capture:c0001']);
  assert.ok(out.input?.evidences.some((e) => e.id === 'capture:c0002'));
  assert.equal(result.totals.evaluatedHalfPoints, 22, 'a coleta padrão não tem UTM');
});

test('CADEIA REAL: a captura mais recente COM resposta utilizável é a única fonte do perfil (nunca mistura capturas)', async () => {
  const { base, auditId } = await versioned({ place: { phoneNumber: '(62) 3000-1111' } });
  await addCapture(base, auditId, { collectedAt: '2026-10-24T08:00:00.000Z', body: bodyWithPhone('(62) 3000-2222'), withReport: true });
  const { out } = await chain(base, auditId, [], '2026-10-26T00:00:00.000Z');
  assert.equal(out.input?.profile?.phone?.[0]?.value, '(62) 3000-2222');
  assert.deepEqual(out.input?.profile?.phone?.[0]?.evidenceIds, ['capture:c0002']);
  assert.deepEqual(out.input?.profile?.name?.[0]?.evidenceIds, ['capture:c0002'], 'todos os campos vêm da MESMA captura');
  assert.equal(out.input?.referenceDate, '2026-10-24');
});
function bodyWithPhone(phone: string): string {
  return JSON.stringify({ places: [{ title: 'Padaria Exemplo (fictícia)', address: 'Rua Fictícia, 100 - Cidade Exemplo - GO', phoneNumber: phone, website: 'https://www.padaria-exemplo.example/', type: 'Padaria', types: ['Padaria'], rating: 4.8, ratingCount: 86, cid: '1311768467294899695', fid: '0x935ef1a2b3c4d5e6:0x1234567890abcdef', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' }], credits: 3 });
}

test('CADEIA REAL: decisão C2 sobre a coleta fictícia ⇒ 34 hp (17 %), INSUFFICIENT, sem índice, sem confiança; o resultado é reproduzível', async () => {
  const { base, auditId } = await versioned({ place: { website: 'https://padaria.example/?utm_source=a&utm_medium=b' } });
  const { out, result } = await chain(base, auditId, [c2Judgement()]);
  assert.deepEqual([result.totals.evaluatedHalfPoints, result.totals.coveragePercent, result.publication.status, result.index, result.confidence], [34, 17, 'INSUFFICIENT', null, null]);
  const again = scoreAudit(out.input);
  assert.ok(again.ok);
  assert.equal(again.result.resultSha256, result.resultSha256, 'mesma entrada ⇒ mesmo resultado');
});

test('CADEIA REAL: leitura repetida ⇒ mesma base e mesma entrada (o leitor e o mapeador são determinísticos)', async () => {
  const { base, auditId } = await versioned();
  const first = await chain(base, auditId);
  const second = await chain(base, auditId);
  assert.deepEqual(second.basis, first.basis);
  assert.equal(second.out.inputSha256, first.out.inputSha256);
  assert.deepEqual(second.out, first.out);
});
