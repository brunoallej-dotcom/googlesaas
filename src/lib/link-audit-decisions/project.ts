import type { OperatorRecord } from '../link-audit/scoring/input';
import { decisionIdFor, MAX_EFFECTIVE_RECORDS, pad, type ClientRecord, type DecisionBasis, type DecisionEntry } from './types';

/*
 * Reprodução (replay) PURA do histórico: dado o encadeamento de arquivos, devolve o estado de cada decisão e a lista
 * de registros VIGENTES. Nenhuma decisão é alterada ou removida: substituir e revogar são novas entradas.
 */
export type DecisionStatus = 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export interface DecisionView {
  readonly decisionId: string;
  readonly seq: number;
  readonly record: ClientRecord;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly supersedes: string | null;
  readonly basis: DecisionBasis;
  readonly status: DecisionStatus;
  /** `decisionId` da decisão que a substituiu. */
  readonly supersededBy: string | null;
  /** Sequência da entrada de revogação. */
  readonly revokedAtSeq: number | null;
}

export interface LogState {
  readonly entries: readonly DecisionEntry[];
  /** Todas as decisões, em ordem de criação, com o estado atual. */
  readonly decisions: readonly DecisionView[];
  /** Somente as vigentes (status ACTIVE), em ordem de criação. */
  readonly effective: readonly DecisionView[];
  readonly head: { readonly seq: number; readonly sha256: string } | null;
}

/**
 * "Espaços" que o contrato da 6A permite ocupar UMA vez por registro vigente. Duas decisões vigentes que ocupem o mesmo
 * espaço violariam o contrato ("mais de um juízo para C2" etc.); por isso a segunda precisa SUBSTITUIR a primeira.
 */
export function slotsOf(record: ClientRecord): string[] {
  switch (record.kind) {
    // `S:<subcritério>` é compartilhado por juízo e N/A do MESMO subcritério: o motor da 6A aplica o N/A primeiro e
    // esconderia o juízo (ex.: "faltam" de C3 valeria zero, mas o N/A neutro o encobriria e inflaria o índice).
    case 'JUDGEMENT':
      return [`J:${record.subcriterionId}`, `S:${record.subcriterionId}`];
    case 'NOT_APPLICABLE':
      return record.subcriterionIds.flatMap((id) => [`NA:${id}`, `S:${id}`]);
    case 'SITE_SCOPE_ATTESTATION':
      return record.subcriterionIds.map((id) => `ATT:${id}`);
    case 'OBSERVATION_CONFIRMATION':
      return record.subcriterionIds.map((id) => `OBS:${id}`);
    case 'IMAGES_CONFIRMATION':
      return ['IMG'];
    case 'NAME_EQUIVALENCE':
      // O par (sem ordem, sem caixa, NFC, espaços normalizados) é o espaço: a mesma equivalência não se repete e só
      // pode ser substituída por ela mesma; pares diferentes convivem.
      return [`NE:${JSON.stringify([record.nameA, record.nameB].map(normalizeName).sort())}`];
  }
}

const normalizeName = (name: string): string => name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Uma decisão só pode ser substituída por outra do MESMO tipo que cubra TODOS os espaços da anterior (pode acrescentar,
 * nunca retirar). Retirar um subcritério (ou trocar C2 por C3, ou uma equivalência de nomes por outra) é uma mudança
 * que o histórico precisa mostrar explicitamente: para isso existe a revogação.
 */
export function canSupersede(target: Pick<DecisionView, 'record'>, replacement: ClientRecord): boolean {
  if (target.record.kind !== replacement.kind) return false;
  const wanted = new Set(slotsOf(replacement));
  return slotsOf(target.record).every((slot) => wanted.has(slot));
}

interface Mutable {
  decisionId: string;
  seq: number;
  record: ClientRecord;
  recordedAt: string;
  recordedBy: string;
  supersedes: string | null;
  basis: DecisionBasis;
  status: DecisionStatus;
  supersededBy: string | null;
  revokedAtSeq: number | null;
}

/** Decisões VIGENTES (exceto as ignoradas) que ocupam algum espaço do `record`. */
export function slotConflicts(active: Iterable<Pick<DecisionView, 'decisionId' | 'record'>>, record: ClientRecord, ignore: ReadonlySet<string> = new Set()): string[] {
  const wanted = new Set(slotsOf(record));
  if (wanted.size === 0) return [];
  const clashes: string[] = [];
  for (const other of active) {
    if (ignore.has(other.decisionId)) continue;
    if (slotsOf(other.record).some((slot) => wanted.has(slot))) clashes.push(other.decisionId);
  }
  return clashes;
}

export type ReplayResult = { readonly ok: true; readonly value: LogState } | { readonly ok: false; readonly issues: readonly string[] };

const freezeView = (view: Mutable): DecisionView => Object.freeze({ ...view });

/** Reproduz o histórico. Qualquer inconsistência semântica (mesmo com hashes corretos) é recusada. */
export function replay(entries: readonly DecisionEntry[]): ReplayResult {
  const issues: string[] = [];
  const byId = new Map<string, Mutable>();
  const order: Mutable[] = [];
  const active = new Map<string, Mutable>(); // vigentes (contagem e conflitos em tempo linear no histórico)

  for (const entry of entries) {
    const label = `d${pad(entry.seq)}`;
    if (entry.action === 'RECORD') {
      if (entry.decisionId !== decisionIdFor(entry.seq)) issues.push(`${label}: o identificador ${entry.decisionId} não corresponde à sequência`);
      if (byId.has(entry.decisionId)) issues.push(`${label}: identificador de decisão repetido (${entry.decisionId})`);
      if (entry.supersedes !== null) {
        const target = byId.get(entry.supersedes);
        if (!target) issues.push(`${label}: substitui ${entry.supersedes}, que não existe antes desta entrada`);
        else if (target.status !== 'ACTIVE') issues.push(`${label}: substitui ${entry.supersedes}, que não está vigente`);
        else if (!canSupersede(target, entry.record)) issues.push(`${label}: substitui ${entry.supersedes}, mas precisa ser do mesmo tipo e cobrir todos os subcritérios da anterior (para retirar um, revogue)`);
        else {
          target.status = 'SUPERSEDED';
          target.supersededBy = entry.decisionId;
          active.delete(target.decisionId);
        }
      }
      const view: Mutable = {
        decisionId: entry.decisionId,
        seq: entry.seq,
        record: entry.record,
        recordedAt: entry.recordedAt,
        recordedBy: entry.recordedBy,
        supersedes: entry.supersedes,
        basis: entry.basis,
        status: 'ACTIVE',
        supersededBy: null,
        revokedAtSeq: null,
      };
      const clashes = slotConflicts(active.values(), entry.record);
      if (clashes.length > 0) issues.push(`${label}: ocupa o mesmo subcritério de ${clashes.join(', ')} sem substituí-la`);
      byId.set(view.decisionId, view);
      order.push(view);
      active.set(view.decisionId, view);
      if (active.size > MAX_EFFECTIVE_RECORDS) issues.push(`${label}: mais de ${MAX_EFFECTIVE_RECORDS} decisões vigentes`);
    } else {
      const target = byId.get(entry.revokes);
      if (!target) issues.push(`${label}: revoga ${entry.revokes}, que não existe antes desta entrada`);
      else if (target.status !== 'ACTIVE') issues.push(`${label}: revoga ${entry.revokes}, que não está vigente`);
      else {
        target.status = 'REVOKED';
        target.revokedAtSeq = entry.seq;
        active.delete(target.decisionId);
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const decisions = order.map(freezeView);
  const last = entries[entries.length - 1];
  return {
    ok: true,
    value: {
      entries,
      decisions,
      effective: decisions.filter((view) => view.status === 'ACTIVE'),
      head: last ? { seq: last.seq, sha256: last.contentSha256 } : null,
    },
  };
}

/** O registro exatamente como a entrada do motor da 6A o espera (autor, data e id vêm do servidor/arquivo). */
export function toScoringRecord(view: Pick<DecisionView, 'decisionId' | 'record' | 'recordedBy' | 'recordedAt'>): OperatorRecord {
  return { ...view.record, id: view.decisionId, operatorEmail: view.recordedBy, recordedAt: view.recordedAt } as OperatorRecord;
}

/** `operatorRecords` da entrada do motor: SOMENTE as decisões vigentes, em ordem de criação. */
export function effectiveScoringRecords(state: Pick<LogState, 'effective'>): OperatorRecord[] {
  return state.effective.map(toScoringRecord);
}
