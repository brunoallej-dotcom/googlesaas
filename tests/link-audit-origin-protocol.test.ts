import { WITNESS_NOT_REQUIRED } from '../src/lib/link-audit-decisions/witness';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDecisionService, type PendingDto } from '../src/lib/link-audit-decisions';
import { DECISION_FILE_KIND, DECISION_SCHEMA_VERSION } from '../src/lib/link-audit-decisions/types';
import { createOriginAuthenticator, originConfigFromEnv, type OriginAuthenticator } from '../src/lib/link-audit-origin';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { parseScoringInput, scoreAudit } from '../src/lib/link-audit/scoring/index';
import { deriveOutcome, MINIMUM_COVERAGE_PERCENT } from '../src/lib/link-audit-scoring-runs/outcome';
import { verifyRunRecord } from '../src/lib/link-audit-scoring-runs/results-verify';
import { MAPPER_VERSION } from '../src/lib/link-audit-scoring-runs/types';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { ANA, BIA, clock, entryPath, hashTree, must, registerCleanup, rec, world, type World } from './helpers/link-audit-decisions-fixtures';
import { OTHER_ORIGIN, OTHER_ORIGIN_KEY, TEST_ORIGIN, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, RES_AUDIT, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { richInput } from './helpers/link-audit-scoring-fixtures';

/*
 * REMEDIAÇÃO DO MAJOR-1 (revisão adversarial independente, RV-01/RV-04): PROVA DE ORIGEM das pendências.
 * Invariante: uma operação criada ou adulterada SÓ numa pasta (decisões OU resultados), por quem não tem a chave do servidor nem a sessão do
 * operador, NUNCA vira CONFIRMADA/ACTIVE porque um operador legítimo acionou a recuperação — nem o "autor" nomeado no arquivo.
 * Os ataques abaixo foram reproduzidos no código anterior (confirmado por teste: a conclusão era aceita); aqui exige-se a recusa.
 */
registerCleanup();

const key = (pending: PendingDto | null | undefined): string => JSON.stringify([pending?.origin, pending?.originDetail, pending?.isMine, pending?.record === null, pending?.recordedBy]);
const svcOf = (w: World, origin?: OriginAuthenticator, fsOps?: FsOps) =>
  createDecisionService({ knownHeads: WITNESS_NOT_REQUIRED, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir, ...(origin ? { origin } : {}), ...(fsOps ? { fs: fsOps } : {}) });
/** Disco cheio SÓ na pasta de recibos: a decisão/resultado é publicado e fica PENDENTE (gravação legítima interrompida). */
const receiptsFail = (anchorDir: string): FsOps =>
  faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(anchorDir)) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });

/* ================================================================================== o módulo de origem */

test('origem: etiqueta por domínio, ligada ao corpo inteiro; ausente/adulterada/outra chave são distintas; rotação por chave anterior', () => {
  const body = { kind: 'X', auditId: 'auditoria-origem-01', seq: 2, prevSha256: null, recordedBy: 'ana@empresa.com', n: 1 };
  const proof = TEST_ORIGIN.sign('DECISION', body);
  assert.deepEqual(Object.keys(proof).sort(), ['kid', 'tag', 'v']);
  assert.match(proof.tag, /^[0-9a-f]{64}$/);
  const entry = { ...body, origin: proof, contentSha256: 'a'.repeat(64) };
  assert.equal(TEST_ORIGIN.verify('DECISION', entry), 'PROVEN');
  assert.equal(TEST_ORIGIN.verify('DECISION', { ...entry, contentSha256: 'b'.repeat(64) }), 'PROVEN', 'o selo (contentSha256) não faz parte da etiqueta: ele muda ao incluir o próprio origin');
  assert.equal(TEST_ORIGIN.verify('DECISION', { n: 1, prevSha256: null, seq: 2, auditId: 'auditoria-origem-01', recordedBy: 'ana@empresa.com', kind: 'X', origin: proof }), 'PROVEN', 'a ordem das chaves não importa (JSON canônico)');
  assert.equal(TEST_ORIGIN.verify('RUN', entry), 'INVALID', 'domínios separados: etiqueta de decisão não vale como de resultado');
  for (const change of [{ seq: 3 }, { recordedBy: 'bia@empresa.com' }, { prevSha256: 'c'.repeat(64) }, { auditId: 'auditoria-origem-02' }, { n: 2 }]) {
    assert.equal(TEST_ORIGIN.verify('DECISION', { ...entry, ...change }), 'INVALID', JSON.stringify(change));
  }
  const { origin, ...unsigned } = entry;
  void origin;
  assert.equal(TEST_ORIGIN.verify('DECISION', unsigned), 'MISSING');
  assert.equal(TEST_ORIGIN.verify('DECISION', { ...entry, origin: { ...proof, tag: 'z'.repeat(64) } }), 'INVALID');
  assert.equal(TEST_ORIGIN.verify('DECISION', { ...entry, origin: { ...proof, extra: 1 } }), 'INVALID', 'esquema estrito');
  assert.equal(TEST_ORIGIN.verify('DECISION', { ...entry, origin: 'forjada' }), 'INVALID');
  assert.equal(OTHER_ORIGIN.verify('DECISION', entry), 'KEY_MISMATCH', 'etiqueta de OUTRA chave não vale');
  assert.notEqual(TEST_ORIGIN.keyId, OTHER_ORIGIN.keyId);
  // rotação: a chave NOVA assina; a ANTERIOR só verifica
  const rotated = createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, retired: [`${TEST_ORIGIN_KEY}:2026-12-31`], now: () => new Date('2026-11-01T00:00:00.000Z') });
  assert.equal(rotated.verify('DECISION', entry), 'PROVEN');
  assert.equal(rotated.sign('DECISION', body).kid, OTHER_ORIGIN.keyId);
  assert.equal(TEST_ORIGIN.verify('DECISION', { ...body, origin: rotated.sign('DECISION', body) }), 'KEY_MISMATCH');
});

test('origem: sem chave, ou com chave malformada/fraca, nada é assinado nem comprovado; o ambiente do SERVIDOR é a única fonte (política completa em link-audit-origin-keys)', () => {
  assert.throws(() => createOriginAuthenticator('curta'));
  assert.deepEqual(originConfigFromEnv({}), { ok: false, code: 'ORIGIN_KEY_NOT_CONFIGURED' });
  assert.deepEqual(originConfigFromEnv({ GMN_LINK_AUDIT_ORIGIN_KEY: 'curta' }), { ok: false, code: 'ORIGIN_KEY_WEAK' });
  const ok = originConfigFromEnv({ GMN_LINK_AUDIT_ORIGIN_KEY: TEST_ORIGIN_KEY });
  assert.ok(ok.ok && ok.authenticator.keyId === TEST_ORIGIN.keyId);
  assert.ok(!JSON.stringify(ok).includes(TEST_ORIGIN_KEY.split(':')[1] as string), 'o material da chave nunca sai do autenticador');
});

/* ================================================================================== 6B — decisões */

/** Entrada FORJADA por quem só escreve na pasta de decisões (sem etiqueta; o selo SHA-256 qualquer um refaz). */
async function forgeDecision(w: World, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const versions = await w.reader.listVersions(ANA, w.auditId);
  const latest = versions.filter((v) => v.capture !== null).sort((a, b) => (b.capture as number) - (a.capture as number))[0]!;
  const last = fs.existsSync(path.join(w.decisionsDir, w.auditId)) ? fs.readdirSync(path.join(w.decisionsDir, w.auditId)).filter((n) => /^d\d{4}\.json$/.test(n)).sort() : [];
  const prev = last.length ? (JSON.parse(fs.readFileSync(path.join(w.decisionsDir, w.auditId, last[last.length - 1] as string), 'utf8')) as { contentSha256: string; seq: number; recordedAt: string }) : null;
  const seq = (prev?.seq ?? 0) + 1;
  const forged = seal({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: DECISION_FILE_KIND,
    auditId: w.auditId,
    action: 'RECORD',
    recordedAt: prev?.recordedAt ?? '2026-10-21T11:00:00.000Z', // respeita a monotonia da cadeia: o que se isola aqui é a ORIGEM, não uma checagem de data
    recordedBy: ANA.email,
    decisionId: `op-${String(seq).padStart(4, '0')}`,
    record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Texto forjado por quem só escreve na pasta de decisões.' },
    supersedes: null,
    basis: { capture: latest.capture, report: null, collectedAt: latest.collectedAt },
    seq,
    prevSha256: prev?.contentSha256 ?? null,
    ...over,
  }) as unknown as Record<string, unknown>;
  fs.mkdirSync(path.join(w.decisionsDir, w.auditId), { recursive: true });
  fs.writeFileSync(entryPath(w, seq), serialize(forged), { mode: 0o444 });
  return forged;
}

test('6B RV-04 (ataque original): decisão forjada em nome de ANA SÓ na pasta de decisões NÃO vira ACTIVE quando ANA reenvia a operação; nada é gravado, nada vale, nada fica visível', async () => {
  const w = await world();
  const forged = await forgeDecision(w);
  const svc = svcOf(w, TEST_ORIGIN);
  const listed = await must(svc.list(ANA, w.auditId));
  // o servidor NÃO afirma o autor nem mostra o conteúdo da pendente forjada
  assert.equal(key(listed.pending), JSON.stringify(['UNPROVEN', 'MISSING', false, true, null]));
  assert.deepEqual([listed.decisions.length, listed.operatorRecords.length, listed.finalizable, listed.head], [0, 0, false, null]);
  const anchorsBefore = hashTree(w.anchorDir);
  const decisionsBefore = hashTree(w.decisionsDir);
  const operation = forged.record as never;
  // a PRÓPRIA ANA reenvia exatamente a operação do arquivo (é o que a interface montava a partir do servidor)
  const byAuthor = await svc.create(ANA, w.auditId, { record: operation, expectedHead: null }, clock);
  assert.ok(!byAuthor.ok && byAuthor.code === 'PENDING_ORIGIN_UNPROVEN', JSON.stringify(byAuthor).slice(0, 200));
  assert.equal(byAuthor.pending?.isMine, false);
  // outro operador também não
  const byOther = await svc.create(BIA, w.auditId, { record: operation, expectedHead: null }, clock);
  assert.ok(!byOther.ok && byOther.code === 'PENDING_UNCONFIRMED');
  assert.deepEqual(hashTree(w.anchorDir), anchorsBefore, 'nenhum recibo foi criado');
  assert.deepEqual(hashTree(w.decisionsDir), decisionsBefore, 'nada foi reescrito');
  const after = await must(svc.list(ANA, w.auditId));
  assert.deepEqual([after.decisions.length, after.operatorRecords.length, after.finalizable, key(after.pending)], [0, 0, false, key(listed.pending)], 'continua pendente: bloqueia, nunca vale');
});

test('6B: forja com AUTOR FALSIFICADO e etiqueta COPIADA de uma entrada legítima é recusada (a etiqueta cobre auditId, seq, prev, autor e conteúdo)', async () => {
  const w = await world();
  const svc = svcOf(w, TEST_ORIGIN);
  await must(svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock)); // d0001 legítima e assinada
  const legit = JSON.parse(fs.readFileSync(entryPath(w, 1), 'utf8')) as { origin: unknown };
  assert.ok(legit.origin, 'a entrada legítima carrega a etiqueta');
  const head = (await must(svc.list(ANA, w.auditId))).head;
  const forged = await forgeDecision(w, { origin: legit.origin, recordedBy: BIA.email, record: rec.p3(5) }); // d0002: etiqueta copiada, autor e conteúdo trocados
  void forged;
  assert.equal(key((await must(svc.list(BIA, w.auditId))).pending), JSON.stringify(['UNPROVEN', 'INVALID', false, true, null]));
  const r = await svc.create(BIA, w.auditId, { record: rec.p3(5), expectedHead: head }, clock);
  assert.ok(!r.ok && r.code === 'PENDING_ORIGIN_UNPROVEN');
  assert.equal(fs.readdirSync(path.join(w.anchorDir, w.auditId)).length, 1, 'só o recibo da d0001 existe');
});

test('6B: adulterar uma pendente LEGÍTIMA (muda a justificativa e refaz o selo) a torna não comprovada', async () => {
  const w = await world();
  const failing = svcOf(w, TEST_ORIGIN, receiptsFail(w.anchorDir));
  const first = await failing.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!first.ok && first.code === 'ANCHOR_PENDING');
  const file = entryPath(w, 1);
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  delete body.contentSha256;
  body.record = { ...body.record, justification: 'Conteúdo trocado por quem escreve na pasta de decisões.' };
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal(body))); // selo SHA-256 refeito: o hash NÃO é autenticação
  const healthy = svcOf(w, TEST_ORIGIN);
  const r = await healthy.create(ANA, w.auditId, { record: { ...(rec.c2() as object), justification: body.record.justification } as never, expectedHead: null }, clock);
  assert.ok(!r.ok && r.code === 'PENDING_ORIGIN_UNPROVEN', JSON.stringify(r).slice(0, 160));
  assert.equal(fs.existsSync(path.join(w.anchorDir, w.auditId, 'a0001.json')), false);
});

test('6B: pendência LEGÍTIMA continua recuperável (também depois de reiniciar o serviço); outro operador vê a origem comprovada, mas sem conteúdo, e nunca a conclui', async () => {
  const w = await world();
  const failing = svcOf(w, TEST_ORIGIN, receiptsFail(w.anchorDir));
  const first = await failing.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!first.ok && first.code === 'ANCHOR_PENDING');
  assert.equal(key(first.pending), JSON.stringify(['PROVEN', null, true, false, 'ana@empresa.com']), 'o autor, com origem comprovada, vê o que vai concluir');
  // "reinício": instância nova sobre as mesmas pastas
  const restarted = svcOf(w, TEST_ORIGIN);
  const byOther = await restarted.create(BIA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!byOther.ok && byOther.code === 'PENDING_UNCONFIRMED');
  assert.equal(key(byOther.pending), JSON.stringify(['PROVEN', null, false, true, 'ana@empresa.com']), 'outro operador: autor comprovado, conteúdo oculto');
  const done = await must(restarted.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  assert.deepEqual([done.replayed, done.decision.status, done.decision.decisionId], [true, 'ACTIVE', 'op-0001']);
  const after = await must(restarted.list(BIA, w.auditId));
  assert.deepEqual([after.pending, after.finalizable, after.decisions.length], [null, true, 1]);
});

test('6B: pendência SEM etiqueta (gravada antes da proteção), servidor SEM chave ou com OUTRA chave: a conclusão é recusada; com a chave anterior mantida (rotação), é aceita', async () => {
  // (a) legada: arquivo do formato ANTERIOR à proteção (sem etiqueta), mesmo sendo legítimo. Hoje nenhum serviço grava sem etiqueta (a primitiva
  //     recusa); o arquivo legado é reconstruído como ele existiria em disco: o legítimo, sem `origin`, com o selo refeito.
  const legacyWorld = await world();
  const legacy = svcOf(legacyWorld, TEST_ORIGIN, receiptsFail(legacyWorld.anchorDir));
  assert.ok(!(await legacy.create(ANA, legacyWorld.auditId, { record: rec.c2(), expectedHead: null }, clock)).ok);
  const legacyFile = JSON.parse(fs.readFileSync(entryPath(legacyWorld, 1), 'utf8')) as Record<string, unknown>;
  delete legacyFile.origin;
  delete legacyFile.contentSha256;
  fs.chmodSync(entryPath(legacyWorld, 1), 0o644);
  fs.writeFileSync(entryPath(legacyWorld, 1), serialize(seal(legacyFile)));
  assert.equal(JSON.parse(fs.readFileSync(entryPath(legacyWorld, 1), 'utf8')).origin, undefined);
  // um serviço SEM autenticador não grava nada, nem conclui: recusa explícita (503 nas rotas)
  const refused = await svcOf(legacyWorld).create(ANA, legacyWorld.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!refused.ok && refused.code === 'ORIGIN_KEY_NOT_CONFIGURED');
  const upgraded = svcOf(legacyWorld, TEST_ORIGIN);
  const legacyTry = await upgraded.create(ANA, legacyWorld.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!legacyTry.ok && legacyTry.code === 'PENDING_ORIGIN_UNPROVEN' && legacyTry.pending?.originDetail === 'MISSING', 'pendência antiga sem comprovação não é confirmada automaticamente');
  // (b) assinada, mas o servidor atual não tem chave: não verificável
  const w = await world();
  assert.ok(!(await svcOf(w, TEST_ORIGIN, receiptsFail(w.anchorDir)).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock)).ok);
  const noKey = svcOf(w);
  assert.equal(key((await must(noKey.list(ANA, w.auditId))).pending), JSON.stringify(['UNVERIFIABLE', 'NO_KEY', false, true, null]));
  const noKeyTry = await noKey.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!noKeyTry.ok && noKeyTry.code === 'ORIGIN_KEY_NOT_CONFIGURED', 'sem autenticador nada é gravado nem concluído');
  assert.equal(fs.existsSync(path.join(w.anchorDir, w.auditId, 'a0001.json')), false);
  // (c) chave trocada sem manter a anterior
  const changed = svcOf(w, OTHER_ORIGIN);
  const changedTry = await changed.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!changedTry.ok && changedTry.code === 'PENDING_ORIGIN_UNPROVEN' && changedTry.pending?.originDetail === 'KEY_MISMATCH');
  assert.equal(fs.existsSync(path.join(w.anchorDir, w.auditId, 'a0001.json')), false);
  // (d) rotação correta: nova chave + anterior só para verificar
  const rotated = svcOf(w, createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, retired: [`${TEST_ORIGIN_KEY}:2026-12-31`], now: () => new Date('2026-11-01T00:00:00.000Z') }));
  const ok = await must(rotated.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  assert.equal(ok.decision.status, 'ACTIVE');
});

test('6B: REVOGAÇÃO forjada (para derrubar uma decisão vigente) também é recusada; a decisão fica EM DÚVIDA (fail-safe) e nada é finalizável', async () => {
  const w = await world();
  const svc = svcOf(w, TEST_ORIGIN);
  const created = await must(svc.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  await forgeDecision(w, { action: 'REVOKE', revokes: 'op-0001', reason: 'Revogação forjada por quem só escreve na pasta de decisões.', decisionId: undefined, record: undefined, supersedes: undefined, basis: undefined });
  const forgedFile = JSON.parse(fs.readFileSync(entryPath(w, 2), 'utf8')) as Record<string, unknown>;
  assert.equal(forgedFile.action, 'REVOKE');
  const r = await svc.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Revogação forjada por quem só escreve na pasta de decisões.', expectedHead: created.head }, clock);
  assert.ok(!r.ok && r.code === 'PENDING_ORIGIN_UNPROVEN', JSON.stringify(r).slice(0, 200));
  const view = await must(svc.list(ANA, w.auditId));
  // a forja nunca vale (não é concluída); e, sem certeza do estado, a decisão alvo não é projetada como vigente nem como revogada
  assert.deepEqual([view.decisions.map((d) => d.decisionId), view.ambiguousDecisionIds, view.finalizable, view.pending?.origin], [[], ['op-0001'], false, 'UNPROVEN']);
  assert.equal(fs.existsSync(path.join(w.anchorDir, w.auditId, 'a0002.json')), false, 'nenhum recibo para a forja');
});

/* ================================================================================== 6C — resultados */

/** Resultado FORJADO por quem só escreve na pasta de resultados: fatos de perfil FABRICADOS, hashes reais, selo refeito, autor à escolha. */
async function forgeRun(w: World, e: ResultsEnv, finalizedBy: string, seq = 1, over: Record<string, unknown> = {}) {
  const preview = previewOver(w);
  const real = await preview.evaluate(OP_B, w.auditId);
  assert.ok(real.ok, JSON.stringify(real));
  const ev = real.value;
  assert.equal(ev.outcome?.outcome, 'INCONCLUSIVO', 'os dados reais só sustentam INCONCLUSIVO');
  const src = (ev.mapped!.traceability.profile as any).source.ref as string;
  const rich = richInput() as any;
  const forgedInput = JSON.parse(JSON.stringify(ev.input)) as any;
  for (const field of ['address', 'hours', 'description', 'services', 'attributes', 'products', 'logoCover', 'photos', 'videos', 'latestMedia', 'latestReviewDate', 'posts', 'actions']) {
    forgedInput.profile[field] = rich.profile[field].map((o: any) => ({ ...o, evidenceIds: [src], complete: false }));
  }
  const scored = scoreAudit(forgedInput);
  assert.ok(scored.ok);
  const result = (scored as any).result;
  const outcome = deriveOutcome(result);
  const trace = ev.mapped!.traceability;
  const prevFile = seq > 1 ? (JSON.parse(fs.readFileSync(path.join(e.base, w.auditId, `s${String(seq - 1).padStart(4, '0')}.json`), 'utf8')) as { contentSha256: string; finalizedAt: string }) : null;
  const draft = {
    schemaVersion: 1,
    kind: 'LINK_AUDIT_SCORE_RUN',
    auditId: w.auditId,
    finalizedAt: prevFile?.finalizedAt ?? '2026-10-23T09:00:00.000Z', // monotonia da cadeia respeitada: o que se isola é a ORIGEM
    finalizedBy,
    outcome: outcome.outcome,
    scored: outcome.outcome === 'PONTUADO' ? { level: outcome.level } : null,
    inconclusive: outcome.outcome === 'INCONCLUSIVO' ? { reasonCode: outcome.reasonCode, failedGates: [...outcome.failedGates], coveragePercent: outcome.coveragePercent, minimumCoveragePercent: MINIMUM_COVERAGE_PERCENT } : null,
    scoringAuditId: trace.auditId!.scoringAuditId,
    auditIdAlias: { applied: trace.auditId!.applied, rule: trace.auditId!.rule, reason: trace.auditId!.reason, sourceAuditId: trace.auditId!.sourceAuditId },
    decisions: { head: ev.decisions.head, count: 0, appliedIds: [], applied: [] },
    layout: ev.basis!.layout,
    evidenceBasis: trace.evidences.map((i: any) => ({ ref: i.ref, kind: i.kind, observedAt: i.observedAt, contentSha256: i.contentSha256, bodySha256: i.bodySha256, legacy: i.legacy, superseded: i.superseded })),
    profileSource: (() => { const s = (trace.profile as any).source; return { ref: s.ref, observedAt: s.observedAt, contentSha256: s.contentSha256, bodySha256: s.bodySha256 }; })(),
    referenceDate: forgedInput.referenceDate,
    referenceDateSource: { ...trace.referenceDateSource! },
    websiteDerivation: null,
    mapperVersion: MAPPER_VERSION,
    methodologyVersion: result.methodologyVersion,
    scoreModelVersion: result.scoreModelVersion,
    rulerFingerprint: result.rulerFingerprint,
    input: JSON.parse(JSON.stringify((parseScoringInput(forgedInput) as any).input)),
    result: JSON.parse(JSON.stringify(result)),
    inputSha256: result.inputSha256,
    resultSha256: result.resultSha256,
    ...over,
  };
  const forged = seal({ ...draft, seq, prevSha256: prevFile?.contentSha256 ?? null }) as any;
  assert.deepEqual(verifyRunRecord(forged), [], 'o registro forjado passa na verificação SEMÂNTICA (é autoconsistente): por isso a origem é que precisa ser provada');
  fs.mkdirSync(path.join(e.base, w.auditId), { recursive: true });
  const file = path.join(e.base, w.auditId, `s${String(seq).padStart(4, '0')}.json`);
  fs.writeFileSync(file, serialize(forged));
  fs.chmodSync(file, 0o444);
  return { forged, preview };
}

test('6C RV-01 (ataque original): resultado PONTUADO FORJADO só na pasta de resultados NÃO é concluído quando o autor nomeado reenvia o pedido montado a partir do servidor; nenhum recibo; nada de índice', async () => {
  const w = await world();
  const e = resultsEnv();
  const { forged, preview } = await forgeRun(w, e, OP_B.email);
  assert.equal(forged.outcome, 'PONTUADO', 'o ataque original produzia PONTUADO com fatos fabricados');
  const svc = makeService(e, preview);
  const listed = await svc.list(OP_B, w.auditId);
  assert.ok(listed.ok);
  const p = listed.value.pending!;
  assert.deepEqual([p.origin, p.originDetail, p.isMine, p.outcome, p.level, p.coveragePercent, p.appliedDecisionCount], ['UNPROVEN', 'MISSING', false, null, null, null, null], 'o servidor não afirma autoria nem desfecho de arquivo não comprovado');
  const receiptsBefore = hashTree(e.anchors);
  const runsBefore = hashTree(e.base);
  // o que `completePendingRun` enviava (SÓ dados do servidor)
  const concluded = await svc.finalize(OP_B, w.auditId, { expectedHead: p.decisionsHead, expectedInputSha256: p.inputSha256 });
  assert.ok(!concluded.ok && concluded.code === 'RESULT_PENDING_ORIGIN_UNPROVEN', JSON.stringify(concluded).slice(0, 200));
  assert.deepEqual(hashTree(e.anchors), receiptsBefore, 'NENHUM recibo foi gravado');
  assert.deepEqual(hashTree(e.base), runsBefore, 'nada foi reescrito');
  const after = await svc.list(OP_B, w.auditId);
  assert.ok(after.ok);
  assert.deepEqual([after.value.results.length, after.value.head, after.value.pending?.origin], [0, null, 'UNPROVEN'], 'continua pendente: nunca vira resultado');
  const got = await svc.get(OP_B, w.auditId, 1);
  assert.ok(!got.ok && got.code === 'RESULT_PENDING_UNCONFIRMED', 'o detalhe não é entregue');
  // outro operador (e o "autor" por outros caminhos) também não conclui
  const other = await svc.finalize(OP_A, w.auditId, { expectedHead: p.decisionsHead, expectedInputSha256: p.inputSha256 });
  assert.ok(!other.ok && other.code === 'RESULT_PENDING_UNCONFIRMED');
});

test('6C: forja com etiqueta COPIADA de um resultado legítimo (outro conteúdo, autor falsificado) continua recusada', async () => {
  const w = await world();
  const e = resultsEnv();
  const preview = previewOver(w);
  const svc = makeService(e, preview);
  const ev = await preview.evaluate(OP_B, w.auditId);
  assert.ok(ev.ok);
  const first = await svc.finalize(OP_B, w.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(first.ok, JSON.stringify(first).slice(0, 200));
  const legit = JSON.parse(fs.readFileSync(path.join(e.base, w.auditId, 's0001.json'), 'utf8')) as { origin: unknown };
  assert.ok(legit.origin, 'o resultado legítimo carrega a etiqueta');
  await forgeRun(w, e, OP_A.email, 2, { origin: legit.origin });
  const listed = await svc.list(OP_A, w.auditId);
  assert.ok(listed.ok);
  assert.deepEqual([listed.value.results.length, listed.value.pending?.origin, listed.value.pending?.originDetail, listed.value.pending?.isMine], [1, 'UNPROVEN', 'INVALID', false]);
  const p = listed.value.pending!;
  const r = await svc.finalize(OP_A, w.auditId, { expectedHead: p.decisionsHead, expectedInputSha256: p.inputSha256 });
  assert.ok(!r.ok && r.code === 'RESULT_PENDING_ORIGIN_UNPROVEN');
  assert.equal(fs.readdirSync(path.join(e.anchors, w.auditId)).length, 1);
});

test('6C: resultado pendente LEGÍTIMO continua recuperável pelo autor; outro operador nunca conclui; se o estado andou, ele nasce como histórico (stale)', async () => {
  const w = await world();
  const e = resultsEnv();
  const preview = previewOver(w);
  const failing = makeService(e, preview, { fs: receiptsFail(e.anchors) });
  const evaluated = await preview.evaluate(OP_B, w.auditId);
  assert.ok(evaluated.ok);
  const request = { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string };
  const first = await failing.finalize(OP_B, w.auditId, request);
  assert.ok(!first.ok && first.code === 'RESULT_ANCHOR_PENDING');
  assert.deepEqual([first.pending?.origin, first.pending?.isMine, first.pending?.outcome, first.pending?.coveragePercent, first.pending?.matchesCurrent === null], ['PROVEN', true, 'INCONCLUSIVO', 11, true]);
  // reinício + outro operador
  const healthy = makeService(e, preview);
  const viewByOther = await healthy.list(OP_A, w.auditId);
  assert.ok(viewByOther.ok);
  assert.deepEqual([viewByOther.value.pending?.origin, viewByOther.value.pending?.isMine, viewByOther.value.pending?.outcome], ['PROVEN', false, 'INCONCLUSIVO']);
  const otherTry = await healthy.finalize(OP_A, w.auditId, request);
  assert.ok(!otherTry.ok && otherTry.code === 'RESULT_PENDING_UNCONFIRMED');
  // o mundo anda (uma decisão nova muda a entrada) antes de o autor concluir
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const mine = await healthy.list(OP_B, w.auditId);
  assert.ok(mine.ok);
  assert.equal(mine.value.pending?.matchesCurrent, false, 'a tela é avisada: o resultado já nasce histórico');
  const done = await healthy.finalize(OP_B, w.auditId, request);
  assert.ok(done.ok, JSON.stringify(done).slice(0, 240));
  assert.deepEqual([done.value.replayed, done.value.recoveredPending, done.value.stateChangedAfterFinalization], [true, true, true]);
  const final = await healthy.list(OP_B, w.auditId);
  assert.ok(final.ok);
  assert.deepEqual([final.value.results.length, final.value.pending, final.value.results[0]?.stale, final.value.results[0]?.decisionsChanged], [1, null, true, true]);
});

test('6C: remover o último recibo de um resultado CONFIRMADO o torna pendente (indistinguível de gravação interrompida): a origem continua comprovada, o conteúdo NÃO muda e nenhum outro operador conclui', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation({ kind: 'INCONCLUSIVO' });
  const svc = makeService(e, new FakeEvaluator(ev));
  assert.ok((await svc.finalize(OP_B, RES_AUDIT, bodyOf(ev))).ok);
  const runBytes = fs.readFileSync(path.join(e.base, RES_AUDIT, 's0001.json'), 'utf8');
  const receiptFile = path.join(e.anchors, RES_AUDIT, 'a0001.json');
  const originalReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as Record<string, unknown>;
  fs.rmSync(path.join(e.anchors, RES_AUDIT), { recursive: true, force: true });
  const listed = await svc.list(OP_A, RES_AUDIT);
  assert.ok(listed.ok);
  assert.deepEqual([listed.value.results.length, listed.value.pending?.origin, listed.value.pending?.isMine], [0, 'PROVEN', false], 'a lista NÃO mostra o resultado como confirmado');
  const other = await svc.finalize(OP_A, RES_AUDIT, bodyOf(ev));
  assert.ok(!other.ok && other.code === 'RESULT_PENDING_UNCONFIRMED');
  const author = await svc.finalize(OP_B, RES_AUDIT, bodyOf(ev));
  assert.ok(author.ok && author.value.recoveredPending, 'o autor, com origem comprovada, recria o recibo do MESMO conteúdo (após confirmação na tela)');
  assert.equal(fs.readFileSync(path.join(e.base, RES_AUDIT, 's0001.json'), 'utf8'), runBytes, 'o resultado não foi reescrito');
  const recreated = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as Record<string, unknown>;
  assert.equal(recreated.headSha256, originalReceipt.headSha256, 'o recibo recriado aponta para o MESMO conteúdo');
});

test('6C: remover o recibo E adulterar o resultado (selo refeito) NÃO gera recuperação: a origem deixa de ser comprovada', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation({ kind: 'INCONCLUSIVO' });
  const svc = makeService(e, new FakeEvaluator(ev));
  assert.ok((await svc.finalize(OP_B, RES_AUDIT, bodyOf(ev))).ok);
  const file = path.join(e.base, RES_AUDIT, 's0001.json');
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  delete body.contentSha256;
  body.finalizedBy = OP_A.email; // troca o autor
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal(body)));
  fs.rmSync(path.join(e.anchors, RES_AUDIT), { recursive: true, force: true });
  const listed = await svc.list(OP_A, RES_AUDIT);
  assert.ok(listed.ok);
  assert.deepEqual([listed.value.pending?.origin, listed.value.pending?.originDetail, listed.value.pending?.isMine], ['UNPROVEN', 'INVALID', false]);
  const r = await svc.finalize(OP_A, RES_AUDIT, bodyOf(ev));
  assert.ok(!r.ok && r.code === 'RESULT_PENDING_ORIGIN_UNPROVEN');
  assert.equal(fs.existsSync(path.join(e.anchors, RES_AUDIT, 'a0001.json')), false, 'nenhum recibo recriado');
});

test('6C: sem chave no servidor, ou resultado de uma pendência antiga (sem etiqueta), a conclusão é recusada; reiniciar não muda isso', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation({ kind: 'INCONCLUSIVO' });
  const failing = makeService(e, new FakeEvaluator(ev), { fs: receiptsFail(e.anchors) });
  assert.ok(!(await failing.finalize(OP_B, RES_AUDIT, bodyOf(ev))).ok);
  const noKey = makeService(e, new FakeEvaluator(ev), { origin: undefined as never });
  const view = await noKey.list(OP_B, RES_AUDIT);
  assert.ok(view.ok);
  assert.deepEqual([view.value.pending?.origin, view.value.pending?.originDetail, view.value.pending?.isMine], ['UNVERIFIABLE', 'NO_KEY', false]);
  const r = await noKey.finalize(OP_B, RES_AUDIT, bodyOf(ev));
  assert.ok(!r.ok && r.code === 'ORIGIN_KEY_NOT_CONFIGURED', 'sem autenticador a finalização/conclusão é recusada (503 nas rotas)');
  assert.equal(fs.existsSync(path.join(e.anchors, RES_AUDIT, 'a0001.json')), false);
  // a pendência antiga, SEM etiqueta: o arquivo do formato anterior à proteção (nenhum serviço grava sem etiqueta hoje)
  const legacyEnv = resultsEnv();
  const legacyEval = buildEvaluation({ kind: 'INCONCLUSIVO' });
  assert.ok(!(await makeService(legacyEnv, new FakeEvaluator(legacyEval), { fs: receiptsFail(legacyEnv.anchors) }).finalize(OP_B, RES_AUDIT, bodyOf(legacyEval))).ok);
  const legacyRun = path.join(legacyEnv.base, RES_AUDIT, 's0001.json');
  const legacyBody = JSON.parse(fs.readFileSync(legacyRun, 'utf8')) as Record<string, unknown>;
  delete legacyBody.origin;
  delete legacyBody.contentSha256;
  fs.chmodSync(legacyRun, 0o644);
  fs.writeFileSync(legacyRun, serialize(seal(legacyBody)));
  assert.equal(JSON.parse(fs.readFileSync(legacyRun, 'utf8')).origin, undefined);
  const upgraded = makeService(legacyEnv, new FakeEvaluator(legacyEval));
  const legacyTry = await upgraded.finalize(OP_B, RES_AUDIT, bodyOf(legacyEval));
  assert.ok(!legacyTry.ok && legacyTry.code === 'RESULT_PENDING_ORIGIN_UNPROVEN' && legacyTry.pending?.originDetail === 'MISSING');
});

test('R3-MINOR-5 (API): o estado ESTRUTURADO do resultado sem recibo chega a TODOS os operadores — recibo ausente, bloqueia finalização, nunca confirmação — sem vazar conteúdo de origem não comprovada', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation({ kind: 'INCONCLUSIVO' });
  const failing = makeService(e, new FakeEvaluator(ev), { fs: receiptsFail(e.anchors) });
  assert.ok(!(await failing.finalize(OP_A, RES_AUDIT, bodyOf(ev))).ok);
  for (const [label, viewer, mine] of [['autor', OP_A, true], ['outro operador', OP_B, false]] as const) {
    const view = await must(makeService(e, new FakeEvaluator(ev)).list(viewer, RES_AUDIT));
    assert.deepEqual([view.pending?.receipt, view.pending?.blocksFinalization, view.pending?.origin, view.pending?.isMine, view.results.length], ['MISSING', true, 'PROVEN', mine, 0], label);
  }
  // origem NÃO comprovada (arquivo sem etiqueta): o estado estruturado é o mesmo, o conteúdo do arquivo não vai a ninguém
  const file = path.join(e.base, RES_AUDIT, 's0001.json');
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete body.origin;
  delete body.contentSha256;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal(body)));
  for (const viewer of [OP_A, OP_B]) {
    const view = await must(makeService(e, new FakeEvaluator(ev)).list(viewer, RES_AUDIT));
    assert.deepEqual([view.pending?.receipt, view.pending?.blocksFinalization, view.pending?.origin, view.pending?.isMine, view.pending?.outcome, view.pending?.coveragePercent], ['MISSING', true, 'UNPROVEN', false, null, null], viewer.email);
  }
});
