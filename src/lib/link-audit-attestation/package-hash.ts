import { canonicalJson, sha256Hex } from '../link-audit/canonical';
import { packageBodySchema, type PackageBody } from './schemas';

/**
 * `packageSha256` = SHA-256 de `canonicalJson` do corpo (spec §5.3): `delta`, `packageSha256` e `generatedAt` ficam de fora.
 * A entrada passa pelo esquema estrito de corpo: campo extra ou fora de forma lança, nunca é ignorado em silêncio (um campo ignorado
 * seria um campo que o aprovador não viu no hash). `observedHours` entra como armazenado; quem monta o pacote o arredonda (W2).
 */
export class PackageHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageHashError';
  }
}

export function computePackageSha256(input: unknown): string {
  const body = pickBody(input);
  const parsed = packageBodySchema.safeParse(body);
  if (!parsed.success) throw new PackageHashError(`corpo do pacote inválido: ${parsed.error.issues.map((i) => i.path.join('.') || '(raiz)').join(', ')}`);
  return sha256Hex(canonicalJson(parsed.data satisfies PackageBody));
}

/** Descarta só os três campos fora do hash; qualquer OUTRO campo extra continua sendo recusado pelo esquema estrito. */
function pickBody(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const { delta: _delta, packageSha256: _hash, generatedAt: _generatedAt, ...body } = input as Record<string, unknown>;
  return body;
}

/** `true` só se o `packageSha256` declarado é o que o corpo produz. Nunca lança. */
export function isPackageHashConsistent(pkg: { readonly packageSha256: string }): boolean {
  try {
    return computePackageSha256(pkg) === pkg.packageSha256;
  } catch {
    return false;
  }
}
