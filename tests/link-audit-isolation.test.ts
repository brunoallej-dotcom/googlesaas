import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.join(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'src', 'lib', 'link-audit');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.next' ? [] : walk(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const moduleFiles = walk(MODULE_DIR);

/*
 * Política por arquivo (Onda 2). Todos os arquivos seguem as regras da Onda 1 (só './', zod e url-safety;
 * sem rede, sem ambiente, sem relógio). Exceções mínimas e declaradas:
 *  - canonical.ts: node:crypto (somente para o SHA-256);
 *  - snapshot-store.ts: node:crypto (nome de temporário), node:fs/promises e node:path (único arquivo com disco).
 * Rede, fetch, process.env, Date.now/new Date()/Math.random continuam proibidos em TODOS, inclusive no store.
 */
const EXTRA_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'canonical.ts': ['node:crypto'],
  'snapshot-store.ts': ['node:crypto', 'node:fs/promises', 'node:path'],
};
const FS_ALLOWED_FILES: ReadonlySet<string> = new Set(['snapshot-store.ts']);

/*
 * Onda 4A: o módulo ganhou `url-redaction.ts` (usa `src/lib/redact.ts`, só texto) e a pasta `collector/`
 * (motor de coleta com provedores INJETADOS, sem rede). Pela resolução real dos imports:
 *  - qualquer arquivo do módulo pode importar outros arquivos do módulo, zod, `url-safety` e `redact`;
 *  - só os arquivos de `collector/` podem fazer `import type` de `site-check` e `serper-reviews` (tipos
 *    apagados na compilação: nenhum código dessas fontes é carregado).
 * Continuam proibidos em TODOS, inclusive no coletor: fetch, rede, ambiente, relógio implícito, disco.
 */
/** Imports de valor fora do módulo, ARQUIVO POR ARQUIVO (nenhum outro arquivo pode usá-los). */
const FILE_VALUE_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'maps-link.ts': ['src/lib/url-safety'],
  'evidence.ts': ['src/lib/url-safety'],
  'url-redaction.ts': ['src/lib/redact'],
  'collector/adapters.ts': ['src/lib/url-safety'],
};
const COLLECTOR_TYPE_ONLY_TARGETS: ReadonlySet<string> = new Set(['src/lib/site-check', 'src/lib/serper-reviews']);
const relativeToRoot = (absolute: string): string => path.relative(ROOT, absolute).split(path.sep).join('/');

test('o módulo da auditoria por link existe e tem os arquivos esperados', () => {
  const names = moduleFiles.map((file) => path.relative(MODULE_DIR, file).split(path.sep).join('/')).sort();
  assert.deepEqual(names, [
    'audit.ts',
    'canonical.ts',
    'collector/adapters.ts',
    'collector/budget.ts',
    'collector/capabilities.ts',
    'collector/capture-report.ts',
    'collector/collect.ts',
    'collector/cost.ts',
    'collector/index.ts',
    'collector/maps-place.ts',
    'collector/report.ts',
    'collector/site-access.ts',
    'collector/summaries.ts',
    'collector/types.ts',
    'evidence.ts',
    'identifiers.ts',
    'index.ts',
    'maps-link.ts',
    'methodology.ts',
    'scoring/aggregate.ts',
    'scoring/confidence.ts',
    'scoring/context.ts',
    'scoring/dates.ts',
    'scoring/engine.ts',
    'scoring/eval-authority.ts',
    'scoring/eval-common.ts',
    'scoring/eval-conversion.ts',
    'scoring/eval-profile.ts',
    'scoring/eval-reputation.ts',
    'scoring/eval-site.ts',
    'scoring/eval-visuals-posts.ts',
    'scoring/fingerprint.ts',
    'scoring/index.ts',
    'scoring/input.ts',
    'scoring/integrity.ts',
    'scoring/math.ts',
    'scoring/na.ts',
    'scoring/nap-compare.ts',
    'scoring/publication.ts',
    'scoring/report-text.ts',
    'scoring/results.ts',
    'scoring/ruler.ts',
    'scoring/tiers.ts',
    'scoring/types.ts',
    'scoring/versions.ts',
    'snapshot-store.ts',
    'snapshot.ts',
    'url-redaction.ts',
    'validate.ts',
  ]);
});

test('isolamento: o módulo só importa o próprio módulo, zod, url-safety e redact (e tipos de site-check/serper-reviews no coletor)', () => {
  for (const file of moduleFiles) {
    const inCollector = file.startsWith(path.join(MODULE_DIR, 'collector') + path.sep);
    for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
      const { specifier } = statement;
      const extra = EXTRA_IMPORTS[path.basename(file)] ?? [];
      const resolved = resolveImport(file, specifier);
      const target = resolved ? relativeToRoot(resolved) : null;
      const insideModule = resolved !== null && (resolved === MODULE_DIR || resolved.startsWith(MODULE_DIR + path.sep));
      const allowed =
        insideModule ||
        specifier === 'zod' ||
        extra.includes(specifier) ||
        (target !== null && (FILE_VALUE_TARGETS[path.relative(MODULE_DIR, file).split(path.sep).join('/')] ?? []).includes(target)) ||
        (inCollector && statement.typeOnly && target !== null && COLLECTOR_TYPE_ONLY_TARGETS.has(target));
      assert.ok(allowed, `${relativeToRoot(file)} importa "${specifier}", fora da lista permitida`);
    }
  }
});

test('o módulo não usa rede, processos, ambiente nem armazenamento', () => {
  const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfetch\s*\(/, 'fetch'],
    [/node:(?:http|https|http2|dns|net|tls|dgram|child_process|worker_threads)\b/, 'módulo node de rede/processo'],
    [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/, 'cliente de rede'],
    [/process\.env/, 'process.env'],
    [/\bprocess\.(?:exit|kill)\b/, 'process'],
    [/\beval\s*\(|new Function\s*\(/, 'avaliação dinâmica de código'],
    [/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random/, 'relógio/aleatório implícito (domínio puro)'],
  ];
  for (const file of moduleFiles) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const [pattern, label] of forbidden) {
      assert.ok(!pattern.test(code), `${path.relative(ROOT, file)} usa ${label}`);
    }
    if (!FS_ALLOWED_FILES.has(path.basename(file))) {
      assert.ok(!/node:fs\b/.test(code), `${path.relative(ROOT, file)} acessa disco; só snapshot-store.ts pode`);
    }
  }
});

test('Onda 2: só o armazenamento toca o disco e só dentro de um diretório base informado', () => {
  const storeCode = stripComments(fs.readFileSync(path.join(MODULE_DIR, 'snapshot-store.ts'), 'utf8'));
  assert.ok(/node:fs\/promises/.test(storeCode));
  assert.ok(!/['"`]public['"`]|\/public\b/.test(storeCode), 'o armazenamento não referencia public/');
  assert.ok(!/\.data['"`]\s*,\s*['"`]audits/.test(storeCode), 'o armazenamento não referencia .data/audits');
  assert.ok(/'\.data', 'link-audits'/.test(storeCode), 'a pasta padrão é .data/link-audits');
  for (const file of moduleFiles.filter((f) => !FS_ALLOWED_FILES.has(path.basename(f)))) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    assert.ok(!/\bfsPromises\b|\bwriteFile\b|\breadFile\b|\bmkdir\b|\bunlink\b/.test(code), `${path.relative(ROOT, file)} usa operação de arquivo`);
  }
});

test('isolamento: nada do Juiz, evidência antiga, PDF, agentes, banco, filas ou Serper aparece no módulo', () => {
  const forbiddenWords = /judge|juiz|battlefield|maestro|supabase|bullmq|ioredis|redis|serper|dataforseo|site-check|pdfkit|\/pdf\/|\/agents\/|\/queues\/|\/workers\/|lib\/evidence|criteria\.ts/i;
  for (const file of moduleFiles) {
    const inCollector = file.startsWith(path.join(MODULE_DIR, 'collector') + path.sep);
    for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveImport(file, statement.specifier);
      const target = resolved ? relativeToRoot(resolved) : null;
      // Única exceção: tipos (apagados na compilação) de site-check e serper-reviews dentro do coletor.
      if (inCollector && statement.typeOnly && target !== null && COLLECTOR_TYPE_ONLY_TARGETS.has(target)) continue;
      assert.ok(!forbiddenWords.test(statement.specifier), `${relativeToRoot(file)} importa "${statement.specifier}"`);
    }
  }
});

/*
 * Onda 3: a interface passou a CONSUMIR o módulo. A regra deixou de ser "ninguém importa" e virou uma
 * lista fechada de consumidores, cada um com o que pode importar. Qualquer outro arquivo (dashboard atual,
 * Juiz, PDFs, agentes, filas, workers, scripts) continua proibido de importar o módulo.
 */

/** Resolve um import (alias @/ ou relativo) para o caminho absoluto, ou null se for um pacote externo. */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return path.join(ROOT, 'src', specifier.slice(2));
  if (specifier.startsWith('.')) return path.resolve(path.dirname(fromFile), specifier);
  return null;
}

/** O import aponta para dentro de src/lib/link-audit, qualquer que seja a forma (alias, ../, ./link-audit/…)? */
function targetsModule(fromFile: string, specifier: string): string | null {
  const resolved = resolveImport(fromFile, specifier);
  if (!resolved) return null;
  if (resolved === MODULE_DIR) return 'index';
  return resolved.startsWith(MODULE_DIR + path.sep) ? resolved.slice(MODULE_DIR.length + 1) : null;
}
const ROUTE_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  'src/app/api/link-audit/parse/route.ts': ['maps-link'],
  'src/app/api/link-audit/confirm/route.ts': ['audit', 'maps-link'],
};
/** Onda 4B: o runtime de coleta (só servidor) e o comando deliberado são os únicos consumidores além da tela. */
const RUNTIME_DIR = 'src/lib/link-audit-runtime/';
const RUNTIME_CLI = 'scripts/link-audit-collect.ts';
/** Onda 4D: comando offline de evidências (persistir, verificar, relatório). Consome o módulo; não usa o runtime nem rede. */
const EVIDENCE_CLI = 'scripts/link-audit-evidence.ts';
/** Onda 5A: serviço de evidências (servidor; único com disco além do snapshot-store). */
const EVIDENCE_DIR = 'src/lib/link-audit-evidence/';
/**
 * Onda 6B: o módulo de decisões humanas (servidor) consome SÓ estes arquivos do módulo: o selo canônico, o mecanismo único
 * de gravação e o CONTRATO de entrada do motor (input/versions). Nunca o motor que calcula (engine) nem o coletor.
 */
const DECISIONS_DIR = 'src/lib/link-audit-decisions/';
const DECISIONS_TARGETS: ReadonlySet<string> = new Set(['canonical.ts', 'snapshot-store.ts', 'scoring/input.ts', 'scoring/versions.ts']);
/**
 * Onda 6C (I0): módulo NEUTRO de armazenamento (servidor). Consome SÓ o selo canônico e o mecanismo único de gravação; nunca o
 * motor, o coletor nem os esquemas. Quem o consome é verificado em `link-audit-storage-isolation.test.ts`.
 */
const STORAGE_DIR = 'src/lib/link-audit-storage/';
const STORAGE_TARGETS: ReadonlySet<string> = new Set(['canonical.ts', 'snapshot-store.ts']);
/** Remediação do MAJOR-1: o módulo de PROVA DE ORIGEM (HMAC) consome SÓ o selo canônico (serialização estável do corpo assinado); conferido em `link-audit-origin-isolation.test.ts`. */
const ORIGIN_DIR = 'src/lib/link-audit-origin/';
const LEDGER_DIR = 'src/lib/link-audit-ledger/';
const ORIGIN_TARGETS: ReadonlySet<string> = new Set(['canonical.ts']);
/**
 * Onda 6C (I2): mapeador determinístico (servidor). Consome SÓ o selo canônico, as constantes de metodologia (tipo) e o CONTRATO
 * do motor (entrada, tipos, régua como dados, datas puras e versões). NUNCA o motor que calcula (engine, agregação, avaliadores).
 * Os imports são conferidos arquivo a arquivo em `link-audit-scoring-runs-isolation.test.ts`.
 */
const SCORING_RUNS_DIR = 'src/lib/link-audit-scoring-runs/';
const SCORING_RUNS_TARGETS: ReadonlySet<string> = new Set(['canonical.ts', 'methodology.ts', 'scoring/dates.ts', 'scoring/index.ts', 'scoring/input.ts', 'scoring/ruler.ts', 'scoring/types.ts', 'scoring/versions.ts']);
/** Onda 6C (I4): SÓ o armazenamento dos resultados (`results-store.ts`) usa o mecanismo único de gravação (`snapshot-store`: trava e publicação exclusiva). */
const SCORING_RUNS_STORE_TARGETS: ReadonlyMap<string, ReadonlySet<string>> = new Map([['src/lib/link-audit-scoring-runs/results-store.ts', new Set(['snapshot-store.ts'])]]);
/** Onda 6C (I3): a rota da prévia (servidor). Só ela e o serviço de prévia consomem o índice do motor; cada arquivo é conferido em `link-audit-scoring-runs-isolation.test.ts`. */
const SCORING_ROUTES_DIR = 'src/app/api/link-audit/scoring/';
/** P1 W1: núcleo de atestação (puro). Só o selo canônico (SHA-256 do pacote); nunca o motor, o disco nem as decisões. Conferido arquivo a arquivo em `link-audit-seal-isolation.test.ts`. */
const ATTESTATION_DIR = 'src/lib/link-audit-attestation/';
/** Arquivo do núcleo de atestação → arquivos do módulo de evidências que ele pode importar. */
const ATTESTATION_EVIDENCE_IMPORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['src/lib/link-audit-attestation/index.ts', ['evidence-to-prove']],
  ['src/lib/link-audit-attestation/schemas.ts', ['types']],
  // P1 W2: a montagem pura do pacote (função única basis → evidências) e o adaptador de disco do `export` (só os leitores e o FsOps)
  ['src/lib/link-audit-attestation/export.ts', ['evidence-to-prove', 'types']],
  ['src/lib/link-audit-attestation/export-run.ts', ['provenance', 'reader', 'scoring-basis', 'store']],
  // P1 W4.2: a cadeia do `sign` é lida e verificada pelo verificador v2 real (só ele)
  ['src/lib/link-audit-attestation/sign-chain.ts', ['provenance']],
]);
const ATTESTATION_TARGETS: ReadonlySet<string> = new Set(['canonical.ts']);
/** P1 W2: só o adaptador de disco do `export` usa também o FsOps (leitura O_NOFOLLOW/O_NONBLOCK e a criação exclusiva do --out). */
const ATTESTATION_EXTRA_TARGETS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['src/lib/link-audit-attestation/export-run.ts', new Set(['snapshot-store.ts'])],
  // P1 W4.2: só o TIPO FsOps (o disco é injetado por quem chama; a leitura da cadeia nunca escreve)
  ['src/lib/link-audit-attestation/sign-chain.ts', new Set(['snapshot-store.ts'])],
  // P1 W4.3: o disco do `sign` (tipos BytesFsOps/FsOps e `errorCode`): leitura única das entradas e a gravação temporário + link() exclusivo
  ['src/lib/link-audit-attestation/sign-run.ts', new Set(['snapshot-store.ts'])],
  // P1 W4.4: o comando `sign` usa o disco PADRÃO (nodeFsOps, injetável nos testes) para entregá-lo a sign-run.ts; não lê nem grava por conta própria
  ['src/lib/link-audit-attestation/sign-cli.ts', new Set(['snapshot-store.ts'])],
]);
const CLIENT_DIRS = ['src/components/link-audit/', 'src/app/auditoria-por-link/'];
/** Único valor (não só tipo) que o navegador pode importar: constantes puras, sem nenhum import. */
const CLIENT_VALUE_IMPORTS: ReadonlySet<string> = new Set(['methodology']);
const CLIENT_EXTERNAL_PACKAGES: ReadonlySet<string> = new Set(['react', 'react/jsx-runtime', 'next/link', 'next/navigation', 'lucide-react']); // next/navigation: notFound() da rota da auditoria (I5)

interface ImportStatement {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function importStatements(source: string): ImportStatement[] {
  const code = stripComments(source);
  const found: ImportStatement[] = [];
  for (const match of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)) {
    found.push({ specifier: match[2] ?? '', typeOnly: Boolean(match[1]) });
  }
  for (const match of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ specifier: match[1] ?? '', typeOnly: false });
  }
  return found;
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

test('isolamento reverso: só os consumidores declarados importam o módulo, e só o que podem', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))].filter(
    (file) => !file.startsWith(MODULE_DIR + path.sep),
  );
  assert.ok(files.length > 60, 'a varredura deve cobrir o código existente');
  const consumersSeen = new Set<string>();

  for (const file of files) {
    const name = rel(file);
    const isClient = CLIENT_DIRS.some((dir) => name.startsWith(dir));
    const allowedRoute = ROUTE_CONSUMERS[name];
    const isRuntime = name.startsWith(RUNTIME_DIR) || name.startsWith(EVIDENCE_DIR) || name === RUNTIME_CLI || name === EVIDENCE_CLI;
    const isDecisions = name.startsWith(DECISIONS_DIR);
    const isStorage = name.startsWith(STORAGE_DIR);
    const isOrigin = name.startsWith(ORIGIN_DIR);
    const isLedger = name.startsWith(LEDGER_DIR);
    const isScoringRuns = name.startsWith(SCORING_RUNS_DIR);
    for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
      const target = targetsModule(file, statement.specifier);
      if (target === null) continue;
      consumersSeen.add(name);
      if (isScoringRuns) {
        const withExtension = target.endsWith('.ts') ? target : `${target}.ts`;
        assert.ok(SCORING_RUNS_TARGETS.has(withExtension) || SCORING_RUNS_STORE_TARGETS.get(name)?.has(withExtension) === true, `${name} importa "${statement.specifier}", fora da lista fechada do mapeador (contrato do motor, nunca o motor que calcula)`);
      } else if (isDecisions) {
        const withExtension = target.endsWith('.ts') ? target : `${target}.ts`;
        assert.ok(DECISIONS_TARGETS.has(withExtension), `${name} importa "${statement.specifier}", fora da lista fechada do módulo de decisões`);
      } else if (isLedger) {
        // livro de cabeças: só as primitivas de gravação/leitura atômica já testadas (FsOps, publishExclusive); nunca o restante do módulo
        const withExtension = target.endsWith('.ts') ? target : `${target}.ts`;
        assert.ok(withExtension === 'snapshot-store.ts', `${name} importa "${statement.specifier}", fora da lista fechada do livro de cabeças`);
      } else if (isOrigin) {
        const withExtension = target.endsWith('.ts') ? target : `${target}.ts`;
        assert.ok(ORIGIN_TARGETS.has(withExtension), `${name} importa "${statement.specifier}", fora da lista fechada do módulo de prova de origem`);
      } else if (name.startsWith(ATTESTATION_DIR)) {
        const withExtension = target.endsWith('.ts') ? target : `${target}.ts`;
        assert.ok(ATTESTATION_TARGETS.has(withExtension) || ATTESTATION_EXTRA_TARGETS.get(name)?.has(withExtension) === true, `${name} importa "${statement.specifier}", fora da lista fechada do núcleo de atestação`);
      } else if (isStorage) {
        const withExtension = target.endsWith('.ts') ? target : `${target}.ts`;
        assert.ok(STORAGE_TARGETS.has(withExtension), `${name} importa "${statement.specifier}", fora da lista fechada do módulo neutro de armazenamento`);
      } else if (isRuntime) {
        continue;
      } else if (allowedRoute) {
        assert.ok(allowedRoute.includes(target), `${name} importa "${statement.specifier}", fora do que a rota pode usar`);
      } else if (isClient) {
        assert.ok(
          statement.typeOnly || CLIENT_VALUE_IMPORTS.has(target),
          `${name} (navegador) importa valor de "${statement.specifier}"; só tipos e methodology são permitidos`,
        );
      } else {
        assert.fail(`${name} não é um consumidor autorizado e importa "${statement.specifier}"`);
      }
    }
  }
  for (const route of Object.keys(ROUTE_CONSUMERS)) assert.ok(consumersSeen.has(route), `${route} deveria usar o módulo`);
});

test('Onda 3: nada do navegador importa Node, url-safety, armazenamento ou hash; a interface não grava nem usa storage', () => {
  const clientFiles = [...walk(path.join(ROOT, 'src', 'components', 'link-audit')), ...walk(path.join(ROOT, 'src', 'app', 'auditoria-por-link'))];
  assert.ok(clientFiles.length >= 8, 'a tela deve ter seus componentes');
  for (const file of clientFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { specifier } of importStatements(source)) {
      assert.ok(!/^node:/.test(specifier), `${rel(file)} importa ${specifier}`);
      assert.ok(!/url-safety|snapshot|canonical|supabase|redis|queues|workers|agents|serper/i.test(specifier), `${rel(file)} importa ${specifier}`);
    }
    const code = stripComments(source);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code), `${rel(file)} usa armazenamento do navegador`);
    // Onda 6C (I5): o cliente HTTP da página da auditoria (mesma origem) é o único outro arquivo autorizado a chamar fetch
    if (!rel(file).endsWith('api-client.ts') && rel(file) !== 'src/components/link-audit/audit-page/api.ts') assert.ok(!/\bfetch\s*\(/.test(code.replace(/fetch\('\/api\/auth\/logout'[^)]*\)/g, '')), `${rel(file)} chama fetch fora do cliente de API`);
  }
});

test('Onda 3: o que o navegador alcança, transitivamente, só usa pacotes de interface e methodology.ts', () => {
  const entries = [...walk(path.join(ROOT, 'src', 'components', 'link-audit')), ...walk(path.join(ROOT, 'src', 'app', 'auditoria-por-link'))];
  const reached = new Set<string>();
  const queue = [...entries];
  const resolveFile = (base: string): string | null => {
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
      if (statement.typeOnly) continue; // tipos somem na compilação e não entram no pacote do navegador
      const resolved = resolveImport(file, statement.specifier);
      if (resolved === null) {
        assert.ok(CLIENT_EXTERNAL_PACKAGES.has(statement.specifier), `${rel(file)} (navegador) importa o pacote "${statement.specifier}"`);
        continue;
      }
      const target = resolveFile(resolved);
      assert.ok(target, `${rel(file)} importa "${statement.specifier}", que não foi encontrado`);
      queue.push(target as string);
    }
  }
  const reachedNames = [...reached].map(rel);
  assert.ok(reachedNames.length >= 12, 'a varredura deve alcançar os componentes do dashboard usados pelo shell');
  for (const name of reachedNames) {
    assert.ok(
      name.startsWith('src/components/') || name.startsWith('src/app/auditoria-por-link/') || name === 'src/lib/link-audit/methodology.ts',
      `o navegador alcança ${name}, fora do que é permitido`,
    );
  }
  assert.ok(reachedNames.includes('src/lib/link-audit/methodology.ts'));
  assert.deepEqual(reachedNames.filter((name) => name.startsWith('src/lib/')), ['src/lib/link-audit/methodology.ts'], 'do código de servidor, o navegador só alcança methodology.ts');
});

test('Onda 3: as rotas da interface não persistem nada nem acessam rede', () => {
  for (const route of Object.keys(ROUTE_CONSUMERS)) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, route), 'utf8'));
    for (const { specifier } of importStatements(code)) {
      assert.ok(!/snapshot|canonical|^node:fs|^node:http|^node:net|^node:dns|supabase|redis|queues/i.test(specifier), `${route} importa ${specifier}`);
    }
    assert.ok(!/\bfetch\s*\(|writeFile|mkdir|process\.env/.test(code), `${route} usa rede, disco ou ambiente`);
  }
});

/*
 * Onda 6A (D3B homologada): a pontuação existe, mas SOMENTE em `src/lib/link-audit/scoring/` (módulo puro e ainda não
 * conectado). Fora dessa pasta continua proibido qualquer cálculo de índice/cobertura/arredondamento; dentro dela
 * o arredondamento é só aritmética inteira (nada de Math.round, toFixed ou parseFloat).
 */
const SCORING_PREFIX = path.join(MODULE_DIR, 'scoring') + path.sep;
test('Onda 6A: a pontuação só existe em scoring/; o resto do módulo continua sem cálculo de índice ou cobertura', () => {
  for (const file of moduleFiles) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (file.startsWith(SCORING_PREFIX)) {
      assert.ok(!/Math\.round|toFixed\s*\(|parseFloat\s*\(/.test(code), `${path.relative(ROOT, file)} usa arredondamento/decimal de ponto flutuante`);
      continue;
    }
    assert.ok(
      !/function\s+(?:compute|calculate|score|rate|classify)\w*/i.test(code),
      `${path.relative(ROOT, file)} declara função de cálculo fora de scoring/`,
    );
    assert.ok(!/Math\.round|toFixed\s*\(/.test(code), `${path.relative(ROOT, file)} faz arredondamento fora de scoring/`);
  }
});

/*
 * Onda 4B: política do runtime de coleta real. Nenhuma coleta é acionada por rota, página, componente ou worker;
 * `fetch` existe em UM arquivo; o ambiente é lido em UM arquivo; o runtime só é importado pelo comando deliberado.
 */
test('Onda 4B: o runtime só é importado pelo comando; nenhuma rota, página, componente ou worker o alcança', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))].filter((file) => !rel(file).startsWith(RUNTIME_DIR));
  for (const file of files) {
    for (const { specifier } of importStatements(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveImport(file, specifier);
      const hitsRuntime = resolved !== null && (resolved === path.join(ROOT, 'src', 'lib', 'link-audit-runtime') || resolved.startsWith(path.join(ROOT, 'src', 'lib', 'link-audit-runtime') + path.sep));
      if (hitsRuntime) assert.equal(rel(file), RUNTIME_CLI, `${rel(file)} importa o runtime de coleta ("${specifier}")`);
    }
  }
  assert.ok(fs.existsSync(path.join(ROOT, RUNTIME_CLI)));
});

test('Onda 4B: `fetch(` só no provedor Serper; ambiente só em config.ts; sem /reviews, sem eval, sem processos', () => {
  const runtimeFiles = walk(path.join(ROOT, 'src', 'lib', 'link-audit-runtime'));
  assert.ok(runtimeFiles.length >= 6);
  for (const file of runtimeFiles) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const name = path.basename(file);
    assert.equal(/\bfetch\s*\(/.test(code), name === 'serper-maps-provider.ts', `${rel(file)}: uso de fetch fora da política`);
    assert.equal(/process\.env/.test(code), false, `${rel(file)} lê process.env diretamente (use o env recebido por argumento)`);
    assert.ok(!/serper\.dev\/reviews|\/reviews['"`]/.test(code), `${rel(file)} referencia o /reviews`);
    assert.ok(!/\beval\s*\(|new Function\s*\(|node:child_process/.test(code), `${rel(file)} usa execução dinâmica`);
    assert.ok(!/supabase|bullmq|ioredis|head-prospector|from\s+['"][^'"]*serper-reviews['"]|\.env\.local/i.test(code), `${rel(file)} toca prospecção, banco, filas ou .env.local`);
    if (name !== 'used-authorizations.ts') assert.ok(!/node:fs\b/.test(code), `${rel(file)} acessa disco; só used-authorizations.ts pode`);
  }
  const cli = stripComments(fs.readFileSync(path.join(ROOT, RUNTIME_CLI), 'utf8'));
  assert.ok(!/\bfetch\s*\(/.test(cli), 'o comando não chama fetch');
  assert.ok(!/node:fs|readFile|writeFile|appendFile/.test(cli), 'o comando não toca arquivos (o ambiente vem de loadEnvConfig, só no LIVE)');
  assert.ok(cli.indexOf('loadEnv()') > cli.indexOf("flags.has('live')"), 'o ambiente só é carregado depois de confirmar que o modo é LIVE');
});

test('Onda 4B/4D: o núcleo da coleta (budget, cost, report, summaries, site-access, capture-report) é puro', () => {
  for (const name of ['budget', 'cost', 'report', 'summaries', 'site-access', 'capture-report']) {
    const code = stripComments(fs.readFileSync(path.join(MODULE_DIR, 'collector', `${name}.ts`), 'utf8'));
    assert.ok(!/node:|process\.|\bfetch\b|Date\.now|new Date\s*\(\s*\)|Math\.random/.test(code), `collector/${name}.ts não é puro`);
  }
});

test('Onda 4D: o comando de evidências é offline (sem rede, sem runtime, sem .env.local) e nenhuma rota o importa', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, EVIDENCE_CLI), 'utf8'));
  assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|child_process)\b|XMLHttpRequest|WebSocket/.test(code), 'sem rede');
  assert.ok(!/link-audit-runtime|loadEnvConfig|@next\/env|\.env\.local|serper-maps-provider|site-provider/.test(code), 'sem runtime nem leitura do ambiente');
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    if (rel(file) === EVIDENCE_CLI) continue;
    for (const { specifier } of importStatements(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveImport(file, specifier);
      assert.ok(resolved === null || !/scripts[\\/]link-audit-evidence$/.test(resolved), `${rel(file)} importa o comando de evidências`);
    }
  }
});

/*
 * Onda 5B: as ROTAS DE LEITURA (src/app/api/link-audit/evidence/**) são os únicos consumidores de servidor do leitor
 * (pelo índice público); o navegador só pode importar TIPOS (apagados na compilação). Ninguém mais.
 */
const EVIDENCE_ROUTES_DIR = 'src/app/api/link-audit/evidence/';
/** Onda 6B: as rotas de decisões também criam o leitor autorizado de evidências (pelo índice público) para validar referências. */
const DECISIONS_ROUTES_DIR = 'src/app/api/link-audit/decisions/';

test('Onda 5A/5B: só o runtime, os comandos e as rotas de leitura importam o serviço de evidências; o navegador só importa tipos', () => {
  const evidenceRoot = path.join(ROOT, 'src', 'lib', 'link-audit-evidence');
  const allowedImporters = (name: string): boolean =>
    name.startsWith('src/lib/link-audit-evidence/') || name.startsWith(RUNTIME_DIR) || name === RUNTIME_CLI || name === EVIDENCE_CLI || name.startsWith(EVIDENCE_ROUTES_DIR) || name.startsWith(DECISIONS_ROUTES_DIR);
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    const name = rel(file);
    if (name.startsWith(SCORING_RUNS_DIR)) {
      // Onda 6C (I2): o mapeador só importa TIPOS da base de pontuação (apagados na compilação); nunca o leitor nem o armazenamento
      for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
        const resolved = resolveImport(file, statement.specifier);
        if (resolved === null || !(resolved === evidenceRoot || resolved.startsWith(evidenceRoot + path.sep))) continue;
        // exceção deliberada (R2-MINOR-1): o serviço de prévia usa a POLÍTICA de proveniência das evidências (a fronteira com o motor); mais ninguém do módulo
        if (name.endsWith('/preview.ts') && (resolved === path.join(evidenceRoot, 'provenance') || resolved === path.join(evidenceRoot, 'evidence-to-prove'))) continue; // W1 P1: a montagem única base → evidências a provar
        assert.ok(statement.typeOnly && resolved === path.join(evidenceRoot, 'scoring-basis'), `${name} importa "${statement.specifier}": só tipos de scoring-basis são permitidos`);
      }
      continue;
    }
    if (name.startsWith(SCORING_ROUTES_DIR)) {
      // Onda 6C (I3): a rota da prévia usa o índice público e o leitor de pontuação (único lugar que o monta)
      for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
        const resolved = resolveImport(file, statement.specifier);
        if (resolved === null || !(resolved === evidenceRoot || resolved.startsWith(evidenceRoot + path.sep))) continue;
        assert.ok(resolved === evidenceRoot || resolved === path.join(evidenceRoot, 'scoring-basis') || resolved === path.join(evidenceRoot, 'provenance'), `${name} importa "${statement.specifier}": só o índice público, o leitor de pontuação e a política de proveniência são permitidos`);
      }
      continue;
    }
    if (name.startsWith(ATTESTATION_DIR)) {
      // P1 W1: o núcleo de atestação usa SÓ estes dois arquivos do módulo de evidências, e só nestes importadores
      for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
        const resolved = resolveImport(file, statement.specifier);
        if (resolved === null || !(resolved === evidenceRoot || resolved.startsWith(evidenceRoot + path.sep))) continue;
        const allowed = ATTESTATION_EVIDENCE_IMPORTS.get(name);
        assert.ok(allowed !== undefined && allowed.some((target) => resolved === path.join(evidenceRoot, target)), `${name} importa "${statement.specifier}": fora da lista fechada do núcleo de atestação`);
      }
      continue;
    }
    if (allowedImporters(name)) continue;
    for (const statement of importStatements(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveImport(file, statement.specifier);
      const hits = resolved !== null && (resolved === evidenceRoot || resolved.startsWith(evidenceRoot + path.sep));
      const clientTypeOnly = CLIENT_DIRS.some((dir) => name.startsWith(dir)) && statement.typeOnly && resolved === evidenceRoot;
      assert.ok(!hits || clientTypeOnly, `${name} importa o serviço de evidências ("${statement.specifier}")`);
    }
  }
  // as rotas usam só o índice público (leitor + apresentação), nunca o armazenamento nem os segredos
  for (const file of [...walk(path.join(ROOT, 'src', 'app', 'api', 'link-audit', 'evidence')), ...walk(path.join(ROOT, 'src', 'app', 'api', 'link-audit', 'decisions'))]) {
    for (const { specifier } of importStatements(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveImport(file, specifier);
      if (resolved === null || !resolved.startsWith(evidenceRoot)) continue;
      assert.equal(resolved, evidenceRoot, `${rel(file)} importa "${specifier}": só o índice público é permitido`);
    }
  }
});

test('Onda 5B: as rotas de leitura são só GET, sem rede, sem disco, sem escrita e sem ler outra variável de ambiente', () => {
  const files = walk(path.join(ROOT, 'src', 'app', 'api', 'link-audit', 'evidence'));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|child_process|fs)\b|fsPromises|XMLHttpRequest|WebSocket/.test(code), `${rel(file)} usa rede ou disco`);
    assert.ok(!/export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE|OPTIONS)\b/.test(code), `${rel(file)} exporta método de escrita`);
    assert.ok(!/bodyText|request\.json\(|request\.formData\(|request\.body\b/.test(code), `${rel(file)} lê corpo da requisição ou do provedor`);
    for (const match of code.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      assert.equal(match[1], 'GMN_LINK_AUDIT_EVIDENCE_DIR', `${rel(file)} lê a variável ${match[1]}`);
    }
  }
  const shared = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'api', 'link-audit', 'evidence', 'shared.ts'), 'utf8'));
  assert.ok(/requireOperator\(request\)/.test(shared), 'toda leitura passa por requireOperator');
  assert.ok(/SlidingWindowLimiter/.test(shared) && /RATE_LIMITED/.test(shared), 'há limite de requisições');
  assert.ok(/no-store/.test(shared) && /private/.test(shared), 'respostas privadas sem cache');
});

test('Onda 5B: o navegador não referencia a pasta de evidências, caminhos de arquivo nem APIs de arquivo', () => {
  const clientFiles = [...walk(path.join(ROOT, 'src', 'components', 'link-audit')), ...walk(path.join(ROOT, 'src', 'app', 'auditoria-por-link'))];
  for (const file of clientFiles) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const name = rel(file);
    // a mensagem de ajuda pode citar o NOME da variável (texto para o administrador), nunca ler ambiente
    assert.ok(!/process\.env|FileReader|showOpenFilePicker|<input[^>]*type="file"|\.capture\.json|MANIFEST/.test(code), `${name} toca ambiente, arquivos ou nomes de arquivo privados`);
    assert.ok(!/['"`]\/(?:mnt|tmp|home)\//.test(code) && !/['"`][A-Za-z]:\\\\/.test(code), `${name} embute caminho de disco`);
  }
  const apiClient = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'components', 'link-audit', 'evidence-api-client.ts'), 'utf8'));
  assert.ok(/method: 'GET'/.test(apiClient) && !/method: 'POST'|method: 'PUT'|method: 'DELETE'|body:/.test(apiClient), 'o cliente de evidências só faz GET sem corpo');
});

test('Onda 5A: o serviço de evidências não usa rede, ambiente nem relógio, só grava pelo mecanismo único e não referencia public/', () => {
  const files = walk(path.join(ROOT, 'src', 'lib', 'link-audit-evidence'));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|child_process)\b|XMLHttpRequest|WebSocket/.test(code), `${rel(file)} usa rede`);
    assert.ok(!/process\.env|loadEnvConfig|@next\/env|\.env\.local/.test(code), `${rel(file)} lê o ambiente`);
    assert.ok(!/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random/.test(code), `${rel(file)} usa relógio/aleatório implícito`);
    assert.ok(!/node:fs\b|fsPromises|writeFileSync|appendFile|createWriteStream/.test(code), `${rel(file)} escreve em disco fora do FsOps`);
    assert.ok(!/['"`]public['"`]\s*[,)]|\.data['"`]\s*,\s*['"`]audits/.test(code.replace(/\['public'[^\]]*\]/, '')), `${rel(file)} referencia public/ ou .data/audits`);
  }
  const store = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'link-audit-evidence', 'store.ts'), 'utf8'));
  assert.ok(/publishExclusive\(/.test(store), 'a gravação usa o mecanismo único (publishExclusive)');
});
