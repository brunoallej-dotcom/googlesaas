import fs from 'node:fs';
import path from 'node:path';

/*
 * Localização da captura REAL da AUD-001 (primeira consulta LIVE), lida SOMENTE PARA LEITURA pelos testes que a usam.
 * O repositório é público: nem o caminho, nem o nome real da pasta, nem os dados da empresa ficam aqui. Quem tem a captura
 * define, fora da árvore (valores no dossiê offline do responsável):
 *   GMN_TEST_AUD001_BASE  = pasta-base das evidências (a que contém a pasta da auditoria);
 *   GMN_TEST_AUD001_AUDIT = nome da pasta da auditoria (padrão: o rótulo opaco `aud-001-autorizacao-01`).
 * Sem a pasta (CI e outras máquinas), os testes que dependem dela são ignorados.
 */
export const AUD001_BASE = process.env.GMN_TEST_AUD001_BASE ?? '';
export const AUD001_AUDIT = process.env.GMN_TEST_AUD001_AUDIT ?? 'aud-001-autorizacao-01';
export const AUD001_DIR = AUD001_BASE === '' ? '' : path.join(AUD001_BASE, AUD001_AUDIT);

/** `true` só se a pasta da captura existe nesta máquina e contém o arquivo indicado. */
export function aud001CapturePresent(marker = 'MANIFEST.json'): boolean {
  return AUD001_DIR !== '' && fs.existsSync(path.join(AUD001_DIR, marker));
}

/** Lê um JSON da captura (somente leitura). */
export function readAud001Json<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(AUD001_DIR, name), 'utf8')) as T;
}
