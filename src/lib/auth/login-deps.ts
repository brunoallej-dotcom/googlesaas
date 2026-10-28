import { verifyWithSupabase, type CredentialVerifier } from './operators';

/** Ponto de injeção da verificação de credenciais (os testes substituem `verify`). */
export const loginDependencies: { verify: CredentialVerifier } = { verify: verifyWithSupabase };
