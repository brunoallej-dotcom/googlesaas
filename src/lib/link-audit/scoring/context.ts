import { canonicalJson } from '../canonical';
import { formatDay, parseDay, parseDayFromIso, relativeAgeBounds } from './dates';
import type { OperatorRecord, ProfileInput, ProfileKey, ScoredDate, ScoringEvidence, ScoringInput, ScoringOrigin } from './input';
import { combineBasis, EMPTY_BASIS, type Basis } from './results';
import { RULES } from './ruler';
import type { ConflictRecord, EvidenceGrade, ReasonCode, SubcriterionId } from './types';

export type ProfileValue<K extends ProfileKey> =
  NonNullable<ProfileInput[K]> extends ReadonlyArray<infer Item> ? (Item extends { value: infer Value } ? Value : never) : never;

export interface GroundOk {
  readonly ok: true;
  readonly basis: Basis;
}
export interface GroundFail {
  readonly ok: false;
  readonly reasonCode: ReasonCode;
  readonly reason: string;
}

export type Resolved<T> =
  | { readonly status: 'OK'; readonly value: T; readonly complete: boolean; readonly basis: Basis; readonly superseded: number }
  | { readonly status: 'CONFLICT' }
  | { readonly status: 'NONE'; readonly fail: GroundFail | null };

/** Subcritérios que dependem de cada campo do perfil (para associar conflitos). */
const FIELD_SUBS: Readonly<Record<ProfileKey, readonly SubcriterionId[]>> = {
  name: ['N1', 'N5'],
  address: ['N2', 'N5'],
  phone: ['N3', 'N5'],
  hours: ['N4', 'N5'],
  website: ['X1', 'X2', 'X4', 'X5'],
  primaryCategory: ['C1', 'C2'],
  additionalCategories: ['C3'],
  description: ['S1'],
  services: ['S2'],
  attributes: ['S3'],
  products: ['S4'],
  logoCover: ['V1'],
  photos: ['V2', 'V4'],
  videos: ['V3', 'V4'],
  latestMedia: ['V4'],
  reviews: ['R1', 'R2', 'R3', 'P1', 'P2', 'P3', 'L1', 'L2'],
  latestReviewDate: ['R3'],
  replies: ['P1', 'P2', 'P3'],
  posts: ['A1', 'A2', 'A3'],
  actions: ['X3'],
};

const PRIMARY_CAPTURES = new Set(['STORED_CAPTURE', 'OPERATOR_ATTACHMENT']);

/** Estado de uma execução do motor: evidências indexadas, campos resolvidos, conflitos e inconsistências. */
export class ScoringContext {
  readonly refDay: number;
  readonly referenceDate: string;
  readonly evidence: ReadonlyMap<string, ScoringEvidence>;
  readonly conflicts: ConflictRecord[] = [];
  readonly issues: string[] = [];
  private readonly cache = new Map<string, Resolved<unknown>>();

  constructor(readonly input: ScoringInput) {
    const day = parseDay(input.referenceDate);
    if (day === null) throw new Error('referenceDate inválida');
    this.refDay = day;
    this.referenceDate = input.referenceDate;
    this.evidence = new Map(input.evidences.map((item) => [item.id, item]));
  }

  evidenceDay(item: ScoringEvidence): number {
    const day = parseDayFromIso(item.observedAt);
    if (day === null) throw new Error('observedAt inválida');
    return day;
  }

  /**
   * Valida as evidências que sustentam um fato: VERIFICADA, de origem permitida para o subcritério, que não seja
   * relatório histórico em PDF e com no máximo 180 dias em relação ao snapshot. Fonte externa NUNCA comprova atributo
   * nativo: basta a origem não estar em `allowed`.
   */
  ground(ids: readonly string[], allowed: readonly ScoringOrigin[]): GroundOk | GroundFail {
    let grade: EvidenceGrade = 'PRIMARY';
    let maxAge = 0;
    for (const id of ids) {
      const item = this.evidence.get(id);
      if (!item) return { ok: false, reasonCode: 'NO_OBSERVATION', reason: `Evidência ${id} inexistente.` };
      if (item.status !== 'VERIFIED') {
        return { ok: false, reasonCode: 'EVIDENCE_NOT_VERIFIED', reason: `A evidência ${id} está como ${item.status} (evidência incompleta não fundamenta pontuação).` };
      }
      if (!allowed.includes(item.origin)) {
        return { ok: false, reasonCode: 'EVIDENCE_SOURCE_NOT_ALLOWED', reason: `A evidência ${id} tem origem ${item.origin}; este subcritério só aceita ${allowed.join(', ')} (fonte externa não comprova atributo nativo).` };
      }
      if (item.capture === 'PREVIOUS_AUDIT_PDF') {
        return { ok: false, reasonCode: 'HISTORICAL_ONLY', reason: `A evidência ${id} vem de relatório antigo em PDF: é histórica e não fundamenta pontos.` };
      }
      const age = this.refDay - this.evidenceDay(item);
      if (age > RULES.evidenceCannotGroundAfterDays) {
        return { ok: false, reasonCode: 'EVIDENCE_TOO_OLD', reason: `A evidência ${id} tem ${age} dias (mais de ${RULES.evidenceCannotGroundAfterDays}) em relação ao snapshot.` };
      }
      if (!PRIMARY_CAPTURES.has(item.capture)) grade = 'SECONDARY';
      if (age > maxAge) maxAge = age;
    }
    return { ok: true, basis: { ...EMPTY_BASIS, evidenceIds: [...ids].sort(), grade: ids.length === 0 ? 'NONE' : grade, maxAgeDays: ids.length === 0 ? null : maxAge } };
  }

  /**
   * Resolve um campo do perfil: descarta observações sem fundamento; a captura mais RECENTE prevalece (as antigas ficam
   * no histórico); duas capturas da mesma data com valores distintos são CONFLITO ABERTO (o campo vira Não verificado).
   */
  resolve<K extends ProfileKey>(key: K): Resolved<ProfileValue<K>> {
    const cached = this.cache.get(key);
    if (cached) return cached as Resolved<ProfileValue<K>>;
    const list = (this.input.profile?.[key] ?? []) as ReadonlyArray<{ evidenceIds: string[]; complete: boolean; value: unknown }>;
    const candidates: Array<{ item: (typeof list)[number]; basis: Basis; day: number }> = [];
    let fail: GroundFail | null = null;
    for (const item of list) {
      const grounded = this.ground(item.evidenceIds, ['GOOGLE_NATIVE']);
      if (!grounded.ok) {
        fail = fail ?? grounded;
        continue;
      }
      const day = Math.max(...item.evidenceIds.map((id) => this.evidenceDay(this.evidence.get(id) as ScoringEvidence)));
      candidates.push({ item, basis: grounded.basis, day });
    }
    let resolved: Resolved<unknown>;
    if (candidates.length === 0) {
      resolved = { status: 'NONE', fail };
    } else {
      const latest = Math.max(...candidates.map((candidate) => candidate.day));
      const top = candidates.filter((candidate) => candidate.day === latest);
      const distinct = new Set(top.map((candidate) => canonicalJson(candidate.item.value)));
      if (distinct.size > 1) {
        this.conflicts.push({
          field: `profile.${key}`,
          subcriteria: FIELD_SUBS[key],
          observations: top
            .map((candidate) => ({ evidenceIds: [...candidate.item.evidenceIds].sort(), observedAt: formatDay(candidate.day) }))
            .sort((a, b) => (a.evidenceIds.join() < b.evidenceIds.join() ? -1 : 1)),
        });
        resolved = { status: 'CONFLICT' };
      } else {
        const first = top[0];
        if (!first) throw new Error('observação ausente');
        resolved = {
          status: 'OK',
          value: first.item.value,
          complete: top.every((candidate) => candidate.item.complete),
          basis: combineBasis(...top.map((candidate) => candidate.basis)),
          superseded: candidates.length - top.length,
        };
      }
    }
    this.cache.set(key, resolved);
    return resolved as Resolved<ProfileValue<K>>;
  }

  records<K extends OperatorRecord['kind']>(kind: K): Array<Extract<OperatorRecord, { kind: K }>> {
    return (this.input.operatorRecords ?? []).filter((record): record is Extract<OperatorRecord, { kind: K }> => record.kind === kind);
  }

  judgement(sid: 'C2' | 'C3' | 'P3'): Extract<OperatorRecord, { kind: 'JUDGEMENT' }> | null {
    return this.records('JUDGEMENT').find((record) => record.subcriterionId === sid) ?? null;
  }

  /** O escopo do site é suficiente para a ausência/faixa intermediária do subcritério? (escopo + atestado do operador). */
  siteScopeSufficient(sid: SubcriterionId): { readonly sufficient: boolean; readonly attestationId: string | null } {
    const kind = this.input.site?.scope.kind;
    if (kind !== 'SITEMAP_COMPLETE' && kind !== 'DOCUMENTED_FULL_REVIEW') return { sufficient: false, attestationId: null };
    const attestation = this.records('SITE_SCOPE_ATTESTATION').find((record) => record.subcriterionIds.includes(sid));
    return attestation ? { sufficient: true, attestationId: attestation.id } : { sufficient: false, attestationId: null };
  }

  /** Limites de idade (em dias) de uma data exata ou relativa em relação ao snapshot. */
  ageBounds(date: ScoredDate): { readonly lo: number; readonly hi: number } {
    if (date.kind === 'RELATIVE') return relativeAgeBounds(date.amount, date.unit);
    const day = parseDay(date.date);
    if (day === null) throw new Error('data inválida');
    const age = this.refDay - day;
    return { lo: age, hi: age };
  }

  reject(message: string): void {
    this.issues.push(message);
  }
}
