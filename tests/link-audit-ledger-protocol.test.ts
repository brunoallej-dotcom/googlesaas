import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createUnconfiguredLedger, ledgerConfigFromEnv, LEDGER_DIR_ENV, LEDGER_KEY_ENV, LEDGER_REVOKED_IDS_ENV, LEDGER_RETIRED_KEYS_ENV } from '../src/lib/link-audit-ledger';
import { ORIGIN_KEY_ENV } from '../src/lib/link-audit-origin';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, anchorPath, BIA, clock, entryPath, hashTree, must, rec, registerCleanup, tmpDir, world } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFiles, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS } from './helpers/link-audit-ledger-fixtures';
import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import { TEST_ORIGIN_KEY, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * PROTOCOLO do livro de cabeças sobre o serviço REAL de decisões: estados (Q1), ordem INTENT → entrada + recibo → CONFIRMED → sucesso, relação entre
 * decisão e livro, recusas fechadas e ações administrativas BLOQUEADAS (Q5/Q7). A chave do livro é exclusiva (Q3).
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';

test('auditoria NOVA exige inscrição explícita: antes dela nada é gravado (nem decisão, nem pasta, nem livro); a inscrição escreve o GENESIS e só então as decisões funcionam', async () => {
  const w = await ledgerWorld({ enroll: false });
  const before = await must(w.rawProtected.list(ANA, w.auditId));
  assert.deepEqual([before.ledger.state, before.ledger.reason, before.finalizable, before.decisions.length], ['ENROLLMENT_PENDING', null, false, 0]);
  const dirsBefore = [hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)];
  const refused = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_ENROLLMENT_REQUIRED', JSON.stringify(refused).slice(0, 160));
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)], dirsBefore, 'nada gravado');
  assert.deepEqual(fs.readdirSync(w.decisionsDir), [], 'nem a pasta da auditoria foi criada');

  const enrolled = await must(w.rawProtected.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock()));
  assert.deepEqual([enrolled.action, enrolled.ledger.state, enrolled.ledger.confirmedDecisions, enrolled.ledger.head?.ledgerSeq], ['ENROLL', 'PROTECTED', 0, 1]);
  const [genesis] = await ledgerRecords(w);
  assert.deepEqual([genesis?.event, genesis?.actor, genesis?.genesis, genesis?.prevSha256, genesis?.origin.kid], ['GENESIS', 'ana@empresa.com', { mode: 'EMPTY' }, null, 'lk-test-a']);
  const again = await w.rawProtected.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!again.ok && again.code === 'LEDGER_ACTION_INVALID', 'inscrever duas vezes não faz nada');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS']);
  assert.ok((await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock())).ok);
});

test('ordem e relação: GENESIS, INTENT, CONFIRMED por operação; opId, posições, cabeças anterior/nova, identidade, ids da decisão e referência do recibo ficam registrados e batem com a 6B', async () => {
  const w = await ledgerWorld();
  const created = await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const revoked = await must(w.protectedService.revoke(BIA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()));
  assert.equal(revoked.revoked.status, 'REVOKED');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'INTENT', 'CONFIRMED']);
  const records = await ledgerRecords(w);
  const [genesis, intent1, confirmed1, intent2, confirmed2] = records;
  for (const [index, record] of records.entries()) {
    assert.equal(record.ledgerSeq, index + 1);
    assert.equal(record.prevSha256, index === 0 ? null : records[index - 1]?.contentSha256, 'encadeado');
    assert.equal(record.auditId, w.auditId);
  }
  assert.equal(genesis?.actor, 'ana@empresa.com');
  // 1ª operação: criação por ANA
  assert.deepEqual([intent1?.op?.action, intent1?.op?.author, intent1?.actor, intent1?.op?.decisionSeq, intent1?.op?.prevDecisionsHead, intent1?.op?.decisionId, intent1?.op?.affectsPrior], ['RECORD', 'ana@empresa.com', 'ana@empresa.com', 1, null, 'op-0001', false]);
  assert.deepEqual([confirmed1?.op?.opId, confirmed1?.op?.intentSeq, confirmed1?.op?.newDecisionsHead, confirmed1?.op?.anchorRef?.name], [intent1?.op?.opId, 2, intent1?.op?.newDecisionsHead, 'a0001.json']);
  assert.equal(confirmed1?.op?.anchorRef?.headSha256, intent1?.op?.newDecisionsHead.sha256);
  // 2ª operação: revogação por BIA, encadeada à cabeça anterior das decisões
  assert.deepEqual([intent2?.op?.action, intent2?.op?.author, intent2?.op?.revokes, intent2?.op?.decisionId, intent2?.op?.affectsPrior, intent2?.op?.decisionSeq], ['REVOKE', 'bia@empresa.com', 'op-0001', null, true, 2]);
  assert.deepEqual(intent2?.op?.prevDecisionsHead, intent1?.op?.newDecisionsHead);
  assert.notEqual(intent2?.op?.opId, intent1?.op?.opId);
  assert.deepEqual([confirmed2?.op?.intentSeq, confirmed2?.op?.anchorRef?.name], [4, 'a0002.json']);
  // as cabeças do livro são exatamente as entradas da 6B
  const listed = await must(w.rawProtected.list(ANA, w.auditId));
  assert.equal(listed.head?.sha256, confirmed2?.op?.newDecisionsHead.sha256);
  assert.deepEqual([listed.ledger.state, listed.ledger.confirmedDecisions, listed.ledger.head?.ledgerSeq, listed.ledger.openOperation, listed.finalizable], ['PROTECTED', 2, 5, null, true]);
  assert.equal(created.decision.decisionId, 'op-0001');
});

test('reenvio de um pedido já confirmado é idempotente: mesma resposta, nenhum registro novo no livro', async () => {
  const w = await ledgerWorld();
  const head = (await must(w.rawProtected.list(ANA, w.auditId))).head;
  const body = { record: rec.c2(), expectedHead: head };
  const first = await must(w.rawProtected.create(ANA, w.auditId, body, clock()));
  const events = await ledgerEvents(w);
  const second = await must(w.rawProtected.create(ANA, w.auditId, body, clock()));
  assert.deepEqual([first.replayed, second.replayed, second.decision.decisionId], [false, true, 'op-0001']);
  assert.deepEqual(await ledgerEvents(w), events);
});

test('o sucesso só vem DEPOIS do CONFIRMED: se o livro não grava o CONFIRMED a resposta é erro, a decisão fica atrás do livro (nunca vigente) e o MESMO pedido a conclui', async () => {
  let failConfirmed = true;
  const ledgerFs = faulty({
    async writeExclusive(target, data, mode) {
      if (failConfirmed && target.includes('l000003.json')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await ledgerWorld({ ledgerFs });
  const head = (await must(w.rawProtected.list(ANA, w.auditId))).head;
  const body = { record: rec.c2(), expectedHead: head };
  const failed = await w.rawProtected.create(ANA, w.auditId, body, clock());
  assert.ok(!failed.ok && failed.code === 'LEDGER_UNAVAILABLE', JSON.stringify(failed).slice(0, 200));
  assert.ok(fs.existsSync(entryPath(w, 1)) && fs.existsSync(anchorPath(w, 1)), 'a decisão e o recibo existem');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'o livro tem só o INTENT');
  const view = await must(w.rawProtected.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.recoverable, view.decisions.length, view.finalizable], ['HISTORY_UNRESOLVED', 'LEDGER_BEHIND', true, 0, false], 'atrasado: nada vigente enquanto não recuperado');
  assert.ok(view.allDecisions.every((d) => d.status !== 'ACTIVE'));
  // outro operador tentando escrever recupera o CONFIRMED (verificável) e só então segue (aqui o pedido dele é recusado por cabeça velha, com o livro já recuperado)
  failConfirmed = false;
  const retried = await must(w.rawProtected.create(ANA, w.auditId, body, clock()));
  assert.deepEqual([retried.replayed, retried.decision.decisionId], [true, 'op-0001'], 'o reenvio idêntico devolve o resultado, sem duplicar');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  assert.equal((await must(w.rawProtected.list(BIA, w.auditId))).ledger.state, 'PROTECTED');
});

test('se o INTENT não pode ser gravado NADA é publicado: a decisão não existe, o livro não mudou, a resposta é erro', async () => {
  const ledgerFs = faulty({
    async writeExclusive(target, data, mode) {
      if (target.includes('l000002.json')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await ledgerWorld({ ledgerFs });
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)];
  const failed = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock());
  assert.ok(!failed.ok && failed.code === 'LEDGER_UNAVAILABLE', JSON.stringify(failed).slice(0, 200));
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)], before);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS']);
});

test('auditoria LEGADA (histórico sem livro): consulta restrita, nenhuma decisão vigente, escrita recusada e NENHUMA cabeça vazia é criada', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const ledgerDir = tmpDir('lad-led-');
  const ledger = ledgerFor({ ledgerDir, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir], guard: undefined as never }, { guard: null });
  const service = decisionsOver(w, { ledger });
  const view = await must(service.list(BIA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.finalizable, view.decisions, view.operatorRecords], ['LEGACY_READ_ONLY', 'LEDGER_ABSENT_WITH_HISTORY', false, [], []]);
  assert.deepEqual(view.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'AMBIGUOUS']], 'consultável, mas nunca ACTIVE');
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(ledgerDir)];
  const write = await service.create(BIA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!write.ok && write.code === 'LEDGER_LEGACY_READ_ONLY');
  const revoke = await service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!revoke.ok && revoke.code === 'LEDGER_LEGACY_READ_ONLY');
  const enroll = await service.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!enroll.ok && enroll.code === 'ADMIN_APPROVAL_UNAVAILABLE', 'histórico existente só entra por adoção administrativa (bloqueada)');
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(ledgerDir)], before, 'nada gravado, livro intocado');
  assert.deepEqual(fs.readdirSync(ledgerDir), [], 'o livro NÃO nasceu sozinho');
});

test('AÇÕES ADMINISTRATIVAS (adoção, RESTORE_ACK, QUARANTINE_ACK) ficam BLOQUEADAS: não existe papel administrativo, nada é simulado nem gravado — nem em auditoria protegida', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)];
  for (const action of ['ADOPT', 'RESTORE_ACK', 'QUARANTINE_ACK']) {
    const result = await w.rawProtected.ledgerAction(ANA, w.auditId, { action }, clock());
    assert.ok(!result.ok && result.code === 'ADMIN_APPROVAL_UNAVAILABLE', `${action}: ${JSON.stringify(result).slice(0, 120)}`);
  }
  for (const body of [{ action: 'ENROLL', extra: 1 }, { action: 'FORCE' }, {}, { action: 'RESTORE_ACK', approvedBy: 'eu' }] as const) {
    const bad = await w.rawProtected.ledgerAction(ANA, w.auditId, body, clock());
    assert.ok(!bad.ok && (bad.code === 'INVALID_BODY' || bad.code === 'FORBIDDEN_FIELDS'), `corpo estrito: ${JSON.stringify(body)}`);
  }
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(w.ledgerDir)], before);
});

test('livro NÃO configurado, ausente, ilegível, relativo ou sobreposto: falha fechada com o rótulo certo; consulta informativa sem decisão vigente; nunca "cabeça vazia"', async () => {
  const w = await world();
  const protectedWorld = await ledgerWorld();
  await must(protectedWorld.protectedService.create(ANA, protectedWorld.auditId, { record: rec.c2() }, clock()));
  const cases: Array<[string, () => ReturnType<typeof decisionsOver>, string]> = [
    ['porta não configurada', () => decisionsOver(protectedWorld, { ledger: createUnconfiguredLedger() }), 'NOT_CONFIGURED'],
    ['raiz do livro inexistente', () => decisionsOver(protectedWorld, { ledger: ledgerFor({ ...protectedWorld, ledgerDir: path.join(protectedWorld.ledgerDir, 'nao-existe') }, { guard: null }) }), 'UNAVAILABLE'],
    ['caminho relativo', () => decisionsOver(protectedWorld, { ledger: ledgerFor({ ...protectedWorld, ledgerDir: 'livro-relativo' }, { guard: null }) }), 'NOT_CONFIGURED'],
    ['livro dentro da pasta de decisões', () => decisionsOver(protectedWorld, { ledger: ledgerFor({ ...protectedWorld, ledgerDir: path.join(protectedWorld.decisionsDir, 'livro') }, { guard: null }) }), 'NOT_CONFIGURED'],
    ['livro igual à pasta de recibos', () => decisionsOver(protectedWorld, { ledger: ledgerFor({ ...protectedWorld, ledgerDir: protectedWorld.anchorDir }, { guard: null }) }), 'NOT_CONFIGURED'],
    ['listagem do livro falha (EACCES)', () => decisionsOver(protectedWorld, { ledger: ledgerFor(protectedWorld, { guard: null, fs: faulty({ async readdir(dir) { if (dir.startsWith(protectedWorld.ledgerDir)) throw errno('EACCES'); return nodeFsOps.readdir(dir); } }) }) }), 'UNAVAILABLE'],
    ['leitura de um registro falha (EIO)', () => decisionsOver(protectedWorld, { ledger: ledgerFor(protectedWorld, { guard: null, fs: faulty({ async readFile(target, max) { if (target.startsWith(protectedWorld.ledgerDir)) throw errno('EIO'); return nodeFsOps.readFile(target, max); } }) }) }), 'UNAVAILABLE'],
  ];
  for (const [label, build, reason] of cases) {
    const service = build();
    const view = await must(service.list(BIA, protectedWorld.auditId));
    assert.deepEqual([view.ledger.state, view.ledger.reason, view.finalizable, view.decisions, view.operatorRecords], ['HISTORY_UNRESOLVED', reason, false, [], []], label);
    assert.ok(view.allDecisions.every((d) => d.status !== 'ACTIVE'), `${label}: nada ACTIVE`);
    const head = view.head;
    const write = await service.create(ANA, protectedWorld.auditId, { record: rec.c3(), expectedHead: head }, clock());
    assert.ok(!write.ok && (write.code === 'LEDGER_NOT_CONFIGURED' || write.code === 'DECISIONS_HISTORY_UNRESOLVED'), `${label}: escrita recusada ${JSON.stringify(write).slice(0, 100)}`);
  }
  void w;
});

test('configuração do ambiente (Q2/Q3): pasta absoluta + chave EXCLUSIVA; ausente, relativa, fraca, malformada ou igual (id ou material) à de origem ⇒ recusada', () => {
  const dir = '/data/gmn-link-audit-ledger';
  const ok = ledgerConfigFromEnv({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: LEDGER_KEY_A });
  assert.ok(ok.ok && ok.dir === dir && ok.authenticator.keyId === 'lk-test-a');
  const code = (env: Record<string, string | undefined>) => {
    const config = ledgerConfigFromEnv(env);
    return config.ok ? 'OK' : config.code;
  };
  assert.equal(code({ [LEDGER_KEY_ENV]: LEDGER_KEY_A }), 'LEDGER_DIR_NOT_CONFIGURED');
  assert.equal(code({ [LEDGER_DIR_ENV]: 'relativo', [LEDGER_KEY_ENV]: LEDGER_KEY_A }), 'LEDGER_DIR_NOT_CONFIGURED');
  assert.equal(code({ [LEDGER_DIR_ENV]: dir }), 'LEDGER_KEY_NOT_CONFIGURED');
  assert.equal(code({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: `lk-fraca-a:${'0'.repeat(64)}` }), 'LEDGER_KEY_WEAK');
  assert.equal(code({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: 'senha-humana' }), 'LEDGER_KEY_WEAK');
  assert.equal(code({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: LEDGER_KEY_A, [LEDGER_REVOKED_IDS_ENV]: 'lk-test-a' }), 'LEDGER_CONFIG_INVALID', 'revogada ainda configurada');
  // SEPARAÇÃO: nenhuma chave do livro repete id ou material de uma chave de origem
  const originMaterial = TEST_ORIGIN_KEY.split(':')[1] as string;
  assert.equal(code({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: LEDGER_KEY_A, [ORIGIN_KEY_ENV]: TEST_ORIGIN_KEY }), 'OK', 'chaves diferentes');
  assert.equal(code({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: `lk-test-a:${originMaterial}`, [ORIGIN_KEY_ENV]: TEST_ORIGIN_KEY }), 'LEDGER_CONFIG_INVALID', 'mesmo MATERIAL da chave de origem');
  assert.equal(code({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: testKeySpec('ok-test-a', 'ledger-x'), [ORIGIN_KEY_ENV]: TEST_ORIGIN_KEY }), 'LEDGER_CONFIG_INVALID', 'mesmo ID da chave de origem');
  assert.notEqual(code({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: LEDGER_KEY_B, [LEDGER_RETIRED_KEYS_ENV]: `${testKeySpec('lk-test-r', 'ledger-r')}:2099-01-01` }), 'OK', 'aposentada com validade acima do teto (ou sem relógio) é recusada');
  assert.ok(!JSON.stringify(ledgerConfigFromEnv({ [LEDGER_DIR_ENV]: dir, [LEDGER_KEY_ENV]: 'senha-humana' })).includes('senha-humana'), 'nenhum material nas respostas de erro');
});

test('ISOLAMENTO entre auditorias: cada uma tem seu livro; registros de uma não valem na outra (o auditId está na etiqueta); operar numa não toca a outra', async () => {
  const a = await ledgerWorld({ auditId: 'auditoria-iso-aaaa' });
  const second = await ledgerWorld({ auditId: 'auditoria-iso-bbbb' });
  await must(a.protectedService.create(ANA, a.auditId, { record: rec.c2() }, clock()));
  assert.deepEqual(await ledgerEvents(a), ['GENESIS', 'INTENT', 'CONFIRMED']);
  assert.deepEqual(await ledgerEvents(second), ['GENESIS']);
  // o livro de A copiado para a pasta de B (mesmo servidor de livro): a etiqueta/identificador de auditoria não confere
  const stolen = path.join(second.ledgerDir, second.auditId);
  fs.rmSync(stolen, { recursive: true, force: true });
  fs.mkdirSync(stolen, { recursive: true });
  for (const name of ledgerFiles(a)) fs.copyFileSync(path.join(a.ledgerDir, a.auditId, name), path.join(stolen, name));
  const view = await must(second.rawProtected.list(BIA, second.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions.length], ['HISTORY_UNRESOLVED', 'UNTRUSTED', 0]);
  assert.equal((await must(a.rawProtected.list(BIA, a.auditId))).ledger.state, 'PROTECTED', 'A segue íntegra');
});

test('o módulo antigo (6B isolada) segue funcionando sem o livro quando a dispensa é EXPLÍCITA, e diz isso no estado', async () => {
  const w = await world();
  const view = await must(w.raw.list(ANA, w.auditId));
  assert.equal(view.ledger.state, 'NOT_REQUIRED');
  void LEDGER_NOT_REQUIRED;
  void NO_RESULTS;
});
