import fs from 'node:fs';
import path from 'node:path';

/*
 * Autorizações de consumo já usadas (Onda 4B). Cada autorização vale para UMA coleta: o marcador é criado de
 * forma EXCLUSIVA (`wx`) ANTES da chamada, então uma queda ou um novo comando não permite repetir o gasto.
 * O marcador guarda só id, operador, auditoria e limites: nenhum dado da empresa.
 */

const AUTH_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface UsedAuthorizationRecord {
  readonly authorizationId: string;
  readonly operator: string;
  readonly snapshotId: string;
  readonly maxMapsCalls: number;
  readonly markedAt: string;
  /** Impressão dos identificadores da empresa (sem dados dela): impede nova autorização para a mesma empresa. */
  readonly companyFingerprint?: string;
}

export interface UsedAuthorizationStore {
  isUsed(authorizationId: string): boolean;
  /** Alguma autorização para esta empresa foi usada desde `sinceIso`? Falha fechada: erro ⇒ true. */
  companyUsedSince(fingerprint: string, sinceIso: string): boolean;
  /** Marca como usada de forma exclusiva. `ok:false` se já estava usada ou se não foi possível gravar. */
  markUsed(record: UsedAuthorizationRecord): { readonly ok: true } | { readonly ok: false; readonly reason: string };
}

export function createMemoryUsedStore(initial: readonly string[] = []): UsedAuthorizationStore {
  const used = new Set(initial);
  const records: UsedAuthorizationRecord[] = [];
  return {
    isUsed: (id) => used.has(id),
    companyUsedSince: (fingerprint, sinceIso) => records.some((r) => r.companyFingerprint === fingerprint && r.markedAt >= sinceIso),
    markUsed(record) {
      if (used.has(record.authorizationId)) return { ok: false, reason: 'autorização já usada' };
      used.add(record.authorizationId);
      records.push(record);
      return { ok: true };
    },
  };
}

/** Marcadores em `<dir>/<id>.json`, criados com `wx`. Falha fechada: qualquer erro ⇒ "usada". */
export function createFileUsedStore(dir: string): UsedAuthorizationStore {
  const fileFor = (id: string): string | null => {
    if (!AUTH_ID.test(id)) return null;
    const root = path.resolve(dir);
    const file = path.join(root, `${id}.json`);
    return file.startsWith(root + path.sep) ? file : null;
  };
  return {
    isUsed(id) {
      const file = fileFor(id);
      if (!file) return true; // id inválido: nunca autoriza
      try {
        return fs.existsSync(file);
      } catch {
        return true;
      }
    },
    companyUsedSince(fingerprint, sinceIso) {
      try {
        const root = path.resolve(dir);
        if (!fs.existsSync(root)) return false;
        for (const name of fs.readdirSync(root)) {
          if (!name.endsWith('.json')) continue;
          const parsed = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as Partial<UsedAuthorizationRecord>;
          if (parsed.companyFingerprint === fingerprint && typeof parsed.markedAt === 'string' && parsed.markedAt >= sinceIso) return true;
        }
        return false;
      } catch {
        return true;
      }
    },
    markUsed(record) {
      const file = fileFor(record.authorizationId);
      if (!file) return { ok: false, reason: 'identificador de autorização inválido' };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'autorização já usada' : 'não foi possível registrar o uso da autorização' };
      }
    },
  };
}

/** Pasta padrão dos marcadores (privada, fora de `public/`, ignorada pelo git). */
export function defaultUsedAuthorizationDirectory(projectRoot: string): string {
  return path.join(projectRoot, '.data', 'link-audit-live');
}
