import { createHash } from 'node:crypto';

/*
 * P9.3a (revisão do PR #70) — impressão do projeto Supabase (spec §5.6 passo 5): os 12 primeiros hex do sha256 da ORIGEM CANÔNICA
 * `https://<host em minúsculas>`. É a MESMA regra de `deploy/hostinger/supabase-fp12.sh`, que o job (`deploy/ci/receiver-call.sh`) e o
 * responsável (runbook H-04, a impressão de produção do `--forbid-supabase`) usam; um teste confere as duas sobre os mesmos casos.
 * Aceito: `https://` + host DNS (rótulos de 1 a 63 caracteres em letras, dígitos e hífen, pelo menos dois) + `:443` opcional + `/` opcional.
 * Qualquer outra coisa (http, usuário ou senha, outra porta, caminho, consulta, fragmento, espaço) ⇒ `null`. Puro.
 */

const RAW_ORIGIN = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?\/?$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const FP12_LENGTH = 12;

/** A origem canônica, ou `null` fora da regra. O `URL` do Node confere de novo (sem usuário, porta, caminho, consulta nem fragmento). */
export function canonicalSupabaseOrigin(raw: string): string | null {
  const match = RAW_ORIGIN.exec(raw);
  if (!match) return null;
  const host = (match[1] as string).toLowerCase();
  if (!HOST.test(host)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const clean = parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.port === '' && parsed.pathname === '/' && parsed.search === '' && parsed.hash === '' && parsed.hostname === host;
  return clean ? `https://${host}` : null;
}

/** Os 12 hex da origem canônica, ou `null` fora da regra. */
export function supabaseFp12(raw: string): string | null {
  const origin = canonicalSupabaseOrigin(raw);
  return origin === null ? null : createHash('sha256').update(origin, 'utf8').digest('hex').slice(0, FP12_LENGTH);
}
