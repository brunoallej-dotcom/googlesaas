import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scoreAudit } from '../src/lib/link-audit/scoring';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { writeCapture } from '../src/lib/link-audit-evidence/store';
import type { ListPayload } from '../src/lib/link-audit-decisions';
import { PREVIEW_HTTP_STATUS, type PreviewFailure, type PreviewPayload, type PreviewResult } from '../src/lib/link-audit-scoring-runs';
import { anchorPath, clock, hashTree, must, rec, registerCleanup, world, type World } from './helpers/link-audit-decisions-fixtures';
import { bodyText, captureInput, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';
import { addCapture } from './helpers/link-audit-mapper-real-basis';
import { ANA, c2Record, clockFixed, equivalenceRecord, fakeList, NOW, operatorRecord, previewOver, s4Record } from './helpers/link-audit-preview-fixtures';

/*
 * Onda 6C, I3 — serviço de PRÉVIA. Stores reais em pastas temporárias (evidências, decisões, âncoras) e o leitor real do I1; o motor
 * é o real. Doubles só onde a falha não é alcançável sem adulterar o disco (várias decisões conflitantes, head que muda no meio).
 */
registerCleanup();

const ok = (result: PreviewResult): PreviewPayload => {
  assert.ok(result.ok, result.ok ? '' : `${result.code} ${result.issues.join('|')}`);
  return result.value;
};
const failed = (result: PreviewResult): PreviewFailure => {
  assert.ok(!result.ok, 'esperava falha');
  return result;
};
const sub = (payload: PreviewPayload, id: string) => payload.criteria.flatMap((criterion) => criterion.subcriteria).find((item) => item.id === id);
const codes = (payload: PreviewPayload): string[] => payload.blockers.map((b) => `${b.severity}:${b.code}`);
const snapshotAll = (w: Pick<World, 'evidenceDir' | 'decisionsDir' | 'anchorDir'>) => [hashTree(w.evidenceDir), hashTree(w.decisionsDir), hashTree(w.anchorDir)];

/* ---------------------------------------------------------------- 1. auditoria válida, resultado inconclusivo */
test('auditoria válida com cobertura insuficiente: 200 com desfecho INCONCLUSIVO (index:null) — NÃO é erro, NÃO é bloqueio, NÃO é falha de integridade — e é finalizável', async () => {
  const w = await world();
  const before = snapshotAll(w);
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.equal(payload.definitive, false);
  assert.equal(payload.state, 'CALCULADO_FINALIZAVEL');
  assert.deepEqual(payload.blockers, []);
  assert.deepEqual(payload.outcomePreview, { outcome: 'INCONCLUSIVO', level: null, reasonCode: 'COBERTURA_INSUFICIENTE', failedGates: payload.outcomePreview?.failedGates, coveragePercent: 11, minimumCoveragePercent: 40 });
  assert.deepEqual([...(payload.outcomePreview?.failedGates ?? [])].sort(), ['COVERAGE_MIN', 'CRITERIA_MIN']);
  assert.equal(payload.finalization.allowed, true);
  assert.deepEqual([payload.result?.index, payload.result?.confidence, payload.result?.naSensitivity], [null, null, null]);
  assert.equal(payload.company.located, true);
  assert.equal(payload.evidence.integrity.status, 'OK');
  assert.deepEqual(snapshotAll(w), before, 'a prévia não grava nada em nenhuma das três pastas');
});

test('INCONCLUSIVO nunca expõe nota: sem índice, classificação, confiança, sensibilidade ao N/A nem pontos obtidos (agregados, por critério ou por subcritério)', async () => {
  const w = await world();
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  const text = JSON.stringify(payload);
  assert.ok(!/obtainedHalfPoints/.test(text), 'nenhum ponto obtido em lugar algum da resposta');
  const result = payload.result as Record<string, any>;
  assert.equal(Object.hasOwn(result.totals, 'obtainedHalfPoints'), false);
  for (const item of result.criteria) assert.equal(Object.hasOwn(item, 'obtainedHalfPoints'), false);
  for (const item of result.subcriteria) assert.equal(Object.hasOwn(item, 'obtainedHalfPoints'), false);
  assert.equal(Object.hasOwn(result, 'displayData'), false);
  assert.ok(result.totals.coveragePercent === 11 && result.totals.evaluatedHalfPoints === 22, 'cobertura e portões continuam visíveis');
  assert.ok(!/"classification"|"decimal2"|"shown"/.test(text) || result.index === null);
  assert.equal(sub(payload, 'N1')?.state, 'SCORED');
  assert.equal(sub(payload, 'N1')?.tier, 'presente');
  assert.equal(sub(payload, 'N1')?.obtainedHalfPoints, undefined);
});

test('o desfecho aponta o que falta para o mínimo (potencial NÃO comprovado) e a matriz tem as 4 fontes, sem inventar dado', async () => {
  const w = await world();
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.ok(payload.missing.length > 0 && payload.missing.every((item) => item.note === 'potencial, ainda não comprovado'));
  assert.equal(payload.missing.find((item) => item.family === 'M4A_EXCLUDED')?.potentialHalfPoints, 24);
  assert.equal(payload.missing.find((item) => item.family === 'AWAITING_OPERATOR_DECISION')?.potentialHalfPoints, 8);
  assert.equal(payload.criteria.length, 9);
  assert.equal(payload.criteria.flatMap((c) => c.subcriteria).length, 35);
  assert.deepEqual(payload.decisionOptions.map((o) => [o.subcriterionId, o.available]), [['C2', true], ['S4', true]]);
});

/* ---------------------------------------------------------------- 2. sem evidências, evidência adulterada */
test('auditoria inexistente ⇒ AUDIT_NOT_FOUND; pasta sem captura+relatório ⇒ 200 SEM_EVIDENCIA com bloqueio NO_STORED_CAPTURE e nenhum resultado', async () => {
  const w = await world({ seed: false });
  assert.equal(failed(await previewOver(w).preview(ANA, w.auditId)).code, 'AUDIT_NOT_FOUND');
  assert.equal(PREVIEW_HTTP_STATUS.AUDIT_NOT_FOUND, 404);
  const created = await writeCapture(w.evidenceDir, captureInput({ auditId: w.auditId })); // captura sem relatório
  assert.ok(created.ok);
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.equal(payload.state, 'SEM_EVIDENCIA');
  assert.deepEqual(codes(payload), ['BLOCKING:NO_STORED_CAPTURE']);
  assert.deepEqual([payload.result, payload.outcomePreview, payload.scoringAuditId, payload.finalization.allowed, payload.finalization.expectedInputSha256], [null, null, null, false, null]);
  assert.equal(payload.criteria.flatMap((c) => c.subcriteria).length, 35);
  assert.deepEqual(payload.evidence.bases, []);
});

test('evidência adulterada ⇒ 409 EVIDENCE_INTEGRITY SEM nenhum dado (nem de decisões), em qualquer arquivo da coleta', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const file = path.join(w.evidenceDir, w.auditId, 'c0001.capture.json');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Padaria Exemplo (fictícia)', 'Outra Empresa'));
  const result = failed(await previewOver(w).preview(ANA, w.auditId));
  assert.equal(result.code, 'EVIDENCE_INTEGRITY');
  assert.equal(PREVIEW_HTTP_STATUS.EVIDENCE_INTEGRITY, 409);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'issues', 'ok']);
  assert.ok(!JSON.stringify(result).includes('Outra Empresa') && !JSON.stringify(result).includes('Padaria'));
});

test('decisões adulteradas ou truncadas ⇒ 409 do serviço de decisões, sem dados', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(anchorPath(w, 1), { force: true });
  await must(w.service.list(ANA, w.auditId)).catch(() => undefined);
  const file = path.join(w.decisionsDir, w.auditId, 'd0001.json');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('COMPATIBLE', 'INCOMPATIBLE'));
  const result = failed(await previewOver(w).preview(ANA, w.auditId));
  assert.ok(['DECISIONS_INTEGRITY', 'ANCHOR_INTEGRITY', 'ANCHOR_MISMATCH', 'DECISIONS_TRUNCATED'].includes(result.code), result.code);
  assert.equal(PREVIEW_HTTP_STATUS[result.code], 409);
});

/* ---------------------------------------------------------------- 3. decisões */
test('decisão C2 confirmada e ligada à captura correta ⇒ aplicada: C2 pontua (8 hp), cobertura 15 %, rastreada ao op-NNNN e ao head consultado', async () => {
  const w = await world();
  const created = await must(w.service.create(ANA, w.auditId, { record: rec.c2('PARTIAL') }, clock()));
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.deepEqual(payload.decisions.applied, ['op-0001']);
  assert.deepEqual(payload.decisions.held, []);
  assert.deepEqual(payload.decisions.head, created.head);
  assert.deepEqual(payload.finalization.expectedHead, created.head);
  const c2 = sub(payload, 'C2');
  assert.deepEqual([c2?.state, c2?.source, c2?.decisionIds, c2?.evaluatedHalfPoints], ['SCORED', 'DECISAO_HUMANA', ['op-0001'], 8]);
  assert.equal(payload.outcomePreview?.coveragePercent, 15);
  assert.equal(payload.state, 'CALCULADO_FINALIZAVEL');
  assert.equal(payload.decisionOptions[0]?.reasonCode, 'EXISTING_DECISION_REPLACE');
});

test('decisão PENDENTE (sem recibo) ⇒ não vale, não entra no cálculo, bloqueia e o estado é DECISAO_PENDENTE; finalizável nunca é true', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(anchorPath(w, 1), { force: true }); // recibo removido: indistinguível de uma gravação interrompida
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.equal(payload.state, 'DECISAO_PENDENTE');
  assert.equal(payload.decisions.finalizable, false);
  assert.deepEqual([payload.decisions.pending?.seq, payload.decisions.pending?.decisionId], [1, 'op-0001']);
  assert.deepEqual(payload.blockers.map((b) => [b.code, b.severity, b.decisionIds]), [['DECISION_PENDING', 'BLOCKING', ['op-0001']]]);
  assert.equal(payload.finalization.allowed, false);
  assert.equal(JSON.stringify(payload.decisions.pending).includes('ana@'), false, 'nem autor nem texto livre da pendente saem');
});

test('REVOGAÇÃO pendente ⇒ a decisão possivelmente revogada continua vigente e fica apontada (op-NNNN) no bloqueio; nada é finalizável', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Informação conferida e incorreta; decisão desfeita.' }, clock()));
  fs.rmSync(anchorPath(w, 2), { force: true });
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.equal(payload.state, 'DECISAO_PENDENTE');
  assert.deepEqual(payload.decisions.applied, ['op-0001'], 'sem o recibo a revogação não vale');
  assert.deepEqual([payload.decisions.pending?.action, payload.decisions.pending?.revokes], ['REVOKE', 'op-0001']);
  assert.deepEqual(payload.blockers.map((b) => [b.code, b.decisionIds]), [['DECISION_PENDING', ['op-0001']]]);
  assert.equal(payload.finalization.allowed, false);
});

test('revogação CONFIRMADA ⇒ a decisão sai do cálculo e a prévia volta a ser finalizável', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: 'Informação conferida e incorreta; decisão desfeita.' }, clock()));
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.deepEqual([payload.decisions.applied, payload.decisions.count, sub(payload, 'C2')?.state, payload.state], [[], 0, 'NOT_VERIFIED', 'CALCULADO_FINALIZAVEL']);
});

test('decisões humanas FORA do contrato aprovado ficam RETIDAS: não entram na entrada, bloqueiam, são apontadas pelo op-NNNN e a prévia segue calculando', async () => {
  const w = await world();
  const kinds: Array<[string, Record<string, unknown>, string]> = [
    ['N/A FEATURE_UNAVAILABLE de S3', rec.naFeature(), 'DECISION_NOT_SUPPORTED'],
    ['N/A NO_ADDITIONAL_NEEDED de C3', rec.naNoAdditional(), 'DECISION_NOT_SUPPORTED'],
    ['juízo C3', rec.c3(), 'DECISION_NOT_SUPPORTED'],
    ['atestado de escopo', rec.attestation(), 'DECISION_NEEDS_SITE_SCOPE'],
    ['confirmação de imagens', rec.images(), 'DECISION_NOT_SUPPORTED'],
  ];
  const base = ok(await previewOver(w).preview(ANA, w.auditId));
  for (const [name, record, code] of kinds) {
    const created = await w.service.create(ANA, w.auditId, { record }, clock());
    if (!created.ok) continue; // a 6B pode recusar combinações; o que ela aceita é o que importa aqui
    const payload = ok(await previewOver(w).preview(ANA, w.auditId));
    const id = created.value.decision.decisionId;
    assert.ok(payload.decisions.held.some((item) => item.decisionId === id && item.code === code), `${name}: retida como ${code}`);
    assert.ok(!payload.decisions.applied.includes(id), name);
    const blocker = payload.blockers.find((b) => b.code === code && b.decisionIds.includes(id));
    assert.equal(blocker?.severity, 'BLOCKING', name);
    assert.equal(payload.finalization.allowed, false, name);
    assert.notEqual(payload.result, null, `${name}: a prévia continua calculada`);
    assert.equal(payload.outcomePreview?.coveragePercent, base.outcomePreview?.coveragePercent, `${name}: a decisão retida não altera a cobertura`);
    assert.equal(sub(payload, 'S3')?.state, 'NOT_VERIFIED', `${name}: N/A de S3 NÃO foi aplicado`);
    assert.equal(sub(payload, 'C3')?.state, 'NOT_VERIFIED', name);
    await must(w.service.revoke(ANA, w.auditId, { revokes: id, reason: 'Informação conferida e incorreta; decisão desfeita.' }, clock()));
    const after = ok(await previewOver(w).preview(ANA, w.auditId));
    assert.equal(after.finalization.allowed, true, `${name}: revogada, volta a ser finalizável`);
  }
});

/* ---------------------------------------------------------------- 4. C2 vinculado à categoria julgada */
test('C2 e a categoria: a decisão vale para a captura que o operador viu; uma captura utilizável POSTERIOR muda a fonte do perfil e RETÉM o juízo (DECISION_CATEGORY_MISMATCH) até ser substituído', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  assert.equal(ok(await previewOver(w).preview(ANA, w.auditId)).decisions.held.length, 0, 'categoria correta: aplicada');
  await addCapture(w.evidenceDir, w.auditId, { collectedAt: '2026-10-24T09:00:00.000Z', body: bodyText({ type: 'Posto de combustível' }), withReport: true });
  const later = previewOver(w, { clock: () => '2026-10-26T00:00:00.000Z' });
  const payload = ok(await later.preview(ANA, w.auditId));
  assert.equal(payload.evidence.profileSource?.ref, 'capture:c0002');
  assert.deepEqual(payload.decisions.held, [{ decisionId: 'op-0001', code: 'DECISION_CATEGORY_MISMATCH' }]);
  assert.deepEqual(payload.blockers.filter((b) => b.severity === 'BLOCKING').map((b) => [b.code, b.decisionIds, b.subcriterionIds]), [['DECISION_CATEGORY_MISMATCH', ['op-0001'], ['C2']]]);
  assert.deepEqual([sub(payload, 'C2')?.state, sub(payload, 'C2')?.evaluatedHalfPoints], ['NOT_VERIFIED', 0], 'o juízo antigo NÃO é aplicado à categoria nova');
  assert.equal(payload.finalization.allowed, false);
  // substituir (novo juízo, agora com a captura atual) resolve
  const replaced = await w.service.create(ANA, w.auditId, { record: rec.c2('INCOMPATIBLE'), supersedes: 'op-0001' }, clock());
  assert.ok(replaced.ok, replaced.ok ? '' : replaced.code);
  const fixed = ok(await later.preview(ANA, w.auditId));
  assert.deepEqual([fixed.decisions.held, fixed.decisions.applied.length, sub(fixed, 'C2')?.state, fixed.finalization.allowed], [[], 1, 'SCORED', true]);
});

test('C2 e capturas inúteis (HTTP 500): uma captura posterior sem resposta utilizável NÃO muda a fonte do perfil, NÃO gera fatos e NÃO retira o juízo', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await addCapture(w.evidenceDir, w.auditId, { collectedAt: '2026-10-24T09:00:00.000Z', status: 500, body: bodyText({ title: 'Outro Nome', phoneNumber: '(11) 90000-0000', type: 'Oficina' }) });
  const payload = ok(await previewOver(w, { clock: () => '2026-10-26T00:00:00.000Z' }).preview(ANA, w.auditId));
  assert.equal(payload.evidence.profileSource?.ref, 'capture:c0001');
  assert.equal(payload.evidence.referenceDate, '2026-10-24', 'a data de referência acompanha a evidência íntegra mais recente');
  assert.deepEqual(payload.decisions.held, []);
  assert.equal(sub(payload, 'C2')?.state, 'SCORED');
  assert.equal(sub(payload, 'N1')?.state, 'SCORED');
  assert.ok(!JSON.stringify(payload).includes('Outro Nome') && !JSON.stringify(payload).includes('90000-0000') && !JSON.stringify(payload).includes('Oficina'));
  assert.equal(payload.outcomePreview?.coveragePercent, 15);
});

test('C2 registrado ANTES da existência da captura de origem, ou sem captura de referência, nunca é aplicado (falha fechada)', async () => {
  const w = await world();
  for (const basisCapture of [0, null]) {
    const fake = { list: async (): Promise<{ ok: true; value: ListPayload }> => ({ ok: true, value: fakeList(w.auditId, [c2Record('op-0001')], { basisCapture: basisCapture as never }) }) };
    const payload = ok(await previewOver(w, { decisions: fake as never }).preview(ANA, w.auditId));
    assert.deepEqual(payload.decisions.held, [{ decisionId: 'op-0001', code: 'DECISION_CATEGORY_MISMATCH' }], String(basisCapture));
    assert.equal(sub(payload, 'C2')?.state, 'NOT_VERIFIED');
  }
  const nonexistent = { list: async (): Promise<{ ok: true; value: ListPayload }> => ({ ok: true, value: fakeList(w.auditId, [c2Record('op-0001')], { basisCapture: 7 }) }) };
  assert.deepEqual(ok(await previewOver(w, { decisions: nonexistent as never }).preview(ANA, w.auditId)).decisions.held, [{ decisionId: 'op-0001', code: 'DECISION_BASIS_UNVERIFIABLE' }], 'a captura 7 carimbada não existe nas evidências atuais');
  const fine = { list: async (): Promise<{ ok: true; value: ListPayload }> => ({ ok: true, value: fakeList(w.auditId, [c2Record('op-0001')], { basisCapture: 1 }) }) };
  assert.deepEqual(ok(await previewOver(w, { decisions: fine as never }).preview(ANA, w.auditId)).decisions.held, [], 'captura carimbada existe e a data confere');
});

/* ---------------------------------------------------------------- 5. erros vinculados à operação responsável (por experimento, não por texto) */
test('entrada recusada pelo contrato ⇒ as decisões responsáveis são isoladas por EXPERIMENTO (mínimas, sem ler o texto do erro) e apontadas pelo op-NNNN', async () => {
  const w = await world();
  // dois juízos de C2 vigentes ao mesmo tempo (a 6B impede; aqui é um double): a mensagem do contrato não cita nenhum id
  const records = [c2Record('op-0001'), equivalenceRecord('op-0002'), c2Record('op-0003', 'PARTIAL'), s4Record('op-0004')];
  const fake = { list: async () => ({ ok: true as const, value: fakeList(w.auditId, records) }) };
  const payload = ok(await previewOver(w, { decisions: fake as never }).preview(ANA, w.auditId));
  assert.equal(payload.state, 'ENTRADA_RECUSADA');
  assert.equal(payload.result, null);
  const blocker = payload.blockers.find((b) => b.code === 'ENGINE_CONTRACT_REJECTED');
  assert.deepEqual([blocker?.severity, blocker?.decisionIds, blocker?.subcriterionIds], ['BLOCKING', ['op-0001', 'op-0003'], ['C2']], 'só o par que conflita; op-0002 e op-0004 ficam de fora');
  assert.equal(payload.finalization.allowed, false);
  assert.equal(payload.finalization.expectedInputSha256, null);
});

test('recusa do MOTOR ⇒ ENGINE_REJECTED_INPUT ligado à decisão que a causa; recusa independente das decisões não culpa nenhuma', async () => {
  const w = await world();
  const records = [c2Record('op-0001'), equivalenceRecord('op-0003'), s4Record('op-0004')];
  const fake = { list: async () => ({ ok: true as const, value: fakeList(w.auditId, records) }) };
  const rejectWhen = (id: string | null) => (input: Parameters<typeof scoreAudit>[0]) => {
    const present = (input as { operatorRecords?: Array<{ id: string }> }).operatorRecords ?? [];
    return id === null || present.some((item) => item.id === id) ? { ok: false as const, issues: ['recusa de teste'] } : scoreAudit(input);
  };
  const blamed = ok(await previewOver(w, { decisions: fake as never, score: rejectWhen('op-0003') as never }).preview(ANA, w.auditId));
  const one = blamed.blockers.find((b) => b.code === 'ENGINE_REJECTED_INPUT');
  assert.deepEqual([one?.severity, one?.decisionIds, one?.reasonCode, blamed.result, blamed.state, blamed.finalization.allowed], ['BLOCKING', ['op-0003'], null, null, 'ENTRADA_RECUSADA', false]);
  const independent = ok(await previewOver(w, { decisions: fake as never, score: rejectWhen(null) as never }).preview(ANA, w.auditId));
  const none = independent.blockers.find((b) => b.code === 'ENGINE_REJECTED_INPUT');
  assert.deepEqual([none?.decisionIds, none?.reasonCode], [[], 'NOT_CAUSED_BY_DECISIONS']);
});

/* ---------------------------------------------------------------- 6. consistência de leitura */
test('o head muda durante a prévia ⇒ nada é calculado sobre a visão velha: relê e a resposta carrega o head efetivamente consultado', async () => {
  const w = await world();
  let calls = 0;
  const racing = {
    list: async (actor: { email: string }, auditId: string) => {
      calls += 1;
      const result = await w.raw.list(actor, auditId);
      if (calls === 1) await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock())); // alguém decide logo depois da 1ª leitura
      return result;
    },
  };
  const payload = ok(await previewOver(w, { decisions: racing as never }).preview(ANA, w.auditId));
  const current = await must(w.raw.list(ANA, w.auditId));
  assert.deepEqual(payload.decisions.head, current.head, 'o head da resposta é o atual, não o da 1ª leitura');
  assert.deepEqual(payload.decisions.applied, ['op-0001']);
  assert.equal(calls, 4, '1ª tentativa (2 leituras, divergentes) + 2ª tentativa (2 leituras, iguais)');
});

test('o head continua mudando ⇒ READ_INCONSISTENT (409) depois de 3 tentativas, sem nenhum dado; mudança só na pendente também é detectada', async () => {
  const w = await world();
  let calls = 0;
  const unstable = { list: async () => ({ ok: true as const, value: fakeList(w.auditId, [], { head: { seq: ++calls, sha256: 'c'.repeat(64) } }) }) };
  const result = failed(await previewOver(w, { decisions: unstable as never }).preview(ANA, w.auditId));
  assert.equal(result.code, 'READ_INCONSISTENT');
  assert.equal(PREVIEW_HTTP_STATUS.READ_INCONSISTENT, 409);
  assert.equal(calls, 6);
  let n = 0;
  const flicker = { list: async () => ({ ok: true as const, value: fakeList(w.auditId, [], { head: null, finalizable: n++ % 2 === 0 }) }) };
  assert.equal(failed(await previewOver(w, { decisions: flicker as never }).preview(ANA, w.auditId)).code, 'READ_INCONSISTENT');
});

test('a evidência muda durante a leitura: troca por outra base válida ⇒ relê (ou READ_INCONSISTENT); vira inválida ⇒ EVIDENCE_INTEGRITY', async () => {
  const w = await world();
  const real = createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true });
  const other = tmpDir('lad-ev-');
  await writeFull(other, { auditId: w.auditId, body: bodyText({ phoneNumber: '(62) 3000-1111' }) });
  const otherReader = createScoringBasisReader({ baseDir: other, authorize: () => true });
  let reads = 0;
  const swapping = { readScoringBasis: (actor: { email: string }, auditId: string) => (++reads === 1 ? real : otherReader).readScoringBasis(actor, auditId) };
  const settled = ok(await previewOver(w, { basisReader: swapping as never }).preview(ANA, w.auditId));
  assert.equal(reads, 4);
  assert.equal(settled.state, 'CALCULADO_FINALIZAVEL');
  let flip = 0;
  const alternating = { readScoringBasis: (actor: { email: string }, auditId: string) => (flip++ % 2 === 0 ? real : otherReader).readScoringBasis(actor, auditId) };
  assert.equal(failed(await previewOver(w, { basisReader: alternating as never }).preview(ANA, w.auditId)).code, 'READ_INCONSISTENT');
  let seen = 0;
  const tampering = {
    readScoringBasis: async (actor: { email: string }, auditId: string) => {
      const outcome = await real.readScoringBasis(actor, auditId);
      if (++seen === 1) {
        const file = path.join(w.evidenceDir, w.auditId, 'c0001.capture.json');
        fs.chmodSync(file, 0o644);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Padaria Exemplo (fictícia)', 'Outra Empresa'));
      }
      return outcome;
    },
  };
  assert.equal(failed(await previewOver(w, { basisReader: tampering as never }).preview(ANA, w.auditId)).code, 'EVIDENCE_INTEGRITY');
});

/* ---------------------------------------------------------------- 7. identidade e alias */
test('auditId com "_": o motor recebe o alias, a resposta mostra o id REAL e o alias; todas as leituras usam SÓ o id real', async () => {
  const w = await world({ auditId: 'tuvaplast_20261022_maps01' });
  const seen: string[] = [];
  const spyBasis = createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true });
  const payload = ok(
    await previewOver(w, {
      basisReader: { readScoringBasis: (actor: { email: string }, id: string) => (seen.push(id), spyBasis.readScoringBasis(actor, id)) } as never,
      decisions: { list: (actor: { email: string }, id: string) => (seen.push(id), w.raw.list(actor, id)) } as never,
    }).preview(ANA, w.auditId),
  );
  assert.equal(payload.auditId, 'tuvaplast_20261022_maps01');
  assert.match(payload.scoringAuditId ?? '', /^tuvaplast-20261022-maps01-ux[0-9a-f]{32}$/);
  assert.deepEqual(payload.auditIdAlias, { applied: true, rule: 'lumos-audit-id-alias-v1', reason: 'CONTAINS_UNDERSCORE' });
  assert.deepEqual([...new Set(seen)], ['tuvaplast_20261022_maps01'], 'o alias nunca localiza dados');
  assert.equal(seen.length, 4);
  assert.ok(ok(await previewOver(await world({ auditId: 'auditoria-teste-0001' })).preview(ANA, 'auditoria-teste-0001')).auditIdAlias?.applied === false);
});

test('identidade incompatível entre a rota, a base e as decisões ⇒ falha fechada (AUDIT_IDENTITY_MISMATCH), sem dados', async () => {
  const w = await world();
  const basisOf = createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true });
  const otherAudit = await world({ auditId: 'outra-auditoria-0002' });
  const wrongBasis = { readScoringBasis: (actor: { email: string }, _id: string) => createScoringBasisReader({ baseDir: otherAudit.evidenceDir, authorize: () => true }).readScoringBasis(actor, 'outra-auditoria-0002') };
  assert.equal(failed(await previewOver(w, { basisReader: wrongBasis as never }).preview(ANA, w.auditId)).code, 'AUDIT_IDENTITY_MISMATCH');
  const wrongDecisions = { list: async () => ({ ok: true as const, value: fakeList('outra-auditoria-0002', []) }) };
  assert.equal(failed(await previewOver(w, { decisions: wrongDecisions as never, basisReader: basisOf }).preview(ANA, w.auditId)).code, 'AUDIT_IDENTITY_MISMATCH');
  const tamperedResult = failed(await previewOver(w, { score: ((input: Parameters<typeof scoreAudit>[0]) => scoreAudit({ ...(input as object), auditId: 'outro-id-qualquer' })) as never }).preview(ANA, w.auditId));
  assert.ok(['AUDIT_IDENTITY_MISMATCH', 'INTERNAL_ERROR'].includes(tamperedResult.code), 'resultado do motor para outra identidade nunca é aceito');
});

test('auditId inválido ⇒ INVALID_PARAMS antes de qualquer leitura', async () => {
  const w = await world();
  let reads = 0;
  const counting = { list: async () => (reads++, { ok: false as const, code: 'INTERNAL_ERROR' as const, issues: [] }) };
  for (const bad of ['', 'curto', 'ABC_DEF_GHI', '../fora', 'a'.repeat(65), 'com espaço', 5 as never, null as never]) {
    assert.equal(failed(await previewOver(w, { decisions: counting as never }).preview(ANA, bad)).code, 'INVALID_PARAMS', String(bad));
  }
  assert.equal(reads, 0);
});

/* ---------------------------------------------------------------- 8. proveniência, hashes, sigilo e determinismo */
test('proveniência e hashes: as bases vêm do leitor íntegro, o hash esperado da entrada é o do motor e o head é o consultado', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  const reader = createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true });
  const outcome = await reader.readScoringBasis(ANA, w.auditId);
  assert.equal(outcome.status, 'READY');
  const basis = (outcome as unknown as { basis: { evidences: Array<{ ref: string; contentSha256: string; observedAt: string }> } }).basis;
  assert.deepEqual(payload.evidence.bases.map((b) => [b.ref, b.contentSha256, b.observedAt]).sort(), basis.evidences.map((b) => [b.ref, b.contentSha256, b.observedAt]).sort());
  assert.match(payload.finalization.expectedInputSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(payload.result?.inputSha256, payload.finalization.expectedInputSha256);
  assert.deepEqual(payload.finalization.expectedHead, payload.decisions.head);
  assert.equal(payload.result?.rulerFingerprint, '957f88fd2928b0f0bb99c2689adb400eeb15b64c504bc72a26c1df40b22b387d');
});

test('sem dados sensíveis: nenhuma URL bruta, parâmetro, caminho, corpo do provedor, autor, justificativa ou hash do bruto na resposta', async () => {
  const w = await world({ seed: false });
  await writeFull(w.evidenceDir, { auditId: w.auditId, body: bodyText({ website: 'https://www.padaria-exemplo.example/loja/SEGREDO8/CAMINHO-SECRETO;jsessionid=SEGREDO9?utm_source=ORIGEM-S&utm_medium=MEIO-M&sid=SEGREDO12&igsh=SEGREDO-IG#frag-SEGREDO' }) });
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.naFeature() }, clock()));
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.equal(payload.company.websiteHost, 'www.padaria-exemplo.example');
  assert.equal(sub(payload, 'X5')?.state, 'SCORED', 'a prova de UTM comprovada é usada');
  const text = JSON.stringify(payload);
  for (const leak of ['SEGREDO', 'ORIGEM-S', 'MEIO-M', 'CAMINHO-SECRETO', 'jsessionid', 'igsh', 'frag-', 'loja/', 'SENTINELA', 'ana@empresa.com', 'Conferido no painel', w.evidenceDir, w.decisionsDir, w.anchorDir, '/tmp/', '/mnt/', 'rawSha256', 'operatorEmail', 'padaria-exemplo.example/?', 'Bearer', 'token=']) {
    assert.ok(!text.includes(leak), `a resposta vazou "${leak}"`);
  }
  assert.ok(!('input' in payload) && !text.includes('"profile"'), 'a entrada do motor nunca é devolvida');
});

test('determinismo: leituras repetidas com os mesmos dados ⇒ resposta idêntica byte a byte; ordem dos bloqueios estável', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await must(w.service.create(ANA, w.auditId, { record: rec.naFeature() }, clock()));
  const service = previewOver(w);
  const first = JSON.stringify(ok(await service.preview(ANA, w.auditId)));
  for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(ok(await service.preview(ANA, w.auditId))), first);
  assert.equal(JSON.stringify(ok(await previewOver(w, { clock: () => '2027-03-01T00:00:00.000Z' }).preview(ANA, w.auditId))), first, 'o relógio do servidor não entra na resposta');
});

test('o serviço só recebe o auditId: a assinatura não tem como carregar pontuação, entrada do motor, caminho, autor ou data do cliente', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'link-audit-scoring-runs', 'preview.ts'), 'utf8');
  assert.match(source, /async preview\(actor: PreviewActor, auditId: string\): Promise<PreviewResult>/);
  assert.equal(clockFixed(), NOW);
  void operatorRecord;
});

test('resultado do motor NÃO reproduzível (alterado depois do cálculo) nunca é entregue: falha fechada, sem dados', async () => {
  const w = await world();
  const tampering = (input: Parameters<typeof scoreAudit>[0]) => {
    const outcome = scoreAudit(input);
    return outcome.ok ? { ok: true as const, result: { ...outcome.result, totals: { ...outcome.result.totals, evaluatedHalfPoints: 999 } } } : outcome;
  };
  const result = failed(await previewOver(w, { score: tampering as never }).preview(ANA, w.auditId));
  assert.equal(result.code, 'INTERNAL_ERROR');
  assert.deepEqual(result.issues, []);
});

test('payload de decisões incoerente (registro sem decisão correspondente, ou decisão sem registro) ⇒ falha fechada, nunca aplica o que não conferiu', async () => {
  const w = await world();
  const list = fakeList(w.auditId, [c2Record('op-0001')]);
  const extra = { ...list, operatorRecords: [...list.operatorRecords, s4Record('op-0002')] }; // registro que nenhuma decisão vigente explica
  assert.equal(failed(await previewOver(w, { decisions: { list: async () => ({ ok: true as const, value: extra }) } as never }).preview(ANA, w.auditId)).code, 'INTERNAL_ERROR');
  const missing = { ...list, operatorRecords: [] }; // decisão vigente sem o registro
  assert.equal(failed(await previewOver(w, { decisions: { list: async () => ({ ok: true as const, value: missing }) } as never }).preview(ANA, w.auditId)).code, 'INTERNAL_ERROR');
});

/* ---------------------------------------------------------------- regressões da revisão independente do I3 */
const POINTS_TEXT = /\d+(?:[.,]\d+)? de \d+(?:[.,]\d+)? pontos?/;
const JUSTIFICATION_SENTINEL = 'SENTINELA-JUSTIFICATIVA-S4-9f3a texto livre do operador';

test('REVISÃO #1: em INCONCLUSIVO nenhum texto da resposta traz "(X de Y pontos)" (razão obtido÷avaliado), nem com juízo C2 aplicado', async () => {
  const w = await world();
  for (const value of [undefined, 'PARTIAL', 'COMPATIBLE', 'INCOMPATIBLE']) {
    if (value) await w.service.create(ANA, w.auditId, { record: rec.c2(value), ...(value === 'PARTIAL' ? {} : { supersedes: 'op-0001' }) }, clock());
    const payload = ok(await previewOver(w).preview(ANA, w.auditId));
    assert.equal(payload.outcomePreview?.outcome, 'INCONCLUSIVO');
    assert.ok(!POINTS_TEXT.test(JSON.stringify(payload)), `texto com pontos (${String(value)})`);
    assert.ok(!/obtainedHalfPoints/.test(JSON.stringify(payload)));
    assert.match((payload.result as any).subcriteria.find((s: any) => s.id === 'N1').reason, /^Faixa factual atingida: presente\.$/);
  }
});

test('REVISÃO #2: a justificativa livre do operador (N/A de S4 aplicado) NUNCA sai — nem em subcritérios, nem no registro de N/A, nem nas limitações', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: { ...rec.naModel(), justification: JUSTIFICATION_SENTINEL } }, clock()));
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.deepEqual(payload.decisions.applied, ['op-0001']);
  assert.equal(sub(payload, 'S4')?.state, 'NOT_APPLICABLE');
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('SENTINELA') && !text.includes('texto livre do operador'));
  const result = payload.result as any;
  assert.equal(result.naRegistry[0].justification, 'Não aplicável (BUSINESS_MODEL): fora do denominador.');
  assert.ok(result.limitations.some((l: any) => l.code === 'NOT_APPLICABLE:S4' && l.text === 'S4 não aplicável (BUSINESS_MODEL): fora do denominador.'));
  assert.equal(result.subcriteria.find((s: any) => s.id === 'S4').reason, 'Não aplicável (BUSINESS_MODEL): fora do denominador.');
  assert.equal(result.naRegistry[0].operatorRecordId, 'op-0001', 'a rastreabilidade ao registro continua');
});

test('REVISÃO #3: C2 carimbado numa captura que NÃO existe mais (arquivos removidos/restaurados) ou que mudou de data é retido (DECISION_BASIS_UNVERIFIABLE)', async () => {
  const w = await world();
  await addCapture(w.evidenceDir, w.auditId, { collectedAt: '2026-10-24T09:00:00.000Z', body: bodyText({ type: 'Posto de combustível' }), withReport: true });
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock())); // carimbo: captura 2
  const later = (over: Partial<Parameters<typeof previewOver>[1]> = {}) => previewOver(w, { clock: () => '2026-10-26T00:00:00.000Z', ...over });
  assert.deepEqual(ok(await later().preview(ANA, w.auditId)).decisions.held, [], 'capturas existem e conferem: aplicado');
  for (const name of fs.readdirSync(path.join(w.evidenceDir, w.auditId)).filter((file) => file.startsWith('c0002.'))) {
    const file = path.join(w.evidenceDir, w.auditId, name);
    fs.chmodSync(file, 0o644);
    fs.rmSync(file);
  }
  const restored = ok(await later().preview(ANA, w.auditId));
  assert.equal(restored.evidence.profileSource?.ref, 'capture:c0001');
  assert.deepEqual(restored.decisions.held, [{ decisionId: 'op-0001', code: 'DECISION_BASIS_UNVERIFIABLE' }]);
  assert.equal(sub(restored, 'C2')?.state, 'NOT_VERIFIED');
  assert.equal(restored.finalization.allowed, false);
  const redated = { list: async () => ({ ok: true as const, value: fakeList(w.auditId, [c2Record('op-0001')], { basisCapture: 1 }) }) };
  const dateOff = fakeList(w.auditId, [c2Record('op-0001')], { basisCapture: 1 });
  (dateOff.decisions[0] as { basis: { collectedAt: string | null } }).basis.collectedAt = '2026-10-21T00:00:00.000Z';
  assert.deepEqual(ok(await previewOver(w, { decisions: { list: async () => ({ ok: true as const, value: dateOff }) } as never }).preview(ANA, w.auditId)).decisions.held, [{ decisionId: 'op-0001', code: 'DECISION_BASIS_UNVERIFIABLE' }]);
  (dateOff.decisions[0] as { basis: { collectedAt: string | null } }).basis.collectedAt = null;
  assert.equal(ok(await previewOver(w, { decisions: { list: async () => ({ ok: true as const, value: dateOff }) } as never }).preview(ANA, w.auditId)).decisions.held[0]?.code, 'DECISION_BASIS_UNVERIFIABLE', 'sem data de captura registrada não há como conferir');
  void redated;
});

test('REVISÃO #4 (decisão de projeto documentada): captura de número MAIOR porém de data ANTERIOR não é a fonte; o juízo carimbado nela vale para a fonte (era a que o operador via)', async () => {
  const w = await world();
  await addCapture(w.evidenceDir, w.auditId, { collectedAt: '2026-10-20T09:00:00.000Z', body: bodyText({ type: 'Posto de combustível' }), withReport: true });
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const payload = ok(await previewOver(w).preview(ANA, w.auditId));
  assert.equal(payload.evidence.profileSource?.ref, 'capture:c0001', 'a fonte é a de maior DATA');
  assert.deepEqual(payload.decisions.held, []);
  assert.equal(sub(payload, 'C2')?.state, 'SCORED');
});

test('REVISÃO #7/#8: entrada recusada tem estado próprio; finalizable:false da 6B sem pendente gera bloqueio explícito; relógio anterior à evidência é falha fechada e explícita', async () => {
  const w = await world();
  const recusada = ok(await previewOver(w, { clock: () => '2026-10-21T10:00:00.000Z' }).preview(ANA, w.auditId));
  assert.deepEqual([recusada.state, recusada.result, recusada.finalization.allowed, recusada.blockers.map((b) => b.code)], ['ENTRADA_RECUSADA', null, false, ['EVIDENCE_DATED_IN_FUTURE']]);
  const unmarked = { list: async () => ({ ok: true as const, value: fakeList(w.auditId, [], { finalizable: false, pending: null }) }) };
  const payload = ok(await previewOver(w, { decisions: unmarked as never }).preview(ANA, w.auditId));
  assert.deepEqual(payload.blockers.map((b) => [b.code, b.severity, b.reasonCode]), [['DECISION_PENDING', 'BLOCKING', 'FINALIZABLE_FALSE']]);
  assert.equal(payload.finalization.allowed, false);
});

test('REVISÃO #9: leitores que entregam formas inesperadas (status desconhecido, base nula, perfil nulo) viram INTERNAL_ERROR sem detalhe — nunca exceção nem "pronto"', async () => {
  const w = await world();
  const real = createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true });
  const reader = (mutate: (outcome: any) => any) => ({ readScoringBasis: async (actor: { email: string }, id: string) => mutate(await real.readScoringBasis(actor, id)) });
  const variants: Array<[string, (o: any) => any]> = [
    ['status desconhecido', (o) => ({ ...o, status: 'OUTRO' })],
    ['status ausente', () => ({})],
    ['base nula', (o) => ({ ...o, basis: null })],
    ['perfil nulo', (o) => ({ ...o, basis: { ...o.basis, profile: null } })],
    ['evidências nulas', (o) => ({ ...o, basis: { ...o.basis, evidences: null } })],
  ];
  for (const [name, mutate] of variants) {
    const result = failed(await previewOver(w, { basisReader: reader(mutate) as never }).preview(ANA, w.auditId));
    assert.equal(result.code, 'INTERNAL_ERROR', name);
    assert.deepEqual(result.issues, [], name);
  }
});

test('C2 com perfil indisponível (identidade não localizada): não há categoria, o juízo não é retido nem pontua, e o mapeador avisa que não tem efeito', async () => {
  const w = await world();
  await must(w.service.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const real = createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true });
  const unavailable = {
    readScoringBasis: async (actor: { email: string }, id: string) => {
      const outcome = (await real.readScoringBasis(actor, id)) as any;
      return { ...outcome, basis: { ...outcome.basis, profile: { state: 'UNAVAILABLE', reason: 'NOT_LOCATED' } } };
    },
  };
  const payload = ok(await previewOver(w, { basisReader: unavailable as never }).preview(ANA, w.auditId));
  assert.deepEqual(payload.decisions.held, []);
  assert.deepEqual(payload.decisions.applied, ['op-0001']);
  assert.equal(sub(payload, 'C2')?.state, 'NOT_VERIFIED');
  assert.deepEqual(payload.blockers.map((b) => `${b.severity}:${b.code}`).sort(), ['WARNING:DECISION_HAS_NO_EFFECT', 'WARNING:PROFILE_UNAVAILABLE']);
  assert.equal(payload.company.profileState, 'UNAVAILABLE');
  assert.equal(payload.outcomePreview?.reasonCode, 'SEM_DADOS_AVALIADOS');
});
