import type { EvidenceToProve } from './provenance';

/**
 * Forma mínima da base de pontuação que a prova de coleta precisa. Estrutural de propósito: `BasisEvidence` e `BasisArtifact`
 * (scoring-basis) a satisfazem sem este arquivo importar o leitor.
 */
export interface EvidenceToProveSource {
  readonly evidences: readonly EvidenceToProveItem[];
  readonly artifacts?: readonly EvidenceToProveItem[];
}

interface EvidenceToProveItem {
  readonly ref: string;
  readonly contentSha256: string;
  readonly legacy: boolean;
}

/**
 * A ÚNICA montagem `base de pontuação → evidências a provar`. A prévia (que entrega a lista ao verificador) e o `export`/`sign`
 * do P1 usam esta função, para o que se atesta ser exatamente o que o verificador recebe. Pura; preserva a ordem
 * (evidências, depois artefatos) e copia só os três campos que a verificação usa.
 */
export function evidenceToProveFromBasis(basis: EvidenceToProveSource): EvidenceToProve[] {
  return [...basis.evidences, ...(basis.artifacts ?? [])].map((e) => ({ ref: e.ref, contentSha256: e.contentSha256, legacy: e.legacy }));
}
