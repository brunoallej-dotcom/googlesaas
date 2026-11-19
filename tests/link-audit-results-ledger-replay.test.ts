import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProtection, replayLedger, verifyTags, type DecisionRef, type LedgerRecord, type ProtectionInput } from '../src/lib/link-audit-ledger';
import { LEDGER_AUTH_A, refOf } from './helpers/link-audit-ledger-fixtures';
import { chainOf, hashOf, type Chain, type RunBody } from './helpers/link-audit-results-ledger-fixtures';

/*
 * R1.1 — REPLAY com o segundo slot `openRun` (spec §16.17.2, invariantes I-1…I-6) e o autor no fecho (D-R1-1, §16.17.13) nas DUAS famílias. Toda violação
 * ⇒ replay inválido ⇒ `UNTRUSTED` na avaliação (falha fechada). Registros assinados com a chave de TESTE do livro: a regra que recusa é a do replay, não a
 * etiqueta (RL-23; mutações M-R04, M-R05, M-R06 campo a campo, M-R27, M-R28, M-R29 e M-R39).
 */
const AUD = 'auditoria-runs-0001';
const D1 = refOf(1, null, 'dec');
const D2 = refOf(2, D1.sha256, 'dec');
const NO_RESULTS = { ok: true as const, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] };

const replays = (chain: Chain | readonly LedgerRecord[]): boolean => replayLedger('records' in chain ? chain.records : chain, AUD).ok;
const chain0 = (): Chain => chainOf(AUD).genesis();
function evaluate(records: readonly LedgerRecord[], confirmed: readonly DecisionRef[] = []) {
  const input: ProtectionInput = {
    configured: true,
    read: { kind: 'PRESENT', records, tagFailure: verifyTags(records, LEDGER_AUTH_A) },
    auditId: AUD,
    decisions: { confirmed, pending: null },
    entryOriginProven: () => true,
    results: NO_RESULTS,
    guard: { status: 'NOT_CONFIGURED' },
    ageMsOf: () => 1_000,
    staleMs: 120_000,
    currentKeyId: LEDGER_AUTH_A.keyId,
  };
  return evaluateProtection(input);
}
/** O replay recusa E a avaliação diz UNTRUSTED (com etiquetas válidas: é o replay que recusa). */
function rejected(chain: Chain, label: string, confirmed: readonly DecisionRef[] = []): void {
  assert.equal(verifyTags(chain.records, LEDGER_AUTH_A), null, `${label}: controle — etiquetas válidas`);
  assert.equal(replays(chain), false, `${label}: o replay recusa`);
  const view = evaluate(chain.records, confirmed).view;
  assert.deepEqual([view.state, view.reason], ['HISTORY_UNRESOLVED', 'UNTRUSTED'], `${label}: avaliação`);
}
function accepted(chain: Chain, label: string, confirmed: readonly DecisionRef[] = []): void {
  const replay = replayLedger(chain.records, AUD);
  assert.ok(replay.ok, `${label}: ${replay.ok ? '' : replay.issues.join('; ')}`);
  assert.equal(evaluate(chain.records, confirmed).view.state, 'PROTECTED', `${label}: avaliação`);
}

test('RL-23: replay com RUN_* expõe confirmedRuns, openRun e abortedRuns, e as decisões (confirmed/open) ficam intactas', () => {
  const chain = chain0().decision(D1).run().runIntent().runAbort().runIntent();
  const replay = replayLedger(chain.records, AUD);
  assert.ok(replay.ok, replay.ok ? '' : replay.issues.join('; '));
  const value = replay.value;
  assert.equal(value.confirmed.length, 1, 'decisões confirmadas: só a da decisão');
  assert.equal(value.open, null, 'nenhuma operação de DECISÃO aberta (o RUN_INTENT não ocupa esse slot)');
  assert.equal(value.confirmedRuns.length, 1);
  const first = value.confirmedRuns[0];
  assert.deepEqual([first?.runSeq, first?.intentSeq, first?.confirmedSeq, first?.runSha256], [1, 4, 5, (chain.records[3] as unknown as { run: RunBody }).run.runSha256]);
  assert.deepEqual(value.abortedRuns.map((a) => [a.intentSeq, a.abortedSeq, a.run.runSeq]), [[6, 7, 2]]);
  assert.equal(value.openRun?.ledgerSeq, 8, 'o RUN_INTENT aberto');
  assert.deepEqual(value.head, { ledgerSeq: 8, sha256: chain.tail().contentSha256 }, 'a cabeça do livro continua sendo a cauda, de qualquer tipo');
  accepted(chain, 'cadeia completa', [D1]);
});

test('RL-23 / D-8: as famílias são independentes — INTENT de decisão com resultado aberto, e fechos intercalados nas duas ordens', () => {
  accepted(chain0().runIntent().decision(D1, { open: true }).runConfirm().confirmDecision(), 'RUN_INTENT, INTENT, RUN_CONFIRMED, CONFIRMED', [D1]);
  accepted(chain0().runIntent().decision(D1).runConfirm(), 'RUN_INTENT, INTENT, CONFIRMED, RUN_CONFIRMED', [D1]);
  accepted(chain0().runIntent().decision(D1, { open: true }).runAbort().abortDecision(), 'abortos intercalados');
  const both = chain0().runIntent().decision(D1, { open: true });
  const replay = replayLedger(both.records, AUD);
  assert.ok(replay.ok && replay.value.open?.event === 'INTENT' && replay.value.openRun?.event === 'RUN_INTENT', 'dois slots abertos ao mesmo tempo');
});

test('RL-23 / M-R04 (I-1): RUN_INTENT exige openRun === null E open === null', () => {
  rejected(chain0().runIntent().runIntent({ runSeq: 1, prevRunSha256: null }), 'RUN_INTENT com outro resultado aberto');
  rejected(chain0().decision(D1, { open: true }).runIntent(), 'RUN_INTENT com operação de DECISÃO aberta');
  accepted(chain0().decision(D1).runIntent(), 'controle: depois do CONFIRMED da decisão', [D1]);
  accepted(chain0().decision(D1, { open: true }).abortDecision().runIntent(), 'controle: depois do ABORTED da decisão');
});

test('RL-23 / M-R27 (I-2): RUN_INTENT.runSeq === confirmados + 1 e prevRunSha256 === runSha256 do último RUN_CONFIRMED', () => {
  rejected(chain0().runIntent({ runSeq: 2, prevRunSha256: hashOf('anterior') }), 'runSeq 2 sem nenhum confirmado');
  rejected(chain0().run().runIntent({ runSeq: 3 }), 'runSeq pula um');
  rejected(chain0().run().runIntent({ runSeq: 1, prevRunSha256: null }), 'runSeq repete o confirmado');
  rejected(chain0().run().runIntent({ prevRunSha256: hashOf('outro') }), 'anterior que não é o último confirmado');
  rejected(chain0().runIntent().runAbort().runIntent({ runSeq: 2, prevRunSha256: hashOf('abortado') }), 'aborto não conta como confirmado');
  accepted(chain0().runIntent().runAbort().runIntent(), 'controle: depois do aborto, o MESMO runSeq de novo');
  accepted(chain0().run().run().run(), 'controle: três resultados encadeados');
});

test('RL-23 / M-R05 (I-3): RUN_INTENT.citedLedgerHead === cabeça de decisões do PREFIXO (último registro não RUN_*), nunca a cauda RUN_*', () => {
  const after = chain0().decision(D1).run();
  const runConfirmed = after.tail(); // cauda RUN_*
  const decisionTail = after.records[2] as LedgerRecord; // CONFIRMED da decisão
  rejected(chain0().decision(D1).run().runIntent({ citedLedgerHead: { ledgerSeq: runConfirmed.ledgerSeq, sha256: runConfirmed.contentSha256 } }), 'cita a cauda RUN_CONFIRMED', [D1]);
  rejected(chain0().decision(D1).runIntent({ citedLedgerHead: { ledgerSeq: 2, sha256: (after.records[1] as LedgerRecord).contentSha256 } }), 'cita registro de decisão ANTERIOR ao último', [D1]);
  rejected(chain0().decision(D1).runIntent({ citedLedgerHead: { ledgerSeq: decisionTail.ledgerSeq, sha256: hashOf('outro') } }), 'posição certa, hash errado', [D1]);
  // a cauda é RUN_*: a cabeça citada é a do último registro de DECISÃO (aqui o CONFIRMED, seq 3)
  const valid = chain0().decision(D1).run().runIntent();
  assert.deepEqual((valid.tail() as unknown as { run: RunBody }).run.citedLedgerHead, { ledgerSeq: 3, sha256: decisionTail.contentSha256 });
  accepted(valid, 'controle: cauda RUN_* e citação da cabeça de decisões', [D1]);
  accepted(chain0().decision(D1).run().checkpoint().runIntent(), 'controle: CHECKPOINT é cabeça de decisões (D-6)', [D1]);
  accepted(chain0().decision(D1, { open: true }).abortDecision().runIntent(), 'controle: ABORTED é cabeça de decisões');
});

test('RL-23 / M-R28 (I-4): RUN_INTENT.decisionsHead === newDecisionsHead do último CONFIRMED (ou null)', () => {
  rejected(chain0().decision(D1).runIntent({ decisionsHead: null }), 'nulo com decisão confirmada', [D1]);
  rejected(chain0().decision(D1).runIntent({ decisionsHead: { seq: 1, sha256: hashOf('outro') } }), 'hash errado', [D1]);
  rejected(chain0().decision(D1).decision(D2).runIntent({ decisionsHead: { seq: 1, sha256: D1.sha256 } }), 'decisão anterior à última', [D1, D2]);
  rejected(chain0().runIntent({ decisionsHead: { seq: 1, sha256: D1.sha256 } }), 'não nulo sem decisão confirmada');
  rejected(chain0().decision(D1).decision(D2, { open: true }).abortDecision().runIntent({ decisionsHead: { seq: 2, sha256: D2.sha256 } }), 'decisão abortada não conta', [D1]);
  accepted(chain0().decision(D1).decision(D2, { open: true }).abortDecision().runIntent(), 'controle: depois do aborto vale a última confirmada', [D1]);
});

/** Cadeia com o 2º resultado aberto (runSeq 2, anterior não nulo): permite mudar runSeq e prevRunSha256 sem violar S-7. */
const withSecondOpen = (): Chain => chain0().decision(D1).run().runIntent();
const FIELD_BREAKS: ReadonlyArray<[string, Partial<RunBody>]> = [
  ['runOpId', { runOpId: 'f'.repeat(32) }],
  ['runSeq', { runSeq: 3 }],
  ['prevRunSha256', { prevRunSha256: hashOf('outro-anterior') }],
  ['runSha256', { runSha256: hashOf('outro-resultado') }],
  ['author', { author: 'bia@empresa.com' }],
  ['citedLedgerHead.ledgerSeq', { citedLedgerHead: { ledgerSeq: 2, sha256: hashOf('x') } }],
  ['citedLedgerHead.sha256', { citedLedgerHead: { ledgerSeq: 3, sha256: hashOf('x') } }],
  ['decisionsHead.seq', { decisionsHead: { seq: 2, sha256: D1.sha256 } }],
  ['decisionsHead.sha256', { decisionsHead: { seq: 1, sha256: hashOf('x') } }],
  ['decisionsHead nulo', { decisionsHead: null }],
];

test('RL-23 / M-R06 (I-5), CAMPO A CAMPO: RUN_CONFIRMED e RUN_ABORTED só com openRun aberto, intentSeq da posição dele e os MESMOS campos', () => {
  for (const [field, over] of FIELD_BREAKS) {
    // o actor do fecho é o autor do RUN_INTENT (Ana): só o campo quebrado difere
    rejected(withSecondOpen().runConfirm('ana@empresa.com', over), `RUN_CONFIRMED com ${field} diferente`, [D1]);
    rejected(withSecondOpen().runAbort('ana@empresa.com', over), `RUN_ABORTED com ${field} diferente`, [D1]);
  }
  rejected(chain0().decision(D1).run().runIntent().runConfirm('ana@empresa.com', { intentSeq: 4 }), 'RUN_CONFIRMED com intentSeq de outro RUN_INTENT', [D1]);
  rejected(chain0().decision(D1).run().runIntent().runAbort('bia@empresa.com', { intentSeq: 3 }), 'RUN_ABORTED com intentSeq de registro de decisão', [D1]);
  // fecho sem RUN_INTENT aberto: monta o fecho de um resultado já fechado
  const closed = chain0().decision(D1).run();
  const intent = closed.records[3] as unknown as { run: RunBody; ledgerSeq: number };
  rejected(closed.raw({ event: 'RUN_CONFIRMED', actor: 'ana@empresa.com', run: { ...intent.run, intentSeq: 4, anchorRef: { name: 'a0001.json', headSha256: intent.run.runSha256 } } }), 'RUN_CONFIRMED repetido (sem openRun)', [D1]);
  const none = chain0().decision(D1);
  rejected(none.raw({ event: 'RUN_ABORTED', actor: 'bia@empresa.com', run: { runOpId: 'e'.repeat(32), runSeq: 1, prevRunSha256: null, runSha256: hashOf('r'), author: 'ana@empresa.com', citedLedgerHead: { ledgerSeq: 3, sha256: (none.records[2] as LedgerRecord).contentSha256 }, decisionsHead: { seq: 1, sha256: D1.sha256 }, intentSeq: 2, observed: { resultPresent: false, receiptPresent: false, ageMs: 1 } } }), 'RUN_ABORTED sem nenhum RUN_INTENT', [D1]);
  accepted(withSecondOpen().runConfirm(), 'controle: fecho idêntico', [D1]);
  accepted(withSecondOpen().runAbort(), 'controle: aborto idêntico', [D1]);
});

test('RL-23 / M-R29 (I-6): CHECKPOINT e RECEIPT_REISSUED entram com resultado aberto; a reemissão continua exigindo nenhuma operação de DECISÃO aberta', () => {
  accepted(chain0().decision(D1).runIntent().checkpoint().runConfirm(), 'CHECKPOINT com openRun', [D1]);
  accepted(chain0().decision(D1).runIntent().reissue().runConfirm(), 'RECEIPT_REISSUED com openRun', [D1]);
  accepted(chain0().decision(D1).runIntent().reissue().checkpoint(), 'os dois, com o resultado ainda aberto', [D1]);
  rejected(chain0().decision(D1).decision(D2, { open: true }).reissue(), 'reemissão com operação de decisão aberta (inalterado)', [D1]);
});

test('replay falha fechado em evento que nenhum caso trata (o esquema já o recusa; o replay não confia nisso)', () => {
  rejected(chain0().decision(D1).raw({ event: 'RUN_REISSUED', actor: 'system' }), 'evento desconhecido', [D1]);
});

/* ============================================================================ D-R1-1: autor no fecho, nas DUAS famílias (M-R39) */

test('D-R1-1 / M-R39 (RUN_*): RUN_CONFIRMED só pelo autor do RUN_INTENT (normalizado); RUN_ABORTED de qualquer operador', () => {
  rejected(withSecondOpen().runConfirm('bia@empresa.com'), 'RUN_CONFIRMED gravado por outro operador', [D1]);
  rejected(withSecondOpen().runConfirm('system'), 'RUN_CONFIRMED gravado por system', [D1]);
  accepted(withSecondOpen().runConfirm('ANA@Empresa.COM'), 'autor com outra caixa (normalização)', [D1]);
  accepted(chain0().runIntent({ author: 'Ana@Empresa.com' }, 'Ana@Empresa.com').runConfirm('ana@empresa.com'), 'autor gravado com caixa, fecho normalizado (normaliza os DOIS lados)');
  accepted(withSecondOpen().runAbort('bia@empresa.com'), 'RUN_ABORTED de outro operador', [D1]);
  accepted(withSecondOpen().runAbort('system'), 'RUN_ABORTED de system', [D1]);
});

test('D-R1-1 / M-R39 (decisões): CONFIRMED só pelo autor da INTENT (normalizado); ABORTED e RECEIPT_REISSUED inalterados', () => {
  rejected(chain0().decision(D1, { actor: 'bia@empresa.com' }), 'CONFIRMED autêntico gravado por outro operador', [D1]);
  rejected(chain0().decision(D1, { actor: 'system' }), 'CONFIRMED gravado por system', [D1]);
  accepted(chain0().decision(D1, { actor: 'ANA@EMPRESA.COM' }), 'autor com outra caixa (normalização)', [D1]);
  const upper = refOf(1, null, 'dec', { author: 'Ana@Empresa.com' });
  const upperChain = chain0().decision(upper, { actor: 'ana@empresa.com' });
  const replay = replayLedger(upperChain.records, AUD);
  assert.ok(replay.ok, `autor gravado com caixa, fecho normalizado (normaliza os DOIS lados): ${replay.ok ? '' : replay.issues.join('; ')}`);
  accepted(chain0().decision(D1, { open: true }).abortDecision('bia@empresa.com'), 'ABORTED de outro operador');
  accepted(chain0().decision(D1).reissue('bia@empresa.com'), 'RECEIPT_REISSUED de outro operador', [D1]);
});
