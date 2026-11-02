import { WITNESS_NOT_REQUIRED } from '../../src/lib/link-audit-decisions/witness';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createDecisionService, type DecisionService } from '../../src/lib/link-audit-decisions';
import { createEvidenceReader, type EvidenceReader } from '../../src/lib/link-audit-evidence';
import { seal, serialize } from '../../src/lib/link-audit-decisions/store';
import { ANCHOR_FILE_KIND, anchorFileName, decisionIdFor, DECISION_FILE_KIND, DECISION_SCHEMA_VERSION, entryFileName, type DecisionEntry } from '../../src/lib/link-audit-decisions/types';
import type { FsOps } from '../../src/lib/link-audit/snapshot-store';
import { AUDIT, registerCleanup, tmpDir, writeFull } from './link-audit-evidence-fixtures';
import { TEST_ORIGIN } from './link-audit-origin-fixtures';

/** Fixtures FICTÍCIAS das decisões humanas: evidências sintéticas em pasta temporária, nenhuma rede, nenhum dado real. */
export { AUDIT, registerCleanup, tmpDir };

export const ANA = { email: 'ana@empresa.com' };
export const BIA = { email: 'bia@empresa.com' };

let tick = 0;
/** Relógio do "servidor" nos testes: sempre crescente, em UTC, antes da data de referência dos fixtures do motor. */
export const clock = (): string => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++)).toISOString();

const JUSTIFICATION = 'Conferido no painel do perfil pelo operador responsável.';

/** Um exemplo válido de CADA tipo de decisão humana da 6A. As evidências citadas existem nos fixtures (capture:c0001). */
export const rec = {
  c2: (value = 'COMPATIBLE') => ({ kind: 'JUDGEMENT', subcriterionId: 'C2', value, justification: JUSTIFICATION }),
  c3: (value = 'ALL_RELEVANT') => ({ kind: 'JUDGEMENT', subcriterionId: 'C3', value, justification: JUSTIFICATION }),
  /** `null` = sem tamanho da amostra (inválido pelo contrato da 6A). */
  p3: (sampleSize: number | null = 5, value = 'SPECIFIC') => ({
    kind: 'JUDGEMENT',
    subcriterionId: 'P3',
    value,
    ...(sampleSize === null ? {} : { sampleSize }),
    justification: JUSTIFICATION,
  }),
  naModel: () => ({ kind: 'NOT_APPLICABLE', subcriterionIds: ['S4'], code: 'BUSINESS_MODEL', justification: JUSTIFICATION }),
  naFeature: (refs: string[] = ['capture:c0001']) => ({ kind: 'NOT_APPLICABLE', subcriterionIds: ['S3'], code: 'FEATURE_UNAVAILABLE', causeEvidenceIds: refs, justification: JUSTIFICATION }),
  naNoAdditional: () => ({ kind: 'NOT_APPLICABLE', subcriterionIds: ['C3'], code: 'NO_ADDITIONAL_NEEDED', justification: JUSTIFICATION }),
  attestation: (ids: string[] = ['S5']) => ({
    kind: 'SITE_SCOPE_ATTESTATION',
    subcriterionIds: ids,
    scopeDescription: 'Sitemap integralmente percorrido e páginas de oferta conferidas manualmente.',
    justification: JUSTIFICATION,
  }),
  images: (refs: string[] = ['capture:c0001'], types: string[] = ['PLACE', 'PRODUCT_OR_SERVICE']) => ({ kind: 'IMAGES_CONFIRMATION', imageTypes: types, evidenceIds: refs, justification: JUSTIFICATION }),
  observation: (ids: string[] = ['S5', 'X4']) => ({ kind: 'OBSERVATION_CONFIRMATION', subcriterionIds: ids, justification: JUSTIFICATION }),
  nameEquivalence: (a = 'Padaria Exemplo Ltda', b = 'Padaria Exemplo') => ({ kind: 'NAME_EQUIVALENCE', nameA: a, nameB: b, justification: JUSTIFICATION }),
};

/** Os seis tipos do contrato da 6A, um exemplo de cada, em ordem. */
export const ALL_KIND_EXAMPLES = (): Array<{ kind: string; record: Record<string, unknown> }> => [
  { kind: 'JUDGEMENT', record: rec.c2() },
  { kind: 'NOT_APPLICABLE', record: rec.naFeature() },
  { kind: 'SITE_SCOPE_ATTESTATION', record: rec.attestation() },
  { kind: 'IMAGES_CONFIRMATION', record: rec.images() },
  { kind: 'OBSERVATION_CONFIRMATION', record: rec.observation() },
  { kind: 'NAME_EQUIVALENCE', record: rec.nameEquivalence() },
];

export interface World {
  readonly evidenceDir: string;
  readonly decisionsDir: string;
  readonly anchorDir: string;
  readonly auditId: string;
  readonly reader: EvidenceReader;
  /** Serviço COM `expectedHead` automático (o head atual é lido antes de cada escrita): quase todos os testes usam este. */
  readonly service: DecisionService;
  /** Serviço cru: o `expectedHead` precisa ser enviado no corpo (para testar a visão velha, o retrocesso e a ausência). */
  readonly raw: DecisionService;
}

/**
 * Envolve o serviço para preencher `expectedHead` com o head ATUAL quando o corpo não o traz. Corpos que não são objetos
 * simples passam intactos; se a auditoria não existe, usa `null` (o serviço responde o erro verdadeiro).
 */
export function withAutoHead(raw: DecisionService): DecisionService {
  const fill = async (actor: { email: string }, auditId: string, body: unknown): Promise<unknown> => {
    if (typeof body !== 'object' || body === null || Array.isArray(body) || 'expectedHead' in body) return body;
    try {
      const listed = await raw.list(actor, auditId);
      return { ...body, expectedHead: listed.ok ? listed.value.head : null };
    } catch {
      return { ...body, expectedHead: null }; // identidade sem acesso ao leitor: o serviço responde o erro verdadeiro
    }
  };
  return {
    list: (actor, auditId) => raw.list(actor, auditId),
    create: async (actor, auditId, body, now) => raw.create(actor, auditId, await fill(actor, auditId, body), now),
    revoke: async (actor, auditId, body, now) => raw.revoke(actor, auditId, await fill(actor, auditId, body), now),
  };
}

/** Evidência sintética completa (captura, site e relatório) + pastas de decisões e de âncoras vazias e separadas. */
export async function world(options: { fs?: FsOps; auditId?: string; seed?: boolean } = {}): Promise<World> {
  const evidenceDir = tmpDir('lad-ev-');
  const decisionsDir = tmpDir('lad-dec-');
  const anchorDir = tmpDir('lad-anc-');
  const auditId = options.auditId ?? AUDIT;
  if (options.seed !== false) await writeFull(evidenceDir, { auditId });
  const reader = createEvidenceReader({ baseDir: evidenceDir, authorize: () => true });
  const raw = createDecisionService({ knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: decisionsDir, anchorDir, evidence: reader, evidenceBaseDir: evidenceDir, ...(options.fs ? { fs: options.fs } : {}) });
  return { evidenceDir, decisionsDir, anchorDir, auditId, reader, raw, service: withAutoHead(raw) };
}

/** Cria e exige sucesso. */
export async function must<T>(promise: Promise<{ ok: true; value: T } | { ok: false; code: string; issues: readonly string[] }>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`esperava sucesso, veio ${result.code}: ${result.issues.join(' | ')}`);
  return result.value;
}

/** SHA-256 + tamanho de todos os arquivos (para provar que nada foi alterado nem criado). */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = `${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}:${fs.statSync(full).size}`;
    }
  };
  walk(dir);
  return out;
}

export const entryPath = (w: Pick<World, 'decisionsDir' | 'auditId'>, seq: number, auditId = w.auditId): string => path.join(w.decisionsDir, auditId, `d${String(seq).padStart(4, '0')}.json`);
export const anchorPath = (w: Pick<World, 'anchorDir' | 'auditId'>, seq: number, auditId = w.auditId): string => path.join(w.anchorDir, auditId, `a${String(seq).padStart(4, '0')}.json`);

/**
 * Escreve DIRETO em disco uma cadeia válida (decisões + âncoras) de `count` entradas alternando criação de C2 e revogação
 * (a última é uma criação vigente quando `count` é ímpar). Serve para testar limites sem milhares de chamadas ao serviço.
 */
/** Entrada selada COMO O SERVIDOR LEGÍTIMO a grava (com a etiqueta de origem do `TEST_ORIGIN`). Quem só escreve numa pasta NÃO consegue fazer isto. */
export function signedSeal<T extends object>(body: T): T & { origin: ReturnType<typeof TEST_ORIGIN.sign>; contentSha256: string } {
  return seal({ ...body, origin: TEST_ORIGIN.sign('DECISION', body) });
}

export function writeAlternatingChain(decisionsDir: string, anchorDir: string, auditId: string, count: number): void {
  const dir = path.join(decisionsDir, auditId);
  const adir = path.join(anchorDir, auditId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(adir, { recursive: true });
  let prev: string | null = null;
  let prevAnchor: string | null = null;
  const basis = { capture: 1, report: { capture: 1, revision: 1 }, collectedAt: '2026-10-22T12:54:48.079Z' };
  for (let seq = 1; seq <= count; seq++) {
    const at = '2026-10-21T12:00:00.000Z';
    const entry: DecisionEntry = signedSeal(
      seq % 2 === 1
        ? { schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId, seq, action: 'RECORD', recordedAt: at, recordedBy: 'ana@empresa.com', prevSha256: prev, decisionId: decisionIdFor(seq), record: rec.c2(), supersedes: null, basis }
        : { schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId, seq, action: 'REVOKE', recordedAt: at, recordedBy: 'ana@empresa.com', prevSha256: prev, revokes: decisionIdFor(seq - 1), reason: 'Informação conferida e incorreta; decisão desfeita.' },
    ) as unknown as DecisionEntry;
    prev = entry.contentSha256;
    fs.writeFileSync(path.join(dir, entryFileName(seq)), serialize(entry));
    const anchor: { contentSha256: string } = seal({ schemaVersion: DECISION_SCHEMA_VERSION, kind: ANCHOR_FILE_KIND, auditId, seq, headSha256: entry.contentSha256, anchoredAt: at, prevAnchorSha256: prevAnchor });
    prevAnchor = anchor.contentSha256;
    fs.writeFileSync(path.join(adir, anchorFileName(seq)), serialize(anchor));
  }
}
