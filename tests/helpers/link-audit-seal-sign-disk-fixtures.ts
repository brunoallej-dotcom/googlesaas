import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nodeFsOps } from '../../src/lib/link-audit/snapshot-store';
import { CHECK_IDS, computePackageSha256, type Approval, type CandidatePackage } from '../../src/lib/link-audit-attestation';
import type { SignPlan } from '../../src/lib/link-audit-attestation/sign-core';
import type { SignRunDeps, SignRunInput } from '../../src/lib/link-audit-attestation/sign-run';
import { GOLDEN } from './link-audit-seal-v2-golden';

/*
 * Fixtures da W4.3 (disco e concorrência do `sign`). Sem `node:test`: o processo FILHO da corrida também as importa. Dados 100% FICTÍCIOS; a chave é a
 * de TESTE `a` dos vetores-ouro, derivada da semente de teste em memória (PKCS#8 DER = prefixo + semente; nunca texto PEM no repositório, nunca chave
 * real). Quem chama cria e apaga as pastas temporárias.
 */

export const AUD = 'auditoria-disco-sign-01';
export const KEY_ID = GOLDEN.keys.a.keyId;
/** `--trust-keys` no formato com estado do contrato v2 (§5): só a chave de teste `a`, ativa. */
export const RING = `${KEY_ID}:${GOLDEN.keys.a.publicRaw}:active`;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Chave PRIVADA de TESTE (semente fabricada dos vetores-ouro), só em memória. */
export function testKey(): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(GOLDEN.keys.a.seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
}

export const LAST_COLLECTED_AT = '2026-11-18T09:00:00.000Z';
export const NOW = '2026-11-19T09:00:00.000Z';
export type Entries = ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>;
export const h = (c: string): string => c.repeat(64);
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ev = (ref: string, fill: string): { ref: string; contentSha256: string } => ({ ref, contentSha256: h(fill) });
export const E1: Entries = [ev('capture:c0001', 'a'), ev('report:c0001-r0001', 'b')];
export const E2: Entries = [ev('capture:c0001', 'a'), ev('capture:c0002', 'c'), ev('report:c0001-r0001', 'b'), ev('report:c0002-r0001', 'd')];

/** Dossiê FICTÍCIO e BINÁRIO de propósito (bytes que não são UTF-8 válido, como um PDF): o hash tem de ser dos BYTES lidos. */
export const DOSSIER: Buffer = Buffer.concat([Buffer.from('%PDF-1.7 dossiê de aprovação FICTÍCIO (W4.3)\n', 'utf8'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x0a])]);
export const DOSSIER_ID = 'dossie-disco-0001';

const NOT_EXECUTED: ReadonlySet<string> = new Set(['REPORT_REPRODUCES', 'AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE']);
const byRef = (a: { readonly ref: string }, b: { readonly ref: string }): number => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

/** Pacote atestável como o `export` o entrega (hash refeito sobre o corpo); empresa `null` (nenhum dado de empresa). */
export function makePackage(entries: Entries, auditId = AUD): CandidatePackage {
  const list = [...entries].sort(byRef).map(({ ref, contentSha256 }) => ({ ref, contentSha256 }));
  const count = (prefix: string): number => list.filter((entry) => entry.ref.startsWith(prefix)).length;
  const body = {
    schemaVersion: 1 as const,
    kind: 'LINK_AUDIT_P1_CANDIDATE' as const,
    auditId,
    layout: 'VERSIONED' as const,
    attestable: true,
    summary: { company: { name: null, city: null, stateCode: null }, firstCollectedAt: LAST_COLLECTED_AT, lastCollectedAt: LAST_COLLECTED_AT, captures: count('capture:'), reportRevisions: count('report:'), artifacts: 0, containsLegacy: false },
    integrity: { status: 'OK' as const, algorithm: 'SHA-256' as const, checkedFiles: list.length },
    checks: CHECK_IDS.map((id) => ({ id, status: NOT_EXECUTED.has(id) ? ('NOT_EXECUTED' as const) : ('PASS' as const) })),
    gap: { maxHours: 24, observedHours: 1, justification: null },
    entries: list.map((entry) => ({ ...entry, legacy: false })),
    delta: null,
    generatedAt: '2026-11-18T13:00:00.000Z',
  };
  return { ...body, packageSha256: computePackageSha256(body) };
}

export function makeApproval(pkg: CandidatePackage, dossier: Uint8Array = DOSSIER): Approval {
  return {
    schemaVersion: 1,
    kind: 'LINK_AUDIT_P1_APPROVAL',
    auditId: pkg.auditId,
    packageSha256: pkg.packageSha256,
    decision: 'APPROVED',
    approvedBy: 'CONF-01',
    operator: 'OPER-01',
    approvedAt: '2026-11-18T14:00:00.000Z',
    dossier: { id: DOSSIER_ID, sha256: sha256(dossier) },
    humanChecks: pkg.checks.filter((check) => check.status === 'NOT_EXECUTED').map((check) => ({ id: check.id as Approval['humanChecks'][number]['id'], result: 'PASS' as const, note: 'conferido pelo conferente (fictício)' })),
    riskAcceptance: null,
  };
}

/** Bytes de um JSON como o conferente o guarda (identado, com quebra final). */
export const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export interface StationFiles {
  readonly packagePath: string;
  readonly approvalPath: string;
  readonly dossierPath: string;
}
/** Grava pacote, aprovação e dossiê na pasta da estação (temporária) e devolve os caminhos. */
export function writeStation(dir: string, files: { readonly pkg?: CandidatePackage; readonly approval?: unknown; readonly dossier?: Uint8Array; readonly entries?: Entries } = {}): StationFiles {
  const pkg = files.pkg ?? makePackage(files.entries ?? E1);
  const dossier = files.dossier ?? DOSSIER;
  const station = { packagePath: path.join(dir, 'pacote.json'), approvalPath: path.join(dir, 'aprovacao.json'), dossierPath: path.join(dir, 'dossie.pdf') };
  fs.writeFileSync(station.packagePath, jsonBytes(pkg));
  fs.writeFileSync(station.approvalPath, jsonBytes(files.approval ?? makeApproval(pkg, dossier)));
  fs.writeFileSync(station.dossierPath, dossier);
  return station;
}

export function signInput(station: StationFiles, sealsDir: string, over: Partial<SignRunInput> = {}): SignRunInput {
  return { auditId: AUD, custodian: 'CUST-01', ...station, sealsDir, trustKeys: RING, expectSeq: 1, first: true, keyId: KEY_ID, ...over };
}

/** Dependências do `sign` com o disco REAL, relógio fixo e o leitor de chave como espião (conta as aberturas). */
export function signDeps(over: Partial<SignRunDeps> = {}): SignRunDeps & { readonly keyCalls: () => number } {
  let calls = 0;
  return {
    fs: nodeFsOps,
    now: () => new Date(NOW),
    openKey: () => {
      calls += 1;
      return testKey();
    },
    ...over,
    keyCalls: () => calls,
  };
}

/** Plano válido (seq 1) para gravar direto, sem o núcleo: `variant` muda só o `sealedAt` (manifestos distintos para o MESMO seq). */
export function planFor(variant: number, entries: Entries = E1, auditId = AUD): SignPlan {
  const pkg = makePackage(entries, auditId);
  return {
    auditId,
    sealedAt: new Date(Date.parse(NOW) + variant).toISOString(),
    seq: 1,
    prevSealSha256: null,
    packageSha256: pkg.packageSha256,
    entries: pkg.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256 })),
    dossier: { id: DOSSIER_ID, sha256: sha256(DOSSIER) },
    approvedBy: 'CONF-01',
    operator: 'OPER-01',
    custodian: 'CUST-01',
    roleException: false,
    requiresLaterReview: false,
  };
}

/** Nome do temporário da W4.3 (§5.5.1 item 4): `.seal-NNNN.json.tmp-<32 hex>`. */
export const TEMP_NAME = /^\.seal-\d{4}\.json\.tmp-[0-9a-f]{32}$/;
