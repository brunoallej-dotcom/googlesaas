import { sha256 } from './migration';

/**
 * Correção ISOLADA do metadado de um PDF (`pageCount` e `fileSizeBytes` do `diagrammer_payload`),
 * calculado a partir do PDF OFICIAL. Só essas duas chaves podem mudar; nada mais.
 */
export class PdfInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfInspectionError';
  }
}

/**
 * Conta as páginas por dois caminhos e exige que concordem: objetos `/Type /Page` e o `/Count` da
 * raiz da árvore de páginas (`/Type /Pages`). Recusa PDF que não confere (adulterado/ilegível).
 */
export function countPdfPages(buffer: Uint8Array): number {
  const text = Buffer.from(buffer).toString('latin1');
  if (!text.startsWith('%PDF-')) throw new PdfInspectionError('Arquivo não é um PDF.');
  const pageObjects = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  const counts: number[] = [];
  for (const match of text.matchAll(/<<[^>]*?\/Type\s*\/Pages[^>]*?>>|<<[^>]*?\/Count\s+\d+[^>]*?\/Type\s*\/Pages[^>]*?>>/g)) {
    const count = /\/Count\s+(\d+)/.exec(match[0]);
    if (count) counts.push(Number(count[1]));
  }
  if (pageObjects === 0) throw new PdfInspectionError('Nenhuma página encontrada no PDF.');
  if (counts.length === 0) throw new PdfInspectionError('Árvore de páginas (/Count) não encontrada.');
  const root = Math.max(...counts);
  if (root !== pageObjects) throw new PdfInspectionError(`Contagem inconsistente: ${pageObjects} objetos /Page × /Count ${root}.`);
  return pageObjects;
}

export interface MetadataFixPlan {
  readonly auditId: string;
  readonly before: { readonly pageCount: unknown; readonly fileSizeBytes: unknown };
  readonly after: { readonly pageCount: number; readonly fileSizeBytes: number };
  readonly payloadBefore: Record<string, unknown>;
  readonly payloadAfter: Record<string, unknown>;
  readonly officialSha256: string;
  readonly changed: boolean;
}

/** Valida que o arquivo é EXATAMENTE o oficial (SHA-256 esperado) e calcula os novos valores. */
export function planMetadataFix(params: {
  readonly auditId: string;
  readonly payload: Record<string, unknown> | null;
  readonly officialBytes: Uint8Array;
  readonly expectedOfficialSha256: string;
  /** SHA-256 da cópia no bucket privado, quando disponível: precisa ser igual. */
  readonly privateCopySha256?: string;
}): MetadataFixPlan {
  const { payload, officialBytes } = params;
  if (!payload) throw new PdfInspectionError('Registro sem diagrammer_payload.');
  const digest = sha256(officialBytes);
  if (digest !== params.expectedOfficialSha256) throw new PdfInspectionError(`O arquivo não é o oficial: SHA-256 ${digest.slice(0, 16)} ≠ ${params.expectedOfficialSha256.slice(0, 16)}.`);
  if (params.privateCopySha256 !== undefined && params.privateCopySha256 !== digest) throw new PdfInspectionError('A cópia no bucket privado difere do arquivo oficial.');
  const after = { pageCount: countPdfPages(officialBytes), fileSizeBytes: officialBytes.byteLength };
  return {
    auditId: params.auditId,
    before: { pageCount: payload.pageCount, fileSizeBytes: payload.fileSizeBytes },
    after,
    payloadBefore: payload,
    payloadAfter: { ...payload, pageCount: after.pageCount, fileSizeBytes: after.fileSizeBytes },
    officialSha256: digest,
    changed: payload.pageCount !== after.pageCount || payload.fileSizeBytes !== after.fileSizeBytes,
  };
}

export interface MetadataPort {
  read(auditId: string): Promise<{ readonly diagrammer_payload: Record<string, unknown> | null; readonly updated_at: string } | null>;
  /** UPDATE condicional por id + updated_at (compare-and-set). `true` só se EXATAMENTE 1 linha mudou. */
  update(auditId: string, payload: Record<string, unknown>, expectedUpdatedAt: string): Promise<boolean>;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Aplica o plano com CAS; se o estado lido depois não for exatamente o esperado, reverte. */
export async function applyMetadataFix(port: MetadataPort, plan: MetadataFixPlan): Promise<{ readonly updatedAtBefore: string; readonly updatedAtAfter: string }> {
  const current = await port.read(plan.auditId);
  if (!current) throw new Error(`Auditoria ${plan.auditId} não encontrada.`);
  if (!sameJson(current.diagrammer_payload, plan.payloadBefore)) throw new Error('O diagrammer_payload mudou desde a leitura do plano; nada foi escrito.');
  if (!(await port.update(plan.auditId, plan.payloadAfter, current.updated_at))) throw new Error('UPDATE condicional não alterou exatamente 1 linha; nada foi alterado.');
  const written = await port.read(plan.auditId);
  if (!written || !sameJson(written.diagrammer_payload, plan.payloadAfter)) {
    await port.update(plan.auditId, plan.payloadBefore, written?.updated_at ?? current.updated_at).catch(() => false);
    throw new Error('Verificação pós-escrita falhou; payload revertido automaticamente.');
  }
  return { updatedAtBefore: current.updated_at, updatedAtAfter: written.updated_at };
}

/** Reversão manual a partir do backup do payload original. */
export async function rollbackMetadataFix(port: MetadataPort, params: { readonly auditId: string; readonly payloadBefore: Record<string, unknown>; readonly payloadAfter: Record<string, unknown> }): Promise<void> {
  const current = await port.read(params.auditId);
  if (!current) throw new Error(`Auditoria ${params.auditId} não encontrada.`);
  if (!sameJson(current.diagrammer_payload, params.payloadAfter)) throw new Error('O payload atual não é o corrigido por este procedimento; reversão recusada para não sobrescrever outra alteração.');
  if (!(await port.update(params.auditId, params.payloadBefore, current.updated_at))) throw new Error('Reversão não alterou exatamente 1 linha.');
}
