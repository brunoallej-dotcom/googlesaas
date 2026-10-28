import type IORedis from 'ioredis';

/**
 * Coordenação via Redis: trava de enfileiramento (impede duplo clique) e batimento (heartbeat) do
 * Worker. Uma porta pequena (`CoordinationStore`) permite testar sem Redis.
 */
export interface CoordinationStore {
  /** SET key value NX EX ttl → true se adquiriu. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

export const HEARTBEAT_KEY = 'gmn:worker:heartbeat';
export const HEARTBEAT_TTL_SECONDS = 45;

export function redisCoordinationStore(redis: IORedis, timeoutMs = 2500): CoordinationStore {
  const guard = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Tempo limite ao falar com o Redis')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    setIfAbsent: async (key, value, ttl) => (await guard(redis.set(key, value, 'EX', ttl, 'NX'))) === 'OK',
    set: async (key, value, ttl) => {
      await guard(redis.set(key, value, 'EX', ttl));
    },
    get: (key) => guard(redis.get(key)),
    del: async (key) => {
      await guard(redis.del(key));
    },
  };
}

export function memoryCoordinationStore(now: () => number = Date.now): CoordinationStore & { readonly size: () => number } {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string): string | null => {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      data.delete(key);
      return null;
    }
    return entry.value;
  };
  return {
    setIfAbsent: async (key, value, ttl) => {
      if (live(key) !== null) return false;
      data.set(key, { value, expiresAt: now() + ttl * 1000 });
      return true;
    },
    set: async (key, value, ttl) => {
      data.set(key, { value, expiresAt: now() + ttl * 1000 });
    },
    get: async (key) => live(key),
    del: async (key) => {
      data.delete(key);
    },
    size: () => data.size,
  };
}

export function enqueueLockKey(placeId: string, keyword: string): string {
  return `gmn:enqueue-lock:${placeId}:${keyword.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export interface WorkerHeartbeat {
  readonly at: string;
  readonly pid: number;
  readonly concurrency: number;
}

export async function writeWorkerHeartbeat(store: CoordinationStore, info: { pid: number; concurrency: number }, now: Date = new Date()): Promise<void> {
  const beat: WorkerHeartbeat = { at: now.toISOString(), pid: info.pid, concurrency: info.concurrency };
  await store.set(HEARTBEAT_KEY, JSON.stringify(beat), HEARTBEAT_TTL_SECONDS);
}

/** `redisReachable` distingue "Worker parado" de "não consegui falar com o Redis". */
export async function readWorkerHeartbeat(store: CoordinationStore): Promise<{
  readonly redisReachable: boolean;
  readonly heartbeat: WorkerHeartbeat | null;
}> {
  try {
    const raw = await store.get(HEARTBEAT_KEY);
    if (!raw) return { redisReachable: true, heartbeat: null };
    const parsed = JSON.parse(raw) as Partial<WorkerHeartbeat>;
    if (typeof parsed.at !== 'string' || typeof parsed.pid !== 'number') return { redisReachable: true, heartbeat: null };
    return { redisReachable: true, heartbeat: { at: parsed.at, pid: parsed.pid, concurrency: Number(parsed.concurrency ?? 0) } };
  } catch {
    return { redisReachable: false, heartbeat: null };
  }
}
