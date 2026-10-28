import IORedis from 'ioredis';

/**
 * Singleton de conexão Redis otimizado para BullMQ (Queue + Worker).
 * BullMQ exige `maxRetriesPerRequest: null` para comandos bloqueantes.
 */
let redisInstance: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (redisInstance) {
    return redisInstance;
  }

  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const useTls = process.env.REDIS_TLS_ENABLED === 'true';

  redisInstance = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...(useTls ? { tls: {} } : {}),
    retryStrategy(times: number): number {
      return Math.min(times * 200, 5000);
    },
  });

  return redisInstance;
}
