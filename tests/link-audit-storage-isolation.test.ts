import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Isolamento do módulo NEUTRO de armazenamento (Onda 6C, I0). Ele guarda a mecânica de selo, leitura estrita, gravação atômica
 * e recibos; não pode conhecer decisões, evidências, o motor, a rede, o ambiente nem o relógio, e só os consumidores
 * declarados abaixo podem usá-lo (pelo índice público).
 */
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-storage');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.next' ? [] : walk(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** Enxerga import/export estáticos, `import()` dinâmico e `require()`: um consumidor não pode escapar da lista usando-os. */
const imports = (source: string): string[] => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? ''),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? ''),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? ''),
  ];
};
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
const libFiles = walk(LIB);

/** Consumidores autorizados do módulo neutro. Acrescentar um exige revisão deliberada deste teste. */
const CONSUMERS: readonly string[] = ['src/lib/link-audit-decisions/', 'src/lib/link-audit-scoring-runs/results-store.ts', 'src/lib/link-audit-scoring-runs/results-types.ts']; // Onda 6C (I4): os resultados reutilizam o protocolo de arquivos e recibos

test('o módulo tem exatamente os arquivos esperados (qualquer arquivo novo exige revisão deliberada)', () => {
  assert.deepEqual(libFiles.map((f) => path.relative(LIB, f)).sort(), ['files.ts', 'index.ts', 'receipts.ts']);
});

test('imports: só o selo canônico, o mecanismo único de gravação e o próprio módulo — nunca decisões, evidências, motor, coletor ou bibliotecas externas', () => {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    'files.ts': ['node:path', '../link-audit/canonical', '../link-audit/snapshot-store'],
    'receipts.ts': ['node:crypto', 'node:path', '../link-audit/snapshot-store', './files'],
    'index.ts': ['./files', './receipts'],
  };
  for (const file of libFiles) {
    const name = path.basename(file);
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      assert.ok((allowed[name] ?? []).includes(specifier), `${rel(file)} importa "${specifier}"`);
    }
  }
});

test('o módulo não usa rede, ambiente, relógio, aleatoriedade fora do nome do temporário, console, avaliação dinâmica nem disco fora do FsOps', () => {
  const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, 'fetch'],
    [/node:(?:http|https|http2|dns|net|tls|dgram|child_process|fs|worker_threads|vm)\b|fsPromises/, 'módulo de rede/processo/disco'],
    [/process\.env|loadEnvConfig|@next\/env|dotenv|\.env\b/, 'ambiente'],
    [/Date\.now\s*\(|new Date\s*\(|\bDate\b\s*\(|Math\.random/, 'relógio ou aleatoriedade implícitos'],
    [/\bconsole\./, 'console'],
    [/\beval\s*\(|new Function\s*\(/, 'avaliação dinâmica'],
    [/XMLHttpRequest|WebSocket/, 'cliente de rede'],
    [/Math\.round|toFixed\s*\(|parseFloat\s*\(/, 'cálculo de pontuação'],
    [/supabase|redis|serper|dataforseo|bullmq/i, 'serviço externo'],
  ];
  for (const file of libFiles) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    for (const [pattern, label] of forbidden) assert.ok(!pattern.test(code), `${rel(file)} usa ${label}`);
  }
});

test('só grava pelo mecanismo único (publishExclusive) e SOMENTE de forma atômica; nenhuma API de alteração ou exclusão; nenhum arquivo é apagado, renomeado ou reescrito', () => {
  const receipts = strip(fs.readFileSync(path.join(LIB, 'receipts.ts'), 'utf8'));
  assert.ok(/publishExclusive\(/.test(receipts) && /atomicOnly\(/.test(receipts));
  for (const file of libFiles) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    assert.ok(!/writeFile|appendFile|createWriteStream|\.rename\(|\.unlink\(|\.rm\(|\.rmdir\(|\.truncate\(|\.chmod\(|\.copyFile\(/.test(code), `${rel(file)} altera/apaga arquivos diretamente`);
    assert.ok(!/export\s+(?:async\s+)?function\s+(?:delete|remove|update|edit|overwrite|replace|purge|clear(?!StorageFatal))\w*/i.test(code), `${rel(file)} exporta operação destrutiva`);
  }
});

test('só os consumidores declarados importam o módulo, e SOMENTE pelo índice público (nunca pelos arquivos internos)', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))].filter((file) => !file.startsWith(LIB + path.sep));
  assert.ok(files.length > 100, 'a varredura deve cobrir o código existente');
  const seen = new Set<string>();
  for (const file of files) {
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      const resolved = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
      if (resolved === null) continue;
      if (resolved !== LIB && !resolved.startsWith(LIB + path.sep)) continue;
      seen.add(rel(file));
      assert.ok(CONSUMERS.some((prefix) => rel(file).startsWith(prefix)), `${rel(file)} não é um consumidor autorizado do módulo de armazenamento`);
      assert.equal(resolved, LIB, `${rel(file)} importa um arquivo interno ("${specifier}"); use o índice público`);
    }
  }
  assert.ok([...seen].some((f) => f.endsWith('link-audit-decisions/files.ts')) && [...seen].some((f) => f.endsWith('link-audit-decisions/anchor-store.ts')), 'a 6B consome o módulo');
});

test('o navegador, as páginas, os componentes e as rotas NÃO importam o módulo de armazenamento', () => {
  for (const dir of ['src/components', 'src/app']) {
    for (const file of walk(path.join(ROOT, dir))) {
      for (const specifier of imports(fs.readFileSync(file, 'utf8'))) assert.ok(!/link-audit-storage/.test(specifier), `${rel(file)} importa o armazenamento ("${specifier}")`);
    }
  }
});

test('o módulo neutro não importa a 6B nem o contrário circular: nenhum arquivo de `link-audit-storage` cita decisões, âncoras de decisão ou evidências', () => {
  for (const file of libFiles) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    assert.ok(!/link-audit-decisions|link-audit-evidence|DecisionEntry|DECISION_|scoring\//.test(code), `${rel(file)} conhece um consumidor`);
  }
});

test('o script de testes do package.json inclui TODOS os testes do módulo de armazenamento', () => {
  const script = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: { test: string } }).scripts.test;
  const onDisk = fs.readdirSync(path.join(ROOT, 'tests')).filter((name) => /^link-audit-storage-.*\.test\.ts$/.test(name));
  assert.deepEqual(onDisk.sort(), ['link-audit-storage-conformance.test.ts', 'link-audit-storage-differential.test.ts', 'link-audit-storage-files.test.ts', 'link-audit-storage-isolation.test.ts', 'link-audit-storage-receipts.test.ts']);
  for (const name of onDisk) assert.ok(script.includes(`tests/${name}`), `${name} não está no script de testes`);
});

test('o detector de imports enxerga import() dinâmico e require() (senão um consumidor escaparia da lista usando-os)', () => {
  assert.deepEqual(imports("import { a } from '../x';\nconst m = await import('@/lib/link-audit-storage');\nconst r = require('./y');\n// import('../comentario')"), ['../x', '@/lib/link-audit-storage', './y']);
  assert.deepEqual(imports("export * from './z';"), ['./z']);
});
