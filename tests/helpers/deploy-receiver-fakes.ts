import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReceiverConfig } from '../../src/lib/deploy-receiver/args';
import type { ByteSource, Clock, InputEvent, ProcessRunner, ReceiverDeps, ReceiverLog, RunRequest, RunResult } from '../../src/lib/deploy-receiver/ports';
import { nodeLock, nodeReceiverFs } from '../../src/lib/deploy-receiver/node-adapters';
import { runDeployReceiver } from '../../src/lib/deploy-receiver/receiver';
import type { ReceiverOutcome } from '../../src/lib/deploy-receiver/codes';
import { tmpDir } from './link-audit-evidence-fixtures';

/*
 * P9.3a — mundo de teste do receptor de deploy: pastas TEMPORÁRIAS reais (estado, stack, arquivo de variáveis, pastas de homologação) com o disco
 * real do adaptador, e `docker`, `tar`, `gzip` e o script de pastas FALSOS em processo (nenhum Docker, ssh ou rede). Dados 100% fictícios; as
 * sentinelas do arquivo de variáveis e da saída do Docker servem para provar que nada disso chega à saída pública.
 */

export const SHA40 = 'a'.repeat(40);
export const OTHER_SHA40 = 'b'.repeat(40);
export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const fp12 = (value: string): string => sha256(Buffer.from(value, 'utf8')).slice(0, 12);
/** Valores do arquivo de variáveis: nenhum pode aparecer na saída pública nem no log. */
export const SENTINEL_URL = 'https://projeto-sentinela-hostvars.supabase.invalid';
export const SENTINEL_EMAIL = 'operador-sentinela-hostvars@exemplo.invalid';
export const SENTINEL_HOST = 'dominio-sentinela-hostvars.invalid';
export const PRODUCTION_URL = 'https://projeto-de-producao-ficticio.supabase.invalid';
/** Caminho falso que o Docker falso "imprime": nunca pode chegar ao stdout/stderr do receptor. */
export const DOCKER_NOISE = '/srv/caminho-real-sentinela-docker/saida';

export interface TestKey {
  readonly id: string;
  readonly pub: string;
}
export function testKey(id: string): TestKey {
  const { publicKey } = generateKeyPairSync('ed25519');
  return { id, pub: String(publicKey.export({ format: 'jwk' }).x) };
}
export const trustLine = (key: TestKey, state = ''): string => `${key.id}:${key.pub}${state === '' ? '' : `:${state}`}`;
export const trustFile = (lines: readonly string[]): Buffer => Buffer.from(lines.map((line) => `${line}\n`).join(''), 'ascii');

/* ------------------------------------------------------------------------------------------------------------------------- stdin */

export class FakeStdin implements ByteSource {
  reads = 0;
  private readonly events: InputEvent[];
  constructor(chunks: readonly Uint8Array[], ending: 'end' | 'hang' = 'end') {
    this.events = chunks.map((chunk) => ({ kind: 'data' as const, chunk }));
    if (ending === 'end') this.events.push({ kind: 'end' });
  }
  static of(bytes: Uint8Array, chunkSize = 4096): FakeStdin {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) chunks.push(bytes.subarray(offset, offset + chunkSize));
    return new FakeStdin(chunks);
  }
  async next(): Promise<InputEvent> {
    this.reads += 1;
    return this.events.shift() ?? { kind: 'idle' };
  }
}

/* ------------------------------------------------------------------------------------------------------------------------- relógio */

export class FakeClock implements Clock {
  now = 0;
  slept = 0;
  monotonicMs(): number {
    return this.now;
  }
  isoNow(): string {
    return '2026-11-23T00:00:00.000Z';
  }
  async sleep(ms: number): Promise<void> {
    this.now += ms;
    this.slept += ms;
  }
}

export class MemoryLog implements ReceiverLog {
  readonly entries: Array<{ event: string; fields: Readonly<Record<string, unknown>> }> = [];
  write(event: string, fields: Readonly<Record<string, string | number | boolean | null>> = {}): void {
    this.entries.push({ event, fields });
  }
  text(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n');
  }
}

/* ------------------------------------------------------------------------------------------------------------------------- docker */

export interface FakeService {
  ID: string;
  Spec: {
    Name: string;
    Mode: { Replicated?: { Replicas: number } };
    TaskTemplate: { ContainerSpec: { Image: string; Env?: string[]; Mounts?: Array<{ Type?: string; Source?: string; Target: string; ReadOnly?: boolean }> } };
    EndpointSpec?: { Ports?: unknown[] } | null;
  };
  Endpoint?: { Ports?: unknown[] } | null;
  UpdateStatus?: { State: string; StartedAt?: string } | null;
  running: string;
}

export interface DockerScenario {
  /** Serviços que já existem antes do deploy (nome → serviço). */
  services: Map<string, FakeService>;
  rootDir: string;
  /** Saída do `tar -xzOf … manifest.json` (texto cru). */
  manifest: string;
  /** Os `Config` dentro do pacote (caminho no tar → bytes), lidos pelo `tar -xzOf` no armazenamento containerd. */
  configs: Map<string, Buffer>;
  gzipOk: boolean;
  tarOk: boolean;
  loadOk: boolean;
  /** O que o `docker image inspect` devolve depois do load (ref → id, tags e diff_ids). */
  loadedImages: Map<string, LoadedImage>;
  stackConfigOk: boolean;
  stackDeployOk: boolean;
  foldersOk: boolean;
  /**
   * Estados do `UpdateStatus` do web devolvidos a cada consulta depois do deploy: `stale` = o anterior, tarefas ainda na imagem velha;
   * `stale-new-image` = o anterior, mas as tarefas já na imagem nova; `none` = sem `UpdateStatus` (serviço criado agora).
   */
  updateStates: string[];
  /** Ajuste dos serviços logo depois do `stack deploy` (para reprovar uma verificação PD-xx). */
  afterDeploy?: (services: Map<string, FakeService>) => void;
  /** `docker service ls` falha. */
  serviceLsFails?: boolean;
  /** Id da imagem que o CONTÊINER das tarefas de um serviço roda (serviço → id); sem ele, o id carregado da tag do serviço. */
  runningImageIds?: Map<string, string>;
  /** O `stack deploy` não muda a especificação do web (o mesmo commit de novo): o serviço anterior fica como está. */
  specUnchanged?: boolean;
  /** Saída do `tar -tvzf` (linhas do GNU tar); sem ela, montada do `manifest` e dos `configs` (`listingFor`). */
  listing?: string;
  /** Chamado antes de cada programa (ex.: trocar a stack instalada no meio do deploy). */
  beforeCall?: (request: RunRequest) => void;
}

/** O que um `docker stack config|deploy` recebeu: os `-c` e os bytes de cada um NO MOMENTO da chamada. */
export interface ComposeCall {
  readonly sub: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Buffer | null }>;
  readonly env: Readonly<Record<string, string>>;
}

export interface LoadedImage {
  Id: string;
  RepoTags: string[] | null;
  Layers: string[];
}

/** Os `Config` das duas imagens (como o `docker save` grava): os diff_ids e um rótulo; o digest é o sha256 dos bytes. */
const imageConfig = (role: string, diffIds: readonly string[]): Buffer => Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: { papel: role } }, rootfs: { type: 'layers', diff_ids: diffIds } }));
export const WEB_DIFF_IDS = [`sha256:${'1'.repeat(64)}`, `sha256:${'3'.repeat(64)}`];
export const WORKER_DIFF_IDS = [`sha256:${'2'.repeat(64)}`];
export const WEB_CONFIG = imageConfig('web', WEB_DIFF_IDS);
export const WORKER_CONFIG = imageConfig('worker', WORKER_DIFF_IDS);
export const CONFIG_DIGEST_WEB = sha256(WEB_CONFIG);
/** O id da imagem que as tarefas rodavam antes do deploy. */
export const OLD_IMAGE_ID = `sha256:${'0'.repeat(64)}`;
export const CONFIG_DIGEST_WORKER = sha256(WORKER_CONFIG);
/** Formato OCI para o web, antigo para o Worker (os dois que o receptor aceita). */
export const WEB_CONFIG_PATH = `blobs/sha256/${CONFIG_DIGEST_WEB}`;
export const WORKER_CONFIG_PATH = `${CONFIG_DIGEST_WORKER}.json`;
/** Ids do armazenamento containerd: o digest do MANIFESTO, não o do Config. */
export const CONTAINERD_ID_WEB = `sha256:${'e'.repeat(64)}`;
export const CONTAINERD_ID_WORKER = `sha256:${'f'.repeat(64)}`;

/** Imagens carregadas no armazenamento clássico (id = digest do Config). */
export const classicImages = (tag: string): Map<string, LoadedImage> =>
  new Map([
    [`gmn-web:${tag}`, { Id: `sha256:${CONFIG_DIGEST_WEB}`, RepoTags: [`gmn-web:${tag}`], Layers: [...WEB_DIFF_IDS] }],
    [`gmn-worker:${tag}`, { Id: `sha256:${CONFIG_DIGEST_WORKER}`, RepoTags: [`gmn-worker:${tag}`], Layers: [...WORKER_DIFF_IDS] }],
  ]);
/** Imagens carregadas no armazenamento containerd (id = digest do manifesto; a conferência é pelos diff_ids e pela tag). */
export const containerdImages = (tag: string): Map<string, LoadedImage> =>
  new Map([
    [`gmn-web:${tag}`, { Id: CONTAINERD_ID_WEB, RepoTags: [`gmn-web:${tag}`], Layers: [...WEB_DIFF_IDS] }],
    [`gmn-worker:${tag}`, { Id: CONTAINERD_ID_WORKER, RepoTags: [`gmn-worker:${tag}`], Layers: [...WORKER_DIFF_IDS] }],
  ]);
export const bundleConfigs = (): Map<string, Buffer> =>
  new Map([
    [WEB_CONFIG_PATH, WEB_CONFIG],
    [WORKER_CONFIG_PATH, WORKER_CONFIG],
  ]);

/** Uma linha do `tar -tv` do GNU tar. */
export const listLine = (type: string, size: number, name: string): string => `${type}${type === 'd' ? 'rwxr-xr-x' : 'rw-r--r--'} 0/0 ${String(size).padStart(12)} 1970-01-01 00:00 ${name}`;
const LAYER_BYTES = 1024 * 1024;

/** A listagem que o `docker save` produziria para o manifesto e os Config dados (formato OCI + os nomes do manifesto). */
export function listingFor(manifest: string, configs: ReadonlyMap<string, Buffer>): string {
  let entries: Array<{ Config?: unknown; Layers?: unknown }> = [];
  try {
    const parsed: unknown = JSON.parse(manifest);
    if (Array.isArray(parsed)) entries = parsed as typeof entries;
  } catch {
    entries = [];
  }
  const files = new Map<string, number>([['index.json', 300], ['manifest.json', Buffer.byteLength(manifest)], ['oci-layout', 30]]);
  for (const [name, bytes] of configs) files.set(name, bytes.length);
  for (const entry of entries) {
    if (typeof entry.Config === 'string' && !files.has(entry.Config)) files.set(entry.Config, 1000);
    for (const layer of Array.isArray(entry.Layers) ? entry.Layers : []) if (typeof layer === 'string') files.set(layer, LAYER_BYTES);
  }
  const lines = [listLine('d', 0, 'blobs/'), listLine('d', 0, 'blobs/sha256/'), ...[...files].map(([name, size]) => listLine('-', size, name))];
  return `${lines.join('\n')}\n`;
}

export function manifestFor(tag: string, overrides: { web?: string; worker?: string; extra?: boolean; drop?: boolean } = {}): string {
  const entries = [
    { Config: WEB_CONFIG_PATH, RepoTags: [overrides.web ?? `gmn-web:${tag}`], Layers: [`blobs/sha256/${'1'.repeat(64)}`] },
    { Config: WORKER_CONFIG_PATH, RepoTags: [overrides.worker ?? `gmn-worker:${tag}`], Layers: [`blobs/sha256/${'2'.repeat(64)}`] },
  ];
  if (overrides.extra) entries.push({ Config: `blobs/sha256/${'e'.repeat(64)}`, RepoTags: ['traefik:latest'], Layers: [] });
  if (overrides.drop) entries.pop();
  return JSON.stringify(entries);
}

const result = (exitCode: number | null, stdout = '', stderr = ''): RunResult => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), timedOut: false, overflow: false });

export function baseService(name: string, image: string, replicas: number, extra: Partial<FakeService['Spec']['TaskTemplate']['ContainerSpec']> = {}): FakeService {
  return { ID: `id-${name}`, Spec: { Name: name, Mode: { Replicated: { Replicas: replicas } }, TaskTemplate: { ContainerSpec: { Image: image, ...extra } }, EndpointSpec: { Ports: [] } }, Endpoint: {}, UpdateStatus: null, running: image };
}

/** O `docker`, o `tar`, o `gzip` e o script de pastas, falsos e em processo; registra cada chamada (argv e ambiente). */
export class FakeRunner implements ProcessRunner {
  readonly calls: RunRequest[] = [];
  readonly composeCalls: ComposeCall[] = [];
  private polls = 0;
  private lastState = 'completed';
  private readonly taskImages = new Map<string, string>();
  private readonly containers = new Map<string, string>();
  private deployed = false;
  private oldWebImage = 'gmn-web:anterior';
  constructor(readonly scenario: DockerScenario, readonly stackName: string, readonly env: 'producao' | 'homologacao') {}

  dockerCalls(): string[][] {
    return this.calls.filter((call) => call.program === 'docker').map((call) => [...call.args]);
  }
  called(prefix: readonly string[]): boolean {
    return this.dockerCalls().some((args) => prefix.every((part, index) => args[index] === part));
  }

  async run(request: RunRequest): Promise<RunResult> {
    this.calls.push(request);
    this.scenario.beforeCall?.(request);
    if (request.program === 'docker' && request.args[0] === 'stack') this.recordCompose(request);
    if (typeof request.program !== 'string') return this.scenario.foldersOk ? result(0, `ok ${DOCKER_NOISE}`) : result(1, '', `[verificar-pastas-fase6] RECUSADO: ${DOCKER_NOISE}`);
    if (request.program === 'gzip') return result(this.scenario.gzipOk ? 0 : 1, '', this.scenario.gzipOk ? '' : `gzip: ${DOCKER_NOISE}: invalid`);
    if (request.program === 'tar') return request.args[0] === '-tvzf' ? this.list_() : this.tar(request.args[2] as string);
    return this.docker(request);
  }

  private recordCompose(request: RunRequest): void {
    const files = request.args.flatMap((arg, index) => (request.args[index - 1] === '-c' ? [arg] : [])).map((file) => ({ path: file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null }));
    this.composeCalls.push({ sub: request.args[1] as string, files, env: request.env });
  }

  private docker(request: RunRequest): RunResult {
    const [a, b] = request.args;
    if (a === 'info') return result(0, `${JSON.stringify(this.scenario.rootDir)}\n`);
    if (a === 'inspect' && b === '--type') return this.objectInspect(request.args[2] as string, request.args[request.args.length - 1] as string);
    if (a === 'service' && b === 'inspect') return this.inspect(request.args.slice(2));
    if (a === 'service' && b === 'ls') return this.list();
    if (a === 'service' && b === 'ps') return this.tasks(request.args[request.args.length - 1] as string);
    if (a === 'image' && b === 'inspect') return this.imageInspect(request.args[request.args.length - 1] as string);
    if (a === 'load') return this.scenario.loadOk ? result(0, `Loaded image: ${DOCKER_NOISE}\n`) : result(1, '', `Error: ${DOCKER_NOISE}`);
    if (a === 'stack' && b === 'config') return this.scenario.stackConfigOk ? result(0, `services: ${DOCKER_NOISE} ${request.env.GMN_OPERATOR_EMAILS ?? ''}\n`) : result(1, '', `invalid interpolation ${DOCKER_NOISE}`);
    if (a === 'stack' && b === 'deploy') return this.deploy(request);
    return result(1, '', `fake docker: unexpected ${request.args.join(' ')}`);
  }

  private inspect(names: readonly string[]): RunResult {
    const services = names.map((name) => [...this.scenario.services.values()].find((service) => service.Spec.Name === name || service.ID === name));
    if (services.some((service) => service === undefined)) return result(1, '[]\n', `Error: no such service: ${names[0]}`);
    const view = (services as FakeService[]).map((service) => {
      const { running: _running, ...rest } = service;
      if (service.Spec.Name === `${this.stackName}_gmn-web` && this.deployed) {
        this.lastState = this.currentState();
        this.polls += 1;
        return { ...rest, UpdateStatus: this.updateFor(this.lastState) };
      }
      return rest;
    });
    return result(0, `${JSON.stringify(view)}\n`);
  }

  private currentState(): string {
    const states = this.scenario.updateStates;
    return states[Math.min(this.polls, states.length - 1)] ?? 'completed';
  }

  private updateFor(state: string): FakeService['UpdateStatus'] {
    const web = this.scenario.services.get(`${this.stackName}_gmn-web`);
    if (state === 'stale' || state === 'stale-new-image') return web?.UpdateStatus ?? null;
    if (state === 'none') return null;
    return { State: state === 'updating-new-image' ? 'updating' : state, StartedAt: '2026-11-23T00:00:01Z' };
  }

  private tasks(name: string): RunResult {
    const service = this.scenario.services.get(name);
    if (!service) return result(1, '', 'no such service');
    if ((service.Spec.Mode.Replicated?.Replicas ?? 0) === 0) return result(0, '');
    const isWeb = name === `${this.stackName}_gmn-web`;
    const fresh = !isWeb || ['completed', 'none', 'stale-new-image', 'updating-new-image'].includes(this.lastState);
    const image = fresh ? service.Spec.TaskTemplate.ContainerSpec.Image : this.oldWebImage;
    const id = `t${sha256(name).slice(0, 24)}`;
    this.taskImages.set(id, fresh ? (this.scenario.runningImageIds?.get(name) ?? this.scenario.loadedImages.get(image)?.Id ?? OLD_IMAGE_ID) : OLD_IMAGE_ID);
    return result(0, `${JSON.stringify({ ID: id, Image: image, CurrentState: 'Running 3 seconds ago', DesiredState: 'Running' })}\n`);
  }

  /** `docker inspect --type task|container --format … <id>`: tarefa ⇒ contêiner ⇒ id da imagem do contêiner. */
  private objectInspect(type: string, id: string): RunResult {
    if (type === 'task') {
      if (!this.taskImages.has(id)) return result(1, '', 'Error: No such task');
      const container = sha256(`contêiner ${id}`);
      this.containers.set(container, id);
      return result(0, `${JSON.stringify(container)}\n`);
    }
    const task = this.containers.get(id);
    return task === undefined ? result(1, '', 'Error: No such container') : result(0, `${JSON.stringify(this.taskImages.get(task))}\n`);
  }

  private list(): RunResult {
    if (this.scenario.serviceLsFails) return result(1, '', 'Cannot connect');
    const lines = [...this.scenario.services.values()].map((service) => {
      const desired = service.Spec.Mode.Replicated?.Replicas ?? 0;
      return JSON.stringify({ ID: service.ID, Name: service.Spec.Name, Replicas: service.running === 'down' ? `0/${desired}` : `${desired}/${desired}`, Ports: '' });
    });
    return result(0, `${lines.join('\n')}\n`);
  }

  private list_(): RunResult {
    if (!this.scenario.tarOk) return result(2, '', `tar: ${DOCKER_NOISE}`);
    return result(0, this.scenario.listing ?? listingFor(this.scenario.manifest, this.scenario.configs));
  }

  private tar(member: string): RunResult {
    if (!this.scenario.tarOk) return result(2, '', `tar: ${DOCKER_NOISE}`);
    if (member === 'manifest.json') return result(0, this.scenario.manifest);
    const config = this.scenario.configs.get(member);
    return config === undefined ? { ...result(2, '', `tar: ${member}: Not found in archive ${DOCKER_NOISE}`) } : { ...result(0), stdout: config };
  }

  private imageInspect(ref: string): RunResult {
    const image = this.scenario.loadedImages.get(ref);
    if (image === undefined) return result(1, '', `Error: No such image: ${ref}`);
    // o ambiente da imagem (sentinela) nunca pode ir a lugar nenhum
    return result(0, `${JSON.stringify({ Id: image.Id, RepoTags: image.RepoTags, RootFS: { Type: 'layers', Layers: image.Layers }, Config: { Env: [`NEXT_PUBLIC_SUPABASE_URL=${SENTINEL_URL}`] } })}\n`);
  }

  private deploy(request: RunRequest): RunResult {
    if (!this.scenario.stackDeployOk) return result(1, '', `failed to update service ${DOCKER_NOISE}`);
    const tag = request.env.GMN_IMAGE_TAG ?? '';
    const env = [`GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS=${request.env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS ?? ''}`, `GMN_OPERATOR_EMAILS=${request.env.GMN_OPERATOR_EMAILS ?? ''}`];
    if (this.env === 'homologacao') env.push('GMN_LINK_AUDIT_HOMOLOGATION=1');
    const services = this.scenario.services;
    const previous = services.get(`${this.stackName}_gmn-web`);
    if (previous) this.oldWebImage = previous.Spec.TaskTemplate.ContainerSpec.Image;
    if (!(this.scenario.specUnchanged && previous)) services.set(`${this.stackName}_gmn-web`, { ...baseService(`${this.stackName}_gmn-web`, `gmn-web:${tag}`, 1, { Env: env }), UpdateStatus: previous?.UpdateStatus ?? null });
    services.set(`${this.stackName}_gmn-worker`, baseService(`${this.stackName}_gmn-worker`, `gmn-worker:${tag}`, Number(request.env.GMN_WORKER_REPLICAS ?? '0'), { Mounts: [{ Type: 'bind', Source: '/srv/x/audits', Target: '/app/.data/audits' }, { Type: 'tmpfs', Target: '/tmp' }] }));
    if (!services.has(`${this.stackName}_gmn-redis`)) services.set(`${this.stackName}_gmn-redis`, baseService(`${this.stackName}_gmn-redis`, 'redis:7.4.11-alpine', 1));
    this.scenario.afterDeploy?.(services);
    this.deployed = true;
    return result(0, `Updating service ${this.stackName}_gmn-web (id: ${DOCKER_NOISE})\n`, 'Since --detach=false was not specified, tasks will be updated in the background.\n');
  }
}

/* ------------------------------------------------------------------------------------------------------------------------- mundo */

export interface WorldOptions {
  env?: 'producao' | 'homologacao';
  /** Linhas do arquivo de variáveis; o padrão é um arquivo válido para o ambiente. */
  hostVars?: string | Buffer;
  /** Lista instalada antes (`null` = ausente). */
  installed?: Buffer | null;
  /** Lista enviada no stdin. */
  trust?: Buffer;
  freeBytes?: number;
}

export interface World {
  readonly root: string;
  readonly env: 'producao' | 'homologacao';
  readonly stateDir: string;
  readonly stackFile: string;
  readonly overlayFile: string | null;
  readonly hostVarsFile: string;
  readonly foldersCheck: string;
  readonly logFile: string;
  readonly dataPrefix: string | null;
  readonly dataFolders: readonly string[];
  readonly stackName: string;
  readonly tag: string;
  readonly bundle: Buffer;
  readonly bundleSha256: string;
  readonly stackSha256: string;
  readonly overlaySha256: string | null;
  trust: Buffer;
  readonly scenario: DockerScenario;
  freeBytes: number;
  readonly keys: { readonly a: TestKey; readonly b: TestKey };
}

export const FOLDER_NAMES = ['decisoes', 'recibos-decisoes', 'resultados', 'recibos-resultados', 'livro', 'manifestos'] as const;
/** As origens de bind que a stack deriva de `GMN_DATA_ROOT` (`${GMN_DATA_ROOT:-/srv/gmn}/<pasta>`). */
export const DERIVED_BIND_FOLDERS = ['audits', 'link-audits', 'evidence', 'redis'] as const;
const REPO_ROOT = path.join(__dirname, '..', '..');
const VAR_NAMES = ['GMN_RAIZ_DADOS_DECISOES', 'GMN_RAIZ_DADOS_RECIBOS_DECISOES', 'GMN_RAIZ_DADOS_RESULTADOS', 'GMN_RAIZ_DADOS_RECIBOS_RESULTADOS', 'GMN_RAIZ_DADOS_LIVRO', 'GMN_RAIZ_DADOS_MANIFESTOS'] as const;

export function validHostVars(env: 'producao' | 'homologacao', folders: readonly string[], dataRoot: string, url = SENTINEL_URL): string {
  const lines = [
    '# arquivo de variáveis fictício (teste)',
    `GMN_HOST=${SENTINEL_HOST}`,
    'GMN_NODE_HOSTNAME=no-ficticio',
    `NEXT_PUBLIC_SUPABASE_URL="${url}"`,
    `GMN_OPERATOR_EMAILS='${SENTINEL_EMAIL}'`,
    'GMN_HTTP_ENTRYPOINT=web',
    'GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS=',
    '',
    `GMN_DATA_ROOT=${dataRoot}`,
    ...VAR_NAMES.map((name, index) => `${name}=${folders[index]}`),
    'GMN_WORKER_REPLICAS=0',
  ];
  if (env === 'homologacao') lines.push('GMN_TRAEFIK_NAME=gmn-hml');
  return `${lines.join('\n')}\n`;
}

export function world(options: WorldOptions = {}): World {
  const env = options.env ?? 'producao';
  const root = fs.realpathSync(tmpDir('dr-world-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { mode: 0o711 });
  // a stack e a sobreposição REAIS do repositório (as origens de bind e os nomes interpolados saem delas)
  const stackFile = path.join(root, 'opt', 'stack.yml');
  fs.mkdirSync(path.dirname(stackFile), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'deploy', 'hostinger', 'stack.yml'), stackFile);
  const overlayFile = env === 'homologacao' ? path.join(root, 'opt', 'stack-hml.yml') : null;
  if (overlayFile) fs.copyFileSync(path.join(REPO_ROOT, 'deploy', 'hostinger', 'stack-hml.yml'), overlayFile);
  const dataRoot = path.join(root, 'srv', env === 'homologacao' ? 'gmn-hml' : 'gmn');
  const dataFolders = FOLDER_NAMES.map((name) => path.join(dataRoot, name));
  for (const folder of [...dataFolders, ...DERIVED_BIND_FOLDERS.map((name) => path.join(dataRoot, name))]) fs.mkdirSync(folder, { recursive: true });
  const hostVarsFile = path.join(root, 'opt', 'variaveis');
  fs.writeFileSync(hostVarsFile, options.hostVars ?? validHostVars(env, dataFolders, dataRoot));
  const foldersCheck = path.join(root, 'opt', 'verificar-pastas-fase6.sh');
  fs.writeFileSync(foldersCheck, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const keys = { a: testKey(env === 'homologacao' ? 'ensaio-chave-a' : 'chave-prod-a'), b: testKey(env === 'homologacao' ? 'ensaio-chave-b' : 'chave-prod-b') };
  if (options.installed !== undefined && options.installed !== null) fs.writeFileSync(path.join(stateDir, 'trust-keys.txt'), options.installed, { mode: 0o644 });
  const bundle = Buffer.from(`pacote fictício ${SHA40}\n`.repeat(64));
  const incoming = path.join(stateDir, 'incoming');
  fs.mkdirSync(incoming, { mode: 0o700 });
  fs.writeFileSync(path.join(incoming, `bundle-${SHA40}.tar.gz`), bundle, { mode: 0o600 });
  const stackName = env === 'homologacao' ? 'gmn-hml' : 'gmn';
  const tag = `${env}-${SHA40}`;
  const scenario: DockerScenario = {
    services: new Map(),
    rootDir: '/var/lib/docker',
    manifest: manifestFor(tag),
    gzipOk: true,
    tarOk: true,
    loadOk: true,
    configs: bundleConfigs(),
    loadedImages: classicImages(tag),
    stackConfigOk: true,
    stackDeployOk: true,
    foldersOk: true,
    updateStates: ['updating', 'completed'],
  };
  return {
    root,
    env,
    stateDir,
    stackFile,
    overlayFile,
    hostVarsFile,
    foldersCheck,
    logFile: path.join(root, 'receptor.log'),
    dataPrefix: env === 'homologacao' ? `${dataRoot}/` : null,
    dataFolders,
    stackName,
    tag,
    bundle,
    bundleSha256: sha256(bundle),
    stackSha256: sha256(fs.readFileSync(stackFile)),
    overlaySha256: overlayFile ? sha256(fs.readFileSync(overlayFile)) : null,
    trust: options.trust ?? trustFile([trustLine(keys.a)]),
    scenario,
    freeBytes: options.freeBytes ?? 64 * 1024 * 1024 * 1024,
    keys,
  };
}

export function wrapperArgs(w: World, forbid = fp12(PRODUCTION_URL)): string[] {
  const args = ['--env', w.env, '--stack-name', w.stackName, '--stack', w.stackFile, '--host-vars', w.hostVarsFile, '--folders-check', w.foldersCheck, '--state', w.stateDir, '--log', w.logFile];
  if (w.env === 'homologacao') args.push('--overlay', w.overlayFile as string, '--data-prefix', w.dataPrefix as string, '--forbid-supabase', forbid);
  return args;
}

export function deployCommand(w: World, over: Partial<{ sha40: string; bundle: string; stack: string; overlay: string; trust: string; fp: string }> = {}): string {
  const overlay = over.overlay ?? (w.overlaySha256 ?? '-');
  return ['deploy', over.sha40 ?? SHA40, over.bundle ?? w.bundleSha256, over.stack ?? w.stackSha256, overlay, over.trust ?? sha256(w.trust), over.fp ?? fp12(SENTINEL_URL)].join(' ');
}

export interface Run {
  readonly outcome: ReceiverOutcome;
  readonly runner: FakeRunner;
  readonly stdin: FakeStdin;
  readonly log: MemoryLog;
  readonly clock: FakeClock;
}

/** Uma execução em processo do receptor completo (`runDeployReceiver`), com as portas falsas e o disco real das pastas temporárias. */
export async function runReceiver(w: World, command: string | undefined, stdin: FakeStdin = FakeStdin.of(w.trust), argv: readonly string[] = wrapperArgs(w)): Promise<Run> {
  const runner = new FakeRunner(w.scenario, w.stackName, w.env);
  const log = new MemoryLog();
  const clock = new FakeClock();
  let suffix = 0;
  const factory = (_config: ReceiverConfig, childPath: string): ReceiverDeps => ({
    fs: { ...nodeReceiverFs, availableBytes: async () => w.freeBytes },
    runner,
    clock,
    lock: nodeLock,
    stdin,
    log,
    childPath,
    randomSuffix: () => (suffix += 1).toString(16).padStart(16, '0'),
  });
  const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
  if (command !== undefined) env.SSH_ORIGINAL_COMMAND = command;
  const outcome = await runDeployReceiver({ argv, env }, factory);
  return { outcome, runner, stdin, log, clock };
}

/** A única linha pública (stdout ou stderr) de uma execução, e nada mais. */
export function publicText(outcome: ReceiverOutcome): string {
  return `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`;
}
