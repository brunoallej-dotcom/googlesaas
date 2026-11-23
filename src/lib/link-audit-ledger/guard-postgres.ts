import { z } from 'zod';
import { GUARD_RESPONSE_TIMEOUT_MS, PROCESS_GUARD_TIMER, type ExternalGuardPort, type GuardLatestResult, type GuardPublishResult, type GuardTimer } from './guard';
import type { GuardPseudonyms, GuardRef } from './guard-pseudonym';
import { LEDGER_AUDIT_ID_PATTERN, MAX_LEDGER_RECORDS, type LedgerHead } from './types';

/*
 * ADAPTADOR REAL da guarda externa (G1.b.2a, GE-E1; provedor Supabase/Postgres, D-G0-1; spec `link-audit-production-gates.md` §5.1.4 regras 5, 7 e 8,
 * §5.1.6 opção (1), §5.1.7). Fala com o esquema da migração `supabase/proposed/004_link_audit_guard.sql` pelo papel `gmn_guard_writer`:
 *  - `publish` chama SÓ a função de publicação (`publish_head`, regra 7 atômica no provedor) e mapeia o desfecho: `RECORDED`/`ALREADY_RECORDED` ⇒
 *    `{ ok: true }`, `CONFLICT` ⇒ `CONFLICT`, `STALE` ⇒ `STALE`; qualquer erro, prazo ou resposta fora do esquema ⇒ `UNAVAILABLE`;
 *  - `latest` lê a maior posição do pseudônimo de CADA chave (atual e aposentadas) e devolve a maior; `null` só numa resposta VÁLIDA e vazia; erro,
 *    prazo ou resposta fora do esquema ⇒ `{ ok: false }` (nunca "nenhuma cabeça"). A mesma posição máxima com `sha256` diferentes sob dois
 *    pseudônimos é incoerente ⇒ indisponível (escolher uma poderia esconder um retrocesso);
 *  - o `auditId` NUNCA sai do processo: o provedor recebe o `audit_ref` (HMAC, `guard-pseudonym.ts`) e o id público da chave, sempre como
 *    PARÂMETROS posicionais de um SQL fixo;
 *  - uma conexão por chamada (sem pool) com prazo de 3 s (D-G0-3) TAMBÉM aqui: esgotado, a conexão é encerrada e a chamada responde indisponível; a
 *    conexão que abrir depois do prazo é encerrada na hora. Toda conexão aberta é encerrada exatamente uma vez.
 * O cliente do banco é INJETADO (`connect`): a produção usa `pgGuardConnector` (`guard-pg.ts`, TLS verificado); os testes usam um provedor simulado.
 * O serviço do livro sempre envolve este adaptador com `boundGuard` (prazo e validação na porta), então os prazos se somam por camada, sem lacuna.
 */

/** Valores posicionais aceitos nas duas consultas. */
export type GuardDbValue = string | number | readonly string[];
/** Uma conexão do banco da guarda: uma consulta e o encerramento. */
export interface GuardDbSession {
  query(text: string, values: readonly GuardDbValue[]): Promise<{ readonly rows: readonly unknown[] }>;
  end(): Promise<void>;
}
export type GuardDbConnect = () => Promise<GuardDbSession>;

/** As duas ÚNICAS consultas do adaptador (SQL fixo; dados só por parâmetro). Mudar aqui exige mudar a migração e o teste local dela. */
export const GUARD_PUBLISH_SQL = 'select gmn_link_audit_guard.publish_head($1, $2, $3, $4) as outcome';
/**
 * Todas as linhas na MAIOR posição de cada pseudônimo pedido (não `distinct on`): se a restrição única do provedor faltasse ou fosse outra, duas
 * linhas na mesma posição máxima do mesmo pseudônimo chegariam ambas e o adaptador responderia indisponível, nunca um `sha256` escolhido ao acaso
 * (revisão do PR #61; a migração também confere a definição exata da restrição).
 */
export const GUARD_LATEST_SQL =
  'select h.audit_ref, h.key_id, h.ledger_seq, h.sha256 from gmn_link_audit_guard.ledger_heads h where h.audit_ref = any($1::text[]) and h.ledger_seq = (select pg_catalog.max(m.ledger_seq) from gmn_link_audit_guard.ledger_heads m where m.audit_ref = h.audit_ref) order by h.audit_ref';

export interface PostgresGuardOptions {
  /** Pseudônimos da auditoria (chave atual e aposentadas), montados pela configuração. */
  readonly pseudonyms: GuardPseudonyms;
  /** Abre uma conexão (produção: `pgGuardConnector`). */
  readonly connect: GuardDbConnect;
  /** Relógio do prazo (padrão: o do processo). Só testes injetam outro. */
  readonly timer?: GuardTimer;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const outcomeRowsSchema = z.array(z.object({ outcome: z.enum(['RECORDED', 'ALREADY_RECORDED', 'CONFLICT', 'STALE']) }).strict()).length(1);
const headRowSchema = z
  .object({
    audit_ref: z.string().regex(HEX_64),
    key_id: z.string().regex(/^[a-z0-9][a-z0-9-]{3,31}$/),
    ledger_seq: z.number().int().min(1).max(MAX_LEDGER_RECORDS),
    sha256: z.string().regex(HEX_64),
  })
  .strict();
const PUBLISH_UNAVAILABLE: GuardPublishResult = { ok: false, reason: 'UNAVAILABLE' };
const LATEST_UNAVAILABLE: GuardLatestResult = { ok: false };
const OUTCOMES: Readonly<Record<z.infer<typeof outcomeRowsSchema>[number]['outcome'], GuardPublishResult>> = {
  RECORDED: { ok: true },
  ALREADY_RECORDED: { ok: true },
  CONFLICT: { ok: false, reason: 'CONFLICT' },
  STALE: { ok: false, reason: 'STALE' },
};

/** Encerra sem nunca lançar nem esperar (o desfecho da chamada já está decidido). */
function closeQuietly(session: GuardDbSession): void {
  try {
    void session.end().catch(() => undefined);
  } catch {
    // `end` síncrono que lança: a conexão já não serve; nada a fazer além de não propagar (o desfecho é o mesmo)
  }
}

/** Maior cabeça entre os pseudônimos pedidos; resposta incoerente ⇒ indisponível. */
function headOf(refs: readonly GuardRef[], rows: readonly unknown[]): GuardLatestResult {
  const parsed = z.array(headRowSchema).safeParse(rows);
  if (!parsed.success) return LATEST_UNAVAILABLE;
  const asked = new Set(refs.map((ref) => ref.auditRef));
  const seen = new Set<string>();
  for (const row of parsed.data) {
    if (!asked.has(row.audit_ref) || seen.has(row.audit_ref)) return LATEST_UNAVAILABLE; // pseudônimo não pedido, ou duas linhas na posição máxima dele
    seen.add(row.audit_ref);
  }
  if (parsed.data.length === 0) return { ok: true, head: null };
  const top = Math.max(...parsed.data.map((row) => row.ledger_seq));
  const hashes = new Set(parsed.data.filter((row) => row.ledger_seq === top).map((row) => row.sha256));
  if (hashes.size !== 1) return LATEST_UNAVAILABLE;
  const head: LedgerHead = { ledgerSeq: top, sha256: [...hashes][0] as string };
  return { ok: true, head };
}

const validRecord = (record: { readonly auditId: string; readonly ledgerSeq: number; readonly sha256: string }): boolean =>
  LEDGER_AUDIT_ID_PATTERN.test(record.auditId) && Number.isSafeInteger(record.ledgerSeq) && record.ledgerSeq >= 1 && record.ledgerSeq <= MAX_LEDGER_RECORDS && HEX_64.test(record.sha256);

export function createPostgresGuard(options: PostgresGuardOptions): ExternalGuardPort {
  const timer = options.timer ?? PROCESS_GUARD_TIMER;

  /** Uma chamada: abre, consulta, encerra; prazo de 3 s; nunca lança. */
  function call<T>(work: (session: GuardDbSession) => Promise<T>, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      let open: GuardDbSession | null = null;
      let cancel: () => void = () => undefined;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        cancel();
        const session = open;
        open = null;
        if (session) closeQuietly(session);
        resolve(value);
      };
      cancel = timer.start(GUARD_RESPONSE_TIMEOUT_MS, () => finish(fallback));
      if (settled) cancel(); // relógio que esgota de forma síncrona
      let connecting: Promise<GuardDbSession>;
      try {
        connecting = options.connect();
      } catch {
        finish(fallback);
        return;
      }
      Promise.resolve(connecting).then(
        (session) => {
          if (settled) {
            closeQuietly(session); // abriu depois do prazo: encerra sem consultar
            return;
          }
          open = session;
          let running: Promise<T>;
          try {
            running = work(session);
          } catch {
            finish(fallback);
            return;
          }
          Promise.resolve(running).then(finish, () => finish(fallback));
        },
        () => finish(fallback),
      );
    });
  }

  return {
    publish(record) {
      if (!validRecord(record)) return Promise.resolve(PUBLISH_UNAVAILABLE);
      const ref = options.pseudonyms.current(record.auditId);
      return call(async (session) => {
        const result = await session.query(GUARD_PUBLISH_SQL, [ref.auditRef, ref.keyId, record.ledgerSeq, record.sha256]);
        const parsed = outcomeRowsSchema.safeParse(result.rows);
        return parsed.success ? OUTCOMES[(parsed.data[0] as { outcome: keyof typeof OUTCOMES }).outcome] : PUBLISH_UNAVAILABLE;
      }, PUBLISH_UNAVAILABLE);
    },
    latest(auditId) {
      if (!LEDGER_AUDIT_ID_PATTERN.test(auditId)) return Promise.resolve(LATEST_UNAVAILABLE);
      const refs = options.pseudonyms.all(auditId);
      return call(async (session) => {
        const result = await session.query(GUARD_LATEST_SQL, [refs.map((ref) => ref.auditRef)]);
        return headOf(refs, result.rows);
      }, LATEST_UNAVAILABLE);
    },
  };
}
