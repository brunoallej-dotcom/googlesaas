import { NextResponse } from 'next/server';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import { gmnRepository } from '@/lib/supabase';
import { configurationPresence, overallStatus, staleMinutesFromEnv, type ComponentStatus, type HealthReport } from '@/lib/system-health';
import { getCoordinationStore, readWorkerSignal } from '@/lib/worker-signal';
import { getAuditQueue } from '@/queues/audit-queue';

/** GET /api/system/health: diagnóstico leve para o operador. Nunca devolve valores de configuração. */
export async function GET(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  try {
    const signal = await readWorkerSignal(getCoordinationStore());
    const redis: ComponentStatus = signal.redisReachable ? 'OK' : 'DOWN';
    const worker: ComponentStatus = !signal.redisReachable ? 'UNKNOWN' : signal.workerAlive ? 'OK' : 'DOWN';

    let queue: Record<string, number> | null = null;
    if (signal.redisReachable) {
      queue = await Promise.race([
        getAuditQueue().getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
      ]).catch(() => null);
    }

    let supabase: ComponentStatus = 'OK';
    let recent: HealthReport['recentAudits'] = [];
    try {
      recent = await gmnRepository.listRecentAuditActivity(8);
    } catch {
      supabase = 'DOWN';
    }

    const report: HealthReport = {
      overall: overallStatus([redis, worker, supabase]),
      checkedAt: new Date().toISOString(),
      redis: { status: redis },
      worker: { status: worker, lastHeartbeat: signal.heartbeat?.at ?? null, concurrency: signal.heartbeat?.concurrency ?? null },
      supabase: { status: supabase },
      queue,
      staleAuditMinutes: staleMinutesFromEnv(),
      recentAudits: recent,
      configuration: configurationPresence(),
    };
    return NextResponse.json(report, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    return apiFailure(error, { route: 'GET /api/system/health' });
  }
}
