import path from 'node:path';
import { NextResponse } from 'next/server';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { AUDIT_ID_PATTERN, createDecisionService } from '@/lib/link-audit-decisions';
import { createEvidenceReader, EvidenceAccessError, type EvidenceActor } from '@/lib/link-audit-evidence';
import { createScoringBasisReader } from '@/lib/link-audit-evidence/scoring-basis';
import { createScoringPreviewService, PREVIEW_HTTP_STATUS, PREVIEW_MESSAGE, type PreviewFailure } from '@/lib/link-audit-scoring-runs';
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

/** Relógio do servidor: só alimenta as verificações de "data futura" do mapeador (nunca entra na entrada do motor). */
const serverClock = (): string => new Date().toISOString();

export interface ScoringContext {
  readonly service: ReturnType<typeof createScoringPreviewService>;
  readonly actor: EvidenceActor;
}

/** Autentica, limita a taxa, confere a configuração e entrega o serviço; qualquer exceção vira erro genérico. */
export async function withScoring(request: Request, handler: (ctx: ScoringContext) => Promise<NextResponse>): Promise<NextResponse> {
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
  try {
    const storage = await reader.storageStatus(actor);
    if (storage !== 'READY') return reply({ error: 'O armazenamento de evidências não está acessível ao servidor.', code: 'EVIDENCE_STORAGE_UNAVAILABLE' }, 503);
    const service = createScoringPreviewService({
      basisReader: createScoringBasisReader({ baseDir: evidenceDir, authorize }),
      decisions: createDecisionService({ baseDir: decisionsDir, anchorDir, evidence: reader, evidenceBaseDir: evidenceDir }),
      clock: serverClock,
    });
    return await handler({ service, actor });
  } catch (error) {
    if (error instanceof EvidenceAccessError) return reply({ error: 'Acesso negado.', code: 'FORBIDDEN' }, 403);
    return internal(); // nada do erro (mensagem, caminho) é devolvido ou registrado
  }
}
