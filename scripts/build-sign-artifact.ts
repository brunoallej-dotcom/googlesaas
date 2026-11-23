/**
 * BUILD do artefato único do `sign`/`close-key` (P1 W4.6; spec `docs/specs/link-audit-p1-attestation.md` §5.5.1 itens 5–7; IA-03 artefato, IA-24).
 *
 *   npm run link-audit:sign-artifact -- [--out <pasta>] [--check]
 *
 * Empacota `scripts/link-audit-sign-artifact.ts` com o esbuild travado no lockfile (0.28.2), com opções FIXAS (bundle, node, cjs, target node22, sem
 * sourcemap, sem comentários, ASCII, só o espaço em branco minificado, zod embutido, caminhos relativos à raiz do repositório, sem ler o
 * tsconfig.json), e só grava o arquivo depois das guardas sobre a SAÍDA:
 *  - pelo `metafile`, todo import que sobrou no arquivo é externo, por `require` estático, e está na lista LITERAL do §5.5.1 item 7;
 *  - pelo texto do arquivo final, TODA ocorrência do identificador `require` é exatamente `require("<módulo da lista>")` (nunca como valor, membro
 *    ou com nome calculado), e não há outra forma de carregar código: `getBuiltinModule`, `process.binding`, `_linkedBinding`, `createRequire`,
 *    `module.constructor`, `_load`, `mainModule`, `process.dlopen`, `import(`, `import.meta`, `eval` nem `Function` (revisão independente da W4.6: no
 *    Node 22 o modelo de permissões não restringe rede, e esta guarda é o controle). O zod embutido tem quatro usos exatos de `Function`, cada um
 *    aceito uma única vez, pela função inteira, com texto exato e SHA-256 (`ZOD_FUNCTION_EXCEPTIONS`);
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
/** Formas de carregar ou gerar código que a lista de imports não enxerga; nenhuma pode aparecer no arquivo final (fora das exceções do zod). */
const FORBIDDEN_LOADERS: readonly RegExp[] = [
  /\bimport\s*\(/,
  /\bimport\s*\.\s*meta\b/,
  /\bgetBuiltinModule\b/,
  /\bprocess\s*\.\s*binding\b/,
  /\b_linkedBinding\b/,
  /\bcreateRequire\b/,
  /\bmodule\s*\.\s*constructor\b/,
  /\b_load\b/,
  /\bmainModule\b/,
  /\bprocess\s*\.\s*dlopen\b/,
  /\beval\b/,
  /\bFunction\b/,
];
/**
 * Os ÚNICOS usos de `Function` aceitos, todos do zod embutido. Cada exceção fixa a função (ou o trecho) INTEIRA, do começo ao fim, pelo texto exato
 * da saída e pelo SHA-256 dele (confirmação da revisão da W4.6): qualquer caractere diferente, inclusive um uso a mais do apelido `F`, deixa o trecho
 * sem exceção e a guarda recusa. Cada uma é retirada UMA vez (o teste confere que aparece exatamente uma vez). Uma versão nova do zod que mude esses
 * trechos faz o build falhar e exige revisão. Em execução o JIT do zod fica desligado (`jitless`, na entrada do artefato): `Function` não é chamado.
 *  1. `util.allowsEval`: testa se o runtime permite gerar código (com `jitless`, devolve `false` sem testar);
 *  2. `Doc.compile` (`core/doc.js`): o JIT dos validadores de objeto (gera a checagem a partir do próprio esquema, não de dado externo);
 *  3. `compileFn` (`core/compile.js`, o `z.compile`): o compilador de esquema, no mesmo molde (o `sign` não o chama; vem com o namespace `z`);
 *  4. uma mensagem de erro do conversor para JSON Schema (texto, não código).
 */
export interface ZodFunctionException {
  readonly name: string;
  /** SHA-256 (hex) do texto exato, conferido antes de usar a exceção. */
  readonly sha256: string;
  readonly text: string;
}
export const ZOD_FUNCTION_EXCEPTIONS: readonly ZodFunctionException[] = [
  { name: "util.allowsEval", sha256: 'fa7e25cf83d803b31a5a54bac35f61b4b40801e8681aae5841ab747f4826adc1', text: "var allowsEval=cached(()=>{if(globalConfig.jitless){return false}if(typeof navigator!==\"undefined\"&&navigator?.userAgent?.includes(\"Cloudflare\")){return false}try{const F=Function;new F(\"\");return true}catch(_){return false}});" },
  { name: "Doc.compile", sha256: '376c0306f6ed21873e7c3d92ccac27654c762627d1cdfb0295b3be2ffc0c503b', text: "compile(){const F=Function;const content=this?.content??[``];const factory=new F(...Object.keys(this.closed),`return function (${this.args.join(\", \")}) {\n${content.join(\"\\n\")}\n};`);return factory(...Object.values(this.closed))}" },
  { name: "z.compile (compileFn)", sha256: '8c9b3de26386ed6dd195497338074a654204def27b5fbc63c1d2aaffd106e05f', text: "function compileFn(schema,options){let recursive2=true;try{recursive2=isRecursiveSchema(schema)}catch{}if(recursive2){throw new ZodCompileUnsupportedError(\"a schema whose subtree contains a reference cycle\")}const ctx={constants:new Map,constantCounter:0,varCounter:0,definite:true};const doc=new Doc([\"input\"]);const outputAccessor=generateCheck(doc,ctx,schema,\"input\",!options?.assertOnly);doc.write(outputAccessor===null?`return true;`:`return ${outputAccessor};`);const constantNames=[\"INVALID\",...ctx.constants.keys()];const constantValues=[INVALID,...ctx.constants.values()];const code=doc.content.join(\"\\n\");const fullCode=options?.debug?constantNames.length>0?`// Constants: ${constantNames.join(\", \")}\n${code}`:code:\"\";const F=Function;const factoryCode=`return (input) => {\n${code}\n}`;let fn;try{const factory=new F(...constantNames,factoryCode);fn=factory(...constantValues)}catch(err){throw new ZodCompileUnsupportedError(`this schema (generated code failed to evaluate: ${err.message})`)}if(options?.debug){fn.code=fullCode}fn.definite=ctx.definite;return fn}" },
  { name: "mensagem do JSON Schema", sha256: '7e8d10bad68261d6821a3ddf11bba04395bdb48b9a729d9c572af427d9631de0', text: "\"Function types cannot be represented in JSON Schema\"" },
];
const REQUIRE_IDENTIFIER = /\brequire\b/g;
const LITERAL_REQUIRE = /^require\s*\(\s*"([^"\\]+)"\s*\)/;
const MEMBER_ACCESS = /[.?]\s*$/;

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

/**
 * Pelo metafile: os imports que sobraram no arquivo de saída são externos, estáticos (`require`) e da lista literal. `allowed` só muda para os
 * artefatos dos receptores (P9.3a, `scripts/build-receivers-artifact.ts`), cada um com a própria lista literal.
 */
export function checkMetafileImports(metafile: Metafile, allowed: readonly string[] = ARTIFACT_NODE_MODULES): string[] {
  const outputs = Object.values(metafile.outputs);
  if (outputs.length !== 1) throw new ArtifactBuildError('BUILD_FAILED', `o build devia gerar 1 arquivo (gerou ${outputs.length})`);
  const imports = (outputs[0] as Metafile['outputs'][string]).imports;
  for (const item of imports) {
    if (item.kind !== 'require-call') throw new ArtifactBuildError('DYNAMIC_LOAD', `import "${item.path}" de tipo ${item.kind} no artefato (só require estático)`);
    if (item.external !== true || !allowed.includes(item.path)) throw new ArtifactBuildError('IMPORT_NOT_ALLOWED', `import "${item.path}" fora da lista literal do §5.5.1 item 7`);
  }
  return [...new Set(imports.map((item) => item.path))].sort();
}

/**
 * Pelo texto do arquivo final: toda ocorrência do identificador `require` é uma chamada direta com string literal da lista; nenhuma outra forma de
 * carregar ou gerar código (cada exceção do zod, inteira e conferida pelo SHA-256, é retirada UMA vez antes da busca); nenhum caminho absoluto.
 */
export function checkArtifactText(text: string, absolutePaths: readonly string[], allowed: readonly string[] = ARTIFACT_NODE_MODULES): string[] {
  for (const exception of ZOD_FUNCTION_EXCEPTIONS) {
    if (createHash('sha256').update(exception.text, 'utf8').digest('hex') !== exception.sha256) throw new ArtifactBuildError('BUILD_FAILED', `exceção do zod "${exception.name}" com texto que não confere com o SHA-256 fixado`);
  }
  const searched = ZOD_FUNCTION_EXCEPTIONS.reduce((current, exception) => current.replace(exception.text, ''), text);
  for (const pattern of FORBIDDEN_LOADERS) if (pattern.test(searched)) throw new ArtifactBuildError('DYNAMIC_LOAD', `carregamento ou geração de código no artefato (${pattern.source})`);
  const required = new Set<string>();
  for (const match of text.matchAll(REQUIRE_IDENTIFIER)) {
    const literal = LITERAL_REQUIRE.exec(text.slice(match.index));
    if (!literal || MEMBER_ACCESS.test(text.slice(0, match.index))) throw new ArtifactBuildError('DYNAMIC_LOAD', 'require como valor, membro ou com argumento que não é string literal no artefato');
    const specifier = literal[1] as string;
    if (!allowed.includes(specifier)) throw new ArtifactBuildError('IMPORT_NOT_ALLOWED', `require("${specifier}") fora da lista literal do §5.5.1 item 7`);
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
