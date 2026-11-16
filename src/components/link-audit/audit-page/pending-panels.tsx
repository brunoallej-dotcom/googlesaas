import { useId, useState } from 'react';
import { RotateCcw, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { formatDateTime, OUTCOME_LABELS, safeText } from './labels';
import { isBlockingLedger, isUnresolvedWitness, type LedgerInfo, type PendingDecision, type PendingOriginDetail, type PendingRun, type WitnessInfo, type WitnessStatus } from './types';
import { BUTTON_PRIMARY, BUTTON_QUIET } from './ui-bits';

/*
 * Painéis das PENDÊNCIAS (decisão ou resultado gravado e ainda SEM recibo). Regras (remediação do MAJOR-1):
 *  - quem diz que a origem é verdadeira é o SERVIDOR (etiqueta de origem com chave fora das pastas); o campo "autor" do arquivo nunca
 *    basta. Por isso "foi você quem gravou" só aparece quando `origin === 'PROVEN'` e o autor autenticado é a sessão (`isMine`);
 *  - sem origem comprovada NÃO há botão: nem o suposto autor consegue concluir, e a tela não mostra conteúdo nem autor do arquivo;
 *  - com origem comprovada, a tela mostra o que será confirmado e exige confirmação explícita (caixa marcada) antes de enviar;
 *  - o estado "gravação interrompida" e "recibo removido depois de confirmado" são indistinguíveis sem uma testemunha externa: a tela diz isso.
 */

const ORIGIN_REASON: Readonly<Record<PendingOriginDetail, string>> = {
  MISSING: 'o registro não tem a etiqueta de origem (foi gravado antes desta proteção ou por quem não é este sistema)',
  INVALID: 'a etiqueta de origem não confere com o conteúdo (registro alterado ou forjado)',
  KEY_MISMATCH: 'a etiqueta é de uma chave que este servidor não conhece (chave trocada sem manter a anterior, ou registro forjado)',
  KEY_REVOKED: 'a etiqueta é de uma chave REVOGADA por comprometimento: nada assinado por ela é comprovado',
  KEY_EXPIRED: 'a etiqueta é de uma chave aposentada cuja validade terminou',
  NO_KEY: 'este servidor não tem a chave para comprovar a origem',
};

const RECORD_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['kind', 'Tipo'],
  ['subcriterionId', 'Subcritério'],
  ['subcriterionIds', 'Subcritérios'],
  ['value', 'Valor'],
  ['code', 'Motivo'],
  ['sampleSize', 'Amostra'],
  ['nameA', 'Nome A'],
  ['nameB', 'Nome B'],
  ['scopeDescription', 'Escopo'],
  ['imageTypes', 'Tipos de imagem'],
  ['evidenceIds', 'Evidências'],
  ['causeEvidenceIds', 'Evidências da causa'],
  ['justification', 'Justificativa'],
];

const lineOf = (value: unknown): string => (Array.isArray(value) ? value.map((item) => safeText(String(item), 80)).join(', ') : safeText(String(value), 600));

function Fact({ label, value }: { readonly label: string; readonly value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <dt className="shrink-0 text-gmn-muted">{label}</dt>
      <dd className="min-w-0 break-words text-gmn-text">{value}</dd>
    </div>
  );
}

function Unproven({ detail, what }: { readonly detail: PendingOriginDetail | null; readonly what: string }): React.JSX.Element {
  const unverifiable = detail === 'NO_KEY';
  return (
    <>
      <p className="mt-1 flex items-start gap-2 text-gmn-muted">
        {unverifiable ? <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" /> : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />}
        <span>
          <strong className="text-gmn-text">{unverifiable ? 'Não é possível comprovar a origem agora.' : 'A origem NÃO foi comprovada pelo servidor.'}</strong> Motivo: {detail ? ORIGIN_REASON[detail] : 'desconhecido'}.
        </span>
      </p>
      <p className="mt-1 text-gmn-muted">
        {what} <strong className="text-gmn-text">Não pode ser concluído por esta tela</strong> (nem por quem aparece como autor no arquivo); nada é gravado. O conteúdo e o autor indicados no arquivo não são exibidos porque não são confiáveis. Siga o procedimento de quarentena da documentação.
      </p>
    </>
  );
}

const BOX = 'rounded-xl border border-dashed border-gmn-warning/60 bg-gmn-warning/[0.06] p-3 text-xs';

/** Resultado (6C) gravado e ainda sem recibo. */
export function PendingRunPanel({ pending, busy, onComplete }: { readonly pending: PendingRun; readonly busy: boolean; readonly onComplete: () => void }): React.JSX.Element {
  const [ack, setAck] = useState(false);
  const id = useId();
  const name = `s${String(pending.seq).padStart(4, '0')}`;
  return (
    <section aria-labelledby={`${id}-t`} className={BOX}>
      <p id={`${id}-t`} className="font-semibold text-gmn-text">Resultado {name} gravado e NÃO confirmado (sem recibo): ele não vale.</p>
      <div className="mt-2 space-y-1 text-gmn-muted" data-testid="pending-run-impact">
        <p>
          Uma gravação <strong className="text-gmn-text">interrompida</strong> e um recibo <strong className="text-gmn-text">removido</strong> de um resultado já confirmado têm o mesmo aspecto aqui; o sistema não consegue distingui-los sozinho. <strong className="text-gmn-text">Não apague nem mova o arquivo deste resultado:</strong> se ele era o último resultado confirmado, ele deixa de contar como resultado até o recibo ser concluído.
        </p>
        <p>Enquanto houver esta pendência, nenhum novo resultado é registrado nesta auditoria. Ela <strong className="text-gmn-text">não é uma confirmação</strong>.</p>
      </div>
      {pending.origin !== 'PROVEN' ? (
        <Unproven detail={pending.originDetail} what="Este resultado pendente continua bloqueando novos registros desta auditoria." />
      ) : pending.isMine ? (
        <>
          <p className="mt-1 flex items-start gap-2 text-gmn-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-300" aria-hidden="true" />
            <span>O servidor <strong className="text-gmn-text">comprovou</strong> que gravou este resultado em nome do seu usuário. Falta apenas o recibo.</span>
          </p>
          <dl className="mt-2 space-y-1">
            <Fact label="Gravado em" value={formatDateTime(pending.finalizedAt)} />
            <Fact label="Desfecho" value={pending.outcome ? OUTCOME_LABELS[pending.outcome] : 'não informado'} />
            <Fact label="Cobertura" value={pending.coveragePercent === null ? 'não informada' : `${pending.coveragePercent}%`} />
            <Fact label="Decisões aplicadas" value={pending.appliedDecisionCount === null ? 'não informado' : String(pending.appliedDecisionCount)} />
            <Fact
              label="Entrada de hoje"
              value={pending.matchesCurrent === true ? 'é a mesma da gravação' : pending.matchesCurrent === false ? 'MUDOU desde a gravação: depois de concluído ele será HISTÓRICO' : 'não foi possível comparar agora'}
            />
          </dl>
          <p className="mt-2 text-gmn-muted">Concluir cria o recibo do MESMO conteúdo; o servidor reconfere as evidências, a coleta e o histórico antes de dá-lo.</p>
          <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-2 text-gmn-text">
            <input type="checkbox" checked={ack} disabled={busy} onChange={(event) => setAck(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#1D68DB]" />
            <span>Conferi os dados acima e quero concluir a confirmação deste resultado.</span>
          </label>
          <button type="button" disabled={busy || !ack} onClick={onComplete} className={`${BUTTON_PRIMARY} mt-2`}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Concluir a confirmação
          </button>
        </>
      ) : (
        <p className="mt-1 text-gmn-muted">Gravado por outro operador (origem comprovada pelo servidor). Somente o autor pode concluí-lo. Enquanto não for concluído, nenhum novo resultado é registrado.</p>
      )}
    </section>
  );
}

/**
 * O que a pendência significa para QUALQUER operador autorizado (inclusive quem não é o autor e quem não tem origem comprovada): a ambiguidade
 * "gravação interrompida × recibo removido", as decisões que ficam EM DÚVIDA (não vigentes) e o que a testemunha independente diz. Só ids e
 * rótulos fixos: nenhum conteúdo privado do arquivo.
 */
function PendingImpact({ ambiguousIds, witness, hasPending }: { readonly ambiguousIds: readonly string[]; readonly witness: WitnessStatus; readonly hasPending: boolean }): React.JSX.Element {
  return (
    <div className="mt-2 space-y-1 text-gmn-muted" data-testid="pending-impact">
      <p>
        Uma gravação <strong className="text-gmn-text">interrompida</strong> e um recibo <strong className="text-gmn-text">removido</strong> de uma operação já confirmada têm o mesmo aspecto aqui; o sistema não consegue distingui-los sozinho. <strong className="text-gmn-text">Não apague nem mova o arquivo desta pendência.</strong>
      </p>
      {ambiguousIds.length > 0 && (
        <p>
          <strong className="text-gmn-text">Em dúvida: {ambiguousIds.map((id) => safeText(id, 12)).join(', ')}.</strong> Enquanto esta pendência não for resolvida, essa decisão <strong className="text-gmn-text">não é considerada vigente</strong> (nem na prévia) e nenhum resultado pode ser registrado.
        </p>
      )}
      {witness === 'RECEIPT_LOST_WITNESSED' && (
        <p>
          <strong className="text-gmn-text">Incidente de integridade:</strong> um resultado já selado registrou esta decisão como confirmada. O recibo dela foi REMOVIDO (ou a pasta de recibos foi restaurada de uma cópia antiga). Restaure o recibo a partir do backup e avise a operação.
        </p>
      )}
      {hasPending && (witness === 'CONSISTENT' || witness === 'UNWITNESSED') && <p>Nenhum resultado selado cobre esta posição do histórico: não há testemunha independente para distinguir os dois casos.</p>}
      {hasPending && witness === 'NOT_REQUIRED' && <p>Este servidor não tem testemunha independente: não há como distinguir os dois casos.</p>}
    </div>
  );
}

const WITNESS_REASON: Readonly<Record<'HISTORY_REGRESSED' | 'HISTORY_DIVERGES' | 'UNTRUSTED' | 'UNAVAILABLE' | 'NOT_CONFIGURED', string>> = {
  HISTORY_REGRESSED: 'um resultado já selado registra uma posição do histórico de decisões que HOJE FALTA (arquivos de decisão removidos, movidos para quarentena ou restaurados de uma cópia antiga)',
  HISTORY_DIVERGES: 'um resultado já selado registra, naquela posição, uma entrada DIFERENTE da que existe hoje',
  UNTRUSTED: 'a testemunha independente NÃO é confiável (a cadeia de resultados não confere, ou há um resultado pendente de origem não comprovada que afirma histórico que hoje não existe)',
  UNAVAILABLE: 'a testemunha independente (os resultados selados) não pôde ser lida',
  NOT_CONFIGURED: 'a testemunha independente não está configurada neste servidor (pastas de resultados e de recibos dos resultados)',
};

/** Cobertura da testemunha: informação (não bloqueio) para TODOS os operadores quando há revogação/substituição que nenhuma testemunha cobre. */
export function WitnessCoverageNote({ witness }: { readonly witness: WitnessInfo }): React.JSX.Element | null {
  if ((witness.status !== 'UNWITNESSED' && witness.status !== 'CONSISTENT') || witness.unwitnessedAffecting === 0) return null;
  return (
    <section role="note" className="rounded-xl border border-dashed border-gmn-warning/60 bg-gmn-warning/[0.06] p-3 text-xs text-gmn-muted" data-testid="witness-coverage">
      <p>
        <strong className="text-gmn-text">Sem testemunha independente para {witness.unwitnessedAffecting} revogação(ões)/substituição(ões)</strong>
        {witness.coveredSeq === null ? ' (nenhum resultado selado cobre este histórico)' : ` (a cobertura vai até a posição ${witness.coveredSeq})`}. Isto <strong className="text-gmn-text">não é uma garantia de integridade</strong>: se os arquivos dessas entradas fossem removidos ou movidos, o sistema não detectaria. Não apague nem mova arquivos de decisão.
      </p>
    </section>
  );
}

/** Integridade do histórico NÃO resolvida: aviso para TODOS os operadores autorizados (só estado e motivos fixos; nenhum conteúdo privado). */
export function HistoryIntegrityBanner({ status }: { readonly status: WitnessStatus }): React.JSX.Element | null {
  if (!isUnresolvedWitness(status)) return null;
  const reason = WITNESS_REASON[status as keyof typeof WITNESS_REASON];
  return (
    <section role="alert" className="rounded-xl border border-red-400/50 bg-red-500/[0.08] p-4 text-sm" data-testid="history-integrity">
      <p className="flex items-start gap-2 font-semibold text-gmn-text">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
        <span>Integridade do histórico de decisões NÃO resolvida.</span>
      </p>
      <p className="mt-1 text-xs text-gmn-muted">
        Motivo: {reason}. <strong className="text-gmn-text">Nenhuma decisão é considerada vigente nem enviada ao motor</strong> (inclusive as que estavam ativas), novas decisões e resultados estão bloqueados e a pontuação não pode ser finalizada.
      </p>
      <p className="mt-1 text-xs text-gmn-muted">Não apague, mova nem restaure arquivos por conta própria: avise a operação para restaurar o par decisões + recibos do mesmo instante a partir do backup independente.</p>
    </section>
  );
}

/** Decisão (6B) gravada e ainda sem recibo. */
export function PendingDecisionPanel({ pending, ambiguousIds, witness, ledger, onResend }: { readonly pending: PendingDecision; readonly ambiguousIds: readonly string[]; readonly witness: WitnessStatus; readonly ledger: LedgerInfo; readonly onResend: () => void }): React.JSX.Element {
  const [ack, setAck] = useState(false);
  const id = useId();
  const proven = pending.origin === 'PROVEN';
  const what = pending.action === 'REVOKE' ? `Revogação de ${safeText(pending.revokes, 12)}` : `Nova decisão ${safeText(pending.decisionId, 12)}`;
  const record = pending.record;
  const fields = record ? RECORD_FIELDS.filter(([key]) => record[key] !== undefined && record[key] !== null).map(([key, label]) => [label, lineOf(record[key])] as const) : [];
  return (
    <section aria-labelledby={`${id}-t`} className={`${BOX} p-4 text-sm`}>
      <p id={`${id}-t`} className="font-semibold text-gmn-text">Decisão pendente — gravada, mas SEM recibo: ela ainda não vale.</p>
      {proven && <p className="mt-1 text-xs text-gmn-muted">{what} · {formatDateTime(pending.recordedAt)}</p>}
      <div className="text-xs">
        <PendingImpact ambiguousIds={ambiguousIds} witness={witness} hasPending />
      </div>
      {!proven ? (
        <div className="text-xs">
          <Unproven detail={pending.originDetail} what="Enquanto isso, nenhum resultado pode ser registrado e nenhuma nova decisão é gravada nesta auditoria." />
        </div>
      ) : isUnresolvedWitness(witness) || (isBlockingLedger(ledger.state) && !ledger.receiptReissuable) ? (
        <p className="mt-2 text-xs text-gmn-muted"><strong className="text-gmn-text">Não pode ser concluída por esta tela</strong> enquanto a integridade do histórico não estiver resolvida (ver o aviso acima).</p>
      ) : pending.isMine ? (
        <div className="text-xs">
          <p className="mt-2 flex items-start gap-2 text-gmn-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-300" aria-hidden="true" />
            <span>O servidor <strong className="text-gmn-text">comprovou</strong> que gravou esta decisão em nome do seu usuário. Falta apenas o recibo.</span>
          </p>
          <dl className="mt-2 space-y-1">
            {pending.action === 'REVOKE' ? <Fact label="Motivo da revogação" value={safeText(pending.reason, 600)} /> : fields.map(([label, value]) => <Fact key={label} label={label} value={value} />)}
            {pending.supersedes ? <Fact label="Substitui" value={safeText(pending.supersedes, 12)} /> : null}
          </dl>
          <p className="mt-2 text-gmn-muted">Concluir cria o recibo do MESMO conteúdo; nada é reescrito.</p>
          <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-2 text-gmn-text">
            <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#1D68DB]" />
            <span>Conferi os dados acima e quero concluir esta decisão.</span>
          </label>
          <button type="button" disabled={!ack} onClick={onResend} className={`${BUTTON_PRIMARY} mt-2`}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Concluir a decisão
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-gmn-muted">
          Gravada por {safeText(pending.recordedBy, 120)} (origem comprovada pelo servidor). Somente o autor pode concluí-la. Enquanto isso, nenhum resultado pode ser registrado.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ LIVRO DE CABEÇAS (contrato §16) */
const LEDGER_REASON: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: 'o livro de cabeças não está configurado neste servidor (pasta e chave exclusivas)',
  UNAVAILABLE: 'o armazenamento do livro de cabeças não pôde ser lido',
  UNTRUSTED: 'o livro de cabeças não é confiável (cadeia, etiqueta ou formato não conferem)',
  KEY_REVOKED: 'há registros do livro assinados por uma chave REVOGADA por comprometimento: nada assinado por ela é aceito',
  KEY_EXPIRED: 'há registros do livro assinados por chave aposentada já vencida e sem ponto de verificação que os cubra',
  KEY_UNKNOWN: 'há registros do livro assinados por uma chave que este servidor não conhece',
  LIMIT_REACHED: 'o livro desta auditoria atingiu o limite de registros',
  DURABILITY_UNKNOWN: 'o armazenamento não comprovou a gravação (falha de fsync): a durabilidade do livro é DESCONHECIDA e nada é considerado protegido até reiniciar o servidor e provar de novo',
  LEDGER_ABSENT_WITH_HISTORY: 'o livro desta auditoria está ausente e há histórico: ele pode nunca ter existido (histórico anterior ao livro) ou ter sido removido, e o sistema não consegue distinguir sem fonte independente',
  LEDGER_REMOVED_WITNESSED: 'o livro desta auditoria sumiu, mas resultados ou a guarda externa provam que ele existiu',
  HISTORY_REGRESSED: 'o livro confirma decisões que não existem mais nas pastas de decisões (arquivos removidos ou restaurados de cópia antiga)',
  HISTORY_DIVERGES: 'uma decisão difere da que o livro confirmou naquela posição',
  RECEIPT_REMOVED: 'o recibo de uma decisão que o livro já confirmou foi removido (o autor pode reemitir o recibo de mesmo conteúdo)',
  UNLEDGERED_ENTRY: 'há decisão confirmada que o livro nunca registrou',
  UNLEDGERED_PENDING: 'há decisão pendente que o livro nunca registrou (não foi gravada por este sistema)',
  PUBLISHED_AFTER_ABORT: 'uma decisão foi publicada depois de a operação ter sido abortada no livro',
  LEDGER_BEHIND: 'o livro ficou um registro atrás de uma decisão confirmada (queda entre o recibo e o livro); a recuperação é verificável e só o autor da decisão a conclui',
  BEHIND_UNVERIFIABLE: 'o livro está atrasado e a origem da decisão não pode ser comprovada',
  RESULT_LEDGER_MISMATCH: 'um resultado selado cita uma posição do livro que não confere',
  RESULTS_EVIDENCE_UNAVAILABLE: 'os resultados (testemunha independente do livro) não puderam ser lidos',
  GUARD_MISMATCH: 'a guarda externa guarda uma cabeça que o livro não contém (retrocesso)',
  GUARD_UNAVAILABLE: 'a guarda externa não pôde ser consultada',
};
const GUARD_TEXT: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: 'Guarda externa NÃO configurada: um retrocesso coordenado de todos os volumes NÃO é detectado.',
  CONSISTENT: 'Guarda externa em dia.',
  BEHIND: 'Guarda externa atrasada em relação ao livro.',
  MISMATCH: 'Guarda externa DIVERGE do livro.',
  UNAVAILABLE: 'Guarda externa indisponível.',
};
const PHASE_TEXT: Readonly<Record<'A' | 'B' | 'C', string>> = {
  A: 'uma gravação começou e a decisão ainda não foi publicada',
  B: 'a decisão foi publicada e ainda falta o recibo (ela ainda não vale)',
  C: 'a decisão e o recibo existem, mas o livro ainda não registrou a confirmação (só o autor da decisão a conclui)',
};

/**
 * Estado do LIVRO. Fora de PROTECTED o modo é RESTRITO e é dito a todos: consulta apenas, nenhuma decisão vigente, nada finalizável. A tela nunca afirma
 * proteção contra retrocesso coordenado de todos os volumes (a guarda externa é requisito de produção e não existe ainda). Ações: inscrever (auditoria
 * vazia) e recuperar (verificável); adoção/restauração exigem aprovação administrativa que não existe: a tela NÃO oferece botão para elas.
 */
export function LedgerPanel({ ledger, canAct, onAction }: { readonly ledger: LedgerInfo; readonly canAct: boolean; readonly onAction: (action: 'ENROLL' | 'RECOVER') => void }): React.JSX.Element | null {
  if (ledger.state === 'NOT_REQUIRED') return null;
  const guard = GUARD_TEXT[ledger.externalGuard] ?? '';
  if (ledger.state === 'PROTECTED') {
    const open = ledger.openOperation;
    const capacity = ledger.capacity;
    const coverage = ledger.keyCoverage;
    const attention = (capacity !== undefined && capacity.level !== 'OK') || (coverage !== undefined && !coverage.covered);
    return (
      <section role={attention ? 'alert' : 'note'} className={`rounded-xl border p-3 text-xs text-gmn-muted ${attention ? 'border-amber-400/50 bg-amber-500/[0.08]' : 'border-green-400/30 bg-green-500/[0.05]'}`} data-testid="ledger-protected">
        <p className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-300" aria-hidden="true" />
          <span>
            <strong className="text-gmn-text">Protegida pelo livro de cabeças</strong> · {ledger.confirmedDecisions} decisão(ões) confirmada(s) · cabeça do livro #{ledger.head?.ledgerSeq ?? '—'}. {guard}
          </span>
        </p>
        {open && (
          <p className="mt-1" data-testid="ledger-open-operation">
            Operação em andamento: {PHASE_TEXT[open.phase]}. Nada é finalizável enquanto isso{open.stale ? '; ela está parada há tempo demais e pode ser recuperada' : ''}.
            {ledger.recoverable && (
              <button type="button" disabled={!canAct} onClick={() => onAction('RECOVER')} className={`${BUTTON_QUIET} ml-2`}>
                Recuperar
              </button>
            )}
          </p>
        )}
        {capacity && (
          <p className="mt-1" data-testid="ledger-capacity">
            Capacidade do livro: {capacity.usedRecords} de {capacity.maxRecords} registros · cabem {capacity.decisionsAvailable} decisão(ões) nova(s) e {capacity.revocationsAvailable} revogação(ões).
            {capacity.level === 'REVOKE_ONLY' && <strong className="text-gmn-text"> Decisões novas encerradas: só cabem revogações.</strong>}
            {capacity.level === 'EXHAUSTED' && <strong className="text-gmn-text"> CAPACIDADE ESGOTADA: nenhuma nova decisão nem revogação; esta auditoria precisa de intervenção (a reabertura administrativa ainda não existe).</strong>}
          </p>
        )}
        {coverage && !coverage.covered && (
          <p className="mt-1" data-testid="ledger-key-coverage">
            Rotação de chave do livro SEM ponto de verificação da chave atual ({coverage.otherKeyRecords} registro(s) de outra chave): antes de a chave antiga vencer, quem opera o servidor precisa executar a recuperação (RECOVER) desta auditoria.
          </p>
        )}
      </section>
    );
  }
  const reason = ledger.reason ? (LEDGER_REASON[ledger.reason] ?? 'a integridade do livro não pôde ser estabelecida') : null;
  return (
    <section role="alert" className="rounded-xl border border-amber-400/50 bg-amber-500/[0.08] p-4 text-sm" data-testid={`ledger-${ledger.state.toLowerCase()}`}>
      {ledger.state === 'ENROLLMENT_PENDING' && (
        <>
          <p className="flex items-start gap-2 font-semibold text-gmn-text">
            <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <span>Auditoria ainda NÃO inscrita no livro de cabeças.</span>
          </p>
          <p className="mt-1 text-xs text-gmn-muted">
            Esta auditoria está vazia (sem decisões nem resultados). A inscrição é explícita: antes dela <strong className="text-gmn-text">nenhuma decisão é gravada</strong>. {guard}
          </p>
          <button type="button" disabled={!canAct} onClick={() => onAction('ENROLL')} className={`${BUTTON_PRIMARY} mt-2`}>
            Inscrever esta auditoria no livro
          </button>
        </>
      )}
      {ledger.state === 'LEGACY_READ_ONLY' && (
        <>
          <p className="flex items-start gap-2 font-semibold text-gmn-text">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <span>Auditoria em MODO RESTRITO (há histórico e o livro de cabeças desta auditoria está ausente).</span>
          </p>
          <p className="mt-1 text-xs text-gmn-muted">
            Só consulta: <strong className="text-gmn-text">nenhuma decisão é considerada vigente nem enviada ao motor</strong>, nada é finalizável e novas decisões são recusadas. Nada do histórico existente ganha garantia retroativa. A adoção exige aprovação
            administrativa (identidade verificável e dupla aprovação), que <strong className="text-gmn-text">ainda não existe</strong> neste sistema. Não apague nem mova arquivos.
          </p>
        </>
      )}
      {ledger.state === 'HISTORY_UNRESOLVED' && (
        <>
          <p className="flex items-start gap-2 font-semibold text-gmn-text">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
            <span>Livro de cabeças: integridade do histórico NÃO resolvida.</span>
          </p>
          <p className="mt-1 text-xs text-gmn-muted">
            Motivo: {reason}. <strong className="text-gmn-text">Nenhuma decisão é considerada vigente nem enviada ao motor</strong>, novas decisões e resultados estão bloqueados. Não apague, mova nem restaure arquivos por conta própria:
            a restauração é administrativa (ainda não existe) e preserva a evidência da inconsistência.
          </p>
          {ledger.recoverable && (
            <button type="button" disabled={!canAct} onClick={() => onAction('RECOVER')} className={`${BUTTON_QUIET} mt-2`}>
              Concluir recuperação verificável
            </button>
          )}
        </>
      )}
    </section>
  );
}
