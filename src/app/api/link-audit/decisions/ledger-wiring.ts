import path from 'node:path';
import type { LedgerPort } from '@/lib/link-audit-decisions';
import { createLedgerService, createUnconfiguredLedger, guardAlarmLogEntry, ledgerConfigFromProcess, postgresGuardFor, type GuardAlarmSink } from '@/lib/link-audit-ledger';
import { StructuredLogger } from '@/lib/logger';

/**
 * LIVRO DE CABEÇAS das rotas (Q2/Q3): pasta própria (`GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR`) e chave EXCLUSIVA do livro. Pasta ou chave ausente, fraca,
 * contraditória ou igual à de origem ⇒ o livro é `NOT_CONFIGURED` e NENHUMA decisão é gravada (falha fechada).
 * GUARDA EXTERNA (G1.b.2a, GE-E2): com a configuração da guarda completa e válida (lida SÓ pelo módulo do livro), o livro nasce com a guarda real
 * (adaptador Postgres sobre TLS verificado; o serviço a usa sempre pelo prazo e pela validação de `boundGuard`). Sem nenhuma variável da guarda, o estado
 * continua `externalGuard: NOT_CONFIGURED` e nada afirma proteção contra rollback coordenado (não passa no portão G-1). Configuração PARCIAL ou
 * INVÁLIDA ⇒ o livro inteiro fica `NOT_CONFIGURED`, com o código do motivo nas pendências (nunca o valor).
 * As rotas nunca recebem o ambiente inteiro: elas só leem as duas pastas abaixo; as CHAVES e a credencial da guarda são lidas pelo módulo do livro.
 */
const pick = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  return value && !value.includes('\0') && path.isAbsolute(value) ? path.resolve(value) : null;
};
export const ledgerDirOf = (): string | null => pick(process.env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR);
export const sealsDirOf = (): string | null => pick(process.env.GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR);

const guardLog = new StructuredLogger('SYSTEM');
/**
 * GE-E6: os alarmes da guarda vão ao log estruturado no envelope da spec de observabilidade (§5.2): `message` = nome do evento, só enums e inteiros.
 * Nunca lança (o serviço também protege a chamada): o alarme nunca muda o desfecho do protocolo (regra de ouro da observabilidade, §11.1).
 */
export const GUARD_ALARMS_TO_LOG: GuardAlarmSink = Object.freeze<GuardAlarmSink>({
  emit(alarm) {
    try {
      const entry = guardAlarmLogEntry(alarm);
      if (entry.level === 'ERROR') guardLog.error(entry.event, { ...entry.metadata });
      else guardLog.warn(entry.event, { ...entry.metadata });
    } catch {
      // falha do próprio log (serialização, console): engolida de propósito — não há outro canal e o protocolo segue igual (observabilidade §11.1)
    }
  },
});

export function ledgerForRoutes(otherDirs: ReadonlyArray<string | null | undefined>): LedgerPort {
  const config = ledgerConfigFromProcess(() => new Date());
  if (!config.ok) {
    const detail = config.code === 'LEDGER_GUARD_CONFIG_INVALID' ? [`guarda externa: configuração recusada (${config.guardCode}); com a guarda pedida, o livro não grava sem ela.`] : [];
    return createUnconfiguredLedger(detail);
  }
  return createLedgerService({
    dir: config.dir,
    authenticator: config.authenticator,
    otherDirs: [...otherDirs, sealsDirOf()],
    guardAlarms: GUARD_ALARMS_TO_LOG,
    ...(config.guard ? { guard: postgresGuardFor(config.guard) } : {}),
  });
}
