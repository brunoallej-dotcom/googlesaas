import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GuardDbConnect, GuardDbSession, GuardDbValue, LedgerRecord } from '../../src/lib/link-audit-ledger';
import { READER_BEGIN_SQL, READER_END_SQL, READER_HEADS_SQL, READER_IDENTITY_SQL, READER_ROWS_SQL } from '../../src/lib/link-audit-guard-reconcile/reader';
import { serialize } from '../../src/lib/link-audit-storage';
import { tmpDir } from './link-audit-decisions-fixtures';
import type { SimulatedHeadRow } from './link-audit-guard-db-fixtures';
import { LEDGER_AUTH_A, refOf, syntheticLedger } from './link-audit-ledger-fixtures';

/*
 * G1.b.2b — RODADAS DE BACKUP SINTÉTICAS do livro, no formato do plano de backup (`deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md`, "Rotina
 * diária"): `<destino>/<RODADA>/` com `dados/` (a cópia da raiz do livro: `<auditId>/lNNNNNN.json`), `SHA256SUMS` (o manifesto de `find . -type f |
 * sort | sha256sum` na origem), `CABECAS.json` e o marcador `RODADA-VALIDA`. Os registros são REAIS (selados e assinados com a chave de teste do
 * livro), gravados com os mesmos bytes do armazenamento. Tudo em pasta temporária; nada de dado real.
 */
export const ROUND = '20261122-031500-4242';
export const sha256Hex = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Livro sintético com `n` registros (GENESIS + pares INTENT/CONFIRMED; n ímpar ⇒ o último INTENT fica aberto). */
export function ledgerOf(auditId: string, n: number): LedgerRecord[] {
  if (n < 1) return [];
  const decisions = Math.ceil((n - 1) / 2);
  const refs: ReturnType<typeof refOf>[] = [];
  for (let seq = 1; seq <= decisions; seq += 1) refs.push(refOf(seq, refs[seq - 2]?.sha256 ?? null, `d${auditId}`));
  const records = syntheticLedger(LEDGER_AUTH_A, auditId, refs, { open: (n - 1) % 2 === 1 });
  return records.slice(0, n);
}

export interface RoundOptions {
  /** Sem o marcador `RODADA-VALIDA`. */
  readonly noValidMarker?: boolean;
  /** Com o marcador `RODADA-INCOMPLETA`. */
  readonly incomplete?: boolean;
  /** Rótulo da pasta da rodada (padrão: `ROUND`). */
  readonly round?: string;
  /** Mexe na cópia DEPOIS do manifesto (simula cópia adulterada ou incompleta). */
  readonly afterManifest?: (dataDir: string) => void;
  /** Mexe na cópia ANTES do manifesto (o manifesto confere; o livro não). */
  readonly beforeManifest?: (dataDir: string) => void;
}

/** Grava uma rodada do livro e devolve a pasta dela (`<destino>/<RODADA>`). */
export function writeRound(ledgers: Readonly<Record<string, readonly LedgerRecord[]>>, options: RoundOptions = {}): string {
  const base = tmpDir('lagr-backup-');
  const roundDir = path.join(base, options.round ?? ROUND);
  const dataDir = path.join(roundDir, 'dados');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [auditId, records] of Object.entries(ledgers)) {
    const dir = path.join(dataDir, auditId);
    fs.mkdirSync(dir);
    for (const record of records) fs.writeFileSync(path.join(dir, `l${String(record.ledgerSeq).padStart(6, '0')}.json`), serialize(record));
  }
  options.beforeManifest?.(dataDir);
  fs.writeFileSync(path.join(roundDir, 'SHA256SUMS'), manifestOf(dataDir));
  options.afterManifest?.(dataDir);
  fs.writeFileSync(path.join(roundDir, 'CABECAS.json'), '{"sentinela":"cabeças da rodada"}\n');
  if (!options.noValidMarker) fs.writeFileSync(path.join(roundDir, 'RODADA-VALIDA'), `rodada ${options.round ?? ROUND} VALIDA\nquando (UTC): 2026-11-22T03:15:09Z\n`);
  if (options.incomplete) fs.writeFileSync(path.join(roundDir, 'RODADA-INCOMPLETA'), `rodada ${options.round ?? ROUND} INCOMPLETA\n`);
  return roundDir;
}

/** O manifesto como o plano o gera: `cd dados && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum`. */
export function manifestOf(dataDir: string): string {
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile()) files.push(relPath);
    }
  };
  walk(dataDir, '');
  const sorted = files.map((file) => `./${file}`).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sorted.map((file) => `${sha256Hex(fs.readFileSync(path.join(dataDir, file.slice(2))))}  ${file}\n`).join('');
}

/** A cabeça (posição e `contentSha256`) de um livro sintético em `seq`. */
export const headAt = (records: readonly LedgerRecord[], seq: number): { readonly ledgerSeq: number; readonly sha256: string } => {
  const record = records[seq - 1];
  if (!record) throw new Error(`sem registro ${seq}`);
  return { ledgerSeq: record.ledgerSeq, sha256: record.contentSha256 };
};

/* ------------------------------------------------------------------ provedor simulado do LEITOR (sem rede, sem banco) */

/**
 * Implementa as consultas do leitor da reconciliação (`reader.ts`) sobre as MESMAS linhas do provedor simulado do escritor
 * (`simulatedGuardDb().rows`), para que o que o adaptador real publicou seja o que a reconciliação lê. A identidade da sessão é configurável
 * (o escritor tem outro papel, sessão gravável e EXECUTE na publicação). Registra cada consulta e conta conexões abertas e encerradas.
 */
export interface SimulatedIdentity {
  readonly role_name: string;
  readonly default_read_only: string;
  readonly can_publish: boolean;
}
export const READER_IDENTITY: SimulatedIdentity = { role_name: 'gmn_guard_reader', default_read_only: 'on', can_publish: false };
export const WRITER_IDENTITY: SimulatedIdentity = { role_name: 'gmn_guard_writer', default_read_only: 'off', can_publish: true };

export function simulatedReaderDb(rows: SimulatedHeadRow[] = [], identity: SimulatedIdentity = READER_IDENTITY) {
  const queries: Array<{ readonly text: string; readonly values: readonly GuardDbValue[] }> = [];
  const state = { connects: 0, ends: 0, open: 0, failConnect: false, failOn: null as string | null, hangOn: null as string | null, rewrite: null as ((text: string, rows: readonly unknown[]) => readonly unknown[]) | null, inTransaction: false };
  const heads = (limit: number): SimulatedHeadRow[] => {
    const refs = [...new Set(rows.map((row) => row.audit_ref))].sort();
    return refs.flatMap((ref) => {
      const top = rows.filter((row) => row.audit_ref === ref).sort((x, y) => y.ledger_seq - x.ledger_seq)[0];
      return top ? [{ ...top }] : [];
    }).slice(0, limit);
  };
  const at = (refs: readonly string[], seqs: readonly string[]): SimulatedHeadRow[] =>
    rows.filter((row) => refs.some((ref, index) => ref === row.audit_ref && Number(seqs[index]) === row.ledger_seq)).map((row) => ({ ...row })).sort((x, y) => (x.audit_ref === y.audit_ref ? x.ledger_seq - y.ledger_seq : x.audit_ref < y.audit_ref ? -1 : 1));
  const answer = (text: string, values: readonly GuardDbValue[]): readonly unknown[] => {
    switch (text) {
      case READER_IDENTITY_SQL:
        return [{ ...identity }];
      case READER_BEGIN_SQL:
        state.inTransaction = true;
        return [];
      case READER_END_SQL:
        state.inTransaction = false;
        return [];
      case READER_HEADS_SQL:
        if (!state.inTransaction) throw new Error('sentinela: leitura fora da transação somente leitura');
        return heads(values[0] as number);
      case READER_ROWS_SQL:
        if (!state.inTransaction) throw new Error('sentinela: leitura fora da transação somente leitura');
        return at(values[0] as readonly string[], values[1] as readonly string[]);
      default:
        throw new Error('sentinela: SQL desconhecido');
    }
  };
  const connect: GuardDbConnect = async () => {
    state.connects += 1;
    if (state.failConnect) throw new Error('sentinela: conexão recusada');
    state.open += 1;
    let ended = false;
    const session: GuardDbSession = {
      async query(text, values) {
        queries.push({ text, values });
        if (state.failOn === text) throw new Error('sentinela: consulta falhou');
        if (state.hangOn === text) return new Promise(() => undefined);
        const result = answer(text, values);
        return { rows: state.rewrite ? state.rewrite(text, result) : result };
      },
      async end() {
        if (ended) return;
        ended = true;
        state.open -= 1;
        state.ends += 1;
      },
    };
    return session;
  };
  return { connect, rows, queries, state };
}
export type SimulatedReaderDb = ReturnType<typeof simulatedReaderDb>;

/** Relógio de prazo manual (o teste decide quando esgota). */
export function manualTimer() {
  const pending: Array<() => void> = [];
  return {
    timer: {
      start(_ms: number, onTimeout: () => void) {
        pending.push(onTimeout);
        return () => {
          const index = pending.indexOf(onTimeout);
          if (index >= 0) pending.splice(index, 1);
        };
      },
    },
    fire: () => pending.splice(0).forEach((fn) => fn()),
    get armed() {
      return pending.length;
    },
  };
}
