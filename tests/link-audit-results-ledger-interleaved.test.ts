import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deriveCapacityPolicy, replayLedger, verifyTags, type LedgerRecord } from '../src/lib/link-audit-ledger';
import type { OriginAuthenticator } from '../src/lib/link-audit-origin';
import { clearStorageFatal, serialize } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { BIA, clock, must, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno } from './helpers/link-audit-evidence-fixtures';
import { ledgerAuth, ledgerFiles, ledgerFor, ledgerPath, ledgerRecords, LEDGER_AUTH_A, LEDGER_AUTH_B, LEDGER_KEY_A, LEDGER_KEY_B, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild, servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { OP_A } from './helpers/link-audit-results-fixtures';
import { closingRunBody, nextRunBody, openRunOf, signRecord } from './helpers/link-audit-results-ledger-fixtures';
import { bodyNow, finalizeAs, finalizerOver, openRunWorld, protectedWorld, publishedRunFiles, runsOf } from './helpers/link-audit-results-ledger-finalize-fixtures';

/*
 * R1.4 — FECHOS INTERCALADOS da família `RUN_*` (spec §16.17.3, "Fechos intercalados"; D-20; RL-32 nos dois sentidos; M-R31 e M-R18). As duas famílias podem ter operação aberta
 * ao mesmo tempo (D-8): o fecho de uma pode achar a posição ocupada por registro da outra (ou por um CHECKPOINT). No EEXIST de um fecho `RUN_CONFIRMED`/`RUN_ABORTED`, o escritor
 * relê o livro, exige etiquetas, replay e que a releitura ESTENDA o que leu, e então: (i) a própria operação continua aberta ⇒ regrava o MESMO fecho na nova cauda (só posição,
 * encadeamento, hora, etiqueta e hash mudam), até 5 vezes, cada gravação dentro do teto duro de capacidade; (ii) foi fechada por um `RUN_CONFIRMED` idêntico GRAVADO PELO AUTOR
 * (R6-04: `runOpId`, `intentSeq`, `runSha256`/âncora) ⇒ sincroniza o livro e devolve sucesso; (iii) qualquer outra coisa ⇒ recusa, nada gravado. Vale também o sentido inverso: o
 * `CONFIRMED` de decisão colidindo com um `RUN_*` (regra das decisões, `reconcileClosing`).
 * Determinístico: o intruso entra num GANCHO do `FsOps` no instante exato (o `link()` do fecho do dono); os cenários "ambos 200" usam os serviços reais das duas famílias.
 */
registerCleanup();
test.afterEach(() => clearStorageFatal());

const show = (value: unknown): string => JSON.stringify(value).slice(0, 320);
const BASE = ['GENESIS', 'INTENT', 'CONFIRMED'];
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
const eventsOf = async (w: LedgerWorld): Promise<string[]> => (await ledgerRecords(w)).map((record) => record.event);
const codeOf = (result: { ok: boolean }): string | null => (result.ok ? null : ((result as unknown as { code: string }).code ?? null));
const eventOfFile = (file: string): string => (JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerRecord).event;
const inLedger = (w: LedgerWorld, to: string): boolean => path.dirname(to) === path.join(w.ledgerDir, w.auditId);

type Draft = (tail: LedgerRecord, all: readonly LedgerRecord[]) => Record<string, unknown>;
/** Registros novos encadeados à cauda, assinados por `auth` (hora = a da cauda: o replay só exige que não volte). */
function extend(auth: OriginAuthenticator, w: LedgerWorld, chain: readonly LedgerRecord[], ...drafts: Draft[]): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const draft of drafts) {
    const all = [...chain, ...out];
    const tail = all[all.length - 1] as LedgerRecord;
    out.push(signRecord(auth, w.auditId, tail, { recordedAt: tail.recordedAt, ...draft(tail, all) }));
  }
  return out;
}
const checkpoint: Draft = (tail) => ({ event: 'CHECKPOINT', actor: 'bia@empresa.com', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
const runClosing = (event: 'RUN_CONFIRMED' | 'RUN_ABORTED', actor: string, over: Record<string, unknown> = {}): Draft => (_tail, all) => {
  const intent = openRunOf(all) as LedgerRecord;
  return { event, actor, run: closingRunBody(intent, event, over) };
};

/**
 * `FsOps` do livro do DONO: quando ele vai publicar (`link`) um registro do evento `event`, o gancho planta ANTES, na posição dele, os registros de `build(cadeia)` — o `link` dele
 * então falha com EEXIST. `times` limita quantas vezes o gancho age.
 */
function planter(w: LedgerWorld, event: string, build: (chain: readonly LedgerRecord[]) => LedgerRecord[], options: { times?: number; extra?: Partial<FsOps> } = {}) {
  const state = { collisions: 0, mismatch: null as string | null };
  const ops: FsOps = {
    ...nodeFsOps,
    ...options.extra,
    async link(from, to) {
      if (inLedger(w, to) && state.collisions < (options.times ?? 1) && eventOfFile(from) === event) {
        const chain = await ledgerRecords(w);
        if (to !== ledgerPath(w, chain.length + 1)) state.mismatch = `o escritor publicaria ${path.basename(to)} com ${chain.length} registros no disco`;
        for (const record of build(chain)) fs.writeFileSync(ledgerPath(w, record.ledgerSeq), serialize(record), { mode: 0o444, flag: 'wx' });
        state.collisions += 1;
      }
      return nodeFsOps.link(from, to);
    },
  };
  return { ops, state };
}

/** O fecho final é o RUN_CONFIRMED do autor, casando com o RUN_INTENT, e o livro inteiro é autêntico. */
async function assertAuthentic(w: LedgerWorld, auth: OriginAuthenticator = LEDGER_AUTH_A): Promise<LedgerRecord[]> {
  const records = await ledgerRecords(w);
  assert.ok(replayLedger(records, w.auditId).ok, 'replay válido');
  assert.equal(verifyTags(records, auth), null, 'etiquetas válidas');
  return records;
}

/* ============================================================================ RL-32 [novo]: as duas famílias, serviços reais, ambos 200 sem reenvio */

test('RL-32 (RUN_* × decisão): RUN_INTENT de Ana aberto, INTENT de revogação de Bia, RUN_CONFIRMED de Ana; o CONFIRMED de Bia recebe EEXIST e é regravado na nova cauda ⇒ AMBOS 200 sem reenvio, livro autêntico', async () => {
  const { w, e } = await protectedWorld();
  const decisionId = ((await must(servicesOver(w, e).list(BIA, w.auditId, clock()))).decisions[0] as { decisionId: string }).decisionId;
  let biaAtClosing!: () => void;
  const biaReady = new Promise<void>((resolve) => (biaAtClosing = resolve));
  let anaClosed!: () => void;
  const anaDone = new Promise<void>((resolve) => (anaClosed = resolve));
  // Bia: no link() do CONFIRMED dela, espera o RUN_CONFIRMED de Ana entrar na MESMA posição
  const biaLedgerFs: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (inLedger(w, to) && eventOfFile(from) === 'CONFIRMED') {
        biaAtClosing();
        await anaDone;
      }
      return nodeFsOps.link(from, to);
    },
  };
  let revoked: Promise<unknown> | null = null;
  // Ana: no passo 10 (recibo durável), Bia começa a revogação; Ana segue quando Bia está no fecho
  const anaResultsFs: FsOps = {
    ...nodeFsOps,
    async syncDirectory(dir) {
      await nodeFsOps.syncDirectory(dir);
      if (revoked === null && dir === path.join(e.anchors, w.auditId) && fs.existsSync(path.join(dir, 'a0001.json'))) {
        const bia = servicesOver(w, e, { ledger: ledgerFor(w, { guard: null, fs: biaLedgerFs }) });
        revoked = bia.revoke(BIA, w.auditId, { revokes: decisionId, reason: REASON, expectedHead: (await must(bia.list(BIA, w.auditId, clock()))).head }, clock());
        await Promise.race([biaReady, revoked]);
      }
    },
  };
  const anaLedgerFs: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      await nodeFsOps.link(from, to);
      if (inLedger(w, to) && eventOfFile(from) === 'RUN_CONFIRMED') anaClosed();
    },
  };
  const done = await finalizeAs(finalizerOver(w, e, { resultsFs: anaResultsFs, ledger: { fs: anaLedgerFs } }), OP_A, w.auditId);
  assert.ok(done.ok, `Ana: ${show(done)}`);
  const biaResult = (await (revoked as Promise<unknown> | null)) as { ok: boolean };
  assert.ok(biaResult.ok, `Bia: ${show(biaResult)}`);
  const records = await assertAuthentic(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'INTENT', 'RUN_CONFIRMED', 'CONFIRMED'], 'o CONFIRMED de Bia foi regravado DEPOIS do RUN_CONFIRMED de Ana');
  assert.deepEqual([records[6]?.op?.intentSeq, records[6]?.actor, records[6]?.prevSha256], [5, 'bia@empresa.com', records[5]?.contentSha256]);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.openOperation, view.ledger.runs?.open, view.ledger.runs?.confirmed.length], ['PROTECTED', null, null, 1]);
});

test('RL-32 (simétrico, decisão × RUN_*): entre a releitura e o link() do RUN_CONFIRMED de Ana, a revogação inteira de Bia entra (INTENT + CONFIRMED); o RUN_CONFIRMED recebe EEXIST e é regravado na nova cauda ⇒ AMBOS 200 sem reenvio', async () => {
  const { w, e } = await protectedWorld();
  const decisionId = ((await must(servicesOver(w, e).list(BIA, w.auditId, clock()))).decisions[0] as { decisionId: string }).decisionId;
  let biaResult: { ok: boolean } | null = null;
  const anaLedgerFs: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (biaResult === null && inLedger(w, to) && eventOfFile(from) === 'RUN_CONFIRMED') {
        const bia = servicesOver(w, e);
        biaResult = (await bia.revoke(BIA, w.auditId, { revokes: decisionId, reason: REASON, expectedHead: (await must(bia.list(BIA, w.auditId, clock()))).head }, clock())) as { ok: boolean };
      }
      return nodeFsOps.link(from, to);
    },
  };
  const done = await finalizeAs(finalizerOver(w, e, { ledger: { fs: anaLedgerFs } }), OP_A, w.auditId);
  assert.ok((biaResult as { ok: boolean } | null)?.ok, `Bia: ${show(biaResult)}`);
  assert.ok(done.ok, `Ana: ${show(done)}`);
  const records = await assertAuthentic(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'INTENT', 'CONFIRMED', 'RUN_CONFIRMED'], 'o RUN_CONFIRMED foi regravado depois da revogação');
  assert.deepEqual([records[6]?.actor, records[6]?.run?.intentSeq, records[6]?.prevSha256], ['ana@empresa.com', 4, records[5]?.contentSha256], 'o MESMO fecho, só a posição mudou');
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open, view.ledger.runs?.confirmed.length, view.head?.seq, view.decisions.length], ['PROTECTED', null, 1, 2, 0], 'a revogação de Bia valeu (nenhuma decisão vigente; cabeça na entrada 2)');
});

const at = (iso: string) => () => new Date(iso);
const rotatedAuth = (now = '2026-11-03T12:00:00Z') => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at(now) });
const AFTER_OLD_KEY_EXPIRED = '2026-12-20T12:00:00Z';

test('RL-32 / RL-30 (processo real, rotação devida): no link() do RUN_CONFIRMED de Ana, o RECOVER de OUTRO operador (outro processo) grava o CHECKPOINT da chave nova na posição; o fecho é regravado depois dele — sucesso sem reenvio, rotação coberta', async () => {
  const { w, e } = await protectedWorld();
  let recovered: Awaited<ReturnType<typeof runChild>> | null = null;
  const anaLedgerFs: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (recovered === null && inLedger(w, to) && eventOfFile(from) === 'RUN_CONFIRMED') recovered = await runChild(w, e, { task: 'recover', rotated: true, actor: 'bia@empresa.com' });
      return nodeFsOps.link(from, to);
    },
  };
  const done = await finalizeAs(finalizerOver(w, e, { ledger: { auth: rotatedAuth(), fs: anaLedgerFs } }), OP_A, w.auditId);
  const rescuer = recovered as Awaited<ReturnType<typeof runChild>> | null;
  assert.equal(rescuer?.line?.ok, true, `o RECOVER de Bia grava o CHECKPOINT: ${show(rescuer?.line)} ${rescuer?.stderr.slice(0, 200)}`);
  assert.ok(done.ok, `Ana: ${show(done)}`);
  const records = await assertAuthentic(w, rotatedAuth());
  assert.deepEqual(records.map((r) => `${r.event}:${r.origin.kid.slice(-1)}`), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'RUN_INTENT:b', 'CHECKPOINT:b', 'RUN_CONFIRMED:b']);
  assert.equal(verifyTags(records, rotatedAuth(AFTER_OLD_KEY_EXPIRED)), null, 'coberto pelo CHECKPOINT depois do vencimento da chave antiga');
});

/* ============================================================================ caso (i): regravação na nova cauda (M-R31) */

test('caso (i) / M-R31: um CHECKPOINT entra na posição do RUN_CONFIRMED do dono ⇒ o MESMO fecho é regravado na nova cauda (mesma operação e RUN_INTENT; só posição, encadeamento, hora, etiqueta e hash mudam); 200', async () => {
  const { w, e } = await protectedWorld();
  const hook = planter(w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, checkpoint));
  const done = await finalizeAs(finalizerOver(w, e, { ledger: { fs: hook.ops } }), OP_A, w.auditId);
  assert.equal(hook.state.mismatch, null);
  assert.equal(hook.state.collisions, 1);
  assert.ok(done.ok, show(done));
  const records = await assertAuthentic(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'CHECKPOINT', 'RUN_CONFIRMED']);
  const intent = records[3] as LedgerRecord;
  const closing = records[5] as LedgerRecord;
  assert.deepEqual([closing.actor, closing.run?.runOpId, closing.run?.intentSeq, closing.run?.runSha256, closing.prevSha256], ['ana@empresa.com', intent.run?.runOpId, 4, intent.run?.runSha256, records[4]?.contentSha256]);
});

test('caso (i) na CONCLUSÃO da fase C pelo autor: o RUN_CONFIRMED da conclusão também é regravado depois de um intruso; 200 recoveredPending', async () => {
  const { w, e, body } = await openRunWorld('C');
  const hook = planter(w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, checkpoint));
  const done = await finalizerOver(w, e, { ledger: { fs: hook.ops } }).results.finalize(OP_A, w.auditId, body);
  assert.equal(hook.state.collisions, 1);
  assert.ok(done.ok && done.value.recoveredPending, show(done));
  assert.deepEqual((await assertAuthentic(w)).map((r) => r.event), [...BASE, 'RUN_INTENT', 'CHECKPOINT', 'RUN_CONFIRMED']);
});

test('caso (i) / M-R31: o RUN_ABORTED do PRÓPRIO dono (prazo do passo 7 vencido) colide com um CHECKPOINT ⇒ é regravado na nova cauda (a operação fecha); a resposta continua RESULT_WRITE_CONFLICT e nada é publicado', async () => {
  const { w, e } = await protectedWorld();
  let now = 10_000;
  let collisions = 0;
  const ops: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (collisions === 0 && inLedger(w, to) && eventOfFile(from) === 'RUN_ABORTED') {
        for (const record of extend(LEDGER_AUTH_A, w, await ledgerRecords(w), checkpoint)) fs.writeFileSync(ledgerPath(w, record.ledgerSeq), serialize(record), { mode: 0o444, flag: 'wx' });
        collisions += 1;
      }
      await nodeFsOps.link(from, to);
      // o RUN_INTENT entrou: o relógio monotônico do dono passa do prazo (staleOperationMs / 2) antes da publicação do resultado
      if (to === ledgerPath(w, 4)) now += 60_001;
    },
  };
  const f = finalizerOver(w, e, { ledger: { staleOperationMs: 120_000, monotonicMs: () => now, fs: ops } });
  const done = await finalizeAs(f, OP_A, w.auditId);
  assert.equal(codeOf(done), 'RESULT_WRITE_CONFLICT', show(done));
  assert.equal(collisions, 1);
  const records = await assertAuthentic(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'CHECKPOINT', 'RUN_ABORTED'], 'o próprio RUN_ABORTED foi regravado (antes da R1.4 a fase A ficava aberta até vencer)');
  assert.deepEqual([records[5]?.actor, records[5]?.run?.intentSeq, records[5]?.run?.observed], ['ana@empresa.com', 4, { resultPresent: false, receiptPresent: false, ageMs: 60_001 }]);
  assert.deepEqual(publishedRunFiles(e), [], 'nada publicado');
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open], ['PROTECTED', null], 'a operação fechou');
});

/* ============================================================================ caso (ii): adoção do fecho idêntico do autor (M-R18) */

test('caso (ii) / M-R18: depois de um CHECKPOINT intercalado, OUTRO processo do mesmo autor já gravou o RUN_CONFIRMED idêntico; o dono adota, sincroniza o livro e devolve sucesso sem duplicar', async () => {
  const { w, e } = await protectedWorld();
  const synced: string[] = [];
  const hook = planter(w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, checkpoint, runClosing('RUN_CONFIRMED', 'ana@empresa.com')), {
    extra: {
      async syncDirectory(dir) {
        await nodeFsOps.syncDirectory(dir);
        if (fs.existsSync(ledgerPath(w, 6))) synced.push(dir);
      },
    },
  });
  const done = await finalizeAs(finalizerOver(w, e, { ledger: { fs: hook.ops } }), OP_A, w.auditId);
  assert.equal(hook.state.mismatch, null);
  assert.ok(done.ok, show(done));
  assert.deepEqual((await assertAuthentic(w)).map((r) => r.event), [...BASE, 'RUN_INTENT', 'CHECKPOINT', 'RUN_CONFIRMED'], 'nenhum RUN_CONFIRMED duplicado');
  assert.ok(synced.includes(path.join(w.ledgerDir, w.auditId)), `R7-04: o livro adotado foi sincronizado antes do sucesso: ${show(synced)}`);
});

const NOT_ADOPTED: ReadonlyArray<readonly [string, Draft]> = [
  ['RUN_CONFIRMED gravado por QUEM NÃO É O AUTOR (D-R1-1)', runClosing('RUN_CONFIRMED', 'bia@empresa.com')],
  ['RUN_CONFIRMED com OUTRO resultado na âncora (I-5)', runClosing('RUN_CONFIRMED', 'ana@empresa.com', { runSha256: 'f'.repeat(64), anchorRef: { name: 'a0001.json', headSha256: 'f'.repeat(64) } })],
  ['RUN_CONFIRMED de OUTRA operação (runOpId, I-5)', runClosing('RUN_CONFIRMED', 'ana@empresa.com', { runOpId: 'c'.repeat(32) })],
];
for (const [label, draft] of NOT_ADOPTED) {
  test(`caso (ii) negado / M-R18: ${label}, com etiqueta autêntica, na posição do fecho ⇒ não é adotado (o replay já o recusa) e o dono recusa sem gravar nada`, async () => {
    const { w, e } = await protectedWorld();
    const hook = planter(w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, draft));
    const refused = await finalizeAs(finalizerOver(w, e, { ledger: { fs: hook.ops } }), OP_A, w.auditId);
    assert.equal(hook.state.mismatch, null);
    assert.equal(codeOf(refused), 'RESULT_ANCHOR_PENDING', show(refused));
    const records = await ledgerRecords(w);
    assert.equal(verifyTags(records, LEDGER_AUTH_A), null, 'controle: a etiqueta do intruso é autêntica');
    assert.equal(replayLedger(records, w.auditId).ok, false, 'o replay recusa o fecho intruso');
    assert.deepEqual(ledgerFiles(w), ['l000001.json', 'l000002.json', 'l000003.json', 'l000004.json', 'l000005.json'], 'o dono não gravou nada depois do intruso');
  });
}

/* ============================================================================ caso (iii), releitura não confiável, limites */

test('caso (iii): a operação do dono foi ABORTADA por outro processo antes do fecho ⇒ o dono recusa (RESULT_INTEGRITY, sem prometer conclusão por reenvio) e nunca grava RUN_CONFIRMED depois do RUN_ABORTED', async () => {
  const { w, e } = await protectedWorld();
  const hook = planter(w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, runClosing('RUN_ABORTED', 'bia@empresa.com')));
  const refused = await finalizeAs(finalizerOver(w, e, { ledger: { fs: hook.ops } }), OP_A, w.auditId);
  assert.equal(hook.state.mismatch, null);
  // revisão da R1.4 (junin-02): RESULT_ANCHOR_PENDING diria "só o autor, reenviando o MESMO pedido, o conclui" — falso depois de um RUN_ABORTED (o resultado publicado depois do
  // encerramento é a contradição RESULT_PUBLISHED_AFTER_ABORT, sem receita); a recusa diz que o reenvio NÃO conclui
  assert.equal(codeOf(refused), 'RESULT_INTEGRITY', show(refused));
  const issues = (refused as unknown as { issues: readonly string[] }).issues;
  assert.ok(issues.some((issue) => /encerrada por outro processo antes da confirmação/.test(issue) && /NÃO pode ser concluído por reenvio/.test(issue)), show(refused));
  const records = await assertAuthentic(w);
  assert.deepEqual(records.map((r) => r.event), [...BASE, 'RUN_INTENT', 'RUN_ABORTED'], 'nada além do RUN_ABORTED alheio');
});

test('releitura NÃO confiável: intruso com etiqueta de chave desconhecida, ou que quebra o replay (RUN_INTENT com operação aberta, I-1) ⇒ o dono recusa sem gravar', async () => {
  const cases: Array<[string, (w: LedgerWorld, chain: readonly LedgerRecord[]) => LedgerRecord[]]> = [
    ['etiqueta de chave desconhecida', (w, chain) => extend(LEDGER_AUTH_B, w, chain, checkpoint)],
    ['replay inválido (RUN_INTENT com operação aberta)', (w, chain) => extend(LEDGER_AUTH_A, w, chain, (_tail, all) => ({ event: 'RUN_INTENT', actor: 'bia@empresa.com', run: nextRunBody(all, { author: 'bia@empresa.com' }) }))],
  ];
  for (const [label, build] of cases) {
    const { w, e } = await protectedWorld();
    const hook = planter(w, 'RUN_CONFIRMED', (chain) => build(w, chain));
    const refused = await finalizeAs(finalizerOver(w, e, { ledger: { fs: hook.ops } }), OP_A, w.auditId);
    assert.equal(codeOf(refused), 'RESULT_ANCHOR_PENDING', `${label}: ${show(refused)}`);
    assert.deepEqual(ledgerFiles(w), ['l000001.json', 'l000002.json', 'l000003.json', 'l000004.json', 'l000005.json'], `${label}: nada gravado depois do intruso`);
  }
});

test('releitura que NÃO estende o que a sessão leu (o intruso some depois do EEXIST) ⇒ recusa sem gravar, mesmo com etiquetas e replay válidos', async () => {
  const { w, e } = await protectedWorld();
  let done = false;
  const ops: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (done || !inLedger(w, to) || eventOfFile(from) !== 'RUN_CONFIRMED') return nodeFsOps.link(from, to);
      done = true;
      const chain = await ledgerRecords(w);
      const [intruder] = extend(LEDGER_AUTH_A, w, chain, checkpoint);
      fs.writeFileSync(ledgerPath(w, (intruder as LedgerRecord).ledgerSeq), serialize(intruder), { mode: 0o444, flag: 'wx' });
      try {
        return await nodeFsOps.link(from, to);
      } finally {
        fs.unlinkSync(to);
      }
    },
  };
  const refused = await finalizeAs(finalizerOver(w, e, { ledger: { fs: ops } }), OP_A, w.auditId);
  assert.equal(codeOf(refused), 'RESULT_ANCHOR_PENDING', show(refused));
  assert.deepEqual(ledgerFiles(w), ['l000001.json', 'l000002.json', 'l000003.json', 'l000004.json'], 'o dono não gravou nada');
});

test('tentativas LIMITADAS: um intruso a cada tentativa ⇒ o dono para depois de 1 publicação + 5 regravações e recusa (fase C); o autor conclui depois pelo reenvio', async () => {
  const { w, e } = await protectedWorld();
  const hook = planter(w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, checkpoint), { times: 50 });
  const f = finalizerOver(w, e, { ledger: { fs: hook.ops } });
  const body = await bodyNow(f, OP_A, w.auditId);
  const refused = await f.results.finalize(OP_A, w.auditId, body);
  assert.equal(codeOf(refused), 'RESULT_ANCHOR_PENDING', show(refused));
  assert.equal(hook.state.collisions, 6, 'colisões = 1 publicação + WRITE_RETRIES (5) regravações');
  assert.deepEqual(await eventsOf(w), [...BASE, 'RUN_INTENT', ...Array<string>(6).fill('CHECKPOINT')], 'nenhum fecho gravado');
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.equal(view.ledger.runs?.open?.phase, 'C');
  const concluded = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
  assert.ok(concluded.ok && concluded.value.recoveredPending, show(concluded));
  assert.equal((await assertAuthentic(w)).filter((r) => r.event === 'RUN_CONFIRMED').length, 1);
});

test('CAPACIDADE (R7-02): com o livro em MAX − 1 depois dos intrusos o fecho reservado ainda cabe e entra EXATAMENTE em MAX; se intrusos (fora da regra) ocupam até MAX, o fecho é recusado sem passar do limite', async () => {
  const policy = deriveCapacityPolicy(20, 1, 8);
  for (const fill of [19, 20]) {
    const { w, e } = await protectedWorld({ capacityPolicy: policy, checkpointEvery: 8 });
    const hook = planter(w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, ...Array<Draft>(fill - chain.length).fill(checkpoint)));
    const done = await finalizeAs(finalizerOver(w, e, { ledger: { capacityPolicy: policy, checkpointEvery: 8, fs: hook.ops } }), OP_A, w.auditId);
    assert.equal(hook.state.mismatch, null, `fill ${fill}`);
    const records = await ledgerRecords(w);
    if (fill === 19) {
      assert.ok(done.ok, `fill 19: o fecho reservado cabe: ${show(done)}`);
      assert.deepEqual([records.length, records[19]?.event], [20, 'RUN_CONFIRMED'], 'fecho exatamente em MAX');
    } else {
      assert.equal(codeOf(done), 'RESULT_ANCHOR_PENDING', `fill 20: ${show(done)}`);
      assert.equal(records.length, 20, 'nada além de MAX');
      assert.ok(!records.some((r) => r.event === 'RUN_CONFIRMED'));
    }
  }
});

test('DURABILIDADE: o fecho regravado só é sucesso com a pasta do livro sincronizada COM ele; se esse fsync falha ⇒ RESULT_DURABILITY_UNKNOWN (nunca sucesso)', async () => {
  const ok = await protectedWorld();
  const synced: string[] = [];
  const good = planter(ok.w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, ok.w, chain, checkpoint), {
    extra: {
      async syncDirectory(dir) {
        await nodeFsOps.syncDirectory(dir);
        if (fs.existsSync(ledgerPath(ok.w, 6))) synced.push(dir);
      },
    },
  });
  const done = await finalizeAs(finalizerOver(ok.w, ok.e, { ledger: { fs: good.ops } }), OP_A, ok.w.auditId);
  assert.ok(done.ok, show(done));
  assert.ok(synced.includes(path.join(ok.w.ledgerDir, ok.w.auditId)), show(synced));

  const bad = await protectedWorld();
  const broken = planter(bad.w, 'RUN_CONFIRMED', (chain) => extend(LEDGER_AUTH_A, bad.w, chain, checkpoint), {
    extra: {
      async syncDirectory(dir) {
        if (dir === path.join(bad.w.ledgerDir, bad.w.auditId) && fs.existsSync(ledgerPath(bad.w, 6))) throw errno('EIO');
        await nodeFsOps.syncDirectory(dir);
      },
    },
  });
  const failed = await finalizeAs(finalizerOver(bad.w, bad.e, { ledger: { fs: broken.ops } }), OP_A, bad.w.auditId);
  assert.equal(codeOf(failed), 'RESULT_DURABILITY_UNKNOWN', show(failed));
  assert.ok(fs.existsSync(ledgerPath(bad.w, 6)), 'o registro foi publicado; falta a prova de durabilidade');
  const { all } = await runsOf(bad.e, bad.w.auditId);
  assert.equal(all.length, 1);
});

