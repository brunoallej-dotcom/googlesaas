import type { BytesFsOps } from '../link-audit/fs-ops';
import { MAX_RUN_READ_BYTES } from './budget';
import { refusal, type SealsRefusal } from './codes';
import { checkoutPath, SEALS_ROOT, SEALS_SUBDIR, type ChannelEnvironment } from './paths';
import { MAX_TRUST_LIST_BYTES } from './trust-list';

/*
 * P9.5 (revisão do PR #74, item 9) — teto do ARQUIVO de manifestos de um ambiente: tudo sob `link-audit-seals/<amb>/seals/` no commit. A entrega
 * manda o arquivo INTEIRO a cada execução (§5.5.2, teto de 1000 arquivos) e o modo árvore do `seals-verify` lê o arquivo inteiro dentro do
 * teto único de leitura de uma execução (64 MiB, com a lista de confiança). Para a `main` nunca ter um arquivo que não se entrega, a admissão
 * (o job `seals` do PR e o modo árvore) recusa com `SEALS_ARCHIVE_FULL` quando o ambiente passaria de 1000 arquivos ou da soma de bytes.
 * Chegar ao teto exige uma mudança planejada do canal (spec §5.5.2, "Limite declarado"). Disco só por `lstat` (nada é lido).
 */

/** Manifestos e fechos de um ambiente (o teto de arquivos por execução da entrega). */
export const MAX_ARCHIVE_FILES = 1000;
/** A soma dos tamanhos do arquivo de um ambiente: o teto único de leitura de uma execução, menos a lista de confiança. */
export const MAX_ARCHIVE_BYTES = MAX_RUN_READ_BYTES - MAX_TRUST_LIST_BYTES;

/** Os caminhos do arquivo de um ambiente: TODO caminho sob `link-audit-seals/<amb>/seals/` (o que a entrega conta). */
export const archivePaths = (paths: Iterable<string>, env: ChannelEnvironment): string[] => {
  const prefix = `${SEALS_ROOT}/${env}/${SEALS_SUBDIR}/`;
  return [...paths].filter((repoPath) => repoPath.startsWith(prefix));
};

/**
 * `SEALS_ARCHIVE_FULL` (regra S-05): mais de `MAX_ARCHIVE_FILES` caminhos ⇒ detalhe `<amb> FILES`, sem olhar o disco; a soma dos tamanhos dos
 * arquivos comuns no checkout (`lstat`, sem ler) acima de `MAX_ARCHIVE_BYTES` ⇒ `<amb> BYTES`. Um caminho que não é arquivo comum não soma (o
 * S-04 o recusa quando é novo).
 */
export async function archiveRefusals(env: ChannelEnvironment, paths: readonly string[], repoRoot: string, fs: BytesFsOps): Promise<SealsRefusal[]> {
  if (paths.length > MAX_ARCHIVE_FILES) return [refusal('S-05', 'SEALS_ARCHIVE_FULL', null, `${env} FILES`)];
  let total = 0;
  for (const repoPath of paths) {
    try {
      const info = await fs.lstat(checkoutPath(repoRoot, repoPath));
      if (info.isFile() && !info.isSymbolicLink()) total += info.size;
    } catch {
      continue; // ausente ou ilegível: o S-04 (arquivo novo) ou o modo árvore recusam o arquivo em si
    }
    if (total > MAX_ARCHIVE_BYTES) return [refusal('S-05', 'SEALS_ARCHIVE_FULL', null, `${env} BYTES`)];
  }
  return [];
}
