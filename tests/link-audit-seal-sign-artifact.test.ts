import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARTIFACT_FILE_NAME, ARTIFACT_NODE_MODULES, ArtifactBuildError, buildSignArtifact, checkArtifactText, hashLine, VERSIONED_HASH_FILE, versionedSha256, type BuiltArtifact } from '../scripts/build-sign-artifact';
import { runSignArtifact } from '../scripts/link-audit-sign-artifact';
import { createSealedEvidenceProvenance, parseTrustKeyring, type TrustKeyring } from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { AUD, cliWorld, CUSTODIAN, FakeTerminal, makeKeyFile, makePackage, type TestKeyFile } from './helpers/link-audit-seal-sign-cli-fixtures';
import { CONFIRM_LENGTH, E1, writeStation } from './helpers/link-audit-seal-sign-disk-fixtures';

/*
 * P1 W4.6 — o ARTEFATO ÚNICO do `sign`/`close-key` (spec §5.5.1 itens 5–7; IA-03 artefato, IA-24; confirmação da revisão da W4.5, critérios i e ii).
 *  - build reprodutível (esbuild travado, opções fixas) e o SHA-256 versionado em `docs/phase6-auditoria-link/p1-sign-artifact.sha256`;
 *  - o ARQUIVO FINAL só carrega módulos da lista literal, por `require` estático; as guardas do build recusam o resto (mutações);
 *  - o recibo do artefato leva o SHA-256 dos próprios bytes;
 *  - em processo REAL, por `env -i` com o node por caminho absoluto e `--permission`: as recusas da barreira e uma assinatura completa num
 *    pseudo-terminal (`script`), com grants estreitos, chave GERADA no teste e o manifesto autenticado pelo verificador v2.
 * Dados 100% FICTÍCIOS. A assinatura completa precisa de uma "estação": uma pasta fora das temporárias e de qualquer árvore com `.git` (a custódia da
 * chave recusa as duas), criada e apagada no HOME. Sem `script` ou sem essa pasta, o teste é pulado; com LINK_AUDIT_ARTIFACT_STRICT=1 (job do
 * artefato no CI), pular é falha.
 */
registerCleanup();

const STRICT = process.env.LINK_AUDIT_ARTIFACT_STRICT === '1';
const LIMIT_MS = 90_000;
/** Spec §5.5.1 item 7, LITERAL (a lista do build tem de ser exatamente esta). */
const LITERAL_LIST = ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:readline', 'node:process'];
/** As opções do node da linha do runbook (antes dos grants de caminho). */
const RUNBOOK_FLAGS = ['--disable-sigusr1', '--permission'];
const PROC_GRANTS = ['/proc/self/cmdline', '/proc/self/environ'].map((file) => `--allow-fs-read=${file}`);

let shared: Promise<BuiltArtifact> | null = null;
/** Um build por arquivo de teste (as guardas e o hash são do mesmo arquivo que os processos reais executam). */
const built = (): Promise<BuiltArtifact> => (shared ??= buildSignArtifact({ outDir: tmpDir('lasa-build-') }));
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hasScript = ((): boolean => {
  try {
    execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skipOrFail = (reason: string): string | false => {
  if (STRICT) assert.fail(`LINK_AUDIT_ARTIFACT_STRICT=1: ${reason}`);
  return reason;
};

/* =============================================================================================================== build e hash */

test('IA-24 (§5.5.1 itens 5 e 6): o build é REPRODUTÍVEL (duas pastas, mesmos bytes) e o SHA-256 é o versionado; o arquivo versionado tem o formato do sha256sum', async () => {
  const first = await built();
  const second = await buildSignArtifact({ outDir: tmpDir('lasa-build2-') });
  assert.ok(first.bytes.equals(second.bytes), 'mesmos bytes em pastas diferentes');
  assert.equal(first.sha256, sha256Of(fs.readFileSync(first.file)), 'o hash é o dos bytes gravados');
  assert.equal(path.basename(first.file), ARTIFACT_FILE_NAME);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o444, 'gravado somente leitura');
  assert.equal(fs.readFileSync(VERSIONED_HASH_FILE, 'utf8'), `${hashLine(first.sha256)}\n`, 'docs/phase6-auditoria-link/p1-sign-artifact.sha256 = o hash recompilado (uma linha, formato do sha256sum)');
  assert.equal(versionedSha256(), first.sha256);
});

test('IA-03 artefato (§5.5.1 item 7, RS-14): o ARQUIVO FINAL só carrega módulos da lista LITERAL, por require estático; nenhum carregamento dinâmico; o export, o leitor de evidências e a rede ficam de fora', async () => {
  assert.deepEqual([...ARTIFACT_NODE_MODULES], LITERAL_LIST, 'a lista do build é a literal da spec');
  const artifact = await built();
  const text = fs.readFileSync(artifact.file, 'utf8');
  const required = [...text.matchAll(/\brequire\s*\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1] as string);
  assert.ok(required.length > 0 && required.every((specifier) => LITERAL_LIST.includes(specifier)), `require fora da lista: ${required.filter((s) => !LITERAL_LIST.includes(s)).join(', ')}`);
  assert.equal([...text.matchAll(/\brequire\s*\(/g)].length, required.length, 'todo require( tem string literal');
  assert.deepEqual([...new Set(required)].sort(), artifact.requires, 'o que o build relatou é o que está no arquivo');
  assert.ok(!/\bimport\s*\(|\bcreateRequire\b|\bmodule\s*\.\s*require\b|\brequire\s*\.\s*resolve\b|\bprocess\s*\.\s*(?:binding|dlopen)\b/.test(text), 'carregamento dinâmico');
  for (const absent of ['node:dns', 'node:net', 'node:child_process', 'node:http', 'node:os', 'exportCandidatePackage', 'readScoringBasis', 'LINK_AUDIT_SIGN_ARTIFACT']) assert.ok(!text.includes(absent), `${absent} no artefato`);
  assert.deepEqual(checkArtifactText(text, []), artifact.requires);
});

/** Entrada fictícia para provar que as guardas do build recusam (cada caso é uma mutação do que o artefato pode carregar). */
function fixtureEntry(source: string): string {
  const dir = tmpDir('lasa-fixture-');
  const file = path.join(dir, 'entrada.ts');
  fs.writeFileSync(file, source);
  return file;
}

test('guardas do build (mutações): módulo fora da lista (node:os, node:net, fs sem prefixo), import() dinâmico, require com nome calculado ou caminho absoluto no texto ⇒ ArtifactBuildError e NADA gravado', async () => {
  const cases: ReadonlyArray<readonly [string, string, ArtifactBuildError['code']]> = [
    ['node:os', "import os from 'node:os';\nconsole.log(os.hostname());\n", 'IMPORT_NOT_ALLOWED'],
    ['node:net', "import net from 'node:net';\nconsole.log(typeof net.connect);\n", 'IMPORT_NOT_ALLOWED'],
    ['fs sem prefixo', "import fs from 'fs';\nconsole.log(typeof fs.readFileSync);\n", 'IMPORT_NOT_ALLOWED'],
    ['import() dinâmico', "void import('node:crypto').then((m) => console.log(typeof m));\n", 'DYNAMIC_LOAD'],
    ['require calculado', "declare const require: (name: string) => unknown;\nconst name = ['node', 'net'].join(':');\nconsole.log(require(name));\n", 'DYNAMIC_LOAD'],
  ];
  for (const [label, source, code] of cases) {
    const outDir = tmpDir('lasa-out-');
    await assert.rejects(buildSignArtifact({ outDir, entry: fixtureEntry(source) }), (error: unknown) => error instanceof ArtifactBuildError && error.code === code, label);
    assert.deepEqual(fs.readdirSync(outDir), [], `${label}: nada gravado`);
  }
  assert.throws(() => checkArtifactText('console.log("/home/estacao/repo/x")', ['/home/estacao/repo']), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'ABSOLUTE_PATH');
  assert.throws(() => checkArtifactText('const a = require("node:crypto"); const b = require("node:os");', []), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'IMPORT_NOT_ALLOWED');
});

/* =============================================================================================================== recibo (em processo) */

const NUL = '\0';
const block = (records: readonly string[]): Uint8Array => Buffer.from(records.map((record) => `${record}${NUL}`).join(''), 'utf8');

test('§5.5.1 item 6: no artefato, o recibo leva artifactSha256 = SHA-256 dos bytes do próprio arquivo; artefato ilegível ⇒ SIGN_ARTIFACT_UNREADABLE (código 3) antes de ler qualquer entrada; pelo código-fonte, null', async () => {
  const artifact = await built();
  const world = cliWorld();
  const flags = [...RUNBOOK_FLAGS, `--allow-fs-read=${path.dirname(artifact.file)}`];
  const asArtifact = (file: string, typed: ReturnType<typeof world.typed>) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      projectRoot: path.dirname(artifact.file),
      artifact: { file },
      execArgv: flags,
      execBlock: { cmdline: async () => block(['/usr/bin/node', ...flags, file, 'sign']), environ: async () => block([]) },
      env: {},
      terminal: new FakeTerminal(typed),
      report: { reportOnFatalError: true, reportOnSignal: true, reportOnUncaughtException: true },
      tempRoots: [],
    };
    return runSignArtifact(['sign', ...world.argv(), '--json'], (line) => out.push(line), (line) => err.push(line), () => new Date(), deps).then((code) => ({ code, out, err }));
  };
  const run = await asArtifact(artifact.file, world.typed());
  assert.equal(run.code, 0, run.err.join('\n'));
  const receipt = JSON.parse(run.out[0] ?? '{}') as Record<string, unknown>;
  assert.equal(receipt.artifactSha256, artifact.sha256, 'o recibo anota o hash dos bytes do artefato');
  assert.ok(run.err.some((line) => line.includes(`artifactSha256 ${artifact.sha256}`)), 'a saída de erro mostra o hash para a conferência da estação');
  assert.ok(!run.err.some((line) => /artifactSha256 é nulo/.test(line)));
  const unreadable = await asArtifact(path.join(tmpDir('lasa-sem-'), ARTIFACT_FILE_NAME), world.typed());
  assert.equal(unreadable.code, 3);
  assert.equal((JSON.parse(unreadable.out[0] ?? '{}') as Record<string, unknown>).code, 'SIGN_ARTIFACT_UNREADABLE');
  const usage = await runSignArtifact(['export', '--json'], () => undefined, () => undefined);
  assert.equal(usage, 1, 'o export não faz parte do artefato');
});

/* =============================================================================================================== processo REAL (env -i, --permission) */

interface RealRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `env -i [variáveis] <node absoluto> <opções> <artefato> <args>` — a linha do runbook (critério i), sem herdar nada do ambiente do teste. */
function viaEnvI(nodeOptions: readonly string[], artifactFile: string, args: readonly string[], envAssignments: readonly string[] = []): RealRun {
  const result = spawnSync('env', ['-i', ...envAssignments, process.execPath, ...nodeOptions, artifactFile, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function refusedBarrier(run: RealRun, label: string, message?: RegExp): void {
  assert.equal(run.status, 3, `${label}: código 3 (veio ${run.status}): ${run.stderr}`);
  assert.match(run.stderr, /Código: SIGN_RUNTIME_UNSAFE/, label);
  if (message) assert.match(run.stderr, message, label);
}

test('critérios i e ii em processo REAL: por env -i com o node por caminho absoluto, --disable-sigusr1, --permission e grants estreitos o artefato passa a barreira (USAGE, código 1); sem o modelo de permissões, sem --disable-sigusr1, com ambiente, com opção extra, sem grant do /proc ou com uma pré-carga que limpa NODE_OPTIONS ⇒ SIGN_RUNTIME_UNSAFE (código 3)', { timeout: LIMIT_MS }, async () => {
  assert.ok(path.isAbsolute(process.execPath), 'node por caminho absoluto');
  const artifact = await built();
  const artifactGrant = `--allow-fs-read=${path.dirname(artifact.file)}`;
  const runbook = [...RUNBOOK_FLAGS, artifactGrant, ...PROC_GRANTS];
  const passed = viaEnvI(runbook, artifact.file, ['sign']);
  assert.equal(passed.status, 1, `a linha do runbook passa a barreira e cai no analisador (USAGE): ${passed.stderr}`);
  assert.match(passed.stderr, /Informe --audit/);
  assert.equal(viaEnvI(runbook, artifact.file, ['close-key']).status, 1, 'close-key também');
  // sem --permission o node nem aceita --allow-fs-*: a linha sem o modelo de permissões é a de um node comum
  refusedBarrier(viaEnvI([], artifact.file, ['sign']), 'sem --permission (node comum)', /--permission/);
  refusedBarrier(viaEnvI(['--permission', artifactGrant, ...PROC_GRANTS], artifact.file, ['sign']), 'sem --disable-sigusr1', /--disable-sigusr1/);
  refusedBarrier(viaEnvI(runbook, artifact.file, ['sign'], ['LANG=C.UTF-8']), 'ambiente não vazio', /env -i/);
  refusedBarrier(viaEnvI([...runbook, '--expose-gc'], artifact.file, ['sign']), 'opção extra do node');
  refusedBarrier(viaEnvI([...RUNBOOK_FLAGS, artifactGrant], artifact.file, ['sign']), 'sem grant de /proc/self/cmdline e environ', /\/proc\/self/);
  // critério ii: a pré-carga roda ANTES do comando e apaga NODE_OPTIONS de process.env; o ambiente ORIGINAL ainda o tem
  const dir = tmpDir('lasa-preload-');
  const preload = path.join(dir, 'limpa-ambiente.cjs');
  fs.writeFileSync(preload, "delete process.env.NODE_OPTIONS;\nprocess.execArgv.length = 0;\nprocess.stderr.write('PRELOAD_RODOU\\n');\n");
  const hidden = viaEnvI([...runbook, `--allow-fs-read=${dir}`], artifact.file, ['sign'], [`NODE_OPTIONS=--require=${preload}`]);
  assert.match(hidden.stderr, /PRELOAD_RODOU/, 'a pré-carga rodou');
  refusedBarrier(hidden, 'pré-carga que limpa process.env e execArgv', /NODE_OPTIONS/);
  assert.ok(!hidden.stderr.includes(preload), 'o valor da variável nunca é ecoado');
});

/* =============================================================================================================== assinatura completa (PTY) */

/** Uma "estação" no HOME: fora das pastas temporárias e de qualquer árvore com `.git`, como a custódia exige. `null` se não for possível. */
function stationDir(): string | null {
  const home = os.homedir();
  if (!home || !path.isAbsolute(home) || !fs.existsSync(home)) return null;
  for (let dir = home; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    if (path.dirname(dir) === dir) break;
  }
  const temps = [os.tmpdir(), '/tmp', '/var/tmp', '/dev/shm'].map((dir) => (fs.existsSync(dir) ? fs.realpathSync(dir) : dir));
  const realHome = fs.realpathSync(home);
  if (temps.some((temp) => realHome === temp || realHome.startsWith(`${temp}${path.sep}`))) return null;
  try {
    return fs.mkdtempSync(path.join(home, '.lasa-estacao-'));
  } catch {
    return null;
  }
}

/** Os `.git` de cada pasta acima do arquivo de chave (a custódia faz `lstat` deles), da pasta da estação até a raiz. */
function gitAncestorGrants(station: string): string[] {
  const grants: string[] = [];
  for (let dir = station; ; dir = path.dirname(dir)) {
    grants.push(path.join(dir, '.git'));
    if (path.dirname(dir) === dir) return grants;
  }
}

/**
 * A linha do runbook para esta estação: o artefato, as entradas, a pasta de manifestos (leitura e escrita), a pasta da chave, os `.git` das pastas
 * acima dela, as raízes temporárias (a custódia resolve o caminho real delas), o bloco original do exec e `/proc/self/fd` (caminho real do descritor
 * da chave). Nenhum grant é prefixo de texto de outro (o Node 24 nega o mais curto quando um mais longo com o mesmo começo foi dado antes).
 */
function runbookGrants(layout: { readonly artifactDir: string; readonly inputs: string; readonly seals: string; readonly keyDir: string; readonly station: string }): string[] {
  const reads = [layout.artifactDir, layout.inputs, layout.seals, layout.keyDir, ...gitAncestorGrants(layout.station), '/tmp', '/var/tmp', '/dev/shm', '/proc/self/cmdline', '/proc/self/environ', '/proc/self/fd'];
  for (const a of reads) for (const b of reads) assert.ok(a === b || !b.startsWith(a), `grant ${a} é prefixo de ${b}`);
  return [...RUNBOOK_FLAGS, ...reads.map((dir) => `--allow-fs-read=${dir}`), `--allow-fs-write=${layout.seals}`];
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * O node deste processo deixa `fsync` sob `--permission`? O Node 24.22.0 passou a bloquear `fsync`/`fdatasync` com o modelo de permissões
 * (nodejs/node#65431); a gravação à prova de queda do `sign` (§5.5.1 item 4: fsync do arquivo e da pasta) então recusa, fechada (SIGN_WRITE_FAILED).
 */
function permissionAllowsFsync(): boolean {
  const dir = tmpDir('lasa-fsync-');
  const code = `const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(path.join(dir, 'x'))},'wx');try{fs.fsyncSync(fd);process.exitCode=0}catch{process.exitCode=7}finally{fs.closeSync(fd)}`;
  return spawnSync(process.execPath, ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '-e', code], { encoding: 'utf8', timeout: 30_000 }).status === 0;
}

/** Roda a linha no pseudo-terminal e digita a confirmação e a frase quando os pedidos aparecem (como o teste PTY da W4.4). */
function runInPty(command: readonly string[], confirmation: string, passphrase: string): Promise<{ readonly code: number | null; readonly screen: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-q', '-e', '-c', command.map(quote).join(' '), '/dev/null'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' } as unknown as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let screen = '';
    let step = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pseudo-terminal sem resposta: ${screen}`));
    }, LIMIT_MS);
    const onOutput = (chunk: Buffer): void => {
      screen += chunk.toString('utf8');
      if (step === 0 && /12 primeiros caracteres/.test(screen)) {
        step = 1;
        child.stdin.write(`${confirmation}\r`);
      } else if (step === 1 && /Frase-senha/.test(screen)) {
        step = 2;
        child.stdin.write(`${passphrase}\r`);
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      child.stdin.end();
      resolve({ code, screen });
    });
  });
}

test('critério i, assinatura completa: env -i + node absoluto + --permission com grants ESTREITOS, num pseudo-terminal (script): confirmação e frase sem eco, manifesto gravado e AUTENTICADO pelo verificador v2, recibo com artifactSha256 = SHA-256 do arquivo executado', { timeout: LIMIT_MS + 30_000 }, async (t) => {
  if (!hasScript) return t.skip(skipOrFail('script (util-linux) indisponível') || undefined);
  const station = stationDir();
  if (station === null) return t.skip(skipOrFail('sem pasta de estação possível (HOME ausente, temporário ou dentro de uma árvore com .git)') || undefined);
  try {
    const artifact = await built();
    const layout = { station, artifactDir: path.join(station, 'artefato'), inputs: path.join(station, 'entradas'), seals: path.join(station, 'manifestos'), keyDir: path.join(station, 'chave') };
    for (const dir of [layout.artifactDir, layout.inputs, layout.seals]) fs.mkdirSync(dir, { recursive: true });
    const artifactFile = path.join(layout.artifactDir, ARTIFACT_FILE_NAME);
    fs.copyFileSync(artifact.file, artifactFile);
    fs.chmodSync(artifactFile, 0o444);
    const pkg = makePackage(E1);
    const files = writeStation(layout.inputs, { pkg });
    const key: TestKeyFile = makeKeyFile({ dir: layout.keyDir });
    const args = ['sign', '--audit', AUD, '--package', files.packagePath, '--approval', files.approvalPath, '--dossier', files.dossierPath, '--seals-dir', layout.seals, '--expect-seq', '1', '--first', '--key-id', key.keyId, '--key-source', `file:${key.keyPath}`, '--custodian', CUSTODIAN, '--trust-keys', key.ring];
    const run = await runInPty(['env', '-i', process.execPath, ...runbookGrants(layout), artifactFile, ...args], pkg.packageSha256.slice(0, CONFIRM_LENGTH), key.passphrase);
    for (const sentinel of key.sentinels) assert.ok(!run.screen.includes(sentinel), 'a frase (ou a chave) apareceu na tela');
    if (!permissionAllowsFsync()) {
      // barreira, custódia sob grants estreitos, chave e autoteste passaram; a gravação precisa de fsync e recusa fechada: nada gravado nem recibo
      assert.equal(run.code, 3, run.screen);
      assert.match(run.screen, /Chave aberta; pública derivada/);
      assert.match(run.screen, /Código: SIGN_WRITE_FAILED/);
      assert.ok(!/Recibo \(JSON\)/.test(run.screen), 'nenhum recibo');
      const written = (fs.readdirSync(layout.seals, { recursive: true, encoding: 'utf8' }) as string[]).filter((name) => /seal-\d{4}\.json/.test(name));
      assert.deepEqual(written, [], 'nenhum manifesto (nem temporário) gravado');
      if (STRICT) assert.fail(`LINK_AUDIT_ARTIFACT_STRICT=1: o node ${process.version} bloqueia fsync sob --permission (nodejs/node#65431); a assinatura completa sob o modelo de permissões não é possível sem decisão (notas da W4.6)`);
      return;
    }
    assert.equal(run.code, 0, run.screen);
    assert.match(run.screen, /MANIFESTO v2 ASSINADO/);
    const receiptText = /Recibo \(JSON\): (\{[^\r\n]*\})/.exec(run.screen)?.[1];
    assert.ok(receiptText, `recibo na tela: ${run.screen}`);
    const receipt = JSON.parse(receiptText as string) as Record<string, unknown>;
    assert.equal(receipt.artifactSha256, sha256Of(fs.readFileSync(artifactFile)), 'o recibo anota o hash dos bytes executados');
    assert.equal(receipt.artifactSha256, artifact.sha256);
    const verdict = await createSealedEvidenceProvenance({ sealsDir: layout.seals, keyring: parseTrustKeyring(key.ring) as TrustKeyring, acceptedVersions: [2] }).classify(AUD, E1.map(({ ref, contentSha256 }) => ({ ref, contentSha256, legacy: false })));
    assert.equal(verdict.status, 'AUTHENTICATED', JSON.stringify(verdict));
  } finally {
    fs.rmSync(station, { recursive: true, force: true });
  }
});
