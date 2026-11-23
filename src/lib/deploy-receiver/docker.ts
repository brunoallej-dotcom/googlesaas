import { z } from 'zod';
import { ReceiverError, type ReceiverCode } from './codes';
import type { ReceiverDeps, ReceiverProgram, RunResult } from './ports';

/*
 * P9.3a — as chamadas aos programas do host (spec §5.6): `docker`, `tar`, `gzip` e o script de pastas, sempre por `execFile` com argv fixo e sem
 * shell (porta `ProcessRunner`). A saída deles NUNCA vai à saída pública: o stderr (com teto) vai ao log local e o stdout só quando não leva
 * ambiente (o `service inspect` e o `stack config` têm o ambiente renderizado: e-mails de operador, URL do projeto). Toda saída que o receptor
 * interpreta passa por um esquema zod (fronteira).
 */

export const QUERY_TIMEOUT_MS = 60_000;
export const QUERY_MAX_OUTPUT = 4 * 1024 * 1024;
const LOG_OUTPUT_CHARS = 4096;

export interface ProgramCall {
  readonly program: ReceiverProgram;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** O stdout pode ir ao log local (não leva ambiente nem conteúdo de arquivo do host). */
  readonly logStdout: boolean;
  /** Rótulo fixo do passo no log. */
  readonly label: string;
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');
const clip = (value: string): string => (value.length > LOG_OUTPUT_CHARS ? `${value.slice(0, LOG_OUTPUT_CHARS)}…` : value);

/** Roda um programa e registra no log local o rótulo, a saída numérica e o stderr (e o stdout, quando permitido). Nunca lança por saída ≠ 0. */
export async function runProgram(call: ProgramCall, deps: Pick<ReceiverDeps, 'runner' | 'log'>): Promise<RunResult> {
  const result = await deps.runner.run({ program: call.program, args: call.args, env: call.env, timeoutMs: call.timeoutMs, maxOutputBytes: call.maxOutputBytes });
  deps.log.write('program', {
    label: call.label,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    overflow: result.overflow,
    stderr: clip(text(result.stderr)) || null,
    stdout: call.logStdout ? clip(text(result.stdout)) || null : null,
  });
  return result;
}

const succeeded = (result: RunResult): boolean => result.exitCode === 0 && !result.timedOut && !result.overflow;

/** Uma consulta somente leitura ao Docker; saída ≠ 0 ⇒ `ReceiverError(code)`. Devolve o stdout. */
export async function dockerQuery(args: readonly string[], label: string, code: ReceiverCode, deps: Pick<ReceiverDeps, 'runner' | 'log' | 'childPath'>): Promise<string> {
  const result = await runProgram({ program: 'docker', args, env: { PATH: deps.childPath }, timeoutMs: QUERY_TIMEOUT_MS, maxOutputBytes: QUERY_MAX_OUTPUT, logStdout: false, label }, deps);
  if (!succeeded(result)) throw new ReceiverError(code, null, `${label} failed`);
  return text(result.stdout);
}

/** Interpreta JSON com um esquema; fora dele ⇒ `ReceiverError(code)` (a saída nunca vai à mensagem). */
export function parseJsonWith<T>(raw: string, schema: z.ZodType<T>, code: ReceiverCode, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ReceiverError(code, null, `${label}: not JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ReceiverError(code, null, `${label}: unexpected shape`);
  return parsed.data;
}

/** Uma linha JSON por item (`--format '{{json .}}'`). */
export function parseJsonLines<T>(raw: string, schema: z.ZodType<T>, code: ReceiverCode, label: string): T[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseJsonWith(line, schema, code, label));
}

const MountSchema = z.object({ Type: z.string().optional(), Source: z.string().optional(), Target: z.string(), ReadOnly: z.boolean().optional() });
const PortsSchema = z.array(z.unknown()).nullable().optional();
export const ServiceSchema = z.object({
  ID: z.string(),
  Spec: z.object({
    Name: z.string(),
    Mode: z.object({ Replicated: z.object({ Replicas: z.number().int().nonnegative() }).optional() }),
    TaskTemplate: z.object({
      ContainerSpec: z.object({ Image: z.string(), Env: z.array(z.string()).nullable().optional(), Mounts: z.array(MountSchema).nullable().optional() }),
    }),
    EndpointSpec: z.object({ Ports: PortsSchema }).nullable().optional(),
  }),
  Endpoint: z.object({ Ports: PortsSchema }).nullable().optional(),
  UpdateStatus: z.object({ State: z.string(), StartedAt: z.string().optional() }).nullable().optional(),
});
export type ServiceInfo = z.infer<typeof ServiceSchema>;
const ServiceArraySchema = z.array(ServiceSchema);
const NO_SUCH_SERVICE = /no such service/i;

/** `docker service inspect <nome>`: o serviço, ou `null` se ele não existe. Outra falha ⇒ `ReceiverError(code)`. */
export async function inspectService(name: string, code: ReceiverCode, deps: Pick<ReceiverDeps, 'runner' | 'log' | 'childPath'>): Promise<ServiceInfo | null> {
  const label = `docker service inspect ${name}`;
  const result = await runProgram({ program: 'docker', args: ['service', 'inspect', name], env: { PATH: deps.childPath }, timeoutMs: QUERY_TIMEOUT_MS, maxOutputBytes: QUERY_MAX_OUTPUT, logStdout: false, label }, deps);
  if (result.exitCode !== 0 && !result.timedOut && !result.overflow && NO_SUCH_SERVICE.test(text(result.stderr))) return null;
  if (!succeeded(result)) throw new ReceiverError(code, null, `${label} failed`);
  const services = parseJsonWith(text(result.stdout), ServiceArraySchema, code, label);
  const found = services.find((service) => service.Spec.Name === name);
  if (services.length !== 1 || found === undefined) throw new ReceiverError(code, null, `${label}: unexpected result`);
  return found;
}

/** `docker info`: a raiz de dados do Docker (para o espaço livre do passo 8). */
export async function dockerRootDir(deps: Pick<ReceiverDeps, 'runner' | 'log' | 'childPath'>): Promise<string> {
  const raw = await dockerQuery(['info', '--format', '{{json .DockerRootDir}}'], 'docker info', 'E_INTERNAL', deps);
  const root = parseJsonWith(raw, z.string().regex(/^\/[^\0]*$/), 'E_INTERNAL', 'docker info');
  return root;
}

/** O que o receptor usa do `docker image inspect` (o resto, como o ambiente da imagem, nem vai ao log). */
const ImageInfoSchema = z.object({
  Id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  RepoTags: z.array(z.string()).nullable().optional(),
  RootFS: z.object({ Layers: z.array(z.string()).nullable().optional() }).nullable().optional(),
});
export type ImageInfo = z.infer<typeof ImageInfoSchema>;

/** `docker image inspect --format '{{json .}}' <ref>`: id (`sha256:<64 hex>`), tags e diff_ids da imagem carregada. */
export async function imageInfo(ref: string, deps: Pick<ReceiverDeps, 'runner' | 'log' | 'childPath'>): Promise<ImageInfo> {
  const raw = await dockerQuery(['image', 'inspect', '--format', '{{json .}}', ref], `docker image inspect ${ref}`, 'E_DOCKER_LOAD', deps);
  return parseJsonWith(raw.trim(), ImageInfoSchema, 'E_DOCKER_LOAD', 'docker image inspect');
}
