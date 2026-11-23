import type { CompanyIdentity } from '../link-audit/audit';
import { CallLedger, evaluateAuthorization, identifiersFingerprint, LIVE_HARD_LIMITS, MAX_AUTHORIZATION_WINDOW_MS, type AuthorizationDenial, type CollectionMode } from '../link-audit/collector/budget';
import { collectEvidence, planSearch } from '../link-audit/collector/collect';
import { estimateCost, SECONDARY_SOURCE_ASSUMPTIONS, type CostAssumptions, type CostEstimate } from '../link-audit/collector/cost';
import { buildCollectionReport, type CollectionReport } from '../link-audit/collector/report';
import type { CallBudget, CollectionInput, CollectorProviders, Viewport } from '../link-audit/collector/types';
import { safeFailureReason, sanitizeUrl } from '../link-audit/url-redaction';
import { buildReportFromCapture, type CaptureReport } from '../link-audit/collector/capture-report';
import type { SiteCheckOutcome } from '../link-audit/collector/site-access';
import type { SiteProvider } from '../link-audit/collector/types';
import type { FsOps } from '../link-audit/snapshot-store';
import { containsSecret } from '../link-audit-evidence/secrets';
import { checkStorage, readCapture, writeCapture, writeReport, writeSiteObservation } from '../link-audit-evidence/store';
import { AUDIT_ID_PATTERN, captureName } from '../link-audit-evidence/types';
import type { ProviderCaptureInfo } from './serper-maps-provider';
import { buildExpectedIdentity } from '../link-audit/identifiers';
import { buildSerperMapsBody, DEFAULT_SERPER_MAPS_URL } from './serper-maps-provider';
import { createSimulatedMapsProvider, isSyntheticIdentity } from './simulated-provider';
import { SITE_MAX_HTTP_REQUESTS } from './site-provider';
import type { UsedAuthorizationStore } from './used-authorizations';

/*
 * Orquestração da coleta (Onda 4B). Três modos:
 *  - DRY_RUN (padrão): só planeja e estima o custo. Nenhuma chamada, nenhum provedor é sequer criado.
 *  - SIMULATED: provedores injetados (fixtures), sem gravar nada. Nunca há tráfego externo. COM `evidence` (ensaio da W5 em homologação,
 *    W5.2b, spec do P1 §5.7): só com `homologation: true`, só o gerador sintético e a identidade sintética; captura e relatório gravados
 *    com a marca SIMULATED (dentro do hash).
 *  - LIVE: exige TODAS as travas (ambiente ligado, autorização válida e não usada, ciência do custo, identidade
 *    confirmada, limite ≤ 1 chamada ao Serper) e marca a autorização como usada ANTES de chamar.
 * Nada aqui roda ao abrir a página nem ao validar um link: não existe rota HTTP de coleta.
 */

export const DEFAULT_REQUESTED_BUDGET: CallBudget = { maps: 1, reviews: 0, site: 1 };

export interface CollectionPlan {
  readonly mode: 'DRY_RUN';
  readonly externalTraffic: false;
  readonly search: { readonly canSearch: boolean; readonly query: string; readonly viewport: Viewport | null; readonly nameSource: string };
  readonly calls: readonly { readonly provider: 'serper-maps' | 'serper-reviews' | 'site-check'; readonly maxCalls: number; readonly description: string }[];
  /** Identidade esperada: o FID original e o CID (do link ou derivado dele, com a origem). */
  readonly expectedIdentity: { readonly featureId: string | null; readonly cid: string | null; readonly cidOrigin: string | null; readonly placeId: string | null; readonly conflict: string | null };
  /** Requisição que seria enviada ao Serper (a chave NUNCA aparece). Mesmo construtor do envio real. */
  readonly request: { readonly method: 'POST'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: Readonly<Record<string, unknown>> } | null;
  readonly confirmationCriterion: readonly string[];
  readonly cost: CostEstimate;
  readonly notes: readonly string[];
}

export interface RunRequest {
  readonly mode?: CollectionMode;
  readonly input: CollectionInput;
  readonly budget?: CallBudget;
  /** Obrigatória no modo LIVE. */
  readonly authorization?: unknown;
  /** SIMULATED com gravação de evidências: id da auditoria do ensaio (no LIVE é o id da autorização). */
  readonly auditId?: string;
}

export interface RunDeps {
  readonly now: () => Date;
  /** `GMN_LINK_AUDIT_LIVE=on`? (lido fora deste módulo) */
  readonly liveEnabled?: boolean;
  readonly usedStore?: UsedAuthorizationStore;
  /** SIMULATED: provedores de fixture. */
  readonly providers?: CollectorProviders;
  /** LIVE: fábrica dos provedores reais; só é chamada depois de todas as travas. */
  readonly createLiveProviders?: (hooks: { readonly onCapture: (info: ProviderCaptureInfo) => Promise<void> }) => CollectorProviders;
  /** LIVE: armazenamento das evidências (obrigatório). O pré-voo roda ANTES de a autorização ser consumida. */
  readonly evidence?: { readonly baseDir: string; readonly fs?: FsOps; readonly projectRoot?: string; readonly apiKey?: string };
  readonly costAssumptions?: CostAssumptions;
  /** Trava de homologação já conferida por quem chama (`--simulated` + `GMN_LINK_AUDIT_HOMOLOGATION=1`): exigida para GRAVAR evidência simulada. */
  readonly homologation?: boolean;
}

/** O que foi (ou não) persistido numa coleta LIVE. `errors` não vazio ⇒ a coleta paga NÃO está totalmente preservada. */
export interface PersistedEvidence {
  readonly auditId: string;
  readonly captureNumber: number | null;
  readonly revision: number | null;
  readonly files: { readonly capture?: string; readonly site?: string; readonly report?: string };
  readonly storedReport: CaptureReport | null;
  /** A resposta paga NÃO está totalmente preservada. */
  readonly errors: readonly string[];
  /** Algo não foi gerado (ex.: relatório), mas a captura original está preservada. */
  readonly warnings: readonly string[];
}

export type RunOutcome =
  | { readonly ok: true; readonly kind: 'PLAN'; readonly plan: CollectionPlan }
  | { readonly ok: true; readonly kind: 'REPORT'; readonly report: CollectionReport; readonly persisted?: PersistedEvidence }
  | { readonly ok: false; readonly persisted?: PersistedEvidence; readonly code: 'STORAGE_NOT_READY' | AuthorizationDenial | 'INVALID_REQUEST' | 'IDENTITY_NOT_CONFIRMED' | 'IDENTITY_MISMATCH' | 'INVALID_BUDGET' | 'NO_PROVIDERS' | 'PROVIDER_SETUP_FAILED' | 'HOMOLOGATION_REQUIRED'; readonly reason: string };

function planFor(request: RunRequest, budget: CallBudget, deps: RunDeps): CollectionPlan {
  const search = planSearch(request.input);
  const cost = estimateCost(budget, deps.costAssumptions ?? SECONDARY_SOURCE_ASSUMPTIONS);
  const ids = request.input.identity.identifiers;
  const expected = buildExpectedIdentity(ids);
  return {
    mode: 'DRY_RUN',
    externalTraffic: false,
    expectedIdentity: {
      featureId: ids.featureId ?? null,
      cid: expected.cid?.value ?? null,
      cidOrigin: expected.cid ? (expected.cid.origin === 'DERIVED_FROM_FID' ? 'derivado do FID (conversão offline)' : 'informado no link') : null,
      placeId: ids.placeId ?? null,
      conflict: expected.conflict ?? null,
    },
    request: search.canSearch && !expected.conflict
      ? { method: 'POST', url: DEFAULT_SERPER_MAPS_URL, headers: { 'X-API-KEY': '<não exibida>', 'Content-Type': 'application/json' }, body: buildSerperMapsBody({ query: search.query, viewport: search.viewport }) }
      : null,
    confirmationCriterion: [
      'O perfil só é aceito se um resultado trouxer o MESMO CID (campo cid, ou a 2ª metade do fid do próprio resultado convertida para decimal) ou o MESMO placeId.',
      'O prefixo do FID é ignorado; o nome nunca confirma; resultado sem identificador comparável = identidade NÃO confirmada.',
      'Identificadores contraditórios (no resultado ou entre resultados) = perfil recusado.',
    ],
    search: { canSearch: search.canSearch, query: search.query, viewport: search.viewport, nameSource: search.nameSource },
    calls: [
      {
        provider: 'serper-maps',
        maxCalls: budget.maps,
        description: search.canSearch
          ? `POST /maps com q="${search.query}"${search.viewport ? ' e ll do link' : ''}; o perfil só é aceito por identificador exato (nunca por nome).`
          : 'Sem nome (do operador ou do link) não há como buscar: nenhuma chamada seria feita.',
      },
      { provider: 'serper-reviews', maxCalls: 0, description: 'Desligado: o formato da resposta não foi confirmado.' },
      {
        provider: 'site-check',
        maxCalls: budget.site,
        description: `Só se o perfil informar site próprio: no máximo ${SITE_MAX_HTTP_REQUESTS} requisições HTTP, sem login, com proteção contra SSRF; sem custo de API.`,
      },
    ],
    cost,
    notes: ['DRY_RUN: nenhuma chamada foi feita e nenhum dado de empresa foi consultado.', 'A estimativa de custo NÃO está confirmada; confirme no painel do Serper.'],
  };
}

function confirmedIdentity(input: CollectionInput): CompanyIdentity | null {
  return input.identity.confirmation ? input.identity : null;
}

export async function runLinkAuditCollection(request: RunRequest, deps: RunDeps): Promise<RunOutcome> {
  const mode: CollectionMode = request.mode ?? 'DRY_RUN';
  if (mode !== 'DRY_RUN' && mode !== 'SIMULATED' && mode !== 'LIVE') return { ok: false, code: 'INVALID_REQUEST', reason: 'Modo inválido.' };
  const requested = request.budget ?? DEFAULT_REQUESTED_BUDGET;
  const identity = confirmedIdentity(request.input);
  if (!identity) return { ok: false, code: 'IDENTITY_NOT_CONFIRMED', reason: 'A coleta só começa depois que o operador confirma a identidade.' };

  const expectedIdentity = buildExpectedIdentity(identity.identifiers);
  if (mode !== 'DRY_RUN' && expectedIdentity.conflict) {
    return { ok: false, code: 'IDENTITY_MISMATCH', reason: `Identificadores do link inconsistentes: ${expectedIdentity.conflict}.` };
  }

  if (mode === 'DRY_RUN') {
    if (!(['maps', 'reviews', 'site'] as const).every((key) => Number.isInteger(requested[key]) && requested[key] >= 0 && requested[key] <= 10)) {
      return { ok: false, code: 'INVALID_BUDGET', reason: 'Orçamento inválido.' };
    }
    return { ok: true, kind: 'PLAN', plan: planFor(request, requested, deps) };
  }

  let budget: CallBudget = requested;
  let providers: CollectorProviders;
  let auditId = '';
  const live: LiveCaptureState = { rawBody: null, httpStatus: null, attempts: 0, collectedAt: null, captureNumber: null, files: {}, siteOutcome: null, errors: [] };

  if (mode === 'SIMULATED' && deps.evidence) {
    // ---- SIMULATED GRAVADO (ensaio da W5 em homologação): trava, gerador sintético e identidade sintética, antes de qualquer pasta ----
    if (deps.homologation !== true) return { ok: false, code: 'HOMOLOGATION_REQUIRED', reason: 'A gravação de evidência SIMULADA (ensaio) exige a trava de homologação; nada foi gravado.' };
    if (deps.providers || deps.createLiveProviders) return { ok: false, code: 'INVALID_REQUEST', reason: 'A coleta simulada gravada usa SÓ o gerador sintético do ensaio: provedor injetado ou real não é aceito.' };
    if (!isSyntheticIdentity(identity)) return { ok: false, code: 'INVALID_REQUEST', reason: 'A coleta simulada gravada só aceita a identidade sintética do ensaio (Empresa de Ensaio).' };
    const prepared = await prepareEvidence(request, deps.evidence, String(request.auditId ?? '').toLowerCase(), true);
    if (!prepared.ok) return prepared;
    auditId = prepared.auditId;
    budget = { maps: 1, reviews: 0, site: 0 };
    providers = { maps: createSimulatedMapsProvider({ now: deps.now, onCapture: captureHook({ base: deps.evidence.baseDir, auditId, request, storageOptions: prepared.storageOptions, live, simulated: true }) }) };
  } else if (mode === 'SIMULATED') {
    if (!deps.providers) return { ok: false, code: 'NO_PROVIDERS', reason: 'O modo SIMULATED exige provedores de fixture.' };
    if (deps.providers.maps?.live || deps.providers.site?.live) return { ok: false, code: 'INVALID_REQUEST', reason: 'Provedores reais não são aceitos no modo SIMULATED.' };
    providers = deps.providers;
  } else {
    // ---- LIVE: todas as travas, nesta ordem, antes de qualquer provedor existir --------------------
    const decision = evaluateAuthorization(request.authorization, {
      liveEnabled: deps.liveEnabled === true,
      snapshotId: request.input.snapshotId,
      identifiers: identity.identifiers,
      now: deps.now(),
      requested: { maps: requested.maps, siteHttpRequests: requested.site > 0 ? SITE_MAX_HTTP_REQUESTS : 0 },
      isUsed: (id) => (deps.usedStore ? deps.usedStore.isUsed(id) : true),
    });
    if (!decision.ok) return { ok: false, code: decision.code, reason: decision.reason };
    if (deps.usedStore && deps.usedStore.companyUsedSince(identifiersFingerprint(identity.identifiers), new Date(deps.now().getTime() - MAX_AUTHORIZATION_WINDOW_MS).toISOString())) {
      return { ok: false, code: 'ALREADY_USED', reason: 'Já houve uma coleta real autorizada para esta empresa nas últimas 24 horas; nova autorização exige decisão do usuário (apagar o marcador não é um procedimento previsto).' };
    }
    if (!deps.usedStore || !deps.createLiveProviders) return { ok: false, code: 'NO_PROVIDERS', reason: 'Faltam o registro de uso da autorização ou a fábrica dos provedores.' };
    if (requested.reviews > LIVE_HARD_LIMITS.reviews) return { ok: false, code: 'LIMIT_ABOVE_AUTHORIZED', reason: 'O /reviews está desligado: o orçamento deve ser 0.' };

    // Armazenamento das evidências: sem publicação segura garantida, nada é gasto e a autorização NÃO é consumida.
    if (!deps.evidence) return { ok: false, code: 'STORAGE_NOT_READY', reason: 'O modo LIVE exige armazenamento de evidências configurado (--evidence-dir).' };
    const prepared = await prepareEvidence(request, deps.evidence, String((request.authorization as { authorizationId?: unknown }).authorizationId ?? '').toLowerCase(), false);
    if (!prepared.ok) return prepared;
    const storageOptions = prepared.storageOptions;
    auditId = prepared.auditId;

    const authorization = request.authorization as { authorizationId: string; operator: string; maxMapsCalls: number };
    const marked = deps.usedStore.markUsed({
      authorizationId: authorization.authorizationId,
      operator: authorization.operator,
      snapshotId: request.input.snapshotId,
      maxMapsCalls: authorization.maxMapsCalls,
      markedAt: deps.now().toISOString(),
      companyFingerprint: identifiersFingerprint(identity.identifiers),
    });
    if (!marked.ok) return { ok: false, code: 'ALREADY_USED', reason: marked.reason };

    budget = { maps: decision.effective.maps, reviews: 0, site: decision.effective.siteHttpRequests > 0 ? 1 : 0 };
    // A resposta paga é gravada IMEDIATAMENTE, antes da verificação do site e de qualquer outro processamento.
    const hooks = { onCapture: captureHook({ base: deps.evidence.baseDir, auditId, request, storageOptions, live, simulated: false }) };
    try {
      const created = deps.createLiveProviders(hooks);
      const site = created.site;
      const recordingSite: SiteProvider | undefined = site
        ? {
            ...(site.live ? { live: true as const } : {}),
            check: async (url: string) => {
              const result = await site.check(url);
              live.siteOutcome = result;
              return result;
            },
          }
        : undefined;
      providers = { ...(created.maps ? { maps: created.maps } : {}), ...(recordingSite ? { site: recordingSite } : {}) }; // nunca /reviews
    } catch (error) {
      return { ok: false, code: 'PROVIDER_SETUP_FAILED', reason: `Não foi possível preparar os provedores: ${safeFailureReason(error)}` };
    }
  }

  const ledger = new CallLedger(mode, { 'serper-maps': budget.maps, 'serper-reviews': budget.reviews, 'site-check': budget.site }, deps.now);
  const outcome = await collectEvidence(request.input, providers, { budget, now: deps.now, ledger });
  // aqui o modo é LIVE (sempre grava) ou SIMULATED (só grava pelo caminho com `evidence`)
  const persisting = deps.evidence !== undefined;
  if (!outcome.ok) {
    // Depois de consumida a autorização, o que foi (ou não) persistido SEMPRE é informado.
    const persistedAfterFailure = persisting ? await finishPersistence({ deps, request, auditId, live, ledger, simulated: mode === 'SIMULATED' }) : undefined;
    return { ok: false, code: outcome.code, reason: outcome.issues.join(' '), ...(persistedAfterFailure ? { persisted: persistedAfterFailure } : {}) };
  }

  const report = buildCollectionReport({
    mode,
    input: request.input,
    identity,
    result: outcome.result,
    ledger,
    cost: estimateCost(budget, deps.costAssumptions ?? SECONDARY_SOURCE_ASSUMPTIONS),
    generatedAt: deps.now().toISOString(),
  });
  if (!persisting) return { ok: true, kind: 'REPORT', report };
  const persisted = await finishPersistence({ deps, request, auditId, live, ledger, simulated: mode === 'SIMULATED' });
  return { ok: true, kind: 'REPORT', report, persisted };
}

interface LiveCaptureState {
  rawBody: string | null;
  httpStatus: number | null;
  attempts: number;
  collectedAt: string | null;
  captureNumber: number | null;
  files: { capture?: string; site?: string; report?: string };
  siteOutcome: SiteCheckOutcome | null;
  errors: string[];
}

type StorageOptionsOf = { fs?: FsOps; projectRoot?: string; apiKey?: string };
const storageOptionsOf = (evidence: NonNullable<RunDeps['evidence']>): StorageOptionsOf => ({ ...(evidence.fs ? { fs: evidence.fs } : {}), ...(evidence.projectRoot ? { projectRoot: evidence.projectRoot } : {}), ...(evidence.apiKey ? { apiKey: evidence.apiKey } : {}) });

/** Pré-voo do armazenamento (LIVE e SIMULATED gravado): id da auditoria, segredo na entrada e publicação segura, ANTES de qualquer consulta. */
async function prepareEvidence(
  request: RunRequest,
  evidence: NonNullable<RunDeps['evidence']>,
  auditIdCandidate: string,
  simulated: boolean,
): Promise<{ readonly ok: true; readonly auditId: string; readonly storageOptions: StorageOptionsOf } | { readonly ok: false; readonly code: 'STORAGE_NOT_READY'; readonly reason: string }> {
  const untouched = simulated ? 'Nada foi gravado.' : 'Nenhuma consulta foi feita e a autorização não foi consumida.';
  if (!AUDIT_ID_PATTERN.test(auditIdCandidate)) {
    return { ok: false, code: 'STORAGE_NOT_READY', reason: simulated ? 'Informe um id de auditoria válido para o ensaio (8 a 64 caracteres: minúsculas, números, _ e -).' : 'O id da autorização não pode ser usado como identificador de auditoria (8 a 64 caracteres: letras, números, _ e -).' };
  }
  const storageOptions = storageOptionsOf(evidence);
  // Segredo no link/identidade é erro NOSSO e é detectado ANTES de pagar (a resposta paga nunca é descartada depois).
  if (containsSecret(JSON.stringify(request.input), 'BROAD', evidence.apiKey)) {
    return { ok: false, code: 'STORAGE_NOT_READY', reason: `O link ou a identidade parecem conter chave, token ou cabeçalho de autenticação; ${simulated ? 'nada foi gravado.' : 'nada foi consultado e a autorização não foi consumida.'}` };
  }
  const storage = await checkStorage(evidence.baseDir, { ...storageOptions, auditId: auditIdCandidate, simulated });
  if (!storage.ok) return { ok: false, code: 'STORAGE_NOT_READY', reason: `Armazenamento de evidências indisponível: ${storage.issues.join(' ')} ${untouched}` };
  return { ok: true, auditId: auditIdCandidate, storageOptions };
}

/** Gancho de captura: grava a resposta (paga, ou SIMULADA com a marca) assim que ela existe, antes de qualquer processamento. */
function captureHook(params: { base: string; auditId: string; request: RunRequest; storageOptions: StorageOptionsOf; live: LiveCaptureState; simulated: boolean }): (info: ProviderCaptureInfo) => Promise<void> {
  const { base, auditId, request, storageOptions, live, simulated } = params;
  return async (info: ProviderCaptureInfo): Promise<void> => {
    live.rawBody = info.bodyText;
    live.httpStatus = info.httpStatus;
    live.attempts = info.attempts;
    live.collectedAt = info.capturedAt;
    const written = await writeCapture(
      base,
      {
        auditId,
        collectedAt: info.capturedAt,
        request: { url: info.url, body: info.requestBody },
        response: { httpStatus: info.httpStatus, attempts: info.attempts, bodyText: info.bodyText, failure: info.failure },
        input: { snapshotId: request.input.snapshotId, originalLink: sanitizeUrl(request.input.link.originalLink), identity: { ...(JSON.parse(JSON.stringify(request.input.identity)) as Record<string, unknown>), originalLink: sanitizeUrl(request.input.identity.originalLink) } },
        ...(simulated ? { simulated: true as const } : {}),
      },
      storageOptions,
    );
    if (written.ok) {
      live.captureNumber = written.value.captureNumber;
      live.files.capture = written.value.filePath;
    } else {
      live.errors.push(`${simulated ? 'A resposta SIMULADA' : 'A resposta paga'} NÃO foi persistida (${written.code}): ${written.issues.join(' ')}`);
    }
  };
}

/** Grava a observação do site e o relatório (mesmo `buildReportFromCapture` do replay offline) depois da captura. */
async function finishPersistence(params: { deps: RunDeps; request: RunRequest; auditId: string; live: LiveCaptureState; ledger: CallLedger; simulated: boolean }): Promise<PersistedEvidence> {
  const { deps, request, auditId, live, ledger, simulated } = params;
  const base = (deps.evidence as NonNullable<RunDeps['evidence']>).baseDir;
  const options = { ...(deps.evidence?.fs ? { fs: deps.evidence.fs } : {}), ...(deps.evidence?.projectRoot ? { projectRoot: deps.evidence.projectRoot } : {}), ...(deps.evidence?.apiKey ? { apiKey: deps.evidence.apiKey } : {}) };
  let revision: number | null = null;
  let storedReport: CaptureReport | null = null;
  const warnings: string[] = [];

  if (live.captureNumber === null) {
    if (live.errors.length === 0 && ledger.summary()['serper-maps'].sent > 0) live.errors.push('A consulta ao Serper foi enviada, mas nenhuma resposta chegou ao armazenamento de evidências.');
  } else {
    if (live.siteOutcome) {
      const site = await writeSiteObservation(base, auditId, live.captureNumber, JSON.parse(JSON.stringify(live.siteOutcome)) as Record<string, unknown>, live.siteOutcome.checkedAt, options);
      if (site.ok) live.files.site = site.value.filePath;
      else live.errors.push(`A observação do site NÃO foi persistida (${site.code}): ${site.issues.join(' ')}`);
    }
    if (live.rawBody !== null && live.httpStatus !== null && live.collectedAt !== null) {
      const captureRead = await readCapture(base, auditId, live.captureNumber, options);
      if (!captureRead.ok) {
        live.errors.push(`O relatório NÃO foi gerado: a captura gravada não pôde ser relida (${captureRead.code}).`);
        return { auditId, captureNumber: live.captureNumber, revision, files: live.files, storedReport, errors: live.errors, warnings };
      }
      const built = await buildReportFromCapture({
        rawBody: live.rawBody,
        body: { name: captureName(live.captureNumber), sha256: captureRead.value.contentSha256, bytes: captureRead.value.response.bytes },
        otherFiles: [],
        httpStatus: live.httpStatus,
        httpAttempts: live.attempts,
        collectedAt: live.collectedAt,
        input: request.input,
        site: null,
        siteOutcome: live.siteOutcome,
        generatedAt: deps.now().toISOString(),
        ...(simulated ? { simulated: true } : {}),
      });
      if (built.ok) {
        const written = await writeReport(base, auditId, live.captureNumber, JSON.parse(JSON.stringify(built.report)) as Record<string, unknown>, deps.now().toISOString(), options);
        if (written.ok) {
          revision = written.value.revision;
          live.files.report = written.value.filePath;
          storedReport = built.report;
        } else live.errors.push(`O relatório NÃO foi persistido (${written.code}): ${written.issues.join(' ')}`);
      } else {
        warnings.push(`Relatório não gerado: ${built.reason} A captura original está preservada.`);
      }
    } else {
      warnings.push('Relatório não gerado: a consulta não trouxe um corpo de resposta utilizável (erro HTTP ou falha de rede). A captura original está preservada.');
    }
  }
  return { auditId, captureNumber: live.captureNumber, revision, files: live.files, storedReport, errors: live.errors, warnings };
}
