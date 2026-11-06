import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { KnownHeadsProvider } from '../src/lib/link-audit-decisions';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { ANA, BIA, clock, entryPath, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerPath, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { sealedWorld, sealResult, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R7-06 — RECOVER (e qualquer gravação de recuperação) com EVIDÊNCIA DESATUALIZADA. A testemunha é lida a cada tentativa e RELIDA imediatamente antes de cada gravação do livro,
 * DEPOIS da leitura do livro; a testemunha das DECISÕES (6B) não resolvida impede a recuperação. Se uma testemunha passa a contradizer o livro entre a leitura e a gravação, NADA é
 * gravado (o registro pendente é preservado e a recuperação segura continua possível depois). Aqui a testemunha é adulterada para devolver leituras velhas/mudadas, exatamente
 * como o revisor fez (a corrida de milissegundos é construída; ela não é reproduzível por sorte).
 */
registerCleanup();
const trees = (w: LedgerWorld, e: ResultsEnv) => ({ ledger: hashTree(w.ledgerDir), decisions: hashTree(w.decisionsDir), anchors: hashTree(w.anchorDir), results: hashTree(e.base), resultAnchors: hashTree(e.anchors) });

/** Testemunha que devolve `script[i]` na i-ésima chamada (e a leitura real depois do fim do roteiro); conta as chamadas. */
type Read = Awaited<ReturnType<KnownHeadsProvider>>;
function scripted(real: KnownHeadsProvider, script: ReadonlyArray<'real' | 'throw' | Read>) {
  let calls = 0;
  const provider: KnownHeadsProvider = async (auditId) => {
    const step = script[calls];
    calls += 1;
    if (step === undefined || step === 'real') return real(auditId);
    if (step === 'throw') throw new Error('falha simulada da testemunha');
    return step as Read;
  };
  return { provider, calls: () => calls };
}

/** Mundo: resultado r1 selado (cita 3); decisão 2 confirmada e resultado r2 selado (cita 5); o ATACANTE remove o CONFIRMED da decisão 2 (livro atrasado: parece recuperável). */
async function worldWithTailRemoved() {
  const { w, e } = await sealedWorld();
  const real = witnessOver(w, e);
  const stale = await real(w.auditId); // retrato de ANTES do segundo resultado
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
  const second = await sealResult(w, e);
  assert.equal(second.ledgerHead?.ledgerSeq, 5);
  fs.rmSync(ledgerPath(w, 5));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'INTENT']);
  return { w, e, real, stale };
}

test('TOCTOU construído: a testemunha entrega a leitura VELHA nas leituras iniciais; a releitura imediatamente antes da gravação enxerga o resultado que contradiz o livro ⇒ o RECOVER NÃO grava o CONFIRMED', async () => {
  const { w, e, real, stale } = await worldWithTailRemoved();
  const before = trees(w, e);
  const { provider, calls } = scripted(real, [stale, stale]); // leitura inicial do serviço + leitura do início da tentativa: velhas
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: provider });
  const done = await service.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!done.ok, `com evidência velha o RECOVER não pode gravar: ${JSON.stringify(done).slice(0, 200)}`);
  assert.equal(done.ok ? '' : done.code, 'DECISIONS_HISTORY_UNRESOLVED');
  assert.ok(calls() >= 3, `a testemunha foi relida antes de gravar (chamadas: ${calls()})`);
  assert.deepEqual(trees(w, e), before, 'nenhum arquivo mudou: o registro pendente (INTENT) foi PRESERVADO');
  // com a testemunha íntegra a leitura confirma o desacordo (a recuperação segura NUNCA foi destruída)
  const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: real }).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.recoverable], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', false]);
});

test('evidência MUDANDO DURANTE o RECOVER (a 3ª leitura traz o resultado que contradiz): recusa sem gravar; a mesma coisa para a criação e a revogação que tentam passar pela recuperação da fase C', async () => {
  const { w, e, real } = await worldWithTailRemoved();
  const truth = await real(w.auditId);
  const before = trees(w, e);
  // as duas primeiras leituras mostram "nenhum resultado cita o livro" (o retrato velho que o revisor usou); a terceira é a verdade
  const clean = { ...truth, ledgerHeads: [], unverifiedLedgerHeads: [] } as Read;
  for (const action of ['recover', 'create', 'revoke'] as const) {
    const { provider } = scripted(real, [clean, clean]);
    const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: provider });
    const head = (await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS }).list(BIA, w.auditId, clock()))).head;
    const result =
      action === 'recover'
        ? await service.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock())
        : action === 'create'
          ? await service.create(ANA, w.auditId, { record: rec.naFeature(), expectedHead: head }, clock)
          : await service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: head }, clock);
    assert.ok(!result.ok, `${action}: ${JSON.stringify(result).slice(0, 160)}`);
    assert.deepEqual(trees(w, e), before, `${action}: nada gravado`);
  }
});

test('mudança BENIGNA durante o RECOVER (a releitura traz mais evidência, mas nenhuma contradiz o livro) NÃO bloqueia a recuperação legítima; releitura que FALHA bloqueia', async () => {
  // fase C legítima: o CONFIRMED não chegou a ser gravado; nenhum resultado cita nada além do que o livro tem
  let failConfirmed = true;
  const ledgerFs = faulty({ async writeExclusive(target, data, mode) { if (failConfirmed && target.includes('l000003.json')) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const w = await ledgerWorld({ ledgerFs });
  const e = resultsEnv();
  assert.ok(!(await w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock())).ok);
  failConfirmed = false;
  const real = witnessOver(w, e);
  const benign = scripted(real, ['real', 'real', { ok: true, heads: [], unverifiedHeads: [], hasResults: true, ledgerHeads: [], unverifiedLedgerHeads: [] } as Read]);
  const healthy = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: benign.provider });
  const done = await healthy.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(done.ok, `evidência nova e consistente não impede a recuperação: ${JSON.stringify(done).slice(0, 200)}`);
  assert.equal((await ledgerEvents(w)).at(-1), 'CONFIRMED');

  // a releitura imediatamente antes de gravar falha ⇒ a testemunha não pode ser consultada ⇒ NÃO grava
  const w2 = await ledgerWorld({ ledgerFs: faulty({ async writeExclusive(target, data, mode) { if (target.includes('l000003.json')) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } }) });
  assert.ok(!(await w2.rawProtected.create(ANA, w2.auditId, { record: rec.c2(), expectedHead: null }, clock())).ok);
  const e2 = resultsEnv();
  const broken = scripted(witnessOver(w2, e2), ['real', 'real', 'throw']);
  const blocked = decisionsOver(w2, { ledger: ledgerFor(w2, { guard: null }), knownHeads: broken.provider });
  const before = (await ledgerEvents(w2)).length;
  assert.ok(!(await blocked.ledgerAction(BIA, w2.auditId, { action: 'RECOVER' }, clock())).ok);
  assert.equal((await ledgerEvents(w2)).length, before, 'testemunha ilegível na hora de gravar ⇒ nada gravado');
});

test('R7-06 (2): a testemunha das DECISÕES (6B) não resolvida (indício de resultado pendente forjado ⇒ UNTRUSTED) impede QUALQUER gravação de recuperação do livro — o ABORTED não é gravado', async () => {
  // INTENT aberta e vencida (fase A): a recuperação normal a abortaria
  const failingEntry = faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w = await ledgerWorld({ decisionsFs: failingEntry });
  const e = resultsEnv();
  assert.ok(!(await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock())).ok);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT']);
  // testemunha: um resultado PENDENTE de origem não comprovada cita uma cabeça de decisões que contradiz o histórico ⇒ a 6B marca UNTRUSTED
  const forged: KnownHeadsProvider = async () => ({ ok: true, heads: [], unverifiedHeads: [{ seq: 1, sha256: 'f'.repeat(64) }], hasResults: true, ledgerHeads: [], unverifiedLedgerHeads: [] }) as never;
  void e;
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }), knownHeads: forged });
  const before = (await ledgerEvents(w)).length;
  const recover = await service.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, '2026-12-01T00:00:00.000Z');
  assert.ok(!recover.ok, 'sob testemunha não resolvida a recuperação não grava');
  const create = await service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, () => '2026-12-01T00:00:00.000Z');
  assert.ok(!create.ok && create.code === 'DECISIONS_HISTORY_UNRESOLVED' && create.issues.some((i) => /testemunha: UNTRUSTED/.test(i)), JSON.stringify(create).slice(0, 200));
  assert.equal((await ledgerEvents(w)).length, before, 'nenhum ABORTED foi gravado');
  // controle: com a testemunha íntegra a MESMA recuperação aborta
  const ok = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }), knownHeads: NO_RESULTS });
  assert.ok((await ok.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, '2026-12-01T00:00:00.000Z')).ok);
  assert.equal((await ledgerEvents(w)).at(-1), 'ABORTED');
});

test('origem da operação: na fase C a recuperação só conclui o CONFIRMED se a etiqueta de ORIGEM da entrada é comprovada — entrada forjada (sem etiqueta de origem) não é confirmada pelo servidor', async () => {
  let failConfirmed = true;
  const ledgerFs = faulty({ async writeExclusive(target, data, mode) { if (failConfirmed && target.includes('l000003.json')) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const w = await ledgerWorld({ ledgerFs });
  assert.ok(!(await w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock())).ok);
  failConfirmed = false;
  // quem escreve na pasta de decisões refaz a entrada SEM a etiqueta de origem (e refaz o selo SHA-256, que qualquer um refaz)
  const file = entryPath(w, 1);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete entry.contentSha256;
  delete entry.origin;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal(entry)));
  const before = (await ledgerEvents(w)).length;
  const done = await decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS }).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!done.ok, 'sem origem comprovada o servidor não confirma em nome do autor');
  assert.equal((await ledgerEvents(w)).length, before, 'nenhum CONFIRMED');
});
