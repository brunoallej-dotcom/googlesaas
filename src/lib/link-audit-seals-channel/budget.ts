import type { BytesFsOps } from '../link-audit/fs-ops';

/*
 * P9.2 (revisão do PR #68) — teto ÚNICO de leitura de uma execução do `seals-check` (spec §5.4, "Implementação"). Toda leitura do checkout
 * passa pela porta embrulhada aqui: os arquivos novos (que o S-05 já limita a 16 MiB antes de ler), a releitura das cadeias pelo
 * verificador (S-10), as cabeças dos fechos (S-11), os fechos das fixações (S-12) e as listas do commit. Acima do teto, nada mais é lido
 * e a execução recusa (`SEALS_TOO_MANY`, detalhe `READ_BUDGET`). O veredito informativo das cadeias usa um teto à parte, que só trunca a
 * informação (nunca recusa).
 */

/** Teto de bytes lidos por execução (e, à parte, pelo veredito informativo). */
export const MAX_RUN_READ_BYTES = 64 * 1024 * 1024;
const BUDGET_ERROR_CODE = 'EBUDGET';

export interface ReadBudget {
  remaining: number;
  exhausted: boolean;
}

export const readBudget = (bytes: number = MAX_RUN_READ_BYTES): ReadBudget => ({ remaining: bytes, exhausted: false });

const budgetError = (): Error => Object.assign(new Error('teto de leitura da execução esgotado'), { code: BUDGET_ERROR_CODE });

function spend(budget: ReadBudget, bytes: number): void {
  budget.remaining -= bytes;
  if (budget.remaining < 0) {
    budget.exhausted = true;
    throw budgetError(); // os bytes lidos além do teto são descartados (no máximo um arquivo, já limitado por quem pede)
  }
}

/** A porta com as leituras contadas no teto: esgotado, toda leitura seguinte falha (falha fechada para quem lê). */
export function budgetedFs(fs: BytesFsOps, budget: ReadBudget): BytesFsOps {
  return {
    ...fs,
    readFile: async (target, maxBytes) => {
      if (budget.exhausted) throw budgetError();
      const text = await fs.readFile(target, maxBytes);
      spend(budget, Buffer.byteLength(text, 'utf8'));
      return text;
    },
    readFileBytes: async (target, maxBytes) => {
      if (budget.exhausted) throw budgetError();
      const bytes = await fs.readFileBytes(target, maxBytes);
      spend(budget, bytes.byteLength);
      return bytes;
    },
  };
}
