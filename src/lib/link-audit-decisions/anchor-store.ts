import type { FsOps } from '../link-audit/snapshot-store';
import {
  confirmReceipt,
  prepareReceiptDirectory,
  readReceipts,
  receiptBody,
  verifyReceipts,
  writeReceipt,
  type ReceiptProfile,
  type ReceiptShape,
  type ReceiptsRead,
  type ReceiptSummary,
} from '../link-audit-storage';
import type { Location, StoreFailure, StoreResult } from './files';
import { ANCHOR_FILE, ANCHOR_FILE_KIND, anchorFileName, anchorSchema, DECISION_SCHEMA_VERSION, MAX_ENTRY_BYTES, type AnchorFile, type DecisionEntry } from './types';

/*
 * Âncoras: um recibo imutável por entrada de decisão, em uma pasta SEPARADA (outro local de gravação). Elas existem para
 * detectar o que a cadeia de hashes sozinha não detecta: perda do FIM do histórico (arquivo(s) apagado(s)), refazer o hash
 * do último arquivo e restaurar um backup antigo. Ver `docs/phase6-auditoria-link/onda6b-adr-ancora-externa.md`.
 *
 * Desde a Onda 6C (I0) a MECÂNICA do protocolo vive em `../link-audit-storage/receipts.ts`; aqui ficam apenas o perfil da 6B
 * (nomes `aNNNN.json`, esquema, tamanho máximo e os TEXTOS das mensagens, idênticos aos de antes) e as funções com as
 * mesmas assinaturas que o restante da 6B já usa.
 */
export type AnchorSummary = ReceiptSummary;
export type AnchorsRead = ReceiptsRead<AnchorFile>;

/*
 * Guarda de TIPO: o protocolo genérico monta o corpo do recibo com as chaves de `ReceiptShape`; o esquema da 6B precisa ter
 * EXATAMENTE as mesmas. Se alguém acrescentar (ou tirar) um campo em `anchorSchema`, a compilação quebra aqui, em vez de o
 * erro só aparecer em execução (o cast do módulo neutro esconderia a diferença).
 */
type BodyKeys = keyof Omit<ReceiptShape, 'contentSha256'>;
type AnchorBodyKeys = keyof Omit<AnchorFile, 'contentSha256'>;
const sameBodyKeys: [BodyKeys] extends [AnchorBodyKeys] ? ([AnchorBodyKeys] extends [BodyKeys] ? true : never) : never = true;
void sameBodyKeys;

const DECISION_ANCHORS: ReceiptProfile<AnchorFile> = {
  schemaVersion: DECISION_SCHEMA_VERSION,
  kind: ANCHOR_FILE_KIND,
  prefix: 'a',
  filePattern: ANCHOR_FILE,
  fileName: anchorFileName,
  maxBytes: MAX_ENTRY_BYTES,
  schema: anchorSchema,
  /** Tentativas imediatas de gravar o recibo (erro transitório de volume). */
  attempts: 3,
  messages: {
    storeMissing: 'O armazenamento de âncoras não existe neste servidor.',
    storeNotDirectory: 'O armazenamento de âncoras não é um diretório comum.',
    auditNotDirectory: 'A pasta de âncoras da auditoria não é um diretório comum.',
    listingLabel: 'listagem das âncoras',
    directoryLabel: 'âncoras',
    suspicious: (name) => `Arquivo suspeito na pasta de âncoras: ${name}.`,
    gap: (expected, found) => `Lacuna na sequência de âncoras (esperado ${expected}, achado ${found}).`,
    otherAudit: (name) => `${name} pertence a outra auditoria.`,
    sequenceMismatch: (name, seq) => `${name}: a sequência interna (${seq}) não corresponde ao nome do arquivo.`,
    notChained: (name) => `${name}: não está encadeada à âncora anterior.`,
    truncated: (entries, receipts) =>
      `O histórico de decisões tem ${entries} arquivo(s), mas há âncora(s) até a posição ${receipts}: arquivos de decisão foram removidos ou o histórico foi restaurado de uma cópia antiga.`,
    mismatch: (seq) => `A decisão ${seq} não confere com a âncora gravada na pasta separada (arquivo reescrito ou substituído).`,
    tooManyUnanchored: (count) => `${count} decisões estão sem âncora (o máximo tolerado é 1): âncoras removidas ou pasta de âncoras trocada.`,
    fatalBefore: 'Erro fatal de disco anterior na pasta de âncoras: escritas interrompidas até reiniciar o servidor.',
    invalidContract: 'A âncora montada não segue o contrato (erro interno).',
    label: (name) => `A âncora ${name}`,
    exists: (name) => `A âncora ${name} já existe; nada foi sobrescrito.`,
    noAtomicLink: 'O armazenamento de âncoras não suporta link() atômico.',
    fatalNow: (errno) => `Erro fatal de disco (${errno}) na pasta de âncoras: escritas interrompidas.`,
    noAttempt: 'Nenhuma tentativa de gravar o recibo foi feita.',
    notLast: (name) => `A âncora ${name} existe, mas a pasta de âncoras não termina nela.`,
    notMatching: (name, seq) => `A âncora ${name} já existe e NÃO corresponde à decisão ${seq}.`,
  },
};

/** Lê e verifica TODAS as âncoras da auditoria (sequência, esquema, bytes, hash, encadeamento). Pasta ausente da auditoria = nenhuma. */
export function readAnchors(ops: FsOps, located: Location, auditId: string): Promise<StoreResult<AnchorsRead>> {
  return readReceipts(DECISION_ANCHORS, ops, located, auditId);
}

/**
 * Confronta as âncoras com o histórico de decisões. Âncora à frente do histórico (ou de um arquivo que não existe mais) =
 * TRUNCADO; hash diferente na mesma posição = reescrito. No máximo UMA decisão pode estar sem âncora.
 */
export function verifyAnchors(entries: readonly DecisionEntry[], anchors: readonly AnchorFile[]): StoreResult<AnchorSummary> {
  return verifyReceipts(DECISION_ANCHORS, entries, anchors);
}

export function anchorBody(entry: DecisionEntry, previousAnchor: AnchorFile | undefined, anchoredAt: string): Omit<AnchorFile, 'contentSha256'> {
  return receiptBody(DECISION_ANCHORS, entry, previousAnchor, anchoredAt);
}

export function prepareAnchorDirectory(ops: FsOps, located: Location): Promise<StoreFailure | null> {
  return prepareReceiptDirectory(DECISION_ANCHORS, ops, located);
}

/** Grava UMA âncora (só de forma atômica). Nunca sobrescreve: EEXIST ⇒ CONFLICT (o chamador relê). */
export function writeAnchor(ops: FsOps, located: Location, anchor: Omit<AnchorFile, 'contentSha256'>): Promise<StoreResult<AnchorFile>> {
  return writeReceipt(DECISION_ANCHORS, ops, located, anchor);
}

/**
 * ÚNICO ponto em que uma decisão deixa de ser PENDENTE e passa a ser CONFIRMADA: o recibo dela está durável na pasta separada.
 * `EEXIST` não é erro: outro processo (ou uma tentativa anterior que falhou depois do `link`) já gravou o recibo — só vale se
 * ele corresponde EXATAMENTE a esta entrada (mesmo número, mesmo hash, encadeado); qualquer diferença é adulteração.
 */
export function confirmAnchor(ops: FsOps, located: Location, entry: DecisionEntry, previous: AnchorFile | undefined, anchoredAt: string): Promise<StoreResult<AnchorFile>> {
  return confirmReceipt(DECISION_ANCHORS, ops, located, entry, previous, anchoredAt);
}
