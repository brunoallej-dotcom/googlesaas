import { createHash } from 'node:crypto';
import { createOriginAuthenticator, ORIGIN_KEY_ENV } from '../../src/lib/link-audit-origin';

/*
 * Chaves de ORIGEM só para TESTE (nunca valem fora dos testes; produção usa GMN_LINK_AUDIT_ORIGIN_KEY, fora do repositório). O material é derivado
 * por SHA-256 de rótulos de teste (64 hexadecimais, o formato estrito de produção): não há segredo fixo parecido com um real no repositório.
 * `TEST_ORIGIN` é o "servidor legítimo"; `OTHER_ORIGIN` é uma chave diferente (chave errada/rotação); o invasor dos testes NÃO conhece nenhuma das duas.
 */
export const testKeyMaterial = (label: string): string => createHash('sha256').update(`gmn-test-only/origin/${label}`).digest('hex');
export const testKeySpec = (id: string, label = id): string => `${id}:${testKeyMaterial(label)}`;

export const TEST_ORIGIN_KEY = testKeySpec('ok-test-a');
export const OTHER_ORIGIN_KEY = testKeySpec('ok-test-b');
export const TEST_ORIGIN = createOriginAuthenticator(TEST_ORIGIN_KEY);
export const OTHER_ORIGIN = createOriginAuthenticator(OTHER_ORIGIN_KEY);

/** Variável de ambiente que as ROTAS leem; os testes de API a definem com `TEST_ORIGIN_KEY`. */
export const ORIGIN_ENV = ORIGIN_KEY_ENV;
