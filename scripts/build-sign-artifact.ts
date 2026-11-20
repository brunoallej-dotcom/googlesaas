/**
 * BUILD do artefato único do `sign`/`close-key` (P1 W4.6; spec `docs/specs/link-audit-p1-attestation.md` §5.5.1 itens 5–7; IA-03 artefato, IA-24).
 *
 *   npm run link-audit:sign-artifact -- [--out <pasta>] [--check]
 *
 * Empacota `scripts/link-audit-sign-artifact.ts` com o esbuild travado no lockfile (0.28.2), com opções FIXAS (bundle, node, cjs, target node22, sem
 * sourcemap, sem comentários, ASCII, só o espaço em branco minificado, zod embutido, caminhos relativos à raiz do repositório, sem ler o
 * tsconfig.json), e só grava o arquivo depois das guardas sobre a SAÍDA:
 *  - pelo `metafile`, todo import que sobrou no arquivo é externo, por `require` estático, e está na lista LITERAL do §5.5.1 item 7;
 *  - pelo texto do arquivo final, todo `require(` tem como argumento uma dessas strings literais; nenhum `import(`, `require.resolve`,
 *    `module.require`, `createRequire`, `process.binding` ou `process.dlopen`;
 *  - nenhum caminho absoluto da máquina do build no arquivo (build reprodutível em qualquer pasta).
 * Imprime `<sha256>  link-audit-sign.cjs` (formato do `sha256sum`). `--check` compara com o hash versionado em
 * `docs/phase6-auditoria-link/p1-sign-artifact.sha256` e falha se diferir. Sem rede: o esbuild roda localmente.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build, type BuildOptions, type Metafile } from 'esbuild';

/** Spec §5.5.1 item 7 (RS-14): os ÚNICOS módulos que o artefato pode carregar (`zod` vai embutido). */
export const ARTIFACT_NODE_MODULES: readonly string[] = ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:readline', 'node:process'];
export const ARTIFACT_FILE_NAME = 'link-audit-sign.cjs';
export const REPO_ROOT = path.resolve(__dirname, '..');
export const ARTIFACT_ENTRY = path.join(REPO_ROOT, 'scripts', 'link-audit-sign-artifact.ts');
export const VERSIONED_HASH_FILE = path.join(REPO_ROOT, 'docs', 'phase6-auditoria-link', 'p1-sign-artifact.sha256');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.cache', 'sign-artifact');
/** Formas de carregar código que a lista de imports não enxerga; nenhuma pode aparecer no arquivo final. */
const FORBIDDEN_LOADERS: readonly RegExp[] = [/\bimport\s*\(/, /\brequire\s*\.\s*resolve\b/, /\bmodule\s*\.\s*require\b/, /\bcreateRequire\b/, /\bprocess\s*\.\s*binding\b/, /\bprocess\s*\.\s*dlopen\b/];
const REQUIRE_CALL = /\brequire\s*\(/g;
const LITERAL_REQUIRE = /^require\s*\(\s*"([^"\\]+)"\s*\)/;

export type ArtifactBuildErrorCode = 'IMPORT_NOT_ALLOWED' | 'DYNAMIC_LOAD' | 'ABSOLUTE_PATH' | 'BUILD_FAILED' | 'HASH_MISMATCH';

/** Falha tipada do build (código fixo; a mensagem cita só o módulo ou a regra, nunca conteúdo de arquivo). */
export class ArtifactBuildError extends Error {
  readonly code: ArtifactBuildErrorCode;
  constructor(code: ArtifactBuildErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactBuildError';
    this.code = code;
  }
}

/** As opções FIXAS do esbuild (qualquer mudança aqui muda o hash versionado). */
export function artifactBuildOptions(entry: string, outfile: string): BuildOptions & { readonly metafile: true; readonly write: false } {
  return {
    absWorkingDir: REPO_ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    charset: 'ascii',
    // só o espaço em branco (e, com ele, TODO comentário, inclusive os das dependências, que poderiam conter "import(" ou "require(" e confundir a
    // guarda textual); nomes e sintaxe ficam como estão. O fonte auditável é o do repositório; o artefato é o build reprodutível dele
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    treeShaking: true,
    // o node_modules de um worktree pode ser link simbólico: os caminhos (comentários do bundle) ficam relativos à raiz do repositório
    preserveSymlinks: true,
    // nada do tsconfig.json do projeto entra no artefato (um ajuste do Next não muda o hash)
    tsconfigRaw: {},
    define: { LINK_AUDIT_SIGN_ARTIFACT: 'true' },
    metafile: true,
    write: false,
    logLevel: 'silent',
  };
}

/** Pelo metafile: os imports que sobraram no arquivo de saída são externos, estáticos (`require`) e da lista literal. */
function checkMetafileImports(metafile: Metafile): string[] {
  const outputs = Object.values(metafile.outputs);
  if (outputs.length !== 1) throw new ArtifactBuildError('BUILD_FAILED', `o build devia gerar 1 arquivo (gerou ${outputs.length})`);
  const imports = (outputs[0] as Metafile['outputs'][string]).imports;
  for (const item of imports) {
    if (item.kind !== 'require-call') throw new ArtifactBuildError('DYNAMIC_LOAD', `import "${item.path}" de tipo ${item.kind} no artefato (só require estático)`);
    if (item.external !== true || !ARTIFACT_NODE_MODULES.includes(item.path)) throw new ArtifactBuildError('IMPORT_NOT_ALLOWED', `import "${item.path}" fora da lista literal do §5.5.1 item 7`);
  }
  return [...new Set(imports.map((item) => item.path))].sort();
}

/** Pelo texto do arquivo final: cada `require(` com string literal da lista; nenhuma outra forma de carregar código; nenhum caminho absoluto. */
export function checkArtifactText(text: string, absolutePaths: readonly string[]): string[] {
  for (const pattern of FORBIDDEN_LOADERS) if (pattern.test(text)) throw new ArtifactBuildError('DYNAMIC_LOAD', `carregamento dinâmico no artefato (${pattern.source})`);
  const required = new Set<string>();
  for (const match of text.matchAll(REQUIRE_CALL)) {
    const literal = LITERAL_REQUIRE.exec(text.slice(match.index));
    if (!literal) throw new ArtifactBuildError('DYNAMIC_LOAD', 'require com argumento que não é string literal no artefato');
    const specifier = literal[1] as string;
    if (!ARTIFACT_NODE_MODULES.includes(specifier)) throw new ArtifactBuildError('IMPORT_NOT_ALLOWED', `require("${specifier}") fora da lista literal do §5.5.1 item 7`);
    required.add(specifier);
  }
  for (const absolute of absolutePaths) if (absolute.length > 1 && text.includes(absolute)) throw new ArtifactBuildError('ABSOLUTE_PATH', 'caminho absoluto da máquina do build no artefato');
  return [...required].sort();
}

export interface BuiltArtifact {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: Buffer;
  /** Os módulos que o arquivo final carrega (subconjunto da lista literal). */
  readonly requires: readonly string[];
}

/** Monta, confere e só então grava `<outDir>/link-audit-sign.cjs` (0444). Qualquer guarda que falha ⇒ `ArtifactBuildError`, nada gravado. */
export async function buildSignArtifact(options: { readonly outDir: string; readonly entry?: string }): Promise<BuiltArtifact> {
  const file = path.join(path.resolve(options.outDir), ARTIFACT_FILE_NAME);
  let result: Awaited<ReturnType<typeof build<ReturnType<typeof artifactBuildOptions>>>>;
  try {
    result = await build(artifactBuildOptions(options.entry ?? ARTIFACT_ENTRY, file));
  } catch {
    throw new ArtifactBuildError('BUILD_FAILED', 'o esbuild recusou o build (rode com logLevel para ver o motivo)');
  }
  const fromMetafile = checkMetafileImports(result.metafile);
  const output = result.outputFiles.find((candidate) => candidate.path === file);
  if (!output || result.outputFiles.length !== 1) throw new ArtifactBuildError('BUILD_FAILED', 'saída inesperada do esbuild');
  const bytes = Buffer.from(output.contents);
  const realRoot = fs.realpathSync(REPO_ROOT);
  const realModules = fs.existsSync(path.join(REPO_ROOT, 'node_modules')) ? fs.realpathSync(path.join(REPO_ROOT, 'node_modules')) : realRoot;
  const requires = checkArtifactText(bytes.toString('utf8'), [REPO_ROOT, realRoot, realModules, path.dirname(file)]);
  if (requires.join('\n') !== fromMetafile.join('\n')) throw new ArtifactBuildError('IMPORT_NOT_ALLOWED', 'o texto do artefato e o metafile divergem nos imports');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, 0o444);
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes, requires };
}

/** A linha do arquivo versionado (`<sha256>  link-audit-sign.cjs`, formato do `sha256sum -c`). */
export function hashLine(sha256: string): string {
  return `${sha256}  ${ARTIFACT_FILE_NAME}`;
}

/** O SHA-256 versionado (primeira linha do arquivo, no formato do `sha256sum`). */
export function versionedSha256(): string {
  const line = fs.readFileSync(VERSIONED_HASH_FILE, 'utf8').split('\n')[0] ?? '';
  const match = /^([0-9a-f]{64}) {2}link-audit-sign\.cjs$/.exec(line);
  if (!match) throw new ArtifactBuildError('HASH_MISMATCH', `${path.relative(REPO_ROOT, VERSIONED_HASH_FILE)} fora do formato "<sha256>  ${ARTIFACT_FILE_NAME}"`);
  return match[1] as string;
}

async function main(argv: readonly string[]): Promise<number> {
  const outAt = argv.indexOf('--out');
  const outDir = outAt >= 0 ? argv[outAt + 1] : DEFAULT_OUT_DIR;
  if (outDir === undefined || outDir.startsWith('--') || argv.some((arg, index) => arg.startsWith('--') && arg !== '--out' && arg !== '--check' && index !== outAt + 1)) {
    console.error('Uso: npm run link-audit:sign-artifact -- [--out <pasta>] [--check]');
    return 1;
  }
  try {
    const built = await buildSignArtifact({ outDir });
    console.log(hashLine(built.sha256));
    console.error(`Artefato: ${path.relative(process.cwd(), built.file) || built.file} (${built.bytes.length} bytes); módulos: ${built.requires.join(', ')}`);
    if (!argv.includes('--check')) return 0;
    const expected = versionedSha256();
    if (expected === built.sha256) return 0;
    console.error(`FALHA: o hash recompilado difere do versionado em ${path.relative(REPO_ROOT, VERSIONED_HASH_FILE)} (${expected}). Build não reprodutível ou fonte mudada sem atualizar o hash.`);
    return 3;
  } catch (error) {
    console.error(error instanceof ArtifactBuildError ? `FALHA (${error.code}): ${error.message}` : 'FALHA inesperada no build do artefato.');
    return 3;
  }
}

if (/build-sign-artifact\.ts$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 4;
    },
  );
}
