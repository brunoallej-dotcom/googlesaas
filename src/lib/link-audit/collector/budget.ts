import type { MapsIdentifiers } from '../maps-link';
import type { ProviderId } from './types';

/*
 * Orçamento, razão de chamadas e autorização de consumo da Auditoria por Link (Onda 4B).
 * Módulo PURO: sem rede, ambiente nem relógio implícito (o relógio entra por parâmetro).
 *
 * Princípios: falhar fechado; registrar cada tentativa ANTES da chamada; nenhuma chamada é repetida
 * (uma tentativa que falhou continua gastando o orçamento); LIVE só com autorização explícita.
 */

export type CollectionMode = 'DRY_RUN' | 'SIMULATED' | 'LIVE';

/** Tetos absolutos do modo LIVE, independentes do que a autorização peça. */
export const LIVE_HARD_LIMITS = { maps: 1, reviews: 0, siteHttpRequests: 8 } as const;
/** Uma autorização vale no máximo por 24 horas. */
export const MAX_AUTHORIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type LedgerStatus = 'planned' | 'simulated' | 'sent' | 'ok' | 'failed' | 'denied';

export interface LedgerEntry {
  readonly provider: ProviderId;
  readonly status: LedgerStatus;
  readonly at: string;
  readonly note?: string;
}

export interface LedgerSummary {
  readonly planned: number;
  readonly simulated: number;
  readonly sent: number;
  readonly ok: number;
  readonly failed: number;
  readonly denied: number;
}

export type Reservation =
  | { readonly ok: true; readonly index: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Razão de chamadas. `limits` é o máximo de TENTATIVAS por fonte. `reserve` deve ser chamado imediatamente
 * antes da chamada; `settle` registra o desfecho. Não existe repetição automática: depois de uma tentativa que
 * falhou, a fonte fica bloqueada mesmo que sobre orçamento.
 */
export class CallLedger {
  private readonly entries: LedgerEntry[] = [];
  private readonly failed = new Set<ProviderId>();

  constructor(
    private readonly mode: CollectionMode,
    private readonly limits: Readonly<Record<ProviderId, number>>,
    private readonly now: () => Date,
  ) {}

  get externalTraffic(): boolean {
    return this.entries.some((entry) => entry.status === 'sent');
  }

  private attempts(provider: ProviderId): number {
    return this.entries.filter((entry) => entry.provider === provider && (entry.status === 'simulated' || entry.status === 'sent')).length;
  }

  private record(provider: ProviderId, status: LedgerStatus, note?: string): number {
    this.entries.push({ provider, status, at: this.now().toISOString(), ...(note ? { note } : {}) });
    return this.entries.length - 1;
  }

  /** Registra a intenção (DRY_RUN) sem permitir a chamada. */
  plan(provider: ProviderId): void {
    if (this.attempts(provider) + this.entries.filter((e) => e.provider === provider && e.status === 'planned').length < (this.limits[provider] ?? 0)) {
      this.record(provider, 'planned');
    }
  }

  reserve(provider: ProviderId): Reservation {
    if (this.mode === 'DRY_RUN') {
      this.record(provider, 'denied', 'modo DRY_RUN: nenhuma chamada é feita');
      return { ok: false, reason: 'modo DRY_RUN: nenhuma chamada é feita' };
    }
    if (this.failed.has(provider)) {
      this.record(provider, 'denied', 'a tentativa anterior falhou e não é repetida');
      return { ok: false, reason: 'a tentativa anterior falhou e não é repetida automaticamente' };
    }
    const limit = this.limits[provider] ?? 0;
    if (this.attempts(provider) >= limit) {
      this.record(provider, 'denied', 'limite de chamadas atingido');
      return { ok: false, reason: limit === 0 ? 'orçamento igual a zero' : 'limite de chamadas atingido' };
    }
    return { ok: true, index: this.record(provider, this.mode === 'LIVE' ? 'sent' : 'simulated') };
  }

  settle(reservation: Reservation, outcome: 'ok' | 'failed', note?: string): void {
    if (!reservation.ok) return;
    const provider = this.entries[reservation.index]?.provider;
    if (!provider) return;
    this.record(provider, outcome, note);
    if (outcome === 'failed') this.failed.add(provider);
  }

  list(): readonly LedgerEntry[] {
    return [...this.entries];
  }

  summary(): Readonly<Record<ProviderId, LedgerSummary>> {
    const empty = (): { -readonly [K in keyof LedgerSummary]: number } => ({ planned: 0, simulated: 0, sent: 0, ok: 0, failed: 0, denied: 0 });
    const out: Record<ProviderId, { -readonly [K in keyof LedgerSummary]: number }> = {
      'serper-maps': empty(),
      'serper-reviews': empty(),
      'site-check': empty(),
    };
    for (const entry of this.entries) out[entry.provider][entry.status] += 1;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------
// Autorização de consumo (somente LIVE)
// ---------------------------------------------------------------------------------------------------

export interface ConsumptionAuthorization {
  readonly authorizationId: string;
  /** Auditoria à qual a autorização pertence. */
  readonly snapshotId: string;
  /** Impressão dos identificadores da empresa autorizada (ver `identifiersFingerprint`). */
  readonly identifiersFingerprint: string;
  readonly maxMapsCalls: number;
  readonly maxSiteHttpRequests: number;
  readonly expiresAt: string;
  /** O operador viu a estimativa de custo e a aceitou. */
  readonly costAcknowledged: boolean;
  readonly operator: string;
}

/** Texto canônico dos identificadores: a autorização só vale para esta empresa. */
export function identifiersFingerprint(ids: MapsIdentifiers): string {
  return `cid=${ids.cid ?? ''}|fid=${ids.featureId ?? ''}|pid=${ids.placeId ?? ''}`;
}

export type AuthorizationDecision =
  | { readonly ok: true; readonly effective: { readonly maps: number; readonly siteHttpRequests: number } }
  | { readonly ok: false; readonly code: AuthorizationDenial; readonly reason: string };

export type AuthorizationDenial =
  | 'LIVE_DISABLED'
  | 'NO_AUTHORIZATION'
  | 'INVALID_AUTHORIZATION'
  | 'EXPIRED'
  | 'WRONG_AUDIT'
  | 'WRONG_COMPANY'
  | 'COST_NOT_ACKNOWLEDGED'
  | 'LIMIT_ABOVE_AUTHORIZED'
  | 'ALREADY_USED';

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface AuthorizationContext {
  /** A trava de ambiente do LIVE está ligada? (lida fora deste módulo) */
  readonly liveEnabled: boolean;
  readonly snapshotId: string;
  readonly identifiers: MapsIdentifiers;
  readonly now: Date;
  readonly requested: { readonly maps: number; readonly siteHttpRequests: number };
  /** Autorização já consumida antes (memória ou marcador exclusivo em disco)? */
  readonly isUsed: (authorizationId: string) => boolean;
}

/** Decide se uma coleta LIVE pode começar. Falha fechada: qualquer dúvida ⇒ recusa com o motivo. */
export function evaluateAuthorization(authorization: unknown, context: AuthorizationContext): AuthorizationDecision {
  const deny = (code: AuthorizationDenial, reason: string): AuthorizationDecision => ({ ok: false, code, reason });
  if (!context.liveEnabled) return deny('LIVE_DISABLED', 'O modo LIVE está desligado (variável de ambiente de autorização ausente).');
  if (!authorization || typeof authorization !== 'object') return deny('NO_AUTHORIZATION', 'Não há autorização de consumo.');

  const auth = authorization as Partial<Record<keyof ConsumptionAuthorization, unknown>>;
  const wellFormed =
    typeof auth.authorizationId === 'string' && ID.test(auth.authorizationId) &&
    typeof auth.snapshotId === 'string' && auth.snapshotId.length > 0 &&
    typeof auth.identifiersFingerprint === 'string' &&
    Number.isInteger(auth.maxMapsCalls) && Number.isInteger(auth.maxSiteHttpRequests) &&
    (auth.maxMapsCalls as number) >= 0 && (auth.maxSiteHttpRequests as number) >= 0 &&
    typeof auth.expiresAt === 'string' && ISO.test(auth.expiresAt) &&
    typeof auth.operator === 'string' && auth.operator.length > 0;
  if (!wellFormed) return deny('INVALID_AUTHORIZATION', 'A autorização de consumo está incompleta ou malformada.');
  const checked = auth as unknown as ConsumptionAuthorization;

  if (checked.costAcknowledged !== true) return deny('COST_NOT_ACKNOWLEDGED', 'O operador não confirmou a ciência da estimativa de custo.');
  const expires = Date.parse(checked.expiresAt);
  const now = context.now.getTime();
  if (!Number.isFinite(expires) || expires <= now) return deny('EXPIRED', 'A autorização de consumo está vencida.');
  if (expires - now > MAX_AUTHORIZATION_WINDOW_MS) return deny('INVALID_AUTHORIZATION', 'A validade da autorização excede 24 horas.');
  if (checked.snapshotId !== context.snapshotId) return deny('WRONG_AUDIT', 'A autorização pertence a outra auditoria.');
  if (checked.identifiersFingerprint !== identifiersFingerprint(context.identifiers)) {
    return deny('WRONG_COMPANY', 'A autorização foi emitida para outra empresa.');
  }
  if (context.requested.maps > checked.maxMapsCalls || context.requested.siteHttpRequests > checked.maxSiteHttpRequests) {
    return deny('LIMIT_ABOVE_AUTHORIZED', 'O consumo pedido excede o que foi autorizado.');
  }
  if (context.isUsed(checked.authorizationId)) return deny('ALREADY_USED', 'Esta autorização já foi usada; cada autorização vale para uma única coleta.');

  return {
    ok: true,
    effective: {
      maps: Math.min(context.requested.maps, checked.maxMapsCalls, LIVE_HARD_LIMITS.maps),
      siteHttpRequests: Math.min(context.requested.siteHttpRequests, checked.maxSiteHttpRequests, LIVE_HARD_LIMITS.siteHttpRequests),
    },
  };
}
