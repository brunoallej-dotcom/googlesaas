import type { AuditPipelineStage } from '@/types/gmn';

/**
 * Fase de uma auditoria para o operador. `INTERRUPTED` é DERIVADA (o enum do banco não muda): a
 * auditoria está em andamento no banco, mas não há atualização recente e/ou o Worker não dá sinal.
 */
export type AuditPhase = 'WAITING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';

export interface LivenessInput {
  readonly status: AuditPipelineStage | string;
  /** ISO da última atualização da linha (trigger `updated_at`). */
  readonly updatedAt?: string | null;
  readonly workerAlive: boolean;
  readonly now?: number;
  /** Minutos sem atualização para considerar parada (padrão 15; a coleta dos 49 pontos é a etapa mais longa). */
  readonly staleMinutes?: number;
  /** Minutos sem atualização, com o Worker fora do ar, para declarar interrupção (padrão 2). */
  readonly workerDownGraceMinutes?: number;
}

export interface LivenessResult {
  readonly phase: AuditPhase;
  readonly reason: string | null;
  readonly resumable: boolean;
}

/**
 * Só há o que retomar se o Campo de Batalha completo (49 pontos) já foi gravado: ele é a etapa
 * cara. Sem ele, "retomar" seria uma coleta nova (49 consultas pagas) e exige confirmação própria.
 */
export function hasReusableBattlefield(state: Readonly<Record<string, unknown>> | null | undefined): boolean {
  const battlefield = state?.battlefield as { points?: unknown } | undefined;
  return Array.isArray(battlefield?.points) && battlefield.points.length === 49;
}

export function staleMinutesFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env.GMN_AUDIT_STALE_MINUTES);
  return Number.isFinite(value) && value >= 2 ? value : 15;
}

export function deriveAuditPhase(input: LivenessInput): LivenessResult {
  const now = input.now ?? Date.now();
  const stale = input.staleMinutes ?? 15;
  const grace = input.workerDownGraceMinutes ?? 2;
  if (input.status === 'COMPLETED') return { phase: 'COMPLETED', reason: null, resumable: false };
  if (input.status === 'FAILED') return { phase: 'FAILED', reason: null, resumable: true };

  const updated = input.updatedAt ? Date.parse(input.updatedAt) : Number.NaN;
  const idleMinutes = Number.isFinite(updated) ? (now - updated) / 60_000 : null;

  if (idleMinutes !== null && idleMinutes >= stale) {
    return {
      phase: 'INTERRUPTED',
      reason: `Sem atualização há ${Math.floor(idleMinutes)} min: o processamento parou antes de terminar.`,
      resumable: true,
    };
  }
  if (!input.workerAlive && idleMinutes !== null && idleMinutes >= grace) {
    return {
      phase: 'INTERRUPTED',
      reason: 'O Worker de auditorias não está ativo: o processamento não será retomado sozinho.',
      resumable: true,
    };
  }
  return { phase: input.status === 'QUEUED' ? 'WAITING' : 'RUNNING', reason: null, resumable: false };
}

/* -------------------------------------------------------------------------- */
/* Idempotência por empresa + palavra-chave                                    */
/* -------------------------------------------------------------------------- */

export interface ExistingAuditSummary {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: string | null;
  readonly hasBattlefield: boolean;
}

export type EnqueueDecision =
  | { readonly action: 'CREATE' }
  | {
      readonly action: 'REUSE';
      readonly code: 'ALREADY_RUNNING' | 'ALREADY_COMPLETED' | 'RESUMABLE_EXISTS';
      readonly auditId: string;
      readonly message: string;
    };

/**
 * Decide se uma nova auditoria pode ser criada. `existing` vem ordenada da mais recente para a mais
 * antiga e já filtrada por empresa + palavra-chave normalizada. Só `force` ignora o resultado.
 */
export function decideEnqueue(
  existing: readonly ExistingAuditSummary[],
  workerAlive: boolean,
  options: { readonly force?: boolean; readonly now?: number; readonly staleMinutes?: number } = {}
): EnqueueDecision {
  if (options.force) return { action: 'CREATE' };
  for (const audit of existing) {
    const live = deriveAuditPhase({
      status: audit.status,
      updatedAt: audit.updatedAt,
      workerAlive,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.staleMinutes !== undefined ? { staleMinutes: options.staleMinutes } : {}),
    });
    if (live.phase === 'WAITING' || live.phase === 'RUNNING') {
      return { action: 'REUSE', code: 'ALREADY_RUNNING', auditId: audit.id, message: 'Já existe uma auditoria em andamento para esta empresa e palavra-chave.' };
    }
    if (live.phase === 'COMPLETED') {
      return { action: 'REUSE', code: 'ALREADY_COMPLETED', auditId: audit.id, message: 'Já existe uma auditoria concluída para esta empresa e palavra-chave. Abra o resultado salvo ou confirme uma nova coleta.' };
    }
    if (audit.hasBattlefield) {
      return { action: 'REUSE', code: 'RESUMABLE_EXISTS', auditId: audit.id, message: 'Uma auditoria anterior parou depois de coletar o Campo de Batalha. Retome-a para não pagar as 49 consultas de novo.' };
    }
  }
  return { action: 'CREATE' };
}
