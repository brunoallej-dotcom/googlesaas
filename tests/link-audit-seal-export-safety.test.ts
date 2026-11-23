import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { isForbiddenOutPath } from '../src/lib/link-audit-attestation/export-run';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { registerCleanup, SENTINEL, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { legacyReplica } from './helpers/link-audit-mapper-real-basis';
import { at, exportArgs, HOUR, jsonOf, makeAudit, makeReadOnly, newOut, NOW, readJsonFile, runCli, T_COLLECT, treeHash } from './helpers/link-audit-seal-export-fixtures';

/* Dados 100% FICTÍCIOS. P1 W2 — `export`: somente leitura (IA-02), sem rede (IA-05), lixo na pasta (IA-13) e dados pessoais (IA-14). */
registerCleanup();

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'link-audit-seal.ts');
const WRITE_OPS: ReadonlySet<string> = new Set(['mkdir', 'writeExclusive', 'link', 'unlink', 'chmod', 'syncDirectory']);

/** FsOps que falha (e registra) em QUALQUER escrita e registra as leituras: prova que a injeção chegou aos leitores. */
function recordingFs(writes: string[], reads: string[], allowWrites = false): FsOps {
  return new Proxy(nodeFsOps, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (WRITE_OPS.has(prop)) {
          writes.push(`${prop}:${String(args[0])}`);
          if (!allowWrites) return Promise.reject(new Error(`ESCRITA PROIBIDA (${prop})`));
        } else reads.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/* -------------------------------------------------------------------- IA-02 (ii): somente leitura */

test('IA-02 (1): o FsOps dos leitores é um proxy que falha em qualquer escrita; o export lê por ele e nunca escreve (com --out, sem --out e com --seals-dir)', async () => {
  const audit = await makeAudit();
  const seals = tmpDir('lase-seals-');
  for (const extra of [[], ['--seals-dir', seals]]) {
    const writes: string[] = [];
    const reads: string[] = [];
    const outWrites: string[] = [];
    const out = newOut();
    const run = await runCli(exportArgs(audit, extra, out), NOW, { fs: recordingFs(writes, reads), outFs: recordingFs(outWrites, [], true) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(writes, [], 'nenhuma escrita pelo FsOps dos leitores');
    assert.ok(reads.includes('readFile') && reads.includes('readdir') && reads.includes('lstat'), `o proxy foi de fato usado: ${[...new Set(reads)].join(',')}`);
    assert.deepEqual(outWrites, [`writeExclusive:${path.join(fs.realpathSync(path.dirname(out)), 'pacote.json')}`], 'a ÚNICA escrita é o --out, por criação exclusiva');
  }
  const writes: string[] = [];
  const run = await runCli(exportArgs(audit, ['--show-summary'], null), NOW, { fs: recordingFs(writes, []), outFs: recordingFs(writes, []) });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(writes, [], 'sem --out, nenhuma escrita em lugar nenhum');
});

test('IA-02 (2): árvore em 0444/0555: o export funciona (só leitura)', async () => {
  const audit = await makeAudit();
  const restore = makeReadOnly(audit.base);
  try {
    assert.equal(fs.statSync(path.join(audit.dir, 'c0001.capture.json')).mode & 0o777, 0o444);
    assert.equal(fs.statSync(audit.dir).mode & 0o777, 0o555);
    const out = newOut();
    const run = await runCli(exportArgs(audit, [], out));
    assert.equal(run.code, 0, run.stderr);
    assert.ok(fs.existsSync(out));
  } finally {
    restore();
  }
});

test('IA-02 (3): hash da árvore (conteúdo, modo, tamanho, mtime) idêntico antes e depois: sucesso, recusa e --seals-dir', async () => {
  const audit = await makeAudit([{}, { collectedAt: at(T_COLLECT, HOUR).toISOString() }]);
  const before = treeHash(audit.base);
  assert.equal((await runCli(exportArgs(audit, [], newOut()), at(T_COLLECT, 2 * HOUR))).code, 0);
  assert.equal((await runCli(exportArgs(audit, ['--seals-dir', tmpDir()], newOut()), at(T_COLLECT, 2 * HOUR))).code, 0);
  assert.equal((await runCli(exportArgs(audit, [], newOut()), at(T_COLLECT, 40 * HOUR))).code, 3, 'recusa de janela');
  assert.equal((await runCli(exportArgs(audit, [], path.join(audit.dir, 'p.json')))).code, 3, 'recusa de --out');
  assert.equal(treeHash(audit.base), before);
});

test('IA-02 (4): --out dentro da pasta de evidências (direto, na auditoria ou por link simbólico) ⇒ EXPORT_OUT_UNSAFE; --out existente ou sem pasta ⇒ idem', async () => {
  const audit = await makeAudit();
  const before = treeHash(audit.base);
  const elsewhere = tmpDir('lase-alias-');
  const alias = path.join(elsewhere, 'atalho');
  fs.symlinkSync(audit.dir, alias);
  const baseAlias = path.join(elsewhere, 'base-atalho');
  fs.symlinkSync(audit.base, baseAlias);
  const existing = newOut();
  fs.writeFileSync(existing, 'ANTERIOR');
  for (const out of [path.join(audit.base, 'p.json'), path.join(audit.dir, 'p.json'), path.join(alias, 'p.json'), path.join(baseAlias, 'p.json'), audit.base, existing, path.join(tmpDir(), 'nao-existe', 'p.json')]) {
    const run = await runCli(exportArgs(audit, ['--json'], out));
    assert.equal(run.code, 3, out);
    assert.equal(jsonOf(run).code, 'EXPORT_OUT_UNSAFE', out);
  }
  assert.equal(fs.readFileSync(existing, 'utf8'), 'ANTERIOR', 'nada é sobrescrito');
  assert.equal(treeHash(audit.base), before, 'nada foi criado na pasta de evidências');
  // pela pasta de evidências apontada por link simbólico, o --out real dentro dela também é recusado
  const run = await runCli([...exportArgs({ ...audit, base: baseAlias }, ['--json'], path.join(audit.base, 'q.json'))]);
  assert.equal(jsonOf(run).code, 'EXPORT_OUT_UNSAFE');
});

test('IA-02 (4): --out em QUALQUER lugar da árvore do projeto (public/, src/, raiz, subpasta, por link simbólico ou com a raiz dada por link) ⇒ EXPORT_OUT_UNSAFE', async () => {
  const audit = await makeAudit();
  const project = tmpDir('lase-proj-');
  for (const dir of ['public', 'src', path.join('docs', 'sub')]) fs.mkdirSync(path.join(project, dir), { recursive: true });
  const alias = path.join(tmpDir('lase-alias-'), 'projeto');
  fs.symlinkSync(project, alias);
  fs.symlinkSync(tmpDir('lase-fora-'), path.join(project, 'public', 'fora')); // link em public/ para fora: servido pelo Next mesmo assim
  const cases: ReadonlyArray<readonly [string, string]> = [
    [path.join(project, 'public', 'fora', 'p.json'), project],
    [path.join(project, 'public', 'p.json'), project],
    [path.join(project, 'src', 'p.json'), project],
    [path.join(project, 'p.json'), project],
    [path.join(project, 'docs', 'sub', 'p.json'), project],
    [path.join(alias, 'public', 'p.json'), project],
    [path.join(project, 'public', 'p.json'), alias],
  ];
  for (const [out, projectRoot] of cases) {
    const run = await runCli(exportArgs(audit, ['--json'], out), NOW, { projectRoot });
    assert.equal(run.code, 3, `${out} (raiz ${projectRoot})`);
    assert.equal(jsonOf(run).code, 'EXPORT_OUT_UNSAFE', out);
    assert.equal(fs.existsSync(out), false);
  }
  assert.equal((await runCli(exportArgs(audit, [], newOut()), NOW, { projectRoot: project })).code, 0, 'fora do projeto continua aceito');
});

test('IA-02 (4) TOCTOU: a pasta do --out passa a apontar para a pasta de evidências (ou para o projeto) entre a conferência e a gravação ⇒ EXPORT_OUT_UNSAFE, nada gravado', async () => {
  const audit = await makeAudit();
  const project = tmpDir('lase-proj-');
  for (const swapTo of [audit.dir, project]) {
    const before = treeHash(audit.base);
    const out = newOut();
    const parent = path.dirname(out);
    let parentCalls = 0;
    const writes: string[] = [];
    const swapping: FsOps = {
      ...nodeFsOps,
      realpath: async (target) => (target === parent && ++parentCalls > 1 ? swapTo : nodeFsOps.realpath(target)),
      writeExclusive: async (target, data, mode) => {
        writes.push(target);
        return nodeFsOps.writeExclusive(target, data, mode);
      },
    };
    const run = await runCli(exportArgs(audit, ['--json'], out), NOW, { outFs: swapping, projectRoot: project });
    assert.equal(run.code, 3);
    assert.equal(jsonOf(run).code, 'EXPORT_OUT_UNSAFE');
    assert.ok(parentCalls >= 2, 'a pasta foi resolvida de novo logo antes de gravar');
    assert.deepEqual(writes, [], 'nenhuma escrita');
    assert.equal(treeHash(audit.base), before);
  }
});

test('IA-02 (4) unidade: a regra de destino proibido recusa o próprio diretório, qualquer descendente e variação de caixa; aceita irmão de prefixo parecido', () => {
  const root = path.join(path.sep, 'dados', 'evidencias');
  assert.equal(isForbiddenOutPath(root, [root]), true);
  assert.equal(isForbiddenOutPath(path.join(root, 'a', 'p.json'), [root]), true);
  assert.equal(isForbiddenOutPath(path.join(path.sep, 'DADOS', 'Evidencias', 'p.json'), [root]), true);
  assert.equal(isForbiddenOutPath(path.join(path.sep, 'dados', 'evidencias-copia', 'p.json'), [root]), false);
  assert.equal(isForbiddenOutPath(path.join(path.sep, 'outro', 'p.json'), [root, path.join(path.sep, 'projeto')]), false);
  assert.equal(isForbiddenOutPath(path.join(path.sep, 'projeto', 'public', 'p.json'), [root, path.join(path.sep, 'projeto')]), true);
});

test('IA-02 (4): falha DEPOIS de criar o --out (sem espaço) ou corrida (EEXIST) ⇒ EXPORT_OUT_WRITE_FAILED (código 3), avisa do arquivo parcial e nunca apaga', async () => {
  const audit = await makeAudit();
  for (const errno of ['ENOSPC', 'EEXIST']) {
    const out = newOut();
    const failing: FsOps = {
      ...nodeFsOps,
      writeExclusive: async (target) => {
        fs.writeFileSync(target, '{"parcial":'); // a criação aconteceu; a gravação falhou no meio
        throw Object.assign(new Error('falha simulada'), { code: errno });
      },
    };
    for (const json of [true, false]) {
      if (fs.existsSync(out)) fs.rmSync(out);
      const run = await runCli(exportArgs(audit, json ? ['--json'] : [], out), NOW, { outFs: failing });
      assert.equal(run.code, 3, errno);
      const message = json ? String(jsonOf(run).message) : run.stderr;
      if (json) assert.equal(jsonOf(run).code, 'EXPORT_OUT_WRITE_FAILED');
      else assert.match(run.stderr, /RECUSADO \(EXPORT_OUT_WRITE_FAILED\)/);
      assert.match(message, /parcial/);
      assert.ok(!message.includes(out) && !message.includes(path.dirname(out)), 'sem caminho de disco na mensagem');
      assert.equal(fs.readFileSync(out, 'utf8'), '{"parcial":', 'o export nunca apaga');
    }
  }
});

/* -------------------------------------------------------------------- IA-05 (v): sem rede */

type Restorer = () => void;
function trap(target: object, key: string, label: string, fired: string[]): Restorer {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: () => {
      fired.push(label);
      throw new Error(`rede proibida: ${label}`);
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete (target as Record<string, unknown>)[key];
  };
}

function installNetworkTraps(fired: string[]): Restorer {
  const restorers: Restorer[] = [
    trap(globalThis, 'fetch', 'fetch', fired),
    trap(net.Socket.prototype, 'connect', 'net.Socket#connect', fired),
    trap(net, 'connect', 'net.connect', fired),
    trap(net, 'createConnection', 'net.createConnection', fired),
    trap(tls, 'connect', 'tls.connect', fired),
    trap(http, 'request', 'http.request', fired),
    trap(http, 'get', 'http.get', fired),
    trap(https, 'request', 'https.request', fired),
    trap(https, 'get', 'https.get', fired),
    ...['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny'].map((key) => trap(dns, key, `dns.${key}`, fired)),
    ...['lookup', 'resolve', 'resolve4', 'resolve6'].map((key) => trap(dns.promises, key, `dns.promises.${key}`, fired)),
  ];
  return () => restorers.reverse().forEach((restore) => restore());
}

test('IA-05: com fetch, net.Socket#connect, dns.* e http(s).request trocados por armadilhas, o export completa (versionado, legado, --seals-dir, recusa) e nenhuma dispara', async () => {
  const audit = await makeAudit();
  const { base: legacyBase } = await legacyReplica();
  const seals = tmpDir('lase-seals-');
  const fired: string[] = [];
  const restore = installNetworkTraps(fired);
  const codes: number[] = [];
  try {
    assert.throws(() => (globalThis.fetch as unknown as () => void)(), /rede proibida/, 'a armadilha está ativa');
    fired.length = 0;
    codes.push((await runCli(exportArgs(audit, ['--seals-dir', seals], newOut()))).code);
    codes.push((await runCli(exportArgs(audit, ['--json', '--show-summary'], null))).code);
    codes.push((await runCli(['export', '--evidence-dir', legacyBase, '--audit', 'auditoria-teste-0001', '--out', newOut()])).code);
    codes.push((await runCli(exportArgs(audit, [], newOut()), at(T_COLLECT, 48 * HOUR))).code);
  } finally {
    restore();
  }
  assert.deepEqual(codes, [0, 0, 0, 3]);
  assert.deepEqual(fired, []);
});

/** Todas as formas de dependência: `import/export ... from`, `import 'x'`, `import('x')` e `require('x')`. */
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const importsOf = (source: string): string[] => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
  ];
};
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  throw new Error(`import não resolvido: ${specifier} em ${path.relative(ROOT, from)}`);
}
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importsOf(fs.readFileSync(file, 'utf8'))) {
      const local = resolveLocal(file, specifier);
      if (local === null) packages.add(specifier);
      else queue.push(local);
    }
  }
  return { files, packages };
}

test('IA-05 (estático): o grafo de imports do CLI não inclui Supabase, Serper, Redis, ioredis, bullmq, runtime de coleta, rede HTTP, processos nem leitura de arquivo de ambiente', () => {
  const { files, packages } = importGraph(CLI);
  const relative = [...files].map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  assert.ok(relative.includes('src/lib/link-audit-attestation/export-run.ts') && relative.includes('src/lib/link-audit-evidence/scoring-basis.ts'), 'o grafo foi de fato percorrido');
  for (const name of relative) assert.ok(!/supabase|serper|redis|bullmq|queue|worker|link-audit-runtime|site-provider|site-check|link-audit-decisions|link-audit-ledger/i.test(name), `o grafo alcança ${name}`);
  for (const specifier of packages) {
    assert.ok(!/^(?:@supabase\/|ioredis$|bullmq$|redis$|@next\/|next(?:\/|$)|react|dot.?env|undici|axios|node-fetch|(?:node:)?(?:http|https|http2|child_process|worker_threads|cluster|dgram)$)/.test(specifier), `pacote proibido no grafo: ${specifier}`);
  }
  const envFileReads = new RegExp(['loadEnvConfig', '@next/' + 'env', 'dot' + 'env', `['"\`]\\.${'env'}`].join('|'));
  for (const file of files) assert.ok(!envFileReads.test(strip(fs.readFileSync(file, 'utf8'))), `${path.relative(ROOT, file)} lê arquivo de ambiente`);
  // os arquivos NOVOS da W2 nem sequer olham o ambiente do processo (redact.ts, já existente, só usa process.env em memória como padrão). Exceção
  // única (W5.2b, spec §5.7, decisão do manager): o CLI lê SÓ a variável da trava de homologação do `export --simulated`, uma vez
  const processEnv = new RegExp(`process\\.${'env'}`);
  const withoutLock = (code: string): string => code.replace(/process\.env\.GMN_LINK_AUDIT_HOMOLOGATION\b/, '');
  for (const name of ['scripts/link-audit-seal.ts', 'src/lib/link-audit-attestation/export.ts', 'src/lib/link-audit-attestation/export-run.ts']) {
    const code = strip(fs.readFileSync(path.join(ROOT, name), 'utf8'));
    assert.ok(!processEnv.test(name === 'scripts/link-audit-seal.ts' ? withoutLock(code) : code), `${name} lê o ambiente`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|child_process|\beval\s*\(|new Function\s*\(/.test(strip(fs.readFileSync(path.join(ROOT, name), 'utf8'))), `${name} usa rede, processo ou avaliação dinâmica`);
  }
});

/* -------------------------------------------------------------------- IA-13: lixo na pasta (processo filho com SIGKILL) */

const CHILD = path.join(ROOT, 'tests', 'helpers', 'link-audit-seal-export-child.ts');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const LIMIT_MS = 30_000;
const hasMkfifo = ((): boolean => {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function runChild(scenario: string, extra: readonly string[] = []): { timedOut: boolean; status: number | null; line: Record<string, unknown> | null; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-seal-junk-'));
  try {
    const run = spawnSync(process.execPath, ['--require', REGISTER, CHILD, dir, scenario, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: LIMIT_MS, killSignal: 'SIGKILL', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as unknown as NodeJS.ProcessEnv });
    const timedOut = run.error !== undefined && (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const last = run.stdout?.trim().split('\n').pop() ?? '';
    return { timedOut, status: run.status, line: last.startsWith('{') ? (JSON.parse(last) as Record<string, unknown>) : null, stderr: run.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const JUNK: ReadonlyArray<readonly [string, string, string]> = [
  ['fifo-capture', 'FIFO com nome de captura (c0002.capture.json)', 'EXPORT_INTEGRITY_NOT_OK'],
  ['fifo-report', 'FIFO com nome de relatório (c0001.report-r0002.json)', 'EXPORT_INTEGRITY_NOT_OK'],
  ['symlink-capture', 'captura trocada por link simbólico (não é seguido)', 'EXPORT_INTEGRITY_NOT_OK'],
  ['symlink-dir', 'pasta da auditoria é link simbólico', 'EXPORT_NOT_FOUND'],
  ['oversize-capture', 'captura acima do limite de 6 MiB', 'EXPORT_INTEGRITY_NOT_OK'],
  ['fifo-legacy', 'FIFO no lugar de um arquivo do layout legado', 'EXPORT_INTEGRITY_NOT_OK'],
];

for (const [scenario, label, code] of JUNK) {
  test(`IA-13: ${label} ⇒ ${code}, sem travar e sem gravar --out`, { skip: !hasMkfifo && 'mkfifo indisponível' }, async () => {
    const extra = scenario === 'fifo-legacy' ? [(await legacyReplica()).dir] : [];
    const r = runChild(scenario, extra);
    assert.equal(r.timedOut, false, `${scenario}: o filho travou`);
    assert.equal(r.status, 0, r.stderr.slice(0, 400));
    assert.ok(r.line, 'o filho devolveu o resultado');
    assert.equal(r.line.crashed, undefined, `o filho quebrou: ${String(r.line.crashed)}`);
    assert.equal(r.line.exit, 3);
    assert.equal(r.line.code, code);
    assert.equal(r.line.wrote, false);
    assert.ok(Number(r.line.ms) < 10_000, `lento demais: ${String(r.line.ms)} ms`);
  });
}

test('IA-13: FIFO com nome FORA do conjunto (lixo.fifo) não é aberto nem atestado: o export conclui sem travar (o leitor só lê os nomes do conjunto, §7.2)', { skip: !hasMkfifo && 'mkfifo indisponível' }, () => {
  const r = runChild('fifo-unlisted');
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0, r.stderr.slice(0, 400));
  assert.equal(r.line?.exit, 0);
  assert.equal(r.line?.wrote, true);
});

/* -------------------------------------------------------------------- IA-14: dados pessoais (RS-21) */

test('IA-14: stdout/stderr do export (humano e --json, sucesso e recusa, versionado e legado) sem nome, cidade, telefone, endereço, URL, corpo, e-mail do operador nem caminho de disco', async () => {
  const audit = await makeAudit();
  const { base: legacyBase } = await legacyReplica();
  const out = newOut();
  const runs = [
    await runCli(exportArgs(audit, [], out)),
    await runCli(exportArgs(audit, ['--json'], newOut())),
    await runCli(exportArgs(audit, ['--seals-dir', tmpDir()], newOut())),
    await runCli(exportArgs(audit, [], newOut()), at(T_COLLECT, 30 * HOUR)),
    await runCli(exportArgs(audit, ['--json'], newOut()), at(T_COLLECT, 30 * HOUR)),
    await runCli(exportArgs(audit, ['--json'], path.join(audit.dir, 'p.json'))),
    await runCli(['export', '--evidence-dir', legacyBase, '--audit', 'auditoria-teste-0001', '--out', newOut()]),
    await runCli(['export', '--evidence-dir', path.join(audit.base, 'nao-existe'), '--audit', audit.auditId, '--out', newOut()]),
  ];
  const forbidden = ['Padaria Exemplo', 'Cidade Exemplo', 'Rua Fictícia', '99999-0000', '3000-9999', 'padaria-exemplo.example', 'legado.example', 'http://', 'https://', 'wa.me', SENTINEL, 'ana@empresa.com', 'empresa.com', os.tmpdir(), audit.base, legacyBase, out, path.dirname(out)];
  for (const [index, run] of runs.entries()) {
    const text = `${run.stdout}\n${run.stderr}`;
    for (const value of forbidden) assert.ok(!text.includes(value), `execução ${index}: a saída contém "${value}"`);
  }
  assert.equal(runs[1] && (jsonOf(runs[1]) as Record<string, unknown>).company, undefined, 'sem --show-summary o JSON não traz a empresa');
  // o ARQUIVO do pacote sempre contém o resumo (spec §5.3); só nome/cidade/UF e hashes
  const pkg = readJsonFile<{ summary: { company: unknown } }>(out);
  assert.deepEqual(pkg.summary.company, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' });
  const fileText = fs.readFileSync(out, 'utf8');
  for (const value of ['Rua Fictícia', '99999-0000', 'padaria-exemplo.example', 'http', SENTINEL, 'ana@empresa.com', os.tmpdir()]) assert.ok(!fileText.includes(value), `o pacote contém "${value}"`);
  // com --show-summary, e só com ele, a saída humana mostra nome/cidade/UF
  const shown = await runCli(exportArgs(audit, ['--show-summary'], newOut()));
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /Empresa: Padaria Exemplo · Cidade Exemplo\/GO/);
});
