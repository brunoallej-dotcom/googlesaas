import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BytesFsOps } from '../../src/lib/link-audit/fs-ops';
import type { EvidenceSealFileV2 } from '../../src/lib/link-audit-evidence/provenance';
import type { SealReceiverConfig } from '../../src/lib/seal-receiver/args';
import type { SealReceiverOutcome } from '../../src/lib/seal-receiver/codes';
import { parseSealCommand } from '../../src/lib/seal-receiver/grammar';
import { nodeLock, sealReceiverFs } from '../../src/lib/seal-receiver/node-adapters';
import type { ByteSource, Clock, InputEvent, LockPort, PermissionFacts, ReceiverLog, SealReceiverDeps } from '../../src/lib/seal-receiver/ports';
import { runPut } from '../../src/lib/seal-receiver/put';
import { runSealReceiver } from '../../src/lib/seal-receiver/receiver';
import { tmpDir } from './link-audit-evidence-fixtures';
import { canonicalText, nextSeal, type SealSpec } from './link-audit-seals-fixtures';

/*
 * P9.3b — mundo de teste do receptor de manifestos: pastas TEMPORÁRIAS reais (pasta de manifestos `2750`, estado do deploy com a lista instalada
 * e a pendente, pasta da trava, log) com o disco real do adaptador de produção, cadeias v2 REAIS assinadas por chaves de TESTE geradas em memória
 * (fixtures da P9.2) e falhas injetadas pela porta de disco. Nenhum ssh, Docker ou rede; nenhuma chave real. Toda saída de toda execução passa por
 * `assertPublicOutcome` (P9-R10).
 */

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const errno = (code: string): Error => Object.assign(new Error(`falha injetada ${code}`), { code });

/** Uma linha pública da gramática do §5.8 (sem nada além). */
export const PUBLIC_LINE = /^(?:OK (?:WRITTEN|ALREADY_PRESENT) (?:aud-[0-9a-f]{16}\/seal-\d{4}\.json|_closures\/[a-z0-9][a-z0-9-]{3,31}\.json) [0-9a-f]{64}|ERRO E_[A-Z0-9_]+(?: [A-Z0-9_]+)?)$/;

export interface SealWorld {
  readonly root: string;
  readonly sealsRoot: string;
  readonly stateDir: string;
  readonly trustFile: string;
  readonly pendingFile: string;
  readonly lockFile: string;
  readonly logFile: string;
  readonly config: SealReceiverConfig;
  readonly argv: readonly string[];
}

/** Um host fictício: a pasta de manifestos `2750` (setgid), o estado do deploy (lista instalada vazia), a pasta da trava e o log `0600`. */
export function sealWorld(env: SealReceiverConfig['env'] = 'producao'): SealWorld {
  const root = fs.realpathSync(tmpDir('p93b-host-'));
  const sealsRoot = path.join(root, 'srv', 'manifestos');
  fs.mkdirSync(sealsRoot, { recursive: true });
  fs.chmodSync(sealsRoot, 0o2750);
  const stateDir = path.join(root, 'var', 'lib', 'gmn-deploy', env);
  fs.mkdirSync(stateDir, { recursive: true });
  const trustFile = path.join(stateDir, 'trust-keys.txt');
  fs.writeFileSync(trustFile, '', { mode: 0o644 });
  const lockDir = path.join(root, 'var', 'lib', 'gmn-seals', env);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const logDir = path.join(root, 'var', 'log', 'gmn-receivers');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${env}-seals.log`);
  fs.writeFileSync(logFile, '', { mode: 0o600 });
  fs.chmodSync(logFile, 0o600);
  const config: SealReceiverConfig = { env, sealsRoot, trustList: trustFile, lockFile: path.join(lockDir, 'lock'), logFile };
  const argv = ['--env', env, '--seals-root', sealsRoot, '--trust-list', trustFile, '--lock', config.lockFile, '--log', logFile];
  return { root, sealsRoot, stateDir, trustFile, pendingFile: path.join(stateDir, 'trust-keys.pending'), lockFile: config.lockFile, logFile, config, argv };
}

/** A lista instalada, trocada de forma ATÔMICA (temporário + `rename`), como o receptor de deploy a instala. Devolve os bytes. */
export function installTrust(w: SealWorld, lines: readonly string[]): Buffer {
  const bytes = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'ascii');
  const temporary = path.join(w.stateDir, `.trust-keys.txt.tmp-${sha256(bytes).slice(0, 8)}`);
  fs.writeFileSync(temporary, bytes, { mode: 0o644 });
  fs.chmodSync(temporary, 0o644);
  fs.renameSync(temporary, w.trustFile);
  return bytes;
}

/** Grava um manifesto na pasta de manifestos do host como o canal o deixa (canônico, `0444`). */
export function deliverOnHost(w: SealWorld, seal: EvidenceSealFileV2): string {
  const dir = path.join(w.sealsRoot, seal.auditId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `seal-${String(seal.seq).padStart(4, '0')}.json`);
  fs.writeFileSync(file, canonicalText(seal), { mode: 0o444 });
  return file;
}

/** Uma cadeia v2 real de `auditId` (um manifesto por assinante, em memória). */
export function chainOf(auditId: string, specs: readonly SealSpec[]): EvidenceSealFileV2[] {
  const seals: EvidenceSealFileV2[] = [];
  for (const spec of specs) seals.push(nextSeal(auditId, seals, spec));
  return seals;
}

export const sealRelpath = (seal: { readonly auditId: string; readonly seq: number }): string => `${seal.auditId}/seal-${String(seal.seq).padStart(4, '0')}.json`;
export const putLine = (relpath: string, bytes: Uint8Array | string, trust: Uint8Array | string): string => `put ${relpath} ${sha256(bytes)} ${sha256(trust)}`;

/* ------------------------------------------------------------------------------------------------------------------------- portas falsas */

export class FakeStdin implements ByteSource {
  reads = 0;
  private readonly events: InputEvent[];
  constructor(chunks: readonly Uint8Array[], ending: 'end' | 'hang' = 'end') {
    this.events = chunks.map((chunk) => ({ kind: 'data' as const, chunk }));
    if (ending === 'end') this.events.push({ kind: 'end' });
  }
  static of(bytes: Uint8Array | string, chunkSize = 4096): FakeStdin {
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) chunks.push(data.subarray(offset, offset + chunkSize));
    return new FakeStdin(chunks);
  }
  get remaining(): number {
    return this.events.length;
  }
  async next(): Promise<InputEvent> {
    this.reads += 1;
    return this.events.shift() ?? { kind: 'idle' };
  }
}

/** Relógio monotônico falso; `stepMs` avança a cada leitura (para o prazo do stdin inteiro). */
export class FakeClock implements Clock {
  now = 0;
  constructor(private readonly stepMs = 0) {}
  monotonicMs(): number {
    const current = this.now;
    this.now += this.stepMs;
    return current;
  }
  isoNow(): string {
    return '2026-11-23T00:00:00.000Z';
  }
}

export class MemoryLog implements ReceiverLog {
  readonly entries: Array<{ event: string; fields: Readonly<Record<string, unknown>> }> = [];
  write(event: string, fields: Readonly<Record<string, string | number | boolean | null>> = {}): void {
    this.entries.push({ event, fields });
  }
  text(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n');
  }
}

/** O modelo de permissões da linha do wrapper (§5.7): leitura da lista, escrita na pasta de manifestos, nada sobre a lista, sem filho nem worker. */
export const wrapperPermission = (w: SealWorld): PermissionFacts => ({
  has: (scope, reference) => {
    if (scope === 'child' || scope === 'worker') return false;
    if (scope === 'fs.read') return reference === w.trustFile || reference === w.sealsRoot;
    return reference === w.sealsRoot || reference === path.dirname(w.lockFile) || reference === path.dirname(w.logFile);
  },
});

let suffixCounter = 0;
const nextSuffix = (): string => (suffixCounter += 1).toString(16).padStart(32, '0');

export interface RunOptions {
  readonly fs?: BytesFsOps;
  readonly stdin?: ByteSource;
  readonly clock?: Clock;
  readonly lock?: LockPort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly permission?: PermissionFacts | null;
  readonly argv?: readonly string[];
  readonly log?: ReceiverLog;
}

export interface RunResult {
  readonly outcome: SealReceiverOutcome;
  readonly log: MemoryLog;
  readonly stdin: ByteSource;
}

function depsFor(stdin: ByteSource, log: ReceiverLog, options: RunOptions): SealReceiverDeps {
  return { fs: options.fs ?? sealReceiverFs, stdin, clock: options.clock ?? new FakeClock(), lock: options.lock ?? nodeLock, log, tempSuffix: nextSuffix };
}

/** Uma execução do receptor inteiro (ambiente, parâmetros, modelo de permissões, gramática, trava, `put`), com a saída pública conferida. */
export async function runReceiver(w: SealWorld, command: string | undefined, input: Uint8Array | string | ByteSource, options: RunOptions = {}): Promise<RunResult> {
  const stdin = typeof input === 'string' || input instanceof Uint8Array ? FakeStdin.of(input) : input;
  const log = new MemoryLog();
  const env = options.env ?? { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: command };
  const permission = options.permission === undefined ? wrapperPermission(w) : options.permission;
  const outcome = await runSealReceiver({ argv: options.argv ?? w.argv, env, permission }, () => depsFor(stdin, options.log ?? log, options));
  assertPublicOutcome(outcome, w);
  return { outcome, log, stdin };
}

/** Só o `put` (sem a trava de defesa), para as corridas do P9-R08. A saída é montada como a do receptor. */
export async function putOnly(w: SealWorld, command: string, input: Uint8Array | string, options: RunOptions = {}): Promise<string> {
  const parsed = parseSealCommand(command);
  assert.ok(parsed, 'comando do teste fora da gramática');
  try {
    return await runPut(parsed, w.config, depsFor(FakeStdin.of(input), options.log ?? new MemoryLog(), options));
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'E_INTERNAL';
    return `ERRO ${code}`;
  }
}

/** P9-R10: exatamente uma linha pública (stdout no sucesso, stderr na falha), da gramática, sem caminho absoluto nem conteúdo de arquivo. */
export function assertPublicOutcome(outcome: SealReceiverOutcome, w: SealWorld): void {
  const line = outcome.stdout ?? outcome.stderr ?? '';
  assert.ok((outcome.stdout === null) !== (outcome.stderr === null), 'um canal só');
  assert.match(line, PUBLIC_LINE, JSON.stringify(line));
  assert.ok(!line.includes('\n'), 'uma linha');
  assert.equal(outcome.stdout !== null, outcome.exitCode === 0, 'stdout só no sucesso');
  for (const forbidden of [w.root, '/tmp', '/home', '/srv', '/var', '{', '"', 'signature', 'LINK_AUDIT']) assert.ok(!line.includes(forbidden), `${forbidden} na saída pública`);
}

/** O que existe sob a pasta de manifestos (caminhos relativos, ordenados), para provar "nada gravado". */
export function listTree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).sort();
}

/** Disco com falhas injetadas: as operações dadas trocam as do adaptador de produção. */
export const faultyFs = (overrides: Partial<BytesFsOps>): BytesFsOps => ({ ...sealReceiverFs, ...overrides });
