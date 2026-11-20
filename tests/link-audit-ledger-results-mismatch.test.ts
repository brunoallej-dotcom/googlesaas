import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GET as listRoute, POST as createRoute } from '../src/app/api/link-audit/decisions/[auditId]/route';
import { POST as ledgerRoute } from '../src/app/api/link-audit/decisions/[auditId]/ledger/route';
import { POST as revokeRoute } from '../src/app/api/link-audit/decisions/[auditId]/revocations/route';
import { POST as finalizeRoute } from '../src/app/api/link-audit/scoring/[auditId]/finalize/route';
import { GET as previewRoute } from '../src/app/api/link-audit/scoring/[auditId]/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, anchorPath, BIA, clock, entryPath, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { proveEvidenceForRoutes } from './helpers/link-audit-evidence-provenance-fixtures';
import { applyLedgerEnv, decisionsOver, ledgerEvents, ledgerFor, ledgerPath, ledgerWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild, sealedWorld, sealResult, servicesOver, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * M29 — DESACORDO ENTRE RESULTADO E LIVRO (`RESULT_LEDGER_MISMATCH`): um resultado selado cita uma posição do livro que o livro não tem mais (ou com outro hash).
 * O desacordo vem SÓ do livro (quem escreve só na pasta do livro): as decisões e os recibos estão íntegros e a testemunha das decisões não reclama. Assim o teste
 * isola a defesa do livro: nenhuma outra checagem mascara uma escrita indevida. Em TODOS os canais (serviço, rotas, prévia, finalização, recuperação, processos
 * concorrentes) o resultado tem de ser bloqueio explícito e NENHUM arquivo de nenhuma das pastas pode mudar.
 */
registerCleanup();

const trees = (w: LedgerWorld, e: ResultsEnv) => ({ ledger: hashTree(w.ledgerDir), decisions: hashTree(w.decisionsDir), anchors: hashTree(w.anchorDir), results: hashTree(e.base), resultAnchors: hashTree(e.anchors) });
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';

/** Remove do livro o registro que o resultado cita E tudo o que veio depois (o livro "andou para trás" sozinho); decisões e recibos intactos. */
function dropCitedHead(w: LedgerWorld, cited: number): void {
  for (const name of fs.readdirSync(path.join(w.ledgerDir, w.auditId))) {
    const match = /^l(\d{6})\.json$/.exec(name);
    if (match && Number(match[1]) >= cited) fs.rmSync(path.join(w.ledgerDir, w.auditId, name));
  }
}

/** A entrada muda DEPOIS do selo (uma decisão a mais): assim uma nova finalização é de fato nova, e não a repetição idempotente do resultado já selado. */
async function driftAfterSeal(w: LedgerWorld): Promise<void> {
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
}

test('M29 (serviço): livro SEM o registro que o resultado cita — leitura não resolvida, NENHUMA recuperação oferecida, escrita/revogação/RECOVER/prévia/finalização bloqueadas e nada muda em disco', async () => {
  const { w, e, run } = await sealedWorld();
  const cited = run.ledgerHead?.ledgerSeq as number;
  await driftAfterSeal(w);
  const control = await must(servicesOver(w, e).list(BIA, w.auditId));
  assert.deepEqual([control.ledger.state, control.finalizable, control.decisions.length], ['PROTECTED', true, 2], 'controle: antes do desacordo está tudo íntegro');
  const controlPreview = await previewOver({ evidenceDir: w.evidenceDir, raw: servicesOver(w, e) }).evaluate(OP_A, w.auditId);
  assert.ok(controlPreview.ok && controlPreview.value.payload.finalization.allowed === true, 'controle: a prévia permite finalizar');

  dropCitedHead(w, cited);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'só o livro foi alterado (a cabeça citada e o que veio depois sumiram)');
  const before = trees(w, e);
  const service = servicesOver(w, e);

  const view = await must(service.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.recoverable, view.decisions.length, view.finalizable], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', false, 0, false], 'a testemunha dos resultados vence a receita de recuperação');
  assert.equal(view.witness.status, 'CONSISTENT', 'a testemunha das DECISÕES não reclama: o desacordo é só do livro');

  const write = await service.create(ANA, w.auditId, { record: rec.naFeature(), expectedHead: view.head }, clock());
  assert.ok(!write.ok && write.code === 'DECISIONS_HISTORY_UNRESOLVED' && write.issues.some((i) => /RESULT_LEDGER_MISMATCH/.test(i)), JSON.stringify(write).slice(0, 240));
  const revoke = await service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!revoke.ok && revoke.code === 'DECISIONS_HISTORY_UNRESOLVED', JSON.stringify(revoke).slice(0, 240));
  for (const actor of [ANA, BIA]) {
    const recover = await service.ledgerAction(actor, w.auditId, { action: 'RECOVER' }, clock());
    assert.ok(!recover.ok, 'RECOVER não pode "consertar" o que uma testemunha contradiz');
  }

  const evaluated = await previewOver({ evidenceDir: w.evidenceDir, raw: service }).evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok);
  assert.equal(evaluated.value.payload.finalization.allowed, false);
  assert.ok(evaluated.value.payload.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.severity === 'BLOCKING' && b.reasonCode === 'RESULT_LEDGER_MISMATCH'), JSON.stringify(evaluated.value.payload.blockers.map((b) => [b.code, b.reasonCode])));
  const attempt = await makeService(e, previewOver({ evidenceDir: w.evidenceDir, raw: service })).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string }); // o pedido que a PRÉVIA deste estado oferece
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE', JSON.stringify(attempt).slice(0, 200));

  assert.deepEqual(trees(w, e), before, 'nenhuma operação, em nenhum canal, gravou algo em alguma pasta');
});

test('M29 (desacordo com o livro IGUAL às decisões): ABORTED removido deixa uma INTENT vencida que seria "abortada de novo" — o abortamento NÃO acontece enquanto o resultado contradiz o livro', async () => {
  // a decisão não é publicada (disco cheio) ⇒ INTENT aberta; a recuperação a ABORTA; um resultado selado cita a cabeça (o ABORTED)
  const failingDecisions = faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w = await ledgerWorld({ decisionsFs: failingDecisions });
  const e = resultsEnv();
  const failed = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock());
  assert.ok(!failed.ok);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT']);
  const stale = servicesOver(w, e, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }) });
  await must(stale.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, '2026-10-21T13:00:00.000Z'));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'ABORTED']);
  const run = await sealResult(w, e);
  assert.equal(run.ledgerHead?.ledgerSeq, 3, 'o resultado cita o ABORTED');

  dropCitedHead(w, 3);
  const before = trees(w, e);
  const later = servicesOver(w, e, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }) });
  const view = await must(later.list(BIA, w.auditId, '2026-10-21T14:00:00.000Z'));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.recoverable], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', false]);
  const recover = await later.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, '2026-10-21T14:00:00.000Z');
  assert.ok(!recover.ok, 'não se aborta de novo uma INTENT contra uma testemunha que a contradiz');
  const write = await later.create(ANA, w.auditId, { record: rec.c2(), expectedHead: view.head }, '2026-10-21T14:00:00.000Z');
  assert.ok(!write.ok && write.code === 'DECISIONS_HISTORY_UNRESOLVED', JSON.stringify(write).slice(0, 200));
  assert.deepEqual(trees(w, e), before, 'nenhum registro novo no livro');
});

test('M29 (recuperação de PENDÊNCIA): decisão pendente (sem recibo) quando o livro perde a cabeça citada — o reenvio do autor e a conclusão por outro operador são recusados e o recibo NÃO é gravado', async () => {
  const { w, e, run } = await sealedWorld();
  const cited = run.ledgerHead?.ledgerSeq as number;
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(w.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const flaky = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witnessOver(w, e), fs: noReceipts });
  const head = (await must(flaky.list(ANA, w.auditId, clock()))).head;
  const pending = await flaky.create(ANA, w.auditId, { record: rec.c3(), expectedHead: head }, clock());
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING', JSON.stringify(pending).slice(0, 200));
  assert.ok(fs.existsSync(entryPath(w, 2)) && !fs.existsSync(anchorPath(w, 2)), 'decisão 2 publicada, recibo ausente');
  // R1.5: o resultado é gravado PELO LIVRO (RUN_INTENT + RUN_CONFIRMED, posições 4 e 5); sem o par ele seria UNLEDGERED_RESULT
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_CONFIRMED', 'INTENT'], 'a segunda operação está aberta no livro');

  // o livro perde a cabeça citada pelo resultado E tudo o que veio depois, inclusive a INTENT da pendência (quem escreve só no livro)
  fs.rmSync(ledgerPath(w, cited + 3));
  dropCitedHead(w, cited);
  const before = trees(w, e);
  const service = servicesOver(w, e);
  const view = await must(service.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.recoverable, view.decisions.length], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', false, 0]);
  const resend = await service.create(ANA, w.auditId, { record: rec.c3(), expectedHead: head }, clock());
  assert.ok(!resend.ok && resend.code === 'DECISIONS_HISTORY_UNRESOLVED', `o autor reenvia o MESMO pedido: ${JSON.stringify(resend).slice(0, 200)}`);
  const other = await service.create(BIA, w.auditId, { record: rec.c3(), expectedHead: head }, clock());
  assert.ok(!other.ok, 'outro operador também é recusado');
  assert.ok(!fs.existsSync(anchorPath(w, 2)), 'o recibo da pendência NÃO foi gravado (conclusão recusada)');
  assert.deepEqual(trees(w, e), before);
});

test('M29 (CONCORRÊNCIA entre processos): 4 processos tentam gravar, revogar-via-criação e recuperar ao mesmo tempo contra o desacordo — todos recusados, nenhum arquivo muda', async () => {
  const { w, e, run } = await sealedWorld();
  await driftAfterSeal(w);
  dropCitedHead(w, run.ledgerHead?.ledgerSeq as number);
  const before = trees(w, e);
  const outcomes = await Promise.all([
    runChild(w, e, { task: 'create', actor: 'ana@empresa.com' }),
    runChild(w, e, { task: 'recover', actor: 'bia@empresa.com' }),
    runChild(w, e, { task: 'create', actor: 'bia@empresa.com' }),
    runChild(w, e, { task: 'recover', actor: 'ana@empresa.com' }),
  ]);
  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(outcome.status, 0, `processo ${index}: ${outcome.stderr.slice(0, 200)}`);
    assert.equal(outcome.line?.ok, false, `processo ${index}: ${JSON.stringify(outcome.line)}`);
  }
  assert.deepEqual(trees(w, e), before, 'nenhum processo gravou nada');
});

test('M29 (API das decisões, prévia e finalização pelas ROTAS reais): GET, POST, revogação, RECOVER, prévia e finalização respondem bloqueio explícito e nada é gravado', async () => {
  const env = process.env as Record<string, string | undefined>;
  const SECRET = 'service-role-key-de-teste-0123456789';
  const { w, e, run } = await sealedWorld();
  await driftAfterSeal(w);
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = Array.from({ length: 30 }, (_, i) => `m29op${i}@empresa.com`).join(',');
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_EVIDENCE_DIR = w.evidenceDir;
  env.GMN_LINK_AUDIT_DECISIONS_DIR = w.decisionsDir;
  env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR = w.anchorDir;
  env.GMN_LINK_AUDIT_RESULTS_DIR = e.base;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = e.anchors;
  applyLedgerEnv(env, w);
  await proveEvidenceForRoutes(env, w);
  let n = 0;
  const fresh = async (): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(`m29op${n++}@empresa.com`, SECRET)}`;
  const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
  const req = (url: string, cookie: string, method = 'GET', body?: unknown): Request =>
    new Request(`http://app.local${url}`, { method, headers: { host: 'app.local', cookie, ...(body !== undefined ? { 'content-type': 'application/json', origin: 'http://app.local' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = async (r: Response): Promise<any> => r.json();
  const a = w.auditId;

  const controlList = await json(await listRoute(req(`/api/link-audit/decisions/${a}`, await fresh()), ctx(a)));
  const controlPreview = await json(await previewRoute(req(`/api/link-audit/scoring/${a}`, await fresh()), ctx(a)));
  assert.deepEqual([controlList.ledger.state, controlList.decisions.length], ['PROTECTED', 2], 'controle (rota): íntegro');
  assert.equal(controlPreview.finalization.allowed, true, `controle (rota): a prévia permite finalizar ${JSON.stringify(controlPreview.blockers?.map((b: { code: string }) => b.code))}`);

  dropCitedHead(w, run.ledgerHead?.ledgerSeq as number);
  const before = trees(w, e);
  const list = await listRoute(req(`/api/link-audit/decisions/${a}`, await fresh()), ctx(a));
  const listBody = await json(list);
  assert.equal(list.status, 200);
  assert.deepEqual([listBody.ledger.state, listBody.ledger.reason, listBody.ledger.recoverable, listBody.decisions.length, listBody.finalizable], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', false, 0, false]);
  const create = await createRoute(req(`/api/link-audit/decisions/${a}`, await fresh(), 'POST', { record: rec.naFeature(), expectedHead: listBody.head }), ctx(a));
  assert.deepEqual([create.status, (await json(create)).code], [409, 'DECISIONS_HISTORY_UNRESOLVED']);
  const revoke = await revokeRoute(req(`/api/link-audit/decisions/${a}/revocations`, await fresh(), 'POST', { revokes: 'op-0001', reason: REASON, expectedHead: listBody.head }), ctx(a));
  assert.deepEqual([revoke.status, (await json(revoke)).code], [409, 'DECISIONS_HISTORY_UNRESOLVED']);
  const recover = await ledgerRoute(req(`/api/link-audit/decisions/${a}/ledger`, await fresh(), 'POST', { action: 'RECOVER' }), ctx(a));
  assert.ok(recover.status >= 400 && recover.status < 500, `RECOVER ⇒ ${recover.status}`);
  const preview = await json(await previewRoute(req(`/api/link-audit/scoring/${a}`, await fresh()), ctx(a)));
  assert.equal(preview.finalization.allowed, false);
  assert.ok(preview.blockers.some((b: { code: string; reasonCode: string }) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.reasonCode === 'RESULT_LEDGER_MISMATCH'));
  const finalize = await finalizeRoute(req(`/api/link-audit/scoring/${a}/finalize`, await fresh(), 'POST', { expectedHead: preview.finalization.expectedHead, expectedInputSha256: preview.finalization.expectedInputSha256 }), ctx(a)); // o pedido que a PRÉVIA deste estado oferece
  assert.deepEqual([finalize.status, (await json(finalize)).code], [409, 'NOT_FINALIZABLE']);
  assert.deepEqual(trees(w, e), before, 'nenhuma rota gravou algo');
});
