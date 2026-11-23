import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import type { ReceiverConfig } from './args';
import { loadBundle, type BundleImages } from './bundle';
import { ReceiverError } from './codes';
import { updateMarkOf, waitForConvergence } from './converge';
import { dockerRootDir, inspectService, runProgram } from './docker';
import type { DeployCommand } from './grammar';
import { checkHostConfig, MAX_HOST_VARS_BYTES, parseHostVarsFile, type HostConfig } from './host-vars';
import type { ReceiverDeps } from './ports';
import { runPostdeployChecks, TRUST_KEYS_ENV } from './postdeploy';
import { bundleFileName, INCOMING_DIR } from './staging';
import { installTrustList, receiveTrustList, type ReceivedTrustList } from './trust';

/*
 * P9.3a — `deploy <sha40> <bundle-sha256> <stack-sha256> <overlay-sha256|-> <trust-sha256> <supabase-fp12>`, os passos 1 a 15 do §5.6, NA ORDEM.
 * A trava do ambiente é tomada antes (receiver.ts). Até o passo 8 o Docker só é CONSULTADO (`docker service inspect`, `docker info`); nada é
 * carregado nem implantado antes do passo 9. A lista de confiança só é instalada depois do PD-07 (passo 14).
 */

const GIB = 1024 * 1024 * 1024;
/** Passo 8: livre na raiz do Docker ≥ max(10 GiB, 3 × pacote). */
export const MIN_FREE_BYTES = 10 * GIB;
export const BUNDLE_FREE_FACTOR = 3;
const FOLDERS_CHECK_TIMEOUT_MS = 120_000;
const STACK_CONFIG_TIMEOUT_MS = 120_000;
const STACK_DEPLOY_TIMEOUT_MS = 10 * 60_000;
const SMALL_OUTPUT = 256 * 1024;
const STACK_CONFIG_MAX_OUTPUT = 4 * 1024 * 1024;
const FP12_LENGTH = 12;

const fp12Of = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, FP12_LENGTH);

/** Passo 1: o pacote recebido existe com o mesmo `sha40` e o mesmo hash. Devolve o caminho e o tamanho. */
async function stagedBundle(command: DeployCommand, config: ReceiverConfig, deps: ReceiverDeps): Promise<{ readonly file: string; readonly size: number }> {
  const incoming = await deps.fs.lstat(nodePath.join(config.stateDir, INCOMING_DIR));
  if (incoming === null || !incoming.isDirectory || incoming.isSymbolicLink) throw new ReceiverError('E_NOT_STAGED', null, 'no real incoming dir');
  const file = nodePath.join(config.stateDir, INCOMING_DIR, bundleFileName(command.sha40));
  const info = await deps.fs.lstat(file);
  if (info === null || !info.isFile || info.isSymbolicLink) throw new ReceiverError('E_NOT_STAGED', null, 'no staged bundle for this commit');
  const { sha256, size } = await deps.fs.sha256File(file);
  if (sha256 !== command.bundleSha256) throw new ReceiverError('E_HASH_MISMATCH', null, 'staged bundle sha256 differs from the declared one');
  return { file, size };
}

/** SHA-256 de um arquivo regular; ausente, link ou ilegível ⇒ `null` (o chamador recusa com o código do passo). */
async function fileSha256OrNull(file: string, deps: ReceiverDeps): Promise<string | null> {
  try {
    const info = await deps.fs.lstat(file);
    if (info === null || !info.isFile || info.isSymbolicLink) return null;
    return (await deps.fs.sha256File(file)).sha256;
  } catch {
    deps.log.write('deploy.stack_file_unreadable');
    return null;
  }
}

/** Passo 2: a stack (e a sobreposição) INSTALADAS pelo responsável têm o hash do commit (desvio D-1). Sem chamar o Docker. */
async function checkStackFiles(command: DeployCommand, config: ReceiverConfig, deps: ReceiverDeps): Promise<void> {
  if ((await fileSha256OrNull(config.stackFile, deps)) !== command.stackSha256) throw new ReceiverError('E_STACK_FILE_MISMATCH', null, 'stack file differs from the commit');
  if (config.overlayFile !== null && (await fileSha256OrNull(config.overlayFile, deps)) !== command.overlaySha256) throw new ReceiverError('E_STACK_FILE_MISMATCH', null, 'overlay file differs from the commit');
}

/** Em homologação, o caminho REAL de cada pasta também fica sob o caminho real do prefixo (um link não leva para fora). */
async function checkRealPrefix(host: HostConfig, dataPrefix: string, deps: ReceiverDeps): Promise<void> {
  try {
    const realPrefix = await deps.fs.realpath(dataPrefix.slice(0, -1));
    for (const folder of host.prefixedFolders) {
      const real = await deps.fs.realpath(folder);
      if (real !== realPrefix && !real.startsWith(`${realPrefix}/`)) throw new Error('outside');
    }
  } catch {
    throw new ReceiverError('E_DATA_PREFIX', null, 'real path of a homologation folder outside --data-prefix (or unresolvable)');
  }
}

/** Passo 4: o arquivo de variáveis do host, pelo parser estrito, e as regras de ambiente. */
async function readHostConfig(config: ReceiverConfig, deps: ReceiverDeps): Promise<HostConfig> {
  const info = await deps.fs.lstat(config.hostVarsFile);
  if (info === null || !info.isFile || info.isSymbolicLink) throw new ReceiverError('E_HOST_CONFIG', null, 'host-vars file missing or not regular');
  let raw: Uint8Array;
  try {
    raw = await deps.fs.readFileCapped(config.hostVarsFile, MAX_HOST_VARS_BYTES);
  } catch {
    throw new ReceiverError('E_HOST_CONFIG', null, 'host-vars file unreadable or too large');
  }
  const host = checkHostConfig(parseHostVarsFile(raw), config.env, config.dataPrefix);
  if (config.dataPrefix !== null) await checkRealPrefix(host, config.dataPrefix, deps);
  return host;
}

/** Passo 5: a imagem foi construída para o projeto que vai rodar; a homologação nunca usa o projeto de produção. */
function checkSupabase(command: DeployCommand, host: HostConfig, config: ReceiverConfig): void {
  const hostFp12 = fp12Of(host.supabaseUrl);
  if (config.forbidSupabase !== null && (hostFp12 === config.forbidSupabase || command.supabaseFp12 === config.forbidSupabase)) throw new ReceiverError('E_HML_PRODUCTION_PROJECT', null, 'homologation points to the production Supabase project');
  if (hostFp12 !== command.supabaseFp12) throw new ReceiverError('E_SUPABASE_MISMATCH', null, 'image and host point to different Supabase projects');
}

/** Passo 6: `verificar-pastas-fase6.sh` com os seis `GMN_RAIZ_DADOS_*` (só leitura). */
async function checkFolders(config: ReceiverConfig, host: HostConfig, deps: ReceiverDeps): Promise<void> {
  const info = await deps.fs.lstat(config.foldersCheck);
  if (info === null || !info.isFile || info.isSymbolicLink) throw new ReceiverError('E_HOST_FOLDERS', null, 'folders check script missing');
  const result = await runProgram({ program: { script: config.foldersCheck }, args: host.dataFolders, env: { PATH: deps.childPath }, timeoutMs: FOLDERS_CHECK_TIMEOUT_MS, maxOutputBytes: SMALL_OUTPUT, logStdout: true, label: 'verificar-pastas-fase6.sh' }, deps);
  if (result.exitCode !== 0 || result.timedOut) throw new ReceiverError('E_HOST_FOLDERS', null, 'folders check refused');
}

/** Passo 7: se o Worker existe, as réplicas atuais = `GMN_WORKER_REPLICAS` do arquivo (padrão 0). O receptor nunca o liga nem o desliga. */
async function checkWorkerDrift(config: ReceiverConfig, host: HostConfig, deps: ReceiverDeps): Promise<void> {
  const worker = await inspectService(`${config.stackName}_gmn-worker`, 'E_INTERNAL', deps);
  if (worker === null) return;
  if (worker.Spec.Mode.Replicated?.Replicas !== host.workerReplicas) throw new ReceiverError('E_WORKER_REPLICAS_DRIFT', null, 'worker replicas differ from the host-vars file');
}

/** Passo 8: espaço livre na raiz do Docker. */
async function checkDisk(bundleSize: number, deps: ReceiverDeps): Promise<void> {
  const root = await dockerRootDir(deps);
  const available = await deps.fs.availableBytes(root);
  if (available < Math.max(MIN_FREE_BYTES, BUNDLE_FREE_FACTOR * bundleSize)) throw new ReceiverError('E_DISK_LOW', null, 'not enough free space in the Docker root');
}

/** Os `-c` do ambiente: a stack e, em homologação, a sobreposição. */
const composeArgs = (config: ReceiverConfig): string[] => (config.overlayFile === null ? ['-c', config.stackFile] : ['-c', config.stackFile, '-c', config.overlayFile]);

/** O ambiente dos `docker stack …`: o arquivo do host, a tag e a lista (nunca na linha de comando). */
function stackEnvironment(host: HostConfig, images: BundleImages, trust: ReceivedTrustList, deps: ReceiverDeps): Record<string, string> {
  return { PATH: deps.childPath, ...Object.fromEntries(host.vars), GMN_IMAGE_TAG: images.tag, [TRUST_KEYS_ENV]: trust.value };
}

/** Passos 10 e 11: `docker stack config` (saída só ao log, e nem isso: tem o ambiente renderizado) e `docker stack deploy`, sem `--prune`. */
async function configureAndDeploy(config: ReceiverConfig, env: Record<string, string>, deps: ReceiverDeps): Promise<void> {
  const rendered = await runProgram({ program: 'docker', args: ['stack', 'config', ...composeArgs(config)], env, timeoutMs: STACK_CONFIG_TIMEOUT_MS, maxOutputBytes: STACK_CONFIG_MAX_OUTPUT, logStdout: false, label: 'docker stack config' }, deps);
  if (rendered.exitCode !== 0 || rendered.timedOut || rendered.overflow) throw new ReceiverError('E_STACK_CONFIG', null, 'docker stack config refused');
  const deployed = await runProgram({ program: 'docker', args: ['stack', 'deploy', '--resolve-image', 'never', ...composeArgs(config), config.stackName], env, timeoutMs: STACK_DEPLOY_TIMEOUT_MS, maxOutputBytes: SMALL_OUTPUT, logStdout: true, label: 'docker stack deploy' }, deps);
  if (deployed.exitCode !== 0 || deployed.timedOut) throw new ReceiverError('E_STACK_DEPLOY', null, 'docker stack deploy failed');
}

/** O `deploy` inteiro; devolve a linha `OK DEPLOYED …`. Lança `ReceiverError` com o código do primeiro passo que recusa. */
export async function runDeploy(command: DeployCommand, config: ReceiverConfig, deps: ReceiverDeps): Promise<string> {
  const bundle = await stagedBundle(command, config, deps); // 1
  await checkStackFiles(command, config, deps); // 2
  const trust = await receiveTrustList(command.trustSha256, config.env, config.stateDir, deps); // 3
  const host = await readHostConfig(config, deps); // 4
  checkSupabase(command, host, config); // 5
  await checkFolders(config, host, deps); // 6
  await checkWorkerDrift(config, host, deps); // 7
  await checkDisk(bundle.size, deps); // 8
  const images = await loadBundle(bundle.file, config.env, command.sha40, deps); // 9
  const webService = `${config.stackName}_gmn-web`;
  const before = updateMarkOf(await inspectService(webService, 'E_INTERNAL', deps));
  await configureAndDeploy(config, stackEnvironment(host, images, trust, deps), deps); // 10, 11
  await waitForConvergence(webService, images.webRef, before, deps); // 12
  await runPostdeployChecks({ stackName: config.stackName, env: config.env, webRef: images.webRef, workerRef: images.workerRef, workerReplicas: host.workerReplicas, trustValue: trust.value }, deps); // 13
  const installedSha256 = await installTrustList(trust, config.stateDir, deps); // 14
  await deps.fs.unlink(bundle.file).catch(() => deps.log.write('deploy.bundle_unlink_failed'));
  deps.log.write('deploy.done', { tag: images.tag, stackSha256: command.stackSha256, overlaySha256: command.overlaySha256, trustInstalledSha256: installedSha256 });
  return `OK DEPLOYED ${images.tag} ${images.webImageId} ${images.workerImageId} ${command.stackSha256} ${command.overlaySha256 ?? '-'} ${installedSha256}`; // 15
}
