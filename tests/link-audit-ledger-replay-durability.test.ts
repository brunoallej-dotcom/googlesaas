import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BIA, clock, must, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';

/*
 * R7-04 (resíduo) — REENVIO IDEMPOTENTE de uma entrada que o livro JÁ confirmou. Cenário do revisor: o `CONFIRMED` é publicado no livro, mas o fsync da pasta do livro FALHA
 * (a resposta é "durabilidade desconhecida", a base trava); o servidor reinicia; o cliente reenvia o MESMO pedido. O registro EXISTE, então o reenvio é reconhecido como repetição —
 * mas "existe" não prova que sobreviveria a uma queda. O sucesso só pode vir DEPOIS de sincronizar de novo as três pastas (decisões, recibos, livro). Falhas por injeção em
 * processo FILHO real (reinício de verdade); nenhum armazenamento real é tocado.
 */
registerCleanup();
const read = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const dirsOf = (w: LedgerWorld) => ({ decisions: path.join(w.decisionsDir, w.auditId), anchors: path.join(w.anchorDir, w.auditId), ledger: path.join(w.ledgerDir, w.auditId) });

/** Mundo em que o `CONFIRMED` (l000003) existe, mas o fsync que o tornaria durável FALHOU num processo à parte. */
async function confirmedButUnsynced(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  const failed = await runChild(w, null, { task: 'create', failSync: 'ledger', failSyncWhenExists: 'l000003.json', actor: 'ana@empresa.com' });
  assert.equal(failed.line?.ok, false, `sem durabilidade comprovada NÃO é sucesso (${JSON.stringify(failed.line)} ${failed.stderr.slice(0, 160)})`);
  assert.equal(failed.line?.code, 'DECISIONS_DURABILITY_UNKNOWN');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'o registro existe (a durabilidade dele é que é desconhecida)');
  return w;
}

test('CONFIRMED com fsync do livro falho + reinício + reenvio: o reenvio só é sucesso depois de sincronizar de novo as pastas de decisões, recibos E livro — e não duplica nada', async () => {
  const w = await confirmedButUnsynced();
  const log = path.join(tmpDir('lad-replaylog-'), 'sync.log');
  const resent = await runChild(w, null, { task: 'create', resend: true, syncLog: log, actor: 'ana@empresa.com' });
  assert.equal(resent.line?.ok, true, `${JSON.stringify(resent.line)} ${resent.stderr.slice(0, 200)}`);
  const synced = read(log);
  for (const [name, dir] of Object.entries(dirsOf(w))) assert.ok(synced.includes(dir), `o reenvio sincronizou a pasta ${name} (log: ${synced.length} chamadas)`);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'nenhum registro novo: é só a confirmação de durabilidade');
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS }).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.decisions.length, view.history.length], ['PROTECTED', 1, 1], 'uma decisão, sem duplicata');
});

test('reenvio depois do reinício com o fsync AINDA falhando (livro, decisões ou recibos): continua NÃO sendo sucesso — a incerteza não é apagada por uma repetição', async () => {
  for (const folder of ['ledger', 'decisions', 'anchors'] as const) {
    const w = await confirmedButUnsynced();
    const resent = await runChild(w, null, { task: 'create', resend: true, failSync: folder, actor: 'ana@empresa.com' });
    assert.equal(resent.line?.ok, false, `${folder}: ${JSON.stringify(resent.line)}`);
    assert.equal(resent.line?.code, 'DECISIONS_DURABILITY_UNKNOWN', `${folder}: resultado próprio, nunca "ok"`);
    // e quando o disco volta a sincronizar, o MESMO pedido conclui
    const healthy = await runChild(w, null, { task: 'create', resend: true, actor: 'ana@empresa.com' });
    assert.equal(healthy.line?.ok, true, `${folder}: ${JSON.stringify(healthy.line)}`);
    assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], `${folder}: sem registro novo`);
  }
});

test('o reenvio de uma entrada confirmada com TUDO durável também sincroniza (barato e idempotente) e devolve sucesso sem gravar nada', async () => {
  const w = await ledgerWorld();
  const first = await runChild(w, null, { task: 'create', actor: 'ana@empresa.com' });
  assert.equal(first.line?.ok, true, JSON.stringify(first.line));
  const before = await ledgerEvents(w);
  const log = path.join(tmpDir('lad-replaylog2-'), 'sync.log');
  const again = await runChild(w, null, { task: 'create', resend: true, syncLog: log, actor: 'ana@empresa.com' });
  assert.equal(again.line?.ok, true, JSON.stringify(again.line));
  assert.deepEqual(await ledgerEvents(w), before);
  assert.ok(read(log).includes(dirsOf(w).ledger), 'sincronizou o livro');
});
