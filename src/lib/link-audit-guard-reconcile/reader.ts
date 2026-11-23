import { z } from 'zod';
import { MAX_LEDGER_RECORDS, PROCESS_GUARD_TIMER, type GuardDbConnect, type GuardDbSession, type GuardTimer } from '../link-audit-ledger';
import type { GuardRow } from './model';

/*
 * LEITURA DA GUARDA pela reconciliação externa (G1.b.2b, GE-E5). SOMENTE LEITURA, pelo papel `gmn_guard_reader` (spec §5.1.6; credencial fora da
 * VPS), com o conector TLS `verify-full` da G1.b.2a injetado (`pgGuardReaderConnector`; os testes usam um provedor simulado). Uma conexão só, sem
 * pool, SEMPRE encerrada, com prazo TOTAL (`READER_DEADLINE_MS`) além dos prazos do driver e do papel.
 *
 * Ordem:
 *  1. IDENTIDADE, antes de ler qualquer cabeça: o papel da sessão é o de leitura, a sessão é somente leitura por padrão (o
 *     `default_transaction_read_only` do papel, migração 004) e a sessão NÃO pode executar a função de publicação. Qualquer sinal de outra credencial
 *     (o escritor tem outro papel, sessão gravável e EXECUTE) ⇒ recusa, sem ler nada;
 *  2. `begin … read only` (repeatable read: cabeças e linhas antigas do MESMO instante; e a transação recusa escrita mesmo que o papel mudasse);
 *  3. as cabeças: a maior linha de CADA pseudônimo da tabela (todas as auditorias: a reconciliação também procura cabeça sem livro na cópia);
 *  4. as linhas do registro anterior, pela posição exata (pseudônimo + posição), para conferir que nada sumiu nem mudou;
 *  5. `rollback`.
 * Erro, prazo ou resposta fora do esquema ⇒ recusa (nunca "guarda vazia"). SQL fixo; dados só por parâmetro. Nunca recebe nem envia `auditId`.
 */
export const READER_IDENTITY_SQL =
  "select current_user::text as role_name, pg_catalog.current_setting('default_transaction_read_only') as default_read_only, pg_catalog.has_function_privilege('gmn_link_audit_guard.publish_head(text, text, integer, text)', 'EXECUTE') as can_publish";
export const READER_BEGIN_SQL = 'begin transaction isolation level repeatable read, read only';
export const READER_HEADS_SQL = 'select distinct on (h.audit_ref) h.audit_ref, h.key_id, h.ledger_seq, h.sha256 from gmn_link_audit_guard.ledger_heads h order by h.audit_ref, h.ledger_seq desc limit $1';
export const READER_ROWS_SQL =
  'select h.audit_ref, h.key_id, h.ledger_seq, h.sha256 from gmn_link_audit_guard.ledger_heads h join pg_catalog.unnest($1::text[], $2::text[]) as p(audit_ref, ledger_seq) on h.audit_ref = p.audit_ref and h.ledger_seq = p.ledger_seq::integer order by h.audit_ref, h.ledger_seq';
export const READER_END_SQL = 'rollback';
/** Papel que a sessão precisa ter (o mesmo nome de `GUARD_READER_ROLE`; aqui sem import cruzado do valor de configuração). */
export const READER_ROLE = 'gmn_guard_reader';
/** Teto de pseudônimos lidos de uma vez; acima disso a leitura recusa (nunca trunca em silêncio). */
export const MAX_GUARD_HEADS = 20_000;
/** Prazo TOTAL da leitura (conectar, conferir, ler e encerrar). */
export const READER_DEADLINE_MS = 60_000;

export type ReaderRefusal = 'GUARD_UNAVAILABLE' | 'GUARD_RESPONSE_INVALID' | 'NOT_READER_ROLE' | 'SESSION_NOT_READ_ONLY' | 'READER_CAN_PUBLISH' | 'TOO_MANY_GUARD_HEADS';
export interface GuardReading {
  readonly role: string;
  /** A maior linha de cada pseudônimo, em ordem de pseudônimo. */
  readonly heads: readonly GuardRow[];
  /** O que a guarda tem hoje nas posições do registro anterior. */
  readonly previousNow: readonly GuardRow[];
}
export type ReaderResult = { readonly ok: true; readonly value: GuardReading } | { readonly ok: false; readonly code: ReaderRefusal };

const HEX_64 = /^[0-9a-f]{64}$/;
const identitySchema = z.array(z.object({ role_name: z.string(), default_read_only: z.string(), can_publish: z.boolean() }).strict()).length(1);
const rowSchema = z.object({ audit_ref: z.string().regex(HEX_64), key_id: z.string().regex(/^[a-z0-9][a-z0-9-]{3,31}$/), ledger_seq: z.number().int().min(1).max(MAX_LEDGER_RECORDS), sha256: z.string().regex(HEX_64) }).strict();
const rowsSchema = z.array(rowSchema);

/** Falha de leitura com o código já decidido (sai do trabalho sem virar "indisponível"). */
class ReaderStop extends Error {
  constructor(readonly code: ReaderRefusal) {
    super(code);
  }
}

const asRows = (raw: readonly unknown[]): GuardRow[] => {
  const parsed = rowsSchema.safeParse(raw);
  if (!parsed.success) throw new ReaderStop('GUARD_RESPONSE_INVALID');
  return parsed.data.map((row) => ({ auditRef: row.audit_ref, keyId: row.key_id, ledgerSeq: row.ledger_seq, sha256: row.sha256 }));
};

async function checkIdentity(session: GuardDbSession): Promise<string> {
  const parsed = identitySchema.safeParse((await session.query(READER_IDENTITY_SQL, [])).rows);
  if (!parsed.success) throw new ReaderStop('GUARD_RESPONSE_INVALID');
  const identity = parsed.data[0] as z.infer<typeof identitySchema>[number];
  if (identity.role_name !== READER_ROLE) throw new ReaderStop('NOT_READER_ROLE');
  if (identity.default_read_only !== 'on') throw new ReaderStop('SESSION_NOT_READ_ONLY');
  if (identity.can_publish) throw new ReaderStop('READER_CAN_PUBLISH');
  return identity.role_name;
}

async function readHeads(session: GuardDbSession): Promise<GuardRow[]> {
  const heads = asRows((await session.query(READER_HEADS_SQL, [MAX_GUARD_HEADS + 1])).rows);
  if (heads.length > MAX_GUARD_HEADS) throw new ReaderStop('TOO_MANY_GUARD_HEADS');
  if (new Set(heads.map((row) => row.auditRef)).size !== heads.length) throw new ReaderStop('GUARD_RESPONSE_INVALID');
  return heads;
}

async function readPrevious(session: GuardDbSession, previous: readonly Pick<GuardRow, 'auditRef' | 'ledgerSeq'>[]): Promise<GuardRow[]> {
  if (previous.length === 0) return [];
  const asked = new Set(previous.map((row) => `${row.auditRef}:${row.ledgerSeq}`));
  const rows = asRows((await session.query(READER_ROWS_SQL, [previous.map((row) => row.auditRef), previous.map((row) => String(row.ledgerSeq))])).rows);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.auditRef}:${row.ledgerSeq}`;
    if (!asked.has(key) || seen.has(key)) throw new ReaderStop('GUARD_RESPONSE_INVALID'); // linha não pedida ou repetida
    seen.add(key);
  }
  return rows;
}

async function readAll(session: GuardDbSession, previous: readonly GuardRow[]): Promise<GuardReading> {
  const role = await checkIdentity(session);
  await session.query(READER_BEGIN_SQL, []);
  const heads = await readHeads(session);
  const previousNow = await readPrevious(session, previous);
  try {
    await session.query(READER_END_SQL, []);
  } catch {
    // o encerramento da conexão descarta a transação (somente leitura) de qualquer forma; o que foi lido já está validado
  }
  return { role, heads, previousNow };
}

function closeQuietly(session: GuardDbSession): void {
  try {
    void session.end().catch(() => undefined);
  } catch {
    // `end` síncrono que lança: a conexão já não serve; o desfecho é o mesmo
  }
}

/** Lê a guarda (somente leitura) com prazo total; nunca lança. */
export function readGuard(connect: GuardDbConnect, previous: readonly GuardRow[], options: { readonly timer?: GuardTimer; readonly deadlineMs?: number } = {}): Promise<ReaderResult> {
  const timer = options.timer ?? PROCESS_GUARD_TIMER;
  return new Promise<ReaderResult>((resolve) => {
    let settled = false;
    let open: GuardDbSession | null = null;
    let cancel: () => void = () => undefined;
    const finish = (result: ReaderResult): void => {
      if (settled) return;
      settled = true;
      cancel();
      const session = open;
      open = null;
      if (session) closeQuietly(session);
      resolve(result);
    };
    const fail = (error: unknown): void => finish({ ok: false, code: error instanceof ReaderStop ? error.code : 'GUARD_UNAVAILABLE' });
    cancel = timer.start(options.deadlineMs ?? READER_DEADLINE_MS, () => finish({ ok: false, code: 'GUARD_UNAVAILABLE' }));
    if (settled) cancel();
    let connecting: Promise<GuardDbSession>;
    try {
      connecting = connect();
    } catch (error) {
      fail(error);
      return;
    }
    Promise.resolve(connecting).then(
      (session) => {
        if (settled) {
          closeQuietly(session); // abriu depois do prazo: encerra sem consultar
          return;
        }
        open = session;
        readAll(session, previous).then((value) => finish({ ok: true, value }), fail);
      },
      () => finish({ ok: false, code: 'GUARD_UNAVAILABLE' }),
    );
  });
}
