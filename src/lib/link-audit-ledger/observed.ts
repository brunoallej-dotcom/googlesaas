/*
 * IDADE OBSERVADA de uma operação aberta (R7-09). A hora gravada num registro (`recordedAt`) é a do relógio de quem o gravou: se esse relógio estava ADIANTADO (NTP, VM, ajuste
 * manual), a INTENT parece "do futuro", a idade dela é NEGATIVA e ela nunca venceria até o relógio real alcançá-la — a auditoria ficaria presa em "operação em andamento", sem
 * recuperação possível (a reabertura administrativa não existe). Nada que dependa de `recordedAt` pode ser a única referência de tempo.
 *
 * Referência independente do relógio de parede: o tempo MONOTÔNICO decorrido desde que ESTE processo viu a operação aberta pela primeira vez. Um dono vivo conclui em milissegundos;
 * uma operação que continua aberta por `staleOperationMs` de observação contínua é tratada como vencida, exatamente como uma de idade normal. Só vale quando a hora gravada está
 * no futuro (idade de parede negativa): para as demais a idade de parede continua mandando. A memória é limitada (as entradas mais antigas saem; sair só ADIA o vencimento).
 */
export interface OpenObservations {
  /** Milissegundos monotônicos desde a primeira vez que esta chave foi vista (a primeira chamada devolve 0). */
  ageOf(key: string): number;
  readonly size: number;
}

export const MAX_OBSERVATIONS = 256;

export function createOpenObservations(monotonicMs: () => number = () => performance.now(), max: number = MAX_OBSERVATIONS): OpenObservations {
  const firstSeen = new Map<string, number>();
  return {
    ageOf(key: string): number {
      const now = monotonicMs();
      let first = firstSeen.get(key);
      if (first === undefined) {
        first = now;
        if (firstSeen.size >= max) {
          const oldest = firstSeen.keys().next();
          if (!oldest.done) firstSeen.delete(oldest.value);
        }
        firstSeen.set(key, first);
      }
      // inteiro: o tempo monotônico real tem frações de ms e a idade é gravada no `ABORTED` (esquema `int`)
      return Math.max(0, Math.floor(now - first));
    },
    get size(): number {
      return firstSeen.size;
    },
  };
}

/** Registro COMPARTILHADO do processo: o serviço do livro é criado a cada requisição, a observação precisa sobreviver entre elas. */
export const PROCESS_OBSERVATIONS: OpenObservations = createOpenObservations();
