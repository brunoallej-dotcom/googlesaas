import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProtection, isLedgerBlocking, needsCheckpoint, replayLedger, verifyTags, type DecisionRef, type LedgerRecord, type ProtectionInput } from '../src/lib/link-audit-ledger';
import { seal } from '../src/lib/link-audit-storage';
import { ledgerAuth, LEDGER_AUTH_A, LEDGER_AUTH_B, LEDGER_KEY_A, LEDGER_KEY_B, makeRecord, opOf, refOf, sha, syntheticLedger, T0 } from './helpers/link-audit-ledger-fixtures';
import { TEST_ORIGIN, testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * MODELO PURO do livro: cadeia, etiquetas e a AVALIAÇÃO da proteção (todos os ramos). Nenhum disco. A regra de ouro (Q1): a ausência do livro
 * nunca vira "cabeça vazia", e qualquer dúvida é HISTORY_UNRESOLVED (falha fechada).
 */
const AUD = 'auditoria-ledger-0001';
const NOW = T0 + 10 * 60_000; // 10 min depois do primeiro registro
const chain = (count: number): DecisionRef[] => {
  const refs: DecisionRef[] = [];
  for (let seq = 1; seq <= count; seq += 1) refs.push(refOf(seq, seq === 1 ? null : (refs[seq - 2] as DecisionRef).sha256, 'dec'));
  return refs;
};
const NO_RESULTS = { ok: true as const, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] };

function input(records: readonly LedgerRecord[] | null, refs: readonly DecisionRef[], over: Partial<ProtectionInput> = {}): ProtectionInput {
  return {
    configured: true,
    read: records === null ? { kind: 'ABSENT' } : { kind: 'PRESENT', records, tagFailure: null },
    auditId: AUD,
    decisions: { confirmed: refs, pending: null },
    entryOriginProven: () => true,
    results: NO_RESULTS,
    guard: { status: 'NOT_CONFIGURED' },
    ageMsOf: (iso) => NOW - Date.parse(iso),
    staleMs: 120_000,
    ...over,
  };
}
const state = (over: Parameters<typeof input>) => evaluateProtection(input(...over));

test('sem configuração, livro ilegível, não confiável ou testemunha dos resultados indisponível: HISTORY_UNRESOLVED (nunca "sem problema")', () => {
  const refs = chain(1);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  assert.deepEqual([state([records, refs, { configured: false }]).view.state, state([records, refs, { configured: false }]).view.reason], ['HISTORY_UNRESOLVED', 'NOT_CONFIGURED']);
  assert.equal(state([records, refs, { read: { kind: 'UNAVAILABLE' } }]).view.reason, 'UNAVAILABLE');
  assert.equal(state([records, refs, { read: { kind: 'UNTRUSTED' } }]).view.reason, 'UNTRUSTED');
  for (const present of [null, records]) {
    const evaluation = state([present, refs, { results: { ok: false } }]);
    assert.deepEqual([evaluation.view.state, evaluation.view.reason], ['HISTORY_UNRESOLVED', 'RESULTS_EVIDENCE_UNAVAILABLE']);
  }
  assert.equal(state([records, refs, { guard: { status: 'UNAVAILABLE' } }]).view.reason, 'GUARD_UNAVAILABLE');
  for (const s of ['NOT_REQUIRED', 'PROTECTED'] as const) assert.equal(isLedgerBlocking(s), false);
  for (const s of ['ENROLLMENT_PENDING', 'LEGACY_READ_ONLY', 'HISTORY_UNRESOLVED'] as const) assert.equal(isLedgerBlocking(s), true, s);
});

test('livro AUSENTE: vazio ⇒ inscrição pendente; com histórico ⇒ modo legado; com testemunha de que existiu ⇒ NÃO resolvido — nunca uma cabeça vazia implícita', () => {
  const refs = chain(2);
  assert.deepEqual([state([null, [], {}]).view.state, state([null, [], {}]).view.reason], ['ENROLLMENT_PENDING', null]);
  assert.deepEqual([state([null, refs, {}]).view.state, state([null, refs, {}]).view.reason], ['LEGACY_READ_ONLY', 'LEDGER_ABSENT_WITH_HISTORY']);
  const pending = { confirmed: [], pending: refs[0] as DecisionRef };
  assert.equal(state([null, [], { decisions: pending }]).view.state, 'LEGACY_READ_ONLY', 'só uma pendente já é histórico');
  assert.equal(state([null, [], { results: { ...NO_RESULTS, hasResults: true } }]).view.state, 'LEGACY_READ_ONLY', 'resultado sem ledgerHead já é histórico');
  const cited = state([null, [], { results: { ...NO_RESULTS, hasResults: true, ledgerHeads: [{ ledgerSeq: 3, sha256: sha('b') }] } }]);
  assert.deepEqual([cited.view.state, cited.view.reason], ['HISTORY_UNRESOLVED', 'LEDGER_REMOVED_WITNESSED']);
  const hinted = state([null, [], { results: { ...NO_RESULTS, unverifiedLedgerHeads: [{ ledgerSeq: 1, sha256: sha('c') }] } }]);
  assert.equal(hinted.view.reason, 'LEDGER_REMOVED_WITNESSED', 'até um indício de que o livro existiu bloqueia');
  const guarded = state([null, [], { guard: { status: 'READ', head: { ledgerSeq: 2, sha256: sha('d') } } }]);
  assert.deepEqual([guarded.view.reason, guarded.view.externalGuard], ['LEDGER_REMOVED_WITNESSED', 'MISMATCH']);
  assert.equal(state([null, [], { guard: { status: 'READ', head: null } }]).view.state, 'ENROLLMENT_PENDING', 'guarda legível sem registro = auditoria nova');
});

test('PROTEGIDA: livro íntegro e igual às decisões; cabeça, contagem e operação aberta informadas', () => {
  const refs = chain(3);
  const evaluation = state([syntheticLedger(LEDGER_AUTH_A, AUD, refs), refs, {}]);
  assert.deepEqual([evaluation.view.state, evaluation.view.reason, evaluation.view.confirmedDecisions, evaluation.view.openOperation, evaluation.plan.kind], ['PROTECTED', null, 3, null, 'NONE']);
  assert.equal(evaluation.view.head?.ledgerSeq, 7);
  const onlyGenesis = state([syntheticLedger(LEDGER_AUTH_A, AUD, []), [], {}]);
  assert.deepEqual([onlyGenesis.view.state, onlyGenesis.view.confirmedDecisions], ['PROTECTED', 0]);
});

test('retrocesso, divergência e recibo removido são detectados SEM nenhum resultado selado (a janela sem testemunha, fechada para auditoria protegida)', () => {
  const refs = chain(3);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  assert.equal(state([records, refs.slice(0, 2), {}]).view.reason, 'HISTORY_REGRESSED', 'arquivo de decisão removido');
  assert.equal(state([records, [], {}]).view.reason, 'HISTORY_REGRESSED', 'todos os arquivos removidos');
  const swapped = [...refs.slice(0, 2), refOf(3, refs[1]?.sha256 ?? null, 'outra')];
  assert.equal(state([records, swapped, {}]).view.reason, 'HISTORY_DIVERGES');
  const lost = state([records, refs.slice(0, 2), { decisions: { confirmed: refs.slice(0, 2), pending: refs[2] as DecisionRef } }]);
  assert.deepEqual([lost.view.reason, lost.view.receiptReissuable, lost.plan.kind], ['RECEIPT_REMOVED', true, 'REISSUE_RECEIPT']);
  const wrongPending = state([records, refs.slice(0, 2), { decisions: { confirmed: refs.slice(0, 2), pending: refOf(3, refs[1]?.sha256 ?? null, 'forjada') } }]);
  assert.equal(wrongPending.view.reason, 'HISTORY_REGRESSED', 'pendente diferente da confirmada não é recibo removido');
});

test('entradas fora do livro: confirmada ou pendente sem INTENT ⇒ NÃO resolvido; explicada por INTENT aberto ⇒ recuperável SÓ com origem comprovada', () => {
  const refs = chain(3);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs.slice(0, 2));
  assert.equal(state([records, refs, {}]).view.reason, 'UNLEDGERED_ENTRY');
  assert.equal(state([records, refs.slice(0, 2), { decisions: { confirmed: refs.slice(0, 2), pending: refs[2] as DecisionRef } }]).view.reason, 'UNLEDGERED_PENDING');
  const open = syntheticLedger(LEDGER_AUTH_A, AUD, refs, { open: true }); // INTENT da 3ª, sem CONFIRMED
  const behind = state([open, refs, {}]);
  assert.deepEqual([behind.view.state, behind.view.reason, behind.view.recoverable, behind.plan.kind], ['HISTORY_UNRESOLVED', 'LEDGER_BEHIND', true, 'COMPLETE_CONFIRMED']);
  const unproven = state([open, refs, { entryOriginProven: () => false }]);
  assert.deepEqual([unproven.view.reason, unproven.view.recoverable, unproven.plan.kind], ['BEHIND_UNVERIFIABLE', false, 'NONE']);
  assert.equal(state([open, [...refs, refOf(4, refs[2]?.sha256 ?? null, 'dec')], {}]).view.reason, 'UNLEDGERED_ENTRY', 'duas à frente não é "atrasado de um"');
});

test('operação aberta: fase A (sem entrada) espera ou é abortada quando vence; fase B (pendente igual ao INTENT) é a pendente de sempre', () => {
  const refs = chain(2);
  const open = syntheticLedger(LEDGER_AUTH_A, AUD, refs, { open: true });
  const confirmed = refs.slice(0, 1);
  const fresh = evaluateProtection(input(open, confirmed, { ageMsOf: () => 5_000 }));
  assert.deepEqual([fresh.view.state, fresh.view.openOperation?.phase, fresh.view.openOperation?.stale, fresh.plan.kind], ['PROTECTED', 'A', false, 'WAIT']);
  const stale = evaluateProtection(input(open, confirmed, { ageMsOf: () => 120_000 }));
  assert.deepEqual([stale.view.openOperation?.stale, stale.view.recoverable, stale.plan.kind], [true, true, 'ABORT']);
  const phaseB = evaluateProtection(input(open, confirmed, { decisions: { confirmed, pending: refs[1] as DecisionRef } }));
  assert.deepEqual([phaseB.view.state, phaseB.view.openOperation?.phase, phaseB.plan.kind], ['PROTECTED', 'B', 'NONE']);
  const forged = evaluateProtection(input(open, confirmed, { decisions: { confirmed, pending: refOf(2, refs[0]?.sha256 ?? null, 'forjada') } }));
  assert.equal(forged.view.reason, 'UNLEDGERED_PENDING', 'pendente que não é a do INTENT');
});

test('entrada publicada DEPOIS de ABORTED (dono lento): NÃO resolvido (falha fechada, declarada)', () => {
  const refs = chain(2);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs, { open: true });
  const intent = records[records.length - 1] as LedgerRecord;
  const aborted = makeRecord(LEDGER_AUTH_A, AUD, intent, { event: 'ABORTED', recordedAt: new Date(T0 + 400_000).toISOString(), actor: 'bia@empresa.com', op: { ...(intent.op as NonNullable<LedgerRecord['op']>), intentSeq: intent.ledgerSeq, observed: { entryPresent: false, receiptPresent: false, ageMs: 130_000 } } });
  const withAbort = [...records, aborted];
  assert.equal(evaluateProtection(input(withAbort, refs.slice(0, 1))).view.state, 'PROTECTED', 'aborto legítimo: posição liberada');
  const late = evaluateProtection(input(withAbort, refs.slice(0, 1), { decisions: { confirmed: refs.slice(0, 1), pending: refs[1] as DecisionRef } }));
  assert.equal(late.view.reason, 'PUBLISHED_AFTER_ABORT');
  assert.equal(evaluateProtection(input(withAbort, refs)).view.reason, 'PUBLISHED_AFTER_ABORT', 'também com recibo');
});

test('resultados que citam o livro (ledgerHead): a posição tem de existir com o mesmo hash; indício que contradiz torna a testemunha não confiável', () => {
  const refs = chain(2);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  const ok = { ...NO_RESULTS, hasResults: true, ledgerHeads: [{ ledgerSeq: 3, sha256: (records[2] as LedgerRecord).contentSha256 }] };
  assert.equal(state([records, refs, { results: ok }]).view.state, 'PROTECTED');
  const wrong = { ...ok, ledgerHeads: [{ ledgerSeq: 3, sha256: sha('e') }] };
  assert.equal(state([records, refs, { results: wrong }]).view.reason, 'RESULT_LEDGER_MISMATCH');
  const beyond = { ...ok, ledgerHeads: [{ ledgerSeq: 99, sha256: sha('e') }] };
  assert.equal(state([records, refs, { results: beyond }]).view.reason, 'RESULT_LEDGER_MISMATCH', 'livro truncado: o resultado cita posição que não existe mais');
  assert.equal(state([records, refs, { results: { ...ok, ledgerHeads: [], unverifiedLedgerHeads: [{ ledgerSeq: 3, sha256: sha('f') }] } }]).view.reason, 'UNTRUSTED');
  assert.equal(state([records, refs, { results: { ...ok, ledgerHeads: [], unverifiedLedgerHeads: [{ ledgerSeq: 3, sha256: (records[2] as LedgerRecord).contentSha256 }] } }]).view.state, 'PROTECTED', 'indício que confere é ignorado');
});

test('guarda externa: a cabeça publicada tem de ser prefixo do livro; atrasada = BEHIND; divergente = NÃO resolvido; sem guarda NÃO afirma nada', () => {
  const refs = chain(2);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  const at = (seq: number) => ({ ledgerSeq: seq, sha256: (records[seq - 1] as LedgerRecord).contentSha256 });
  assert.equal(state([records, refs, { guard: { status: 'READ', head: at(5) } }]).view.externalGuard, 'CONSISTENT');
  assert.equal(state([records, refs, { guard: { status: 'READ', head: at(3) } }]).view.externalGuard, 'BEHIND');
  assert.equal(state([records, refs, { guard: { status: 'READ', head: null } }]).view.externalGuard, 'BEHIND');
  const mismatch = state([records, refs, { guard: { status: 'READ', head: { ledgerSeq: 5, sha256: sha('9') } } }]);
  assert.deepEqual([mismatch.view.reason, mismatch.view.externalGuard], ['GUARD_MISMATCH', 'MISMATCH']);
  assert.equal(state([records.slice(0, 3), refs.slice(0, 1), { guard: { status: 'READ', head: at(5) } }]).view.reason, 'GUARD_MISMATCH', 'livro retrocedido: a guarda guarda uma posição que ele já não tem');
  assert.equal(state([records, refs, {}]).view.externalGuard, 'NOT_CONFIGURED');
});

test('estrutura da cadeia: lacuna, encadeamento, outra auditoria, GENESIS repetido, INTENT com outro aberto, CONFIRMED sem INTENT, operação que não casa, hora regressiva ⇒ NÃO confiável', () => {
  const refs = chain(2);
  const good = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  assert.equal(replayLedger(good, AUD).ok, true);
  const bad = (records: readonly LedgerRecord[], auditId = AUD): boolean => replayLedger(records, auditId).ok;
  assert.equal(bad([]), false, 'vazio');
  assert.equal(bad(good, 'outra-auditoria-0001'), false, 'outra auditoria');
  assert.equal(bad([good[0] as LedgerRecord, ...good.slice(2)]), false, 'lacuna');
  assert.equal(bad([...good.slice(0, 2), { ...(good[2] as LedgerRecord), prevSha256: sha('0') }]), false, 'encadeamento');
  assert.equal(bad(good.slice(1)), false, 'sem GENESIS');
  assert.equal(bad([...good, makeRecord(LEDGER_AUTH_A, AUD, good[good.length - 1] ?? null, { event: 'GENESIS', recordedAt: new Date(T0 + 50_000).toISOString(), actor: 'x@y.z', genesis: { mode: 'EMPTY' } })]), false, 'GENESIS repetido');
  const intent2 = makeRecord(LEDGER_AUTH_A, AUD, good[good.length - 1] ?? null, { event: 'INTENT', recordedAt: new Date(T0 + 60_000).toISOString(), actor: 'ana@empresa.com', op: opOf(refOf(3, refs[1]?.sha256 ?? null, 'dec'), 'c'.repeat(32)) });
  const intent3 = makeRecord(LEDGER_AUTH_A, AUD, intent2, { event: 'INTENT', recordedAt: new Date(T0 + 61_000).toISOString(), actor: 'ana@empresa.com', op: opOf(refOf(3, refs[1]?.sha256 ?? null, 'dec'), 'd'.repeat(32)) });
  assert.equal(bad([...good, intent2, intent3]), false, 'INTENT com outra operação aberta');
  const orphan = makeRecord(LEDGER_AUTH_A, AUD, good[good.length - 1] ?? null, { event: 'CONFIRMED', recordedAt: new Date(T0 + 60_000).toISOString(), actor: 'ana@empresa.com', op: { ...opOf(refs[1] as DecisionRef), intentSeq: 2, anchorRef: { name: 'a0002.json', headSha256: (refs[1] as DecisionRef).sha256 } } });
  assert.equal(bad([...good, orphan]), false, 'CONFIRMED sem INTENT aberto');
  const open = syntheticLedger(LEDGER_AUTH_A, AUD, refs, { open: true });
  const intent = open[open.length - 1] as LedgerRecord;
  const mismatch = makeRecord(LEDGER_AUTH_A, AUD, intent, { event: 'CONFIRMED', recordedAt: new Date(T0 + 70_000).toISOString(), actor: 'ana@empresa.com', op: { ...(intent.op as NonNullable<LedgerRecord['op']>), author: 'outra@empresa.com', intentSeq: intent.ledgerSeq, anchorRef: { name: 'a0002.json', headSha256: (intent.op as NonNullable<LedgerRecord['op']>).newDecisionsHead.sha256 } } });
  assert.equal(bad([...open, mismatch]), false, 'CONFIRMED que não casa com o INTENT');
  const early = makeRecord(LEDGER_AUTH_A, AUD, good[good.length - 1] ?? null, { event: 'CHECKPOINT', recordedAt: new Date(T0 - 1000).toISOString(), actor: 'system', checkpoint: { throughSeq: 1, throughSha256: (good[0] as LedgerRecord).contentSha256 } });
  assert.equal(bad([...good, early]), false, 'hora anterior à do registro anterior');
  assert.equal(bad([...good, makeRecord(LEDGER_AUTH_A, AUD, good[good.length - 1] ?? null, { event: 'CHECKPOINT', recordedAt: new Date(T0 + 80_000).toISOString(), actor: 'system', checkpoint: { throughSeq: 1, throughSha256: sha('1') } })]), false, 'checkpoint que não confere com o registro que declara');
  assert.equal(evaluateProtection(input([good[0] as LedgerRecord, ...good.slice(2)], refs)).view.reason, 'UNTRUSTED', 'a avaliação trata estrutura inválida como não confiável');
});

test('etiquetas: atual e aposentada válida verificam; adulterada, de outra chave ou de outro domínio ⇒ UNTRUSTED; revogada ⇒ SEMPRE KEY_REVOKED; vencida/desconhecida só com ponto de verificação', () => {
  const refs = chain(1);
  const good = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  assert.equal(verifyTags(good, LEDGER_AUTH_A), null);
  const tampered = good.map((record, index) => (index === 1 ? seal({ ...(({ contentSha256, ...rest }) => rest)(record), actor: 'intruso@empresa.com' }) : record)) as LedgerRecord[];
  assert.deepEqual(verifyTags(tampered, LEDGER_AUTH_A), { reason: 'UNTRUSTED', seq: 2 }, 'corpo alterado com hash refeito');
  assert.equal(verifyTags(good, LEDGER_AUTH_B)?.reason, 'KEY_UNKNOWN', 'chave de outro id (nenhuma configurada para este kid)');
  const crossKey = ledgerAuth(testKeySpec('lk-test-a', 'material-cruzado'));
  assert.equal(verifyTags(good, crossKey)?.reason, 'UNTRUSTED', 'mesmo id, outro material');
  assert.equal(verifyTags(good, TEST_ORIGIN as never)?.reason, 'UNTRUSTED', 'a chave de ORIGEM não autentica o livro (domínio/finalidade)');
  // rotação planejada: A aposentada (válida até 2026-11-30) e B atual
  const rotated = (now: Date) => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-11-30`], now: () => now });
  const plannedValid = rotated(new Date(Date.UTC(2026, 9, 25)));
  const expired = rotated(new Date(Date.UTC(2026, 11, 20)));
  assert.equal(verifyTags(good, plannedValid), null, 'aposentada dentro da validade');
  assert.equal(verifyTags(good, expired)?.reason, 'KEY_EXPIRED', 'vencida e sem ponto de verificação');
  // ponto de verificação sob a chave NOVA cobre os registros anteriores (assinados pela antiga)
  const tail = good[good.length - 1] as LedgerRecord;
  const checkpoint = makeRecord(plannedValid, AUD, tail, { event: 'CHECKPOINT', recordedAt: new Date(T0 + 90_000).toISOString(), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
  assert.equal(verifyTags([...good, checkpoint], expired), null, 'depois do vencimento, o ponto de verificação (chave nova) cobre');
  assert.equal(verifyTags([...good, checkpoint], LEDGER_AUTH_B), null, 'chave antiga removida da configuração: ainda coberto');
  // revogada: nunca coberta
  const revoked = ledgerAuth({ current: LEDGER_KEY_B, revokedIds: ['lk-test-a'] });
  assert.equal(verifyTags(good, revoked)?.reason, 'KEY_REVOKED');
  const newerCheckpoint = makeRecord(revoked, AUD, tail, { event: 'CHECKPOINT', recordedAt: new Date(T0 + 90_000).toISOString(), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
  assert.equal(verifyTags([...good, newerCheckpoint], revoked)?.reason, 'KEY_REVOKED', 'um ponto de verificação posterior NÃO limpa o que a chave comprometida assinou');
  // o ponto de verificação assinado por chave VENCIDA não cobre
  const staleCheckpoint = makeRecord(LEDGER_AUTH_A, AUD, tail, { event: 'CHECKPOINT', recordedAt: new Date(T0 + 90_000).toISOString(), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
  assert.equal(verifyTags([...good, staleCheckpoint], expired)?.reason, 'KEY_EXPIRED');
  // a etiqueta usa finalidade própria: o autenticador de origem não assina o livro
  assert.throws(() => TEST_ORIGIN.sign('LEDGER', { x: 1 }), /domínio/);
  assert.throws(() => LEDGER_AUTH_A.sign('DECISION', { x: 1 }), /domínio/);
});

test('ponto de verificação automático: a cada N registros e quando a cauda tem registro de chave diferente da atual', () => {
  const refs = chain(2);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  assert.equal(needsCheckpoint(records, 'lk-test-a', 64), false);
  assert.equal(needsCheckpoint(records, 'lk-test-b', 64), true, 'rotação: cauda assinada por outra chave');
  assert.equal(needsCheckpoint(records, 'lk-test-a', 3), true, 'a cada N');
  const tail = records[records.length - 1] as LedgerRecord;
  const checkpoint = makeRecord(LEDGER_AUTH_A, AUD, tail, { event: 'CHECKPOINT', recordedAt: new Date(T0 + 90_000).toISOString(), actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
  assert.equal(needsCheckpoint([...records, checkpoint], 'lk-test-a', 64), false, 'logo depois de um ponto de verificação da chave ATUAL não há o que cobrir');
  // R6-02: um ponto de verificação da chave ANTIGA não cobre a rotação — a chave nova precisa gravar o seu
  assert.equal(needsCheckpoint([...records, checkpoint], 'lk-test-b', 64), true, 'o último ponto de verificação é da chave antiga: a chave nova ainda precisa do seu');
  assert.equal(needsCheckpoint([], 'lk-test-a', 64), false);
});
