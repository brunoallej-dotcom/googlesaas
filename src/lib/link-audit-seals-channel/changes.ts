/*
 * P9.2 — as ENTRADAS que o workflow entrega ao `seals-check` (spec §5.4, "Comando"): a lista de mudanças de
 * `git diff --name-status --no-renames -z <base> HEAD` e os modos de `git ls-tree -r -z HEAD`. Puro: só bytes. O comando não chama git.
 * Um caminho que não é UTF-8 válido nunca casa a gramática: fica com um marcador que só pode ser `unexpected` (nunca é ecoado).
 */

export type ChangeStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T';
export interface ChangeEntry {
  readonly status: ChangeStatus;
  /** Caminho do repositório (separador `/`), ou o marcador de caminho que não é UTF-8. */
  readonly path: string;
}
export type ParsedChanges = { readonly ok: true; readonly entries: readonly ChangeEntry[] } | { readonly ok: false };

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
const NUL = 0;
/** `R`/`C` trazem pontuação de semelhança (`R100`); com `--no-renames` não aparecem, mas são lidos (e recusados pelo S-01/S-02). */
const STATUS_TOKEN = /^([ACDMRT])(\d{0,3})$/;
const TWO_PATH_STATUSES: ReadonlySet<string> = new Set(['R', 'C']);
/** Prefixo em bytes do canal, para classificar um caminho que não é UTF-8 (fica dentro do canal, como `unexpected`). */
const CHANNEL_PREFIX = Buffer.from('link-audit-seals/', 'utf8');
/** Marcador de caminho não UTF-8 dentro do canal: nunca casa a gramática do §5.2. */
export const NON_UTF8_CHANNEL_PATH = 'link-audit-seals/\u0000';
const NON_UTF8_OUTSIDE = '\u0000';
const MODE = /^[0-7]{6}$/;
const OBJECT_TYPE = /^(?:blob|commit|tree)$/;
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Campos terminados em NUL (o último NUL fecha o último campo). Sem NUL final ⇒ entrada truncada. */
function nulFields(raw: Uint8Array): Uint8Array[] | null {
  if (raw.byteLength === 0) return [];
  if (raw[raw.byteLength - 1] !== NUL) return null;
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < raw.byteLength; index += 1) {
    if (raw[index] !== NUL) continue;
    fields.push(raw.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

function decodePath(field: Uint8Array): string {
  try {
    return STRICT_UTF8.decode(field);
  } catch {
    return Buffer.from(field).subarray(0, CHANNEL_PREFIX.byteLength).equals(CHANNEL_PREFIX) ? NON_UTF8_CHANNEL_PATH : NON_UTF8_OUTSIDE;
  }
}

function decodeToken(field: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(field);
  } catch {
    return null;
  }
}

/** `git diff --name-status --no-renames -z`: `<status>\0<caminho>\0` (ou dois caminhos com `R`/`C`). Qualquer outra forma ⇒ `{ok:false}`. */
export function parseNameStatus(raw: Uint8Array): ParsedChanges {
  const fields = nulFields(raw);
  if (fields === null) return { ok: false };
  const entries: ChangeEntry[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = STATUS_TOKEN.exec(decodeToken(fields[index] as Uint8Array) ?? '')?.[1] as ChangeStatus | undefined;
    const width = status !== undefined && TWO_PATH_STATUSES.has(status) ? 2 : 1;
    const paths = fields.slice(index + 1, index + 1 + width);
    if (status === undefined || paths.length !== width || paths.some((field) => field.byteLength === 0)) return { ok: false };
    for (const field of paths) entries.push({ status, path: decodePath(field) });
    index += 1 + width;
  }
  return { ok: true, entries };
}

/** `git ls-tree -r -z`: `<modo> <tipo> <objeto>\t<caminho>\0` → caminho ⇒ modo. Caminho repetido ou linha fora da forma ⇒ `null`. */
export function parseTreeModes(raw: Uint8Array): ReadonlyMap<string, string> | null {
  const fields = nulFields(raw);
  if (fields === null) return null;
  const modes = new Map<string, string>();
  for (const field of fields) {
    const tab = field.indexOf(0x09);
    const meta = tab > 0 ? decodeToken(field.subarray(0, tab)) : null;
    const [mode, type, object, extra] = (meta ?? '').split(' ');
    const pathField = field.subarray(tab + 1);
    if (meta === null || extra !== undefined || !MODE.test(mode ?? '') || !OBJECT_TYPE.test(type ?? '') || !OBJECT_NAME.test(object ?? '') || pathField.byteLength === 0) return null;
    const path = decodePath(pathField);
    if (path === NON_UTF8_CHANNEL_PATH || path === NON_UTF8_OUTSIDE) continue; // nunca casa a gramática: o S-03 recusa o caminho na lista de mudanças
    if (modes.has(path)) return null;
    modes.set(path, mode as string);
  }
  return modes;
}
