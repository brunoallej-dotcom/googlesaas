/**
 * Modelo de evidência da Fase 4.
 *
 * Toda informação importante de uma auditoria carrega a sua origem, a data da coleta, o status
 * da comprovação e as limitações da conclusão. Nada aqui é persistido em tabela própria: as
 * evidências ficam dentro dos payloads JSONB já existentes (`schemaVersion` garante a leitura
 * de auditorias antigas). A estrutura é independente do armazenamento para permitir, no futuro,
 * a migração para tabelas dedicadas sem alterar os produtores.
 */

export const EVIDENCE_SCHEMA_VERSION = 1;

/** Metodologia de ranking do Campo de Batalha usada para decidir se rodadas são comparáveis. */
export const BATTLEFIELD_METHOD_VERSION = 'grid7x7-serper-maps-v1';

export type EvidenceStatus = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'NOT_VERIFIED' | 'SIMULATED';

export interface AuditEvidence {
  /** Critério do Juiz (1 a 21) ao qual a evidência se refere. */
  readonly criterionId: number;
  readonly status: EvidenceStatus;
  /** Resumo JSON-seguro do que foi observado (nunca a resposta integral do provedor). */
  readonly value: unknown;
  readonly sourceProvider?: string;
  readonly sourceType?: string;
  readonly sourceReference?: string;
  readonly collectedAt?: string;
  /** O que foi efetivamente comprovado (ou por que não foi). */
  readonly explanation: string;
  /** O que a conclusão NÃO cobre. */
  readonly limitations: readonly string[];
  /** 0 a 1; presente somente quando há alguma evidência. */
  readonly confidence?: number;
}

/** Valor que pode não existir: indisponível nunca vira número com aparência de real. */
export type Availability<T> =
  | { readonly state: 'AVAILABLE'; readonly value: T; readonly collectedAt: string; readonly provider: string }
  | { readonly state: 'UNAVAILABLE'; readonly reason: string; readonly provider: string | null; readonly attemptedAt: string };

/** Falha estruturada de provedor, registrada sem derrubar os dados válidos já obtidos. */
export interface ProviderFailure {
  readonly provider: string;
  readonly operation: string;
  readonly reason: string;
  readonly httpStatus?: number;
  readonly attempts?: number;
  readonly at: string;
}

export interface EvidenceBundle {
  readonly schemaVersion: number;
  readonly evidence: readonly AuditEvidence[];
  readonly providerFailures: readonly ProviderFailure[];
  /** `true` somente em execuções com GMN_DEMO_MODE; nunca é persistido como auditoria real. */
  readonly demo: boolean;
  /** `true` quando a ficha foi gerada a partir de fixtures de teste (dados sintéticos). */
  readonly testFixture?: boolean;
}

export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  VERIFIED: 'Verificado',
  PARTIALLY_VERIFIED: 'Parcialmente verificado',
  NOT_VERIFIED: 'Não verificado',
  SIMULATED: 'Simulado',
};

export function isDemoMode(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.GMN_DEMO_MODE === 'true';
}

/** Reduz uma coleção ao formato persistível: remove `undefined`, limita texto e profundidade. */
export function toPersistableEvidence(evidence: readonly AuditEvidence[]): readonly AuditEvidence[] {
  return evidence
    .filter((item) => item.status !== 'SIMULATED')
    .map((item) => ({
      ...item,
      explanation: item.explanation.slice(0, 600),
      limitations: item.limitations.map((entry) => entry.slice(0, 300)).slice(0, 8),
    }));
}
