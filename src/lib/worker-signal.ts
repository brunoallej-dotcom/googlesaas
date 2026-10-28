import { getRedisConnection } from './redis';
import { readWorkerHeartbeat, redisCoordinationStore, type CoordinationStore, type WorkerHeartbeat } from './audit-coordinator';

let store: CoordinationStore | null = null;

/** Armazenamento de coordenação sobre a conexão Redis compartilhada (criado sob demanda). */
export function getCoordinationStore(): CoordinationStore {
  store ??= redisCoordinationStore(getRedisConnection());
  return store;
}

export interface WorkerSignal {
  readonly redisReachable: boolean;
  readonly workerAlive: boolean;
  readonly heartbeat: WorkerHeartbeat | null;
}

/** O Worker é considerado ativo se o batimento (TTL 45 s) existe. Nunca lança. */
export async function readWorkerSignal(coordination: CoordinationStore = getCoordinationStore()): Promise<WorkerSignal> {
  const { redisReachable, heartbeat } = await readWorkerHeartbeat(coordination);
  return { redisReachable, workerAlive: heartbeat !== null, heartbeat };
}
