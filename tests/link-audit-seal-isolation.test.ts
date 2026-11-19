import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computePackageSha256, evidenceToProveFromBasis } from '../src/lib/link-audit-attestation';

/* P1 W1 — o núcleo de atestação é PURO: lista fechada de arquivos e de imports, sem rede, disco, ambiente, relógio nem aleatoriedade. */
const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib', 'link-audit-attestation');
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** Todas as formas de dependência: `import/export ... from`, `import 'x'` (efeito colateral), `import('x')` e `require('x')`. */
const importsOf = (source: string): string[] => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
  ];
};
const FILES = ['export-run.ts', 'export.ts', 'index.ts', 'package-hash.ts', 'schemas.ts', 'sign-chain.ts', 'sign-core.ts', 'sign-run.ts'];
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  'index.ts': new Set(['../link-audit-evidence/evidence-to-prove', './package-hash', './schemas']),
  'package-hash.ts': new Set(['../link-audit/canonical', './schemas']),
  'schemas.ts': new Set(['zod', '../link-audit-evidence/types']),
  // P1 W2: montagem PURA do pacote candidato (a função única basis → evidências e o padrão do auditId)
  'export.ts': new Set(['../link-audit-evidence/evidence-to-prove', '../link-audit-evidence/types', './package-hash', './schemas']),
  // P1 W2: o ÚNICO arquivo do módulo com disco: lê pelos leitores existentes (FsOps injetado) e cria só o --out; fora do índice público
  'export-run.ts': new Set(['node:path', 'zod', '../link-audit/snapshot-store', '../link-audit-evidence/provenance', '../link-audit-evidence/reader', '../link-audit-evidence/scoring-basis', '../link-audit-evidence/store', './export', './schemas']),
  // P1 W4.1: núcleo PURO das recusas do `sign` (só o hash do dossiê vem de node:crypto); nunca o verificador, o leitor nem disco
  'sign-core.ts': new Set(['node:crypto', './package-hash', './schemas']),
  // P1 W4.2: o ÚNICO arquivo do `sign` que importa o verificador v2 (leitura e verificação da cadeia, corpo e assinatura); disco só pelo FsOps
  // injetado (tipo), nunca o leitor de evidências nem o armazenamento. O artefato único separa o núcleo do verificador na W4.6 (§5.5.1 item 7).
  'sign-chain.ts': new Set(['node:crypto', 'node:path', '../link-audit/snapshot-store', '../link-audit-evidence/provenance', './schemas', './sign-core']),
  // P1 W4.3: o ÚNICO arquivo do `sign` que escreve (leitura única das entradas e gravação temporário + link() exclusivo), pelo FsOps injetado;
  // nunca o verificador (o texto gravado vem conferido de sign-chain.ts), o leitor de evidências nem o armazenamento
  'sign-run.ts': new Set(['node:crypto', 'node:path', '../link-audit/snapshot-store', './schemas', './sign-chain', './sign-core']),
};
/** Exceções por arquivo às proibições abaixo, cada uma trocada por uma regra mais estreita (P1 W2). */
const NO_IMPLICIT_CLOCK: readonly [RegExp, string] = [/Date\.now|new Date\s*\(\s*\)|performance\.now/, 'relógio implícito'];
const EXCEPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  'export.ts': new Set(['Date']), // Date.parse/toISOString de datas recebidas (normalização); o instante vem de quem chama
  'export-run.ts': new Set(['Date', 'módulo node']), // só node:path (lista acima); o instante vem de quem chama
  'sign-core.ts': new Set(['Date', 'módulo node']), // relógio INJETADO (tipo Date); só createHash de node:crypto (teste abaixo)
  'sign-chain.ts': new Set(['módulo node']), // só node:crypto (assinar/derivar a pública) e node:path (lista acima); sem relógio
  'sign-run.ts': new Set(['módulo node', 'escrita']), // node:crypto (só randomBytes do nome do temporário) e node:path; escrita SÓ pela regra estreita abaixo
};

test('importsOf enxerga import de efeito colateral, import() dinâmico, require e export from', () => {
  assert.deepEqual(importsOf("import 'a';\nimport { b } from 'b';\nconst c = await import('c');\nconst d = require('d');\nexport { e } from 'e';\n// import 'comentario'"), ['b', 'e', 'a', 'c', 'd']);
});

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
    for (const [pattern, label] of forbidden) if (!EXCEPTIONS[name]?.has(label)) assert.ok(!pattern.test(code), `${name} usa ${label}`);
    if (EXCEPTIONS[name]?.has('Date')) assert.ok(!NO_IMPLICIT_CLOCK[0].test(code), `${name} usa ${NO_IMPLICIT_CLOCK[1]}`);
  }
});

test('P1 W2: export-run.ts só escreve por UMA criação exclusiva (o --out) e nunca apaga, renomeia, cria pasta nem muda permissão', () => {
  const code = strip(fs.readFileSync(path.join(LIB, 'export-run.ts'), 'utf8'));
  assert.equal([...code.matchAll(/\.writeExclusive\s*\(/g)].length, 1);
  assert.ok(!/\.(?:mkdir|link|unlink|chmod|syncDirectory|rename|rm|truncate)\s*\(|publishExclusive|withLock|node:fs/.test(code));
  assert.equal(strip(fs.readFileSync(path.join(LIB, 'index.ts'), 'utf8')).includes('export-run'), false, 'o adaptador de disco fica fora do índice público');
});

test('P1 W4.1: sign-core.ts usa de node:crypto SÓ createHash (hash do dossiê): nunca assina, abre, gera nem deriva chave', () => {
  const code = strip(fs.readFileSync(path.join(LIB, 'sign-core.ts'), 'utf8'));
  assert.deepEqual([...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:crypto'/g)].map((m) => (m[1] ?? '').trim()), ['createHash']);
  assert.ok(!/\b(?:sign|verify|createPrivateKey|createPublicKey|generateKeyPair\w*|randomBytes|scrypt\w*|pbkdf2\w*)\s*\(/.test(code) && !/\bKeyObject\b/.test(code), 'operação de chave no núcleo');
  assert.ok(!/node:(?!crypto')/.test(code), 'outro módulo node');
});

test('P1 W4.2: sign-chain.ts verifica a cadeia com o verificador REAL em modo produção (keyring, acceptedVersions [2]), só lê pelo FsOps injetado e nunca escreve', () => {
  const code = strip(fs.readFileSync(path.join(LIB, 'sign-chain.ts'), 'utf8'));
  assert.ok(/createSealedEvidenceProvenance\(\{[^}]*\bkeyring\b[^}]*\bacceptedVersions:\s*\[2\]/.test(code), 'verificador com keyring e acceptedVersions: [2]');
  assert.ok(!/\btrustedKeys\b/.test(code), 'trustedKeys é só de teste');
  assert.ok(!/\.(?:mkdir|writeExclusive|link|unlink|chmod|syncDirectory|rename|rm|truncate)\s*\(|publishExclusive|withLock|nodeFsOps|node:fs/.test(code), 'escrita ou disco implícito');
  for (const name of FILES.filter((file) => file !== 'sign-chain.ts' && file !== 'export-run.ts')) {
    assert.ok(!importsOf(fs.readFileSync(path.join(LIB, name), 'utf8')).includes('../link-audit-evidence/provenance'), `${name} não importa o verificador (§5.5.1 item 7)`);
  }
});

test('P1 W4.3: sign-run.ts escreve SÓ pelo FsOps injetado: uma subpasta, um temporário exclusivo, um link() para o nome final, remove só o próprio temporário e sincroniza; nunca apaga um manifesto, renomeia, muda permissão nem usa o disco padrão', () => {
  const code = strip(fs.readFileSync(path.join(LIB, 'sign-run.ts'), 'utf8'));
  const count = (pattern: RegExp): number => [...code.matchAll(pattern)].length;
  assert.deepEqual([count(/\.mkdir\s*\(/g), count(/\.writeExclusive\s*\(/g), count(/\.link\s*\(/g), count(/\.syncDirectory\s*\(/g)], [1, 1, 1, 2], 'mkdir da subpasta, temporário, link() e fsync da raiz nova e da pasta');
  assert.ok(count(/\.unlink\s*\(/g) > 0 && count(/\.unlink\s*\(/g) === count(/\.unlink\s*\(\s*temp\s*\)/g), 'unlink só do temporário');
  assert.ok(/\.writeExclusive\s*\(\s*temp\s*,/.test(code) && /\.link\s*\(\s*temp\s*,/.test(code), 'o nome final só nasce por link() do temporário');
  assert.ok(!/\.(?:rename|rm|rmdir|truncate|chmod|appendFile|writeFile|copyFile)\s*\(|publishExclusive|withLock|nodeFsOps|node:fs/.test(code), 'escrita fora da regra ou disco implícito');
  assert.deepEqual([...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:crypto'/g)].map((m) => (m[1] ?? '').trim()), ['randomBytes, type KeyObject'], 'de node:crypto só o aleatório do temporário (e o tipo da chave)');
  assert.ok(!/\b(?:sign|verify|createPrivateKey|createPublicKey|generateKeyPair\w*)\s*\(/.test(code), 'operação de chave fora de sign-chain.ts');
});

/** P1 W2: o CLI `scripts/link-audit-seal.ts` é o ÚNICO consumidor (o `sign` chega na W4), e só destes arquivos. */
const CLI_FILE = path.join(ROOT, 'scripts', 'link-audit-seal.ts');
const CLI_ALLOWED: ReadonlySet<string> = new Set(['@/lib/link-audit-attestation/export', '@/lib/link-audit-attestation/export-run', '@/lib/link-audit-attestation/schemas']);

test('consumidores: só o CLI link-audit-seal importa o módulo (src/ e os demais scripts não), e só export, export-run e schemas', () => {
  const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    if (file.startsWith(LIB + path.sep) || file === CLI_FILE) continue;
    assert.ok(!/link-audit-attestation/.test(strip(fs.readFileSync(file, 'utf8'))), `${path.relative(ROOT, file)} importa o módulo de atestação`);
  }
  const used = importsOf(fs.readFileSync(CLI_FILE, 'utf8')).filter((specifier) => /link-audit-attestation/.test(specifier));
  assert.ok(used.length > 0 && used.every((specifier) => CLI_ALLOWED.has(specifier)), `o CLI importa ${used.join(', ')}`);
  assert.ok(importsOf(fs.readFileSync(CLI_FILE, 'utf8')).every((specifier) => specifier === 'node:path' || CLI_ALLOWED.has(specifier)), 'o CLI importa só node:path e o módulo de atestação');
});

test('o único consumidor do arquivo evidence-to-prove fora da pasta de evidências é a prévia e a atestação (lista fechada)', () => {
  const evidenceRoot = path.join(ROOT, 'src', 'lib', 'link-audit-evidence');
  const importers = fs.readdirSync(path.join(ROOT, 'src', 'lib'), { recursive: true, encoding: 'utf8' })
    .filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.startsWith('link-audit-evidence'))
    .filter((rel) => importsOf(fs.readFileSync(path.join(ROOT, 'src', 'lib', rel), 'utf8')).some((s) => /link-audit-evidence\/evidence-to-prove$/.test(s)))
    .sort();
  assert.deepEqual(importers, ['link-audit-attestation/export.ts', 'link-audit-attestation/index.ts', 'link-audit-scoring-runs/preview.ts']);
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
