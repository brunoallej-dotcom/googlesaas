import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nodeFsOps } from '../../src/lib/link-audit/snapshot-store';
import type { CloseKeyDeps, CloseKeyInput } from '../../src/lib/link-audit-attestation/sign-closure';
import type { CloseConfirmationFacts } from '../../src/lib/link-audit-attestation/sign-core';
import { nodeCloseFsOps } from '../../src/lib/link-audit-attestation/sign-receipts';
import { createEvidenceSealV2, sealSha256, type EvidenceSealFileV2 } from '../../src/lib/link-audit-evidence/provenance';
import { tmpDir } from './link-audit-evidence-fixtures';
import { GOLDEN } from './link-audit-seal-v2-golden';
import { testKey } from './link-audit-seal-sign-disk-fixtures';

/*
 * Fixtures da W4.5 (comando de fecho `close-key`, spec §5.5.1 item 9; contrato do verificador v2 §6, V2-46). Dados 100% FICTÍCIOS em pastas
 * temporárias. As chaves são GERADAS em memória a cada chamada (ou as sementes de TESTE dos vetores-ouro), nunca chave real, nunca texto de chave
 * no repositório. A cópia do servidor (`--seals-dir`) recebe cadeias v2 reais (produtores do verificador), e a pasta de recibos (`--receipts-dir`,
 * o registro EXTERNO) recebe um JSON por assinatura, no formato do recibo do passo 16 do `sign`.
 */

export interface TestSigner {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicRaw: string;
}

/** Par Ed25519 gerado em memória (a privada nunca sai do teste). */
export function signer(keyId: string): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { keyId, privateKey, publicRaw: String(publicKey.export({ format: 'jwk' }).x) };
}

/** As chaves de TESTE `a` e `b` dos vetores-ouro (semente fabricada, em memória). */
export function goldenSigner(which: 'a' | 'b'): TestSigner {
  return { keyId: GOLDEN.keys[which].keyId, privateKey: testKey(which), publicRaw: GOLDEN.keys[which].publicRaw };
}

export const item = (key: TestSigner, state = 'active'): string => `${key.keyId}:${key.publicRaw}:${state}`;

const h = (c: string): string => c.repeat(64);
export type Entries = ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>;
export const E1: Entries = [
  { ref: 'capture:c0001', contentSha256: h('a') },
  { ref: 'report:c0001-r0001', contentSha256: h('b') },
];
export const E2: Entries = [
  { ref: 'capture:c0001', contentSha256: h('a') },
  { ref: 'capture:c0002', contentSha256: h('c') },
  { ref: 'report:c0001-r0001', contentSha256: h('b') },
];
const DOSSIER = { id: 'dossie-fecho-0001', sha256: h('9') };
/** Base dos `sealedAt` das cadeias das fixtures (o relógio do `close-key` nos testes é depois disso). */
export const CHAIN_BASE = Date.parse('2026-11-18T10:00:00.000Z');
export const CLOSE_NOW = '2026-11-20T08:00:00.000Z';

/** Grava um manifesto como a cópia do servidor o guarda (`seal-NNNN.json`, JSON compacto + quebra de linha, somente leitura). */
export function deliverSeal(sealsDir: string, auditId: string, seq: number, text: string | Buffer): string {
  const file = path.join(sealsDir, auditId, `seal-${String(seq).padStart(4, '0')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o444);
  return file;
}

/**
 * Cadeia v2 REAL de `auditId` na cópia do servidor: uma posição por assinante (seq 1, 2, …), cada uma ligada ao `sealSha256` da anterior, com as
 * entradas cumulativas (`entries` de cada posição; padrão E1). Devolve os manifestos na ordem.
 */
export function chainOn(sealsDir: string, auditId: string, signers: readonly TestSigner[], entries: (seq: number) => Entries = () => E1): EvidenceSealFileV2[] {
  const seals: EvidenceSealFileV2[] = [];
  signers.forEach((key, index) => {
    const previous = seals[index - 1];
    const seal = createEvidenceSealV2({
      auditId,
      seq: index + 1,
      sealedAt: new Date(CHAIN_BASE + index * 3_600_000).toISOString(),
      keyId: key.keyId,
      privateKey: key.privateKey,
      entries: entries(index + 1),
      dossier: DOSSIER,
      prevSealSha256: previous ? sealSha256(previous) : null,
    });
    seals.push(seal);
    deliverSeal(sealsDir, auditId, seal.seq, `${JSON.stringify(seal)}\n`);
  });
  return seals;
}

/** O recibo do passo 16 do `sign` para um manifesto (os campos que não vêm do manifesto são fictícios e fixos). */
export function receiptFor(seal: EvidenceSealFileV2, over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ok: true,
    auditId: seal.auditId,
    seq: seal.seq,
    schemaVersion: 2,
    keyId: seal.keyId,
    sealedAt: seal.sealedAt,
    sealSha256: sealSha256(seal),
    prevSealSha256: seal.prevSealSha256,
    packageSha256: h('1'),
    dossierSha256: seal.dossier.sha256,
    entries: seal.entries.length,
    approvedBy: 'CONF-01',
    operator: 'OPER-01',
    custodian: 'CUST-01',
    roleException: false,
    requiresLaterReview: false,
    artifactSha256: null,
    ...over,
  };
}

/** Grava um recibo na pasta de recibos: compacto (a linha "Recibo (JSON)" do `sign`) ou identado (como alguém o guardaria). */
export function writeReceipt(receiptsDir: string, name: string, receipt: unknown, format: 'compact' | 'pretty' = 'compact'): string {
  const file = path.join(receiptsDir, name);
  fs.writeFileSync(file, format === 'compact' ? `${JSON.stringify(receipt)}\n` : `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

/** Um recibo por manifesto, com nome derivado da posição (`<auditId>-seal-NNNN.json`). */
export function writeReceipts(receiptsDir: string, seals: readonly EvidenceSealFileV2[]): void {
  for (const seal of seals) writeReceipt(receiptsDir, `${seal.auditId}-seal-${String(seal.seq).padStart(4, '0')}.json`, receiptFor(seal));
}

export interface CloseWorld {
  readonly sealsDir: string;
  readonly receiptsDir: string;
  /** A chave a aposentar (R). */
  readonly retired: TestSigner;
  /** A chave ativa que assina o fecho (S). */
  readonly closer: TestSigner;
  /** `--trust-keys`: R e S ativas (o fecho ainda não foi fixado). */
  readonly trustKeys: string;
  input(over?: Partial<CloseKeyInput>): CloseKeyInput;
}

/** Cópia do servidor e pasta de recibos vazias; R e S geradas em memória (ou as indicadas). */
export function closeWorld(keys: { readonly retired?: TestSigner; readonly closer?: TestSigner } = {}): CloseWorld {
  const sealsDir = tmpDir('lack-seals-');
  const receiptsDir = tmpDir('lack-rec-');
  const retired = keys.retired ?? signer('ek-fecho-r');
  const closer = keys.closer ?? signer('ek-fecho-s');
  const trustKeys = `${item(retired)},${item(closer)}`;
  return {
    sealsDir,
    receiptsDir,
    retired,
    closer,
    trustKeys,
    input: (over = {}) => ({ retiredKeyId: retired.keyId, signerKeyId: closer.keyId, sealsDir, receiptsDir, trustKeys, custodian: 'CUST-01', ...over }),
  };
}

export type CloseDeps = CloseKeyDeps & { readonly order: () => readonly string[]; readonly facts: () => readonly CloseConfirmationFacts[] };

/**
 * Dependências do `close-key` com o disco REAL, relógio fixo e a confirmação e o leitor de chave como espiões. Sem `confirm`, o custodiante digita o
 * id da chave a aposentar (que leu no registro de rotação, fora da tela). Sem `openKey`, a chave do fecho é a de `world.closer`.
 */
export function closeDeps(world: CloseWorld, over: Partial<CloseKeyDeps> = {}): CloseDeps {
  const order: string[] = [];
  const facts: CloseConfirmationFacts[] = [];
  const confirm = over.confirm ?? (async () => world.retired.keyId);
  const openKey = over.openKey ?? (() => world.closer.privateKey);
  return {
    fs: nodeFsOps,
    closeFs: nodeCloseFsOps,
    uid: process.getuid?.(),
    now: () => new Date(CLOSE_NOW),
    ...over,
    confirm: (seen) => {
      order.push('confirm');
      facts.push(seen);
      return confirm(seen);
    },
    openKey: () => {
      order.push('openKey');
      return openKey();
    },
    order: () => [...order],
    facts: () => [...facts],
  };
}

export const closurePath = (sealsDir: string, keyId: string): string => path.join(sealsDir, '_closures', `${keyId}.json`);

/** Todos os arquivos (caminho relativo) abaixo de `dir`. */
export function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).filter((rel) => fs.lstatSync(path.join(dir, rel)).isFile()).sort();
}
