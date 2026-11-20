import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type BytesFsOps } from '../src/lib/link-audit/snapshot-store';
import { runtimeRefusal, type ExecBlockReader } from '../src/lib/link-audit-attestation/sign-args';
import { nodeKeyFileOps, type KeyFileOps } from '../src/lib/link-audit-attestation/sign-key';
import { nodeFsyncProbe } from '../src/lib/link-audit-attestation/sign-runtime';
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
const NUL = '\0';
/** O bloco ORIGINAL do exec como o Linux o guarda (`/proc/self/cmdline` e `/proc/self/environ`): registros terminados por NUL. */
const nulBlock = (records: readonly string[]): Uint8Array => Buffer.from(records.map((record) => `${record}${NUL}`).join(''), 'utf8');
function execBlockOf(cmdline: readonly string[], environ: readonly string[]): ExecBlockReader {
  return { cmdline: async () => nulBlock(cmdline), environ: async () => nulBlock(environ) };
}
/** O bloco de um processo que começou EXATAMENTE com este execArgv e este ambiente (nada escondido por pré-carga). */
const faithful = (execArgv: readonly string[], envNames: readonly string[]): ExecBlockReader => execBlockOf([process.execPath, ...execArgv, SCRIPT, 'sign', '--json'], envNames.map((name) => `${name}=valor-ficticio`));
const check = (execArgv: readonly string[], envNames: readonly string[] = [], execBlock: ExecBlockReader = faithful(execArgv, envNames), artifact = false) =>
  runtimeRefusal({ execArgv, envNames, projectRoot: ROOT, realpath, execBlock, artifact });

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

/* =============================================================================================================== W4.6: o bloco ORIGINAL do exec */

test('W4.6 (ii): opção do node na linha ORIGINAL (/proc/self/cmdline) que uma pré-carga tirou de execArgv ⇒ SIGN_RUNTIME_UNSAFE; só as opções ANTES do script contam (o que vem depois é argumento do comando)', async () => {
  const sentinela = 'VALOR-SENTINELA-CMDLINE';
  for (const hidden of [['--heapsnapshot-signal=SIGUSR2'], ['--inspect'], ['--require', `/tmp/${sentinela}.cjs`], ['--expose-gc'], ['--'], ['-'], ['--permission-audit']]) {
    const refusal = await check([], [], execBlockOf([process.execPath, ...hidden, SCRIPT, 'sign'], []));
    assert.equal(refusal?.code, 'SIGN_RUNTIME_UNSAFE', JSON.stringify(hidden));
    assert.ok(!refusal?.message.includes(sentinela), 'valor nunca ecoado');
  }
  // depois do script, tudo é argumento do comando (o analisador do sign o julga), inclusive algo com cara de opção do node
  assert.equal(await check([], [], execBlockOf([process.execPath, SCRIPT, 'sign', '--expose-gc', '--inspect', `--x=${sentinela}`], [])), null);
  assert.equal(await check(TSX_ARGV, [], execBlockOf([process.execPath, ...TSX_ARGV, SCRIPT, 'close-key'], [])), null, 'o carregador do projeto na linha original passa');
  const fake = await check(TSX_ARGV, [], execBlockOf([process.execPath, '--require', '/tmp/preflight.cjs', '--import', 'file:///tmp/loader.mjs', SCRIPT], []));
  assert.equal(fake?.code, 'SIGN_RUNTIME_UNSAFE', 'carregador falso na linha original');
});

test('W4.6 (ii): NODE_OPTIONS (ou outro NODE_*) no ambiente ORIGINAL (/proc/self/environ) que uma pré-carga apagou de process.env ⇒ SIGN_RUNTIME_UNSAFE, citando só o NOME; nome de segredo no ambiente original ⇒ SECRET_VIA_ENV_FORBIDDEN; valores nunca ecoados', async () => {
  const sentinela = 'VALOR-SENTINELA-ENVIRON';
  for (const name of ['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_V8_COVERAGE']) {
    const refusal = await check([], ['PATH'], execBlockOf([process.execPath, SCRIPT, 'sign'], ['PATH=/usr/bin', `${name}=--require /tmp/${sentinela}.cjs`]));
    assert.equal(refusal?.code, 'SIGN_RUNTIME_UNSAFE', name);
    assert.ok(refusal?.message.includes(name) && !refusal.message.includes(sentinela), `${name}: o nome, nunca o valor`);
  }
  const secret = await check([], [], execBlockOf([process.execPath, SCRIPT, 'sign'], [`GITHUB_TOKEN=${sentinela}`]));
  assert.equal(secret?.code, 'SECRET_VIA_ENV_FORBIDDEN');
  assert.ok(secret?.message.includes('GITHUB_TOKEN') && !secret.message.includes(sentinela));
  // registro sem "=" conta inteiro como nome; valor com bytes que não são UTF-8 nem é decodificado
  const raw = Buffer.concat([Buffer.from('PATH=/usr/bin\0NODE_OPTIONS=', 'latin1'), Buffer.from([0xff, 0xfe, 0x00])]);
  const binary = await check([], [], { cmdline: async () => nulBlock([process.execPath, SCRIPT]), environ: async () => raw });
  assert.equal(binary?.code, 'SIGN_RUNTIME_UNSAFE');
  assert.equal(await check([], ['NODE_ENV'], execBlockOf([process.execPath, SCRIPT, 'sign'], ['NODE_ENV=production', 'NODE=/usr/bin/node', 'PATH=/usr/bin'])), null, 'NODE_ENV e NODE continuam passando');
});

test('W4.6 (ii): bloco original ilegível (fora do Linux, ou sem --allow-fs-read para /proc/self/cmdline e /proc/self/environ sob --permission), vazio ou sem o nome do programa ⇒ SIGN_RUNTIME_UNSAFE (recusa fechada), sem o objeto de erro', async () => {
  const failing = (which: 'cmdline' | 'environ'): ExecBlockReader => ({
    cmdline: async () => (which === 'cmdline' ? Promise.reject(Object.assign(new Error('falha simulada /proc'), { code: 'ERR_ACCESS_DENIED' })) : nulBlock([process.execPath, SCRIPT])),
    environ: async () => (which === 'environ' ? Promise.reject(Object.assign(new Error('falha simulada /proc'), { code: 'ENOENT' })) : nulBlock([])),
  });
  for (const reader of [failing('cmdline'), failing('environ'), { cmdline: async () => new Uint8Array(0), environ: async () => new Uint8Array(0) }, { cmdline: async () => nulBlock(['']), environ: async () => new Uint8Array(0) }]) {
    const refusal = await check([], [], reader);
    assert.equal(refusal?.code, 'SIGN_RUNTIME_UNSAFE');
    assert.match(refusal?.message ?? '', /\/proc\/self/);
    assert.ok(!refusal?.message.includes('falha simulada'));
  }
});

test('W4.6 artefato único: sem o carregador do tsx; exige --permission (ou --experimental-permission) e --disable-sigusr1 em execArgv E na linha original, e o ambiente VAZIO (env -i) no original e em process.env', async () => {
  const ARTIFACT = '/srv/estacao/artefato/link-audit-sign.cjs';
  const line = ['--disable-sigusr1', '--permission', '--allow-fs-read=/srv/estacao/artefato', '--allow-fs-write=/srv/estacao/manifestos'];
  const artifact = (execArgv: readonly string[], cmdlineOptions: readonly string[] = execArgv, environ: readonly string[] = [], envNames: readonly string[] = []) => check(execArgv, envNames, execBlockOf(['/usr/bin/node', ...cmdlineOptions, ARTIFACT, 'sign', '--json'], environ), true);
  assert.equal(await artifact(line), null, 'a linha do runbook passa');
  assert.equal(await artifact(['--experimental-permission', '--disable-sigusr1', '--allow-fs-read=/srv/estacao/artefato']), null, 'o nome antigo do modelo de permissões');
  const refused: ReadonlyArray<readonly [string, Promise<Awaited<ReturnType<typeof check>>>, RegExp]> = [
    ['sem --permission', artifact(['--disable-sigusr1', '--allow-fs-read=/srv/a']), /--permission/],
    ['sem --disable-sigusr1', artifact(['--permission', '--allow-fs-read=/srv/a']), /--disable-sigusr1/],
    ['--permission só em execArgv (a linha original não tem)', artifact(line, ['--disable-sigusr1', '--allow-fs-read=/srv/a']), /--permission/],
    ['carregador do tsx', artifact([...line, ...TSX_ARGV]), /opções além/],
    ['ambiente original não vazio', artifact(line, line, ['PATH=/usr/bin', 'LANG=C.UTF-8']), /env -i/],
    ['process.env não vazio', artifact(line, line, [], ['HOME']), /env -i/],
  ];
  for (const [label, pending, message] of refused) {
    const refusal = await pending;
    assert.equal(refusal?.code, 'SIGN_RUNTIME_UNSAFE', label);
    assert.match(refusal?.message ?? '', message, label);
  }
  const named = await artifact(line, line, ['PATH=/usr/bin', 'LANG=C.UTF-8', 'TERM=xterm', 'SHELL=/bin/sh']);
  assert.ok(named?.message.includes('PATH') && !named.message.includes('/usr/bin'), 'cita até 3 nomes, nunca valores');
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

test('W4.6 (ii) pelo CLI: o padrão do bloco original é /proc/self; injetado com NODE_OPTIONS só no ambiente ORIGINAL (process.env limpo) ⇒ SIGN_RUNTIME_UNSAFE antes de ler qualquer arquivo, do terminal e da chave', async () => {
  const world = cliWorld();
  for (const subcommand of ['sign', 'close-key'] as const) {
    const data = spyOps<BytesFsOps>(nodeFsOps);
    const run = await runSealSubcommand(subcommand, world.argv(), { typed: world.typed(), fs: data.ops, execBlock: execBlockOf([process.execPath, SCRIPT, subcommand], ['NODE_OPTIONS=--heapsnapshot-signal=SIGUSR2']) });
    refusedRuntime(run, `${subcommand}: NODE_OPTIONS só no ambiente original`);
    assert.equal(data.calls.length, 0, `${subcommand}: nada lido`);
    assert.ok(run.stderr.includes('NODE_OPTIONS') && !run.stderr.includes('heapsnapshot'));
  }
});

/* =============================================================================================================== W4.6 (decisão 3): sondagem de fsync */

test('W4.6 (decisão 3): sondagem antecipada de fsync na raiz de --seals-dir; "blocked" (o node bloqueia fsync sob --permission) ⇒ SIGN_RUNTIME_NO_FSYNC (código 3) no sign e no close-key, DEPOIS do analisador e ANTES de ler qualquer entrada, da confirmação, da custódia e da frase; "ok" e "unprobed" seguem', async () => {
  const world = cliWorld();
  const closeArgv = ['--retired-key-id', 'ek-cli-fecho-r', '--seals-dir', world.sealsDir, '--receipts-dir', tmpDir('lasr-rec-'), '--key-id', world.key.keyId, '--key-source', `file:${world.key.keyPath}`, '--custodian', 'CUST-01', '--trust-keys', world.key.ring];
  for (const [subcommand, argv] of [['sign', world.argv()], ['close-key', closeArgv]] as const) {
    const probed: string[] = [];
    const data = spyOps<BytesFsOps>(nodeFsOps);
    const key = spyOps<KeyFileOps>(nodeKeyFileOps);
    const run = await runSealSubcommand(subcommand, argv, { typed: world.typed(), fs: data.ops, keyFs: key.ops, fsyncProbe: async (dir) => (probed.push(dir), 'blocked') });
    assert.equal(run.code, 3, `${subcommand}: ${run.stderr}`);
    const at = run.err.findIndex((line) => line.startsWith('RECUSADO: '));
    assert.equal(run.err[at + 1], 'Código: SIGN_RUNTIME_NO_FSYNC', subcommand);
    assert.match(run.err[at] ?? '', /bloqueia fsync sob --permission/);
    assert.match(run.err[at] ?? '', /versão do node fixada no runbook/);
    assert.match(run.err[at] ?? '', /Nada foi lido nem assinado/);
    assert.deepEqual(probed, [world.sealsDir], `${subcommand}: a sonda recebe a raiz de --seals-dir`);
    assert.equal(data.calls.length, 0, `${subcommand}: nenhuma entrada lida`);
    assert.ok(key.calls.every((call) => call.op === 'realpath'), `${subcommand}: da chave, nada`);
    assert.deepEqual([run.terminal.rawCalls, run.terminal.reads], [[], 0], `${subcommand}: terminal intocado (nem confirmação nem frase)`);
    const json = await runSealSubcommand(subcommand, [...argv, '--json'], { typed: world.typed(), fsyncProbe: async () => 'blocked' });
    assert.equal((JSON.parse(json.out[0] ?? '{}') as Record<string, unknown>).code, 'SIGN_RUNTIME_NO_FSYNC');
    const usageFirst = await runSealSubcommand(subcommand, ['--foo'], { typed: world.typed(), fsyncProbe: async () => 'blocked' });
    assert.equal(usageFirst.code, 1, `${subcommand}: o analisador vem antes da sonda`);
    const barrierFirst = await runSealSubcommand(subcommand, argv, { typed: world.typed(), execArgv: ['--expose-gc'], fsyncProbe: async () => 'blocked' });
    assert.match(barrierFirst.stderr, /Código: SIGN_RUNTIME_UNSAFE/, `${subcommand}: a barreira do runtime vem antes da sonda`);
  }
  for (const result of ['ok', 'unprobed'] as const) {
    const fresh = cliWorld();
    const run = await runSealSubcommand('sign', fresh.argv(), { typed: fresh.typed(), fsyncProbe: async () => result });
    assert.equal(run.code, 0, `sonda "${result}": o sign segue e assina: ${run.stderr}`);
  }
});

test('W4.6 (decisão 3): a sonda real (nodeFsyncProbe) abre a pasta só para leitura e sincroniza o descritor: pasta comum ⇒ "ok"; inexistente ou arquivo ⇒ "unprobed" (o fluxo normal decide); nada é gravado', async () => {
  const dir = tmpDir('lasr-sonda-');
  assert.equal(await nodeFsyncProbe(dir), 'ok');
  assert.deepEqual(fs.readdirSync(dir), [], 'nada gravado');
  assert.equal(await nodeFsyncProbe(path.join(dir, 'nao-existe')), 'unprobed');
  const file = path.join(dir, 'arquivo');
  fs.writeFileSync(file, 'x');
  assert.equal(await nodeFsyncProbe(file), 'unprobed');
});

/* =============================================================================================================== processo REAL (tsx) */

const hasTsx = fs.existsSync(TSX);
function realRun(args: readonly string[], env: Readonly<Record<string, string>>): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync(TSX, args, { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
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

test('W4.6 (ii) em processo REAL: uma pré-carga (NODE_OPTIONS=--require …) que apaga NODE_OPTIONS de process.env antes do comando não engana a barreira: o ambiente ORIGINAL (/proc/self/environ) ainda o tem ⇒ SIGN_RUNTIME_UNSAFE (código 3)', { skip: !hasTsx && 'tsx ausente' }, () => {
  const dir = tmpDir('lasr-preload-');
  const preload = path.join(dir, 'limpa-ambiente.cjs');
  fs.writeFileSync(preload, "delete process.env.NODE_OPTIONS;\nprocess.stderr.write('PRELOAD_RODOU\\n');\n");
  // exatamente o que o tsx põe no processo filho (o par do carregador), mais a pré-carga por NODE_OPTIONS
  const result = spawnSync(process.execPath, [...TSX_ARGV, SCRIPT, 'sign'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_OPTIONS: `--require ${preload}` } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
  assert.match(result.stderr, /PRELOAD_RODOU/, 'a pré-carga rodou antes do comando');
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /Código: SIGN_RUNTIME_UNSAFE/);
  assert.ok(result.stderr.includes('NODE_OPTIONS') && !result.stderr.includes(preload), 'cita o nome, nunca o valor');
  const clean = spawnSync(process.execPath, [...TSX_ARGV, SCRIPT, 'sign'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
  assert.equal(clean.status, 1, `sem a pré-carga, o mesmo processo passa pela barreira (USAGE): ${clean.stderr}`);
});
