import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BIA, clock, must, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { ledgerRecords } from './helpers/link-audit-ledger-fixtures';
import { servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { AGED_OTHERS, bodyNow, everyResultHasIntent, finalizerOver, footprintOf, protectedWorld, runsOf, spawnChild } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { OP_A, OP_B, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import type { LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * R1.3 — RL-19: VARREDURA DE SIGKILL (processo real) antes e depois de cada passo 5–11 da finalização pelo livro (spec §16.17.3). Para cada ponto: o que sobra no disco, o que um
 * leitor vê (sempre PROTECTED), a INVARIANTE "nunca resultado sem RUN_INTENT" (`UNLEDGERED_RESULT` impossível: o RUN_INTENT é durável antes de `sk` existir) e a recuperação:
 *  - antes do RUN_INTENT (passo 5 e 6 antes do link): nada no livro ⇒ o reenvio do autor conclui exatamente um resultado;
 *  - fase A (RUN_INTENT sem `sk`): vencida, o reenvio do autor aborta (RUN_ABORTED) e conclui exatamente um resultado;
 *  - fases B e C (`sk` publicado, RUN_CONFIRMED ausente): a operação fica aberta e PROTECTED; OUTRO operador recebe RESULT_PENDING_UNCONFIRMED e nada é gravado; o reenvio do
 *    AUTOR conclui exatamente um resultado (R1.4, §16.17.4: na R1.3 ninguém concluía e este teste fixava a recusa também para o autor);
 *  - depois do RUN_CONFIRMED: o reenvio é 200 `replayed`, sem duplicar.
 */
registerCleanup();

type After = 'NOTHING' | 'A' | 'B' | 'C' | 'CONFIRMED';
interface Point {
  readonly label: string;
  readonly crash: (w: LedgerWorld, e: ResultsEnv) => { at: string; match: string };
  readonly after: After;
}
const ledgerFile = (w: LedgerWorld, seq: number): string => `/${w.auditId}/l${String(seq).padStart(6, '0')}.json`;
const runFile = (e: ResultsEnv, w: LedgerWorld): string => path.join(e.base, w.auditId, 's0001.json');
const receiptFile = (e: ResultsEnv, w: LedgerWorld): string => path.join(e.anchors, w.auditId, 'a0001.json');

const POINTS: readonly Point[] = [
  { label: 'passo 5, antes do fsync da raiz de resultados', crash: (_w, e) => ({ at: 'sync-before', match: e.base }), after: 'NOTHING' },
  { label: 'passo 5, depois do fsync da raiz de recibos (fim do passo 5)', crash: (_w, e) => ({ at: 'sync-after', match: e.anchors }), after: 'NOTHING' },
  { label: 'passo 6, antes do link do RUN_INTENT', crash: (w) => ({ at: 'before', match: ledgerFile(w, 4) }), after: 'NOTHING' },
  { label: 'passo 6, depois do link do RUN_INTENT', crash: (w) => ({ at: 'after', match: ledgerFile(w, 4) }), after: 'A' },
  { label: 'passo 7, antes do link do resultado', crash: (w, e) => ({ at: 'before', match: runFile(e, w) }), after: 'A' },
  { label: 'passo 7, depois do link do resultado', crash: (w, e) => ({ at: 'after', match: runFile(e, w) }), after: 'B' },
  { label: 'passo 8, depois do fsync da pasta de resultados da auditoria', crash: (w, e) => ({ at: 'sync-after', match: path.join(e.base, w.auditId) }), after: 'B' },
  { label: 'passo 9, antes do link do recibo', crash: (w, e) => ({ at: 'before', match: receiptFile(e, w) }), after: 'B' },
  { label: 'passo 9, depois do link do recibo', crash: (w, e) => ({ at: 'after', match: receiptFile(e, w) }), after: 'C' },
  { label: 'passo 10, depois do fsync da pasta de recibos da auditoria', crash: (w, e) => ({ at: 'sync-after', match: path.join(e.anchors, w.auditId) }), after: 'C' },
  { label: 'passo 11, antes do link do RUN_CONFIRMED', crash: (w) => ({ at: 'before', match: ledgerFile(w, 5) }), after: 'C' },
  { label: 'passo 11, depois do link do RUN_CONFIRMED', crash: (w) => ({ at: 'after', match: ledgerFile(w, 5) }), after: 'CONFIRMED' },
];
const BASE = ['GENESIS', 'INTENT', 'CONFIRMED'];
const EVENTS: Readonly<Record<After, readonly string[]>> = { NOTHING: BASE, A: [...BASE, 'RUN_INTENT'], B: [...BASE, 'RUN_INTENT'], C: [...BASE, 'RUN_INTENT'], CONFIRMED: [...BASE, 'RUN_INTENT', 'RUN_CONFIRMED'] };

for (const point of POINTS) {
  test(`RL-19: SIGKILL ${point.label} — o que sobra, PROTECTED, nunca resultado sem RUN_INTENT e a recuperação sem duplicar`, async () => {
    const { w, e } = await protectedWorld();
    const body = await bodyNow(finalizerOver(w, e), OP_A, w.auditId);
    const child = await spawnChild(w, e, { task: 'finalize', withPort: true, crash: point.crash(w, e) });
    assert.ok(child.killed, `o filho tem de morrer por SIGKILL (status ${child.status}, linha ${JSON.stringify(child.line)}, ${child.stderr.slice(0, 200)})`);

    // 1) o que sobrou
    const records = await ledgerRecords(w);
    assert.deepEqual(records.map((r) => r.event), EVENTS[point.after], 'livro');
    const published = { run: fs.existsSync(runFile(e, w)), receipt: fs.existsSync(receiptFile(e, w)) };
    assert.deepEqual(published, { run: ['B', 'C', 'CONFIRMED'].includes(point.after), receipt: ['C', 'CONFIRMED'].includes(point.after) }, 'resultado e recibo');
    const { all } = await runsOf(e, w.auditId);
    assert.ok(everyResultHasIntent(records, all), 'INVARIANTE: nenhum resultado sem o seu RUN_INTENT (nunca UNLEDGERED_RESULT)');

    // 2) o que um leitor vê (reinício / outro processo)
    const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.equal(view.ledger.state, 'PROTECTED');
    assert.equal(view.ledger.runs?.open?.phase ?? null, ['A', 'B', 'C'].includes(point.after) ? point.after : null, 'fase da operação de resultado aberta');

    // 3) recuperação
    if (point.after === 'B' || point.after === 'C') {
      const before = await footprintOf(w, e);
      const other = await finalizerOver(w, e, { ledger: AGED_OTHERS }).results.finalize(OP_B, w.auditId, body);
      assert.ok(!other.ok && other.code === 'RESULT_PENDING_UNCONFIRMED', `${OP_B.email}: ${JSON.stringify(other).slice(0, 240)}`);
      assert.deepEqual(await footprintOf(w, e), before, 'outro operador nunca conclui; nada gravado');
    }
    const again = await finalizerOver(w, e, { ledger: AGED_OTHERS }).results.finalize(OP_A, w.auditId, body);
    assert.ok(again.ok, JSON.stringify(again).slice(0, 240));
    assert.equal(again.value.replayed, point.after === 'CONFIRMED' || point.after === 'B' || point.after === 'C', 'B/C: o reenvio do autor conclui a pendente (replayed + recoveredPending)');
    assert.equal(again.value.recoveredPending, point.after === 'B' || point.after === 'C');
    const final = await ledgerRecords(w);
    const expected = point.after === 'A' ? [...BASE, 'RUN_INTENT', 'RUN_ABORTED', 'RUN_INTENT', 'RUN_CONFIRMED'] : [...BASE, 'RUN_INTENT', 'RUN_CONFIRMED'];
    assert.deepEqual(final.map((r) => r.event), expected, 'exatamente um par confirmado (o abortado não conta)');
    const after = await runsOf(e, w.auditId);
    assert.deepEqual([after.all.length, after.runs.length, after.pending], [1, 1, null], 'exatamente um resultado');
    assert.ok(everyResultHasIntent(final, after.all));
    const reread = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.deepEqual([reread.ledger.state, reread.ledger.runs?.open, reread.ledger.runs?.confirmed.length], ['PROTECTED', null, 1]);
  });
}
