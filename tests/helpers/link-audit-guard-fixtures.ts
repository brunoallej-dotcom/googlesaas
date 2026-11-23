import fs from 'node:fs';
import type { ExternalGuardPort, GuardAlarm, GuardAlarmSink, GuardTimer } from '../../src/lib/link-audit-ledger';
import { nodeFsOps, type FsOps } from '../../src/lib/link-audit/snapshot-store';
import { ledgerAuth, LEDGER_KEY_A, LEDGER_KEY_B } from './link-audit-ledger-fixtures';
import { testKeySpec } from './link-audit-origin-fixtures';

/*
 * G1.b.1 — contrato da guarda externa independente de provedor (spec `link-audit-production-gates.md` §5.1.4). Guardas CONTROLÁVEIS sobre a sintética, registro dos
 * alarmes e timer manual do prazo de resposta. Nenhuma rede: a guarda "de dentro" é sempre a sintética (pasta local), e os e-mails são fictícios `@empresa.com`.
 */

/** Guarda sobre outra (a sintética): publicações com `ledgerSeq >= failFrom` são recusadas como `UNAVAILABLE`; `latest` lê sempre a de dentro. `before` roda antes de cada publicação. */
export function controlledGuard(inner: ExternalGuardPort) {
  const state = { failFrom: Number.POSITIVE_INFINITY, published: [] as number[], before: null as null | ((record: { auditId: string; ledgerSeq: number; sha256: string }) => Promise<void>) };
  const port: ExternalGuardPort = {
    latest: (auditId) => inner.latest(auditId),
    async publish(record) {
      state.published.push(record.ledgerSeq);
      if (state.before) await state.before(record);
      if (record.ledgerSeq >= state.failFrom) return { ok: false, reason: 'UNAVAILABLE' };
      return inner.publish(record);
    },
  };
  return {
    port,
    state,
    /** A partir de `from` (inclusive), toda publicação falha. */
    down: (from = 1): void => {
      state.failFrom = from;
    },
    heal: (): void => {
      state.failFrom = Number.POSITIVE_INFINITY;
    },
  };
}
export type ControlledGuard = ReturnType<typeof controlledGuard>;

/** Porta de alarmes que só registra (a ligação ao logger é da G1.b.2). */
export function alarmLog(): { readonly sink: GuardAlarmSink; readonly alarms: GuardAlarm[] } {
  const alarms: GuardAlarm[] = [];
  return { alarms, sink: { emit: (alarm) => void alarms.push(alarm) } };
}
/** `GUARD_PUBLISH_FAILED_AFTER_RECORD:S8`, `GUARD_LAGGING`, … */
export const kindsOf = (alarms: readonly GuardAlarm[]): string[] => alarms.map((alarm) => (alarm.kind === 'GUARD_PUBLISH_FAILED_AFTER_RECORD' ? `${alarm.kind}:${alarm.point}` : alarm.kind));

/** Timer MANUAL do prazo de resposta: registra o prazo pedido e só dispara quando o teste mandar. */
export function manualTimer(): GuardTimer & { readonly asked: number[]; fire(): void; readonly active: () => number } {
  const pending = new Set<() => void>();
  const asked: number[] = [];
  return {
    asked,
    start(ms, onTimeout) {
      asked.push(ms);
      pending.add(onTimeout);
      return () => void pending.delete(onTimeout);
    },
    fire() {
      for (const callback of [...pending]) {
        pending.delete(callback);
        callback();
      }
    },
    active: () => pending.size,
  };
}
/** Timer que esgota o prazo na hora (toda chamada à guarda perde a corrida). */
export const EXPIRED_TIMER: GuardTimer = {
  start(_ms, onTimeout) {
    queueMicrotask(onTimeout);
    return () => undefined;
  },
};

/* ------------------------------------------------------------------ rotação da chave do livro (A ⇒ B ⇒ C) */
export const LEDGER_KEY_C = testKeySpec('lk-test-c', 'ledger-c');
const at = (iso: string) => () => new Date(iso);
/** Chave B atual, A aposentada (validade até 02/12/2026). */
export const rotatedOnce = () => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at('2026-11-03T12:00:00Z') });
/** Chave C atual, B e A aposentadas. */
export const rotatedTwice = () => ledgerAuth({ current: LEDGER_KEY_C, retired: [`${LEDGER_KEY_B}:2026-12-02`, `${LEDGER_KEY_A}:2026-12-02`], now: at('2026-11-03T12:00:00Z') });

/** `FsOps` do livro que roda `run` UMA vez, imediatamente ANTES de publicar (`link`) o arquivo que casa `match` (o gancho decide pelo conteúdo do temporário). */
export function beforeLedgerLink(match: (record: { event: string; ledgerSeq: number }, to: string) => boolean, run: () => Promise<void>): FsOps {
  let fired = false;
  return {
    ...nodeFsOps,
    async link(from, to) {
      if (!fired && /\/l\d{6}\.json$/.test(to)) {
        const record = JSON.parse(fs.readFileSync(from, 'utf8')) as { event: string; ledgerSeq: number };
        if (match(record, to)) {
          fired = true;
          await run();
        }
      }
      return nodeFsOps.link(from, to);
    },
  };
}
/** `FsOps` que roda `run` UMA vez, imediatamente DEPOIS de publicar o arquivo cujo caminho termina em `suffix`. */
export function afterLink(suffix: string, run: () => void | Promise<void>): FsOps {
  let fired = false;
  return {
    ...nodeFsOps,
    async link(from, to) {
      await nodeFsOps.link(from, to);
      if (!fired && to.endsWith(suffix)) {
        fired = true;
        await run();
      }
    },
  };
}

/** A resposta nunca diz que nada foi gravado (regra 4 da §5.1.4). */
export const saysNothingRecorded = (value: unknown): boolean => /nada (?:foi )?gravad|nothing (?:was )?record/i.test(JSON.stringify(value));
