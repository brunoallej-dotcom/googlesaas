import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDecisionService, type ListPayload } from '../src/lib/link-audit-decisions';
import { seal, serialize } from '../src/lib/link-audit-storage';
import type { LedgerRecord } from '../src/lib/link-audit-ledger';
import { ANA, anchorPath, BIA, clock, entryPath, hashTree, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerPath, ledgerRecords, ledgerWorld, LEDGER_AUTH_A, LEDGER_AUTH_B, LEDGER_KEY_A, LEDGER_KEY_B, makeRecord, NO_RESULTS, ledgerAuth, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { OTHER_ORIGIN, TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';

/*
 * ATAQUES contra o livro (Q1–Q7, Etapa 4). Modelo principal: quem escreve em UMA pasta (decisões, recibos ou livro), sem as demais e sem as chaves.
 * Cada teste prova duas coisas: o ataque NÃO reativa decisão, NÃO deixa nada finalizável e NÃO é aceito para escrita; e o motivo é o CERTO
 * (estado e razão do livro), não um ambiente incompleto. Casos legítimos (queda entre etapas) seguem recuperáveis.
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';

/** op-0001 criada e revogada (posições 1 e 2 das decisões; livro GENESIS + 2×(INTENT, CONFIRMED)). */
async function revokedWorld(options: Parameters<typeof ledgerWorld>[0] = {}): Promise<LedgerWorld> {
  const w = await ledgerWorld(options);
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.protectedService.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()));
  return w;
}
const away = (file: string): string => {
  const dir = tmpDir('lad-quar-');
  const target = path.join(dir, path.basename(file));
  fs.renameSync(file, target);
  return target;
};
const rewrite = (file: string, text: string): void => {
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
};
/** "Reinício": serviço novo sobre as mesmas pastas (nada em memória). */
const fresh = (w: LedgerWorld, over: { auth?: typeof LEDGER_AUTH_A } = {}) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null, ...(over.auth ? { auth: over.auth } : {}) }), knownHeads: NO_RESULTS });

async function assertFrozen(w: LedgerWorld, service = fresh(w), expectedReason?: string | readonly string[]): Promise<ListPayload> {
  const view = await must(service.list(BIA, w.auditId));
  assert.equal(view.ledger.state, 'HISTORY_UNRESOLVED', JSON.stringify(view.ledger));
  if (expectedReason) assert.ok([expectedReason].flat().includes(view.ledger.reason ?? ''), `razão ${view.ledger.reason}`);
  assert.deepEqual([view.decisions, view.operatorRecords, view.finalizable], [[], [], false], 'nenhuma decisão vigente, motor vazio, nada finalizável');
  assert.ok(view.allDecisions.every((d) => d.status !== 'ACTIVE'), 'a decisão (antes vigente ou revogada) nunca aparece ACTIVE');
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)];
  const write = await service.create(BIA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!write.ok && ['DECISIONS_HISTORY_UNRESOLVED', 'PENDING_UNCONFIRMED'].includes(write.code), `escrita recusada: ${JSON.stringify(write).slice(0, 140)}`);
  const revoke = await service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!revoke.ok, 'revogação (ou conclusão por quem não é o autor) recusada');
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)], before, 'nada foi gravado em nenhuma pasta');
  return view;
}

test('RECIBO da revogação removido (só a pasta de recibos): a decisão revogada NÃO volta a ACTIVE — o livro prova que o recibo EXISTIU; a reemissão legítima pelo autor fica REGISTRADA', async () => {
  const w = await revokedWorld();
  fs.rmSync(anchorPath(w, 2));
  const view = await must(fresh(w).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.receiptReissuable, view.decisions, view.finalizable], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', true, [], false]);
  assert.deepEqual(view.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'AMBIGUOUS']]);
  // outro operador não conclui; o autor reenviando o MESMO pedido recria o recibo de mesmo conteúdo, com a reemissão registrada ANTES
  const other = await fresh(w).revoke(BIA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!other.ok, 'só o autor conclui');
  assert.ok(!fs.existsSync(anchorPath(w, 2)), 'o recibo não foi recriado por quem não é o autor');
  const done = await must(fresh(w).revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock()));
  assert.equal(done.revoked.status, 'REVOKED');
  assert.ok(fs.existsSync(anchorPath(w, 2)));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'INTENT', 'CONFIRMED', 'RECEIPT_REISSUED'], 'a evidência do incidente não se perde');
  const after = await must(fresh(w).list(BIA, w.auditId));
  assert.deepEqual([after.ledger.state, after.finalizable, after.allDecisions.map((d) => d.status)], ['PROTECTED', true, ['REVOKED']]);
});

test('QUARENTENA da pendência (recibo removido + arquivo movido): o BLOQUEADOR da janela sem testemunha está FECHADO para auditoria protegida — mesmo SEM nenhum resultado selado, e depois de reiniciar', async () => {
  const w = await revokedWorld();
  fs.rmSync(anchorPath(w, 2)); // quem escreve só nos recibos…
  away(entryPath(w, 2)); // …e o operador "resolve" mandando o arquivo da revogação para a quarentena
  for (const label of ['logo depois', 'depois de reiniciar', 'depois de reiniciar outra vez']) {
    const view = await assertFrozen(w, fresh(w), 'HISTORY_REGRESSED');
    assert.deepEqual(view.allDecisions.map((d) => d.status), ['AMBIGUOUS'], label);
  }
  // o livro continua afirmando as duas posições: a evidência do retrocesso permanece
  assert.equal((await ledgerRecords(w)).filter((record) => record.event === 'CONFIRMED').length, 2);
});

test('RETROCESSO por exclusão de decisão: sem recibo e arquivo (duas pastas) ⇒ REGRESSED; só o arquivo ⇒ truncamento detectado pela 6B (nenhum dado); só a pasta de recibos inteira ⇒ nada vigente', async () => {
  const w = await revokedWorld();
  const copyDec = path.join(w.decisionsDir, w.auditId);
  const backup = tmpDir('lad-bkp-');
  fs.cpSync(copyDec, path.join(backup, 'dec'), { recursive: true });
  fs.cpSync(path.join(w.anchorDir, w.auditId), path.join(backup, 'anc'), { recursive: true });
  // (a) A1 apenas: arquivo da revogação removido, recibo permanece ⇒ a 6B acusa truncamento e NENHUM dado é devolvido
  fs.rmSync(entryPath(w, 2));
  const truncated = await fresh(w).list(BIA, w.auditId);
  assert.ok(!truncated.ok && ['DECISIONS_TRUNCATED', 'ANCHOR_INTEGRITY', 'DECISIONS_INTEGRITY'].includes(truncated.code), JSON.stringify(truncated).slice(0, 120));
  // (b) A1 + A2: arquivo e recibo da última ⇒ o livro ainda afirma a posição 2
  fs.rmSync(anchorPath(w, 2));
  await assertFrozen(w, fresh(w), 'HISTORY_REGRESSED');
  // (c) tudo das decisões removido (as duas pastas) ⇒ o livro afirma 2 posições que não existem mais
  fs.rmSync(path.join(w.decisionsDir, w.auditId), { recursive: true });
  fs.rmSync(path.join(w.anchorDir, w.auditId), { recursive: true });
  await assertFrozen(w, fresh(w), 'HISTORY_REGRESSED');
  // (d) restaurar o par do mesmo instante (backup independente) devolve a auditoria íntegra
  fs.cpSync(path.join(backup, 'dec'), path.join(w.decisionsDir, w.auditId), { recursive: true });
  fs.cpSync(path.join(backup, 'anc'), path.join(w.anchorDir, w.auditId), { recursive: true });
  assert.equal((await must(fresh(w).list(BIA, w.auditId))).ledger.state, 'PROTECTED');
});

test('TRUNCAMENTO do livro: o último CONFIRMED sozinho é a queda entre o recibo e o livro (recuperável, nada vigente enquanto isso); o resto truncado deixa entradas FORA do livro (NÃO resolvido); nunca "cabeça vazia"', async () => {
  const w = await revokedWorld();
  // (a) só o CONFIRMED da revogação some: indistinguível de uma queda legítima ⇒ atrasado de um, recuperável
  const confirmed2 = away(ledgerPath(w, 5));
  const behind = await must(fresh(w).list(BIA, w.auditId));
  assert.deepEqual([behind.ledger.reason, behind.ledger.recoverable, behind.decisions, behind.finalizable], ['LEDGER_BEHIND', true, [], false]);
  const recovered = await must(fresh(w).ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock()));
  assert.equal(recovered.ledger.state, 'PROTECTED', 'a recuperação conclui o CONFIRMED verificável');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'INTENT', 'CONFIRMED']);
  // (b) o CONFIRMED E o INTENT da revogação somem: a revogação deixa de ter registro no livro
  away(ledgerPath(w, 5));
  away(ledgerPath(w, 4));
  await assertFrozen(w, fresh(w), 'UNLEDGERED_ENTRY');
  // (c) tudo menos o GENESIS
  for (const seq of [3, 2]) away(ledgerPath(w, seq));
  await assertFrozen(w, fresh(w), 'UNLEDGERED_ENTRY');
  void confirmed2;
});

test('livro APAGADO (pasta da auditoria ou raiz trocada por uma vazia): auditoria com histórico vira LEGADA/restrita e NADA é reinicializado em silêncio; auditoria vazia volta a pedir inscrição EXPLÍCITA', async () => {
  const w = await revokedWorld();
  fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)];
  const view = await must(fresh(w).list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions, view.finalizable], ['LEGACY_READ_ONLY', 'LEDGER_ABSENT_WITH_HISTORY', [], false]);
  const write = await fresh(w).create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!write.ok && write.code === 'LEDGER_LEGACY_READ_ONLY');
  const enroll = await fresh(w).ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!enroll.ok && enroll.code === 'ADMIN_APPROVAL_UNAVAILABLE', 'não existe reinscrição automática nem por operador comum');
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)], before, 'nenhum GENESIS foi criado');
  // a RAIZ do livro some (volume não montado): armazenamento indisponível, não "livro vazio"
  const gone = path.join(w.ledgerDir, '..', `raiz-removida-${path.basename(w.ledgerDir)}`);
  fs.renameSync(w.ledgerDir, gone);
  const unavailable = await must(fresh(w).list(BIA, w.auditId));
  assert.deepEqual([unavailable.ledger.state, unavailable.ledger.reason, unavailable.decisions], ['HISTORY_UNRESOLVED', 'UNAVAILABLE', []]);
  // um volume NOVO e VAZIO no lugar: auditoria com histórico continua legada
  fs.mkdirSync(w.ledgerDir);
  assert.equal((await must(fresh(w).list(BIA, w.auditId))).ledger.state, 'LEGACY_READ_ONLY');
  // auditoria sem nenhum histórico (nova) num livro vazio: inscrição pendente, nunca protegida sozinha
  const empty = await ledgerWorld({ enroll: false, auditId: 'auditoria-nova-0001' });
  assert.equal((await must(empty.rawProtected.list(ANA, empty.auditId))).ledger.state, 'ENROLLMENT_PENDING');
});

test('FALSIFICAÇÃO sem a chave do livro: registro adicionado, editado com hash refeito, de outra chave ou assinado com a chave de ORIGEM ⇒ NÃO confiável; a cabeça atual não pode ser inventada', async () => {
  const w = await revokedWorld();
  const records = await ledgerRecords(w);
  const tail = records[records.length - 1] as LedgerRecord;
  const publishForged = (record: LedgerRecord): void => rewrite(ledgerPath(w, record.ledgerSeq), serialize(record));
  // (a) registro novo encadeado, com etiqueta de OUTRA chave do livro
  fs.writeFileSync(ledgerPath(w, tail.ledgerSeq + 1), serialize(makeRecord(LEDGER_AUTH_B, w.auditId, tail, { event: 'CHECKPOINT', recordedAt: new Date(Date.parse(tail.recordedAt) + 1000).toISOString(), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } })));
  await assertFrozen(w, fresh(w), ['KEY_UNKNOWN', 'UNTRUSTED']);
  fs.rmSync(ledgerPath(w, tail.ledgerSeq + 1));
  // (b) corpo editado + hash refeito (sem a chave a etiqueta não confere)
  const { contentSha256: dropped, ...body } = tail;
  void dropped;
  const edited = seal({ ...body, actor: 'intruso@empresa.com' }) as LedgerRecord;
  publishForged(edited);
  await assertFrozen(w, fresh(w), 'UNTRUSTED');
  publishForged(tail); // restaura o original
  assert.equal((await must(fresh(w).list(BIA, w.auditId))).ledger.state, 'PROTECTED', 'o original volta a valer (nada ficou preso)');
  // (c) a chave de ORIGEM (comprometida, p.ex.) não autentica o livro: finalidade e derivação próprias
  const originSigned = seal({ ...body, origin: { v: 1, kid: 'ok-test-a', tag: TEST_ORIGIN.sign('DECISION', body).tag } }) as LedgerRecord;
  publishForged(originSigned);
  await assertFrozen(w, fresh(w), ['UNTRUSTED', 'KEY_UNKNOWN']);
  publishForged(tail);
  assert.equal((await must(fresh(w).list(BIA, w.auditId))).ledger.state, 'PROTECTED');
});

test('INTENT / pendente FABRICADOS: sem a chave nenhum INTENT é aceito; uma pendente fora do livro (ou diferente da do INTENT) NUNCA é concluída — nenhum recibo, nenhum CONFIRMED', async () => {
  const w = await revokedWorld();
  const view = await must(fresh(w).list(ANA, w.auditId));
  // (a) pendente forjada na pasta de decisões (arquivo bem formado, SEM INTENT no livro): o autor nomeado não consegue concluí-la
  const forgedPending = path.join(w.decisionsDir, w.auditId, 'd0003.json');
  const source = JSON.parse(fs.readFileSync(entryPath(w, 1), 'utf8')) as Record<string, unknown>;
  const { contentSha256: ignored, origin: dropped, ...rest } = source;
  void ignored;
  void dropped;
  fs.writeFileSync(forgedPending, serialize(seal({ ...rest, seq: 3, prevSha256: (JSON.parse(fs.readFileSync(entryPath(w, 2), 'utf8')) as { contentSha256: string }).contentSha256, decisionId: 'op-0003' })));
  const frozen = await must(fresh(w).list(ANA, w.auditId));
  assert.deepEqual([frozen.ledger.state, frozen.ledger.reason, frozen.finalizable], ['HISTORY_UNRESOLVED', 'UNLEDGERED_PENDING', false]);
  const before = [hashTree(w.anchorDir), hashTree(w.ledgerDir)];
  const replay = await fresh(w).create(ANA, w.auditId, { record: source.record as never, expectedHead: view.head }, clock());
  assert.ok(!replay.ok, 'a pendente forjada não vira confirmada pelo reenvio do autor nomeado');
  assert.deepEqual([hashTree(w.anchorDir), hashTree(w.ledgerDir)], before, 'nenhum recibo, nenhum registro no livro');
  fs.rmSync(forgedPending);
  // (b) INTENT adicionado ao livro sem a chave correta ⇒ não confiável
  const records = await ledgerRecords(w);
  const tail = records[records.length - 1] as LedgerRecord;
  const op = { ...(records[1]?.op as NonNullable<LedgerRecord['op']>), decisionSeq: 3, prevDecisionsHead: { seq: 2, sha256: (tail.op as NonNullable<LedgerRecord['op']>).newDecisionsHead.sha256 }, newDecisionsHead: { seq: 3, sha256: 'a'.repeat(64) }, opId: 'f'.repeat(32), decisionId: 'op-0003' };
  fs.writeFileSync(ledgerPath(w, tail.ledgerSeq + 1), serialize(makeRecord(LEDGER_AUTH_B, w.auditId, tail, { event: 'INTENT', recordedAt: new Date(Date.parse(tail.recordedAt) + 1000).toISOString(), actor: 'ana@empresa.com', op })));
  await assertFrozen(w, fresh(w), ['KEY_UNKNOWN', 'UNTRUSTED']);
});

test('INTENT legítimo + entrada DIFERENTE publicada na mesma posição por quem escreve só em decisões: não casa com o INTENT ⇒ NÃO resolvido; o recibo e o CONFIRMED não nascem', async () => {
  const w = await ledgerWorld();
  // um INTENT aberto de verdade: a escrita "morre" depois do INTENT (publicação da entrada falha por queda simulada)
  const crashing = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }) });
  const view = await must(crashing.list(ANA, w.auditId));
  const boom = (await import('./helpers/link-audit-evidence-fixtures')).faulty({ async link() { throw Object.assign(new Error('queda'), { code: 'EACCES' }); } });
  const dying = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), fs: boom });
  const failed = await dying.create(ANA, w.auditId, { record: rec.c2(), expectedHead: view.head }, clock());
  assert.ok(!failed.ok);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'INTENT aberto, entrada não publicada');
  // o atacante publica OUTRA entrada nessa posição (conteúdo e hash diferentes) e um recibo para ela
  const shaped = path.join(w.decisionsDir, w.auditId);
  fs.mkdirSync(shaped, { recursive: true });
  const other = seal({ schemaVersion: 1, kind: 'LINK_AUDIT_DECISION', auditId: w.auditId, action: 'REVOKE', seq: 1, prevSha256: null, revokes: 'op-0099', reason: 'forjada por quem escreve só na pasta de decisões', recordedAt: clock(), recordedBy: 'ana@empresa.com' });
  fs.writeFileSync(path.join(shaped, 'd0001.json'), serialize(other));
  const verdict = await fresh(w).list(BIA, w.auditId);
  assert.ok(!verdict.ok || verdict.value.ledger.state !== 'PROTECTED', 'nunca protegida com uma entrada que o INTENT não descreve');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'nada foi confirmado');
});

test('CHAVE DO LIVRO COMPROMETIDA: registros assinados por ela ⇒ KEY_REVOKED (SEMPRE); quem a tem não consegue estender o livro; a configuração não aceita manter o material de um id revogado', async () => {
  const w = await revokedWorld();
  const rotated = ledgerAuth({ current: LEDGER_KEY_B, revokedIds: ['lk-test-a'] });
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth: rotated }), knownHeads: NO_RESULTS });
  await assertFrozen(w, service, 'KEY_REVOKED');
  // o atacante com a chave A tenta estender o livro com um CHECKPOINT "legítimo": continua KEY_REVOKED (a chave nova NÃO limpa o que a antiga assinou)
  const records = await ledgerRecords(w);
  const tail = records[records.length - 1] as LedgerRecord;
  fs.writeFileSync(ledgerPath(w, tail.ledgerSeq + 1), serialize(makeRecord(LEDGER_AUTH_A, w.auditId, tail, { event: 'CHECKPOINT', recordedAt: new Date(Date.parse(tail.recordedAt) + 1000).toISOString(), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } })));
  await assertFrozen(w, service, 'KEY_REVOKED');
  // nenhuma escrita chega a assinar com a chave nova sobre um histórico que não é confiável
  assert.equal((await ledgerRecords(w)).filter((record) => record.origin.kid === 'lk-test-b').length, 0);
  // material de id revogado ainda configurado é erro de configuração (o autenticador nem é criado)
  assert.throws(() => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-11-30`], revokedIds: ['lk-test-a'], now: () => new Date(Date.UTC(2026, 9, 25)) }), /revogada|configurada/i);
});

test('CONFIRMAR o que não pode ser comprovado: livro atrasado de um com a ORIGEM da decisão não comprovável (chave de origem trocada) NÃO é concluído em nome de ninguém', async () => {
  const w = await ledgerWorld();
  const head = (await must(w.rawProtected.list(ANA, w.auditId))).head;
  const lost = tmpDir('lad-lost-');
  // fabrica a queda entre o recibo e o CONFIRMED: grava e depois afasta o CONFIRMED
  await must(w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: head }, clock()));
  fs.renameSync(ledgerPath(w, 3), path.join(lost, 'l000003.json'));
  const rotatedOrigin = createDecisionService({ baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir, origin: OTHER_ORIGIN, knownHeads: NO_RESULTS, ledger: ledgerFor(w, { guard: null }) });
  const view = await must(rotatedOrigin.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.reason, view.ledger.recoverable], ['BEHIND_UNVERIFIABLE', false]);
  const before = hashTree(w.ledgerDir);
  const recover = await rotatedOrigin.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!recover.ok && recover.code === 'DECISIONS_HISTORY_UNRESOLVED', JSON.stringify(recover).slice(0, 160));
  assert.deepEqual(hashTree(w.ledgerDir), before, 'nenhum CONFIRMED foi gravado');
  // com a origem comprovável a MESMA recuperação funciona (era a prova que faltava)
  const recovered = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS }).ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock()));
  assert.equal(recovered.ledger.state, 'PROTECTED');
});

test('uma escrita só chega ao livro com a ordem certa e SEM sobrescrever: tentar regravar uma posição do livro é recusado (CONFLICT) e o conteúdo original permanece byte a byte', async () => {
  const w = await revokedWorld();
  const before = fs.readFileSync(ledgerPath(w, 3));
  const records = await ledgerRecords(w);
  const { publishLedgerRecord } = await import('../src/lib/link-audit-ledger');
  const result = await publishLedgerRecord(w.ledgerDir, { ...(records[2] as LedgerRecord) });
  assert.ok(!result.ok && result.code === 'CONFLICT');
  assert.deepEqual(fs.readFileSync(ledgerPath(w, 3)), before);
});
