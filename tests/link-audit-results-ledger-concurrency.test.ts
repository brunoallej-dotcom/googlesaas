import assert from 'node:assert/strict';
import test from 'node:test';
import { replayLedger, verifyTags } from '../src/lib/link-audit-ledger';
import { BIA, clock, must, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { LEDGER_AUTH_A, ledgerRecords } from './helpers/link-audit-ledger-fixtures';
import { servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { everyResultHasIntent, intentsWellFormed, protectedWorld, runsOf, spawnChild } from './helpers/link-audit-results-ledger-finalize-fixtures';

/*
 * R1.3 — RL-15: DOIS OPERADORES, 2 a 5 PROCESSOS REAIS, o MESMO estado, largada sincronizada, todos finalizando PELA PORTA do livro. A exclusão entre processos vem só do
 * `link()` exclusivo de cada posição do livro e de `sNNNN`/`aNNNN` (nenhuma memória compartilhada). Prova: um único resultado; um único par RUN_INTENT/RUN_CONFIRMED; os
 * demais recebem 200 `replayed`, `RESULT_PENDING_UNCONFIRMED` (viram a operação aberta em B/C) ou `LEDGER_OPERATION_IN_PROGRESS` (esperaram o limite na fase A); nunca dois
 * RUN_INTENT do mesmo `runSeq` sem RUN_ABORTED entre eles; o livro final é autêntico e a auditoria continua PROTECTED. Timer de 120 s por filho.
 */
registerCleanup();
const ALLOWED_LOSERS = new Set(['RESULT_PENDING_UNCONFIRMED', 'LEDGER_OPERATION_IN_PROGRESS']);

for (const processes of [2, 3, 5]) {
  test(`RL-15: ${processes} processos (Ana e Bia alternados), mesmo estado ⇒ um resultado e um par RUN_INTENT/RUN_CONFIRMED; os demais: replayed, RESULT_PENDING_UNCONFIRMED ou LEDGER_OPERATION_IN_PROGRESS; final PROTECTED`, async () => {
    const { w, e } = await protectedWorld();
    const startAt = Date.now() + 1_500;
    const actors = Array.from({ length: processes }, (_, index) => (index % 2 === 0 ? 'ana@empresa.com' : 'bia@empresa.com'));
    const outcomes = await Promise.all(actors.map((actor, worker) => spawnChild(w, e, { task: 'finalize', withPort: true, actor, worker, startAt })));
    const lines = outcomes.map((outcome, index) => {
      assert.ok(outcome.line !== null && !outcome.killed, `processo ${index + 1} sem resposta (status ${outcome.status}, ${outcome.stderr.slice(0, 300)})`);
      return outcome.line;
    });
    const winners = lines.filter((line) => line.ok === true && line.replayed === false);
    const replayed = lines.filter((line) => line.ok === true && line.replayed === true);
    const losers = lines.filter((line) => line.ok !== true);
    assert.equal(winners.length, 1, `exatamente um vencedor: ${JSON.stringify(lines)}`);
    for (const line of replayed) assert.equal(line.seq, 1, JSON.stringify(line));
    for (const line of losers) assert.ok(ALLOWED_LOSERS.has(String(line.code)), `desfecho inesperado: ${JSON.stringify(line)}`);

    const records = await ledgerRecords(w);
    const events = records.map((record) => record.event);
    assert.deepEqual(events, ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_CONFIRMED'], 'um único par intent/fecho; nenhum RUN_ABORTED (ninguém venceu a fase A)');
    assert.ok(intentsWellFormed(records), 'nunca dois RUN_INTENT do mesmo runSeq sem RUN_ABORTED entre eles');
    assert.equal(verifyTags(records, LEDGER_AUTH_A), null, 'livro autêntico');
    assert.ok(replayLedger(records, w.auditId).ok, 'replay válido (I-1…I-6)');
    const { all, runs, pending } = await runsOf(e, w.auditId);
    assert.deepEqual([all.length, runs.length, pending], [1, 1, null], 'um único resultado, confirmado');
    assert.ok(everyResultHasIntent(records, all), 'todo resultado tem o seu RUN_INTENT');
    assert.equal(records[4]?.run?.runSha256, runs[0]?.contentSha256);
    assert.equal(records[4]?.actor, runs[0]?.finalizedBy, 'quem confirma é o autor do resultado');
    const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.ledger.runs?.open, view.ledger.runs?.confirmed.length], ['PROTECTED', null, 1]);
  });
}
