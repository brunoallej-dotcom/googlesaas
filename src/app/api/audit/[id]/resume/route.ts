import { NextResponse } from 'next/server';
import { limitEnqueue, invalidIdResponse, isUuid } from '@/lib/api-limits';
import { enqueueLockKey } from '@/lib/audit-coordinator';
import { deriveAuditPhase, hasReusableBattlefield, staleMinutesFromEnv } from '@/lib/audit-liveness';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import { gmnRepository } from '@/lib/supabase';
import { getCoordinationStore, readWorkerSignal } from '@/lib/worker-signal';
import { ensureRedisReady, enqueueGmnAuditJob } from '@/queues/audit-queue';

/**
 * POST /api/audit/[id]/resume
 * Retoma uma auditoria FALHA ou INTERROMPIDA reaproveitando o que já foi gravado (Reputação,
 * Vitrine e os 49 pontos do Battlefield): essas etapas NÃO são consultadas de novo. Ação explícita
 * do operador; nunca acontece sozinha.
 */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> }
): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  const { id } = await context.params;
  if (!isUuid(id)) return invalidIdResponse();

  try {
    const state = await gmnRepository.getAuditState(id);
    if (!state) return NextResponse.json({ error: 'Auditoria não localizada.', code: 'NOT_FOUND' }, { status: 404 });

    if (!hasReusableBattlefield(state)) {
      return NextResponse.json(
        {
          error: 'Não há dados gravados para retomar. Uma nova coleta consome 49 consultas pagas e precisa ser confirmada na tela de leads.',
          code: 'NOTHING_TO_RESUME',
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    await ensureRedisReady();
    const coordination = getCoordinationStore();
    const signal = await readWorkerSignal(coordination);
    const phase = deriveAuditPhase({
      status: String(state.status),
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
      workerAlive: signal.workerAlive,
      staleMinutes: staleMinutesFromEnv(),
    });
    if (!phase.resumable) {
      return NextResponse.json(
        { error: 'Esta auditoria não pode ser retomada agora (concluída ou ainda em andamento).', code: 'NOT_RESUMABLE', phase: phase.phase },
        { status: 409, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const limited = limitEnqueue(access.operator);
    if (limited) return limited;

    const payload = await gmnRepository.getAuditJobPayload(id);
    if (!payload) {
      return NextResponse.json({ error: 'Dados originais da auditoria indisponíveis.', code: 'PAYLOAD_UNAVAILABLE' }, { status: 409 });
    }

    const lockKey = enqueueLockKey(payload.lead.placeId, payload.targetKeyword);
    if (!(await coordination.setIfAbsent(lockKey, access.operator, 120))) {
      return NextResponse.json({ error: 'Já existe uma solicitação em andamento para esta auditoria.', code: 'ALREADY_RUNNING' }, { status: 409 });
    }
    try {
      // Compare-and-set: se alguém retomou/concluiu no meio tempo, nada é enfileirado.
      if (!(await gmnRepository.requeueAuditForResume(id))) {
        return NextResponse.json({ error: 'A auditoria mudou de estado; atualize a tela.', code: 'STATE_CHANGED' }, { status: 409 });
      }
      try {
        await enqueueGmnAuditJob({ ...payload, resume: true }, { jobId: `${id}-resume-${Date.now()}` });
      } catch (queueError: unknown) {
        await gmnRepository.markAuditFailed(id, queueError instanceof Error ? queueError.message : String(queueError));
        return apiFailure(queueError, { route: 'POST /api/audit/[id]/resume', auditId: id });
      }
    } finally {
      await coordination.del(lockKey).catch(() => undefined);
    }

    return NextResponse.json(
      {
        auditId: id,
        status: 'QUEUED',
        workerAlive: signal.workerAlive,
        reusesPersistedResults: true,
        note: 'Reputação, Vitrine e Campo de Batalha já gravados serão reaproveitados; não há novas consultas pagas para eles.',
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return apiFailure(error, { route: 'POST /api/audit/[id]/resume', auditId: id });
  }
}
