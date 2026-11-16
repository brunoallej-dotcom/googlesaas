import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { keyEpochViolation, publishLedgerRecord, verifyTags, type LedgerRecord } from '../src/lib/link-audit-ledger';
import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import { WITNESS_NOT_REQUIRED } from '../src/lib/link-audit-decisions/witness';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, anchorPath, clock, entryPath, must, rec, registerCleanup, world } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, isoAt, ledgerAuth, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_KEY_A, LEDGER_KEY_B, makeRecord, NO_RESULTS, refOf, syntheticLedger } from './helpers/link-audit-ledger-fixtures';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';

/*
 * R6-04, R6-06 e R6-07 (revisão independente nº 6): defeitos/limites que o revisor apontou, com TESTE ANTES da correção e controle em cada caso.
 */
registerCleanup();
const AUD = 'auditoria-teste-0001';
const at = (iso: string) => () => new Date(iso);
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';

/* ============================================================================ R6-04 — fase C com dono VIVO */

test('R6-04: o dono entre o recibo e o CONFIRMED NÃO recebe erro falso quando OUTRO processo conclui o MESMO CONFIRMED antes; a decisão está confirmada e a resposta é de sucesso', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const slowOwner = faulty({
    async link(from, to) {
      if (to.endsWith('l000003.json') && !paused) {
        paused = true;
        await gate; // o dono dorme ANTES de publicar o CONFIRMED (entrada e recibo já existem)
      }
      return nodeFsOps.link(from, to);
    },
  });
  const w = await ledgerWorld({ ledgerFs: slowOwner });
  const head = (await must(w.rawProtected.list(ANA, w.auditId))).head;
  const owner = w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: head }, clock());
  // espera o dono chegar ao ponto (entrada e recibo publicados, CONFIRMED pendente)
  for (let i = 0; i < 200 && !(paused && fs.existsSync(entryPath(w, 1)) && fs.existsSync(anchorPath(w, 1))); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(paused && fs.existsSync(entryPath(w, 1)) && fs.existsSync(anchorPath(w, 1)), 'o dono parou entre o recibo e o CONFIRMED');
  // OUTRO PROCESSO do MESMO autor (ana) vê a fase C e conclui o CONFIRMED (§16.16: outro AUTOR não concluiria mais)
  const rescuer = await runChild(w, null, { task: 'recover', actor: 'ana@empresa.com' });
  assert.equal(rescuer.status, 0, rescuer.stderr.slice(0, 200));
  assert.equal(rescuer.line?.ok, true, JSON.stringify(rescuer.line));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'o outro processo já concluiu');
  release();
  const result = await owner;
  assert.ok(result.ok, `o dono recebe SUCESSO (a operação está confirmada): ${JSON.stringify(result).slice(0, 220)}`);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'nenhum registro duplicado');
  const records = await ledgerRecords(w);
  assert.equal(records[2]?.actor, 'ana@empresa.com', '§16.16: o CONFIRMED da fase C é sempre gravado pelo próprio autor (o actor coincide com `op.author`)');
  assert.equal(records[2]?.op?.author, 'ana@empresa.com');
  const view = await must(w.rawProtected.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.decisions.length, view.finalizable], ['PROTECTED', 1, true]);
});

test('R6-04 (controle): o dono lento (dorme ANTES de publicar a entrada) tem a INTENT abortada por OUTRO processo; ao acordar não recebe sucesso e a auditoria falha fechada (PUBLISHED_AFTER_ABORT)', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const w0 = await ledgerWorld({
    decisionsFs: faulty({
      async link(from, to) {
        if (to.endsWith('d0001.json') && !paused) {
          paused = true;
          await gate; // a INTENT já está no livro; a entrada ainda não existe
        }
        return nodeFsOps.link(from, to);
      },
    }),
  });
  const head = (await must(w0.rawProtected.list(ANA, w0.auditId))).head;
  const owner = w0.rawProtected.create(ANA, w0.auditId, { record: rec.c2(), expectedHead: head }, clock());
  for (let i = 0; i < 200 && !paused; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(paused);
  assert.deepEqual(await ledgerEvents(w0), ['GENESIS', 'INTENT']);
  // OUTRO PROCESSO reconhece a INTENT como vencida (fase A: sem entrada nem recibo) e a ABORTA
  const aborter = await runChild(w0, null, { task: 'recover', actor: 'bia@empresa.com', staleOperationMs: 1, nowIso: '2026-12-01T00:00:00.000Z' });
  assert.equal(aborter.line?.ok, true, JSON.stringify(aborter.line) + aborter.stderr.slice(0, 200));
  assert.deepEqual(await ledgerEvents(w0), ['GENESIS', 'INTENT', 'ABORTED']);
  release();
  const result = await owner;
  assert.ok(!result.ok, `o dono NÃO pode receber sucesso: a operação dele foi abortada ${JSON.stringify(result).slice(0, 160)}`);
  assert.deepEqual(await ledgerEvents(w0), ['GENESIS', 'INTENT', 'ABORTED'], 'nenhum CONFIRMED fabricado');
  const view = await must(w0.rawProtected.list(BIA, w0.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions.length, view.finalizable], ['HISTORY_UNRESOLVED', 'PUBLISHED_AFTER_ABORT', 0, false]);
});

/* ============================================================================ R6-06 — época de chave */

const K1 = () => ledgerAuth(LEDGER_KEY_A);
const rotated = (now: string, retiredUntil = '2026-12-02') => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:${retiredUntil}`], now: at(now) });
/** Cadeia legítima: GENESIS+operação pela chave A, depois o CHECKPOINT e uma operação pela chave B (a rotação planejada já aconteceu). */
function rotatedChain(): LedgerRecord[] {
  const refs = [refOf(1, null, 'x')];
  const old = syntheticLedger(K1(), AUD, refs);
  const tail = old[old.length - 1] as LedgerRecord;
  const keyB = ledgerAuth(LEDGER_KEY_B);
  const checkpoint = makeRecord(keyB, AUD, tail, { event: 'CHECKPOINT', recordedAt: isoAt(100), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
  return [...old, checkpoint];
}
const forgeWith = (auth: ReturnType<typeof ledgerAuth>, chain: readonly LedgerRecord[], draft: Record<string, unknown>): LedgerRecord => makeRecord(auth, AUD, chain[chain.length - 1] as LedgerRecord, draft as never);

test('R6-06: depois que a chave NOVA assinou, a aposentada (ainda válida) NÃO autentica mais nenhum registro — nenhum tipo de evento, mesmo com data retroativa', () => {
  const chain = rotatedChain();
  const auth = rotated('2026-11-02T12:00:00Z');
  assert.equal(verifyTags(chain, auth), null, 'controle: a cadeia legítima da rotação verifica');
  const tail = chain[chain.length - 1] as LedgerRecord;
  const old = syntheticLedger(K1(), AUD, [refOf(1, null, 'x')]);
  const op = { ...(old[1]?.op as NonNullable<LedgerRecord['op']>) };
  const drafts: Array<[string, Record<string, unknown>]> = [
    ['INTENT', { event: 'INTENT', recordedAt: isoAt(200), actor: 'ana@empresa.com', op: { ...op, decisionSeq: 2, opId: 'b'.repeat(32) } }],
    ['CONFIRMED', { event: 'CONFIRMED', recordedAt: isoAt(200), actor: 'ana@empresa.com', op: { ...op, intentSeq: 2, anchorRef: { name: 'a0001.json', headSha256: op.newDecisionsHead.sha256 } } }],
    ['ABORTED', { event: 'ABORTED', recordedAt: isoAt(200), actor: 'system', op: { ...op, intentSeq: 2, observed: { entryPresent: false, receiptPresent: false, ageMs: 1 } } }],
    ['CHECKPOINT', { event: 'CHECKPOINT', recordedAt: isoAt(200), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } }],
    // RETRODATADO: a hora declarada é ANTERIOR à rotação — a hora é de quem forja e NÃO é a referência; a posição na cadeia é
    ['CHECKPOINT retrodatado', { event: 'CHECKPOINT', recordedAt: isoAt(-86_400), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } }],
  ];
  for (const [label, draft] of drafts) {
    const forged = forgeWith(K1(), chain, draft);
    const failure = verifyTags([...chain, forged], auth);
    assert.deepEqual(failure, { reason: 'UNTRUSTED', seq: chain.length + 1 }, `${label}: registro novo assinado pela aposentada`);
  }
  // a mesma ideia sem a rotação planejada: depois de A, B, A (qualquer volta) a cadeia é suspeita
  assert.deepEqual(keyEpochViolation([...chain, forgeWith(K1(), chain, drafts[3]?.[1] as Record<string, unknown>)], 'lk-test-b'), { reason: 'UNTRUSTED', seq: chain.length + 1 });
});

test('R6-06: a época é a ORDEM da cadeia, não a validade da chave — o registro da aposentada ANTES da rotação continua válido (e coberto depois do vencimento), o de DEPOIS nunca', () => {
  const chain = rotatedChain();
  assert.equal(verifyTags(chain, rotated('2026-11-02T12:00:00Z')), null);
  assert.equal(verifyTags(chain, rotated('2026-12-20T12:00:00Z')), null, 'vencida a aposentada, o CHECKPOINT da chave nova cobre o que ela assinou antes');
  assert.equal(verifyTags(chain, ledgerAuth(LEDGER_KEY_B)), null, 'e ela pode sair da configuração');
  const forged = forgeWith(K1(), chain, { event: 'CHECKPOINT', recordedAt: isoAt(300), actor: 'system', checkpoint: { throughSeq: chain.length, throughSha256: (chain[chain.length - 1] as LedgerRecord).contentSha256 } });
  assert.ok(['UNTRUSTED', 'KEY_EXPIRED'].includes(verifyTags([...chain, forged], rotated('2026-12-20T12:00:00Z'))?.reason ?? ''), 'o forjado de DEPOIS nunca é aceito (vencida a chave, nem o vencimento nem o CHECKPOINT o salvam)');
});

test('R6-06 (serviço): reverter para a chave antiga depois de a nova ter assinado deixa a auditoria NÃO resolvida e nada é gravado (sem segunda linha de assinatura)', async () => {
  const w = await ledgerWorld({ enroll: false });
  const svcA = decisionsOver(w, { ledger: ledgerFor(w, { auth: K1(), guard: null }), knownHeads: NO_RESULTS });
  await must(svcA.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock));
  await must(svcA.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  const svcB = decisionsOver(w, { ledger: ledgerFor(w, { auth: rotated('2026-11-02T12:00:00Z'), guard: null }), knownHeads: NO_RESULTS });
  await must(svcB.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: (await must(svcB.list(ANA, w.auditId, clock()))).head }, clock));
  const kids = (await ledgerRecords(w)).map((r) => r.origin.kid);
  assert.deepEqual([...new Set(kids)], ['lk-test-a', 'lk-test-b']);
  // configuração revertida: A é a atual de novo e B é só aposentada
  const reverted = decisionsOver(w, { ledger: ledgerFor(w, { auth: ledgerAuth({ current: LEDGER_KEY_A, retired: [`${LEDGER_KEY_B}:2026-12-02`], now: at('2026-11-03T12:00:00Z') }), guard: null }), knownHeads: NO_RESULTS });
  const before = (await ledgerRecords(w)).length;
  const view = await must(reverted.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions.length, view.finalizable], ['HISTORY_UNRESOLVED', 'UNTRUSTED', 0, false]);
  const write = await reverted.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!write.ok);
  assert.equal((await ledgerRecords(w)).length, before, 'nada foi anexado pela chave revertida');
});

test('R6-06 — JANELA RESIDUAL (travada em teste): entre a rotação e o PRIMEIRO registro da chave nova, quem tem a chave antiga e escrita no livro anexa registros que o sistema aceita; o CHECKPOINT da chave nova os cobre e, depois dele, a antiga fica inutilizável', async () => {
  const w = await ledgerWorld({ enroll: false });
  const svcA = decisionsOver(w, { ledger: ledgerFor(w, { auth: K1(), guard: null }), knownHeads: NO_RESULTS });
  await must(svcA.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock));
  const authB = rotated('2026-11-02T12:00:00Z');
  const svcB = decisionsOver(w, { ledger: ledgerFor(w, { auth: authB, guard: null }), knownHeads: NO_RESULTS });
  // rotação feita, NENHUMA operação ainda: a chave antiga forja um CHECKPOINT (inofensivo, mas prova a janela)
  const recs = await ledgerRecords(w);
  const tail = recs[recs.length - 1] as LedgerRecord;
  const forged = makeRecord(K1(), w.auditId, tail, { event: 'CHECKPOINT', recordedAt: isoAt(5000), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
  assert.ok((await publishLedgerRecord(w.ledgerDir, forged)).ok);
  const during = await must(svcB.list(BIA, w.auditId, clock()));
  assert.equal(during.ledger.state, 'PROTECTED', 'LIMITE DECLARADO: a janela existe até a primeira operação da chave nova');
  // a primeira operação da chave nova grava o CHECKPOINT dela (cobrindo o que veio antes) e fecha a janela
  await must(svcB.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  const events = (await ledgerRecords(w)).map((r) => `${r.event}:${r.origin.kid}`);
  assert.ok(events.includes('CHECKPOINT:lk-test-b'), events.join());
  const late = makeRecord(K1(), w.auditId, (await ledgerRecords(w)).at(-1) as LedgerRecord, { event: 'CHECKPOINT', recordedAt: isoAt(9000), actor: 'system', checkpoint: { throughSeq: 1, throughSha256: (await ledgerRecords(w))[0]?.contentSha256 } } as never);
  assert.ok((await publishLedgerRecord(w.ledgerDir, late)).ok);
  const after = await must(svcB.list(BIA, w.auditId, clock()));
  assert.deepEqual([after.ledger.state, after.ledger.reason], ['HISTORY_UNRESOLVED', 'UNTRUSTED'], 'depois da chave nova a antiga não anexa mais nada');
});

/* ============================================================================ R6-07 — fsync de diretório */

const syncFails = (match: (dir: string) => boolean, code = 'EIO') =>
  faulty({
    async syncDirectory(dir) {
      if (match(dir)) throw errno(code);
      return nodeFsOps.syncDirectory(dir);
    },
  });

test('R6-07 (livro): se o fsync do diretório do livro falha, a gravação NÃO devolve sucesso, a base trava e a resposta não cita caminhos — em EIO e em sistema de arquivos que não suporta (EINVAL)', async () => {
  for (const code of ['EIO', 'EINVAL', 'ENOTSUP']) {
    const w = await ledgerWorld({ enroll: false, ledgerFs: syncFails(() => true, code) });
    const enroll = await w.rawProtected.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock);
    assert.ok(!enroll.ok, `${code}: inscrever sem durabilidade comprovada NÃO é sucesso`);
    const text = JSON.stringify(enroll);
    assert.ok(/durabilidade/i.test(text), `${code}: a resposta diz o motivo ${text.slice(0, 200)}`);
    for (const leak of [w.ledgerDir, 'l000001', '/tmp/']) assert.ok(!text.includes(leak), `${code}: vazou "${leak}"`);
    // a base está travada: nem uma nova tentativa nem outra escrita passa
    const again = await w.rawProtected.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock);
    assert.ok(!again.ok, `${code}: base travada`);
  }
});

test('R6-07 (decisões e recibos com o livro): fsync de diretório falhando na pasta das DECISÕES ou dos RECIBOS ⇒ nenhum sucesso, nada no livro além da INTENT, e depois de "reiniciar" com disco saudável o MESMO pedido conclui', async () => {
  for (const [label, pick] of [['decisões', (w: { decisionsDir: string }) => w.decisionsDir], ['recibos', (w: { anchorDir: string }) => w.anchorDir]] as const) {
    const w0 = await ledgerWorld(); // só para obter as pastas
    const failing = decisionsOver(w0, { ledger: ledgerFor(w0, { guard: null }), knownHeads: NO_RESULTS, fs: syncFails((dir) => dir.startsWith(pick(w0)), 'EIO') });
    const head = (await must(failing.list(ANA, w0.auditId, clock()))).head;
    const body = { record: rec.c2(), expectedHead: head };
    const failed = await failing.create(ANA, w0.auditId, body, clock());
    assert.ok(!failed.ok, `${label}: sem durabilidade comprovada não há sucesso (${JSON.stringify(failed).slice(0, 160)})`);
    assert.equal(failed.code, 'DECISIONS_DURABILITY_UNKNOWN', `${label}: durabilidade DESCONHECIDA é um resultado próprio`);
    const events = await ledgerEvents(w0);
    assert.ok(!events.includes('CONFIRMED'), `${label}: o livro não confirmou nada (${events.join()})`);
    // a base está travada neste processo
    const blocked = await failing.create(ANA, w0.auditId, body, clock());
    assert.ok(!blocked.ok, `${label}: ${JSON.stringify(blocked).slice(0, 160)}`);
    // "reinício" (a trava é do processo) com disco saudável: o mesmo pedido conclui, sem duplicar
    clearStorageFatal(w0.decisionsDir);
    clearStorageFatal(w0.anchorDir);
    const healthy = decisionsOver(w0, { ledger: ledgerFor(w0, { guard: null, staleOperationMs: 1 }), knownHeads: NO_RESULTS });
    const concluded = await healthy.create(ANA, w0.auditId, body, clock());
    assert.ok(concluded.ok, `${label}: depois do reinício ${JSON.stringify(concluded).slice(0, 200)}`);
    const view = await must(healthy.list(BIA, w0.auditId));
    assert.deepEqual([view.ledger.state, view.decisions.length, view.history.length], ['PROTECTED', 1, 1], `${label}: uma decisão, sem duplicata`);
  }
});

test('R6-07 — LIMITE TRAVADO: SEM o livro (6B isolada) o fsync de diretório segue melhor-esforço (risco P-4 histórico, sem aceite): a gravação é dada como feita', async () => {
  const w = await world();
  const isolated = decisionsOver(w, { ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, fs: syncFails(() => true, 'EIO') });
  const result = await isolated.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(result.ok, 'documentado: sem livro a 6B não observa o fsync de diretório');
});

/* R7-09 (INTENT com hora gravada no FUTURO) deixou de ser limite declarado: está corrigido e provado em `link-audit-ledger-clock.test.ts`. */
