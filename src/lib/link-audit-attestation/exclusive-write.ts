import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { errorCode, type FileInfo, type FsOps } from '../link-audit/fs-ops';

/*
 * A CRIAÇÃO EXCLUSIVA e durável de um arquivo de manifesto (P1 W4.3, spec do P1 §5.5.1 item 4; IA-12), extraída sem mudança de comportamento de
 * `sign-run.ts` na P9.3b (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.7 passo 7) para ser COMPARTILHADA pelo `sign`/`close-key` e pelo
 * receptor de manifestos do host: raiz real → subpasta (criada se ausente, com fsync da raiz) → temporário exclusivo `.<nome>.tmp-<32 hex>`
 * (criação + escrita + fsync, contrato de `FsOps.writeExclusive`) → `link()` exclusivo para o nome final → remoção do temporário → fsync da pasta.
 * Disco SÓ pelo `FsOps` injetado. Nunca sobrescreve, nunca renomeia, nunca muda permissão e nunca apaga o nome final; só remove o próprio
 * temporário. As recusas são de quem chama (`ExclusiveWriteOutcomes`): o `sign` passa as mensagens dele, o receptor os códigos dele.
 */

/** O manifesto nasce somente leitura (o `link()` leva o mesmo inode: nenhum chmod toca o nome final). */
export const SEAL_MODE = 0o444;
const TEMP_SUFFIX_BYTES = 16;
/** O sufixo aleatório do temporário: 32 hex (16 bytes). */
export const TEMP_SUFFIX = /^[0-9a-f]{32}$/;

/** As recusas que a gravação devolve por conta própria (as do nome final ficam no `ExclusiveTarget`). `ok: false` as distingue do sucesso. */
export interface ExclusiveWriteOutcomes<R extends { readonly ok: false }> {
  /** Sufixo do temporário fora de forma: nada foi tocado. */
  readonly badSuffix: R;
  /** A raiz ou a subpasta não é um diretório comum (link, arquivo, ausente) ou mudou no meio: nada foi gravado. */
  readonly unsafeDir: R;
  /** Falha antes do `link()` (mkdir, escrita, fsync ou link): nada foi gravado; `tempLeft` = o temporário deste processo pode ter ficado. */
  readonly writeFailed: (tempLeft: boolean) => R;
}

export interface ExclusiveTarget<R extends { readonly ok: false }> {
  /** A raiz pelo CAMINHO REAL; outra coisa é recusada. */
  readonly root: string;
  /** A subpasta da raiz (a da auditoria, ou `_closures`). */
  readonly dirName: string;
  readonly fileName: string;
  /** Os bytes exatos a gravar (já conferidos por quem chama). */
  readonly text: string;
  /** O nome final já existe (outra execução o gravou): nada sobrescrito. */
  readonly conflict: (tempLeft: boolean) => R;
  /** Falha depois do `link()`: o arquivo existe, mas não está confirmado. */
  readonly unconfirmed: R;
}

export type ExclusiveWriteResult<R extends { readonly ok: false }> = { readonly ok: true; readonly file: string } | R;

const attempt = async (task: () => Promise<void>): Promise<boolean> => {
  try {
    await task();
    return true;
  } catch {
    return false; // quem chama converte em recusa (nunca em sucesso); o sign não tem logger (RS-13)
  }
};

function tempSuffixOf(source: (() => string) | undefined): string | null {
  try {
    const value = source ? source() : randomBytes(TEMP_SUFFIX_BYTES).toString('hex');
    return typeof value === 'string' && TEMP_SUFFIX.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** A raiz tem de ser um diretório e o seu próprio caminho real (um link trocado no meio do caminho depois de fixada a raiz ⇒ recusa). */
export async function rootIsReal(fs: FsOps, sealsDir: string): Promise<boolean> {
  try {
    return path.isAbsolute(sealsDir) && (await fs.realpath(sealsDir)) === sealsDir && (await fs.lstat(sealsDir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Estado de `<raiz>/<nome>/` SEM criar nada (a mesma regra de `subDir`): `absent` (ENOENT), `real` (diretório comum, sem link, e o próprio caminho
 * real), `unsafe` (link simbólico, arquivo, outro tipo, caminho real diferente ou erro de leitura). Para quem precisa conferir antes de gravar
 * (o receptor de manifestos, §5.7 passo 4).
 */
export async function subDirState(fs: FsOps, root: string, name: string): Promise<'absent' | 'real' | 'unsafe'> {
  const dir = path.join(root, name);
  let info: FileInfo;
  try {
    info = await fs.lstat(dir);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unsafe';
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return 'unsafe';
  try {
    return (await fs.realpath(dir)) === dir ? 'real' : 'unsafe';
  } catch {
    return 'unsafe';
  }
}

/**
 * `<raiz>/<nome>/` (a subpasta da auditoria, ou `_closures` no `close-key`), sem seguir link: criada se ausente (e a raiz sincronizada, para a pasta
 * nova sobreviver a uma queda); link simbólico, arquivo ou caminho real diferente ⇒ recusa.
 */
async function subDir<R extends { readonly ok: false }>(fs: FsOps, root: string, name: string, outcomes: ExclusiveWriteOutcomes<R>): Promise<{ readonly ok: true; readonly dir: string } | R> {
  const dir = path.join(root, name);
  let info: FileInfo;
  let created = false;
  try {
    info = await fs.lstat(dir);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return outcomes.unsafeDir;
    if (!(await attempt(() => fs.mkdir(dir)))) return outcomes.writeFailed(false);
    created = true;
    try {
      info = await fs.lstat(dir);
    } catch {
      return outcomes.unsafeDir;
    }
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return outcomes.unsafeDir;
  try {
    if ((await fs.realpath(dir)) !== dir) return outcomes.unsafeDir;
  } catch {
    return outcomes.unsafeDir;
  }
  if (created && !(await attempt(() => fs.syncDirectory(root)))) return outcomes.writeFailed(false);
  return { ok: true, dir };
}

/**
 * §5.5.1 item 4: temporário EXCLUSIVO (criação + escrita + fsync do arquivo, contrato de `FsOps.writeExclusive`) → `link()` para o nome final
 * (existe ⇒ `conflict`, nada sobrescrito) → remoção do temporário → fsync da pasta. Sem `link()` (EPERM, EXDEV, ENOSYS…) é recusa: nunca a
 * escrita direta não atômica do nome final. Antes do `link()` o temporário (se for deste processo) é removido em qualquer falha; depois dele, o
 * manifesto existe e nunca é apagado, e qualquer falha é `unconfirmed`, nunca sucesso.
 */
async function commitFile<R extends { readonly ok: false }>(fs: FsOps, target: ExclusiveTarget<R>, outcomes: ExclusiveWriteOutcomes<R>, dir: string, temp: string): Promise<R | null> {
  const { fileName, text } = target;
  try {
    await fs.writeExclusive(temp, text, SEAL_MODE);
  } catch (error) {
    // EEXIST: um temporário com este nome que NÃO é deste processo (nunca é apagado); senão, o parcial é nosso
    const tempLeft = errorCode(error) === 'EEXIST' ? false : !(await attempt(() => fs.unlink(temp)));
    return outcomes.writeFailed(tempLeft);
  }
  try {
    await fs.link(temp, path.join(dir, fileName));
  } catch (error) {
    const tempLeft = !(await attempt(() => fs.unlink(temp)));
    // revisão da W4.3: o conflito também avisa quando a limpeza do temporário falhou (o resíduo não é secreto, mas precisa de limpeza pelo runbook)
    return errorCode(error) === 'EEXIST' ? target.conflict(tempLeft) : outcomes.writeFailed(tempLeft);
  }
  const removed = await attempt(() => fs.unlink(temp));
  const synced = await attempt(() => fs.syncDirectory(dir));
  return removed && synced ? null : target.unconfirmed;
}

/** Raiz real → subpasta (criada se ausente) → temporário + `link()` exclusivo + fsync (`commitFile`). Nunca lança e nunca sobrescreve. */
export async function linkExclusive<R extends { readonly ok: false }>(fs: FsOps, target: ExclusiveTarget<R>, outcomes: ExclusiveWriteOutcomes<R>, tempSuffix: (() => string) | undefined): Promise<ExclusiveWriteResult<R>> {
  const suffix = tempSuffixOf(tempSuffix);
  if (suffix === null) return outcomes.badSuffix;
  if (!(await rootIsReal(fs, target.root))) return outcomes.unsafeDir;
  const prepared = await subDir(fs, target.root, target.dirName, outcomes);
  if (!prepared.ok) return prepared;
  const failed = await commitFile(fs, target, outcomes, prepared.dir, path.join(prepared.dir, `.${target.fileName}.tmp-${suffix}`));
  return failed ?? { ok: true, file: path.join(prepared.dir, target.fileName) };
}
