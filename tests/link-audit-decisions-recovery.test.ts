import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import { WITNESS_NOT_REQUIRED } from '../src/lib/link-audit-decisions/witness';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDecisionService, type DecisionService } from '../src/lib/link-audit-decisions';
import { clearStorageFatal } from '../src/lib/link-audit-decisions/store';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { seal, serialize } from '../src/lib/link-audit-decisions/store';
import { DECISION_FILE_KIND, DECISION_SCHEMA_VERSION } from '../src/lib/link-audit-decisions/types';
import { ANA, BIA, anchorPath, clock, entryPath, hashTree, must, rec, registerCleanup, signedSeal, tmpDir, world, writeAlternatingChain, type World } from './helpers/link-audit-decisions-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';

registerCleanup();

/*
 * Protocolo de publicação (Emenda 1 do ADR da âncora externa): a decisão só é CONFIRMADA quando o arquivo `dNNNN.json` E o
 * recibo `aNNNN.json` (pasta separada) estão duráveis. Entre os dois a decisão é PENDENTE: existe, mas não vale, não é
 * devolvida como sucesso e pode ser perdida sem que nenhuma promessa tenha sido feita. Reenviar o MESMO pedido a conclui.
 */

const serviceWith = (w: World, ops: FsOps): DecisionService => createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir, fs: ops });

/** Disco em que a ÂNCORA número `seq` não consegue ser gravada (em qualquer etapa que se escolha). */
function anchorFailure(w: World, seq: number, mode: 'temp-enospc' | 'link-eperm' | 'link-eio' | 'link-eacces'): FsOps {
  const name = `a${String(seq).padStart(4, '0')}.json`;
  return faulty({
    async writeExclusive(target, data, fileMode) {
      if (mode === 'temp-enospc' && target.startsWith(w.anchorDir) && path.basename(target).startsWith(`.tmp-${name}`)) throw errno('ENOSPC', 'sem espaço no volume de âncoras');
      return nodeFsOps.writeExclusive(target, data, fileMode);
    },
    async link(from, to) {
      if (to.startsWith(w.anchorDir) && path.basename(to) === name) {
        if (mode === 'link-eperm') throw errno('EPERM');
        if (mode === 'link-eio') throw errno('EIO');
        if (mode === 'link-eacces') throw errno('EACCES');
      }
      return nodeFsOps.link(from, to);
    },
  });
}

/** Histórico íntegro até d0010 (com âncoras a0001…a0010), como no cenário do relatório. */
async function tenEntries(): Promise<{ w: World; head: { seq: number; sha256: string } }> {
  const w = await world();
  writeAlternatingChain(w.decisionsDir, w.anchorDir, w.auditId, 10);
  const listed = await must(w.raw.list(ANA, w.auditId));
  assert.equal(listed.head?.seq, 10);
  assert.deepEqual(listed.anchors, { count: 10, lastSeq: 10, unanchored: 0 });
  return { w, head: listed.head as { seq: number; sha256: string } };
}

/* ===================================================================== reprodução do cenário do relatório */

test('REPRODUÇÃO — d0010/a0010 íntegros; d0011 gravada, a0011 falha, d0011 some: o servidor NÃO pode ter prometido sucesso definitivo', async () => {
  const { w, head } = await tenEntries();
  const failing = serviceWith(w, anchorFailure(w, 11, 'temp-enospc'));

  // 2–4: o servidor grava d0011, a gravação de a0011 falha e a API responde…
  const response = await failing.create(ANA, w.auditId, { record: rec.c2(), expectedHead: head }, clock());
  assert.ok(fs.existsSync(entryPath(w, 11)), 'a janela existe: d0011 foi publicada');
  assert.ok(!fs.existsSync(anchorPath(w, 11)), 'a janela existe: a0011 não foi gravada');
  assert.ok(!response.ok, 'a resposta NÃO pode ser sucesso (HTTP 201) se a integridade da decisão ainda não está garantida');

  // 5–6: d0011 é perdida antes de qualquer outra operação; o armazenamento volta a mostrar d0010 + a0010
  fs.chmodSync(entryPath(w, 11), 0o644);
  fs.rmSync(entryPath(w, 11));
  const reread = await w.raw.list(ANA, w.auditId);
  // Sem confirmação emitida, nada foi perdido: o histórico é de fato o confirmado (d0010) e o operador foi avisado de que NÃO estava salvo.
  assert.ok(reread.ok && reread.value.head?.seq === 10 && reread.value.pending === null);
});

test('INVARIANTE — se a escrita respondeu sucesso, a perda da decisão recém-gravada é DETECTADA pelo leitor (qualquer falha de âncora)', async () => {
  for (const mode of ['temp-enospc', 'link-eperm', 'link-eio', 'link-eacces'] as const) {
    clearStorageFatal();
    const { w, head } = await tenEntries();
    const response = await serviceWith(w, anchorFailure(w, 11, mode)).create(ANA, w.auditId, { record: rec.c2(), expectedHead: head }, clock());
    if (response.ok) {
      // promessa feita ⇒ a perda do arquivo precisa ser visível para QUALQUER leitor
      fs.chmodSync(entryPath(w, 11), 0o644);
      fs.rmSync(entryPath(w, 11));
      const reread = await w.raw.list(ANA, w.auditId);
      assert.ok(!reread.ok && reread.code === 'DECISIONS_TRUNCATED', `${mode}: sucesso prometido e a perda de d0011 passou despercebida`);
    } else {
      assert.equal(response.code, 'ANCHOR_PENDING', `${mode}: a única falha aceitável aqui é "pendente de confirmação" (veio ${response.code})`);
    }
    clearStorageFatal();
  }
});

/* ===================================================================== utilidades da bateria adversarial */

const REASON = 'Informação conferida e incorreta; decisão desfeita.';
type Head = { seq: number; sha256: string };
const folder = (w: World, which: 'd' | 'a'): string => path.join(which === 'd' ? w.decisionsDir : w.anchorDir, w.auditId);
const remove = (file: string): void => {
  fs.chmodSync(file, 0o644);
  fs.rmSync(file);
};
const snapshot = (dir: string): Map<string, Buffer> => new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
const restore = (dir: string, files: Map<string, Buffer>): void => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  for (const [name, data] of files) fs.writeFileSync(path.join(dir, name), data, { mode: 0o444 });
};

/** Três decisões e uma revogação, todas CONFIRMADAS (quatro arquivos de decisão, quatro recibos). */
async function confirmedFour(): Promise<{ w: World; heads: Head[] }> {
  const w = await world();
  const heads: Head[] = [];
  for (const record of [rec.c2(), rec.c3(), rec.p3()]) heads.push((await must(w.service.create(ANA, w.auditId, { record }, clock()))).head);
  heads.push((await must(w.service.revoke(ANA, w.auditId, { revokes: 'op-0002', reason: REASON }, clock()))).head);
  assert.deepEqual(heads.map((h) => h.seq), [1, 2, 3, 4]);
  return { w, heads };
}

/** Processo que MORRE depois da `k`-ésima operação que muda o disco: tudo o que vem depois (inclusive leituras) lança ECRASH. */
function crashAfter(k: number): { ops: FsOps; mutations: () => number } {
  let count = 0;
  let dead = false;
  const alive = (): void => {
    if (dead) throw errno('ECRASH', 'processo encerrado');
  };
  const mutating =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      alive();
      if (++count > k) {
        dead = true;
        throw errno('ECRASH', 'processo encerrado');
      }
      return fn(...a);
    };
  const reading =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      alive();
      return fn(...a);
    };
  return {
    mutations: () => count,
    ops: {
      mkdir: mutating(nodeFsOps.mkdir),
      writeExclusive: mutating(nodeFsOps.writeExclusive),
      link: mutating(nodeFsOps.link),
      unlink: mutating(nodeFsOps.unlink),
      chmod: mutating(nodeFsOps.chmod),
      syncDirectory: mutating(nodeFsOps.syncDirectory),
      lstat: reading(nodeFsOps.lstat),
      readdir: reading(nodeFsOps.readdir),
      realpath: reading(nodeFsOps.realpath),
      readFile: reading(nodeFsOps.readFile),
    },
  };
}

/* ===================================================================== A. queda em CADA etapa da escrita */

test('QUEDA em cada etapa: o histórico nunca fica ilegível, nenhuma promessa é feita sem os dois arquivos, e reenviar o MESMO pedido converge para exatamente uma decisão', async () => {
  let reachedSuccess = false;
  const outcomes = new Set<string>();
  for (let k = 0; k <= 40 && !reachedSuccess; k++) {
    const w = await world();
    await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
    await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock()));
    const before = await must(w.raw.list(ANA, w.auditId));
    const body = { record: rec.p3(), expectedHead: before.head };

    const crash = crashAfter(k);
    const response = await serviceWith(w, crash.ops).create(ANA, w.auditId, body, clock());
    reachedSuccess = response.ok;
    const published = fs.existsSync(entryPath(w, 3));
    outcomes.add(response.ok ? 'ok' : `${response.code}${published ? '+publicada' : ''}`);

    if (response.ok) assert.ok(published && fs.existsSync(anchorPath(w, 3)), `k=${k}: sucesso sem os dois arquivos`); // promessa ⇒ ambos duráveis
    const view = await w.raw.list(ANA, w.auditId); // nunca ilegível, qualquer que seja o ponto da queda
    assert.ok(view.ok, `k=${k}: histórico ilegível depois da queda (${view.ok ? '' : view.code})`);
    if (!view.ok) return;
    assert.ok(view.value.head !== null && view.value.head.seq >= 2 && view.value.operatorRecords.every((r) => r.id !== 'op-0003' || view.value.pending === null), `k=${k}`);
    if (view.value.pending) assert.deepEqual([view.value.pending.seq, view.value.head?.seq, view.value.history.length], [3, 2, 2], `k=${k}: a pendente não pode valer`);

    const retried = await must(w.raw.create(ANA, w.auditId, body, clock())); // o operador reenvia o MESMO pedido
    assert.equal(retried.replayed, published, `k=${k}: reenvio ${published ? 'deveria' : 'não deveria'} ser reconhecido`);
    assert.deepEqual([retried.anchored, retried.decision.decisionId, retried.head.seq, retried.anchors], [true, 'op-0003', 3, { count: 3, lastSeq: 3, unanchored: 0 }], `k=${k}`);
    const frozen = { d: hashTree(w.decisionsDir), a: hashTree(w.anchorDir) };
    const twice = await must(w.raw.create(ANA, w.auditId, body, clock())); // e quantas vezes quiser
    assert.deepEqual([twice.replayed, twice.head.seq], [true, 3], `k=${k}`);
    assert.deepEqual({ d: hashTree(w.decisionsDir), a: hashTree(w.anchorDir) }, frozen, `k=${k}: o segundo reenvio não pode gravar nada`);
    const final = await must(w.raw.list(ANA, w.auditId));
    assert.deepEqual([final.history.length, final.pending, final.anchors.unanchored, final.decisions.map((d) => d.decisionId)], [3, null, 0, ['op-0001', 'op-0002', 'op-0003']], `k=${k}`);
    // e, uma vez confirmada, a perda dela é detectada
    remove(entryPath(w, 3));
    const lost = await w.raw.list(ANA, w.auditId);
    assert.ok(!lost.ok && lost.code === 'DECISIONS_TRUNCATED', `k=${k}`);
  }
  assert.ok(reachedSuccess, 'a varredura chegou a uma gravação completa');
  assert.ok([...outcomes].some((o) => o.startsWith('ANCHOR_PENDING') || o.includes('+publicada')) && outcomes.has('ok'), `a varredura passou por quedas antes e depois da publicação: ${[...outcomes].join(' | ')}`);
});

test('QUEDA em cada etapa da REVOGAÇÃO: a decisão não "ressuscita" nem some sem aviso; o reenvio conclui uma única revogação', async () => {
  let reachedSuccess = false;
  for (let k = 0; k <= 40 && !reachedSuccess; k++) {
    const { w, heads } = await confirmedFour();
    const body = { revokes: 'op-0003', reason: REASON, expectedHead: heads[3] };
    const response = await serviceWith(w, crashAfter(k).ops).revoke(ANA, w.auditId, body, clock());
    reachedSuccess = response.ok;
    const view = await must(w.raw.list(ANA, w.auditId));
    // a decisão NUNCA é projetada como vigente com certeza indevida: sem nada publicado segue vigente; com a revogação PENDENTE fica EM DÚVIDA
    // (fora de `decisions` e de `operatorRecords`); com o recibo está revogada
    const published = fs.existsSync(entryPath(w, 5));
    const vigente = view.decisions.some((d) => d.decisionId === 'op-0003');
    if (view.pending !== null) {
      assert.equal(vigente, false, `k=${k}: pendente ⇒ a decisão em dúvida não é vigente`);
      assert.deepEqual(view.ambiguousDecisionIds, ['op-0003'], `k=${k}`);
      assert.equal(view.operatorRecords.some((r) => r.id === 'op-0003'), false, `k=${k}: e não alimenta o motor`);
    } else if (published) {
      assert.equal(vigente, false, `k=${k}: revogação confirmada`);
    } else {
      assert.equal(vigente, true, `k=${k}: nada foi publicado: a decisão segue vigente`);
    }
    const retried = await must(w.raw.revoke(ANA, w.auditId, body, clock()));
    assert.deepEqual([retried.revoked.status, retried.head.seq, retried.effectiveCount], ['REVOKED', 5, 1], `k=${k}`);
    assert.equal((await must(w.raw.list(ANA, w.auditId))).history.length, 5, `k=${k}: exatamente uma revogação`);
  }
  assert.ok(reachedSuccess);
});

/* ===================================================================== B. truncamento e restauração */

test('TRUNCAMENTO — o ÚLTIMO arquivo de decisão desaparece (confirmado): leitura, criação e revogação acusam DECISIONS_TRUNCATED, sem dados e sem gravar nada', async () => {
  for (const removed of [[4], [3, 4], [2, 3, 4], [1, 2, 3, 4]]) {
    const { w, heads } = await confirmedFour();
    for (const seq of removed) remove(entryPath(w, seq));
    const before = { d: hashTree(w.decisionsDir), a: hashTree(w.anchorDir) };
    for (const result of [
      await w.raw.list(ANA, w.auditId),
      await w.raw.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: heads[3] }, clock()),
      await w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: heads[3] }, clock()),
    ]) {
      assert.ok(!result.ok && result.code === 'DECISIONS_TRUNCATED' && !('value' in result), `removidos ${removed.join(',')}`);
    }
    assert.deepEqual({ d: hashTree(w.decisionsDir), a: hashTree(w.anchorDir) }, before, 'nada foi gravado');
  }
  const { w } = await confirmedFour();
  fs.rmSync(path.join(w.decisionsDir, w.auditId), { recursive: true, force: true }); // a pasta INTEIRA da auditoria sumiu
  const gone = await w.raw.list(ANA, w.auditId);
  assert.ok(!gone.ok && gone.code === 'DECISIONS_TRUNCATED');
});

test('TRUNCAMENTO — a ÚLTIMA REVOGAÇÃO desaparece: a decisão revogada não volta a valer em silêncio', async () => {
  const { w } = await confirmedFour(); // d0004 revoga op-0002
  remove(entryPath(w, 4));
  const result = await w.raw.list(ANA, w.auditId);
  assert.ok(!result.ok && result.code === 'DECISIONS_TRUNCATED');
});

test('RESTAURAÇÃO — backup antigo de UMA das pastas, de AMBAS e arquivo reescrito: cada caso é acusado (ou é o limite documentado, fechado pelo expectedHead)', async () => {
  // só as decisões voltam ao passado
  let { w, heads } = await confirmedFour();
  const oldDecisions = (() => {
    const copy = snapshot(folder(w, 'd'));
    for (const name of [...copy.keys()]) if (name > 'd0002.json') copy.delete(name);
    return copy;
  })();
  restore(folder(w, 'd'), oldDecisions);
  let result = await w.raw.list(ANA, w.auditId);
  assert.ok(!result.ok && result.code === 'DECISIONS_TRUNCATED', 'decisões antigas + recibos novos');

  // só os recibos voltam ao passado: há decisões demais sem recibo
  ({ w, heads } = await confirmedFour());
  const oldAnchors = snapshot(folder(w, 'a'));
  for (const name of [...oldAnchors.keys()]) if (name > 'a0002.json') oldAnchors.delete(name);
  restore(folder(w, 'a'), oldAnchors);
  result = await w.raw.list(ANA, w.auditId);
  assert.ok(!result.ok && result.code === 'ANCHOR_INTEGRITY', 'recibos antigos + decisões novas');

  // AS DUAS voltam ao passado (restauração coordenada): a leitura isolada não vê; o head que o operador guardou vê
  ({ w, heads } = await confirmedFour());
  const keep = (dir: string, last: string): Map<string, Buffer> => {
    const copy = snapshot(dir);
    for (const name of [...copy.keys()]) if (name > last) copy.delete(name);
    return copy;
  };
  restore(folder(w, 'd'), keep(folder(w, 'd'), 'd0002.json'));
  restore(folder(w, 'a'), keep(folder(w, 'a'), 'a0002.json'));
  const listed = await must(w.raw.list(ANA, w.auditId)); // limite assumido do ADR §4
  assert.equal(listed.head?.seq, 2);
  for (const attempt of [
    await w.raw.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: heads[3] }, clock()),
    await w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: heads[3] }, clock()),
  ]) {
    assert.ok(!attempt.ok && attempt.code === 'HISTORY_REGRESSED' && attempt.head?.seq === 2);
  }
  // …mas um operador NOVO, sem head guardado, não vê nada: por isso a 6C precisa FIXAR o head nos resultados
  const blind = await w.raw.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: listed.head }, clock());
  assert.ok(blind.ok, 'documentado: sem head guardado, a restauração coordenada não é detectada');

  // arquivo reescrito e re-selado
  ({ w } = await confirmedFour());
  const file = entryPath(w, 4);
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete body.contentSha256;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal({ ...body, recordedBy: 'intruso@empresa.com' })));
  result = await w.raw.list(ANA, w.auditId);
  assert.ok(!result.ok && result.code === 'ANCHOR_MISMATCH');
});

test('RECIBOS removidos: a última sozinha vira PENDENTE (não vale, não é integridade); duas ou mais, ou do meio, são falha', async () => {
  let { w } = await confirmedFour();
  remove(anchorPath(w, 4));
  const pending = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual([pending.head?.seq, pending.pending?.seq, pending.history.length, pending.anchors], [3, 4, 3, { count: 3, lastSeq: 3, unanchored: 1 }]);
  // a revogação d0004 (que revogava op-0002) NÃO vale enquanto não houver recibo, mas op-0002 NÃO volta a ser vigente: fica EM DÚVIDA, fora do motor
  assert.deepEqual(pending.decisions.map((d) => d.decisionId), ['op-0001', 'op-0003']);
  assert.deepEqual(pending.ambiguousDecisionIds, ['op-0002']);
  assert.deepEqual(pending.operatorRecords.map((r) => r.id), ['op-0001', 'op-0003']);
  assert.equal(pending.pending?.action, 'REVOKE');
  for (const dropped of [[3, 4], [2, 3, 4], [1, 2, 3, 4], [2]]) {
    ({ w } = await confirmedFour());
    for (const seq of dropped) remove(anchorPath(w, seq));
    const failed = await w.raw.list(ANA, w.auditId);
    assert.ok(!failed.ok && failed.code === 'ANCHOR_INTEGRITY', `recibos removidos ${dropped.join(',')}`);
  }
});

test('PENDENTE perdida: a decisão sem recibo some e o histórico volta ao confirmado sem alarme falso; o reenvio grava de novo, uma vez só', async () => {
  const { w, heads } = await confirmedFour();
  const body = { record: rec.naModel(), expectedHead: heads[3] };
  const response = await serviceWith(w, anchorFailure(w, 5, 'link-eacces')).create(ANA, w.auditId, body, clock());
  assert.ok(!response.ok && response.code === 'ANCHOR_PENDING' && response.pending?.seq === 5 && response.head?.seq === 4);
  remove(entryPath(w, 5));
  const view = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual([view.head, view.pending, view.anchors.unanchored], [heads[3], null, 0]);
  const again = await must(w.raw.create(ANA, w.auditId, body, clock()));
  assert.deepEqual([again.replayed, again.head.seq, again.decision.decisionId], [false, 5, 'op-0005']);
  assert.equal((await must(w.raw.list(ANA, w.auditId))).history.length, 5);
});

test('ENTRADA FORJADA na cauda (quem só escreve na pasta de decisões): é PENDENTE, não vale, e nenhum pedido alheio a "legitima" nem fabrica o recibo', async () => {
  const { w, heads } = await confirmedFour();
  const last = JSON.parse(fs.readFileSync(entryPath(w, 4), 'utf8')) as { contentSha256: string; recordedAt: string };
  const forged = seal({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: DECISION_FILE_KIND,
    auditId: w.auditId,
    seq: 5,
    recordedAt: last.recordedAt,
    recordedBy: 'ana@empresa.com',
    prevSha256: last.contentSha256,
    action: 'RECORD',
    decisionId: 'op-0005',
    record: { ...rec.naModel(), causeEvidenceIds: [], justification: 'Texto inventado por quem escreveu direto no disco.' }, // já na forma normalizada que o contrato da 6A grava
    supersedes: null,
    basis: { capture: 1, report: null, collectedAt: null },
  });
  fs.writeFileSync(entryPath(w, 5), serialize(forged), { mode: 0o444 });
  const view = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual([view.head, view.history.length, view.pending?.seq, view.operatorRecords.some((r) => r.id === 'op-0005')], [heads[3], 4, 5, false]);
  const anchorsBefore = hashTree(w.anchorDir);
  for (const attempt of [
    await w.raw.create(ANA, w.auditId, { record: rec.p3(7), expectedHead: heads[3] }, clock()), // o "autor" com outro conteúdo
    await w.raw.create(BIA, w.auditId, { record: rec.naModel(), expectedHead: heads[3] }, clock()), // outro operador, mesmo conteúdo-base
    await w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: heads[3] }, clock()),
  ]) {
    // a pendente é NÃO comprovada: o arquivo cita ANA, mas o servidor não afirma isso (autor e conteúdo ficam ocultos)
    assert.ok(!attempt.ok && attempt.code === 'PENDING_UNCONFIRMED' && attempt.pending?.recordedBy === null && attempt.pending?.origin === 'UNPROVEN' && attempt.pending?.isMine === false && attempt.pending?.record === null);
  }
  // O ATAQUE ORIGINAL (RV-04): a própria ANA reenvia EXATAMENTE a operação do arquivo forjado, montada a partir do que o servidor mostra
  const forgedOperation = (forged as unknown as { record: Record<string, unknown> }).record;
  const replayByAuthor = await w.raw.create(ANA, w.auditId, { record: forgedOperation as never, expectedHead: heads[3] }, clock());
  assert.ok(!replayByAuthor.ok && replayByAuthor.code === 'PENDING_ORIGIN_UNPROVEN' && replayByAuthor.pending?.origin === 'UNPROVEN', JSON.stringify(replayByAuthor).slice(0, 200));
  assert.deepEqual(hashTree(w.anchorDir), anchorsBefore, 'nenhum recibo foi gravado para a entrada forjada');
  const after = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual([after.head, after.pending?.seq, after.finalizable, after.operatorRecords.some((r) => r.id === 'op-0005')], [heads[3], 5, false, false], 'a forjada continua pendente: não vale e continua bloqueando (nunca vira ACTIVE)');
});

/* ===================================================================== C. idempotência */

test('IDEMPOTÊNCIA — resposta perdida, reenvio tardio, outro operador, decisão já revogada e pedido diferente', async () => {
  const w = await world();
  const first = await must(w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  // resposta perdida: o reenvio devolve a MESMA decisão e não grava nada
  const frozen = { d: hashTree(w.decisionsDir), a: hashTree(w.anchorDir) };
  const lost = await must(w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  assert.deepEqual([lost.replayed, lost.decision.decisionId, lost.head], [true, 'op-0001', first.head]);
  assert.deepEqual({ d: hashTree(w.decisionsDir), a: hashTree(w.anchorDir) }, frozen);

  // reenvio TARDIO: outras decisões já entraram; o head devolvido é o ATUAL (não o da entrada reenviada)
  const second = await must(w.raw.create(ANA, w.auditId, { record: rec.c3(), expectedHead: first.head }, clock()));
  const late = await must(w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  assert.deepEqual([late.replayed, late.decision.decisionId, late.head], [true, 'op-0001', second.head]);

  // outro operador com o MESMO corpo e a mesma visão nunca é reenvio
  const foreign = await w.raw.create(BIA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(!foreign.ok && foreign.code === 'HEAD_MISMATCH');
  // o mesmo operador, outro conteúdo, mesma visão: nada de reenvio
  const changed = await w.raw.create(ANA, w.auditId, { record: rec.c2('PARTIAL'), expectedHead: null }, clock());
  assert.ok(!changed.ok && changed.code === 'HEAD_MISMATCH');
  // a decisão foi revogada depois: o reenvio NÃO a recria nem a reativa; mostra o estado atual
  const revoked = await must(w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: second.head }, clock()));
  const after = await must(w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  assert.deepEqual([after.replayed, after.decision.status, after.effectiveCount, after.head], [true, 'REVOKED', 1, revoked.head]);
  // reenvio da revogação
  const resentRevoke = await must(w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: second.head }, clock()));
  assert.deepEqual([resentRevoke.replayed, resentRevoke.revocation.seq], [true, 3]);
  // uma decisão igual sobre o head ATUAL é um pedido novo, não reenvio: as regras de domínio decidem (op-0002 já ocupa C3)
  const duplicate = await w.raw.create(ANA, w.auditId, { record: rec.c3(), expectedHead: revoked.head }, clock());
  assert.ok(!duplicate.ok && duplicate.code === 'SUPERSEDE_REQUIRED');
  const fresh = await must(w.raw.create(ANA, w.auditId, { record: rec.p3(), expectedHead: revoked.head }, clock()));
  assert.deepEqual([fresh.replayed, fresh.decision.decisionId], [false, 'op-0004']);
  assert.equal((await must(w.raw.list(ANA, w.auditId))).history.length, 4);
});

/* ===================================================================== D. concorrência preservada */

test('CONCORRÊNCIA — 6 reenvios idênticos simultâneos gravam UMA decisão; 6 pedidos diferentes sobre a mesma visão: um vence, os outros recebem HEAD_MISMATCH', async () => {
  const w = await world();
  const base = await must(w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  const same = await Promise.all(Array.from({ length: 6 }, () => w.raw.create(ANA, w.auditId, { record: rec.c3(), expectedHead: base.head }, clock())));
  assert.ok(same.every((r) => r.ok));
  assert.deepEqual(same.map((r) => (r.ok ? r.value.replayed : null)).sort(), [false, true, true, true, true, true]);
  assert.equal((await must(w.raw.list(ANA, w.auditId))).history.length, 2);

  const head = (await must(w.raw.list(ANA, w.auditId))).head;
  const records = [rec.p3(1), rec.p3(2), rec.p3(3), rec.p3(4), rec.p3(5), rec.p3(6)];
  const racing = await Promise.all(records.map((record, i) => w.raw.create(i % 2 === 0 ? ANA : BIA, w.auditId, { record, expectedHead: head }, clock())));
  assert.equal(racing.filter((r) => r.ok).length, 1);
  assert.ok(racing.filter((r) => !r.ok).every((r) => !r.ok && (r.code === 'HEAD_MISMATCH' || r.code === 'SUPERSEDE_REQUIRED')));
  const listed = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual([listed.history.length, listed.pending, listed.anchors.unanchored], [3, null, 0]);
});

/* ===================================================================== E. fuzz determinístico com modelo */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('FUZZ (semente fixa) — 160 passos com recibos que falham, quedas em pontos aleatórios e reenvios: nada prometido se perde ou é trocado, nada fica ilegível, a pendente nunca vale', async () => {
  for (const seed of [20261028, 7, 424242]) {
    clearStorageFatal();
    const rng = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
    const w = await world();
    const promised = new Map<number, string>(); // seq → hash prometido ao operador
    const seen = { pendingResponses: 0, pendingViews: 0, replays: 0, blocked: 0 };
    type Sent = { kind: 'create' | 'revoke'; body: Record<string, unknown>; actor: { email: string } };
    const sent: Sent[] = [];
    let names = 0;

    for (let step = 0; step < 160; step++) {
      const before = await must(w.raw.list(ANA, w.auditId));
      const roll = rng();
      const prevOfPending = before.pending ? (before.pending.seq === 1 ? null : (before.history[before.pending.seq - 2]?.entrySha256 ?? 'x')) : undefined;
      // o autor da pendente (cliente realista) reenvia exatamente o pedido que a criou
      const ofPending = before.pending ? sent.find((r) => r.actor.email === before.pending?.recordedBy && ((r.body.expectedHead as Head | null)?.sha256 ?? null) === prevOfPending) : undefined;
      let request: Sent;
      if (ofPending && roll < 0.75) request = ofPending;
      else if (roll < 0.3 && sent.length > 0) request = pick(sent); // reenvio de um pedido antigo, com a visão ANTIGA dele
      else if (roll < 0.55 && before.decisions.length > 0) request = { kind: 'revoke', actor: rng() < 0.85 ? ANA : BIA, body: { revokes: pick(before.decisions).decisionId, reason: REASON, expectedHead: before.head } };
      else request = { kind: 'create', actor: rng() < 0.85 ? ANA : BIA, body: { record: rec.nameEquivalence(`Empresa ${++names} Ltda`, `Empresa ${names}`), expectedHead: before.head } };
      if (!sent.includes(request)) sent.push(request);

      const mode = rng();
      const ops: FsOps =
        mode < 0.5
          ? nodeFsOps
          : mode < 0.75
            ? anchorFailure(w, before.history.length + 1, pick(['temp-enospc', 'link-eperm', 'link-eacces'] as const))
            : crashAfter(Math.floor(rng() * 16)).ops;
      const svc = serviceWith(w, ops);
      const response = request.kind === 'create' ? await svc.create(request.actor, w.auditId, request.body, clock()) : await svc.revoke(request.actor, w.auditId, request.body, clock());

      const view = await w.raw.list(ANA, w.auditId);
      assert.ok(view.ok, `seed ${seed} passo ${step}: histórico ilegível (${view.ok ? '' : view.code})`);
      if (!view.ok) return;
      if (!response.ok && response.code === 'ANCHOR_PENDING') seen.pendingResponses++;
      if (!response.ok && response.code === 'PENDING_UNCONFIRMED') seen.blocked++;
      if (response.ok && response.value.replayed) seen.replays++;
      if (view.value.pending) seen.pendingViews++;
      if (response.ok) {
        const seq = 'decision' in response.value ? response.value.decision.seq : response.value.revocation.seq;
        assert.equal(response.value.anchored, true);
        promised.set(seq, view.value.history[seq - 1]?.entrySha256 ?? 'AUSENTE');
      }
      for (const [seq, sha] of promised) assert.equal(view.value.history[seq - 1]?.entrySha256, sha, `seed ${seed} passo ${step}: a entrada ${seq} prometida foi trocada ou perdida`);
      if (view.value.pending) {
        assert.equal(view.value.pending.seq, view.value.history.length + 1, `seed ${seed} passo ${step}`);
        assert.ok(!view.value.operatorRecords.some((r) => r.id === view.value.pending?.decisionId), `seed ${seed} passo ${step}: a pendente valeu`);
      }
      assert.ok(view.value.anchors.count === view.value.history.length && view.value.anchors.unanchored === (view.value.pending ? 1 : 0), `seed ${seed} passo ${step}`);
    }
    // a última entrada confirmada, se desaparecer, é acusada (com uma pendente depois dela a lacuna na sequência também acusa)
    const final = await must(w.raw.list(ANA, w.auditId));
    if (final.history.length > 0) {
      remove(entryPath(w, final.history.length));
      const lost = await w.raw.list(ANA, w.auditId);
      assert.ok(!lost.ok && lost.code === (final.pending ? 'DECISIONS_INTEGRITY' : 'DECISIONS_TRUNCATED'), `seed ${seed}: ${lost.ok ? 'perda não detectada' : lost.code}`);
    }
    assert.ok(promised.size > 10, `seed ${seed}: o fuzz exercitou promessas (${promised.size})`);
    assert.ok(seen.pendingResponses > 3 && seen.pendingViews > 3 && seen.replays > 3 && seen.blocked > 0, `seed ${seed}: o fuzz precisa passar por pendências, bloqueios e reenvios: ${JSON.stringify(seen)}`);
  }
});

/* ===================================================================== F. achados da revisão independente (M1, M2, M3 e cobertura) */

test('M1 — leitura que cruza com uma escrita CONCORRENTE não acusa adulteração: no pior caso mostra a pendente; com duas escritas na janela, relê e fecha limpo', async () => {
  for (const writes of [1, 2]) {
    const w = await world();
    await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
    await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock()));
    let fired = false;
    const reader = serviceWith(
      w,
      faulty({
        async readdir(dir) {
          if (!fired && dir === folder(w, 'd')) {
            fired = true; // as âncoras já foram lidas; "outro processo" conclui N escritas antes de lermos as decisões
            const extra = [rec.p3(), rec.naModel()];
            for (let i = 0; i < writes; i++) await must(w.service.create(ANA, w.auditId, { record: extra[i] }, clock()));
          }
          return nodeFsOps.readdir(dir);
        },
      }),
    );
    const view = await reader.list(ANA, w.auditId);
    assert.ok(view.ok, `${writes} escrita(s) concorrente(s): leitura legítima acusou ${view.ok ? '' : view.code}`);
    if (!view.ok) return;
    assert.equal(view.value.history.length + (view.value.pending ? 1 : 0), 2 + writes);
    assert.equal(view.value.finalizable, view.value.pending === null);
  }
  // e uma perda REAL continua acusada nas duas leituras (a releitura não esconde nada)
  const { w } = await confirmedFour();
  remove(entryPath(w, 4));
  const real = await w.raw.list(ANA, w.auditId);
  assert.ok(!real.ok && real.code === 'DECISIONS_TRUNCATED');
});

test('M2 — recibo da REVOGAÇÃO removido: a decisão revogada NÃO volta a ser vigente (fica em dúvida); finalizable:false e pending acusam; nunca silenciosamente', async () => {
  const { w } = await confirmedFour(); // d0004 revoga op-0002
  const ok = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual([ok.finalizable, ok.pending, ok.decisions.map((d) => d.decisionId)], [true, null, ['op-0001', 'op-0003']]);
  remove(anchorPath(w, 4));
  const view = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual([view.finalizable, view.pending?.action, view.pending?.revokes, view.decisions.map((d) => d.decisionId)], [false, 'REVOKE', 'op-0002', ['op-0001', 'op-0003']]);
  assert.deepEqual(view.ambiguousDecisionIds, ['op-0002']);
  assert.deepEqual(view.allDecisions.map((d) => [d.decisionId, d.status]).filter(([id]) => id === 'op-0002'), [['op-0002', 'AMBIGUOUS']]);
  // e nenhum pedido alheio grava por cima nem conclui o recibo
  const blocked = await w.raw.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: view.head }, clock());
  assert.ok(!blocked.ok && blocked.code === 'PENDING_UNCONFIRMED');
});

test('M3 — pendente FORJADA não é concluída pelo reenvio se a data é futura, cita captura desconhecida ou viola o contrato da 6A; continua pendente e sem recibo', async () => {
  const forge = async (w: World, over: Record<string, unknown>, record: Record<string, unknown>) => {
    const last = JSON.parse(fs.readFileSync(entryPath(w, 4), 'utf8')) as { contentSha256: string; recordedAt: string };
    const entry = signedSeal({ // ASSINADA: o que se testa aqui são as checagens INTERNAS (defesa em profundidade); a origem tem os seus próprios testes
      schemaVersion: DECISION_SCHEMA_VERSION,
      kind: DECISION_FILE_KIND,
      auditId: w.auditId,
      seq: 5,
      recordedAt: last.recordedAt,
      recordedBy: 'bia@empresa.com',
      prevSha256: last.contentSha256,
      action: 'RECORD',
      decisionId: 'op-0005',
      record,
      supersedes: null,
      basis: { capture: 1, report: null, collectedAt: null },
      ...over,
    });
    fs.writeFileSync(entryPath(w, 5), serialize(entry), { mode: 0o444 });
  };
  const naModel = { ...rec.naModel(), causeEvidenceIds: [] };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['data futura', { recordedAt: '2099-01-01T00:00:00.000Z' }, naModel],
    ['data anterior à da entrada anterior (monotonia)', { recordedAt: '2000-01-01T00:00:00.000Z' }, naModel],
    ['captura desconhecida', { basis: { capture: 77, report: null, collectedAt: null } }, naModel],
    ['revisão de relatório desconhecida', { basis: { capture: 1, report: { capture: 1, revision: 9 }, collectedAt: null } }, naModel],
    ['viola o contrato da 6A (N/A FEATURE_UNAVAILABLE sem evidência da causa)', {}, { ...rec.naFeature(), causeEvidenceIds: [] }],
  ];
  for (const [label, over, record] of cases) {
    const { w, heads } = await confirmedFour();
    await forge(w, over, record);
    const anchorsBefore = hashTree(w.anchorDir);
    const resent = await w.raw.create(BIA, w.auditId, { record, expectedHead: heads[3] }, clock()); // o "autor" envia exatamente o conteúdo forjado
    assert.ok(!resent.ok && resent.code === 'PENDING_UNCONFIRMED' && resent.issues.length > 0, `${label}: foi concluída (${resent.ok ? 'ok' : resent.code})`);
    assert.deepEqual(hashTree(w.anchorDir), anchorsBefore, `${label}: nenhum recibo pode ser gravado`);
    const view = await must(w.raw.list(ANA, w.auditId));
    assert.deepEqual([view.pending?.seq, view.finalizable, view.history.length], [5, false, 4], label);
  }
  // o caso legítimo (mesma forma, dados coerentes) é concluído normalmente
  const { w, heads } = await confirmedFour();
  await forge(w, {}, naModel);
  const ok = await must(w.raw.create(BIA, w.auditId, { record: naModel, expectedHead: heads[3] }, clock()));
  assert.deepEqual([ok.replayed, ok.head.seq], [true, 5]);
});

test('LIMITE — pendente na última posição (9999): o reenvio ainda a conclui, e qualquer outro pedido recebe PENDING_UNCONFIRMED (não LIMIT_REACHED)', async () => {
  const decisionsDir = tmpDir('lad-lim-d-');
  const anchorDir = tmpDir('lad-lim-a-');
  const AUDIT = 'auditoria-limite-01';
  writeAlternatingChain(decisionsDir, anchorDir, AUDIT, 9999); // d9999 é uma criação de C2
  remove(path.join(anchorDir, AUDIT, 'a9999.json'));
  const evidence = {
    async getIntegrity() {
      return { state: 'COMPLETE', integrity: { status: 'OK' as const } };
    },
    async listVersions() {
      return [{ capture: 1, collectedAt: '2026-10-22T12:54:48.079Z', reportRevisions: [{ revision: 1 }] }];
    },
  };
  const svc = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: decisionsDir, anchorDir, evidence });
  const view = await must(svc.list(ANA, AUDIT));
  assert.deepEqual([view.head?.seq, view.pending?.seq, view.finalizable], [9998, 9999, false]);
  const other = await svc.create(ANA, AUDIT, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!other.ok && other.code === 'PENDING_UNCONFIRMED');
  const done = await must(svc.create(ANA, AUDIT, { record: rec.c2(), expectedHead: view.head }, clock()));
  assert.deepEqual([done.replayed, done.head.seq, done.anchors.unanchored], [true, 9999, 0]);
});

test('N1 — uma captura NOVA (ainda sem relatório) que chega depois da gravação NÃO bloqueia o reenvio legítimo da pendente', async () => {
  const decisionsDir = tmpDir('lad-n1-d-');
  const anchorDir = tmpDir('lad-n1-a-');
  const AUDIT = 'auditoria-n1-teste-01';
  const lookup = (withNewCapture: boolean) => ({
    async getIntegrity() {
      return { state: 'COMPLETE', integrity: { status: 'OK' as const } };
    },
    async listVersions() {
      return [
        { capture: 1, collectedAt: '2026-10-22T12:54:48.079Z', reportRevisions: [{ revision: 1 }] },
        ...(withNewCapture ? [{ capture: 2, collectedAt: '2026-10-23T12:00:00.000Z', reportRevisions: [] }] : []),
      ];
    },
  });
  const failingAnchors = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(anchorDir) && path.basename(target).startsWith('.tmp-a0001')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const body = { record: rec.c2(), expectedHead: null };
  const first = await createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: decisionsDir, anchorDir, evidence: lookup(false), fs: failingAnchors }).create(ANA, AUDIT, body, clock());
  assert.ok(!first.ok && first.code === 'ANCHOR_PENDING' && first.pending?.seq === 1);
  const later = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: decisionsDir, anchorDir, evidence: lookup(true) }); // agora existe a captura 2, sem relatório
  const resent = await must(later.create(ANA, AUDIT, body, clock()));
  assert.deepEqual([resent.replayed, resent.head.seq, resent.decision.basis.capture], [true, 1, 1]); // a base da decisão continua sendo a da gravação original
});

test('M3 — REVOGAÇÃO forjada com data futura também não é concluída pelo reenvio', async () => {
  const { w, heads } = await confirmedFour();
  const last = JSON.parse(fs.readFileSync(entryPath(w, 4), 'utf8')) as { contentSha256: string };
  const forged = signedSeal({ // ASSINADA (ver M3): testa a checagem interna de data futura
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: DECISION_FILE_KIND,
    auditId: w.auditId,
    seq: 5,
    recordedAt: '2099-01-01T00:00:00.000Z',
    recordedBy: 'bia@empresa.com',
    prevSha256: last.contentSha256,
    action: 'REVOKE',
    revokes: 'op-0001',
    reason: REASON,
  });
  fs.writeFileSync(entryPath(w, 5), serialize(forged), { mode: 0o444 });
  const anchorsBefore = hashTree(w.anchorDir);
  const resent = await w.raw.revoke(BIA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: heads[3] }, clock());
  assert.ok(!resent.ok && resent.code === 'PENDING_UNCONFIRMED' && resent.issues.join(' ').includes('posterior ao relógio'));
  assert.deepEqual(hashTree(w.anchorDir), anchorsBefore);
});
