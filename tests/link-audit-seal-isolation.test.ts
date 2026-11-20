import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computePackageSha256, evidenceToProveFromBasis } from '../src/lib/link-audit-attestation';

/** P1 W4.2/W4.5: os ÚNICOS arquivos do `sign` que importam o verificador v2 (a cadeia/autoteste do manifesto e o fecho). */
const VERIFIER_ADAPTERS: ReadonlySet<string> = new Set(['sign-chain.ts', 'sign-closure.ts']);

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
const FILES = ['export-run.ts', 'export.ts', 'index.ts', 'package-hash.ts', 'schemas.ts', 'sign-args.ts', 'sign-chain.ts', 'sign-cli.ts', 'sign-closure.ts', 'sign-core.ts', 'sign-key.ts', 'sign-receipts.ts', 'sign-run.ts', 'sign-runtime.ts', 'sign-terminal.ts'];
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
  // injetado (tipo), nunca o leitor de evidências nem o armazenamento. W4.6 (§5.5.1 item 7): o NÚCLEO do verificador (sem disco padrão) e a
  // porta estreita de disco (só tipos), nunca a fachada provenance.ts nem o snapshot-store.
  'sign-chain.ts': new Set(['node:crypto', 'node:path', '../link-audit/fs-ops', '../link-audit-evidence/provenance-core', './schemas', './sign-core']),
  // P1 W4.3: o ÚNICO arquivo do `sign` que escreve (leitura única das entradas e gravação temporário + link() exclusivo), pelo FsOps injetado;
  // nunca o verificador (o texto gravado vem conferido de sign-chain.ts), o leitor de evidências nem o armazenamento
  'sign-run.ts': new Set(['node:crypto', 'node:path', '../link-audit/fs-ops', './schemas', './sign-chain', './sign-core']),
  // P1 W4.4: o terminal sem eco (modo bruto, restaurado no fim) e as telas da confirmação e da frase; nenhum import além dos tipos do núcleo
  'sign-terminal.ts': new Set(['./sign-core']),
  // P1 W4.4: a chave K1 (PKCS#8 cifrado + frase) e a custódia do arquivo; disco SÓ leitura (node:fs/promises, sem escrita) e só do arquivo de chave
  'sign-key.ts': new Set(['node:crypto', 'node:fs/promises', 'node:path', './sign-core']),
  // P1 W4.4: o analisador estrito do `sign` e as barreiras de segredo em argv e ambiente (§8.1); a lista com estado é validada por sign-chain.ts
  'sign-args.ts': new Set(['./schemas', './sign-chain', './sign-core', './sign-key']),
  // P1 W4.4: o comando `sign` (composição: argumentos → leitura única/cadeia/núcleo/gravação de sign-run.ts, terminal, chave K1, recibo); o disco
  // padrão é o nodeFsOps (o mesmo FsOps injetável de sign-run.ts); nunca o verificador direto. W4.6: o adaptador estreito (node-fs-ops) e a porta
  // (fs-ops), sem o snapshot-store; o bloco original do exec e o hash do artefato vêm de sign-runtime.ts
  'sign-cli.ts': new Set(['../link-audit/fs-ops', '../link-audit/node-fs-ops', './sign-args', './sign-chain', './sign-closure', './sign-core', './sign-key', './sign-receipts', './sign-run', './sign-runtime', './sign-terminal']),
  // P1 W4.6: a LEITURA do bloco original do exec (/proc/self/cmdline e /proc/self/environ, que um preload não altera ao limpar process.env) e o
  // SHA-256 dos bytes do próprio artefato (recibo); só leitura (node:fs/promises, regra estreita abaixo) e node:crypto (só o hash)
  'sign-runtime.ts': new Set(['node:crypto', 'node:fs/promises']),
  // P1 W4.5: o REGISTRO EXTERNO do fecho (pasta de recibos do passo 16, aberta UMA vez e lida só pelo descritor; esquema zod estrito, limites) e a
  // escolha das cabeças; disco SÓ leitura (node:fs/promises, regra estreita abaixo); nunca o verificador, nem por transitividade (revisão da W4.5)
  'sign-receipts.ts': new Set(['node:fs/promises', 'node:path', 'zod', './schemas', './sign-core']),
  // P1 W4.5: o lado VERIFICADOR do close-key (varredura somente leitura da cópia do servidor, fecho montado e assinado, autoteste com R
  // retired:<hash>); o segundo e último arquivo do sign que importa o verificador (a W4.6 separa o núcleo dele do FsOps de disco para os dois);
  // a gravação é a de sign-run.ts (temporário + link() exclusivo)
  'sign-closure.ts': new Set(['node:crypto', 'node:path', '../link-audit/fs-ops', '../link-audit-evidence/provenance-core', './schemas', './sign-chain', './sign-core', './sign-receipts', './sign-run']),
};
/** Exceções por arquivo às proibições abaixo, cada uma trocada por uma regra mais estreita (P1 W2). */
const NO_IMPLICIT_CLOCK: readonly [RegExp, string] = [/Date\.now|new Date\s*\(\s*\)|performance\.now/, 'relógio implícito'];
const EXCEPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  'export.ts': new Set(['Date']), // Date.parse/toISOString de datas recebidas (normalização); o instante vem de quem chama
  'export-run.ts': new Set(['Date', 'módulo node']), // só node:path (lista acima); o instante vem de quem chama
  'sign-core.ts': new Set(['Date', 'módulo node']), // relógio INJETADO (tipo Date); só createHash de node:crypto (teste abaixo)
  'sign-chain.ts': new Set(['módulo node']), // só node:crypto (assinar/derivar a pública) e node:path (lista acima); sem relógio
  'sign-run.ts': new Set(['módulo node', 'escrita']), // node:crypto (só randomBytes do nome do temporário) e node:path; escrita SÓ pela regra estreita abaixo
  'sign-key.ts': new Set(['módulo node']), // node:crypto (abrir a chave e derivar a pública), node:fs/promises SÓ leitura (regra estreita abaixo) e node:path
  'sign-receipts.ts': new Set(['módulo node']), // node:fs/promises SÓ leitura pelo descritor (regra estreita abaixo) e node:path
  'sign-runtime.ts': new Set(['módulo node']), // node:fs/promises SÓ leitura (regra estreita abaixo) e createHash de node:crypto
  'sign-closure.ts': new Set(['módulo node', 'Date']), // node:crypto (assinar o fecho, derivar a pública, SHA-256 dos bytes) e node:path; relógio INJETADO (tipo Date)
  'sign-cli.ts': new Set(['process', 'ambiente', 'Date']), // padrões injetáveis process.env/stdin/report (regra estreita abaixo: nomes do ambiente, nunca arquivo de ambiente); relógio INJETADO (tipo Date)
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
  // W4.6: a fábrica do NÚCLEO exige a porta de leitura (sem disco padrão): a fotografia somente leitura é sempre a injetada
  assert.ok(/createSealedEvidenceProvenanceOver\(\{[^}]*\bkeyring\b[^}]*\bacceptedVersions:\s*\[2\][^}]*\bfs:/.test(code), 'verificador com keyring, acceptedVersions: [2] e a porta injetada');
  assert.ok(!/\btrustedKeys\b/.test(code), 'trustedKeys é só de teste');
  assert.ok(!/\.(?:mkdir|writeExclusive|link|unlink|chmod|syncDirectory|rename|rm|truncate)\s*\(|publishExclusive|withLock|nodeFsOps|node:fs/.test(code), 'escrita ou disco implícito');
  for (const name of FILES.filter((file) => !VERIFIER_ADAPTERS.has(file) && file !== 'export-run.ts')) {
    const imported = importsOf(fs.readFileSync(path.join(LIB, name), 'utf8'));
    assert.ok(!imported.includes('../link-audit-evidence/provenance') && !imported.includes('../link-audit-evidence/provenance-core'), `${name} não importa o verificador (§5.5.1 item 7)`);
  }
  // W4.6: os dois adaptadores do verificador usam o NÚCLEO, nunca a fachada (que traz o disco padrão)
  for (const name of VERIFIER_ADAPTERS) assert.ok(!importsOf(fs.readFileSync(path.join(LIB, name), 'utf8')).includes('../link-audit-evidence/provenance'), `${name} importa a fachada do verificador`);
});

test('P1 W4.5: sign-closure.ts autotesta o fecho com o verificador REAL em modo produção (keyring, acceptedVersions [2]), só lê pelo FsOps injetado e nunca escreve (a gravação é a de sign-run.ts)', () => {
  const code = strip(fs.readFileSync(path.join(LIB, 'sign-closure.ts'), 'utf8'));
  assert.ok(/createSealedEvidenceProvenanceOver\(\{[^}]*\bkeyring\b[^}]*\bacceptedVersions:\s*\[2\][^}]*\bfs:/.test(code), 'verificador com keyring, acceptedVersions: [2] e a porta injetada');
  assert.ok(!/\btrustedKeys\b/.test(code), 'trustedKeys é só de teste');
  assert.ok(!/\.(?:mkdir|writeExclusive|link|unlink|chmod|syncDirectory|rename|rm|truncate)\s*\(|publishExclusive|withLock|nodeFsOps|node:fs/.test(code), 'escrita ou disco implícito');
  assert.ok(/\bpublishClosure\s*\(/.test(code), 'o fecho é gravado pela criação exclusiva de sign-run.ts');
});

test('P1 W4.5 (revisão, TOCTOU): sign-receipts.ts só LÊ, e a pasta de recibos é aberta UMA vez (O_RDONLY|O_DIRECTORY|O_NOFOLLOW) e enumerada e lida SÓ por /proc/self/fd/<fd>; cada recibo aberto O_RDONLY|O_NOFOLLOW|O_NONBLOCK; nunca o verificador, por import direto ou transitivo', () => {
  const code = strip(fs.readFileSync(path.join(LIB, 'sign-receipts.ts'), 'utf8'));
  assert.ok(!/writeFile|appendFile|\.write\s*\(|\.mkdir|\.mkdtemp|\.unlink|\.rm\s*\(|\.rmdir|\.rename|\.chmod|\.chown|\.link\s*\(|\.symlink|\.copyFile|\.truncate|createWriteStream|provenance|nodeFsOps/.test(code), 'escrita, disco implícito ou verificador');
  assert.ok(!/readFile\b|readFileBytes|\.realpath\s*\(/.test(code), 'nunca lê nem resolve por caminho (a leitura é pelo descritor)');
  const opens = [...code.matchAll(/\.open\s*\(([^;]*?)\)\s*;/g)].map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim());
  assert.deepEqual(opens, ['target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW', '`${base}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK'], 'dois opens: a pasta e cada recibo DENTRO dela');
  assert.ok(/const base = `\/proc\/self\/fd\/\$\{handle\.fd\}`/.test(code), 'a base de toda consulta é o descritor aberto');
  assert.deepEqual([...code.matchAll(/\.readlink\s*\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim()), ['base'], 'readlink só do descritor');
  assert.deepEqual([...code.matchAll(/\.opendir\s*\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim()).sort(), ['base', 'target'], 'opendir da pasta aberta (pelo descritor) e da raiz da cópia do servidor');
  const graph = reachableFrom(path.join(LIB, 'sign-receipts.ts'));
  for (const file of graph.keys()) assert.ok(!/(?:provenance|snapshot-store)\.ts$/.test(file), `sign-receipts.ts alcança ${path.relative(ROOT, file)}`);
});

test('P1 W4.5 (revisão, NIT): o padrão do id de chave mora no núcleo sem verificador (sign-core.ts); sign-chain.ts só o reexporta', async () => {
  const core = await import('../src/lib/link-audit-attestation/sign-core');
  const chain = await import('../src/lib/link-audit-attestation/sign-chain');
  assert.equal(chain.SIGN_KEY_ID_PATTERN, core.SIGN_KEY_ID_PATTERN);
  assert.ok(!/SIGN_KEY_ID_PATTERN\s*=/.test(strip(fs.readFileSync(path.join(LIB, 'sign-chain.ts'), 'utf8'))), 'sign-chain.ts não redefine o padrão');
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

const signCode = (name: string): string => strip(fs.readFileSync(path.join(LIB, name), 'utf8'));

test('P1 W4.4: sign-key.ts só LÊ do disco (um open somente leitura, sem seguir link e sem travar em FIFO; lstat e realpath) e nunca escreve, apaga, muda permissão nem lê o ambiente', () => {
  const code = signCode('sign-key.ts');
  assert.equal([...code.matchAll(/\.open\s*\(/g)].length, 1, 'um único open');
  assert.ok(/\.open\s*\(\s*target\s*,\s*constants\.O_RDONLY\s*\|\s*\(constants\.O_NOFOLLOW \?\? 0\)\s*\|\s*\(constants\.O_NONBLOCK \?\? 0\)\s*\)/.test(code), 'open O_RDONLY | O_NOFOLLOW | O_NONBLOCK');
  assert.ok(!/writeFile|appendFile|\.write\s*\(|\.mkdir|\.mkdtemp|\.unlink|\.rm\s*\(|\.rmdir|\.rename|\.chmod|\.chown|\.link\s*\(|\.symlink|\.copyFile|\.cp\s*\(|\.truncate|\.utimes|createWriteStream|['"]w\+?['"]|['"]a\+?['"]/.test(code), 'escrita no disco');
  assert.ok(!/process\./.test(code), 'ambiente do processo');
  // revisão da W4.4: o caminho real vem do DESCRITOR aberto (o mesmo que é lido), e só por /proc/self/fd
  assert.deepEqual([...code.matchAll(/\.readlink\s*\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim()), ['`/proc/self/fd/${handle.fd}`'], 'readlink só do descritor aberto');
  const reads = [...code.matchAll(/(\w+)\.read\s*\(/g)].map((m) => m[1]);
  assert.ok(reads.includes('handle') && reads.every((owner) => owner === 'handle' || owner === 'opened'), `leitura só pelo descritor aberto (${reads.join(', ')})`);
  assert.ok(!/readFile/.test(code), 'nunca lê de novo pelo caminho');
});

test('P1 W4.4: só sign-key.ts abre chave privada (createPrivateKey); a frase e a chave nunca passam por console, logger, ambiente nem relatório', () => {
  for (const name of SIGN_FILES) {
    const code = signCode(name);
    if (name !== 'sign-key.ts') assert.ok(!/createPrivateKey/.test(code), `${name} abre chave`);
    assert.ok(!/\bconsole\.|\/logger\b|process\.report\.write|writeReport/.test(code), `${name} registra ou despeja o processo`);
  }
});

test('P1 W4.4/W4.5: sign-cli.ts só usa de process os PADRÕES injetáveis (process.env, process.stdin, process.report e, na W4.5, process.execArgv e process.getuid), e do ambiente lê os NOMES (Object.keys)', () => {
  const code = signCode('sign-cli.ts');
  const uses = [...code.matchAll(/process\.(\w+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0 && uses.every((use) => use === 'env' || use === 'stdin' || use === 'report' || use === 'execArgv' || use === 'getuid'), `process.${uses.join(', process.')}`);
  assert.ok(/Object\.keys\(env\)/.test(code), 'a barreira do §8.1 olha os nomes');
  const fileOfEnvironment = new RegExp(['dot' + 'env', 'loadEnvConfig', `['"\`]\\.${'env'}`].join('|'));
  assert.ok(!fileOfEnvironment.test(code), 'nunca lê arquivo de ambiente');
  for (const name of SIGN_FILES.filter((file) => file !== 'sign-cli.ts')) assert.ok(!/process\./.test(signCode(name)), `${name} usa process`);
});

/** Arquivo `.ts` de um import relativo ou `@/` (= `src/`); `null` para pacote externo ou módulo `node:`. Import local que não resolve falha o teste. */
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null;
  if (base === null) return null;
  const found = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found ?? assert.fail(`import local não resolvido: "${specifier}" em ${path.relative(ROOT, from)}`);
}

/** Todos os arquivos locais alcançáveis a partir de `entry` (imports relativos, inclusive `import type`, que só deixam o teste mais estrito). */
function reachableFrom(entry: string): ReadonlyMap<string, readonly string[]> {
  const seen = new Map<string, readonly string[]>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    const specifiers = importsOf(fs.readFileSync(file, 'utf8'));
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      const local = resolveLocal(file, specifier);
      if (local !== null) pending.push(local);
    }
  }
  return seen;
}

/** O que nenhum arquivo alcançável pelo núcleo do `sign` pode importar: o verificador, disco, rede, processos ou o armazenamento. */
const SIGN_CORE_FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/link-audit-evidence\/provenance$/, 'o verificador'],
  [/^(?:node:)?fs(?:\/promises)?$/, 'disco'],
  [/^(?:node:)?(?:net|dns|http|https|http2|tls|dgram)(?:\/|$)|^(?:undici|ioredis|bullmq|@supabase\/)/, 'rede'],
  [/^(?:node:)?(?:child_process|worker_threads|cluster)$/, 'processo'],
  [/snapshot-store$/, 'o armazenamento (snapshot-store)'],
];

test('P1 W4.1 (revisão): o núcleo sign-core.ts, por TODO import local alcançável (não só os diretos), nunca chega ao verificador, a disco, rede nem ao snapshot-store', () => {
  const graph = reachableFrom(path.join(LIB, 'sign-core.ts'));
  const files = [...graph.keys()].map((file) => path.relative(ROOT, file).split(path.sep).join('/')).sort();
  assert.deepEqual(files, [
    'src/lib/link-audit-attestation/package-hash.ts',
    'src/lib/link-audit-attestation/schemas.ts',
    'src/lib/link-audit-attestation/sign-core.ts',
    'src/lib/link-audit-evidence/types.ts',
    'src/lib/link-audit/canonical.ts',
  ], 'arquivo novo no grafo do núcleo exige decisão e revisão deste teste');
  for (const [file, specifiers] of graph) {
    const where = path.relative(ROOT, file);
    for (const specifier of specifiers) {
      for (const [pattern, label] of SIGN_CORE_FORBIDDEN) assert.ok(!pattern.test(specifier), `${where} importa ${label} ("${specifier}")`);
      const local = resolveLocal(file, specifier);
      if (local !== null) assert.ok(!/(?:provenance|snapshot-store)\.ts$/.test(local), `${where} alcança ${path.relative(ROOT, local)}`);
    }
  }
  const external = new Set([...graph].flatMap(([file, specifiers]) => specifiers.filter((specifier) => resolveLocal(file, specifier) === null)));
  assert.deepEqual([...external].sort(), ['node:crypto', 'zod'], 'de fora do repositório, só node:crypto e zod');
});

/**
 * Carregamento dinâmico que a lista fechada de imports não enxerga: `import(` cujo argumento não é UMA string literal simples (concatenação,
 * template, variável), e qualquer `require` (`require(`, `require.resolve`, `module.require`, `createRequire`). Devolve o que achou.
 */
function dynamicLoads(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/\bimport\s*\(/g)) {
    const rest = code.slice(match.index);
    if (!/^import\s*\(\s*(['"])[^'"`$\\\n]*\1\s*\)/.test(rest)) found.push(rest.slice(0, 40));
  }
  // qualquer ocorrência solta do identificador (`require(`, `(require)(…)`, `const r = require`…), não só a chamada direta (confirmação da W4.2)
  for (const match of code.matchAll(/\brequire\b|\bcreateRequire\b/g)) found.push(match[0]);
  return found;
}

test('dynamicLoads enxerga import() com nome calculado e require; import() com string literal passa', () => {
  assert.deepEqual(dynamicLoads("const a = await import('./x');\nconst b = await import(\"node:crypto\");"), []);
  for (const code of ["import('./' + 'x')", 'import(`./${name}`)', 'import(name)', "import( './x' + y)", "require('x')", "require.resolve('x')", "module.require('x')", "createRequire(url)", "(require)('node:' + 'fs')", "const r = require; r('fs')"]) {
    assert.equal(dynamicLoads(code).length > 0, true, code);
  }
});

/** Arquivos do `sign` (`sign-*.ts`); arquivo novo do `sign` exige revisão desta lista. */
const SIGN_FILES = FILES.filter((name) => name.startsWith('sign-'));

test('confirmação da revisão da W4.1: nos arquivos do sign, nenhum import() com nome calculado e nenhum require (o grafo de imports fica todo visível)', () => {
  assert.deepEqual(SIGN_FILES, ['sign-args.ts', 'sign-chain.ts', 'sign-cli.ts', 'sign-closure.ts', 'sign-core.ts', 'sign-key.ts', 'sign-receipts.ts', 'sign-run.ts', 'sign-runtime.ts', 'sign-terminal.ts']);
  for (const name of SIGN_FILES) assert.deepEqual(dynamicLoads(strip(fs.readFileSync(path.join(LIB, name), 'utf8'))), [], `${name}: carregamento dinâmico`);
});

test('confirmação da revisão da W4.2: nenhum arquivo ALCANÇÁVEL a partir dos arquivos do sign (dependências transitivas, inclusive o verificador) usa import() com nome calculado ou require', () => {
  const reached = new Set<string>();
  for (const name of SIGN_FILES) for (const file of reachableFrom(path.join(LIB, name)).keys()) reached.add(file);
  assert.ok(reached.size > SIGN_FILES.length, 'o grafo percorrido vai além dos próprios arquivos do sign');
  for (const file of reached) assert.deepEqual(dynamicLoads(strip(fs.readFileSync(file, 'utf8'))), [], `${path.relative(ROOT, file)}: carregamento dinâmico`);
});

/** Spec §5.5.1 item 7 (RS-14): a lista LITERAL de módulos node que o artefato único pode carregar (`zod` vai embutido). */
const ARTIFACT_NODE_MODULES: readonly string[] = ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:readline', 'node:process'];

test('P1 W4.6 (§5.5.1 item 7): pelo grafo de FONTES a partir da entrada do artefato, o sign e o close-key não alcançam o export, o snapshot-store, a fachada do verificador nem a cadeia de rede (evidence → url-safety); de fora, só a lista literal e o zod', () => {
  const graph = reachableFrom(path.join(ROOT, 'scripts', 'link-audit-sign-artifact.ts'));
  const files = [...graph.keys()].map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  for (const forbidden of [/link-audit-attestation\/export(?:-run)?\.ts$/, /snapshot-store\.ts$/, /link-audit-evidence\/provenance\.ts$/, /link-audit\/evidence\.ts$/, /url-safety\.ts$/, /link-audit-evidence\/(?:reader|store|scoring-basis)\.ts$/, /scripts\/link-audit-seal\.ts$/]) {
    assert.ok(!files.some((file) => forbidden.test(file)), `o artefato alcança ${files.find((file) => forbidden.test(file))}`);
  }
  assert.ok(files.includes('src/lib/link-audit-evidence/provenance-core.ts') && files.includes('src/lib/link-audit/fs-ops.ts') && files.includes('src/lib/link-audit/node-fs-ops.ts'), 'o núcleo do verificador e a porta estreita estão no grafo');
  const external = new Set([...graph].flatMap(([file, specifiers]) => specifiers.filter((specifier) => resolveLocal(file, specifier) === null)));
  for (const specifier of external) assert.ok(specifier === 'zod' || ARTIFACT_NODE_MODULES.includes(specifier), `módulo de fora da lista literal no grafo do artefato: ${specifier}`);
  for (const file of graph.keys()) assert.deepEqual(dynamicLoads(strip(fs.readFileSync(file, 'utf8'))), [], `${path.relative(ROOT, file)}: carregamento dinâmico`);
});

test('P1 W4.6: sign-runtime.ts só LÊ (o bloco original do exec em /proc/self e os bytes do artefato), pelo descritor aberto O_RDONLY|O_NOFOLLOW|O_NONBLOCK, com teto; nunca escreve, nunca usa process nem decodifica valores do ambiente', () => {
  const code = signCode('sign-runtime.ts');
  assert.equal([...code.matchAll(/\.open\s*\(/g)].length, 1, 'um único open');
  assert.ok(/\.open\s*\(\s*target\s*,\s*constants\.O_RDONLY\s*\|\s*\(constants\.O_NOFOLLOW \?\? 0\)\s*\|\s*\(constants\.O_NONBLOCK \?\? 0\)\s*\)/.test(code), 'open O_RDONLY | O_NOFOLLOW | O_NONBLOCK');
  assert.ok(!/writeFile|appendFile|\.write\s*\(|\.mkdir|\.mkdtemp|\.unlink|\.rm\s*\(|\.rmdir|\.rename|\.chmod|\.chown|\.link\s*\(|\.symlink|\.copyFile|\.truncate|createWriteStream|readFile\b|\.realpath\s*\(/.test(code), 'escrita ou leitura por caminho fora do descritor');
  assert.ok(!/process\./.test(code), 'process');
  assert.deepEqual([...code.matchAll(/'\/proc\/self\/(\w+)'/g)].map((m) => m[1]).sort(), ['cmdline', 'environ'], 'só o bloco original do exec');
  assert.deepEqual([...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:crypto'/g)].map((m) => (m[1] ?? '').trim()), ['createHash'], 'de node:crypto só o hash');
});

/** P1 W2: o CLI `scripts/link-audit-seal.ts` é o ÚNICO consumidor, e só destes arquivos; P1 W4.4: o `sign` entra por UM arquivo, sign-cli.ts. */
const CLI_FILE = path.join(ROOT, 'scripts', 'link-audit-seal.ts');
const CLI_ALLOWED: ReadonlySet<string> = new Set(['@/lib/link-audit-attestation/export', '@/lib/link-audit-attestation/export-run', '@/lib/link-audit-attestation/schemas', '@/lib/link-audit-attestation/sign-cli']);
/** P1 W4.6: a entrada do ARTEFATO ÚNICO (sign e close-key, sem o export) é o segundo consumidor, e só de sign-cli.ts. */
const ARTIFACT_ENTRY = path.join(ROOT, 'scripts', 'link-audit-sign-artifact.ts');

test('consumidores: só o CLI link-audit-seal (export, export-run, schemas e sign-cli) e a entrada do artefato (só sign-cli) importam o módulo; src/ e os demais scripts não', () => {
  const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
  assert.deepEqual(importsOf(fs.readFileSync(ARTIFACT_ENTRY, 'utf8')).filter((specifier) => /link-audit-attestation/.test(specifier)), ['../src/lib/link-audit-attestation/sign-cli'], 'a entrada do artefato importa só sign-cli');
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]) {
    if (file.startsWith(LIB + path.sep) || file === CLI_FILE || file === ARTIFACT_ENTRY) continue;
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
