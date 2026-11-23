import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * P9.3a — o receptor de deploy `src/lib/deploy-receiver/` é ISOLADO e, fora do adaptador, PURO (CLAUDE.md: módulos pequenos e isolados; spec
 * §5.6): lista fechada de arquivos e de imports por arquivo; disco, processo filho, relógio, aleatoriedade e stdin só em `node-adapters.ts`; do
 * resto do projeto, só o módulo da lista de confiança da P9.2 (sem reimplementar). Nenhum consumidor no app; a entrada é só o script fino.
 */

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'src', 'lib', 'deploy-receiver');
const ENTRY = path.join(ROOT, 'scripts', 'deploy-receiver.ts');
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

const TRUST_LIST = '../link-audit-seals-channel/trust-list';
const CHANNEL_PATHS = '../link-audit-seals-channel/paths';
/** Cada arquivo e o que ele pode importar. Arquivo novo, ou import novo, precisa de decisão (e de entrar aqui). */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  'codes.ts': new Set([]),
  'grammar.ts': new Set([CHANNEL_PATHS]),
  'args.ts': new Set(['node:path', './grammar']),
  'host-vars.ts': new Set(['./args', './codes', './grammar', './supabase']),
  'supabase.ts': new Set(['node:crypto']),
  'ports.ts': new Set([]),
  'input.ts': new Set(['./codes', './ports']),
  'staging.ts': new Set(['node:path', './codes', './ports']),
  'upload.ts': new Set(['node:crypto', 'node:path', './args', './codes', './grammar', './input', './ports', './staging']),
  // a lista de confiança: o módulo da P9.2 (parser do arquivo, regra de ambiente e transição), sem reimplementar
  'trust.ts': new Set(['node:crypto', 'node:path', TRUST_LIST, './codes', './grammar', './input', './ports']),
  'docker.ts': new Set(['zod', './codes', './ports']),
  'bundle.ts': new Set(['node:crypto', 'zod', './codes', './docker', './grammar', './ports']),
  'converge.ts': new Set(['zod', './codes', './docker', './ports']),
  'postdeploy.ts': new Set(['zod', './codes', './converge', './docker', './grammar', './ports']),
  'stack-files.ts': new Set(['node:crypto', 'node:path', './args', './codes', './grammar', './ports']),
  'deploy.ts': new Set(['node:path', './stack-files', './args', './bundle', './codes', './converge', './docker', './grammar', './host-vars', './ports', './postdeploy', './staging', './trust']),
  'receiver.ts': new Set(['node:path', './args', './codes', './deploy', './grammar', './ports', './staging', './upload']),
  // o ÚNICO arquivo com disco, processo filho (execFile, sem shell), relógio, aleatoriedade e stdin
  'node-adapters.ts': new Set(['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', './args', './ports']),
  'index.ts': new Set(['./args', './codes', './grammar', './host-vars', './ports', './receiver']),
};

test('isolamento: lista fechada de arquivos do receptor de deploy e de imports por arquivo', () => {
  const files = fs.readdirSync(DIR).sort();
  assert.deepEqual(files, Object.keys(ALLOWED).sort(), 'um arquivo novo no módulo precisa de decisão');
  for (const file of files) {
    const used = new Set(importsOf(fs.readFileSync(path.join(DIR, file), 'utf8')));
    const allowed = ALLOWED[file] ?? new Set<string>();
    for (const specifier of used) assert.ok(allowed.has(specifier), `${file} importa ${specifier}`);
  }
});

test('isolamento: fora do adaptador, nada de disco, processo filho, rede, ambiente, relógio, aleatoriedade, shell ou avaliação dinâmica', () => {
  for (const file of fs.readdirSync(DIR)) {
    const code = strip(fs.readFileSync(path.join(DIR, file), 'utf8'));
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|worker_threads|vm|os)\b|XMLHttpRequest|WebSocket/.test(code), `${file}: sem rede`);
    assert.ok(!/\beval\s*\(|new Function\b|\bFunction\s*\(|shell:\s*true|\bexecSync\b|\bspawnSync\b|\bspawn\s*\(|\.exec\s*\(\s*['"`]/.test(code), `${file}: sem shell nem avaliação dinâmica`);
    assert.ok(!/process\.env/.test(code), `${file}: o ambiente chega pela invocação`);
    if (file === 'node-adapters.ts') continue;
    assert.ok(!/node:fs\b|node:child_process\b|fsPromises/.test(code), `${file}: disco e processo só pelo adaptador`);
    assert.ok(!/Date\.now|new Date\s*\(|Math\.random|performance\.now|process\.hrtime|setTimeout|process\.stdin|process\.(?:exit|kill|argv|cwd)\b/.test(code), `${file}: sem relógio, aleatoriedade, stdin nem processo`);
  }
});

test('isolamento: no adaptador, só execFile com shell: false; nenhum consumidor no app; a entrada fina só liga o adaptador ao receptor', () => {
  const adapter = strip(fs.readFileSync(path.join(DIR, 'node-adapters.ts'), 'utf8'));
  assert.match(adapter, /import \{ execFile \} from 'node:child_process'/);
  assert.match(adapter, /shell: false/);
  assert.ok(!/(?<![.\w])exec\s*\(|\bspawn\b|\bfork\b/.test(adapter.replace(/execFile/g, '')), 'só execFile');
  assert.match(adapter, /O_EXCL \| O_NOFOLLOW/, 'arquivos novos com O_EXCL e sem seguir link');
  assert.deepEqual(new Set(importsOf(fs.readFileSync(ENTRY, 'utf8'))), new Set(['./receiver-artifact-zod', '../src/lib/deploy-receiver/node-adapters', '../src/lib/deploy-receiver/receiver', '../src/lib/deploy-receiver/codes']));
  const consumers = [...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })].filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.startsWith(path.join('lib', 'deploy-receiver')));
  for (const rel of consumers) assert.ok(!/deploy-receiver/.test(strip(fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8'))), `${rel} não importa o receptor`);
});
