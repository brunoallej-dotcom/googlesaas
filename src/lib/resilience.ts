import { StructuredLogger } from './logger';
import type { AgentName } from '@/types/gmn';

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly timeoutMs: number;
  readonly operationName: string;
  readonly agent: AgentName;
  readonly correlationId?: string;
}

export interface RetryExecutionResult<T> {
  readonly success: boolean;
  readonly data: T | null;
  readonly attemptsMade: number;
  readonly lastError: string | null;
}

/**
 * Executa uma operação assíncrona com timeout estrito por tentativa,
 * backoff exponencial com jitter e retorno seguro de metadados de tentativa.
 */
export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<RetryExecutionResult<T>> {
  const logger = new StructuredLogger(options.agent, options.correlationId);
  let lastErrorMessage = 'Unknown failure';

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const startTime = Date.now();
    try {
      const result = await withTimeout(
        operation(attempt),
        options.timeoutMs,
        `${options.operationName} (attempt ${attempt}/${options.maxAttempts})`
      );
      const durationMs = Date.now() - startTime;
      if (attempt > 1) {
        logger.info(`Operação recuperada com sucesso na tentativa ${attempt}`, {
          operationName: options.operationName,
          attempt,
        }, durationMs);
      }
      return {
        success: true,
        data: result,
        attemptsMade: attempt,
        lastError: null,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      lastErrorMessage = error instanceof Error ? error.message : String(error);

      logger.warn(
        `Falha na tentativa ${attempt}/${options.maxAttempts} em ${options.operationName}: ${lastErrorMessage}`,
        {
          operationName: options.operationName,
          attempt,
          maxAttempts: options.maxAttempts,
        },
        durationMs
      );

      if (attempt < options.maxAttempts) {
        const exponentialDelay = Math.min(
          options.maxDelayMs,
          options.baseDelayMs * Math.pow(2, attempt - 1)
        );
        const jitter = Math.floor(Math.random() * 250);
        await sleep(exponentialDelay + jitter);
      }
    }
  }

  logger.error(
    `Todas as ${options.maxAttempts} tentativas falharam para ${options.operationName}`,
    {
      operationName: options.operationName,
      lastError: lastErrorMessage,
    }
  );

  return {
    success: false,
    data: null,
    attemptsMade: options.maxAttempts,
    lastError: lastErrorMessage,
  };
}

/**
 * Wrapper de Timeout estrito para evitar conexões HTTP penduradas.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timeout de ${timeoutMs}ms excedido em: ${label}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Controlador de concorrência determinístico (semelhante ao p-limit)
 * para executar os 49 pontos da grade do Campo de Batalha sem sofrer rate-limit.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrencyLimit: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrencyLimit, items.length));
  const results: TOutput[] = new Array<TOutput>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      const item = items[currentIndex];
      if (item !== undefined) {
        results[currentIndex] = await mapper(item, currentIndex);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < safeConcurrency; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
