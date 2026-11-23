import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseRelpath } from '../src/lib/seal-receiver/grammar';
import { CLOSURE_REFUSAL_DETAILS, SEAL_RECEIVER_EXIT_CODES, V2_REFUSAL_DETAILS } from '../src/lib/seal-receiver/codes';
import { assertNoLeak, assertRefused, calls, makeSandbox, outputs, runScript, setScenario, TRUST_LIST, type FakeResponse, type FakeRule, type RunResult, type Sandbox } from './helpers/deploy-ci-sandbox';
import { isYamlMap, parseYamlSubset } from './helpers/yaml-subset';

/*
 * P9.5 (spec docs/specs/ci-deploy-and-seal-delivery.md §5.5, §5.5.2, §5.7 "Para o job de entrega", §5.8 e §5.9): os scripts dos jobs
 * `seals-verify` e `seals-deliver` executados de verdade numa pasta temporária que imita a raiz do repositório. O git é o REAL (sobre um
 * repositório local temporário); `ssh`, `gh` e `npm` são FALSOS no PATH. Nada aqui abre rede, chama SSH ou o GitHub, nem lê segredo: os
 * valores são sentinelas fictícias, e cada teste confere que elas não vazam para a saída nem para o resumo.
 */
const ROOT = path.join(__dirname, '..');
const SEALS_FAKES = ['ssh', 'gh', 'npm'] as const;
const HOST_SENTINEL = 'vps-sentinela.invalid';
// Moldura montada por partes: o texto literal completo dispararia o scanner de segredos do CI.
const PEM_LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ');
const KEY_SENTINEL = `-----BEGIN ${PEM_LABEL}-----\nsentinela-chave-de-manifestos\n-----END ${PEM_LABEL}-----`;
const DEPLOY_KEY_SENTINEL = `-----BEGIN ${PEM_LABEL}-----\nsentinela-chave-de-deploy\n-----END ${PEM_LABEL}-----`;
const KNOWN_HOSTS_LINE = `${HOST_SENTINEL} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake`;
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const TRUST_SHA = sha256(TRUST_LIST);
const AUD_A = 'aud-0000000000000a01';
const AUD_B = 'aud-0000000000000b02';
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'teste', GIT_AUTHOR_EMAIL: 'teste@exemplo.invalid', GIT_COMMITTER_NAME: 'teste', GIT_COMMITTER_EMAIL: 'teste@exemplo.invalid' };
const seal = (auditId: string, seq: number): string => `${auditId}/seal-${String(seq).padStart(4, '0')}.json`;
const content = (relpath: string): string => `{"falso":"${relpath}"}\n`;

type Fixture = { readonly t: { after: (fn: () => void) => void } };
const sandboxOf = (t: Fixture['t']): Sandbox => makeSandbox(t, {}, { fakes: SEALS_FAKES });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: { ...GIT_ENV, PATH: '/usr/bin:/bin', HOME: cwd } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Um arquivo sob link-audit-seals/ do sandbox (caminho relativo a link-audit-seals/). */
function put(sandbox: Sandbox, rel: string, data: string | Buffer): string {
  const file = path.join(sandbox.root, 'link-audit-seals', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/** Um link simbólico sob <amb>/seals/ (o git o guarda com o modo 120000). */
function linkSeal(sandbox: Sandbox, rel: string): void {
  const file = path.join(sandbox.root, 'link-audit-seals', 'homologacao', 'seals', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync('../../trust-keys.txt', file);
}

/** Repositório git REAL na raiz do sandbox, com link-audit-seals/ (e o .gitattributes do projeto) versionados; devolve o SHA. */
function commitAll(sandbox: Sandbox, message = 'manifestos'): string {
  if (!fs.existsSync(path.join(sandbox.root, '.git'))) {
    git(sandbox.root, 'init', '-q', '-b', 'main');
    fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(sandbox.root, '.gitattributes'));
  }
  git(sandbox.root, 'add', '-A', '--', 'link-audit-seals', '.gitattributes');
  git(sandbox.root, 'commit', '-q', '--allow-empty', '-m', message);
  return git(sandbox.root, 'rev-parse', 'HEAD');
}

const withHome = (sandbox: Sandbox, env: Record<string, string>): Record<string, string> => ({ HOME: sandbox.root, ...GIT_ENV, ...env });
const listFile = (sandbox: Sandbox): string => path.join(sandbox.runnerTemp, 'gmn-seals', 'files');
const resultsFile = (sandbox: Sandbox): string => path.join(sandbox.runnerTemp, 'gmn-seals', 'results');
const readLines = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');

/* ------------------------------------------------------------------------------------------------ passo 1: a lista ordenada */

test('P9.5 lista (passo 1): TODOS os arquivos de <amb>/seals/ em ordem determinística, manifestos por auditId e seq, depois os fechos; sha256 de cada arquivo e da lista de confiança; só o ambiente pedido', (t) => {
  const sandbox = sandboxOf(t);
  const rels = [seal(AUD_B, 2), seal(AUD_A, 10), seal(AUD_A, 2), seal(AUD_B, 1), '_closures/zz-chave.json', seal(AUD_A, 1), '_closures/ab-cd.json', '_closures/abcd.json'];
  for (const rel of rels) put(sandbox, `homologacao/seals/${rel}`, content(rel));
  put(sandbox, `producao/seals/${seal(AUD_A, 1)}`, content('producao'));
  const sha = commitAll(sandbox);
  const result = runScript(sandbox, 'seals-files.sh', [], withHome(sandbox, { GMN_AMB: 'homologacao', GMN_SHA: sha }));
  assert.equal(result.status, 0, result.stderr);
  const expected = [seal(AUD_A, 1), seal(AUD_A, 2), seal(AUD_A, 10), seal(AUD_B, 1), seal(AUD_B, 2), '_closures/ab-cd.json', '_closures/abcd.json', '_closures/zz-chave.json'];
  assert.deepEqual(readLines(listFile(sandbox)), expected.map((rel) => `${rel} ${sha256(content(rel))}`));
  assert.deepEqual(outputs(sandbox), { trust_sha256: TRUST_SHA, count: '8' });
  assert.equal(fs.statSync(path.dirname(listFile(sandbox))).mode & 0o777, 0o700);
  assert.equal(fs.statSync(listFile(sandbox)).mode & 0o777, 0o600);
  // revisão do PR #74, item 6: uma cópia privada 0600 de cada blob do commit, com o sha256 da lista
  const blobs = path.join(sandbox.runnerTemp, 'gmn-seals', 'blobs');
  assert.equal(fs.statSync(blobs).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(blobs).sort(), expected.map((rel) => sha256(content(rel))).sort());
  for (const rel of expected) {
    const blob = path.join(blobs, sha256(content(rel)));
    assert.equal(fs.readFileSync(blob, 'utf8'), content(rel));
    assert.equal(fs.statSync(blob).mode & 0o777, 0o600);
  }
  assert.match(result.stdout, /^8 arquivo\(s\) a entregar \(5 manifesto\(s\), 3 fecho\(s\)\); lista de confiança do commit: sha256 [0-9a-f]{64}$/m);
  assert.ok(!result.stdout.includes('falso'), 'nenhum conteúdo de arquivo no log');

  setScenario(sandbox, {});
  assert.equal(runScript(sandbox, 'seals-files.sh', [], withHome(sandbox, { GMN_AMB: 'producao', GMN_SHA: sha })).status, 0);
  assert.deepEqual(readLines(listFile(sandbox)), [`${seal(AUD_A, 1)} ${sha256(content('producao'))}`], 'a lista de produção é só a de produção');
  assert.equal(outputs(sandbox).trust_sha256, sha256(''), 'lista vazia (política fechada) também tem hash');
});

test('P9.5 lista: caminho fora da gramática (sem eco), link, executável, acima de 256 KiB, bytes do checkout ≠ blob do commit e checkout de outro commit ⇒ recusa com código fixo', (t) => {
  const cases: Array<[string, (sandbox: Sandbox) => void, string, string | undefined]> = [
    ['fora da gramática', (s) => put(s, 'homologacao/seals/AUD-001/seal-0001.json', 'x'), 'SEALS_UNEXPECTED_PATH', undefined],
    ['seal-0257', (s) => put(s, `homologacao/seals/${AUD_A}/seal-0257.json`, 'x'), 'SEALS_UNEXPECTED_PATH', undefined],
    ['caixa', (s) => put(s, `homologacao/seals/${AUD_A}/SEAL-0001.json`, 'x'), 'SEALS_UNEXPECTED_PATH', undefined],
    ['link', (s) => linkSeal(s, seal(AUD_B, 2)), 'SEALS_BAD_MODE', seal(AUD_B, 2)],
    ['executável', (s) => fs.chmodSync(put(s, `homologacao/seals/${seal(AUD_B, 1)}`, 'x'), 0o755), 'SEALS_BAD_MODE', seal(AUD_B, 1)],
    ['grande', (s) => put(s, `homologacao/seals/${seal(AUD_B, 1)}`, Buffer.alloc(262145, 0x20)), 'SEALS_TOO_LARGE', seal(AUD_B, 1)],
  ];
  for (const [label, arrange, code, detail] of cases) {
    const sandbox = sandboxOf(t);
    put(sandbox, `homologacao/seals/${seal(AUD_A, 1)}`, content('a'));
    arrange(sandbox);
    const sha = commitAll(sandbox, label);
    const result = runScript(sandbox, 'seals-files.sh', [], withHome(sandbox, { GMN_AMB: 'homologacao', GMN_SHA: sha }));
    assertRefused(sandbox, result, code, detail);
    assertNoLeak(result, 'AUD-001', 'SEAL-0001', 'seal-0257');
  }
  const other = sandboxOf(t);
  put(other, `homologacao/seals/${seal(AUD_A, 1)}`, content('a'));
  commitAll(other);
  assertRefused(other, runScript(other, 'seals-files.sh', [], withHome(other, { GMN_AMB: 'homologacao', GMN_SHA: 'f'.repeat(40) })), 'CHECKOUT_MISMATCH');
});

test('P9.5 lista: ambiente ou SHA inválidos, lista de confiança do COMMIT ausente, link ou acima de 8 KiB, ambiente sem nenhum arquivo ⇒ recusa antes de qualquer arquivo', (t) => {
  const sandbox = sandboxOf(t);
  let sha = commitAll(sandbox);
  const env = (extra: Record<string, string> = {}): Record<string, string> => withHome(sandbox, { GMN_AMB: 'homologacao', GMN_SHA: sha, ...extra });
  assertRefused(sandbox, runScript(sandbox, 'seals-files.sh', [], env({ GMN_AMB: 'staging' })), 'INPUT_INVALID', 'GMN_AMB');
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'seals-files.sh', [], env({ GMN_SHA: 'main' })), 'INPUT_INVALID', 'GMN_SHA');
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'seals-files.sh', [], env()), 'SEALS_EMPTY');
  const trust = path.join(sandbox.root, 'link-audit-seals', 'homologacao', 'trust-keys.txt');
  fs.writeFileSync(trust, 'x'.repeat(8193));
  sha = commitAll(sandbox, 'lista grande');
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'seals-files.sh', [], env()), 'TRUST_LIST_TOO_LARGE');
  fs.rmSync(trust);
  fs.symlinkSync('../producao/trust-keys.txt', trust);
  sha = commitAll(sandbox, 'lista link');
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'seals-files.sh', [], env()), 'HASH_INPUT_MISSING', 'trust-keys.txt');
  fs.rmSync(trust);
  sha = commitAll(sandbox, 'sem lista');
  setScenario(sandbox, {});
  assertRefused(sandbox, runScript(sandbox, 'seals-files.sh', [], env()), 'HASH_INPUT_MISSING', 'trust-keys.txt');
});

test('P9.5 lista: teto de 1000 arquivos por execução ⇒ SEALS_TOO_MANY conferido ANTES de olhar qualquer arquivo (nem o caminho fora da gramática chega a ser visto)', (t) => {
  const sandbox = sandboxOf(t);
  for (let i = 0; i < 1000; i += 1) put(sandbox, `homologacao/seals/${seal(`aud-${i.toString(16).padStart(16, '0')}`, 1)}`, 'x');
  put(sandbox, 'homologacao/seals/AUD-001/seal-0001.json', 'x');
  const sha = commitAll(sandbox);
  assertRefused(sandbox, runScript(sandbox, 'seals-files.sh', [], withHome(sandbox, { GMN_AMB: 'homologacao', GMN_SHA: sha })), 'SEALS_TOO_MANY');
  assert.ok(!fs.existsSync(path.join(sandbox.runnerTemp, 'gmn-seals', 'files')), 'nenhuma lista gerada');
});

/* ------------------------------------------------------------------------------------------------ passo 2: chave de manifestos */

const SEALS_SSH_ENV = { GMN_AMB: 'homologacao', GMN_SSH_HOST: HOST_SENTINEL, GMN_SEALS_SSH_KEY: KEY_SENTINEL, GMN_SSH_KNOWN_HOSTS: KNOWN_HOSTS_LINE };

test('P9.5 chave (ssh-setup.sh seals): a chave de MANIFESTOS em id_seals, apelido gmn-seal-receiver, usuário gmn-hml-seals / gmn-seals, as mesmas opções fixas do deploy; a chave de deploy nunca é lida', (t) => {
  const sandbox = sandboxOf(t);
  const result = runScript(sandbox, 'ssh-setup.sh', ['seals'], { ...SEALS_SSH_ENV, GMN_DEPLOY_SSH_KEY: DEPLOY_KEY_SENTINEL });
  assert.equal(result.status, 0, result.stderr);
  const sshDir = path.join(sandbox.runnerTemp, 'gmn-ssh');
  assert.deepEqual(fs.readdirSync(sshDir).sort(), ['config', 'id_seals', 'known_hosts']);
  for (const name of ['config', 'id_seals', 'known_hosts']) assert.equal(fs.statSync(path.join(sshDir, name)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(sshDir).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(sshDir, 'id_seals'), 'utf8'), `${KEY_SENTINEL}\n`);
  const config = fs.readFileSync(path.join(sshDir, 'config'), 'utf8');
  assert.ok(config.startsWith(`Host gmn-seal-receiver\n  HostName ${HOST_SENTINEL}\n  Port 22\n  User gmn-hml-seals\n  IdentityFile "${sshDir}/id_seals"\n  IdentitiesOnly yes\n`));
  for (const option of ['BatchMode yes', 'StrictHostKeyChecking yes', `UserKnownHostsFile "${sshDir}/known_hosts"`, 'GlobalKnownHostsFile /dev/null', 'LogLevel ERROR', 'ConnectTimeout 20', 'ServerAliveInterval 15', 'RequestTTY no', 'ClearAllForwardings yes']) {
    assert.ok(config.includes(`\n  ${option}\n`), option);
  }
  assert.ok(!config.includes('sentinela-chave-de-deploy') && !fs.readFileSync(path.join(sshDir, 'id_seals'), 'utf8').includes('deploy'), 'a chave de deploy nunca no job de entrega');
  assertNoLeak(result, 'sentinela-chave', HOST_SENTINEL);

  setScenario(sandbox, {});
  assert.equal(runScript(sandbox, 'ssh-setup.sh', ['seals'], { ...SEALS_SSH_ENV, GMN_AMB: 'producao' }).status, 0);
  assert.match(fs.readFileSync(path.join(sshDir, 'config'), 'utf8'), /\n {2}User gmn-seals\n/);
});

test('P9.5 chave: papel ausente ou desconhecido, ou a chave de manifestos ausente (mesmo com a de deploy presente) ⇒ recusa sem escrever nada', (t) => {
  const sandbox = sandboxOf(t);
  const cases: Array<[string[], Record<string, string>, string, string]> = [
    [[], SEALS_SSH_ENV, 'INPUT_INVALID', 'role'],
    [['root'], SEALS_SSH_ENV, 'INPUT_INVALID', 'role'],
    [['seals'], { ...SEALS_SSH_ENV, GMN_SEALS_SSH_KEY: '', GMN_DEPLOY_SSH_KEY: DEPLOY_KEY_SENTINEL }, 'SSH_CONFIG_MISSING', 'GMN_SEALS_SSH_KEY'],
    [['seals'], { ...SEALS_SSH_ENV, GMN_SEALS_SSH_KEY: 'sentinela-sem-moldura' }, 'SSH_CONFIG_INVALID', 'GMN_SEALS_SSH_KEY'],
    [['deploy'], { ...SEALS_SSH_ENV, GMN_DEPLOY_SSH_KEY: '' }, 'SSH_CONFIG_MISSING', 'GMN_DEPLOY_SSH_KEY'],
  ];
  for (const [args, env, code, detail] of cases) {
    setScenario(sandbox, {});
    const result = runScript(sandbox, 'ssh-setup.sh', args, env);
    assertRefused(sandbox, result, code, detail);
    assertNoLeak(result, 'sentinela', HOST_SENTINEL);
    assert.ok(!fs.existsSync(path.join(sandbox.runnerTemp, 'gmn-ssh')), 'nada escrito');
  }
});

/* ------------------------------------------------------------------------------------------------ passos 3 e 4: um put por arquivo */

interface DeliverFixture {
  readonly sandbox: Sandbox;
  readonly rels: readonly string[];
}

/** A chave e a configuração do passo 2 (ssh-setup.sh seals), sem rodar o script. */
function writeSshFiles(sandbox: Sandbox): void {
  const sshDir = path.join(sandbox.runnerTemp, 'gmn-ssh');
  fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(sshDir, 'id_seals'), `${KEY_SENTINEL}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(sshDir, 'known_hosts'), `${KNOWN_HOSTS_LINE}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(sshDir, 'config'), `Host gmn-seal-receiver\n  HostName ${HOST_SENTINEL}\n`, { mode: 0o600 });
}

/** A lista do passo 1 (ordem dada) com as cópias privadas dos blobs, e a chave/configuração do passo 2, sem git. */
function deliverFixture(t: Fixture['t'], rels: readonly string[], ssh: readonly FakeRule[]): DeliverFixture {
  const sandbox = sandboxOf(t);
  const sealsDir = path.join(sandbox.runnerTemp, 'gmn-seals');
  fs.mkdirSync(path.join(sealsDir, 'blobs'), { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(sealsDir, 'files'), rels.map((rel) => `${rel} ${sha256(content(rel))}\n`).join(''), { mode: 0o600 });
  for (const rel of rels) fs.writeFileSync(path.join(sealsDir, 'blobs', sha256(content(rel))), content(rel), { mode: 0o600 });
  writeSshFiles(sandbox);
  setScenario(sandbox, { commands: { ssh }, readStdin: ['ssh'] });
  return { sandbox, rels };
}
const DELIVER_ENV = { GMN_AMB: 'homologacao', GMN_SHA: '0123456789abcdef0123456789abcdef01234567', GMN_TRUST_SHA256: TRUST_SHA };
const ok = (verdict: 'WRITTEN' | 'ALREADY_PRESENT', rel: string): FakeResponse => ({ stdout: `OK ${verdict} ${rel} ${sha256(content(rel))}\n` });
const forFile = (rel: string, ...responses: FakeResponse[]): FakeRule => ({ match: [`put ${rel} `], responses });
const deliver = (fixture: DeliverFixture, extra: Record<string, string> = {}): RunResult => runScript(fixture.sandbox, 'seals-deliver.sh', [], { ...DELIVER_ENV, ...extra });
const results = (sandbox: Sandbox): string[][] => (fs.existsSync(resultsFile(sandbox)) ? readLines(resultsFile(sandbox)).map((line) => line.split('\t')) : []);

test('P9.5 entrega: um `put <relpath> <sha256> <trust-sha256>` por arquivo, na ordem da lista, com o arquivo no stdin, só pela configuração privada (`ssh -F … -T gmn-seal-receiver`); WRITTEN e ALREADY_PRESENT registrados', (t) => {
  const rels = [seal(AUD_A, 1), seal(AUD_A, 2), '_closures/ab-cd.json'];
  const fixture = deliverFixture(t, rels, [forFile(rels[0] as string, ok('ALREADY_PRESENT', rels[0] as string)), forFile(rels[1] as string, ok('WRITTEN', rels[1] as string)), forFile(rels[2] as string, ok('WRITTEN', rels[2] as string))]);
  const result = deliver(fixture);
  assert.equal(result.status, 0, result.stderr);
  const sshCalls = calls(fixture.sandbox, 'ssh');
  assert.deepEqual(sshCalls.map((call) => call.argv), rels.map((rel) => ['-F', path.join(fixture.sandbox.runnerTemp, 'gmn-ssh', 'config'), '-T', 'gmn-seal-receiver', `put ${rel} ${sha256(content(rel))} ${TRUST_SHA}`]));
  assert.deepEqual(sshCalls.map((call) => call.stdinSha256), rels.map((rel) => sha256(content(rel))), 'cada arquivo no stdin do seu put');
  for (const call of sshCalls) assert.match(call.argv[4] ?? '', /^put (?:aud-[0-9a-f]{16}\/seal-\d{4}\.json|_closures\/[a-z0-9-]+\.json) [0-9a-f]{64} [0-9a-f]{64}$/);
  assert.deepEqual(results(fixture.sandbox), [[rels[0], sha256(content(rels[0] as string)), 'ALREADY_PRESENT', 'OK'], [rels[1], sha256(content(rels[1] as string)), 'WRITTEN', 'OK'], [rels[2], sha256(content(rels[2] as string)), 'WRITTEN', 'OK']]);
  assert.equal(outputs(fixture.sandbox).sent, '3');
  assert.match(result.stdout, new RegExp(`^OK ALREADY_PRESENT ${rels[0]} [0-9a-f]{64}$`, 'm'));
  assertNoLeak(result, HOST_SENTINEL, 'sentinela-chave', 'falso');
});

test('P9.5 entrega PARA NO PRIMEIRO ERRO (RC-10): o arquivo recusado fica FALHOU com o código, os seguintes nunca são enviados', (t) => {
  const rels = [seal(AUD_A, 1), seal(AUD_A, 2), seal(AUD_B, 1)];
  const fixture = deliverFixture(t, rels, [forFile(rels[0] as string, ok('WRITTEN', rels[0] as string)), forFile(rels[1] as string, { rc: 31, stderr: 'ERRO E_EXISTS_DIFFERENT\n' }), forFile(rels[2] as string, ok('WRITTEN', rels[2] as string))]);
  const result = deliver(fixture);
  assertRefused(fixture.sandbox, result, 'E_EXISTS_DIFFERENT');
  assert.equal(calls(fixture.sandbox, 'ssh').length, 2, 'nada depois do primeiro erro');
  assert.deepEqual(results(fixture.sandbox).map((row) => [row[0], row[2], row[3]]), [[rels[0], 'WRITTEN', 'OK'], [rels[1], 'FALHOU', 'E_EXISTS_DIFFERENT']]);
});

test('P9.5 bytes do commit (revisão do PR #74, item 6): a lista e o stdin de cada put vêm dos blobs IMUTÁVEIS do SHA; um arquivo do checkout trocado antes ou depois do passo 1 não muda o que é enviado; a cópia privada alterada ⇒ SEALS_FILE_CHANGED sem ssh', (t) => {
  const sandbox = sandboxOf(t);
  const rel = seal(AUD_A, 1);
  const file = put(sandbox, `homologacao/seals/${rel}`, content(rel));
  const sha = commitAll(sandbox);
  fs.writeFileSync(file, 'trocado ANTES do passo 1\n');
  assert.equal(runScript(sandbox, 'seals-files.sh', [], withHome(sandbox, { GMN_AMB: 'homologacao', GMN_SHA: sha })).status, 0);
  assert.deepEqual(readLines(listFile(sandbox)), [`${rel} ${sha256(content(rel))}`], 'o sha256 é o do blob do commit');
  fs.writeFileSync(file, 'trocado DEPOIS do passo 1\n');
  fs.writeFileSync(path.join(sandbox.root, 'link-audit-seals', 'homologacao', 'trust-keys.txt'), 'lista trocada no checkout\n');
  writeSshFiles(sandbox);
  setScenario(sandbox, { commands: { ssh: [forFile(rel, ok('WRITTEN', rel))] }, readStdin: ['ssh'] });
  const delivered = runScript(sandbox, 'seals-deliver.sh', [], { ...DELIVER_ENV, GMN_SHA: sha });
  assert.equal(delivered.status, 0, delivered.stderr);
  const [call] = calls(sandbox, 'ssh');
  assert.equal(call?.stdinSha256, sha256(content(rel)), 'o stdin é a cópia do blob, não o arquivo do checkout');
  assert.equal(call?.argv[4], `put ${rel} ${sha256(content(rel))} ${TRUST_SHA}`, 'a lista de confiança é a do blob do commit');

  fs.writeFileSync(path.join(sandbox.runnerTemp, 'gmn-seals', 'blobs', sha256(content(rel))), 'copia adulterada');
  setScenario(sandbox, { commands: { ssh: [forFile(rel, ok('WRITTEN', rel))] }, readStdin: ['ssh'] });
  assertRefused(sandbox, runScript(sandbox, 'seals-deliver.sh', [], { ...DELIVER_ENV, GMN_SHA: sha }), 'SEALS_FILE_CHANGED');
  assert.equal(calls(sandbox, 'ssh').length, 0);
});

const oneFile = seal(AUD_A, 3);
const refusedBy = (t: Fixture['t'], response: FakeResponse): { readonly fixture: DeliverFixture; readonly result: RunResult } => {
  const fixture = deliverFixture(t, [oneFile], [forFile(oneFile, response)]);
  return { fixture, result: deliver(fixture) };
};

test('P9.5 conjunto fechado do receptor de manifestos: CADA código com a sua saída numérica (src/lib/seal-receiver/codes.ts) vira a linha pública remontada, sem repetir o resto do stderr', (t) => {
  for (const [code, rc] of Object.entries(SEAL_RECEIVER_EXIT_CODES)) {
    const { fixture, result } = refusedBy(t, { rc, stderr: `aviso /srv/caminho-real-sentinela\nERRO ${code}\n` });
    assertRefused(fixture.sandbox, result, code);
    assert.equal(result.stderr, `ERRO ${code}\n`, code);
    assertNoLeak(result, 'caminho-real-sentinela');
    assert.deepEqual(results(fixture.sandbox).map((row) => [row[2], row[3]]), [['FALHOU', code]]);
  }
});

test('P9.5 conjunto fechado: CADA detalhe do E_V2_REFUSED (razões do verificador + HEAD_MISMATCH) e do E_CLOSURE_REFUSED (motivos do S-11) passa; o código sem detalhe também', (t) => {
  const cases: Array<[string, number, string]> = [
    ...V2_REFUSAL_DETAILS.map((detail): [string, number, string] => ['E_V2_REFUSED', 32, detail]),
    ...CLOSURE_REFUSAL_DETAILS.map((detail): [string, number, string] => ['E_CLOSURE_REFUSED', 33, detail]),
  ];
  for (const [code, rc, detail] of cases) {
    const { fixture, result } = refusedBy(t, { rc, stderr: `ERRO ${code} ${detail}\n` });
    assertRefused(fixture.sandbox, result, code, detail);
    assert.deepEqual(results(fixture.sandbox).map((row) => row[3]), [`${code} ${detail}`]);
  }
});

test('P9.5 conjunto fechado: código desconhecido, código só do receptor de deploy, detalhe fora da lista, detalhe em código sem detalhe, saída numérica trocada ou lixo ⇒ RECEIVER_UNKNOWN_ERROR EXIT_<n>, sem repetir nada; saída 29 sem NENHUM texto = E_INTERNAL', (t) => {
  const cases: Array<[number, string, string]> = [
    [70, 'ERRO E_SEGREDO_SENTINELA\n', 'E_SEGREDO_SENTINELA'],
    [52, 'ERRO E_HOST_CONFIG GMN_IMAGE_TAG\n', 'E_HOST_CONFIG'],
    [64, 'ERRO E_POSTDEPLOY_CHECK PD-01\n', 'E_POSTDEPLOY_CHECK'],
    [32, 'ERRO E_V2_REFUSED SEGREDO_SENTINELA\n', 'SEGREDO_SENTINELA'],
    [32, 'ERRO E_V2_REFUSED SIGNER_NOT_LISTED\n', 'SIGNER_NOT_LISTED'],
    [33, 'ERRO E_CLOSURE_REFUSED SEAL_KEY_REVOKED\n', 'SEAL_KEY_REVOKED'],
    [16, 'ERRO E_LOCKED detalhe-sentinela\n', 'detalhe-sentinela'],
    [13, 'ERRO E_LOCKED\n', 'E_LOCKED'],
    [31, 'ERRO E_V2_REFUSED SEAL_CHAIN_BROKEN\n', 'E_V2_REFUSED'],
    [1, 'Traceback /opt/caminho-sentinela\n', 'caminho-sentinela'],
    [29, 'saida-sentinela do node\n', 'saida-sentinela'],
    [36, 'erro E_WRITE_UNCONFIRMED\n', 'E_WRITE_UNCONFIRMED'],
  ];
  for (const [rc, stderr, sentinel] of cases) {
    const { fixture, result } = refusedBy(t, { rc, stderr });
    assertRefused(fixture.sandbox, result, 'RECEIVER_UNKNOWN_ERROR', `EXIT_${rc}`);
    assertNoLeak(result, sentinel);
    assert.deepEqual(results(fixture.sandbox).map((row) => row[3]), [`RECEIVER_UNKNOWN_ERROR EXIT_${rc}`]);
  }
  const closed = refusedBy(t, { rc: 29 });
  assertRefused(closed.fixture.sandbox, closed.result, 'E_INTERNAL');
});

test('P9.5 resposta OK fora da forma: outra linha a mais, caminho ou sha256 que não ecoam o pedido, outro veredito, campos a menos ou stdout vazio com saída 0 ⇒ RECEIVER_BAD_OUTPUT put', (t) => {
  const digest = sha256(content(oneFile));
  for (const stdout of [
    `OK WRITTEN ${oneFile} ${digest}\nmais uma linha\n`,
    `OK WRITTEN ${seal(AUD_A, 4)} ${digest}\n`,
    `OK WRITTEN ${oneFile} ${'a'.repeat(64)}\n`,
    `OK DEPLOYED ${oneFile} ${digest}\n`,
    `OK VERIFIED ${oneFile} ${digest}\n`,
    `OK WRITTEN ${oneFile}\n`,
    `OK WRITTEN  ${oneFile} ${digest}\n`,
    `ok written ${oneFile} ${digest}\n`,
    '',
  ]) {
    const { fixture, result } = refusedBy(t, { stdout });
    assertRefused(fixture.sandbox, result, 'RECEIVER_BAD_OUTPUT', 'put');
    assert.deepEqual(results(fixture.sandbox).map((row) => [row[2], row[3]]), [['FALHOU', 'RECEIVER_BAD_OUTPUT put']]);
  }
});

test('P9.5 entrega: ssh sem conexão (255) ⇒ SSH_CONNECT_FAILED HOST_KEY|AUTH|OTHER, sem repetir o stderr do ssh (host, endereço)', (t) => {
  const cases: Array<[string, string]> = [
    [`ssh: connect to host ${HOST_SENTINEL} port 22: Connection refused\n`, 'OTHER'],
    [`Host key for ${HOST_SENTINEL} has changed\nHost key verification failed.\n`, 'HOST_KEY'],
    [`gmn-hml-seals@${HOST_SENTINEL}: Permission denied (publickey).\n`, 'AUTH'],
  ];
  for (const [stderr, hint] of cases) {
    const { fixture, result } = refusedBy(t, { rc: 255, stderr });
    assertRefused(fixture.sandbox, result, 'SSH_CONNECT_FAILED', hint);
    assertNoLeak(result, HOST_SENTINEL, 'Connection refused');
  }
});

test('P9.5 entrega: arquivo mudado depois do passo 1, lista ilegível ou acima do teto de 1000 (conferido antes do primeiro put), chave/configuração ou lista ausentes, hash da lista de confiança inválido ⇒ recusa sem ssh', (t) => {
  const changed = deliverFixture(t, [oneFile], []);
  fs.writeFileSync(path.join(changed.sandbox.runnerTemp, 'gmn-seals', 'blobs', sha256(content(oneFile))), 'bytes trocados');
  assertRefused(changed.sandbox, deliver(changed), 'SEALS_FILE_CHANGED');
  assert.deepEqual(results(changed.sandbox).map((row) => [row[0], row[2], row[3]]), [[oneFile, 'FALHOU', 'SEALS_FILE_CHANGED']]);

  const cases: Array<[(fixture: DeliverFixture) => void, Record<string, string>, string, string | undefined]> = [
    [() => undefined, { GMN_TRUST_SHA256: 'xyz' }, 'INPUT_INVALID', 'GMN_TRUST_SHA256'],
    [() => undefined, { GMN_AMB: 'staging' }, 'INPUT_INVALID', 'GMN_AMB'],
    [(f) => fs.rmSync(path.join(f.sandbox.runnerTemp, 'gmn-ssh', 'id_seals')), {}, 'SSH_CONFIG_MISSING', 'id_seals'],
    [(f) => fs.rmSync(path.join(f.sandbox.runnerTemp, 'gmn-ssh', 'config')), {}, 'SSH_CONFIG_MISSING', 'config'],
    [(f) => fs.rmSync(listFile(f.sandbox)), {}, 'SEALS_LIST_MISSING', undefined],
    [(f) => fs.writeFileSync(listFile(f.sandbox), `../../etc/passwd ${'a'.repeat(64)}\n`), {}, 'SEALS_LIST_INVALID', undefined],
    [(f) => fs.writeFileSync(listFile(f.sandbox), `${oneFile} ${'a'.repeat(64)} extra\n`), {}, 'SEALS_LIST_INVALID', undefined],
    [(f) => fs.writeFileSync(listFile(f.sandbox), Array.from({ length: 1001 }, () => `${oneFile} ${sha256(content(oneFile))}\n`).join('')), {}, 'SEALS_TOO_MANY', undefined],
  ];
  for (const [arrange, extra, code, detail] of cases) {
    const fixture = deliverFixture(t, [oneFile], [forFile(oneFile, ok('WRITTEN', oneFile))]);
    arrange(fixture);
    const result = deliver(fixture, extra);
    assertRefused(fixture.sandbox, result, code, detail);
    assert.equal(calls(fixture.sandbox, 'ssh').length, 0, code);
  }
});

test('P9.5 paridade: a tabela de códigos e saídas e as listas de detalhes do seals-deliver.sh são EXATAMENTE as de src/lib/seal-receiver/codes.ts; a gramática do relpath em lib.sh é a do receptor (grammar.ts)', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy', 'ci', 'seals-deliver.sh'), 'utf8');
  const table = /declare -rA SEAL_RECEIVER_EXIT_CODES=\(\n([\s\S]*?)\n\)/.exec(script)?.[1] ?? '';
  const parsed = Object.fromEntries([...table.matchAll(/\[([A-Z0-9_]+)\]=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(parsed, { ...SEAL_RECEIVER_EXIT_CODES });
  const list = (name: string): string[] => (new RegExp(`readonly ${name}=" ([^"]*) "`).exec(script.replace(/\\\n/g, ''))?.[1] ?? '').split(' ').filter(Boolean);
  assert.deepEqual(list('V2_REFUSAL_DETAILS'), [...V2_REFUSAL_DETAILS]);
  assert.deepEqual(list('CLOSURE_REFUSAL_DETAILS'), [...CLOSURE_REFUSAL_DETAILS]);
  const lib = fs.readFileSync(path.join(ROOT, 'deploy', 'ci', 'lib.sh'), 'utf8');
  const sealRe = new RegExp(/readonly GMN_CI_SEAL_RELPATH='([^']+)'/.exec(lib)?.[1] ?? '^$');
  const closureRe = new RegExp(/readonly GMN_CI_CLOSURE_RELPATH='([^']+)'/.exec(lib)?.[1] ?? '^$');
  const samples = [
    seal(AUD_A, 1), seal(AUD_A, 9), seal(AUD_A, 10), seal(AUD_A, 99), seal(AUD_A, 100), seal(AUD_A, 199), seal(AUD_A, 200), seal(AUD_A, 249), seal(AUD_A, 250), seal(AUD_A, 256),
    `${AUD_A}/seal-0000.json`, `${AUD_A}/seal-0257.json`, `${AUD_A}/seal-0300.json`, `${AUD_A}/seal-1000.json`, 'aud-0123/seal-0001.json', `${AUD_A.toUpperCase()}/seal-0001.json`, `${AUD_A}/seal-0001.JSON`, `${AUD_A}/seal-0001.json/x`,
    '_closures/abcd.json', '_closures/a-b-c.json', `_closures/${'a'.repeat(32)}.json`, `_closures/${'a'.repeat(33)}.json`, '_closures/abc.json', '_closures/-abc.json', '_closures/ABCD.json', '_closures/ab_cd.json', '_closures/../x.json', `x/${seal(AUD_A, 1)}`,
  ];
  for (const sample of samples) assert.equal(sealRe.test(sample) || closureRe.test(sample), parseRelpath(sample) !== null, sample);
});

/* ------------------------------------------------------------------------------------------------ passo 5: resumo (RC-08) */

const SUMMARY_ENV: Record<string, string> = {
  GMN_AMB: 'homologacao', GMN_SHA: '0123456789abcdef0123456789abcdef01234567', GITHUB_RUN_ID: '987654', GITHUB_RUN_ATTEMPT: '2',
  GMN_O_HEAD: 'success', GMN_O_CHECKOUT: 'success', GMN_O_FILES: 'success', GMN_O_SSH: 'success', GMN_O_HEAD2: 'success', GMN_O_DELIVER: 'success', GMN_V_TRUST_SHA256: TRUST_SHA,
  // Variáveis que o resumo NUNCA lê: se aparecerem, vazou.
  GMN_SSH_HOST: HOST_SENTINEL, GMN_SEALS_SSH_KEY: KEY_SENTINEL,
};
const summaryRows = (sandbox: Sandbox): string[][] =>
  fs.readFileSync(sandbox.summaryFile, 'utf8').split('\n').filter((line) => line.startsWith('| `')).map((line) => line.slice(2, -2).split(' | '));

function summaryFixture(t: Fixture['t'], rels: readonly string[], rows: ReadonlyArray<readonly [string, string, string]>): Sandbox {
  const sandbox = sandboxOf(t);
  const dir = path.join(sandbox.runnerTemp, 'gmn-seals');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'files'), rels.map((rel) => `${rel} ${sha256(content(rel))}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'results'), rows.map(([rel, verdict, code]) => `${rel}\t${sha256(content(rel))}\t${verdict}\t${code}\n`).join(''));
  return sandbox;
}

test('P9.5 resumo (§5.9): uma linha por arquivo na ordem de envio, com execução, tentativa, commit, ambiente, caminho, sha256, resultado e código; ALREADY_PRESENT é "conteúdo idêntico já presente", NUNCA "verificado no host"', (t) => {
  const rels = [seal(AUD_A, 1), seal(AUD_A, 2), '_closures/ab-cd.json'];
  const sandbox = summaryFixture(t, rels, [[rels[0] as string, 'ALREADY_PRESENT', 'OK'], [rels[1] as string, 'WRITTEN', 'OK'], [rels[2] as string, 'WRITTEN', 'OK']]);
  const result = runScript(sandbox, 'seals-summary.sh', [], SUMMARY_ENV);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(sandbox.summaryFile, 'utf8');
  assert.match(text, /^### Entrega de manifestos \(homologacao\)$/m);
  assert.match(text, /^\| execução \| tentativa \| commit \| ambiente \| caminho relativo \| sha256 dos bytes \| resultado \| código \|$/m);
  assert.match(text, /^Resultado: `OK` \(2 gravado\(s\) e verificado\(s\) no host, 1 com conteúdo idêntico já presente\)\.$/m);
  assert.match(text, new RegExp(`^Lista de confiança do commit \\(sha256\\): \`${TRUST_SHA}\`\\.$`, 'm'));
  const rows = summaryRows(sandbox);
  assert.deepEqual(rows.map((row) => row.slice(0, 6).map((cell) => cell.replace(/`/g, ''))), rels.map((rel) => ['987654', '2', SUMMARY_ENV.GMN_SHA, 'homologacao', rel, sha256(content(rel))]));
  const present = rows[0] as string[];
  assert.equal(present[6], '`ALREADY_PRESENT`: conteúdo idêntico já presente');
  assert.ok(!present.join(' ').includes('verificado'), 'ALREADY_PRESENT nunca como verificado no host');
  assert.equal(rows[1]?.[6], '`WRITTEN`: gravado (verificado no host)');
  assert.deepEqual(rows.map((row) => row[7]), ['`OK`', '`OK`', '`OK`']);
  for (const sentinel of [HOST_SENTINEL, 'sentinela-chave', 'falso']) assert.ok(!text.includes(sentinel), sentinel);
});

test('P9.5 resumo: parada no primeiro erro (FALHOU com o código; os seguintes "não enviado"); falha antes da entrega (ex.: NOT_MAIN_HEAD) deixa todos "não enviado"; valores fora do padrão nunca entram (sem injeção de Markdown)', (t) => {
  const rels = [seal(AUD_A, 1), seal(AUD_A, 2), seal(AUD_B, 1)];
  const stopped = summaryFixture(t, rels, [[rels[0] as string, 'WRITTEN', 'OK'], [rels[1] as string, 'FALHOU', 'E_V2_REFUSED SEAL_CHAIN_BROKEN']]);
  runScript(stopped, 'seals-summary.sh', [], { ...SUMMARY_ENV, GMN_O_DELIVER: 'failure', GMN_E_DELIVER: 'E_V2_REFUSED' });
  let text = fs.readFileSync(stopped.summaryFile, 'utf8');
  assert.match(text, /^Resultado: `E_V2_REFUSED`\. A entrega para no primeiro erro \(RC-10\): 1 arquivo\(s\) não enviado\(s\)\.$/m);
  assert.deepEqual(summaryRows(stopped).map((row) => [row[6], row[7]]), [['`WRITTEN`: gravado (verificado no host)', '`OK`'], ['`FALHOU`', '`E_V2_REFUSED SEAL_CHAIN_BROKEN`'], ['não enviado', '`-`']]);

  const head = summaryFixture(t, rels, []);
  runScript(head, 'seals-summary.sh', [], { ...SUMMARY_ENV, GMN_O_HEAD2: 'failure', GMN_E_HEAD2: 'NOT_MAIN_HEAD', GMN_O_DELIVER: 'skipped' });
  text = fs.readFileSync(head.summaryFile, 'utf8');
  assert.match(text, /^Resultado: `NOT_MAIN_HEAD`\. A entrega para no primeiro erro \(RC-10\): 3 arquivo\(s\) não enviado\(s\)\.$/m);
  assert.deepEqual(summaryRows(head).map((row) => row[6]), ['não enviado', 'não enviado', 'não enviado']);

  const noList = sandboxOf(t);
  runScript(noList, 'seals-summary.sh', [], { ...SUMMARY_ENV, GMN_O_FILES: 'failure', GMN_E_FILES: 'SEALS_TOO_MANY', GMN_O_SSH: 'skipped' });
  text = fs.readFileSync(noList.summaryFile, 'utf8');
  assert.match(text, /^Resultado: `SEALS_TOO_MANY`\./m);
  assert.match(text, /^Nenhum arquivo listado nesta execução\.$/m);

  const injected = summaryFixture(t, [rels[0] as string], [[rels[0] as string, 'WRITTEN', 'OK | `injetado`']]);
  fs.appendFileSync(path.join(injected.runnerTemp, 'gmn-seals', 'files'), `../fora ${'a'.repeat(64)}\n| injetado | ${'a'.repeat(64)}\n`);
  fs.appendFileSync(path.join(injected.runnerTemp, 'gmn-seals', 'results'), `${rels[1]}\t${'b'.repeat(64)}\tINVENTADO\tOK\n`);
  runScript(injected, 'seals-summary.sh', [], { ...SUMMARY_ENV, GMN_AMB: 'x | y', GMN_SHA: 'main', GMN_V_TRUST_SHA256: '<script>', GMN_O_DELIVER: 'failure', GMN_E_DELIVER: 'lixo `x`' });
  text = fs.readFileSync(injected.summaryFile, 'utf8');
  assert.ok(!text.includes('injetado') && !text.includes('INVENTADO') && !text.includes('<script>') && !text.includes('fora'), 'nada fora do padrão no resumo');
  assert.match(text, /^### Entrega de manifestos \(-\)$/m);
  assert.match(text, /^Resultado: `FALHOU_DELIVER`\./m);
  assert.deepEqual(summaryRows(injected).map((row) => [row[2], row[3], row[7]]), [['`-`', '`-`', '`-`']]);
});

/* ------------------------------------------------------------------------------------------------ seals-verify: detect (push em toda a main) */

const detect = (sandbox: Sandbox, env: Record<string, string>): RunResult => runScript(sandbox, 'seals-detect.sh', [], withHome(sandbox, env));

test('P9.5 detect (revisão do PR #74, item 2): o push vale para toda a main; o diff local before..sha decide; sem mudança em link-audit-seals/*/seals/ ⇒ changed=false, ambientes=[] e "nada a entregar", sem npm', (t) => {
  const sandbox = sandboxOf(t);
  const before = commitAll(sandbox, 'base');
  put(sandbox, 'homologacao/trust-keys.txt', TRUST_LIST.replace('active', 'revoked'));
  for (let i = 0; i < 310; i += 1) fs.writeFileSync(path.join(sandbox.root, 'link-audit-seals', `outro-${i}.txt`), 'x');
  git(sandbox.root, 'add', '-A', '--', 'link-audit-seals');
  git(sandbox.root, 'commit', '-q', '-m', 'sem manifestos');
  const unrelated = git(sandbox.root, 'rev-parse', 'HEAD');
  const quiet = detect(sandbox, { GMN_SHA: unrelated, GMN_EVENT: 'push', GMN_BEFORE: before });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.deepEqual(outputs(sandbox), { changed: 'false', ambientes: '[]' });
  assert.match(fs.readFileSync(sandbox.summaryFile, 'utf8'), /Nada mudou sob `link-audit-seals\/\*\/seals\/` neste push: nada a entregar/);
  assert.equal(calls(sandbox, 'npm').length, 0);

  // um push com mais de 300 arquivos e UM manifesto no fim: o filtro `paths` do GitHub poderia não vê-lo; o diff local vê
  for (let i = 0; i < 310; i += 1) fs.writeFileSync(path.join(sandbox.root, 'link-audit-seals', `outro-${i}.txt`), 'y');
  put(sandbox, `producao/seals/${seal(AUD_B, 1)}`, content('p'));
  const big = commitAll(sandbox, 'grande');
  setScenario(sandbox, {});
  assert.equal(detect(sandbox, { GMN_SHA: big, GMN_EVENT: 'push', GMN_BEFORE: unrelated }).status, 0);
  assert.deepEqual(outputs(sandbox), { changed: 'true' });

  // apagar um manifesto também é mudança (o seals-check recusa depois, S-01)
  fs.rmSync(path.join(sandbox.root, 'link-audit-seals', 'producao', 'seals', AUD_B, 'seal-0001.json'));
  const removed = commitAll(sandbox, 'remove');
  setScenario(sandbox, {});
  assert.equal(detect(sandbox, { GMN_SHA: removed, GMN_EVENT: 'push', GMN_BEFORE: big }).status, 0);
  assert.equal(outputs(sandbox).changed, 'true');
});

test('P9.5 detect: base inutilizável (before todo zero, fora do histórico, fora da forma) ⇒ SEALS_NO_BASE; dispatch ⇒ changed=true só com ambiente válido; evento desconhecido ou checkout de outro commit ⇒ recusa', (t) => {
  const sandbox = sandboxOf(t);
  const sha = commitAll(sandbox, 'base');
  for (const bad of ['0'.repeat(40), 'a'.repeat(40), 'main', '']) {
    setScenario(sandbox, {});
    assertRefused(sandbox, detect(sandbox, { GMN_SHA: sha, GMN_EVENT: 'push', GMN_BEFORE: bad }), 'SEALS_NO_BASE');
  }
  setScenario(sandbox, {});
  assert.equal(detect(sandbox, { GMN_SHA: sha, GMN_EVENT: 'workflow_dispatch', GMN_DISPATCH_AMB: 'producao' }).status, 0);
  assert.deepEqual(outputs(sandbox), { changed: 'true' });
  const cases: Array<[Record<string, string>, string, string | undefined]> = [
    [{ GMN_EVENT: 'workflow_dispatch', GMN_DISPATCH_AMB: 'staging' }, 'INPUT_INVALID', 'GMN_DISPATCH_AMB'],
    [{ GMN_EVENT: 'schedule' }, 'INPUT_INVALID', 'GMN_EVENT'],
    [{ GMN_EVENT: 'push', GMN_BEFORE: sha, GMN_SHA: 'f'.repeat(40) }, 'CHECKOUT_MISMATCH', undefined],
  ];
  for (const [extra, code, detail] of cases) {
    setScenario(sandbox, {});
    const env: Record<string, string> = { GMN_SHA: sha, ...extra };
    assertRefused(sandbox, detect(sandbox, env), code, detail);
  }
});

/* ------------------------------------------------------------------------------------------------ seals-verify: matriz de ambientes */

/** Sandbox do seals-verify: git real, `npm` falso, o preparo do ci.yml copiado (o mesmo do job `seals`). */
function verifySandbox(t: Fixture['t'], npm: readonly FakeResponse[] = [{ stdout: '### seals\n' }]): Sandbox {
  const sandbox = makeSandbox(t, { commands: { npm: [{ responses: npm }] } }, { fakes: SEALS_FAKES });
  fs.mkdirSync(path.join(sandbox.root, '.github', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.github', 'scripts', 'seals-prepare.sh'), path.join(sandbox.root, '.github', 'scripts', 'seals-prepare.sh'));
  return sandbox;
}
const npmArgs = (sandbox: Sandbox): string[][] => calls(sandbox, 'npm').map((call) => call.argv);
const verify = (sandbox: Sandbox, env: Record<string, string>): RunResult => runScript(sandbox, 'seals-verify.sh', [], withHome(sandbox, env));

test('P9.5 seals-verify no dispatch: só o modo árvore do ambiente escolhido; matriz com o ambiente só se ele tem arquivos sob <amb>/seals/ (senão [] e "nada a entregar")', (t) => {
  const sandbox = verifySandbox(t);
  put(sandbox, `homologacao/seals/${seal(AUD_A, 1)}`, content('a'));
  const sha = commitAll(sandbox);
  const result = verify(sandbox, { GMN_SHA: sha, GMN_EVENT: 'workflow_dispatch', GMN_DISPATCH_AMB: 'homologacao', GMN_BEFORE: '' });
  assert.equal(result.status, 0, result.stderr);
  const modes = path.join(sandbox.runnerTemp, 'gmn-seals-verify', 'modes');
  assert.deepEqual(npmArgs(sandbox), [['run', '--silent', 'link-audit:seals-check', '--', '--tree', 'homologacao', '--modes', modes, '--repo', sandbox.root]]);
  assert.equal(outputs(sandbox).ambientes, '["homologacao"]');
  assert.ok(fs.readFileSync(modes).includes(Buffer.from(`link-audit-seals/homologacao/seals/${seal(AUD_A, 1)}`)), 'os modos reais do git');
  assert.match(fs.readFileSync(sandbox.summaryFile, 'utf8'), /`\["homologacao"\]` \(um job `seals-deliver` por ambiente/);

  setScenario(sandbox, { commands: { npm: [{ responses: [{ stdout: '### seals\n' }] }] } });
  fs.rmSync(sandbox.summaryFile, { force: true });
  assert.equal(verify(sandbox, { GMN_SHA: sha, GMN_EVENT: 'workflow_dispatch', GMN_DISPATCH_AMB: 'producao' }).status, 0);
  assert.equal(outputs(sandbox).ambientes, '[]', 'produção sem arquivos: nada a entregar');
  assert.match(fs.readFileSync(sandbox.summaryFile, 'utf8'), /Nenhum: nada a entregar nesta execução\./);

  for (const [extra, code, detail] of [[{ GMN_DISPATCH_AMB: 'staging' }, 'INPUT_INVALID', 'GMN_DISPATCH_AMB'], [{ GMN_EVENT: 'schedule' }, 'INPUT_INVALID', 'GMN_EVENT'], [{ GMN_SHA: 'f'.repeat(40) }, 'CHECKOUT_MISMATCH', undefined]] as const) {
    setScenario(sandbox, {});
    const dispatch: Record<string, string> = { GMN_SHA: sha, GMN_EVENT: 'workflow_dispatch', GMN_DISPATCH_AMB: 'homologacao' };
    assertRefused(sandbox, verify(sandbox, { ...dispatch, ...extra }), code, detail);
    assert.equal(npmArgs(sandbox).length, 0);
  }
});

test('P9.5 seals-verify no push: o modo de mudanças sobre o push (base = before, preparo do ci.yml) e o modo árvore de cada ambiente com arquivo NOVO; a matriz é a dos ambientes tocados', (t) => {
  const sandbox = verifySandbox(t);
  put(sandbox, `producao/seals/${seal(AUD_B, 1)}`, content('p'));
  const before = commitAll(sandbox, 'base');
  put(sandbox, `homologacao/seals/${seal(AUD_A, 1)}`, content('h'));
  const sha = commitAll(sandbox, 'push');
  const result = verify(sandbox, { GMN_SHA: sha, GMN_EVENT: 'push', GMN_BEFORE: before });
  assert.equal(result.status, 0, result.stderr);
  const work = path.join(sandbox.runnerTemp, 'gmn-seals-verify');
  assert.deepEqual(npmArgs(sandbox), [
    ['run', '--silent', 'link-audit:seals-check', '--', '--changes', path.join(work, 'push', 'changes'), '--modes', path.join(work, 'push', 'modes'), '--base-trust', path.join(work, 'push', 'base-trust'), '--repo', sandbox.root],
    ['run', '--silent', 'link-audit:seals-check', '--', '--tree', 'homologacao', '--modes', path.join(work, 'modes'), '--repo', sandbox.root],
  ]);
  assert.equal(outputs(sandbox).ambientes, '["homologacao"]', 'produção não foi tocada pelo push: sem aprovação de produção à toa');

  put(sandbox, `homologacao/seals/${seal(AUD_A, 2)}`, content('h2'));
  put(sandbox, `producao/seals/${seal(AUD_B, 2)}`, content('p2'));
  const both = commitAll(sandbox, 'dois');
  setScenario(sandbox, { commands: { npm: [{ responses: [{ stdout: '### seals\n' }] }] } });
  assert.equal(verify(sandbox, { GMN_SHA: both, GMN_EVENT: 'push', GMN_BEFORE: sha }).status, 0);
  assert.equal(outputs(sandbox).ambientes, '["homologacao","producao"]');
  assert.deepEqual(npmArgs(sandbox).map((argv) => argv[4]), ['--changes', '--tree', '--tree']);
});

test('P9.5 seals-verify: before todo zero ou fora do histórico ⇒ SEALS_NO_BASE; recusa do seals-check (qualquer modo) ⇒ SEALS_REFUSED e nenhuma matriz', (t) => {
  const sandbox = verifySandbox(t);
  const before = commitAll(sandbox, 'base');
  put(sandbox, `homologacao/seals/${seal(AUD_A, 1)}`, content('h'));
  const sha = commitAll(sandbox, 'push');
  for (const bad of ['0'.repeat(40), 'a'.repeat(40), 'main', '']) {
    setScenario(sandbox, {});
    assertRefused(sandbox, verify(sandbox, { GMN_SHA: sha, GMN_EVENT: 'push', GMN_BEFORE: bad }), 'SEALS_NO_BASE');
    assert.equal(npmArgs(sandbox).length, 0);
  }
  setScenario(sandbox, { commands: { npm: [{ responses: [{ rc: 1, stderr: 'ERRO SEAL_V2_SEAL_KEY_REVOKED\n' }] }] } });
  const refused = verify(sandbox, { GMN_SHA: sha, GMN_EVENT: 'push', GMN_BEFORE: before });
  assertRefused(sandbox, refused, 'SEALS_REFUSED');
  assert.equal(outputs(sandbox).ambientes, undefined, 'nenhuma matriz: o seals-deliver não roda');
  assert.equal(npmArgs(sandbox).length, 1, 'para na primeira recusa');

  setScenario(sandbox, { commands: { npm: [{ match: ['--tree'], responses: [{ rc: 1, stderr: 'ERRO SEAL_FORMAT\n' }] }, { responses: [{ stdout: 'ok\n' }] }] } });
  assertRefused(sandbox, verify(sandbox, { GMN_SHA: sha, GMN_EVENT: 'workflow_dispatch', GMN_DISPATCH_AMB: 'homologacao' }), 'SEALS_REFUSED');
  assert.equal(outputs(sandbox).ambientes, undefined);
});

test('P9.5 resumo recusado antes do checkout (passo escrito no workflow): o código da primeira conferência (NOT_MAIN_HEAD), execução, commit e ambiente validado; nada foi enviado', (t) => {
  const workflow = parseYamlSubset(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8'));
  assert.ok(isYamlMap(workflow) && isYamlMap(workflow.jobs) && isYamlMap(workflow.jobs['seals-deliver']) && Array.isArray(workflow.jobs['seals-deliver'].steps));
  const fallback = workflow.jobs['seals-deliver'].steps.find((item) => isYamlMap(item) && item.name === 'Resumo da entrega (recusado antes do checkout)');
  assert.ok(isYamlMap(fallback) && typeof fallback.run === 'string');
  const sandbox = sandboxOf(t);
  const file = path.join(sandbox.root, 'fallback.sh');
  fs.writeFileSync(file, fallback.run);
  const run = (amb: string, code: string): string => {
    fs.rmSync(sandbox.summaryFile, { force: true });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], { env: { GITHUB_STEP_SUMMARY: sandbox.summaryFile, GITHUB_RUN_ID: '42', GMN_SHA: DELIVER_ENV.GMN_SHA, GMN_AMB: amb, GMN_E_HEAD: code, PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(sandbox.summaryFile, 'utf8');
  };
  assert.match(run('homologacao', 'NOT_MAIN_HEAD'), new RegExp(`### Entrega de manifestos \\(homologacao\\)\\n\\nRecusado antes do checkout: \`NOT_MAIN_HEAD\` \\(execução \`42\`, commit \`${DELIVER_ENV.GMN_SHA}\`\\)\\. Nada foi enviado\\.`));
  assert.match(run('x | y', 'lixo `x`'), /### Entrega de manifestos \(-\)[\s\S]*`FALHOU_ANTES_DO_CHECKOUT`/);
});
