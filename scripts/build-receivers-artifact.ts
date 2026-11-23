/**
 * BUILD dos artefatos únicos dos RECEPTORES do host (P9.3a; spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.6 "Instalação", §5.7).
 *
 *   npm run deploy:receivers-artifact -- [--out <pasta>] [--check]
 *
 * O mesmo padrão do artefato do `sign` (`scripts/build-sign-artifact.ts`), reaproveitado e não copiado: o esbuild travado no lockfile, as MESMAS
 * opções fixas (`artifactBuildOptions`, só o `define` muda) e as MESMAS guardas sobre a saída (`checkMetafileImports` e `checkArtifactText`), cada
 * artefato com a própria lista LITERAL de módulos. O arquivo só é gravado (`0444`) depois das guardas.
 * Imprime uma linha `<sha256>  <arquivo>` por artefato (formato do `sha256sum`). `--check` compara com `deploy/hostinger/receivers.sha256`, que tem
 * exatamente uma linha por artefato de `RECEIVER_ARTIFACTS`, na mesma ordem (linhas que começam com `#` são comentários, ignorados também pelo
 * `sha256sum -c`). O responsável instala no host só o que passou no `sha256sum -c` desse arquivo no commit; o CI nunca atualiza receptor. Sem rede.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { ArtifactBuildError, artifactBuildOptions, checkArtifactText, checkMetafileImports, REPO_ROOT, type BuiltArtifact } from './build-sign-artifact';

export interface ReceiverArtifactSpec {
  readonly fileName: string;
  readonly entry: string;
  /** Identificador definido como `true` só no build (a entrada usa para saber que é o artefato). */
  readonly defineName: string;
  /** Lista LITERAL dos únicos módulos que o arquivo final pode carregar (por `require` estático). */
  readonly modules: readonly string[];
}

/** Receptor de deploy (§5.6): disco, SHA-256, caminhos e `execFile` (só `docker`, `tar`, `gzip` e o script de pastas, sem shell). */
export const DEPLOY_RECEIVER_NODE_MODULES: readonly string[] = ['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path'];
export const DEPLOY_RECEIVER_FILE_NAME = 'gmn-deploy-receiver.cjs';

/**
 * Os artefatos, na ordem das linhas de `receivers.sha256`. A P9.3b acrescenta aqui o receptor de manifestos (`gmn-seal-receiver.cjs`, sem
 * `node:child_process`) e a linha dele no arquivo de hash, no mesmo PR.
 */
export const RECEIVER_ARTIFACTS: readonly ReceiverArtifactSpec[] = [
  { fileName: DEPLOY_RECEIVER_FILE_NAME, entry: path.join(REPO_ROOT, 'scripts', 'deploy-receiver.ts'), defineName: 'GMN_DEPLOY_RECEIVER_ARTIFACT', modules: DEPLOY_RECEIVER_NODE_MODULES },
];
export const RECEIVERS_HASH_FILE = path.join(REPO_ROOT, 'deploy', 'hostinger', 'receivers.sha256');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.cache', 'receivers-artifact');
const HASH_LINE = /^([0-9a-f]{64}) {2}([a-z0-9][a-z0-9.-]*\.cjs)$/;

/** Monta, confere e só então grava `<outDir>/<arquivo>` (0444). Qualquer guarda que falha ⇒ `ArtifactBuildError`, nada gravado. */
export async function buildReceiverArtifact(spec: ReceiverArtifactSpec, options: { readonly outDir: string; readonly entry?: string }): Promise<BuiltArtifact> {
  const file = path.join(path.resolve(options.outDir), spec.fileName);
  const buildOptions = { ...artifactBuildOptions(options.entry ?? spec.entry, file), define: { [spec.defineName]: 'true' } };
  let result: Awaited<ReturnType<typeof build<typeof buildOptions>>>;
  try {
    result = await build(buildOptions);
  } catch {
    throw new ArtifactBuildError('BUILD_FAILED', `o esbuild recusou o build de ${spec.fileName} (rode com logLevel para ver o motivo)`);
  }
  const fromMetafile = checkMetafileImports(result.metafile, spec.modules);
  const output = result.outputFiles.find((candidate) => candidate.path === file);
  if (!output || result.outputFiles.length !== 1) throw new ArtifactBuildError('BUILD_FAILED', 'saída inesperada do esbuild');
  const bytes = Buffer.from(output.contents);
  const realRoot = fs.realpathSync(REPO_ROOT);
  const modulesDir = path.join(REPO_ROOT, 'node_modules');
  const realModules = fs.existsSync(modulesDir) ? fs.realpathSync(modulesDir) : realRoot;
  const requires = checkArtifactText(bytes.toString('utf8'), [REPO_ROOT, realRoot, realModules, path.dirname(file)], spec.modules);
  if (requires.join('\n') !== fromMetafile.join('\n')) throw new ArtifactBuildError('IMPORT_NOT_ALLOWED', 'o texto do artefato e o metafile divergem nos imports');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, 0o444);
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes, requires };
}

/** Todos os artefatos de `RECEIVER_ARTIFACTS`, na ordem. */
export async function buildReceiverArtifacts(options: { readonly outDir: string }): Promise<BuiltArtifact[]> {
  const built: BuiltArtifact[] = [];
  for (const spec of RECEIVER_ARTIFACTS) built.push(await buildReceiverArtifact(spec, options));
  return built;
}

/** A linha do arquivo versionado (`<sha256>  <arquivo>`, formato do `sha256sum -c`). */
export const receiverHashLine = (built: BuiltArtifact): string => `${built.sha256}  ${path.basename(built.file)}`;

/** Os hashes versionados, na ordem: exatamente um por artefato de `RECEIVER_ARTIFACTS`, mesmo nome, mesma ordem; `#` = comentário. */
export function versionedReceiverHashes(file: string = RECEIVERS_HASH_FILE): ReadonlyMap<string, string> {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '' && !line.startsWith('#'));
  const hashes = new Map<string, string>();
  lines.forEach((line, index) => {
    const match = HASH_LINE.exec(line);
    const expected = RECEIVER_ARTIFACTS[index]?.fileName;
    if (!match || expected === undefined || match[2] !== expected || hashes.has(expected)) throw new ArtifactBuildError('HASH_MISMATCH', `${path.relative(REPO_ROOT, file)}: linha ${index + 1} fora do formato "<sha256>  <arquivo>" ou fora da ordem de RECEIVER_ARTIFACTS`);
    hashes.set(expected, match[1] as string);
  });
  if (hashes.size !== RECEIVER_ARTIFACTS.length) throw new ArtifactBuildError('HASH_MISMATCH', `${path.relative(REPO_ROOT, file)}: ${hashes.size} linhas para ${RECEIVER_ARTIFACTS.length} artefatos`);
  return hashes;
}

function parseOutDir(argv: readonly string[]): string | null {
  const outAt = argv.indexOf('--out');
  const outDir = outAt >= 0 ? argv[outAt + 1] : DEFAULT_OUT_DIR;
  const unknown = argv.some((arg, index) => arg.startsWith('--') && arg !== '--out' && arg !== '--check' && index !== outAt + 1);
  return outDir === undefined || outDir.startsWith('--') || unknown ? null : outDir;
}

async function main(argv: readonly string[]): Promise<number> {
  const outDir = parseOutDir(argv);
  if (outDir === null) {
    console.error('Uso: npm run deploy:receivers-artifact -- [--out <pasta>] [--check]');
    return 1;
  }
  try {
    const built = await buildReceiverArtifacts({ outDir });
    for (const artifact of built) {
      console.log(receiverHashLine(artifact));
      console.error(`Artefato: ${path.basename(artifact.file)} (${artifact.bytes.length} bytes); módulos: ${artifact.requires.join(', ')}`);
    }
    if (!argv.includes('--check')) return 0;
    const versioned = versionedReceiverHashes();
    const differing = built.filter((artifact) => versioned.get(path.basename(artifact.file)) !== artifact.sha256);
    if (differing.length === 0) return 0;
    console.error(`FALHA: hash recompilado difere do versionado em ${path.relative(REPO_ROOT, RECEIVERS_HASH_FILE)} (${differing.map((artifact) => path.basename(artifact.file)).join(', ')}). Build não reprodutível ou fonte mudada sem atualizar o hash.`);
    return 3;
  } catch (error) {
    console.error(error instanceof ArtifactBuildError ? `FALHA (${error.code}): ${error.message}` : 'FALHA inesperada no build dos artefatos.');
    return 3;
  }
}

if (/build-receivers-artifact\.ts$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 4;
    },
  );
}
