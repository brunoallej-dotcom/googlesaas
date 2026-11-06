/*
 * Fiação do LIVRO DE CABEÇAS para as sementes de navegador (scripts/browser/): MESMO caminho de produção (`ledgerConfigFromEnv`), chave exclusiva recebida por
 * ambiente (aleatória por execução, nunca fixa), pasta própria `ledger/` dentro do diretório temporário da execução. Fica em tests/helpers porque usa os
 * serviços de decisões, resultados e livro, que as regras de isolamento só permitem a rotas de servidor e a testes.
 */
import path from 'node:path';
import { createDecisionService, type DecisionService } from '../../src/lib/link-audit-decisions';
import { createEvidenceReader } from '../../src/lib/link-audit-evidence';
import { createLedgerService, ledgerConfigFromEnv } from '../../src/lib/link-audit-ledger';
import type { OriginAuthenticator } from '../../src/lib/link-audit-origin';
import { createResultsKnownHeads } from '../../src/lib/link-audit-scoring-runs';
import { LEDGER_NOT_REQUIRED } from '../../src/lib/link-audit-decisions/ledger-port';
import { WITNESS_NOT_REQUIRED } from '../../src/lib/link-audit-decisions/witness';

type Fs = Parameters<typeof createDecisionService>[0]['fs'];

export function browserSeedServices(root: string, origin: OriginAuthenticator): {
  readonly decisions: (fsOps?: Fs) => DecisionService;
  /** Serviço SEM livro (6B isolada): só para criar a auditoria LEGADA (histórico anterior ao livro). */
  readonly legacyDecisions: () => DecisionService;
} {
  const d = (name: string): string => path.join(root, name);
  const ledgerKey = process.env.GMN_LINK_AUDIT_LEDGER_KEY ?? '';
  if (ledgerKey.length < 40) throw new Error('GMN_LINK_AUDIT_LEDGER_KEY ausente'); // a MESMA chave do servidor: só assim o livro semeado é reconhecido
  const config = ledgerConfigFromEnv({ GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR: d('ledger'), GMN_LINK_AUDIT_LEDGER_KEY: ledgerKey, GMN_LINK_AUDIT_ORIGIN_KEY: process.env.GMN_LINK_AUDIT_ORIGIN_KEY });
  if (!config.ok) throw new Error(`semente: livro de cabeças inválido (${config.code})`);
  const reader = createEvidenceReader({ baseDir: d('evidence'), authorize: () => true });
  const ledger = () => createLedgerService({ dir: config.dir, authenticator: config.authenticator, otherDirs: [d('decisions'), d('anchors'), d('evidence'), d('results'), d('resanchors'), d('seals')] });
  const knownHeads = createResultsKnownHeads({ baseDir: d('results'), anchorDir: d('resanchors'), origin, otherDirs: [d('decisions'), d('anchors'), d('evidence'), d('ledger'), d('seals')] });
  return {
    decisions: (fsOps) => createDecisionService({ ledger: ledger(), knownHeads, origin, baseDir: d('decisions'), anchorDir: d('anchors'), evidence: reader, evidenceBaseDir: d('evidence'), ...(fsOps ? { fs: fsOps } : {}) }),
    legacyDecisions: () => createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin, baseDir: d('decisions'), anchorDir: d('anchors'), evidence: reader, evidenceBaseDir: d('evidence') }),
  };
}
