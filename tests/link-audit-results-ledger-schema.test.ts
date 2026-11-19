import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  createLedgerService,
  evaluateProtection,
  LEDGER_EVENTS,
  LEDGER_RUN_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  ledgerRecordSchema,
  MAX_LEDGER_RECORD_BYTES,
  MAX_RUNS,
  readLedgerFiles,
  runAnchorName,
  verifyTags,
  type LedgerRecord,
} from '../src/lib/link-audit-ledger';
import type { LedgerPort } from '../src/lib/link-audit-decisions/ledger-port';
import { createOriginAuthenticator, originProofSchema } from '../src/lib/link-audit-origin';
import { MAX_RUNS as RESULTS_MAX_RUNS, runAnchorFileName } from '../src/lib/link-audit-scoring-runs/results-types';
import { serialize } from '../src/lib/link-audit-storage';
import { registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { LEDGER_AUTH_A, LEDGER_KEY_A, refOf, syntheticLedger } from './helpers/link-audit-ledger-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';
import { chainOf, hashOf, resign, writeLedger, type Chain } from './helpers/link-audit-results-ledger-fixtures';

/*
 * R1.1 — ESQUEMA dos registros `RUN_*` no livro de cabeças (spec §16.17.2): versão por família (decisão = 1, byte a byte; `RUN_*` = 2), regras S-1…S-7,
 * objetos estritos, etiqueta HMAC com a chave EXCLUSIVA do livro e domínio LEDGER, teto de 4 KiB, constantes duplicadas iguais às dos resultados e o leitor
 * anterior à R1 (cópia congelada) recusando todo `RUN_*` (RL-22, RL-36; mutações M-R01, M-R02, M-R03, M-R23, M-R24, M-R25, M-R26).
 */
registerCleanup();
const AUD = 'auditoria-runs-0001';
const NO_RESULTS = { ok: true as const, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] };

/** GENESIS, uma decisão confirmada, um resultado confirmado (seq 4–5) e um segundo resultado abortado (seq 6–7). */
function base(): { chain: Chain; intent: LedgerRecord; confirmed: LedgerRecord; intent2: LedgerRecord; aborted: LedgerRecord } {
  const chain = chainOf(AUD).genesis().decision(refOf(1, null, 'dec')).runIntent().runConfirm().runIntent().runAbort();
  const [, , , intent, confirmed, intent2, aborted] = chain.records as [LedgerRecord, LedgerRecord, LedgerRecord, LedgerRecord, LedgerRecord, LedgerRecord, LedgerRecord];
  return { chain, intent, confirmed, intent2, aborted };
}
const accepts = (record: unknown): boolean => ledgerRecordSchema.safeParse(record).success;
const mutate = (record: LedgerRecord, change: (u: Record<string, unknown>) => void): LedgerRecord =>
  resign(LEDGER_AUTH_A, record, (u) => {
    change(u);
    return u;
  });
const runOf = (u: Record<string, unknown>): Record<string, unknown> => u.run as Record<string, unknown>;

test('RL-22: os três RUN_* válidos passam e a leitura é a identidade (nada é acrescentado nem removido); constantes de versão por família', () => {
  const { intent, confirmed, aborted } = base();
  assert.deepEqual([LEDGER_SCHEMA_VERSION, LEDGER_RUN_SCHEMA_VERSION], [1, 2]);
  assert.deepEqual([...LEDGER_EVENTS], ['GENESIS', 'INTENT', 'CONFIRMED', 'ABORTED', 'RECEIPT_REISSUED', 'CHECKPOINT', 'RUN_INTENT', 'RUN_CONFIRMED', 'RUN_ABORTED']);
  for (const record of [intent, confirmed, aborted]) {
    const parsed = ledgerRecordSchema.safeParse(record);
    assert.ok(parsed.success, `${record.event}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
    assert.deepEqual(parsed.data, record, `${record.event}: leitura sem transformação`);
    assert.equal(record.schemaVersion, 2);
  }
});

test('RL-22 / M-R01 (S-1): `run` presente ⇔ evento RUN_*; RUN_* não carrega op, genesis nem checkpoint; evento de decisão não carrega run', () => {
  const { chain, intent, confirmed, aborted } = base();
  const decision = chain.records[2] as LedgerRecord; // CONFIRMED da decisão
  const op = decision.op as NonNullable<LedgerRecord['op']>;
  for (const record of [intent, confirmed, aborted]) {
    assert.equal(accepts(mutate(record, (u) => delete u.run)), false, `${record.event} sem run`);
    assert.equal(accepts(mutate(record, (u) => (u.op = op))), false, `${record.event} com op`);
    assert.equal(accepts(mutate(record, (u) => (u.genesis = { mode: 'EMPTY' }))), false, `${record.event} com genesis`);
    assert.equal(accepts(mutate(record, (u) => (u.checkpoint = { throughSeq: 1, throughSha256: (chain.records[0] as LedgerRecord).contentSha256 }))), false, `${record.event} com checkpoint`);
  }
  for (const record of chain.records.slice(0, 3)) {
    assert.ok(accepts(record), `controle: ${record.event} de decisão é válido`);
    assert.equal(accepts(mutate(record, (u) => (u.run = (intent as unknown as { run: unknown }).run))), false, `${record.event} de decisão com run`);
  }
  const checkpoint = chainOf(AUD).genesis().checkpoint().tail();
  assert.equal(accepts(mutate(checkpoint, (u) => (u.run = (intent as unknown as { run: unknown }).run))), false, 'CHECKPOINT com run');
});

test('RL-22 / M-R02 (S-2): versão ⇔ família — RUN_* com schemaVersion 1 e evento de decisão com 2 são recusados; versão desconhecida também', () => {
  const { chain, intent, confirmed, aborted } = base();
  for (const record of [intent, confirmed, aborted]) {
    assert.equal(accepts(mutate(record, (u) => (u.schemaVersion = 1))), false, `${record.event} com versão 1`);
    assert.equal(accepts(mutate(record, (u) => (u.schemaVersion = 3))), false, `${record.event} com versão 3`);
  }
  const first = refOf(1, null, 'dec');
  const decisions = chainOf(AUD).genesis().decision(first).decision(refOf(2, first.sha256, 'x'), { open: true }).abortDecision().checkpoint().reissue().records;
  assert.deepEqual([...new Set(decisions.map((r) => r.event))].sort(), ['ABORTED', 'CHECKPOINT', 'CONFIRMED', 'GENESIS', 'INTENT', 'RECEIPT_REISSUED']);
  for (const record of [...decisions, chain.records[1] as LedgerRecord]) {
    assert.ok(accepts(record), `controle: ${record.event} v1`);
    assert.equal(accepts(mutate(record, (u) => (u.schemaVersion = 2))), false, `${record.event} com versão 2`);
    assert.equal(accepts(mutate(record, (u) => (u.schemaVersion = 3))), false, `${record.event} com versão 3`);
    assert.equal(accepts(mutate(record, (u) => (u.schemaVersion = 0))), false, `${record.event} com versão 0`);
  }
});

test('RL-22 / M-R23 (S-3): RUN_INTENT não fecha nada — sem intentSeq, anchorRef nem observed', () => {
  const { intent } = base();
  assert.equal(accepts(mutate(intent, (u) => (runOf(u).intentSeq = 1))), false, 'intentSeq');
  assert.equal(accepts(mutate(intent, (u) => (runOf(u).anchorRef = { name: 'a0001.json', headSha256: runOf(u).runSha256 }))), false, 'anchorRef');
  assert.equal(accepts(mutate(intent, (u) => (runOf(u).observed = { resultPresent: false, receiptPresent: false, ageMs: 1 }))), false, 'observed');
});

test('RL-22 / M-R03 (S-4): RUN_CONFIRMED exige intentSeq e anchorRef, sem observed; anchorRef.headSha256 === runSha256 e anchorRef.name === runAnchorName(runSeq)', () => {
  const { confirmed } = base();
  assert.equal(accepts(mutate(confirmed, (u) => delete runOf(u).intentSeq)), false, 'sem intentSeq');
  assert.equal(accepts(mutate(confirmed, (u) => delete runOf(u).anchorRef)), false, 'sem anchorRef');
  assert.equal(accepts(mutate(confirmed, (u) => (runOf(u).observed = { resultPresent: false, receiptPresent: false, ageMs: 1 }))), false, 'com observed');
  assert.equal(accepts(mutate(confirmed, (u) => (runOf(u).anchorRef = { name: 'a0001.json', headSha256: hashOf('outro') }))), false, 'headSha256 ≠ runSha256');
  assert.equal(accepts(mutate(confirmed, (u) => (runOf(u).anchorRef = { name: 'a0002.json', headSha256: runOf(u).runSha256 }))), false, 'nome de outro recibo');
  assert.equal(accepts(mutate(confirmed, (u) => (runOf(u).anchorRef = { name: 's0001.json', headSha256: runOf(u).runSha256 }))), false, 'nome fora do padrão');
});

test('RL-22 / M-R24 (S-5): RUN_ABORTED exige intentSeq e observed (os dois ausentes, idade ≥ 0), sem anchorRef', () => {
  const { aborted } = base();
  assert.equal(accepts(mutate(aborted, (u) => delete runOf(u).intentSeq)), false, 'sem intentSeq');
  assert.equal(accepts(mutate(aborted, (u) => delete runOf(u).observed)), false, 'sem observed');
  assert.equal(accepts(mutate(aborted, (u) => (runOf(u).anchorRef = { name: 'a0002.json', headSha256: runOf(u).runSha256 }))), false, 'com anchorRef');
  assert.equal(accepts(mutate(aborted, (u) => (runOf(u).observed = { resultPresent: true, receiptPresent: false, ageMs: 1 }))), false, 'resultado presente');
  assert.equal(accepts(mutate(aborted, (u) => (runOf(u).observed = { resultPresent: false, receiptPresent: true, ageMs: 1 }))), false, 'recibo presente');
  assert.equal(accepts(mutate(aborted, (u) => (runOf(u).observed = { resultPresent: false, receiptPresent: false, ageMs: -1 }))), false, 'idade negativa');
});

test('RL-22 / M-R25 (S-6): intentSeq e citedLedgerHead.ledgerSeq anteriores ao próprio registro', () => {
  const { intent, confirmed, aborted } = base();
  for (const record of [confirmed, aborted]) {
    assert.equal(accepts(mutate(record, (u) => (runOf(u).intentSeq = record.ledgerSeq))), false, `${record.event}: intentSeq = ledgerSeq`);
    assert.equal(accepts(mutate(record, (u) => (runOf(u).intentSeq = record.ledgerSeq + 1))), false, `${record.event}: intentSeq > ledgerSeq`);
    assert.ok(accepts(mutate(record, (u) => (runOf(u).intentSeq = record.ledgerSeq - 1))), `controle ${record.event}: intentSeq imediatamente anterior`);
  }
  for (const record of [intent, confirmed, aborted]) {
    assert.equal(accepts(mutate(record, (u) => (runOf(u).citedLedgerHead = { ledgerSeq: record.ledgerSeq, sha256: hashOf('x') }))), false, `${record.event}: cabeça citada = a própria posição`);
    assert.equal(accepts(mutate(record, (u) => (runOf(u).citedLedgerHead = { ledgerSeq: record.ledgerSeq + 5, sha256: hashOf('x') }))), false, `${record.event}: cabeça citada à frente`);
    assert.ok(accepts(mutate(record, (u) => (runOf(u).citedLedgerHead = { ledgerSeq: record.ledgerSeq - 1, sha256: hashOf('x') }))), `controle ${record.event}: posição anterior`);
  }
});

test('RL-22 / M-R26 (S-7): (runSeq === 1) ⇔ (prevRunSha256 === null)', () => {
  const { intent, confirmed, intent2 } = base();
  assert.equal(accepts(mutate(intent, (u) => (runOf(u).prevRunSha256 = hashOf('anterior')))), false, 'runSeq 1 com anterior');
  assert.equal(accepts(mutate(intent2, (u) => (runOf(u).prevRunSha256 = null))), false, 'runSeq 2 sem anterior');
  assert.equal(accepts(mutate(confirmed, (u) => (runOf(u).prevRunSha256 = hashOf('anterior')))), false, 'fecho com runSeq 1 e anterior');
  assert.ok(accepts(intent2), 'controle: runSeq 2 com anterior');
});

test('RL-22: objetos estritos e faixas — chave a mais em qualquer nível, runSeq fora de 1..500, posições fora de 1..4000, identificadores e autor mal formados', () => {
  const { intent, confirmed, aborted, intent2 } = base();
  const bad: Array<[string, LedgerRecord, (u: Record<string, unknown>) => void]> = [
    ['chave a mais no registro', intent, (u) => (u.extra = 1)],
    ['chave a mais em run', intent, (u) => (runOf(u).extra = 1)],
    ['chave a mais em citedLedgerHead', intent, (u) => ((runOf(u).citedLedgerHead as Record<string, unknown>).extra = 1)],
    ['chave a mais em decisionsHead', intent, (u) => ((runOf(u).decisionsHead as Record<string, unknown>).extra = 1)],
    ['chave a mais em anchorRef', confirmed, (u) => ((runOf(u).anchorRef as Record<string, unknown>).extra = 1)],
    ['chave a mais em observed', aborted, (u) => ((runOf(u).observed as Record<string, unknown>).extra = 1)],
    ['runSeq 0', intent, (u) => (runOf(u).runSeq = 0)],
    ['runSeq 501', intent2, (u) => (runOf(u).runSeq = 501)],
    ['runSeq fracionário', intent2, (u) => (runOf(u).runSeq = 1.5)],
    ['citedLedgerHead.ledgerSeq 0', intent, (u) => (runOf(u).citedLedgerHead = { ledgerSeq: 0, sha256: hashOf('x') })],
    ['decisionsHead.seq 0', intent, (u) => (runOf(u).decisionsHead = { seq: 0, sha256: hashOf('x') })],
    ['decisionsHead.seq 10000', intent, (u) => (runOf(u).decisionsHead = { seq: 10000, sha256: hashOf('x') })],
    ['runOpId curto', intent, (u) => (runOf(u).runOpId = 'abc')],
    ['runOpId maiúsculo', intent, (u) => (runOf(u).runOpId = 'A'.repeat(32))],
    ['runSha256 inválido', intent, (u) => (runOf(u).runSha256 = 'z'.repeat(64))],
    ['autor com espaço', intent, (u) => (runOf(u).author = 'ana @empresa.com')],
    ['autor vazio', intent, (u) => (runOf(u).author = '')],
    ['intentSeq 0', confirmed, (u) => (runOf(u).intentSeq = 0)],
    ['evento desconhecido', intent, (u) => (u.event = 'RUN_REISSUED')],
    ['sem run.author', intent, (u) => delete runOf(u).author],
    ['sem decisionsHead', intent, (u) => delete runOf(u).decisionsHead],
  ];
  for (const [label, record, change] of bad) assert.equal(accepts(mutate(record, change)), false, label);
  assert.ok(accepts(mutate(intent2, (u) => (runOf(u).runSeq = MAX_RUNS))), `controle: runSeq ${MAX_RUNS} (o teto) cabe`);
  assert.ok(accepts(mutate(intent, (u) => (runOf(u).decisionsHead = null))), 'controle: decisionsHead nulo (nenhuma decisão confirmada)');
});

test('RL-22: MAX_RUNS e runAnchorName duplicados no livro são IGUAIS aos dos resultados (o livro não importa link-audit-scoring-runs)', () => {
  assert.equal(MAX_RUNS, RESULTS_MAX_RUNS);
  for (const seq of [1, 2, 9, 10, 99, 100, 499, 500]) assert.equal(runAnchorName(seq), runAnchorFileName(seq), `seq ${seq}`);
});

test('RL-22: etiqueta — RUN_* da chave do livro verifica; corpo alterado (run, evento ou posição) não; chave de ORIGEM (domínio RUN) ou outra finalidade com o mesmo id ⇒ não autentica', () => {
  const { chain, intent } = base();
  assert.equal(verifyTags(chain.records, LEDGER_AUTH_A), null, 'controle: cadeia com RUN_* autêntica');
  const at = chain.records.indexOf(intent);
  const swapped = (record: LedgerRecord): LedgerRecord[] => chain.records.map((r, i) => (i === at ? record : r));
  // corpo alterado sem refazer a etiqueta (o hash é refeito: só a etiqueta denuncia)
  const resealed = (change: (u: Record<string, unknown>) => void): LedgerRecord => {
    const { contentSha256: _h, ...rest } = structuredClone(intent) as unknown as Record<string, unknown>;
    void _h;
    change(rest);
    return { ...(rest as object), contentSha256: createHash('sha256').update('x').digest('hex') } as LedgerRecord;
  };
  for (const [label, change] of [
    ['run.runSha256', (u: Record<string, unknown>) => (runOf(u).runSha256 = hashOf('trocado'))],
    ['run.author', (u: Record<string, unknown>) => (runOf(u).author = 'bia@empresa.com')],
    ['run.citedLedgerHead', (u: Record<string, unknown>) => (runOf(u).citedLedgerHead = { ledgerSeq: 1, sha256: (chain.records[0] as LedgerRecord).contentSha256 })],
  ] as const) {
    assert.deepEqual(verifyTags(swapped(resealed(change)), LEDGER_AUTH_A), { reason: 'UNTRUSTED', seq: intent.ledgerSeq }, label);
  }
  // chave de ORIGEM: id próprio ⇒ chave desconhecida do livro; mesmo id do livro com a finalidade de origem (domínio RUN) ⇒ etiqueta inválida
  const unsigned = (({ origin: _o, contentSha256: _c, ...rest }) => rest)(intent as unknown as Record<string, unknown> & { origin: unknown; contentSha256: unknown });
  const withOrigin = (origin: unknown): LedgerRecord => ({ ...unsigned, origin, contentSha256: hashOf('qualquer') }) as unknown as LedgerRecord;
  const originKey = withOrigin(TEST_ORIGIN.sign('RUN', unsigned));
  assert.equal(verifyTags(swapped(originKey), LEDGER_AUTH_A)?.reason, 'KEY_UNKNOWN', 'chave de origem (outro id): não autentica o livro');
  const sameIdOtherPurpose = createOriginAuthenticator({ current: LEDGER_KEY_A, purpose: 'origin' });
  assert.equal(sameIdOtherPurpose.keyId, LEDGER_AUTH_A.keyId);
  const crossDomain = withOrigin(sameIdOtherPurpose.sign('RUN', unsigned));
  assert.deepEqual(verifyTags(swapped(crossDomain), LEDGER_AUTH_A), { reason: 'UNTRUSTED', seq: intent.ledgerSeq }, 'mesmo id, finalidade de origem e domínio RUN ⇒ UNTRUSTED');
  const decisionDomain = withOrigin(sameIdOtherPurpose.sign('DECISION', unsigned));
  assert.deepEqual(verifyTags(swapped(decisionDomain), LEDGER_AUTH_A), { reason: 'UNTRUSTED', seq: intent.ledgerSeq }, 'domínio DECISION ⇒ UNTRUSTED');
  // a avaliação falha fechada nos dois casos
  for (const forged of [originKey, crossDomain]) {
    const records = swapped(forged);
    const failure = verifyTags(records, LEDGER_AUTH_A);
    const view = evaluateProtection({ configured: true, read: { kind: 'PRESENT', records, tagFailure: failure }, auditId: AUD, decisions: { confirmed: [refOf(1, null, 'dec')], pending: null }, entryOriginProven: () => true, results: NO_RESULTS, guard: { status: 'NOT_CONFIGURED' }, ageMsOf: () => 0, staleMs: 120_000 }).view;
    assert.equal(view.state, 'HISTORY_UNRESOLVED');
  }
});

test('RL-22: teto de 4 KiB — o maior RUN_* possível cabe com folga; o armazenamento lê os três RUN_* de um livro real', async () => {
  const author = `${'a'.repeat(240)}@empresa.com`;
  assert.ok(author.length <= 254);
  const chain = chainOf(AUD).genesis().decision(refOf(1, null, 'dec')).runIntent({ author }, author).runConfirm(author).runIntent({ author }, author).runAbort(author);
  for (const record of chain.records.filter((r) => r.event.startsWith('RUN_'))) {
    assert.ok(accepts(record), record.event);
    const bytes = Buffer.byteLength(serialize(record));
    assert.ok(bytes < MAX_LEDGER_RECORD_BYTES, `${record.event}: ${bytes} bytes < ${MAX_LEDGER_RECORD_BYTES}`);
  }
  const w = { ledgerDir: tmpDir('lad-run-'), auditId: AUD };
  writeLedger(w, chain.records);
  const read = await readLedgerFiles(w.ledgerDir, AUD);
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual(read.value.records, chain.records, 'o que foi gravado é exatamente o que se lê');
});

/* ============================================================================ decisões v1 BYTE A BYTE */

test('decisões continuam schemaVersion 1 BYTE A BYTE: hashes de ouro (calculados ANTES da R1.1) e o GENESIS gravado pelo serviço real com os mesmos bytes', async () => {
  // cadeia sintética fixa (GENESIS, RECORD, REVOKE): hash da cauda calculado no código anterior à R1.1 (main 655850d + docs)
  const refs = [refOf(1, null, 'dec')];
  refs.push(refOf(2, (refs[0] as { sha256: string }).sha256, 'dec', { action: 'REVOKE', decisionId: null, revokes: 'op-0001', affectsPrior: true }));
  const records = syntheticLedger(LEDGER_AUTH_A, 'auditoria-golden-0001', refs);
  assert.equal(records.length, 5);
  assert.equal((records[4] as LedgerRecord).contentSha256, '8696530a989f370f07d7f63abb15e547e1ce9094553fe65c88f0b799cae951fe');
  for (const record of records) {
    const parsed = ledgerRecordSchema.safeParse(record);
    assert.ok(parsed.success, `${record.event}: o esquema novo lê o v1`);
    assert.deepEqual(parsed.data, record, `${record.event}: sem tocar em nada (nenhum campo acrescentado, removido ou convertido)`);
    assert.equal(record.schemaVersion, 1);
    assert.ok(!('run' in record), 'nenhum campo novo nos registros de decisão');
  }
  // o ESCRITOR real (append do serviço) grava o GENESIS com os mesmos bytes de antes
  const dir = tmpDir('lad-gold-');
  const port = createLedgerService({ dir, authenticator: LEDGER_AUTH_A, otherDirs: [] });
  const enrolled = await port.enroll({ auditId: 'auditoria-golden-0001', actor: 'ana@empresa.com', snapshot: { confirmed: [], pending: null }, results: NO_RESULTS, nowIso: '2026-10-21T12:00:00.000Z' });
  assert.ok(enrolled.ok, JSON.stringify(enrolled));
  const bytes = fs.readFileSync(path.join(dir, 'auditoria-golden-0001', 'l000001.json'));
  assert.deepEqual([createHash('sha256').update(bytes).digest('hex'), bytes.length], ['d6ee1a21b413ff926f23ffbbe1cb571f23c1b072684466cce36f608f164c8bd0', 500]);
});

/* ============================================================================ RL-36: imagem anterior à R1 */

/*
 * CÓPIA CONGELADA do esquema v1 (src/lib/link-audit-ledger/types.ts, linhas 61–142 da main 655850d). NÃO atualizar: representa a imagem que já existe e
 * que, depois do primeiro `RUN_*`, tem de ler o livro como NÃO confiável (falha fechada; extensão de R6-09, spec 16.17.10).
 */
const PRE_R1_MAX_LEDGER_RECORDS = 4000;
const PRE_R1_AUDIT_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const preHex64 = z.string().regex(/^[0-9a-f]{64}$/);
const preHex32 = z.string().regex(/^[0-9a-f]{32}$/);
const preIso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const preSeqNumber = z.number().int().min(1).max(9999);
const preActor = z.string().regex(/^[^\s\u0000-\u001f\u007f-\u009f]{1,254}$/);
const preDecisionId = z.string().regex(/^op-\d{4}$/);
const preHead = z.object({ seq: preSeqNumber, sha256: preHex64 }).strict();
const PRE_R1_EVENTS = ['GENESIS', 'INTENT', 'CONFIRMED', 'ABORTED', 'RECEIPT_REISSUED', 'CHECKPOINT'] as const;
const preOp = z
  .object({
    opId: preHex32,
    decisionSeq: preSeqNumber,
    prevDecisionsHead: preHead.nullable(),
    newDecisionsHead: preHead,
    action: z.enum(['RECORD', 'REVOKE']),
    author: preActor,
    decisionId: preDecisionId.nullable(),
    revokes: preDecisionId.nullable(),
    supersedes: preDecisionId.nullable(),
    affectsPrior: z.boolean(),
    intentSeq: z.number().int().min(1).max(PRE_R1_MAX_LEDGER_RECORDS).optional(),
    anchorRef: z.object({ name: z.string().regex(/^a\d{4}\.json$/), headSha256: preHex64 }).strict().optional(),
    observed: z.object({ entryPresent: z.literal(false), receiptPresent: z.literal(false), ageMs: z.number().int().min(0) }).strict().optional(),
  })
  .strict();
const PRE_R1_LEDGER_RECORD_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('link-audit-decisions-ledger'),
    auditId: z.string().regex(PRE_R1_AUDIT_ID),
    ledgerSeq: z.number().int().min(1).max(PRE_R1_MAX_LEDGER_RECORDS),
    prevSha256: preHex64.nullable(),
    event: z.enum(PRE_R1_EVENTS),
    recordedAt: preIso,
    actor: preActor,
    op: preOp.optional(),
    genesis: z.object({ mode: z.literal('EMPTY') }).strict().optional(),
    checkpoint: z.object({ throughSeq: z.number().int().min(1).max(PRE_R1_MAX_LEDGER_RECORDS), throughSha256: preHex64 }).strict().optional(),
    origin: originProofSchema,
    contentSha256: preHex64,
  })
  .strict()
  .superRefine((record, ctx) => {
    const bad = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const { event, op, genesis, checkpoint } = record;
    if (event === 'GENESIS') {
      if (!genesis || op || checkpoint || record.ledgerSeq !== 1 || record.prevSha256 !== null) bad('GENESIS inválido');
      return;
    }
    if (genesis) bad('só o GENESIS carrega genesis');
    if (event === 'CHECKPOINT') {
      if (!checkpoint || op || checkpoint.throughSeq >= record.ledgerSeq) bad('CHECKPOINT inválido');
      return;
    }
    if (checkpoint) bad('só o CHECKPOINT carrega checkpoint');
    if (!op) {
      bad(`${event} exige op`);
      return;
    }
    if (op.newDecisionsHead.seq !== op.decisionSeq) bad('newDecisionsHead.seq difere de decisionSeq');
    if ((op.prevDecisionsHead?.seq ?? 0) + 1 !== op.decisionSeq) bad('prevDecisionsHead não é o anterior de decisionSeq');
    if (op.action === 'REVOKE' ? op.revokes === null || op.decisionId !== null : op.revokes !== null || op.decisionId === null) bad('campos de ação incoerentes');
    if (op.affectsPrior !== (op.action === 'REVOKE' || op.supersedes !== null)) bad('affectsPrior incoerente');
    if (event === 'INTENT' && (op.intentSeq !== undefined || op.anchorRef || op.observed)) bad('INTENT não fecha nada');
    if ((event === 'CONFIRMED' || event === 'RECEIPT_REISSUED') && (op.intentSeq === undefined || !op.anchorRef || op.observed)) bad(`${event} exige intentSeq e anchorRef`);
    if (event === 'ABORTED' && (op.intentSeq === undefined || op.anchorRef || !op.observed)) bad('ABORTED exige intentSeq e observed');
    if (op.intentSeq !== undefined && op.intentSeq >= record.ledgerSeq) bad('intentSeq deve ser anterior');
    if (op.anchorRef && op.anchorRef.headSha256 !== op.newDecisionsHead.sha256) bad('anchorRef não ancora a entrada da operação');
  });

/**
 * O serviço REAL do livro montado com o esquema congelado: uma cópia nova de `service`/`store`/`model` cujo `./types` é o atual com `ledgerRecordSchema`
 * trocado pela cópia de antes da R1 (cache de módulos isolado e restaurado; o módulo de verdade nunca é alterado).
 */
function preR1LedgerService(): typeof createLedgerService {
  const req = Module.createRequire(__filename);
  const dir = path.resolve(__dirname, '..', 'src', 'lib', 'link-audit-ledger');
  const local = ['types.ts', 'model.ts', 'store.ts', 'guard.ts', 'observed.ts', 'service.ts'].map((name) => req.resolve(path.join(dir, name)));
  const saved = new Map(local.map((file) => [file, req.cache[file]] as const));
  try {
    for (const file of local) delete req.cache[file];
    const typesFile = local[0] as string;
    const current = req(typesFile) as Record<string, unknown>;
    const frozen = new Module(typesFile);
    frozen.filename = typesFile;
    frozen.loaded = true;
    frozen.exports = { ...current, ledgerRecordSchema: PRE_R1_LEDGER_RECORD_SCHEMA, LEDGER_EVENTS: PRE_R1_EVENTS };
    req.cache[typesFile] = frozen;
    return (req(local[5] as string) as { createLedgerService: typeof createLedgerService }).createLedgerService;
  } finally {
    for (const [file, mod] of saved) {
      if (mod) req.cache[file] = mod;
      else delete req.cache[file];
    }
  }
}

async function viewOf(port: LedgerPort, auditId: string): Promise<{ state: string; reason: string | null }> {
  const session = await port.begin(auditId);
  const view = await port.view({ session, auditId, snapshot: { confirmed: [], pending: null }, results: NO_RESULTS, entryOriginProven: () => true, nowIso: '2026-10-21T13:00:00.000Z' });
  return { state: view.state, reason: view.reason };
}

test('RL-36: o leitor ANTERIOR à R1 (cópia congelada do esquema v1) recusa todo RUN_* e o serviço montado com ele lê o livro como UNTRUSTED — falha fechada, nunca "livro válido sem os resultados"', async () => {
  const { chain, intent, confirmed, aborted } = base();
  for (const record of [intent, confirmed, aborted]) {
    assert.ok(accepts(record), `controle: ${record.event} é válido no esquema novo`);
    assert.equal(PRE_R1_LEDGER_RECORD_SCHEMA.safeParse(record).success, false, `${record.event}: a imagem antiga recusa`);
  }
  for (const record of chain.records.slice(0, 3)) assert.ok(PRE_R1_LEDGER_RECORD_SCHEMA.safeParse(record).success, `controle: a imagem antiga lê ${record.event}`);

  const preR1 = preR1LedgerService();
  assert.notEqual(preR1, createLedgerService, 'cópia isolada do serviço');
  const withRuns = chainOf(AUD).genesis().run().records;
  const withoutRuns = chainOf('auditoria-runs-0002').genesis().records;
  const ledgerDir = tmpDir('lad-pre-');
  writeLedger({ ledgerDir, auditId: AUD }, withRuns);
  writeLedger({ ledgerDir, auditId: 'auditoria-runs-0002' }, withoutRuns);
  const options = { dir: ledgerDir, authenticator: LEDGER_AUTH_A, otherDirs: [] };
  assert.deepEqual(await viewOf(preR1(options), AUD), { state: 'HISTORY_UNRESOLVED', reason: 'UNTRUSTED' }, 'imagem antiga + RUN_* ⇒ UNTRUSTED');
  assert.deepEqual(await viewOf(preR1(options), 'auditoria-runs-0002'), { state: 'PROTECTED', reason: null }, 'controle: a imagem antiga ainda lê um livro sem RUN_*');
  assert.deepEqual(await viewOf(createLedgerService(options), AUD), { state: 'PROTECTED', reason: null }, 'controle: a imagem nova lê o livro com RUN_*');
  // o módulo de verdade não foi tocado
  assert.ok(accepts(intent));
});
