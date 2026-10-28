import { Worker, type Job } from 'bullmq';
import { loadEnvConfig } from '@next/env';
import type { BullMQAuditJobPayload, CompleteAuditDossier } from '@/types/gmn';
import { getRedisConnection } from '@/lib/redis';
import { StructuredLogger } from '@/lib/logger';
import { maestroOrchestrator } from '@/agents/maestro-orchestrator';
import { GMN_AUDIT_QUEUE_NAME } from '@/queues/audit-queue';
import { gmnRepository } from '@/lib/supabase';
import { writeWorkerHeartbeat } from '@/lib/audit-coordinator';
import { getCoordinationStore } from '@/lib/worker-signal';

// The standalone tsx process does not load .env.local by default.
loadEnvConfig(process.cwd());

const logger = new StructuredLogger('MAESTRO');

/**
 * Worker dedicado BullMQ para processar as auditorias em background
 * sem bloquear ou causar timeout nas requisições HTTP do Next.js.
 */
export type AuditJobResult = CompleteAuditDossier | { readonly skipped: true; readonly reason: string };

export function workerConcurrency(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env.GMN_WORKER_CONCURRENCY);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 3;
}

/**
 * Processa um job. A auditoria é REIVINDICADA de forma atômica (QUEUED → RUNNING): se outro Worker,
 * um job duplicado ou uma reentrega chegar depois, ele não executa nada, então nenhuma consulta
 * paga é repetida.
 */
export async function processAuditJob(
  job: Pick<Job<BullMQAuditJobPayload>, 'id' | 'data' | 'updateProgress'>,
  deps: {
    readonly claim: (auditId: string) => Promise<boolean>;
    readonly run: typeof maestroOrchestrator.runAuditPipeline;
  } = { claim: (id) => gmnRepository.claimAudit(id), run: (...args) => maestroOrchestrator.runAuditPipeline(...args) }
): Promise<AuditJobResult> {
  const { auditId } = job.data;
  if (!(await deps.claim(auditId))) {
    logger.warn('Job ignorado: a auditoria já foi reivindicada, concluída ou falhou (nenhuma consulta feita)', {
      auditId,
      jobId: job.id,
      stage: 'claim',
      status: 'SKIPPED',
    });
    return { skipped: true, reason: 'AUDIT_NOT_QUEUED' };
  }
  logger.info(`Worker BullMQ iniciou processamento do job ${job.id}`, {
    auditId,
    placeId: job.data.lead.placeId,
    resume: Boolean(job.data.resume),
  });
  return deps.run(job.data, async (percent, stageLabel) => {
    await job.updateProgress({ percent, stageLabel });
  });
}

/**
 * Falha de job (inclusive job travado/estagnado, que com `maxStalledCount: 0` falha em vez de
 * reexecutar): registra o log e PERSISTE o estado FAILED para a auditoria não ficar "em andamento"
 * para sempre. Estados finais não regridem (uma auditoria já concluída continua concluída).
 */
export async function handleJobFailure(
  job: { readonly id?: string | undefined; readonly data?: { readonly auditId?: string } } | undefined,
  error: Error,
  markFailed: (auditId: string, message: string) => Promise<void> = (id, message) => gmnRepository.markAuditFailed(id, message)
): Promise<void> {
  const auditId = job?.data?.auditId;
  logger.error(`Job BullMQ ${job?.id ?? 'unknown'} falhou: ${error.message}`, {
    auditId,
    stage: 'job',
    status: 'FAILED',
    errorCategory: /stalled/i.test(error.message) ? 'STALLED' : 'PIPELINE',
  });
  if (!auditId) return;
  try {
    await markFailed(auditId, error.message);
  } catch (persistError: unknown) {
    logger.error('Não foi possível registrar a falha da auditoria', {
      auditId,
      detail: persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
}

export function startAuditWorker(): Worker<BullMQAuditJobPayload, AuditJobResult> {
  const concurrency = workerConcurrency();
  const worker = new Worker<BullMQAuditJobPayload, AuditJobResult>(
    GMN_AUDIT_QUEUE_NAME,
    async (job: Job<BullMQAuditJobPayload>): Promise<AuditJobResult> => {

      return processAuditJob(job);
    },
    {
      connection: getRedisConnection(),
      concurrency,
      // Um job travado FALHA em vez de voltar à fila: reexecutar refaria as 49 consultas pagas.
      maxStalledCount: 0,
      lockDuration: 120_000,
      limiter: {
        max: 10,
        duration: 60000,
      },
    }
  );

  worker.on('ready', () => {
    logger.info('Worker conectado ao Redis e pronto para receber jobs');
  });

  worker.on('error', (error) => {
    logger.error(`Falha de conexao Redis/BullMQ: ${error.message}`);
  });

  worker.on('completed', (job) => {
    logger.info(`Job BullMQ ${job.id} concluído com sucesso`, {
      auditId: job.data.auditId,
    });
  });

  worker.on('failed', (job, err) => {
    void handleJobFailure(job, err);
  });

  // Batimento: permite à plataforma saber se há um Worker vivo (chave Redis com TTL curto).
  const beat = (): void => {
    void writeWorkerHeartbeat(getCoordinationStore(), { pid: process.pid, concurrency }).catch(() => undefined);
  };
  beat();
  const heartbeat = setInterval(beat, 10_000);
  heartbeat.unref();
  worker.on('closing', () => clearInterval(heartbeat));

  return worker;
}

if (require.main === module) {
  logger.info('Iniciando processo standalone do BullMQ Worker (gmn-audit-pipeline)...');
  const activeWorker = startAuditWorker();

  const shutdown = async (): Promise<void> => {
    logger.info('Encerrando BullMQ Worker graciosamente...');
    await activeWorker.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
