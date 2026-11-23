import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ArtifactBuildError, type BuiltArtifact } from '../scripts/build-sign-artifact';
import { buildReceiverArtifact, RECEIVER_ARTIFACTS, RECEIVER_TEMPLATES, RECEIVER_TEMPLATES_DIR, RECEIVERS_HASH_FILE, receiverHashLine, SEAL_RECEIVER_FILE_NAME, SEAL_RECEIVER_NODE_MODULES, VERSIONED_FILE_NAMES, versionedReceiverHashes } from '../scripts/build-receivers-artifact';
import { parseSealReceiverArgs } from '../src/lib/seal-receiver/args';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { signer } from './helpers/link-audit-seal-close-key-fixtures';
import { AUD_A, AUD_B, canonicalText, listItem } from './helpers/link-audit-seals-fixtures';
import { chainOf, deliverOnHost, installTrust, PUBLIC_LINE, putLine, sealRelpath, sealWorld, sha256, type SealWorld } from './helpers/seal-receiver-fakes';

/*
 * P9.3b — o ARTEFATO ÚNICO do receptor de manifestos e os wrappers do comando forçado (spec §5.7 "Instalação"; critério P9-R11; P9-O04 depende
 * deste hash):
 *  - build reprodutível com o esbuild travado e o hash versionado em `deploy/hostinger/receivers.sha256` (o job `receivers artifact` do CI refaz e
 *    confere); guardas sobre a saída: só `node:crypto`, `node:fs`, `node:fs/promises` e `node:path` (NENHUM processo filho), nada de carregamento
 *    dinâmico;
 *  - o artefato em processo REAL pelo próprio modelo de wrapper preenchido: conferência do sha256, trava do kernel (`flock -n`), `umask 027`,
 *    `env -i`, node por caminho absoluto, `--disable-sigusr1` e `--permission` com exatamente os grants do §5.7; grava com `fsync` no Node 22 (o
 *    Node 24.22+ bloqueia `fsync` sob `--permission`: lá a gravação recusa, `E_WRITE_FAILED`, sem nada gravado);
 *  - os dois modelos de wrapper de manifestos (estático e com um node falso que registra argv, ambiente e umask).
 * Sem ssh, sem Docker, sem rede. SEAL_RECEIVER_ARTIFACT_STRICT=1 (job do CI, Node 22): nada pode ser pulado e o fsync tem de ser permitido.
 */
registerCleanup();

const STRICT = process.env.SEAL_RECEIVER_ARTIFACT_STRICT === '1';
const PROD_WRAPPER = path.join(RECEIVER_TEMPLATES_DIR, 'gmn-seals.modelo.sh');
const HML_WRAPPER = path.join(RECEIVER_TEMPLATES_DIR, 'gmn-hml-seals.modelo.sh');
const FLOCK = '/usr/bin/flock';
const HAS_FLOCK = fs.existsSync(FLOCK);
const SPEC = RECEIVER_ARTIFACTS.find((spec) => spec.fileName === SEAL_RECEIVER_FILE_NAME) as (typeof RECEIVER_ARTIFACTS)[number];
const realTmp = (prefix: string): string => fs.realpathSync(tmpDir(prefix));
let shared: Promise<BuiltArtifact> | null = null;
const built = (): Promise<BuiltArtifact> => (shared ??= buildReceiverArtifact(SPEC, { outDir: realTmp('sra-build-') }));
const KEY_A = signer('ek-artefato-a');
const KEY_B = signer('ek-artefato-b');

/* ===================================================================================================================== build e hash */

test('P9-R11 artefato: build REPRODUTÍVEL (duas pastas, mesmos bytes), 0444, e o sha256 é o versionado em deploy/hostinger/receivers.sha256 (artefatos na ordem, depois os quatro modelos)', async () => {
  const first = await built();
  const second = await buildReceiverArtifact(SPEC, { outDir: tmpDir('sra-build2-') });
  assert.ok(first.bytes.equals(second.bytes), 'mesmos bytes em pastas diferentes');
  assert.equal(path.basename(first.file), SEAL_RECEIVER_FILE_NAME);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o444);
  assert.equal(versionedReceiverHashes().get(SEAL_RECEIVER_FILE_NAME), first.sha256, 'receivers.sha256 = o hash recompilado (refaça o arquivo quando o fonte mudar)');
  assert.deepEqual(RECEIVER_ARTIFACTS.map((spec) => spec.fileName), ['gmn-deploy-receiver.cjs', SEAL_RECEIVER_FILE_NAME]);
  assert.deepEqual([...RECEIVER_TEMPLATES], ['gmn-deploy.modelo.sh', 'gmn-hml-deploy.modelo.sh', 'gmn-seals.modelo.sh', 'gmn-hml-seals.modelo.sh']);
  assert.deepEqual([...VERSIONED_FILE_NAMES], ['gmn-deploy-receiver.cjs', SEAL_RECEIVER_FILE_NAME, ...RECEIVER_TEMPLATES]);
  const lines = fs.readFileSync(RECEIVERS_HASH_FILE, 'utf8').split('\n').filter((line) => line !== '' && !line.startsWith('#'));
  assert.equal(lines[1], receiverHashLine(first));
  for (const name of ['gmn-seals.modelo.sh', 'gmn-hml-seals.modelo.sh']) assert.ok(lines.includes(`${sha256(fs.readFileSync(path.join(RECEIVER_TEMPLATES_DIR, name)))}  ${name}`), `${name} com o hash dos bytes`);
});

test('P9-R11 artefato: o arquivo final só carrega a lista LITERAL (crypto, fs, fs/promises, path) por require estático; nada de processo filho, rede, os, carregamento dinâmico ou marcador do build', async () => {
  assert.deepEqual([...SEAL_RECEIVER_NODE_MODULES], ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path']);
  const artifact = await built();
  const text = fs.readFileSync(artifact.file, 'utf8');
  const required = [...text.matchAll(/\brequire\s*\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1] as string);
  assert.deepEqual([...new Set(required)].sort(), artifact.requires);
  assert.ok(required.every((specifier) => SEAL_RECEIVER_NODE_MODULES.includes(specifier)));
  assert.equal([...text.matchAll(/\brequire\s*\(/g)].length, required.length, 'todo require( tem string literal');
  for (const absent of ['node:child_process', 'execFile', 'node:net', 'node:http', 'node:https', 'node:dns', 'node:os', 'node:worker_threads', 'GMN_SEAL_RECEIVER_ARTIFACT', 'createRequire', 'import(', 'publishExclusive']) assert.ok(!text.includes(absent), `${absent} no artefato`);
});

test('P9-R11 artefato (mutação): módulo fora da lista do receptor de manifestos (node:child_process, node:net) ⇒ ArtifactBuildError e nada gravado', async () => {
  for (const [label, source] of [
    ['node:child_process', "import { execFile } from 'node:child_process';\nconsole.log(typeof execFile);\n"],
    ['node:net', "import net from 'node:net';\nconsole.log(typeof net.connect);\n"],
  ] as const) {
    const dir = tmpDir('sra-fixture-');
    const entry = path.join(dir, 'entrada.ts');
    fs.writeFileSync(entry, source);
    const outDir = tmpDir('sra-out-');
    await assert.rejects(buildReceiverArtifact(SPEC, { outDir, entry }), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'IMPORT_NOT_ALLOWED', label);
    assert.deepEqual(fs.readdirSync(outDir), [], label);
  }
});

/* ===================================================================================================================== processo real */

/** Saídas da sonda: 0 = fsync permitido sob `--permission`; 7 = negado (Node 24.22+); outra coisa = a sonda quebrou. */
const PROBE_ALLOWED = 0;
const PROBE_DENIED = 7;
const PROBE_SCRIPT = `const fs = require('node:fs/promises');
(async () => {
  const probe = await fs.open(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    await probe.sync();
    process.exitCode = ${PROBE_ALLOWED};
  } catch (error) {
    process.exitCode = error && error.code === 'ERR_ACCESS_DENIED' ? ${PROBE_DENIED} : 8;
  } finally {
    await probe.close();
  }
})();
`;

/** O node deste processo deixa `fsync` sob `--permission`? (a mesma sonda do teste do artefato do `sign`, notas da W4.6) */
function permissionFsync(): 'allowed' | 'denied' {
  const dir = tmpDir('sra-fsync-');
  const script = path.join(tmpDir('sra-sonda-'), 'sonda-fsync.cjs');
  fs.writeFileSync(script, PROBE_SCRIPT);
  const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${path.dirname(script)}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, script, dir], { encoding: 'utf8', timeout: 30_000 });
  if (result.status === PROBE_ALLOWED) return 'allowed';
  if (result.status === PROBE_DENIED) return 'denied';
  return assert.fail(`a sonda de fsync sob --permission quebrou (${process.version}; status ${String(result.status)}): ${result.stderr}`);
}

interface FilledWrapper {
  readonly file: string;
  readonly lock: string;
}

/** O modelo de wrapper com os caminhos do host fictício (`w`), o artefato, o hash e o node trocados; o resto da linha fica como no modelo. */
function fillWrapper(template: string, w: SealWorld, artifact: string, hash: string, node: string = process.execPath): FilledWrapper {
  const dir = realTmp('sra-wrapper-');
  const lock = path.join(dir, 'seals.flock');
  fs.writeFileSync(lock, '', { mode: 0o644 });
  const values: Readonly<Record<string, string>> = { ARTIFACT: artifact, ARTIFACT_SHA256: hash, NODE: node, LOCK: lock, SEALS_ROOT: w.sealsRoot, TRUST_LIST: w.trustFile, NODE_LOCK: w.lockFile, LOG: w.logFile };
  let text = fs.readFileSync(template, 'utf8');
  const shared = ['ARTIFACT', 'ARTIFACT_SHA256', 'NODE', 'LOCK'];
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^${name}='[^']*'$`, 'm');
    if (shared.includes(name)) assert.match(text, line, `${name} no modelo`);
    else if (!line.test(text)) continue; // os modelos de deploy não têm as variáveis do receptor de manifestos
    text = text.replace(line, `${name}='${value}'`);
  }
  const file = path.join(dir, 'wrapper');
  fs.writeFileSync(file, text, { mode: 0o755 });
  return { file, lock };
}

/** O ambiente EXATO do shell do wrapper (o tipo do Next exige NODE_ENV em ProcessEnv; o filho não o recebe). */
const runWrapper = (file: string, env: Record<string, string>, input: string | Buffer = '') => {
  const result = spawnSync('/bin/sh', [file], { env: env as NodeJS.ProcessEnv, input, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
};

function assertOneLine(run: { stdout: string; stderr: string }, w: SealWorld): void {
  const text = run.stdout + run.stderr;
  assert.ok((run.stdout === '') !== (run.stderr === ''), `um canal só: ${JSON.stringify(text)}`);
  assert.ok(text.endsWith('\n') && text.indexOf('\n') === text.length - 1, `uma linha: ${JSON.stringify(text)}`);
  assert.match(text.slice(0, -1), PUBLIC_LINE);
  for (const forbidden of [w.root, '/tmp', '/home', 'Warning', 'at ']) assert.ok(!text.includes(forbidden), `${forbidden} na saída pública`);
}

test('P9-R11 em processo REAL pelo modelo de wrapper preenchido (sha256 do artefato, flock do kernel, umask 027, env -i, node absoluto, --disable-sigusr1, --permission com os grants do §5.7): grava com fsync no Node 22 (OK WRITTEN, 0444, pasta nova 2750 com o setgid); repetido ⇒ OK ALREADY_PRESENT; lista com outro hash ⇒ 14; fora da gramática ⇒ 10; uma linha só; log 0600', { skip: !HAS_FLOCK && !STRICT ? 'sem /usr/bin/flock' : false, timeout: 180_000 }, async () => {
  const artifact = await built();
  const fsyncState = permissionFsync();
  if (STRICT) assert.equal(fsyncState, 'allowed', `SEAL_RECEIVER_ARTIFACT_STRICT=1: o node ${process.version} bloqueia fsync sob --permission; o CI e o host usam a linha 22`);
  for (const template of [PROD_WRAPPER, HML_WRAPPER]) {
    const env = template === PROD_WRAPPER ? 'producao' : 'homologacao';
    const w = sealWorld(env);
    const keyA = env === 'producao' ? KEY_A : signer('ensaio-artefato-a');
    const keyB = env === 'producao' ? KEY_B : signer('ensaio-artefato-b');
    const trust = installTrust(w, [listItem(keyA), listItem(keyB)]);
    const [first, second] = chainOf(AUD_A, [{ signer: keyA }, { signer: keyB }]) as [ReturnType<typeof chainOf>[number], ReturnType<typeof chainOf>[number]];
    deliverOnHost(w, first);
    const wrapper = fillWrapper(template, w, artifact.file, artifact.sha256);
    const call = (command: string, input: string): ReturnType<typeof runWrapper> => runWrapper(wrapper.file, { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: command }, input);
    const outside = call('qualquer-coisa', '');
    assertOneLine(outside, w);
    assert.equal(outside.status, 10, `${env}: ${outside.stderr}`);
    assert.equal(outside.stderr, 'ERRO E_COMMAND\n');
    const firstText = canonicalText(first);
    const present = call(putLine(sealRelpath(first), firstText, trust), firstText);
    assertOneLine(present, w);
    assert.equal(present.stdout, `OK ALREADY_PRESENT ${sealRelpath(first)} ${sha256(firstText)}\n`, `${env}: ${present.stderr}`);
    const secondText = canonicalText(second);
    const mismatch = call(putLine(sealRelpath(second), secondText, 'outra lista'), secondText);
    assert.equal(mismatch.status, 14);
    assert.equal(mismatch.stderr, 'ERRO E_TRUST_LIST_MISMATCH\n');
    const written = call(putLine(sealRelpath(second), secondText, trust), secondText);
    assertOneLine(written, w);
    const dest = path.join(w.sealsRoot, sealRelpath(second));
    if (fsyncState === 'allowed') {
      assert.equal(written.status, 0, `${env}: ${written.stderr}`);
      assert.equal(written.stdout, `OK WRITTEN ${sealRelpath(second)} ${sha256(secondText)}\n`);
      assert.equal(fs.readFileSync(dest, 'utf8'), secondText);
      assert.equal(fs.statSync(dest).mode & 0o7777, 0o444);
      const [fresh] = chainOf(AUD_B, [{ signer: keyA }]) as [ReturnType<typeof chainOf>[number]];
      const freshText = canonicalText(fresh);
      assert.equal(call(putLine(sealRelpath(fresh), freshText, trust), freshText).stdout, `OK WRITTEN ${sealRelpath(fresh)} ${sha256(freshText)}\n`);
      const dir = fs.statSync(path.join(w.sealsRoot, AUD_B));
      assert.equal(dir.mode & 0o7777, 0o2750, `${env}: pasta nova 2750 pelo umask 027 do wrapper e o setgid herdado`);
      assert.equal(dir.gid, fs.statSync(w.sealsRoot).gid);
    } else {
      // Node 24.22+: o modelo de permissões nega o fsync do temporário ⇒ recusa antes do link(), nada gravado (só o CI/host, na linha 22, grava)
      assert.equal(written.stderr, 'ERRO E_WRITE_FAILED\n', `${env}: ${written.stderr}`);
      assert.equal(written.status, 35);
      assert.deepEqual(fs.readdirSync(path.join(w.sealsRoot, AUD_A)), ['seal-0001.json'], 'nem nome final nem temporário');
    }
    assert.equal(fs.statSync(w.logFile).mode & 0o777, 0o600);
    const log = fs.readFileSync(w.logFile, 'utf8');
    assert.ok(log.split('\n').filter(Boolean).every((line) => JSON.parse(line) !== null), 'uma linha JSON por evento');
    assert.ok(!log.includes(second.signature), 'nenhum conteúdo do manifesto no log');
    assert.ok(!fs.existsSync(w.lockFile), 'a trava de defesa é liberada');
  }
});

test('P9-R11 em processo REAL: fora do modelo de permissões, com processo filho permitido ou com escrita concedida sobre a lista instalada ⇒ E_INTERNAL (29), sem tocar em nada', { timeout: 120_000 }, async () => {
  const artifact = await built();
  const w = sealWorld();
  const trust = installTrust(w, [listItem(KEY_A), listItem(KEY_B)]);
  const [first] = chainOf(AUD_A, [{ signer: KEY_A }]) as [ReturnType<typeof chainOf>[number]];
  const text = canonicalText(first);
  const fixed = ['--env', 'producao', '--seals-root', w.sealsRoot, '--trust-list', w.trustFile, '--lock', w.lockFile, '--log', w.logFile];
  const grants = [`--allow-fs-read=${w.sealsRoot}`, `--allow-fs-read=${w.trustFile}`, `--allow-fs-read=${artifact.file}`, `--allow-fs-write=${w.sealsRoot}`, `--allow-fs-write=${path.dirname(w.lockFile)}`, `--allow-fs-write=${path.dirname(w.logFile)}`];
  const viaEnvI = (nodeArgs: readonly string[]) => {
    const result = spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', `SSH_ORIGINAL_COMMAND=${putLine(sealRelpath(first), text, trust)}`, process.execPath, '--disable-sigusr1', ...nodeArgs, artifact.file, ...fixed], { input: text, timeout: 60_000 });
    return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
  };
  for (const [label, nodeArgs] of [
    ['sem --permission', []],
    ['com --allow-child-process', ['--permission', ...grants, '--allow-child-process']],
    ['com --allow-worker', ['--permission', ...grants, '--allow-worker']],
    ['com escrita sobre a lista instalada', ['--permission', ...grants, `--allow-fs-write=${w.trustFile}`]],
    ['com escrita em tudo', ['--permission', ...grants.filter((grant) => !grant.startsWith('--allow-fs-write')), '--allow-fs-write=*']],
    ['com leitura de tudo', ['--permission', ...grants.filter((grant) => !grant.startsWith('--allow-fs-read')), '--allow-fs-read=*']],
  ] as const) {
    const run = viaEnvI(nodeArgs);
    assertOneLine(run, w);
    assert.equal(run.status, 29, `${label}: ${run.stderr}`);
    assert.equal(run.stderr, 'ERRO E_INTERNAL\n', label);
  }
  assert.deepEqual(fs.readdirSync(w.sealsRoot), [], 'nada gravado');
  const ok = viaEnvI(['--permission', ...grants]);
  assertOneLine(ok, w);
  assert.ok(ok.status === 0 || ok.status === 35, `com a linha do §5.7, segue até a gravação (${ok.stderr}${ok.stdout})`);
});

/* ===================================================================================================================== wrapper */

test('wrapper (os dois modelos de manifestos): só marcadores; set -eu; sha256 do artefato antes de tudo (E_ARTIFACT, 17); Node, flock e trava conferidos (E_INTERNAL, 29); trava do kernel flock -n com saída 75 ⇒ E_LOCKED (16); umask 027 antes do Node; env -i com PATH fixo; node absoluto com --disable-sigusr1 --permission; exatamente os grants do §5.7, um por caminho; nenhum --allow-child-process/worker/addons/wasi', () => {
  for (const template of [PROD_WRAPPER, HML_WRAPPER]) {
    const text = fs.readFileSync(template, 'utf8');
    const code = text.replace(/^#.*$/gm, '');
    assert.equal(fs.statSync(template).mode & 0o111, 0o111, 'executável');
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.match(text, /^set -eu$/m);
    assert.match(text, /^ARTIFACT='\/opt\/gmn-receivers\/<VERSAO>\/gmn-seal-receiver\.cjs'$/m);
    assert.match(text, /^ARTIFACT_SHA256='<SHA256_DO_ARTEFATO>'$/m);
    assert.match(text, /^NODE='\/opt\/gmn-receivers\/node\/bin\/node'$/m);
    assert.match(text, /^FLOCK='\/usr\/bin\/flock'$/m);
    assert.match(text, /^LOCK_BUSY=75$/m);
    assert.match(text, /^fail\(\) \{\n {2}printf '%s\\n' "ERRO \$1" >&2\n {2}exit "\$2"\n\}$/m, 'a única saída do wrapper é ERRO <código>');
    assert.match(text, /^\[ "\$actual" = "\$ARTIFACT_SHA256" \] \|\| fail E_ARTIFACT 17$/m);
    assert.match(text, /^\[ -x "\$NODE" \] && \[ -x "\$FLOCK" \] && \[ -f "\$LOCK" \] && \[ -r "\$LOCK" \] \|\| fail E_INTERNAL 29$/m);
    assert.match(text, /^\[ "\$status" -ne "\$LOCK_BUSY" \] \|\| fail E_LOCKED 16$/m);
    assert.match(text, /^umask 027$/m);
    const launch = /^\{ err="\$\(\/usr\/bin\/env -i [\s\S]*?\|\| status=\$\?; \} 3>&1$/m.exec(text)?.[0] ?? '';
    assert.ok(launch.startsWith('{ err="$(/usr/bin/env -i PATH=/usr/bin:/bin "SSH_ORIGINAL_COMMAND=${SSH_ORIGINAL_COMMAND-}" "$FLOCK" -n -E "$LOCK_BUSY" "$LOCK" "$NODE" --disable-sigusr1 --permission \\\n'), launch);
    const grants = [...launch.matchAll(/"(--allow-[a-z-]+)=([^"]*)"/g)].map((match) => `${match[1]}=${match[2]}`);
    assert.deepEqual(grants, ['--allow-fs-read=$SEALS_ROOT', '--allow-fs-read=$TRUST_LIST', '--allow-fs-read=$ARTIFACT', '--allow-fs-write=$SEALS_ROOT', '--allow-fs-write=${NODE_LOCK%/*}', '--allow-fs-write=${LOG%/*}'], 'exatamente os grants do §5.7');
    assert.ok(!/--allow-(?:child-process|worker|addons|wasi)|--allow-fs-[a-z]+=\*|,/.test(launch), 'nenhum outro grant, curinga ou lista por vírgula');
    assert.match(launch, /"\$ARTIFACT" --env (?:producao|homologacao) --seals-root "\$SEALS_ROOT" --trust-list "\$TRUST_LIST" --lock "\$NODE_LOCK" --log "\$LOG" 2>&1 1>&3 3>&-\)" \|\| status=\$\?; \} 3>&1$/, 'o stdout segue pelo descritor 3; o stderr é capturado para o filtro');
    assert.ok(code.indexOf('sha256sum') < code.indexOf('umask 027') && code.indexOf('umask 027') < code.indexOf('"$FLOCK" -n'), 'hash, umask, e só então a trava e o Node');
    assert.ok(!/\beval\b|\$SSH_ORIGINAL_COMMAND\b(?!-)|`/.test(code), 'o comando pedido nunca é interpretado pelo shell');
    assert.ok(!/^\s*exec\b/m.test(code), 'sem exec: o wrapper precisa mapear a saída do flock');
    assert.ok(!/-o\b|--close/.test(launch.split('\n')[0] as string), 'o filho herda o descritor da trava (sem -o)');
    assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b|https?:\/\//.test(text), 'nenhum host, IP ou URL real');
  }
  const prod = fs.readFileSync(PROD_WRAPPER, 'utf8');
  for (const line of ["LOCK='/var/lib/gmn-receivers-locks/producao/seals.flock'", "SEALS_ROOT='<RAIZ_MANIFESTOS>'", "TRUST_LIST='/var/lib/gmn-deploy/producao/trust-keys.txt'", "NODE_LOCK='/var/lib/gmn-seals/producao/lock'", "LOG='/var/log/gmn-receivers/producao-seals.log'"]) assert.ok(prod.split('\n').includes(line), line);
  const hml = fs.readFileSync(HML_WRAPPER, 'utf8');
  for (const line of ["LOCK='/var/lib/gmn-receivers-locks/homologacao/seals.flock'", "SEALS_ROOT='/srv/gmn-hml/manifestos'", "TRUST_LIST='/var/lib/gmn-deploy/homologacao/trust-keys.txt'", "NODE_LOCK='/var/lib/gmn-seals/homologacao/lock'", "LOG='/var/log/gmn-receivers/homologacao-seals.log'"]) assert.ok(hml.split('\n').includes(line), line);
  assert.ok(!/trust-keys\.pending/.test(prod + hml), 'a pendente nunca entra nos grants');
});

/** Um node FALSO que registra argv, ambiente e umask e responde como o receptor faria a um comando fora da gramática. */
function recordingNode(dir: string): { readonly node: string; readonly record: string } {
  const record = path.join(dir, 'registro.json');
  const node = path.join(dir, 'node');
  fs.writeFileSync(node, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, umask: process.umask() }));\nprocess.stderr.write('ERRO E_COMMAND\\n');\nprocess.exit(10);\n`, { mode: 0o755 });
  return { node, record };
}

test('wrapper em processo (node falso): hash certo ⇒ roda o node com EXATAMENTE os grants e os parâmetros fixos, ambiente limpo (só PATH e o comando, sem interpretar) e umask 027; os parâmetros são aceitos pelo receptor', () => {
  for (const [template, env] of [[PROD_WRAPPER, 'producao'], [HML_WRAPPER, 'homologacao']] as const) {
    const w = sealWorld(env);
    const fakeDir = realTmp('sra-node-');
    const artifact = path.join(fakeDir, 'gmn-seal-receiver.cjs');
    fs.writeFileSync(artifact, 'artefato fictício', { mode: 0o444 });
    const { node, record } = recordingNode(fakeDir);
    const filled = fillWrapper(template, w, artifact, sha256('artefato fictício'), node);
    const hostile = 'put $(id) `id` ; rm -rf / && echo "x"';
    const result = spawnSync('/bin/sh', [filled.file], { env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: hostile, NODE_OPTIONS: '--require /tmp/x.js', LD_PRELOAD: '/tmp/x.so', HOME: '/home/x' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 10, result.stderr);
    const quiet = spawnSync('/bin/sh', [filled.file], { env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: hostile, NODE_OPTIONS: '--require /tmp/x.js', HOME: '/home/x', ENV: '/tmp/x.sh', BASH_ENV: '/tmp/x.sh' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });
    assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [10, '', 'ERRO E_COMMAND\n'], `${env}: só a linha do receptor, nada do ambiente hostil no stderr`);
    const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { argv: string[]; env: Record<string, string>; umask: number };
    assert.deepEqual(seen.env, { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: hostile }, `${env}: ambiente limpo, comando repassado byte a byte`);
    assert.equal(seen.umask, 0o027, `${env}: umask 027`);
    assert.deepEqual(seen.argv.slice(0, 9), ['--disable-sigusr1', '--permission', `--allow-fs-read=${w.sealsRoot}`, `--allow-fs-read=${w.trustFile}`, `--allow-fs-read=${artifact}`, `--allow-fs-write=${w.sealsRoot}`, `--allow-fs-write=${path.dirname(w.lockFile)}`, `--allow-fs-write=${path.dirname(w.logFile)}`, artifact]);
    const config = parseSealReceiverArgs(seen.argv.slice(9));
    assert.ok(config, `${env}: parâmetros aceitos pelo receptor`);
    assert.deepEqual(config, w.config);
  }
});

test('wrapper em processo: artefato com outro hash, ausente ou marcador sem preencher ⇒ ERRO E_ARTIFACT (17); Node ausente ou não executável, trava ausente ⇒ ERRO E_INTERNAL (29); nada roda e nenhum caminho sai', () => {
  const w = sealWorld();
  const make = (template: string, hash?: string) => {
    const fakeDir = realTmp('sra-node-');
    const artifact = path.join(fakeDir, 'gmn-seal-receiver.cjs');
    fs.writeFileSync(artifact, 'artefato fictício', { mode: 0o644 });
    const { node, record } = recordingNode(fakeDir);
    return { ...fillWrapper(template, w, artifact, hash ?? sha256('artefato fictício'), node), artifact, node, record };
  };
  const command = { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: `put ${AUD_A}/seal-0001.json ${'0'.repeat(64)} ${'0'.repeat(64)}` };
  const altered = make(PROD_WRAPPER);
  fs.appendFileSync(altered.artifact, 'x');
  const missing = make(HML_WRAPPER);
  fs.rmSync(missing.artifact);
  const placeholder = make(PROD_WRAPPER, '<SHA256_DO_ARTEFATO>');
  for (const filled of [altered, missing, placeholder]) {
    const result = runWrapper(filled.file, command);
    assert.deepEqual([result.status, result.stderr, result.stdout], [17, 'ERRO E_ARTIFACT\n', '']);
    assert.ok(!fs.existsSync(filled.record), 'o node não rodou');
  }
  const noNode = make(PROD_WRAPPER);
  fs.rmSync(noNode.node);
  const notExecutable = make(HML_WRAPPER);
  fs.chmodSync(notExecutable.node, 0o644);
  const noLock = make(PROD_WRAPPER);
  fs.rmSync(noLock.lock);
  for (const filled of [noNode, notExecutable, noLock]) {
    const result = runWrapper(filled.file, command);
    assert.deepEqual([result.status, result.stderr, result.stdout], [29, 'ERRO E_INTERNAL\n', '']);
    assert.ok(!fs.existsSync(filled.record), 'o node não rodou');
  }
});

test('wrapper em processo: trava do kernel (flock -n) ocupada por outra execução ⇒ ERRO E_LOCKED (16) sem rodar o node; solta, roda', { skip: !HAS_FLOCK && !STRICT ? 'sem /usr/bin/flock' : false, timeout: 60_000 }, async () => {
  const w = sealWorld();
  const fakeDir = realTmp('sra-node-');
  const artifact = path.join(fakeDir, 'gmn-seal-receiver.cjs');
  fs.writeFileSync(artifact, 'artefato fictício', { mode: 0o444 });
  const { node, record } = recordingNode(fakeDir);
  const filled = fillWrapper(HML_WRAPPER, w, artifact, sha256('artefato fictício'), node);
  const holder = spawn(FLOCK, ['-n', filled.lock, process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', detached: true });
  const command = { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: 'qualquer-coisa' };
  try {
    const deadline = Date.now() + 10_000;
    while (spawnSync(FLOCK, ['-n', filled.lock, 'true']).status === 0) {
      assert.ok(Date.now() < deadline, 'o processo de teste não pegou a trava');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const busy = runWrapper(filled.file, command);
    assert.deepEqual([busy.status, busy.stderr], [16, 'ERRO E_LOCKED\n']);
    assert.ok(!fs.existsSync(record), 'o node não rodou');
  } finally {
    try {
      process.kill(-(holder.pid as number), 'SIGKILL');
    } catch {
      // o grupo já terminou
    }
  }
  const deadline = Date.now() + 10_000;
  while (spawnSync(FLOCK, ['-n', filled.lock, 'true']).status !== 0) {
    assert.ok(Date.now() < deadline, 'a trava não foi solta');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(runWrapper(filled.file, command).status, 10);
  assert.ok(fs.existsSync(record), 'sem disputa, o node roda (debaixo da trava)');
});

const ALL_WRAPPERS = ['gmn-deploy.modelo.sh', 'gmn-hml-deploy.modelo.sh', 'gmn-seals.modelo.sh', 'gmn-hml-seals.modelo.sh'].map((name) => path.join(RECEIVER_TEMPLATES_DIR, name));

test('wrapper (os quatro modelos; revisão do PR #72, item 5): o próprio wrapper nunca ecoa caminho nem texto livre: só `ERRO <código literal>` pelo fail e a linha do receptor que passa no filtro do conjunto fechado (uma linha, `ERRO E_…`, sem `/`, `.` nem espaço extra); o stderr do flock, do env e do node é capturado; a trava do kernel fica numa pasta do root', () => {
  for (const template of ALL_WRAPPERS) {
    const code = fs.readFileSync(template, 'utf8').replace(/^#.*$/gm, '');
    assert.ok(!/\becho\b/.test(code), 'sem echo');
    const prints = [...code.matchAll(/printf [^\n]*/g)].map((match) => match[0]);
    assert.deepEqual(prints, ["printf '%s\\n' \"ERRO $1\" >&2", "printf '%s\\n' \"$1\" | LC_ALL=C /usr/bin/grep -Eqx 'ERRO E_[A-Z0-9_]+( [A-Z0-9_-]+)?' 2>/dev/null", "printf '%s\\n' \"$err\" >&2"], `${path.basename(template)}: só estes printf`);
    assert.match(code, /actual="\$\(\/usr\/bin\/sha256sum -- "\$ARTIFACT" 2>\/dev\/null\)"/, 'o stderr do sha256sum nunca sai');
    assert.match(code, /^set -eu\n+unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_PROFILE LD_PROFILE_OUTPUT$/m, 'variáveis do carregador fora antes de qualquer programa');
    assert.match(code, /^\{ err="\$\(\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin "SSH_ORIGINAL_COMMAND=\$\{SSH_ORIGINAL_COMMAND-\}" "\$FLOCK" /m, 'env -i antes do flock (flock e node com o ambiente limpo)');
    for (const call of code.matchAll(/\bfail (\S+) (\S+)/g)) assert.match(`${call[1]} ${call[2]}`, /^E_[A-Z_]+ \d+$/, `${path.basename(template)}: fail só com código literal`);
    assert.match(code, /\[ "\$status" -ne "\$LOCK_BUSY" \] \|\| fail E_LOCKED 16\n\[ "\$status" -ne 0 \] \|\| exit 0\npublic_error "\$err" \|\| fail E_INTERNAL 29\nprintf '%s\\n' "\$err" >&2\nexit "\$status"\n$/, 'o filtro antes de repassar a linha do receptor');
    assert.match(code, /case "\$1" in '' \| \*"\$NL"\*\) return 1 ;; esac/, 'vazio ou mais de uma linha não passa');
    assert.match(code, /^LOCK='\/var\/lib\/gmn-receivers-locks\/(?:producao|homologacao)\/(?:deploy|seals)\.flock'$/m, 'trava do kernel na pasta do root');
  }
});

test('wrapper em processo (revisão do PR #72, item 5): node que morre com pilha e caminho no stderr, ou que escreve duas linhas, ⇒ só `ERRO E_INTERNAL` (29); a linha do receptor do conjunto fechado passa com a saída dele; no sucesso, o stdout segue e o ruído do stderr some', () => {
  const w = sealWorld();
  for (const template of ALL_WRAPPERS) {
    const dir = realTmp('sra-noisy-');
    const artifact = path.join(dir, 'artefato.cjs');
    fs.writeFileSync(artifact, 'artefato fictício', { mode: 0o444 });
    const node = path.join(dir, 'node');
    const filled = fillWrapper(template, w, artifact, sha256('artefato fictício'), node);
    const behave = (body: string): void => fs.writeFileSync(node, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    const call = () => runWrapper(filled.file, { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: 'qualquer-coisa' });
    behave(`process.stderr.write('Error: Access to this API has been restricted\\n    at Object.openSync (node:fs:573:18)\\n    at /opt/gmn-receivers/x/artefato.cjs:1:1 ' + ${JSON.stringify(w.root)} + '\\n'); process.exit(1);`);
    assert.deepEqual(Object.values(call()), [29, '', 'ERRO E_INTERNAL\n'], `${path.basename(template)}: pilha com caminho`);
    behave("process.stderr.write('ERRO E_COMMAND\\nERRO E_INTERNAL\\n'); process.exit(10);");
    assert.deepEqual(Object.values(call()), [29, '', 'ERRO E_INTERNAL\n'], 'duas linhas');
    behave("process.stderr.write('ERRO E_COMMAND /tmp/x\\n'); process.exit(10);");
    assert.deepEqual(Object.values(call()), [29, '', 'ERRO E_INTERNAL\n'], 'linha com caminho');
    behave("process.exit(3);");
    assert.deepEqual(Object.values(call()), [29, '', 'ERRO E_INTERNAL\n'], 'saída sem linha');
    behave("process.stderr.write('ERRO E_V2_REFUSED SEAL_KEY_REVOKED\\n'); process.exit(32);");
    assert.deepEqual(Object.values(call()), [32, '', 'ERRO E_V2_REFUSED SEAL_KEY_REVOKED\n'], 'a linha do receptor passa');
    behave("process.stderr.write('ERRO E_POSTDEPLOY_CHECK PD-07\\n'); process.exit(64);");
    assert.deepEqual(Object.values(call()), [64, '', 'ERRO E_POSTDEPLOY_CHECK PD-07\n'], 'detalhe PD-xx do receptor de deploy');
    behave("process.stdout.write('OK WRITTEN aud-0123456789abcdef/seal-0001.json ' + 'a'.repeat(64) + '\\n'); process.stderr.write('(node:1) Warning: ' + " + JSON.stringify(w.root) + " + '\\n');");
    assert.deepEqual(Object.values(call()), [0, `OK WRITTEN aud-0123456789abcdef/seal-0001.json ${'a'.repeat(64)}\n`, ''], 'sucesso: stdout segue, ruído some');
  }
});

/* ===================================================================================================================== zod e CI */

test('P9-R11 artefato: a entrada configura o zod SEM JIT antes de qualquer esquema; carregar o artefato real não chama Function nenhuma vez', { timeout: 60_000 }, async () => {
  const artifact = await built();
  const counter = path.join(tmpDir('sra-jit-'), 'conta-function.cjs');
  fs.writeFileSync(counter, [
    'const Original = Function;',
    'let calls = 0;',
    'globalThis.Function = new Proxy(Original, { construct(target, args) { calls += 1; return Reflect.construct(target, args); }, apply(target, self, args) { calls += 1; return Reflect.apply(target, self, args); } });',
    "process.on('exit', () => process.stderr.write('FUNCTION_CALLS=' + calls + '\\n'));",
    '',
  ].join('\n'));
  const run = spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', process.execPath, '--require', counter, artifact.file, '--env', 'producao'], { encoding: 'utf8', timeout: 30_000 });
  assert.match(run.stderr, /^ERRO E_INTERNAL\n/);
  assert.match(run.stderr, /FUNCTION_CALLS=0\b/, run.stderr);
  assert.equal(run.status, 29);
});

test('CI: o job "receivers artifact (build, hash)" roda este teste em modo estrito (SEAL_RECEIVER_ARTIFACT_STRICT=1) e sobe o artefato e os modelos de manifestos com o hash versionado', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = /\n {2}receivers-artifact:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|\n?$)/.exec(ci)?.[1] ?? '';
  assert.match(job, /node-version: '22'/, 'a linha 22 do Node (fsync permitido sob --permission)');
  assert.match(job, /SEAL_RECEIVER_ARTIFACT_STRICT: '1'/);
  assert.match(job, /tests\/link-audit-seal-receiver-artifact\.test\.ts/);
  for (const name of [SEAL_RECEIVER_FILE_NAME, 'gmn-seals.modelo.sh', 'gmn-hml-seals.modelo.sh', 'receivers.sha256']) assert.ok(job.includes(`\${{ runner.temp }}/receivers-artifact/${name}`), `upload de ${name}`);
});

test('runbook H-04/H-05/H-06 (P9.3b): artefato e modelos de manifestos instalados só depois do sha256sum -c; wrapper gmn-hml-seals preenchido numa pasta privada (mktemp -d) depois de conferir o modelo de novo, instalado 0755 do root, comparado e com o sha256 registrado; usuário de manifestos fora de docker/sudo/10001; pasta gmn-hml-seals:10001 2750 e trava seals.flock do root; blocos privilegiados em subshell com set -euo pipefail', () => {
  const runbook = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'hostinger', 'RUNBOOK-DEPLOY-PELO-CI.md'), 'utf8');
  const section = (from: string, to: string): string => runbook.slice(runbook.indexOf(from), runbook.indexOf(to));
  /** Os blocos `bash`, sem a indentação de item de lista (o recuo da primeira linha sai de todas). */
  const blocks = (text: string): string[] =>
    [...text.matchAll(/^( *)```bash\n([\s\S]*?)\n *```/gm)].map((match) => (match[2] as string).replace(new RegExp(`^ {0,${(match[1] as string).length}}`, 'gm'), ''));
  const h04 = blocks(section('### H-04', '### H-05'));
  const all04 = h04.join('\n');
  assert.ok(!/\/tmp\//.test(all04), 'nenhum caminho fixo do /tmp');
  const vpsCheck = all04.indexOf('( cd "$S" && sha256sum -c --strict receivers.sha256 )');
  const sealInstall = all04.indexOf('"$S/gmn-seal-receiver.cjs" "$S/gmn-seals.modelo.sh" "$S/gmn-hml-seals.modelo.sh"');
  assert.ok(vpsCheck > 0 && sealInstall > vpsCheck, 'na VPS: sha256sum -c dos seis antes de instalar o receptor de manifestos e os modelos');
  const seals = h04.find((block) => block.includes('"$K/gmn-hml-seals.modelo.sh" > "$T/gmn-hml-seals"')) ?? '';
  assert.ok(seals.startsWith('( set -euo pipefail'), 'subshell que para no primeiro erro');
  assert.match(seals, /T="\$\(mktemp -d\)"/, 'pasta privada');
  const recheck = seals.indexOf('( cd "$K" && sha256sum -c --strict receivers.sha256 )');
  const fill = seals.indexOf('"$K/gmn-hml-seals.modelo.sh" > "$T/gmn-hml-seals"');
  const markers = seals.indexOf("grep -n '<[A-Z_]*>' \"$T/gmn-hml-seals\"");
  const install = seals.indexOf('sudo install -m 0755 -o root -g root "$T/gmn-hml-seals" /opt/gmn-receivers/bin/gmn-hml-seals');
  assert.ok(recheck > 0 && recheck < fill && fill < markers && markers < install, 'modelo conferido de novo, preenchido, sem marcador, e só então instalado');
  assert.match(seals, /awk '\$2 == "gmn-seal-receiver\.cjs" \{ print \$1 \}' "\$K\/receivers\.sha256"/, 'o hash do artefato de manifestos vem do receivers.sha256 conferido');
  assert.match(seals, /cmp "\$T\/gmn-hml-seals" \/opt\/gmn-receivers\/bin\/gmn-hml-seals/);
  assert.match(seals, /sha256sum \/opt\/gmn-receivers\/bin\/gmn-hml-seals\s+# registrar/);
  assert.match(seals, /rm -rf -- "\$T"\n\)$/);
  const h05 = blocks(section('### H-05', '### H-06')).find((block) => block.includes('useradd')) ?? '';
  assert.ok(h05.startsWith('( set -euo pipefail'), 'H-05 em subshell');
  assert.ok(!/usermod -aG docker gmn-hml-seals|usermod -aG [a-z,]*\b(?:sudo|10001)\b/.test(h05), 'o usuário de manifestos nunca entra em docker, sudo ou 10001');
  assert.match(h05, /grep -qxE '0\|10001'/, 'e o bloco confere');
  const h06 = blocks(section('### H-06', '### H-07'));
  const folders = h06.find((block) => block.includes('/srv/gmn-hml/manifestos')) ?? '';
  const state = h06.find((block) => block.includes('gmn-receivers-locks')) ?? '';
  for (const block of [folders, state]) assert.ok(block.startsWith('( set -euo pipefail'), 'H-06 em subshell');
  assert.match(folders, /sudo install -d -m 2750 -o gmn-hml-seals -g 10001 \/srv\/gmn-hml\/manifestos/);
  assert.match(folders, /\[ "\$\(stat -c '%U:%g %a' \/srv\/gmn-hml\/manifestos\)" = "gmn-hml-seals:10001 2750" \]/);
  assert.match(state, /sudo install -d -m 0755 -o root -g root \/var\/lib\/gmn-receivers-locks \/var\/lib\/gmn-receivers-locks\/homologacao/, 'a pasta das travas do kernel é do root e o usuário do receptor não grava nela');
  assert.match(state, /for lock in deploy seals; do\n\s+f="\/var\/lib\/gmn-receivers-locks\/homologacao\/\$lock\.flock"\n\s+\[ -e "\$f" \] \|\| sudo install -m 0644 -o root -g root \/dev\/null "\$f"/, 'as duas travas do kernel, do root, 0644');
  assert.ok(!/gmn-seals\/homologacao\/seals\.flock|gmn-deploy\/homologacao\/deploy\.flock/.test(runbook), 'nenhuma trava do kernel numa pasta do usuário do receptor');
  const cleanup = section('### H-04', '### H-05');
  assert.match(cleanup, /sudo flock -n \/var\/lib\/gmn-receivers-locks\/<amb>\/seals\.flock rm -- \/var\/lib\/gmn-seals\/<amb>\/lock/, 'a limpeza manual segura a trava do kernel enquanto apaga');
  assert.match(cleanup, /sudo flock -n \/var\/lib\/gmn-receivers-locks\/<amb>\/deploy\.flock rm -- \/var\/lib\/gmn-deploy\/<amb>\/deploy\.lock/);
  assert.match(state, /sudo install -d -m 0700 -o gmn-hml-seals -g gmn-hml-seals \/var\/lib\/gmn-seals\/homologacao/);
  const template = fs.readFileSync(HML_WRAPPER, 'utf8');
  for (const [name, value] of [['LOCK', '/var/lib/gmn-receivers-locks/homologacao/seals.flock'], ['SEALS_ROOT', '/srv/gmn-hml/manifestos'], ['NODE_LOCK', '/var/lib/gmn-seals/homologacao/lock'], ['LOG', '/var/log/gmn-receivers/homologacao-seals.log']] as const) {
    assert.ok(template.split('\n').includes(`${name}='${value}'`), `${name} do modelo`);
    if (name !== 'LOG') assert.ok(runbook.includes(value.replace(/\/lock$/, '')), `${value}: o mesmo caminho no runbook`);
  }
  assert.ok(state.includes('log="/var/log/gmn-receivers/homologacao-${pair%%:*}.log"') && state.includes('seals:gmn-hml-seals'), 'o log do modelo é o que o H-06 cria (0600, do usuário de manifestos)');
});

test('plano de backup e runbook (revisão do PR #72, item 2): a restauração da pasta de manifestos segura a trava do kernel do receptor durante TODA a troca (flock -n antes dos mv, solta só depois da conferência no lugar) e devolve gmn-seals:10001 2750 com arquivos 0444', () => {
  const plan = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'hostinger', 'PLANO-DE-BACKUP-E-RESTAURACAO.md'), 'utf8');
  const block = (plan.match(/```bash[\s\S]*?```/g) ?? []).find((text) => text.includes('seals.flock')) ?? '';
  const at = (needle: string): number => block.indexOf(needle);
  const order = ['exec 8<"/var/lib/gmn-receivers-locks/producao/seals.flock"', 'flock -n 8 ||', 'mv -- "$P" "$P.antigo-', 'mv -- "$P.restaurado-<RODADA>" "$P"', 'chown -R gmn-seals:10001 -- "$P"', 'find "$P" -type d -exec chmod 2750', 'find "$P" -type f -exec chmod 0444', 'sha256sum --quiet --strict -c "$C/SHA256SUMS"', 'exec 8<&-'].map(at);
  assert.ok(order.every((index) => index >= 0), `todos os passos no bloco: ${order.join(',')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'trava, troca, dono e modos, conferência, e só então solta');
  const runbook = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'hostinger', 'RUNBOOK-DEPLOY-PELO-CI.md'), 'utf8');
  assert.match(runbook, /\*\*Restauração da pasta de manifestos\*\* \(backup\): a troca inteira roda segurando a trava do kernel do receptor de manifestos/);
});
