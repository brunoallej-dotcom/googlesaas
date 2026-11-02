import path from 'node:path';
import { companyIdentitySchema } from '../link-audit/audit';
import { matchPlace, parseMapsPlaces, type MapsPlace } from '../link-audit/collector/maps-place';
import { nodeFsOps } from '../link-audit/snapshot-store';
import { sanitizeForOutput } from '../link-audit/url-redaction';
import { deriveWebsite, type WebsiteDerivation } from './derive-url';
import { integrityInfo, readLegacyAudit } from './legacy';
import { EvidenceAccessError, type EvidenceActor, type EvidenceReaderOptions, type IntegrityInfo } from './reader';
import { locate, readCapture, readReport, verifyAudit } from './store';
import { pad, type CaptureFile } from './types';

/*
 * Base de pontuação (Onda 6C, I1): a projeção, SOMENTE NO SERVIDOR, do que as evidências armazenadas e ÍNTEGRAS permitem
 * entregar ao mapeador do Motor Lumos (I2). Este módulo NÃO pontua, NÃO mapeia para o `ScoringInput`, NÃO grava e NÃO
 * decide nada: só lê, verifica e descreve, com proveniência (referência, data de observação, SHA-256).
 *
 * Regras (spec §9, §23 I1):
 *  - Nada é devolvido se qualquer arquivo da coleta não confere (`INTEGRITY_FAILED`), se não há captura com relatório
 *    (`NO_EVIDENCE`) ou se a auditoria não existe (`NOT_FOUND`). Nesses casos não sai nenhum dado de perfil nem hash.
 *  - Nada é inferido: campo ausente é `null`; não existe `complete`, zero por ausência nem lista vazia fabricada.
 *  - O perfil só existe se a identidade confirmada pelo operador casar com o corpo por CID/placeId (nome nunca confirma).
 *  - O website bruto NUNCA sai daqui: sai a URL derivada mínima, o SHA-256 do bruto e a referência à evidência de origem.
 *  - M-4a (modo estrito): nota e contagem de avaliações saem SOMENTE em `informational.reviews`, rotuladas como excluídas
 *    do cálculo. O mapeador não pode lê-las.
 *  - Corpo bruto, `request`, link original, cabeçalhos e caminhos de disco nunca aparecem na saída.
 */

export const SCORING_BASIS_VERSION = 'scoring-basis-v1' as const;
/** Referência do status do provedor do layout legado. */
export const legacyStatusRef = (capture: number): string => `legacy-status:c${String(capture).padStart(4, '0')}`;

export interface BasisEvidence {
  /** Mesmos identificadores que a 6B aceita nas decisões: `capture:c0001` · `report:c0001-r0001`. */
  readonly ref: string;
  readonly kind: 'CAPTURE' | 'REPORT';
  readonly capture: number;
  readonly revision: number | null;
  /** Dia da coleta da captura (também para o relatório: nunca a data de geração). */
  readonly observedAt: string;
  readonly generatedAt: string | null;
  /** Hash selado do arquivo (legado: SHA-256 do arquivo conferido contra o SHA256SUMS / hash declarado). */
  readonly contentSha256: string;
  /** Hash do corpo do provedor (captura); `null` no relatório. */
  readonly bodySha256: string | null;
  /** Relatório com uma revisão posterior. */
  readonly superseded: boolean;
  readonly legacy: boolean;
  /** O Serper é um intermediário: o `GOOGLE_NATIVE` do contrato do motor não significa API oficial do Google. */
  readonly origin: 'GOOGLE_NATIVE';
  readonly provider: 'serper-maps';
  readonly intermediary: true;
}

export interface BasisSource {
  readonly ref: string;
  readonly observedAt: string;
  readonly contentSha256: string;
  readonly bodySha256: string;
}

export interface BasisWebsite {
  readonly state: WebsiteDerivation['state'];
  /** URL mínima derivada (ver `derive-url.ts`); `null` se o bruto não pôde ser interpretado. */
  readonly derived: string | null;
  readonly utm: WebsiteDerivation['utm'];
  readonly unparsableReason: string | null;
  readonly derivation: {
    readonly rule: WebsiteDerivation['rule'];
    /** SHA-256 do texto do website bruto (após `trim`): permite conferir contra a captura sem guardar a URL. */
    readonly rawSha256: string;
    readonly sourceEvidence: BasisSource;
  };
}

export type EvidenceFieldStatus = 'VERIFIED' | 'PARTIAL' | 'NOT_VERIFIED' | 'NOT_FOUND';

export interface BasisProfile {
  readonly state: 'AVAILABLE';
  readonly source: BasisSource;
  readonly identity: {
    readonly state: 'PROVEN';
    readonly matchedBy: { readonly cid: boolean; readonly placeId: boolean };
    readonly expectedCidOrigin: 'LINK' | 'DERIVED_FROM_FID' | null;
  };
  readonly name: string | null;
  readonly phone: string | null;
  readonly primaryCategory: string | null;
  /** Lista como OBSERVADA no perfil (até 10, sem duplicatas); `null` = nenhuma observada. A completude NÃO é comprovada (nunca tratar como completa). */
  readonly additionalCategories: readonly string[] | null;
  readonly address: { readonly raw: string } | null;
  readonly hoursRaw: string | null;
  readonly website: BasisWebsite | null;
  /** Status das evidências `maps-*` do relatório mais recente daquela captura (ausente = o relatório não a trouxe). */
  readonly reportEvidence: Readonly<Record<string, EvidenceFieldStatus>>;
}

export type ProfileUnavailableReason =
  | 'NO_USABLE_CAPTURE'
  | 'BODY_UNREADABLE'
  | 'IDENTITY_NOT_CONFIRMED'
  | 'NOT_LOCATED'
  | 'AMBIGUOUS_IDENTITY';

export interface BasisProfileUnavailable {
  readonly state: 'UNAVAILABLE';
  readonly reason: ProfileUnavailableReason;
}

export interface InformationalReviews {
  /** Nota e contagem COMO LIDAS no perfil casado; inteiro ≥ 0 ou `null`. NÃO alimentam o motor (M-4a estrita). */
  readonly rating: number | null;
  readonly ratingCount: number | null;
  readonly scoringUse: 'EXCLUDED_M4A';
  readonly reason: string;
  readonly source: Omit<BasisSource, 'bodySha256'>;
}

/**
 * Artefato que INFLUENCIA a leitura mas não é captura nem relatório (hoje: o `serper-status.json` do layout legado, que decide se há perfil utilizável).
 * Não é evidência do resultado (não entra nos registros), mas ENTRA na prova de coleta: sem o hash dele no manifesto assinado, a base não é autêntica.
 */
export interface BasisArtifact {
  readonly ref: string;
  readonly contentSha256: string;
  readonly legacy: boolean;
}

export interface ScoringBasis {
  readonly version: typeof SCORING_BASIS_VERSION;
  readonly auditId: string;
  readonly layout: 'VERSIONED' | 'LEGACY';
  readonly evidences: readonly BasisEvidence[];
  /** Artefatos que influenciam a base e precisam ser autenticados junto (R3-MINOR-3). Ausente/vazio no layout versionado. */
  readonly artifacts?: readonly BasisArtifact[];
  readonly profile: BasisProfile | BasisProfileUnavailable;
  readonly informational: { readonly reviews: InformationalReviews | null };
}

export type ScoringBasisOutcome =
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'NO_EVIDENCE'; readonly integrity: IntegrityInfo }
  | { readonly status: 'INTEGRITY_FAILED'; readonly integrity: IntegrityInfo }
  | { readonly status: 'READY'; readonly basis: ScoringBasis };

export const INFORMATIONAL_REVIEWS_REASON = 'Semântica de completude da contagem de avaliações não comprovada (M-4a): informativo, fora do cálculo.';
const MAPS_FIELD_IDS = ['maps-name', 'maps-address', 'maps-phone', 'maps-hours', 'maps-category', 'maps-website'] as const;
const FIELD_STATUSES: readonly string[] = ['VERIFIED', 'PARTIAL', 'NOT_VERIFIED', 'NOT_FOUND'];
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
/** Formato E data real (`2026-13-45T99:99:99Z` passaria só na regex). */
const validIso = (value: string | null): value is string => value !== null && ISO.test(value) && !Number.isNaN(Date.parse(value));

const captureRef = (n: number): string => `capture:c${pad(n)}`;
const reportRef = (n: number, r: number): string => `report:c${pad(n)}-r${pad(r)}`;
const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function reportEvidenceOf(report: Record<string, unknown> | null): Record<string, EvidenceFieldStatus> {
  const out: Record<string, EvidenceFieldStatus> = {};
  if (!report || !Array.isArray(report.evidences)) return out;
  for (const entry of report.evidences) {
    const e = rec(entry);
    const id = str(e.id);
    const status = str(e.status);
    if (id && (MAPS_FIELD_IDS as readonly string[]).includes(id) && status && FIELD_STATUSES.includes(status) && out[id] === undefined) out[id] = status as EvidenceFieldStatus;
  }
  return out;
}

interface ProfileInput {
  readonly source: BasisSource;
  readonly bodyText: string;
  /** Identidade candidata, ainda não validada (vem do arquivo; nunca é confiada sem o esquema). */
  readonly identityCandidate: unknown;
  readonly report: Record<string, unknown> | null;
  /**
   * USO INTERNO (recheca do I4): recebe o texto do website BRUTO do lugar casado. O valor nunca sai deste módulo: quem o recebe é
   * `verifyWebsiteDerivation`, que devolve só um veredito.
   */
  readonly onRawWebsite?: (raw: string | null) => void;
}

/** Perfil + dado informativo, a partir do corpo ÍNTEGRO de UMA captura. Puro. */
export function profileFromBody(input: ProfileInput): { profile: BasisProfile | BasisProfileUnavailable; reviews: InformationalReviews | null } {
  const unavailable = (reason: ProfileUnavailableReason): { profile: BasisProfileUnavailable; reviews: null } => ({ profile: { state: 'UNAVAILABLE', reason }, reviews: null });
  const identity = companyIdentitySchema.safeParse(input.identityCandidate);
  if (!identity.success || identity.data.confirmation === undefined) return unavailable('IDENTITY_NOT_CONFIRMED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    return unavailable('BODY_UNREADABLE');
  }
  const places = rec(parsed).places;
  if (!Array.isArray(places)) return unavailable('BODY_UNREADABLE');
  const matched = matchPlace(parseMapsPlaces(places).places, identity.data.identifiers);
  if (matched.state === 'NOT_LOCATED') return unavailable('NOT_LOCATED');
  if (matched.state === 'AMBIGUOUS') return unavailable('AMBIGUOUS_IDENTITY');
  const place: MapsPlace = matched.place;
  input.onRawWebsite?.(place.website);

  const website: BasisWebsite | null =
    place.website === null
      ? null
      : ((derivation) => ({
          state: derivation.state,
          derived: derivation.derived,
          utm: derivation.utm,
          unparsableReason: derivation.state === 'UNPARSABLE' ? derivation.reason : null,
          derivation: { rule: derivation.rule, rawSha256: derivation.rawSha256, sourceEvidence: input.source },
        }))(deriveWebsite(place.website));

  return {
    profile: {
      state: 'AVAILABLE',
      source: input.source,
      identity: { state: 'PROVEN', matchedBy: { cid: matched.basis.cid, placeId: matched.basis.placeId }, expectedCidOrigin: matched.basis.expectedCidOrigin },
      name: place.title,
      phone: place.phone,
      primaryCategory: place.category,
      additionalCategories: place.secondaryCategories.length > 0 ? [...new Set(place.secondaryCategories)] : null,
      address: place.address === null ? null : { raw: place.address },
      hoursRaw: place.openingHours.length > 0 ? place.openingHours.map(([day, hours]) => `${day}: ${hours}`).join('; ') : null,
      website,
      reportEvidence: reportEvidenceOf(input.report),
    },
    reviews: {
      rating: place.rating,
      ratingCount: place.ratingCount,
      scoringUse: 'EXCLUDED_M4A',
      reason: INFORMATIONAL_REVIEWS_REASON,
      source: { ref: input.source.ref, observedAt: input.source.observedAt, contentSha256: input.source.contentSha256 },
    },
  };
}

export function createScoringBasisReader(options: EvidenceReaderOptions) {
  const ops = options.fs ?? nodeFsOps;
  const projectRoot = options.projectRoot ?? process.cwd();
  const storeOptions = { fs: ops, projectRoot };

  async function guard(actor: EvidenceActor): Promise<void> {
    let allowed = false;
    try {
      allowed = Boolean(actor && typeof actor.email === 'string' && actor.email.length > 0 && (await options.authorize(actor)));
    } catch {
      allowed = false; // falha fechada
    }
    if (!allowed) throw new EvidenceAccessError();
  }

  const failed = (info: IntegrityInfo): ScoringBasisOutcome => ({ status: 'INTEGRITY_FAILED', integrity: { ...info, issues: sanitizeForOutput(info.issues) as string[] } });

  async function readVersioned(auditId: string, onRawWebsite?: (raw: string | null) => void): Promise<ScoringBasisOutcome> {
    const verification = await verifyAudit(options.baseDir, auditId, storeOptions);
    if (!verification.ok) {
      if (verification.code === 'NOT_FOUND') return { status: 'NOT_FOUND' };
      return failed(integrityInfo('MISMATCH', 0, ['Não foi possível ler a pasta da auditoria.']));
    }
    const { state, captures, reports, issues } = verification.value;
    const info = integrityInfo(state === 'CORRUPT' ? 'MISMATCH' : state === 'COMPLETE' ? 'OK' : 'INCOMPLETE', captures.length + reports.length, issues);
    if (state === 'CORRUPT') return failed(info);
    if (state === 'INCOMPLETE') return { status: 'NO_EVIDENCE', integrity: info };

    const evidences: BasisEvidence[] = [];
    const files = new Map<number, CaptureFile>();
    for (const n of captures) {
      const capture = await readCapture(options.baseDir, auditId, n, storeOptions);
      if (!capture.ok) return failed(integrityInfo('MISMATCH', captures.length + reports.length, [`Captura ${n}: ${capture.issues.join(' ')}`]));
      files.set(n, capture.value);
      evidences.push({
        ref: captureRef(n),
        kind: 'CAPTURE',
        capture: n,
        revision: null,
        observedAt: capture.value.collectedAt,
        generatedAt: null,
        contentSha256: capture.value.contentSha256,
        bodySha256: capture.value.response.bodySha256,
        superseded: false,
        legacy: false,
        origin: 'GOOGLE_NATIVE',
        provider: 'serper-maps',
        intermediary: true,
      });
    }
    // Revisões de relatório contíguas (1..n) por captura: lacuna = arquivo removido.
    for (const n of captures) {
      const revisions = reports.filter((r) => r.capture === n).map((r) => r.revision).sort((a, b) => a - b);
      if (revisions.some((revision, index) => revision !== index + 1)) return failed(integrityInfo('MISMATCH', captures.length + reports.length, [`Lacuna na numeração dos relatórios da captura ${n}.`]));
    }
    // Todas as capturas da auditoria têm de ser da MESMA empresa (identificadores confirmados iguais).
    const identityKeys = new Set<string>();
    for (const file of files.values()) {
      const parsed = companyIdentitySchema.safeParse(file.input.identity);
      if (parsed.success) identityKeys.add(JSON.stringify([parsed.data.identifiers.cid ?? null, parsed.data.identifiers.featureId ?? null, parsed.data.identifiers.placeId ?? null]));
    }
    if (identityKeys.size > 1) return failed(integrityInfo('MISMATCH', captures.length + reports.length, ['As capturas desta auditoria têm identidades diferentes.']));
    const reportFiles = new Map<string, Record<string, unknown>>();
    for (const r of reports) {
      const file = await readReport(options.baseDir, auditId, r.capture, r.revision, storeOptions);
      const owner = files.get(r.capture);
      if (!file.ok || !owner) return failed(integrityInfo('MISMATCH', captures.length + reports.length, [`Relatório ${r.capture}/r${r.revision}: ${file.ok ? 'sem captura correspondente.' : file.issues.join(' ')}`]));
      // vínculo reconferido NESTA leitura (a verificação anterior e esta são leituras distintas)
      if (file.value.captureSha256 !== owner.contentSha256) return failed(integrityInfo('MISMATCH', captures.length + reports.length, [`Relatório ${r.capture}/r${r.revision} não pertence à captura lida.`]));
      reportFiles.set(reportRef(r.capture, r.revision), rec(file.value.report));
      evidences.push({
        ref: reportRef(r.capture, r.revision),
        kind: 'REPORT',
        capture: r.capture,
        revision: r.revision,
        observedAt: owner.collectedAt,
        generatedAt: file.value.generatedAt,
        contentSha256: file.value.contentSha256,
        bodySha256: null,
        superseded: r.revision < Math.max(...reports.filter((x) => x.capture === r.capture).map((x) => x.revision)),
        legacy: false,
        origin: 'GOOGLE_NATIVE',
        provider: 'serper-maps',
        intermediary: true,
      });
    }

    // Perfil: SOMENTE da captura mais recente (maior data de coleta; empate pelo número) com resposta utilizável (HTTP 2xx e corpo
    // presente); nunca mistura capturas. O consumidor deve usar `profile.source` como fonte da data de referência.
    let profile: BasisProfile | BasisProfileUnavailable = { state: 'UNAVAILABLE', reason: 'NO_USABLE_CAPTURE' };
    let reviews: InformationalReviews | null = null;
    for (const n of [...captures].sort((a, b) => Date.parse(files.get(b)?.collectedAt ?? '') - Date.parse(files.get(a)?.collectedAt ?? '') || b - a)) {
      const capture = files.get(n);
      if (!capture) continue;
      const { httpStatus, bodyText, bodySha256 } = capture.response;
      if (httpStatus === null || httpStatus < 200 || httpStatus > 299 || bodyText === null || bodySha256 === null) continue;
      const latest = reports.filter((r) => r.capture === n).sort((a, b) => b.revision - a.revision)[0];
      const built = profileFromBody({
        source: { ref: captureRef(n), observedAt: capture.collectedAt, contentSha256: capture.contentSha256, bodySha256 },
        bodyText,
        identityCandidate: capture.input.identity,
        report: latest ? (reportFiles.get(reportRef(n, latest.revision)) ?? null) : null,
        ...(onRawWebsite ? { onRawWebsite } : {}),
      });
      profile = built.profile;
      reviews = built.reviews;
      break;
    }
    return { status: 'READY', basis: { version: SCORING_BASIS_VERSION, auditId, layout: 'VERSIONED', evidences, profile, informational: { reviews } } };
  }

  async function readLegacy(auditId: string, dir: string, onRawWebsite?: (raw: string | null) => void): Promise<ScoringBasisOutcome> {
    const legacy = await readLegacyAudit(ops, dir);
    if (legacy.integrity.status === 'MISMATCH') return failed(legacy.integrity);
    // o relatório VIGENTE (não superado) é obrigatório: um relatório superado nunca é promovido em silêncio
    const current = legacy.reports.find((r) => !r.superseded && r.report !== null);
    if (legacy.integrity.status === 'INCOMPLETE' || !current || !current.report) return { status: 'NO_EVIDENCE', integrity: legacy.integrity };
    const bodyHash = legacy.verifiedHashes['serper-body.json'];
    const collectedAt = str(rec(current.report.source).collectedAt);
    if (!bodyHash || legacy.verifiedBodyText === null || !validIso(collectedAt)) return { status: 'NO_EVIDENCE', integrity: legacy.integrity };
    // vínculo relatório↔corpo (o legado não tem `captureSha256`): o relatório vigente declara o hash do corpo de que foi gerado
    if (rec(rec(current.report.source).capture).sha256 !== bodyHash) return failed(integrityInfo('MISMATCH', legacy.integrity.checkedFiles, ['O relatório vigente não pertence ao corpo conferido.']));

    const evidences: BasisEvidence[] = [
      { ref: captureRef(1), kind: 'CAPTURE', capture: 1, revision: null, observedAt: collectedAt, generatedAt: null, contentSha256: bodyHash, bodySha256: bodyHash, superseded: false, legacy: true, origin: 'GOOGLE_NATIVE', provider: 'serper-maps', intermediary: true },
    ];
    for (const r of legacy.reports) {
      const hash = legacy.verifiedHashes[r.file];
      if (!r.report || !hash) continue;
      evidences.push({
        ref: reportRef(1, r.revision),
        kind: 'REPORT',
        capture: 1,
        revision: r.revision,
        observedAt: collectedAt,
        generatedAt: ((value) => (validIso(value) ? value : null))(str(r.report.generatedAt)),
        contentSha256: hash,
        bodySha256: null,
        superseded: r.superseded,
        legacy: true,
        origin: 'GOOGLE_NATIVE',
        provider: 'serper-maps',
        intermediary: true,
      });
    }

    let profile: BasisProfile | BasisProfileUnavailable = { state: 'UNAVAILABLE', reason: 'NO_USABLE_CAPTURE' };
    let reviews: InformationalReviews | null = null;
    // o status vem do texto VERIFICADO (não de uma releitura do arquivo)
    const httpStatus = ((text) => {
      try {
        return text === null ? null : (rec(JSON.parse(text)).status as unknown);
      } catch {
        return null;
      }
    })(legacy.verifiedStatusText);
    if (typeof httpStatus === 'number' && httpStatus >= 200 && httpStatus <= 299) {
      const report = current.report;
      const given = rec(report.identity);
      const built = profileFromBody({
        source: { ref: captureRef(1), observedAt: collectedAt, contentSha256: bodyHash, bodySha256: bodyHash },
        bodyText: legacy.verifiedBodyText,
        identityCandidate: {
          originalLink: given.originalLink,
          identifiers: rec(report.identifiers).fromLink,
          confirmation: { confirmedBy: given.confirmedBy, confirmedAt: given.confirmedAt },
        },
        report,
        ...(onRawWebsite ? { onRawWebsite } : {}),
      });
      profile = built.profile;
      reviews = built.reviews;
    }
    // O status do provedor decide se há perfil utilizável (cobertura, `located`): é INFLUÊNCIA sobre o resultado e, por isso, entra na prova de coleta com o hash VERIFICADO
    const statusHash = legacy.verifiedStatusText !== null ? legacy.verifiedHashes['serper-status.json'] : undefined;
    const artifacts: BasisArtifact[] = statusHash ? [{ ref: legacyStatusRef(1), contentSha256: statusHash, legacy: true }] : [];
    return { status: 'READY', basis: { version: SCORING_BASIS_VERSION, auditId, layout: 'LEGACY', evidences, artifacts, profile, informational: { reviews } } };
  }

  /** Localiza a pasta, descarta symlink/não diretório e escolhe o layout; o mesmo caminho para ler e para rechecar. */
  async function readAny(auditId: string, onRawWebsite?: (raw: string | null) => void): Promise<ScoringBasisOutcome> {
    const located = locate(options.baseDir, auditId, projectRoot);
    if (!located.ok) throw new Error(located.issues.join(' '));
    try {
      const info = await ops.lstat(located.value.dir);
      if (info.isSymbolicLink() || !info.isDirectory()) return { status: 'NOT_FOUND' };
    } catch {
      // pasta inexistente: a verificação a trata como "não encontrada"
    }
    let legacy = false;
    try {
      legacy = (await ops.lstat(path.join(located.value.dir, 'MANIFEST.json'))).isFile();
    } catch {
      legacy = false;
    }
    return legacy ? readLegacy(auditId, located.value.dir, onRawWebsite) : readVersioned(auditId, onRawWebsite);
  }

  return {
    /** Lê, verifica e projeta a base de pontuação. Só leitura. Id inválido lança erro; ator não autorizado lança `EvidenceAccessError`. */
    async readScoringBasis(actor: EvidenceActor, auditId: string): Promise<ScoringBasisOutcome> {
      await guard(actor);
      return readAny(auditId);
    },

    /**
     * RECHECA a derivação do website (Onda 6C, I4) no último instante antes de gravar um resultado: relê, do disco e com a MESMA
     * verificação de integridade, a captura-fonte, acha o website BRUTO do lugar casado por CID/placeId e o deriva de novo. Só
     * devolve `MATCH` se o SHA-256 do bruto, a URL derivada e o nível de UTM forem exatamente os esperados. O bruto não sai daqui.
     * Independência real: bytes lidos de novo e reverificados, não o objeto que a prévia já tinha em memória. LIMITE: a derivação em si
     * é a mesma função (`deriveWebsite`); o que se prova é que o resultado reflete a evidência íntegra de AGORA.
     */
    async verifyWebsiteDerivation(actor: EvidenceActor, auditId: string, expected: WebsiteExpectation): Promise<'MATCH' | 'MISMATCH' | 'NOT_AVAILABLE'> {
      await guard(actor);
      let raw: string | null | undefined;
      const outcome = await readAny(auditId, (value) => {
        raw = value;
      });
      if (outcome.status !== 'READY' || outcome.basis.profile.state !== 'AVAILABLE') return 'NOT_AVAILABLE';
      if (outcome.basis.profile.source.ref !== expected.sourceRef) return 'MISMATCH';
      if (typeof raw !== 'string') return 'MISMATCH';
      const fresh = deriveWebsite(raw);
      return fresh.rawSha256 === expected.rawSha256 && fresh.state === 'DERIVED' && fresh.derived === expected.derived && fresh.utm.level === expected.utmLevel ? 'MATCH' : 'MISMATCH';
    },
  };
}

/** O que a prévia derivou do website e a finalização quer conferir contra o bruto íntegro. */
export interface WebsiteExpectation {
  readonly sourceRef: string;
  readonly rawSha256: string;
  readonly derived: string;
  readonly utmLevel: 'COMPLETE' | 'PARTIAL' | 'NOT_OBSERVED';
}

export type ScoringBasisReader = ReturnType<typeof createScoringBasisReader>;
