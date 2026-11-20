import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type BytesFsOps } from '../src/lib/link-audit/snapshot-store';
import { runtimeRefusal } from '../src/lib/link-audit-attestation/sign-args';
import { nodeKeyFileOps, type KeyFileOps } from '../src/lib/link-audit-attestation/sign-key';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { cliWorld, runSealSubcommand, type SignCliRun } from './helpers/link-audit-seal-sign-cli-fixtures';

/*
 * P1 W4.5, correção da revisão (MAJOR, modelo de ameaças T-008): o `sign` e o `close-key` recusam rodar num processo do Node configurado para
 * DESPEJAR a memória (onde estará a frase da chave) ou abrir um depurador: `NODE_OPTIONS` (e as outras variáveis `NODE_*`, salvo `NODE_ENV`) e
 * qualquer opção do node em `process.execArgv` além do carregador do `npm run link-audit:seal` (o par `--require …/tsx/dist/preflight.cjs` +
 * `--import file://…/tsx/dist/loader.mjs` do PRÓPRIO projeto, conferido pelo caminho real) e do modelo de permissões do artefato da W4.6
 * (`--permission`, `--allow-fs-read=…`, `--allow-fs-write=…`). A barreira vem logo depois da de ambiente da W4.4, antes do analisador: nada é lido,
 * o terminal não é tocado e a frase nunca é pedida. Recusa `SIGN_RUNTIME_UNSAFE` (código 3). Dados 100% FICTÍCIOS.
 */
registerCleanup();

const ROOT = path.join(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const SCRIPT = path.join(ROOT, 'scripts', 'link-audit-seal.ts');
const PREFLIGHT = fs.realpathSync(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'preflight.cjs'));
const LOADER_URL = `file://${fs.realpathSync(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'))}`;
/** O que o `tsx` (o `npm run link-audit:seal`) põe em `process.execArgv`, conferido num processo real: o par do carregador, nesta ordem. */
const TSX_ARGV = ['--require', PREFLIGHT, '--import', LOADER_URL];
const realpath = (target: string): Promise<string> => fs.promises.realpath(target);
const check = (execArgv: readonly string[], envNames: readonly string[] = []) => runtimeRefusal({ execArgv, envNames, projectRoot: ROOT, realpath });

/* =============================================================================================================== a barreira, por injeção */

test('T-008: execArgv do carregador do próprio projeto (tsx), do modelo de permissões da W4.6 (--permission, --allow-fs-read=, --allow-fs-write=) e vazio passam; NODE_ENV passa', async () => {
  const allowed: ReadonlyArray<readonly string[]> = [
    [],
    TSX_ARGV,
    ['--permission', '--allow-fs-read=/srv/estacao', '--allow-fs-write=/srv/estacao/manifestos'],
    ['--experimental-permission', '--allow-fs-read=/srv/estacao'],
    ['--permission', '--disable-sigusr1', '--allow-fs-read=/srv/a', '--allow-fs-read=/srv/b'],
  ];
  for (const execArgv of allowed) assert.equal(await check(execArgv, ['PATH', 'HOME', 'NODE_ENV', 'NODE', 'npm_node_execpath']), null, JSON.stringify(execArgv));
});

test('T-008: opção de diagnóstico, depuração, perfil, pré-carga extra ou qualquer outra opção do node em execArgv ⇒ SIGN_RUNTIME_UNSAFE, sem ecoar o valor', async () => {
  const fakeDir = tmpDir('lasr-falso-');
  const fakePreflight = path.join(fakeDir, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
  fs.mkdirSync(path.dirname(fakePreflight), { recursive: true });
  fs.writeFileSync(fakePreflight, '');
  fs.writeFileSync(path.join(path.dirname(fakePreflight), 'loader.mjs'), '');
  const sentinela = 'VALOR-SENTINELA-EXECARGV';
  const refused: ReadonlyArray<readonly string[]> = [
    ['--inspect'],
    ['--inspect=127.0.0.1:0'],
    ['--inspect-brk'],
    ['--inspect-port=0'],
    ['--inspect-wait'],
    ['--heapsnapshot-signal=SIGUSR2'],
    ['--heapsnapshot-near-heap-limit=1'],
    ['--heap-prof'],
    ['--cpu-prof'],
    [`--diagnostic-dir=/tmp/${sentinela}`],
    ['--report-on-signal'],
    ['--report-uncaught-exception'],
    [`--report-dir=/tmp/${sentinela}`],
    ['--expose-gc'],
    ['--trace-uncaught'],
    ['--env-file=.env.local'],
    ['--require', `/tmp/${sentinela}.cjs`],
    ['--import', `file:///tmp/${sentinela}.mjs`],
    ['-r', `/tmp/${sentinela}.cjs`],
    ['--loader', `/tmp/${sentinela}.mjs`],
    ['--allow-fs-read'],
    ['--allow-fs-read', '/srv'],
    ['--allow-child-process'],
    [...TSX_ARGV, '--expose-gc'],
    [...TSX_ARGV, ...TSX_ARGV],
    ['--import', LOADER_URL, '--require', PREFLIGHT],
    ['--require', fakePreflight, '--import', `file://${path.join(path.dirname(fakePreflight), 'loader.mjs')}`],
    ['--require', PREFLIGHT, '--import', `file://${sentinela}`],
    ['--require', PREFLIGHT],
  ];
  for (const execArgv of refused) {
    const refusal = await check(execArgv);
    assert.equal(refusal?.code, 'SIGN_RUNTIME_UNSAFE', JSON.stringify(execArgv));
    assert.ok(!refusal?.message.includes(sentinela) && !refusal?.message.includes(fakeDir), `${JSON.stringify(execArgv)}: valor nunca ecoado`);
    assert.match(refusal?.message ?? '', /Nada foi lido, assinado nem gravado/);
  }
});

test('T-008: NODE_OPTIONS (mesmo vazio: só os NOMES do ambiente são olhados) e as outras variáveis NODE_* ⇒ SIGN_RUNTIME_UNSAFE, citando o nome; NODE_ENV e NODE (do npm) passam', async () => {
  for (const name of ['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_V8_COVERAGE', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_INSPECT_RESUME_ON_START', 'NODE_EXTRA_CA_CERTS']) {
    const refusal = await check([], ['PATH', name]);
    assert.equal(refusal?.code, 'SIGN_RUNTIME_UNSAFE', name);
    assert.ok(refusal?.message.includes(name), `${name}: o NOME (não secreto) é citado`);
  }
  assert.equal(await check([], ['NODE_ENV', 'NODE', 'node_options_doc']), null, 'só NODE_* em maiúsculas é configuração do Node');
});

/* =============================================================================================================== pelo CLI (sign e close-key) */

type Call = { readonly op: string };
function spyOps<T extends object>(ops: T): { readonly ops: T; readonly calls: Call[] } {
  const calls: Call[] = [];
  const source = ops as unknown as Record<string, (...args: unknown[]) => unknown>;
  return { ops: Object.fromEntries(Object.keys(source).map((name) => [name, (...args: unknown[]) => (calls.push({ op: name }), (source[name] as (...a: unknown[]) => unknown)(...args))])) as unknown as T, calls };
}
function refusedRuntime(run: SignCliRun, label: string): void {
  assert.equal(run.code, 3, `${label}: código 3 (veio ${run.code}): ${run.stderr}`);
  const at = run.err.findIndex((line) => line.startsWith('RECUSADO: '));
  assert.ok(at >= 0, `${label}: RECUSADO: ${run.stderr}`);
  assert.equal(run.err[at + 1], 'Código: SIGN_RUNTIME_UNSAFE', label);
  assert.deepEqual([run.terminal.rawCalls, run.terminal.reads], [[], 0], `${label}: terminal intocado (a frase nunca é pedida)`);
}

test('T-008 pelo CLI: sign e close-key com --heapsnapshot-signal em execArgv ou com NODE_OPTIONS ⇒ SIGN_RUNTIME_UNSAFE (código 3) antes de ler qualquer arquivo, do terminal e da chave; vem depois das barreiras de segredo e antes do analisador', async () => {
  const world = cliWorld();
  const closeArgv = ['--retired-key-id', 'ek-cli-fecho-r', '--seals-dir', world.sealsDir, '--receipts-dir', tmpDir('lasr-rec-'), '--key-id', world.key.keyId, '--key-source', `file:${world.key.keyPath}`, '--custodian', 'CUST-01', '--trust-keys', world.key.ring];
  for (const [subcommand, argv] of [['sign', world.argv()], ['close-key', closeArgv]] as const) {
    for (const [label, options] of [
      ['execArgv com --heapsnapshot-signal', { execArgv: ['--heapsnapshot-signal=SIGUSR2'] }],
      ['NODE_OPTIONS', { env: { PATH: '/usr/bin', NODE_OPTIONS: '--inspect' } }],
      ['carregador falso', { execArgv: ['--require', '/tmp/preflight.cjs', '--import', 'file:///tmp/loader.mjs'] }],
    ] as const) {
      const data = spyOps<BytesFsOps>(nodeFsOps);
      const key = spyOps<KeyFileOps>(nodeKeyFileOps);
      const run = await runSealSubcommand(subcommand, argv, { typed: world.typed(), fs: data.ops, keyFs: key.ops, ...options });
      refusedRuntime(run, `${subcommand}: ${label}`);
      assert.equal(data.calls.length, 0, `${subcommand}: ${label}: nada lido`);
      assert.ok(key.calls.every((call) => call.op === 'realpath'), `${subcommand}: ${label}: da chave, nada (só o caminho real do carregador, se houver)`);
      const json = await runSealSubcommand(subcommand, [...argv, '--json'], { typed: world.typed(), ...options });
      assert.equal((JSON.parse(json.out[0] ?? '{}') as Record<string, unknown>).code, 'SIGN_RUNTIME_UNSAFE');
    }
    const secretFirst = await runSealSubcommand(subcommand, argv, { typed: world.typed(), env: { NODE_OPTIONS: '--inspect', GITHUB_TOKEN: 'x' } });
    assert.match(secretFirst.stderr, /Código: SECRET_VIA_ENV_FORBIDDEN/, `${subcommand}: a barreira de segredo da W4.4 vem antes`);
    const beforeParser = await runSealSubcommand(subcommand, ['--foo'], { typed: world.typed(), execArgv: ['--expose-gc'] });
    refusedRuntime(beforeParser, `${subcommand}: antes do analisador`);
    const passed = await runSealSubcommand(subcommand, argv, { typed: world.typed(), execArgv: TSX_ARGV, env: { NODE_ENV: 'production' } });
    assert.ok(!passed.stderr.includes('SIGN_RUNTIME_UNSAFE'), `${subcommand}: o carregador do projeto e NODE_ENV passam pela barreira: ${passed.stderr}`);
    if (subcommand === 'sign') assert.equal(passed.code, 0, `o sign com o carregador do projeto assina: ${passed.stderr}`);
  }
});

/* =============================================================================================================== processo REAL (tsx) */

const hasTsx = fs.existsSync(TSX);
function realRun(args: readonly string[], env: Readonly<Record<string, string>>): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync(TSX, args, { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stderr: result.stderr };
}

test('T-008 em processo REAL: pelo tsx (o que o npm run link-audit:seal usa), o carregador do projeto passa (USAGE, código 1), mas NODE_OPTIONS=--heapsnapshot-signal ou uma opção extra do node (--expose-gc) ⇒ SIGN_RUNTIME_UNSAFE (código 3)', { skip: !hasTsx && 'tsx ausente' }, () => {
  const clean = realRun([SCRIPT, 'sign'], {});
  assert.equal(clean.status, 1, `carregador do projeto aceito: ${clean.stderr}`);
  assert.match(clean.stderr, /Uso: npm run link-audit:seal -- sign/);
  const heap = realRun([SCRIPT, 'close-key'], { NODE_OPTIONS: '--heapsnapshot-signal=SIGUSR2' });
  assert.equal(heap.status, 3, heap.stderr);
  assert.match(heap.stderr, /Código: SIGN_RUNTIME_UNSAFE/);
  assert.ok(heap.stderr.includes('NODE_OPTIONS') && !heap.stderr.includes('heapsnapshot'), 'cita o nome, nunca o valor');
  const extra = realRun(['--expose-gc', SCRIPT, 'sign'], {});
  assert.equal(extra.status, 3, extra.stderr);
  assert.match(extra.stderr, /Código: SIGN_RUNTIME_UNSAFE/);
});
