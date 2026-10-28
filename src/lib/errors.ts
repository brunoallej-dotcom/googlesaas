import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { StructuredLogger } from './logger';

/**
 * Erros de API: o cliente recebe uma mensagem GENÉRICA, um código estável e um `correlationId`;
 * o detalhe técnico (já com segredos redigidos) vai só para o log do servidor.
 */
export class GmnError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly publicMessage: string,
    options?: { cause?: unknown }
  ) {
    super(publicMessage, options);
    this.name = 'GmnError';
  }
}

export type ErrorCategory = 'VALIDATION' | 'AUTH' | 'CONFLICT' | 'RATE_LIMIT' | 'DEPENDENCY' | 'INTERNAL';

export interface ClassifiedError {
  readonly status: number;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly publicMessage: string;
}

const REDIS_PATTERN = /redis|ioredis|bullmq|ECONNREFUSED|ENOTFOUND|Connection is closed|ETIMEDOUT.*6379|Tempo limite de 3s/i;
const DATABASE_PATTERN = /supabase|postgrest|PGRST|fetch failed|Falha ao (consultar|criar|atualizar|persistir|salvar)|Erro ao persistir/i;

/** Classifica qualquer erro sem expor seu texto ao cliente. */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof GmnError) {
    const category: ErrorCategory =
      error.status === 400 ? 'VALIDATION' : error.status === 401 || error.status === 403 ? 'AUTH' : error.status === 409 ? 'CONFLICT' : error.status === 429 ? 'RATE_LIMIT' : error.status === 503 ? 'DEPENDENCY' : 'INTERNAL';
    return { status: error.status, code: error.code, category, publicMessage: error.publicMessage };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (REDIS_PATTERN.test(message)) {
    return { status: 503, code: 'REDIS_UNAVAILABLE', category: 'DEPENDENCY', publicMessage: 'A fila de processamento (Redis) está indisponível. Nada foi enviado nem cobrado; tente novamente em instantes.' };
  }
  if (DATABASE_PATTERN.test(message)) {
    return { status: 503, code: 'DATABASE_UNAVAILABLE', category: 'DEPENDENCY', publicMessage: 'O banco de dados (Supabase) está indisponível. Nenhuma consulta paga foi feita; tente novamente em instantes.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', category: 'INTERNAL', publicMessage: 'Erro interno. Consulte o registro do servidor com o código de correlação informado.' };
}

/** Resposta de erro segura + registro estruturado do detalhe. */
export function apiFailure(error: unknown, context: { readonly route: string; readonly auditId?: string }): NextResponse {
  const correlationId = randomUUID();
  const classified = classifyError(error);
  new StructuredLogger('SYSTEM', correlationId).error('Falha em rota da API', {
    route: context.route,
    ...(context.auditId ? { auditId: context.auditId } : {}),
    status: classified.status,
    errorCode: classified.code,
    errorCategory: classified.category,
    detail: error instanceof Error ? error.message : String(error),
  });
  return NextResponse.json(
    { error: classified.publicMessage, code: classified.code, correlationId },
    { status: classified.status, headers: { 'Cache-Control': 'no-store' } }
  );
}
