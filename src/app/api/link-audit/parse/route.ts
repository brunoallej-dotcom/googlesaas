import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { parseGoogleMapsLink } from '@/lib/link-audit/maps-link';
import { internalFailure, invalidBody, NO_STORE, readJsonBody } from '../body';

const BodySchema = z.object({ link: z.string().max(10_000) }).strict();

/**
 * POST /api/link-audit/parse — Fase 6, Onda 3.
 * Analisa o TEXTO do link com o parser da Onda 1. Não faz nenhuma requisição externa (links curtos
 * ficam "resolução pendente"), não segue redirecionamentos, não grava nada e não registra o link.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;

  try {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = BodySchema.safeParse(body.value);
    if (!parsed.success) return invalidBody();

    const result = parseGoogleMapsLink(parsed.data.link);
    return NextResponse.json({ result, externalLookup: false, persisted: false }, { status: 200, headers: NO_STORE });
  } catch {
    return internalFailure(); // nada do erro (nem o link) é devolvido ou registrado
  }
}
