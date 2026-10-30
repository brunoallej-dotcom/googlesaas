import path from 'node:path';
import { NextResponse } from 'next/server';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { AUDIT_ID_PATTERN, createDecisionService } from '@/lib/link-audit-decisions';
import { createEvidenceReader, EvidenceAccessError, type EvidenceActor } from '@/lib/link-audit-evidence';
import { createScoringBasisReader } from '@/lib/link-audit-evidence/scoring-basis';
import { createScoringPreviewService, createScoringResultsService, PREVIEW_HTTP_STATUS, PREVIEW_MESSAGE, RESULTS_HTTP_STATUS, RESULTS_MESSAGE, type PreviewFailure, type ResultsFailure, type ScoringResultsService } from '@/lib/link-audit-scoring-runs';
import { SlidingWindowLimiter } from '@/lib/rate-limit';

/*
 * Rota da PRÉVIA da pontuação Lumos (Fase 6, Onda 6C, I3). SOMENTE GET. Regras:
 *  - `requireOperator` em toda requisição (sessão + lista de operadores); o `auditId` só é validado DEPOIS da autenticação;
 *  - as raízes (evidências, decisões e âncoras) vêm SÓ da configuração do servidor; o navegador envia apenas o `auditId`:
 *    nenhuma consulta (`?…`), corpo, pontuação, entrada do motor, caminho, autor ou data é aceito;
 *  - NÃO grava nada e NÃO gera recibo: a prévia nunca é definitiva (`definitive:false`);
 *  - nenhuma resposta traz caminho do disco, URL bruta, parâmetro, mensagem interna ou exceção; respostas privadas e sem cache;
 *  - limite de requisições por operador (a prévia relê e confere evidências e decisões duas vezes).
 */
export const SCORING_HEADERS = {
  'Cache-Control': 'no-store, private, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie',
} as const;

const limiter = new SlidingWindowLimiter(20, 60_000);

export function reply(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...SCORING_HEADERS, ...extra } });
}

export const invalidParams = (): NextResponse => reply({ error: 'Parâmetros inválidos.', code: 'INVALID_PARAMS' }, 400);
const internal = (): NextResponse => reply({ error: 'Não foi possível concluir a operação.', code: 'INTERNAL_ERROR' }, 500);

export const isAuditId = (value: unknown): value is string => typeof value === 'string' && AUDIT_ID_PATTERN.test(value);

/** Falha do serviço: mensagem fixa + (no máximo 10) detalhes de integridade já saneados; nunca `head`, pendente, caminhos nem exceções. */
export function failureResponse(failure: PreviewFailure): NextResponse {
  const issues = failure.issues.slice(0, 10).map((issue) => issue.slice(0, 300));
  return reply({ error: PREVIEW_MESSAGE[failure.code], code: failure.code, ...(issues.length > 0 ? { issues } : {}) }, PREVIEW_HTTP_STATUS[failure.code], failure.code === 'READ_INCONSISTENT' ? { 'Retry-After': '2' } : {});
}

function configuredDir(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.includes('\0') || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

/** Relógio do servidor: só alimenta as verificações de "data futura" do mapeador e a hora do resultado (nunca vem do cliente). */
const serverClock = (): string => new Date().toISOString();

export interface ScoringContext {
  readonly service: ReturnType<typeof createScoringPreviewService>;
  readonly actor: EvidenceActor;
}

interface Prepared {
  readonly actor: EvidenceActor;
  readonly preview: ReturnType<typeof createScoringPreviewService>;
  readonly basisReader: ReturnType<typeof createScoringBasisReader>;
  readonly dirs: { readonly evidence: string; readonly decisions: string; readonly anchors: string };
}

/** Autentica, limita a taxa, confere a configuração das três raízes de LEITURA e monta a prévia; qualquer exceção do chamador vira erro genérico. */
async function prepare(request: Request, limiter: SlidingWindowLimiter): Promise<NextResponse | Prepared> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;

  const verdict = limiter.consume(access.operator);
  if (!verdict.allowed) {
    return reply({ error: 'Muitas requisições em pouco tempo. Aguarde um instante.', code: 'RATE_LIMITED' }, 429, { 'Retry-After': String(verdict.retryAfterSeconds) });
  }

  const evidenceDir = configuredDir(process.env.GMN_LINK_AUDIT_EVIDENCE_DIR);
  if (!evidenceDir) return reply({ error: 'O armazenamento de evidências não está configurado neste servidor.', code: 'EVIDENCE_NOT_CONFIGURED' }, 503);
  const decisionsDir = configuredDir(process.env.GMN_LINK_AUDIT_DECISIONS_DIR);
  if (!decisionsDir) return reply({ error: 'O armazenamento de decisões não está configurado neste servidor.', code: 'DECISIONS_NOT_CONFIGURED' }, 503);
  const anchorDir = configuredDir(process.env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR);
  if (!anchorDir) return reply({ error: 'O armazenamento de âncoras das decisões não está configurado neste servidor.', code: 'ANCHOR_NOT_CONFIGURED' }, 503);

  const actor: EvidenceActor = { email: access.operator };
  const authorize = (candidate: EvidenceActor): boolean => candidate.email === access.operator && candidate.email.length > 0;
  const reader = createEvidenceReader({ baseDir: evidenceDir, authorize });
  const storage = await reader.storageStatus(actor);
  if (storage !== 'READY') return reply({ error: 'O armazenamento de evidências não está acessível ao servidor.', code: 'EVIDENCE_STORAGE_UNAVAILABLE' }, 503);
  const basisReader = createScoringBasisReader({ baseDir: evidenceDir, authorize });
  const preview = createScoringPreviewService({
    basisReader,
    decisions: createDecisionService({ baseDir: decisionsDir, anchorDir, evidence: reader, evidenceBaseDir: evidenceDir }),
    clock: serverClock,
  });
  return { actor, preview, basisReader, dirs: { evidence: evidenceDir, decisions: decisionsDir, anchors: anchorDir } };
}

const guarded = async (action: () => Promise<NextResponse>): Promise<NextResponse> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof EvidenceAccessError) return reply({ error: 'Acesso negado.', code: 'FORBIDDEN' }, 403);
    return internal(); // nada do erro (mensagem, caminho) é devolvido ou registrado
  }
};

/** Prévia (somente leitura). */
export async function withScoring(request: Request, handler: (ctx: ScoringContext) => Promise<NextResponse>): Promise<NextResponse> {
  return guarded(async () => {
    const prepared = await prepare(request, limiter);
    if (prepared instanceof NextResponse) return prepared;
    return handler({ service: prepared.preview, actor: prepared.actor });
  });
}

/* ------------------------------------------------------------------ resultados finalizados (Onda 6C, I4) */
const finalizeLimiter = new SlidingWindowLimiter(6, 60_000);
const resultsReadLimiter = new SlidingWindowLimiter(30, 60_000);

export interface ResultsContext {
  readonly service: ScoringResultsService;
  readonly actor: EvidenceActor;
}

/**
 * Falha dos resultados: mensagem fixa + (no máximo 10) detalhes de integridade já saneados + bloqueios (NOT_FINALIZABLE) + o head atual
 * das decisões (recusas de `expectedHead`) + o resumo da pendente. Nunca caminhos, exceções, entrada do motor, justificativas ou URLs.
 */
export function resultsFailureResponse(failure: ResultsFailure): NextResponse {
  const issues = failure.issues.slice(0, 10).map((issue) => issue.slice(0, 300));
  // pendente = resultado gravado e ainda sem recibo: ou há uma finalização em curso (o reenvio logo depois é 200), ou o autor ainda precisa reenviar
  const extra: Record<string, string> = failure.code === 'RESULT_ANCHOR_PENDING' || failure.code === 'RESULT_PENDING_UNCONFIRMED' ? { 'Retry-After': '5' } : failure.code === 'READ_INCONSISTENT' ? { 'Retry-After': '2' } : {};
  return reply(
    {
      error: RESULTS_MESSAGE[failure.code],
      code: failure.code,
      ...(issues.length > 0 ? { issues } : {}),
      ...(failure.blockers !== undefined ? { blockers: failure.blockers } : {}),
      ...(failure.head !== undefined ? { head: failure.head } : {}),
      ...(failure.pending !== undefined ? { pending: failure.pending } : {}),
    },
    RESULTS_HTTP_STATUS[failure.code],
    extra,
  );
}

/** Resultados: a finalização exige as duas pastas de resultados (503 sem elas); a prévia continua funcionando sem elas. */
export async function withResults(request: Request, mode: 'read' | 'write', handler: (ctx: ResultsContext) => Promise<NextResponse>): Promise<NextResponse> {
  return guarded(async () => {
    const prepared = await prepare(request, mode === 'write' ? finalizeLimiter : resultsReadLimiter);
    if (prepared instanceof NextResponse) return prepared;
    const resultsDir = configuredDir(process.env.GMN_LINK_AUDIT_RESULTS_DIR);
    if (!resultsDir) return reply({ error: RESULTS_MESSAGE.RESULTS_NOT_CONFIGURED, code: 'RESULTS_NOT_CONFIGURED' }, 503);
    const resultsAnchorDir = configuredDir(process.env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR);
    if (!resultsAnchorDir) return reply({ error: RESULTS_MESSAGE.RESULT_ANCHOR_NOT_CONFIGURED, code: 'RESULT_ANCHOR_NOT_CONFIGURED' }, 503);
    const service = createScoringResultsService({
      preview: prepared.preview,
      basisReader: prepared.basisReader,
      baseDir: resultsDir,
      anchorDir: resultsAnchorDir,
      otherDirs: [prepared.dirs.evidence, prepared.dirs.decisions, prepared.dirs.anchors],
      clock: serverClock,
    });
    return handler({ service, actor: prepared.actor });
  });
}
