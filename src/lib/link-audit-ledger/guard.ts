import path from 'node:path';
import { atomicOnly, dirStatus, ensureDirectory } from '../link-audit-storage';
import { nodeFsOps, publishExclusive, type FsOps } from '../link-audit/snapshot-store';
import { LEDGER_AUDIT_ID_PATTERN, type LedgerHead } from './types';

/*
 * GUARDA EXTERNA (Q6, 01/11/2026): testemunha IMUTÁVEL da cabeça do livro, em domínio de falha SEPARADO da VPS. É a única defesa contra o
 * retrocesso coordenado de todos os volumes e contra quem escreve em ≥ 2 pastas incluindo o livro. É REQUISITO DE PRODUÇÃO e AINDA NÃO EXISTE:
 * esta etapa define a PORTA e um adaptador SINTÉTICO, só para testes locais. Nenhum provedor externo é conectado; sem guarda configurada
 * o estado é `NOT_CONFIGURED` e nada afirma proteção contra rollback coordenado.
 */
export interface ExternalGuardPort {
  /** Publica a cabeça (idempotente para o mesmo par; par diferente na mesma posição ⇒ falha). */
  publish(record: { readonly auditId: string; readonly ledgerSeq: number; readonly sha256: string }): Promise<{ readonly ok: boolean }>;
  /** Maior cabeça publicada para a auditoria (`head: null` = nenhuma). `ok:false` = indisponível (nunca "nenhuma"). */
  latest(auditId: string): Promise<{ readonly ok: true; readonly head: LedgerHead | null } | { readonly ok: false }>;
}

const GUARD_FILE = /^g(\d{6})-([0-9a-f]{64})\.json$/;

/**
 * ADAPTADOR SINTÉTICO — SOMENTE TESTES E DESENVOLVIMENTO. Simula uma testemunha imutável com arquivos de criação exclusiva em uma pasta que
 * os testes tratam como OUTRO domínio de falha (o atacante modelado não a alcança). NÃO é proteção de produção.
 */
export function createSyntheticGuard(options: { readonly dir: string; readonly fs?: FsOps }): ExternalGuardPort {
  const ops = options.fs ?? nodeFsOps;
  return {
    async publish(record) {
      try {
        if (!LEDGER_AUDIT_ID_PATTERN.test(record.auditId) || !/^[0-9a-f]{64}$/.test(record.sha256)) return { ok: false };
        if ((await dirStatus(ops, options.dir)) !== 'EXISTS') return { ok: false };
        const dir = path.join(options.dir, record.auditId);
        if (await ensureDirectory(ops, dir, 'guarda')) return { ok: false };
        const name = `g${String(record.ledgerSeq).padStart(6, '0')}-${record.sha256}.json`;
        const existing = (await ops.readdir(dir)).filter((file) => file.startsWith(`g${String(record.ledgerSeq).padStart(6, '0')}-`));
        if (existing.length > 0) return { ok: existing.length === 1 && existing[0] === name };
        const published = await publishExclusive(atomicOnly(ops), { dir, finalPath: path.join(dir, name), tempPath: path.join(dir, `.tmp-${name}`), data: `${JSON.stringify(record)}\n`, label: name });
        return { ok: published.ok };
      } catch {
        return { ok: false };
      }
    },
    async latest(auditId) {
      try {
        if (!LEDGER_AUDIT_ID_PATTERN.test(auditId)) return { ok: false };
        if ((await dirStatus(ops, options.dir)) !== 'EXISTS') return { ok: false };
        const dir = path.join(options.dir, auditId);
        const status = await dirStatus(ops, dir);
        if (status === 'MISSING') return { ok: true, head: null };
        if (status !== 'EXISTS') return { ok: false };
        let best: LedgerHead | null = null;
        for (const name of await ops.readdir(dir)) {
          const match = GUARD_FILE.exec(name);
          if (!match) continue;
          const ledgerSeq = Number(match[1]);
          if (best === null || ledgerSeq > best.ledgerSeq) best = { ledgerSeq, sha256: match[2] as string };
        }
        return { ok: true, head: best };
      } catch {
        return { ok: false };
      }
    },
  };
}
