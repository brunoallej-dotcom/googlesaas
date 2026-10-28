import type { ReviewsFetchOutcome } from '../../serper-reviews';
import type { SiteAccessClass, SiteCheckOutcome } from './site-access';
import type { CompanyIdentity, CriterionAssessment } from '../audit';
import type { Evidence } from '../evidence';
import type { MapsIdentifiers } from '../maps-link';
import type { CallLedger } from './budget';

/*
 * Tipos do motor de coleta da Auditoria por Link (Fase 6, Onda 4A).
 * Os provedores são INTERFACES injetadas: nesta onda só existem provedores simulados (testes). Nenhum
 * código aqui acessa rede, ambiente ou relógio.
 */

export type ProviderId = 'serper-maps' | 'serper-reviews' | 'site-check';

/** Quantas chamadas cada fonte pode receber numa coleta. Nunca é excedido. */
export interface CallBudget {
  readonly maps: number;
  readonly reviews: number;
  readonly site: number;
}

export interface CallUsage {
  readonly maps: number;
  readonly reviews: number;
  readonly site: number;
}

export interface Viewport {
  readonly latitude: number;
  readonly longitude: number;
  readonly zoom: number | null;
}

export interface MapsSearchRequest {
  /** Texto da busca (nome informado pelo operador ou dica não verificada do link, mais cidade/UF). */
  readonly query: string;
  readonly viewport: Viewport | null;
  /**
   * CID decimal a enviar como parâmetro de entrada. O coletor NUNCA preenche isto enquanto a estratégia
   * IDENTIFIER_PARAMS estiver desligada (parâmetro não confirmado); o adaptador só o repassa se vier.
   */
  readonly cid?: string;
}

/** `reason` de falhas já vem saneado (sem URLs completas, chaves ou tokens). */
export type ProviderOutcome<T> =
  | { readonly state: 'OK'; readonly value: T; readonly fetchedAt: string }
  | { readonly state: 'DISABLED'; readonly reason: string }
  | { readonly state: 'FAILED'; readonly reason: string };

/** Busca no Serper `/maps`. Devolve os itens crus; o coletor valida e casa por identificador. */
export interface MapsProvider {
  /** Provedor que faz tráfego externo real; recusado fora do modo LIVE. */
  readonly live?: true;
  search(request: MapsSearchRequest): Promise<ProviderOutcome<readonly unknown[]>>;
}

export interface ReviewsProvider {
  /** Busca avaliações datadas (cada página é uma chamada cobrada). Nome sem "fetch" de propósito: o módulo não faz rede. */
  getReviews(
    identifiers: { readonly featureId: string | null; readonly placeId: string | null; readonly cid: string | null },
    /** Teto de páginas (= orçamento). O provedor real DEVE respeitá-lo: cada página é uma chamada cobrada. */
    options: { readonly maxPages: number },
  ): Promise<ReviewsFetchOutcome>;
}

export interface SiteProvider {
  /** Provedor que faz tráfego externo real; recusado fora do modo LIVE. */
  readonly live?: true;
  check(url: string): Promise<SiteCheckOutcome>;
}

export interface CollectorProviders {
  readonly maps?: MapsProvider;
  readonly reviews?: ReviewsProvider;
  readonly site?: SiteProvider;
}

export interface CollectionInput {
  readonly snapshotId: string;
  readonly link: {
    readonly originalLink: string;
    readonly resolved: { readonly url: string; readonly resolvedAt: string; readonly method: 'REDIRECT_CHAIN' } | null;
  };
  /** Identidade já confirmada pelo operador (identificadores + confirmação). */
  readonly identity: CompanyIdentity;
}

export interface CollectionOptions {
  readonly budget: CallBudget;
  /** Relógio injetado (o módulo não lê o relógio por conta própria). */
  readonly now: () => Date;
  /** Prazo por chamada a provedor, em ms (padrão 30 000; máximo 120 000). Estourou, a fonte conta como falha. */
  readonly providerTimeoutMs?: number;
  /** Razão de chamadas (Onda 4B): cada chamada é reservada ANTES de ser feita e nunca repetida. */
  readonly ledger?: CallLedger;
}

export type LocateState = 'MATCHED' | 'NOT_LOCATED' | 'AMBIGUOUS' | 'NOT_ATTEMPTED';

/** Dados do perfil entregues pelo Serper /maps (intermediário). Texto já limpo; site já saneado. */
export interface ProfileSummary {
  readonly name: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly category: string | null;
  readonly secondaryCategories: readonly string[];
  readonly rating: number | null;
  readonly ratingCount: number | null;
  readonly openingHours: readonly (readonly [string, string])[];
}

/** O que foi observado no PRÓPRIO site (nunca confundir com o perfil do Google). */
export interface SiteObservation {
  readonly requestedUrl: string | null;
  readonly finalUrl: string | null;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly redirects: number;
  readonly checkedAt: string;
  readonly noindex: boolean | null;
  readonly robotsTxt: string;
  /** Classe do acesso (o que foi observado) e a nota correspondente; nunca "exige login" sem evidência. */
  readonly accessClass: SiteAccessClass;
  readonly accessNote: string;
  /** Requisições HTTP feitas (quando registradas). */
  readonly httpRequests: number | null;
  readonly authChallenge: boolean | null;
  readonly telLinks: number;
  readonly whatsappLinks: number;
  readonly emailLinks: number;
  readonly declaredName: string | null;
  readonly declaredTelephone: string | null;
  readonly declaredTypes: readonly string[];
}

/** Como a identidade da empresa foi (ou não) confirmada. Nunca por nome. */
export interface IdentityBasis {
  /** CID esperado e sua origem: `DERIVED_FROM_FID` = conversão offline do FID do link (não veio de API). */
  readonly expectedCid: { readonly value: string; readonly origin: 'LINK' | 'DERIVED_FROM_FID' } | null;
  /** Preenchido só quando o perfil foi aceito. */
  readonly matchedBy: {
    readonly cid: boolean;
    readonly placeId: boolean;
    /** CID comprovado (decimal) quando o perfil foi aceito por CID; rotulado pela origem em `expectedCid`/`resultCidSource`. */
    readonly provenCid: string | null;
    /** O resultado trouxe o `cid`, só o `fid` (de que se derivou o CID) ou ambos. */
    readonly resultCidSource: 'cid' | 'fid' | 'cid+fid' | null;
  } | null;
}

/** Um identificador efetivamente COMPARADO com o que o provedor devolveu e confirmado. */
export interface ConfirmedIdentifier {
  readonly type: 'cid' | 'placeId' | 'featureId';
  readonly value: string;
  /** De onde veio o valor esperado: do link ou derivado do FID do link (conversão offline). */
  readonly expectedOrigin: 'LINK' | 'DERIVED_FROM_FID';
  /** Campos do resultado do provedor usados na comparação (`fid (2ª metade)` = CID derivado do fid do resultado). */
  readonly providerFields: readonly string[];
  readonly result: 'EQUAL';
}

/** Quatro coisas distintas: o que o link trazia, o que foi derivado, o que o provedor devolveu e o que foi confirmado. */
export interface IdentifierReport {
  readonly fromLink: MapsIdentifiers;
  readonly derived: { readonly cid?: { readonly value: string; readonly derivedFrom: 'featureId'; readonly method: string } };
  /** Identificadores do resultado ACEITO (nada se o perfil não foi aceito). */
  readonly returnedByProvider: MapsIdentifiers | null;
  readonly confirmed: readonly ConfirmedIdentifier[];
}

export interface Divergence {
  readonly field: 'telefone' | 'nome' | 'dominio';
  readonly googleMaps: string;
  readonly site: string;
  readonly note: string;
}

export interface CollectionResult {
  readonly evidences: readonly Evidence[];
  readonly criteria: readonly CriterionAssessment[];
  readonly limitations: readonly string[];
  readonly usage: CallUsage;
  readonly located: LocateState;
  readonly collectedAt: string;
  /** Identificadores do link que o provedor devolveu E que conferem com o perfil escolhido. */
  readonly provenIdentifiers: MapsIdentifiers;
  readonly identityBasis: IdentityBasis;
  readonly identifiers: IdentifierReport;
  readonly profile: ProfileSummary | null;
  readonly siteObservation: SiteObservation | null;
  readonly divergences: readonly Divergence[];
  readonly queriedAt: { readonly maps: string | null; readonly site: string | null };
}

export type CollectionOutcome =
  | { readonly ok: true; readonly result: CollectionResult }
  | { readonly ok: false; readonly code: 'IDENTITY_NOT_CONFIRMED' | 'IDENTITY_MISMATCH' | 'INVALID_BUDGET'; readonly issues: readonly string[] };
