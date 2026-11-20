import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type BytesFsOps } from '../src/lib/link-audit/snapshot-store';
import { nodeKeyFileOps, type KeyFileOps } from '../src/lib/link-audit-attestation/sign-key';
import { createSealedEvidenceProvenance, parseTrustKeyring, sealSha256, type EvidenceSealFileV2, type TrustKeyring } from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { chainOn, closurePath, item, receiptFor, signer, writeReceipt, writeReceipts, type TestSigner } from './helpers/link-audit-seal-close-key-fixtures';
import { makeKeyFile, runSealSubcommand, type SignCliOptions, type SignCliRun, type TestKeyFile } from './helpers/link-audit-seal-sign-cli-fixtures';

/*
 * P1 W4.5 (B) — o CLI do `close-key` (spec §5.5.1 item 9; contrato do verificador v2 §6). As mesmas barreiras e a mesma custódia K1 do `sign` (W4.4,
 * reaproveitadas): segredo fora de argv e ambiente, analisador estrito (USAGE, código 1), `external:` recusado, confirmação no TTY sem eco e a frase
 * da chave no mesmo terminal; recusas com `RECUSADO:` e código 3; a saída mostra o `closureSha256` (o hash a fixar na lista) e o aviso de que, sem
 * a fixação, R não conta. Terminal FALSO das fixtures, ambiente vazio, chave de teste gerada em memória e gravada CIFRADA. Dados 100% FICTÍCIOS.
 */
registerCleanup();

const X = 'auditoria-cli-fecho-x1';
const Y = 'auditoria-cli-fecho-y1';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const CONFIRM_PROMPT = /chave a aposentar/i;
const PASS_PROMPT = /Frase-senha/;
const JSON_KEYS = ['ok', 'retiredKeyId', 'signerKeyId', 'custodian', 'sealedAt', 'closureSha256', 'fileName', 'heads', 'unknownSealsOnServer', 'receiptedHeadsNotOnServer', 'pinnedTrustKey'];

interface CliCloseWorld {
  readonly sealsDir: string;
  readonly receiptsDir: string;
  readonly retired: TestSigner;
  /** A chave S, gravada CIFRADA (custódia K1). */
  readonly key: TestKeyFile;
  readonly trustKeys: string;
  readonly x: readonly EvidenceSealFileV2[];
  argv(over?: Readonly<Record<string, string | null>>, extra?: readonly string[]): string[];
  /** O custodiante digita o id de R (do registro de rotação, fora da tela) e depois a frase de S. */
  typed(): string[];
}

/** X com R1 R2 recibados; Y com R1 no servidor e sem recibo (UNKNOWN_SEAL_ON_SERVER). */
function cliCloseWorld(): CliCloseWorld {
  const sealsDir = tmpDir('lackc-seals-');
  const receiptsDir = tmpDir('lackc-rec-');
  const retired = signer('ek-cli-fecho-r');
  const key = makeKeyFile({ keyId: 'ek-cli-fecho-s' });
  const trustKeys = `${item(retired)},${key.ring}`;
  const x = chainOn(sealsDir, X, [retired, retired]);
  writeReceipts(receiptsDir, x);
  chainOn(sealsDir, Y, [retired]);
  const base: Array<[string, string]> = [
    ['retired-key-id', retired.keyId],
    ['seals-dir', sealsDir],
    ['receipts-dir', receiptsDir],
    ['key-id', key.keyId],
    ['key-source', `file:${key.keyPath}`],
    ['custodian', 'CUST-01'],
    ['trust-keys', trustKeys],
  ];
  return {
    sealsDir,
    receiptsDir,
    retired,
    key,
    trustKeys,
    x,
    argv(over = {}, extra = []) {
      const pairs = base.filter(([name]) => over[name] !== null).map(([name, value]): [string, string] => [name, typeof over[name] === 'string' ? (over[name] as string) : value]);
      for (const [name, value] of Object.entries(over)) if (typeof value === 'string' && !pairs.some(([existing]) => existing === name)) pairs.push([name, value]);
      return [...pairs.flatMap(([name, value]) => [`--${name}`, value]), ...extra];
    },
    typed: () => [`${retired.keyId}\r`, `${key.passphrase}\r`],
  };
}

const run = (argv: readonly string[], options: SignCliOptions = {}): Promise<SignCliRun> => runSealSubcommand('close-key', argv, options);
const jsonOut = (result: SignCliRun): Record<string, unknown> => {
  assert.equal(result.out.length, 1, `--json imprime exatamente uma linha: ${result.stdout}`);
  return JSON.parse(result.out[0] ?? '') as Record<string, unknown>;
};
function spyOps<T extends object>(ops: T): { readonly ops: T; readonly calls: string[] } {
  const calls: string[] = [];
  const source = ops as unknown as Record<string, (...args: unknown[]) => unknown>;
  return { ops: Object.fromEntries(Object.keys(source).map((name) => [name, (...args: unknown[]) => (calls.push(name), (source[name] as (...a: unknown[]) => unknown)(...args))])) as unknown as T, calls };
}
const spyData = () => spyOps<BytesFsOps>(nodeFsOps);
const spyKey = () => spyOps<KeyFileOps>(nodeKeyFileOps);

function refusedCli(result: SignCliRun, code: string, label = code): void {
  assert.equal(result.code, 3, `${label}: código 3 (veio ${result.code}): ${result.stderr}`);
  const at = result.err.findIndex((line) => line.startsWith('RECUSADO: '));
  assert.ok(at >= 0, `${label}: prefixo RECUSADO: (${result.stderr})`);
  assert.match(result.err[at + 1] ?? '', new RegExp(`^Código: ${code}( \\(|$)`), label);
}
function usageCli(result: SignCliRun, label: string): void {
  assert.equal(result.code, 1, `${label}: USAGE (veio ${result.code}): ${result.stderr}`);
  assert.ok(result.stderr.includes('Uso: npm run link-audit:seal -- close-key'), `${label}: texto de uso do close-key`);
}
function noPathsIn(world: CliCloseWorld, result: SignCliRun, label: string): void {
  const shown = `${result.stdout}\n${result.stderr}`;
  for (const fragment of [world.sealsDir, fs.realpathSync(world.sealsDir), world.receiptsDir, world.key.dir, os.tmpdir() + path.sep, ...world.key.sentinels]) assert.ok(!shown.includes(fragment), `${label}: "${fragment.slice(0, 30)}" na saída`);
}

/* =============================================================================================================== argumentos e barreiras */

test('close-key: flag desconhecida, repetida, sem valor, obrigatória ausente, ids fora do padrão, S = R, --custodian ou --trust-keys fora de forma ⇒ USAGE (código 1) sem ler nada; terminal e chave intocados', async () => {
  const world = cliCloseWorld();
  const cases: Array<[string, string[]]> = [
    ['desconhecida', world.argv({}, ['--foo', 'x'])],
    ['repetida', world.argv({}, ['--seals-dir', world.sealsDir])],
    ['sem valor', [...world.argv({ 'trust-keys': null }), '--trust-keys']],
    ['--first não existe no close-key', world.argv({}, ['--first'])],
    ...['retired-key-id', 'seals-dir', 'receipts-dir', 'key-id', 'key-source', 'custodian', 'trust-keys'].map((name): [string, string[]] => [`sem --${name}`, world.argv({ [name]: null })]),
    ['--retired-key-id fora do padrão', world.argv({ 'retired-key-id': 'R' })],
    ['--key-id fora do padrão', world.argv({ 'key-id': 'EK-S' })],
    ['S = R', world.argv({ 'key-id': world.retired.keyId })],
    ['--custodian com e-mail', world.argv({ custodian: 'cust@exemplo.invalid' })],
    ['--trust-keys lixo', world.argv({ 'trust-keys': 'lixo' })],
    ['--key-source file: sem caminho', world.argv({ 'key-source': 'file:' })],
  ];
  for (const [label, argv] of cases) {
    const data = spyData();
    const key = spyKey();
    const result = await run(argv, { typed: world.typed(), fs: data.ops, keyFs: key.ops });
    usageCli(result, label);
    assert.equal(data.calls.length + key.calls.length, 0, `${label}: nada lido`);
    assert.deepEqual([result.terminal.rawCalls, result.terminal.reads], [[], 0], `${label}: terminal intocado`);
  }
  assert.ok(!fs.existsSync(path.join(world.sealsDir, '_closures')));
});

test('close-key: segredo em argv (--passphrase, PEM) ⇒ SECRET_VIA_ARGV_FORBIDDEN; --retired-key-id NÃO é nome de segredo; variável de ambiente com nome de segredo ⇒ SECRET_VIA_ENV_FORBIDDEN; external:<id> ⇒ SIGN_KEY_SOURCE_UNSUPPORTED; nada lido', async () => {
  const world = cliCloseWorld();
  const sentinela = 'valor-secreto-sentinela-c10e';
  const pem = String(world.key.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const cases: Array<[string, string[], string, Readonly<Record<string, string>>?]> = [
    ['--passphrase', world.argv({}, ['--passphrase', sentinela]), 'SECRET_VIA_ARGV_FORBIDDEN'],
    ['PEM em --custodian', world.argv({ custodian: pem }), 'SECRET_VIA_ARGV_FORBIDDEN'],
    ['ambiente', world.argv(), 'SECRET_VIA_ENV_FORBIDDEN', { GITHUB_TOKEN: sentinela, PATH: '/usr/bin' }],
    ['external:', world.argv({ 'key-source': 'external:token-piv-01' }), 'SIGN_KEY_SOURCE_UNSUPPORTED'],
  ];
  for (const [label, argv, code, env] of cases) {
    const data = spyData();
    const key = spyKey();
    const result = await run(argv, { typed: world.typed(), fs: data.ops, keyFs: key.ops, ...(env ? { env } : {}) });
    refusedCli(result, code, label);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(sentinela), `${label}: valor nunca ecoado`);
    assert.equal(data.calls.length + key.calls.length, 0, `${label}: nada lido`);
  }
  const accepted = await run(world.argv(), { typed: world.typed() });
  assert.equal(accepted.code, 0, `--retired-key-id passa pelas barreiras: ${accepted.stderr}`);
});

/* =============================================================================================================== sucesso */

test('close-key (saída humana): fecho gravado em _closures/<R>.json, closureSha256 = SHA-256 dos bytes, o item a FIXAR na lista, o aviso de que sem a fixação R não conta e a lista UNKNOWN_SEAL_ON_SERVER; sem caminho de disco nem chave; terminal sem eco e restaurado', async () => {
  const world = cliCloseWorld();
  const result = await run(world.argv(), { typed: world.typed() });
  assert.equal(result.code, 0, result.stderr);
  const bytes = fs.readFileSync(closurePath(world.sealsDir, world.retired.keyId));
  const closureSha256 = sha256(bytes);
  assert.match(result.stdout, /FECHO DE APOSENTADORIA ASSINADO/);
  assert.ok(result.stdout.includes(`_closures/${world.retired.keyId}.json`), 'o nome do arquivo (relativo à pasta de manifestos)');
  assert.ok(result.stdout.includes(`closureSha256: ${closureSha256}`), 'o hash a fixar');
  assert.ok(result.stdout.includes(`${world.retired.keyId}:${world.retired.publicRaw}:retired:${closureSha256}`), 'o item da lista a fixar (runbook)');
  assert.match(result.stdout, /sem fixar[^\n]*NÃO conta/i, 'aviso: sem a fixação, R não conta');
  assert.ok(result.stdout.includes('UNKNOWN_SEAL_ON_SERVER') && result.stdout.includes(Y), 'cadeia desconhecida listada (e não coberta)');
  assert.match(result.stdout, /Autoteste/, 'o autoteste do fecho é registrado');
  assert.ok(result.stderr.includes(`${world.key.keyId}:${world.key.publicRaw}`) || result.stdout.includes(`${world.key.keyId}:${world.key.publicRaw}`), 'a pública derivada de S (não secreta)');
  noPathsIn(world, result, 'sucesso');
  assert.deepEqual(result.terminal.echoed, [], 'nada ecoado');
  assert.deepEqual(result.terminal.deliveries.map((delivery) => delivery.raw), [true, true]);
  assert.equal(result.terminal.isRaw, false, 'eco restaurado');
  const confirmScreen = result.terminal.deliveries[0]?.screen ?? '';
  assert.match(confirmScreen, CONFIRM_PROMPT);
  assert.ok(!confirmScreen.includes(world.retired.keyId), 'a tela de confirmação não mostra o id de R (o custodiante o digita do registro)');
  const pinned = `${world.retired.keyId}:${world.retired.publicRaw}:retired:${closureSha256},${world.key.ring}`;
  const head = world.x[1] as EvidenceSealFileV2;
  const verdict = await createSealedEvidenceProvenance({ sealsDir: world.sealsDir, keyring: parseTrustKeyring(pinned) as TrustKeyring, acceptedVersions: [2] }).classify(X, head.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256, legacy: false })));
  assert.equal(verdict.status, 'AUTHENTICATED');
});

test('close-key --json: UM objeto com o resumo do fecho (heads, UNKNOWN_SEAL_ON_SERVER, closureSha256 e o item a fixar); a pública derivada vai à saída de erro', async () => {
  const world = cliCloseWorld();
  const result = await run(world.argv({}, ['--json']), { typed: world.typed() });
  assert.equal(result.code, 0, result.stderr);
  const summary = jsonOut(result);
  assert.deepEqual(Object.keys(summary), JSON_KEYS);
  const closureSha256 = sha256(fs.readFileSync(closurePath(world.sealsDir, world.retired.keyId)));
  assert.deepEqual(summary, {
    ok: true,
    retiredKeyId: world.retired.keyId,
    signerKeyId: world.key.keyId,
    custodian: 'CUST-01',
    sealedAt: '2026-11-19T09:00:00.000Z',
    closureSha256,
    fileName: `_closures/${world.retired.keyId}.json`,
    heads: [{ auditId: X, seq: 2, sealSha256: sealSha256(world.x[1] as EvidenceSealFileV2) }],
    unknownSealsOnServer: [{ auditId: Y, seqs: [1] }],
    receiptedHeadsNotOnServer: [],
    pinnedTrustKey: `${world.retired.keyId}:${world.retired.publicRaw}:retired:${closureSha256}`,
  });
  assert.ok(result.stderr.includes(`${world.key.keyId}:${world.key.publicRaw}`));
  noPathsIn(world, result, '--json');
});

/* =============================================================================================================== recusas */

test('close-key: recusas com RECUSADO: + Código (código 3) e, com --json, {ok:false, code, message}; confirmação errada ⇒ SIGN_CONFIRMATION_FAILED sem pedir a frase; nada gravado', async () => {
  const conflict = cliCloseWorld();
  writeReceipt(conflict.receiptsDir, 'divergente.json', receiptFor(conflict.x[1] as EvidenceSealFileV2, { custodian: 'CUST-99' }));
  const human = await run(conflict.argv(), { typed: conflict.typed() });
  refusedCli(human, 'CLOSE_RECEIPTS_CONFLICT');
  assert.deepEqual(human.terminal.reads, 0, 'recusa antes da confirmação');
  noPathsIn(conflict, human, 'recusa');
  const json = await run(conflict.argv({}, ['--json']), { typed: conflict.typed() });
  assert.equal(json.code, 3);
  assert.deepEqual(Object.keys(jsonOut(json)), ['ok', 'code', 'message']);
  assert.equal(jsonOut(json).code, 'CLOSE_RECEIPTS_CONFLICT');
  const wrong = cliCloseWorld();
  const typedWrong = await run(wrong.argv(), { typed: [`${wrong.retired.keyId.toUpperCase()}\r`, `${wrong.key.passphrase}\r`] });
  refusedCli(typedWrong, 'SIGN_CONFIRMATION_FAILED');
  assert.ok(!PASS_PROMPT.test(typedWrong.stderr), 'frase nunca pedida');
  assert.equal(typedWrong.terminal.reads, 1);
  assert.equal(typedWrong.terminal.isRaw, false);
  for (const world of [conflict, wrong]) assert.ok(!fs.existsSync(path.join(world.sealsDir, '_closures')), 'nada gravado');
});

test('close-key pelo script: a raiz do PROJETO vale para a custódia (chave dentro do repositório ⇒ SECRET_PATH_UNSAFE depois da confirmação, sem pedir a frase); subcomando desconhecido ⇒ USAGE citando os três', async () => {
  const world = cliCloseWorld();
  const inside = path.join(__dirname, '..', 'chave-de-teste-inexistente.pem');
  const result = await run(world.argv({ 'key-source': `file:${inside}` }), { typed: world.typed(), projectRoot: null });
  refusedCli(result, 'SECRET_PATH_UNSAFE');
  assert.ok(!result.stderr.includes(inside));
  assert.ok(!PASS_PROMPT.test(result.stderr));
  const unknown = await runSealSubcommand('sign', [], {});
  assert.equal(unknown.code, 1);
  const { runSealCli } = await import('../scripts/link-audit-seal');
  const err: string[] = [];
  assert.equal(await runSealCli(['rotate'], () => undefined, (line) => err.push(line)), 1);
  assert.match(err.join('\n'), /export, sign ou close-key/);
  assert.ok(err.join('\n').includes('Uso: npm run link-audit:seal -- close-key'), 'o USAGE geral traz o close-key');
});
