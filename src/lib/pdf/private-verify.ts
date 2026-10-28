import { forgedToken } from '@/lib/rls-probe';
import type { StoragePort } from './migration';

export interface AccessCheck {
  readonly check: string;
  readonly status: number | string;
  readonly passed: boolean;
  readonly detail: string;
}

/** O bucket precisa ser privado, só PDF e com limite de tamanho. */
export async function checkBucketConfig(storage: StoragePort, bucket: string): Promise<AccessCheck[]> {
  const info = await storage.getBucket(bucket);
  if (!info) return [{ check: `bucket ${bucket} existe`, status: 'ausente', passed: false, detail: 'bucket não encontrado' }];
  return [
    { check: 'bucket privado (public=false)', status: String(info.public), passed: info.public === false, detail: `public=${info.public}` },
    { check: 'somente application/pdf', status: JSON.stringify(info.allowedMimeTypes ?? null), passed: Array.isArray(info.allowedMimeTypes) && info.allowedMimeTypes.length === 1 && info.allowedMimeTypes[0] === 'application/pdf', detail: 'tipos permitidos' },
    { check: 'limite de tamanho definido', status: String(info.fileSizeLimit ?? null), passed: typeof info.fileSizeLimit === 'number' && info.fileSizeLimit > 0, detail: `limite=${info.fileSizeLimit ?? 'nenhum'}` },
  ];
}

/**
 * Acesso NÃO autenticado/indevido ao bucket novo: nenhuma das vias pode devolver o arquivo nem
 * listar objetos. Só leitura (sem escrita anônima, para não criar objetos).
 */
export async function checkAnonymousDenied(params: {
  readonly baseUrl: string;
  readonly anonKey: string;
  readonly bucket: string;
  readonly keys: readonly string[];
  readonly fetchImpl?: typeof fetch;
}): Promise<AccessCheck[]> {
  const f = params.fetchImpl ?? fetch;
  const out: AccessCheck[] = [];
  const encode = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

  for (const key of params.keys) {
    const short = key.length > 52 ? `…${key.slice(-50)}` : key;
    const publicUrl = await f(`${params.baseUrl}/storage/v1/object/public/${params.bucket}/${encode(key)}`, { method: 'HEAD' });
    out.push({ check: `URL pública sem credencial: ${short}`, status: publicUrl.status, passed: publicUrl.status !== 200, detail: 'esperado: 400/404' });
    const withAnon = await f(`${params.baseUrl}/storage/v1/object/authenticated/${params.bucket}/${encode(key)}`, { method: 'HEAD', headers: { apikey: params.anonKey, Authorization: `Bearer ${params.anonKey}` } });
    out.push({ check: `chave anon (papel anon): ${short}`, status: withAnon.status, passed: withAnon.status !== 200, detail: 'esperado: negado' });
    const forged = await f(`${params.baseUrl}/storage/v1/object/authenticated/${params.bucket}/${encode(key)}`, { method: 'HEAD', headers: { apikey: params.anonKey, Authorization: `Bearer ${forgedToken()}` } });
    out.push({ check: `token forjado (service_role falso): ${short}`, status: forged.status, passed: forged.status !== 200, detail: 'esperado: 400/401' });
  }
  const list = await f(`${params.baseUrl}/storage/v1/object/list/${params.bucket}`, { method: 'POST', headers: { apikey: params.anonKey, Authorization: `Bearer ${params.anonKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'audits', limit: 10 }) });
  const body = (await list.json().catch(() => null)) as unknown;
  const visible = Array.isArray(body) ? body.length : 0;
  out.push({ check: 'listagem de objetos com a chave anon', status: list.status, passed: visible === 0, detail: `objetos visíveis: ${visible}` });
  const buckets = await f(`${params.baseUrl}/storage/v1/bucket`, { headers: { apikey: params.anonKey, Authorization: `Bearer ${params.anonKey}` } });
  const bucketBody = (await buckets.json().catch(() => null)) as unknown;
  const seen = Array.isArray(bucketBody) ? (bucketBody as { name?: string }[]).some((b) => b.name === params.bucket) : false;
  out.push({ check: 'bucket novo aparece para a chave anon', status: buckets.status, passed: !seen, detail: seen ? 'VISÍVEL' : 'não visível' });
  return out;
}
