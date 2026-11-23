import { parseTrustKeyring, type EvidenceProvenancePolicy, type EvidenceToProve, type EvidenceTrust } from './provenance';

/*
 * PORTA DE RECONFERÊNCIA DA PROVENIÊNCIA (R2.2; contrato do verificador v2 §6 e §7.3, D12 da spec do P1). Lado do DOMÍNIO DE EVIDÊNCIAS: a releitura dos resultados confirmados
 * (`link-audit-scoring-runs/results.ts`) a recebe injetada pela composição das rotas (`scoring/shared.ts`) e nunca importa o verificador nem lê o ambiente (RL-29).
 *
 * Para UMA base de evidências (a GRAVADA no resultado), devolve:
 *  - `revokedKeyIds`: os ids PÚBLICOS das chaves `revoked` na lista de confiança ATUAL (a aposentada, com ou sem fecho, NÃO é revogada: ela só verifica o que o fecho congelou);
 *  - `trust`: o `classify` ATUAL da política de produção sobre essa base (a mesma política da prévia e da finalização).
 * Lista ausente ou inválida ⇒ `NOT_CONFIGURED` (quem consome trata como revisão, nunca como autenticado). Exceção da política (que nunca deveria lançar) ⇒ `UNAUTHENTICATED`.
 *
 * CUSTO E ATUALIDADE: a lista é interpretada UMA vez, quando a porta é montada; `shared.ts` monta a porta A CADA requisição (o ambiente é lido de novo), então nada de revogação é
 * lembrado entre requisições. Quem consome deduplica por base DENTRO da requisição. Nada aqui grava, registra em log ou devolve material de chave.
 */
export type ProvenanceRecheck =
  | { readonly kind: 'CHECKED'; readonly revokedKeyIds: readonly string[]; readonly trust: EvidenceTrust }
  | { readonly kind: 'NOT_CONFIGURED' };

export interface ProvenanceRecheckPort {
  recheck(auditId: string, evidences: readonly EvidenceToProve[]): Promise<ProvenanceRecheck>;
}

export interface ProvenanceRecheckConfig {
  /** A política de PRODUÇÃO desta requisição (a de `evidenceProvenanceFromConfig` com `acceptedVersions: [2]`): a releitura usa exatamente a mesma verificação da prévia. */
  readonly policy: EvidenceProvenancePolicy;
  /** O valor CRU da lista de chaves de confiança lido nesta requisição (só chaves públicas). */
  readonly trustKeys: string | undefined;
}

const VERIFICATION_ERROR: EvidenceTrust = Object.freeze({ status: 'UNAUTHENTICATED', reason: 'VERIFICATION_ERROR' });

export function createProvenanceRecheck(config: ProvenanceRecheckConfig): ProvenanceRecheckPort {
  const ring = parseTrustKeyring(config.trustKeys);
  const revoked = ring === null ? null : Object.freeze([...ring].filter(([, entry]) => entry.status === 'revoked').map(([id]) => id).sort());
  return {
    async recheck(auditId, evidences) {
      if (revoked === null) return { kind: 'NOT_CONFIGURED' };
      let trust: EvidenceTrust;
      try {
        trust = await config.policy.classify(auditId, evidences);
      } catch {
        trust = VERIFICATION_ERROR; // a política nunca deveria lançar; se lançar, nada é autenticado (falha fechada)
      }
      return { kind: 'CHECKED', revokedKeyIds: [...revoked], trust };
    },
  };
}
