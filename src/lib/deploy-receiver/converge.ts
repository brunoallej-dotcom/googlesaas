import { z } from 'zod';
import { ReceiverError } from './codes';
import { dockerQuery, inspectService, parseJsonLines, type ServiceInfo } from './docker';
import type { ReceiverDeps } from './ports';

/*
 * P9.3a — passo 12 do `deploy` (spec §5.6): por até 10 min, a atualização do web termina `completed` e as tarefas rodam a imagem nova. Se ela
 * terminar `rollback_*` (o `failure_action: rollback` do `stack.yml`), `E_ROLLED_BACK`; se o prazo vencer, `E_CONVERGE_TIMEOUT`. O receptor NUNCA
 * faz rollback por conta própria (R6-09).
 *
 * Só conta a atualização que começou DEPOIS do `stack deploy`: o `UpdateStatus` lido antes (`StartedAt`) fica de fora, para um
 * `rollback_completed` antigo não virar `E_ROLLED_BACK` e um `completed` antigo não valer como convergência. Sem atualização nova (serviço criado
 * agora, ou o mesmo commit de novo, especificação igual), basta as tarefas em execução rodarem a imagem nova.
 */

export const CONVERGE_TIMEOUT_MS = 10 * 60_000;
export const CONVERGE_POLL_MS = 5_000;
const ROLLBACK_STATE = /^rollback_/;
const COMPLETED_STATE = 'completed';
const RUNNING_STATE = /^Running\b/;

export interface UpdateMark {
  readonly startedAt: string | null;
}

/** O `UpdateStatus` do web antes do `stack deploy` (`null` se o serviço não existe ou nunca foi atualizado). */
export const updateMarkOf = (service: ServiceInfo | null): UpdateMark | null => (service?.UpdateStatus ? { startedAt: service.UpdateStatus.StartedAt ?? null } : null);

const TaskSchema = z.object({ Image: z.string(), CurrentState: z.string(), DesiredState: z.string() });

/** A referência de imagem do serviço é a tag nova (com ou sem o digest que o Docker pode acrescentar). */
export const isImageRef = (image: string, ref: string): boolean => image === ref || image.startsWith(`${ref}@sha256:`);

async function tasksRunImage(serviceName: string, ref: string, deps: ReceiverDeps): Promise<boolean> {
  const raw = await dockerQuery(['service', 'ps', '--no-trunc', '--filter', 'desired-state=running', '--format', '{{json .}}', serviceName], `docker service ps ${serviceName}`, 'E_CONVERGE_TIMEOUT', deps);
  const tasks = parseJsonLines(raw, TaskSchema, 'E_CONVERGE_TIMEOUT', 'docker service ps');
  return tasks.length > 0 && tasks.every((task) => isImageRef(task.Image, ref) && RUNNING_STATE.test(task.CurrentState));
}

type PollVerdict = 'converged' | 'rolled_back' | 'waiting';

async function pollOnce(serviceName: string, ref: string, before: UpdateMark | null, deps: ReceiverDeps): Promise<PollVerdict> {
  const service = await inspectService(serviceName, 'E_CONVERGE_TIMEOUT', deps);
  if (service === null) return 'waiting';
  const status = service.UpdateStatus ?? null;
  const isNewUpdate = status !== null && (before === null || (status.StartedAt ?? null) !== before.startedAt);
  if (isNewUpdate && ROLLBACK_STATE.test(status.State)) return 'rolled_back';
  if (isNewUpdate && status.State !== COMPLETED_STATE) return 'waiting';
  return (await tasksRunImage(serviceName, ref, deps)) ? 'converged' : 'waiting';
}

/** Espera a convergência do web; lança `E_ROLLED_BACK` ou `E_CONVERGE_TIMEOUT`. Falha passageira de consulta só é registrada. */
export async function waitForConvergence(serviceName: string, ref: string, before: UpdateMark | null, deps: ReceiverDeps): Promise<void> {
  const deadline = deps.clock.monotonicMs() + CONVERGE_TIMEOUT_MS;
  while (deps.clock.monotonicMs() < deadline) {
    await deps.clock.sleep(CONVERGE_POLL_MS);
    let verdict: PollVerdict = 'waiting';
    try {
      verdict = await pollOnce(serviceName, ref, before, deps);
    } catch (error) {
      deps.log.write('converge.query_failed', { note: error instanceof ReceiverError ? error.logNote : 'unexpected' });
    }
    if (verdict === 'rolled_back') throw new ReceiverError('E_ROLLED_BACK', null, 'swarm rolled the web service back');
    if (verdict === 'converged') {
      deps.log.write('converge.done');
      return;
    }
  }
  throw new ReceiverError('E_CONVERGE_TIMEOUT', null, 'web service did not converge in 10 minutes');
}
