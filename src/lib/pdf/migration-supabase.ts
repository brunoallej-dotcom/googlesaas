import type { SupabaseClient } from '@supabase/supabase-js';
import { baseName, type AuditPointerRow, type BucketObject, type DatabasePort, type StoragePort } from './migration';

/** Implementação real das portas de migração sobre o Supabase (service role, só no servidor/CLI). */
export function supabaseStoragePort(supabase: SupabaseClient, publicBaseUrl: string): StoragePort {
  return {
    async listObjects(bucket) {
      const out: BucketObject[] = [];
      const walk = async (prefix: string): Promise<void> => {
        const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset: 0 });
        if (error) throw new Error(`Falha ao listar ${bucket}/${prefix}: ${error.message}`);
        for (const entry of data ?? []) {
          const key = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.id === null) await walk(key);
          else out.push({ key, size: typeof entry.metadata?.size === 'number' ? entry.metadata.size : null });
        }
      };
      await walk('');
      return out;
    },
    async download(bucket, key) {
      const { data, error } = await supabase.storage.from(bucket).download(key);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async upload(bucket, key, body) {
      const { error } = await supabase.storage.from(bucket).upload(key, body, { contentType: 'application/pdf', upsert: false });
      if (!error) return 'uploaded';
      return /already exists|Duplicate/i.test(error.message) ? 'exists' : { error: error.message };
    },
    async getBucket(bucket) {
      const { data, error } = await supabase.storage.getBucket(bucket);
      return error || !data ? null : { public: data.public, fileSizeLimit: data.file_size_limit ?? null, allowedMimeTypes: data.allowed_mime_types ?? null };
    },
    async createPrivateBucket(bucket) {
      const { error } = await supabase.storage.createBucket(bucket, { public: false, fileSizeLimit: 20 * 1024 * 1024, allowedMimeTypes: ['application/pdf'] });
      if (error) throw new Error(`Falha ao criar o bucket privado ${bucket}: ${error.message}`);
    },
    async setBucketPublic(bucket, isPublic) {
      const { error } = await supabase.storage.updateBucket(bucket, { public: isPublic });
      if (error) throw new Error(`Falha ao alterar a visibilidade de ${bucket}: ${error.message}`);
    },
    async headPublic(bucket, key) {
      try {
        const encoded = key.split('/').map(encodeURIComponent).join('/');
        return (await fetch(`${publicBaseUrl}/storage/v1/object/public/${bucket}/${encoded}`, { method: 'HEAD' })).status;
      } catch {
        return 0;
      }
    },
  };
}

export function supabaseDatabasePort(supabase: SupabaseClient): DatabasePort {
  return {
    async listAuditsWithPdf() {
      const { data, error } = await supabase
        .from('gmn_audits')
        .select('id, pdf_storage_path, pdf_download_url, diagrammer_payload')
        .not('pdf_storage_path', 'is', null)
        .order('created_at', { ascending: true });
      if (error) throw new Error(`Falha ao ler auditorias: ${error.message}`);
      return (data ?? []) as AuditPointerRow[];
    },
    async updatePointers(auditId, values, expected) {
      let query = supabase.from('gmn_audits').update(values).eq('id', auditId);
      if (expected) {
        // Compare-and-set: só altera se os ponteiros ainda forem os esperados.
        query = expected.pdf_download_url === null ? query.is('pdf_download_url', null) : query.eq('pdf_download_url', expected.pdf_download_url);
        query = expected.pdf_storage_path === null ? query.is('pdf_storage_path', null) : query.eq('pdf_storage_path', expected.pdf_storage_path);
      }
      const { data, error } = await query.select('id');
      if (error) throw new Error(`Falha ao atualizar ponteiros de ${auditId}: ${error.message}`);
      return (data ?? []).length === 1;
    },
  };
}

export { baseName };
