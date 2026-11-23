import type { ChannelEnvironment } from '../link-audit-seals-channel/paths';

/*
 * P9.3a — gramática FECHADA do comando do receptor de deploy (`SSH_ORIGINAL_COMMAND`, spec §5.6). ASCII visível, até 512 bytes, um espaço entre
 * campos; qualquer outra coisa é `E_COMMAND`, e nada é lido do stdin:
 *   upload <sha40> <bundle-sha256> <bytes>
 *   deploy <sha40> <bundle-sha256> <stack-sha256> <overlay-sha256|-> <trust-sha256> <supabase-fp12>
 * Em produção o `overlay` tem de ser `-`; em homologação, um hash. Puro.
 */

export type DeployEnvironment = ChannelEnvironment;

export const MAX_COMMAND_BYTES = 512;
/** 3 GiB: o teto do pacote (o mesmo do job, `GMN_CI_BUNDLE_MAX_BYTES` em `deploy/ci/lib.sh`). */
export const MAX_BUNDLE_BYTES = 3 * 1024 * 1024 * 1024;
const FIRST_VISIBLE_ASCII = 0x20;
const LAST_VISIBLE_ASCII = 0x7e;
const UPLOAD = /^upload ([0-9a-f]{40}) ([0-9a-f]{64}) ([1-9][0-9]{0,9})$/;
const DEPLOY = /^deploy ([0-9a-f]{40}) ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64}|-) ([0-9a-f]{64}) ([0-9a-f]{12})$/;

export interface UploadCommand {
  readonly verb: 'upload';
  readonly sha40: string;
  readonly bundleSha256: string;
  readonly bytes: number;
}
export interface DeployCommand {
  readonly verb: 'deploy';
  readonly sha40: string;
  readonly bundleSha256: string;
  readonly stackSha256: string;
  /** `null` em produção (o campo é `-`). */
  readonly overlaySha256: string | null;
  readonly trustSha256: string;
  readonly supabaseFp12: string;
}
export type ReceiverCommand = UploadCommand | DeployCommand;

const isVisibleAscii = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < FIRST_VISIBLE_ASCII || code > LAST_VISIBLE_ASCII) return false;
  }
  return true;
};

function parseUpload(command: string): UploadCommand | null {
  const match = UPLOAD.exec(command);
  if (!match) return null;
  const bytes = Number(match[3]);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BUNDLE_BYTES) return null;
  return { verb: 'upload', sha40: match[1] as string, bundleSha256: match[2] as string, bytes };
}

function parseDeploy(command: string, env: DeployEnvironment): DeployCommand | null {
  const match = DEPLOY.exec(command);
  if (!match) return null;
  const overlay = match[4] as string;
  // produção nunca usa sobreposição; homologação sempre (§5.6, §5.11)
  if ((env === 'producao') !== (overlay === '-')) return null;
  return {
    verb: 'deploy',
    sha40: match[1] as string,
    bundleSha256: match[2] as string,
    stackSha256: match[3] as string,
    overlaySha256: overlay === '-' ? null : overlay,
    trustSha256: match[5] as string,
    supabaseFp12: match[6] as string,
  };
}

/** O comando, ou `null` (= `E_COMMAND`). Ausente, vazio, acima de 512 bytes, fora do ASCII visível ou fora da gramática ⇒ `null`. */
export function parseReceiverCommand(raw: string | undefined, env: DeployEnvironment): ReceiverCommand | null {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_COMMAND_BYTES || !isVisibleAscii(raw)) return null;
  if (raw.startsWith('upload ')) return parseUpload(raw);
  if (raw.startsWith('deploy ')) return parseDeploy(raw, env);
  return null;
}
