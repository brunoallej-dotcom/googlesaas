import path from 'node:path';
import { NextResponse } from 'next/server';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { AUDIT_ID_PATTERN, createEvidenceReader, EvidenceAccessError, type EvidenceActor, type EvidenceReader } from '@/lib/link-audit-evidence';
import { SlidingWindowLimiter } from '@/lib/rate-limit';

/*
 * Rotas de LEITURA das evidências armazenadas (Fase 6, Onda 5B). Somente GET. Regras:
 *  - `requireOperator` em toda requisição; o leitor ainda confere o ator (defesa em profundidade);
 *  - a raiz das evidências vem SÓ da configuração do servidor (`GMN_LINK_AUDIT_EVIDENCE_DIR`): o navegador
 *    envia apenas o identificador da auditoria e números; nunca caminhos;
 *  - o corpo bruto do provedor, chaves, tokens e caminhos do disco nunca são devolvidos;
 *  - mensagens de erro genéricas; respostas privadas sem cache; limite de requisições por operador.
 */
export const EVIDENCE_HEADERS = {
  'Cache-Control': 'no-store, private, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie',
} as const;

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;
const MAX_OFFSET = 10_000;
// A lista e o detalhe releem e conferem os arquivos (I/O): limite conservador por operador.
const limiter = new SlidingWindowLimiter(30, 60_000);

export function reply(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...EVIDENCE_HEADERS, ...extra } });
}

export const invalidParams = (): NextResponse => reply({ error: 'Parâmetros inválidos.', code: 'INVALID_PARAMS' }, 400);
export const notFound = (): NextResponse => reply({ error: 'Auditoria não encontrada.', code: 'NOT_FOUND' }, 404);
const internal = (): NextResponse => reply({ error: 'Não foi possível concluir a operação.', code: 'INTERNAL_ERROR' }, 500);

export interface EvidenceContext {
  readonly reader: EvidenceReader;
  readonly actor: EvidenceActor;
}

/** Valida a configuração: caminho absoluto, vindo do servidor. Sem a variável a funcionalidade fica desligada (503). */
function configuredRoot(): string | null {
  const raw = process.env.GMN_LINK_AUDIT_EVIDENCE_DIR?.trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) return null;
  return path.resolve(raw);
}

/** Executa um tratador de leitura depois de autenticar, limitar a taxa e conferir o armazenamento. */
export async function withEvidence(request: Request, handler: (ctx: EvidenceContext) => Promise<NextResponse>): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;

  const verdict = limiter.consume(access.operator);
  if (!verdict.allowed) {
    return reply({ error: 'Muitas consultas em pouco tempo. Aguarde um instante.', code: 'RATE_LIMITED' }, 429, { 'Retry-After': String(verdict.retryAfterSeconds) });
  }

  const baseDir = configuredRoot();
  if (!baseDir) {
    return reply({ error: 'O armazenamento de evidências não está configurado neste servidor.', code: 'EVIDENCE_NOT_CONFIGURED' }, 503);
  }
  const actor: EvidenceActor = { email: access.operator };
  const reader = createEvidenceReader({ baseDir, authorize: (candidate) => candidate.email === access.operator && candidate.email.length > 0 });
  try {
    const storage = await reader.storageStatus(actor);
    if (storage !== 'READY') {
      return reply({ error: 'O armazenamento de evidências não está acessível ao servidor.', code: 'EVIDENCE_STORAGE_UNAVAILABLE', reason: storage }, 503);
    }
    return await handler({ reader, actor });
  } catch (error) {
    if (error instanceof EvidenceAccessError) return reply({ error: 'Acesso negado.', code: 'FORBIDDEN' }, 403);
    return internal(); // nada do erro (mensagem, caminho) é devolvido ou registrado
  }
}

const NUMBER = /^\d{1,5}$/;

/** Só os parâmetros conhecidos, só números pequenos. `null` = inválido. */
export function readQuery(url: URL, allowed: readonly string[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || name in out || !NUMBER.test(value)) return null;
    out[name] = Number(value);
  }
  return out;
}

export function listWindow(query: Record<string, number>): { limit: number; offset: number } | null {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  if (limit < 1 || limit > MAX_LIMIT || offset > MAX_OFFSET) return null;
  return { limit, offset };
}

export const isAuditId = (value: unknown): value is string => typeof value === 'string' && AUDIT_ID_PATTERN.test(value);
