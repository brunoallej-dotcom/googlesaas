import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureRedisReady, enqueueGmnAuditJob } from '@/queues/audit-queue';
import { decideEnqueue } from '@/lib/audit-liveness';
import { enqueueLockKey } from '@/lib/audit-coordinator';
import { getCoordinationStore, readWorkerSignal } from '@/lib/worker-signal';
import { staleMinutesFromEnv } from '@/lib/audit-liveness';
import { gmnRepository } from '@/lib/supabase';
import { limitEnqueue } from '@/lib/api-limits';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import type { FrontierLead } from '@/types/gmn';

const MAX_CENTER_OFFSET_KM = 5;

function distanceKm(
  a: { readonly latitude: number; readonly longitude: number },
  b: { readonly latitude: number; readonly longitude: number }
): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const EnqueueAuditSchema = z.object({
  leadId: z.string().uuid(),
  targetKeyword: z.string().trim().min(2).max(180),
  interestCenter: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
  gridZoom: z.string().default('15z'),
  gridStepMeters: z.number().int().min(100).max(5000).default(500),
  leadSnapshot: z.record(z.string(), z.unknown()).optional(),
  /** Só `true` (confirmação explícita) permite uma nova coleta paga para quem já tem auditoria. */
  force: z.boolean().default(false),
});

/**
 * POST /api/audit/enqueue
 * Enfileira a auditoria assíncrona no BullMQ para evitar timeouts HTTP,
 * retornando imediatamente o `auditId` e o `jobId` para polling de progresso.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  try {
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = EnqueueAuditSchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Payload de enfileiramento inválido',
          code: 'INVALID_PAYLOAD',
        },
        { status: 400 }
      );
    }

    const { leadId, targetKeyword, interestCenter, gridZoom, gridStepMeters, force } = parsed.data;

    // O lead vem SÓ do banco: um cliente não pode injetar dados de empresa (leadSnapshot é ignorado).
    const lead: FrontierLead | null = await gmnRepository.getLeadById(leadId);

    if (!lead) {
      return NextResponse.json(
        { error: 'Lead não encontrado no banco de dados.', code: 'LEAD_NOT_FOUND' },
        { status: 404 }
      );
    }

    // O centro de interesse só pode ser deslocado até 5 km da empresa (evita grade em outra cidade).
    if (interestCenter && distanceKm(interestCenter, lead.coordinates) > MAX_CENTER_OFFSET_KM) {
      return NextResponse.json(
        { error: 'Centro de interesse distante demais da empresa.', code: 'CENTER_TOO_FAR' },
        { status: 400 }
      );
    }
    const limited = limitEnqueue(access.operator);
    if (limited) return limited;

    // Nada é gravado nem cobrado se o Redis estiver fora do ar.
    await ensureRedisReady();
    const coordination = getCoordinationStore();
    const lockKey = enqueueLockKey(lead.placeId, targetKeyword);

    // Trava atômica: o segundo clique/aba/requisição simultânea recebe 409 e nada é duplicado.
    if (!(await coordination.setIfAbsent(lockKey, access.operator, 120))) {
      return NextResponse.json(
        { error: 'Já existe uma solicitação em andamento para esta empresa e palavra-chave.', code: 'ALREADY_RUNNING' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const auditId = randomUUID();
    try {
      const existing = await gmnRepository.listAuditsForLeadKeyword(lead.placeId, targetKeyword);
      const signal = await readWorkerSignal(coordination);
      const decision = decideEnqueue(existing, signal.workerAlive, { force, staleMinutes: staleMinutesFromEnv() });
      if (decision.action === 'REUSE') {
        await coordination.del(lockKey).catch(() => undefined);
        return NextResponse.json(
          { error: decision.message, code: decision.code, auditId: decision.auditId },
          { status: 409, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const effectiveCenter = interestCenter ?? lead.coordinates;
      const jobPayload = {
        auditId,
        lead,
        targetKeyword,
        interestCenter: effectiveCenter,
        gridZoom,
        gridStepMeters,
      };

      await gmnRepository.createAuditJob(jobPayload);

      let queueReceipt;
      try {
        queueReceipt = await enqueueGmnAuditJob(jobPayload);
      } catch (queueError: unknown) {
        const reason = queueError instanceof Error ? queueError.message : String(queueError);
        await gmnRepository.markAuditFailed(auditId, reason);
        await coordination.del(lockKey).catch(() => undefined);
        return apiFailure(queueError, { route: 'POST /api/audit/enqueue', auditId });
      }
      return NextResponse.json(
        {
          auditId,
          bullmqJobId: queueReceipt.jobId,
          queueMode: queueReceipt.mode,
          status: 'QUEUED',
          progressPercent: 5,
          workerAlive: signal.workerAlive,
        },
        { status: 202 }
      );
    } catch (error: unknown) {
      await coordination.del(lockKey).catch(() => undefined);
      throw error;
    }
  } catch (error: unknown) {
    return apiFailure(error, { route: 'POST /api/audit/enqueue' });
  }
}
