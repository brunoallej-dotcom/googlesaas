import fs from 'node:fs';
import path from 'node:path';
import { serialize } from '../../src/lib/link-audit-storage';
import { ledgerRefOf, readLog } from '../../src/lib/link-audit-decisions/store';
import type { LedgerDraft, LedgerRecord } from '../../src/lib/link-audit-ledger';
import { writeAlternatingChain } from './link-audit-decisions-fixtures';
import { isoAt, LEDGER_AUTH_A, makeRecord, opOf, type LedgerWorld } from './link-audit-ledger-fixtures';


/*
 * HISTÓRICO LONGO e REAL-ASSINADO no disco, sem executar milhares de operações: `n` decisões alternando RECORD/REVOKE (a última, se `n` é ímpar, fica ATIVA e pode ser revogada) com
 * o livro correspondente (GENESIS + INTENT/CONFIRMED por decisão) completado com CHECKPOINTs até exatamente `total` registros. `checkpointEveryOps` controla o alinhamento do
 * último ponto de verificação (quanto maior, mais registros desde o último ⇒ mais cedo um novo é devido).
 */
export async function buildLongLedger(w: LedgerWorld, n: number, total: number, options: { checkpointEveryOps?: number } = {}): Promise<LedgerRecord[]> {
  writeAlternatingChain(w.decisionsDir, w.anchorDir, w.auditId, n);
  const log = await readLog(w.decisionsDir, w.auditId, { anchorDir: w.anchorDir });
  if (!log.ok) throw new Error('histórico longo ilegível');
  const everyOps = options.checkpointEveryOps ?? 20;
  const records: LedgerRecord[] = [];
  const push = (draft: unknown): void => {
    records.push(makeRecord(LEDGER_AUTH_A, w.auditId, records[records.length - 1] ?? null, { ...(draft as object), recordedAt: isoAt(records.length) } as LedgerDraft));
  };
  const checkpoint = (): void => push({ event: 'CHECKPOINT', actor: 'system', checkpoint: { throughSeq: records.length, throughSha256: (records[records.length - 1] as LedgerRecord).contentSha256 } });
  push({ event: 'GENESIS', actor: 'ana@empresa.com', genesis: { mode: 'EMPTY' } });
  for (const [i, entry] of log.value.state.entries.entries()) {
    const ref = ledgerRefOf(entry);
    const op = opOf(ref, String(i + 1).padStart(32, '0'));
    push({ event: 'INTENT', actor: ref.author, op });
    push({ event: 'CONFIRMED', actor: ref.author, op: { ...op, intentSeq: records.length, anchorRef: { name: `a${String(ref.seq).padStart(4, '0')}.json`, headSha256: ref.sha256 } } });
    if ((i + 1) % everyOps === 0 && records.length < total - 1) checkpoint();
  }
  if (records.length > total) throw new Error(`histórico de ${n} decisões já ocupa ${records.length} registros (> ${total})`);
  while (records.length < total) checkpoint();
  const dir = path.join(w.ledgerDir, w.auditId);
  fs.mkdirSync(dir, { recursive: true });
  for (const r of records) fs.writeFileSync(path.join(dir, `l${String(r.ledgerSeq).padStart(6, '0')}.json`), serialize(r), { mode: 0o444 });
  return records;
}
