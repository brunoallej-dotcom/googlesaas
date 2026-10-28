import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cópia durável dos PDFs em bucket PRIVADO do Supabase (opcional). Sempre via service role, no
 * servidor; nunca gera URL pública. Chaves seguem `audits/<auditId>/<arquivo>.pdf`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}\.pdf$/i;

export function privateBucketName(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const name = env.SUPABASE_PRIVATE_AUDIT_BUCKET?.trim();
  return name ? name : null;
}

export function privateObjectKey(auditId: string, fileName: string): string {
  if (!UUID.test(auditId)) throw new Error('Identificador de auditoria inválido para o armazenamento privado.');
  if (!SAFE_NAME.test(fileName) || fileName.includes('..')) throw new Error('Nome de arquivo inválido para o armazenamento privado.');
  return `audits/${auditId}/${fileName}`;
}

/** Baixa o PDF do bucket privado; `null` se não existir ou se o armazenamento falhar. */
export async function downloadPrivatePdf(
  supabase: SupabaseClient | null,
  bucket: string | null,
  auditId: string,
  fileName: string
): Promise<Buffer<ArrayBuffer> | null> {
  if (!supabase || !bucket) return null;
  let key: string;
  try {
    key = privateObjectKey(auditId, fileName);
  } catch {
    return null;
  }
  const { data, error } = await supabase.storage.from(bucket).download(key);
  if (error || !data) return null;
  const bytes = Buffer.from(await data.arrayBuffer()) as Buffer<ArrayBuffer>;
  return bytes.subarray(0, 5).toString() === '%PDF-' ? bytes : null;
}

/** Envia sem sobrescrever (`upsert: false`): se já existe, devolve `exists`. */
export async function uploadPrivatePdf(
  supabase: SupabaseClient,
  bucket: string,
  auditId: string,
  fileName: string,
  body: Buffer
): Promise<'uploaded' | 'exists' | { readonly error: string }> {
  const key = privateObjectKey(auditId, fileName);
  const { error } = await supabase.storage.from(bucket).upload(key, body, { contentType: 'application/pdf', upsert: false });
  if (!error) return 'uploaded';
  if (/already exists|Duplicate|resource already exists/i.test(error.message)) return 'exists';
  return { error: error.message };
}
