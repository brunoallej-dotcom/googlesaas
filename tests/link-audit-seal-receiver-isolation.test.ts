import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * P9.3b — o receptor de manifestos `src/lib/seal-receiver/` é ISOLADO e, fora do adaptador, PURO (CLAUDE.md: módulos pequenos e isolados; spec
 * §5.7): lista fechada de arquivos e de imports por arquivo; disco, relógio, aleatoriedade, stdin e processo só em `node-adapters.ts`; NENHUM processo
 * filho (nem no adaptador); do resto do projeto, só o que a spec manda reaproveitar: o núcleo do canal da P9.2 (gramática, regras por arquivo,
 * lista, cadeias e fechos), o verificador v2 (núcleo `provenance-core`), a leitura da cadeia e o autoteste do `sign` (`sign-chain`), a criação
 * exclusiva compartilhada (`exclusive-write`) e a porta de disco da Fase 6. Nenhum consumidor no app; a entrada é só o script fino.
 */

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'src', 'lib', 'seal-receiver');
const ENTRY = path.join(ROOT, 'scripts', 'seal-receiver.ts');
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const importsOf = (source: string): string[] => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
  ];
};

const PORT = '../link-audit/fs-ops';
const VERIFIER = '../link-audit-evidence/provenance-core';
const SIGN_CHAIN = '../link-audit-attestation/sign-chain';
const EXCLUSIVE_WRITE = '../link-audit-attestation/exclusive-write';
const CHANNEL = (file: string): string => `../link-audit-seals-channel/${file}`;
/** Cada arquivo e o que ele pode importar. Arquivo novo, ou import novo, precisa de decisão (e de entrar aqui). */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  // as razões fixas do verificador e os motivos do S-11, do núcleo do canal (conjuntos fechados da saída pública)
  'codes.ts': new Set([CHANNEL('codes')]),
  'grammar.ts': new Set([]),
  'args.ts': new Set(['node:path', CHANNEL('paths')]),
  'ports.ts': new Set([PORT]),
  'input.ts': new Set(['node:crypto', './codes', './ports']),
  // a lista: o módulo da P9.2 (parser do arquivo, regra de ambiente), sem reimplementar
  'trust.ts': new Set(['node:crypto', PORT, CHANNEL('paths'), CHANNEL('trust-list'), './codes']),
  // S-06 a S-08 do canal (judgeSeal/judgeClosure) e o teto do S-05
  'candidate.ts': new Set([VERIFIER, CHANNEL('files'), CHANNEL('paths'), './codes', './grammar']),
  // raiz e subpasta pelas regras da criação exclusiva compartilhada com o sign
  'layout.ts': new Set(['node:path', PORT, EXCLUSIVE_WRITE, './codes', './grammar']),
  // o autoteste do sign (selfTestSeal sobre chainSnapshot) e, depois da gravação, o S-10 e o S-11 do canal
  'verify.ts': new Set([PORT, SIGN_CHAIN, VERIFIER, CHANNEL('chains'), CHANNEL('closures'), './candidate', './codes', './grammar', './layout', './trust']),
  'write.ts': new Set([PORT, EXCLUSIVE_WRITE, './codes', './grammar']),
  'put.ts': new Set(['./args', './candidate', './codes', './grammar', './input', './layout', './ports', './trust', './verify', './write']),
  'receiver.ts': new Set(['node:path', './args', './codes', './grammar', './ports', './put']),
  // o ÚNICO arquivo com disco, relógio, aleatoriedade, stdin e o processo; nenhum node:child_process
  'node-adapters.ts': new Set(['node:crypto', 'node:fs', 'node:fs/promises', PORT, '../link-audit/node-fs-ops', './args', './ports']),
  'index.ts': new Set(['./args', './codes', './grammar', './ports', './receiver']),
};

test('isolamento: lista fechada de arquivos do receptor de manifestos e de imports por arquivo', () => {
  const files = fs.readdirSync(DIR).sort();
  assert.deepEqual(files, Object.keys(ALLOWED).sort(), 'um arquivo novo no módulo precisa de decisão');
  for (const file of files) {
    const used = new Set(importsOf(fs.readFileSync(path.join(DIR, file), 'utf8')));
    const allowed = ALLOWED[file] ?? new Set<string>();
    for (const specifier of used) assert.ok(allowed.has(specifier), `${file} importa ${specifier}`);
  }
});

test('isolamento: nenhum processo filho, rede, shell nem avaliação dinâmica em lugar nenhum; fora do adaptador, nada de disco, relógio, aleatoriedade, stdin ou processo', () => {
  for (const file of fs.readdirSync(DIR)) {
    const code = strip(fs.readFileSync(path.join(DIR, file), 'utf8'));
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|worker_threads|vm|os|child_process)\b|XMLHttpRequest|WebSocket|\bexecFile\b|\bspawn\b|\bfork\s*\(/.test(code), `${file}: sem rede nem processo filho`);
    assert.ok(!/\beval\s*\(|new Function\b|\bFunction\s*\(|shell:/.test(code), `${file}: sem shell nem avaliação dinâmica`);
    assert.ok(!/process\.env/.test(code), `${file}: o ambiente chega pela invocação`);
    assert.ok(!/publishExclusive|snapshot-store/.test(code), `${file}: nunca o publishExclusive do armazenamento (ignora o fsync da pasta, CE-3)`);
    if (file === 'node-adapters.ts') continue;
    assert.ok(!/node:fs\b|fsPromises|nodeFsOps/.test(code), `${file}: disco só pela porta`);
    assert.ok(!/Date\.now|new Date\s*\(|Math\.random|randomBytes|performance\.now|process\.hrtime|setTimeout|process\.stdin|process\.(?:exit|kill|argv|cwd|umask|permission)\b/.test(code), `${file}: sem relógio, aleatoriedade, stdin nem processo`);
  }
});

test('isolamento: o adaptador cria com O_EXCL sem seguir link, grava o modo explícito por chmod do temporário (o fchmod é desligado sob --permission) e não usa o umask; a entrada fina só liga o adaptador ao receptor; nenhum consumidor no app', () => {
  const adapter = strip(fs.readFileSync(path.join(DIR, 'node-adapters.ts'), 'utf8'));
  assert.match(adapter, /fsp\.open\(target, 'wx', mode\)/, 'temporário exclusivo (wx = O_CREAT | O_EXCL, não segue link)');
  assert.match(adapter, /await handle\.writeFile\(data, 'utf8'\);\n\s*await fsp\.chmod\(target, mode\);\n\s*await handle\.sync\(\);/, 'escrita, modo explícito e só então o fsync');
  assert.match(adapter, /O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW/, 'a trava de defesa é exclusiva e não segue link');
  assert.ok(!/process\.umask|\.fchmod|handle\.chmod/.test(adapter), 'o umask é do wrapper e da entrada; nada de fchmod');
  assert.deepEqual(new Set(importsOf(fs.readFileSync(ENTRY, 'utf8'))), new Set(['./receiver-artifact-zod', '../src/lib/seal-receiver/node-adapters', '../src/lib/seal-receiver/receiver', '../src/lib/seal-receiver/codes']));
  const consumers = [...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })].filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.startsWith(path.join('lib', 'seal-receiver')));
  for (const rel of consumers) assert.ok(!/seal-receiver/.test(strip(fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8'))), `${rel} não importa o receptor de manifestos`);
});

/** Arquivo `.ts` de um import relativo; `null` para pacote externo ou módulo `node:`. */
function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  const found = [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate));
  return found ?? assert.fail(`import local não resolvido: "${specifier}" em ${path.relative(ROOT, from)}`);
}

test('grafo de FONTES a partir da entrada: nada de processo filho, rede, armazenamento de snapshots, fachada do verificador, leitor de evidências nem a cadeia de rede (evidence → url-safety); de fora, só módulos node da lista do artefato e o zod', () => {
  const seen = new Set<string>();
  const external = new Set<string>();
  const pending = [ENTRY];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(fs.readFileSync(file, 'utf8'))) {
      const local = resolveLocal(file, specifier);
      if (local === null) external.add(specifier);
      else pending.push(local);
    }
  }
  const files = [...seen].map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  for (const forbidden of [/snapshot-store\.ts$/, /link-audit-evidence\/provenance\.ts$/, /link-audit\/evidence\.ts$/, /url-safety\.ts$/, /link-audit-evidence\/(?:reader|store|scoring-basis)\.ts$/, /deploy-receiver\//, /sign-(?:cli|key|run|receipts|runtime|terminal|args)\.ts$/]) {
    assert.ok(!files.some((file) => forbidden.test(file)), `a entrada alcança ${files.find((file) => forbidden.test(file))}`);
  }
  for (const required of ['src/lib/link-audit-evidence/provenance-core.ts', 'src/lib/link-audit-attestation/exclusive-write.ts', 'src/lib/link-audit-attestation/sign-chain.ts', 'src/lib/link-audit-seals-channel/closures.ts']) assert.ok(files.includes(required), `${required} no grafo`);
  assert.deepEqual([...external].sort(), ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'zod'], 'de fora do repositório');
});
