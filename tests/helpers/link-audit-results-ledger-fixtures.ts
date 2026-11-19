import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ledgerRefOf, readLog } from '../../src/lib/link-audit-decisions/store';
import { LEDGER_KIND, readLedgerFiles, type DecisionRef, type LedgerRecord } from '../../src/lib/link-audit-ledger';
import type { OriginAuthenticator } from '../../src/lib/link-audit-origin';
import { seal, serialize } from '../../src/lib/link-audit-storage';
import { writeAlternatingChain } from './link-audit-decisions-fixtures';
import { isoAt, LEDGER_AUTH_A, opOf, type LedgerWorld } from './link-audit-ledger-fixtures';

/*
 * Registros `RUN_*` (R1.1, spec §16.17.2) construídos e etiquetados com a chave de TESTE do livro, em memória. Ninguém em `src/` grava `RUN_*` nesta
 * fatia: os testes montam as cadeias à mão (encadeadas, assinadas, seladas) e as gravam direto no disco quando precisam do serviço real.
 * Nenhum dado real: e-mails `@empresa.com` fictícios, hashes derivados de rótulos.
 */

export type RunEvent = 'RUN_INTENT' | 'RUN_CONFIRMED' | 'RUN_ABORTED';
/** Corpo `run` como o teste o escreve (pode ser inválido de propósito). */
export type RunBody = Record<string, unknown> & {
  runOpId: string;
  runSeq: number;
  prevRunSha256: string | null;
  runSha256: string;
  author: string;
  citedLedgerHead: { ledgerSeq: number; sha256: string };
  decisionsHead: { seq: number; sha256: string } | null;
};

export const hashOf = (label: string): string => createHash('sha256').update(label).digest('hex');
export const anchorOf = (runSeq: number): string => `a${String(runSeq).padStart(4, '0')}.json`;
const isRun = (event: string): boolean => event.startsWith('RUN_');

/** Assina e sela UM registro encadeado ao anterior. `schemaVersion` segue a família (1 decisão, 2 `RUN_*`) salvo quando o teste força outra. */
export function signRecord(auth: OriginAuthenticator, auditId: string, previous: LedgerRecord | null, body: Record<string, unknown>, over: { schemaVersion?: number } = {}): LedgerRecord {
  const event = String(body.event);
  const unsigned = { schemaVersion: over.schemaVersion ?? (isRun(event) ? 2 : 1), kind: LEDGER_KIND, auditId, ledgerSeq: (previous?.ledgerSeq ?? 0) + 1, prevSha256: previous?.contentSha256 ?? null, ...body };
  return seal({ ...unsigned, origin: auth.sign('LEDGER', unsigned) }) as LedgerRecord;
}

/** Reassina um registro depois de mudar o corpo (o "autor" do teste tem a chave: isola a regra de esquema/replay da etiqueta). */
export function resign(auth: OriginAuthenticator, record: LedgerRecord, mutate: (unsigned: Record<string, unknown>) => Record<string, unknown>): LedgerRecord {
  const { origin: _origin, contentSha256: _hash, ...unsigned } = record as unknown as Record<string, unknown>;
  void _origin;
  void _hash;
  const next = mutate(structuredClone(unsigned));
  return seal({ ...next, origin: auth.sign('LEDGER', next) }) as LedgerRecord;
}

/* ------------------------------------------------------------------ o que o prefixo diz (para montar um RUN_INTENT válido) */

/** Cabeça de decisões do prefixo: último registro que NÃO é `RUN_*` (I-3). */
export function decisionHeadOf(records: readonly LedgerRecord[]): { ledgerSeq: number; sha256: string } {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as LedgerRecord;
    if (!isRun(record.event)) return { ledgerSeq: record.ledgerSeq, sha256: record.contentSha256 };
  }
  throw new Error('prefixo sem registro de decisão');
}
/** `newDecisionsHead` do último `CONFIRMED` (I-4). */
export function decisionsHeadOf(records: readonly LedgerRecord[]): { seq: number; sha256: string } | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as LedgerRecord;
    if (record.event === 'CONFIRMED' && record.op) return { seq: record.op.newDecisionsHead.seq, sha256: record.op.newDecisionsHead.sha256 };
  }
  return null;
}
const runOf = (record: LedgerRecord): RunBody => (record as unknown as { run: RunBody }).run;
const confirmedRunsOf = (records: readonly LedgerRecord[]): RunBody[] => records.filter((r) => r.event === 'RUN_CONFIRMED').map(runOf);
export function openRunOf(records: readonly LedgerRecord[]): LedgerRecord | null {
  let open: LedgerRecord | null = null;
  for (const record of records) {
    if (record.event === 'RUN_INTENT') open = record;
    else if (record.event === 'RUN_CONFIRMED' || record.event === 'RUN_ABORTED') open = null;
  }
  return open;
}
export function openDecisionOf(records: readonly LedgerRecord[]): LedgerRecord | null {
  let open: LedgerRecord | null = null;
  for (const record of records) {
    if (record.event === 'INTENT') open = record;
    else if (record.event === 'CONFIRMED' || record.event === 'ABORTED') open = null;
  }
  return open;
}

/** Corpo `run` de um `RUN_INTENT` VÁLIDO sobre o prefixo (I-2, I-3, I-4), com `over` para quebrar um campo. */
export function nextRunBody(records: readonly LedgerRecord[], over: Partial<RunBody> = {}): RunBody {
  const confirmed = confirmedRunsOf(records);
  const attempts = records.filter((r) => r.event === 'RUN_INTENT').length + 1;
  const runSeq = confirmed.length + 1;
  return {
    runOpId: `${attempts.toString(16).padStart(31, '0')}e`,
    runSeq,
    prevRunSha256: confirmed[confirmed.length - 1]?.runSha256 ?? null,
    runSha256: hashOf(`resultado-${runSeq}-tentativa-${attempts}`),
    author: 'ana@empresa.com',
    citedLedgerHead: decisionHeadOf(records),
    decisionsHead: decisionsHeadOf(records),
    ...over,
  };
}
/** Corpo de fecho que repete o `RUN_INTENT` aberto (I-5), com `over` para quebrar um campo. */
export function closingRunBody(intent: LedgerRecord, event: 'RUN_CONFIRMED' | 'RUN_ABORTED', over: Partial<RunBody> = {}): RunBody {
  const base = { ...runOf(intent), intentSeq: intent.ledgerSeq, ...over } as RunBody;
  return event === 'RUN_CONFIRMED'
    ? { ...base, anchorRef: { name: anchorOf(base.runSeq), headSha256: base.runSha256 }, ...over }
    : { ...base, observed: { resultPresent: false, receiptPresent: false, ageMs: 130_000 }, ...over };
}

/* ------------------------------------------------------------------ montador de cadeias */

export interface Chain {
  readonly records: LedgerRecord[];
  readonly auditId: string;
  /** Troca a chave que assina os PRÓXIMOS registros (rotação). */
  as(auth: OriginAuthenticator): Chain;
  genesis(): Chain;
  /** INTENT (+ CONFIRMED pelo autor) de uma decisão; `open` deixa a INTENT aberta. */
  decision(ref: DecisionRef, options?: { open?: boolean; actor?: string }): Chain;
  confirmDecision(actor?: string): Chain;
  abortDecision(actor?: string): Chain;
  /** `RECEIPT_REISSUED` da ÚLTIMA decisão confirmada. */
  reissue(actor?: string): Chain;
  checkpoint(): Chain;
  /** CHECKPOINTs até `total` registros. */
  fill(total: number): Chain;
  runIntent(over?: Partial<RunBody>, actor?: string): Chain;
  runConfirm(actor?: string, over?: Partial<RunBody>): Chain;
  runAbort(actor?: string, over?: Partial<RunBody>): Chain;
  /** Um par completo `RUN_INTENT` + `RUN_CONFIRMED`. */
  run(): Chain;
  /** Registro arbitrário (corpo já com `event`, sem `recordedAt`). */
  raw(body: Record<string, unknown>, over?: { schemaVersion?: number }): Chain;
  tail(): LedgerRecord;
}

export function chainOf(auditId: string, initialAuth: OriginAuthenticator = LEDGER_AUTH_A): Chain {
  const records: LedgerRecord[] = [];
  let auth = initialAuth;
  let ops = 0;
  const push = (body: Record<string, unknown>, over: { schemaVersion?: number } = {}): void => {
    records.push(signRecord(auth, auditId, records[records.length - 1] ?? null, { ...body, recordedAt: isoAt(records.length) }, over));
  };
  const lastConfirmedDecision = (): LedgerRecord => {
    const found = [...records].reverse().find((r) => r.event === 'CONFIRMED');
    if (!found) throw new Error('sem decisão confirmada');
    return found;
  };
  const chain: Chain = {
    records,
    auditId,
    as(next) {
      auth = next;
      return chain;
    },
    genesis() {
      push({ event: 'GENESIS', actor: 'ana@empresa.com', genesis: { mode: 'EMPTY' } });
      return chain;
    },
    decision(ref, options = {}) {
      ops += 1;
      push({ event: 'INTENT', actor: ref.author, op: opOf(ref, `${ops.toString(16).padStart(31, '0')}d`) });
      if (!options.open) chain.confirmDecision(options.actor);
      return chain;
    },
    confirmDecision(actor) {
      const intent = openDecisionOf(records);
      if (!intent?.op) throw new Error('sem INTENT de decisão aberta');
      push({ event: 'CONFIRMED', actor: actor ?? intent.op.author, op: { ...intent.op, intentSeq: intent.ledgerSeq, anchorRef: { name: anchorOf(intent.op.decisionSeq), headSha256: intent.op.newDecisionsHead.sha256 } } });
      return chain;
    },
    abortDecision(actor = 'bia@empresa.com') {
      const intent = openDecisionOf(records);
      if (!intent?.op) throw new Error('sem INTENT de decisão aberta');
      push({ event: 'ABORTED', actor, op: { ...intent.op, intentSeq: intent.ledgerSeq, observed: { entryPresent: false, receiptPresent: false, ageMs: 130_000 } } });
      return chain;
    },
    reissue(actor) {
      const confirmed = lastConfirmedDecision();
      const op = confirmed.op as NonNullable<LedgerRecord['op']>;
      push({ event: 'RECEIPT_REISSUED', actor: actor ?? op.author, op });
      return chain;
    },
    checkpoint() {
      const tail = records[records.length - 1] as LedgerRecord;
      push({ event: 'CHECKPOINT', actor: 'system', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } });
      return chain;
    },
    fill(total) {
      while (records.length < total) chain.checkpoint();
      return chain;
    },
    runIntent(over = {}, actor) {
      const run = nextRunBody(records, over);
      push({ event: 'RUN_INTENT', actor: actor ?? run.author, run });
      return chain;
    },
    runConfirm(actor, over = {}) {
      const intent = openRunOf(records);
      if (!intent) throw new Error('sem RUN_INTENT aberto');
      const run = closingRunBody(intent, 'RUN_CONFIRMED', over);
      push({ event: 'RUN_CONFIRMED', actor: actor ?? runOf(intent).author, run });
      return chain;
    },
    runAbort(actor = 'bia@empresa.com', over = {}) {
      const intent = openRunOf(records);
      if (!intent) throw new Error('sem RUN_INTENT aberto');
      push({ event: 'RUN_ABORTED', actor, run: closingRunBody(intent, 'RUN_ABORTED', over) });
      return chain;
    },
    run() {
      return chain.runIntent().runConfirm();
    },
    raw(body, over) {
      push(body, over);
      return chain;
    },
    tail() {
      return records[records.length - 1] as LedgerRecord;
    },
  };
  return chain;
}

/* ------------------------------------------------------------------ disco: o serviço real lendo o que o teste montou */

const fileOf = (w: Pick<LedgerWorld, 'ledgerDir' | 'auditId'>, seq: number): string => path.join(w.ledgerDir, w.auditId, `l${String(seq).padStart(6, '0')}.json`);

/** Grava a cadeia inteira numa pasta de livro VAZIA (somente leitura, como o armazenamento grava). */
export function writeLedger(w: Pick<LedgerWorld, 'ledgerDir' | 'auditId'>, records: readonly LedgerRecord[]): void {
  fs.mkdirSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  for (const record of records) fs.writeFileSync(fileOf(w, record.ledgerSeq), serialize(record), { mode: 0o444, flag: 'wx' });
}

/** Lê o livro atual e acrescenta registros assinados por `auth` (cada `make` recebe os registros até ali e devolve o corpo, sem `recordedAt`). */
export async function appendLedger(w: Pick<LedgerWorld, 'ledgerDir' | 'auditId'>, auth: OriginAuthenticator, ...makers: Array<(records: readonly LedgerRecord[]) => Record<string, unknown>>): Promise<LedgerRecord[]> {
  const read = await readLedgerFiles(w.ledgerDir, w.auditId);
  if (!read.ok) throw new Error(`livro ilegível: ${read.code}`);
  const records = [...read.value.records];
  const added: LedgerRecord[] = [];
  for (const make of makers) {
    const previous = records[records.length - 1] ?? null;
    const later = previous && previous.recordedAt > isoAt(records.length) ? previous.recordedAt : isoAt(records.length);
    const record = signRecord(auth, w.auditId, previous, { ...make(records), recordedAt: later });
    records.push(record);
    added.push(record);
  }
  writeLedger(w, added);
  return records;
}
export const runIntentMaker = (over: Partial<RunBody> = {}) => (records: readonly LedgerRecord[]): Record<string, unknown> => {
  const run = nextRunBody(records, over);
  return { event: 'RUN_INTENT', actor: run.author, run };
};
export const runClosingMaker = (event: 'RUN_CONFIRMED' | 'RUN_ABORTED', actor?: string) => (records: readonly LedgerRecord[]): Record<string, unknown> => {
  const intent = openRunOf(records);
  if (!intent) throw new Error('sem RUN_INTENT aberto');
  return { event, actor: actor ?? (event === 'RUN_CONFIRMED' ? runOf(intent).author : 'bia@empresa.com'), run: closingRunBody(intent, event) };
};

/**
 * Pastas de decisões com `n` decisões alternadas RECORD/REVOKE (a última ATIVA quando `n` é ímpar; todas de Ana, `rec.c2()`) e o livro montado por `build`
 * sobre as referências REAIS dessas entradas — o serviço de decisões real lê os dois e os encontra coerentes.
 */
export async function plantWorld(w: LedgerWorld, n: number, build: (chain: Chain, refs: readonly DecisionRef[]) => void, auth: OriginAuthenticator = LEDGER_AUTH_A): Promise<LedgerRecord[]> {
  writeAlternatingChain(w.decisionsDir, w.anchorDir, w.auditId, n);
  const log = await readLog(w.decisionsDir, w.auditId, { anchorDir: w.anchorDir });
  if (!log.ok) throw new Error('decisões ilegíveis');
  const refs = log.value.state.entries.map((entry) => ledgerRefOf(entry));
  const chain = chainOf(w.auditId, auth).genesis();
  build(chain, refs);
  writeLedger(w, chain.records);
  return chain.records;
}
