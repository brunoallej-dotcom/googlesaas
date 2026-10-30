import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Onda 6C, I1 — isolamento da base de pontuação. O leitor (`scoring-basis.ts`), a derivação de URL (`derive-url.ts`) e a
 * extração do layout legado (`legacy.ts`) são SOMENTE DE SERVIDOR e só podem ser importados de dentro do próprio módulo
 * `src/lib/link-audit-evidence/`. Nenhuma rota, página, componente ou script os alcança no I1; uma rota futura (I3) exige
 * decisão e um teste próprio. Lista fechada.
 */
const ROOT = path.join(__dirname, '..');
const EVIDENCE = path.join(ROOT, 'src', 'lib', 'link-audit-evidence');
const NEW_FILES = ['scoring-basis.ts', 'derive-url.ts', 'legacy.ts'];

const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === 'node_modules' || entry.name === '.next' ? [] : walk(path.join(dir, entry.name))) : /\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) ? [path.join(dir, entry.name)] : []))
    : [];
/** import/export estáticos, `import()` dinâmico e `require()`: um consumidor não escapa da lista usando-os. */
const imports = (source: string): string[] => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
  ];
};
const resolveImport = (from: string, specifier: string): string | null => {
  const base = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return base;
};

test('só o próprio módulo de evidências importa scoring-basis, derive-url e legacy (rotas, páginas, componentes e scripts não os alcançam)', () => {
  const targets = new Set(NEW_FILES.map((name) => path.join(EVIDENCE, name)));
  const importers: Record<string, string[]> = {};
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveImport(file, specifier);
      if (resolved && targets.has(resolved)) (importers[path.relative(ROOT, resolved)] ??= []).push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(importers, {
    'src/lib/link-audit-evidence/derive-url.ts': ['src/lib/link-audit-evidence/scoring-basis.ts'],
    'src/lib/link-audit-evidence/legacy.ts': ['src/lib/link-audit-evidence/reader.ts', 'src/lib/link-audit-evidence/scoring-basis.ts'],
    // Onda 6C (I2): o mapeador é o único consumidor externo, e SÓ de tipos (apagados na compilação; verificado abaixo)
    'src/lib/link-audit-evidence/scoring-basis.ts': ['src/lib/link-audit-scoring-runs/assemble.ts', 'src/lib/link-audit-scoring-runs/types.ts'],
  });
  for (const importer of importers['src/lib/link-audit-evidence/scoring-basis.ts'] ?? []) {
    const code = strip(fs.readFileSync(path.join(ROOT, importer), 'utf8'));
    const statements = [...code.matchAll(/(?:^|\n)\s*import\s+(type\s+)?[^;]*?from\s+['"][^'"]*scoring-basis['"]/g)];
    assert.ok(statements.length > 0 && statements.every((match) => match[1] !== undefined), `${importer} deve importar scoring-basis apenas como tipo`);
  }
});

test('o índice público do módulo NÃO exporta a base de pontuação (o índice é importado pelo navegador para tipos)', () => {
  const index = strip(fs.readFileSync(path.join(EVIDENCE, 'index.ts'), 'utf8'));
  assert.ok(!/scoring-basis|derive-url|legacy|createScoringBasisReader|readScoringBasis/.test(index));
  assert.ok(!/export\s+\*/.test(index));
});

test('o detector de imports enxerga import() dinâmico e require() (senão uma rota escaparia da lista)', () => {
  assert.deepEqual(imports("import { a } from '../x';\nconst m = await import('@/lib/link-audit-evidence/scoring-basis');\nconst r = require('./y');\n// import('../comentario')"), ['../x', '@/lib/link-audit-evidence/scoring-basis', './y']);
});

test('os três arquivos não usam rede, ambiente, relógio, aleatório, console, escrita em disco nem o motor de pontuação', () => {
  for (const name of NEW_FILES) {
    const code = strip(fs.readFileSync(path.join(EVIDENCE, name), 'utf8'));
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|child_process|fs)\b|fsPromises|XMLHttpRequest|WebSocket/.test(code), `${name} usa rede ou disco direto`);
    assert.ok(!/process\.env|loadEnvConfig|@next\/env|\.env\.local/.test(code), `${name} lê o ambiente`);
    assert.ok(!/Date\.now\s*\(|new Date\s*\(|Math\.random|performance\.now/.test(code), `${name} usa relógio ou aleatório`);
    assert.ok(!/\bconsole\./.test(code), `${name} escreve em console (poderia registrar dados da fonte)`);
    assert.ok(!/writeExclusive|publishExclusive|\.link\s*\(|\.unlink\s*\(|\.mkdir\s*\(|\.chmod\s*\(|writeFile|appendFile|\.rename\s*\(|withLock/.test(code), `${name} escreve`);
    for (const specifier of imports(code)) {
      assert.ok(!/link-audit\/scoring|link-audit-decisions|link-audit-storage|supabase|redis|bullmq|serper-reviews|site-check|url-safety/i.test(specifier), `${name} importa "${specifier}"`);
    }
  }
});

test('o leitor de pontuação só usa FsOps para LER (lstat, readdir, readFile) e o armazenamento de evidências para verificar', () => {
  const code = strip(fs.readFileSync(path.join(EVIDENCE, 'scoring-basis.ts'), 'utf8'));
  assert.deepEqual([...new Set([...code.matchAll(/\bops\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1]))].sort(), ['lstat']);
  assert.ok(/verifyAudit\(/.test(code) && /readCapture\(/.test(code) && /readReport\(/.test(code), 'a base só nasce de arquivos verificados');
  assert.ok(/INTEGRITY_FAILED/.test(code) && /NO_EVIDENCE/.test(code));
  const legacy = strip(fs.readFileSync(path.join(EVIDENCE, 'legacy.ts'), 'utf8'));
  assert.deepEqual([...new Set([...legacy.matchAll(/\bops\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1]))].sort(), ['readFile']);
});

test('o navegador não referencia a base de pontuação nem tem como recebê-la (nenhum arquivo de UI cita seus nomes)', () => {
  for (const file of [...walk(path.join(ROOT, 'src', 'components')), ...walk(path.join(ROOT, 'src', 'app'))]) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    assert.ok(!/scoring-basis|ScoringBasis|readScoringBasis|derive-url|deriveWebsite|EXCLUDED_M4A/.test(code), `${path.relative(ROOT, file)} referencia a base de pontuação`);
  }
});
