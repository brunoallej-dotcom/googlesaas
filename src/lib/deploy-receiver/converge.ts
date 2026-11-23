import { ReceiverError } from './codes';
import { inspectService, runningTasks, taskImageId, type ServiceInfo } from './docker';
import type { ReceiverDeps } from './ports';

/*
 * P9.3a — passo 12 do `deploy` (spec §5.6): por até 10 min, a atualização do web termina `completed` e as tarefas rodam a imagem nova. Se ela
 * terminar `rollback_*` (o `failure_action: rollback` do `stack.yml`), `E_ROLLED_BACK`; se o prazo vencer, `E_CONVERGE_TIMEOUT`. O receptor NUNCA
 * faz rollback por conta própria (R6-09).
 *
 * Revisão do PR #70 (item 4):
 *  - a fotografia de ANTES do `stack deploy` guarda a especificação do web e o `UpdateStatus.StartedAt`. Se o deploy MUDOU a especificação, só
 *    vale a atualização começada por ELE (outro `StartedAt`) num estado terminal `completed`; `updating`, `paused` ou um `completed`/
 *    `rollback_completed` antigo nunca valem. Especificação igual (o mesmo commit de novo) ou serviço criado agora: não há atualização a
 *    esperar, valem as tarefas;
 *  - "as tarefas rodam a imagem nova" é conferido pela identidade EFETIVA: o id da imagem do contêiner de cada tarefa em execução tem de ser o
 *    id carregado no passo 9 (não só a tag).
 */

export const CONVERGE_TIMEOUT_MS = 10 * 60_000;
export const CONVERGE_POLL_MS = 5_000;
const ROLLBACK_STATE = /^rollback_/;
const COMPLETED_STATE = 'completed';
const RUNNING_STATE = /^Running\b/;

/** O web antes do `stack deploy`: se existia, a especificação serializada e o início da última atualização. */
export interface ServiceSnapshot {
  readonly existed: boolean;
  readonly specJson: string | null;
  readonly startedAt: string | null;
}

export const snapshotOf = (service: ServiceInfo | null): ServiceSnapshot => ({
  existed: service !== null,
  specJson: service?.specJson ?? null,
  startedAt: service?.UpdateStatus?.StartedAt ?? null,
});

/** A referência de imagem do serviço é a tag nova (com ou sem o digest que o Docker pode acrescentar). */
export const isImageRef = (image: string, ref: string): boolean => image === ref || image.startsWith(`${ref}@sha256:`);

/** Todas as tarefas em execução do serviço rodam a tag nova E a imagem de id `imageId` (pelo contêiner); `false` se ainda não há tarefa. */
export async function tasksRunImage(serviceName: string, ref: string, imageId: string, deps: ReceiverDeps): Promise<boolean> {
  const tasks = await runningTasks(serviceName, 'E_CONVERGE_TIMEOUT', deps);
  if (tasks.length === 0 || !tasks.every((task) => isImageRef(task.Image, ref) && RUNNING_STATE.test(task.CurrentState))) return false;
  for (const task of tasks) if ((await taskImageId(task.ID, 'E_CONVERGE_TIMEOUT', deps)) !== imageId) return false;
  return true;
}

type PollVerdict = 'converged' | 'rolled_back' | 'waiting';

interface Expectation {
  readonly serviceName: string;
  readonly ref: string;
  readonly imageId: string;
  readonly before: ServiceSnapshot;
}

/** `true` se o `stack deploy` mudou a especificação do web (então uma atualização nova tem de terminar `completed`). */
const specChanged = (before: ServiceSnapshot, after: ServiceInfo): boolean => before.existed && before.specJson !== after.specJson;

async function pollOnce(expect: Expectation, deps: ReceiverDeps): Promise<PollVerdict> {
  const service = await inspectService(expect.serviceName, 'E_CONVERGE_TIMEOUT', deps);
  if (service === null) return 'waiting';
  const status = service.UpdateStatus ?? null;
  const isNewUpdate = status !== null && (status.StartedAt ?? null) !== expect.before.startedAt;
  if (isNewUpdate && ROLLBACK_STATE.test(status.State)) return 'rolled_back';
  const needsUpdate = specChanged(expect.before, service);
  if ((needsUpdate && !isNewUpdate) || (isNewUpdate && status.State !== COMPLETED_STATE)) return 'waiting';
  return (await tasksRunImage(expect.serviceName, expect.ref, expect.imageId, deps)) ? 'converged' : 'waiting';
}

/** Espera a convergência do web; lança `E_ROLLED_BACK` ou `E_CONVERGE_TIMEOUT`. Falha passageira de consulta só é registrada. */
export async function waitForConvergence(serviceName: string, ref: string, imageId: string, before: ServiceSnapshot, deps: ReceiverDeps): Promise<void> {
  const expect: Expectation = { serviceName, ref, imageId, before };
  const deadline = deps.clock.monotonicMs() + CONVERGE_TIMEOUT_MS;
  while (deps.clock.monotonicMs() < deadline) {
    await deps.clock.sleep(CONVERGE_POLL_MS);
    let verdict: PollVerdict = 'waiting';
    try {
      verdict = await pollOnce(expect, deps);
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
