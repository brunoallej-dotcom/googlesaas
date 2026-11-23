import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { isYamlMap, parseYamlSubset } from './helpers/yaml-subset';

/*
 * P9.4 (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5.1, §5.6 e §5.9): os scripts do job `deploy` (deploy/ci/*.sh) e as duas
 * conferências escritas no próprio workflow (CI verde e cabeça da `main`, que rodam antes do checkout) executados de verdade, numa pasta
 * temporária que imita a raiz do repositório, com `docker`, `ssh`, `curl`, `git`, `gh`, `sleep` e `date` FALSOS no PATH. Nada aqui abre rede,
 * chama Docker ou SSH reais, nem lê segredo: os valores são sentinelas fictícias, e cada teste confere que elas não vazam para a saída.
 */
const ROOT = path.join(__dirname, '..');
const CI_DIR = path.join(ROOT, 'deploy', 'ci');
const WORKFLOW = parseYamlSubset(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8'));
const FAKES = ['docker', 'ssh', 'curl', 'git', 'gh', 'sleep', 'date'] as const;

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const HOST_SENTINEL = 'vps-sentinela.invalid';
const PUBLIC_HOST_SENTINEL = 'hml-sentinela.invalid';
const SUPABASE_URL_SENTINEL = 'https://laboratorio-sentinela.invalid';
const ANON_SENTINEL = 'anon-sentinela-de-teste';
// Moldura montada por partes: o texto literal completo dispararia o scanner de segredos do CI.
const PEM_LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ');
const KEY_SENTINEL = `-----BEGIN ${PEM_LABEL}-----\nsentinela-chave-falsa\n-----END ${PEM_LABEL}-----`;
const KNOWN_HOSTS_LINE = `${HOST_SENTINEL} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake`;
const TRUST_LIST = 'ensaio-a1b2:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2:active\n';
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const HEX64_A = 'a'.repeat(64);
const IMAGE_WEB = `sha256:${'1'.repeat(64)}`;
const IMAGE_WORKER = `sha256:${'2'.repeat(64)}`;

/** Gramática do receptor de deploy (spec §5.6), do lado de quem chama. */
const UPLOAD_GRAMMAR = /^upload [0-9a-f]{40} [0-9a-f]{64} (?:[1-9][0-9]{0,9})$/;
const DEPLOY_GRAMMAR = /^deploy [0-9a-f]{40} [0-9a-f]{64} [0-9a-f]{64} (?:[0-9a-f]{64}|-) [0-9a-f]{64} [0-9a-f]{12}$/;
const EXPECTED_SSH_OPTIONS = (sshDir: string): string[] => [
  '-F', '/dev/null', '-T',
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${sshDir}/known_hosts`, '-o', 'GlobalKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15',
];

interface FakeResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly rc?: number;
}
interface FakeRule {
  readonly match?: readonly string[];
  /** Trechos que o stdin tem de conter (só para comandos em `readStdin`). */
  readonly matchStdin?: readonly string[];
  readonly responses: readonly FakeResponse[];
}
interface Scenario {
  readonly commands?: Readonly<Record<string, readonly FakeRule[]>>;
  readonly readStdin?: readonly string[];
  readonly recordEnv?: readonly string[];
}
interface FakeCall {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly stdinSha256?: string;
  readonly stdinBytes?: number;
}
interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
interface Sandbox {
  readonly root: string;
  readonly fakeDir: string;
  readonly runnerTemp: string;
  readonly sshDir: string;
  readonly bundleFile: string;
  readonly outputFile: string;
  readonly summaryFile: string;
}

/** Comando falso: registra argv, as variáveis pedidas e o sha256 do stdin; responde pela primeira regra cujo `match` casa o argv. */
const FAKE_IMPL = `'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const name = process.argv[2];
const argv = process.argv.slice(3);
const dir = process.env.FAKE_DIR;
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const entry = { argv, env: {} };
for (const key of scenario.recordEnv || []) if (process.env[key] !== undefined) entry.env[key] = process.env[key];
let stdinText = '';
if ((scenario.readStdin || []).includes(name)) {
  const data = fs.readFileSync(0);
  stdinText = data.toString('utf8');
  entry.stdinBytes = data.length;
  entry.stdinSha256 = crypto.createHash('sha256').update(data).digest('hex');
}
fs.appendFileSync(path.join(dir, name + '.calls.jsonl'), JSON.stringify(entry) + '\\n');
const rules = (scenario.commands || {})[name] || [];
const index = rules.findIndex((rule) => (rule.match || []).every((m) => argv.some((a) => a.includes(m))) && (rule.matchStdin || []).every((m) => stdinText.includes(m)));
if (index >= 0) {
  const counter = path.join(dir, name + '.' + index + '.count');
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  const responses = rules[index].responses;
  const response = responses[Math.min(n, responses.length - 1)];
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.rc || 0;
}
`;

function makeSandbox(t: { after: (fn: () => void) => void }, scenario: Scenario = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-deploy-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ciDir = path.join(root, 'deploy', 'ci');
  fs.mkdirSync(ciDir, { recursive: true });
  for (const name of fs.readdirSync(CI_DIR)) fs.copyFileSync(path.join(CI_DIR, name), path.join(ciDir, name));
  fs.mkdirSync(path.join(root, 'deploy', 'hostinger'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy', 'hostinger', 'stack.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(root, 'deploy', 'hostinger', 'stack-hml.yml'), 'services: {}\nsecrets: {}\n');
  for (const amb of ['producao', 'homologacao']) {
    fs.mkdirSync(path.join(root, 'link-audit-seals', amb), { recursive: true });
    fs.writeFileSync(path.join(root, 'link-audit-seals', amb, 'trust-keys.txt'), amb === 'homologacao' ? TRUST_LIST : '');
  }
  const fakeDir = path.join(root, 'fake');
  const bin = path.join(fakeDir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(fakeDir, 'impl.cjs'), FAKE_IMPL);
  for (const name of FAKES) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${path.join(fakeDir, 'impl.cjs')}" ${name} "$@"\n`, { mode: 0o755 });
  }
  const runnerTemp = path.join(root, 'runner-temp');
  fs.mkdirSync(runnerTemp);
  const sandbox: Sandbox = {
    root,
    fakeDir,
    runnerTemp,
    sshDir: path.join(runnerTemp, 'gmn-ssh'),
    bundleFile: path.join(runnerTemp, 'gmn-bundle', 'gmn-images.tar.gz'),
    outputFile: path.join(root, 'github-output'),
    summaryFile: path.join(root, 'step-summary.md'),
  };
  setScenario(sandbox, scenario);
  return sandbox;
}

function setScenario(sandbox: Sandbox, scenario: Scenario): void {
  fs.writeFileSync(path.join(sandbox.fakeDir, 'scenario.json'), JSON.stringify(scenario));
  for (const name of fs.readdirSync(sandbox.fakeDir)) if (/\.(calls\.jsonl|count)$/.test(name)) fs.rmSync(path.join(sandbox.fakeDir, name));
  fs.rmSync(sandbox.outputFile, { force: true });
}

function baseEnv(sandbox: Sandbox, env: Record<string, string>): NodeJS.ProcessEnv {
  const vars: Record<string, string> = {
    PATH: `${path.join(sandbox.fakeDir, 'bin')}:/usr/bin:/bin`,
    LC_ALL: 'C',
    FAKE_DIR: sandbox.fakeDir,
    RUNNER_TEMP: sandbox.runnerTemp,
    GITHUB_OUTPUT: sandbox.outputFile,
    GITHUB_STEP_SUMMARY: sandbox.summaryFile,
    ...env,
  };
  return vars as unknown as NodeJS.ProcessEnv;
}

function runScript(sandbox: Sandbox, script: string, args: readonly string[], env: Record<string, string>): RunResult {
  const result = spawnSync('bash', [path.join(sandbox.root, 'deploy', 'ci', script), ...args], { cwd: sandbox.root, env: baseEnv(sandbox, env), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** O texto `run:` de um passo do workflow, executado como o Actions faz com `shell: bash` (bash -eo pipefail). */
function inlineRun(stepId: string): string {
  assert.ok(isYamlMap(WORKFLOW) && isYamlMap(WORKFLOW.jobs) && isYamlMap(WORKFLOW.jobs.deploy));
  const steps = WORKFLOW.jobs.deploy.steps;
  assert.ok(Array.isArray(steps));
  const step = steps.find((item) => isYamlMap(item) && item.id === stepId);
  assert.ok(isYamlMap(step) && typeof step.run === 'string', `passo ${stepId} com run`);
  return step.run;
}

function runInline(sandbox: Sandbox, stepId: string, env: Record<string, string>): RunResult {
  const file = path.join(sandbox.root, `step-${stepId}.sh`);
  fs.writeFileSync(file, inlineRun(stepId));
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], { cwd: sandbox.root, env: baseEnv(sandbox, env), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function calls(sandbox: Sandbox, name: string): FakeCall[] {
  const file = path.join(sandbox.fakeDir, `${name}.calls.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as FakeCall);
}

function outputs(sandbox: Sandbox): Record<string, string> {
  if (!fs.existsSync(sandbox.outputFile)) return {};
  return Object.fromEntries(fs.readFileSync(sandbox.outputFile, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

const assertNoLeak = (result: RunResult, ...sentinels: string[]): void => {
  for (const sentinel of sentinels) assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel), `vazou para a saída: ${sentinel.slice(0, 24)}`);
};
const assertRefused = (sandbox: Sandbox, result: RunResult, code: string, detail?: string): void => {
  assert.equal(result.status, 1, `saída 1 (${result.stderr.trim()})`);
  assert.match(result.stderr, new RegExp(`^ERRO ${code}${detail === undefined ? '' : ` ${detail}`}$`, 'm'));
  assert.equal(outputs(sandbox).code, code, 'código na saída do passo (para o resumo)');
};

/* ------------------------------------------------------------------------------------------------ build, pacote e hashes */

const BUILD_ENV = { GMN_AMB: 'homologacao', GMN_SHA: SHA, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL_SENTINEL, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_SENTINEL };
const GIT_HEAD = (sha: string): FakeRule[] => [{ match: ['rev-parse'], responses: [{ stdout: `${sha}\n` }] }];

test('P9.4 build: dois alvos, linux/amd64, tag <amb>-<sha40>, argumentos do build pelo AMBIENTE (sem =valor na linha de comando)', (t) => {
  const sandbox = makeSandbox(t, { commands: { git: GIT_HEAD(SHA) }, recordEnv: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] });
  const result = runScript(sandbox, 'build-images.sh', [], BUILD_ENV);
  assert.equal(result.status, 0, result.stderr);
  const builds = calls(sandbox, 'docker');
  assert.equal(builds.length, 2);
  for (const [i, target] of ['web', 'worker'].entries()) {
    const call = builds[i];
    assert.ok(call);
    assert.deepEqual(call.argv, [
      'build', '--platform', 'linux/amd64', '-f', 'deploy/hostinger/Dockerfile', '--target', target,
      '--build-arg', 'NEXT_PUBLIC_SUPABASE_URL', '--build-arg', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', '-t', `gmn-${target}:homologacao-${SHA}`, '.',
    ]);
    assert.equal(call.env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL_SENTINEL, 'o valor chega ao docker pelo ambiente');
    assert.equal(call.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, ANON_SENTINEL);
  }
  assertNoLeak(result, SUPABASE_URL_SENTINEL, ANON_SENTINEL);
});

test('P9.4 build: checkout de outro commit, argumento ausente ou URL sem https, ambiente ou SHA inválidos ⇒ recusa sem chamar o docker', (t) => {
  const sandbox = makeSandbox(t, { commands: { git: GIT_HEAD(OTHER_SHA) } });
  assertRefused(sandbox, runScript(sandbox, 'build-images.sh', [], BUILD_ENV), 'CHECKOUT_MISMATCH');
  setScenario(sandbox, { commands: { git: GIT_HEAD(SHA) } });
  assertRefused(sandbox, runScript(sandbox, 'build-images.sh', [], { ...BUILD_ENV, NEXT_PUBLIC_SUPABASE_URL: '' }), 'BUILD_CONFIG_MISSING', 'GMN_BUILD_SUPABASE_URL');
  setScenario(sandbox, { commands: { git: GIT_HEAD(SHA) } });
  assertRefused(sandbox, runScript(sandbox, 'build-images.sh', [], { ...BUILD_ENV, NEXT_PUBLIC_SUPABASE_ANON_KEY: '' }), 'BUILD_CONFIG_MISSING', 'GMN_BUILD_SUPABASE_ANON_KEY');
  setScenario(sandbox, { commands: { git: GIT_HEAD(SHA) } });
  assertRefused(sandbox, runScript(sandbox, 'build-images.sh', [], { ...BUILD_ENV, NEXT_PUBLIC_SUPABASE_URL: 'http://laboratorio-sentinela.invalid' }), 'BUILD_CONFIG_INVALID', 'GMN_BUILD_SUPABASE_URL');
  setScenario(sandbox, { commands: { git: GIT_HEAD(SHA) } });
  assertRefused(sandbox, runScript(sandbox, 'build-images.sh', [], { ...BUILD_ENV, GMN_AMB: 'staging' }), 'INPUT_INVALID', 'GMN_AMB');
  setScenario(sandbox, { commands: { git: GIT_HEAD(SHA) } });
  assertRefused(sandbox, runScript(sandbox, 'build-images.sh', [], { ...BUILD_ENV, GMN_SHA: SHA.toUpperCase() }), 'INPUT_INVALID', 'GMN_SHA');
  assert.equal(calls(sandbox, 'docker').length, 0);
  setScenario(sandbox, { commands: { git: GIT_HEAD(SHA), docker: [{ match: ['build'], responses: [{ rc: 1, stderr: 'saida do docker\n' }] }] } });
  const failed = runScript(sandbox, 'build-images.sh', [], BUILD_ENV);
  assertRefused(sandbox, failed, 'BUILD_FAILED', 'web');
});

test('P9.4 pacote: docker save das duas tags | gzip -n em $RUNNER_TEMP (0700/0600), sha256 e tamanho nas saídas', (t) => {
  const tar = 'conteudo-falso-do-docker-save';
  const sandbox = makeSandbox(t, { commands: { docker: [{ match: ['save'], responses: [{ stdout: tar }] }] } });
  const result = runScript(sandbox, 'bundle.sh', [], { GMN_AMB: 'producao', GMN_SHA: SHA });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(sandbox, 'docker').map((call) => call.argv), [['save', `gmn-web:producao-${SHA}`, `gmn-worker:producao-${SHA}`]]);
  const bundle = fs.readFileSync(sandbox.bundleFile);
  assert.equal(gunzipSync(bundle).toString(), tar);
  assert.equal((bundle[3] ?? 0) & 0x08, 0, 'gzip -n: sem nome de arquivo no cabeçalho');
  assert.equal(bundle.readUInt32LE(4), 0, 'gzip -n: sem data no cabeçalho');
  assert.equal(fs.statSync(path.dirname(sandbox.bundleFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(sandbox.bundleFile).mode & 0o777, 0o600);
  assert.deepEqual(outputs(sandbox), { sha256: sha256(bundle), bytes: String(bundle.length) });
});

test('P9.4 pacote: docker save falhando ⇒ BUNDLE_FAILED (pipefail), nunca um pacote vazio aceito', (t) => {
  const sandbox = makeSandbox(t, { commands: { docker: [{ match: ['save'], responses: [{ rc: 1 }] }] } });
  assertRefused(sandbox, runScript(sandbox, 'bundle.sh', [], { GMN_AMB: 'producao', GMN_SHA: SHA }), 'BUNDLE_FAILED');
});

test('P9.4 hashes declarados: stack, sobreposição só em homologação ("-" em produção) e lista do ambiente; arquivo ausente, link ou lista acima de 8 KiB ⇒ recusa', (t) => {
  const sandbox = makeSandbox(t);
  const stackSha = sha256('services: {}\n');
  assert.equal(runScript(sandbox, 'declared-hashes.sh', [], { GMN_AMB: 'producao' }).status, 0);
  assert.deepEqual(outputs(sandbox), { stack_sha256: stackSha, overlay_sha256: '-', trust_sha256: sha256('') });
  setScenario(sandbox, {});
  assert.equal(runScript(sandbox, 'declared-hashes.sh', [], { GMN_AMB: 'homologacao' }).status, 0);
  assert.deepEqual(outputs(sandbox), { stack_sha256: stackSha, overlay_sha256: sha256('services: {}\nsecrets: {}\n'), trust_sha256: sha256(TRUST_LIST) });

  const trust = path.join(sandbox.root, 'link-audit-seals', 'producao', 'trust-keys.txt');
  fs.writeFileSync(trust, 'x'.repeat(8193));
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'declared-hashes.sh', [], { GMN_AMB: 'producao' }), 'TRUST_LIST_TOO_LARGE');
  fs.rmSync(trust);
  fs.symlinkSync(path.join(sandbox.root, 'link-audit-seals', 'homologacao', 'trust-keys.txt'), trust);
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'declared-hashes.sh', [], { GMN_AMB: 'producao' }), 'HASH_INPUT_MISSING', 'trust-keys.txt');
  fs.rmSync(path.join(sandbox.root, 'deploy', 'hostinger', 'stack-hml.yml'));
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'declared-hashes.sh', [], { GMN_AMB: 'homologacao' }), 'HASH_INPUT_MISSING', 'stack-hml.yml');
});

/* ------------------------------------------------------------------------------------------------ chave SSH */

test('P9-W08 chave: escrita em $RUNNER_TEMP/gmn-ssh (0700) com arquivos 0600; nada impresso', (t) => {
  const sandbox = makeSandbox(t);
  const result = runScript(sandbox, 'ssh-setup.sh', [], { GMN_DEPLOY_SSH_KEY: KEY_SENTINEL, GMN_SSH_KNOWN_HOSTS: KNOWN_HOSTS_LINE });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(sandbox.sshDir).mode & 0o777, 0o700);
  for (const name of ['id_deploy', 'known_hosts']) assert.equal(fs.statSync(path.join(sandbox.sshDir, name)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(sandbox.sshDir, 'id_deploy'), 'utf8'), `${KEY_SENTINEL}\n`);
  assert.equal(fs.readFileSync(path.join(sandbox.sshDir, 'known_hosts'), 'utf8'), `${KNOWN_HOSTS_LINE}\n`);
  assertNoLeak(result, 'sentinela-chave-falsa', HOST_SENTINEL);
});

test('P9-W07 chave: known_hosts vazio, com marcador, curinga ou lixo, e chave sem a moldura OpenSSH ⇒ recusa sem escrever nada (sem TOFU)', (t) => {
  const sandbox = makeSandbox(t);
  const cases: Array<[Record<string, string>, string, string]> = [
    [{ GMN_DEPLOY_SSH_KEY: '', GMN_SSH_KNOWN_HOSTS: KNOWN_HOSTS_LINE }, 'SSH_CONFIG_MISSING', 'GMN_DEPLOY_SSH_KEY'],
    [{ GMN_DEPLOY_SSH_KEY: KEY_SENTINEL, GMN_SSH_KNOWN_HOSTS: '' }, 'SSH_CONFIG_MISSING', 'GMN_SSH_KNOWN_HOSTS'],
    [{ GMN_DEPLOY_SSH_KEY: 'sentinela-chave-falsa', GMN_SSH_KNOWN_HOSTS: KNOWN_HOSTS_LINE }, 'SSH_CONFIG_INVALID', 'GMN_DEPLOY_SSH_KEY'],
    [{ GMN_DEPLOY_SSH_KEY: KEY_SENTINEL, GMN_SSH_KNOWN_HOSTS: `@cert-authority ${KNOWN_HOSTS_LINE}` }, 'SSH_CONFIG_INVALID', 'GMN_SSH_KNOWN_HOSTS'],
    [{ GMN_DEPLOY_SSH_KEY: KEY_SENTINEL, GMN_SSH_KNOWN_HOSTS: KNOWN_HOSTS_LINE.replace(HOST_SENTINEL, '*') }, 'SSH_CONFIG_INVALID', 'GMN_SSH_KNOWN_HOSTS'],
    [{ GMN_DEPLOY_SSH_KEY: KEY_SENTINEL, GMN_SSH_KNOWN_HOSTS: `${KNOWN_HOSTS_LINE}\nlixo` }, 'SSH_CONFIG_INVALID', 'GMN_SSH_KNOWN_HOSTS'],
  ];
  for (const [env, code, detail] of cases) {
    setScenario(sandbox, {});
    const result = runScript(sandbox, 'ssh-setup.sh', [], env);
    assertRefused(sandbox, result, code, detail);
    assertNoLeak(result, 'sentinela-chave-falsa', HOST_SENTINEL);
    assert.ok(!fs.existsSync(sandbox.sshDir), 'nada escrito');
  }
});

/* ------------------------------------------------------------------------------------------------ receptor de deploy por SSH */

interface ReceiverFixture {
  readonly sandbox: Sandbox;
  readonly bundleSha: string;
  readonly bundleBytes: string;
}
function receiverFixture(t: { after: (fn: () => void) => void }, sshResponses: readonly FakeResponse[]): ReceiverFixture {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.sshDir, { mode: 0o700 });
  fs.writeFileSync(path.join(sandbox.sshDir, 'id_deploy'), `${KEY_SENTINEL}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(sandbox.sshDir, 'known_hosts'), `${KNOWN_HOSTS_LINE}\n`, { mode: 0o600 });
  fs.mkdirSync(path.dirname(sandbox.bundleFile), { mode: 0o700 });
  fs.writeFileSync(sandbox.bundleFile, 'pacote-falso');
  setScenario(sandbox, { commands: { ssh: [{ responses: sshResponses }] }, readStdin: ['ssh'] });
  return { sandbox, bundleSha: sha256('pacote-falso'), bundleBytes: String('pacote-falso'.length) };
}
const uploadEnv = (fixture: ReceiverFixture, extra: Record<string, string> = {}): Record<string, string> => ({
  GMN_AMB: 'producao', GMN_SHA: SHA, GMN_SSH_HOST: HOST_SENTINEL, GMN_BUNDLE_SHA256: fixture.bundleSha, GMN_BUNDLE_BYTES: fixture.bundleBytes, ...extra,
});
const deployEnv = (fixture: ReceiverFixture, amb: 'producao' | 'homologacao', extra: Record<string, string> = {}): Record<string, string> => ({
  GMN_AMB: amb,
  GMN_SHA: SHA,
  GMN_SSH_HOST: HOST_SENTINEL,
  GMN_BUILD_SUPABASE_URL: SUPABASE_URL_SENTINEL,
  GMN_BUNDLE_SHA256: fixture.bundleSha,
  GMN_STACK_SHA256: HEX64_A,
  GMN_OVERLAY_SHA256: amb === 'producao' ? '-' : 'b'.repeat(64),
  GMN_TRUST_SHA256: sha256(amb === 'producao' ? '' : TRUST_LIST),
  ...extra,
});
const deployedLine = (amb: string, overlay: string, trust: string): string => `OK DEPLOYED ${amb}-${SHA} ${IMAGE_WEB} ${IMAGE_WORKER} ${HEX64_A} ${overlay} ${trust}\n`;

test('P9-W07 P9-D01 (lado do workflow) upload: opções fixas do ssh, usuário do ambiente, porta 22 por padrão, comando na gramática e o pacote no stdin', (t) => {
  const fixture = receiverFixture(t, [{ stdout: `OK UPLOADED ${SHA} ${sha256('pacote-falso')}\n` }]);
  const result = runScript(fixture.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(fixture));
  assert.equal(result.status, 0, result.stderr);
  const [call] = calls(fixture.sandbox, 'ssh');
  assert.ok(call);
  const sshDir = fixture.sandbox.sshDir;
  assert.deepEqual(call.argv, [...EXPECTED_SSH_OPTIONS(sshDir), '-i', `${sshDir}/id_deploy`, '-p', '22', '--', `gmn-deploy@${HOST_SENTINEL}`, `upload ${SHA} ${fixture.bundleSha} ${fixture.bundleBytes}`]);
  assert.match(call.argv[call.argv.length - 1] ?? '', UPLOAD_GRAMMAR);
  assert.equal(call.stdinSha256, fixture.bundleSha, 'o pacote vai no stdin');
  assert.match(result.stdout, new RegExp(`^OK UPLOADED ${SHA} ${fixture.bundleSha}$`, 'm'));
  assertNoLeak(result, HOST_SENTINEL);

  setScenario(fixture.sandbox, { commands: { ssh: [{ responses: [{ stdout: `OK UPLOADED ${SHA} ${fixture.bundleSha}\n` }] }] }, readStdin: ['ssh'] });
  assert.equal(runScript(fixture.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(fixture, { GMN_AMB: 'homologacao', GMN_SSH_PORT: '2222' })).status, 0);
  const [hml] = calls(fixture.sandbox, 'ssh');
  assert.ok(hml);
  assert.deepEqual(hml.argv.slice(-4, -1), ['2222', '--', `gmn-hml-deploy@${HOST_SENTINEL}`], 'homologação: usuário próprio, porta do segredo');
});

test('P9.4 upload: host ou porta fora do padrão (inclusive opção disfarçada de host), pacote mudado ou chave ausente ⇒ recusa sem chamar o ssh', (t) => {
  const fixture = receiverFixture(t, [{ stdout: 'nao-deveria-ser-chamado\n' }]);
  const cases: Array<[Record<string, string>, string, string]> = [
    [{ GMN_SSH_HOST: '-oProxyCommand=sentinela' }, 'SSH_CONFIG_INVALID', 'GMN_SSH_HOST'],
    [{ GMN_SSH_HOST: `${HOST_SENTINEL} extra` }, 'SSH_CONFIG_INVALID', 'GMN_SSH_HOST'],
    [{ GMN_SSH_PORT: '0' }, 'SSH_CONFIG_INVALID', 'GMN_SSH_PORT'],
    [{ GMN_SSH_PORT: '70000' }, 'SSH_CONFIG_INVALID', 'GMN_SSH_PORT'],
    [{ GMN_SSH_PORT: '22 -v' }, 'SSH_CONFIG_INVALID', 'GMN_SSH_PORT'],
    [{ GMN_BUNDLE_BYTES: '999' }, 'BUNDLE_CHANGED', ''],
    [{ GMN_BUNDLE_SHA256: 'xyz' }, 'INPUT_INVALID', 'GMN_BUNDLE_SHA256'],
  ];
  for (const [extra, code, detail] of cases) {
    setScenario(fixture.sandbox, { readStdin: ['ssh'] });
    assertRefused(fixture.sandbox, runScript(fixture.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(fixture, extra)), code, detail === '' ? undefined : detail);
  }
  fs.rmSync(path.join(fixture.sandbox.sshDir, 'id_deploy'));
  setScenario(fixture.sandbox, { readStdin: ['ssh'] });
  assertRefused(fixture.sandbox, runScript(fixture.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(fixture)), 'SSH_CONFIG_MISSING', 'id_deploy');
  assert.equal(calls(fixture.sandbox, 'ssh').length, 0);
});

test('P9.4 upload: ssh sem conexão (255) ⇒ SSH_CONNECT_FAILED com dica fixa; o stderr do ssh (host, endereço) nunca chega ao log', (t) => {
  const cases: Array<[string, string]> = [
    [`ssh: connect to host ${HOST_SENTINEL} port 22: Connection refused\n`, 'OTHER'],
    [`@@@ WARNING @@@\nHost key for ${HOST_SENTINEL} has changed\nHost key verification failed.\n`, 'HOST_KEY'],
    [`gmn-deploy@${HOST_SENTINEL}: Permission denied (publickey).\n`, 'AUTH'],
  ];
  for (const [stderr, hint] of cases) {
    const fixture = receiverFixture(t, [{ rc: 255, stderr }]);
    const result = runScript(fixture.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(fixture));
    assertRefused(fixture.sandbox, result, 'SSH_CONNECT_FAILED', hint);
    assertNoLeak(result, HOST_SENTINEL, 'Connection refused', 'WARNING');
  }
});

test('P9.4 receptor: só a linha pública `ERRO E_…` do receptor passa (sem caminho nem saída do Docker); outra saída ⇒ RECEIVER_FAILED / RECEIVER_BAD_OUTPUT', (t) => {
  const refused = receiverFixture(t, [{ rc: 13, stderr: 'ERRO E_HASH_MISMATCH\n/srv/caminho-real-sentinela/saida do docker\n' }]);
  const result = runScript(refused.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(refused));
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'ERRO E_HASH_MISMATCH\n');
  assert.equal(outputs(refused.sandbox).code, 'E_HASH_MISMATCH');
  assertNoLeak(result, 'caminho-real-sentinela', 'saida do docker');

  const detail = receiverFixture(t, [{ rc: 64, stderr: 'ERRO E_POSTDEPLOY_CHECK PD-07\n' }]);
  const pd = runScript(detail.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(detail));
  assert.equal(pd.stderr, 'ERRO E_POSTDEPLOY_CHECK PD-07\n');

  const garbage = receiverFixture(t, [{ rc: 1, stderr: 'Traceback /opt/caminho-sentinela\n' }]);
  const failed = runScript(garbage.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(garbage));
  assertRefused(garbage.sandbox, failed, 'RECEIVER_FAILED', 'EXIT_1');
  assertNoLeak(failed, 'caminho-sentinela');

  const wrong = receiverFixture(t, [{ stdout: `OK UPLOADED ${OTHER_SHA} ${HEX64_A}\n` }]);
  assertRefused(wrong.sandbox, runScript(wrong.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(wrong)), 'RECEIVER_BAD_OUTPUT', 'upload');
  const extra = receiverFixture(t, [{ stdout: `OK UPLOADED ${SHA} ${sha256('pacote-falso')}\nmais uma linha\n` }]);
  assertRefused(extra.sandbox, runScript(extra.sandbox, 'receiver-call.sh', ['upload'], uploadEnv(extra)), 'RECEIVER_BAD_OUTPUT', 'upload');
});

test('P9-D01 P9-D11 (lado do workflow) deploy em produção: overlay "-", lista no stdin, impressão do Supabase só no comando (nunca impressa), OK DEPLOYED conferido', (t) => {
  const trust = sha256('');
  const fixture = receiverFixture(t, [{ stdout: deployedLine('producao', '-', trust) }]);
  const result = runScript(fixture.sandbox, 'receiver-call.sh', ['deploy'], deployEnv(fixture, 'producao'));
  assert.equal(result.status, 0, result.stderr);
  const fp12 = sha256(SUPABASE_URL_SENTINEL).slice(0, 12);
  const [call] = calls(fixture.sandbox, 'ssh');
  assert.ok(call);
  const command = call.argv[call.argv.length - 1] ?? '';
  assert.equal(command, `deploy ${SHA} ${fixture.bundleSha} ${HEX64_A} - ${trust} ${fp12}`);
  assert.match(command, DEPLOY_GRAMMAR);
  assert.ok(command.length <= 512 && /^[\x20-\x7e]+$/.test(command), 'ASCII, até 512 bytes');
  assert.equal(call.stdinSha256, trust, 'a lista vai no stdin');
  assert.equal(call.argv[call.argv.length - 2], `gmn-deploy@${HOST_SENTINEL}`);
  assertNoLeak(result, fp12, SUPABASE_URL_SENTINEL, HOST_SENTINEL);
  assert.ok(!result.stdout.includes('::'), 'nenhum comando de workflow (nada de add-mask)');
  assert.deepEqual(outputs(fixture.sandbox), { web_image: IMAGE_WEB, worker_image: IMAGE_WORKER, trust_installed_sha256: trust });
});

test('P9-D01 (lado do workflow) deploy em homologação: overlay obrigatório; produção com overlay, homologação sem, lista mudada ou URL ausente ⇒ recusa sem ssh', (t) => {
  const trust = sha256(TRUST_LIST);
  const fixture = receiverFixture(t, [{ stdout: deployedLine('homologacao', 'b'.repeat(64), trust) }]);
  const ok = runScript(fixture.sandbox, 'receiver-call.sh', ['deploy'], deployEnv(fixture, 'homologacao'));
  assert.equal(ok.status, 0, ok.stderr);
  const [call] = calls(fixture.sandbox, 'ssh');
  assert.ok(call);
  assert.match(call.argv[call.argv.length - 1] ?? '', new RegExp(`^deploy ${SHA} [0-9a-f]{64} ${HEX64_A} ${'b'.repeat(64)} ${trust} [0-9a-f]{12}$`));
  assert.equal(call.argv[call.argv.length - 2], `gmn-hml-deploy@${HOST_SENTINEL}`);

  const cases: Array<[Record<string, string>, 'producao' | 'homologacao', string, string]> = [
    [{ GMN_OVERLAY_SHA256: 'b'.repeat(64) }, 'producao', 'INPUT_INVALID', 'GMN_OVERLAY_SHA256'],
    [{ GMN_OVERLAY_SHA256: '-' }, 'homologacao', 'INPUT_INVALID', 'GMN_OVERLAY_SHA256'],
    [{ GMN_TRUST_SHA256: HEX64_A }, 'producao', 'TRUST_LIST_CHANGED', ''],
    [{ GMN_BUILD_SUPABASE_URL: '' }, 'producao', 'BUILD_CONFIG_MISSING', 'GMN_BUILD_SUPABASE_URL'],
    [{ GMN_STACK_SHA256: '' }, 'producao', 'INPUT_INVALID', 'GMN_STACK_SHA256'],
  ];
  for (const [extra, amb, code, detail] of cases) {
    setScenario(fixture.sandbox, { readStdin: ['ssh'] });
    assertRefused(fixture.sandbox, runScript(fixture.sandbox, 'receiver-call.sh', ['deploy'], deployEnv(fixture, amb, extra)), code, detail === '' ? undefined : detail);
    assert.equal(calls(fixture.sandbox, 'ssh').length, 0);
  }
});

test('P9-D11 (lado do workflow) deploy: lista instalada diferente da enviada ⇒ vermelho (TRUST_LIST_INSTALLED_MISMATCH); tag de outro ambiente ⇒ RECEIVER_BAD_OUTPUT', (t) => {
  const mismatch = receiverFixture(t, [{ stdout: deployedLine('producao', '-', HEX64_A) }]);
  const result = runScript(mismatch.sandbox, 'receiver-call.sh', ['deploy'], deployEnv(mismatch, 'producao'));
  assertRefused(mismatch.sandbox, result, 'TRUST_LIST_INSTALLED_MISMATCH');
  assert.equal(outputs(mismatch.sandbox).trust_installed_sha256, HEX64_A, 'o hash instalado fica registrado para o resumo');
  const otherEnv = receiverFixture(t, [{ stdout: deployedLine('homologacao', '-', sha256('')) }]);
  assertRefused(otherEnv.sandbox, runScript(otherEnv.sandbox, 'receiver-call.sh', ['deploy'], deployEnv(otherEnv, 'producao')), 'RECEIVER_BAD_OUTPUT', 'deploy');
  const badImage = receiverFixture(t, [{ stdout: deployedLine('producao', '-', sha256('')).replace(IMAGE_WEB, 'sha256:xyz') }]);
  assertRefused(badImage.sandbox, runScript(badImage.sandbox, 'receiver-call.sh', ['deploy'], deployEnv(badImage, 'producao')), 'RECEIVER_BAD_OUTPUT', 'deploy');
});

/* ------------------------------------------------------------------------------------------------ verificação externa */

const curlRules = (login: readonly FakeResponse[], health: readonly FakeResponse[], evidence: readonly FakeResponse[]): FakeRule[] => [
  { matchStdin: ['/login"'], responses: login },
  { matchStdin: ['/api/system/health"'], responses: health },
  { matchStdin: ['/api/link-audit/evidence"'], responses: evidence },
];
const codes = (...values: string[]): FakeResponse[] => values.map((code) => ({ stdout: code }));
/** Relógio falso (`date +%s`): a sequência de leituras; a última se repete. */
const clock = (...values: number[]): FakeRule[] => [{ responses: values.map((value) => ({ stdout: `${value}\n` })) }];
const externalScenario = (curl: FakeRule[], time: FakeRule[] = clock(1000)): Scenario => ({ commands: { curl, date: time }, readStdin: ['curl'] });
const curlConfig = (p: string): string => sha256(`url = "https://${PUBLIC_HOST_SENTINEL}${p}"\n`);
const maxTimes = (sandbox: Sandbox): string[] => calls(sandbox, 'curl').map((call) => call.argv[call.argv.indexOf('--max-time') + 1] ?? '');

test('P9.4 verificação externa: EX-01 /login 200, EX-02 e EX-03 401, por https com TLS verificado, sem seguir redirecionamento, URL só pelo stdin; só ids e códigos no log', (t) => {
  const sandbox = makeSandbox(t, externalScenario(curlRules(codes('200'), codes('401'), codes('401'))));
  const result = runScript(sandbox, 'external-check.sh', [], { GMN_PUBLIC_HOST: PUBLIC_HOST_SENTINEL });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputs(sandbox).ex, 'EX-01:200 EX-02:401 EX-03:401');
  const curlCalls = calls(sandbox, 'curl');
  assert.deepEqual(curlCalls.map((call) => call.stdinSha256), ['/login', '/api/system/health', '/api/link-audit/evidence'].map(curlConfig), 'a URL vai na configuração do stdin');
  for (const call of curlCalls) {
    assert.equal(call.argv[0], '-q', '-q primeiro: ignora .curlrc');
    assert.deepEqual(call.argv.slice(-2), ['--config', '-']);
    for (const flag of ['--proto', '=https', '--tlsv1.2', '--max-redirs', '0', '--max-time']) assert.ok(call.argv.includes(flag), `curl ${flag}`);
    assert.ok(!call.argv.some((arg) => ['-k', '--insecure', '-L', '--location', '-b', '--cookie', '-u', '--user', '-H', '--header'].includes(arg)), 'sem -k, redirecionamento, cookie ou credencial');
    assert.ok(!call.argv.some((arg) => arg.includes(PUBLIC_HOST_SENTINEL) || arg.includes('https://')), 'nenhuma URL na linha de comando');
  }
  assert.deepEqual(maxTimes(sandbox), ['10', '10', '10']);
  assertNoLeak(result, PUBLIC_HOST_SENTINEL);
  assert.equal(calls(sandbox, 'sleep').length, 0);
});

test('P9.4 verificação externa: repete enquanto o web sobe; EX-02 aberto sem sessão (200) até o fim ⇒ EX_CHECK_FAILED EX-02; host inválido ⇒ recusa sem curl', (t) => {
  const sandbox = makeSandbox(t, externalScenario(curlRules(codes('000', '502', '200'), codes('401'), codes('401'))));
  const recovering = runScript(sandbox, 'external-check.sh', [], { GMN_PUBLIC_HOST: PUBLIC_HOST_SENTINEL });
  assert.equal(recovering.status, 0, recovering.stderr);
  assert.deepEqual(calls(sandbox, 'sleep').map((call) => call.argv), [['10'], ['10']]);

  setScenario(sandbox, externalScenario(curlRules(codes('200'), codes('200'), codes('401'))));
  const open = runScript(sandbox, 'external-check.sh', [], { GMN_PUBLIC_HOST: PUBLIC_HOST_SENTINEL });
  assertRefused(sandbox, open, 'EX_CHECK_FAILED', 'EX-02');
  assert.equal(outputs(sandbox).ex, 'EX-01:200 EX-02:200 EX-03:401');
  assert.equal(calls(sandbox, 'curl').length, 36, '12 tentativas, 3 verificações cada');
  assertNoLeak(open, PUBLIC_HOST_SENTINEL);

  setScenario(sandbox, externalScenario([]));
  assertRefused(sandbox, runScript(sandbox, 'external-check.sh', [], { GMN_PUBLIC_HOST: `https://${PUBLIC_HOST_SENTINEL}/x` }), 'EX_CONFIG_INVALID', 'GMN_PUBLIC_HOST');
  assert.equal(calls(sandbox, 'curl').length, 0);
});

test('P9.4 verificação externa: código impresso com saída do curl diferente de 0 (ex.: 28, prazo) não vale ⇒ 000 e EX_CHECK_FAILED', (t) => {
  const sandbox = makeSandbox(t, externalScenario(curlRules([{ stdout: '200', rc: 28 }], codes('401'), codes('401'))));
  const result = runScript(sandbox, 'external-check.sh', [], { GMN_PUBLIC_HOST: PUBLIC_HOST_SENTINEL });
  assertRefused(sandbox, result, 'EX_CHECK_FAILED', 'EX-01');
  assert.equal(outputs(sandbox).ex, 'EX-01:000 EX-02:401 EX-03:401');
});

test('P9.4 verificação externa: prazo de 2 min conferido antes de cada tentativa, e o --max-time de cada chamada limitado ao tempo que falta', (t) => {
  // início, conferência da tentativa 1, três chamadas e a conferência antes da espera a 1000; a tentativa 2 começa a 1125 (passou dos 120 s)
  const sandbox = makeSandbox(t, externalScenario(curlRules(codes('502'), codes('401'), codes('401')), clock(1000, 1000, 1000, 1000, 1000, 1000, 1125)));
  const late = runScript(sandbox, 'external-check.sh', [], { GMN_PUBLIC_HOST: PUBLIC_HOST_SENTINEL });
  assertRefused(sandbox, late, 'EX_CHECK_FAILED', 'EX-01');
  assert.equal(calls(sandbox, 'curl').length, 3, 'nenhuma tentativa depois do prazo');
  assert.deepEqual(calls(sandbox, 'sleep').map((call) => call.argv), [['10']]);

  // tentativa 2 a 1115 (faltam 5 s): as chamadas recebem --max-time 5, 2 e 1, e a espera seguinte já passou do prazo
  setScenario(sandbox, externalScenario(curlRules(codes('502'), codes('401'), codes('401')), clock(1000, 1000, 1000, 1000, 1000, 1000, 1115, 1115, 1118, 1119, 1200)));
  const bounded = runScript(sandbox, 'external-check.sh', [], { GMN_PUBLIC_HOST: PUBLIC_HOST_SENTINEL });
  assertRefused(sandbox, bounded, 'EX_CHECK_FAILED', 'EX-01');
  assert.deepEqual(maxTimes(sandbox), ['10', '10', '10', '5', '2', '1']);
  assert.equal(calls(sandbox, 'sleep').length, 1);
});

/* ------------------------------------------------------------------------------------------------ resumo do job */

const SUMMARY_OK: Record<string, string> = {
  GMN_AMB: 'producao', GMN_SHA: SHA, GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1',
  GMN_O_CI: 'success', GMN_O_HEAD: 'success', GMN_O_CHECKOUT: 'success', GMN_O_BUILD: 'success', GMN_O_BUNDLE: 'success',
  GMN_O_HASHES: 'success', GMN_O_SSH: 'success', GMN_O_UPLOAD: 'success', GMN_O_HEAD2: 'success', GMN_O_DEPLOY: 'success', GMN_O_EXTERNAL: 'success',
  GMN_V_BUNDLE_SHA256: 'c'.repeat(64), GMN_V_STACK_SHA256: HEX64_A, GMN_V_OVERLAY_SHA256: '-', GMN_V_TRUST_INSTALLED_SHA256: 'd'.repeat(64),
  GMN_V_WEB_IMAGE: IMAGE_WEB, GMN_V_WORKER_IMAGE: IMAGE_WORKER, GMN_V_EX: 'EX-01:200 EX-02:401 EX-03:401',
  // Variáveis que o resumo NUNCA lê: se aparecerem, vazou.
  GMN_SSH_HOST: HOST_SENTINEL, GMN_PUBLIC_HOST: PUBLIC_HOST_SENTINEL, GMN_BUILD_SUPABASE_URL: SUPABASE_URL_SENTINEL,
};
const summaryRow = (sandbox: Sandbox): string[] => {
  const row = fs.readFileSync(sandbox.summaryFile, 'utf8').split('\n').find((line) => line.startsWith('| `'));
  assert.ok(row, 'uma linha de dados');
  return row.split(' | ').map((cell) => cell.replace(/^\|? ?`|` ?\|?$/g, ''));
};

test('P9.4 resumo (§5.9): uma linha por execução com os campos públicos e a lista INSTALADA; nunca host, domínio nem URL do Supabase', (t) => {
  const sandbox = makeSandbox(t);
  const result = runScript(sandbox, 'summary.sh', [], SUMMARY_OK);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(sandbox.summaryFile, 'utf8');
  assert.match(text, /\| execução \| commit \| ambiente \| pacote sha256 \| stack sha256 \| sobreposição sha256 \| lista instalada sha256 \| imagem web \| imagem worker \| CI verde \| cabeça da `main` \| EX-01\.\.03 \| resultado \|/);
  assert.deepEqual(summaryRow(sandbox), [
    '123456 (tentativa 1)', SHA, 'producao', 'c'.repeat(64), HEX64_A, '-', 'd'.repeat(64), IMAGE_WEB, IMAGE_WORKER, 'sim', 'sim (início e antes do deploy)', 'EX-01:200 EX-02:401 EX-03:401', 'OK',
  ]);
  for (const sentinel of [HOST_SENTINEL, PUBLIC_HOST_SENTINEL, SUPABASE_URL_SENTINEL, sha256(SUPABASE_URL_SENTINEL).slice(0, 12)]) assert.ok(!text.includes(sentinel));
});

test('P9.4 resumo: o primeiro passo que falhou dá o resultado (código do passo ou FALHOU_<PASSO>); valor fora do padrão vira "-" (sem injeção de Markdown)', (t) => {
  const sandbox = makeSandbox(t);
  runScript(sandbox, 'summary.sh', [], { ...SUMMARY_OK, GMN_O_DEPLOY: 'failure', GMN_E_DEPLOY: 'E_STACK_FILE_MISMATCH', GMN_O_EXTERNAL: 'skipped', GMN_V_EX: '' });
  let row = summaryRow(sandbox);
  assert.equal(row[12], 'E_STACK_FILE_MISMATCH');
  assert.equal(row[11], '-');

  fs.rmSync(sandbox.summaryFile);
  runScript(sandbox, 'summary.sh', [], { ...SUMMARY_OK, GMN_O_HEAD2: 'failure', GMN_E_HEAD2: 'NOT_MAIN_HEAD', GMN_O_DEPLOY: 'skipped', GMN_O_EXTERNAL: 'skipped' });
  row = summaryRow(sandbox);
  assert.equal(row[10], 'NOT_MAIN_HEAD (antes do deploy)');
  assert.equal(row[12], 'NOT_MAIN_HEAD');

  fs.rmSync(sandbox.summaryFile);
  runScript(sandbox, 'summary.sh', [], { ...SUMMARY_OK, GMN_O_BUILD: 'failure', GMN_E_BUILD: 'build | `quebra`', GMN_V_WEB_IMAGE: 'sha256:abc | x', GMN_V_STACK_SHA256: `${HEX64_A}\n| injetado |` });
  row = summaryRow(sandbox);
  assert.equal(row[12], 'FALHOU_BUILD');
  assert.equal(row[7], '-');
  assert.equal(row[4], '-');
  assert.ok(!fs.readFileSync(sandbox.summaryFile, 'utf8').includes('injetado'));

  fs.rmSync(sandbox.summaryFile);
  runScript(sandbox, 'summary.sh', [], { ...SUMMARY_OK, GMN_O_UPLOAD: 'cancelled' });
  assert.equal(summaryRow(sandbox)[12], 'CANCELADO');
});

/* ------------------------------------------------------------------------------------------------ passos escritos no workflow */

const INLINE_ENV = { GMN_AMB: 'producao', GMN_SHA: SHA, GITHUB_REPOSITORY: 'dono-ficticio/repo-ficticio', GITHUB_SERVER_URL: 'https://github.example', GH_TOKEN: 'token-ficticio-de-teste' };

test('P9.4 CI verde (passo `ci`, antes do checkout): só a execução mais recente do ci.yml por push no SHA exato, concluída com success', (t) => {
  const sandbox = makeSandbox(t, { commands: { gh: [{ responses: [{ stdout: `${SHA} completed success\n` }] }] }, recordEnv: ['GH_TOKEN'] });
  const ok = runInline(sandbox, 'ci', INLINE_ENV);
  assert.equal(ok.status, 0, ok.stderr);
  const [call] = calls(sandbox, 'gh');
  assert.ok(call);
  assert.deepEqual(call.argv.slice(0, 4), ['api', '--method', 'GET', 'repos/dono-ficticio/repo-ficticio/actions/workflows/ci.yml/runs']);
  for (const param of [`head_sha=${SHA}`, 'event=push', 'branch=main']) assert.ok(call.argv.includes(param), param);
  assert.ok(call.argv.includes('--jq'));
  assert.ok(!call.argv.some((arg) => arg.includes('token-ficticio')), 'o token vai pelo ambiente');
  assert.equal(call.env.GH_TOKEN, 'token-ficticio-de-teste');

  const cases: Array<[string, number, string]> = [
    ['- - -\n', 0, 'CI_PENDING'],
    [`${SHA} in_progress -\n`, 0, 'CI_PENDING'],
    [`${OTHER_SHA} completed success\n`, 0, 'CI_PENDING'],
    [`${SHA} completed failure\n`, 0, 'CI_NOT_GREEN'],
    [`${SHA} completed cancelled\n`, 0, 'CI_NOT_GREEN'],
    ['', 1, 'GITHUB_API_FAILED'],
  ];
  for (const [stdout, rc, code] of cases) {
    setScenario(sandbox, { commands: { gh: [{ responses: [{ stdout, rc }] }] } });
    assertRefused(sandbox, runInline(sandbox, 'ci', INLINE_ENV), code);
  }
  setScenario(sandbox, {});
  assertRefused(sandbox, runInline(sandbox, 'ci', { ...INLINE_ENV, GMN_SHA: 'main' }), 'INPUT_INVALID');
  assert.equal(calls(sandbox, 'gh').length, 0);
});

test('P9-W11 cabeça da main (passos `head` e `head2`): leitura pela API do GitHub com o token do job no ambiente (nada montado, nada mascarado); outro commit, várias linhas ou falha ⇒ NOT_MAIN_HEAD', (t) => {
  for (const stepId of ['head', 'head2']) {
    const sandbox = makeSandbox(t, { commands: { gh: [{ responses: [{ stdout: `${SHA}\n` }] }] }, recordEnv: ['GH_TOKEN'] });
    const ok = runInline(sandbox, stepId, INLINE_ENV);
    assert.equal(ok.status, 0, ok.stderr);
    const [call] = calls(sandbox, 'gh');
    assert.ok(call);
    assert.deepEqual(call.argv, ['api', '--method', 'GET', 'repos/dono-ficticio/repo-ficticio/git/ref/heads/main', '--jq', '.object.sha']);
    assert.deepEqual(call.env, { GH_TOKEN: 'token-ficticio-de-teste' }, 'o token só pelo ambiente');
    assert.ok(!ok.stdout.includes('::'), 'nenhum comando de workflow (nada de add-mask)');
    assertNoLeak(ok, 'token-ficticio-de-teste');

    const cases: Array<[string, number]> = [[`${OTHER_SHA}\n`, 0], [`${SHA}\n${SHA}\n`, 0], ['', 1], [`${SHA.slice(0, 39)}\n`, 0], ['null\n', 0]];
    for (const [stdout, rc] of cases) {
      setScenario(sandbox, { commands: { gh: [{ responses: [{ stdout, rc }] }] } });
      assertRefused(sandbox, runInline(sandbox, stepId, INLINE_ENV), 'NOT_MAIN_HEAD');
    }
    setScenario(sandbox, {});
    assertRefused(sandbox, runInline(sandbox, stepId, { ...INLINE_ENV, GITHUB_REPOSITORY: 'dono/repo;x' }), 'INPUT_INVALID');
    assert.equal(calls(sandbox, 'gh').length, 0);
  }
});

test('P9.4 resumo recusado antes do checkout: registra o código da primeira conferência, sem nada além de execução, commit e ambiente', (t) => {
  const sandbox = makeSandbox(t);
  const step = 'Resumo do job (recusado antes do checkout)';
  assert.ok(isYamlMap(WORKFLOW) && isYamlMap(WORKFLOW.jobs) && isYamlMap(WORKFLOW.jobs.deploy) && Array.isArray(WORKFLOW.jobs.deploy.steps));
  const fallback = WORKFLOW.jobs.deploy.steps.find((item) => isYamlMap(item) && item.name === step);
  assert.ok(isYamlMap(fallback) && typeof fallback.run === 'string');
  const file = path.join(sandbox.root, 'fallback.sh');
  fs.writeFileSync(file, fallback.run);
  const run = (env: Record<string, string>): string => {
    fs.rmSync(sandbox.summaryFile, { force: true });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], { env: baseEnv(sandbox, { ...env, GITHUB_RUN_ID: '42', GMN_SHA: SHA }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(sandbox.summaryFile, 'utf8');
  };
  assert.match(run({ GMN_AMB: 'producao', GMN_E_CI: 'CI_NOT_GREEN' }), new RegExp(`Recusado antes do checkout: \`CI_NOT_GREEN\` \\(execução \`42\`, commit \`${SHA}\`\\)`));
  assert.match(run({ GMN_AMB: 'homologacao', GMN_E_HEAD: 'NOT_MAIN_HEAD' }), /### Deploy pelo CI \(homologacao\)[\s\S]*`NOT_MAIN_HEAD`/);
  assert.match(run({ GMN_AMB: 'x | y', GMN_E_CI: 'lixo `x`' }), /### Deploy pelo CI \(-\)[\s\S]*`FALHOU_ANTES_DO_CHECKOUT`/);
});
