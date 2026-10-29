import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-decisions');
const ROUTES = path.join(ROOT, 'src', 'app', 'api', 'link-audit', 'decisions');

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
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
const libFiles = walk(LIB);
const routeFiles = walk(ROUTES);

test('o módulo tem exatamente os arquivos esperados (qualquer arquivo novo exige revisão deliberada)', () => {
  assert.deepEqual(libFiles.map((f) => path.relative(LIB, f)).sort(), ['anchor-store.ts', 'contract.ts', 'evidence-refs.ts', 'files.ts', 'index.ts', 'project.ts', 'service.ts', 'store.ts', 'types.ts']);
  assert.deepEqual(routeFiles.map((f) => path.relative(ROUTES, f).split(path.sep).join('/')).sort(), ['[auditId]/revocations/route.ts', '[auditId]/route.ts', 'shared.ts']);
});

test('imports: só zod, módulos do próprio módulo e uma lista fechada de arquivos do motor/armazenamento (nunca o motor que calcula)', () => {
  const allowedExternal: Readonly<Record<string, readonly string[]>> = {
    'store.ts': ['node:crypto', 'node:path'],
    'anchor-store.ts': ['node:crypto', 'node:path'],
    'files.ts': ['node:path'],
    'service.ts': ['node:path'],
  };
  const allowedProject: Readonly<Record<string, readonly string[]>> = {
    'types.ts': ['../link-audit/scoring/input'],
    'project.ts': ['../link-audit/scoring/input'],
    'contract.ts': ['../link-audit/scoring/input', '../link-audit/scoring/versions'],
    'store.ts': ['../link-audit/canonical', '../link-audit/snapshot-store'],
    'files.ts': ['../link-audit/canonical', '../link-audit/snapshot-store'],
    'anchor-store.ts': ['../link-audit/snapshot-store'],
    'service.ts': ['../link-audit/scoring/input', '../link-audit/snapshot-store'],
  };
  for (const file of libFiles) {
    const name = path.basename(file);
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      const ok =
        specifier === 'zod' ||
        specifier.startsWith('./') ||
        (allowedExternal[name] ?? []).includes(specifier) ||
        (allowedProject[name] ?? []).includes(specifier);
      assert.ok(ok, `${rel(file)} importa "${specifier}"`);
    }
  }
});

test('nada de Supabase, Redis, filas, Serper, provedores, Juiz, prospecção, PDF, IA, coletor ou avaliação do motor', () => {
  const words = /supabase|bullmq|ioredis|redis|serper|dataforseo|site-check|url-safety|pdfkit|\/pdf\/|\/agents\/|\/queues\/|\/workers\/|judge|juiz|battlefield|maestro|collector|link-audit-runtime|scoring\/(?:engine|index|aggregate|ruler|confidence|publication)/i;
  for (const file of [...libFiles, ...routeFiles]) {
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) assert.ok(!words.test(specifier), `${rel(file)} importa "${specifier}"`);
  }
  for (const file of libFiles) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    assert.ok(!/\bscoreAudit\b|\bverifyScoreResult\b|\bcomputeIndex\b/.test(code), `${rel(file)} usa o motor que calcula`);
  }
});

test('o módulo não usa rede, ambiente, relógio, aleatoriedade, console, avaliação dinâmica nem disco fora do FsOps', () => {
  const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, 'fetch'],
    [/node:(?:http|https|http2|dns|net|tls|dgram|child_process|fs|worker_threads|vm)\b|fsPromises/, 'módulo de rede/processo/disco'],
    [/process\.env|loadEnvConfig|@next\/env|dotenv|\.env\b/, 'ambiente'],
    [/Date\.now\s*\(|new Date\s*\(|\bDate\b\s*\(|Math\.random/, 'relógio ou aleatoriedade implícitos'],
    [/\bconsole\./, 'console'],
    [/\beval\s*\(|new Function\s*\(/, 'avaliação dinâmica'],
    [/XMLHttpRequest|WebSocket/, 'cliente de rede'],
    [/Math\.round|toFixed\s*\(|parseFloat\s*\(/, 'cálculo de pontuação'],
    [/function\s+(?:compute|calculate|score|rate|classify)\w*/i, 'função de cálculo'],
  ];
  for (const file of libFiles) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    for (const [pattern, label] of forbidden) assert.ok(!pattern.test(code), `${rel(file)} usa ${label}`);
  }
});

test('só grava pelo mecanismo único (publishExclusive); não existe API de alteração ou exclusão e nenhum arquivo é apagado ou renomeado', () => {
  for (const name of ['store.ts', 'anchor-store.ts']) assert.ok(/publishExclusive\(/.test(strip(fs.readFileSync(path.join(LIB, name), 'utf8'))), `${name} grava pelo mecanismo único`);
  // e SOMENTE de forma atômica: o caminho alternativo (sem link) de publishExclusive é recusado nos dois armazenamentos
  for (const name of ['store.ts', 'anchor-store.ts']) assert.ok(/atomicOnly\(/.test(strip(fs.readFileSync(path.join(LIB, name), 'utf8'))), `${name} deve usar atomicOnly`);
  for (const file of libFiles) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    assert.ok(!/writeFile|appendFile|createWriteStream|\.rename\(|\.unlink\(|\.rm\(|\.rmdir\(|\.truncate\(|\.chmod\(|\.copyFile\(/.test(code), `${rel(file)} altera/apaga arquivos diretamente`);
    assert.ok(!/export\s+(?:async\s+)?function\s+(?:delete|remove|update|edit|overwrite|replace|purge|clear(?!StorageFatal))\w*/i.test(code), `${rel(file)} exporta operação destrutiva`);
  }
  const service = fs.readFileSync(path.join(LIB, 'service.ts'), 'utf8');
  assert.deepEqual([...service.matchAll(/^\s{4}async (\w+)\(/gm)].map((m) => m[1]), ['list', 'create', 'revoke']);
});

test('rotas: sem rede, sem disco, sem outra variável de ambiente além das duas pastas, sem exportar PUT/PATCH/DELETE', () => {
  for (const file of routeFiles) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|child_process|fs)\b|fsPromises|XMLHttpRequest|WebSocket/.test(code), `${rel(file)} usa rede ou disco`);
    assert.ok(!/export\s+(?:async\s+)?function\s+(?:PUT|PATCH|DELETE|OPTIONS|HEAD)\b/.test(code), `${rel(file)} exporta método de alteração/exclusão`);
    const vars = [...code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    for (const name of vars) assert.ok(['GMN_LINK_AUDIT_DECISIONS_DIR', 'GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR', 'GMN_LINK_AUDIT_EVIDENCE_DIR'].includes(name as string), `${rel(file)} lê ${name}`);
    assert.ok(!/process\.env(?!\.)/.test(code), `${rel(file)} lê o ambiente inteiro`);
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      const ok = specifier.startsWith('.') || specifier === 'next/server' || specifier === 'node:path' || /^@\/lib\/(?:auth\/require-operator|link-audit-decisions|link-audit-evidence|rate-limit)$/.test(specifier);
      assert.ok(ok, `${rel(file)} importa "${specifier}"`);
    }
  }
  const verbs = routeFiles.flatMap((file) => [...strip(fs.readFileSync(file, 'utf8')).matchAll(/export\s+async\s+function\s+(GET|POST)\b/g)].map((m) => `${path.basename(path.dirname(file))}:${m[1]}`)).sort();
  assert.deepEqual(verbs, ['[auditId]:GET', '[auditId]:POST', 'revocations:POST']);
});

test('o navegador, as páginas, os componentes, o Worker e os comandos NÃO importam as decisões (somente as rotas de servidor)', () => {
  const decisionsLib = LIB;
  const decisionsRoutes = ROUTES;
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    if (file.startsWith(decisionsLib + path.sep) || file.startsWith(decisionsRoutes + path.sep)) continue;
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      const resolved = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
      const hits = resolved !== null && (resolved === decisionsLib || resolved.startsWith(decisionsLib + path.sep) || resolved.startsWith(decisionsRoutes));
      assert.ok(!hits, `${rel(file)} importa as decisões ("${specifier}")`);
    }
  }
});

test('o armazenamento de decisões é independente de Supabase: nenhum arquivo SQL/migration foi criado para ele', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'));
  assert.deepEqual(migrations.sort(), ['001_gmn_schema.sql', '002_audit_payloads.sql']);
  assert.ok(!fs.existsSync(path.join(ROOT, 'supabase', 'proposed', '004_link_audit_decisions.sql')));
  const sqlTouchingDecisions = [...walk(path.join(ROOT, 'supabase')), ...fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).map((f) => path.join(ROOT, 'supabase', 'migrations', f))].filter((f) => /decision/i.test(fs.readFileSync(f, 'utf8')) && /link.?audit/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(sqlTouchingDecisions, []);
});

test('o script de testes do package.json inclui TODOS os arquivos de teste da Onda 6B', () => {
  const script = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: { test: string } }).scripts.test;
  const onDisk = fs.readdirSync(path.join(ROOT, 'tests')).filter((name) => /^link-audit-decisions-.*\.test\.ts$/.test(name));
  assert.ok(onDisk.length >= 7);
  for (const name of onDisk) assert.ok(script.includes(`tests/${name}`), `${name} não está no script de testes`);
});
