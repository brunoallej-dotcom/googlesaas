import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ArtifactBuildError, type BuiltArtifact } from '../scripts/build-sign-artifact';
import { buildReceiverArtifact, DEPLOY_RECEIVER_FILE_NAME, DEPLOY_RECEIVER_NODE_MODULES, RECEIVER_ARTIFACTS, RECEIVERS_HASH_FILE, receiverHashLine, versionedReceiverHashes } from '../scripts/build-receivers-artifact';
import { parseReceiverArgs } from '../src/lib/deploy-receiver/args';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { bundleConfigs, classicImages, containerdImages, DOCKER_NOISE, fp12, manifestFor, SENTINEL_EMAIL, SENTINEL_HOST, SENTINEL_URL, SHA40, sha256, testKey, trustFile, trustLine, validHostVars } from './helpers/deploy-receiver-fakes';

/*
 * P9.3a — o ARTEFATO ÚNICO do receptor de deploy e o wrapper do comando forçado (spec §5.6 "Instalação"; P9-O04 depende deste hash):
 *  - build reprodutível com o esbuild travado e o hash versionado em `deploy/hostinger/receivers.sha256` (o job `receivers artifact` do CI
 *    refaz e confere); guardas sobre a saída (só os módulos da lista literal, nada de carregamento dinâmico);
 *  - o artefato em processo REAL, por `env -i` com o node por caminho absoluto, `--disable-sigusr1` e `docker`, `tar` e `gzip` FALSOS no PATH
 *    (scripts que imprimem caminhos): uma linha pública só, nada da saída deles nem do arquivo de variáveis no stdout/stderr;
 *  - os dois modelos de wrapper: conferem o sha256 do artefato (E_ARTIFACT, 17), limpam o ambiente e passam exatamente os parâmetros fixos.
 * Sem Docker real, sem ssh, sem rede. DEPLOY_RECEIVER_ARTIFACT_STRICT=1 (job do CI): nada pode ser pulado.
 */
registerCleanup();

const STRICT = process.env.DEPLOY_RECEIVER_ARTIFACT_STRICT === '1';
const WRAPPERS_DIR = path.join(__dirname, '..', 'deploy', 'hostinger', 'receivers');
const PROD_WRAPPER = path.join(WRAPPERS_DIR, 'gmn-deploy.modelo.sh');
const HML_WRAPPER = path.join(WRAPPERS_DIR, 'gmn-hml-deploy.modelo.sh');
const realTmp = (prefix: string): string => fs.realpathSync(tmpDir(prefix));
let shared: Promise<BuiltArtifact> | null = null;
const built = (): Promise<BuiltArtifact> => (shared ??= buildReceiverArtifact(RECEIVER_ARTIFACTS[0] as (typeof RECEIVER_ARTIFACTS)[number], { outDir: realTmp('dra-build-') }));
const PUBLIC_LINE = /^(?:OK (?:UPLOADED|DEPLOYED) [ -~]+|ERRO E_[A-Z_]+(?: [A-Z0-9_-]+)?)\n$/;

/* ===================================================================================================================== build e hash */

test('P9.3a artefato: build REPRODUTÍVEL (duas pastas, mesmos bytes), 0444, e o sha256 é o versionado em deploy/hostinger/receivers.sha256 (formato do sha256sum, uma linha por artefato, # = comentário)', async () => {
  const first = await built();
  const second = await buildReceiverArtifact(RECEIVER_ARTIFACTS[0] as (typeof RECEIVER_ARTIFACTS)[number], { outDir: tmpDir('dra-build2-') });
  assert.ok(first.bytes.equals(second.bytes), 'mesmos bytes em pastas diferentes');
  assert.equal(path.basename(first.file), DEPLOY_RECEIVER_FILE_NAME);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o444);
  assert.equal(first.sha256, createHash('sha256').update(fs.readFileSync(first.file)).digest('hex'));
  assert.equal(versionedReceiverHashes().get(DEPLOY_RECEIVER_FILE_NAME), first.sha256, 'receivers.sha256 = o hash recompilado (refaça o arquivo quando o fonte mudar)');
  const lines = fs.readFileSync(RECEIVERS_HASH_FILE, 'utf8').split('\n').filter((line) => line !== '' && !line.startsWith('#'));
  assert.deepEqual(lines, [receiverHashLine(first)], 'só o receptor de deploy por enquanto (o de manifestos entra na P9.3b, com a própria linha)');
  assert.deepEqual(RECEIVER_ARTIFACTS.map((spec) => spec.fileName), [DEPLOY_RECEIVER_FILE_NAME]);
});

test('P9.3a artefato: o arquivo final só carrega a lista LITERAL (child_process, crypto, fs, fs/promises, path) por require estático; nada de rede, os, carregamento dinâmico ou marcador do build', async () => {
  assert.deepEqual([...DEPLOY_RECEIVER_NODE_MODULES], ['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path']);
  const artifact = await built();
  const text = fs.readFileSync(artifact.file, 'utf8');
  const required = [...text.matchAll(/\brequire\s*\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1] as string);
  assert.deepEqual([...new Set(required)].sort(), artifact.requires);
  assert.ok(required.every((specifier) => DEPLOY_RECEIVER_NODE_MODULES.includes(specifier)));
  assert.equal([...text.matchAll(/\brequire\s*\(/g)].length, required.length, 'todo require( tem string literal');
  for (const absent of ['node:net', 'node:http', 'node:https', 'node:dns', 'node:os', 'node:worker_threads', 'GMN_DEPLOY_RECEIVER_ARTIFACT', 'createRequire', 'import(']) assert.ok(!text.includes(absent), `${absent} no artefato`);
  const childProcessUses = new Set([...text.matchAll(/\bimport_node_child_process\d*\.(\w+)/g)].map((match) => match[1]));
  assert.deepEqual([...childProcessUses], ['execFile'], 'do node:child_process, só execFile');
  assert.deepEqual([...text.matchAll(/\bshell:\s*(\w+)/g)].map((match) => match[1]), ['false'], 'sem shell');
});

test('P9.3a artefato (mutação): módulo fora da lista do receptor (node:os, node:net) ⇒ ArtifactBuildError e nada gravado; o hash fora do formato ou da ordem ⇒ HASH_MISMATCH', async () => {
  for (const [label, source] of [
    ['node:os', "import os from 'node:os';\nconsole.log(os.hostname());\n"],
    ['node:net', "import net from 'node:net';\nconsole.log(typeof net.connect);\n"],
  ] as const) {
    const dir = tmpDir('dra-fixture-');
    const entry = path.join(dir, 'entrada.ts');
    fs.writeFileSync(entry, source);
    const outDir = tmpDir('dra-out-');
    await assert.rejects(buildReceiverArtifact(RECEIVER_ARTIFACTS[0] as (typeof RECEIVER_ARTIFACTS)[number], { outDir, entry }), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'IMPORT_NOT_ALLOWED', label);
    assert.deepEqual(fs.readdirSync(outDir), [], label);
  }
  const dir = tmpDir('dra-hash-');
  const write = (text: string): string => {
    const file = path.join(dir, `h-${sha256(text).slice(0, 8)}`);
    fs.writeFileSync(file, text);
    return file;
  };
  for (const text of ['', `${'a'.repeat(64)} gmn-deploy-receiver.cjs\n`, `${'a'.repeat(64)}  outro.cjs\n`, `${'a'.repeat(64)}  gmn-deploy-receiver.cjs\n${'b'.repeat(64)}  gmn-deploy-receiver.cjs\n`]) {
    assert.throws(() => versionedReceiverHashes(write(text)), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'HASH_MISMATCH', JSON.stringify(text));
  }
  assert.equal(versionedReceiverHashes(write(`# comentário\n${'a'.repeat(64)}  gmn-deploy-receiver.cjs\n`)).get(DEPLOY_RECEIVER_FILE_NAME), 'a'.repeat(64));
});

/* ===================================================================================================================== processo real */

/** O docker, o tar e o gzip falsos: um único script Node (shebang com o node ABSOLUTO deste processo), despachado pelo nome. */
type ImageStore = 'classic' | 'containerd';

function fakeTools(dir: string, rootDir: string, tag: string, store: ImageStore): { readonly bin: string; readonly calls: () => Array<{ tool: string; args: string[]; envKeys: string[] }> } {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const stateFile = path.join(dir, 'state.json');
  const callsFile = path.join(dir, 'calls.jsonl');
  const images = Object.fromEntries(store === 'classic' ? classicImages(tag) : containerdImages(tag));
  const configs = Object.fromEntries([...bundleConfigs()].map(([member, bytes]) => [member, bytes.toString('base64')]));
  fs.writeFileSync(stateFile, JSON.stringify({ deployed: false, env: {}, manifest: manifestFor(tag), tag, rootDir, images, configs }));
  const source = `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ tool, args, envKeys: Object.keys(process.env).sort() }) + '\\n');
const noise = ${JSON.stringify(DOCKER_NOISE)};
const done = (code, out, err) => { if (out) process.stdout.write(out); if (err) process.stderr.write(err); process.exit(code); };
const service = (name) => {
  const stack = name.replace(/_gmn-(web|worker|redis)$/, '');
  const kind = name.slice(stack.length + 5);
  const image = kind === 'web' ? 'gmn-web:' + state.tag : kind === 'worker' ? 'gmn-worker:' + state.tag : 'redis:7.4.11-alpine';
  const env = kind === 'web' ? ['GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS=' + (state.env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS || ''), 'GMN_OPERATOR_EMAILS=' + (state.env.GMN_OPERATOR_EMAILS || '')] : [];
  const mounts = kind === 'worker' ? [{ Type: 'bind', Source: '/srv/x/audits', Target: '/app/.data/audits' }, { Type: 'tmpfs', Target: '/tmp' }] : [];
  return { ID: 'id-' + name, Spec: { Name: name, Mode: { Replicated: { Replicas: kind === 'worker' ? 0 : 1 } }, TaskTemplate: { ContainerSpec: { Image: image, Env: env, Mounts: mounts } }, EndpointSpec: { Mode: 'vip' } }, Endpoint: {}, UpdateStatus: { State: 'completed', StartedAt: 'agora' } };
};
const names = ['web', 'worker', 'redis'].map((kind) => state.stack + '_gmn-' + kind);
if (tool === 'gzip') done(0, '', '');
if (tool === 'tar') {
  const member = args[2];
  if (member === 'manifest.json') done(0, state.manifest, '');
  if (state.configs[member]) { process.stdout.write(Buffer.from(state.configs[member], 'base64')); process.exit(0); }
  done(2, '', 'tar: ' + member + ': Not found in archive ' + noise + '\\n');
}
const [a, b] = args;
if (a === 'info') done(0, JSON.stringify(state.rootDir) + '\\n', '');
if (a === 'image' && b === 'inspect') {
  const image = state.images[args[args.length - 1]];
  if (!image) done(1, '', 'No such image ' + noise);
  done(0, JSON.stringify({ Id: image.Id, RepoTags: image.RepoTags, RootFS: { Type: 'layers', Layers: image.Layers }, Config: { Env: ['NEXT_PUBLIC_SUPABASE_URL=' + ${JSON.stringify(SENTINEL_URL)}] } }) + '\\n', '');
}
if (a === 'load') done(0, 'Loaded image: ' + noise + '\\n', 'aviso ' + noise + '\\n');
if (a === 'stack' && b === 'config') done(0, 'services: ' + noise + ' ' + (process.env.GMN_OPERATOR_EMAILS || '') + '\\n', '');
if (a === 'stack' && b === 'deploy') { state.deployed = true; state.stack = args[args.length - 1]; state.env = { GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS: process.env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS, GMN_OPERATOR_EMAILS: process.env.GMN_OPERATOR_EMAILS }; state.tag = process.env.GMN_IMAGE_TAG; fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state)); done(0, 'Creating service ' + noise + '\\n', 'Since --detach=false was not specified ' + noise + '\\n'); }
if (a === 'service' && b === 'inspect') {
  if (!state.deployed) done(1, '[]\\n', 'Error: no such service: ' + args[2] + ' ' + noise + '\\n');
  done(0, JSON.stringify(args.slice(2).map((id) => service(id.replace(/^id-/, '')))) + '\\n', '');
}
if (a === 'service' && b === 'ps') done(0, JSON.stringify({ Image: 'gmn-web:' + state.tag, CurrentState: 'Running 2 seconds ago', DesiredState: 'Running' }) + '\\n', '');
if (a === 'service' && b === 'ls') done(0, names.map((name) => JSON.stringify({ ID: 'id-' + name, Name: name, Replicas: name.endsWith('worker') ? '0/0' : '1/1', Ports: '' })).join('\\n') + '\\n', '');
done(1, '', 'fake docker: inesperado ' + args.join(' ') + ' ' + noise + '\\n');
`;
  const tool = path.join(bin, 'fake-tool.cjs');
  fs.writeFileSync(tool, source, { mode: 0o755 });
  for (const name of ['docker', 'tar', 'gzip']) fs.symlinkSync(tool, path.join(bin, name));
  return { bin, calls: () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { tool: string; args: string[]; envKeys: string[] }) };
}

const REPO_ROOT = path.join(__dirname, '..');
const freeBytes = (dir: string): number => {
  const info = fs.statfsSync(dir);
  return Number(info.bavail) * Number(info.bsize);
};
/** A "raiz do Docker" que o `docker info` falso devolve: a pasta com mais espaço livre (o passo 8 exige 10 GiB; o /tmp local pode ser tmpfs). */
const roomiestDir = (dirs: readonly string[]): string => [...dirs].sort((a, b) => freeBytes(b) - freeBytes(a))[0] as string;

interface ProcessWorld {
  readonly dockerRoot: string;
  readonly argv: readonly string[];
  readonly stateDir: string;
  readonly logFile: string;
  readonly bin: string;
  readonly calls: ReturnType<typeof fakeTools>['calls'];
  readonly stackSha256: string;
  readonly trust: Buffer;
}

function processWorld(store: ImageStore = 'classic'): ProcessWorld {
  const root = realTmp('dra-proc-');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { mode: 0o711 });
  const stack = path.join(root, 'stack.yml');
  fs.writeFileSync(stack, 'services: {} # fictícia\n');
  const dataRoot = path.join(root, 'srv', 'gmn');
  const folders = ['decisoes', 'recibos-decisoes', 'resultados', 'recibos-resultados', 'livro', 'manifestos'].map((name) => path.join(dataRoot, name));
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
  const hostVars = path.join(root, 'variaveis');
  fs.writeFileSync(hostVars, validHostVars('producao', folders, dataRoot));
  const foldersCheck = path.join(root, 'verificar-pastas-fase6.sh');
  fs.writeFileSync(foldersCheck, '#!/bin/sh\necho "[verificar-pastas-fase6] OK $1"\nexit 0\n', { mode: 0o755 });
  const logFile = path.join(root, 'producao-deploy.log');
  fs.writeFileSync(logFile, '', { mode: 0o600 });
  const tools = fakeTools(root, roomiestDir([root, REPO_ROOT]), `producao-${SHA40}`, store);
  const argv = ['--env', 'producao', '--stack-name', 'gmn', '--stack', stack, '--host-vars', hostVars, '--folders-check', foldersCheck, '--state', stateDir, '--log', logFile];
  return { dockerRoot: roomiestDir([root, REPO_ROOT]), argv, stateDir, logFile, bin: tools.bin, calls: tools.calls, stackSha256: sha256(fs.readFileSync(stack)), trust: trustFile([trustLine(testKey('chave-prod-a'))]) };
}

/** A linha do wrapper: env -i, PATH (com os falsos na frente), SSH_ORIGINAL_COMMAND, node absoluto, --disable-sigusr1, artefato, parâmetros. */
function runArtifact(file: string, w: ProcessWorld, command: string, input: Buffer, extraEnv: readonly string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('/usr/bin/env', ['-i', `PATH=${w.bin}:/usr/bin:/bin`, `SSH_ORIGINAL_COMMAND=${command}`, ...extraEnv, process.execPath, '--disable-sigusr1', file, ...w.argv], { input, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
}

function assertPublic(run: { stdout: string; stderr: string }): void {
  const text = run.stdout + run.stderr;
  assert.match(text, PUBLIC_LINE, JSON.stringify(text));
  assert.ok((run.stdout === '') !== (run.stderr === ''), 'um canal só');
  for (const forbidden of [DOCKER_NOISE, SENTINEL_URL, SENTINEL_EMAIL, SENTINEL_HOST, '/tmp', '/home', 'at ']) assert.ok(!text.includes(forbidden), `${forbidden} na saída pública`);
}

test('P9-D13 em processo REAL (env -i, node absoluto, docker/tar/gzip FALSOS no PATH que imprimem caminhos), nos dois armazenamentos de imagens (clássico e containerd): upload e deploy completos; uma linha pública por execução, nada da saída dos falsos nem do arquivo de variáveis; log local 0600 com as saídas do Docker', { timeout: 180_000 }, async () => {
  const artifact = await built();
  for (const store of ['classic', 'containerd'] as const) await realProcessDeploy(artifact, store);
});

async function realProcessDeploy(artifact: BuiltArtifact, store: ImageStore): Promise<void> {
  const w = processWorld(store);
  const tag = `producao-${SHA40}`;
  const images = store === 'classic' ? classicImages(tag) : containerdImages(tag);
  const bundle = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
  const upload = runArtifact(artifact.file, w, `upload ${SHA40} ${sha256(bundle)} ${bundle.length}`, bundle);
  assertPublic(upload);
  assert.equal(upload.status, 0, upload.stderr);
  assert.equal(upload.stdout, `OK UPLOADED ${SHA40} ${sha256(bundle)}\n`);
  assert.deepEqual(fs.readFileSync(path.join(w.stateDir, 'incoming', `bundle-${SHA40}.tar.gz`)), bundle, 'o stdin real chegou inteiro');
  const command = `deploy ${SHA40} ${sha256(bundle)} ${w.stackSha256} - ${sha256(w.trust)} ${fp12(SENTINEL_URL)}`;
  const deployed = runArtifact(artifact.file, w, command, w.trust);
  assertPublic(deployed);
  const free = freeBytes(w.dockerRoot);
  if (STRICT || free >= 10.5 * 1024 ** 3) {
    assert.equal(deployed.status, 0, deployed.stderr);
    assert.equal(deployed.stdout, `OK DEPLOYED ${tag} ${images.get(`gmn-web:${tag}`)?.Id} ${images.get(`gmn-worker:${tag}`)?.Id} ${w.stackSha256} - ${sha256(w.trust)}\n`, store);
    assert.deepEqual(fs.readFileSync(path.join(w.stateDir, 'trust-keys.txt')), w.trust);
  } else {
    // sem 10 GiB livres em nenhuma pasta candidata (só fora do CI), o passo 8 recusa: também é o comportamento certo
    assert.equal(deployed.stderr, 'ERRO E_DISK_LOW\n');
  }
  const calls = w.calls();
  assert.ok(calls.some((call) => call.tool === 'docker' && call.args[0] === 'info'), 'os falsos foram chamados pelo PATH');
  for (const call of calls) assert.ok(call.envKeys.every((key) => key === 'PATH' || /^(GMN_|NEXT_PUBLIC_)/.test(key)), `ambiente do filho: ${call.envKeys.join(',')}`);
  const log = fs.readFileSync(w.logFile, 'utf8');
  assert.equal(fs.statSync(w.logFile).mode & 0o777, 0o600);
  assert.ok(log.includes(DOCKER_NOISE), 'a saída do Docker fica no log local');
  for (const sentinel of [SENTINEL_URL, SENTINEL_EMAIL, SENTINEL_HOST]) assert.ok(!log.includes(sentinel), `${sentinel} no log local`);
  assert.ok(log.split('\n').filter(Boolean).every((line) => JSON.parse(line) !== null), 'uma linha JSON por evento');
  if (deployed.status === 0) {
    const tarMembers = calls.filter((call) => call.tool === 'tar').map((call) => call.args[2]);
    assert.deepEqual(tarMembers, store === 'classic' ? ['manifest.json'] : ['manifest.json', ...bundleConfigs().keys()], `${store}: o que o receptor leu do pacote`);
  }
}

test('em processo REAL: fora da gramática ⇒ ERRO E_COMMAND (10); ambiente além de PATH e SSH_ORIGINAL_COMMAND ⇒ E_INTERNAL (29); lista com hash errado ⇒ E_TRUST_LIST_MISMATCH (14); stdin fechado cedo no upload ⇒ E_INPUT_TRUNCATED (12)', { timeout: 120_000 }, async () => {
  const artifact = await built();
  const w = processWorld();
  const outside = runArtifact(artifact.file, w, 'qualquer-coisa; id', Buffer.alloc(0));
  assertPublic(outside);
  assert.equal(outside.status, 10);
  assert.equal(outside.stderr, 'ERRO E_COMMAND\n');
  const polluted = runArtifact(artifact.file, w, `upload ${SHA40} ${'0'.repeat(64)} 10`, Buffer.alloc(10), ['NODE_OPTIONS=--no-warnings']);
  assert.equal(polluted.status, 29);
  assert.equal(polluted.stderr, 'ERRO E_INTERNAL\n');
  const short = runArtifact(artifact.file, w, `upload ${SHA40} ${'0'.repeat(64)} 1000`, Buffer.alloc(10));
  assert.equal(short.status, 12);
  assert.equal(short.stderr, 'ERRO E_INPUT_TRUNCATED\n');
  assert.deepEqual(fs.readdirSync(path.join(w.stateDir, 'incoming')), [], 'parcial apagado');
  const bundle = Buffer.from('pacote');
  assert.equal(runArtifact(artifact.file, w, `upload ${SHA40} ${sha256(bundle)} ${bundle.length}`, bundle).status, 0);
  const mismatch = runArtifact(artifact.file, w, `deploy ${SHA40} ${sha256(bundle)} ${w.stackSha256} - ${'0'.repeat(64)} ${fp12(SENTINEL_URL)}`, w.trust);
  assertPublic(mismatch);
  assert.equal(mismatch.status, 14);
  assert.ok(!fs.existsSync(path.join(w.stateDir, 'deploy.lock')), 'a trava é liberada');
});

/* ===================================================================================================================== wrapper */

interface FilledWrapper {
  readonly file: string;
  readonly artifact: string;
  readonly record: string;
}

/** Uma cópia do modelo com o artefato, o hash e o node trocados por caminhos temporários (o node é um falso que registra argv e ambiente). */
function fillWrapper(template: string, artifactBytes: Buffer, hash: string = sha256(artifactBytes)): FilledWrapper {
  const dir = realTmp('dra-wrapper-');
  const artifact = path.join(dir, 'gmn-deploy-receiver.cjs');
  fs.writeFileSync(artifact, artifactBytes, { mode: 0o444 });
  const record = path.join(dir, 'registro.json');
  const node = path.join(dir, 'node');
  fs.writeFileSync(node, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.stderr.write('ERRO E_COMMAND\\n');\nprocess.exit(10);\n`, { mode: 0o755 });
  const text = fs
    .readFileSync(template, 'utf8')
    .replace(/^ARTIFACT='[^']*'$/m, `ARTIFACT='${artifact}'`)
    .replace(/^ARTIFACT_SHA256='[^']*'$/m, `ARTIFACT_SHA256='${hash}'`)
    .replace(/^NODE='[^']*'$/m, `NODE='${node}'`)
    .replaceAll('<ARQUIVO_DE_VARIAVEIS>', 'variaveis')
    .replaceAll('<IMPRESSAO_SUPABASE_PRODUCAO>', '0123456789ab');
  const file = path.join(dir, 'wrapper');
  fs.writeFileSync(file, text, { mode: 0o755 });
  return { file, artifact, record };
}

/** O ambiente EXATO do shell do wrapper (o tipo do Next exige NODE_ENV em ProcessEnv; o filho não o recebe). */
const runWrapper = (file: string, env: Record<string, string>) => spawnSync('/bin/sh', [file], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });

test('wrapper (os dois modelos): só marcadores; set -eu; confere o sha256 do artefato antes de tudo; env -i com PATH fixo; node absoluto com --disable-sigusr1; parâmetros fixos iguais aos da spec e aceitos pelo receptor', () => {
  for (const template of [PROD_WRAPPER, HML_WRAPPER]) {
    const text = fs.readFileSync(template, 'utf8');
    assert.equal(fs.statSync(template).mode & 0o111, 0o111, 'executável');
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.match(text, /^set -eu$/m);
    assert.match(text, /^ARTIFACT='\/opt\/gmn-receivers\/<VERSAO>\/gmn-deploy-receiver\.cjs'$/m);
    assert.match(text, /^ARTIFACT_SHA256='<SHA256_DO_ARTEFATO>'$/m);
    assert.match(text, /^NODE='\/opt\/gmn-receivers\/node\/bin\/node'$/m);
    assert.match(text, /exec \/usr\/bin\/env -i PATH=\/usr\/bin:\/bin "SSH_ORIGINAL_COMMAND=\$\{SSH_ORIGINAL_COMMAND-\}" "\$NODE" --disable-sigusr1 "\$ARTIFACT"/);
    assert.ok(!/\beval\b|\$SSH_ORIGINAL_COMMAND\b(?!-)|`/.test(text.replace(/^#.*$/gm, '')), 'o comando pedido nunca é interpretado pelo shell');
    assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b|https?:\/\//.test(text), 'nenhum host, IP ou URL real');
    assert.ok(text.indexOf('sha256sum') < text.indexOf('exec '), 'o hash é conferido antes do exec');
  }
  const prodArgs = /--env producao[^\n]*\\\n[^\n]*/.exec(fs.readFileSync(PROD_WRAPPER, 'utf8'))?.[0] ?? '';
  assert.match(prodArgs, /--env producao --stack-name gmn --stack \/opt\/gmn\/stack\.yml --host-vars '\/opt\/gmn\/<ARQUIVO_DE_VARIAVEIS>'/);
  assert.match(prodArgs, /--folders-check \/opt\/gmn\/verificar-pastas-fase6\.sh --state \/var\/lib\/gmn-deploy\/producao --log \/var\/log\/gmn-receivers\/producao-deploy\.log/);
  const hmlText = fs.readFileSync(HML_WRAPPER, 'utf8');
  assert.match(hmlText, /--env homologacao --stack-name gmn-hml --stack \/opt\/gmn-hml\/stack\.yml --overlay \/opt\/gmn-hml\/stack-hml\.yml/);
  assert.match(hmlText, /--data-prefix \/srv\/gmn-hml\/ --forbid-supabase '<IMPRESSAO_SUPABASE_PRODUCAO>'/);
  assert.match(hmlText, /--state \/var\/lib\/gmn-deploy\/homologacao --log \/var\/log\/gmn-receivers\/homologacao-deploy\.log/);
});

test('wrapper em processo: hash certo ⇒ roda o node com EXATAMENTE os parâmetros fixos e o ambiente limpo (só PATH=/usr/bin:/bin e o comando pedido, sem interpretar); parâmetros aceitos pelo receptor', () => {
  for (const [template, env] of [[PROD_WRAPPER, 'producao'], [HML_WRAPPER, 'homologacao']] as const) {
    const filled = fillWrapper(template, Buffer.from('artefato fictício'));
    const hostile = 'upload $(id) `id` ; rm -rf / && echo "x"';
    const result = runWrapper(filled.file, { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: hostile, NODE_OPTIONS: '--require /tmp/x.js', LD_PRELOAD: '/tmp/x.so', HOME: '/home/x' });
    assert.equal(result.status, 10, result.stderr);
    const record = JSON.parse(fs.readFileSync(filled.record, 'utf8')) as { argv: string[]; env: Record<string, string> };
    assert.deepEqual(record.env, { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: hostile }, `${env}: ambiente limpo, comando repassado byte a byte`);
    assert.deepEqual(record.argv.slice(0, 2), ['--disable-sigusr1', filled.artifact]);
    const config = parseReceiverArgs(record.argv.slice(2));
    assert.ok(config, `${env}: parâmetros aceitos pelo receptor`);
    assert.equal(config.env, env);
    assert.equal(config.stackName, env === 'producao' ? 'gmn' : 'gmn-hml');
    assert.equal(config.logFile, `/var/log/gmn-receivers/${env}-deploy.log`);
  }
  const unset = fillWrapper(PROD_WRAPPER, Buffer.from('artefato fictício'));
  assert.equal(runWrapper(unset.file, { PATH: '/usr/bin:/bin' }).status, 10);
  assert.equal((JSON.parse(fs.readFileSync(unset.record, 'utf8')) as { env: Record<string, string> }).env.SSH_ORIGINAL_COMMAND, '', 'sem comando: vazio (o receptor recusa com E_COMMAND)');
});

test('wrapper em processo: artefato com outro hash, ausente, ou marcador do hash sem preencher ⇒ ERRO E_ARTIFACT (17) no stderr, sem rodar o node', () => {
  const bytes = Buffer.from('artefato fictício');
  const altered = fillWrapper(PROD_WRAPPER, bytes);
  fs.chmodSync(altered.artifact, 0o644);
  fs.appendFileSync(altered.artifact, 'x');
  const missing = fillWrapper(HML_WRAPPER, bytes);
  fs.rmSync(missing.artifact);
  const placeholder = fillWrapper(PROD_WRAPPER, bytes, '<SHA256_DO_ARTEFATO>');
  for (const filled of [altered, missing, placeholder]) {
    const result = runWrapper(filled.file, { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: `upload ${SHA40} ${'0'.repeat(64)} 10` });
    assert.equal(result.status, 17);
    assert.equal(result.stderr, 'ERRO E_ARTIFACT\n');
    assert.equal(result.stdout, '');
    assert.ok(!fs.existsSync(filled.record), 'o node não rodou');
  }
});

test('wrapper + artefato REAL: o modelo de homologação com a impressão de produção sem preencher faz o receptor recusar a instalação (E_INTERNAL), nunca seguir', async () => {
  const artifact = await built();
  const dir = realTmp('dra-wrapper-real-');
  const text = fs
    .readFileSync(HML_WRAPPER, 'utf8')
    .replace(/^ARTIFACT='[^']*'$/m, `ARTIFACT='${artifact.file}'`)
    .replace(/^ARTIFACT_SHA256='[^']*'$/m, `ARTIFACT_SHA256='${artifact.sha256}'`)
    .replace(/^NODE='[^']*'$/m, `NODE='${process.execPath}'`);
  const file = path.join(dir, 'wrapper');
  fs.writeFileSync(file, text, { mode: 0o755 });
  const result = runWrapper(file, { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: `upload ${SHA40} ${'0'.repeat(64)} 10` });
  assert.equal(result.status, 29, result.stderr);
  assert.equal(result.stderr, 'ERRO E_INTERNAL\n');
});

/* ===================================================================================================================== zod e CI */

test('P9.3a artefato: a entrada configura o zod SEM JIT antes de qualquer esquema (como o sign); carregar o artefato real não chama Function nenhuma vez', { timeout: 60_000 }, async () => {
  const artifact = await built();
  const dir = tmpDir('dra-jit-');
  const counter = path.join(dir, 'conta-function.cjs');
  fs.writeFileSync(counter, [
    'const Original = Function;',
    'let calls = 0;',
    'globalThis.Function = new Proxy(Original, { construct(target, args) { calls += 1; return Reflect.construct(target, args); }, apply(target, self, args) { calls += 1; return Reflect.apply(target, self, args); } });',
    "process.on('exit', () => process.stderr.write('FUNCTION_CALLS=' + calls + '\\n'));",
    '',
  ].join('\n'));
  // parâmetros inválidos: o receptor recusa (E_INTERNAL) DEPOIS de todos os módulos (e esquemas) carregados
  const run = spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', process.execPath, '--require', counter, artifact.file, '--env', 'producao'], { encoding: 'utf8', timeout: 30_000 });
  assert.match(run.stderr, /^ERRO E_INTERNAL\n/);
  assert.match(run.stderr, /FUNCTION_CALLS=0\b/, run.stderr);
  assert.equal(run.status, 29);
});

test('CI: job "receivers artifact (build, hash)" no ci.yml, como o sign-artifact: só leitura, sem segredo, recompila, confere o hash versionado com sha256sum -c --strict e roda os testes do artefato em modo estrito', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = /\n {2}receivers-artifact:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|\n?$)/.exec(ci)?.[1] ?? '';
  assert.match(job, /name: receivers artifact \(build, hash\)/);
  assert.match(job, /permissions:\n\s+contents: read\n/);
  assert.ok(!/secrets\.|write/.test(job), 'sem segredo e sem escrita');
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /npm run deploy:receivers-artifact -- --out "\$RUNNER_TEMP\/receivers-artifact"/);
  assert.match(job, /sha256sum -c --strict "\$GITHUB_WORKSPACE\/deploy\/hostinger\/receivers\.sha256"/);
  assert.match(job, /DEPLOY_RECEIVER_ARTIFACT_STRICT: '1'/);
  assert.match(job, /tests\/deploy-receiver-artifact\.test\.ts/);
  for (const uses of job.matchAll(/uses: ([^\s#]+)/g)) assert.match(uses[1] as string, /@[0-9a-f]{40}$/, 'action fixada por SHA');
});
