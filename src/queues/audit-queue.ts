import { Queue } from 'bullmq';
import type { BullMQAuditJobPayload } from '@/types/gmn';
import { getRedisConnection } from '@/lib/redis';
import { StructuredLogger } from '@/lib/logger';

export const GMN_AUDIT_QUEUE_NAME = 'gmn-audit-pipeline';

let auditQueueInstance: Queue<BullMQAuditJobPayload> | null = null;

export function getAuditQueue(): Queue<BullMQAuditJobPayload> {
  if (auditQueueInstance) return auditQueueInstance;

  auditQueueInstance = new Queue<BullMQAuditJobPayload>(GMN_AUDIT_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 3600 * 24 * 7, count: 500 },
      removeOnFail: { age: 3600 * 24 * 14 },
    },
  });

  auditQueueInstance.on('error', (error) => {
    new StructuredLogger('MAESTRO').error('Erro de comunicacao na fila Redis', {
      errorMessage: error.message,
    });
  });

  return auditQueueInstance;
}

export async function ensureRedisReady(): Promise<void> {
  const redis = getRedisConnection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Tempo limite de 3s ao conectar Redis')), 3000);
      }),
    ]);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Nao foi possivel conectar ao Redis. Verifique REDIS_URL no .env.local e inicie o servidor Redis antes da auditoria. Detalhes: ${detail}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Enqueue through Redis even when REDIS_URL is redis://localhost:6379. */
export async function enqueueGmnAuditJob(
  payload: BullMQAuditJobPayload,
  options: { readonly jobId?: string } = {}
): Promise<{ readonly jobId: string; readonly mode: 'BULLMQ_REDIS' }> {
  const logger = new StructuredLogger('MAESTRO', payload.auditId);

  await ensureRedisReady();
  const queue = getAuditQueue();
  const job = await queue.add(`audit-${payload.lead.placeId}`, payload, {
    jobId: options.jobId ?? payload.auditId,
  });

  logger.info('Job enfileirado no Redis/BullMQ', {
    auditId: payload.auditId,
    jobId: job.id,
  });

  return {
    jobId: String(job.id ?? payload.auditId),
    mode: 'BULLMQ_REDIS',
  };
}
