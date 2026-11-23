import { z } from 'zod';
import { ReceiverError, type PostdeployCheckId } from './codes';
import { isImageRef } from './converge';
import { dockerQuery, inspectService, parseJsonLines, parseJsonWith, ServiceSchema, type ServiceInfo } from './docker';
import type { DeployEnvironment } from './grammar';
import type { ReceiverDeps } from './ports';

/*
 * P9.3a — passo 13 do `deploy` (spec §5.6; `VERIFICACAO-POS-DEPLOY.md` §1–2 e EN-12): verificações SOMENTE LEITURA, cada uma com id fixo, na
 * ordem; a primeira reprovada ⇒ `E_POSTDEPLOY_CHECK <PD-xx>` (o serviço já foi atualizado: o responsável decide pelo `PLANO-DE-ROLLBACK.md`).
 *   PD-01 web 1/1 · PD-02 redis 1/1 · PD-03 Worker com as réplicas do arquivo (homologação: 0) · PD-04 nenhuma porta publicada na stack ·
 *   PD-05 Worker só com a pasta de PDFs e `/tmp` · PD-06 imagens = `gmn-web:<tag>` e `gmn-worker:<tag>` · PD-07 a variável da lista no web = a
 *   lista recebida · PD-08 produção sem `GMN_LINK_AUDIT_HOMOLOGATION` no web, homologação com `1`.
 * Uma consulta que falha reprova a verificação que dependia dela.
 */

export const TRUST_KEYS_ENV = 'GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS';
export const HOMOLOGATION_ENV = 'GMN_LINK_AUDIT_HOMOLOGATION';
/** Montagens do Worker no `stack.yml`: a pasta de PDFs (bind) e `/tmp` (tmpfs). Nada da Fase 6. */
export const WORKER_MOUNTS: readonly string[] = ['bind:/app/.data/audits', 'tmpfs:/tmp'];
const REPLICAS = /^(\d+)\/(\d+)/;

export interface PostdeployInput {
  readonly stackName: string;
  readonly env: DeployEnvironment;
  readonly webRef: string;
  readonly workerRef: string;
  readonly workerReplicas: number;
  readonly trustValue: string;
}

const ListedServiceSchema = z.object({ ID: z.string(), Name: z.string(), Replicas: z.string() });
type ListedService = z.infer<typeof ListedServiceSchema>;

const fail = (id: PostdeployCheckId, note: string): ReceiverError => new ReceiverError('E_POSTDEPLOY_CHECK', id, note);

async function stackServices(stackName: string, deps: ReceiverDeps): Promise<readonly ListedService[]> {
  const raw = await dockerQuery(['service', 'ls', '--filter', `label=com.docker.stack.namespace=${stackName}`, '--format', '{{json .}}'], 'docker service ls', 'E_POSTDEPLOY_CHECK', deps);
  return parseJsonLines(raw, ListedServiceSchema, 'E_POSTDEPLOY_CHECK', 'docker service ls');
}

function checkReplicas(services: readonly ListedService[], name: string, wanted: number, id: PostdeployCheckId): void {
  const replicas = REPLICAS.exec(services.find((service) => service.Name === name)?.Replicas ?? '');
  if (replicas === null || Number(replicas[1]) !== wanted || Number(replicas[2]) !== wanted) throw fail(id, `${name} replicas`);
}

const hasPorts = (ports: readonly unknown[] | null | undefined): boolean => (ports ?? []).length > 0;

async function checkNoPublishedPorts(services: readonly ListedService[], deps: ReceiverDeps): Promise<void> {
  if (services.length === 0) throw fail('PD-04', 'no services');
  const raw = await dockerQuery(['service', 'inspect', ...services.map((service) => service.ID)], 'docker service inspect (stack)', 'E_POSTDEPLOY_CHECK', deps);
  const inspected = parseJsonWith(raw, z.array(ServiceSchema), 'E_POSTDEPLOY_CHECK', 'docker service inspect (stack)');
  if (inspected.length !== services.length || inspected.some((service) => hasPorts(service.Spec.EndpointSpec?.Ports) || hasPorts(service.Endpoint?.Ports))) throw fail('PD-04', 'published port');
}

function checkWorkerMounts(worker: ServiceInfo): void {
  const mounts = (worker.Spec.TaskTemplate.ContainerSpec.Mounts ?? []).map((mount) => `${mount.Type ?? ''}:${mount.Target}`).sort();
  if (mounts.join('\n') !== [...WORKER_MOUNTS].sort().join('\n')) throw fail('PD-05', 'worker mounts');
}

/** As entradas `NOME=…` do ambiente do serviço. */
const envEntries = (service: ServiceInfo, name: string): string[] => (service.Spec.TaskTemplate.ContainerSpec.Env ?? []).filter((entry) => entry.startsWith(`${name}=`));

function checkEnvironment(web: ServiceInfo, input: PostdeployInput): void {
  const trust = envEntries(web, TRUST_KEYS_ENV);
  if (trust.length !== 1 || trust[0] !== `${TRUST_KEYS_ENV}=${input.trustValue}`) throw fail('PD-07', 'trust list variable differs');
  const lock = envEntries(web, HOMOLOGATION_ENV);
  const lockOk = input.env === 'producao' ? lock.length === 0 : lock.length === 1 && lock[0] === `${HOMOLOGATION_ENV}=1`;
  if (!lockOk) throw fail('PD-08', 'homologation lock');
}

async function requireService(name: string, id: PostdeployCheckId, deps: ReceiverDeps): Promise<ServiceInfo> {
  let service: ServiceInfo | null;
  try {
    service = await inspectService(name, 'E_POSTDEPLOY_CHECK', deps);
  } catch {
    throw fail(id, `${name} inspect failed`);
  }
  if (service === null) throw fail(id, `${name} missing`);
  return service;
}

async function withCheck<T>(id: PostdeployCheckId, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReceiverError && error.code === 'E_POSTDEPLOY_CHECK' && error.detail !== null) throw error;
    throw fail(id, error instanceof ReceiverError && error.logNote !== null ? error.logNote : 'query failed');
  }
}

/** PD-01 a PD-08, na ordem. */
export async function runPostdeployChecks(input: PostdeployInput, deps: ReceiverDeps): Promise<void> {
  const services = await withCheck('PD-01', () => stackServices(input.stackName, deps));
  checkReplicas(services, `${input.stackName}_gmn-web`, 1, 'PD-01');
  checkReplicas(services, `${input.stackName}_gmn-redis`, 1, 'PD-02');
  checkReplicas(services, `${input.stackName}_gmn-worker`, input.env === 'homologacao' ? 0 : input.workerReplicas, 'PD-03');
  await withCheck('PD-04', () => checkNoPublishedPorts(services, deps));
  const worker = await requireService(`${input.stackName}_gmn-worker`, 'PD-05', deps);
  checkWorkerMounts(worker);
  const web = await requireService(`${input.stackName}_gmn-web`, 'PD-06', deps);
  if (!isImageRef(web.Spec.TaskTemplate.ContainerSpec.Image, input.webRef) || !isImageRef(worker.Spec.TaskTemplate.ContainerSpec.Image, input.workerRef)) throw fail('PD-06', 'service images');
  checkEnvironment(web, input);
  deps.log.write('postdeploy.ok');
}
