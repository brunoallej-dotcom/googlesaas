import { canonicalJson, sha256Hex } from '../canonical';
import { RULER_DATA } from './ruler';

/** Impressão digital da régua: qualquer mudança em pesos, faixas ou regras muda este valor (e exige nova scoreModelVersion). */
export const RULER_FINGERPRINT: string = sha256Hex(canonicalJson(RULER_DATA));

export function sha256OfCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
