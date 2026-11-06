import path from 'node:path';
import { NextResponse } from 'next/server';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { AUDIT_ID_PATTERN, createDecisionService, HTTP_STATUS, PUBLIC_MESSAGE, type DecisionService, type ServiceFailure } from '@/lib/link-audit-decisions';
import { createEvidenceReader, EvidenceAccessError, type EvidenceActor } from '@/lib/link-audit-evidence';
import { ledgerDirOf, ledgerForRoutes } from './ledger-wiring';
import { originConfigFromEnv } from '@/lib/link-audit-origin';
import { createResultsKnownHeads } from '@/lib/link-audit-scoring-runs';
import { SlidingWindowLimiter } from '@/lib/rate-limit';

/*
 * Rotas das DECISÕES HUMANAS (Fase 6, Onda 6B). Regras:
 *  - `requireOperator` em toda requisição (sessão + lista de operadores + bloqueio de origem cruzada nos POST);
 *  - autor e hora vêm da SESSÃO e do relógio do servidor; o navegador nunca envia caminhos, autor, data ou pontos;
 *  - as três raízes (evidências, decisões e ÂNCORAS) vêm SÓ da configuração do servidor e precisam ser pastas separadas;
 *  - toda escrita exige o `expectedHead` (a visão do operador) e só é confirmada depois do recibo na pasta de âncoras
 *    (sem recibo: 503 ANCHOR_PENDING, nunca 2xx; reenviar o mesmo pedido é idempotente);
 *  - ESCRITAS exigem a chave de comprovação de origem (variável de ambiente do servidor, fora das pastas de dados): sem ela, 503 e nada
 *    é gravado nem concluído (uma pendente só é concluída se o servidor comprovar que ele mesmo a gravou);
 *  - corpo limitado (413), tipo exato application/json (415), limite de requisições por operador (429);
 *  - nenhuma resposta traz caminho do disco, credencial ou mensagem interna; respostas privadas e sem cache.
 */
export const DECISION_HEADERS = {
  'Cache-Control': 'no-store, private, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie',
} as const;

// A leitura relê e confere todos os arquivos (I/O); a escrita é rara: limites por operador.
const readLimiter = new SlidingWindowLimiter(30, 60_000);
const writeLimiter = new SlidingWindowLimiter(20, 60_000);

export function reply(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...DECISION_HEADERS, ...extra } });
}

export const invalidParams = (): NextResponse => reply({ error: PUBLIC_MESSAGE.INVALID_PARAMS, code: 'INVALID_PARAMS' }, 400);
const internal = (): NextResponse => reply({ error: PUBLIC_MESSAGE.INTERNAL_ERROR, code: 'INTERNAL_ERROR' }, 500);

/** Resposta de erro do serviço: mensagem fixa + (no máximo 10) detalhes já saneados; nunca caminhos nem exceções. */
export function failureResponse(failure: ServiceFailure): NextResponse {
  const status = HTTP_STATUS[failure.code];
  const issues = failure.issues.slice(0, 10).map((issue) => issue.slice(0, 300));
  // Pendente: a decisão foi gravada, mas NÃO está confirmada. Nunca é um sucesso (2xx); reenviar o mesmo pedido a conclui.
  const extra: Record<string, string> = failure.code === 'ANCHOR_PENDING' ? { 'Retry-After': '5' } : {};
  return reply(
    {
      error: PUBLIC_MESSAGE[failure.code],
      code: failure.code,
      ...(issues.length > 0 ? { issues } : {}),
      ...(failure.head !== undefined ? { head: failure.head } : {}),
      ...(failure.pending !== undefined ? { pending: failure.pending } : {}),
    },
    status,
    extra,
  );
}

/** 201 = decisão nova confirmada; 200 = o pedido já tinha sido aplicado (reenvio) e agora está confirmado. */
export const successStatus = (value: { readonly replayed: boolean }): number => (value.replayed ? 200 : 201);

function configuredDir(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.includes('\0') || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

export interface DecisionContext {
  readonly service: DecisionService;
  readonly actor: EvidenceActor;
}

/** Relógio do servidor (ISO UTC com milissegundos); as rotas o entregam como função para que a hora seja tomada dentro da trava. */
export const serverClock = (): string => new Date().toISOString();

export const isAuditId = (value: unknown): value is string => typeof value === 'string' && AUDIT_ID_PATTERN.test(value);

/** Autentica, limita a taxa, confere a configuração e entrega o serviço; qualquer exceção vira erro genérico. */
export async function withDecisions(request: Request, mode: 'read' | 'write', handler: (ctx: DecisionContext) => Promise<NextResponse>): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;

  const verdict = (mode === 'write' ? writeLimiter : readLimiter).consume(access.operator);
  if (!verdict.allowed) {
    return reply({ error: 'Muitas requisições em pouco tempo. Aguarde um instante.', code: 'RATE_LIMITED' }, 429, { 'Retry-After': String(verdict.retryAfterSeconds) });
  }

  const decisionsDir = configuredDir(process.env.GMN_LINK_AUDIT_DECISIONS_DIR);
  if (!decisionsDir) return reply({ error: 'O armazenamento de decisões não está configurado neste servidor.', code: 'DECISIONS_NOT_CONFIGURED' }, 503);
  const anchorDir = configuredDir(process.env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR);
  if (!anchorDir) return reply({ error: 'O armazenamento de âncoras das decisões não está configurado neste servidor; nenhuma decisão é gravada.', code: 'ANCHOR_NOT_CONFIGURED' }, 503);
  const evidenceDir = configuredDir(process.env.GMN_LINK_AUDIT_EVIDENCE_DIR);
  if (!evidenceDir) return reply({ error: 'O armazenamento de evidências não está configurado neste servidor.', code: 'EVIDENCE_NOT_CONFIGURED' }, 503);

  // Chave de ORIGEM (nunca em log, resposta ou pasta de dados). Leitura sem chave funciona (a origem das pendentes fica "não verificável"); escrita não.
  const originConfig = originConfigFromEnv(undefined, () => new Date());
  if (mode === 'write' && !originConfig.ok) return reply({ error: PUBLIC_MESSAGE.ORIGIN_KEY_NOT_CONFIGURED, code: 'ORIGIN_KEY_NOT_CONFIGURED' }, HTTP_STATUS.ORIGIN_KEY_NOT_CONFIGURED);

  const actor: EvidenceActor = { email: access.operator };
  const reader = createEvidenceReader({ baseDir: evidenceDir, authorize: (candidate) => candidate.email === access.operator && candidate.email.length > 0 });
  try {
    const storage = await reader.storageStatus(actor);
    if (storage !== 'READY') return reply({ error: 'O armazenamento de evidências não está acessível ao servidor.', code: 'EVIDENCE_STORAGE_UNAVAILABLE' }, 503);
    // TESTEMUNHA do histórico: as cabeças já confirmadas em resultados selados (OUTRAS pastas). OBRIGATÓRIA: sem as DUAS pastas de resultados configuradas o fornecedor
    // responde `NOT_CONFIGURED` e a 6B trata o histórico como NÃO RESOLVIDO (falha fechada: nenhuma decisão vigente, nenhuma escrita). Nunca "sem inconsistência".
    const resultsDir = configuredDir(process.env.GMN_LINK_AUDIT_RESULTS_DIR);
    const resultsAnchorDir = configuredDir(process.env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR);
    const knownHeads = resultsDir && resultsAnchorDir ? createResultsKnownHeads({ baseDir: resultsDir, anchorDir: resultsAnchorDir, otherDirs: [decisionsDir, anchorDir, evidenceDir, ledgerDirOf()], ...(originConfig.ok ? { origin: originConfig.authenticator } : {}) }) : async () => ({ ok: false as const, reason: 'NOT_CONFIGURED' as const });
    const ledger = ledgerForRoutes([decisionsDir, anchorDir, evidenceDir, resultsDir, resultsAnchorDir]);
    const service = createDecisionService({ baseDir: decisionsDir, anchorDir, evidence: reader, evidenceBaseDir: evidenceDir, ...(originConfig.ok ? { origin: originConfig.authenticator } : {}), knownHeads, ledger });
    return await handler({ service, actor });
  } catch (error) {
    if (error instanceof EvidenceAccessError) return reply({ error: 'Acesso negado.', code: 'FORBIDDEN' }, 403);
    return internal(); // nada do erro (mensagem, caminho) é devolvido ou registrado
  }
}
