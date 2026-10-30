import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { OperatorRecord } from '../src/lib/link-audit/scoring';
import { assembleScoringInput } from '../src/lib/link-audit-scoring-runs/assemble';
import { deriveAuditIdAlias, verifyAuditIdAlias } from '../src/lib/link-audit-scoring-runs/audit-id-alias';
import { c2Judgement, makeBasis, NOW, richProfile, s4NotApplicable, unavailable, website } from './helpers/link-audit-mapper-fixtures';

/*
 * Onda 6C, I2 — o mapeador é PURO e independente de rede, banco, relógio global, Redis, Serper e Next.js. Duas provas:
 * (1) estática: lista exata de arquivos, de imports e de construções proibidas; ninguém ainda o consome;
 * (2) dinâmica: com armadilhas em fetch, sockets, DNS, http(s), fs, relógio, aleatoriedade, ambiente e timers, o mapeador roda
 *     do mesmo jeito (e nenhuma armadilha dispara).
 */
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-scoring-runs');
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === 'node_modules' || entry.name === '.next' ? [] : walk(path.join(dir, entry.name))) : /\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) ? [path.join(dir, entry.name)] : []))
    : [];
const importsOf = (source: string): Array<{ specifier: string; typeOnly: boolean }> => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => ({ specifier: m[2] ?? '', typeOnly: Boolean(m[1]) })),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => ({ specifier: m[1] ?? '', typeOnly: false })),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => ({ specifier: m[1] ?? '', typeOnly: false })),
  ];
};

const FILES = ['assemble.ts', 'audit-id-alias.ts', 'criteria-sources.ts', 'index.ts', 'types.ts'];
/** Lista fechada por arquivo: importa só irmãos, o selo canônico, a metodologia (tipo), o contrato do motor e tipos da base. */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  'assemble.ts': new Set(['../link-audit/canonical', '../link-audit/scoring/dates', '../link-audit/scoring/input', '../link-audit/scoring/ruler', '../link-audit/scoring/types', '../link-audit/scoring/versions', '../link-audit-evidence/scoring-basis', './audit-id-alias', './criteria-sources', './types']),
  'audit-id-alias.ts': new Set(['../link-audit/canonical']),
  'criteria-sources.ts': new Set(['../link-audit/methodology', '../link-audit/scoring/input', '../link-audit/scoring/ruler', '../link-audit/scoring/types']),
  'index.ts': new Set(['./assemble', './audit-id-alias', './criteria-sources', './types']),
  'types.ts': new Set(['../link-audit/methodology', '../link-audit/scoring/input', '../link-audit/scoring/types', '../link-audit-evidence/scoring-basis', './audit-id-alias', './criteria-sources']),
};

test('lista exata de arquivos do módulo (qualquer arquivo novo exige decisão e revisão deste teste)', () => {
  assert.deepEqual(fs.readdirSync(LIB).sort(), FILES);
});

test('cada arquivo importa só a sua lista fechada; o motor que calcula, o leitor, o armazenamento, decisões, Next, React, banco, filas e rede ficam de fora', () => {
  for (const name of FILES) {
    for (const { specifier, typeOnly } of importsOf(fs.readFileSync(path.join(LIB, name), 'utf8'))) {
      assert.ok(ALLOWED[name]?.has(specifier), `${name} importa "${specifier}" fora da lista`);
      if (specifier.includes('scoring-basis') || specifier.includes('methodology')) assert.ok(typeOnly, `${name}: "${specifier}" só como tipo`);
      assert.ok(!/engine|aggregate|eval-|confidence|publication|integrity|results|nap-compare|link-audit-decisions|link-audit-storage|reader|store|supabase|redis|bullmq|serper|dataforseo|site-check|url-safety|next|react|pdf|collector|runtime/i.test(specifier.replace('../link-audit-evidence/scoring-basis', '')), `${name} importa "${specifier}"`);
    }
  }
});

test('nenhum consumidor no I2: nada em src/ ou scripts/ importa o mapeador (a prévia, a simulação e as rotas são os incrementos seguintes)', () => {
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    if (file.startsWith(LIB + path.sep)) continue;
    for (const { specifier } of importsOf(fs.readFileSync(file, 'utf8'))) {
      const resolved = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
      assert.ok(resolved === null || !(resolved === LIB || resolved.startsWith(LIB + path.sep)), `${path.relative(ROOT, file)} importa o mapeador ("${specifier}")`);
    }
  }
});

test('sem rede, disco, ambiente, relógio, aleatoriedade, console, temporizadores, avaliação dinâmica nem escrita', () => {
  const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, 'fetch'],
    [/node:/, 'módulo node'],
    [/\brequire\s*\(/, 'require'],
    [/process\./, 'process'],
    [/\bDate\b/, 'Date (relógio/fuso)'],
    [/\bperformance\b/, 'performance'],
    [/Math\.random|crypto\.random|randomUUID|getRandomValues/, 'aleatoriedade'],
    [/\beval\s*\(|new Function\s*\(/, 'avaliação dinâmica'],
    [/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|queueMicrotask/, 'temporizador'],
    [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/, 'cliente de rede'],
    [/\.env\b|dotenv|loadEnvConfig/, 'ambiente'],
    [/\bconsole\./, 'console'],
    [/writeFile|appendFile|\.mkdir\s*\(|\.unlink\s*\(|\.rename\s*\(|\.link\s*\(|withLock|publishExclusive|writeExclusive/, 'escrita'],
    [/\bglobalThis\b|\bwindow\b|\bdocument\b|localStorage/, 'estado global/navegador'],
  ];
  for (const name of FILES) {
    const code = strip(fs.readFileSync(path.join(LIB, name), 'utf8'));
    for (const [pattern, label] of forbidden) assert.ok(!pattern.test(code), `${name} usa ${label}`);
  }
});

test('M-4a: nenhum arquivo do mapeador lê a parte informativa da base nem nomeia nota/contagem de avaliações; "reviews" só aparece como marca de exclusão', () => {
  for (const name of FILES) {
    const code = strip(fs.readFileSync(path.join(LIB, name), 'utf8'));
    assert.ok(!/\binformational\b/.test(code), `${name} referencia a parte informativa`);
    assert.ok(!/ratingCount|ratingShown|reviewCount|latestReviewDate|\.rating\b/.test(code), `${name} nomeia dado de avaliações`);
    const reviewsMentions = [...code.matchAll(/\breviews\b/g)].length;
    assert.ok(name === 'types.ts' ? reviewsMentions === 1 : reviewsMentions === 0 || name === 'assemble.ts', `${name}: menções a reviews inesperadas (${reviewsMentions})`);
  }
  const assemble = strip(fs.readFileSync(path.join(LIB, 'assemble.ts'), 'utf8'));
  for (const match of assemble.matchAll(/\breviews\b/g)) {
    const around = assemble.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 40);
    assert.ok(/excluded|EXCLUDED_M4A/.test(around), `menção a reviews fora da marca de exclusão: ${around}`);
  }
});

test('o mapeador nunca produz pontos: nenhuma função exportada devolve, recebe ou calcula pontuação', () => {
  const code = ['assemble.ts', 'criteria-sources.ts', 'audit-id-alias.ts', 'index.ts'].map((name) => strip(fs.readFileSync(path.join(LIB, name), 'utf8'))).join('\n');
  assert.ok(!/scoreAudit|verifyScoreResult|computeIndex|aggregate\(|buildPublication|obtainedHalfPoints|coveragePercent|evaluatedHalfPoints\s*[+=]/.test(code));
  const index = strip(fs.readFileSync(path.join(LIB, 'index.ts'), 'utf8'));
  assert.ok(!/export\s+\*/.test(index));
});

/* ---------------------------------------------------------------- dinâmica: armadilhas */
type Trap = { name: string; calls: number };
function withTraps<T>(action: () => T): { value: T; traps: Trap[] } {
  const traps: Trap[] = [];
  const restores: Array<() => void> = [];
  const trap = (name: string, install: (fire: () => never) => () => void): void => {
    const record: Trap = { name, calls: 0 };
    traps.push(record);
    restores.push(install(() => { record.calls += 1; throw new Error(`acesso externo proibido: ${name}`); }));
  };
  const patch = <O extends object, K extends keyof O>(owner: O, key: K, name: string): void =>
    trap(name, (fire) => {
      const original = owner[key];
      Object.defineProperty(owner, key, { configurable: true, writable: true, value: fire });
      return () => Object.defineProperty(owner, key, { configurable: true, writable: true, value: original });
    });
  patch(globalThis as { fetch: unknown }, 'fetch', 'fetch');
  patch(net.Socket.prototype as never, 'connect', 'net.Socket.connect');
  patch(net as never, 'connect', 'net.connect');
  patch(net as never, 'createConnection', 'net.createConnection');
  patch(dns as never, 'lookup', 'dns.lookup');
  patch(http as never, 'request', 'http.request');
  patch(http as never, 'get', 'http.get');
  patch(https as never, 'request', 'https.request');
  patch(https as never, 'get', 'https.get');
  for (const method of ['readFileSync', 'readFile', 'writeFileSync', 'writeFile', 'appendFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'mkdirSync', 'unlinkSync', 'rmSync']) patch(fs as never, method as never, `fs.${method}`);
  patch(fs.promises as never, 'readFile' as never, 'fs.promises.readFile');
  patch(fs.promises as never, 'writeFile' as never, 'fs.promises.writeFile');
  patch(Date as never, 'now' as never, 'Date.now');
  patch(Math as never, 'random' as never, 'Math.random');
  patch(globalThis as never, 'setTimeout' as never, 'setTimeout');
  patch(globalThis as never, 'setInterval' as never, 'setInterval');
  patch(performance as never, 'now' as never, 'performance.now');
  trap('process.env', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'env') as PropertyDescriptor;
    Object.defineProperty(process, 'env', { configurable: true, get: () => { traps.find((t) => t.name === 'process.env')!.calls += 1; throw new Error('acesso externo proibido: process.env'); } });
    return () => Object.defineProperty(process, 'env', original);
  });
  try {
    return { value: action(), traps };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

test('DINÂMICO: com armadilhas em rede, DNS, http(s), sockets, fs, relógio, aleatoriedade, temporizadores e ambiente, o mapeador roda igual e nenhuma dispara', () => {
  const records: OperatorRecord[] = [c2Judgement(), s4NotApplicable()];
  const scenarios = [
    () => assembleScoringInput(makeBasis(), records, { now: NOW }),
    () => assembleScoringInput(makeBasis({ auditId: 'tuvaplast_20261022_maps01' }), [], { now: NOW }),
    () => assembleScoringInput(makeBasis({ profile: unavailable('NOT_LOCATED') }), [], { now: NOW }),
    () => assembleScoringInput(makeBasis({ profile: richProfile({ website: website({ derived: 'http://evil.example/p?token=SEGREDO' }) }) }), [], { now: NOW }),
    () => assembleScoringInput({ lixo: true } as never, [], { now: NOW }),
    () => ({ alias: deriveAuditIdAlias('abc_defgh_ijk'), ok: verifyAuditIdAlias(deriveAuditIdAlias('abc_defgh_ijk')) }),
  ];
  const before = JSON.stringify(scenarios.map((run) => run()));
  const { value, traps } = withTraps(() => JSON.stringify(scenarios.map((run) => run())));
  assert.equal(value, before, 'a saída com armadilhas é idêntica à sem armadilhas');
  assert.ok(traps.length >= 20, `armadilhas instaladas: ${traps.length}`);
  assert.deepEqual(traps.filter((t) => t.calls > 0), [], 'nenhuma armadilha pode ter disparado');
  assert.ok(!value.includes('MAPPER_INTERNAL_ERROR'), 'uma armadilha engolida por try/catch apareceria como erro interno');
});

test('DINÂMICO: as armadilhas funcionam (um acesso de verdade dispara e é restaurado), para o teste acima não ser vazio', () => {
  assert.throws(() => withTraps(() => fs.readFileSync(__filename)), /acesso externo proibido: fs\.readFileSync/);
  assert.throws(() => withTraps(() => Date.now()), /acesso externo proibido: Date\.now/);
  assert.throws(() => withTraps(() => Math.random()), /acesso externo proibido: Math\.random/);
  assert.throws(() => withTraps(() => process.env.PATH), /acesso externo proibido: process\.env/);
  assert.equal(typeof fs.readFileSync(__filename), 'object', 'fs restaurado');
  assert.ok(Number.isFinite(Date.now()) && Math.random() >= 0 && typeof process.env.PATH === 'string', 'relógio, aleatoriedade e ambiente restaurados');
});

test('a saída é JSON puro (nada de função, Date, Map, Set ou referência circular) e sobrevive a ida e volta sem perda', () => {
  const out = assembleScoringInput(makeBasis(), [c2Judgement(), s4NotApplicable()], { now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  const walkValues = (value: unknown): void => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
    assert.ok(typeof value === 'object', `tipo inesperado: ${typeof value}`);
    assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype, 'só objetos simples e listas');
    for (const child of Object.values(value as object)) walkValues(child);
  };
  walkValues(out);
});
