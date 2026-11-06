import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createEvidenceSeal, type EvidenceProvenancePolicy, type EvidenceSealFile } from '../../src/lib/link-audit-evidence/provenance';
import { createScoringBasisReader } from '../../src/lib/link-audit-evidence/scoring-basis';

/*
 * Doubles e atestação FICTÍCIOS só para TESTE. O par de chaves é gerado a cada uso (nada fixo no repositório); a chave PRIVADA nunca sai do teste.
 * `TRUSTING_EVIDENCE_POLICY` autentica TUDO e existe só para que testes de OUTROS assuntos (decisões, resultados, interface) não dependam da
 * prova de coleta; a prova de coleta tem testes próprios com a política REAL (`link-audit-evidence-provenance.test.ts`).
 */
export const TRUSTING_EVIDENCE_POLICY: EvidenceProvenancePolicy = { async classify() { return { status: 'AUTHENTICATED' }; } };

export interface EvidenceKeys {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  /** Valor da variável `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (só a parte PÚBLICA). */
  readonly trustKeys: string;
  /** 32 bytes da chave pública em base64url. */
  readonly publicRaw: string;
}

export function evidenceKeys(keyId = 'ek-teste-0001'): EvidenceKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const publicRaw = Buffer.from(der.subarray(der.length - 32)).toString('base64url');
  return { keyId, privateKey, trustKeys: `${keyId}:${publicRaw}`, publicRaw };
}

/** Atesta TODAS as evidências que o leitor entrega hoje para a auditoria (como faria quem tem a chave, depois de conferir a coleta). */
export async function sealAuditForTests(input: { readonly evidenceDir: string; readonly auditId: string; readonly sealsDir: string; readonly keys: EvidenceKeys; readonly seq?: number; readonly only?: (ref: string) => boolean }): Promise<EvidenceSealFile> {
  const reader = createScoringBasisReader({ baseDir: input.evidenceDir, authorize: () => true });
  const basis = await reader.readScoringBasis({ email: 'selador@teste.invalid' }, input.auditId);
  if (basis.status !== 'READY') throw new Error(`não há base íntegra para atestar (${basis.status})`);
  const entries = [...basis.basis.evidences, ...(basis.basis.artifacts ?? [])].filter((e) => (input.only ? input.only(e.ref) : true)).map((e) => ({ ref: e.ref, contentSha256: e.contentSha256 }));
  const seq = input.seq ?? 1;
  const seal = createEvidenceSeal({ auditId: input.auditId, seq, sealedAt: '2026-10-30T12:00:00.000Z', keyId: input.keys.keyId, privateKey: input.keys.privateKey, entries });
  writeSealFile(input.sealsDir, input.auditId, seq, seal);
  return seal;
}

export function writeSealFile(sealsDir: string, auditId: string, seq: number, content: unknown): string {
  const dir = path.join(sealsDir, auditId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `seal-${String(seq).padStart(4, '0')}.json`);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, `${JSON.stringify(content)}\n`);
  fs.chmodSync(file, 0o444);
  return file;
}

/**
 * Para os testes de ROTA (que montam os serviços pelo ambiente, como em produção): gera o par de chaves, atesta as auditorias indicadas e define
 * `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR` e `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (só a parte PÚBLICA). Devolve o necessário para atestar de novo.
 */
export async function proveEvidenceForRoutes(env: Record<string, string | undefined>, w: { readonly evidenceDir: string; readonly auditId: string }, extraAuditIds: readonly string[] = []): Promise<{ readonly sealsDir: string; readonly keys: EvidenceKeys }> {
  const sealsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-routes-'));
  after(() => fs.rmSync(sealsDir, { recursive: true, force: true }));
  const keys = evidenceKeys();
  for (const auditId of [w.auditId, ...extraAuditIds]) {
    try {
      await sealAuditForTests({ evidenceDir: w.evidenceDir, auditId, sealsDir, keys });
    } catch {
      // auditoria sem base íntegra (sem evidência, corrompida): não há o que atestar; a rota responderá o que responderia sem a prova
    }
  }
  env.GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR = sealsDir;
  env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = keys.trustKeys;
  return { sealsDir, keys };
}

/**
 * SEMENTES DE NAVEGADOR: o harness (que não importa o código do servidor) gera o par de chaves desta execução e entrega à semente só a chave PRIVADA
 * (`GMN_SEED_EVIDENCE_SIGNING_KEY`, PKCS8/DER em base64) e o id; ao servidor entrega só a PÚBLICA. A semente atesta as auditorias indicadas — o papel de
 * quem tem a chave — e deixa as demais SEM manifesto de propósito (para provar o bloqueio no navegador).
 */
export async function sealAuditsForBrowserSeed(root: string, auditIds: readonly string[]): Promise<void> {
  const encoded = process.env.GMN_SEED_EVIDENCE_SIGNING_KEY ?? '';
  const keyId = process.env.GMN_SEED_EVIDENCE_KEY_ID ?? '';
  if (encoded.length < 40 || keyId.length < 4) throw new Error('chave de atestação de teste ausente (GMN_SEED_EVIDENCE_SIGNING_KEY / GMN_SEED_EVIDENCE_KEY_ID)');
  const privateKey = createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
  const keys: EvidenceKeys = { keyId, privateKey, trustKeys: '', publicRaw: '' };
  for (const auditId of auditIds) await sealAuditForTests({ evidenceDir: path.join(root, 'evidence'), auditId, sealsDir: path.join(root, 'seals'), keys });
}

