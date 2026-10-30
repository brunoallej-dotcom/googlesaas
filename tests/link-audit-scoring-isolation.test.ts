import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.join(__dirname, '..');
const SCORING_DIR = path.join(ROOT, 'src', 'lib', 'link-audit', 'scoring');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.next' ? [] : walk(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const imports = (source: string): string[] => [...strip(source).matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
const files = walk(SCORING_DIR);

test('o motor é um módulo puro: só importa a si mesmo, zod, canonical e methodology', () => {
  assert.ok(files.length >= 20);
  for (const file of files) {
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier;
      const inside = typeof resolved === 'string' && resolved.startsWith(SCORING_DIR + path.sep);
      const allowedParent = resolved === path.join(ROOT, 'src', 'lib', 'link-audit', 'canonical') || resolved === path.join(ROOT, 'src', 'lib', 'link-audit', 'methodology');
      const zod = specifier === 'zod' && path.basename(file) === 'input.ts';
      const type = /import type /.test(fs.readFileSync(file, 'utf8')) && specifier.startsWith('../') && /(evidence)$/.test(specifier);
      assert.ok(inside || allowedParent || zod || type, `${path.relative(ROOT, file)} importa "${specifier}"`);
    }
  }
});

test('o motor não usa rede, disco, ambiente, processos, relógio, aleatoriedade nem avaliação dinâmica', () => {
  const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, 'fetch'],
    [/node:/, 'módulo node'],
    [/\brequire\s*\(/, 'require'],
    [/process\./, 'process'],
    [/\bDate\b/, 'Date (relógio/fuso)'],
    [/Math\.random/, 'aleatoriedade'],
    [/\beval\s*\(|new Function\s*\(/, 'avaliação dinâmica'],
    [/\bsetTimeout\b|\bsetInterval\b/, 'temporizador'],
    [/\bXMLHttpRequest\b|\bWebSocket\b/, 'cliente de rede'],
    [/\.env\b|dotenv/, 'ambiente'],
    [/\bconsole\./, 'console'],
  ];
  for (const file of files) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    for (const [pattern, label] of forbidden) assert.ok(!pattern.test(code), `${path.relative(ROOT, file)} usa ${label}`);
  }
});

test('independência: nada de Juiz, prospecção, banco, filas, PDF, Serper, coletor ou armazenamento no motor', () => {
  const words = /judge|juiz|battlefield|maestro|supabase|bullmq|ioredis|redis|serper|dataforseo|site-check|pdfkit|\/pdf\/|\/agents\/|\/queues\/|\/workers\/|collector|snapshot|url-safety|redact|runtime|link-audit-evidence/i;
  for (const file of files) {
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) assert.ok(!words.test(specifier), `${path.relative(ROOT, file)} importa "${specifier}"`);
  }
});

/**
 * Onda 6B: o módulo de decisões humanas consome SÓ o contrato de entrada (input.ts, versions.ts). O que CALCULA (engine,
 * agregação, régua, confiança…) continua sem nenhum consumidor até a Onda 6C.
 */
const DECISIONS_DIR = path.join(ROOT, 'src', 'lib', 'link-audit-decisions') + path.sep;
const DECISIONS_ALLOWED = new Set([path.join(SCORING_DIR, 'input'), path.join(SCORING_DIR, 'versions')]);

/**
 * Onda 6C (I2): o mapeador consome o CONTRATO de entrada (input, types, versions), a régua como DADOS (ruler: pesos e limites,
 * sem cálculo) e a aritmética de datas pura (dates). Nunca o que CALCULA: engine, aggregate, avaliadores, confiança, publicação.
 */
const SCORING_RUNS_DIR = path.join(ROOT, 'src', 'lib', 'link-audit-scoring-runs') + path.sep;
const SCORING_RUNS_ALLOWED = new Set([path.join(SCORING_DIR, 'input'), path.join(SCORING_DIR, 'versions'), path.join(SCORING_DIR, 'types'), path.join(SCORING_DIR, 'ruler'), path.join(SCORING_DIR, 'dates')]);

test('o motor que calcula ainda não está conectado: fora dele só decisões e o mapeador usam o CONTRATO (input, versions, types, ruler, dates); nem o barrel o importa', () => {
  const barrel = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'link-audit', 'index.ts'), 'utf8');
  assert.ok(!/scoring/.test(barrel), 'o barrel de link-audit não exporta o motor');
  const roots = ['src', 'scripts'].map((dir) => path.join(ROOT, dir));
  for (const file of roots.flatMap((dir) => walk(dir))) {
    if (file.startsWith(SCORING_DIR + path.sep)) continue;
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      const resolved = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
      if (file.startsWith(DECISIONS_DIR) && resolved !== null && (resolved === SCORING_DIR || resolved.startsWith(SCORING_DIR + path.sep))) {
        assert.ok(DECISIONS_ALLOWED.has(resolved), `${path.relative(ROOT, file)} importa "${specifier}": o módulo de decisões só pode usar o contrato (input, versions)`);
        continue;
      }
      if (file.startsWith(SCORING_RUNS_DIR) && resolved !== null && (resolved === SCORING_DIR || resolved.startsWith(SCORING_DIR + path.sep))) {
        assert.ok(SCORING_RUNS_ALLOWED.has(resolved), `${path.relative(ROOT, file)} importa "${specifier}": o mapeador só pode usar o contrato, a régua como dados e as datas`);
        continue;
      }
      assert.ok(resolved === null || !(resolved === SCORING_DIR || resolved.startsWith(SCORING_DIR + path.sep)), `${path.relative(ROOT, file)} importa o motor de pontuação`);
    }
  }
});

test('methodology.ts não depende do motor (o navegador continua alcançando só methodology.ts)', () => {
  const methodology = strip(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'link-audit', 'methodology.ts'), 'utf8'));
  assert.ok(!/scoring/.test(methodology));
  assert.deepEqual(imports(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'link-audit', 'methodology.ts'), 'utf8')), []);
});

test('o motor não tem gancho para pontos do cliente: nenhuma função pública aceita pontos como entrada', () => {
  const index = fs.readFileSync(path.join(SCORING_DIR, 'index.ts'), 'utf8');
  const engine = fs.readFileSync(path.join(SCORING_DIR, 'engine.ts'), 'utf8');
  assert.match(engine, /export function scoreAudit\(raw: unknown/);
  assert.match(engine, /export function verifyScoreResult\(resultRaw: unknown, inputRaw: unknown\)/);
  assert.ok(!/export function (?:setScore|importScore|fromPoints|withPoints)/.test(index + engine));
});
