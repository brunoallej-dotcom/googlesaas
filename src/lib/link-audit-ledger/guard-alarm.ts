/*
 * ALARMES DA GUARDA EXTERNA (GE-E6, parte pura; spec `link-audit-production-gates.md` §5.1.4 regras 3, 4, 5 e 7, §5.1.7 e §9). Porta INJETÁVEL do domínio do livro:
 * o serviço emite eventos TIPADOS, com campos fechados — só enums e inteiros (posições do livro, atraso, idade). Nunca `auditId` em claro (D-G0-5: ele pode nascer do nome
 * da empresa), e-mail, caminho, hash ou texto livre. A ligação ao logger com o envelope da spec de observabilidade (§5.2) é da G1.b.2a (`guardAlarmLogEntry` aqui,
 * o destino em `ledger-wiring.ts`); o evento não leva referência da auditoria (nem o `audit_ref`): a tela mostra qual auditoria está congelada.
 */

/** Os nove pontos em que o retorno da publicação era ignorado depois de um registro já gravado (§5.1.2, tabela S1–S9). */
export type GuardPublishPoint = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9';
/** Por que a publicação de melhor esforço falhou: guarda indisponível, conflito na posição ou `STALE` que a cabeça maior da guarda NÃO cobre (regra 7). */
export type GuardPublishCause = 'UNAVAILABLE' | 'CONFLICT' | 'STALE_UNCOVERED';

export type GuardAlarm =
  /** Regra 5: `latest` (leitura) ou uma publicação obrigatória sem resposta válida dentro do prazo. */
  | { readonly kind: 'GUARD_UNAVAILABLE'; readonly call: 'LATEST' | 'PUBLISH' }
  /** A guarda guarda uma cabeça que o livro não contém (retrocesso ou sequência falsa); também o `STALE` não coberto de uma publicação obrigatória. */
  | { readonly kind: 'GUARD_MISMATCH' }
  /** Regra 2: nenhuma cabeça publicada e o livro com ≥ 2 registros. */
  | { readonly kind: 'GUARD_HEAD_MISSING'; readonly ledgerSeq: number }
  /** Regra 3: atraso acima de `L_max`. */
  | { readonly kind: 'GUARD_LAGGING'; readonly lag: number; readonly maxLag: number }
  /** §5.1.7: `BEHIND` (dentro de `L_max`) há mais de `T` desde o primeiro registro ainda não publicado. */
  | { readonly kind: 'GUARD_BEHIND_PROLONGED'; readonly lag: number; readonly ageMs: number }
  /** Regra 4: a publicação de melhor esforço falhou depois do registro `ledgerSeq`, no ponto `point`. */
  | { readonly kind: 'GUARD_PUBLISH_FAILED_AFTER_RECORD'; readonly point: GuardPublishPoint; readonly cause: GuardPublishCause; readonly ledgerSeq: number }
  /** Regra 7: `CONFLICT` sempre gera alarme (outro `sha256` na mesma posição). */
  | { readonly kind: 'GUARD_CONFLICT'; readonly ledgerSeq: number };

/** Porta dos alarmes. `emit` NÃO deve lançar; se lançar, o serviço segue (o alarme nunca muda o desfecho do protocolo). */
export interface GuardAlarmSink {
  emit(alarm: GuardAlarm): void;
}
/** Padrão: nenhum destino (as rotas ligam o logger, G1.b.2a: `ledger-wiring.ts`). */
export const NO_GUARD_ALARMS: GuardAlarmSink = Object.freeze({ emit: () => undefined });

/** Um alarme no ENVELOPE da spec de observabilidade (§5.2): `event` vai em `message`, `metadata` só com enums e inteiros, nível pela gravidade. */
export interface GuardAlarmLogEntry {
  readonly level: 'WARN' | 'ERROR';
  readonly event: string;
  readonly metadata: Readonly<Record<string, string | number>>;
}
const MS_PER_SECOND = 1_000;

/**
 * GE-E6 (G1.b.2a): o evento de log de cada alarme. Puro e fechado: nenhum campo além dos do alarme (nunca `auditId`, e-mail, caminho ou hash). `ERROR`
 * para o que congela a auditoria ou indica adulteração (indisponível, MISMATCH, cabeça ausente, atraso além de `L_max`, CONFLICT); `WARN` para o que a
 * próxima publicação obrigatória ainda resolve (atraso prolongado dentro de `L_max`, falha de publicação depois do registro).
 */
export function guardAlarmLogEntry(alarm: GuardAlarm): GuardAlarmLogEntry {
  switch (alarm.kind) {
    case 'GUARD_UNAVAILABLE':
      return { level: 'ERROR', event: 'link_audit.guard.unavailable', metadata: { code: alarm.kind, call: alarm.call } };
    case 'GUARD_MISMATCH':
      return { level: 'ERROR', event: 'link_audit.guard.mismatch', metadata: { code: alarm.kind } };
    case 'GUARD_HEAD_MISSING':
      return { level: 'ERROR', event: 'link_audit.guard.head_missing', metadata: { code: alarm.kind, seq: alarm.ledgerSeq } };
    case 'GUARD_LAGGING':
      return { level: 'ERROR', event: 'link_audit.guard.lagging', metadata: { code: alarm.kind, lag: alarm.lag, maxLag: alarm.maxLag } };
    case 'GUARD_BEHIND_PROLONGED':
      return { level: 'WARN', event: 'link_audit.guard.behind_prolonged', metadata: { code: alarm.kind, lag: alarm.lag, ageSeconds: Math.floor(alarm.ageMs / MS_PER_SECOND) } };
    case 'GUARD_PUBLISH_FAILED_AFTER_RECORD':
      return { level: 'WARN', event: 'link_audit.guard.publish_failed_after_record', metadata: { code: alarm.kind, point: alarm.point, cause: alarm.cause, seq: alarm.ledgerSeq } };
    case 'GUARD_CONFLICT':
      return { level: 'ERROR', event: 'link_audit.guard.conflict', metadata: { code: alarm.kind, seq: alarm.ledgerSeq } };
  }
}
