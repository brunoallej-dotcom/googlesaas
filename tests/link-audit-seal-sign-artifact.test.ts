import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARTIFACT_FILE_NAME, ARTIFACT_NODE_MODULES, ArtifactBuildError, buildSignArtifact, checkArtifactText, hashLine, VERSIONED_HASH_FILE, versionedSha256, ZOD_FUNCTION_EXCEPTIONS, type BuiltArtifact } from '../scripts/build-sign-artifact';
import { runSignArtifact } from '../scripts/link-audit-sign-artifact';
import { config as zodConfig } from 'zod';
import { createSealedEvidenceProvenance, parseTrustKeyring, type TrustKeyring } from '../src/lib/link-audit-evidence/provenance';
import { nodeFsOps } from '../src/lib/link-audit/node-fs-ops';
import { nodeKeyFileOps, type KeyFileOps } from '../src/lib/link-audit-attestation/sign-key';
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
/** O bloco original do exec e `/proc/self/fd` (caminho real dos descritores do artefato e da chave). */
const PROC_GRANTS = ['/proc/self/cmdline', '/proc/self/environ', '/proc/self/fd'].map((file) => `--allow-fs-read=${file}`);

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
    // revisão independente da W4.6 (2): no Node 22 o modelo de permissões não restringe rede; esta guarda é o controle
    ['getBuiltinModule', "console.log(typeof process.getBuiltinModule('node:net'));\n", 'DYNAMIC_LOAD'],
    ['require como valor', "declare const require: (name: string) => unknown;\nconst load = require;\nconsole.log(load('node:net'));\n", 'DYNAMIC_LOAD'],
    // o esbuild normaliza (require)('x') para require("x") estático: a saída cai na lista literal
    ['require entre parênteses', "declare const require: (name: string) => unknown;\nconsole.log((require)('node:net'));\n", 'IMPORT_NOT_ALLOWED'],
    // idem para module.require('x'): vira require("x") estático (a forma de membro no texto final é recusada abaixo, em checkArtifactText)
    ['module.require', "declare const module: { require(name: string): unknown };\nconsole.log(module.require('node:net'));\n", 'IMPORT_NOT_ALLOWED'],
    ['process.binding', "console.log((process as unknown as { binding(name: string): unknown }).binding('fs'));\n", 'DYNAMIC_LOAD'],
    ['_linkedBinding', "console.log((process as unknown as { _linkedBinding(name: string): unknown })._linkedBinding('x'));\n", 'DYNAMIC_LOAD'],
    ['createRequire', "declare const createRequire: (url: string) => (name: string) => unknown;\nconsole.log(createRequire('/x')('node:net'));\n", 'DYNAMIC_LOAD'],
    ['Module._load', "declare const module: { constructor: { _load(name: string): unknown } };\nconsole.log(module.constructor._load('node:net'));\n", 'DYNAMIC_LOAD'],
    ['mainModule', "console.log((process as unknown as { mainModule: unknown }).mainModule);\n", 'DYNAMIC_LOAD'],
    ['eval', "console.log(eval('1 + 1'));\n", 'DYNAMIC_LOAD'],
    ['new Function', "console.log(new Function('return 1')());\n", 'DYNAMIC_LOAD'],
    ['Function como valor', "const F = Function;\nconsole.log(new F('return 1')());\n", 'DYNAMIC_LOAD'],
  ];
  for (const [label, source, code] of cases) {
    const outDir = tmpDir('lasa-out-');
    await assert.rejects(buildSignArtifact({ outDir, entry: fixtureEntry(source) }), (error: unknown) => error instanceof ArtifactBuildError && error.code === code, label);
    assert.deepEqual(fs.readdirSync(outDir), [], `${label}: nada gravado`);
  }
  assert.throws(() => checkArtifactText('console.log("/home/estacao/repo/x")', ['/home/estacao/repo']), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'ABSOLUTE_PATH');
  assert.throws(() => checkArtifactText('const a = require("node:crypto"); const b = require("node:os");', []), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'IMPORT_NOT_ALLOWED');
  // no texto final: toda ocorrência do identificador require é exatamente require("<módulo da lista>"); e os carregadores indiretos recusados
  for (const text of ['const r = require;', 'x.require("node:crypto")', 'require . resolve("x")', 'const m = import.meta;', 'import("node:net")', 'const e = eval;', 'globalThis.eval("1")', 'Function("return 1")', 'new Function("x")', 'process.getBuiltinModule("node:net")', 'process.binding("fs")', 'process._linkedBinding("x")', 'module.constructor._load("x")', 'process.mainModule', 'createRequire("/x")']) {
    assert.throws(() => checkArtifactText(text, []), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'DYNAMIC_LOAD', text);
  }
  assert.deepEqual(checkArtifactText('var c = require("node:crypto"), p = require( "node:path" );', []), ['node:crypto', 'node:path']);
});

test('confirmação da revisão da W4.6 (2a): cada exceção do zod ao identificador Function fixa a função ou o trecho INTEIRO, pelo texto exato e pelo SHA-256; prefixo seguido de outro uso do apelido F, 1 caractere mudado ou repetição ⇒ ArtifactBuildError', async () => {
  // util.allowsEval (testa se o runtime gera código), core/doc.js (JIT dos validadores), core/compile.js (z.compile, não usado pelo sign) e texto
  assert.deepEqual(ZOD_FUNCTION_EXCEPTIONS.map((exception) => exception.name), ['util.allowsEval', 'Doc.compile', 'z.compile (compileFn)', 'mensagem do JSON Schema']);
  for (const exception of ZOD_FUNCTION_EXCEPTIONS) assert.equal(sha256Of(Buffer.from(exception.text, 'utf8')), exception.sha256, `${exception.name}: o SHA-256 fixado é o do texto`);
  const text = fs.readFileSync((await built()).file, 'utf8');
  for (const exception of ZOD_FUNCTION_EXCEPTIONS) assert.equal(text.split(exception.text).length - 1, 1, `${exception.name}: presente exatamente uma vez, inteira`);
  const refused = (sample: string, label: string): void => {
    assert.throws(() => checkArtifactText(sample, []), (error: unknown) => error instanceof ArtifactBuildError && error.code === 'DYNAMIC_LOAD', label);
  };
  const docCompile = (ZOD_FUNCTION_EXCEPTIONS[1] as { readonly text: string }).text;
  refused('compile(){const F=Function;return new F("return process")()}', 'o prefixo antigo seguido de outro uso de F');
  refused(docCompile.replace('Object.values', 'Object.entries'), '1 caractere a mais ou a menos no trecho');
  refused(docCompile.replace('closed))}', 'closed));F("x")}'), 'uso do apelido F acrescentado no fim do trecho');
  refused(`${docCompile}${docCompile}`, 'uma exceção repetida não esconde a segunda');
  assert.deepEqual(checkArtifactText(ZOD_FUNCTION_EXCEPTIONS.map((exception) => exception.text).join(';'), []), [], 'as quatro, inteiras, passam');
});

test('confirmação da revisão da W4.6 (2b): a entrada do artefato configura o zod SEM JIT antes de qualquer esquema existir (jitless); no artefato real, carregar os módulos não chama Function nenhuma vez (contado por uma pré-carga que só observa)', { timeout: LIMIT_MS }, async () => {
  assert.equal(zodConfig().jitless, true, 'a entrada (importada por este teste) ligou o jitless');
  const artifact = await built();
  const dir = tmpDir('lasa-jit-');
  const counter = path.join(dir, 'conta-function.cjs');
  fs.writeFileSync(counter, [
    'const Original = Function;',
    'let calls = 0;',
    'globalThis.Function = new Proxy(Original, { construct(target, args) { calls += 1; return Reflect.construct(target, args); }, apply(target, self, args) { calls += 1; return Reflect.apply(target, self, args); } });',
    "process.on('exit', () => process.stderr.write('FUNCTION_CALLS=' + calls + '\\n'));",
    '',
  ].join('\n'));
  // sem o modelo de permissões: a barreira do artefato recusa (código 3) DEPOIS de todos os módulos (e esquemas) carregados, que é o que importa aqui
  const run = spawnSync('env', ['-i', process.execPath, '--require', counter, artifact.file, 'sign'], { encoding: 'utf8', timeout: 60_000 });
  assert.match(run.stderr, /Código: SIGN_RUNTIME_UNSAFE/, run.stderr);
  assert.match(run.stderr, /FUNCTION_CALLS=0\b/, `nenhuma geração de código com o jitless: ${run.stderr}`);
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

/** O artefato numa pasta própria (0700, criada por mkdtemp), arquivo 0444: a custódia que a linha do runbook pressupõe. */
async function custodiedCopy(): Promise<string> {
  const dir = tmpDir('lasa-custodia-');
  const file = path.join(dir, ARTIFACT_FILE_NAME);
  fs.copyFileSync((await built()).file, file);
  fs.chmodSync(file, 0o444);
  return file;
}
interface ArtifactRun {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}
/** O CLI do artefato em processo, como se rodasse da linha do runbook (opções do node, bloco original e ambiente vazio injetados). */
async function runAsArtifact(subcommand: 'sign' | 'close-key', file: string, argv: readonly string[], options: { readonly typed?: ReturnType<ReturnType<typeof cliWorld>['typed']>; readonly nodeOptions?: readonly string[]; readonly keyFs?: KeyFileOps; readonly uid?: number; readonly fs?: unknown } = {}): Promise<ArtifactRun> {
  const out: string[] = [];
  const err: string[] = [];
  const flags = options.nodeOptions ?? [...RUNBOOK_FLAGS, `--allow-fs-read=${path.dirname(file)}`];
  const deps = {
    projectRoot: path.dirname(file),
    artifact: { file },
    execArgv: flags,
    execBlock: { cmdline: async () => block(['/usr/bin/node', ...flags, file, subcommand]), environ: async () => block([]) },
    env: {},
    terminal: new FakeTerminal(options.typed ?? []),
    report: { reportOnFatalError: true, reportOnSignal: true, reportOnUncaughtException: true },
    tempRoots: [],
    ...(options.keyFs ? { keyFs: options.keyFs } : {}),
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    ...(options.fs ? { fs: options.fs as never } : {}),
  };
  const code = await runSignArtifact([subcommand, ...argv, '--json'], (line) => out.push(line), (line) => err.push(line), () => new Date(), deps);
  return { code, out, err };
}
const codeOf = (run: ArtifactRun): unknown => (JSON.parse(run.out[0] ?? '{}') as Record<string, unknown>).code;

test('revisão independente da W4.6 (1): o hash do recibo sai do DESCRITOR do próprio artefato, aberto uma vez (O_NOFOLLOW), sob custódia: arquivo comum, sem escrita para ninguém, do usuário ou do root, numa pasta sem escrita para grupo e outros (salvo sticky); qualquer violação ⇒ SIGN_ARTIFACT_UNSAFE antes de ler qualquer entrada', async () => {
  const world = cliWorld();
  const reads: string[] = [];
  const counting: KeyFileOps = {
    ...nodeKeyFileOps,
    openKeyFile: async (target) => {
      const opened = await nodeKeyFileOps.openKeyFile(target);
      return { ...opened, read: (...args) => (reads.push('descritor'), opened.read(...args)) };
    },
  };
  const good = await custodiedCopy();
  const ok = await runAsArtifact('sign', good, world.argv(), { typed: world.typed(), keyFs: counting });
  assert.equal(ok.code, 0, ok.err.join('\n'));
  assert.equal((JSON.parse(ok.out[0] ?? '{}') as Record<string, unknown>).artifactSha256, sha256Of(fs.readFileSync(good)));
  assert.ok(reads.length > 0, 'o hash é lido pelo descritor aberto');
  const refusedBeforeInputs = async (file: string, label: string, options: Parameters<typeof runAsArtifact>[3] = {}): Promise<void> => {
    const data: string[] = [];
    const spy = new Proxy(nodeFsOps, { get: (target, property, receiver) => (typeof Reflect.get(target, property, receiver) === 'function' ? (...args: unknown[]) => (data.push(String(property)), (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown).apply(target, args)) : Reflect.get(target, property, receiver)) });
    const run = await runAsArtifact('sign', file, world.argv(), { typed: world.typed(), fs: spy, ...options });
    assert.equal(run.code, 3, `${label}: ${run.err.join('\n')}`);
    assert.equal(codeOf(run), 'SIGN_ARTIFACT_UNSAFE', label);
    assert.deepEqual(data, [], `${label}: nenhuma entrada lida`);
  };
  const writable = await custodiedCopy();
  fs.chmodSync(writable, 0o644);
  await refusedBeforeInputs(writable, 'arquivo com escrita para o dono');
  const groupWritable = await custodiedCopy();
  fs.chmodSync(groupWritable, 0o464);
  await refusedBeforeInputs(groupWritable, 'arquivo com escrita para o grupo');
  const openDir = await custodiedCopy();
  fs.chmodSync(path.dirname(openDir), 0o777);
  await refusedBeforeInputs(openDir, 'pasta gravável por grupo e outros, sem sticky');
  const sticky = await custodiedCopy();
  fs.chmodSync(path.dirname(sticky), 0o1777);
  const stickyRun = await runAsArtifact('sign', sticky, world.argv(), { typed: world.typed() });
  assert.notEqual(codeOf(stickyRun), 'SIGN_ARTIFACT_UNSAFE', 'pasta com sticky bit (como /tmp) é aceita, como na W4.5');
  const link = path.join(tmpDir('lasa-link-'), ARTIFACT_FILE_NAME);
  fs.symlinkSync(await custodiedCopy(), link);
  await refusedBeforeInputs(link, 'o caminho do artefato é link simbólico');
  const otherOwner: KeyFileOps = {
    ...nodeKeyFileOps,
    openKeyFile: async (target) => {
      const opened = await nodeKeyFileOps.openKeyFile(target);
      return { ...opened, stat: async () => ({ ...pick(await opened.stat()), uid: 4242 }) };
    },
  };
  await refusedBeforeInputs(await custodiedCopy(), 'dono que não é o usuário nem o root', { keyFs: otherOwner, uid: 4243 });
  // troca do arquivo depois da abertura: o descritor aponta para o inode original (apagado do nome) ⇒ recusa; nunca o hash do arquivo novo
  const swapped = await custodiedCopy();
  const swapping: KeyFileOps = {
    ...nodeKeyFileOps,
    openKeyFile: async (target) => {
      const opened = await nodeKeyFileOps.openKeyFile(target);
      const replacement = `${target}.novo`;
      fs.writeFileSync(replacement, 'trocado depois da abertura', { mode: 0o444 });
      fs.renameSync(replacement, target);
      return opened;
    },
  };
  await refusedBeforeInputs(swapped, 'arquivo trocado depois da abertura', { keyFs: swapping });
  // troca DURANTE a leitura (depois das conferências do lugar): o caminho do descritor é conferido de novo no fim ⇒ recusa
  const duringRead = await custodiedCopy();
  const swappingOnRead: KeyFileOps = {
    ...nodeKeyFileOps,
    openKeyFile: async (target) => {
      const opened = await nodeKeyFileOps.openKeyFile(target);
      let swappedOnce = false;
      return {
        ...opened,
        read: (...args) => {
          if (!swappedOnce) {
            swappedOnce = true;
            fs.writeFileSync(`${target}.novo`, 'trocado durante a leitura', { mode: 0o444 });
            fs.renameSync(`${target}.novo`, target);
          }
          return opened.read(...args);
        },
      };
    },
  };
  await refusedBeforeInputs(duringRead, 'arquivo trocado durante a leitura', { keyFs: swappingOnRead });
});
/** Os campos de `KeyFileStat` de um `fstat` real (o spread perderia os métodos do Stats). */
const pick = (info: Awaited<ReturnType<Awaited<ReturnType<KeyFileOps['openKeyFile']>>['stat']>>) => ({ isFile: () => info.isFile(), mode: info.mode, nlink: info.nlink, size: info.size, uid: info.uid });

test('revisão independente da W4.6 (3): no artefato, --allow-fs-write só na raiz real de --seals-dir ou dentro dela (no close-key, só _closures); grant igual a / ou com *, relativo, não normalizado, com vírgula, ou leitura rasa (menos de dois componentes, salvo /tmp e os .git da custódia) ⇒ SIGN_RUNTIME_UNSAFE antes de ler qualquer entrada', async () => {
  const file = await custodiedCopy();
  const world = cliWorld();
  const seals = fs.realpathSync(world.sealsDir);
  const base = [...RUNBOOK_FLAGS, `--allow-fs-read=${path.dirname(file)}`];
  const signWith = (extra: readonly string[], on = world) => runAsArtifact('sign', file, on.argv(), { typed: on.typed(), nodeOptions: [...base, ...extra] });
  const passing: ReadonlyArray<(root: string) => string[]> = [
    (root) => [`--allow-fs-write=${root}`, `--allow-fs-read=${root}`],
    (root) => [`--allow-fs-write=${path.join(root, AUD)}`],
    () => ['--allow-fs-read=/tmp', '--allow-fs-read=/.git', '--allow-fs-read=/home/.git', '--allow-fs-read=/var/tmp', '--allow-fs-read=/dev/shm', '--allow-fs-read=/proc/self/fd'],
  ];
  for (const grants of passing) {
    const fresh = cliWorld();
    const extra = grants(fs.realpathSync(fresh.sealsDir));
    const run = await signWith(extra, fresh);
    assert.equal(run.code, 0, `${JSON.stringify(extra)}: ${run.err.join('\n')}`);
  }
  const outside = tmpDir('lasa-fora-');
  for (const extra of [['--allow-fs-write=/'], ['--allow-fs-write=*'], [`--allow-fs-write=${outside}`], [`--allow-fs-write=${path.dirname(seals)}`], [`--allow-fs-write=${seals}x`], ['--allow-fs-read=/'], ['--allow-fs-read=*'], [`--allow-fs-read=${outside}/*`], ['--allow-fs-read=/home'], ['--allow-fs-read=/etc'], ['--allow-fs-read=relativo/pasta'], [`--allow-fs-read=${seals}/../x`], [`--allow-fs-read=${seals}/`], [`--allow-fs-read=${seals},/etc`]]) {
    const run = await signWith(extra);
    assert.equal(run.code, 3, `${JSON.stringify(extra)}: ${run.err.join('\n')}`);
    assert.equal(codeOf(run), 'SIGN_RUNTIME_UNSAFE', JSON.stringify(extra));
    assert.match(String((JSON.parse(run.out[0] ?? '{}') as Record<string, unknown>).message), /grants/);
  }
  const closeArgv = ['--retired-key-id', 'ek-cli-fecho-r', '--seals-dir', world.sealsDir, '--receipts-dir', tmpDir('lasa-rec-'), '--key-id', world.key.keyId, '--key-source', `file:${world.key.keyPath}`, '--custodian', 'CUST-01', '--trust-keys', world.key.ring];
  const closeWith = (extra: readonly string[]) => runAsArtifact('close-key', file, closeArgv, { nodeOptions: [...base, ...extra] });
  for (const extra of [[`--allow-fs-write=${seals}`], ['--allow-fs-write=/'], ['--allow-fs-read=/'], [`--allow-fs-write=${outside}`]]) {
    const run = await closeWith(extra);
    assert.equal(codeOf(run), 'SIGN_RUNTIME_UNSAFE', `close-key ${JSON.stringify(extra)}`);
  }
  const closures = await closeWith([`--allow-fs-write=${path.join(seals, '_closures')}`, '--allow-fs-read=/home']);
  assert.notEqual(codeOf(closures), 'SIGN_RUNTIME_UNSAFE', `close-key: escrita só em _closures passa (a leitura ampla é limite declarado até a W5): ${closures.out.join('\n')}`);
});

test('confirmação da revisão da W4.6 (3): no artefato, cada grant é o próprio caminho real (existe e nenhum componente é link); a escrita é comparada com a raiz REAL de --seals-dir. Exceções que falham fechado: os caminhos fixos /proc/self/* e as raízes temporárias, e os .git da custódia, que podem não existir', async () => {
  const file = await custodiedCopy();
  const base = [...RUNBOOK_FLAGS, `--allow-fs-read=${path.dirname(file)}`];
  const outside = tmpDir('lasa-fora-');
  const holder = tmpDir('lasa-links-');
  const linkOut = path.join(holder, 'link-para-fora');
  fs.symlinkSync(outside, linkOut);
  fs.mkdirSync(path.join(outside, 'sub'));
  const refusedSign = async (extra: (seals: string) => string[], label: string, sealsArg?: (seals: string) => string): Promise<void> => {
    const world = cliWorld();
    const seals = fs.realpathSync(world.sealsDir);
    const argv = sealsArg ? world.argv({ 'seals-dir': sealsArg(seals) }) : world.argv();
    const run = await runAsArtifact('sign', file, argv, { typed: world.typed(), nodeOptions: [...base, ...extra(seals)] });
    assert.equal(run.code, 3, `${label}: ${run.err.join('\n')}`);
    assert.equal(codeOf(run), 'SIGN_RUNTIME_UNSAFE', label);
    assert.match(String((JSON.parse(run.out[0] ?? '{}') as Record<string, unknown>).message), /grants/, label);
  };
  await refusedSign(() => [`--allow-fs-read=${linkOut}`], 'leitura que é link para fora');
  await refusedSign(() => [`--allow-fs-read=${path.join(linkOut, 'sub')}`], 'leitura com um componente intermediário que é link');
  await refusedSign(() => [`--allow-fs-read=${path.join(outside, 'nao-existe')}`], 'leitura que não existe (fora das exceções)');
  await refusedSign((seals) => {
    fs.symlinkSync(outside, path.join(seals, 'fora'));
    return [`--allow-fs-write=${path.join(seals, 'fora')}`];
  }, 'escrita que, resolvida, cai fora de --seals-dir');
  await refusedSign((seals) => {
    const alias = path.join(holder, `apelido-${path.basename(seals)}`);
    fs.symlinkSync(seals, alias);
    return [`--allow-fs-write=${alias}`];
  }, 'escrita por um link para a própria pasta de manifestos');
  const gitLink = path.join(holder, 'repo');
  fs.mkdirSync(gitLink);
  fs.symlinkSync(outside, path.join(gitLink, '.git'));
  await refusedSign(() => [`--allow-fs-read=${path.join(gitLink, '.git')}`], '.git que existe e é link');
  // --seals-dir dado por um link: a comparação é entre caminhos REAIS (o grant do caminho real passa)
  const world = cliWorld();
  const seals = fs.realpathSync(world.sealsDir);
  const sealsAlias = path.join(holder, 'manifestos-apelido');
  fs.symlinkSync(seals, sealsAlias);
  const viaAlias = await runAsArtifact('sign', file, world.argv({ 'seals-dir': sealsAlias }), { typed: world.typed(), nodeOptions: [...base, `--allow-fs-write=${seals}`, `--allow-fs-read=${seals}`] });
  assert.notEqual(codeOf(viaAlias), 'SIGN_RUNTIME_UNSAFE', `--seals-dir por link, grant pelo caminho real: ${viaAlias.out.join('\n')} ${viaAlias.err.join('\n')}`);
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

test('decisão 3 em processo REAL: com a linha do runbook, a sondagem de fsync na raiz de --seals-dir vem logo depois do analisador: node que bloqueia fsync sob --permission ⇒ SIGN_RUNTIME_NO_FSYNC antes de ler qualquer entrada; node que permite ⇒ segue e só então recusa a entrada inexistente (SIGN_INPUT_UNREADABLE)', { timeout: LIMIT_MS }, async () => {
  const artifact = await built();
  const seals = tmpDir('lasa-manifestos-');
  const key = makeKeyFile();
  const missing = path.join(tmpDir('lasa-vazia-'), 'nao-existe.json');
  const args = ['sign', '--audit', AUD, '--package', missing, '--approval', missing, '--dossier', missing, '--seals-dir', seals, '--expect-seq', '1', '--first', '--key-id', key.keyId, '--key-source', `file:${key.keyPath}`, '--custodian', CUSTODIAN, '--trust-keys', key.ring];
  const line = [...RUNBOOK_FLAGS, `--allow-fs-read=${path.dirname(artifact.file)}`, ...PROC_GRANTS, `--allow-fs-read=${seals}`, `--allow-fs-write=${seals}`];
  const run = viaEnvI(line, artifact.file, args);
  assert.equal(run.status, 3, run.stderr);
  if (permissionFsync() === 'denied') {
    assert.match(run.stderr, /Código: SIGN_RUNTIME_NO_FSYNC/);
    assert.match(run.stderr, /bloqueia fsync sob --permission/);
  } else {
    assert.match(run.stderr, /Código: SIGN_INPUT_UNREADABLE/, 'a sonda passou e o fluxo seguiu até a primeira leitura');
  }
  assert.ok(!/12 primeiros caracteres|Frase-senha/.test(run.stderr), 'nem confirmação nem frase');
  assert.deepEqual(fs.readdirSync(seals), [], 'a sondagem não grava nada');
  // revisão independente da W4.6 (3): escrita fora de --seals-dir (aqui, a raiz inteira) ⇒ recusa antes da sondagem e de qualquer entrada
  const wide = viaEnvI([...line, '--allow-fs-write=/'], artifact.file, args);
  refusedBarrier(wide, '--allow-fs-write=/', /grants/);
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

/** Saídas da sonda do teste: 0 = fsync permitido; 7 = fsync NEGADO pelo modelo de permissões; qualquer outra coisa = a sonda quebrou. */
const PROBE_ALLOWED = 0;
const PROBE_DENIED = 7;
const PROBE_SCRIPT = `const fs = require('node:fs/promises');
(async () => {
  let probe;
  try {
    probe = await fs.open(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  } catch (error) {
    process.stderr.write('SONDA_OPEN ' + String(error && error.code) + ' ' + String(error && error.message) + '\\n');
    process.exit(9);
  }
  try {
    await probe.sync();
    process.exitCode = ${PROBE_ALLOWED};
  } catch (error) {
    process.stderr.write('SONDA_SYNC ' + String(error && error.code) + ' ' + String(error && error.message) + '\\n');
    process.exitCode = error && error.code === 'ERR_ACCESS_DENIED' ? ${PROBE_DENIED} : 8;
  } finally {
    await probe.close();
  }
})();
`;

/**
 * O node deste processo deixa `fsync` sob `--permission`? Desde o Node 24.22.0 o modelo de permissões BLOQUEIA `fsync`/`fdatasync`
 * (nodejs/node#65431); a linha 22 (CI e estação, decisão do manager) permite. A sonda usa a MESMA operação do `sign` (`FileHandle.sync()` numa pasta
 * aberta O_RDONLY|O_DIRECTORY), roda de um arquivo (não de `-e`) e distingue "negado" (`ERR_ACCESS_DENIED` no sync) de "quebrou" (qualquer outra
 * saída: o teste FALHA mostrando o que aconteceu).
 */
function permissionFsync(): 'allowed' | 'denied' {
  const dir = tmpDir('lasa-fsync-');
  const script = path.join(tmpDir('lasa-sonda-'), 'sonda-fsync.cjs');
  fs.writeFileSync(script, PROBE_SCRIPT);
  const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${path.dirname(script)}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, script, dir], { encoding: 'utf8', timeout: 30_000 });
  if (result.status === PROBE_ALLOWED) return 'allowed';
  if (result.status === PROBE_DENIED) return 'denied';
  return assert.fail(`a sonda de fsync sob --permission quebrou (${process.version}; status ${String(result.status)}, sinal ${String(result.signal)}): ${result.stderr}${result.stdout}`);
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
    const fsyncUnderPermission = permissionFsync();
    const run = await runInPty(['env', '-i', process.execPath, ...runbookGrants(layout), artifactFile, ...args], pkg.packageSha256.slice(0, CONFIRM_LENGTH), key.passphrase);
    for (const sentinel of key.sentinels) assert.ok(!run.screen.includes(sentinel), 'a frase (ou a chave) apareceu na tela');
    if (fsyncUnderPermission === 'denied') {
      // decisão 3: a sondagem antecipada recusa ANTES de ler as entradas, da confirmação, da custódia e da frase; nada gravado nem recibo
      assert.equal(run.code, 3, run.screen);
      assert.match(run.screen, /Código: SIGN_RUNTIME_NO_FSYNC/);
      assert.ok(!/12 primeiros caracteres|Frase-senha|Chave aberta/.test(run.screen), 'nem confirmação, nem frase, nem chave');
      assert.deepEqual(fs.readdirSync(layout.seals), [], 'nada gravado na pasta de manifestos');
      if (STRICT) assert.fail(`LINK_AUDIT_ARTIFACT_STRICT=1: o node ${process.version} bloqueia fsync sob --permission (nodejs/node#65431); a estação e o CI usam a linha 22 (notas da W4.6)`);
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
