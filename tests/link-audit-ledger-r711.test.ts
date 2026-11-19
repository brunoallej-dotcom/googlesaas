import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { LedgerPort } from '../src/lib/link-audit-decisions';
import { keyEpochViolation, publishLedgerRecord, readLedgerFiles, replayLedger, verifyTags, type LedgerRecord } from '../src/lib/link-audit-ledger';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, clock, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, LEDGER_AUTH_A, LEDGER_AUTH_B, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, makeRecord, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * R7-11 — QUALIDADE DOS TESTES. O relatório nº 7 (recuperado em 05/11/2026) listou mutantes que SOBREVIVIAM aos testes do repositório: MA1, MB2, MA12, MA13, MA15, MA16. Cada teste abaixo é COMPORTAMENTAL
 * (falha injetada, reinício, processo concorrente simulado) e foi confirmado por mutação do `src/` (ver o relatório de remediação): sem a proteção correspondente ele reprova pelo motivo certo.
 * MA16 é EQUIVALENTE por construção (demonstrada abaixo) e MA13 NÃO é equivalente (só aparece com falha INTERMITENTE de fsync).
 */
registerCleanup();
const fakeRecords = (kids: string[]): LedgerRecord[] => kids.map((kid, index) => ({ ledgerSeq: index + 1, event: 'CHECKPOINT', origin: { kid } }) as unknown as LedgerRecord);

/* ----------------------------------------------------------------------------- MA1 — época de chave no meio da cadeia */
test('MA1: a época de chave vale NO MEIO da cadeia — A,B,A,B com B atual e A,B,A com C atual são NÃO resolvidas; A,A,B,B e A,B,C seguem íntegras (controles)', () => {
  assert.deepEqual(keyEpochViolation(fakeRecords(['A', 'B', 'A', 'B']), 'B'), { reason: 'UNTRUSTED', seq: 3 }, 'a chave A reaparece depois de B no meio da cadeia, mesmo terminando na chave atual');
  assert.deepEqual(keyEpochViolation(fakeRecords(['A', 'B', 'A']), 'C'), { reason: 'UNTRUSTED', seq: 3 });
  assert.deepEqual(keyEpochViolation(fakeRecords(['A', 'B', 'A']), 'A'), { reason: 'UNTRUSTED', seq: 3 }, 'reversão de configuração (a atual já foi substituída)');
  assert.equal(keyEpochViolation(fakeRecords(['A', 'A', 'B', 'B']), 'B'), null);
  assert.equal(keyEpochViolation(fakeRecords(['A', 'B', 'C']), 'C'), null);
  assert.equal(keyEpochViolation(fakeRecords(['A', 'A', 'A']), 'A'), null);
});

/* ----------------------------------------------------------------------------- MB2 — a base trava depois de falha de durabilidade */
test('MB2: depois de UMA falha de fsync a base trava — mesmo com o disco "saudável" na tentativa seguinte (falha INTERMITENTE) o reenvio NÃO tem sucesso até reiniciar; reiniciado, conclui sem duplicar', async () => {
  let failedOnce = false;
  let auditDir = '';
  const intermittent = faulty({
    async syncDirectory(dir) {
      if (!failedOnce && dir === auditDir && (await ledgerEvents(wRef)).includes('CONFIRMED')) {
        failedOnce = true;
        throw errno('EIO');
      }
      return nodeFsOps.syncDirectory(dir);
    },
  });
  const wRef = await ledgerWorld({ ledgerFs: intermittent });
  auditDir = path.join(wRef.ledgerDir, wRef.auditId);
  const body = { record: rec.c2(), expectedHead: null };
  const first = await wRef.rawProtected.create(ANA, wRef.auditId, body, clock);
  assert.ok(!first.ok && first.code === 'DECISIONS_DURABILITY_UNKNOWN', `1ª: ${JSON.stringify(first).slice(0, 180)}`);
  assert.equal(failedOnce, true, 'a falha foi injetada exatamente no fsync que torna o CONFIRMED durável');
  // o disco "voltou" (a falha era intermitente), mas depois de um erro de fsync não se presume nada
  const second = await wRef.rawProtected.create(ANA, wRef.auditId, body, clock);
  assert.ok(!second.ok && second.code === 'DECISIONS_DURABILITY_UNKNOWN', `2ª SEM reiniciar: continua sem sucesso (${JSON.stringify(second).slice(0, 180)})`);
  clearStorageFatal(); // "reiniciar o servidor"
  const third = await decisionsOver(wRef, { ledger: ledgerFor(wRef, { guard: null }), knownHeads: NO_RESULTS }).create(ANA, wRef.auditId, body, clock);
  assert.ok(third.ok, `depois do reinício o MESMO pedido conclui: ${JSON.stringify(third).slice(0, 180)}`);
  assert.deepEqual(await ledgerEvents(wRef), ['GENESIS', 'INTENT', 'CONFIRMED'], 'sem duplicata');
});

/* ----------------------------------------------------------------------------- MA12 / MA13 / pais — reenvio de PENDENTE */
/** Auditoria com decisão PENDENTE (entrada publicada, recibo não gravado) e o serviço de reenvio sobre um `FsOps` à escolha. */
async function pendingWorld(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  const noReceipts = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(w.anchorDir)) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const pending = await decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS, fs: noReceipts }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING', JSON.stringify(pending).slice(0, 160));
  return w;
}
const resend = (w: LedgerWorld, fs: FsOps) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS, fs }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);

test('reenvio de PENDENTE: nenhuma pasta com durabilidade incerta (recibos, pai dos recibos, pai das decisões) é dada como durável — MA12, MA13 e os pais; saudável conclui', async () => {
  const cases: Array<[string, (w: LedgerWorld) => FsOps]> = [
    ['MA12: fsync da pasta de RECIBOS falha sempre', (w) => faulty({ async syncDirectory(dir) { if (dir === path.join(w.anchorDir, w.auditId)) throw errno('EIO'); return nodeFsOps.syncDirectory(dir); } })],
    ['MA13: fsync da pasta de recibos falha UMA vez (intermitente) DENTRO da gravação do recibo e depois volta', (w) => {
      let failed = false;
      return faulty({ async syncDirectory(dir) { if (!failed && dir === path.join(w.anchorDir, w.auditId)) { failed = true; throw errno('EIO'); } return nodeFsOps.syncDirectory(dir); } });
    }],
    ['pai das DECISÕES (onde vive o nome da pasta da auditoria) não sincroniza', (w) => faulty({ async syncDirectory(dir) { if (dir === w.decisionsDir) throw errno('EIO'); return nodeFsOps.syncDirectory(dir); } })],
    ['pai dos RECIBOS não sincroniza', (w) => faulty({ async syncDirectory(dir) { if (dir === w.anchorDir) throw errno('EIO'); return nodeFsOps.syncDirectory(dir); } })],
  ];
  for (const [label, makeFs] of cases) {
    const w = await pendingWorld();
    const result = await resend(w, makeFs(w));
    assert.ok(!result.ok && result.code === 'DECISIONS_DURABILITY_UNKNOWN', `${label}: ${JSON.stringify(result).slice(0, 200)}`);
    assert.ok(!(await ledgerEvents(w)).includes('CONFIRMED'), `${label}: o livro NÃO confirmou o que não ficou durável`);
  }
  const w = await pendingWorld();
  const healthy = await resend(w, nodeFsOps);
  assert.ok(healthy.ok, `controle (disco saudável): ${JSON.stringify(healthy).slice(0, 200)}`);
  assert.equal((await ledgerEvents(w)).at(-1), 'CONFIRMED');
});

/* ----------------------------------------------------------------------------- MA15 / MA16 — CONFIRMED concorrente adotado pelo dono */
/** O dono chega ao `confirmed()`; um registro `CONFIRMED` "de outro processo" já ocupa a posição. `forge` recebe a INTENT e devolve o registro concorrente. */
async function ownerFacing(forge: (intent: LedgerRecord, w: LedgerWorld) => LedgerRecord) {
  const w = await ledgerWorld();
  const inner = ledgerFor(w, { guard: null });
  const port: LedgerPort = new Proxy(inner, {
    get: (target, key) =>
      key === 'confirmed'
        ? async (input: Parameters<LedgerPort['confirmed']>[0]) => {
            const records = await ledgerRecords(w);
            const intent = records[records.length - 1] as LedgerRecord;
            const published = await publishLedgerRecord(w.ledgerDir, forge(intent, w));
            assert.ok(published.ok, JSON.stringify(published));
            return target.confirmed(input);
          }
        : Reflect.get(target, key),
  });
  const result = await decisionsOver(w, { ledger: port, knownHeads: NO_RESULTS }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  return { w, result };
}
const concurrentConfirmed = (auth: typeof LEDGER_AUTH_A, opIdOverride?: string) => (intent: LedgerRecord, w: LedgerWorld): LedgerRecord => {
  const op = intent.op as NonNullable<LedgerRecord['op']>;
  return makeRecord(auth, w.auditId, intent, {
    event: 'CONFIRMED',
    recordedAt: intent.recordedAt,
    // §16.16: o CONFIRMED concorrente legítimo (outro processo do MESMO autor) é gravado pelo autor; o de outro operador não é adotado
    actor: op.author,
    op: { ...op, ...(opIdOverride ? { opId: opIdOverride } : {}), intentSeq: intent.ledgerSeq, anchorRef: { name: 'a0001.json', headSha256: op.newDecisionsHead.sha256 } },
  });
};

test('MA15: o CONFIRMED "concorrente" só é adotado pelo dono se a cadeia continua AUTÊNTICA — registro de forma idêntica assinado por chave desconhecida NÃO vale e o dono não recebe sucesso', async () => {
  const forged = await ownerFacing(concurrentConfirmed(LEDGER_AUTH_B));
  assert.ok(!forged.result.ok, `registro com etiqueta de outra chave não pode ser adotado: ${JSON.stringify(forged.result).slice(0, 200)}`);
  const read = await readLedgerFiles(forged.w.ledgerDir, forged.w.auditId);
  assert.ok(read.ok && verifyTags(read.value.records, LEDGER_AUTH_A) !== null, 'o livro NÃO fica íntegro: a etiqueta forjada é detectada');
  // controle: o MESMO registro concorrente, assinado pela chave certa, é adotado e o dono recebe sucesso sem duplicata
  const genuine = await ownerFacing(concurrentConfirmed(LEDGER_AUTH_A));
  assert.ok(genuine.result.ok, `controle: ${JSON.stringify(genuine.result).slice(0, 200)}`);
  assert.deepEqual(await ledgerEvents(genuine.w), ['GENESIS', 'INTENT', 'CONFIRMED']);
});

test('MA16 (EQUIVALENTE por construção): CONFIRMED autêntico mas com `opId` de OUTRA operação nunca é adotado — a conferência do `opId` em `confirmed()` é redundante porque `replayLedger` exige o mesmo `opId` entre INTENT e CONFIRMED', async () => {
  const other = await ownerFacing(concurrentConfirmed(LEDGER_AUTH_A, 'f'.repeat(32)));
  assert.ok(!other.result.ok, `opId alheio: ${JSON.stringify(other.result).slice(0, 200)}`);
  // a prova da equivalência: sem a conferência do opId em `confirmed()`, a RELEITURA ainda reprova — o replay não casa o CONFIRMED com a INTENT aberta
  const read = await readLedgerFiles(other.w.ledgerDir, other.w.auditId);
  assert.ok(read.ok);
  const replayed = replayLedger((read.ok ? read.value.records : []) as LedgerRecord[], other.w.auditId);
  assert.ok(!replayed.ok && replayed.issues.some((issue) => /não casa com o INTENT/.test(issue)), `replay: ${JSON.stringify(replayed)}`);
});

/* ----------------------------------------------------------------------------- fase C (CONFIRMED que faltou): os pais também */
test('RECOVER da fase C: o CONFIRMED que faltou só é gravado depois de comprovar também os diretórios-PAI das decisões e dos recibos — com o pai sem sincronizar nada é gravado; saudável conclui', async () => {
  const cases: Array<[string, (w: LedgerWorld) => FsOps]> = [
    ['pai das DECISÕES', (w) => faulty({ async syncDirectory(dir) { if (dir === w.decisionsDir) throw errno('EIO'); return nodeFsOps.syncDirectory(dir); } })],
    ['pai dos RECIBOS', (w) => faulty({ async syncDirectory(dir) { if (dir === w.anchorDir) throw errno('EIO'); return nodeFsOps.syncDirectory(dir); } })],
  ];
  const phaseC = async (): Promise<LedgerWorld> => {
    let failConfirmed = true;
    const ledgerFs = faulty({
      async writeExclusive(target, data, mode) {
        if (failConfirmed && target.includes('l000003.json')) throw errno('ENOSPC');
        return nodeFsOps.writeExclusive(target, data, mode);
      },
    });
    const w = await ledgerWorld({ ledgerFs });
    const failed = await w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
    assert.ok(!failed.ok);
    failConfirmed = false;
    assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'fase C: entrada e recibo existem, o CONFIRMED não');
    return w;
  };
  const recover = (w: LedgerWorld, fs: FsOps) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS, fs }).ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock);
  for (const [label, makeFs] of cases) {
    const w = await phaseC();
    const result = await recover(w, makeFs(w));
    assert.ok(!result.ok && result.code === 'DECISIONS_DURABILITY_UNKNOWN', `${label}: ${JSON.stringify(result).slice(0, 200)}`);
    assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], `${label}: o CONFIRMED NÃO foi gravado`);
  }
  const w = await phaseC();
  const healthy = await recover(w, nodeFsOps);
  assert.ok(healthy.ok, JSON.stringify(healthy).slice(0, 200));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
});
