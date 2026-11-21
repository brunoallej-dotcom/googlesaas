import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Isolamento do módulo de observabilidade da Fase 6 (spec de observabilidade §5.3; G1.a entrega só o `operatorRef`, PG-L01).
 * Puro como o resto da Fase 6: HMAC (node:crypto) e zod, nada de disco, rede, log, relógio, aleatoriedade nem chave embutida; o ambiente
 * só entra por parâmetro. Não importa outro módulo da Fase 6 (a política de chave é a mesma, reescrita aqui, sem acoplar ao de origem).
 */
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-observability');

const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const imports = (text: string): string[] => [...code(text).matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
const files = (): string[] => fs.readdirSync(LIB).filter((name) => name.endsWith('.ts')).sort();

test('PG-L01 isolamento: o módulo importa só node:crypto, zod e os próprios arquivos', () => {
  assert.deepEqual(files(), ['index.ts', 'operator-ref.ts']);
  const external = new Set(files().flatMap((name) => imports(fs.readFileSync(path.join(LIB, name), 'utf8'))).filter((spec) => !spec.startsWith('./')));
  assert.deepEqual([...external].sort(), ['node:crypto', 'zod']);
});

test('PG-L01 isolamento: sem disco, rede, log, relógio, aleatoriedade nem chave embutida; ambiente só como padrão do parâmetro', () => {
  const text = files().map((name) => code(fs.readFileSync(path.join(LIB, name), 'utf8'))).join('\n');
  for (const [pattern, label] of [
    [/node:(?:fs|http|https|net|dns|child_process|os|worker_threads)|fetch\s*\(|XMLHttpRequest|WebSocket/, 'disco ou rede'],
    [/console\.|process\.stdout|process\.stderr|StructuredLogger|logger/, 'log'],
    [/Date\.now|new Date\(|performance\.now/, 'relógio'],
    [/Math\.random|randomBytes|randomUUID|getRandomValues/, 'aleatoriedade'],
    [/[0-9a-f]{64}/i, 'material de chave embutido'],
  ] as const) assert.ok(!pattern.test(text), `o módulo usa ${label}`);
  assert.equal((text.match(/process\.env/g) ?? []).length, 1, 'process.env só como valor padrão do parâmetro');
  assert.match(text, /operatorRefSourceFromEnv\(otherKeys: ReadonlyArray<OtherKeyFingerprint>, env: Readonly<Record<string, string \| undefined>> = process\.env\)/, 'a lista das outras chaves é obrigatória, sem padrão');
  assert.ok(!/GMN_LINK_AUDIT_(?!LOG_KEY\b)[A-Z_]+/.test(text), 'o módulo não cita variáveis de outras chaves da Fase 6 (isolamento da chave de origem)');
});
