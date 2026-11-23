import type { EvidenceSealFileV2, KeyRetirementClosureFile } from '../link-audit-evidence/provenance-core';
import { judgeClosure, judgeSeal, readCap } from '../link-audit-seals-channel/files';
import type { ChannelEnvironment, ChannelPath } from '../link-audit-seals-channel/paths';
import { SealReceiverError } from './codes';
import type { SealTarget } from './grammar';

/*
 * P9.3b — passo 3 do `put` (spec §5.7): formato estrito, bytes canônicos e nome coerente, pelas MESMAS regras por arquivo do job `seals` (S-06 a
 * S-08, `judgeSeal`/`judgeClosure` da P9.2), sem reimplementar: manifesto só `v2` pela porta de texto estrita (UTF-8, sem BOM, sem `\`, sem chave
 * repetida), bytes = forma canônica do `sign`, `auditId`/`seq` = caminho; fecho pelo esquema estrito, forma canônica do `close-key` e
 * `retiredKeyId` = nome. Qualquer recusa ⇒ `E_FORMAT`. O texto devolvido é exatamente os bytes recebidos (o que a verificação julga é o que se grava).
 */

type SealChannel = Extract<ChannelPath, { readonly kind: 'seal' }>;
type ClosureChannel = Extract<ChannelPath, { readonly kind: 'closure' }>;

export type Candidate =
  | { readonly kind: 'seal'; readonly seal: EvidenceSealFileV2; readonly bytes: Uint8Array; readonly text: string; readonly sha256: string }
  | { readonly kind: 'closure'; readonly closure: KeyRetirementClosureFile; readonly bytes: Uint8Array; readonly text: string; readonly sha256: string };

const channelOf = (target: SealTarget, env: ChannelEnvironment): SealChannel | ClosureChannel =>
  target.kind === 'seal' ? { kind: 'seal', env, auditId: target.auditId, seq: target.seq } : { kind: 'closure', env, keyId: target.keyId };

/** O teto de bytes do stdin para o alvo (o do S-05: 256 KiB para manifesto e fecho). */
export const inputCapOf = (target: SealTarget, env: ChannelEnvironment): number => readCap(channelOf(target, env));

/** O texto exato dos bytes; se a decodificação UTF-8 não volta aos MESMOS bytes, recusa (nunca se grava outra coisa que a verificada). */
function exactText(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) throw new SealReceiverError('E_FORMAT', null, 'bytes are not exact UTF-8');
  return text;
}

/** Os bytes do stdin julgados pelas regras S-06 a S-08 do canal para o `relpath` pedido. */
export function judgeCandidate(target: SealTarget, env: ChannelEnvironment, bytes: Uint8Array, sha256: string): Candidate {
  const common = { repoPath: target.relpath, publicPath: target.relpath, bytes, bytesSha256: sha256 };
  const channel = channelOf(target, env);
  if (channel.kind === 'seal') {
    const judged = judgeSeal({ ...common, channel });
    if (!judged.ok) throw new SealReceiverError('E_FORMAT', null, `${judged.refusal.rule} ${judged.refusal.code}`);
    return { kind: 'seal', seal: judged.seal, bytes, text: exactText(bytes), sha256 };
  }
  const judged = judgeClosure({ ...common, channel });
  if (!judged.ok) throw new SealReceiverError('E_FORMAT', null, `${judged.refusal.rule} ${judged.refusal.code}`);
  return { kind: 'closure', closure: judged.closure, bytes, text: exactText(bytes), sha256 };
}
