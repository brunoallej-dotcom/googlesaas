import { z } from 'zod';
import { ReceiverError } from './codes';
import { imageId, parseJsonWith, runProgram } from './docker';
import type { DeployEnvironment } from './grammar';
import type { ReceiverDeps } from './ports';

/*
 * P9.3a — passo 9 do `deploy` (spec §5.6): o pacote do `docker save | gzip -n`.
 *  1. `gzip -t` (integridade do gzip);
 *  2. o `manifest.json` do tar lido SEM extrair nada para o disco (`tar -xzOf <pacote> manifest.json`, para o stdout, com teto);
 *  3. exatamente duas imagens, com `RepoTags` = `["gmn-web:<amb>-<sha40>"]` e `["gmn-worker:<amb>-<sha40>"]`, senão `E_BUNDLE_TAGS` (e nenhum
 *     `docker load`);
 *  4. `docker load -i` (`E_DOCKER_LOAD`) e conferência de que o id de cada tag carregada é o do manifesto (o digest do `Config`), senão
 *     `E_DOCKER_LOAD`. Os ids voltam no `OK DEPLOYED` (`sha256:<64 hex>`).
 */

const GZIP_TEST_TIMEOUT_MS = 15 * 60_000;
const MANIFEST_READ_TIMEOUT_MS = 15 * 60_000;
const LOAD_TIMEOUT_MS = 30 * 60_000;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const LOAD_MAX_OUTPUT = 1024 * 1024;
const NO_OUTPUT = 64 * 1024;
const IMAGES_IN_BUNDLE = 2;
/** `Config` no formato OCI (`blobs/sha256/<hex>`, Docker 25+) ou no antigo (`<hex>.json`). */
const CONFIG_DIGEST = /^(?:blobs\/sha256\/([0-9a-f]{64})|([0-9a-f]{64})\.json)$/;

const ManifestSchema = z.array(z.object({ Config: z.string(), RepoTags: z.array(z.string()).nullable(), Layers: z.array(z.string()) }));

export interface BundleImages {
  readonly tag: string;
  readonly webRef: string;
  readonly workerRef: string;
  readonly webImageId: string;
  readonly workerImageId: string;
}

export const imageTag = (env: DeployEnvironment, sha40: string): string => `${env}-${sha40}`;

const tagsError = (note: string): ReceiverError => new ReceiverError('E_BUNDLE_TAGS', null, note);

/** Lê e confere o `manifest.json`; devolve o id esperado (`sha256:<config>`) de cada referência. Nada é carregado. */
async function expectedImageIds(bundle: string, refs: readonly [string, string], deps: ReceiverDeps): Promise<ReadonlyMap<string, string>> {
  const env = { PATH: deps.childPath };
  const gzipTest = await runProgram({ program: 'gzip', args: ['-t', bundle], env, timeoutMs: GZIP_TEST_TIMEOUT_MS, maxOutputBytes: NO_OUTPUT, logStdout: true, label: 'gzip -t' }, deps);
  if (gzipTest.exitCode !== 0 || gzipTest.timedOut) throw tagsError('gzip -t refused the bundle');
  const read = await runProgram({ program: 'tar', args: ['-xzOf', bundle, 'manifest.json'], env, timeoutMs: MANIFEST_READ_TIMEOUT_MS, maxOutputBytes: MANIFEST_MAX_BYTES, logStdout: false, label: 'tar manifest.json' }, deps);
  if (read.exitCode !== 0 || read.timedOut || read.overflow) throw tagsError('manifest.json unreadable');
  const manifest = parseJsonWith(Buffer.from(read.stdout).toString('utf8'), ManifestSchema, 'E_BUNDLE_TAGS', 'manifest.json');
  if (manifest.length !== IMAGES_IN_BUNDLE) throw tagsError(`bundle with ${manifest.length} images`);
  const expected = new Map<string, string>();
  for (const entry of manifest) {
    const tags = entry.RepoTags ?? [];
    const digest = CONFIG_DIGEST.exec(entry.Config);
    const ref = tags[0];
    if (tags.length !== 1 || ref === undefined || !refs.includes(ref) || expected.has(ref) || digest === null) throw tagsError('bundle image tags differ from the expected ones');
    expected.set(ref, `sha256:${digest[1] ?? digest[2]}`);
  }
  return expected;
}

/** Passo 9 inteiro: confere o pacote, carrega e confere os ids carregados. */
export async function loadBundle(bundle: string, env: DeployEnvironment, sha40: string, deps: ReceiverDeps): Promise<BundleImages> {
  const tag = imageTag(env, sha40);
  const webRef = `gmn-web:${tag}`;
  const workerRef = `gmn-worker:${tag}`;
  const expected = await expectedImageIds(bundle, [webRef, workerRef], deps);
  const load = await runProgram({ program: 'docker', args: ['load', '-i', bundle], env: { PATH: deps.childPath }, timeoutMs: LOAD_TIMEOUT_MS, maxOutputBytes: LOAD_MAX_OUTPUT, logStdout: true, label: 'docker load' }, deps);
  if (load.exitCode !== 0 || load.timedOut || load.overflow) throw new ReceiverError('E_DOCKER_LOAD', null, 'docker load failed');
  const webImageId = await imageId(webRef, deps);
  const workerImageId = await imageId(workerRef, deps);
  if (webImageId !== expected.get(webRef) || workerImageId !== expected.get(workerRef)) throw new ReceiverError('E_DOCKER_LOAD', null, 'loaded image ids differ from the manifest');
  deps.log.write('bundle.loaded', { tag, webImageId, workerImageId });
  return { tag, webRef, workerRef, webImageId, workerImageId };
}
