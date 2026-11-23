import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import { WITNESS_NOT_REQUIRED } from '../src/lib/link-audit-decisions/witness';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDecisionService, type EvidenceLookup } from '../src/lib/link-audit-decisions';
import { SITE_SCOPE_ISSUE } from '../src/lib/link-audit-decisions/contract';
import { createEvidenceReader } from '../src/lib/link-audit-evidence';
import { parseScoringInput } from '../src/lib/link-audit/scoring/input';
import { ALL_KIND_EXAMPLES, ANA, BIA, clock, entryPath, hashTree, must, rec, registerCleanup, tmpDir, withAutoHead, world } from './helpers/link-audit-decisions-fixtures';
import { evidence, richInput, run, scoreAudit, sub } from './helpers/link-audit-scoring-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';
import { AUD001_AUDIT, AUD001_BASE, aud001CapturePresent } from './helpers/link-audit-aud001-real-capture';

registerCleanup();

const REASON = 'Informação conferida e incorreta; decisão desfeita.';
const noFiles = (decisionsDir: string, auditId: string): boolean => {
  const dir = path.join(decisionsDir, auditId);
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
};

/** Leitor de evidências "de mentira" (rápido): uma captura e uma revisão de relatório existem. */
const fakeEvidence = (state: 'COMPLETE' | 'INCOMPLETE' | 'CORRUPT' = 'COMPLETE'): EvidenceLookup => ({
  async getIntegrity() {
    return { state, integrity: { status: state === 'CORRUPT' ? 'MISMATCH' : state === 'INCOMPLETE' ? 'INCOMPLETE' : 'OK' } };
  },
  async listVersions() {
    return [{ capture: 1, collectedAt: '2026-10-22T12:54:48.079Z', reportRevisions: state === 'INCOMPLETE' ? [] : [{ revision: 1 }] }];
  },
});

test('todos os tipos de decisão humana: criação e leitura, com autor e data do SERVIDOR, e a projeção passa no parseScoringInput', async () => {
  const w = await world();
  const stamps: string[] = [];
  for (const [index, { kind, record }] of ALL_KIND_EXAMPLES().entries()) {
    const now = clock();
    stamps.push(now);
    const created = await must(w.service.create(ANA, w.auditId, { record }, now));
    assert.equal(created.decision.kind, kind);
    assert.equal(created.decision.decisionId, `op-000${index + 1}`);
    assert.equal(created.decision.recordedBy, 'ana@empresa.com');
    assert.equal(created.decision.recordedAt, now);
    assert.equal(created.decision.status, 'ACTIVE');
    assert.deepEqual(created.decision.basis, { capture: 1, report: { capture: 1, revision: 1 }, collectedAt: '2026-10-22T12:54:48.079Z' });
    assert.equal(created.head.seq, index + 1);
  }
  const listed = await must(w.service.list(ANA, w.auditId));
  assert.equal(listed.decisions.length, 6);
  assert.deepEqual(listed.history.map((h) => [h.seq, h.action, h.recordedBy]), [1, 2, 3, 4, 5, 6].map((n) => [n, 'RECORD', 'ana@empresa.com']));
  assert.deepEqual(listed.operatorRecords.map((r) => r.id), ['op-0001', 'op-0002', 'op-0003', 'op-0004', 'op-0005', 'op-0006']);
  assert.deepEqual(listed.operatorRecords.map((r) => r.recordedAt), stamps);
  assert.equal(listed.integrity.status, 'OK');
  assert.equal(listed.integrity.checkedFiles, 6);
  assert.match(listed.integrity.note, /não é assinatura/);
  const parsed = parseScoringInput({
    schemaVersion: 1,
    auditId: 'auditoria-teste-0001',
    referenceDate: '2026-10-22',
    evidences: [{ id: 'capture:c0001', origin: 'GOOGLE_NATIVE', capture: 'STORED_CAPTURE', status: 'VERIFIED', observedAt: '2026-10-20T10:00:00Z', contentSha256: 'b'.repeat(64) }],
    operatorRecords: listed.operatorRecords,
  });
  // a única recusa possível aqui é o escopo do site (dado da coleta/6C, não da 6B): ver contract.ts
  assert.ok(parsed.ok || parsed.issues.every((issue) => SITE_SCOPE_ISSUE.test(issue)), parsed.ok ? '' : parsed.issues.join(' | '));
});

test('cada variante do contrato: C2, C3, P3 e os códigos de N/A permitidos são aceitos e ficam no formato exato da 6A', async () => {
  const w = await world();
  const variants = [rec.c2('PARTIAL'), rec.c3('MISSING_NEEDED'), rec.p3(8, 'GENERIC_OR_MIXED'), rec.naModel(), rec.naFeature(['capture:c0001', 'report:c0001-r0001']), rec.nameEquivalence('A Ltda', 'A'), rec.nameEquivalence('B Ltda', 'B')];
  // (o N/A "nenhuma necessária" de C3 é a alternativa ao juízo de C3: os dois juntos são recusados — ver o teste de contradições)
  for (const record of variants) await must(w.service.create(ANA, w.auditId, { record }, clock()));
  const listed = await must(w.service.list(ANA, w.auditId));
  assert.equal(listed.decisions.length, variants.length);
  const [c2, c3, p3, na] = listed.operatorRecords;
  assert.deepEqual([c2?.kind, (c2 as { value: string }).value], ['JUDGEMENT', 'PARTIAL']);
  assert.equal((p3 as { sampleSize: number }).sampleSize, 8);
  assert.deepEqual([c3?.kind, na?.kind, (na as { causeEvidenceIds: string[] }).causeEvidenceIds], ['JUDGEMENT', 'NOT_APPLICABLE', []]);
});

test('autor, data e identificador são do servidor: o cliente não consegue enviá-los (corpo recusado, nada gravado)', async () => {
  const w = await world();
  const record = rec.c2();
  for (const body of [
    { record, recordedBy: 'outro@empresa.com' },
    { record, recordedAt: '2020-01-01T00:00:00.000Z' },
    { record, operatorEmail: 'outro@empresa.com' },
    { record, id: 'op-0001' },
    { record, decisionId: 'op-0001' },
    { record: { ...record, operatorEmail: 'outro@empresa.com' } },
    { record: { ...record, recordedAt: '2020-01-01T00:00:00.000Z' } },
    { record: { ...record, id: 'op-0001' } },
    { record, seq: 7 },
    { record, basis: { capture: 9 } },
    { record: record.kind },
    {},
    null,
    'texto',
    [],
  ]) {
    const result = await w.service.create(ANA, w.auditId, body, clock());
    assert.ok(!result.ok && result.code === 'INVALID_BODY', JSON.stringify(body)?.slice(0, 60));
  }
  assert.ok(noFiles(w.decisionsDir, w.auditId));
  // o autor é o da sessão, normalizado
  const made = await must(w.service.create({ email: ' ANA@Empresa.COM ' }, w.auditId, { record }, clock()));
  assert.equal(made.decision.recordedBy, 'ana@empresa.com');
});

test('pontuação, índice, cobertura, confiança ou resultado vindos do cliente são recusados em QUALQUER profundidade', async () => {
  const w = await world();
  const record = rec.c2();
  const bodies: unknown[] = [
    { record, points: 5 },
    { record: { ...record, score: 3 } },
    { record: { ...record, nested: { deep: { index: 1 } } } },
    { record: { ...record, Cobertura: 80 } },
    { record: { ...record, obtainedHalfPoints: 8 } },
    { record: { ...record, tier: 'FAIXA_MAXIMA' } },
    { record: { ...record, confidence: 'HIGH' } },
    { record: { ...record, resultSha256: 'a'.repeat(64) } },
    { record, status: 'SCORED' },
    { record: { ...record, classification: 'STRONG' } },
    { record: { ...record, publication: {} } },
  ];
  for (const body of bodies) {
    const r = await w.service.create(ANA, w.auditId, body, clock());
    assert.ok(!r.ok && r.code === 'FORBIDDEN_FIELDS', JSON.stringify(body).slice(0, 70));
  }
  const revoke = await w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, points: 1 }, clock());
  assert.ok(!revoke.ok && revoke.code === 'FORBIDDEN_FIELDS');
  assert.ok(noFiles(w.decisionsDir, w.auditId));
});

test('identidade do operador que o contrato não aceita (ex.: bypass de desenvolvimento dev@localhost) não grava nada', async () => {
  const w = await world();
  for (const email of ['dev@localhost', '', 'sem-arroba', 'a b@c.com', 'x'.repeat(260) + '@a.com']) {
    const c = await w.service.create({ email }, w.auditId, { record: rec.c2() }, clock());
    assert.ok(!c.ok && c.code === 'OPERATOR_IDENTITY_INVALID', email.slice(0, 20));
    const r = await w.service.revoke({ email }, w.auditId, { revokes: 'op-0001', reason: REASON }, clock());
    assert.ok(!r.ok && r.code === 'OPERATOR_IDENTITY_INVALID');
  }
  assert.ok(noFiles(w.decisionsDir, w.auditId));
});

test('auditoria inexistente ou id inválido: 404/400 em leitura, criação e revogação', async () => {
  const w = await world();
  for (const call of [
    () => w.service.list(ANA, 'auditoria-inexistente-9'),
    () => w.service.create(ANA, 'auditoria-inexistente-9', { record: rec.c2() }, clock()),
    () => w.service.revoke(ANA, 'auditoria-inexistente-9', { revokes: 'op-0001', reason: REASON }, clock()),
  ]) {
    const r = await call();
    assert.ok(!r.ok && r.code === 'AUDIT_NOT_FOUND');
  }
  for (const bad of ['../etc', 'ABC', 'x', '', 'a/b/c/d/e/f/g/h']) {
    const r = await w.service.list(ANA, bad);
    assert.ok(!r.ok && r.code === 'INVALID_PARAMS', bad);
  }
  assert.deepEqual(fs.readdirSync(w.decisionsDir), []); // nem pasta de auditoria inexistente é criada
});

test('substituição explícita: a anterior permanece no histórico (SUPERSEDED), o arquivo original fica intacto e só a nova é vigente', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2('PARTIAL') }, clock()));
  const original = fs.readFileSync(entryPath(w, 1), 'utf8');

  const without = await w.service.create(BIA, w.auditId, { record: rec.c2('COMPATIBLE') }, clock());
  assert.ok(!without.ok && without.code === 'SUPERSEDE_REQUIRED' && without.issues.join(' ').includes('op-0001'));
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 1);

  const replaced = await must(w.service.create(BIA, w.auditId, { record: rec.c2('COMPATIBLE'), supersedes: 'op-0001' }, clock()));
  assert.deepEqual([replaced.decision.decisionId, replaced.decision.supersedes, replaced.decision.recordedBy, replaced.effectiveCount], ['op-0002', 'op-0001', 'bia@empresa.com', 1]);

  const listed = await must(w.service.list(ANA, w.auditId));
  assert.deepEqual(listed.decisions.map((d) => d.decisionId), ['op-0002']);
  assert.deepEqual(listed.allDecisions.map((d) => [d.decisionId, d.status, d.supersededBy]), [['op-0001', 'SUPERSEDED', 'op-0002'], ['op-0002', 'ACTIVE', null]]);
  assert.equal((listed.allDecisions[0]?.record as { value: string }).value, 'PARTIAL');
  assert.equal(fs.readFileSync(entryPath(w, 1), 'utf8'), original, 'o arquivo da decisão original nunca é reescrito');
  assert.deepEqual(listed.operatorRecords.map((r) => r.id), ['op-0002']);
});

test('substituição inválida: inexistente, já substituída/revogada, de outro tipo ou subcritério, ou que deixa outro conflito', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock())); // op-0001
  await must(w.service.create(ANA, w.auditId, { record: rec.c2('PARTIAL'), supersedes: 'op-0001' }, clock())); // op-0002 (op-0001 substituída)
  const fail = async (record: unknown, supersedes: string): Promise<string> => {
    const r = await w.service.create(ANA, w.auditId, { record, supersedes }, clock());
    assert.ok(!r.ok);
    return r.code;
  };
  assert.equal(await fail(rec.c2(), 'op-0099'), 'DECISION_NOT_FOUND');
  assert.equal(await fail(rec.c2(), 'op-0001'), 'DECISION_NOT_ACTIVE');
  assert.equal(await fail(rec.c3(), 'op-0002'), 'SUPERSEDE_INVALID'); // juízo de C3 não "substitui" o de C2
  assert.equal(await fail(rec.naModel(), 'op-0002'), 'SUPERSEDE_INVALID');
  // conflito remanescente: substituir a de S5 não resolve a de X4
  await must(w.service.create(ANA, w.auditId, { record: rec.observation(['S5']) }, clock())); // op-0003
  await must(w.service.create(ANA, w.auditId, { record: rec.observation(['X4']) }, clock())); // op-0004
  const both = await w.service.create(ANA, w.auditId, { record: rec.observation(['S5', 'X4']), supersedes: 'op-0003' }, clock());
  assert.ok(!both.ok && both.code === 'SUPERSEDE_REQUIRED' && both.issues.join(' ').includes('op-0004'));
  assert.equal((await must(w.service.list(ANA, w.auditId))).history.length, 4); // nada além das 4 criações
});

test('revogação: nova entrada com motivo; a original permanece; revogar de novo (ou revogar substituída/inexistente) é recusado', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const original = fs.readFileSync(entryPath(w, 1), 'utf8');
  const revoked = await must(w.service.revoke(BIA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()));
  assert.deepEqual([revoked.revocation.action, revoked.revocation.revokes, revoked.revocation.reason, revoked.revocation.recordedBy, revoked.revoked.status, revoked.effectiveCount], ['REVOKE', 'op-0001', REASON, 'bia@empresa.com', 'REVOKED', 0]);
  assert.equal(fs.readFileSync(entryPath(w, 1), 'utf8'), original);

  const again = await w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock());
  assert.ok(!again.ok && again.code === 'DECISION_NOT_ACTIVE');
  const unknown = await w.service.revoke(ANA, w.auditId, { revokes: 'op-0042', reason: REASON }, clock());
  assert.ok(!unknown.ok && unknown.code === 'DECISION_NOT_FOUND');
  const short = await w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'curto' }, clock());
  assert.ok(!short.ok && short.code === 'INVALID_BODY');
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 2);

  const listed = await must(w.service.list(ANA, w.auditId));
  assert.equal(listed.decisions.length, 0);
  assert.deepEqual(listed.operatorRecords, []);
  assert.deepEqual(listed.allDecisions.map((d) => [d.decisionId, d.status, d.revokedAtSeq]), [['op-0001', 'REVOKED', 2]]);
  assert.deepEqual(listed.history.map((h) => [h.seq, h.action, h.revokes ?? h.decisionId]), [[1, 'RECORD', 'op-0001'], [2, 'REVOKE', 'op-0001']]);

  // substituída também não pode ser revogada; e depois de revogar o subcritério fica livre para uma decisão nova
  await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock())); // op-0003
  await must(w.service.create(ANA, w.auditId, { record: rec.c3('MOSTLY_RELEVANT'), supersedes: 'op-0003' }, clock())); // op-0004
  const sup = await w.service.revoke(ANA, w.auditId, { revokes: 'op-0003', reason: REASON }, clock());
  assert.ok(!sup.ok && sup.code === 'DECISION_NOT_ACTIVE');
  await must(w.service.create(ANA, w.auditId, { record: rec.c2('INCOMPATIBLE') }, clock())); // C2 de novo, sem substituir (a anterior foi revogada)
});

test('referências de evidência: só capture:/report: que EXISTEM; inválidas, inexistentes e site: são recusadas sem gravar nada', async () => {
  const w = await world();
  const attempt = async (refs: string[]) => w.service.create(ANA, w.auditId, { record: rec.naFeature(refs) }, clock());
  for (const refs of [['capture:c0002'], ['report:c0001-r0009'], ['capture:c0001', 'capture:c0007']]) {
    const r = await attempt(refs);
    assert.ok(!r.ok && r.code === 'EVIDENCE_REFERENCE_NOT_FOUND', refs.join(','));
  }
  for (const refs of [['abc'], ['capture:c1'], ['site:c0001'], ['capture:c0001', 'e1']]) {
    const r = await attempt(refs);
    assert.ok(!r.ok && r.code === 'INVALID_EVIDENCE_REFERENCE', refs.join(','));
  }
  // fora do formato de id do contrato da 6A (barrado já na validação do corpo): também 400
  for (const refs of [['../capture:c0001'], ['capture:c0001\n'], ['capture:c0001 '], ['x'.repeat(65)]]) {
    const r = await attempt(refs);
    assert.ok(!r.ok && (r.code === 'INVALID_BODY' || r.code === 'INVALID_EVIDENCE_REFERENCE'), JSON.stringify(refs));
  }
  assert.ok(noFiles(w.decisionsDir, w.auditId));
  await must(attempt(['capture:c0001']));
  await must(w.service.create(ANA, w.auditId, { record: rec.images(['report:c0001-r0001', 'capture:c0001']) }, clock()));
  const noEvidence = await w.service.create(ANA, w.auditId, { record: { ...rec.images(), evidenceIds: [] }, supersedes: 'op-0002' }, clock());
  assert.ok(!noEvidence.ok && noEvidence.code === 'CONTRACT_REJECTED'); // regra da 6A: a confirmação de imagens exige a evidência de origem
});

test('regras do contrato 6A aplicadas pelo MESMO validador do motor: cada violação é recusada e nada é gravado', async () => {
  const w = await world();
  const bad: Array<[string, unknown, RegExp]> = [
    ['valor de juízo inválido', rec.c2('TALVEZ'), /valor "TALVEZ" inválido/],
    ['P3 sem tamanho da amostra', rec.p3(null), /P3 exige sampleSize/],
    ['N/A derivado pelos fatos', { kind: 'NOT_APPLICABLE', subcriterionIds: ['R1'], code: 'NO_REVIEWS_PROVEN', justification: 'Perfil sem avaliações conforme conferido.' }, /derivado pelos fatos/],
    ['N/A em subcritério que a causa não cobre', { ...rec.naModel(), subcriterionIds: ['S3'] }, /não se aplica a S3/],
    ['FEATURE_UNAVAILABLE sem evidência da causa', { ...rec.naFeature(), causeEvidenceIds: [] }, /exige evidência da causa/],
    ['subcritério repetido no mesmo N/A', { ...rec.naModel(), subcriterionIds: ['S4', 'S4'] }, /mais de um N\/A para S4/],
    ['atestado de escopo para subcritério que não depende do site', rec.attestation(['C1']), /não depende do escopo do site/],
    ['confirmação de observação para subcritério não confirmável', rec.observation(['V5']), /não aceita confirmação de observação/],
    ['tipos de imagem repetidos', rec.images(['capture:c0001'], ['PLACE', 'PLACE']), /tipos de imagem repetidos/],
  ];
  for (const [label, record, expected] of bad) {
    const r = await w.service.create(ANA, w.auditId, { record }, clock());
    assert.ok(!r.ok, label);
    assert.equal(r.code, 'CONTRACT_REJECTED', `${label}: ${r.code} ${r.issues.join(' | ')}`); // exatamente a recusa do motor, não de outro motivo
    assert.match(r.issues.join(' | '), expected, label);
  }
  assert.ok(noFiles(w.decisionsDir, w.auditId));
});

test('a ÚNICA regra da 6A descartada é a do escopo do site (dado da coleta/6C): o motor ainda a aplica à entrada completa', () => {
  const parsed = parseScoringInput({
    schemaVersion: 1,
    auditId: 'auditoria-decisoes',
    referenceDate: '2026-10-22',
    evidences: [],
    operatorRecords: [{ ...rec.attestation(), id: 'op-0001', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-21T12:00:00.000Z' }],
  });
  assert.ok(!parsed.ok);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0] as string, SITE_SCOPE_ISSUE); // se a mensagem da 6A mudar, este teste acusa
});

test('evidências adulteradas: não aceitam novas decisões (409), mas a leitura e a revogação continuam possíveis', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const capture = path.join(w.evidenceDir, w.auditId, 'c0001.capture.json');
  fs.chmodSync(capture, 0o644);
  fs.writeFileSync(capture, fs.readFileSync(capture, 'utf8').replace('Padaria', 'Adulterada'));
  const created = await w.service.create(ANA, w.auditId, { record: rec.c3() }, clock());
  assert.ok(!created.ok && created.code === 'EVIDENCE_INTEGRITY');
  assert.ok((await w.service.list(ANA, w.auditId)).ok);
  assert.ok((await w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock())).ok);
});

test('coleta incompleta (sem relatório): decisões sem referências são aceitas; referência a relatório inexistente não', async () => {
  const w = await world({ seed: false });
  const { writeCapture } = await import('../src/lib/link-audit-evidence/store');
  const { captureInput } = await import('./helpers/link-audit-evidence-fixtures');
  const cap = await writeCapture(w.evidenceDir, captureInput({ auditId: w.auditId }));
  assert.ok(cap.ok);
  const made = await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  assert.deepEqual(made.decision.basis.report, null);
  assert.equal(made.decision.basis.capture, 1);
  const ref = await w.service.create(ANA, w.auditId, { record: rec.images(['report:c0001-r0001']) }, clock());
  assert.ok(!ref.ok && ref.code === 'EVIDENCE_REFERENCE_NOT_FOUND');
});

test('histórico de decisões adulterado: leitura, criação e revogação devolvem DECISIONS_INTEGRITY e NENHUM dado', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock()));
  fs.chmodSync(entryPath(w, 1), 0o644);
  fs.writeFileSync(entryPath(w, 1), fs.readFileSync(entryPath(w, 1), 'utf8').replace('ana@empresa.com', 'intruso@empresa.com'));
  for (const result of [
    await w.service.list(ANA, w.auditId),
    await w.service.create(ANA, w.auditId, { record: rec.p3() }, clock()),
    await w.service.revoke(ANA, w.auditId, { revokes: 'op-0002', reason: REASON }, clock()),
  ]) {
    assert.ok(!result.ok && result.code === 'DECISIONS_INTEGRITY');
    assert.ok(!('value' in result));
  }
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 2); // nada novo foi gravado sobre um histórico adulterado
});

test('configuração insegura ou ausente: pastas iguais ou aninhadas (decisões, âncoras, evidências), base inexistente, dentro do código ou relativa', async () => {
  const w = await world();
  const status = async (over: { baseDir?: string; anchorDir?: string; evidenceBaseDir?: string | null } = {}): Promise<string> => {
    const evidenceBaseDir = over.evidenceBaseDir === undefined ? w.evidenceDir : over.evidenceBaseDir;
    const s = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: over.baseDir ?? w.decisionsDir, anchorDir: over.anchorDir ?? w.anchorDir, evidence: w.reader, ...(evidenceBaseDir ? { evidenceBaseDir } : {}) });
    const r = await s.list(ANA, w.auditId);
    return r.ok ? 'OK' : r.code;
  };
  assert.equal(await status(), 'OK');
  assert.equal(await status({ baseDir: w.evidenceDir }), 'DECISIONS_MISCONFIGURED'); // decisões = evidências
  const inside = path.join(w.evidenceDir, 'decisoes');
  fs.mkdirSync(inside);
  assert.equal(await status({ baseDir: inside }), 'DECISIONS_MISCONFIGURED'); // decisões dentro de evidências
  assert.equal(await status({ baseDir: path.dirname(w.evidenceDir), evidenceBaseDir: w.evidenceDir }), 'DECISIONS_MISCONFIGURED'); // evidências dentro de decisões
  const alias = path.join(tmpDir('lad-alias-'), 'alias');
  fs.symlinkSync(w.evidenceDir, alias);
  assert.equal(await status({ baseDir: alias }), 'DECISIONS_MISCONFIGURED'); // apelido (symlink) da pasta de evidências
  assert.equal(await status({ baseDir: path.join(tmpDir('lad-x-'), 'nao-existe') }), 'DECISIONS_STORAGE_UNAVAILABLE');
  assert.equal(await status({ baseDir: path.join(process.cwd(), 'src', 'decisoes') }), 'DECISIONS_MISCONFIGURED');
  assert.equal(await status({ baseDir: 'relativo/pasta' }), 'DECISIONS_MISCONFIGURED');
  // âncoras: nunca iguais nem aninhadas às outras duas; ausentes ⇒ indisponíveis; inseguras ⇒ configuração insegura
  assert.equal(await status({ anchorDir: w.decisionsDir }), 'DECISIONS_MISCONFIGURED');
  assert.equal(await status({ anchorDir: w.evidenceDir }), 'DECISIONS_MISCONFIGURED');
  const anchorInside = path.join(w.decisionsDir, 'ancoras');
  fs.mkdirSync(anchorInside);
  assert.equal(await status({ anchorDir: anchorInside }), 'DECISIONS_MISCONFIGURED'); // âncoras dentro das decisões
  assert.equal(await status({ baseDir: path.join(w.anchorDir, 'dec') }), 'DECISIONS_MISCONFIGURED'); // decisões dentro das âncoras
  assert.equal(await status({ anchorDir: path.join(tmpDir('lad-x-'), 'nao-existe') }), 'ANCHOR_STORAGE_UNAVAILABLE');
  assert.equal(await status({ anchorDir: path.join(process.cwd(), 'public', 'x') }), 'DECISIONS_MISCONFIGURED');
  assert.equal(await status({ anchorDir: 'relativo/ancoras' }), 'DECISIONS_MISCONFIGURED');
});

test('limite de 200 decisões vigentes (o mesmo teto do motor): a 201ª é recusada; revogar libera espaço', async () => {
  const dir = tmpDir('lad-lim-');
  const raw = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: dir, anchorDir: tmpDir('lad-lim-an-'), evidence: fakeEvidence() });
  const AUDIT = 'auditoria-limite-01';
  let head: { seq: number; sha256: string } | null = null; // a cada resposta, o head novo (sem reler tudo a cada passo)
  for (let i = 1; i <= 200; i++) {
    const made: { head: { seq: number; sha256: string } } = await must(raw.create(ANA, AUDIT, { record: rec.nameEquivalence(`Empresa ${i} Ltda`, `Empresa ${i}`), expectedHead: head }, clock()));
    head = made.head;
  }
  const over = await raw.create(ANA, AUDIT, { record: rec.nameEquivalence('Excedente Ltda', 'Excedente'), expectedHead: head }, clock());
  assert.ok(!over.ok && over.code === 'LIMIT_REACHED');
  assert.equal(fs.readdirSync(path.join(dir, AUDIT)).length, 200);
  const revoked = await must(raw.revoke(ANA, AUDIT, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock()));
  const again = await must(raw.create(ANA, AUDIT, { record: rec.nameEquivalence('Excedente Ltda', 'Excedente'), expectedHead: revoked.head }, clock()));
  assert.equal(again.effectiveCount, 200);
});

test('concorrência no serviço: com o MESMO expectedHead só UMA escrita vence; as outras recebem HEAD_MISMATCH (com o head atual) e, relendo, todas concluem com sequências únicas', async () => {
  const w = await world();
  const racers = await Promise.all(Array.from({ length: 8 }, (_, i) => w.raw.create(ANA, w.auditId, { record: rec.nameEquivalence(`Nome ${i} Ltda`, `Nome ${i}`), expectedHead: null }, clock())));
  assert.equal(racers.filter((r) => r.ok).length, 1);
  const losers = racers.filter((r) => !r.ok);
  assert.equal(losers.length, 7);
  assert.ok(losers.every((r) => !r.ok && r.code === 'HEAD_MISMATCH' && r.head?.seq === 1));
  // cada cliente "recarrega" e tenta de novo, um de cada vez por rodada: todos terminam
  const retry = async (record: unknown): Promise<string> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const head = (await must(w.raw.list(ANA, w.auditId))).head;
      const r = await w.raw.create(BIA, w.auditId, { record, expectedHead: head }, clock());
      if (r.ok) return 'OK';
      if (r.code !== 'HEAD_MISMATCH') return r.code;
    }
    return 'SEM_CONVERGENCIA';
  };
  const c2 = await Promise.all([rec.c2('COMPATIBLE'), rec.c2('PARTIAL'), rec.c2('INCOMPATIBLE')].map(retry));
  assert.equal(c2.filter((x) => x === 'OK').length, 1);
  assert.deepEqual(c2.filter((x) => x !== 'OK'), ['SUPERSEDE_REQUIRED', 'SUPERSEDE_REQUIRED']);
  const rest = await Promise.all(Array.from({ length: 6 }, (_, i) => retry(rec.nameEquivalence(`Outro ${i} Ltda`, `Outro ${i}`))));
  assert.ok(rest.every((x) => x === 'OK'), rest.join(','));
  const listed = await must(w.service.list(ANA, w.auditId));
  assert.deepEqual(listed.history.map((h) => h.seq), Array.from({ length: listed.history.length }, (_, i) => i + 1));
  assert.equal(new Set(listed.allDecisions.map((d) => d.decisionId)).size, listed.allDecisions.length);
  assert.equal(listed.decisions.filter((d) => d.kind === 'JUDGEMENT').length, 1);
  assert.equal(listed.anchors.count, listed.history.length);
  assert.equal(listed.anchors.unanchored, 0);
});

test('as evidências originais NUNCA são alteradas e nenhuma resposta traz caminho do disco', async () => {
  const w = await world();
  const before = hashTree(w.evidenceDir);
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.naFeature() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.c2('PARTIAL'), supersedes: 'op-0001' }, clock()));
  const revoked = await must(w.service.revoke(ANA, w.auditId, { revokes: 'op-0002', reason: REASON }, clock()));
  const listed = await must(w.service.list(ANA, w.auditId));
  assert.deepEqual(hashTree(w.evidenceDir), before);
  const text = JSON.stringify([revoked, listed]);
  for (const secret of [w.evidenceDir, w.decisionsDir, '/tmp/', '/home/', '/mnt/']) assert.ok(!text.includes(secret), `vazou ${secret}`);
  assert.ok(!/\.json"|d000\d/.test(text.replace(/"seq"/g, '')), 'nenhum nome de arquivo');
});

test('o head devolvido é o hash do último arquivo (âncora externa para detectar remoção do arquivo mais recente)', async () => {
  const w = await world();
  const a = await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const b = await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock()));
  const file = JSON.parse(fs.readFileSync(entryPath(w, 2), 'utf8')) as { contentSha256: string; prevSha256: string };
  assert.deepEqual(b.head, { seq: 2, sha256: file.contentSha256 });
  assert.equal(file.prevSha256, a.head.sha256);
  assert.deepEqual((await must(w.service.list(ANA, w.auditId))).head, b.head);
});

test('COMPATIBILIDADE COM O MOTOR 6A: as decisões vigentes alimentam o scoreAudit e produzem o mesmo resultado dos fixtures da 6A', async () => {
  const w = await world();
  const ids: Record<string, string> = {};
  for (const [name, record] of [
    ['c2', rec.c2()],
    ['c3', rec.c3()],
    ['p3', rec.p3()],
    ['obs', rec.observation(['S5', 'X4'])],
    ['img', rec.images(['capture:c0001'], ['PLACE', 'PRODUCT_OR_SERVICE'])],
    ['scope', rec.attestation(['S5', 'V5', 'X4'])],
  ] as const) ids[name] = (await must(w.service.create(ANA, w.auditId, { record }, clock()))).decision.decisionId;
  const listed = await must(w.service.list(ANA, w.auditId));

  const draft = structuredClone(richInput()) as Record<string, any>;
  // Na 6C o mapeamento das evidências armazenadas para a entrada do motor define origem e tipo; aqui o stand-in é um site oficial.
  draft.evidences.push(evidence('capture:c0001', { origin: 'OFFICIAL_SITE' }));
  draft.operatorRecords = listed.operatorRecords;
  draft.site.offers.determination.operatorRecordId = ids.obs;
  draft.site.journey.determination.operatorRecordId = ids.obs;
  const outcome = scoreAudit(draft);
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join(' | '));

  const baseline = run();
  for (const id of ['C2', 'C3', 'P3', 'S5', 'V5', 'X4'] as const) {
    const mine = sub(outcome.result, id);
    const ref = sub(baseline, id);
    assert.deepEqual([mine.state, mine.obtainedHalfPoints, mine.evaluatedHalfPoints], [ref.state, ref.obtainedHalfPoints, ref.evaluatedHalfPoints], id);
  }
  assert.deepEqual(sub(outcome.result, 'C2').operatorRecordIds, [ids.c2]);
  assert.deepEqual(sub(outcome.result, 'P3').operatorRecordIds, [ids.p3]);
  assert.equal(outcome.result.totals.coveragePercent, baseline.totals.coveragePercent);
  assert.equal(outcome.result.index?.shown, baseline.index?.shown);

  // revogar muda o resultado do motor: C2 volta a Não verificado (nunca vira zero)
  await must(w.service.revoke(ANA, w.auditId, { revokes: ids.c2 as string, reason: REASON }, clock()));
  const after = await must(w.service.list(ANA, w.auditId));
  draft.operatorRecords = after.operatorRecords;
  const second = scoreAudit(draft);
  assert.ok(second.ok);
  assert.equal(sub(second.result, 'C2').state, 'NOT_VERIFIED');
  assert.equal(sub(second.result, 'C2').evaluatedHalfPoints, 0);
});

/* ---------------------------------------------------------------------- dados reais (somente leitura) */
/* Localização só por variáveis de ambiente (tests/helpers/link-audit-aud001-real-capture.ts); sem a pasta, o teste é ignorado. */
const REAL_BASE = AUD001_BASE;
const REAL_AUDIT = AUD001_AUDIT;
const realPresent = aud001CapturePresent();

test('layout LEGADO real (AUD-001), SOMENTE LEITURA: os identificadores capture:c0001 e report:c0001-r0002 existem de verdade; nada é alterado', { skip: !realPresent && 'captura real ausente nesta máquina' }, async () => {
  const before = hashTree(path.join(REAL_BASE, REAL_AUDIT));
  const reader = createEvidenceReader({ baseDir: REAL_BASE, authorize: (a) => a.email === ANA.email });
  const decisionsDir = tmpDir('lad-real-');
  const service = withAutoHead(createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: decisionsDir, anchorDir: tmpDir('lad-real-an-'), evidence: reader, evidenceBaseDir: REAL_BASE }));
  const made = await must(service.create(ANA, REAL_AUDIT, { record: rec.naFeature(['capture:c0001', 'report:c0001-r0002', 'report:c0001-r0001']) }, clock()));
  assert.deepEqual(made.decision.basis.report, { capture: 1, revision: 2 });
  const missing = await service.create(ANA, REAL_AUDIT, { record: rec.images(['report:c0001-r0003']) }, clock());
  assert.ok(!missing.ok && missing.code === 'EVIDENCE_REFERENCE_NOT_FOUND');
  assert.deepEqual(hashTree(path.join(REAL_BASE, REAL_AUDIT)), before, 'a evidência real não foi tocada');
  assert.deepEqual(fs.readdirSync(path.join(decisionsDir, REAL_AUDIT)), ['d0001.json']);
});
