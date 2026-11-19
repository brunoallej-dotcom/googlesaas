import { randomBytes, type KeyObject } from 'node:crypto';
import path from 'node:path';
import { errorCode, type BytesFsOps, type FileInfo, type FsOps } from '../link-audit/snapshot-store';
import { auditId as auditIdSchema } from './schemas';
import { runSignWithChain, sealFileName, serializeSealFile, signSealManifest, type SealManifest, type SignWithChainDeps } from './sign-chain';
import type { SignCoreResult, SignPlan, SignRefusal, SignRefusalCode } from './sign-core';

/*
 * P1 W4.3 — o DISCO do `sign` (spec §5.5 preâmbulo e passo 15; §5.5.1 item 4; §7.3; IA-12, IA-18; RS-04, RS-12). Encadeia: leitura ÚNICA de
 * `--package`, `--approval`, `--dossier` e, se indicado, `--risk-acceptance` (bytes exatos, pelo `FsOps` injetado, sem seguir link, com limite) → cadeia +
 * núcleo (`runSignWithChain`: recusas dos passos 1–10, confirmação humana pela porta injetada e só então a chave injetada) → corpo e assinatura
 * (`signSealManifest`) → gravação à prova de queda em `<seals-dir>/<auditId>/`:
 * temporário não secreto `.seal-NNNN.json.tmp-<aleatório>` + fsync do arquivo + `link()` exclusivo + remoção do temporário + fsync da pasta.
 * Único arquivo do `sign` que ESCREVE: só cria a subpasta da auditoria, o temporário e o nome final (por `link()`), e só remove o próprio temporário;
 * nunca apaga nem altera um `seal-NNNN.json`, nunca renomeia nem muda permissão. Sem CLI, tela TTY da confirmação, chave real, recibo nem autoteste
 * (W4.4/W4.5); sem relógio implícito (o instante vem de quem chama) e sem o verificador (o texto gravado vem conferido de `sign-chain.ts`).
 */

/**
 * Limites de leitura (nenhum definido na spec nem nos esquemas; escolhidos de forma conservadora, notas da W4.3 no §5.5.1). Pacote: o maior válido
 * (2000 entradas, delta cheio, textos no máximo) tem menos de 0,5 MiB; 2 MiB deixa folga para outra identação sem aceitar um arquivo arbitrário.
 * Aprovação: a maior válida tem menos de 8 KiB. Dossiê: só existência e hash, conteúdo humano (pode ser um PDF); o mesmo teto de 16 MiB do
 * orçamento de bytes do verificador v2 (`MAX_CLASSIFY_BYTES`). Acima disso: recusa, nunca leitura parcial.
 */
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
export const MAX_APPROVAL_BYTES = 64 * 1024;
export const MAX_DOSSIER_BYTES = 16 * 1024 * 1024;
/** Aceite formal de risco (passo 9): documento humano como o dossiê (pode ser um PDF assinado), só existência e hash; o mesmo teto (revisão da W4.1). */
export const MAX_RISK_ACCEPTANCE_BYTES = MAX_DOSSIER_BYTES;
/** O manifesto nasce somente leitura (o `link()` leva o mesmo inode: nenhum chmod toca o nome final). */
const SEAL_MODE = 0o444;
const TEMP_SUFFIX_BYTES = 16;
const TEMP_SUFFIX = /^[0-9a-f]{32}$/;

export interface SignRunInput {
  /** `--audit`: confrontado com pacote, aprovação e cadeia pelo núcleo; a subpasta de entrega deriva SÓ dele. */
  readonly auditId: string;
  readonly custodian: string;
  readonly packagePath: string;
  readonly approvalPath: string;
  readonly dossierPath: string;
  /**
   * `--risk-acceptance` (o argumento do CLI é da W4.4): o arquivo do aceite formal de risco citado na aprovação, ou `null` se não indicado. Quando
   * indicado, é lido uma vez como os outros (ilegível ⇒ recusa, mesmo com papéis distintos); o núcleo só o considera se os papéis coincidirem.
   */
  readonly riskAcceptancePath: string | null;
  readonly sealsDir: string;
  readonly trustKeys: string;
  readonly expectSeq: number;
  readonly first: boolean;
  readonly keyId: string;
}
export interface SignRunDeps extends Omit<SignWithChainDeps<KeyObject>, 'fs'> {
  /** Leitura das entradas (bytes exatos), da cadeia, e a gravação em `<seals-dir>/<auditId>/`. Nada além disso é tocado (RS-04). */
  readonly fs: BytesFsOps;
  /** Só para teste: o sufixo aleatório do temporário (32 hex); fora disso, recusa. */
  readonly tempSuffix?: () => string;
}
export interface SealWritten {
  readonly ok: true;
  readonly seq: number;
  readonly fileName: string;
  /** Caminho real gravado. Não vai para a saída do CLI (IA-14: sem caminho de disco). */
  readonly file: string;
}
export type SealWriteResult = SealWritten | SignRefusal;
export type SignRunResult = (SealWritten & { readonly seal: SealManifest; readonly plan: SignPlan }) | SignRefusal;

const refuse = (code: SignRefusalCode, message: string): SignRefusal => ({ ok: false, code, message });
const NOTHING_SIGNED = 'Nada foi assinado.';
const NOTHING_WRITTEN = 'Nada foi gravado como manifesto.';
const TEMP_LEFT = ' Pode ter ficado um temporário .seal-NNNN.json.tmp-* na pasta da auditoria: o verificador o ignora; o runbook manda apagá-lo.';
const BAD_AUDIT = refuse('USAGE', '--audit inválido (minúsculas, dígitos, "-" ou "_", 8 a 64 caracteres): nunca vira caminho. Nada foi gravado.');
const OTHER_AUDIT = refuse('UNEXPECTED', `O manifesto assinado não é da auditoria de --audit. ${NOTHING_WRITTEN}`);
const BAD_SUFFIX = refuse('UNEXPECTED', `Nome de temporário fora de forma. ${NOTHING_WRITTEN}`);
const UNSAFE_DIR = refuse('SIGN_WRITE_FAILED', `A pasta de manifestos ou a subpasta da auditoria não é um diretório comum (link simbólico, arquivo, ausente) ou mudou durante o sign. ${NOTHING_WRITTEN}`);
const BEFORE_WRITE = refuse('UNEXPECTED', `Falha inesperada antes da gravação (cadeia, núcleo ou abertura da chave). ${NOTHING_WRITTEN}`);
const writeFailed = (tempLeft: boolean): SignRefusal => refuse('SIGN_WRITE_FAILED', `Falha ao gravar o manifesto (escrita, fsync ou link do temporário; sem espaço, erro de disco ou permissão). ${NOTHING_WRITTEN}${tempLeft ? TEMP_LEFT : ''}`);
const seqConflict = (fileName: string, tempLeft = false): SignRefusal =>
  refuse('SIGN_SEQ_CONFLICT', `${fileName} já existe na pasta da auditoria (outra execução gravou este seq): nada foi sobrescrito. Confira o registro externo e refaça a partir da cadeia atualizada.${tempLeft ? TEMP_LEFT : ''}`);
const unconfirmed = (fileName: string): SignRefusal =>
  refuse('SIGN_WRITE_UNCONFIRMED', `${fileName} foi criado, mas a confirmação em disco falhou (remoção do temporário ou fsync da pasta): a gravação NÃO está confirmada. Não entregue o manifesto nem emita recibo; o sign nunca o apaga. Confira o disco e trate como incidente (runbook).`);

/* ------------------------------------------------------------------------------------------------------------------- leitura única (IA-18) */

type InputBytes = { readonly packageBytes: Uint8Array; readonly approvalBytes: Uint8Array; readonly dossierBytes: Uint8Array; readonly riskAcceptanceBytes: Uint8Array | null };

/**
 * UMA leitura por entrada, pelo `FsOps` injetado (sem seguir link, sem travar em FIFO, tipo e tamanho no descritor, limite), e uma CÓPIA dos bytes:
 * o que o núcleo julga, o hash do dossiê e o que é assinado saem desta cópia, que nem a fonte (mexendo no buffer que devolveu) nem o disco alteram.
 */
async function readOnce(fs: BytesFsOps, file: string, argument: string, maxBytes: number): Promise<Uint8Array | SignRefusal> {
  try {
    return Uint8Array.from(await fs.readFileBytes(path.resolve(file), maxBytes));
  } catch (error) {
    if (errorCode(error) === 'ETOOBIG') return refuse('SIGN_INPUT_UNREADABLE', `${argument} acima do limite de ${maxBytes} bytes. ${NOTHING_SIGNED}`);
    return refuse('SIGN_INPUT_UNREADABLE', `${argument} não pôde ser lido como arquivo comum (inexistente, link simbólico, diretório, especial ou ilegível). ${NOTHING_SIGNED}`);
  }
}

async function readInputs(fs: BytesFsOps, input: SignRunInput): Promise<InputBytes | SignRefusal> {
  const packageBytes = await readOnce(fs, input.packagePath, '--package', MAX_PACKAGE_BYTES);
  if (!(packageBytes instanceof Uint8Array)) return packageBytes;
  const approvalBytes = await readOnce(fs, input.approvalPath, '--approval', MAX_APPROVAL_BYTES);
  if (!(approvalBytes instanceof Uint8Array)) return approvalBytes;
  const dossierBytes = await readOnce(fs, input.dossierPath, '--dossier', MAX_DOSSIER_BYTES);
  if (!(dossierBytes instanceof Uint8Array)) return dossierBytes;
  if (input.riskAcceptancePath === null) return { packageBytes, approvalBytes, dossierBytes, riskAcceptanceBytes: null };
  const riskAcceptanceBytes = await readOnce(fs, input.riskAcceptancePath, '--risk-acceptance', MAX_RISK_ACCEPTANCE_BYTES);
  if (!(riskAcceptanceBytes instanceof Uint8Array)) return riskAcceptanceBytes;
  return { packageBytes, approvalBytes, dossierBytes, riskAcceptanceBytes };
}

/**
 * A raiz da cópia da estação, resolvida UMA vez pelo caminho real: a cadeia é lida e o manifesto é gravado na MESMA pasta, mesmo que um link no
 * caminho de `--seals-dir` mude no meio. Se não resolve, segue o caminho informado e a leitura da cadeia dá a recusa de sempre (W4.2).
 */
async function pinnedRoot(fs: FsOps, sealsDir: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(sealsDir));
  } catch {
    return sealsDir;
  }
}

/** Leitura única → cadeia + núcleo (passos 1–10, confirmação humana no 11, chave só no fim) → corpo e assinatura (13) → gravação (15). Devolve o gravado ou a recusa. */
export async function runSign(input: SignRunInput, deps: SignRunDeps): Promise<SignRunResult> {
  const bytes = await readInputs(deps.fs, input);
  if ('ok' in bytes) return bytes;
  const root = await pinnedRoot(deps.fs, input.sealsDir);
  let decided: SignCoreResult<KeyObject>;
  try {
    const { auditId, custodian, trustKeys, expectSeq, first, keyId } = input;
    decided = await runSignWithChain({ auditId, custodian, ...bytes, sealsDir: root, trustKeys, expectSeq, first, keyId }, { fs: deps.fs, now: deps.now, confirm: deps.confirm, openKey: deps.openKey });
  } catch {
    return BEFORE_WRITE; // o objeto de erro nunca sai daqui (pode vir do leitor de chave, RS-13)
  }
  if (!decided.ok) return decided;
  const signed = signSealManifest(decided.plan, input.keyId, decided.key);
  if (!signed.ok) return signed;
  const written = await publishSeal(deps.fs, { sealsDir: root, auditId: input.auditId, seal: signed.seal }, deps.tempSuffix ? { tempSuffix: deps.tempSuffix } : {});
  return written.ok ? { ...written, seal: signed.seal, plan: decided.plan } : written;
}

/* ------------------------------------------------------------------------------------------------------------------- gravação (IA-12) */

export interface SealTarget {
  /** A raiz da cópia da estação pelo CAMINHO REAL (`runSign` a fixa antes da cadeia); outra coisa é recusada. */
  readonly sealsDir: string;
  /** `--audit` validado: a subpasta deriva só dele. */
  readonly auditId: string;
  readonly seal: SealManifest;
}

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
async function rootIsReal(fs: FsOps, sealsDir: string): Promise<boolean> {
  try {
    return path.isAbsolute(sealsDir) && (await fs.realpath(sealsDir)) === sealsDir && (await fs.lstat(sealsDir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `<raiz>/<auditId>/`, sem seguir link: criada se ausente (e a raiz sincronizada, para a pasta nova sobreviver a uma queda); link simbólico, arquivo
 * ou caminho real diferente ⇒ recusa.
 */
async function auditDir(fs: FsOps, root: string, auditId: string): Promise<{ readonly ok: true; readonly dir: string } | SignRefusal> {
  const dir = path.join(root, auditId);
  let info: FileInfo;
  let created = false;
  try {
    info = await fs.lstat(dir);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return UNSAFE_DIR;
    if (!(await attempt(() => fs.mkdir(dir)))) return writeFailed(false);
    created = true;
    try {
      info = await fs.lstat(dir);
    } catch {
      return UNSAFE_DIR;
    }
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return UNSAFE_DIR;
  try {
    if ((await fs.realpath(dir)) !== dir) return UNSAFE_DIR;
  } catch {
    return UNSAFE_DIR;
  }
  if (created && !(await attempt(() => fs.syncDirectory(root)))) return writeFailed(false);
  return { ok: true, dir };
}

/**
 * §5.5.1 item 4: temporário EXCLUSIVO (criação + escrita + fsync do arquivo, contrato de `FsOps.writeExclusive`) → `link()` para o nome final
 * (existe ⇒ `SIGN_SEQ_CONFLICT`, nada sobrescrito) → remoção do temporário → fsync da pasta. Sem `link()` (EPERM, EXDEV, ENOSYS…) é recusa: nunca a
 * escrita direta não atômica do nome final. Antes do `link()` o temporário (se for deste processo) é removido em qualquer falha; depois dele, o
 * manifesto existe e nunca é apagado, e qualquer falha é `SIGN_WRITE_UNCONFIRMED`, nunca sucesso.
 */
async function commitSeal(fs: FsOps, dir: string, fileName: string, temp: string, text: string): Promise<SignRefusal | null> {
  try {
    await fs.writeExclusive(temp, text, SEAL_MODE);
  } catch (error) {
    // EEXIST: um temporário com este nome que NÃO é deste processo (nunca é apagado); senão, o parcial é nosso
    const tempLeft = errorCode(error) === 'EEXIST' ? false : !(await attempt(() => fs.unlink(temp)));
    return writeFailed(tempLeft);
  }
  try {
    await fs.link(temp, path.join(dir, fileName));
  } catch (error) {
    const tempLeft = !(await attempt(() => fs.unlink(temp)));
    // revisão da W4.3: o conflito também avisa quando a limpeza do temporário falhou (o resíduo não é secreto, mas precisa de limpeza pelo runbook)
    return errorCode(error) === 'EEXIST' ? seqConflict(fileName, tempLeft) : writeFailed(tempLeft);
  }
  const removed = await attempt(() => fs.unlink(temp));
  const synced = await attempt(() => fs.syncDirectory(dir));
  return removed && synced ? null : unconfirmed(fileName);
}

/**
 * Grava o manifesto assinado em `<sealsDir>/<auditId>/seal-NNNN.json` (nome = `seq` assinado). O texto é conferido antes de tocar o disco
 * (`serializeSealFile`: tamanho e leitura de volta pelo verificador). Nunca lança e nunca sobrescreve.
 */
export async function publishSeal(fs: FsOps, target: SealTarget, options: { readonly tempSuffix?: () => string } = {}): Promise<SealWriteResult> {
  if (typeof target.auditId !== 'string' || !auditIdSchema.safeParse(target.auditId).success) return BAD_AUDIT;
  if (target.seal?.auditId !== target.auditId) return OTHER_AUDIT;
  const text = serializeSealFile(target.seal);
  if (!text.ok) return text;
  const suffix = tempSuffixOf(options.tempSuffix);
  if (suffix === null) return BAD_SUFFIX;
  if (!(await rootIsReal(fs, target.sealsDir))) return UNSAFE_DIR;
  const prepared = await auditDir(fs, target.sealsDir, target.auditId);
  if (!prepared.ok) return prepared;
  const fileName = sealFileName(target.seal);
  const failed = await commitSeal(fs, prepared.dir, fileName, path.join(prepared.dir, `.${fileName}.tmp-${suffix}`), text.text);
  return failed ?? { ok: true, seq: target.seal.seq, fileName, file: path.join(prepared.dir, fileName) };
}
