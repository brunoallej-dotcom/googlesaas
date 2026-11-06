/*
 * TESTEMUNHA do histórico de decisões (R3-MINOR-2, R4-MINOR-1, INFO-1; decisões do responsável de 01/11/2026).
 *
 * PROBLEMA: o histórico de decisões vive em pastas que quem escreve nelas controla. Uma decisão revogada só deixa de valer porque a ENTRADA
 * de revogação existe. Se essa entrada (ou o seu recibo) desaparece — removida por quem escreve só nos recibos e depois "mandada para a
 * quarentena" por um operador, ou perdida numa restauração parcial —, o replay devolveria a decisão antiga ao estado ACTIVE.
 *
 * REGRA: uma FONTE INDEPENDENTE de "cabeças conhecidas" (cada uma é `seq` + `sha256` de uma entrada que já foi CONFIRMADA) é consultada na
 * leitura e na escrita. Se o histórico de hoje NÃO contém uma cabeça conhecida (retrocesso), ou contém outra entrada naquela posição
 * (divergência), ou se a fonte não está configurada, não pôde ser lida ou não é confiável, a integridade fica NÃO RESOLVIDA e a resposta é
 * FALHAR FECHADO: nenhuma decisão é projetada como vigente, o motor não recebe nenhuma, nada é finalizável e nenhuma escrita é aceita.
 *
 * NUNCA, em hipótese alguma, a AUSÊNCIA de informação vira "consistente":
 *  - fonte sem configuração            ⇒ `NOT_CONFIGURED` (NÃO RESOLVIDO);
 *  - armazenamento ilegível/ausente    ⇒ `UNAVAILABLE` (NÃO RESOLVIDO);
 *  - cadeia de resultados que não confere (adulterada, truncada, recibos) ⇒ `UNTRUSTED` (NÃO RESOLVIDO);
 *  - resultado PENDENTE cuja origem não é comprovada (chave aposentada vencida, revogada, desconhecida, ausente ou arquivo forjado) NÃO é testemunha
 *    — mas é um INDÍCIO de que existiu histórico: se o que ele afirma NÃO bate com o histórico de hoje, a testemunha é `UNTRUSTED` (NÃO RESOLVIDO);
 *    se bate, é ignorado. Um indício NUNCA é promovido a testemunha, e uma chave comprometida NUNCA torna confiável uma pendência;
 *  - fonte legível, configurada e SEM nenhuma cabeça ⇒ `UNWITNESSED`: a testemunha ainda NÃO EXISTE (é o estado de toda auditoria nova). Não é uma
 *    garantia: o sistema diz quantas revogações/substituições ficam sem cobertura (`unwitnessedAffecting`).
 *
 * Este módulo é PURO e NEUTRO: não conhece quem fornece as cabeças (hoje: os resultados selados da 6C, que vivem em outras pastas; amanhã, o
 * LIVRO DE CABEÇAS especificado em `onda6c-especificacao-livro-de-cabecas.md`). Sem fornecedor DECLARADO a construção do serviço não compila:
 * omitir a testemunha não é possível por esquecimento (ver `WITNESS_NOT_REQUIRED`).
 *
 * LIMITE (BLOQUEADOR PARA PRODUÇÃO): `UNWITNESSED`/cobertura parcial — uma revogação posterior à última cabeça não tem testemunha; mover os arquivos
 * dela não é detectado. Só o livro de cabeças (ou uma guarda externa) fecha essa janela. Quem altera as DUAS pastas (a de decisões e a da fonte)
 * também não é detectado.
 */
export interface KnownHead {
  readonly seq: number;
  readonly sha256: string;
}

/** Por que a fonte não pôde dar cabeças. `NOT_CONFIGURED`: dependência ausente/insegura. `STORAGE_UNAVAILABLE`: não leu. `UNTRUSTED`: leu, mas não confere. */
export type KnownHeadsFailure = 'NOT_CONFIGURED' | 'STORAGE_UNAVAILABLE' | 'UNTRUSTED';

export type KnownHeadsRead =
  | {
      readonly ok: true;
      /** Cabeças CONFIABILIZADAS (confirmadas, ou pendentes de origem comprovada): são testemunhas. */
      readonly heads: readonly KnownHead[];
      /** INDÍCIOS (pendentes de origem NÃO comprovada): nunca são testemunhas; só denunciam histórico que o de hoje não tem. */
      readonly unverifiedHeads?: readonly KnownHead[];
      /** Evidência para o LIVRO DE CABEÇAS: existe algum resultado (com ou sem `ledgerHead`) e as posições do livro que os resultados citam. */
      readonly hasResults?: boolean;
      readonly ledgerHeads?: ReadonlyArray<{ readonly ledgerSeq: number; readonly sha256: string }>;
      readonly unverifiedLedgerHeads?: ReadonlyArray<{ readonly ledgerSeq: number; readonly sha256: string }>;
    }
  | { readonly ok: false; readonly reason: KnownHeadsFailure };
export type KnownHeadsProvider = (auditId: string) => Promise<KnownHeadsRead>;

/**
 * Declaração EXPLÍCITA de "esta construção do serviço não precisa de testemunha" (testes unitários da 6B isolada). A produção NUNCA a usa: um teste
 * estático garante que nada em `src/` além deste módulo e do serviço a referencia. Omitir `knownHeads` é erro de compilação.
 */
export const WITNESS_NOT_REQUIRED: unique symbol = Symbol('GMN_WITNESS_NOT_REQUIRED');
export type WitnessSource = KnownHeadsProvider | typeof WITNESS_NOT_REQUIRED;

export type WitnessStatus =
  /** Só em testes da 6B isolada (`WITNESS_NOT_REQUIRED`). Nunca em produção. */
  | 'NOT_REQUIRED'
  /** Fonte configurada e legível, SEM cabeça nenhuma: a testemunha ainda não existe. Não é garantia. */
  | 'UNWITNESSED'
  /** Toda cabeça conhecida (≥ 1) confere com a entrada CONFIRMADA da mesma posição. */
  | 'CONSISTENT'
  /** Uma cabeça conhecida é exatamente a entrada PENDENTE: ela já estava confirmada e o recibo foi removido. */
  | 'RECEIPT_LOST_WITNESSED'
  /** Uma cabeça conhecida está ALÉM do histórico de hoje: entradas confirmadas desapareceram. */
  | 'HISTORY_REGRESSED'
  /** Uma cabeça conhecida difere da entrada que hoje ocupa a mesma posição. */
  | 'HISTORY_DIVERGES'
  /** A cadeia da fonte não confere, ou um indício não verificado contradiz o histórico de hoje: a testemunha não é confiável. */
  | 'UNTRUSTED'
  /** O armazenamento da fonte não pôde ser lido. */
  | 'UNAVAILABLE'
  /** A dependência da testemunha (pastas de resultados e recibos) não está configurada. */
  | 'NOT_CONFIGURED';

export interface WitnessVerdict {
  readonly status: WitnessStatus;
  /** Quantas cabeças CONFIABILIZADAS foram conferidas (indícios não contam). */
  readonly knownHeads: number;
  /** Maior posição coberta por uma cabeça confiabilizada que confere; `null` sem cobertura. */
  readonly coveredSeq: number | null;
  /** Quantas revogações/substituições (confirmadas ou pendente) estão ALÉM da cobertura: a perda delas não seria detectada. */
  readonly unwitnessedAffecting: number;
}

/** Não resolvida = o histórico não pode ser tomado como verdadeiro: falha fechada. */
export const isUnresolved = (status: WitnessStatus): boolean =>
  status === 'HISTORY_REGRESSED' || status === 'HISTORY_DIVERGES' || status === 'UNTRUSTED' || status === 'UNAVAILABLE' || status === 'NOT_CONFIGURED';

interface Chained {
  readonly seq: number;
  readonly contentSha256: string;
  /** A entrada revoga ou substitui outra: a sua perda reativaria uma decisão. */
  readonly affectsPrior?: boolean;
}

/** `read === null` = `WITNESS_NOT_REQUIRED`. Entradas CONFIRMADAS em ordem (seq 1..n contíguo) + a pendente, se houver. */
export function evaluateKnownHeads(confirmed: readonly Chained[], pending: Chained | null, read: KnownHeadsRead | null): WitnessVerdict {
  const verdict = (status: WitnessStatus, knownHeads: number, coveredSeq: number | null): WitnessVerdict => {
    const all = pending ? [...confirmed, pending] : confirmed;
    const beyond = all.filter((entry) => entry.affectsPrior === true && (coveredSeq === null || entry.seq > coveredSeq)).length;
    return { status, knownHeads, coveredSeq, unwitnessedAffecting: beyond };
  };
  if (read === null) return verdict('NOT_REQUIRED', 0, null);
  if (!read.ok) return verdict(read.reason === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : read.reason === 'UNTRUSTED' ? 'UNTRUSTED' : 'UNAVAILABLE', 0, null);

  let lost = false;
  let broken: WitnessStatus | null = null;
  let covered: number | null = null;
  for (const head of read.heads) {
    const at = confirmed[head.seq - 1];
    if (at && at.seq === head.seq) {
      if (at.contentSha256 !== head.sha256) broken = 'HISTORY_DIVERGES';
      else covered = Math.max(covered ?? 0, head.seq);
    } else if (pending && pending.seq === head.seq) {
      if (pending.contentSha256 === head.sha256) {
        lost = true;
        covered = Math.max(covered ?? 0, head.seq); // a testemunha cobre exatamente a posição da pendente
      } else broken = 'HISTORY_DIVERGES';
    } else {
      broken = broken ?? 'HISTORY_REGRESSED';
    }
  }
  if (broken === null) {
    // INDÍCIOS: nunca testemunham; só podem DENUNCIAR. Um que bate com o histórico de hoje é inofensivo (ignorado); um que NÃO bate indica histórico
    // que existiu e hoje não existe (ou é outro) e que NÃO se pode confirmar nem descartar: a testemunha não é confiável.
    for (const hint of read.unverifiedHeads ?? []) {
      const at = confirmed[hint.seq - 1];
      const matches = (at && at.seq === hint.seq && at.contentSha256 === hint.sha256) || (pending && pending.seq === hint.seq && pending.contentSha256 === hint.sha256);
      if (!matches) broken = 'UNTRUSTED';
    }
  }
  if (broken !== null) return verdict(broken, read.heads.length, covered);
  if (lost) return verdict('RECEIPT_LOST_WITNESSED', read.heads.length, covered);
  return verdict(read.heads.length === 0 ? 'UNWITNESSED' : 'CONSISTENT', read.heads.length, covered);
}
