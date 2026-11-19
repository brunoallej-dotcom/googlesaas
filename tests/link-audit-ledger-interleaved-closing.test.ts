import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deriveCapacityPolicy, replayLedger, verifyTags, type LedgerDraft, type LedgerRecord } from '../src/lib/link-audit-ledger';
import { serialize } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, anchorPath, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerAuth, ledgerFiles, ledgerFor, ledgerPath, ledgerRecords, ledgerWorld, LEDGER_AUTH_A, LEDGER_AUTH_B, LEDGER_KEY_A, LEDGER_KEY_B, makeRecord, NO_RESULTS, type LedgerServiceOver, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { runChild } from './helpers/link-audit-ledger-results-fixtures';

/*
 * RL-32 — FECHOS INTERCALADOS na família das DECISÕES (spec §16.17.3, "Fechos intercalados"; D-20). Defeito anterior à emenda: o dono de uma decisão entre a INTENT e o
 * fecho tinha o `CONFIRMED` recusado com `LEDGER_UNAVAILABLE` quando outro processo gravava um `CHECKPOINT` naquela posição (R7-03 permite o CHECKPOINT com operação aberta),
 * e a decisão ficava em fase C até o autor reenviar. Regra: no EEXIST do fecho o dono relê, exige etiquetas e replay válidos e (i) regrava o MESMO fecho na nova cauda se a
 * própria operação segue aberta (limitado), (ii) adota o fecho idêntico de outro processo (R6-04) ou (iii) recusa se a operação foi fechada de outro modo.
 *
 * Determinístico: nenhum cenário depende de corrida. O intruso entra num GANCHO do `FsOps` no instante exato (antes do `link` do recibo, para o RECOVER real de outro
 * processo ver a fase B, ou antes do `link` do próprio fecho, plantando registros assinados com a chave de teste, como outro processo com a mesma configuração gravaria).
 */
registerCleanup();
const at = (iso: string) => () => new Date(iso);
const rotatedAuth = (now = '2026-11-03T12:00:00Z') => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at(now) });
const AFTER_OLD_KEY_EXPIRED = '2026-12-20T12:00:00Z';
const kids = async (w: LedgerWorld) => (await ledgerRecords(w)).map((r) => `${r.event}:${r.origin.kid.slice(-1)}`);
const serviceOver = (w: LedgerWorld, over: LedgerServiceOver = {}, decisionsFs?: FsOps) =>
  decisionsOver(w, { ledger: ledgerFor(w, { guard: null, ...over }), knownHeads: NO_RESULTS, ...(decisionsFs ? { fs: decisionsFs } : {}) });
const codeOf = (result: { ok: boolean }): string | null => (result.ok ? null : ((result as unknown as { code: string }).code ?? null));

/** Registros novos encadeados à cauda `chain`, assinados por `auth` (a hora repete a da cauda: o replay só exige que não volte). */
function extend(auth: typeof LEDGER_AUTH_A, w: LedgerWorld, chain: readonly LedgerRecord[], ...drafts: Array<(tail: LedgerRecord, all: readonly LedgerRecord[]) => Record<string, unknown>>): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const draft of drafts) {
    const all = [...chain, ...out];
    const tail = all[all.length - 1] as LedgerRecord;
    out.push(makeRecord(auth, w.auditId, tail, { recordedAt: tail.recordedAt, ...draft(tail, all) } as LedgerDraft));
  }
  return out;
}
const checkpoint = (tail: LedgerRecord) => ({ event: 'CHECKPOINT', actor: 'bia@empresa.com', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
const openIntentOf = (all: readonly LedgerRecord[]): LedgerRecord => [...all].reverse().find((r) => r.event === 'INTENT') as LedgerRecord;

/**
 * `FsOps` do livro do DONO: quando ele vai publicar (`link`) um registro do evento `event`, o gancho planta ANTES, na mesma posição, os registros de `build(cadeia)` — o `link`
 * dele então falha com EEXIST. `times` limita quantas vezes o gancho age (cada colisão conta em `state.collisions`).
 */
function planter(w: LedgerWorld, event: string, build: (chain: readonly LedgerRecord[]) => LedgerRecord[], options: { times?: number; extra?: Partial<FsOps> } = {}) {
  const state = { collisions: 0, mismatch: null as string | null };
  const ops = faulty({
    ...options.extra,
    async link(from, to) {
      const inLedger = path.dirname(to) === path.join(w.ledgerDir, w.auditId);
      if (inLedger && state.collisions < (options.times ?? 1) && (JSON.parse(fs.readFileSync(from, 'utf8')) as LedgerRecord).event === event) {
        const chain = await ledgerRecords(w);
        if (to !== ledgerPath(w, chain.length + 1)) state.mismatch = `o escritor publicaria ${path.basename(to)} com ${chain.length} registros no disco`;
        for (const record of build(chain)) fs.writeFileSync(ledgerPath(w, record.ledgerSeq), serialize(record), { mode: 0o444, flag: 'wx' });
        state.collisions += 1;
      }
      return nodeFsOps.link(from, to);
    },
  });
  return { ops, state };
}

/** `FsOps` das DECISÕES que roda `run` uma vez, imediatamente ANTES de publicar o recibo da entrada 1 (a entrada já existe; o recibo ainda não: fase B para quem ler agora). */
function beforeReceipt(w: LedgerWorld, run: () => Promise<void>): FsOps {
  let fired = false;
  return faulty({
    async link(from, to) {
      if (!fired && to === anchorPath(w, 1)) {
        fired = true;
        await run();
      }
      return nodeFsOps.link(from, to);
    },
  });
}

/** Auditoria inscrita (chave A) com UMA decisão em FASE B gravada antes da rotação: `GENESIS:a`, `INTENT:a`, entrada publicada, recibo ausente. */
async function phaseBBeforeRotation(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  const noReceipts = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(w.anchorDir)) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const pending = await serviceOver(w, {}, noReceipts).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING', JSON.stringify(pending).slice(0, 200));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a']);
  return w;
}

/* ============================================================================ RL-32 — dois processos reais, rotação devida */

test('RL-32: o autor conclui a fase B depois da rotação e, entre a INTENT e o fecho, o RECOVER de OUTRO operador (outro processo) grava o CHECKPOINT da chave nova; o CONFIRMED do autor colide e é regravado na nova cauda — sucesso sem reenvio, um único CONFIRMED, cadeia autêntica e rotação coberta', async () => {
  const w = await phaseBBeforeRotation();
  let recovered: Awaited<ReturnType<typeof runChild>> | null = null;
  const owner = serviceOver(w, { auth: rotatedAuth() }, beforeReceipt(w, async () => {
    recovered = await runChild(w, null, { task: 'recover', rotated: true, actor: 'bia@empresa.com' });
  }));
  const done = await owner.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  const rescuer = recovered as Awaited<ReturnType<typeof runChild>> | null;
  assert.equal(rescuer?.line?.ok, true, `o RECOVER de Bia (fase B, rotação devida) conclui: ${JSON.stringify(rescuer?.line)} ${rescuer?.stderr.slice(0, 200)}`);
  assert.ok(done.ok, `o autor recebe SUCESSO sem reenviar: ${JSON.stringify(done).slice(0, 260)}`);
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CHECKPOINT:b', 'CONFIRMED:b'], 'o CHECKPOINT ficou entre a INTENT e o fecho; o fecho foi regravado DEPOIS dele');
  const records = await ledgerRecords(w);
  assert.equal(records.filter((r) => r.event === 'CONFIRMED').length, 1, 'exatamente um CONFIRMED');
  const closing = records[3] as LedgerRecord;
  assert.deepEqual([closing.op?.intentSeq, closing.op?.opId, closing.prevSha256, closing.actor], [2, records[1]?.op?.opId, records[2]?.contentSha256, 'ana@empresa.com'], 'o MESMO fecho (mesma operação e INTENT), só a posição mudou');
  assert.ok(replayLedger(records, w.auditId).ok, 'replay válido');
  assert.equal(verifyTags(records, rotatedAuth()), null, 'etiquetas válidas');
  assert.equal(verifyTags(records, rotatedAuth(AFTER_OLD_KEY_EXPIRED)), null, 'coberto pelo CHECKPOINT depois do vencimento da chave antiga');
  const end = await must(serviceOver(w, { auth: rotatedAuth(AFTER_OLD_KEY_EXPIRED) }).list(BIA, w.auditId, clock()));
  assert.deepEqual([end.ledger.state, end.ledger.keyCoverage?.covered, end.ledger.openOperation, end.decisions.length, end.finalizable], ['PROTECTED', true, null, 1, true]);
});

test('RL-32 (limite): o dono que ainda assina com a chave ANTIGA não verifica o CHECKPOINT da chave nova na releitura e recusa sem gravar (nunca regrava sobre o que não autentica); o autor conclui depois pelo processo já rotacionado', async () => {
  const w = await ledgerWorld();
  let recovered: Awaited<ReturnType<typeof runChild>> | null = null;
  const owner = serviceOver(w, {}, beforeReceipt(w, async () => {
    recovered = await runChild(w, null, { task: 'recover', rotated: true, actor: 'bia@empresa.com' });
  }));
  const refused = await owner.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.equal((recovered as Awaited<ReturnType<typeof runChild>> | null)?.line?.ok, true);
  assert.equal(codeOf(refused), 'LEDGER_UNAVAILABLE', JSON.stringify(refused).slice(0, 200));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CHECKPOINT:b'], 'nada gravado pelo dono de chave antiga (uma etiqueta da chave A depois da B violaria a época de chave)');
  const concluded = await serviceOver(w, { auth: rotatedAuth() }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(concluded.ok, JSON.stringify(concluded).slice(0, 200));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CHECKPOINT:b', 'CONFIRMED:b']);
});

/* ============================================================================ casos (ii) e (iii) */

test('caso (ii): depois do CHECKPOINT intercalado, OUTRO processo do mesmo autor já gravou o CONFIRMED idêntico; o dono adota (R6-04), sincroniza o livro e devolve sucesso sem duplicar', async () => {
  const w = await ledgerWorld();
  const sameClosing = (_tail: LedgerRecord, all: readonly LedgerRecord[]) => {
    const intent = openIntentOf(all);
    return { event: 'CONFIRMED', actor: 'ana@empresa.com', op: { ...intent.op, intentSeq: intent.ledgerSeq, anchorRef: { name: 'a0001.json', headSha256: intent.op?.newDecisionsHead.sha256 } } };
  };
  const synced: string[] = [];
  const hook = planter(w, 'CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, checkpoint, sameClosing), {
    extra: {
      async syncDirectory(dir) {
        await nodeFsOps.syncDirectory(dir);
        if (fs.existsSync(ledgerPath(w, 4))) synced.push(dir);
      },
    },
  });
  const done = await serviceOver(w, { fs: hook.ops }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.equal(hook.state.mismatch, null);
  assert.ok(done.ok, JSON.stringify(done).slice(0, 220));
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), ['GENESIS', 'INTENT', 'CHECKPOINT', 'CONFIRMED'], 'nenhum CONFIRMED duplicado');
  assert.ok(synced.includes(path.join(w.ledgerDir, w.auditId)), `R7-04: o livro adotado foi sincronizado antes do sucesso: ${JSON.stringify(synced)}`);
});

test('caso (iii): a operação do dono foi ABORTADA por outro processo antes do fecho; o dono recusa com LEDGER_UNAVAILABLE e não grava nada (a auditoria falha fechada em PUBLISHED_AFTER_ABORT)', async () => {
  const w = await ledgerWorld();
  const aborted = (_tail: LedgerRecord, all: readonly LedgerRecord[]) => {
    const intent = openIntentOf(all);
    return { event: 'ABORTED', actor: 'bia@empresa.com', op: { ...intent.op, intentSeq: intent.ledgerSeq, observed: { entryPresent: false, receiptPresent: false, ageMs: 130_000 } } };
  };
  const hook = planter(w, 'CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, aborted));
  const refused = await serviceOver(w, { fs: hook.ops }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.equal(hook.state.mismatch, null);
  assert.equal(codeOf(refused), 'LEDGER_UNAVAILABLE', JSON.stringify(refused).slice(0, 200));
  assert.deepEqual(ledgerFiles(w), ['l000001.json', 'l000002.json', 'l000003.json'], 'nada além do ABORTED alheio');
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), ['GENESIS', 'INTENT', 'ABORTED']);
  const view = await must(serviceOver(w).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason], ['HISTORY_UNRESOLVED', 'PUBLISHED_AFTER_ABORT']);
});

/* ============================================================================ releitura não confiável */

test('releitura NÃO confiável: intruso com etiqueta de chave desconhecida ou que quebra o replay ⇒ o dono recusa com LEDGER_UNAVAILABLE e não grava nada', async () => {
  const cases: Array<[string, (w: LedgerWorld, chain: readonly LedgerRecord[]) => LedgerRecord[]]> = [
    ['etiqueta de chave desconhecida', (w, chain) => extend(LEDGER_AUTH_B, w, chain, checkpoint)],
    ['replay inválido (segunda INTENT com operação aberta)', (w, chain) => extend(LEDGER_AUTH_A, w, chain, (_tail, all) => ({ event: 'INTENT', actor: 'bia@empresa.com', op: { ...openIntentOf(all).op, opId: 'f'.repeat(32) } }))],
  ];
  for (const [label, build] of cases) {
    const w = await ledgerWorld();
    const hook = planter(w, 'CONFIRMED', (chain) => build(w, chain));
    const refused = await serviceOver(w, { fs: hook.ops }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
    assert.equal(hook.state.mismatch, null, label);
    assert.equal(codeOf(refused), 'LEDGER_UNAVAILABLE', `${label}: ${JSON.stringify(refused).slice(0, 200)}`);
    assert.deepEqual(ledgerFiles(w), ['l000001.json', 'l000002.json', 'l000003.json'], `${label}: nada gravado depois do intruso`);
  }
});

test('releitura que NÃO estende o que a sessão leu (o intruso some depois do EEXIST, ou a INTENT foi reescrita na mesma posição) ⇒ recusa sem gravar, mesmo com etiquetas e replay válidos', async () => {
  const eventOf = (file: string): string | undefined => (JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerRecord).event;
  /** Gancho no `link` do CONFIRMED do dono: `tamper` mexe no livro e devolve o que fazer DEPOIS do EEXIST (antes da releitura do dono). */
  const atClosing = (w: LedgerWorld, tamper: (chain: LedgerRecord[], to: string) => () => void): FsOps => {
    let done = false;
    return faulty({
      async link(from, to) {
        if (done || path.dirname(to) !== path.join(w.ledgerDir, w.auditId) || eventOf(from) !== 'CONFIRMED') return nodeFsOps.link(from, to);
        done = true;
        const afterCollision = tamper(await ledgerRecords(w), to);
        try {
          return await nodeFsOps.link(from, to);
        } finally {
          afterCollision();
        }
      },
    });
  };
  const write = (w: LedgerWorld, record: LedgerRecord): void => fs.writeFileSync(ledgerPath(w, record.ledgerSeq), serialize(record), { mode: 0o444, flag: 'wx' });
  const cases: Array<[string, (w: LedgerWorld) => FsOps, string[]]> = [
    [
      // o livro "encolheu" entre a colisão e a releitura (o intruso que causou o EEXIST foi removido): a operação parece aberta, mas o histórico lido não confere
      'intruso removido depois do EEXIST',
      (w) => atClosing(w, (chain, to) => {
        write(w, extend(LEDGER_AUTH_A, w, chain, checkpoint)[0] as LedgerRecord);
        return () => fs.unlinkSync(to);
      }),
      ['l000001.json', 'l000002.json'],
    ],
    [
      // outra INTENT (outra operação), válida e assinada, no lugar da do dono, com um CHECKPOINT encadeado a ela
      'INTENT reescrita na mesma posição',
      (w) => atClosing(w, (chain) => {
        const [genesis, intent] = chain as [LedgerRecord, LedgerRecord];
        const forged = makeRecord(LEDGER_AUTH_A, w.auditId, genesis, { event: 'INTENT', recordedAt: intent.recordedAt, actor: intent.actor, op: { ...intent.op, opId: 'e'.repeat(32) } } as LedgerDraft);
        fs.unlinkSync(ledgerPath(w, 2));
        write(w, forged);
        write(w, extend(LEDGER_AUTH_A, w, [genesis, forged], checkpoint)[0] as LedgerRecord);
        return () => undefined;
      }),
      ['l000001.json', 'l000002.json', 'l000003.json'],
    ],
  ];
  for (const [label, hook, files] of cases) {
    const w = await ledgerWorld();
    const refused = await serviceOver(w, { fs: hook(w) }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
    assert.equal(codeOf(refused), 'LEDGER_UNAVAILABLE', `${label}: ${JSON.stringify(refused).slice(0, 200)}`);
    assert.match(JSON.stringify(refused), /histórico lido/, `${label}: recusa por releitura que não confere`);
    assert.deepEqual(ledgerFiles(w), files, `${label}: o dono não gravou nada`);
    assert.ok(!(await ledgerRecords(w)).some((r) => r.event === 'CONFIRMED'), `${label}: nenhum CONFIRMED`);
  }
});

/* ============================================================================ limite de tentativas */

test('tentativas LIMITADAS: um intruso a cada tentativa ⇒ o dono para depois de 1 publicação + 5 regravações e recusa (nada de fecho); o autor conclui depois pelo reenvio', async () => {
  const w = await ledgerWorld();
  const hook = planter(w, 'CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, checkpoint), { times: 50 });
  const refused = await serviceOver(w, { fs: hook.ops }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.equal(hook.state.mismatch, null);
  assert.equal(codeOf(refused), 'LEDGER_UNAVAILABLE', JSON.stringify(refused).slice(0, 200));
  assert.equal(hook.state.collisions, 6, 'colisões = 1 publicação + WRITE_RETRIES (5) regravações');
  const events = (await ledgerRecords(w)).map((r) => r.event);
  assert.deepEqual(events, ['GENESIS', 'INTENT', ...Array<string>(6).fill('CHECKPOINT')], 'nenhum fecho gravado');
  const concluded = await serviceOver(w).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(concluded.ok, JSON.stringify(concluded).slice(0, 200));
  assert.equal((await ledgerRecords(w)).filter((r) => r.event === 'CONFIRMED').length, 1);
});

/* ============================================================================ capacidade (R7-02) */

test('CAPACIDADE (R7-02): com o livro em MAX − 1 depois dos intrusos o fecho ainda cabe e entra EXATAMENTE em MAX; se intrusos (fora da regra R7-02) ocupam até MAX, o fecho é recusado sem passar do limite', async () => {
  const policy = deriveCapacityPolicy(20, 1, 8);
  for (const fill of [19, 20]) {
    const w = await ledgerWorld({ capacityPolicy: policy, checkpointEvery: 8 });
    const hook = planter(w, 'CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, ...Array(fill - chain.length).fill(checkpoint)));
    const over = { capacityPolicy: policy, checkpointEvery: 8 };
    const result = await serviceOver(w, { ...over, fs: hook.ops }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
    assert.equal(hook.state.mismatch, null, `fill ${fill}`);
    const records = await ledgerRecords(w);
    if (fill === 19) {
      assert.ok(result.ok, `fill 19: o fecho reservado cabe: ${JSON.stringify(result).slice(0, 200)}`);
      assert.deepEqual([records.length, records[19]?.event], [20, 'CONFIRMED'], 'fecho exatamente em MAX');
      const view = await must(serviceOver(w, over).list(BIA, w.auditId, clock()));
      assert.deepEqual([view.ledger.state, view.decisions.length, view.ledger.capacity?.level], ['PROTECTED', 1, 'EXHAUSTED']);
      const decisionId = (view.decisions[0] as { decisionId: string }).decisionId;
      const blocked = await serviceOver(w, over).revoke(ANA, w.auditId, { revokes: decisionId, reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: view.head }, clock);
      assert.equal(codeOf(blocked), 'LEDGER_CAPACITY_EXHAUSTED');
      assert.equal((await ledgerRecords(w)).length, 20, 'nunca passa de MAX');
    } else {
      assert.equal(codeOf(result), 'LEDGER_CAPACITY_EXHAUSTED', `fill 20: ${JSON.stringify(result).slice(0, 200)}`);
      assert.equal(records.length, 20, 'nada além de MAX');
      assert.ok(!records.some((r) => r.event === 'CONFIRMED'));
    }
  }
});

/* ============================================================================ durabilidade */

test('DURABILIDADE: o fecho regravado só é sucesso depois de sincronizar a pasta do livro COM ele presente; se esse fsync falha, nada é dado como sucesso (durabilidade desconhecida) e o livro deixa de ser lido como protegido', async () => {
  const ok = await ledgerWorld();
  const synced: string[] = [];
  const good = planter(ok, 'CONFIRMED', (chain) => extend(LEDGER_AUTH_A, ok, chain, checkpoint), {
    extra: {
      async syncDirectory(dir) {
        await nodeFsOps.syncDirectory(dir);
        if (fs.existsSync(ledgerPath(ok, 4))) synced.push(dir);
      },
    },
  });
  const done = await serviceOver(ok, { fs: good.ops }).create(ANA, ok.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(done.ok, JSON.stringify(done).slice(0, 200));
  assert.equal((await ledgerRecords(ok))[3]?.event, 'CONFIRMED');
  assert.ok(synced.includes(path.join(ok.ledgerDir, ok.auditId)), `a pasta do livro foi sincronizada depois do fecho regravado existir: ${JSON.stringify(synced)}`);

  const bad = await ledgerWorld();
  const broken = planter(bad, 'CONFIRMED', (chain) => extend(LEDGER_AUTH_A, bad, chain, checkpoint), {
    extra: {
      async syncDirectory(dir) {
        if (dir === path.join(bad.ledgerDir, bad.auditId) && fs.existsSync(ledgerPath(bad, 4))) throw errno('EIO');
        await nodeFsOps.syncDirectory(dir);
      },
    },
  });
  const failed = await serviceOver(bad, { fs: broken.ops }).create(ANA, bad.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.equal(codeOf(failed), 'DECISIONS_DURABILITY_UNKNOWN', `fsync falho nunca é sucesso: ${JSON.stringify(failed).slice(0, 200)}`);
  assert.ok(fs.existsSync(ledgerPath(bad, 4)), 'o registro foi publicado; o que falta é a prova de durabilidade');
  const view = await must(serviceOver(bad).list(BIA, bad.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.finalizable], ['HISTORY_UNRESOLVED', 'DURABILITY_UNKNOWN', false]);
});

/* ============================================================================ ABORTED do prepare: por que a regra não se aplica ali */

test('ABORTED da recuperação colide com o CHECKPOINT de outro RECOVER (que viu a fase A ainda recente): o EEXIST vira nova tentativa com RELEITURA e reavaliação completas, e o ABORTED entra na nova cauda — sem regravação cega', async () => {
  const w = await ledgerWorld();
  const noEntry = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(w.decisionsDir) && target.includes('d0001')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const failed = await serviceOver(w, {}, noEntry).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!failed.ok);
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a'], 'fase A: INTENT sem entrada nem recibo');
  const hook = planter(w, 'ABORTED', (chain) => extend(LEDGER_AUTH_B, w, chain, checkpoint));
  const recovered = await serviceOver(w, { auth: rotatedAuth(), staleOperationMs: 0, fs: hook.ops }).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock());
  assert.equal(hook.state.mismatch, null);
  assert.equal(hook.state.collisions, 1);
  assert.ok(recovered.ok, JSON.stringify(recovered).slice(0, 200));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CHECKPOINT:b', 'ABORTED:b']);
  const records = await ledgerRecords(w);
  assert.ok(replayLedger(records, w.auditId).ok);
  assert.equal(verifyTags(records, rotatedAuth(AFTER_OLD_KEY_EXPIRED)), null);
});

test('CONFIRMED da FASE C (gravado no prepare pelo autor) colide com um CHECKPOINT intercalado: o EEXIST vira nova tentativa, o laço relê e reavalia (fase C de novo, mesmas conferências) e o autor conclui na nova cauda — um único CONFIRMED, cadeia autêntica', async () => {
  const w = await ledgerWorld();
  // fase C: entrada e recibo publicados; a publicação do CONFIRMED falha (ENOSPC, não fatal) e o livro fica um registro atrás
  let failedOnce = false;
  const noClosing = faulty({
    async link(from, to) {
      if (!failedOnce && path.dirname(to) === path.join(w.ledgerDir, w.auditId) && (JSON.parse(fs.readFileSync(from, 'utf8')) as LedgerRecord).event === 'CONFIRMED') {
        failedOnce = true;
        throw errno('ENOSPC');
      }
      return nodeFsOps.link(from, to);
    },
  });
  const stuck = await serviceOver(w, { fs: noClosing }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.equal(codeOf(stuck), 'LEDGER_UNAVAILABLE', JSON.stringify(stuck).slice(0, 200));
  assert.ok(fs.existsSync(anchorPath(w, 1)), 'o recibo existe');
  assert.deepEqual((await must(serviceOver(w).list(BIA, w.auditId, clock()))).ledger.openOperation?.phase, 'C');
  // o autor reenvia; no instante do CONFIRMED da fase C entra um CHECKPOINT (outro processo, mesma chave) na mesma posição
  const hook = planter(w, 'CONFIRMED', (chain) => extend(LEDGER_AUTH_A, w, chain, checkpoint));
  const concluded = await serviceOver(w, { fs: hook.ops }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.equal(hook.state.mismatch, null);
  assert.equal(hook.state.collisions, 1);
  assert.ok(concluded.ok, `o autor conclui: ${JSON.stringify(concluded).slice(0, 200)}`);
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((r) => r.event), ['GENESIS', 'INTENT', 'CHECKPOINT', 'CONFIRMED']);
  assert.deepEqual([records[3]?.actor, records[3]?.op?.intentSeq, records[3]?.prevSha256], ['ana@empresa.com', 2, records[2]?.contentSha256]);
  assert.ok(replayLedger(records, w.auditId).ok);
  assert.equal(verifyTags(records, LEDGER_AUTH_A), null);
  const end = await must(serviceOver(w).list(BIA, w.auditId, clock()));
  assert.deepEqual([end.ledger.state, end.ledger.openOperation, end.decisions.length], ['PROTECTED', null, 1]);
});
