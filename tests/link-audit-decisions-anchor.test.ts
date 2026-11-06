import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import { WITNESS_NOT_REQUIRED } from '../src/lib/link-audit-decisions/witness';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDecisionService, type EvidenceLookup } from '../src/lib/link-audit-decisions';
import { parseScoringInput } from '../src/lib/link-audit/scoring/input';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { ANA, BIA, anchorPath, clock, entryPath, must, rec, registerCleanup, tmpDir, withAutoHead, world, writeAlternatingChain } from './helpers/link-audit-decisions-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';

registerCleanup();

const REASON = 'Informação conferida e incorreta; decisão desfeita.';
const GOLDEN = path.join(__dirname, 'fixtures', 'link-audit-decisions', 'v1');
const GOLDEN_AUDIT = 'auditoria-golden-v1';

const fakeEvidence = (collectedAt: string | null = '2026-10-22T12:54:48.079Z'): EvidenceLookup => ({
  async getIntegrity() {
    return { state: 'COMPLETE', integrity: { status: 'OK' } };
  },
  async listVersions() {
    return [{ capture: 1, collectedAt, reportRevisions: [{ revision: 1 }] }];
  },
});

const reseal = async (file: string, change: Record<string, unknown>): Promise<void> => {
  const { seal, serialize } = await import('../src/lib/link-audit-decisions/store');
  const { contentSha256, ...body } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.ok(contentSha256);
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal({ ...body, ...change })));
};

/* ===================================================================== B1 — âncoras e expectedHead (nível do serviço) */

test('B1 — arquivos de decisão apagados no FIM: leitura, criação e revogação respondem DECISIONS_TRUNCATED, sem dados e sem gravar nada', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock()));
  const revoked = await must(w.service.revoke(ANA, w.auditId, { revokes: 'op-0002', reason: REASON }, clock()));
  assert.equal(revoked.effectiveCount, 1);
  fs.rmSync(entryPath(w, 3)); // some a revogação: sem a âncora, op-0002 voltaria a valer com "integridade OK"
  for (const result of [
    await w.service.list(ANA, w.auditId),
    await w.service.create(ANA, w.auditId, { record: rec.p3() }, clock()),
    await w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON }, clock()),
  ]) {
    assert.ok(!result.ok && result.code === 'DECISIONS_TRUNCATED' && !('value' in result));
  }
  assert.deepEqual(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).sort(), ['d0001.json', 'd0002.json']);
  assert.equal(fs.readdirSync(path.join(w.anchorDir, w.auditId)).length, 3); // as âncoras permanecem
});

test('B1 — último arquivo re-selado: ANCHOR_MISMATCH; âncora reescrita: ANCHOR_INTEGRITY; nada é devolvido', async () => {
  const w = await world();
  for (const record of [rec.c2(), rec.c3()]) await must(w.service.create(ANA, w.auditId, { record }, clock()));
  await reseal(entryPath(w, 2), { recordedBy: 'intruso@empresa.com' });
  const mismatch = await w.service.list(ANA, w.auditId);
  assert.ok(!mismatch.ok && mismatch.code === 'ANCHOR_MISMATCH' && !('value' in mismatch));
  const w2 = await world();
  await must(w2.service.create(ANA, w2.auditId, { record: rec.c2() }, clock()));
  fs.chmodSync(anchorPath(w2, 1), 0o644);
  fs.writeFileSync(anchorPath(w2, 1), fs.readFileSync(anchorPath(w2, 1), 'utf8').replace('"anchoredAt"', '"anchoredAt "'));
  const broken = await w2.service.list(ANA, w2.auditId);
  assert.ok(!broken.ok && broken.code === 'ANCHOR_INTEGRITY');
});

test('B1 — pasta de âncoras ausente/indisponível: nenhuma decisão é gravada (503) e a leitura também falha fechada', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const lost = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: path.join(tmpDir('lad-x-'), 'sumiu'), evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  for (const result of [await lost.list(ANA, w.auditId), await lost.create(ANA, w.auditId, { record: rec.c3(), expectedHead: null }, clock())]) {
    assert.ok(!result.ok && result.code === 'ANCHOR_STORAGE_UNAVAILABLE');
  }
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 1);
  // anchor volume trocado por um VAZIO (mas existente): 1 decisão sem âncora é uma PENDENTE (não vale e ninguém a "legitima"); 2 ou mais é falha
  const empty = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: tmpDir('lad-vazio-'), evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  const head = (await must(w.raw.list(ANA, w.auditId))).head;
  const shown = await must(empty.list(ANA, w.auditId));
  assert.deepEqual([shown.head, shown.pending?.seq, shown.operatorRecords.length, shown.anchors], [null, 1, 0, { count: 0, lastSeq: 0, unanchored: 1 }]);
  const refused = await empty.create(ANA, w.auditId, { record: rec.c3(), expectedHead: head }, clock());
  assert.ok(!refused.ok && refused.code === 'PENDING_UNCONFIRMED' && refused.pending?.seq === 1);
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 1);
  const swapped = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: tmpDir('lad-vazio2-'), evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock())); // com o volume certo a auditoria continua normal
  const bad = await swapped.list(ANA, w.auditId); // 2 decisões e nenhuma âncora
  assert.ok(!bad.ok && bad.code === 'ANCHOR_INTEGRITY');
});

test('janela de queda no serviço: se o recibo falhar depois da decisão, a resposta é ANCHOR_PENDING (503, nunca sucesso) e só o reenvio do MESMO pedido a confirma', async () => {
  const anchorRoot = tmpDir('lad-anc-');
  const failing = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(anchorRoot) && target.includes('.tmp-a0002')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await world({ fs: failing });
  const svc = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: anchorRoot, evidence: w.reader, evidenceBaseDir: w.evidenceDir, fs: failing });
  const raw = withAutoHead(svc);
  const first = await must(raw.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  assert.deepEqual([first.anchored, first.replayed], [true, false]);
  const body = { record: rec.c3(), expectedHead: first.head };
  const second = await svc.create(ANA, w.auditId, body, clock());
  assert.ok(!second.ok && second.code === 'ANCHOR_PENDING');
  assert.deepEqual([second.head, second.pending?.seq, second.pending?.confirmed, second.pending?.action], [first.head, 2, false, 'RECORD']);
  const listed = await must(raw.list(ANA, w.auditId));
  assert.deepEqual([listed.history.length, listed.head, listed.pending?.seq, listed.anchors.unanchored, listed.decisions.map((d) => d.decisionId), listed.operatorRecords.map((r) => r.id)], [1, first.head, 2, 1, ['op-0001'], ['op-0001']]);
  const healthy = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: anchorRoot, evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  const other = await healthy.create(BIA, w.auditId, { record: rec.p3(), expectedHead: first.head }, clock()); // outro operador: NÃO a conclui
  assert.ok(!other.ok && other.code === 'PENDING_UNCONFIRMED');
  const different = await healthy.create(ANA, w.auditId, { record: rec.p3(), expectedHead: first.head }, clock()); // o autor com OUTRO pedido: também não
  assert.ok(!different.ok && different.code === 'PENDING_UNCONFIRMED');
  const resent = await must(healthy.create(ANA, w.auditId, body, clock())); // o MESMO pedido: conclui, sem duplicar
  assert.deepEqual([resent.replayed, resent.anchored, resent.decision.decisionId, resent.head.seq, resent.anchors], [true, true, 'op-0002', 2, { count: 2, lastSeq: 2, unanchored: 0 }]);
  const again = await must(healthy.create(ANA, w.auditId, body, clock())); // e quantas vezes for reenviado
  assert.deepEqual([again.replayed, again.head.seq], [true, 2]);
  const third = await must(withAutoHead(healthy).create(ANA, w.auditId, { record: rec.p3() }, clock()));
  assert.deepEqual([third.anchored, third.replayed, third.anchors.count, third.anchors.unanchored], [true, false, 3, 0]);
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 3);
});

test('expectedHead: obrigatório; null só em histórico vazio; visão velha → HEAD_MISMATCH com o head atual; nada é gravado nas recusas', async () => {
  const w = await world();
  const missing = await w.raw.create(ANA, w.auditId, { record: rec.c2() }, clock());
  assert.ok(!missing.ok && missing.code === 'INVALID_BODY' && missing.issues.join(' ').includes('expectedHead'));
  const malformed = await w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: { seq: 1 } }, clock());
  assert.ok(!malformed.ok && malformed.code === 'INVALID_BODY');
  const extra = await w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: { seq: 1, sha256: 'a'.repeat(64), x: 1 } }, clock());
  assert.ok(!extra.ok && extra.code === 'INVALID_BODY');
  assert.ok(!fs.existsSync(path.join(w.decisionsDir, w.auditId)) || fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length === 0);

  const first = await must(w.raw.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  const second = await must(w.raw.create(ANA, w.auditId, { record: rec.c3(), expectedHead: first.head }, clock()));

  const stale = await w.raw.create(BIA, w.auditId, { record: rec.p3(), expectedHead: first.head }, clock()); // viu a posição 1; já existe a 2
  assert.ok(!stale.ok && stale.code === 'HEAD_MISMATCH' && stale.head?.seq === 2 && stale.head.sha256 === second.head.sha256);
  const nullNow = await w.raw.create(BIA, w.auditId, { record: rec.p3(), expectedHead: null }, clock());
  assert.ok(!nullNow.ok && nullNow.code === 'HEAD_MISMATCH' && nullNow.head?.seq === 2);
  const wrongHash = await w.raw.create(BIA, w.auditId, { record: rec.p3(), expectedHead: { seq: 2, sha256: 'b'.repeat(64) } }, clock());
  assert.ok(!wrongHash.ok && wrongHash.code === 'HEAD_MISMATCH');
  const revokeStale = await w.raw.revoke(BIA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: first.head }, clock());
  assert.ok(!revokeStale.ok && revokeStale.code === 'HEAD_MISMATCH');
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 2);

  const ok = await must(w.raw.create(BIA, w.auditId, { record: rec.p3(), expectedHead: second.head }, clock()));
  assert.equal(ok.head.seq, 3);
});

test('B1 — retrocesso COORDENADO (as duas pastas restauradas de uma cópia antiga): a leitura fecha, mas o expectedHead do operador acusa HISTORY_REGRESSED', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.c3() }, clock()));
  const old = { d: tmpDir('lad-bkp-d-'), a: tmpDir('lad-bkp-a-') };
  for (const [from, to] of [[path.join(w.decisionsDir, w.auditId), old.d], [path.join(w.anchorDir, w.auditId), old.a]] as const) for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
  const seen = await must(w.service.create(ANA, w.auditId, { record: rec.p3() }, clock())); // o operador viu a posição 3
  for (const [folder, backup] of [[path.join(w.decisionsDir, w.auditId), old.d], [path.join(w.anchorDir, w.auditId), old.a]] as const) {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder);
    for (const name of fs.readdirSync(backup)) fs.copyFileSync(path.join(backup, name), path.join(folder, name));
  }
  const listed = await w.raw.list(ANA, w.auditId); // limite assumido: sozinhas, as duas pastas coerentes não acusam nada
  assert.ok(listed.ok && listed.value.head?.seq === 2);
  const regressed = await w.raw.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: seen.head }, clock());
  assert.ok(!regressed.ok && regressed.code === 'HISTORY_REGRESSED' && regressed.head?.seq === 2);
  const revokeRegressed = await w.raw.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: seen.head }, clock());
  assert.ok(!revokeRegressed.ok && revokeRegressed.code === 'HISTORY_REGRESSED');
});

/* ===================================================================== B2 / B3 — contradições e substituições */

test('B2 — juízo "faltam" de C3 e N/A "nenhuma necessária" de C3 são alternativas: juntos são recusados nas duas ordens (o motor esconderia o zero)', async () => {
  const w = await world();
  const judgement = await must(w.service.create(ANA, w.auditId, { record: rec.c3('MISSING_NEEDED') }, clock()));
  const na = await w.service.create(ANA, w.auditId, { record: rec.naNoAdditional() }, clock());
  assert.ok(!na.ok && na.code === 'SUPERSEDE_REQUIRED' && na.issues.join(' ').includes(judgement.decision.decisionId));
  const asReplacement = await w.service.create(ANA, w.auditId, { record: rec.naNoAdditional(), supersedes: judgement.decision.decisionId }, clock());
  assert.ok(!asReplacement.ok && asReplacement.code === 'SUPERSEDE_INVALID'); // trocar de natureza exige revogar (fica explícito no histórico)
  await must(w.service.revoke(ANA, w.auditId, { revokes: judgement.decision.decisionId, reason: REASON }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.naNoAdditional() }, clock()));
  const back = await w.service.create(ANA, w.auditId, { record: rec.c3('ALL_RELEVANT') }, clock());
  assert.ok(!back.ok && back.code === 'SUPERSEDE_REQUIRED');
  // outros subcritérios não são afetados
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
});

const naFeature = (ids: string[]) => ({ kind: 'NOT_APPLICABLE', subcriterionIds: ids, code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: ['capture:c0001'], justification: 'Conferido no painel do perfil pelo operador responsável.' });

test('B3 — substituir NUNCA retira subcritério: [A1,A2]→[A2] e [A1,A2]→[A2,A3] são recusadas, [A1,A2]→[A1,A2,A3] aceita', async () => {
  const w = await world();
  const base = await must(w.service.create(ANA, w.auditId, { record: naFeature(['A1', 'A2']) }, clock()));
  for (const ids of [['A2'], ['A2', 'A3'], ['A1'], ['A3']]) {
    const r = await w.service.create(ANA, w.auditId, { record: naFeature(ids), supersedes: base.decision.decisionId }, clock());
    assert.ok(!r.ok && r.code === 'SUPERSEDE_INVALID', ids.join(','));
  }
  const wider = await must(w.service.create(ANA, w.auditId, { record: naFeature(['A1', 'A2', 'A3']), supersedes: base.decision.decisionId }, clock()));
  assert.equal(wider.effectiveCount, 1);
  const narrow = await w.service.create(ANA, w.auditId, { record: naFeature(['A1']), supersedes: wider.decision.decisionId }, clock());
  assert.ok(!narrow.ok && narrow.code === 'SUPERSEDE_INVALID');
  // para reduzir: revogar e criar de novo (as duas coisas ficam no histórico)
  await must(w.service.revoke(ANA, w.auditId, { revokes: wider.decision.decisionId, reason: REASON }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: naFeature(['A1']) }, clock()));
});

test('B3 — observação e atestado multi-subcritério seguem a mesma regra de cobertura', async () => {
  const w = await world();
  const obs = await must(w.service.create(ANA, w.auditId, { record: rec.observation(['S5', 'X4']) }, clock()));
  const dropped = await w.service.create(ANA, w.auditId, { record: rec.observation(['S5']), supersedes: obs.decision.decisionId }, clock());
  assert.ok(!dropped.ok && dropped.code === 'SUPERSEDE_INVALID');
  const att = await must(w.service.create(ANA, w.auditId, { record: rec.attestation(['S5', 'V5']) }, clock()));
  const swapped = await w.service.create(ANA, w.auditId, { record: rec.attestation(['V5', 'X4']), supersedes: att.decision.decisionId }, clock());
  assert.ok(!swapped.ok && swapped.code === 'SUPERSEDE_INVALID');
  await must(w.service.create(ANA, w.auditId, { record: rec.attestation(['S5', 'V5', 'X4']), supersedes: att.decision.decisionId }, clock()));
});

test('B3 — equivalência de nomes: a mesma (sem ordem/caixa) é duplicata (409); só ela mesma a substitui; outra equivalência convive', async () => {
  const w = await world();
  const first = await must(w.service.create(ANA, w.auditId, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') }, clock()));
  for (const [a, b] of [['Padaria Exemplo Ltda', 'Padaria Exemplo'], ['padaria exemplo', 'PADARIA EXEMPLO LTDA'], ['  Padaria   Exemplo ', 'Padaria Exemplo Ltda']] as const) {
    const dup = await w.service.create(ANA, w.auditId, { record: rec.nameEquivalence(a, b) }, clock());
    assert.ok(!dup.ok && dup.code === 'SUPERSEDE_REQUIRED', `${a}|${b}`);
  }
  const unrelated = await w.service.create(ANA, w.auditId, { record: rec.nameEquivalence('Outra Empresa SA', 'Outra'), supersedes: first.decision.decisionId }, clock());
  assert.ok(!unrelated.ok && unrelated.code === 'SUPERSEDE_INVALID');
  const sameAgain = await must(w.service.create(ANA, w.auditId, { record: rec.nameEquivalence('padaria exemplo', 'Padaria Exemplo Ltda'), supersedes: first.decision.decisionId }, clock()));
  assert.equal(sameAgain.effectiveCount, 1);
  await must(w.service.create(ANA, w.auditId, { record: rec.nameEquivalence('Outra Empresa SA', 'Outra') }, clock()));
  assert.equal((await must(w.service.list(ANA, w.auditId))).decisions.length, 2);
});

/* ===================================================================== S3 — caracteres ocultos no texto livre */

test('S3 — controle, bidi, zero-width e separadores de linha são recusados em TODO texto livre (e quebras de linha comuns são permitidas)', async () => {
  const w = await world();
  const hidden = ['‮', '​', '\u0000', ' ', '﻿', '\u0007', '⁦', '­', '\r'];
  const fields: Array<[string, (text: string) => unknown]> = [
    ['justificativa do juízo', (t) => ({ record: { ...rec.c2(), justification: `Conferido no painel ${t} pelo operador.` } })],
    ['nome A', (t) => ({ record: { ...rec.nameEquivalence(`Empresa ${t} Ltda`, 'Empresa') } })],
    ['nome B', (t) => ({ record: { ...rec.nameEquivalence('Empresa Ltda', `Empresa ${t}`) } })],
    ['descrição do escopo', (t) => ({ record: { ...rec.attestation(), scopeDescription: `Sitemap integralmente ${t} percorrido e conferido.` } })],
  ];
  for (const [label, build] of fields) {
    for (const ch of hidden) {
      const r = await w.service.create(ANA, w.auditId, build(ch), clock());
      assert.ok(!r.ok && r.code === 'INVALID_BODY' && r.issues.join(' ').includes('caracteres'), `${label} aceitou U+${ch.charCodeAt(0).toString(16)}`);
    }
  }
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const reason = await w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: `Informação conferida‮ e incorreta; decisão desfeita.` }, clock());
  assert.ok(!reason.ok && reason.code === 'INVALID_BODY');
  const multiline = await w.service.create(ANA, w.auditId, { record: { ...rec.c3(), justification: 'Primeira linha da conferência.\nSegunda linha, com acentuação: ção ã é.' } }, clock());
  assert.ok(multiline.ok);
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, w.auditId)).length, 2); // nada das recusas foi gravado
});

/* ===================================================================== S5 / S6 / S7 */

test('S5 — as últimas 100 entradas são reservadas a REVOGAÇÕES: criar é recusado, revogar continua possível até o fim do limite', async () => {
  const decisionsDir = tmpDir('lad-res-d-');
  const anchorDir = tmpDir('lad-res-a-');
  const AUDIT = 'auditoria-reserva-01';
  writeAlternatingChain(decisionsDir, anchorDir, AUDIT, 9899); // a última (ímpar) é uma criação vigente: op-9899
  const raw = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: decisionsDir, anchorDir, evidence: fakeEvidence() });
  const listed = await must(raw.list(ANA, AUDIT));
  assert.deepEqual([listed.history.length, listed.decisions.map((d) => d.decisionId)], [9899, ['op-9899']]);
  const create = await raw.create(ANA, AUDIT, { record: rec.c3(), expectedHead: listed.head }, clock());
  assert.ok(!create.ok && create.code === 'LIMIT_REACHED' && create.issues.join(' ').includes('reservadas'));
  const revoke = await must(raw.revoke(ANA, AUDIT, { revokes: 'op-9899', reason: REASON, expectedHead: listed.head }, clock()));
  assert.equal(revoke.head.seq, 9900);
  assert.equal(revoke.effectiveCount, 0);
});

test('S6 — collectedAt inválido ou longo (layout legado) não derruba a criação nem vira "histórico adulterado": basis.collectedAt fica null', async () => {
  for (const weird of ['x'.repeat(120), 'ontem à tarde', '2026-10-22 12:54:48']) {
    const svc = withAutoHead(createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: tmpDir('lad-s6-d-'), anchorDir: tmpDir('lad-s6-a-'), evidence: fakeEvidence(weird) }));
    const made = await must(svc.create(ANA, 'auditoria-legado-01', { record: rec.c2() }, clock()));
    assert.equal(made.decision.basis.collectedAt, null, weird.slice(0, 20));
    assert.equal(made.decision.basis.capture, 1);
    assert.ok((await svc.list(ANA, 'auditoria-legado-01')).ok);
  }
});

test('S7 — decisões que dependem do escopo do site (atestado, confirmação de observação) são sinalizadas com siteDependent', async () => {
  const w = await world();
  for (const record of [rec.c2(), rec.attestation(), rec.observation(), rec.images(), rec.naModel(), rec.nameEquivalence()]) await must(w.service.create(ANA, w.auditId, { record }, clock()));
  const listed = await must(w.service.list(ANA, w.auditId));
  assert.deepEqual(listed.decisions.map((d) => [d.kind, d.siteDependent]), [
    ['JUDGEMENT', false],
    ['SITE_SCOPE_ATTESTATION', true],
    ['OBSERVATION_CONFIRMATION', true],
    ['IMAGES_CONFIRMATION', false],
    ['NOT_APPLICABLE', false],
    ['NAME_EQUIVALENCE', false],
  ]);
});

/* ===================================================================== S8 — o validador da 6A não depende da origem das evidências */

test('S8 — a validação cruzada da 6A NÃO lê origem/status/captura das evidências citadas por registros (se passar a ler, este teste acusa)', () => {
  const records = [
    { ...rec.naFeature(['capture:c0001']), id: 'op-0001', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-21T12:00:00.000Z' },
    { ...rec.images(['capture:c0001', 'report:c0001-r0001']), id: 'op-0002', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-21T12:00:01.000Z' },
    { ...rec.p3(null), id: 'op-0003', operatorEmail: 'ana@empresa.com', recordedAt: '2026-10-21T12:00:02.000Z' }, // violação real: P3 sem amostra
  ];
  const issuesWith = (origin: string, capture: string, status: string): string[] => {
    const evidences = ['capture:c0001', 'report:c0001-r0001'].map((id) => ({ id, origin, capture, status, observedAt: '2026-10-21T12:00:00.000Z', contentSha256: 'c'.repeat(64) }));
    const parsed = parseScoringInput({ schemaVersion: 1, auditId: 'auditoria-decisoes', referenceDate: '2026-10-21', evidences, operatorRecords: records });
    return parsed.ok ? [] : [...parsed.issues];
  };
  const baseline = issuesWith('GOOGLE_NATIVE', 'STORED_CAPTURE', 'VERIFIED');
  assert.ok(baseline.some((i) => /P3 exige sampleSize/.test(i)), 'a violação real é vista');
  for (const [origin, capture, status] of [
    ['OFFICIAL_SITE', 'OPERATOR_ATTACHMENT', 'PARTIAL'],
    ['THIRD_PARTY', 'AGGREGATOR', 'NOT_VERIFIED'],
    ['OFFICIAL_SOCIAL', 'OPERATOR_STATEMENT', 'NOT_FOUND'],
    ['INSTITUTIONAL', 'PREVIOUS_AUDIT_PDF', 'VERIFIED'],
  ] as const) {
    assert.deepEqual(issuesWith(origin, capture, status), baseline, `${origin}/${capture}/${status}`);
  }
});

/* ===================================================================== S9 — fixture "de ouro" do formato v1 */

test('S9 — histórico v1 gravado em arquivos (fixture de ouro) continua legível: se a 6A apertar o esquema, este teste acusa a migração necessária', async () => {
  assert.ok(fs.existsSync(path.join(GOLDEN, 'decisions', GOLDEN_AUDIT, 'd0001.json')), 'fixture ausente');
  const svc = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: path.join(GOLDEN, 'decisions'), anchorDir: path.join(GOLDEN, 'anchors'), evidence: fakeEvidence() });
  const listed = await must(svc.list(ANA, GOLDEN_AUDIT));
  assert.deepEqual(listed.history.map((h) => [h.seq, h.action]), [[1, 'RECORD'], [2, 'RECORD'], [3, 'RECORD'], [4, 'REVOKE'], [5, 'RECORD']]);
  assert.deepEqual(listed.allDecisions.map((d) => [d.decisionId, d.status]), [['op-0001', 'SUPERSEDED'], ['op-0002', 'REVOKED'], ['op-0003', 'ACTIVE'], ['op-0005', 'ACTIVE']]);
  assert.deepEqual(listed.head, { seq: 5, sha256: 'b5f41118cac8737719efa8665fc15cdf4922a7b8bd9391562096bdacdbc5acf1' });
  assert.deepEqual(listed.anchors, { count: 5, lastSeq: 5, unanchored: 0 });
  assert.deepEqual(listed.operatorRecords.map((r) => r.id), ['op-0003', 'op-0005']);
  // e continua EXTENSÍVEL: numa cópia, uma decisão nova é aceita e ancorada sobre o histórico antigo
  const copy = { d: tmpDir('lad-gold-d-'), a: tmpDir('lad-gold-a-') };
  for (const [from, to] of [[path.join(GOLDEN, 'decisions', GOLDEN_AUDIT), path.join(copy.d, GOLDEN_AUDIT)], [path.join(GOLDEN, 'anchors', GOLDEN_AUDIT), path.join(copy.a, GOLDEN_AUDIT)]] as const) {
    fs.mkdirSync(to);
    for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
  const extended = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: copy.d, anchorDir: copy.a, evidence: fakeEvidence() });
  const next = await must(extended.create(ANA, GOLDEN_AUDIT, { record: rec.c3(), expectedHead: listed.head }, clock()));
  assert.deepEqual([next.decision.decisionId, next.anchored, next.anchors.count], ['op-0006', true, 6]);
});
