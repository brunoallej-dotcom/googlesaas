import { NextResponse } from 'next/server';
import { invalidIdResponse, isUuid } from '@/lib/api-limits';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import { deriveAuditPhase, hasReusableBattlefield, staleMinutesFromEnv } from '@/lib/audit-liveness';
import { gmnRepository } from '@/lib/supabase';
import { readWorkerSignal } from '@/lib/worker-signal';

/** GET /api/audit/[id]/status reads the shared Supabase audit state. */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> }
): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  const { id } = await context.params;
  if (!isUuid(id)) return invalidIdResponse();
  try {
    const state = await gmnRepository.getAuditState(id);
    if (!state) {
      return NextResponse.json({ error: 'Auditoria não localizada.', code: 'NOT_FOUND' }, { status: 404 });
    }
    const terminal = state.status === 'COMPLETED' || state.status === 'FAILED';
    // Redis só é consultado para auditorias em andamento; qualquer falha vira "Worker desconhecido".
    const signal = terminal ? null : await readWorkerSignal().catch(() => null);
    const liveness = deriveAuditPhase({
      status: String(state.status),
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
      workerAlive: signal?.workerAlive ?? true,
      staleMinutes: staleMinutesFromEnv(),
    });
    return NextResponse.json(
      {
        ...state,
        phase: liveness.phase,
        phaseReason: liveness.reason,
        // Só oferece retomar quando há dados pagos já gravados para reaproveitar.
        resumable: liveness.resumable && hasReusableBattlefield(state),
        workerAlive: signal ? signal.workerAlive : null,
        redisReachable: signal ? signal.redisReachable : null,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return apiFailure(error, { route: 'GET /api/audit/[id]/status', auditId: id });
  }
}
