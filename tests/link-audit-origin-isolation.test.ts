import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Isolamento do módulo de PROVA DE ORIGEM (remediação do MAJOR-1). Ele guarda a única forma de comprovar que uma pendente foi gravada pelo
 * servidor; por isso é pequeno, puro e fechado: só HMAC (node:crypto), zod e o selo canônico. Nada de disco, rede, log, relógio,
 * aleatoriedade nem chave embutida. Quem pode importá-lo é uma lista fechada.
 */
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-origin');

const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const imports = (text: string): string[] => [...code(text).matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

test('o módulo é UM arquivo e importa só node:crypto, zod e o selo canônico', () => {
  assert.deepEqual(fs.readdirSync(LIB), ['index.ts']);
  assert.deepEqual([...new Set(imports(fs.readFileSync(path.join(LIB, 'index.ts'), 'utf8')))].sort(), ['../link-audit/canonical', 'node:crypto', 'zod']);
});

test('puro: sem disco, rede, log, relógio, aleatoriedade, Math.random nem chave embutida; o ambiente só entra por parâmetro (padrão process.env)', () => {
  const text = code(fs.readFileSync(path.join(LIB, 'index.ts'), 'utf8'));
  for (const [pattern, label] of [
    [/node:(?:fs|http|https|net|dns|child_process|os|worker_threads)|fetch\s*\(|XMLHttpRequest|WebSocket/, 'disco ou rede'],
    [/console\.|process\.stdout|process\.stderr|logger|debug\(/, 'log'],
    [/Date\.now|new Date\(|performance\.now/, 'relógio'],
    [/Math\.random|randomBytes|randomUUID|getRandomValues/, 'aleatoriedade'],
    [/createHmac\(\s*['"][^'"]+['"]\s*,\s*['"`][^'"`]{4,}['"`]/, 'chave embutida no HMAC (literal como chave)'],
  ] as const) assert.ok(!pattern.test(text), `o módulo usa ${label}`);
  assert.equal((text.match(/process\.env/g) ?? []).length, 1, 'process.env só como valor padrão do parâmetro de originConfigFromEnv');
  assert.match(text, /originConfigFromEnv\(env: Readonly<Record<string, string \| undefined>> = process\.env, now\?/);
  // nunca uma etiqueta ou chave entra numa mensagem de erro/retorno
  assert.ok(!/throw new Error\([^)]*(secret|tag|kid)/i.test(text.replace(/chave de origem/g, '')), 'mensagens de erro não citam material de chave');
});

test('só consumidores declarados importam o módulo de origem', () => {
  const allowed = new Set([
    'src/lib/link-audit-decisions/types.ts',
    // Livro de cabeças (Q3): chave EXCLUSIVA, mesma mecânica de HMAC com finalidade própria
    'src/lib/link-audit-ledger/types.ts',
    'src/lib/link-audit-ledger/model.ts',
    'src/lib/link-audit-ledger/config.ts',
    'src/lib/link-audit-ledger/service.ts',
    'src/lib/link-audit-decisions/store.ts',
    'src/lib/link-audit-decisions/service.ts',
    'src/lib/link-audit-scoring-runs/results-types.ts',
    'src/lib/link-audit-scoring-runs/results-store.ts',
    'src/lib/link-audit-scoring-runs/results.ts',
    'src/app/api/link-audit/decisions/shared.ts',
    'src/app/api/link-audit/scoring/shared.ts',
  ]);
  const seen = new Set<string>();
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    if (file.startsWith(LIB + path.sep)) continue;
    const imported = imports(fs.readFileSync(file, 'utf8')).filter((spec) => /link-audit-origin/.test(spec));
    if (imported.length === 0) continue;
    seen.add(rel(file));
    assert.ok(allowed.has(rel(file)), `${rel(file)} importa o módulo de origem sem estar na lista`);
  }
  assert.deepEqual([...seen].sort(), [...allowed].sort(), 'todos os consumidores declarados usam o módulo');
  // o navegador nunca importa nem cita a chave
  for (const dir of ['src/components', 'src/app/auditoria-por-link']) {
    for (const file of walk(path.join(ROOT, dir))) assert.ok(!/GMN_LINK_AUDIT_ORIGIN_KEY|link-audit-origin/.test(fs.readFileSync(file, 'utf8')), `${rel(file)} (navegador) cita a chave ou o módulo de origem`);
  }
});

test('a chave de origem não aparece em nenhum arquivo versionado além do módulo, das rotas, dos testes, da documentação e do harness (nunca com valor)', () => {
  const holders: string[] = [];
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) if (/GMN_LINK_AUDIT_ORIGIN_KEY/.test(fs.readFileSync(file, 'utf8'))) holders.push(rel(file));
  assert.deepEqual(holders.sort(), ['src/lib/link-audit-origin/index.ts', 'scripts/browser/harness.cjs'].sort().filter((name) => holders.includes(name)));
});
