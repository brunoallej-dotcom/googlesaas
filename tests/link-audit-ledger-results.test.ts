import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { createResultsKnownHeads } from '../src/lib/link-audit-scoring-runs';
import { scoreRunSchema, type ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, anchorPath, BIA, clock, entryPath, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerPath, ledgerRecords, ledgerWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, receiptPath, resultsEnv, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * RESULTADOS × LIVRO (Q4): o resultado selado NOVO grava `ledgerHead` (formato v2); o v1 segue legível e inalterado; a leitura confere a posição citada;
 * resultado que cita o que o livro não tem (livro truncado/refeito) ⇒ NÃO resolvido; livro sumido com resultado que o cita ⇒ NÃO resolvido.
 * Finalizar exige auditoria PROTEGIDA e sem operação aberta.
 */
registerCleanup();

const witnessOver = (w: LedgerWorld, e: ResultsEnv) => createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir, w.ledgerDir], origin: TEST_ORIGIN });
const servicesOver = (w: LedgerWorld, e: ResultsEnv) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witnessOver(w, e) });

/** Auditoria protegida com uma decisão e um resultado selado sobre ela PELO LIVRO (R1.3: `RUN_INTENT` + `RUN_CONFIRMED`; R1.5: sem o par seria `UNLEDGERED_RESULT`). */
async function sealedWorld(): Promise<{ w: LedgerWorld; e: ResultsEnv; run: ScoreRun }> {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const decisions = servicesOver(w, e);
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
  assert.equal(evaluated.value.decisions.ledger.state, 'PROTECTED');
  const port = decisions.resultsLedger;
  assert.ok(port, 'porta de escrita do livro');
  const done = await makeService(e, preview, { ledger: port }).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  assert.ok(done.ok, JSON.stringify(done).slice(0, 240));
  const read = await readRunLog(e.base, w.auditId, { anchorDir: e.anchors });
  assert.ok(read.ok);
  return { w, e, run: read.value.runs[0] as ScoreRun };
}

test('o resultado NOVO de uma auditoria protegida é v2 e carrega a cabeça de DECISÕES do livro do instante da finalização; a leitura segue íntegra e a auditoria PROTEGIDA', async () => {
  const { w, e, run } = await sealedWorld();
  assert.equal(run.schemaVersion, 2);
  const records = await ledgerRecords(w);
  // §16.17.9 (R1.5): o resultado cita a cabeça de DECISÕES (§16.17.7), nunca uma posição RUN_* — a cauda é o par RUN_INTENT + RUN_CONFIRMED desta finalização (cauda − 2)
  assert.deepEqual(records.slice(-2).map((r) => r.event), ['RUN_INTENT', 'RUN_CONFIRMED']);
  assert.deepEqual(run.ledgerHead, { ledgerSeq: records.length - 2, sha256: records[records.length - 3]?.contentSha256 });
  assert.ok(scoreRunSchema.safeParse(run).success);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.witness.status, view.finalizable], ['PROTECTED', 'CONSISTENT', true]);
  // o provedor da testemunha informa ao livro o que o resultado cita
  const provider = await witnessOver(w, e)(w.auditId);
  assert.ok(provider.ok && provider.hasResults === true && provider.ledgerHeads?.length === 1 && provider.ledgerHeads[0]?.ledgerSeq === records.length - 2);
  // a auditoria continua andando: o livro cresce e o resultado cita um PREFIXO dele
  const head = (await must(servicesOver(w, e).list(ANA, w.auditId))).head;
  await must(servicesOver(w, e).revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: head }, clock()));
  const later = await must(servicesOver(w, e).list(BIA, w.auditId));
  assert.deepEqual([later.ledger.state, later.ledger.head?.ledgerSeq, later.witness.status], ['PROTECTED', records.length + 2, 'CONSISTENT']);
});

test('formato versionado: v1 continua válido SEM ledgerHead; v2 exige ledgerHead; nenhum arquivo ou recibo histórico é reescrito', async () => {
  const { run } = await sealedWorld();
  const { contentSha256, ledgerHead, ...body } = run;
  void contentSha256;
  void ledgerHead;
  const asV1 = seal({ ...body, schemaVersion: 1 as const });
  assert.ok(scoreRunSchema.safeParse(asV1).success, 'v1 sem ledgerHead (resultados antigos) é legível');
  assert.ok(!scoreRunSchema.safeParse(seal({ ...body, schemaVersion: 1 as const, ledgerHead })).success, 'v1 não pode carregar ledgerHead');
  assert.ok(!scoreRunSchema.safeParse(seal({ ...body, schemaVersion: 2 as const })).success, 'v2 exige ledgerHead');
  assert.ok(!scoreRunSchema.safeParse(seal({ ...body, schemaVersion: 3 as never, ledgerHead })).success, 'versão desconhecida');
  // sem livro (6B/6C isoladas) o resultado continua sendo v1, byte a byte como antes
  const w = await (await import('./helpers/link-audit-decisions-fixtures')).world();
  const e = resultsEnv();
  const preview = previewOver(w);
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok);
  assert.ok((await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string })).ok);
  const legacy = JSON.parse(fs.readFileSync(runPath(e, 1, w.auditId), 'utf8')) as Record<string, unknown>;
  assert.deepEqual([legacy.schemaVersion, 'ledgerHead' in legacy], [1, false]);
});

test('LIVRO TRUNCADO ou REFEITO por quem também refez as decisões (3 pastas): o resultado selado (4ª pasta) cita uma posição que o livro não tem ⇒ RESULT_LEDGER_MISMATCH', async () => {
  const { w, e, run } = await sealedWorld();
  // rollback coordenado do livro, das decisões e dos recibos até ANTES da primeira decisão (o atacante tem acesso a ESSAS três pastas, não à de resultados)
  for (const seq of [5, 4, 3, 2]) fs.rmSync(ledgerPath(w, seq)); // R1.5: inclui o par RUN_* da finalização
  fs.rmSync(entryPath(w, 1));
  fs.rmSync(anchorPath(w, 1));
  const view = await must(servicesOver(w, e).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions, view.finalizable], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', [], false]);
  assert.ok((run.ledgerHead?.ledgerSeq ?? 0) > 1);
  // as escritas são recusadas e nada é gravado
  const write = await servicesOver(w, e).create(ANA, w.auditId, { record: rec.c3(), expectedHead: null }, clock());
  assert.ok(!write.ok && write.code === 'DECISIONS_HISTORY_UNRESOLVED');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS']);
});

test('LIVRO REMOVIDO com resultado que o cita: NÃO resolvido (LEDGER_REMOVED_WITNESSED), nunca "legada" nem cabeça vazia', async () => {
  const { w, e } = await sealedWorld();
  fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  const view = await must(servicesOver(w, e).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions, view.finalizable], ['HISTORY_UNRESOLVED', 'LEDGER_REMOVED_WITNESSED', [], false]);
  const enroll = await servicesOver(w, e).ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!enroll.ok, 'não há reinscrição');
  assert.deepEqual(fs.existsSync(path.join(w.ledgerDir, w.auditId)), false, 'o livro não renasceu sozinho');
});

test('resultado PENDENTE forjado (sem origem) que cita o livro é só INDÍCIO: se confere, é ignorado; se contradiz, a testemunha não é confiável — e nunca vira resultado selado', async () => {
  const { w, e, run } = await sealedWorld();
  fs.rmSync(receiptPath(e, 1, w.auditId)); // o resultado vira pendente; com a origem comprovada ainda é testemunha
  assert.equal((await must(servicesOver(w, e).list(BIA, w.auditId))).ledger.state, 'PROTECTED');
  // forja SEM origem: perde o status de testemunha
  const forge = (ledgerHead: { ledgerSeq: number; sha256: string }): void => {
    const { contentSha256, origin, ...rest } = run;
    void contentSha256;
    void origin;
    const file = runPath(e, 1, w.auditId);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, serialize(seal({ ...rest, ledgerHead })));
  };
  forge(run.ledgerHead as { ledgerSeq: number; sha256: string });
  const same = await witnessOver(w, e)(w.auditId);
  assert.ok(same.ok && same.ledgerHeads?.length === 0 && same.unverifiedLedgerHeads?.length === 1, 'indício, não testemunha');
  // o INDÍCIO que confere é ignorado como testemunha; mas, desde a R1.5, o próprio arquivo trocado na posição que o livro confirmou é contradição (RESULT_DIVERGES, §16.17.5)
  const conferring = await must(servicesOver(w, e).list(BIA, w.auditId));
  assert.deepEqual([conferring.ledger.state, conferring.ledger.reason], ['HISTORY_UNRESOLVED', 'RESULT_DIVERGES'], 'o indício não é acusado; o livro acusa o objeto trocado');
  forge({ ledgerSeq: 3, sha256: 'e'.repeat(64) });
  const contradicts = await must(servicesOver(w, e).list(BIA, w.auditId));
  assert.deepEqual([contradicts.ledger.state, contradicts.ledger.reason, contradicts.decisions], ['HISTORY_UNRESOLVED', 'UNTRUSTED', []], 'o indício que contradiz vence (testemunhas antes do cruzamento de resultados)');
});

test('finalizar exige livro PROTEGIDO e sem operação aberta: a inscrever, legada, não resolvida ou com operação no meio ⇒ NOT_FINALIZABLE, nada gravado', async () => {
  const e = resultsEnv();
  const cases: Array<[string, () => Promise<{ w: LedgerWorld; decisions: ReturnType<typeof servicesOver> }>]> = [
    ['a inscrever', async () => { const w = await ledgerWorld({ enroll: false }); return { w, decisions: servicesOver(w, e) }; }],
    ['livro apagado (legada)', async () => { const w = await ledgerWorld(); await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock())); fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true }); return { w, decisions: servicesOver(w, e) }; }],
    ['recibo removido (não resolvida)', async () => { const w = await ledgerWorld(); await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock())); fs.rmSync(anchorPath(w, 1)); return { w, decisions: servicesOver(w, e) }; }],
  ];
  for (const [label, build] of cases) {
    const { w, decisions } = await build();
    const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
    const evaluated = await preview.evaluate(OP_A, w.auditId);
    assert.ok(evaluated.ok, label);
    assert.equal(evaluated.value.payload.finalization.allowed, false, label);
    assert.ok(evaluated.value.payload.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.severity === 'BLOCKING'), `${label}: ${JSON.stringify(evaluated.value.payload.blockers.map((b) => [b.code, b.reasonCode]))}`);
    const attempt = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
    assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE', `${label}: ${JSON.stringify(attempt).slice(0, 160)}`);
    const dir = path.join(e.base, w.auditId);
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], `${label}: nenhum resultado (a pasta da auditoria pode existir vazia)`);
  }
});

test('finalizar com OPERAÇÃO ABERTA no livro (INTENT gravada, decisão não publicada): a listagem mostra a operação, NÃO é finalizável e o resultado não é gravado', async () => {
  const e = resultsEnv();
  // a publicação da decisão falha DEPOIS de a INTENT estar no livro: a operação fica aberta
  const w = await ledgerWorld({ decisionsFs: faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } }) });
  const failed = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock());
  assert.ok(!failed.ok, 'a gravação da decisão falhou');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'a INTENT ficou sem CONFIRMED/ABORTED');
  const decisions = servicesOver(w, e);
  const view = await must(decisions.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.openOperation !== null, view.finalizable], ['PROTECTED', true, false]);
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok);
  assert.equal(evaluated.value.payload.finalization.allowed, false, 'a prévia não libera a finalização');
  const attempt = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE', JSON.stringify(attempt).slice(0, 160));
  const dir = path.join(e.base, w.auditId);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'nenhum resultado');
});
