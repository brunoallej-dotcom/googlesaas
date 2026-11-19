import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type BytesFsOps } from '../src/lib/link-audit/snapshot-store';
import { defaultTempRoots, nodeKeyFileOps, type KeyFileOps } from '../src/lib/link-audit-attestation/sign-key';
import { openHiddenInput, terminalConfirm } from '../src/lib/link-audit-attestation/sign-terminal';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { cliWorld, contentsOf, FakeTerminal, runSign, sealFile, treeOf, type CliWorld, type SignCliRun, type Typed } from './helpers/link-audit-seal-sign-cli-fixtures';

/*
 * P1 W4.4 — a CHAVE K1 do `sign` (spec §8, §5.5 passo 12, §5.5.1 itens 1, 2 e 8; IA-04, IA-22; RS-11, RS-12, RS-13) e o TERMINAL sem eco. PKCS#8 cifrado
 * com frase digitada só no terminal; custódia do arquivo (.git, projeto, pastas temporárias, permissões, link simbólico, texto claro); sentinelas:
 * a privada e a frase nunca aparecem em saída, argv, ambiente, os.tmpdir(), diretório de trabalho nem arquivo gravado. Chaves GERADAS em memória a
 * cada teste e gravadas cifradas em pastas temporárias (dados fictícios). O terminal real (pseudo-terminal) está em `link-audit-seal-sign-pty.test.ts`.
 */
registerCleanup();

const PASS_PROMPT = /Frase-senha/;

function refusedCli(run: SignCliRun, code: string, label = code): void {
  assert.equal(run.code, 3, `${label}: código 3 (veio ${run.code}): ${run.stderr}`);
  const at = run.err.findIndex((line) => line.startsWith('RECUSADO: '));
  assert.ok(at >= 0, `${label}: prefixo RECUSADO: (${run.stderr})`);
  assert.equal(run.err[at + 1], `Código: ${code}`, `${label}: ${code} (${run.stderr})`);
}
const sealsIn = (world: CliWorld): string[] => treeOf(world.sealsDir).filter((rel) => rel.endsWith('.json'));
function noSecretShown(world: CliWorld, run: SignCliRun, label: string): void {
  for (const sentinel of world.key.sentinels) assert.ok(!run.stdout.includes(sentinel) && !run.stderr.includes(sentinel), `${label}: material da chave ou frase na saída`);
  assert.ok(!run.stderr.includes(world.key.keyPath) && !run.stderr.includes(world.key.dir), `${label}: caminho da chave na saída`);
}
/** Recusa no passo 12: a confirmação foi lida, nada foi gravado e o eco foi restaurado. */
function keyRefused(world: CliWorld, run: SignCliRun, code: string, label: string, options: { readonly askedPassphrase: boolean; readonly reads?: number }): void {
  refusedCli(run, code, label);
  assert.equal(PASS_PROMPT.test(run.stderr), options.askedPassphrase, `${label}: frase ${options.askedPassphrase ? '' : 'NÃO '}pedida`);
  assert.equal(run.terminal.reads, options.reads ?? (options.askedPassphrase ? 2 : 1), `${label}: leituras do terminal`);
  assert.deepEqual(run.terminal.echoed, [], `${label}: nada ecoado`);
  assert.equal(run.terminal.isRaw, false, `${label}: eco restaurado`);
  assert.deepEqual(sealsIn(world), [], `${label}: nada gravado`);
  noSecretShown(world, run, label);
}

/* =============================================================================================================== §8 K1 */

test('§8 K1: PKCS#8 cifrado + frase só pelo terminal sem eco ⇒ assina; imprime <keyId>:<pública base64url> da chave aberta (a mesma da lista)', async () => {
  const world = cliWorld();
  const run = await runSign(world.argv(), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  const line = run.out.find((text) => text.includes(`${world.key.keyId}:`));
  assert.ok(line && line.includes(`${world.key.keyId}:${world.key.publicRaw}`) && /pública/.test(line), `linha da pública: ${line}`);
  assert.equal(world.key.publicRaw.length, 43, 'pública Ed25519 em base64url (32 bytes)');
  assert.deepEqual(run.terminal.deliveries.map((d) => d.raw), [true, true]);
  noSecretShown(world, run, 'sucesso');
});

test('§5.5 passo 12: frase errada ⇒ SIGN_KEY_REJECTED (frase pedida uma vez, sem nova tentativa); frase vazia digitada também; nada gravado, eco restaurado', async () => {
  for (const [label, typedPass] of [['frase errada', 'frase errada (fictícia)\r'], ['frase vazia', '\r'], ['frase com Ctrl-C', 'abc\x03'], ['fim de entrada na frase', null]] as const) {
    const world = cliWorld();
    const typed: Typed[] = [`${world.confirmation}\r`, ...(typedPass === null ? [{ kind: 'end' as const }] : [typedPass])];
    const run = await runSign(world.argv(), { typed });
    keyRefused(world, run, 'SIGN_KEY_REJECTED', label, { askedPassphrase: true, ...(typedPass === null ? { reads: 1 } : {}) });
  }
});

test('§5.5 passo 12: chave de outro tipo (EC P-256 cifrada) ⇒ SIGN_KEY_REJECTED depois da frase; só pública, lixo, inexistente, diretório ou grande demais ⇒ SIGN_KEY_REJECTED sem pedir a frase', async () => {
  const ec = cliWorld({}, { content: 'ec-encrypted' });
  keyRefused(ec, await runSign(ec.argv(), { typed: ec.typed() }), 'SIGN_KEY_REJECTED', 'EC P-256', { askedPassphrase: true });
  for (const content of ['public-only', 'garbage'] as const) {
    const world = cliWorld({}, { content });
    keyRefused(world, await runSign(world.argv(), { typed: world.typed() }), 'SIGN_KEY_REJECTED', content, { askedPassphrase: false });
  }
  const missing = cliWorld();
  keyRefused(missing, await runSign(missing.argv({ 'key-source': `file:${path.join(missing.key.dir, 'nao-existe.pem')}` }), { typed: missing.typed() }), 'SIGN_KEY_REJECTED', 'inexistente', { askedPassphrase: false });
  const directory = cliWorld();
  const sub = path.join(directory.key.dir, 'sub');
  fs.mkdirSync(sub, { mode: 0o700 });
  keyRefused(directory, await runSign(directory.argv({ 'key-source': `file:${sub}` }), { typed: directory.typed() }), 'SIGN_KEY_REJECTED', 'diretório', { askedPassphrase: false });
  const big = cliWorld();
  fs.writeFileSync(big.key.keyPath, Buffer.concat([fs.readFileSync(big.key.keyPath), Buffer.alloc(64 * 1024, 0x41)]));
  keyRefused(big, await runSign(big.argv(), { typed: big.typed() }), 'SIGN_KEY_REJECTED', 'grande demais', { askedPassphrase: false });
});

test('IA-04 (§8): chave cifrada com frase VAZIA ou com cifra legada (não PBES2) ⇒ SIGN_KEY_UNPROTECTED, sem pedir a frase', async () => {
  for (const content of ['empty-passphrase', 'legacy-cipher'] as const) {
    const world = cliWorld({}, { content });
    keyRefused(world, await runSign(world.argv(), { typed: world.typed() }), 'SIGN_KEY_UNPROTECTED', content, { askedPassphrase: false });
  }
});

test('IA-22: chave em TEXTO CLARO (PKCS#8 PEM, DER ou JWK) ⇒ SECRET_NOT_ENCRYPTED, sem pedir a frase e sem usá-la', async () => {
  for (const content of ['plain-pem', 'plain-der', 'plain-jwk'] as const) {
    const world = cliWorld({}, { content });
    const run = await runSign(world.argv(), { typed: world.typed() });
    keyRefused(world, run, 'SECRET_NOT_ENCRYPTED', content, { askedPassphrase: false });
    assert.ok(!run.stdout.includes(world.key.publicRaw), `${content}: a chave em claro nem chega a ser usada (nenhuma pública impressa)`);
  }
});

/* =============================================================================================================== IA-22: custódia */

test('IA-22: custódia do arquivo de chave ⇒ SECRET_PATH_UNSAFE sem pedir a frase: árvore com .git (pasta ou arquivo), dentro do projeto, numa pasta temporária, arquivo ≠ 0600, pasta ≠ 0700, link simbólico (no arquivo ou numa pasta do caminho)', async () => {
  const cases: Array<[string, () => { readonly world: CliWorld; readonly over?: Record<string, string>; readonly tempRoots?: string[]; readonly projectRoot?: string; readonly message: RegExp }]> = [
    ['.git (pasta) num ancestral', () => {
      const repo = tmpDir('lasc-repo-');
      fs.mkdirSync(path.join(repo, '.git'));
      return { world: cliWorld({}, { dir: path.join(repo, 'cofre', 'chaves') }), message: /\.git/ };
    }],
    ['.git (arquivo, worktree) num ancestral', () => {
      const repo = tmpDir('lasc-repo-');
      fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /lugar/nenhum (fictício)\n');
      return { world: cliWorld({}, { dir: path.join(repo, 'chaves') }), message: /\.git/ };
    }],
    ['dentro do projeto', () => {
      const project = tmpDir('lasc-proj-');
      return { world: cliWorld({}, { dir: path.join(project, 'segredos') }), projectRoot: project, message: /projeto/ };
    }],
    ['pasta temporária', () => {
      const temp = tmpDir('lasc-temp-');
      return { world: cliWorld({}, { dir: path.join(temp, 'k') }), tempRoots: [temp], message: /temporária/ };
    }],
    ...[0o644, 0o640, 0o400, 0o700, 0o604].map((mode): [string, () => { world: CliWorld; message: RegExp }] => [`arquivo ${mode.toString(8)}`, () => ({ world: cliWorld({}, { fileMode: mode }), message: /0600/ })]),
    ...[0o755, 0o750, 0o711, 0o1700].map((mode): [string, () => { world: CliWorld; message: RegExp }] => [`pasta ${mode.toString(8)}`, () => ({ world: cliWorld({}, { dirMode: mode }), message: /0700/ })]),
    ['link simbólico para uma chave válida', () => {
      const world = cliWorld();
      const link = path.join(tmpDir('lasc-link-'), 'atalho.pem');
      fs.symlinkSync(world.key.keyPath, link);
      return { world, over: { 'key-source': `file:${link}` }, message: /link simbólico/ };
    }],
    ['pasta do caminho é link para uma pasta temporária', () => {
      const temp = tmpDir('lasc-temp-');
      const world = cliWorld({}, { dir: path.join(temp, 'real') });
      const via = path.join(tmpDir('lasc-via-'), 'atalho');
      fs.symlinkSync(path.join(temp, 'real'), via);
      return { world, over: { 'key-source': `file:${path.join(via, 'custodia.pem')}` }, tempRoots: [temp], message: /temporária/ };
    }],
  ];
  for (const [label, make] of cases) {
    const { world, over, tempRoots, projectRoot, message } = make();
    const run = await runSign(world.argv(over ?? {}), { typed: world.typed(), ...(tempRoots ? { tempRoots } : {}), ...(projectRoot ? { projectRoot } : {}) });
    keyRefused(world, run, 'SECRET_PATH_UNSAFE', label, { askedPassphrase: false });
    assert.match(run.stderr, message, label);
  }
});

test('IA-22: a custódia PADRÃO recusa os.tmpdir() (TMPDIR/TMP/TEMP) e /tmp, /var/tmp, /dev/shm; o script não deixa um teste desligá-la por engano', async () => {
  for (const env of [{ TMPDIR: '/srv/tmp-teste' }, { TMP: '/srv/tmp-teste' }, { TEMP: '/srv/tmp-teste/' }]) {
    const roots = defaultTempRoots(env);
    assert.ok(roots.includes('/srv/tmp-teste'), JSON.stringify(env));
    for (const fixed of ['/tmp', '/var/tmp', '/dev/shm']) assert.ok(roots.includes(fixed), fixed);
  }
  assert.ok(defaultTempRoots({ TMPDIR: os.tmpdir() }).includes(path.resolve(os.tmpdir())), 'os.tmpdir() do processo');
  const world = cliWorld();
  assert.ok(world.key.keyPath.startsWith(fs.realpathSync(os.tmpdir())) || world.key.keyPath.startsWith(os.tmpdir()), 'a chave de teste está em os.tmpdir()');
  const run = await runSign(world.argv(), { typed: world.typed(), defaultTempRoots: true, env: { TMPDIR: os.tmpdir() } });
  keyRefused(world, run, 'SECRET_PATH_UNSAFE', 'os.tmpdir() padrão', { askedPassphrase: false });
  assert.match(run.stderr, /temporária/);
});

test('IA-22: depois de assinar (e de recusar), nenhum arquivo novo na árvore temporária além do manifesto: nada da chave, da frase ou temporário perdido', async () => {
  const world = cliWorld();
  const roots = [world.sealsDir, path.dirname(world.station.packagePath), world.key.dir];
  const before = roots.map(treeOf);
  const run = await runSign(world.argv(), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(roots.map(treeOf), [[...before[0] ?? [], 'auditoria-disco-sign-01', path.join('auditoria-disco-sign-01', 'seal-0001.json')].sort(), before[1], before[2]]);
  const refused = cliWorld();
  const refusedBefore = [refused.sealsDir, refused.key.dir].map(treeOf);
  await runSign(refused.argv(), { typed: [`${refused.confirmation}\r`, 'frase errada\r'] });
  assert.deepEqual([refused.sealsDir, refused.key.dir].map(treeOf), refusedBefore, 'recusa no passo 12: nada novo');
});

/* =============================================================================================================== IA-04: sentinelas */

type Fault = 'nenhuma' | 'frase errada' | 'confirmação errada' | 'leitura da chave lança com o material' | 'gravação lança com o material' | 'terminal lança com a frase' | 'relógio inválido';

function faultyDeps(world: CliWorld, fault: Fault): { readonly typed: Typed[]; readonly fs?: BytesFsOps; readonly keyFs?: KeyFileOps; readonly now?: Date } {
  const material = world.key.sentinels.join(' ');
  const boom = (): never => {
    throw Object.assign(new Error(`falha forçada ${material}`), { code: 'EIO', material, stack: material });
  };
  switch (fault) {
    case 'nenhuma':
      return { typed: world.typed() };
    case 'frase errada':
      return { typed: [`${world.confirmation}\r`, 'frase errada (fictícia)\r'] };
    case 'confirmação errada':
      return { typed: ['000000000000\r', `${world.key.passphrase}\r`] };
    case 'leitura da chave lança com o material':
      return { typed: world.typed(), keyFs: { ...nodeKeyFileOps, readKeyFile: async () => boom() } };
    case 'gravação lança com o material':
      return { typed: world.typed(), fs: { ...nodeFsOps, writeExclusive: async () => boom() } };
    case 'terminal lança com a frase':
      return { typed: [`${world.confirmation}\r`, { kind: 'error', message: `falha ${material}` }] };
    case 'relógio inválido':
      return { typed: world.typed(), now: new Date(Number.NaN) };
  }
}

test('IA-04: a privada e a frase (sentinelas) nunca aparecem em stdout, stderr, --json, argv, ambiente, os.tmpdir(), diretório de trabalho nem em arquivo gravado — no sucesso e nas falhas forçadas (frase errada, exceções com o material na mensagem)', async () => {
  const faults: Fault[] = ['nenhuma', 'frase errada', 'confirmação errada', 'leitura da chave lança com o material', 'gravação lança com o material', 'terminal lança com a frase', 'relógio inválido'];
  const originalTmp = process.env.TMPDIR;
  const originalCwd = process.cwd();
  for (const fault of faults) {
    for (const json of [false, true]) {
      const world = cliWorld();
      const tmp = tmpDir('lasc-ostmp-');
      const cwd = tmpDir('lasc-cwd-');
      const argv = world.argv({}, json ? ['--json'] : []);
      const label = `${fault}${json ? ' --json' : ''}`;
      process.env.TMPDIR = tmp;
      process.chdir(cwd);
      let run: SignCliRun;
      try {
        assert.equal(os.tmpdir(), tmp);
        const deps = faultyDeps(world, fault);
        run = await runSign(argv, { ...deps, ...(deps.now ? { now: deps.now } : {}) });
      } finally {
        process.chdir(originalCwd);
        if (originalTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmp;
      }
      assert.equal(run.code, fault === 'nenhuma' ? 0 : [3, 4].includes(run.code) ? run.code : -1, `${label}: código fixo (veio ${run.code}): ${run.stderr}`);
      if (fault === 'nenhuma' && json) assert.equal(JSON.parse(run.out[0] ?? '{}').ok, true);
      noSecretShown(world, run, label);
      const scanned = [argv.join(' '), process.argv.join(' '), JSON.stringify(process.env), contentsOf(world.sealsDir), contentsOf(tmp), contentsOf(cwd)].join('\n');
      for (const sentinel of world.key.sentinels) assert.ok(!scanned.includes(sentinel), `${label}: sentinela em argv, ambiente, os.tmpdir(), cwd ou manifesto`);
      assert.deepEqual([treeOf(tmp), treeOf(cwd)], [[], []], `${label}: nada gravado em os.tmpdir() nem no diretório de trabalho`);
      assert.equal(run.terminal.isRaw, false, `${label}: eco restaurado`);
      if (fault === 'nenhuma') assert.ok(fs.existsSync(sealFile(world.sealsDir)));
      else assert.deepEqual(treeOf(world.sealsDir).filter((rel) => rel.endsWith('.json')), [], `${label}: nada gravado`);
    }
  }
});

test('IA-04 (RS-13): o sign desliga os relatórios de diagnóstico do Node (process.report) antes de tudo, inclusive numa recusa de uso', async () => {
  const world = cliWorld();
  for (const argv of [world.argv(), ['--foo']]) {
    const run = await runSign(argv, { typed: world.typed() });
    assert.deepEqual(run.report, { reportOnFatalError: false, reportOnSignal: false, reportOnUncaughtException: false }, argv.join(' '));
  }
});

/* =============================================================================================================== terminal sem eco (unidade) */

async function readWith(typed: Typed[], max: number, initialRaw = false): Promise<{ readonly text: string | null; readonly terminal: FakeTerminal; readonly error: string | null }> {
  const terminal = new FakeTerminal(typed);
  terminal.isRaw = initialRaw;
  const input = openHiddenInput(terminal);
  try {
    const bytes = await input.readLine(max);
    return { text: bytes.toString('utf8'), terminal, error: null };
  } catch (error) {
    return { text: null, terminal, error: (error as { readonly reason?: string }).reason ?? 'sem razão' };
  } finally {
    input.close();
  }
}

test('§5.5.1 item 8: o leitor sem eco liga o modo bruto ANTES de ler, edita (Backspace, inclusive UTF-8, e Ctrl-U), aceita CR, LF e CRLF, junta pedaços e restaura o modo anterior (inclusive se já era bruto)', async () => {
  const cases: Array<[Typed[], string]> = [
    [['abc\r'], 'abc'],
    [['abc\n'], 'abc'],
    [['ab', 'c\r\n'], 'abc'],
    [['abx\x7fc\r'], 'abc'],
    [['abx\x08c\r'], 'abc'],
    [['açã\x7f\x7fbc\r'], 'abc'],
    [['lixo\x15abc\r'], 'abc'],
    [['\x7f\x7fabc\r'], 'abc'],
    [['frase com espaço e ç\r'], 'frase com espaço e ç'],
  ];
  for (const [typed, expected] of cases) {
    const result = await readWith(typed, 64);
    assert.equal(result.text, expected, JSON.stringify(typed));
    assert.ok(result.terminal.deliveries.every((d) => d.raw), 'tudo lido com o modo bruto ligado');
    assert.deepEqual(result.terminal.rawCalls, [true, false]);
    assert.equal(result.terminal.isRaw, false);
  }
  const alreadyRaw = await readWith(['abc\r'], 64, true);
  assert.deepEqual([alreadyRaw.text, alreadyRaw.terminal.isRaw, alreadyRaw.terminal.rawCalls], ['abc', true, [true, true]], 'volta ao modo de ANTES');
});

test('§5.5.1 item 8: o leitor recusa sem TTY, sem setRawMode, com modo bruto que não liga, Ctrl-C, Ctrl-D, EOF, erro, tecla de controle e texto acima do limite, sempre restaurando o modo', async () => {
  const cases: Array<[string, () => FakeTerminal, number]> = [
    ['NO_TTY', () => new FakeTerminal(['abc\r'], () => '', { isTTY: false }), 64],
    ['NO_TTY', () => new FakeTerminal(['abc\r'], () => '', { rawMode: 'missing' }), 64],
    ['NO_TTY', () => new FakeTerminal(['abc\r'], () => '', { rawMode: 'ignored' }), 64],
    ['INTERRUPTED', () => new FakeTerminal(['ab\x03']), 64],
    ['INTERRUPTED', () => new FakeTerminal(['\x04']), 64],
    ['ENDED', () => new FakeTerminal([{ kind: 'end' }]), 64],
    ['TERMINAL_ERROR', () => new FakeTerminal([{ kind: 'error', message: 'falha' }]), 64],
    ['CONTROL_KEY', () => new FakeTerminal(['\x1b[A\r']), 64],
    ['TOO_LONG', () => new FakeTerminal(['abcd\r']), 3],
  ];
  for (const [reason, make, max] of cases) {
    const terminal = make();
    const input = openHiddenInput(terminal);
    await assert.rejects(input.readLine(max), (error: { readonly reason?: string }) => error.reason === reason, reason);
    input.close();
    assert.equal(terminal.isRaw, false, `${reason}: modo restaurado`);
    assert.deepEqual(terminal.echoed, [], `${reason}: nada lido com eco`);
  }
});

test('§5.5.1 item 8: o que foi digitado ADIANTADO depois do Enter fica para a próxima leitura da mesma sessão (sem eco no intervalo) e é descartado no close', async () => {
  const terminal = new FakeTerminal(['primeira\rsegunda\r']);
  const input = openHiddenInput(terminal);
  try {
    assert.equal((await input.readLine(64)).toString('utf8'), 'primeira');
    assert.equal(terminal.isRaw, true, 'o eco continua desligado entre as leituras da sessão');
    assert.equal((await input.readLine(64)).toString('utf8'), 'segunda');
  } finally {
    input.close();
  }
  assert.deepEqual([terminal.isRaw, terminal.rawCalls], [false, [true, false]]);
  input.close();
  assert.deepEqual(terminal.rawCalls, [true, false], 'close é idempotente');
});

test('IA-23: a tela da confirmação recebe só auditId, seq e entradas e devolve o texto digitado sem o fim de linha', async () => {
  const terminal = new FakeTerminal(['abcdef012345\r']);
  const input = openHiddenInput(terminal);
  const shown: string[] = [];
  try {
    const typed = await terminalConfirm(input, (line) => shown.push(line))({ auditId: 'auditoria-teste-0001', seq: 3, entries: 7 });
    assert.equal(typed, 'abcdef012345');
  } finally {
    input.close();
  }
  const screen = shown.join('\n');
  assert.ok(screen.includes('auditoria-teste-0001') && /seq 3\b/.test(screen) && /7 entradas/.test(screen) && /12 primeiros caracteres/.test(screen) && /dossiê/i.test(screen), screen);
});
