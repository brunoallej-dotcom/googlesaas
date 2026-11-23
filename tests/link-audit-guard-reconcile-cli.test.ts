import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPostgresGuard } from '../src/lib/link-audit-ledger/guard-postgres';
import { GUARD_DB_URL_ENV, GUARD_KEY_ENV, GUARD_READER_DB_CA_ENV, GUARD_READER_DB_URL_ENV, GUARD_RETIRED_KEYS_ENV } from '../src/lib/link-audit-ledger/config';
import type { GuardDbTarget, LedgerRecord } from '../src/lib/link-audit-ledger';
import { EXIT, GATE_SCHEMA, RECONCILE_SCHEMA, runGuardReconcileCli, type GuardReconcileCliDeps } from '../src/lib/link-audit-guard-reconcile/cli';
import { READER_BEGIN_SQL, READER_END_SQL, READER_HEADS_SQL, READER_IDENTITY_SQL, READER_ROWS_SQL } from '../src/lib/link-audit-guard-reconcile/reader';
import { recordFileName } from '../src/lib/link-audit-guard-reconcile/records';
import { registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { PSEUDONYMS_A, PSEUDONYMS_B_AFTER_A, simulatedGuardDb, type SimulatedHeadRow } from './helpers/link-audit-guard-db-fixtures';
import { makeTestPki } from './helpers/link-audit-guard-pki-fixtures';
import { headAt, ledgerOf, ROUND, simulatedReaderDb, WRITER_IDENTITY, writeRound, type SimulatedReaderDb } from './helpers/link-audit-guard-reconcile-fixtures';
import { testKeySpec } from './helpers/link-audit-origin-fixtures';

/*
 * G1.b.2b — o CLI `scripts/link-audit-guard-reconcile.ts` (GE-E5, PG-G09; e o verificador do portão G-1, PG-G07 segunda metade). Roda FORA da VPS,
 * com a credencial do papel de LEITURA (variáveis próprias), a chave do pseudônimo (atual + aposentadas) e uma rodada válida do backup do livro.
 * `reconcile`: compara guarda × backup × registro anterior, grava o registro novo (criação exclusiva) e sai ≠ 0 em divergência. `gate`: diz se a
 * guarda está operante (configuração completa, TLS/leitor ok, toda auditoria CONSISTENT) e acusa NOT_CONFIGURED. Provedor SIMULADO (sem rede); as
 * cabeças são publicadas pelo ADAPTADOR REAL (`createPostgresGuard`) no provedor simulado do escritor e lidas das MESMAS linhas pelo leitor.
 */
registerCleanup();
const PKI = makeTestPki();
const NEEDS_CA = { skip: PKI === null ? 'openssl ausente' : false };
const ROOT = path.resolve(__dirname, '..');
const A = 'auditoria-cli-recon-a1';
const B = 'auditoria-cli-recon-b1';
const NOW = new Date(Date.UTC(2026, 10, 22, 5, 0, 0));
const READER_URL = 'postgresql://gmn_guard_reader:sentinela-leitor@127.0.0.1:6543/postgres?sslmode=verify-full';
const KEY_A = testKeySpec('gk-test-a', 'guard-a');
const KEY_B = testKeySpec('gk-test-b', 'guard-b');
/** Sob `run-isolated.sh` (namespace de usuário) o root real aparece com o uid de transbordo: só nos testes, o dono de `/` e da pasta temporária conta como root. */
const TRUSTED = [...new Set([0, fs.statSync('/').uid, fs.statSync(os.tmpdir()).uid])];
const ENV = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ [GUARD_READER_DB_URL_ENV]: READER_URL, [GUARD_READER_DB_CA_ENV]: PKI?.caPem ?? '', [GUARD_KEY_ENV]: KEY_A, ...over });

interface World {
  readonly ledgers: Record<string, LedgerRecord[]>;
  readonly roundDir: string;
  readonly recordsDir: string;
  readonly writer: ReturnType<typeof simulatedGuardDb>;
  readonly reader: SimulatedReaderDb;
}

/** A com 7 registros e cabeça 7 (CONSISTENT); B com 9 e cabeça 6 (BEHIND), publicadas pelo adaptador real com a chave A (posições 1, cabeça − 2 e cabeça). */
async function world(options: { readonly headA?: number; readonly headB?: number; readonly ledgers?: Record<string, LedgerRecord[]> } = {}): Promise<World> {
  const ledgers = options.ledgers ?? { [A]: ledgerOf(A, 7), [B]: ledgerOf(B, 9) };
  const writer = simulatedGuardDb();
  const guard = createPostgresGuard({ pseudonyms: PSEUDONYMS_A, connect: writer.connect });
  for (const [auditId, head] of [[A, options.headA ?? 7], [B, options.headB ?? 6]] as const) {
    const records = ledgers[auditId];
    if (!records || head === 0) continue;
    for (const seq of [...new Set([1, head - 2, head])].filter((value) => value >= 1).sort((x, y) => x - y)) assert.deepEqual(await guard.publish({ auditId, ...headAt(records, seq) }), { ok: true });
  }
  return { ledgers, roundDir: writeRound(ledgers), recordsDir: tmpDir('lagr-cli-rec-'), writer, reader: simulatedReaderDb(writer.rows) };
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  json(): Record<string, unknown>;
}
async function run(argv: readonly string[], deps: Partial<GuardReconcileCliDeps> & { readonly reader?: SimulatedReaderDb } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const targets: GuardDbTarget[] = [];
  const code = await runGuardReconcileCli(argv, (line) => out.push(line), (line) => err.push(line), {
    env: ENV(),
    projectRoot: ROOT,
    now: () => NOW,
    recordsDir: { trustedAncestorOwners: TRUSTED },
    connectFor: (target) => {
      targets.push(target);
      return (deps.reader ?? simulatedReaderDb()).connect;
    },
    ...deps,
  });
  return { code, out, err, json: () => JSON.parse(out.join('\n')) as Record<string, unknown> };
}
const reconcileArgs = (w: World, extra: readonly string[] = []): string[] => ['reconcile', '--backup', w.roundDir, '--records-dir', w.recordsDir, ...extra];

/* ============================================================================ reconcile */

test('PG-G09 CLI reconcile limpo: código 0, --json estável e versionado, sem auditId na saída, registro 1 gravado; só SQL de leitura', NEEDS_CA, async () => {
  const w = await world();
  const result = await run(reconcileArgs(w, ['--first', '--json']), { reader: w.reader });
  assert.equal(result.code, EXIT.OK, result.out.join('\n') + result.err.join('\n'));
  const json = result.json();
  assert.deepEqual(Object.keys(json), ['schema', 'command', 'ok', 'code', 'backup', 'reader', 'keys', 'lMax', 'summary', 'findings', 'record']);
  assert.deepEqual(json, {
    schema: RECONCILE_SCHEMA,
    command: 'reconcile',
    ok: true,
    code: null,
    backup: { round: ROUND, manifestSha256: json.backup && (json.backup as { manifestSha256: string }).manifestSha256 },
    reader: { role: 'gmn_guard_reader', readOnly: true },
    keys: { current: 'gk-test-a', all: ['gk-test-a'] },
    lMax: 5,
    summary: { audits: 2, consistent: 1, behind: 1, noHead: 0, divergent: 0, headsOnRetiredKey: 0, guardHeads: 2, findings: 0 },
    findings: [],
    record: { file: recordFileName(1), sequence: 1, sha256: (json.record as { sha256: string }).sha256, previous: null },
  });
  assert.match((json.backup as { manifestSha256: string }).manifestSha256, /^[0-9a-f]{64}$/);
  assert.ok(!result.out.join('\n').includes(A) && !result.out.join('\n').includes(B), 'auditoria sem problema não é listada');
  assert.deepEqual(fs.readdirSync(w.recordsDir), [recordFileName(1)]);
  assert.ok(!fs.readFileSync(path.join(w.recordsDir, recordFileName(1)), 'utf8').includes(A), 'o registro nunca guarda auditId');
  assert.deepEqual([...new Set(w.reader.queries.map((query) => query.text))].sort(), [READER_BEGIN_SQL, READER_END_SQL, READER_HEADS_SQL, READER_IDENTITY_SQL].sort());
  assert.equal(w.reader.state.open, 0);
});

test('PG-G09 CLI reconcile: a SEGUNDA rodada compara com o registro anterior; guarda que regrediu (linha apagada por fora) ⇒ código 2, GUARD_REGRESSED com o auditId do backup, registro 2 encadeado que continua cobrando a linha', NEEDS_CA, async () => {
  const w = await world();
  assert.equal((await run(reconcileArgs(w, ['--first', '--json']), { reader: w.reader })).code, EXIT.OK);
  // o dono do projeto apaga a cabeça 7 de A (com os gatilhos desligados): a guarda volta para a 5
  const refA = PSEUDONYMS_A.current(A).auditRef;
  w.writer.rows.splice(w.writer.rows.findIndex((row) => row.audit_ref === refA && row.ledger_seq === 7), 1);
  const second = await run(reconcileArgs(w, ['--json']), { reader: simulatedReaderDb(w.writer.rows) });
  assert.equal(second.code, EXIT.FINDINGS);
  const json = second.json();
  assert.equal(json.ok, false);
  assert.equal(json.code, 'DIVERGENT');
  assert.deepEqual(json.findings, [{ code: 'GUARD_REGRESSED', auditRef: refA, auditId: A, backupSeq: 7, guardSeq: 5, recordedSeq: 7 }]);
  assert.deepEqual(json.record, { file: recordFileName(2), sequence: 2, sha256: (json.record as { sha256: string }).sha256, previous: recordFileName(1) });
  const third = await run(reconcileArgs(w, ['--json']), { reader: simulatedReaderDb(w.writer.rows) });
  assert.equal(third.code, EXIT.FINDINGS, 'a regressão nunca vira a base nova em silêncio');
  assert.deepEqual((third.json().findings as Array<{ code: string }>).map((item) => item.code), ['GUARD_REGRESSED']);
});

test('PG-G09 CLI reconcile: cabeça da guarda ausente do backup (backup mais velho que a guarda) ⇒ código 2, GUARD_HEAD_NOT_IN_BACKUP', NEEDS_CA, async () => {
  const full = { [A]: ledgerOf(A, 7), [B]: ledgerOf(B, 9) };
  const w = await world({ ledgers: full });
  const older = writeRound({ [A]: full[A]?.slice(0, 5) as LedgerRecord[], [B]: full[B] as LedgerRecord[] });
  const result = await run(['reconcile', '--backup', older, '--records-dir', w.recordsDir, '--first', '--json'], { reader: w.reader });
  assert.equal(result.code, EXIT.FINDINGS);
  assert.deepEqual(result.json().findings, [{ code: 'GUARD_HEAD_NOT_IN_BACKUP', auditRef: PSEUDONYMS_A.current(A).auditRef, auditId: A, backupSeq: 5, guardSeq: 7, recordedSeq: null }]);
});

test('PG-G09 CLI reconcile: backup à frente da guarda além de L_max ⇒ código 2, BACKUP_AHEAD_BEYOND_L_MAX; até L_max ⇒ código 0', NEEDS_CA, async () => {
  const atLimit = await world({ headB: 4 });
  assert.equal((await run(reconcileArgs(atLimit, ['--first', '--json']), { reader: atLimit.reader })).code, EXIT.OK);
  const beyond = await world({ headB: 3 });
  const result = await run(reconcileArgs(beyond, ['--first', '--json']), { reader: beyond.reader });
  assert.equal(result.code, EXIT.FINDINGS);
  assert.deepEqual((result.json().findings as Array<{ code: string; auditId: string }>).map((item) => [item.code, item.auditId]), [['BACKUP_AHEAD_BEYOND_L_MAX', B]]);
});

test('PG-G09 CLI reconcile: divergência de hash e auditoria sem cabeça com livro ≥ 2 ⇒ código 2, HASH_MISMATCH e GUARD_HEAD_MISSING', NEEDS_CA, async () => {
  const w = await world({ headB: 0 });
  const refA = PSEUDONYMS_A.current(A).auditRef;
  const row = w.writer.rows.find((item) => item.audit_ref === refA && item.ledger_seq === 7) as SimulatedHeadRow;
  w.writer.rows.splice(w.writer.rows.indexOf(row), 1, { ...row, sha256: 'e'.repeat(64) });
  const result = await run(reconcileArgs(w, ['--first', '--json']), { reader: simulatedReaderDb(w.writer.rows) });
  assert.equal(result.code, EXIT.FINDINGS);
  assert.deepEqual((result.json().findings as Array<{ code: string; auditId: string }>).map((item) => [item.code, item.auditId]), [['HASH_MISMATCH', A], ['GUARD_HEAD_MISSING', B]]);
});

test('G1.b.2b CLI reconcile: rotação da chave do pseudônimo — com a aposentada na lista da reconciliação, tudo confere; retirar da lista uma chave que o registro anterior usava ⇒ recusado (GUARD_KEY_DROPPED)', NEEDS_CA, async () => {
  const w = await world();
  const rotated = createPostgresGuard({ pseudonyms: PSEUDONYMS_B_AFTER_A, connect: w.writer.connect });
  assert.deepEqual(await rotated.publish({ auditId: A, ...headAt(w.ledgers[A] as LedgerRecord[], 7) }), { ok: true });
  const env = ENV({ [GUARD_KEY_ENV]: KEY_B, [GUARD_RETIRED_KEYS_ENV]: KEY_A });
  const first = await run(reconcileArgs(w, ['--first', '--json']), { reader: simulatedReaderDb(w.writer.rows), env });
  assert.equal(first.code, EXIT.OK, JSON.stringify(first.json()));
  assert.deepEqual(first.json().keys, { current: 'gk-test-b', all: ['gk-test-b', 'gk-test-a'] });
  assert.equal((first.json().summary as { headsOnRetiredKey: number }).headsOnRetiredKey, 1, 'B ainda só tem cabeça sob a aposentada');
  const dropped = await run(reconcileArgs(w, ['--json']), { reader: simulatedReaderDb(w.writer.rows), env: ENV({ [GUARD_KEY_ENV]: KEY_B }) });
  assert.equal(dropped.code, EXIT.REFUSED);
  assert.equal(dropped.json().code, 'GUARD_KEY_DROPPED');
});

test('G1.b.2b CLI reconcile: registro anterior exigido (sem --first numa pasta vazia ⇒ NO_PREVIOUS_RECORD; --first com registro ⇒ PREVIOUS_RECORD_EXISTS); nada é lido da guarda antes disso', NEEDS_CA, async () => {
  const w = await world();
  const none = await run(reconcileArgs(w, ['--json']), { reader: w.reader });
  assert.deepEqual([none.code, none.json().code], [EXIT.REFUSED, 'NO_PREVIOUS_RECORD']);
  assert.equal(w.reader.queries.length, 0);
  assert.equal((await run(reconcileArgs(w, ['--first']), { reader: w.reader })).code, EXIT.OK);
  const again = await run(reconcileArgs(w, ['--first', '--json']), { reader: w.reader });
  assert.deepEqual([again.code, again.json().code], [EXIT.REFUSED, 'PREVIOUS_RECORD_EXISTS']);
});

test('G1.b.2b CLI reconcile (revisão do PR #64): --first só com a pasta TOTALMENTE vazia; registros renomeados nunca fazem a cadeia recomeçar; pasta insegura recusada', NEEDS_CA, async () => {
  const w = await world();
  const temp = tmpDir('lagr-cli-rec-');
  fs.writeFileSync(path.join(temp, `.tmp-reconcile-000001-${'0a'.repeat(8)}.json`), 'sobra');
  const onlyTemp = await run(['reconcile', '--backup', w.roundDir, '--records-dir', temp, '--first', '--json'], { reader: w.reader });
  assert.deepEqual([onlyTemp.code, onlyTemp.json().code], [EXIT.REFUSED, 'RECORDS_DIR_NOT_EMPTY']);
  const readme = tmpDir('lagr-cli-rec-');
  fs.writeFileSync(path.join(readme, 'LEIA-ME.txt'), 'anotações');
  const withReadme = await run(['reconcile', '--backup', w.roundDir, '--records-dir', readme, '--first', '--json'], { reader: w.reader });
  assert.deepEqual([withReadme.code, withReadme.json().code], [EXIT.REFUSED, 'RECORDS_INVALID']);
  assert.equal((await run(reconcileArgs(w, ['--first']), { reader: w.reader })).code, EXIT.OK);
  fs.renameSync(path.join(w.recordsDir, recordFileName(1)), path.join(w.recordsDir, 'registro-antigo.json'));
  for (const extra of [['--first'], []]) {
    const renamed = await run(reconcileArgs(w, [...extra, '--json']), { reader: w.reader });
    assert.deepEqual([renamed.code, renamed.json().code], [EXIT.REFUSED, 'RECORDS_INVALID'], extra.join(' ') || 'sem --first');
  }
  assert.deepEqual(fs.readdirSync(w.recordsDir), ['registro-antigo.json'], 'nenhuma cadeia nova começou');
  const fakeRoot = tmpDir('lagr-cli-root-');
  const inside = path.join(fakeRoot, 'registros');
  fs.mkdirSync(inside, { mode: 0o700 });
  const unsafe = await run(['reconcile', '--backup', w.roundDir, '--records-dir', inside, '--first', '--json'], { reader: w.reader, projectRoot: fakeRoot });
  assert.deepEqual([unsafe.code, unsafe.json().code], [EXIT.REFUSED, 'RECORDS_DIR_UNSAFE']);
  const open = tmpDir('lagr-cli-rec-');
  fs.chmodSync(open, 0o777);
  const writable = await run(['reconcile', '--backup', w.roundDir, '--records-dir', open, '--first', '--json'], { reader: w.reader });
  assert.deepEqual([writable.code, writable.json().code], [EXIT.REFUSED, 'RECORDS_DIR_UNSAFE']);
});

test('G1.b.2b CLI reconcile (revisão final do PR #64, TOCTOU): a pasta dos registros trocada por um link simbólico entre a conferência e a publicação ⇒ RECORDS_DIR_UNSAFE, código 3 (nunca 0)', NEEDS_CA, async () => {
  const w = await world();
  const moved = `${w.recordsDir}-movida`;
  const swapped = await run(reconcileArgs(w, ['--first', '--json']), {
    reader: w.reader,
    recordsDir: {
      trustedAncestorOwners: TRUSTED,
      onStage: (stage) => {
        if (stage !== 'BEFORE_LINK') return;
        fs.renameSync(w.recordsDir, moved);
        fs.symlinkSync(moved, w.recordsDir);
      },
    },
  });
  assert.deepEqual([swapped.code, swapped.json().code], [EXIT.REFUSED, 'RECORDS_DIR_UNSAFE']);
  assert.notEqual(swapped.code, EXIT.OK);
});

test('G1.b.2b CLI reconcile: criação EXCLUSIVA do registro — se o arquivo aparecer entre a leitura e a gravação, ⇒ RECORD_EXISTS (código 3) e o arquivo alheio fica intacto', NEEDS_CA, async () => {
  const w = await world();
  const intruder = path.join(w.recordsDir, recordFileName(1));
  const result = await run(reconcileArgs(w, ['--first', '--json']), {
    connectFor: () => {
      fs.writeFileSync(intruder, 'registro de outra execução\n');
      return w.reader.connect;
    },
  });
  assert.deepEqual([result.code, result.json().code], [EXIT.REFUSED, 'RECORD_EXISTS']);
  assert.equal(fs.readFileSync(intruder, 'utf8'), 'registro de outra execução\n');
});

test('G1.b.2b CLI reconcile: NUNCA a credencial do escritor — variável do escritor no ambiente ⇒ recusado antes de conectar; sessão que não é do leitor ⇒ recusado sem ler cabeças', NEEDS_CA, async () => {
  const w = await world();
  let connected = 0;
  const writerEnv = await run(reconcileArgs(w, ['--first', '--json']), { env: ENV({ [GUARD_DB_URL_ENV]: READER_URL.replace('reader', 'writer') }), connectFor: () => { connected += 1; return w.reader.connect; } });
  assert.deepEqual([writerEnv.code, writerEnv.json().code, connected], [EXIT.REFUSED, 'GUARD_WRITER_CREDENTIAL_PRESENT', 0]);
  const writerRole = await run(reconcileArgs(w, ['--first', '--json']), { env: ENV({ [GUARD_READER_DB_URL_ENV]: READER_URL.replace('gmn_guard_reader', 'gmn_guard_writer') }) });
  assert.deepEqual([writerRole.code, writerRole.json().code], [EXIT.REFUSED, 'GUARD_READER_ROLE_REQUIRED']);
  const session = simulatedReaderDb(w.writer.rows, WRITER_IDENTITY);
  const writerSession = await run(reconcileArgs(w, ['--first', '--json']), { reader: session });
  assert.deepEqual([writerSession.code, writerSession.json().code], [EXIT.REFUSED, 'NOT_READER_ROLE']);
  assert.deepEqual(session.queries.map((query) => query.text), [READER_IDENTITY_SQL]);
  assert.deepEqual(fs.readdirSync(w.recordsDir), [], 'nada gravado');
});

test('G1.b.2b CLI reconcile: entradas e ambiente — sem configuração ⇒ NOT_CONFIGURED; rodada inválida; guarda indisponível; dentro da pilha (GMN_ROLE); variável e arquivo juntos; tudo código 3 sem registro', NEEDS_CA, async () => {
  const w = await world();
  const cases: Array<[string, Promise<Run>]> = [
    ['NOT_CONFIGURED', run(reconcileArgs(w, ['--first', '--json']), { env: {} })],
    ['BACKUP_ROUND_NOT_VALID', run(['reconcile', '--backup', writeRound({ [A]: w.ledgers[A] as LedgerRecord[] }, { incomplete: true }), '--records-dir', w.recordsDir, '--first', '--json'], { reader: w.reader })],
    ['INSIDE_THE_STACK', run(reconcileArgs(w, ['--first', '--json']), { env: ENV({ GMN_ROLE: 'web' }) })],
    ['READER_ENV_INVALID', run(reconcileArgs(w, ['--first', '--json']), { env: ENV({ [`${GUARD_READER_DB_URL_ENV}_FILE`]: '/caminho/sentinela' }) })],
    ['READER_ENV_INVALID', run(reconcileArgs(w, ['--first', '--json']), { env: { ...ENV(), [GUARD_READER_DB_URL_ENV]: undefined, [`${GUARD_READER_DB_URL_ENV}_FILE`]: path.join(tmpDir('lagr-x-'), 'nao-existe') } })],
  ];
  for (const [code, pending] of cases) {
    const result = await pending;
    assert.deepEqual([result.code, result.json().code], [EXIT.REFUSED, code], code);
    assert.equal(typeof result.json().message, 'string');
    assert.ok(!result.out.join('\n').includes('sentinela'), 'nem caminho nem valor ecoados');
  }
  const down = simulatedReaderDb(w.writer.rows);
  down.state.failConnect = true;
  const unavailable = await run(reconcileArgs(w, ['--first', '--json']), { reader: down });
  assert.deepEqual([unavailable.code, unavailable.json().code], [EXIT.REFUSED, 'GUARD_UNAVAILABLE']);
  assert.deepEqual(fs.readdirSync(w.recordsDir), []);
});

test('G1.b.2b CLI: credencial e CA também por ARQUIVO próprio (`*_FILE`), com o fim de linha removido da URL e das chaves', NEEDS_CA, async () => {
  const w = await world();
  const dir = tmpDir('lagr-cred-');
  fs.writeFileSync(path.join(dir, 'url'), `${READER_URL}\n`);
  fs.writeFileSync(path.join(dir, 'ca.pem'), PKI?.caPem ?? '');
  fs.writeFileSync(path.join(dir, 'key'), `${KEY_A}\n`);
  const env = { [`${GUARD_READER_DB_URL_ENV}_FILE`]: path.join(dir, 'url'), [`${GUARD_READER_DB_CA_ENV}_FILE`]: path.join(dir, 'ca.pem'), [`${GUARD_KEY_ENV}_FILE`]: path.join(dir, 'key') };
  const result = await run(reconcileArgs(w, ['--first', '--json']), { reader: w.reader, env });
  assert.equal(result.code, EXIT.OK, JSON.stringify(result.json()));
});

test('G1.b.2b CLI: analisador estrito (subcomando, opção desconhecida, repetida ou sem valor ⇒ USAGE código 1, sem ecoar valores) e saída humana em pt-BR', NEEDS_CA, async () => {
  for (const argv of [[], ['outro'], ['reconcile'], ['reconcile', '--backup'], ['reconcile', '--backup', 'x', '--backup', 'y', '--records-dir', 'z'], ['reconcile', '--backup', 'x', '--records-dir', 'z', '--senha=sentinela'], ['gate', '--first']]) {
    const result = await run([...argv, '--json']);
    assert.equal(result.code, EXIT.USAGE, argv.join(' '));
    assert.equal(result.json().code, 'USAGE');
    assert.ok(!result.out.join('\n').includes('sentinela'));
  }
  const w = await world({ headB: 3 });
  const human = await run(reconcileArgs(w, ['--first']), { reader: w.reader });
  assert.equal(human.code, EXIT.FINDINGS);
  const text = human.out.join('\n');
  assert.match(text, /RECONCILIAÇÃO DA GUARDA/);
  assert.match(text, /BACKUP_AHEAD_BEYOND_L_MAX/);
  assert.match(text, new RegExp(B));
  assert.match(text, /reconcile-000001\.json/);
});

test('G1.b.2b CLI (coerência com a G1.b.2a): duas linhas na posição máxima de um pseudônimo ⇒ reconcile recusa (GUARD_DUPLICATE_HEAD, código 3, sem registro) e o portão fica não operante (código 2); nenhum hash escolhido', NEEDS_CA, async () => {
  const w = await world();
  const refA = PSEUDONYMS_A.current(A).auditRef;
  w.writer.rows.push({ audit_ref: refA, key_id: 'gk-test-a', ledger_seq: 7, sha256: 'e'.repeat(64) }); // só possível sem a restrição única
  const reconciled = await run(reconcileArgs(w, ['--first', '--json']), { reader: simulatedReaderDb(w.writer.rows) });
  assert.deepEqual([reconciled.code, reconciled.json().code], [EXIT.REFUSED, 'GUARD_DUPLICATE_HEAD']);
  assert.deepEqual(fs.readdirSync(w.recordsDir), []);
  const gated = await run(['gate', '--backup', w.roundDir, '--json'], { reader: simulatedReaderDb(w.writer.rows) });
  assert.deepEqual([gated.code, gated.json().code, gated.json().operational], [EXIT.FINDINGS, 'GUARD_DUPLICATE_HEAD', false]);
});

/* ============================================================================ portão G-1 */

test('PG-G07 verificador do portão G-1: SEM configuração da guarda ⇒ NOT_CONFIGURED, não operante, código 2, sem conectar', async () => {
  let connected = 0;
  const result = await run(['gate', '--json'], { env: {}, connectFor: () => { connected += 1; return simulatedReaderDb().connect; } });
  assert.equal(result.code, EXIT.FINDINGS);
  const json = result.json();
  assert.deepEqual(Object.keys(json), ['schema', 'command', 'ok', 'code', 'gate', 'operational', 'checks', 'backup', 'lMax', 'summary', 'notConsistent', 'findings']);
  assert.deepEqual(json, {
    schema: GATE_SCHEMA,
    command: 'gate',
    ok: false,
    code: 'NOT_CONFIGURED',
    gate: 'G-1',
    operational: false,
    checks: { configuration: 'NOT_CONFIGURED', configurationCode: null, connection: 'NOT_ATTEMPTED', reader: 'NOT_VERIFIED', externalGuard: 'NOT_VERIFIED' },
    backup: null,
    lMax: 5,
    summary: null,
    notConsistent: [],
    findings: [],
  });
  assert.equal(connected, 0);
  const human = await run(['gate'], { env: {} });
  assert.match(human.out.join('\n'), /NOT_CONFIGURED/);
});

test('PG-G07 verificador do portão G-1: configuração completa, leitor e TLS ok e TODA auditoria CONSISTENT ⇒ operante, código 0; nada é gravado (nem registro)', NEEDS_CA, async () => {
  const w = await world({ headB: 9 });
  const result = await run(['gate', '--backup', w.roundDir, '--json'], { reader: w.reader });
  assert.equal(result.code, EXIT.OK, JSON.stringify(result.json()));
  const json = result.json();
  assert.equal(json.operational, true);
  assert.deepEqual(json.checks, { configuration: 'READY', configurationCode: null, connection: 'OK', reader: 'OK', externalGuard: 'CONSISTENT' });
  assert.deepEqual(json.notConsistent, []);
  assert.deepEqual(fs.readdirSync(w.recordsDir), []);
  assert.ok(!w.reader.queries.some((query) => query.text === READER_ROWS_SQL));
});

test('PG-G07 verificador do portão G-1: auditoria BEHIND ⇒ NOT_CONSISTENT (código 2) listando só as que não estão CONSISTENT; sem cabeça nenhuma ⇒ STACK_NOT_PUBLISHING; sem --backup ⇒ EXTERNAL_GUARD_NOT_VERIFIED', NEEDS_CA, async () => {
  const w = await world();
  const behind = await run(['gate', '--backup', w.roundDir, '--json'], { reader: w.reader });
  assert.equal(behind.code, EXIT.FINDINGS);
  assert.equal(behind.json().code, 'NOT_CONSISTENT');
  assert.deepEqual(behind.json().notConsistent, [{ auditId: B, auditRef: PSEUDONYMS_A.current(B).auditRef, status: 'BEHIND', backupSeq: 9, guardSeq: 6, lag: 3 }]);
  const silent = await world({ headA: 0, headB: 0 });
  const notPublishing = await run(['gate', '--backup', silent.roundDir, '--json'], { reader: silent.reader });
  assert.deepEqual([notPublishing.code, notPublishing.json().code], [EXIT.FINDINGS, 'STACK_NOT_PUBLISHING']);
  const noBackup = await run(['gate', '--json'], { reader: w.reader });
  assert.deepEqual([noBackup.code, noBackup.json().code], [EXIT.FINDINGS, 'EXTERNAL_GUARD_NOT_VERIFIED']);
  assert.deepEqual((noBackup.json().checks as Record<string, string>).connection, 'OK');
});

test('PG-G07 verificador do portão G-1: configuração inválida ⇒ CONFIG_INVALID; guarda inalcançável ⇒ GUARD_UNAVAILABLE (código 2); credencial do escritor ⇒ recusada (código 3)', NEEDS_CA, async () => {
  const invalid = await run(['gate', '--json'], { env: ENV({ [GUARD_READER_DB_URL_ENV]: READER_URL.replace('verify-full', 'require') }) });
  assert.deepEqual([invalid.code, invalid.json().code, (invalid.json().checks as Record<string, string>).configurationCode], [EXIT.FINDINGS, 'CONFIG_INVALID', 'GUARD_DB_TLS_REQUIRED']);
  const down = simulatedReaderDb();
  down.state.failConnect = true;
  const unreachable = await run(['gate', '--json'], { reader: down });
  assert.deepEqual([unreachable.code, unreachable.json().code, (unreachable.json().checks as Record<string, string>).connection], [EXIT.FINDINGS, 'GUARD_UNAVAILABLE', 'FAILED']);
  const writer = await run(['gate', '--json'], { env: ENV({ [GUARD_DB_URL_ENV]: READER_URL }) });
  assert.deepEqual([writer.code, writer.json().code], [EXIT.REFUSED, 'GUARD_WRITER_CREDENTIAL_PRESENT']);
  const writerSession = await run(['gate', '--json'], { reader: simulatedReaderDb([], WRITER_IDENTITY) });
  assert.deepEqual([writerSession.code, writerSession.json().code], [EXIT.REFUSED, 'NOT_READER_ROLE']);
});

/* ============================================================================ documentação operacional (revisão final do PR #64) */

test('G1.b.2b documentação: os blocos de sessão do roteiro do laboratório e do runbook são autossuficientes (verify-full, CA, pg_como iguais) e, colados no MESMO shell em qualquer ordem, um não desfaz o trap do outro — o exit apaga as duas pastas de sessão', { skip: spawnSync('bash', ['--version']).status === 0 ? false : 'bash ausente' }, () => {
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const blockAfter = (doc: string, heading: string): string => {
    const from = doc.indexOf(heading);
    assert.ok(from >= 0, heading);
    const start = doc.indexOf('```bash\n', from) + '```bash\n'.length;
    return doc.slice(start, doc.indexOf('\n```', start));
  };
  const lab = blockAfter(read('docs/phase6-auditoria-link/producao-g1b-laboratorio-pg-g08.md'), '### 0.1 A sessão segura do roteiro');
  const runbook = blockAfter(read('docs/phase6-auditoria-link/producao-g1b-runbook-guarda.md'), '**Ambiente da reconciliação**');
  const pgComo = (block: string): string => block.slice(block.indexOf('pg_como() {'), block.indexOf('\n}\n', block.indexOf('pg_como() {')));
  const trapLine = `trap 'rm -rf -- "\${GMN_SESSOES[@]}"' EXIT`;
  for (const [name, block] of [['laboratório', lab], ['runbook', runbook]] as const) {
    assert.match(block, /export PGSSLMODE=verify-full PGSSLROOTCERT=<ARQUIVO_CA[A-Z_]*> /, `${name}: verify-full e a CA exportados`);
    assert.match(block, /GMN_SESSOES\+=\("\$(?:LAB|SESSAO)"\)/, `${name}: registra a pasta na lista comum`);
    assert.ok(block.includes(trapLine), `${name}: o mesmo trap sobre todas as pastas`);
    assert.equal((block.match(/^trap /gm) ?? []).length, 1, `${name}: um trap só`);
    assert.ok(block.includes('umask 077'));
  }
  assert.equal(pgComo(runbook), pgComo(lab), 'pg_como idêntica nos dois blocos');
  const ca = path.join(tmpDir('lagr-doc-'), 'ca-falsa.pem');
  fs.writeFileSync(ca, 'não é usada aqui');
  const fill = (block: string): string => block.replace(/<ARQUIVO_CA(?:_DO_PROJETO)?>/g, ca).replace(/<URL_DATA_API>/g, 'http://127.0.0.1:9');
  for (const order of [[lab, runbook], [runbook, lab]]) {
    const out = path.join(tmpDir('lagr-doc-'), 'sessoes.txt');
    const script = `${fill(order[0] as string)}\n${fill(order[1] as string)}\nprintf '%s\\n' "\${GMN_SESSOES[@]}" > ${JSON.stringify(out)}\nfor d in "\${GMN_SESSOES[@]}"; do [ -d "$d" ] || exit 9; done\nexit 0\n`;
    const result = spawnSync('bash', ['--norc', '--noprofile', '-c', script], { input: 'url-sentinela\nchave-sentinela\n\n', encoding: 'utf8', env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir() } });
    assert.equal(result.status, 0, result.stderr);
    const sessions = fs.readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(sessions.length, 2, 'as duas pastas de sessão registradas');
    for (const dir of sessions) assert.ok(!fs.existsSync(dir), `pasta de sessão apagada no exit: ${dir}`);
  }
});

/* ============================================================================ isolamento */

test('G1.b.2b isolamento: o módulo da reconciliação não importa `pg` nem rede, não lê o ambiente do processo e só `records.ts` grava (e só o próprio registro); a credencial do leitor nunca aparece nos arquivos de implantação', () => {
  const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-guard-reconcile');
  const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
  const imports = (source: string): string[] => [...strip(source).matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
  const allowed: Record<string, readonly string[]> = {
    'backup.ts': ['node:crypto', 'node:fs', 'node:path', '../link-audit-ledger'],
    'model.ts': ['../link-audit-ledger', './backup'],
    'reader.ts': ['zod', '../link-audit-ledger', './model'],
    'records.ts': ['node:crypto', 'node:fs', 'node:path', 'zod', '../link-audit-ledger', './model'],
    'cli.ts': ['node:fs', 'node:path', '../link-audit-ledger', './backup', './model', './reader', './records'],
  };
  assert.deepEqual(fs.readdirSync(LIB).sort(), Object.keys(allowed).sort());
  for (const [name, list] of Object.entries(allowed)) {
    const source = fs.readFileSync(path.join(LIB, name), 'utf8');
    for (const specifier of imports(source)) assert.ok(list.includes(specifier), `${name} importa "${specifier}"`);
    const code = strip(source);
    assert.ok(!/process\.env/.test(code), `${name} lê o ambiente do processo`);
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|net|dns|child_process)/.test(code), `${name} usa rede`);
    if (name !== 'records.ts') assert.ok(!/writeFile|appendFile|\.link\s*\(|\.unlink\s*\(|\.rename\s*\(|\.rm\s*\(|mkdir|'wx'/.test(code), `${name} grava no disco`);
  }
  for (const file of ['stack.yml', 'docker-entrypoint.sh', 'Dockerfile']) {
    assert.ok(!/GUARD_READER|gmn_guard_reader/.test(fs.readFileSync(path.join(ROOT, 'deploy', 'hostinger', file), 'utf8')), `${file} cita a credencial do leitor (que nunca fica na VPS)`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'link-audit-guard-reconcile.ts'), 'utf8'), /runGuardReconcileCli/);
  assert.match(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), /"link-audit:guard-reconcile": "tsx scripts\/link-audit-guard-reconcile\.ts"/);
});
