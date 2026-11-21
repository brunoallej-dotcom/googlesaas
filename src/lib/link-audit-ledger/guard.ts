import path from 'node:path';
import { z } from 'zod';
import { atomicOnly, dirStatus, ensureDirectory } from '../link-audit-storage';
import { nodeFsOps, publishExclusive, type FsOps } from '../link-audit/snapshot-store';
import { LEDGER_AUDIT_ID_PATTERN, type LedgerHead } from './types';

/*
 * GUARDA EXTERNA (Q6, 01/11/2026): testemunha IMUTÁVEL da cabeça do livro, em domínio de falha SEPARADO da VPS. É a única defesa contra o
 * retrocesso coordenado de todos os volumes e contra quem escreve em ≥ 2 pastas incluindo o livro. É REQUISITO DE PRODUÇÃO e o provedor real
 * (Supabase, D-G0-1) é da G1.b.2: aqui ficam a PORTA (contrato independente de provedor, spec `link-audit-production-gates.md` §5.1.4, regras 5 e 7),
 * o PRAZO de resposta e a validação das respostas (`boundGuard`) e um adaptador SINTÉTICO, só para testes locais. Sem guarda configurada o estado
 * é `NOT_CONFIGURED` e nada afirma proteção contra rollback coordenado.
 */

/** Motivo da recusa de uma publicação (regra 7): conflito na posição, posição nova abaixo da maior já gravada, ou guarda indisponível (erro, prazo, resposta inválida). */
export type GuardPublishRefusal = 'CONFLICT' | 'STALE' | 'UNAVAILABLE';
export type GuardPublishResult = { readonly ok: true } | { readonly ok: false; readonly reason: GuardPublishRefusal };
export type GuardLatestResult = { readonly ok: true; readonly head: LedgerHead | null } | { readonly ok: false };

export interface ExternalGuardPort {
  /**
   * Publica a cabeça. O provedor decide de forma ATÔMICA por auditoria (regra 7): o mesmo trio `(auditId, ledgerSeq, sha256)` já gravado ⇒ aceito sem registro novo, em
   * qualquer posição; mesmo `ledgerSeq` com outro `sha256` ⇒ `CONFLICT`; `ledgerSeq` novo menor que o maior ⇒ `STALE`; maior que o maior ⇒ gravado.
   */
  publish(record: { readonly auditId: string; readonly ledgerSeq: number; readonly sha256: string }): Promise<GuardPublishResult>;
  /** MAIOR cabeça publicada para a auditoria (`head: null` = nenhuma). `ok:false` = indisponível (nunca "nenhuma"). */
  latest(auditId: string): Promise<GuardLatestResult>;
}

/* ------------------------------------------------------------------ prazo de resposta e validação (regra 5, D-G0-3) */

/** Prazo de resposta POR CHAMADA à guarda (`latest` e `publish`): 3 s (D-G0-3, §5.1.7; a confirmar pela latência medida, PG-G08). Esgotado ⇒ indisponível. */
export const GUARD_RESPONSE_TIMEOUT_MS = 3_000;
/** Relógio do prazo: `start` agenda o esgotamento e devolve o cancelamento. Injetável só em teste. */
export interface GuardTimer {
  start(ms: number, onTimeout: () => void): () => void;
}
export const PROCESS_GUARD_TIMER: GuardTimer = {
  start(ms, onTimeout) {
    const handle = setTimeout(onTimeout, ms);
    handle.unref?.(); // o prazo nunca segura o processo vivo sozinho
    return () => clearTimeout(handle);
  },
};

const headSchema = z.object({ ledgerSeq: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
/** Respostas aceitas da porta (fronteira de confiança: o adaptador fala com um terceiro). Fora disso ⇒ indisponível. */
const latestSchema = z.union([z.object({ ok: z.literal(true), head: headSchema.nullable() }).strict(), z.object({ ok: z.literal(false) }).strict()]);
const publishSchema = z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), reason: z.enum(['CONFLICT', 'STALE', 'UNAVAILABLE']) }).strict()]);
const LATEST_UNAVAILABLE: GuardLatestResult = { ok: false };
const PUBLISH_UNAVAILABLE: GuardPublishResult = { ok: false, reason: 'UNAVAILABLE' };

/** Uma chamada à guarda com prazo: resposta válida antes do prazo ⇒ ela; erro (síncrono ou não), prazo esgotado ou resposta fora do esquema ⇒ `fallback`. Nunca lança. */
function bounded<T>(call: () => Promise<unknown>, schema: z.ZodType<T>, fallback: T, timer: GuardTimer): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let cancel: () => void = () => undefined;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(value);
    };
    cancel = timer.start(GUARD_RESPONSE_TIMEOUT_MS, () => finish(fallback));
    if (settled) cancel(); // timer que esgota de forma síncrona: o cancelamento chegou depois
    let pending: Promise<unknown>;
    try {
      pending = call();
    } catch {
      finish(fallback);
      return;
    }
    Promise.resolve(pending).then(
      (raw) => {
        const parsed = schema.safeParse(raw);
        finish(parsed.success ? parsed.data : fallback);
      },
      () => finish(fallback),
    );
  });
}

/**
 * A porta COM o prazo de resposta e a validação de cada resposta (regra 5 e GE-E1): o serviço do livro sempre fala com a guarda por aqui. Esgotado o prazo, com erro ou com
 * resposta fora do esquema: `latest` ⇒ `{ ok: false }` (nunca "nenhuma cabeça") e `publish` ⇒ `UNAVAILABLE`.
 */
export function boundGuard(port: ExternalGuardPort, timer: GuardTimer = PROCESS_GUARD_TIMER): ExternalGuardPort {
  return {
    publish: (record) => bounded<GuardPublishResult>(() => port.publish(record), publishSchema, PUBLISH_UNAVAILABLE, timer),
    latest: (auditId) => bounded<GuardLatestResult>(() => port.latest(auditId), latestSchema, LATEST_UNAVAILABLE, timer),
  };
}

/* ------------------------------------------------------------------ adaptador sintético */

const GUARD_FILE = /^g(\d{6})-([0-9a-f]{64})\.json$/;
const seqName = (ledgerSeq: number): string => `g${String(ledgerSeq).padStart(6, '0')}`;
type GuardRecord = Parameters<ExternalGuardPort['publish']>[0];

/**
 * ADAPTADOR SINTÉTICO — SOMENTE TESTES E DESENVOLVIMENTO. Simula uma testemunha imutável com arquivos de criação exclusiva em uma pasta que
 * os testes tratam como OUTRO domínio de falha (o atacante modelado não a alcança). NÃO é proteção de produção. Segue a regra 7 exata; a decisão é
 * serializada por auditoria DENTRO do processo (entre processos, duas posições novas podem entrar fora de ordem: o provedor real decide atomicamente).
 */
export function createSyntheticGuard(options: { readonly dir: string; readonly fs?: FsOps }): ExternalGuardPort {
  const ops = options.fs ?? nodeFsOps;
  const queues = new Map<string, Promise<unknown>>();
  /** Fila por auditoria: cada publicação decide sobre o que as anteriores deixaram (atomicidade por auditoria, no processo). */
  const serialized = <T>(auditId: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(auditId) ?? Promise.resolve()).then(work, work);
    queues.set(auditId, run.catch(() => undefined));
    return run;
  };
  async function decide(record: GuardRecord): Promise<GuardPublishResult> {
    if ((await dirStatus(ops, options.dir)) !== 'EXISTS') return PUBLISH_UNAVAILABLE;
    const dir = path.join(options.dir, record.auditId);
    if (await ensureDirectory(ops, dir, 'guarda')) return PUBLISH_UNAVAILABLE;
    const name = `${seqName(record.ledgerSeq)}-${record.sha256}.json`;
    const published = (await ops.readdir(dir)).flatMap((file) => {
      const match = GUARD_FILE.exec(file);
      return match ? [{ ledgerSeq: Number(match[1]), file }] : [];
    });
    const atSeq = published.filter((entry) => entry.ledgerSeq === record.ledgerSeq);
    if (atSeq.length > 0) return atSeq.length === 1 && atSeq[0]?.file === name ? { ok: true } : { ok: false, reason: 'CONFLICT' };
    const highest = published.reduce((max, entry) => Math.max(max, entry.ledgerSeq), 0);
    if (record.ledgerSeq < highest) return { ok: false, reason: 'STALE' };
    const written = await publishExclusive(atomicOnly(ops), { dir, finalPath: path.join(dir, name), tempPath: path.join(dir, `.tmp-${name}`), data: `${JSON.stringify(record)}\n`, label: name });
    return written.ok ? { ok: true } : PUBLISH_UNAVAILABLE;
  }
  return {
    async publish(record) {
      if (!LEDGER_AUDIT_ID_PATTERN.test(record.auditId) || !/^[0-9a-f]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.ledgerSeq) || record.ledgerSeq < 1) return PUBLISH_UNAVAILABLE;
      try {
        return await serialized(record.auditId, () => decide(record));
      } catch {
        return PUBLISH_UNAVAILABLE;
      }
    },
    async latest(auditId) {
      try {
        if (!LEDGER_AUDIT_ID_PATTERN.test(auditId)) return LATEST_UNAVAILABLE;
        if ((await dirStatus(ops, options.dir)) !== 'EXISTS') return LATEST_UNAVAILABLE;
        const dir = path.join(options.dir, auditId);
        const status = await dirStatus(ops, dir);
        if (status === 'MISSING') return { ok: true, head: null };
        if (status !== 'EXISTS') return LATEST_UNAVAILABLE;
        let best: LedgerHead | null = null;
        for (const name of await ops.readdir(dir)) {
          const match = GUARD_FILE.exec(name);
          if (!match) continue;
          const ledgerSeq = Number(match[1]);
          if (best === null || ledgerSeq > best.ledgerSeq) best = { ledgerSeq, sha256: match[2] as string };
        }
        return { ok: true, head: best };
      } catch {
        return LATEST_UNAVAILABLE;
      }
    },
  };
}
