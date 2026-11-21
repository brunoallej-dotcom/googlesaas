import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createSealedEvidenceProvenance, parseTrustKeys, sealSha256 } from '../src/lib/link-audit-evidence/provenance';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import type { LedgerRecord } from '../src/lib/link-audit-ledger';
import { clearStorageFatal, seal, serialize } from '../src/lib/link-audit-storage';
import { ANA, clock, hashTree, must, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { evidenceKeys, sealAuditForTests, sealAuditV2ForTests, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';
import { LEDGER_AUTH_A, ledgerRecords, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, OP_B, receiptPath, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { resign } from './helpers/link-audit-results-ledger-fixtures';
import { finalizerOver, openRunWorld, protectedWorld, runsOf } from './helpers/link-audit-results-ledger-finalize-fixtures';

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
  const port = base.decisions.resultsLedger;
  if (!port) throw new Error('serviço de decisões sem a porta do livro');
  return { preview, results: makeService(e, preview, { ledger: port }) };
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

/* ============================================================================================ pendente LEGADA com o livro (revisão do PR #55) */

const overwrite = (file: string, text: string): void => {
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o444);
};

/**
 * Operação de resultado aberta em B ou C cujo resultado pendente é LEGADO (gravado como o código anterior à R2.1 gravava: sem `evidenceProvenance`). Monta-se a partir de uma
 * pendente real: tira-se o campo, refaz-se a etiqueta de origem (chave de TESTE do servidor) e o selo, o recibo da fase C passa a citar o novo hash e o `RUN_INTENT` (último
 * registro do livro) é reassinado com o novo `runSha256`. O livro continua íntegro e vê a operação aberta na mesma fase.
 */
async function legacyOpenRun(phase: 'B' | 'C') {
  const { w, e, body, run } = await openRunWorld(phase);
  const { contentSha256, origin, evidenceProvenance, ...unsigned } = run;
  void contentSha256;
  void origin;
  assert.ok(evidenceProvenance, 'a pendente real (R2.1) tem o campo');
  const legacy = seal({ ...unsigned, origin: TEST_ORIGIN.sign('RUN', unsigned) }) as ScoreRun;
  overwrite(runPath(e, 1, w.auditId), serialize(legacy));
  if (phase === 'C') {
    const { contentSha256: receiptSha, ...receipt } = JSON.parse(fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8')) as Record<string, unknown>;
    void receiptSha;
    overwrite(receiptPath(e, 1, w.auditId), serialize(seal({ ...receipt, headSha256: legacy.contentSha256 })));
  }
  const records = await ledgerRecords(w);
  const intent = records.at(-1) as LedgerRecord;
  assert.equal(intent.event, 'RUN_INTENT');
  const resigned = resign(LEDGER_AUTH_A, intent, (u) => ({ ...u, run: { ...(u.run as Record<string, unknown>), runSha256: legacy.contentSha256 } }));
  overwrite(path.join(w.ledgerDir, w.auditId, `l${String(intent.ledgerSeq).padStart(6, '0')}.json`), serialize(resigned));
  const view = await must(servicesOver(w, e).list(ANA, w.auditId, clock()));
  assert.equal(view.ledger.state, 'PROTECTED', show(view.ledger));
  assert.equal(view.ledger.runs?.open?.phase, phase, `fase ${phase} vista pelo livro: ${show(view.ledger.runs)}`);
  return { w, e, body, legacy };
}

for (const phase of ['B', 'C'] as const) {
  test(`R2.1 livro: pendente LEGADA em ${phase} (sem evidenceProvenance) ⇒ NOT_FINALIZABLE/PROVENANCE_NOT_RECORDED; nenhum recibo, livro sem registro novo, RUN_INTENT aberto e novas finalizações recusadas como hoje`, async () => {
    const { w, e, body, legacy } = await legacyOpenRun(phase);
    assert.equal('evidenceProvenance' in legacy, false);
    const ledgerBefore = hashTree(w.ledgerDir);
    const anchorsBefore = hashTree(e.anchors);
    const runsBefore = hashTree(e.base);
    const f = finalizerOver(w, e);
    // o AUTOR, com o pedido IDÊNTICO e a origem comprovada: a conclusão é recusada
    const refused = await f.results.finalize(OP_A, w.auditId, body);
    assert.ok(!refused.ok && refused.code === 'NOT_FINALIZABLE' && refused.blockers?.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'PROVENANCE_NOT_RECORDED'), show(refused));
    assert.equal(refused.pending?.seq, 1, 'a pendente continua dita');
    assert.equal(refused.pending?.receipt, phase === 'C' ? 'PRESENT' : 'MISSING');
    assert.deepEqual(hashTree(w.ledgerDir), ledgerBefore, 'livro sem registro novo (nem RUN_CONFIRMED, nem RUN_ABORTED)');
    assert.deepEqual(hashTree(e.anchors), anchorsBefore, phase === 'B' ? 'nenhum recibo gravado' : 'o recibo da fase C não muda');
    assert.deepEqual(hashTree(e.base), runsBefore, 'o resultado legado não é reescrito');
    assert.equal(fs.existsSync(receiptPath(e, 1, w.auditId)), phase === 'C');
    const view = await must(servicesOver(w, e).list(ANA, w.auditId, clock()));
    assert.equal(view.ledger.runs?.open?.phase, phase, 'o RUN_INTENT continua aberto');
    // novas finalizações continuam recusadas como hoje (a pendente bloqueia): outro operador com o pedido idêntico e o autor com outro pedido
    const other = await f.results.finalize(OP_B, w.auditId, body);
    assert.equal(other.ok ? null : other.code, 'RESULT_PENDING_UNCONFIRMED', show(other));
    const fresh = await f.results.finalize(OP_A, w.auditId, { ...body, expectedInputSha256: 'f'.repeat(64) });
    assert.equal(fresh.ok ? null : fresh.code, 'RESULT_PENDING_UNCONFIRMED', show(fresh));
    assert.deepEqual(hashTree(w.ledgerDir), ledgerBefore, 'nada gravado no livro pelas tentativas');
    assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], [runsBefore, anchorsBefore]);
  });
}
