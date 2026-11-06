import { pad, type ClientRecord } from './types';

/*
 * Identificadores de evidência armazenada que uma decisão pode citar. Cada um corresponde a UM arquivo real do
 * serviço de evidências (Onda 5A) e cabe no formato de id do contrato da 6A (`[A-Za-z0-9_.:-]{1,64}`):
 *   capture:c0001      ↔ c0001.capture.json
 *   report:c0001-r0001 ↔ c0001.report-r0001.json
 * `site:c0001` (c0001.site.json) é reconhecido, mas a API pública do leitor não permite confirmar que o arquivo
 * existe; por isso é RECUSADO até a Onda 6C (nunca se aceita um identificador que não se possa verificar).
 */
export type EvidenceRef =
  | { readonly kind: 'capture'; readonly capture: number }
  | { readonly kind: 'report'; readonly capture: number; readonly revision: number }
  | { readonly kind: 'site'; readonly capture: number };

const REF = /^(capture|report|site):c(\d{4})(?:-r(\d{4}))?$/;

export function parseEvidenceRef(ref: string): EvidenceRef | null {
  const match = REF.exec(ref);
  if (!match) return null;
  const capture = Number(match[2]);
  if (capture < 1) return null;
  const revision = match[3];
  if (match[1] === 'report') {
    if (revision === undefined || Number(revision) < 1) return null;
    return { kind: 'report', capture, revision: Number(revision) };
  }
  if (revision !== undefined) return null;
  return match[1] === 'capture' ? { kind: 'capture', capture } : { kind: 'site', capture };
}

export const captureRef = (capture: number): string => `capture:c${pad(capture)}`;
export const reportRef = (capture: number, revision: number): string => `report:c${pad(capture)}-r${pad(revision)}`;

/** Evidências citadas por um registro (as únicas que o contrato da 6A permite citar). */
export function referencedEvidence(record: ClientRecord): readonly string[] {
  switch (record.kind) {
    case 'NOT_APPLICABLE':
      return record.causeEvidenceIds;
    case 'IMAGES_CONFIRMATION':
      return record.evidenceIds;
    default:
      return [];
  }
}

export interface VersionLike {
  readonly capture: number | null;
  readonly collectedAt: string | null;
  readonly reportRevisions: ReadonlyArray<{ readonly revision: number }>;
}

/** Conjunto de referências que existem, a partir das versões devolvidas (e verificadas) pelo leitor de evidências. */
export function availableRefs(versions: readonly VersionLike[]): Set<string> {
  const refs = new Set<string>();
  for (const version of versions) {
    if (version.capture === null) continue;
    refs.add(captureRef(version.capture));
    for (const { revision } of version.reportRevisions) refs.add(reportRef(version.capture, revision));
  }
  return refs;
}
