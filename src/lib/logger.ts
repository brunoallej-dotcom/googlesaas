import type { AgentName } from '@/types/gmn';
import { redactSecrets, redactValue } from './redact';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface StructuredLogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly agent: AgentName | 'SYSTEM';
  readonly message: string;
  readonly correlationId?: string;
  readonly durationMs?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Campos recomendados em `metadata` para a operação: `auditId`, `stage` (etapa), `status`,
 * `errorCode` e `errorCategory`. Segredos são redigidos automaticamente (ver `redact.ts`).
 */

/**
 * Logger estruturado JSON para rastreabilidade em produção (DataForSEO, BullMQ, Supabase).
 */
export class StructuredLogger {
  private readonly agent: AgentName | 'SYSTEM';
  private readonly correlationId?: string;

  constructor(agent: AgentName | 'SYSTEM', correlationId?: string) {
    this.agent = agent;
    this.correlationId = correlationId;
  }

  private emit(
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>,
    durationMs?: number
  ): void {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      agent: this.agent,
      message: redactSecrets(message),
      ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(metadata ? { metadata: redactValue(metadata) as Record<string, unknown> } : {}),
    };

    const serialized = JSON.stringify(entry);
    if (level === 'ERROR') {
      console.error(serialized);
    } else if (level === 'WARN') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }

  public info(message: string, metadata?: Record<string, unknown>, durationMs?: number): void {
    this.emit('INFO', message, metadata, durationMs);
  }

  public warn(message: string, metadata?: Record<string, unknown>, durationMs?: number): void {
    this.emit('WARN', message, metadata, durationMs);
  }

  public error(message: string, metadata?: Record<string, unknown>, durationMs?: number): void {
    this.emit('ERROR', message, metadata, durationMs);
  }

  public debug(message: string, metadata?: Record<string, unknown>, durationMs?: number): void {
    this.emit('DEBUG', message, metadata, durationMs);
  }
}
