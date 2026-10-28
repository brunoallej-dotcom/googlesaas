import { createClient } from '@supabase/supabase-js';
import type { AuthEnv } from './guard';

/**
 * Confere e-mail e senha no Supabase Auth (sem criar usuários e sem persistir sessão do Supabase).
 * Quem decide se o operador PODE entrar é a lista `GMN_OPERATOR_EMAILS`; o Supabase só confirma a
 * senha. Devolve `false` para qualquer falha (credencial errada, serviço fora do ar, configuração
 * ausente): o chamador nunca distingue o motivo ao cliente.
 */
export type CredentialVerifier = (email: string, password: string, env: AuthEnv) => Promise<boolean>;

export const verifyWithSupabase: CredentialVerifier = async (email, password, env) => {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey || url.includes('your-project-ref')) return false;
  try {
    const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.user?.email) return false;
    // Garante que a conta autenticada é a mesma pedida (e-mail confirmado pelo provedor).
    return data.user.email.trim().toLowerCase() === email.trim().toLowerCase();
  } catch {
    return false;
  }
};
