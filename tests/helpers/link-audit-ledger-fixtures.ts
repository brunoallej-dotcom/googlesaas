import fs from 'node:fs';
import path from 'node:path';
import { createDecisionService, WITNESS_NOT_REQUIRED, type DecisionService, type KnownHeadsProvider, type LedgerPort, type LedgerSource } from '../../src/lib/link-audit-decisions';
import { createLedgerService, createSyntheticGuard, LEDGER_KIND, LEDGER_SCHEMA_VERSION, readLedgerFiles, type DecisionRef, type ExternalGuardPort, type LedgerCapacityPolicy, type LedgerDraft, type LedgerOp, type LedgerRecord, type OpenObservations } from '../../src/lib/link-audit-ledger';
import { seal } from '../../src/lib/link-audit-storage';
import { createOriginAuthenticator, type OriginAuthenticator, type OriginKeyring } from '../../src/lib/link-audit-origin';
import type { FsOps } from '../../src/lib/link-audit/snapshot-store';
import { ANA, clock, must, tmpDir, withAutoHead, world, type World } from './link-audit-decisions-fixtures';
import { TEST_ORIGIN, testKeySpec } from './link-audit-origin-fixtures';

/*
 * Cenários do LIVRO DE CABEÇAS sobre o serviço REAL de decisões (pastas reais, chaves fictícias geradas a partir de rótulos de teste).
 * A chave do livro é DIFERENTE da de origem (Q3): `lk-test-*` × `ok-test-*`.
 */
export const LEDGER_KEY_A = testKeySpec('lk-test-a', 'ledger-a');
export const LEDGER_KEY_B = testKeySpec('lk-test-b', 'ledger-b');
export const ledgerAuth = (spec: string | Omit<OriginKeyring, 'purpose'>): OriginAuthenticator => createOriginAuthenticator(typeof spec === 'string' ? { current: spec, purpose: 'ledger' } : { ...spec, purpose: 'ledger' });
export const LEDGER_AUTH_A = ledgerAuth(LEDGER_KEY_A);
export const LEDGER_AUTH_B = ledgerAuth(LEDGER_KEY_B);

/** Testemunha dos resultados sem nenhum resultado (legível e configurada): `UNWITNESSED`, nunca um defeito. */
export const NO_RESULTS: KnownHeadsProvider = async () => ({ ok: true, heads: [], unverifiedHeads: [], hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] });

export interface LedgerWorld extends World {
  readonly ledgerDir: string;
  readonly guardDir: string;
  readonly guard: ExternalGuardPort;
  readonly otherDirs: string[];
  /** Porta real do livro (chave A). */
  readonly ledger: LedgerPort;
  /** Serviço de decisões COM o livro, completando `expectedHead` sozinho. */
  readonly protectedService: DecisionService;
  /** Idem, sem completar `expectedHead`. */
  readonly rawProtected: DecisionService;
}

export interface LedgerServiceOver {
  readonly auth?: OriginAuthenticator;
  readonly fs?: FsOps;
  readonly guard?: ExternalGuardPort | null;
  readonly staleOperationMs?: number;
  readonly pollMs?: number;
  readonly checkpointEvery?: number;
  readonly capacityPolicy?: LedgerCapacityPolicy;
  readonly observations?: OpenObservations;
  /** Relógio monotônico do prazo do dono de uma finalização (R1.3, passo 7). */
  readonly monotonicMs?: () => number;
}

export function ledgerFor(w: Pick<LedgerWorld, 'ledgerDir' | 'otherDirs' | 'guard'>, over: LedgerServiceOver = {}): LedgerPort {
  return createLedgerService({
    dir: w.ledgerDir,
    authenticator: over.auth ?? LEDGER_AUTH_A,
    otherDirs: w.otherDirs,
    ...(over.fs ? { fs: over.fs } : {}),
    ...(over.guard === null ? {} : { guard: over.guard ?? w.guard }),
    ...(over.staleOperationMs !== undefined ? { staleOperationMs: over.staleOperationMs } : {}),
    ...(over.pollMs !== undefined ? { pollMs: over.pollMs } : {}),
    ...(over.checkpointEvery !== undefined ? { checkpointEvery: over.checkpointEvery } : {}),
    ...(over.capacityPolicy ? { capacityPolicy: over.capacityPolicy } : {}),
    ...(over.observations ? { observations: over.observations } : {}),
    ...(over.monotonicMs ? { monotonicMs: over.monotonicMs } : {}),
  });
}

/** Um serviço de decisões novo ("reinício" ou "outro processo") sobre as MESMAS pastas. */
export function decisionsOver(w: Pick<World, 'decisionsDir' | 'anchorDir' | 'evidenceDir' | 'reader'>, options: { ledger: LedgerSource; knownHeads?: KnownHeadsProvider | typeof WITNESS_NOT_REQUIRED; origin?: OriginAuthenticator | null; fs?: FsOps }): DecisionService {
  const origin = options.origin === null ? undefined : (options.origin ?? TEST_ORIGIN);
  return createDecisionService({
    baseDir: w.decisionsDir,
    anchorDir: w.anchorDir,
    evidence: w.reader,
    evidenceBaseDir: w.evidenceDir,
    ...(origin ? { origin } : {}),
    knownHeads: options.knownHeads ?? NO_RESULTS,
    ledger: options.ledger,
    ...(options.fs ? { fs: options.fs } : {}),
  });
}

export async function ledgerWorld(options: { capacityPolicy?: LedgerCapacityPolicy; checkpointEvery?: number; enroll?: boolean; auditId?: string; withGuard?: boolean; decisionsFs?: FsOps; ledgerFs?: FsOps; staleOperationMs?: number; seed?: boolean } = {}): Promise<LedgerWorld> {
  const base = await world({ ...(options.auditId ? { auditId: options.auditId } : {}), ...(options.decisionsFs ? { fs: options.decisionsFs } : {}), ...(options.seed === false ? { seed: false } : {}) });
  const ledgerDir = tmpDir('lad-led-');
  const guardDir = tmpDir('lad-grd-');
  const otherDirs = [base.decisionsDir, base.anchorDir, base.evidenceDir];
  const guard = createSyntheticGuard({ dir: guardDir });
  const partial = { ledgerDir, otherDirs, guard };
  const ledger = ledgerFor(partial, { ...(options.ledgerFs ? { fs: options.ledgerFs } : {}), ...(options.withGuard ? {} : { guard: null }), ...(options.capacityPolicy ? { capacityPolicy: options.capacityPolicy } : {}), ...(options.checkpointEvery !== undefined ? { checkpointEvery: options.checkpointEvery } : {}), ...(options.staleOperationMs !== undefined ? { staleOperationMs: options.staleOperationMs } : {}) });
  const rawProtected = decisionsOver(base, { ledger, ...(options.decisionsFs ? { fs: options.decisionsFs } : {}) });
  const w: LedgerWorld = { ...base, ledgerDir, guardDir, guard, otherDirs, ledger, rawProtected, protectedService: withAutoHead(rawProtected) };
  // sem evidência (seed:false) a inscrição não é possível ainda (a auditoria nem existe): o teste inscreve depois de gravar a evidência
  if (options.enroll !== false && options.seed !== false) await must(rawProtected.ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock()));
  return w;
}

/** Registros do livro da auditoria, lidos direto do disco. */
export async function ledgerRecords(w: Pick<LedgerWorld, 'ledgerDir' | 'auditId'>): Promise<LedgerRecord[]> {
  const read = await readLedgerFiles(w.ledgerDir, w.auditId);
  if (!read.ok) throw new Error(`livro ilegível: ${read.code}`);
  return [...read.value.records];
}
export const ledgerEvents = async (w: Pick<LedgerWorld, 'ledgerDir' | 'auditId'>): Promise<string[]> => (await ledgerRecords(w)).map((record) => record.event);
export const ledgerPath = (w: Pick<LedgerWorld, 'ledgerDir' | 'auditId'>, seq: number, auditId = w.auditId): string => path.join(w.ledgerDir, auditId, `l${String(seq).padStart(6, '0')}.json`);
export const ledgerFiles = (w: Pick<LedgerWorld, 'ledgerDir' | 'auditId'>): string[] => (fs.existsSync(path.join(w.ledgerDir, w.auditId)) ? fs.readdirSync(path.join(w.ledgerDir, w.auditId)).sort() : []);

/* ------------------------------------------------------------------ registros sintéticos (testes do modelo PURO e ataques) */

export const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
export const isoAt = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString();
export const sha = (label: string): string => (label.length >= 64 ? label.slice(0, 64) : label.repeat(Math.ceil(64 / label.length)).slice(0, 64)).replace(/[^0-9a-f]/g, 'a');

/** Constrói e assina UM registro encadeado ao anterior (ou o primeiro). */
export function makeRecord(auth: OriginAuthenticator, auditId: string, previous: LedgerRecord | null, draft: LedgerDraft): LedgerRecord {
  const unsigned = { schemaVersion: LEDGER_SCHEMA_VERSION, kind: LEDGER_KIND, auditId, ledgerSeq: (previous?.ledgerSeq ?? 0) + 1, prevSha256: previous?.contentSha256 ?? null, ...draft };
  return seal({ ...unsigned, origin: auth.sign('LEDGER', unsigned) }) as LedgerRecord;
}

export const refOf = (seq: number, prev: string | null, label: string, over: Partial<DecisionRef> = {}): DecisionRef => ({
  seq,
  sha256: sha(`${label}${seq}`),
  prevSha256: prev,
  action: 'RECORD',
  author: 'ana@empresa.com',
  decisionId: `op-${String(seq).padStart(4, '0')}`,
  revokes: null,
  supersedes: null,
  affectsPrior: false,
  ...over,
});

export function opOf(ref: DecisionRef, opId = 'a'.repeat(32)): LedgerOp {
  return {
    opId,
    decisionSeq: ref.seq,
    prevDecisionsHead: ref.prevSha256 === null ? null : { seq: ref.seq - 1, sha256: ref.prevSha256 },
    newDecisionsHead: { seq: ref.seq, sha256: ref.sha256 },
    action: ref.action,
    author: ref.author,
    decisionId: ref.decisionId,
    revokes: ref.revokes,
    supersedes: ref.supersedes,
    affectsPrior: ref.affectsPrior,
  };
}

/** Cadeia sintética: GENESIS + (INTENT, CONFIRMED) por decisão; `open` deixa o último INTENT sem fechar. */
export function syntheticLedger(auth: OriginAuthenticator, auditId: string, refs: readonly DecisionRef[], options: { open?: boolean; at?: (index: number) => string } = {}): LedgerRecord[] {
  const at = options.at ?? ((index: number) => isoAt(index));
  const records: LedgerRecord[] = [];
  const push = (draft: Omit<LedgerDraft, 'recordedAt'>): void => {
    records.push(makeRecord(auth, auditId, records[records.length - 1] ?? null, { ...draft, recordedAt: at(records.length) } as LedgerDraft));
  };
  push({ event: 'GENESIS', actor: 'ana@empresa.com', genesis: { mode: 'EMPTY' } });
  for (const [index, ref] of refs.entries()) {
    const op = opOf(ref, String(index + 1).padStart(32, '0'));
    push({ event: 'INTENT', actor: ref.author, op });
    if (options.open && index === refs.length - 1) break;
    push({ event: 'CONFIRMED', actor: ref.author, op: { ...op, intentSeq: records.length, anchorRef: { name: `a${String(ref.seq).padStart(4, '0')}.json`, headSha256: ref.sha256 } } });
  }
  return records;
}


/* ------------------------------------------------------------------ rotas e navegador: o mundo COM livro e o ambiente que o espelha */
/**
 * Mundo para os testes de ROTA/INTEGRAÇÃO: `raw`/`service` já passam pelo livro (como as rotas de produção), a auditoria vem INSCRITA e o ambiente do servidor
 * (`applyLedgerEnv`) aponta para a MESMA pasta e chave. Assim o que o teste grava direto e o que a rota lê concordam.
 */
export async function routeWorld(options: { auditId?: string; enroll?: boolean; fs?: FsOps; seed?: boolean } = {}): Promise<LedgerWorld> {
  const w = await ledgerWorld({ ...(options.auditId ? { auditId: options.auditId } : {}), ...(options.enroll === false ? { enroll: false } : {}), ...(options.fs ? { decisionsFs: options.fs } : {}), ...(options.seed === false ? { seed: false } : {}) });
  return { ...w, raw: w.rawProtected, service: w.protectedService };
}

export function applyLedgerEnv(env: Record<string, string | undefined>, w: Pick<LedgerWorld, 'ledgerDir'> | null, key: string | undefined = LEDGER_KEY_A): void {
  if (w === null) {
    delete env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR;
    delete env.GMN_LINK_AUDIT_LEDGER_KEY;
  } else {
    env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR = w.ledgerDir;
    if (key === undefined) delete env.GMN_LINK_AUDIT_LEDGER_KEY;
    else env.GMN_LINK_AUDIT_LEDGER_KEY = key;
  }
  delete env.GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS;
  delete env.GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS;
}
