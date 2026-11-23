import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Bancada dos testes dos scripts do deploy pelo CI (deploy/ci/*.sh; tests/deploy-ci-scripts.test.ts, P9.4, e tests/deploy-seals-delivery.test.ts,
 * P9.5): uma pasta temporária que imita a raiz do repositório, com os scripts copiados e comandos FALSOS no PATH, que registram argv, as
 * variáveis pedidas e o sha256 do stdin e respondem pelo cenário. Nada aqui abre rede nem chama Docker, SSH ou GitHub reais.
 */
const ROOT = path.join(__dirname, '..', '..');
const CI_DIR = path.join(ROOT, 'deploy', 'ci');
/** Os comandos falsos padrão; um teste pode trocar a lista (o da entrega usa o git REAL, numa pasta temporária). */
export const FAKES = ['docker', 'ssh', 'curl', 'git', 'gh', 'sleep', 'date'] as const;
/** Lista de confiança de homologação fictícia (a de produção nasce vazia). */
export const TRUST_LIST = 'ensaio-a1b2:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2:active\n';

export interface SandboxOptions {
  readonly fakes?: readonly string[];
}

export interface FakeResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly rc?: number;
  /** Mata o processo pai (SIGKILL) depois de registrar a chamada: simula o runner cancelando o job no meio da chamada. */
  readonly killParent?: boolean;
}
export interface FakeRule {
  readonly match?: readonly string[];
  /** Trechos que o stdin tem de conter (só para comandos em `readStdin`). */
  readonly matchStdin?: readonly string[];
  readonly responses: readonly FakeResponse[];
}
export interface Scenario {
  readonly commands?: Readonly<Record<string, readonly FakeRule[]>>;
  readonly readStdin?: readonly string[];
  readonly recordEnv?: readonly string[];
}
export interface FakeCall {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly stdinSha256?: string;
  readonly stdinBytes?: number;
}
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface Sandbox {
  readonly root: string;
  readonly fakeDir: string;
  readonly runnerTemp: string;
  readonly sshDir: string;
  readonly bundleFile: string;
  readonly outputFile: string;
  readonly summaryFile: string;
}

/** Comando falso: registra argv, as variáveis pedidas e o sha256 do stdin; responde pela primeira regra cujo `match` casa o argv. */
export const FAKE_IMPL = `'use strict';
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
  if (response.killParent) process.kill(process.ppid, 'SIGKILL');
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.rc || 0;
}
`;

export function makeSandbox(t: { after: (fn: () => void) => void }, scenario: Scenario = {}, options: SandboxOptions = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-deploy-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ciDir = path.join(root, 'deploy', 'ci');
  fs.mkdirSync(ciDir, { recursive: true });
  for (const name of fs.readdirSync(CI_DIR)) fs.copyFileSync(path.join(CI_DIR, name), path.join(ciDir, name));
  fs.mkdirSync(path.join(root, 'deploy', 'hostinger'), { recursive: true });
  // a impressão canônica do Supabase (revisão do PR #70), a mesma do receptor e do runbook
  fs.copyFileSync(path.join(ROOT, 'deploy', 'hostinger', 'supabase-fp12.sh'), path.join(root, 'deploy', 'hostinger', 'supabase-fp12.sh'));
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
  for (const name of options.fakes ?? FAKES) {
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

export function setScenario(sandbox: Sandbox, scenario: Scenario): void {
  fs.writeFileSync(path.join(sandbox.fakeDir, 'scenario.json'), JSON.stringify(scenario));
  for (const name of fs.readdirSync(sandbox.fakeDir)) if (/\.(calls\.jsonl|count)$/.test(name)) fs.rmSync(path.join(sandbox.fakeDir, name));
  fs.rmSync(sandbox.outputFile, { force: true });
}

export function baseEnv(sandbox: Sandbox, env: Record<string, string>): NodeJS.ProcessEnv {
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

export function runScript(sandbox: Sandbox, script: string, args: readonly string[], env: Record<string, string>): RunResult {
  const result = spawnSync('bash', [path.join(sandbox.root, 'deploy', 'ci', script), ...args], { cwd: sandbox.root, env: baseEnv(sandbox, env), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function calls(sandbox: Sandbox, name: string): FakeCall[] {
  const file = path.join(sandbox.fakeDir, `${name}.calls.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as FakeCall);
}

export function outputs(sandbox: Sandbox): Record<string, string> {
  if (!fs.existsSync(sandbox.outputFile)) return {};
  return Object.fromEntries(fs.readFileSync(sandbox.outputFile, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

export const assertNoLeak = (result: RunResult, ...sentinels: string[]): void => {
  for (const sentinel of sentinels) assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel), `vazou para a saída: ${sentinel.slice(0, 24)}`);
};
export const assertRefused = (sandbox: Sandbox, result: RunResult, code: string, detail?: string): void => {
  assert.equal(result.status, 1, `saída 1 (${result.stderr.trim()})`);
  assert.match(result.stderr, new RegExp(`^ERRO ${code}${detail === undefined ? '' : ` ${detail}`}$`, 'm'));
  assert.equal(outputs(sandbox).code, code, 'código na saída do passo (para o resumo)');
};
