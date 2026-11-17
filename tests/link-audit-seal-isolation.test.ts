import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computePackageSha256, evidenceToProveFromBasis } from '../src/lib/link-audit-attestation';

/* P1 W1 — o núcleo de atestação é PURO: lista fechada de arquivos e de imports, sem rede, disco, ambiente, relógio nem aleatoriedade. */
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-attestation');
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const importsOf = (source: string): string[] => [...strip(source).matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
const FILES = ['index.ts', 'package-hash.ts', 'schemas.ts'];
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  'index.ts': new Set(['../link-audit-evidence/evidence-to-prove', './package-hash', './schemas']),
  'package-hash.ts': new Set(['../link-audit/canonical', './schemas']),
  'schemas.ts': new Set(['zod', '../link-audit-evidence/types']),
};

test('lista exata de arquivos do módulo (arquivo novo exige decisão e revisão deste teste)', () => {
  assert.deepEqual(fs.readdirSync(LIB).sort(), FILES);
});

test('cada arquivo importa só a sua lista fechada (nunca o leitor, o armazenamento, Supabase, Redis, Serper, Next, React nem rede)', () => {
  for (const name of FILES) for (const specifier of importsOf(fs.readFileSync(path.join(LIB, name), 'utf8'))) assert.ok(ALLOWED[name]?.has(specifier), `${name} importa "${specifier}" fora da lista`);
});

test('sem rede, disco, ambiente, relógio, aleatoriedade, console, temporizadores, avaliação dinâmica nem estado global', () => {
  const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, 'fetch'],
    [/node:/, 'módulo node'],
    [/\brequire\s*\(/, 'require'],
    [/process\./, 'process'],
    [/\bDate\b/, 'Date'],
    [/Math\.random|randomUUID|getRandomValues/, 'aleatoriedade'],
    [/\beval\s*\(|new Function\s*\(/, 'avaliação dinâmica'],
    [/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|queueMicrotask/, 'temporizador'],
    [/\.env\b|dotenv|loadEnvConfig/, 'ambiente'],
    [/\bconsole\./, 'console'],
    [/writeFile|appendFile|\.mkdir\s*\(|\.unlink\s*\(|\.rename\s*\(/, 'escrita'],
    [/\bglobalThis\b|\bwindow\b|\bdocument\b|localStorage/, 'estado global/navegador'],
  ];
  for (const name of FILES) {
    const code = strip(fs.readFileSync(path.join(LIB, name), 'utf8'));
    for (const [pattern, label] of forbidden) assert.ok(!pattern.test(code), `${name} usa ${label}`);
  }
});

test('consumidores: nada em src/ ou scripts/ importa o módulo ainda (o CLI chega nas ondas W2 e W4)', () => {
  const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    if (file.startsWith(LIB + path.sep)) continue;
    assert.ok(!/link-audit-attestation/.test(strip(fs.readFileSync(file, 'utf8'))), `${path.relative(ROOT, file)} importa o módulo de atestação`);
  }
});

test('o único consumidor do arquivo evidence-to-prove fora da pasta de evidências é a prévia e a atestação (lista fechada)', () => {
  const evidenceRoot = path.join(ROOT, 'src', 'lib', 'link-audit-evidence');
  const importers = fs.readdirSync(path.join(ROOT, 'src', 'lib'), { recursive: true, encoding: 'utf8' })
    .filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.startsWith('link-audit-evidence'))
    .filter((rel) => importsOf(fs.readFileSync(path.join(ROOT, 'src', 'lib', rel), 'utf8')).some((s) => /link-audit-evidence\/evidence-to-prove$/.test(s)))
    .sort();
  assert.deepEqual(importers, ['link-audit-attestation/index.ts', 'link-audit-scoring-runs/preview.ts']);
  assert.ok(fs.existsSync(path.join(evidenceRoot, 'evidence-to-prove.ts')));
});

test('DINÂMICO: com armadilhas em fetch, relógio, aleatoriedade e ambiente, as funções rodam iguais e nenhuma dispara', () => {
  const body = { entries: [{ ref: 'capture:c0001', contentSha256: 'a'.repeat(64), legacy: false }] };
  const run = (): string => JSON.stringify([evidenceToProveFromBasis({ evidences: body.entries }), (() => { try { return computePackageSha256({ lixo: true }); } catch (error) { return (error as Error).name; } })()]);
  const before = run();
  const originals = { fetch: globalThis.fetch, now: Date.now, random: Math.random };
  const fired: string[] = [];
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: () => { fired.push('fetch'); throw new Error('proibido'); } });
  Date.now = () => { fired.push('Date.now'); throw new Error('proibido'); };
  Math.random = () => { fired.push('Math.random'); throw new Error('proibido'); };
  try {
    assert.equal(run(), before);
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originals.fetch });
    Date.now = originals.now;
    Math.random = originals.random;
  }
  assert.deepEqual(fired, []);
});
