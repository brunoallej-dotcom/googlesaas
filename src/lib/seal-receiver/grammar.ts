/*
 * P9.3b — gramática FECHADA do comando do receptor de manifestos (`SSH_ORIGINAL_COMMAND`, spec §5.7). ASCII visível, até 256 bytes, um espaço
 * entre campos; qualquer outra coisa é `E_COMMAND`, e nada é lido do stdin:
 *   put <relpath> <sha256> <trust-sha256>
 *   relpath = aud-[0-9a-f]{16}/seal-(000[1-9]|00[1-9][0-9]|01[0-9][0-9]|02[0-4][0-9]|025[0-6])\.json | _closures/[a-z0-9][a-z0-9-]{3,31}\.json
 * Não há verbo de leitura, listagem, remoção nem troca de lista. Puro (só texto); a paridade com a gramática do canal (`classifyChannelPath`,
 * P9.2) é conferida por teste.
 */

export const MAX_COMMAND_BYTES = 256;
/** A pasta dos fechos na pasta de manifestos (o `CLOSURES_DIR` do `sign` e do verificador). */
export const CLOSURES_DIR_NAME = '_closures';
const FIRST_VISIBLE_ASCII = 0x20;
const LAST_VISIBLE_ASCII = 0x7e;
const PUT = /^put ([^ ]+) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
const SEAL_RELPATH = /^(aud-[0-9a-f]{16})\/(seal-(000[1-9]|00[1-9][0-9]|01[0-9][0-9]|02[0-4][0-9]|025[0-6])\.json)$/;
const CLOSURE_RELPATH = /^_closures\/(([a-z0-9][a-z0-9-]{3,31})\.json)$/;

/** O arquivo pedido: a subpasta da pasta de manifestos (`dirName`) e o nome final (`fileName`), sempre derivados da gramática. */
export type SealTarget =
  | { readonly kind: 'seal'; readonly relpath: string; readonly auditId: string; readonly seq: number; readonly dirName: string; readonly fileName: string }
  | { readonly kind: 'closure'; readonly relpath: string; readonly keyId: string; readonly dirName: string; readonly fileName: string };

export interface PutCommand {
  readonly verb: 'put';
  readonly target: SealTarget;
  /** sha256 declarado dos bytes do stdin. */
  readonly sha256: string;
  /** sha256 declarado da lista de confiança do commit (tem de ser o da lista INSTALADA no host). */
  readonly trustSha256: string;
}

const isVisibleAscii = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < FIRST_VISIBLE_ASCII || code > LAST_VISIBLE_ASCII) return false;
  }
  return true;
};

/** O alvo de um `relpath` da gramática, ou `null`. */
export function parseRelpath(relpath: string): SealTarget | null {
  const seal = SEAL_RELPATH.exec(relpath);
  if (seal) return { kind: 'seal', relpath, auditId: seal[1] as string, seq: Number(seal[3]), dirName: seal[1] as string, fileName: seal[2] as string };
  const closure = CLOSURE_RELPATH.exec(relpath);
  if (closure) return { kind: 'closure', relpath, keyId: closure[2] as string, dirName: CLOSURES_DIR_NAME, fileName: closure[1] as string };
  return null;
}

/** O comando, ou `null` (= `E_COMMAND`). Ausente, vazio, acima de 256 bytes, fora do ASCII visível ou fora da gramática ⇒ `null`. */
export function parseSealCommand(raw: string | undefined): PutCommand | null {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_COMMAND_BYTES || !isVisibleAscii(raw)) return null;
  const match = PUT.exec(raw);
  if (!match) return null;
  const target = parseRelpath(match[1] as string);
  return target === null ? null : { verb: 'put', target, sha256: match[2] as string, trustSha256: match[3] as string };
}
