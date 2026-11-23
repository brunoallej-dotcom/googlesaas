import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ReceiverError, type ReceiverCode } from './codes';
import { imageInfo, parseJsonWith, runProgram, type ImageInfo } from './docker';
import type { DeployEnvironment } from './grammar';
import type { ReceiverDeps } from './ports';

/*
 * P9.3a — passo 9 do `deploy` (spec §5.6): o pacote do `docker save | gzip -n`.
 *  1. `gzip -t` (integridade do gzip);
 *  2. o `manifest.json` do tar lido SEM extrair nada para o disco (`tar -xzOf <pacote> manifest.json`, para o stdout, com teto);
 *  3. exatamente duas imagens, com `RepoTags` = `["gmn-web:<amb>-<sha40>"]` e `["gmn-worker:<amb>-<sha40>"]` e o `Config` num dos dois nomes
 *     aceitos, senão `E_BUNDLE_TAGS` (e nenhum `docker load`);
 *  4. `docker load -i` (`E_DOCKER_LOAD`) e conferência de cada imagem carregada, nos dois armazenamentos de imagens do Docker:
 *     - clássico: o id da tag = `sha256:<digest do Config>`;
 *     - containerd (padrão das instalações novas do Docker Engine 29; o id passa a ser o digest do manifesto): a tag carregada tem
 *       EXATAMENTE a tag esperada nos `RepoTags`, o `Config` lido do pacote (mesmo `tar -xzOf`, com teto) tem o sha256 do próprio nome, e
 *       os `RootFS.Layers` (diff_ids) da imagem carregada são exatamente os `rootfs.diff_ids` desse `Config`.
 *     Qualquer divergência ⇒ `E_DOCKER_LOAD`. Os ids voltam no `OK DEPLOYED` (`sha256:<64 hex>`).
 */

const GZIP_TEST_TIMEOUT_MS = 15 * 60_000;
const MEMBER_READ_TIMEOUT_MS = 15 * 60_000;
const LOAD_TIMEOUT_MS = 30 * 60_000;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const LOAD_MAX_OUTPUT = 1024 * 1024;
const NO_OUTPUT = 64 * 1024;
const IMAGES_IN_BUNDLE = 2;
/** `Config` no formato OCI (`blobs/sha256/<hex>`, Docker 25+) ou no antigo (`<hex>.json`). */
const CONFIG_PATH = /^(?:blobs\/sha256\/([0-9a-f]{64})|([0-9a-f]{64})\.json)$/;
const DIFF_ID = /^sha256:[0-9a-f]{64}$/;

const ManifestSchema = z.array(z.object({ Config: z.string(), RepoTags: z.array(z.string()).nullable(), Layers: z.array(z.string()) }));
const ImageConfigSchema = z.object({ rootfs: z.object({ type: z.literal('layers'), diff_ids: z.array(z.string().regex(DIFF_ID)).min(1) }) });

export interface BundleImages {
  readonly tag: string;
  readonly webRef: string;
  readonly workerRef: string;
  readonly webImageId: string;
  readonly workerImageId: string;
}

/** Uma imagem do `manifest.json`, já conferida: a tag esperada, o caminho do `Config` dentro do tar e o digest dele. */
interface BundleEntry {
  readonly ref: string;
  readonly configPath: string;
  readonly configDigest: string;
}

export type LoadVerification = 'config-digest' | 'diff-ids';

export const imageTag = (env: DeployEnvironment, sha40: string): string => `${env}-${sha40}`;

const tagsError = (note: string): ReceiverError => new ReceiverError('E_BUNDLE_TAGS', null, note);
const loadError = (note: string): ReceiverError => new ReceiverError('E_DOCKER_LOAD', null, note);

/** Um membro do tar para o stdout (nada extraído para o disco), com teto; falha ⇒ `ReceiverError(code)`. */
async function readBundleMember(bundle: string, member: string, maxBytes: number, code: ReceiverCode, deps: ReceiverDeps): Promise<Uint8Array> {
  const read = await runProgram({ program: 'tar', args: ['-xzOf', bundle, member], env: { PATH: deps.childPath }, timeoutMs: MEMBER_READ_TIMEOUT_MS, maxOutputBytes: maxBytes, logStdout: false, label: `tar ${member}` }, deps);
  if (read.exitCode !== 0 || read.timedOut || read.overflow) throw new ReceiverError(code, null, `${member} unreadable in the bundle`);
  return read.stdout;
}

function entryOf(raw: z.infer<typeof ManifestSchema>[number], refs: readonly string[], seen: ReadonlySet<string>): BundleEntry {
  const tags = raw.RepoTags ?? [];
  const ref = tags[0];
  const config = CONFIG_PATH.exec(raw.Config);
  if (tags.length !== 1 || ref === undefined || !refs.includes(ref) || seen.has(ref) || config === null) throw tagsError('bundle image tags differ from the expected ones');
  return { ref, configPath: raw.Config, configDigest: (config[1] ?? config[2]) as string };
}

/** Passos 9.1 a 9.3: `gzip -t`, o `manifest.json` e as duas tags esperadas. Nada é carregado. */
async function bundleEntries(bundle: string, refs: readonly [string, string], deps: ReceiverDeps): Promise<ReadonlyMap<string, BundleEntry>> {
  const gzipTest = await runProgram({ program: 'gzip', args: ['-t', bundle], env: { PATH: deps.childPath }, timeoutMs: GZIP_TEST_TIMEOUT_MS, maxOutputBytes: NO_OUTPUT, logStdout: true, label: 'gzip -t' }, deps);
  if (gzipTest.exitCode !== 0 || gzipTest.timedOut) throw tagsError('gzip -t refused the bundle');
  const raw = await readBundleMember(bundle, 'manifest.json', MANIFEST_MAX_BYTES, 'E_BUNDLE_TAGS', deps);
  const manifest = parseJsonWith(Buffer.from(raw).toString('utf8'), ManifestSchema, 'E_BUNDLE_TAGS', 'manifest.json');
  if (manifest.length !== IMAGES_IN_BUNDLE) throw tagsError(`bundle with ${manifest.length} images`);
  const entries = new Map<string, BundleEntry>();
  for (const item of manifest) {
    const entry = entryOf(item, refs, new Set(entries.keys()));
    entries.set(entry.ref, entry);
  }
  return entries;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/** Armazenamento containerd: tag exata, `Config` do pacote íntegro e diff_ids iguais aos da imagem carregada. */
async function verifyByDiffIds(entry: BundleEntry, info: ImageInfo, bundle: string, deps: ReceiverDeps): Promise<void> {
  const tags = info.RepoTags ?? [];
  if (tags.length !== 1 || tags[0] !== entry.ref) throw loadError(`${entry.ref}: loaded image tags differ from the expected one`);
  const config = await readBundleMember(bundle, entry.configPath, CONFIG_MAX_BYTES, 'E_DOCKER_LOAD', deps);
  if (createHash('sha256').update(config).digest('hex') !== entry.configDigest) throw loadError(`${entry.ref}: config blob differs from its digest`);
  const parsed = parseJsonWith(Buffer.from(config).toString('utf8'), ImageConfigSchema, 'E_DOCKER_LOAD', 'image config');
  if (!sameList(parsed.rootfs.diff_ids, info.RootFS?.Layers ?? [])) throw loadError(`${entry.ref}: loaded layers differ from the bundle config`);
}

/** A imagem carregada para uma tag é a do pacote: pelo id (clássico) ou pelos diff_ids (containerd). */
async function verifyLoaded(entry: BundleEntry, bundle: string, deps: ReceiverDeps): Promise<{ readonly id: string; readonly verification: LoadVerification }> {
  const info = await imageInfo(entry.ref, deps);
  if (info.Id === `sha256:${entry.configDigest}`) return { id: info.Id, verification: 'config-digest' };
  await verifyByDiffIds(entry, info, bundle, deps);
  return { id: info.Id, verification: 'diff-ids' };
}

/** Passo 9 inteiro: confere o pacote, carrega e confere as imagens carregadas. */
export async function loadBundle(bundle: string, env: DeployEnvironment, sha40: string, deps: ReceiverDeps): Promise<BundleImages> {
  const tag = imageTag(env, sha40);
  const webRef = `gmn-web:${tag}`;
  const workerRef = `gmn-worker:${tag}`;
  const entries = await bundleEntries(bundle, [webRef, workerRef], deps);
  const load = await runProgram({ program: 'docker', args: ['load', '-i', bundle], env: { PATH: deps.childPath }, timeoutMs: LOAD_TIMEOUT_MS, maxOutputBytes: LOAD_MAX_OUTPUT, logStdout: true, label: 'docker load' }, deps);
  if (load.exitCode !== 0 || load.timedOut || load.overflow) throw loadError('docker load failed');
  const web = await verifyLoaded(entries.get(webRef) as BundleEntry, bundle, deps);
  const worker = await verifyLoaded(entries.get(workerRef) as BundleEntry, bundle, deps);
  deps.log.write('bundle.loaded', { tag, webImageId: web.id, workerImageId: worker.id, webVerification: web.verification, workerVerification: worker.verification });
  return { tag, webRef, workerRef, webImageId: web.id, workerImageId: worker.id };
}
