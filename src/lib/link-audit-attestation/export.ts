import { evidenceToProveFromBasis } from '../link-audit-evidence/evidence-to-prove';
import { AUDIT_ID_PATTERN } from '../link-audit-evidence/types';
import { computePackageSha256, PackageHashError } from './package-hash';
import { ATTESTATION_SCHEMA_VERSION, candidatePackageSchema, CHECK_IDS, hasNoControlChars, MAX_PACKAGE_ENTRIES, PACKAGE_KIND, type CandidatePackage, type PackageBody } from './schemas';

/*
 * P1 W2 — montagem PURA do pacote candidato (spec §5.3 e §5.3.1). Recebe só o que os leitores EXISTENTES já expuseram (base de pontuação
 * READY e as versões do leitor de evidências) e decide: pacote, ou recusa com `code` estável. Sem disco, rede, ambiente nem relógio implícito:
 * o instante da exportação vem de quem chama. As datas são normalizadas com `toISOString()` (o leitor aceita 0 ou 6 casas; o pacote, 3).
 */

export const EXPORT_REFUSAL_CODES = [
  'USAGE',
  'EXPORT_NOT_FOUND',
  'EXPORT_INTEGRITY_NOT_OK',
  'EXPORT_COLLECTOR_HASH_REQUIRED',
  'EXPORT_COLLECTOR_HASH_MISMATCH',
  'EXPORT_GAP_EXCEEDED',
  'EXPORT_CLOCK_REGRESSION',
  'EXPORT_OUT_UNSAFE',
  'EXPORT_TOO_MANY_ENTRIES',
  'UNEXPECTED',
] as const;
export type ExportRefusalCode = (typeof EXPORT_REFUSAL_CODES)[number];
export interface ExportRefusal {
  readonly ok: false;
  readonly code: ExportRefusalCode;
  /** pt-BR, sem conteúdo de arquivo, sem caminho de disco e sem dado da empresa. */
  readonly message: string;
}
export const refuse = (code: ExportRefusalCode, message: string): ExportRefusal => ({ ok: false, code, message });

/** Teto de sanidade de `--max-gap-hours` (um ano). O valor em si não tem padrão (spec §5.3, IA-20). */
export const MAX_GAP_HOURS = 8760;
const HOUR_MS = 3_600_000;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATE_CODE = /^[A-Z]{2}$/;
const MAX_COMPANY_TEXT = 200;
const MIN_2XX = 200;
const MAX_2XX = 299;

export const isValidAuditId = (value: string): boolean => AUDIT_ID_PATTERN.test(value);
export const captureLabel = (n: number): string => `c${String(n).padStart(4, '0')}`;

/** Forma mínima da base de pontuação (`ScoringBasis` a satisfaz); estrutural para este arquivo não importar o leitor. */
export interface ExportBasis {
  readonly layout: 'VERSIONED' | 'LEGACY';
  readonly evidences: ReadonlyArray<{ readonly ref: string; readonly kind: 'CAPTURE' | 'REPORT'; readonly capture: number; readonly observedAt: string; readonly contentSha256: string; readonly legacy: boolean }>;
  readonly artifacts?: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string; readonly legacy: boolean }>;
}
/** O que o leitor de evidências expõe por captura (`VersionEntry`). */
export interface CaptureFact {
  readonly capture: number | null;
  readonly collectedAt: string | null;
  readonly httpStatus: number | null;
}
export interface CompanyFact {
  readonly name: string | null;
  readonly city: string | null;
  readonly stateCode: string | null;
}

export interface CandidateInput {
  readonly auditId: string;
  readonly basis: ExportBasis;
  /** Versões do leitor de evidências; `null` = o leitor não as expôs (a verificação HTTP fica `NOT_EXECUTED`). */
  readonly captureFacts: readonly CaptureFact[] | null;
  readonly company: CompanyFact | null;
  /** `--collector-hash`: número da captura → hash registrado do relatório do coletor em `--json`. */
  readonly collectorHashes: ReadonlyMap<number, string>;
  readonly maxGapHours: number | null;
  readonly gapJustification: string | null;
  readonly now: Date;
}
export type CandidateResult = { readonly ok: true; readonly package: CandidatePackage } | ExportRefusal;
export interface CandidateDelta {
  readonly added: string[];
  readonly changed: string[];
  readonly missing: string[];
}

type CheckStatus = 'PASS' | 'FAIL' | 'NOT_EXECUTED';
type CheckId = (typeof CHECK_IDS)[number];
type Captures = ExportBasis['evidences'];
type Decided = { readonly ok: true; readonly statuses: Partial<Record<CheckId, CheckStatus>>; readonly gap: PackageBody['gap'] } | ExportRefusal;

const INTEGRITY_REFUSAL = refuse('EXPORT_INTEGRITY_NOT_OK', 'A integridade local não está OK (arquivo alterado, ausente, especial ou grande demais, coleta incompleta ou leituras divergentes). Nada foi exportado.');
const byRef = (a: { readonly ref: string }, b: { readonly ref: string }): number => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
const countRefs = (entries: ReadonlyArray<{ readonly ref: string }>, prefix: string): number => entries.filter((e) => e.ref.startsWith(prefix)).length;

/** Data do leitor → instante com milissegundos em UTC; `null` se não for uma data real. */
function normalizeInstant(value: string): { readonly ms: number; readonly iso: string } | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return ISO_MILLIS.test(iso) ? { ms, iso } : null;
}

/** Valor fora de forma vira `null` (NOT_VERIFIED): nunca é corrigido nem inventado. */
function cleanCompany(company: CompanyFact | null): PackageBody['summary']['company'] {
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length >= 1 && value.length <= MAX_COMPANY_TEXT && hasNoControlChars(value) ? value : null);
  const stateCode = company?.stateCode;
  return { name: text(company?.name), city: text(company?.city), stateCode: typeof stateCode === 'string' && STATE_CODE.test(stateCode) ? stateCode : null };
}

/** RS-05: uma por captura não legada, igual ao `contentSha256`; captura sem valor ou valor sem captura ⇒ recusa. */
function collectorRefusal(captures: Captures, hashes: ReadonlyMap<number, string>): ExportRefusal | null {
  const missing = captures.find((c) => !hashes.has(c.capture));
  if (missing) return refuse('EXPORT_COLLECTOR_HASH_REQUIRED', `Falta --collector-hash para ${captureLabel(missing.capture)} (o hash que o operador registrou do coletor em --json). Captura sem esse registro não é atestável.`);
  const expected = new Map(captures.map((c) => [c.capture, c.contentSha256]));
  for (const [n, hash] of [...hashes].sort(([a], [b]) => a - b)) {
    if (!expected.has(n)) return refuse('EXPORT_COLLECTOR_HASH_MISMATCH', `--collector-hash informado para ${captureLabel(n)}, que não é uma captura nova desta auditoria.`);
    if (expected.get(n) !== hash) return refuse('EXPORT_COLLECTOR_HASH_MISMATCH', `O hash registrado do coletor para ${captureLabel(n)} difere do conteúdo da captura. Nada foi exportado.`);
  }
  return null;
}

/**
 * HTTP 2xx e `collectedAt` por captura, na medida em que o leitor de evidências os expõe (`VersionEntry`); o leitor não é ampliado.
 * As duas leituras têm de concordar (mesmas capturas, mesmo `collectedAt` cru): divergência = a pasta mudou entre leituras ⇒ recusa.
 */
function httpCheck(captures: Captures, facts: readonly CaptureFact[] | null): CheckStatus | ExportRefusal {
  if (facts === null) return 'NOT_EXECUTED';
  const byCapture = new Map(facts.flatMap((f) => (f.capture === null ? [] : [[f.capture, f] as const])));
  if (byCapture.size !== facts.length || byCapture.size !== captures.length) return INTEGRITY_REFUSAL;
  for (const capture of captures) if (byCapture.get(capture.capture)?.collectedAt !== capture.observedAt) return INTEGRITY_REFUSAL;
  const is2xx = (status: number | null | undefined): boolean => typeof status === 'number' && Number.isInteger(status) && status >= MIN_2XX && status <= MAX_2XX;
  return captures.every((c) => is2xx(byCapture.get(c.capture)?.httpStatus)) ? 'PASS' : 'FAIL';
}

/**
 * RS-06: o intervalo é medido em milissegundos exatos contra o limite; o registrado no pacote (e no hash) é arredondado PARA CIMA à hora, que
 * nunca subestima o intervalo e mantém `observedHours ≤ maxHours` ⇔ dentro do limite (limite inteiro).
 */
function gapDecision(lastMs: number, nowMs: number, maxGapHours: number, justification: string | null): NonNullable<PackageBody['gap']> | ExportRefusal {
  const elapsed = nowMs - lastMs;
  if (elapsed < 0) return refuse('EXPORT_CLOCK_REGRESSION', 'A coleta tem data posterior ao relógio desta estação; confira o relógio. Nada foi exportado.');
  const observedHours = Math.ceil(elapsed / HOUR_MS);
  if (elapsed > maxGapHours * HOUR_MS && justification === null) {
    return refuse('EXPORT_GAP_EXCEEDED', `Intervalo entre a coleta e a exportação (${observedHours} h) acima de --max-gap-hours (${maxGapHours} h) sem --gap-justification. Nada foi exportado.`);
  }
  return { maxHours: maxGapHours, observedHours, justification };
}

function versionedChecks(input: CandidateInput, captures: Captures, lastMs: number): Decided {
  if (input.maxGapHours === null) return refuse('USAGE', 'Captura nova exige --max-gap-hours <N> (não há valor padrão).');
  const collector = collectorRefusal(captures, input.collectorHashes);
  if (collector) return collector;
  const gap = gapDecision(lastMs, input.now.getTime(), input.maxGapHours, input.gapJustification);
  if ('ok' in gap) return gap;
  const http = httpCheck(captures, input.captureFacts);
  if (typeof http !== 'string') return http;
  return { ok: true, statuses: { INTEGRITY_LOCAL: 'PASS', COLLECTOR_HASH_MATCHES: 'PASS', COLLECTION_GAP_WITHIN_LIMIT: 'PASS', HTTP_2XX_AND_COLLECTED_AT: http }, gap };
}

/** Legado: só relatório (não atestável); as 8 verificações são gravadas, as mecânicas em `NOT_EXECUTED` (herdado da revisão da W1). */
function legacyChecks(input: CandidateInput): Decided {
  if (input.collectorHashes.size > 0) return refuse('EXPORT_COLLECTOR_HASH_MISMATCH', '--collector-hash só vale para captura nova; esta auditoria é legada (não atestável).');
  return { ok: true, statuses: {}, gap: null };
}

/** Monta o pacote candidato ou recusa. Nunca lança por causa do conteúdo lido. */
export function buildCandidatePackage(input: CandidateInput): CandidateResult {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) return refuse('UNEXPECTED', 'Relógio inválido.');
  const entries = evidenceToProveFromBasis(input.basis).sort(byRef);
  if (entries.length > MAX_PACKAGE_ENTRIES) return refuse('EXPORT_TOO_MANY_ENTRIES', `Mais de ${MAX_PACKAGE_ENTRIES} entradas; o pacote não é produzido.`);
  const captures = input.basis.evidences.filter((e) => e.kind === 'CAPTURE');
  const instants = captures.map((c) => normalizeInstant(c.observedAt));
  if (entries.length === 0 || captures.length === 0 || instants.some((i) => i === null)) return INTEGRITY_REFUSAL;
  const containsLegacy = entries.some((e) => e.legacy);
  if ((input.basis.layout === 'LEGACY') !== containsLegacy) return INTEGRITY_REFUSAL;
  const times = (instants as Array<{ ms: number; iso: string }>).sort((a, b) => a.ms - b.ms);
  const first = times[0] as { ms: number; iso: string };
  const last = times[times.length - 1] as { ms: number; iso: string };
  const decided = containsLegacy ? legacyChecks(input) : versionedChecks(input, captures, last.ms);
  if (!decided.ok) return decided;

  const body: PackageBody = {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    kind: PACKAGE_KIND,
    auditId: input.auditId,
    layout: input.basis.layout,
    attestable: !containsLegacy,
    summary: {
      company: cleanCompany(input.company),
      firstCollectedAt: first.iso,
      lastCollectedAt: last.iso,
      captures: countRefs(entries, 'capture:'),
      reportRevisions: countRefs(entries, 'report:'),
      artifacts: countRefs(entries, 'legacy-status:'),
      containsLegacy,
    },
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: entries.length },
    checks: CHECK_IDS.map((id) => ({ id, status: decided.statuses[id] ?? 'NOT_EXECUTED' })),
    gap: decided.gap,
    entries,
  };
  let packageSha256: string;
  try {
    packageSha256 = computePackageSha256(body);
  } catch (error) {
    if (error instanceof PackageHashError) return refuse('UNEXPECTED', 'O pacote montado não passou no esquema; nada foi exportado.');
    throw error;
  }
  const parsed = candidatePackageSchema.safeParse({ ...body, delta: null, packageSha256, generatedAt: input.now.toISOString() });
  if (!parsed.success) return refuse('UNEXPECTED', 'O pacote montado não passou no esquema; nada foi exportado.');
  return exportRefusalFor(parsed.data) ?? { ok: true, package: parsed.data };
}

/**
 * Guarda final (herdada da revisão da W1): o esquema aceita um pacote `attestable` com verificação em FAIL; o `export` não o entrega. Só as
 * verificações que o `export` recusa por si (§5.3.1); FAIL de HTTP segue no pacote e quem recusa é o `sign`.
 */
export function exportRefusalFor(pkg: Pick<CandidatePackage, 'attestable' | 'checks'>): ExportRefusal | null {
  if (!pkg.attestable) return null;
  const status = (id: CheckId): string | undefined => pkg.checks.find((c) => c.id === id)?.status;
  if (status('INTEGRITY_LOCAL') !== 'PASS') return INTEGRITY_REFUSAL;
  const collector = status('COLLECTOR_HASH_MATCHES');
  if (collector === 'FAIL') return refuse('EXPORT_COLLECTOR_HASH_MISMATCH', 'Pacote atestável com o hash do coletor divergente não é entregue.');
  if (collector !== 'PASS') return refuse('EXPORT_COLLECTOR_HASH_REQUIRED', 'Pacote atestável sem o hash do coletor conferido não é entregue.');
  if (status('COLLECTION_GAP_WITHIN_LIMIT') !== 'PASS') return refuse('EXPORT_GAP_EXCEEDED', 'Pacote atestável fora da janela entre coleta e exportação não é entregue.');
  return null;
}

/** Delta informativo (fora do hash) contra as entradas do último manifesto: novas, com hash diferente e ausentes. */
export function computeDelta(entries: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>, sealed: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>): CandidateDelta {
  const now = new Map(entries.map((e) => [e.ref, e.contentSha256]));
  const before = new Map(sealed.map((e) => [e.ref, e.contentSha256]));
  const sorted = (refs: string[]): string[] => refs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    added: sorted([...now.keys()].filter((ref) => !before.has(ref))),
    changed: sorted([...now].filter(([ref, hash]) => before.has(ref) && before.get(ref) !== hash).map(([ref]) => ref)),
    missing: sorted([...before.keys()].filter((ref) => !now.has(ref))),
  };
}
