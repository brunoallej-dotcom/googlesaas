import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createSealedEvidenceProvenance, parseTrustKeys, sealSha256 } from '../src/lib/link-audit-evidence/provenance';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { hashTree, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { evidenceKeys, sealAuditForTests, sealAuditV2ForTests, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';
import { ledgerRecords, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, OP_B, receiptPath, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { finalizerOver, protectedWorld, runsOf } from './helpers/link-audit-results-ledger-finalize-fixtures';

/*
 * R2.1 com o LIVRO (auditoria protegida, formato v2 com `ledgerHead`): o resultado confirmado pelo livro grava a proveniência devolvida pelo verificador v2 real; o `RUN_INTENT`
 * amarra o hash do resultado INTEIRO (inclui o campo); a reemissão do recibo da R1.6 e o reenvio confirmado (11b) preservam os bytes e o hash. Prova só v1 ⇒ nada é publicado
 * nem registrado no livro. Pastas reais, chaves de TESTE, e-mails fictícios, nenhuma rede.
 */
registerCleanup();
test.afterEach(() => clearStorageFatal());

const show = (value: unknown): string => JSON.stringify(value).slice(0, 360);
const HEAD_FIELDS = /headSeq|headSealSha256|keyIds|evidenceProvenance/;

/** Finalização com o livro real e a prévia sobre a política dada (a de produção: `[2]`). */
function finalizerWith(w: LedgerWorld, e: ResultsEnv, keys: EvidenceKeys, sealsDir: string, versions: readonly (1 | 2)[] = [2]) {
  const base = finalizerOver(w, e);
  const policy = createSealedEvidenceProvenance({ sealsDir, trustedKeys: parseTrustKeys(keys.trustKeys) as never, acceptedVersions: versions });
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: base.decisions }, { evidenceProvenance: policy });
  return { preview, results: makeService(e, preview, { ledger: base.decisions.resultsLedger }) };
}
async function bodyFrom(preview: ReturnType<typeof previewOver>, auditId: string) {
  const ev = await preview.evaluate(OP_A, auditId);
  if (!ev.ok) throw new Error(show(ev));
  return { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string };
}

/** Auditoria protegida, coleta atestada por manifesto v2, UM resultado confirmado pelo livro (Ana). */
async function confirmedWithProof() {
  const { w, e } = await protectedWorld();
  const sealsDir = tmpDir('lrpl-');
  const keys = evidenceKeys('ek-prov-livro');
  const sealed = await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const f = finalizerWith(w, e, keys, sealsDir);
  const body = await bodyFrom(f.preview, w.auditId);
  const done = await f.results.finalize(OP_A, w.auditId, body);
  assert.ok(done.ok, show(done));
  const { runs, pending } = await runsOf(e, w.auditId);
  assert.deepEqual([runs.length, pending], [1, null]);
  return { w, e, keys, sealsDir, sealed, body, run: runs[0] as ScoreRun, done };
}

test('R2.1 livro: o resultado v2 confirmado pelo livro grava a prova do verificador v2; o RUN_INTENT/RUN_CONFIRMED amarram o hash que inclui o campo', async () => {
  const { w, e, keys, sealed, run, done } = await confirmedWithProof();
  assert.equal(run.schemaVersion, 2, 'auditoria protegida: formato v2 de sempre (sem v3)');
  assert.ok(run.ledgerHead);
  assert.deepEqual(run.evidenceProvenance, { headSeq: 1, headSealSha256: sealSha256(sealed), keyIds: [keys.keyId] });
  const records = await ledgerRecords(w);
  const intent = records.filter((r) => r.event === 'RUN_INTENT').at(-1) as unknown as { run: { runSha256: string } };
  assert.equal(intent.run.runSha256, run.contentSha256, 'o livro cita o hash do resultado com o campo');
  assert.equal(records.at(-1)?.event, 'RUN_CONFIRMED');
  const listed = await finalizerWith(w, e, keys, tmpDir('lrpl-')).results.list(OP_B, w.auditId); // a consulta não depende da prova de hoje (R2.2 decide a reconferência)
  assert.ok(listed.ok && listed.value.confirmation === 'LEDGER', show(listed));
  for (const out of [done.ok ? done.value : null, listed.value]) assert.ok(!HEAD_FIELDS.test(JSON.stringify(out)), 'nada da proveniência nas respostas');
});

test('R2.1 livro: a reemissão do recibo (R1.6) não toca o resultado — mesmos bytes, mesmo hash, mesma proveniência', async () => {
  const { w, e, keys, sealsDir, run } = await confirmedWithProof();
  const file = runPath(e, 1, w.auditId);
  const before = fs.readFileSync(file);
  fs.rmSync(receiptPath(e, 1, w.auditId));
  const reissued = await finalizerWith(w, e, keys, sealsDir).results.reissueReceipt(OP_B, w.auditId, { action: 'REISSUE_RECEIPT' });
  assert.ok(reissued.ok, show(reissued));
  assert.deepEqual(fs.readFileSync(file), before, 'bytes do resultado inalterados');
  const { runs } = await runsOf(e, w.auditId);
  assert.equal(runs[0]?.contentSha256, run.contentSha256);
  assert.deepEqual(runs[0]?.evidenceProvenance, run.evidenceProvenance);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8')).headSha256, run.contentSha256);
});

test('R2.1 livro: o reenvio idêntico de resultado já confirmado (11b) responde 200 sem regravar — mesmos bytes e mesmo hash', async () => {
  const { w, e, keys, sealsDir, body, run } = await confirmedWithProof();
  const before = hashTree(e.base);
  const replay = await finalizerWith(w, e, keys, sealsDir).results.finalize(OP_A, w.auditId, body);
  assert.ok(replay.ok && replay.value.replayed, show(replay));
  assert.deepEqual(hashTree(e.base), before, 'nenhum byte de resultado mudou');
  assert.equal(replay.value.head.sha256, run.contentSha256);
});

test('R2.1 livro: prova só v1 ⇒ NOT_FINALIZABLE; nada publicado e NENHUM RUN_INTENT no livro', async () => {
  const { w, e } = await protectedWorld();
  const sealsDir = tmpDir('lrpl-');
  const keys = evidenceKeys('ek-prov-livro1');
  await sealAuditForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const f = finalizerWith(w, e, keys, sealsDir, [1, 2]);
  const ledgerBefore = hashTree(w.ledgerDir);
  const attempt = await f.results.finalize(OP_A, w.auditId, await bodyFrom(f.preview, w.auditId));
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'SEAL_VERSION_NOT_ALLOWED'), show(attempt));
  assert.deepEqual(hashTree(w.ledgerDir), ledgerBefore, 'livro inalterado');
  assert.ok(!(await ledgerRecords(w)).some((r) => r.event === 'RUN_INTENT'));
  assert.deepEqual((await runsOf(e, w.auditId)).all, []);
});
