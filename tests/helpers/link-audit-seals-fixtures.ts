import fs from 'node:fs';
import path from 'node:path';
import { nodeFsOps } from '../../src/lib/link-audit/node-fs-ops';
import type { BytesFsOps } from '../../src/lib/link-audit/fs-ops';
import { parseNameStatus, parseTreeModes, type ChangeStatus } from '../../src/lib/link-audit-seals-channel/changes';
import { runSealsCheck, type SealsCheckReport } from '../../src/lib/link-audit-seals-channel/check';
import type { ChannelEnvironment } from '../../src/lib/link-audit-seals-channel/paths';
import type { BaseTrustList } from '../../src/lib/link-audit-seals-channel/trust-rules';
import { createEvidenceSealV2, createKeyRetirementClosure, sealSha256, type EvidenceSealFileV2, type KeyRetirementClosureFile } from '../../src/lib/link-audit-evidence/provenance';
import { tmpDir } from './link-audit-evidence-fixtures';
import { E1, type Entries, type TestSigner } from './link-audit-seal-close-key-fixtures';

/*
 * Fixtures da P9.2 (job `seals`, spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.2–§5.4). Dados 100% FICTÍCIOS: um "checkout" em pasta
 * temporária com `link-audit-seals/`, cadeias v2 REAIS assinadas por chaves de TESTE geradas em memória (`signer` das fixtures do `close-key`),
 * e as entradas do workflow montadas aqui no formato exato do git (`-z`). Nenhum git, rede ou chave real.
 */

export const AUD_A = 'aud-0123456789abcdef';
export const AUD_B = 'aud-fedcba9876543210';
export const AUD_C = 'aud-00000000000000c1';
const DOSSIER = { id: 'dossie-canal-0001', sha256: 'd'.repeat(64) };
const CHAIN_START = Date.parse('2026-11-18T10:00:00.000Z');
const HOUR_MS = 3_600_000;

export interface World {
  readonly root: string;
  readonly sealsDir: (env?: ChannelEnvironment) => string;
}

/** Um checkout fictício com as duas listas (vazias por padrão). */
export function world(): World {
  const root = tmpDir('p92-repo-');
  for (const env of ['producao', 'homologacao'] as const) writeRepoFile(root, `link-audit-seals/${env}/trust-keys.txt`, '');
  return { root, sealsDir: (env = 'producao') => path.join(root, 'link-audit-seals', env, 'seals') };
}

export function writeRepoFile(root: string, repoPath: string, content: string | Uint8Array): string {
  const file = path.join(root, ...repoPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Item da lista com estado (`<id>:<pub>[:estado]`). */
export const listItem = (key: TestSigner, state = ''): string => `${key.keyId}:${key.publicRaw}${state === '' ? '' : `:${state}`}`;
/** O arquivo da lista: uma linha por item, `\n` no fim de cada uma. */
export const listFile = (items: readonly string[]): string => items.map((item) => `${item}\n`).join('');

export function writeTrustList(w: World, items: readonly string[], env: ChannelEnvironment = 'producao'): string {
  return writeRepoFile(w.root, `link-audit-seals/${env}/trust-keys.txt`, listFile(items));
}

export const sealRepoPath = (auditId: string, seq: number, env: ChannelEnvironment = 'producao'): string => `link-audit-seals/${env}/seals/${auditId}/seal-${String(seq).padStart(4, '0')}.json`;
export const closureRepoPath = (keyId: string, env: ChannelEnvironment = 'producao'): string => `link-audit-seals/${env}/seals/_closures/${keyId}.json`;
export const canonicalText = (value: unknown): string => `${JSON.stringify(value)}\n`;

export interface SealSpec {
  readonly signer: TestSigner;
  readonly entries?: Entries;
  /** Força outro `prevSealSha256` (cadeia quebrada). */
  readonly prev?: string | null;
  readonly auditId?: string;
  readonly seq?: number;
}

/** O próximo manifesto v2 depois de `previous` (assinado de verdade), sem gravar. */
export function nextSeal(auditId: string, previous: readonly EvidenceSealFileV2[], spec: SealSpec): EvidenceSealFileV2 {
  const last = previous[previous.length - 1];
  const seq = spec.seq ?? previous.length + 1;
  return createEvidenceSealV2({
    auditId: spec.auditId ?? auditId,
    seq,
    sealedAt: new Date(CHAIN_START + seq * HOUR_MS).toISOString(),
    keyId: spec.signer.keyId,
    privateKey: spec.signer.privateKey,
    entries: spec.entries ?? E1,
    dossier: DOSSIER,
    prevSealSha256: spec.prev !== undefined ? spec.prev : last ? sealSha256(last) : null,
  });
}

/** Grava uma cadeia (base) no checkout: um manifesto por assinante, canônico. Devolve os manifestos. */
export function chainInRepo(w: World, auditId: string, signers: readonly TestSigner[], env: ChannelEnvironment = 'producao'): EvidenceSealFileV2[] {
  const seals: EvidenceSealFileV2[] = [];
  for (const signerKey of signers) {
    const seal = nextSeal(auditId, seals, { signer: signerKey });
    writeRepoFile(w.root, sealRepoPath(auditId, seal.seq, env), canonicalText(seal));
    seals.push(seal);
  }
  return seals;
}

/** Fecho assinado por `closer` cobrindo as cabeças dadas (sem gravar). */
export function closureFor(retired: TestSigner, closer: TestSigner, heads: readonly EvidenceSealFileV2[]): KeyRetirementClosureFile {
  return createKeyRetirementClosure({
    retiredKeyId: retired.keyId,
    signerKeyId: closer.keyId,
    sealedAt: '2026-11-20T08:00:00.000Z',
    heads: heads.map((seal) => ({ auditId: seal.auditId, seq: seal.seq, sealSha256: sealSha256(seal) })),
    privateKey: closer.privateKey,
  });
}

/** `git diff --name-status --no-renames -z`: `<status>\0<caminho>\0`. */
export function changesBytes(changes: ReadonlyArray<readonly [ChangeStatus | string, ...string[]]>): Buffer {
  return Buffer.from(changes.map(([status, ...paths]) => [status, ...paths].map((field) => `${field}\0`).join('')).join(''), 'utf8');
}

/** `git ls-tree -r -z HEAD -- link-audit-seals` do checkout: `100644` para arquivo comum, `120000` para link; `overrides` troca o modo. */
export function modesBytes(root: string, overrides: Readonly<Record<string, string>> = {}): Buffer {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const repoPath = path.relative(root, full).split(path.sep).join('/');
        const mode = overrides[repoPath] ?? (entry.isSymbolicLink() ? '120000' : '100644');
        lines.push(`${mode} ${mode === '160000' ? 'commit' : 'blob'} ${'a'.repeat(40)}\t${repoPath}\0`);
      }
    }
  };
  walk(path.join(root, 'link-audit-seals'));
  for (const [repoPath, mode] of Object.entries(overrides)) {
    if (!lines.some((line) => line.endsWith(`\t${repoPath}\0`))) lines.push(`${mode} ${mode === '160000' ? 'commit' : 'blob'} ${'a'.repeat(40)}\t${repoPath}\0`);
  }
  return Buffer.from(lines.join(''), 'utf8');
}

export const ABSENT: BaseTrustList = { kind: 'absent' };
export const baseBytes = (text: string): BaseTrustList => ({ kind: 'bytes', bytes: Buffer.from(text, 'utf8') });
export const sameBase = (w: World, env: ChannelEnvironment = 'producao'): BaseTrustList => ({ kind: 'bytes', bytes: fs.readFileSync(path.join(w.root, 'link-audit-seals', env, 'trust-keys.txt')) });

export interface CheckOptions {
  readonly modeOverrides?: Readonly<Record<string, string>>;
  readonly baseTrust?: Partial<Record<ChannelEnvironment, BaseTrustList>>;
  readonly fs?: BytesFsOps;
}

/** O núcleo sobre o checkout fictício, com as entradas montadas como o workflow as entrega. Por padrão a lista do commit-base = a do commit. */
export async function check(w: World, changes: ReadonlyArray<readonly [ChangeStatus | string, ...string[]]>, options: CheckOptions = {}): Promise<SealsCheckReport> {
  const parsed = parseNameStatus(changesBytes(changes));
  const modes = parseTreeModes(modesBytes(w.root, options.modeOverrides));
  if (!parsed.ok || modes === null) throw new Error('entrada de teste fora da forma');
  const baseTrust = { producao: options.baseTrust?.producao ?? sameBase(w, 'producao'), homologacao: options.baseTrust?.homologacao ?? sameBase(w, 'homologacao') };
  return runSealsCheck({ repoRoot: w.root, changes: parsed.entries, modes, baseTrust }, { fs: options.fs ?? nodeFsOps });
}

export const codes = (report: SealsCheckReport): string[] => report.refusals.map((item) => item.code);
