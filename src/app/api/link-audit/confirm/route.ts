import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { companyIdentitySchema, confirmIdentity } from '@/lib/link-audit/audit';
import { parseGoogleMapsLink } from '@/lib/link-audit/maps-link';
import { internalFailure, invalidBody, NO_STORE, readJsonBody } from '../body';

// Caracteres de controle, de direção de texto (bidi) e invisíveis permitem falsificar o que aparece na tela.
const HIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !HIDDEN_CHARACTERS.test(value), 'caracteres de controle ou invisíveis não são permitidos')
    .optional()
    .transform((value) => (value ? value : undefined));

const BodySchema = z
  .object({
    link: z.string().max(10_000),
    /** A caixa de confirmação explícita da tela. */
    acknowledged: z.literal(true),
    name: optionalText(200),
    city: optionalText(120),
    stateCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict();

/**
 * POST /api/link-audit/confirm — Fase 6, Onda 3.
 * Reanalisa o link NO SERVIDOR (identificadores do cliente nunca são aceitos) e, só se ele identificar
 * um perfil, monta a identidade confirmada com o contrato da Onda 1. O operador é o da sessão e a hora
 * é a do servidor. Nome, cidade e UF digitados são do operador e NÃO são evidência do Google.
 * Nada é gravado.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;

  try {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = BodySchema.safeParse(body.value);
    if (!parsed.success) return invalidBody();

    const link = parseGoogleMapsLink(parsed.data.link);
    if (link.status !== 'IDENTIFIED') {
      return NextResponse.json(
        {
          error: 'Este link não identifica uma empresa e não pode ser confirmado.',
          code: 'IDENTITY_NOT_CONFIRMABLE',
          linkStatus: link.status,
          linkCode: link.code,
        },
        { status: 409, headers: NO_STORE },
      );
    }

    const confirmed = confirmIdentity(link, { confirmedBy: access.operator, confirmedAt: new Date().toISOString() });
    if (!confirmed.ok) {
      return NextResponse.json(
        { error: 'Não foi possível confirmar a identidade.', code: 'CONFIRMATION_REJECTED' },
        { status: 409, headers: NO_STORE },
      );
    }

    const operatorProvided = {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.city ? { city: parsed.data.city } : {}),
      ...(parsed.data.stateCode ? { stateCode: parsed.data.stateCode } : {}),
    };
    const identity = companyIdentitySchema.safeParse({ ...confirmed.value, ...operatorProvided });
    if (!identity.success) return invalidBody();

    return NextResponse.json(
      { identity: identity.data, operatorProvided, persisted: false },
      { status: 200, headers: NO_STORE },
    );
  } catch {
    return internalFailure(); // nada do erro (nem o link) é devolvido ou registrado
  }
}
