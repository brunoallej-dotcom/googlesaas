import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createDecisionService, evaluateKnownHeads, WITNESS_NOT_REQUIRED, type KnownHeadsProvider } from '../src/lib/link-audit-decisions';
import { createResultsKnownHeads } from '../src/lib/link-audit-scoring-runs';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';
import { seal, serialize } from '../src/lib/link-audit-storage';
import path from 'node:path';
import { ANA, anchorPath, BIA, clock, entryPath, hashTree, must, registerCleanup, rec, tmpDir, world } from './helpers/link-audit-decisions-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv } from './helpers/link-audit-results-fixtures';
import { confirmedThenRevoked, previewW, quarantine, REASON, sealedAfterRevocation, withWitness } from './helpers/link-audit-witness-fixtures';

/*
 * REMOÇÃO DO RECIBO DE UMA REVOGAÇÃO CONFIRMADA (2ª revisão independente, RV2-A3b; decisão do responsável).
 * Quem escreve SÓ na pasta de recibos remove o recibo da ÚLTIMA entrada. No disco isso é idêntico a uma gravação interrompida. Exigência:
 * a ambiguidade NUNCA pode reativar uma decisão revogada nem permitir finalização baseada nesse histórico; todos os operadores veem o problema
 * (sem conteúdo privado); a recuperação legítima (origem comprovada, autor) continua possível; o `decisionsHead` de um resultado confirmado
 * funciona como TESTEMUNHA independente quando existe (e só quando existe).
 */
registerCleanup();

test('antes da remoção: a decisão revogada não é vigente e a auditoria é finalizável pelo lado das decisões', async () => {
  const w = await confirmedThenRevoked();
  const listed = await must(w.raw.list(BIA, w.auditId));
  assert.deepEqual(listed.decisions, []);
  assert.deepEqual(listed.ambiguousDecisionIds, []);
  assert.deepEqual(listed.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'REVOKED']]);
  assert.equal(listed.finalizable, true);
  assert.equal(listed.pending, null);
});

test('RECIBO DA REVOGAÇÃO REMOVIDO: a decisão revogada NÃO volta a ser vigente; fica EM DÚVIDA para todos, fora do motor, e nada é finalizável', async () => {
  const w = await confirmedThenRevoked();
  fs.rmSync(anchorPath(w, 2)); // o invasor só escreve na pasta de recibos
  for (const viewer of [ANA, BIA, { email: 'carlos@empresa.com' }]) {
    const listed = await must(w.raw.list(viewer, w.auditId));
    assert.deepEqual(listed.decisions, [], `${viewer.email}: a decisão revogada NÃO pode aparecer como vigente`);
    assert.deepEqual(listed.operatorRecords, [], `${viewer.email}: e não pode alimentar o motor`);
    assert.deepEqual(listed.ambiguousDecisionIds, ['op-0001'], `${viewer.email}: todos veem qual decisão está em dúvida`);
    assert.deepEqual(listed.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'AMBIGUOUS']]);
    assert.equal(listed.finalizable, false);
    assert.equal(listed.pending?.action, 'REVOKE');
    assert.equal(listed.pending?.revokes, 'op-0001');
    assert.equal(listed.pending?.origin, 'PROVEN', 'a etiqueta é válida: o servidor gravou a revogação (a ambiguidade é só "recibo ausente")');
    // sem vazamento: o motivo só é do autor
    assert.equal(listed.pending?.reason, viewer.email === ANA.email ? REASON : null, `${viewer.email}: o motivo privado só aparece para o autor`);
    assert.equal(listed.pending?.isMine, viewer.email === ANA.email);
  }
});

test('a prévia da 6C com a revogação sem recibo: não aplica a decisão em dúvida, é bloqueada e não é finalizável', async () => {
  const w = await confirmedThenRevoked();
  fs.rmSync(anchorPath(w, 2));
  const preview = previewOver(w);
  const result = await preview.evaluate(BIA, w.auditId);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value.applied.map((item) => item.decisionId), [], 'a decisão revogada NÃO é aplicada pelo motor');
  assert.equal(result.value.payload.finalization.allowed, false);
  assert.ok(result.value.payload.blockers.some((b) => b.code === 'DECISION_PENDING' && b.severity === 'BLOCKING'));
  assert.equal(result.value.payload.state, 'DECISAO_PENDENTE');
});

test('finalizar com a revogação sem recibo é recusado e NADA é gravado (nem resultado, nem recibo)', async () => {
  const w = await confirmedThenRevoked();
  fs.rmSync(anchorPath(w, 2));
  const e = resultsEnv();
  const svc = makeService(e, previewOver(w));
  const before = [hashTree(e.base), hashTree(e.anchors), hashTree(w.decisionsDir), hashTree(w.anchorDir)];
  const evaluated = await previewOver(w).evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok);
  // o pedido que a interface montaria (cabeça e hash REAIS da prévia): a recusa tem de ser pelo MOTIVO certo, não por visão desatualizada
  const attempt = await svc.finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.code === 'DECISION_PENDING'), JSON.stringify(attempt).slice(0, 200));
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors), hashTree(w.decisionsDir), hashTree(w.anchorDir)], before, 'nenhum arquivo foi criado ou alterado');
  assert.equal(fs.existsSync(anchorPath(w, 2)), false, 'o recibo não foi recriado em silêncio');
});

test('com a pendência: nenhuma NOVA decisão é aceita (de qualquer operador) e listar não recria recibo', async () => {
  const w = await confirmedThenRevoked();
  fs.rmSync(anchorPath(w, 2));
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir)];
  const head = (await must(w.raw.list(BIA, w.auditId))).head;
  for (const [who, body] of [
    [BIA, { record: rec.c2(), expectedHead: head }],
    [ANA, { record: rec.c2(), expectedHead: head }], // o próprio autor, mas com OUTRO pedido: não é o reenvio da pendente
  ] as const) {
    const r = await w.raw.create(who, w.auditId, body, clock());
    assert.ok(!r.ok && r.code === 'PENDING_UNCONFIRMED', `${who.email}: ${JSON.stringify(r).slice(0, 120)}`);
  }
  const other = await w.raw.revoke(BIA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock());
  assert.ok(!other.ok, 'outro operador não conclui a revogação do autor');
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir)], before);
});

test('RECUPERAÇÃO LEGÍTIMA preservada: o AUTOR (origem comprovada) conclui reenviando o mesmo pedido; a decisão fica REVOGADA, sem dúvida, e a auditoria volta a ser finalizável', async () => {
  const w = await confirmedThenRevoked();
  fs.rmSync(anchorPath(w, 2));
  const head = (await must(w.raw.list(ANA, w.auditId))).head;
  const done = await must(w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock()));
  assert.equal(done.revoked.status, 'REVOKED');
  assert.ok(fs.existsSync(anchorPath(w, 2)), 'o recibo do MESMO conteúdo foi recriado');
  const listed = await must(w.raw.list(BIA, w.auditId));
  assert.deepEqual(listed.ambiguousDecisionIds, []);
  assert.deepEqual(listed.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'REVOKED']]);
  assert.equal(listed.finalizable, true);
});

test('recibo removido E arquivo adulterado (selo refeito): a origem NÃO é comprovada, nada é recriado e a decisão segue fora do motor', async () => {
  const w = await confirmedThenRevoked();
  fs.rmSync(anchorPath(w, 2));
  const file = entryPath(w, 2);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete parsed.contentSha256;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal({ ...parsed, reason: 'Motivo trocado por quem adulterou o arquivo depois de tirar o recibo.' })));
  const listed = await must(w.raw.list(ANA, w.auditId));
  assert.equal(listed.pending?.origin, 'UNPROVEN');
  assert.deepEqual(listed.decisions, []);
  assert.deepEqual(listed.ambiguousDecisionIds, ['op-0001']);
  const head = listed.head;
  // (a) o pedido ORIGINAL do autor não é o desta pendência (o conteúdo do arquivo mudou): nada é gravado
  const original = await w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock());
  assert.ok(!original.ok, JSON.stringify(original).slice(0, 160));
  // (b) o pedido montado a partir do ARQUIVO adulterado (o ataque RV-04): a origem não confere
  const fromFile = await w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Motivo trocado por quem adulterou o arquivo depois de tirar o recibo.', expectedHead: head }, clock());
  assert.ok(!fromFile.ok && fromFile.code === 'PENDING_ORIGIN_UNPROVEN', JSON.stringify(fromFile).slice(0, 160));
  assert.equal(fs.existsSync(anchorPath(w, 2)), false);
});

test('a mesma regra vale para a SUBSTITUIÇÃO: sem o recibo da nova decisão, nem a antiga nem a nova são projetadas como vigentes', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: { ...rec.c2(), value: 'INCOMPATIBLE' }, supersedes: 'op-0001' }, clock()));
  fs.rmSync(anchorPath(w, 2));
  const listed = await must(w.raw.list(BIA, w.auditId));
  assert.deepEqual(listed.decisions, [], 'nem a substituída (em dúvida) nem a substituta (pendente) valem');
  assert.deepEqual(listed.operatorRecords, []);
  assert.deepEqual(listed.ambiguousDecisionIds, ['op-0001']);
  assert.deepEqual(listed.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'AMBIGUOUS']]);
  assert.equal(listed.pending?.action, 'RECORD');
  assert.equal(listed.pending?.supersedes, 'op-0001');
  assert.equal(listed.pending?.record, null, 'o conteúdo da pendente não é mostrado a quem não é o autor');
  assert.equal(listed.finalizable, false);
});

test('recibo de uma entrada do MEIO da cadeia removido: não é pendência, é falha de integridade (nenhum dado é devolvido)', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: { ...rec.c2(), value: 'INCOMPATIBLE' } }, clock()));
  fs.rmSync(anchorPath(w, 2)); // há uma entrada confirmada DEPOIS dele
  const listed = await w.raw.list(BIA, w.auditId);
  assert.ok(!listed.ok, 'remoção no meio é detectável');
  assert.ok(['ANCHOR_INTEGRITY', 'ANCHOR_MISMATCH', 'DECISIONS_INTEGRITY', 'DECISIONS_TRUNCATED'].includes(listed.code), listed.code);
  assert.equal('pending' in listed ? listed.pending : undefined, undefined);
});

/* ------------------------------------------------------------------------------ a TESTEMUNHA do histórico (R3-MINOR-2) */
/*
 * Invariante: uma decisão REVOGADA não volta a ACTIVE só porque um registro, recibo, arquivo de quarentena ou a própria testemunha deixou de ser
 * encontrado. A testemunha são as cabeças (`seq`+`sha256`) já CONFIRMADAS em resultados selados (outras pastas). Aqui ela é o provedor REAL
 * (`createResultsKnownHeads`) sobre pastas reais; cada "reinício" é um serviço novo (nada fica em memória).
 */
test('TESTEMUNHA: com resultado selado, o recibo REMOVIDO é visto por TODOS (estado estruturado), a revogação não reativa e o autor recupera', async () => {
  const { w, e } = await sealedAfterRevocation();
  fs.rmSync(anchorPath(w, 2));
  for (const viewer of [ANA, BIA, { email: 'carlos@empresa.com' }]) {
    const view = await must(withWitness(w, e).list(viewer, w.auditId)); // serviço NOVO a cada leitura: nada em memória
    assert.deepEqual([view.witness.status, view.witness.knownHeads, view.decisions.length, view.operatorRecords.length, view.finalizable, view.ambiguousDecisionIds], ['RECEIPT_LOST_WITNESSED', 1, 0, 0, false, ['op-0001']], viewer.email);
    assert.equal(view.pending?.reason, viewer.email === ANA.email ? REASON : null, `${viewer.email}: motivo privado só ao autor`);
  }
  const head = (await must(withWitness(w, e).list(ANA, w.auditId))).head;
  const done = await must(withWitness(w, e).revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock())); // RECUPERAÇÃO LEGÍTIMA
  assert.equal(done.revoked.status, 'REVOKED');
  const after = await must(withWitness(w, e).list(BIA, w.auditId));
  assert.deepEqual([after.witness.status, after.pending, after.ambiguousDecisionIds, after.finalizable], ['CONSISTENT', null, [], true]);
});

test('R3-MINOR-2 (o ataque do revisor): a pendência MOVIDA para quarentena NÃO reativa a decisão revogada: histórico NÃO resolvido, zero decisões vigentes, motor sem decisões, nada finalizável', async () => {
  const { w, e } = await sealedAfterRevocation();
  fs.rmSync(anchorPath(w, 2)); // o invasor só escreve nos recibos
  const moved = quarantine(w, 2); // e o operador "resolve" mandando a pendente para a quarentena (o §15 item 3 antigo)
  assert.ok(fs.existsSync(moved));
  for (const label of ['logo depois', 'depois de reiniciar']) {
    const decisions = withWitness(w, e); // "reinício": serviço novo
    const view = await must(decisions.list(BIA, w.auditId));
    assert.equal(view.witness.status, 'HISTORY_REGRESSED', label);
    assert.deepEqual(view.decisions, [], `${label}: a revogada NÃO volta a ser vigente`);
    assert.deepEqual(view.operatorRecords, [], `${label}: o motor não recebe nenhuma decisão`);
    assert.deepEqual(view.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'AMBIGUOUS']], label);
    assert.deepEqual([view.finalizable, view.ambiguousDecisionIds], [false, ['op-0001']], label);
    const preview = previewW(w, decisions);
    const evaluated = await preview.evaluate(OP_A, w.auditId);
    assert.ok(evaluated.ok);
    assert.deepEqual(evaluated.value.applied, [], `${label}: nada aplicado`);
    assert.equal(evaluated.value.payload.finalization.allowed, false);
    assert.deepEqual(evaluated.value.payload.decisions.witness, { status: 'HISTORY_REGRESSED', knownHeads: 1, coveredSeq: null, unwitnessedAffecting: 0 });
    const blocker = evaluated.value.payload.blockers.find((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED');
    assert.ok(blocker && blocker.severity === 'BLOCKING' && blocker.reasonCode === 'HISTORY_REGRESSED', JSON.stringify(evaluated.value.payload.blockers));
    // tentativa de finalizar com o pedido que a interface montaria (hash real): recusada PELO MOTIVO CERTO e nada é gravado
    const before = [hashTree(e.base), hashTree(e.anchors)];
    const attempt = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
    assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED'), `${label}: ${JSON.stringify(attempt).slice(0, 200)}`);
    assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], before, `${label}: nenhum resultado novo`);
  }
  // escritas: nem decisão nova, nem revogação, nem o "reenvio" do autor: todas recusadas com o código próprio, sem gravar
  const decisions = withWitness(w, e);
  const head = (await must(decisions.list(ANA, w.auditId))).head;
  const filesBefore = [hashTree(w.decisionsDir), hashTree(w.anchorDir)];
  for (const [label, run] of [
    ['nova decisão', () => decisions.create(BIA, w.auditId, { record: rec.c2(), expectedHead: head }, clock())],
    ['revogação', () => decisions.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock())],
  ] as const) {
    const r = await run();
    assert.ok(!r.ok && r.code === 'DECISIONS_HISTORY_UNRESOLVED', `${label}: ${JSON.stringify(r).slice(0, 160)}`);
  }
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir)], filesBefore);
});

test('RESTAURAÇÃO PARCIAL: devolver só o arquivo de decisão ⇒ recibo perdido (testemunhado); devolver também o recibo ⇒ consistente e finalizável de novo', async () => {
  const { w, e } = await sealedAfterRevocation();
  fs.rmSync(anchorPath(w, 2));
  const moved = quarantine(w, 2);
  assert.equal((await must(withWitness(w, e).list(ANA, w.auditId))).witness.status, 'HISTORY_REGRESSED');
  fs.renameSync(moved, entryPath(w, 2)); // restaura SÓ o arquivo
  const half = await must(withWitness(w, e).list(BIA, w.auditId));
  assert.deepEqual([half.witness.status, half.decisions.length, half.finalizable], ['RECEIPT_LOST_WITNESSED', 0, false]);
  const head = half.head;
  await must(withWitness(w, e).revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: head }, clock())); // o autor recria o recibo do MESMO conteúdo
  const whole = await must(withWitness(w, e).list(BIA, w.auditId));
  assert.deepEqual([whole.witness.status, whole.finalizable, whole.allDecisions.map((d) => d.status)], ['CONSISTENT', true, ['REVOKED']]);
  const evaluated = await previewW(w, withWitness(w, e)).evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok && evaluated.value.payload.blockers.every((b) => b.code !== 'DECISIONS_HISTORY_UNRESOLVED'));
});

test('FALHA NA LEITURA DA TESTEMUNHA: cada falha tem o SEU estado e todas falham fechado (nunca "consistente", nunca lista vazia), mesmo sem pendente', async () => {
  const { w, e } = await sealedAfterRevocation();
  const eio: FsOps = faulty({ async readFile() { throw errno('EIO'); } });
  const denied: FsOps = faulty({ async readdir() { throw errno('EACCES'); } });
  const regularFile = path.join(tmpDir('lad-wf-'), 'arquivo-comum');
  fs.writeFileSync(regularFile, 'x');
  const linkToResults = path.join(tmpDir('lad-wl-'), 'link-resultados');
  fs.symlinkSync(e.base, linkToResults);
  const linkToReceipts = path.join(tmpDir('lad-wr-'), 'link-recibos');
  fs.symlinkSync(e.anchors, linkToReceipts);
  const many = Array.from({ length: 2001 }, (_, index) => ({ seq: (index % 90) + 1, sha256: 'a'.repeat(64) }));
  const providers: Array<[string, KnownHeadsProvider, string]> = [
    ['provedor lança', async () => { throw new Error('falha'); }, 'UNAVAILABLE'],
    ['provedor nulo (chamador JavaScript)', null as never, 'UNAVAILABLE'],
    ['resposta nula', (async () => null) as never, 'UNTRUSTED'],
    ['resposta malformada', (async () => ({ ok: true, heads: [{ seq: 'x', sha256: 1 }] })) as never, 'UNTRUSTED'],
    ['seq fora do intervalo', (async () => ({ ok: true, heads: [{ seq: 0, sha256: 'a'.repeat(64) }] })) as never, 'UNTRUSTED'],
    ['indícios malformados', (async () => ({ ok: true, heads: [], unverifiedHeads: [{ seq: 1, sha256: 'curto' }] })) as never, 'UNTRUSTED'],
    ['cabeças em excesso (DoS)', (async () => ({ ok: true, heads: many })) as never, 'UNTRUSTED'],
    ['razão desconhecida', (async () => ({ ok: false, reason: 'OUTRA' })) as never, 'UNAVAILABLE'],
    ['fonte declara-se não configurada', async () => ({ ok: false, reason: 'NOT_CONFIGURED' }), 'NOT_CONFIGURED'],
    ['cadeia de resultados ilegível (EIO)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: eio }), 'UNAVAILABLE'],
    ['diretório de resultados sem permissão (EACCES)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: denied }), 'UNAVAILABLE'],
    ['pasta de resultados inexistente', createResultsKnownHeads({ otherDirs: [], baseDir: path.join(e.base, 'nao-existe'), anchorDir: path.join(e.anchors, 'nao-existe') }), 'UNAVAILABLE'],
    ['pasta de recibos inexistente', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: path.join(e.anchors, 'nao-existe') }), 'UNAVAILABLE'],
    ['caminho relativo (configuração insegura)', createResultsKnownHeads({ otherDirs: [], baseDir: 'relativo', anchorDir: 'relativo-2' }), 'NOT_CONFIGURED'],
    ['resultados e recibos na MESMA pasta', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.base }), 'NOT_CONFIGURED'],
    ['recibos DENTRO da pasta de resultados', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: path.join(e.base, 'recibos') }), 'NOT_CONFIGURED'],
    ['resultados sobrepostos às decisões', createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [e.base] }), 'NOT_CONFIGURED'],
    ['lstat da pasta de resultados falha (EACCES)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: faulty({ async lstat(target) { if (target === e.base) throw errno('EACCES'); return nodeFsOps.lstat(target); } }) }), 'UNAVAILABLE'],
    ['lstat da pasta da auditoria nos resultados falha (EIO)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: faulty({ async lstat(target) { if (target === path.join(e.base, w.auditId)) throw errno('EIO'); return nodeFsOps.lstat(target); } }) }), 'UNAVAILABLE'],
    ['lstat da pasta de recibos falha (EIO)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: faulty({ async lstat(target) { if (target === e.anchors) throw errno('EIO'); return nodeFsOps.lstat(target); } }) }), 'UNAVAILABLE'],
    ['lstat da pasta da auditoria nos recibos falha (EIO)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: faulty({ async lstat(target) { if (target === path.join(e.anchors, w.auditId)) throw errno('EIO'); return nodeFsOps.lstat(target); } }) }), 'UNAVAILABLE'],
    ['listagem dos recibos falha (EACCES)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: faulty({ async readdir(target) { if (target.startsWith(e.anchors)) throw errno('EACCES'); return nodeFsOps.readdir(target); } }) }), 'UNAVAILABLE'],
    ['leitura de um recibo falha (EIO)', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: faulty({ async readFile(target, max) { if (target.startsWith(e.anchors)) throw errno('EIO'); return nodeFsOps.readFile(target, max); } }) }), 'UNAVAILABLE'],
    ['exceção desconhecida na listagem', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors, fs: faulty({ async readdir() { throw new TypeError('falha desconhecida'); } }) }), 'UNAVAILABLE'],
    ['pasta de resultados é um ARQUIVO comum', createResultsKnownHeads({ otherDirs: [], baseDir: regularFile, anchorDir: e.anchors }), 'NOT_CONFIGURED'],
    ['pasta de resultados é um LINK simbólico', createResultsKnownHeads({ otherDirs: [], baseDir: linkToResults, anchorDir: e.anchors }), 'NOT_CONFIGURED'],
    ['pasta de recibos é um LINK simbólico', createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: linkToReceipts }), 'NOT_CONFIGURED'],
  ];
  for (const [label, provider, expected] of providers) {
    const view = await must(withWitness(w, e, provider).list(ANA, w.auditId));
    assert.deepEqual([view.witness.status, view.decisions.length, view.operatorRecords.length, view.finalizable], [expected, 0, 0, false], label);
    assert.deepEqual(view.allDecisions.map((d) => d.status), ['REVOKED'], `${label}: informativo; a decisão revogada NUNCA aparece como vigente`);
    const evaluated = await previewW(w, withWitness(w, e, provider)).evaluate(OP_A, w.auditId);
    assert.ok(evaluated.ok && evaluated.value.payload.finalization.allowed === false && evaluated.value.applied.length === 0, label);
    assert.ok(evaluated.ok && evaluated.value.payload.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.reasonCode === expected), `${label}: o bloqueio traz o estado certo`);
    const r = await withWitness(w, e, provider).create(BIA, w.auditId, { record: rec.c2(), expectedHead: view.head }, clock());
    assert.ok(!r.ok && r.code === 'DECISIONS_HISTORY_UNRESOLVED', `${label}: escrita recusada`);
    const revoke = await withWitness(w, e, provider).revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
    assert.ok(!revoke.ok && revoke.code === 'DECISIONS_HISTORY_UNRESOLVED', `${label}: revogação recusada`);
  }
  // com a leitura restaurada, tudo volta ao normal (nada ficou "travado" em memória)
  assert.equal((await must(withWitness(w, e).list(ANA, w.auditId))).witness.status, 'CONSISTENT');
});

test('OMITIR a testemunha não compila e, se um chamador sem checagem de tipos omitir, o serviço FALHA FECHADO (nunca "sem inconsistência")', async () => {
  const w = await confirmedThenRevoked();
  // @ts-expect-error `knownHeads` é obrigatório: esquecer a testemunha é erro de compilação
  const omitted = createDecisionService({ origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  const view = await must(omitted.list(ANA, w.auditId));
  assert.deepEqual([view.witness.status, view.decisions.length, view.finalizable], ['UNAVAILABLE', 0, false]);
  const r = await omitted.create(BIA, w.auditId, { record: rec.c2(), expectedHead: view.head }, clock());
  assert.ok(!r.ok && r.code === 'DECISIONS_HISTORY_UNRESOLVED');
  // a declaração de dispensa é um símbolo explícito e só existe nos testes da 6B isolada
  const exempt = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir, knownHeads: WITNESS_NOT_REQUIRED });
  assert.equal((await must(exempt.list(ANA, w.auditId))).witness.status, 'NOT_REQUIRED');
});

test('A AUSÊNCIA de testemunha em auditoria SEM resultados é declarada (UNWITNESSED), com a contagem do que ela NÃO cobre — nunca "consistente"', async () => {
  const w = await confirmedThenRevoked();
  const e = resultsEnv(); // pastas existentes e legíveis, mas sem nenhum resultado
  const view = await must(withWitness(w, e).list(ANA, w.auditId));
  assert.deepEqual(view.witness, { status: 'UNWITNESSED', knownHeads: 0, coveredSeq: null, unwitnessedAffecting: 1 });
  assert.equal(view.finalizable, true, 'sem isso a primeira finalização seria impossível (o resultado é a testemunha); o limite é DECLARADO, não escondido');
  const sealed = await sealedAfterRevocation();
  const covered = await must(withWitness(sealed.w, sealed.e).list(ANA, sealed.w.auditId));
  assert.deepEqual(covered.witness, { status: 'CONSISTENT', knownHeads: 1, coveredSeq: 2, unwitnessedAffecting: 0 });
});

test('RESULTADO SELADO ADULTERADO (a própria testemunha corrompida) ⇒ histórico de decisões NÃO resolvido (falha fechada)', async () => {
  const { w, e } = await sealedAfterRevocation();
  const file = path.join(e.base, w.auditId, 's0001.json');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').trimEnd()} \n`); // altera os bytes: o selo/recibo não conferem
  const view = await must(withWitness(w, e).list(BIA, w.auditId));
  assert.deepEqual([view.witness.status, view.decisions.length, view.finalizable], ['UNTRUSTED', 0, false], 'cadeia que não confere = testemunha NÃO confiável (distinto de indisponível)');
});

test('RECIBO DO RESULTADO também removido (duas pastas de recibos) + quarentena da pendente de decisão: o resultado PENDENTE de origem comprovada continua sendo testemunha', async () => {
  const { w, e } = await sealedAfterRevocation();
  fs.rmSync(anchorPath(w, 2));
  fs.rmSync(path.join(e.anchors, w.auditId, 'a0001.json')); // o resultado s1 vira pendente (sem recibo)
  quarantine(w, 2);
  const view = await must(withWitness(w, e).list(BIA, w.auditId));
  assert.deepEqual([view.witness.status, view.decisions.length, view.finalizable], ['HISTORY_REGRESSED', 0, false]);
  // um resultado pendente FORJADO (sem etiqueta) NÃO serve de testemunha: não consegue congelar as decisões de outra auditoria... nem esta
  const forgedEnv = resultsEnv();
  const forgedWorld = await confirmedThenRevoked();
  const forged = JSON.parse(fs.readFileSync(path.join(e.base, w.auditId, 's0001.json'), 'utf8')) as Record<string, unknown>;
  delete forged.origin;
  delete forged.contentSha256;
  fs.mkdirSync(path.join(forgedEnv.base, forgedWorld.auditId), { recursive: true });
  fs.writeFileSync(path.join(forgedEnv.base, forgedWorld.auditId, 's0001.json'), serialize(seal({ ...forged, auditId: forgedWorld.auditId })));
  const provider = createResultsKnownHeads({ otherDirs: [], baseDir: forgedEnv.base, anchorDir: forgedEnv.anchors, origin: TEST_ORIGIN });
  const forgedRead = await provider(forgedWorld.auditId);
  assert.ok(forgedRead.ok && forgedRead.heads.length === 0 && forgedRead.unverifiedHeads?.length === 1, 'forjado: NENHUMA testemunha, apenas um INDÍCIO');
  // consequência DECLARADA (disponibilidade, não integridade): o indício contradiz o histórico desta outra auditoria ⇒ não confiável ⇒ falha fechada
  const frozen = await must(withWitness(forgedWorld, forgedEnv, provider).list(BIA, forgedWorld.auditId));
  assert.deepEqual([frozen.witness.status, frozen.decisions.length, frozen.finalizable], ['UNTRUSTED', 0, false]);
});

test('CONCORRÊNCIA/IDEMPOTÊNCIA: duas conclusões simultâneas da mesma revogação pelo autor ⇒ um único recibo; a repetição devolve o mesmo resultado', async () => {
  const { w, e } = await sealedAfterRevocation();
  fs.rmSync(anchorPath(w, 2));
  const head = (await must(withWitness(w, e).list(ANA, w.auditId))).head;
  const body = { revokes: 'op-0001', reason: REASON, expectedHead: head };
  const results = await Promise.all([withWitness(w, e).revoke(ANA, w.auditId, body, clock()), withWitness(w, e).revoke(ANA, w.auditId, body, clock())]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results).slice(0, 200));
  assert.equal(fs.readdirSync(path.join(w.anchorDir, w.auditId)).filter((n) => n === 'a0002.json').length, 1);
  const again = await must(withWitness(w, e).revoke(ANA, w.auditId, body, clock()));
  assert.equal(again.replayed, true);
});

test('LIMITE DECLARADO (travado em teste): SEM nenhum resultado selado depois da decisão não há testemunha; a quarentena manual de uma pendente PROVEN de revogação reativa a decisão — o sistema NÃO impede, o procedimento proíbe (BLOQUEADOR para produção até haver marcador durável)', async () => {
  const w = await confirmedThenRevoked();
  const e = resultsEnv(); // nenhum resultado
  fs.rmSync(anchorPath(w, 2));
  quarantine(w, 2);
  const view = await must(withWitness(w, e).list(BIA, w.auditId));
  assert.equal(view.witness.status, 'UNWITNESSED', 'a testemunha não tem o que dizer — e o sistema DIZ isso');
  assert.equal(view.witness.unwitnessedAffecting, 0, 'a revogação foi movida: nem a contagem a enxerga');
  assert.deepEqual(view.decisions.map((d) => d.decisionId), ['op-0001'], 'LIMITE: a decisão revogada volta a ser vigente');
});

test('provedor de cabeças: resultados selados ⇒ uma cabeça por resultado; sem resultados ⇒ nenhuma; só confirmados contam (uma pendente não é testemunha)', async () => {
  const { w, e } = await sealedAfterRevocation();
  const heads = await createResultsKnownHeads({ otherDirs: [], baseDir: e.base, anchorDir: e.anchors })(w.auditId);
  assert.ok(heads.ok && heads.heads.length === 1 && heads.heads[0]?.seq === 2 && /^[0-9a-f]{64}$/.test(heads.heads[0]?.sha256 ?? ''), JSON.stringify(heads));
  const none = await createResultsKnownHeads({ otherDirs: [], baseDir: resultsEnv().base, anchorDir: resultsEnv().anchors })(w.auditId);
  assert.deepEqual(none, { ok: true, heads: [], unverifiedHeads: [], hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] }, 'sem resultados: o livro também sabe que NÃO há resultado algum');
  const e2 = resultsEnv();
  const failing: FsOps = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(e2.anchors)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const w2 = await confirmedThenRevoked();
  const d2 = withWitness(w2, e2);
  const ev = await previewW(w2, d2).evaluate(OP_A, w2.auditId);
  assert.ok(ev.ok);
  const pendingRun = await makeService(e2, previewW(w2, d2), { fs: failing as never }).finalize(OP_A, w2.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(!pendingRun.ok && pendingRun.code === 'RESULT_ANCHOR_PENDING', JSON.stringify(pendingRun).slice(0, 200));
  const unreceipted = await createResultsKnownHeads({ otherDirs: [], baseDir: e2.base, anchorDir: e2.anchors })(w2.auditId);
  assert.ok(unreceipted.ok && unreceipted.heads.length === 0 && unreceipted.unverifiedHeads?.length === 1, 'resultado SEM recibo e sem autenticador: apenas INDÍCIO, nunca testemunha');
});

test('evaluateKnownHeads (puro): todos os ramos e prioridades', () => {
  const entry = (seq: number, sha: string) => ({ seq, contentSha256: sha.repeat(64) });
  const head = (seq: number, sha: string) => ({ seq, sha256: sha.repeat(64) });
  const ok = (heads: Array<{ seq: number; sha256: string }>) => ({ ok: true as const, heads });
  const confirmed = [entry(1, 'a'), entry(2, 'b')];
  assert.equal(evaluateKnownHeads(confirmed, null, null).status, 'NOT_REQUIRED');
  assert.equal(evaluateKnownHeads(confirmed, null, { ok: false, reason: 'STORAGE_UNAVAILABLE' }).status, 'UNAVAILABLE');
  assert.equal(evaluateKnownHeads(confirmed, null, ok([])).status, 'UNWITNESSED');
  assert.equal(evaluateKnownHeads(confirmed, null, { ok: false, reason: 'NOT_CONFIGURED' }).status, 'NOT_CONFIGURED');
  assert.equal(evaluateKnownHeads(confirmed, null, { ok: false, reason: 'UNTRUSTED' }).status, 'UNTRUSTED');
  assert.equal(evaluateKnownHeads(confirmed, null, ok([head(1, 'a'), head(2, 'b')])).status, 'CONSISTENT');
  assert.equal(evaluateKnownHeads(confirmed, null, ok([head(2, 'c')])).status, 'HISTORY_DIVERGES');
  assert.equal(evaluateKnownHeads(confirmed, null, ok([head(3, 'c')])).status, 'HISTORY_REGRESSED');
  assert.equal(evaluateKnownHeads(confirmed, entry(3, 'c'), ok([head(3, 'c')])).status, 'RECEIPT_LOST_WITNESSED');
  const lostRevoke = evaluateKnownHeads(confirmed, { ...entry(3, 'c'), affectsPrior: true }, ok([head(3, 'c')]));
  assert.deepEqual([lostRevoke.coveredSeq, lostRevoke.unwitnessedAffecting], [3, 0], 'a testemunha cobre a posição da pendente: nada fica sem cobertura'); // B16b
  const beyond = evaluateKnownHeads([{ ...entry(1, 'a'), affectsPrior: true }, { ...entry(2, 'b'), affectsPrior: true }], null, ok([head(1, 'a')]));
  assert.deepEqual([beyond.status, beyond.coveredSeq, beyond.unwitnessedAffecting], ['CONSISTENT', 1, 1], 'a revogação depois da última cabeça não tem cobertura (declarada)');
  const hint = (heads: Array<{ seq: number; sha256: string }>, unverifiedHeads: Array<{ seq: number; sha256: string }>) => evaluateKnownHeads(confirmed, null, { ok: true, heads, unverifiedHeads });
  assert.equal(hint([], [head(2, 'b')]).status, 'UNWITNESSED', 'indício que confere com o histórico é ignorado e NÃO vira testemunha');
  assert.equal(hint([], [head(2, 'b')]).knownHeads, 0);
  assert.equal(hint([], [head(3, 'c')]).status, 'UNTRUSTED', 'indício além do histórico: não confiável');
  assert.equal(hint([], [head(9, 'z')]).status, 'UNTRUSTED', 'indício MUITO além do histórico (vários passos perdidos): não confiável');
  assert.equal(hint([], [head(1, 'a'), head(1, 'a'), head(2, 'b')]).status, 'UNWITNESSED', 'indícios repetidos e coerentes são ignorados');
  assert.equal(hint([], [head(2, 'z')]).status, 'UNTRUSTED', 'indício com outro hash na mesma posição: não confiável');
  assert.equal(hint([head(1, 'a')], [head(3, 'c')]).status, 'UNTRUSTED', 'testemunha válida não anula um indício que contradiz');
  assert.equal(hint([head(5, 'e')], [head(3, 'c')]).status, 'HISTORY_REGRESSED', 'a regressão de testemunha vence o indício');
  assert.equal(evaluateKnownHeads(confirmed, entry(3, 'c'), ok([head(3, 'd')])).status, 'HISTORY_DIVERGES');
  assert.equal(evaluateKnownHeads(confirmed, entry(3, 'c'), ok([head(4, 'd')])).status, 'HISTORY_REGRESSED', 'além da pendente');
  assert.equal(evaluateKnownHeads(confirmed, entry(3, 'c'), ok([head(3, 'c'), head(5, 'e')])).status, 'HISTORY_REGRESSED', 'a regressão vence a recuperação');
  assert.equal(evaluateKnownHeads(confirmed, entry(3, 'c'), ok([head(3, 'c'), head(1, 'z')])).status, 'HISTORY_DIVERGES', 'a divergência vence tudo');
  assert.equal(evaluateKnownHeads([], null, ok([head(1, 'a')])).status, 'HISTORY_REGRESSED');
});
