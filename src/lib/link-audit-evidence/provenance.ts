import path from 'node:path';
import type { FsOps } from '../link-audit/fs-ops';
import { nodeFsOps } from '../link-audit/node-fs-ops';
import {
  assembleEvidenceSealV2,
  assembleKeyRetirementClosure,
  buildEvidenceSealBodyV2,
  buildKeyRetirementClosureBody,
  CLOSED_EVIDENCE_PROVENANCE,
  CLOSURE_KIND,
  CLOSURE_SCHEMA_VERSION,
  createEvidenceSeal,
  createEvidenceSealV2,
  createKeyRetirementClosure,
  createSealedEvidenceProvenanceOver,
  DEFAULT_ACCEPTED_VERSIONS,
  EvidenceSealError,
  isWeakEd25519PublicKey,
  MAX_CHAIN_SEALS,
  MAX_CLASSIFY_BYTES,
  MAX_CLOSURE_BYTES,
  MAX_CLOSURE_HEADS,
  MAX_SEAL_BYTES,
  MAX_TRUST_KEYS,
  parseEvidenceSealV2Text,
  parseKeyRetirementClosureText,
  parseTrustKeyring,
  parseTrustKeys,
  publicKeyFromRaw,
  SEAL_FILE,
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  SEAL_SCHEMA_VERSION_V2,
  sealSha256,
  verifyEd25519PureSignature,
  verifyEvidenceSealV2Signature,
  verifyKeyRetirementClosureSignature,
  type AcceptedSealVersion,
  type EvidenceHeadProof,
  type EvidenceProvenancePolicy,
  type EvidenceSealBody,
  type EvidenceSealBodyV2,
  type EvidenceSealErrorCode,
  type EvidenceSealFile,
  type EvidenceSealFileV2,
  type EvidenceSealV2Input,
  type EvidenceToProve,
  type EvidenceTrust,
  type EvidenceTrustReason,
  type KeyRetirementClosureBody,
  type KeyRetirementClosureFile,
  type KeyRetirementClosureInput,
  type SealedEvidenceCoreOptions,
  type SealedEvidenceOptions,
  type SealTextIssue,
  type SealTextParse,
  type TrustKeyring,
  type TrustKeyringEntry,
} from './provenance-core';

/*
 * FACHADA do verificador de proveniência (P1 W4.6, spec §5.5.1 item 7). O verificador mora em `provenance-core.ts` (NÚCLEO, sem disco padrão:
 * toda leitura pela porta `FsOps` entregue). Aqui ficam, com o comportamento de antes, o que precisa do DISCO PADRÃO para o servidor
 * (`src/app/api/link-audit/scoring/shared.ts`) e para os testes W3:
 *  - `createSealedEvidenceProvenance(options)`: as mesmas opções; sem `fs`, lê o disco real (`nodeFsOps`, de `node-fs-ops.ts`);
 *  - `evidenceProvenanceFromConfig(config, fsOps?)`: a política a partir da configuração do servidor.
 * Todo o resto é reexportado do núcleo (mesmos valores; os vetores-ouro não mudam). Quem não pode carregar o disco padrão (o artefato único do
 * `sign`) importa o núcleo e entrega a própria porta (`createSealedEvidenceProvenanceOver`). Ver o cabeçalho do núcleo para as regras.
 */

/** Política que só autentica o que um manifesto ASSINADO por uma chave de confiança cobre, com os MESMOS hashes. Sem `fs`: o disco real. */
export function createSealedEvidenceProvenance(options: SealedEvidenceOptions): EvidenceProvenancePolicy {
  return createSealedEvidenceProvenanceOver({ ...options, acceptedVersions: options.acceptedVersions, fs: options.fs ?? nodeFsOps });
}

/**
 * Política a partir da CONFIGURAÇÃO do servidor (variáveis lidas por quem chama): pasta de manifestos + chaves públicas de confiança. Faltando
 * qualquer uma, ou chave malformada, a política é a FECHADA. Não existe valor que "confie em tudo".
 */
export function evidenceProvenanceFromConfig(
  config: { readonly sealsDir: string | null; readonly trustKeys: string | undefined; readonly otherDirs?: ReadonlyArray<string | null | undefined>; readonly acceptedVersions?: readonly AcceptedSealVersion[] },
  fsOps?: FsOps,
): EvidenceProvenancePolicy {
  const ring = parseTrustKeyring(config.trustKeys);
  if (!config.sealsDir || !ring) return CLOSED_EVIDENCE_PROVENANCE;
  // os manifestos NÃO podem morar em nenhuma outra pasta de dados (nem elas dentro deles): quem escreve lá não pode tocar na prova (nem para apagá-la).
  // Duas camadas: léxica aqui (já na configuração) e por caminho REAL (links simbólicos) a cada verificação.
  const others = (config.otherDirs ?? []).filter((dir): dir is string => typeof dir === 'string' && dir !== '');
  const a = path.resolve(config.sealsDir).toLowerCase();
  for (const dir of others) {
    const b = path.resolve(dir).toLowerCase();
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) return CLOSED_EVIDENCE_PROVENANCE;
  }
  // the list in the new format (a superset of the old one) and `acceptedVersions` forwarded as given (absent ⇒ library default [1,2]; production
  // passes [2], V2-19). Contract §5: this function uses `parseTrustKeyring` and the `keyring` option.
  return createSealedEvidenceProvenance({ sealsDir: config.sealsDir, keyring: ring, acceptedVersions: config.acceptedVersions, otherDirs: others, ...(fsOps ? { fs: fsOps } : {}) });
}

/* Reexportados do núcleo (sem `export … from`: a guarda estática da V2-19 só admite import nomeado dos módulos do verificador). */
export {
  assembleEvidenceSealV2,
  assembleKeyRetirementClosure,
  buildEvidenceSealBodyV2,
  buildKeyRetirementClosureBody,
  CLOSED_EVIDENCE_PROVENANCE,
  CLOSURE_KIND,
  CLOSURE_SCHEMA_VERSION,
  createEvidenceSeal,
  createEvidenceSealV2,
  createKeyRetirementClosure,
  DEFAULT_ACCEPTED_VERSIONS,
  EvidenceSealError,
  isWeakEd25519PublicKey,
  MAX_CHAIN_SEALS,
  MAX_CLASSIFY_BYTES,
  MAX_CLOSURE_BYTES,
  MAX_CLOSURE_HEADS,
  MAX_SEAL_BYTES,
  MAX_TRUST_KEYS,
  parseEvidenceSealV2Text,
  parseKeyRetirementClosureText,
  parseTrustKeyring,
  parseTrustKeys,
  publicKeyFromRaw,
  SEAL_FILE,
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  SEAL_SCHEMA_VERSION_V2,
  sealSha256,
  verifyEd25519PureSignature,
  verifyEvidenceSealV2Signature,
  verifyKeyRetirementClosureSignature,
};
export type {
  AcceptedSealVersion,
  EvidenceHeadProof,
  EvidenceProvenancePolicy,
  EvidenceSealBody,
  EvidenceSealBodyV2,
  EvidenceSealErrorCode,
  EvidenceSealFile,
  EvidenceSealFileV2,
  EvidenceSealV2Input,
  EvidenceToProve,
  EvidenceTrust,
  EvidenceTrustReason,
  KeyRetirementClosureBody,
  KeyRetirementClosureFile,
  KeyRetirementClosureInput,
  SealedEvidenceCoreOptions,
  SealedEvidenceOptions,
  SealTextIssue,
  SealTextParse,
  TrustKeyring,
  TrustKeyringEntry,
};
