import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDecisionService, type KnownHeadsProvider } from '../src/lib/link-audit-decisions';
import { createOriginAuthenticator, type OriginAuthenticator } from '../src/lib/link-audit-origin';
import { createResultsKnownHeads } from '../src/lib/link-audit-scoring-runs';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { ANA, anchorPath, BIA, clock, entryPath, hashTree, must, registerCleanup, rec, world, type World } from './helpers/link-audit-decisions-fixtures';
import { OTHER_ORIGIN_KEY, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { makeService, OP_A, receiptPath, resultsEnv, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { previewW, quarantine, REASON, sealedAfterRevocation } from './helpers/link-audit-witness-fixtures';

/*
 * R4-MINOR-1 (4ª revisão independente; decisão do responsável de 01/11/2026): a ROTAÇÃO DE CHAVE não pode fazer o sistema esquecer uma
 * testemunha histórica e reativar uma decisão revogada. Reprodução original (RV4-A7): resultado s1 selado sobre o histórico (cabeça seq 2);
 * o invasor remove o recibo do resultado (a0001) e o da revogação (a0002); o operador "resolve" mandando d0002 para a quarentena; a chave é
 * rotacionada. Antes da correção, s1 deixava de ser testemunha (origem não comprovada) e a revogada voltava a ACTIVE.
 *
 * Regra: um resultado PENDENTE de origem comprovada (chave em vigor, atual ou aposentada dentro da validade) é TESTEMUNHA. Um de origem NÃO comprovada
 * (aposentada vencida, REVOGADA, desconhecida, ausente/inválida, ou lido por servidor sem autenticador) é só INDÍCIO: nunca é promovido a resultado
 * selado e uma chave comprometida NUNCA o torna confiável; se o indício contradiz o histórico de hoje, a testemunha é `UNTRUSTED` (falha fechada).
 */
registerCleanup();

const TODAY = (): Date => new Date('2026-11-01T12:00:00.000Z');
const AFTER_EXPIRY = (): Date => new Date('2026-12-20T12:00:00.000Z');
const RETIRED = `${TEST_ORIGIN_KEY}:2026-11-30`;

/** A chave que assinou tudo é `ok-test-a`. Cada situação é o que o servidor tem configurado DEPOIS do fato. */
type Rotation = 'same-key' | 'planned' | 'planned-expired' | 'emergency-revoked' | 'unknown-key' | 'no-authenticator';
const ROTATIONS: readonly Rotation[] = ['same-key', 'planned', 'planned-expired', 'emergency-revoked', 'unknown-key', 'no-authenticator'];
const authenticatorFor = (rotation: Rotation): OriginAuthenticator | undefined => {
  switch (rotation) {
    case 'same-key':
      return createOriginAuthenticator(TEST_ORIGIN_KEY);
    case 'planned':
      return createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, retired: [RETIRED], now: TODAY });
    case 'planned-expired':
      return createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, retired: [RETIRED], now: AFTER_EXPIRY });
    case 'emergency-revoked':
      return createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, revokedIds: ['ok-test-a'], now: TODAY });
    case 'unknown-key':
      return createOriginAuthenticator(OTHER_ORIGIN_KEY);
    case 'no-authenticator':
      return undefined; // configuração de origem inválida/ausente: as rotas montam o provedor SEM autenticador
  }
};
/** O que a rotação DEVE concluir sobre a pendente assinada por `ok-test-a`: testemunha (PROVEN) ou indício. */
const STILL_PROVEN: ReadonlySet<Rotation> = new Set<Rotation>(['same-key', 'planned']);

/** Serviço de decisões COMO O SERVIDOR O MONTA depois da rotação: o mesmo autenticador assina/verifica as decisões e alimenta o provedor da testemunha. */
function afterRotation(w: World, e: ResultsEnv, rotation: Rotation, provider?: KnownHeadsProvider) {
  const origin = authenticatorFor(rotation);
  return createDecisionService({
    ...(origin ? { origin } : {}),
    baseDir: w.decisionsDir,
    anchorDir: w.anchorDir,
    evidence: w.reader,
    evidenceBaseDir: w.evidenceDir,
    knownHeads: provider ?? createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir], ...(origin ? { origin } : {}) }),
  });
}

/** Cenário RV4-A7: o resultado s1 vira PENDENTE (sem a0001) e o recibo da revogação (a0002) também some. */
async function bothReceiptsGone(): Promise<{ w: World; e: ResultsEnv }> {
  const { w, e } = await sealedAfterRevocation();
  fs.rmSync(receiptPath(e, 1, w.auditId)); // recibo do RESULTADO
  fs.rmSync(anchorPath(w, 2)); // recibo da REVOGAÇÃO
  return { w, e };
}

/** Invariante central: nenhuma perda de prova reativa a decisão revogada, nem a deixa chegar ao motor, nem permite escrever ou finalizar. */
async function assertFailsClosed(w: World, e: ResultsEnv, rotation: Rotation, expected: string, label: string): Promise<void> {
  const decisions = afterRotation(w, e, rotation); // serviço NOVO: nada em memória (reinício)
  const view = await must(decisions.list(BIA, w.auditId));
  assert.equal(view.witness.status, expected, `${label}: estado da testemunha`);
  assert.deepEqual(view.decisions, [], `${label}: a revogada NÃO volta a ser vigente`);
  assert.deepEqual(view.operatorRecords, [], `${label}: o motor não recebe nenhuma decisão`);
  assert.ok(view.allDecisions.every((d) => d.status !== 'ACTIVE'), `${label}: nada aparece como ACTIVE`);
  assert.equal(view.finalizable, false, `${label}: nada finalizável`);
  const evaluated = await previewW(w, decisions).evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok, label);
  assert.deepEqual(evaluated.value.applied, [], `${label}: nada aplicado`);
  assert.equal(evaluated.value.payload.finalization.allowed, false, label);
  assert.ok(evaluated.value.payload.blockers.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.severity === 'BLOCKING'), `${label}: bloqueio próprio`);
  // escritas recusadas pelo motivo certo e SEM gravar
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(e.base), hashTree(e.anchors)];
  // sem autenticador o servidor recusa gravar ANTES de olhar o histórico (ORIGIN_KEY_NOT_CONFIGURED); com autenticador, a recusa é pela integridade
  const writeRefusal = authenticatorFor(rotation) ? 'DECISIONS_HISTORY_UNRESOLVED' : 'ORIGIN_KEY_NOT_CONFIGURED';
  const create = await decisions.create(BIA, w.auditId, { record: rec.c2(), expectedHead: view.head }, clock());
  assert.ok(!create.ok && create.code === writeRefusal, `${label}: nova decisão ${JSON.stringify(create).slice(0, 120)}`);
  const revoke = await decisions.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!revoke.ok && revoke.code === writeRefusal, `${label}: revogação ${JSON.stringify(revoke).slice(0, 120)}`);
  const attempt = await makeService(e, previewW(w, decisions)).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  // com um resultado PENDENTE no caminho a primeira recusa é a dele; sem pendente, é o bloqueio da integridade. Em ambos nada é gravado.
  const pendingResult = fs.existsSync(runPath(e, 1, w.auditId)) && !fs.existsSync(receiptPath(e, 1, w.auditId));
  assert.ok(!attempt.ok, `${label}: finalização recusada`);
  if (pendingResult) assert.equal(attempt.code, 'RESULT_PENDING_UNCONFIRMED', label);
  else assert.ok(attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED'), `${label}: finalização ${JSON.stringify(attempt).slice(0, 160)}`);
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir), hashTree(e.base), hashTree(e.anchors)], before, `${label}: nada foi gravado`);
}

for (const rotation of ROTATIONS) {
  test(`RV4-A7 reproduzido [${rotation}]: os DOIS recibos removidos + quarentena da pendente de revogação NÃO reativam a decisão (falha fechada pelo motivo certo)`, async () => {
    const { w, e } = await bothReceiptsGone();
    quarantine(w, 2);
    // estado esperado: com origem comprovada o resultado pendente é TESTEMUNHA (a posição 2 falta ⇒ retrocesso);
    // sem prova de origem é INDÍCIO que contradiz o histórico de hoje ⇒ testemunha não confiável. Nos dois casos: NÃO RESOLVIDO.
    await assertFailsClosed(w, e, rotation, STILL_PROVEN.has(rotation) ? 'HISTORY_REGRESSED' : 'UNTRUSTED', rotation);
    // e continua assim depois de um segundo "reinício" e de uma releitura (nada foi curado em silêncio)
    await assertFailsClosed(w, e, rotation, STILL_PROVEN.has(rotation) ? 'HISTORY_REGRESSED' : 'UNTRUSTED', `${rotation} (reinício)`);
  });

  test(`resultado CONFIRMADO + quarentena da pendente de revogação [${rotation}]: a testemunha confirmada não depende de chave nenhuma`, async () => {
    const { w, e } = await sealedAfterRevocation();
    fs.rmSync(anchorPath(w, 2));
    quarantine(w, 2);
    await assertFailsClosed(w, e, rotation, 'HISTORY_REGRESSED', rotation);
  });
}

test('provedor: o resultado PENDENTE de origem comprovada é testemunha; sem prova de origem é só INDÍCIO (nunca resultado selado) em cada situação de chave', async () => {
  const { w, e } = await bothReceiptsGone();
  for (const rotation of ROTATIONS) {
    const origin = authenticatorFor(rotation);
    const read = await createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir], ...(origin ? { origin } : {}) })(w.auditId);
    assert.ok(read.ok, rotation);
    assert.equal(read.heads.length, STILL_PROVEN.has(rotation) ? 1 : 0, `${rotation}: testemunhas`);
    assert.equal(read.unverifiedHeads?.length, STILL_PROVEN.has(rotation) ? 0 : 1, `${rotation}: indícios`);
    const asHint = STILL_PROVEN.has(rotation) ? read.heads[0] : read.unverifiedHeads?.[0];
    assert.equal(asHint?.seq, 2, `${rotation}: a posição afirmada pelo resultado`);
  }
});

test('ROTAÇÃO PLANEJADA: dentro da validade a pendente assinada pela chave aposentada continua testemunha; vencida a validade, deixa de ser — e o sistema falha fechado, não aberto', async () => {
  const { w, e } = await bothReceiptsGone();
  // a decisão pendente (d0002, sem recibo) ainda existe: o histórico local está íntegro
  const planned = await must(afterRotation(w, e, 'planned').list(BIA, w.auditId));
  assert.deepEqual([planned.witness.status, planned.witness.knownHeads, planned.decisions.length, planned.ambiguousDecisionIds], ['RECEIPT_LOST_WITNESSED', 1, 0, ['op-0001']]);
  assert.equal(planned.pending?.origin, 'PROVEN', 'a aposentada ainda comprova a origem da pendente de decisão');
  const expired = await must(afterRotation(w, e, 'planned-expired').list(BIA, w.auditId));
  assert.equal(expired.pending?.origin, 'UNPROVEN', 'vencida a validade a origem da pendente NÃO é comprovada');
  assert.deepEqual([expired.decisions.length, expired.ambiguousDecisionIds, expired.finalizable], [0, ['op-0001'], false], 'e a decisão em dúvida continua fora do motor');
  assert.notEqual(expired.witness.status, 'CONSISTENT');
});

test('REVOGAÇÃO EMERGENCIAL da chave: nada assinado por ela vira testemunha NEM é concluído; uma chave comprometida NUNCA torna confiável uma pendência', async () => {
  const { w, e } = await bothReceiptsGone();
  const emergency = afterRotation(w, e, 'emergency-revoked');
  const view = await must(emergency.list(ANA, w.auditId));
  assert.equal(view.pending?.origin, 'UNPROVEN');
  assert.deepEqual([view.decisions, view.operatorRecords, view.finalizable], [[], [], false]);
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir)];
  const done = await emergency.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock());
  assert.ok(!done.ok, 'nem o próprio autor conclui uma pendência assinada por chave revogada');
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir)], before);
  assert.equal(fs.existsSync(anchorPath(w, 2)), false, 'o recibo não foi recriado');
  // re-assinar o arquivo com a chave NOVA não o torna confiável: a etiqueta nova só atestaria que o servidor de hoje o viu
  const file = entryPath(w, 2);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete parsed.contentSha256;
  const resigned = authenticatorFor('unknown-key') as OriginAuthenticator;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal({ ...parsed, origin: resigned.sign('DECISION', { ...parsed }) })));
  const after = await must(afterRotation(w, e, 'unknown-key').list(ANA, w.auditId));
  assert.notEqual(after.witness.status, 'CONSISTENT', 'reassinar não restaura a confiança');
  assert.deepEqual(after.decisions, []);
});

test('PENDENTE COM ORIGEM NÃO COMPROVADA: não é tratado como resultado selado — com histórico coerente é ignorado; contradizendo o histórico, a testemunha deixa de ser confiável', async () => {
  const real = await sealedAfterRevocation();
  const { w } = real;
  const today = (await must(real.decisions.list(ANA, w.auditId))).head;
  assert.ok(today, 'cabeça das decisões de hoje');
  const template = JSON.parse(fs.readFileSync(runPath(real.e, 1, w.auditId), 'utf8')) as { decisions: Record<string, unknown> } & Record<string, unknown>;
  const forgedEnv = resultsEnv();
  // um resultado pendente FORJADO (sem etiqueta de origem e sem recibo) que afirma uma cabeça de decisões
  const forge = (head: { seq: number; sha256: string }): void => {
    const body: Record<string, unknown> = { ...template, decisions: { ...template.decisions, head } };
    delete body.origin;
    delete body.contentSha256;
    fs.rmSync(path.join(forgedEnv.base, w.auditId), { recursive: true, force: true });
    fs.mkdirSync(path.join(forgedEnv.base, w.auditId), { recursive: true });
    fs.writeFileSync(path.join(forgedEnv.base, w.auditId, 's0001.json'), serialize(seal(body)));
  };
  const provider = createResultsKnownHeads({ otherDirs: [], baseDir: forgedEnv.base, anchorDir: forgedEnv.anchors, origin: authenticatorFor('same-key') as OriginAuthenticator });
  forge(today);
  // (a) o indício NÃO conta como testemunha
  const read = await provider(w.auditId);
  assert.ok(read.ok && read.heads.length === 0 && read.unverifiedHeads?.length === 1, JSON.stringify(read));
  // (b) com a MESMA cabeça do histórico de hoje: ignorado (sem falso alarme); a decisão revogada segue revogada e nada foi "selado"
  const same = await must(afterRotation(w, forgedEnv, 'same-key', provider).list(BIA, w.auditId));
  assert.deepEqual([same.witness.status, same.witness.knownHeads, same.allDecisions.map((d) => d.status), same.decisions], ['UNWITNESSED', 0, ['REVOKED'], []]);
  // (c) contradizendo o histórico (posição que hoje falta): não confiável ⇒ falha fechada
  forge({ seq: 3, sha256: 'b'.repeat(64) });
  const contradicted = await must(afterRotation(w, forgedEnv, 'same-key', provider).list(BIA, w.auditId));
  assert.deepEqual([contradicted.witness.status, contradicted.decisions, contradicted.finalizable], ['UNTRUSTED', [], false]);
  // (d) outra cabeça na MESMA posição: idem
  forge({ seq: 2, sha256: 'c'.repeat(64) });
  const diverging = await must(afterRotation(w, forgedEnv, 'same-key', provider).list(BIA, w.auditId));
  assert.deepEqual([diverging.witness.status, diverging.finalizable], ['UNTRUSTED', false]);
});

test('PERDA DE PROVA em todas as combinações e rotações: a decisão revogada NUNCA aparece como vigente (matriz)', async () => {
  const losses: Array<[string, (w: World, e: ResultsEnv) => void]> = [
    ['recibo da revogação', (w) => fs.rmSync(anchorPath(w, 2))],
    ['recibo da revogação + quarentena', (w) => { fs.rmSync(anchorPath(w, 2)); quarantine(w, 2); }],
    ['recibo do resultado', (w, e) => fs.rmSync(receiptPath(e, 1, w.auditId))],
    ['os dois recibos', (w, e) => { fs.rmSync(receiptPath(e, 1, w.auditId)); fs.rmSync(anchorPath(w, 2)); }],
    ['os dois recibos + quarentena', (w, e) => { fs.rmSync(receiptPath(e, 1, w.auditId)); fs.rmSync(anchorPath(w, 2)); quarantine(w, 2); }],
  ];
  for (const [lossLabel, lose] of losses) {
    for (const rotation of ROTATIONS) {
      const { w, e } = await sealedAfterRevocation();
      lose(w, e);
      const view = await must(afterRotation(w, e, rotation).list(BIA, w.auditId));
      assert.ok(!view.decisions.some((d) => d.decisionId === 'op-0001'), `${lossLabel} × ${rotation}: op-0001 nunca é vigente`);
      assert.deepEqual(view.operatorRecords, [], `${lossLabel} × ${rotation}: motor vazio`);
      assert.ok(view.allDecisions.every((d) => d.status !== 'ACTIVE'), `${lossLabel} × ${rotation}: nada ACTIVE`);
      if (lossLabel.includes('quarentena')) assert.equal(view.finalizable, false, `${lossLabel} × ${rotation}: não finalizável`);
    }
  }
});

test('RECUPERAÇÃO LEGÍTIMA continua funcionando após ROTAÇÃO PLANEJADA: o autor conclui a pendente assinada pela chave aposentada (dentro da validade) e a auditoria volta a ser finalizável', async () => {
  const { w, e } = await sealedAfterRevocation();
  fs.rmSync(anchorPath(w, 2)); // só o recibo da revogação some (interrupção ou remoção): o resultado confirmado testemunha
  const decisions = afterRotation(w, e, 'planned');
  const view = await must(decisions.list(ANA, w.auditId));
  assert.deepEqual([view.witness.status, view.pending?.origin, view.decisions.length, view.finalizable], ['RECEIPT_LOST_WITNESSED', 'PROVEN', 0, false]);
  const done = await must(decisions.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, clock()));
  assert.equal(done.revoked.status, 'REVOKED');
  assert.ok(fs.existsSync(anchorPath(w, 2)), 'o recibo do MESMO conteúdo foi recriado');
  const after = await must(afterRotation(w, e, 'planned').list(BIA, w.auditId));
  assert.deepEqual([after.witness.status, after.pending, after.ambiguousDecisionIds, after.finalizable, after.allDecisions.map((d) => d.status)], ['CONSISTENT', null, [], true, ['REVOKED']]);
});

test('RESTAURAÇÃO a partir do backup depois do incidente (fora do sistema) reabilita o histórico: devolver o arquivo e o recibo ⇒ consistente', async () => {
  const { w, e } = await bothReceiptsGone();
  const moved = quarantine(w, 2);
  assert.equal((await must(afterRotation(w, e, 'planned').list(BIA, w.auditId))).witness.status, 'HISTORY_REGRESSED');
  fs.renameSync(moved, entryPath(w, 2)); // restaura o arquivo da decisão
  const half = await must(afterRotation(w, e, 'planned').list(BIA, w.auditId));
  assert.deepEqual([half.witness.status, half.decisions.length, half.finalizable], ['RECEIPT_LOST_WITNESSED', 0, false]);
});

test('LIMITE DECLARADO (travado em teste; BLOQUEADOR para produção): se TODOS os vestígios somem — inclusive o resultado pendente — nada distingue a auditoria de uma que nunca teve resultado; só o livro de cabeças fecha isso', async () => {
  const { w, e } = await bothReceiptsGone();
  quarantine(w, 2); // a pendente de revogação
  fs.rmSync(`${e.base}/${w.auditId}`, { recursive: true }); // e o próprio resultado pendente (a última testemunha)
  const view = await must(afterRotation(w, e, 'planned-expired').list(BIA, w.auditId));
  assert.equal(view.witness.status, 'UNWITNESSED', 'sem NENHUM vestígio a testemunha não existe — e o sistema diz isso');
  assert.deepEqual(view.decisions.map((d) => d.decisionId), ['op-0001'], 'LIMITE: a decisão revogada volta a ser vigente; este teste falhará (e deve ser reescrito) quando o livro de cabeças existir');
});

test('WITNESS_NOT_REQUIRED não existe em código de produção, e as duas composições de rotas SEMPRE fornecem a testemunha (omitir não é possível por esquecimento)', () => {
  const root = path.join(__dirname, '..', 'src');
  const users: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('WITNESS_NOT_REQUIRED')) users.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  assert.deepEqual(users.sort(), ['lib/link-audit-decisions/index.ts', 'lib/link-audit-decisions/service.ts', 'lib/link-audit-decisions/witness.ts']);
  for (const file of ['app/api/link-audit/decisions/shared.ts', 'app/api/link-audit/scoring/shared.ts']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /createResultsKnownHeads\(/, file);
    assert.match(source, /reason: 'NOT_CONFIGURED'/, `${file}: sem as pastas, a testemunha responde NOT_CONFIGURED (falha fechada)`);
    assert.ok(/\bknownHeads\b\s*\}\)/.test(source) && !/\.\.\.\(knownHeads/.test(source), `${file}: knownHeads sempre passado, nunca condicional`);
  }
});

test('CONCLUSÃO de um resultado PENDENTE (reenvio idêntico pelo autor) com o histórico de decisões NÃO resolvido é recusada e NADA é gravado — nem o recibo do resultado', async () => {
  for (const rotation of ['same-key', 'planned'] as const) {
    const { w, e } = await sealedAfterRevocation();
    // o pedido que a interface reenviaria: cabeça e hash da avaliação ORIGINAL (antes de qualquer perda)
    const original = await previewW(w, afterRotation(w, e, rotation)).evaluate(OP_A, w.auditId);
    assert.ok(original.ok, rotation);
    const body = { expectedHead: original.value.decisions.head, expectedInputSha256: original.value.inputSha256 as string };
    fs.rmSync(receiptPath(e, 1, w.auditId)); // o resultado s1 vira PENDENTE
    fs.rmSync(anchorPath(w, 2)); // o recibo da revogação some
    quarantine(w, 2); // e a revogação vai para a quarentena
    const decisions = afterRotation(w, e, rotation);
    assert.equal((await must(decisions.list(BIA, w.auditId))).witness.status, 'HISTORY_REGRESSED', rotation);
    const before = [hashTree(e.base), hashTree(e.anchors), hashTree(w.decisionsDir), hashTree(w.anchorDir)];
    const completion = await makeService(e, previewW(w, decisions), { origin: authenticatorFor(rotation) as OriginAuthenticator }).finalize(OP_A, w.auditId, body);
    assert.ok(!completion.ok && completion.code === 'NOT_FINALIZABLE' && completion.blockers?.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED'), `${rotation}: ${JSON.stringify(completion).slice(0, 220)}`);
    assert.equal(fs.existsSync(receiptPath(e, 1, w.auditId)), false, `${rotation}: o recibo do resultado NÃO foi recriado`);
    assert.deepEqual([hashTree(e.base), hashTree(e.anchors), hashTree(w.decisionsDir), hashTree(w.anchorDir)], before, `${rotation}: nada gravado`);
  }
});

test('CONCLUSÃO de resultado PENDENTE com a testemunha INDISPONÍVEL / NÃO CONFIÁVEL / NÃO CONFIGURADA e o histórico LOCAL íntegro: recusada (é a única barreira nesses casos) e nenhum recibo nasce', async () => {
  const failing: Array<[string, KnownHeadsProvider]> = [
    ['indisponível', async () => ({ ok: false, reason: 'STORAGE_UNAVAILABLE' })],
    ['não confiável', async () => ({ ok: false, reason: 'UNTRUSTED' })],
    ['não configurada', async () => ({ ok: false, reason: 'NOT_CONFIGURED' })],
  ];
  for (const [label, provider] of failing) {
    const { w, e } = await sealedAfterRevocation();
    const original = await previewW(w, afterRotation(w, e, 'same-key')).evaluate(OP_A, w.auditId);
    assert.ok(original.ok, label);
    const body = { expectedHead: original.value.decisions.head, expectedInputSha256: original.value.inputSha256 as string };
    fs.rmSync(receiptPath(e, 1, w.auditId)); // o resultado s1 vira PENDENTE; as decisões continuam íntegras (nada de retrocesso)
    const decisions = afterRotation(w, e, 'same-key', provider);
    const before = [hashTree(e.base), hashTree(e.anchors), hashTree(w.decisionsDir), hashTree(w.anchorDir)];
    const completion = await makeService(e, previewW(w, decisions)).finalize(OP_A, w.auditId, body);
    assert.ok(!completion.ok && completion.code === 'NOT_FINALIZABLE' && completion.blockers?.some((b) => b.code === 'DECISIONS_HISTORY_UNRESOLVED'), `${label}: ${JSON.stringify(completion).slice(0, 200)}`);
    assert.equal(fs.existsSync(receiptPath(e, 1, w.auditId)), false, `${label}: nenhum recibo`);
    assert.deepEqual([hashTree(e.base), hashTree(e.anchors), hashTree(w.decisionsDir), hashTree(w.anchorDir)], before, `${label}: nada gravado`);
    // controle: com a testemunha restaurada o MESMO pedido conclui o resultado (a recusa era mesmo por causa da testemunha)
    const healthy = await makeService(e, previewW(w, afterRotation(w, e, 'same-key'))).finalize(OP_A, w.auditId, body);
    assert.ok(healthy.ok, `${label}: controle ${JSON.stringify(healthy).slice(0, 200)}`);
  }
});

test('LIMITE DECLARADO, forma MAIS LARGA (travado em teste; BLOQUEADOR): revogação sem resultado selado POSTERIOR — basta perder o recibo dela e mover o arquivo, com o resultado ANTERIOR e o recibo dele intactos', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const e = resultsEnv();
  const decisions = afterRotation(w, e, 'same-key');
  const first = await previewW(w, decisions).evaluate(OP_A, w.auditId);
  assert.ok(first.ok);
  assert.ok((await makeService(e, previewW(w, decisions)).finalize(OP_A, w.auditId, { expectedHead: first.value.decisions.head, expectedInputSha256: first.value.inputSha256 as string })).ok);
  const headNow = (await must(decisions.list(ANA, w.auditId))).head;
  await must(decisions.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: headNow }, clock())); // a revogação vem DEPOIS do único resultado
  const covered = await must(afterRotation(w, e, 'same-key').list(BIA, w.auditId));
  assert.deepEqual(covered.witness, { status: 'CONSISTENT', knownHeads: 1, coveredSeq: 1, unwitnessedAffecting: 1 }, 'ANTES do ataque a tela já declara 1 revogação sem testemunha (sem garantia)');
  fs.rmSync(anchorPath(w, 2)); // dois arquivos, em duas pastas (decisões e recibos): o resultado e o recibo dele ficam
  quarantine(w, 2);
  const after = await must(afterRotation(w, e, 'same-key').list(BIA, w.auditId));
  assert.deepEqual([after.witness.status, after.decisions.map((d) => d.decisionId), after.finalizable], ['CONSISTENT', ['op-0001'], true], 'LIMITE: a janela abre na revogação e só fecha no PRÓXIMO resultado selado; este teste muda quando o livro de cabeças existir');
});
