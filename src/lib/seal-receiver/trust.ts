import { createHash } from 'node:crypto';
import { errorCode, type BytesFsOps } from '../link-audit/fs-ops';
import type { ChannelEnvironment } from '../link-audit-seals-channel/paths';
import { MAX_TRUST_LIST_BYTES, parseTrustListFile, trustListEnvironmentViolations } from '../link-audit-seals-channel/trust-list';
import { SealReceiverError } from './codes';

/*
 * P9.3b — passo 2 do `put` (spec §5.3 e §5.7): a lista de confiança INSTALADA pelo receptor de deploy (`--trust-list`, `<estado>/trust-keys.txt`),
 * lida UMA vez por um único descritor (sem seguir link, sem travar em FIFO, tipo e tamanho no descritor, teto de 8 KiB): o hash, o formato, a regra
 * de ambiente e a verificação v2 usam os MESMOS bytes, e uma troca atômica (`rename`) do arquivo no meio nunca entrega um arquivo parcial. A
 * pendente (`trust-keys.pending`) nunca é lida: o modelo de permissões só concede a leitura do caminho da instalada. Com o módulo da lista da P9.2
 * (`parseTrustListFile`, `trustListEnvironmentViolations`), sem reimplementar:
 *  - ausente ou com outro sha256 ⇒ `E_TRUST_LIST_MISMATCH` (normalmente: falta o deploy da lista nova);
 *  - link, não regular, ilegível, acima do teto, fora do formato, recusada pelo `parseTrustKeyring` ou fora da regra de ambiente ⇒
 *    `E_TRUST_LIST_INVALID`.
 */

export interface InstalledTrustList {
  readonly sha256: string;
  /** O valor no formato da variável (linhas juntadas por `,`; '' = política fechada), para o verificador v2. */
  readonly value: string;
  readonly items: number;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function readListBytes(file: string, fs: BytesFsOps): Promise<Uint8Array> {
  try {
    return Uint8Array.from(await fs.readFileBytes(file, MAX_TRUST_LIST_BYTES));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new SealReceiverError('E_TRUST_LIST_MISMATCH', null, 'installed trust list absent');
    throw new SealReceiverError('E_TRUST_LIST_INVALID', null, `installed trust list unreadable (${code})`);
  }
}

/** A lista instalada conferida contra o hash declarado no `put`, o formato e a regra de ambiente. */
export async function readInstalledTrustList(file: string, declaredSha256: string, env: ChannelEnvironment, fs: BytesFsOps): Promise<InstalledTrustList> {
  const bytes = await readListBytes(file, fs);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== declaredSha256) throw new SealReceiverError('E_TRUST_LIST_MISMATCH', null, 'installed trust list sha256 differs from the declared one');
  const parsed = parseTrustListFile(bytes);
  if (!parsed.ok) throw new SealReceiverError('E_TRUST_LIST_INVALID', null, `installed trust list ${parsed.issue}`);
  const offEnvironment = trustListEnvironmentViolations(env, parsed.items);
  if (offEnvironment.length > 0) throw new SealReceiverError('E_TRUST_LIST_INVALID', null, `installed trust list ENV_PREFIX ${offEnvironment.join(' ')}`);
  return { sha256, value: parsed.value, items: parsed.items.length };
}
