import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { evidenceToProveFromBasis } from '../src/lib/link-audit-evidence/evidence-to-prove';
import {
  createEvidenceSealV2,
  createKeyRetirementClosure,
  createSealedEvidenceProvenance,
  evidenceProvenanceFromConfig,
  parseTrustKeyring,
  parseTrustKeys,
  sealSha256,
  type EvidenceProvenancePolicy,
  type EvidenceTrust,
} from '../src/lib/link-audit-evidence/provenance';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { writeCapture } from '../src/lib/link-audit-evidence/store';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { headProofOf } from '../src/lib/link-audit-scoring-runs/preview';
import { appendRun, readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import { evidenceProvenanceSchema, scoreRunSchema, type ScoreRun, type ScoreRunDraft } from '../src/lib/link-audit-scoring-runs/results-types';
import { registerCleanup, tmpDir, world, type World } from './helpers/link-audit-decisions-fixtures';
import { captureInput } from './helpers/link-audit-evidence-fixtures';
import { evidenceKeys, sealAuditForTests, sealAuditV2ForTests, TEST_DOSSIER, writeSealFile, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R2.1 — a prova autenticada vai da prévia até o resultado gravado (plano, onda R2; contrato do verificador v2 §7.3, O6 aprovado na D14 da spec do P1).
 *  - a `Evaluation` (interna) carrega `{headSeq, headSealSha256, keyIds}` exatamente como o verificador v2 devolve em `AUTHENTICATED`; a prévia PÚBLICA não os expõe;
 *  - o resultado novo grava `evidenceProvenance` (campo OPCIONAL nas versões de formato 1 e 2, sem v3); a escrita nova EXIGE o campo e recusa sem prova v2 completa;
 *  - ausente = legado sem proveniência (legível, bytes e hash inalterados); presente e malformado = falha de integridade na leitura.
 * A reconferência na releitura (revogação, UNAUTHENTICATED ⇒ "a reconferir"), a porta injetada e a interface são da R2.2.
 * Pastas temporárias reais, chaves de TESTE geradas a cada execução, e-mails fictícios, nenhuma rede.
 */
registerCleanup();

const FIXTURES = path.join(__dirname, 'fixtures', 'link-audit-results-provenance');
/** Bytes dos resultados LEGADOS (gravados pelo código anterior à R2.1, base 3899a67) e dos recibos deles: fixados; a R2.1 não muda nenhum byte. */
const LEGACY_SHA256: Readonly<Record<string, string>> = {
  'results/auditoria-legado-v1/s0001.json': 'ea64b099a769de655aae534130dd9dba48e7df04280ef47f0300e3cfb715231e',
  'anchors/auditoria-legado-v1/a0001.json': '7603572158bb7f8cb3671ab75e6d25c401cdb12ef30c2ec513958b3f089e4a1e',
  'results/auditoria-legado-v2/s0001.json': '60967ec63a17c14931aea8fcc56fc2cd94c99fab2b71919866e9b854bdbf3c73',
  'anchors/auditoria-legado-v2/a0001.json': 'e7334cc6d3e0d6a413a539007993ed5379a1bb4ceeb7d1997990f9dc34b016c1',
};
const sha256File = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const PROOF = { headSeq: 1, headSealSha256: 'ab'.repeat(32), keyIds: ['ek-teste-0001'] } as const;
const HEAD_FIELDS = /headSeq|headSealSha256|keyIds|evidenceProvenance/;

/** Copia as pastas legadas para pastas temporárias (o teste nunca escreve nas fixtures). */
function legacyEnv(auditId: string): ResultsEnv {
  const e = resultsEnv();
  for (const [kind, root] of [['results', e.base], ['anchors', e.anchors]] as const) {
    const from = path.join(FIXTURES, kind, auditId);
    const to = path.join(root, auditId);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
  return e;
}

async function basisEvidences(w: World) {
  const basis = await createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true }).readScoringBasis({ email: 'conferente@teste.invalid' }, w.auditId);
  if (basis.status !== 'READY') throw new Error(basis.status);
  return evidenceToProveFromBasis(basis.basis);
}
const v2Policy = (sealsDir: string, keys: readonly EvidenceKeys[]): EvidenceProvenancePolicy =>
  createSealedEvidenceProvenance({ sealsDir, trustedKeys: parseTrustKeys(keys.map((k) => k.trustKeys).join(',')) as never, acceptedVersions: [2] });
const fixedPolicy = (trust: EvidenceTrust): EvidenceProvenancePolicy => ({ classify: async () => trust });

/** Mundo real (evidências e decisões em disco) atestado por UM manifesto v2 da chave A, com a política de produção (`[2]`). */
async function attestedWorld() {
  const w = await world();
  const sealsDir = tmpDir('lrp-');
  const keys = evidenceKeys('ek-prov-a');
  const sealed = await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const policy = v2Policy(sealsDir, [keys]);
  return { w, sealsDir, keys, sealed, policy, preview: previewOver(w, { evidenceProvenance: policy }) };
}

/**
 * Cadeia de DOIS manifestos v2 sobre a base do mundo: `seal-0001` da chave R (depois APOSENTADA, com fecho assinado por S e fixado por hash na lista) e `seal-0002` da
 * chave ativa A. O verificador devolve `keyIds` = chaves das posições + o signatário do fecho usado (contrato §6, §7.3): [A, R, S].
 */
async function retiredChainWorld() {
  const w = await world();
  const sealsDir = tmpDir('lrp-');
  const R = evidenceKeys('ek-prov-ret');
  const S = evidenceKeys('ek-prov-suc');
  const A = evidenceKeys('ek-prov-ati');
  const entries = (await basisEvidences(w)).map(({ ref, contentSha256 }) => ({ ref, contentSha256 }));
  const first = createEvidenceSealV2({ auditId: w.auditId, seq: 1, sealedAt: '2026-11-20T10:00:00.000Z', keyId: R.keyId, privateKey: R.privateKey, entries, dossier: TEST_DOSSIER, prevSealSha256: null });
  const second = createEvidenceSealV2({ auditId: w.auditId, seq: 2, sealedAt: '2026-11-20T11:00:00.000Z', keyId: A.keyId, privateKey: A.privateKey, entries, dossier: TEST_DOSSIER, prevSealSha256: sealSha256(first) });
  writeSealFile(sealsDir, w.auditId, 1, first);
  writeSealFile(sealsDir, w.auditId, 2, second);
  const closure = `${JSON.stringify(createKeyRetirementClosure({ retiredKeyId: R.keyId, signerKeyId: S.keyId, sealedAt: '2026-11-20T10:30:00.000Z', heads: [{ auditId: w.auditId, seq: 1, sealSha256: sealSha256(first) }], privateKey: S.privateKey }), null, 2)}\n`;
  fs.mkdirSync(path.join(sealsDir, '_closures'), { recursive: true });
  fs.writeFileSync(path.join(sealsDir, '_closures', `${R.keyId}.json`), closure);
  const pin = createHash('sha256').update(closure, 'utf8').digest('hex');
  const list = [`${R.keyId}:${R.publicRaw}:retired:${pin}`, `${S.keyId}:${S.publicRaw}:active`, `${A.keyId}:${A.publicRaw}:active`].join(',');
  const policy = evidenceProvenanceFromConfig({ sealsDir, trustKeys: list, acceptedVersions: [2] });
  return { w, sealsDir, R, S, A, first, second, policy, preview: previewOver(w, { evidenceProvenance: policy }) };
}

function onlyRunOf(e: ResultsEnv, auditId: string): { run: ScoreRun; bytes: string } {
  const dir = path.join(e.base, auditId);
  const names = fs.readdirSync(dir).filter((name) => /^s\d{4}\.json$/.test(name));
  assert.deepEqual(names, ['s0001.json']);
  const bytes = fs.readFileSync(path.join(dir, 's0001.json'), 'utf8');
  return { run: JSON.parse(bytes) as ScoreRun, bytes };
}
const nothingWritten = (e: ResultsEnv, auditId: string): void => {
  for (const root of [e.base, e.anchors]) {
    const dir = path.join(root, auditId);
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], `nada gravado em ${path.basename(root)}`);
  }
};

/* ============================================================================================ esquema do campo */

test('R2.1 esquema: evidenceProvenance estrito — cabeça 1..256, hash hex minúsculo de 64, keyIds 1..16 distintos, ordenados e no padrão de id da lista de chaves', () => {
  assert.equal(evidenceProvenanceSchema.safeParse(PROOF).success, true);
  assert.equal(evidenceProvenanceSchema.safeParse({ headSeq: 256, headSealSha256: '0'.repeat(64), keyIds: Array.from({ length: 16 }, (_, i) => `ek-chave-${String(i).padStart(2, '0')}`) }).success, true, 'limites superiores');
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['lista', [PROOF]],
    ['campo a mais', { ...PROOF, revokedKeyIds: [] }],
    ['sem headSeq', { headSealSha256: PROOF.headSealSha256, keyIds: PROOF.keyIds }],
    ['sem hash', { headSeq: 1, keyIds: PROOF.keyIds }],
    ['sem keyIds', { headSeq: 1, headSealSha256: PROOF.headSealSha256 }],
    ['headSeq 0', { ...PROOF, headSeq: 0 }],
    ['headSeq 257', { ...PROOF, headSeq: 257 }],
    ['headSeq fracionário', { ...PROOF, headSeq: 1.5 }],
    ['headSeq texto', { ...PROOF, headSeq: '1' }],
    ['hash maiúsculo', { ...PROOF, headSealSha256: 'AB'.repeat(32) }],
    ['hash curto', { ...PROOF, headSealSha256: 'ab'.repeat(31) }],
    ['keyIds vazio', { ...PROOF, keyIds: [] }],
    ['keyIds fora de ordem', { ...PROOF, keyIds: ['ek-teste-0002', 'ek-teste-0001'] }],
    ['keyIds repetido', { ...PROOF, keyIds: ['ek-teste-0001', 'ek-teste-0001'] }],
    ['id maiúsculo', { ...PROOF, keyIds: ['EK-TESTE-0001'] }],
    ['id curto', { ...PROOF, keyIds: ['ek1'] }],
    ['id que começa com hífen', { ...PROOF, keyIds: ['-ek-teste'] }],
    ['17 ids', { ...PROOF, keyIds: Array.from({ length: 17 }, (_, i) => `ek-chave-${String(i).padStart(2, '0')}`) }],
    ['id não texto', { ...PROOF, keyIds: [1] }],
  ];
  for (const [label, value] of bad) assert.equal(evidenceProvenanceSchema.safeParse(value).success, false, label);
});

/**
 * Corpus DETERMINÍSTICO de ids (revisão do PR #55): pontuação (`.`, `_`, `/`, `:`, `,`, espaço, `+`, `@`), maiúsculas, unicode (acento, `ß`, `ı` sem ponto, letra grega,
 * dígito árabe-índico, espaço não separável, invisível), limites de tamanho (1..34, com e sem hífen inicial), posição do caractere (início, meio, fim) e 600 casos gerados por um
 * gerador congruencial de semente fixa sobre um alfabeto misto. Nada aleatório: o mesmo corpus a cada execução.
 */
function keyIdCorpus(): string[] {
  const specials = ['.', '_', '/', ':', ',', ' ', '+', '@', 'A', 'Z', 'é', 'ß', 'ı', 'α', '٣', '\u00a0', '\u200b', '-'];
  const corpus = new Set<string>(['ek-a', 'abcd', 'a1-b2-c3', '0-0-0', 'ek-teste-0001', 'abc', 'Ek-teste', 'ek_teste', '-ekte', 'ek teste', 'ek-téste', 'ek.teste', 'ek-teste.0001', 'a...']);
  for (let n = 1; n <= 34; n += 1) {
    corpus.add('a'.repeat(n));
    corpus.add('0'.repeat(n));
    corpus.add(`-${'a'.repeat(Math.max(0, n - 1))}`);
    corpus.add(`a${'-'.repeat(Math.max(0, n - 1))}`);
  }
  for (const c of specials) for (const id of [`${c}ekte`, `ek${c}te`, `ekte${c}`, `${c}${'a'.repeat(31)}`, `${'a'.repeat(31)}${c}`, `ek-teste${c}0001`]) corpus.add(id);
  const alphabet = ['a', 'k', 'z', '0', '9', '-', ...specials];
  let state = 0x2b2b2b2b;
  const next = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state;
  };
  for (let i = 0; i < 600; i += 1) {
    const length = 1 + (next() % 36);
    let id = '';
    for (let j = 0; j < length; j += 1) id += alphabet[next() % (i % 3 === 0 ? 6 : alphabet.length)];
    corpus.add(id);
  }
  return [...corpus];
}

test('R2.1 esquema: o padrão de id de keyIds (registro E prévia) é o MESMO da lista de chaves do verificador, num corpus determinístico de ids', () => {
  const { publicRaw } = evidenceKeys('ek-padrao-0001');
  const corpus = keyIdCorpus();
  let accepted = 0;
  for (const id of corpus) {
    const listed = parseTrustKeyring(`${id}:${publicRaw}`) !== null;
    if (listed) accepted += 1;
    assert.equal(evidenceProvenanceSchema.safeParse({ ...PROOF, keyIds: [id] }).success, listed, `registro: ${JSON.stringify(id)}`);
    assert.equal(headProofOf({ status: 'AUTHENTICATED', ...PROOF, keyIds: [id] }) !== null, listed, `prévia: ${JSON.stringify(id)}`);
  }
  // o corpus exercita os dois lados (senão a comparação seria vazia)
  assert.ok(corpus.length > 700 && accepted > 50 && corpus.length - accepted > 300, `corpus ${corpus.length}, aceitos ${accepted}`);
});

test('R2.1 esquema: o registro aceita o campo nas versões 1 e 2 (opcional, sem v3); presente e malformado ⇒ recusado', () => {
  for (const name of ['results/auditoria-legado-v1/s0001.json', 'results/auditoria-legado-v2/s0001.json']) {
    const legacy = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
    assert.equal('evidenceProvenance' in legacy, false, `${name} é legado (sem o campo)`);
    assert.equal(scoreRunSchema.safeParse(legacy).success, true, `${name}: legado legível`);
    assert.equal(scoreRunSchema.safeParse({ ...legacy, evidenceProvenance: PROOF }).success, true, `${name}: com o campo`);
    for (const malformed of [null, {}, { ...PROOF, keyIds: [] }, { ...PROOF, headSeq: 0 }, { ...PROOF, extra: true }]) {
      assert.equal(scoreRunSchema.safeParse({ ...legacy, evidenceProvenance: malformed }).success, false, `${name}: ${JSON.stringify(malformed)}`);
    }
  }
});

/* ============================================================================================ prévia: interna × pública */

test('R2.1 prévia: a Evaluation carrega a prova EXATA do verificador v2; a prévia pública NÃO a expõe (nem na avaliação, nem em preview())', async () => {
  const { w, keys, sealed, policy, preview } = await attestedWorld();
  const trust = await policy.classify(w.auditId, await basisEvidences(w));
  assert.deepEqual(trust, { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(sealed), keyIds: [keys.keyId] });
  const evaluated = await preview.evaluate(OP_B, w.auditId);
  assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
  assert.deepEqual(evaluated.value.provenance, { headSeq: 1, headSealSha256: sealSha256(sealed), keyIds: [keys.keyId] });
  assert.equal(evaluated.value.payload.finalization.allowed, true);
  const pub = await preview.preview(OP_B, w.auditId);
  assert.ok(pub.ok);
  for (const payload of [evaluated.value.payload, pub.value]) {
    assert.deepEqual(payload.evidence.provenance, { status: 'AUTHENTICATED', reason: null, missingRefs: [] });
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(sealSha256(sealed)), 'o hash da cabeça não sai na prévia');
    assert.ok(!text.includes(keys.keyId), 'o id da chave não sai na prévia');
    assert.ok(!HEAD_FIELDS.test(text), 'nenhum campo da proveniência na prévia');
  }
});

test('R2.1 prévia: AUTHENTICATED sem a prova v2 (caminho v1 do modo [1,2]) não é finalizável — SEAL_VERSION_NOT_ALLOWED, provenance null na Evaluation', async () => {
  const w = await world();
  const sealsDir = tmpDir('lrp-');
  const keys = evidenceKeys('ek-prov-v1');
  await sealAuditForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys }); // manifesto v1
  const policy = createSealedEvidenceProvenance({ sealsDir, trustedKeys: parseTrustKeys(keys.trustKeys) as never, acceptedVersions: [1, 2] });
  assert.deepEqual(await policy.classify(w.auditId, await basisEvidences(w)), { status: 'AUTHENTICATED' }, 'o verificador responde o caminho v1, sem cabeça');
  for (const evaluated of [await previewOver(w, { evidenceProvenance: policy }).evaluate(OP_B, w.auditId), await previewOver(w, { evidenceProvenance: fixedPolicy({ status: 'AUTHENTICATED' }) }).evaluate(OP_B, w.auditId)]) {
    assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
    assert.equal(evaluated.value.provenance, null);
    assert.deepEqual(evaluated.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'SEAL_VERSION_NOT_ALLOWED', missingRefs: [] });
    assert.equal(evaluated.value.payload.finalization.allowed, false);
    assert.ok(evaluated.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.severity === 'BLOCKING' && b.reasonCode === 'SEAL_VERSION_NOT_ALLOWED'));
  }
});

test('R2.1 prévia: prova v2 MALFORMADA vinda da política (cabeça fora do limite, hash inválido, keyIds vazios/fora de ordem/repetidos/inválidos) falha fechado como prova ausente', async () => {
  const w = await world();
  const malformed: ReadonlyArray<Record<string, unknown>> = [
    { ...PROOF, headSeq: 0 },
    { ...PROOF, headSeq: 257 },
    { ...PROOF, headSeq: 1.5 },
    { ...PROOF, headSealSha256: 'AB'.repeat(32) },
    { ...PROOF, headSealSha256: 'ab' },
    { ...PROOF, keyIds: [] },
    { ...PROOF, keyIds: ['ek-teste-0002', 'ek-teste-0001'] },
    { ...PROOF, keyIds: ['ek-teste-0001', 'ek-teste-0001'] },
    { ...PROOF, keyIds: ['EK-X'] },
    { ...PROOF, keyIds: 'ek-teste-0001' },
    { headSeq: 1, headSealSha256: PROOF.headSealSha256 },
  ];
  for (const proof of malformed) {
    const evaluated = await previewOver(w, { evidenceProvenance: fixedPolicy({ status: 'AUTHENTICATED', ...proof } as never) }).evaluate(OP_B, w.auditId);
    assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
    assert.equal(evaluated.value.provenance, null, JSON.stringify(proof));
    assert.equal(evaluated.value.payload.finalization.allowed, false, JSON.stringify(proof));
    assert.ok(evaluated.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'SEAL_VERSION_NOT_ALLOWED'), JSON.stringify(proof));
  }
  // prova bem formada (16 ids, cabeça 256) continua aceita: a validação não é mais estreita que o verificador
  const wide = { headSeq: 256, headSealSha256: 'cd'.repeat(32), keyIds: Array.from({ length: 16 }, (_, i) => `ek-chave-${String(i).padStart(2, '0')}`) };
  const ok = await previewOver(w, { evidenceProvenance: fixedPolicy({ status: 'AUTHENTICATED', ...wide }) }).evaluate(OP_B, w.auditId);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.provenance, wide);
});

test('R2.1 prévia: sem evidência (NO_EVIDENCE) e com UNAUTHENTICATED a Evaluation não carrega prova', async () => {
  const empty = await world({ seed: false });
  assert.ok((await writeCapture(empty.evidenceDir, captureInput({ auditId: empty.auditId }))).ok); // captura sem relatório
  const none = await previewOver(empty).evaluate(OP_B, empty.auditId);
  assert.ok(none.ok && none.value.payload.state === 'SEM_EVIDENCIA', JSON.stringify(none).slice(0, 200));
  assert.equal(none.value.provenance, null);
  const w = await world();
  const refused = await previewOver(w, { evidenceProvenance: fixedPolicy({ status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_REVOKED', revokedKeyIds: ['ek-teste-0001'] }) }).evaluate(OP_B, w.auditId);
  assert.ok(refused.ok);
  assert.equal(refused.value.provenance, null);
  assert.ok(!JSON.stringify(refused.value.payload).includes('ek-teste-0001'), 'nem os ids revogados saem na prévia');
});

/* ============================================================================================ escrita nova */

test('R2.1 escrita: a finalização grava EXATAMENTE a cabeça e as chaves que o verificador v2 devolveu; a projeção pública não as expõe', async () => {
  const { w, keys, sealed, preview } = await attestedWorld();
  const e = resultsEnv();
  const svc = makeService(e, preview);
  const ev = await preview.evaluate(OP_B, w.auditId);
  assert.ok(ev.ok);
  const done = await svc.finalize(OP_B, w.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(done.ok, JSON.stringify(done).slice(0, 300));
  const { run } = onlyRunOf(e, w.auditId);
  assert.deepEqual(run.evidenceProvenance, { headSeq: 1, headSealSha256: sealSha256(sealed), keyIds: [keys.keyId] });
  assert.equal(run.schemaVersion, 1, 'sem o livro: formato v1 de sempre, agora com o campo (sem v3)');
  const read = await readRunLog(e.base, w.auditId, { anchorDir: e.anchors });
  assert.ok(read.ok);
  assert.deepEqual(read.value.runs[0]?.evidenceProvenance, run.evidenceProvenance);
  const listed = await svc.list(OP_B, w.auditId);
  const detail = await svc.get(OP_B, w.auditId, 1);
  assert.ok(listed.ok && detail.ok);
  for (const out of [done.value, listed.value, detail.value]) {
    const text = JSON.stringify(out);
    assert.ok(!HEAD_FIELDS.test(text) && !text.includes(sealSha256(sealed)) && !text.includes(keys.keyId), 'a proveniência gravada não sai nas respostas (R2.2 decide a projeção)');
  }
});

test('R2.1 escrita: cadeia de 2 manifestos com chave aposentada coberta por fecho — grava a cabeça 2 e keyIds = posições + signatário do fecho, ordenados', async () => {
  const { w, R, S, A, second, policy, preview } = await retiredChainWorld();
  const expected = { headSeq: 2, headSealSha256: sealSha256(second), keyIds: [A.keyId, R.keyId, S.keyId].sort() };
  assert.deepEqual(await policy.classify(w.auditId, await basisEvidences(w)), { status: 'AUTHENTICATED', ...expected }, 'o verificador real');
  const e = resultsEnv();
  const ev = await preview.evaluate(OP_A, w.auditId);
  assert.ok(ev.ok && ev.value.payload.finalization.allowed, JSON.stringify(ev).slice(0, 300));
  assert.deepEqual(ev.value.provenance, expected);
  const done = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(done.ok, JSON.stringify(done).slice(0, 300));
  assert.deepEqual(onlyRunOf(e, w.auditId).run.evidenceProvenance, expected);
});

test('R2.1 escrita: a prova MUDA entre a avaliação e a releitura do passo 6 (fingerprintNow) ⇒ INPUT_CHANGED, nada gravado (a impressão digital inclui a resposta do verificador)', async () => {
  const w = await world();
  const proofA = { headSeq: 1, headSealSha256: 'a1'.repeat(32), keyIds: ['ek-prova-a'] };
  const proofB = { headSeq: 2, headSealSha256: 'b2'.repeat(32), keyIds: ['ek-prova-a', 'ek-prova-b'] };
  let calls = 0;
  // as DUAS leituras da avaliação veem a cadeia A; a releitura do passo 6 vê B (outra cabeça e outras chaves): as duas respostas são AUTHENTICATED e bem formadas
  const switching: EvidenceProvenancePolicy = { classify: async () => ({ status: 'AUTHENTICATED', ...(++calls <= 2 ? proofA : proofB) }) };
  const preview = previewOver(w, { evidenceProvenance: switching });
  const ev = await preview.evaluate(OP_A, w.auditId);
  assert.ok(ev.ok && ev.value.payload.finalization.allowed, JSON.stringify(ev).slice(0, 200));
  assert.deepEqual(ev.value.provenance, proofA);
  calls = 0;
  const e = resultsEnv();
  const attempt = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'INPUT_CHANGED', JSON.stringify(attempt).slice(0, 300));
  assert.equal(calls, 3, 'duas leituras da avaliação e a releitura do passo 6');
  nothingWritten(e, w.auditId);
});

test('R2.1 escrita: prova só v1 (modo [1,2]) ⇒ NOT_FINALIZABLE com o bloqueio, nada gravado', async () => {
  const w = await world();
  const sealsDir = tmpDir('lrp-');
  const keys = evidenceKeys('ek-prov-v1b');
  await sealAuditForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const preview = previewOver(w, { evidenceProvenance: createSealedEvidenceProvenance({ sealsDir, trustedKeys: parseTrustKeys(keys.trustKeys) as never, acceptedVersions: [1, 2] }) });
  const ev = await preview.evaluate(OP_A, w.auditId);
  assert.ok(ev.ok);
  const e = resultsEnv();
  const attempt = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'SEAL_VERSION_NOT_ALLOWED'), JSON.stringify(attempt).slice(0, 300));
  nothingWritten(e, w.auditId);
});

test('R2.1 escrita: avaliação SEM prova (mesmo "finalizável" e sem bloqueios) é recusada pelo serviço — nada gravado', async () => {
  const ev = { ...buildEvaluation(), provenance: null } as never;
  const e = resultsEnv();
  const attempt = await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev));
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'SEAL_VERSION_NOT_ALLOWED'), JSON.stringify(attempt).slice(0, 300));
  nothingWritten(e, 'auditoria-res-0001');
  // controle: a mesma avaliação COM a prova grava, e grava exatamente a prova da avaliação
  const withProof = { ...buildEvaluation(), provenance: { headSeq: 3, headSealSha256: 'ef'.repeat(32), keyIds: ['ek-teste-0001', 'ek-teste-0002'] } } as never;
  const e2 = resultsEnv();
  const done = await makeService(e2, new FakeEvaluator(withProof)).finalize(OP_A, 'auditoria-res-0001', bodyOf(withProof));
  assert.ok(done.ok, JSON.stringify(done).slice(0, 300));
  assert.deepEqual(onlyRunOf(e2, 'auditoria-res-0001').run.evidenceProvenance, { headSeq: 3, headSealSha256: 'ef'.repeat(32), keyIds: ['ek-teste-0001', 'ek-teste-0002'] });
});

test('R2.1 escrita: avaliação com prova MALFORMADA nunca é gravada (o esquema do registro recusa antes de publicar)', async () => {
  for (const provenance of [{ ...PROOF, keyIds: ['ek-teste-0002', 'ek-teste-0001'] }, { ...PROOF, headSeq: 0 }, { ...PROOF, headSealSha256: 'XY' }, { ...PROOF, keyIds: [] }, { ...PROOF, headSeq: 257 }, { ...PROOF, keyIds: ['EK-X'] }]) {
    const ev = { ...buildEvaluation(), provenance } as never;
    const e = resultsEnv();
    const attempt = await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev));
    assert.ok(!attempt.ok, JSON.stringify(provenance));
    nothingWritten(e, 'auditoria-res-0001');
  }
});

test('R2.1 armazenamento: appendRun recusa (fechado) uma escrita NOVA sem evidenceProvenance; com o campo, grava', async () => {
  const ev = buildEvaluation();
  const e = resultsEnv();
  const done = await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev));
  assert.ok(done.ok, JSON.stringify(done).slice(0, 300));
  const { run } = onlyRunOf(e, 'auditoria-res-0001');
  const { seq, prevSha256, contentSha256, origin, evidenceProvenance, ...rest } = run;
  void seq;
  void prevSha256;
  void contentSha256;
  void origin;
  assert.ok(evidenceProvenance, 'o resultado novo tem o campo');
  const options = { anchorDir: '', now: () => '2026-10-30T13:00:00.000Z', origin: TEST_ORIGIN };
  const without = resultsEnv();
  const refused = await appendRun(without.base, 'auditoria-res-0001', async () => ({ ok: true as const, draft: rest as unknown as ScoreRunDraft }), { ...options, anchorDir: without.anchors });
  assert.ok(!refused.ok && refused.code === 'INTERNAL', JSON.stringify(refused).slice(0, 200));
  nothingWritten(without, 'auditoria-res-0001');
  const withField = resultsEnv();
  const accepted = await appendRun(withField.base, 'auditoria-res-0001', async () => ({ ok: true as const, draft: { ...rest, evidenceProvenance } as unknown as ScoreRunDraft }), { ...options, anchorDir: withField.anchors });
  assert.ok(accepted.ok, JSON.stringify(accepted).slice(0, 200));
  assert.deepEqual(accepted.run.evidenceProvenance, evidenceProvenance);
});

/* ============================================================================================ leitura */

test('R2.1 leitura: resultados LEGADOS (v1 e v2, sem o campo) continuam legíveis, com os MESMOS bytes e o mesmo hash', async () => {
  for (const [name, digest] of Object.entries(LEGACY_SHA256)) assert.equal(sha256File(path.join(FIXTURES, name)), digest, `fixture ${name} intacta`);
  for (const auditId of ['auditoria-legado-v1', 'auditoria-legado-v2']) {
    const e = legacyEnv(auditId);
    const file = path.join(e.base, auditId, 's0001.json');
    const before = sha256File(file);
    const read = await readRunLog(e.base, auditId, { anchorDir: e.anchors });
    assert.ok(read.ok, `${auditId}: ${JSON.stringify(read).slice(0, 200)}`);
    const run = read.value.runs[0] as ScoreRun;
    assert.equal(read.value.runs.length, 1);
    assert.equal('evidenceProvenance' in run, false, 'ausente = legado sem proveniência');
    assert.equal(run.contentSha256, (JSON.parse(fs.readFileSync(file, 'utf8')) as ScoreRun).contentSha256);
    assert.equal(sha256File(file), before, 'a leitura não toca o arquivo');
  }
  // consulta do serviço sem o livro (só v1 é exibível assim): legível, RECEIPT_ONLY, o mesmo hash
  const e = legacyEnv('auditoria-legado-v1');
  const svc = makeService(e, new FakeEvaluator(buildEvaluation({ auditId: 'auditoria-legado-v1' })));
  const listed = await svc.list(OP_A, 'auditoria-legado-v1');
  assert.ok(listed.ok, JSON.stringify(listed).slice(0, 300));
  assert.equal(listed.value.confirmation, 'RECEIPT_ONLY');
  assert.equal(listed.value.results[0]?.contentSha256, (JSON.parse(fs.readFileSync(path.join(FIXTURES, 'results/auditoria-legado-v1/s0001.json'), 'utf8')) as ScoreRun).contentSha256);
  const detail = await svc.get(OP_A, 'auditoria-legado-v1', 1);
  assert.ok(detail.ok);
});

test('R2.1 leitura: campo PRESENTE e malformado (re-selado, hash coerente) ⇒ falha de integridade na leitura, nenhum dado exibido', async () => {
  const ev = buildEvaluation();
  const e = resultsEnv();
  const done = await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev));
  assert.ok(done.ok);
  const { run } = onlyRunOf(e, 'auditoria-res-0001');
  const file = path.join(e.base, 'auditoria-res-0001', 's0001.json');
  const pristine = fs.readFileSync(file, 'utf8');
  for (const malformed of [null, {}, { ...PROOF, keyIds: [] }, { ...PROOF, keyIds: ['ek-teste-0002', 'ek-teste-0001'] }, { ...PROOF, headSeq: 0 }, { ...PROOF, headSealSha256: 'AB'.repeat(32) }, { ...PROOF, extra: true }, 'texto']) {
    const { contentSha256, ...body } = run;
    void contentSha256;
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, serialize(seal({ ...body, evidenceProvenance: malformed })));
    const read = await readRunLog(e.base, 'auditoria-res-0001', { anchorDir: e.anchors });
    assert.ok(!read.ok && ['SCHEMA', 'CORRUPT'].includes(read.code), `${JSON.stringify(malformed)}: ${JSON.stringify(read).slice(0, 200)}`);
    const svc = makeService(e, new FakeEvaluator(ev));
    for (const out of [await svc.list(OP_A, 'auditoria-res-0001'), await svc.get(OP_A, 'auditoria-res-0001', 1)]) {
      assert.ok(!out.ok && out.code === 'RESULT_INTEGRITY', `${JSON.stringify(malformed)}: ${JSON.stringify(out).slice(0, 200)}`);
    }
  }
  fs.writeFileSync(file, pristine);
  assert.ok((await readRunLog(e.base, 'auditoria-res-0001', { anchorDir: e.anchors })).ok, 'controle: o original volta a ser legível');
});

/* ============================================================================================ conclusão de pendente legada */

test('R2.1 conclusão: pendente LEGADA (sem o campo, origem comprovada) NÃO é concluída — nenhum recibo; pendente nova (com o campo) é concluída pelo autor', async () => {
  const auditId = 'auditoria-legado-v1';
  const e = resultsEnv();
  fs.mkdirSync(path.join(e.base, auditId), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'results', auditId, 's0001.json'), path.join(e.base, auditId, 's0001.json'));
  const ev = buildEvaluation({ auditId });
  const svc = makeService(e, new FakeEvaluator(ev));
  const listed = await svc.list(OP_A, auditId);
  assert.ok(listed.ok && listed.value.pending?.origin === 'PROVEN' && listed.value.pending.isMine, JSON.stringify(listed).slice(0, 300));
  const refused = await svc.finalize(OP_A, auditId, bodyOf(ev));
  assert.ok(!refused.ok && refused.code === 'NOT_FINALIZABLE' && refused.blockers?.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'PROVENANCE_NOT_RECORDED'), JSON.stringify(refused).slice(0, 300));
  assert.equal(refused.pending?.seq, 1, 'a pendente continua dita');
  assert.equal(fs.existsSync(path.join(e.anchors, auditId, 'a0001.json')), false, 'nenhum recibo para resultado sem proveniência');
  // controle: pendente gravada pela R2.1 (com o campo) é concluída pelo autor
  const e2 = resultsEnv();
  const anchorsFail = nodeFsOps;
  const failing = makeService(e2, new FakeEvaluator(ev), {
    fs: {
      ...anchorsFail,
      async writeExclusive(target: string, data: string, mode?: number) {
        if (target.startsWith(e2.anchors)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return anchorsFail.writeExclusive(target, data, mode);
      },
    } as never,
  });
  const pending = await failing.finalize(OP_A, auditId, bodyOf(ev));
  assert.ok(!pending.ok && pending.code === 'RESULT_ANCHOR_PENDING', JSON.stringify(pending).slice(0, 200));
  const concluded = await makeService(e2, new FakeEvaluator(ev)).finalize(OP_A, auditId, bodyOf(ev));
  assert.ok(concluded.ok && concluded.value.recoveredPending, JSON.stringify(concluded).slice(0, 300));
  assert.ok(onlyRunOf(e2, auditId).run.evidenceProvenance);
});
