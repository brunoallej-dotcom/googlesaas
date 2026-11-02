import { useId, useState } from 'react';
import { RotateCcw, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { formatDateTime, OUTCOME_LABELS, safeText } from './labels';
import { isUnresolvedWitness, type PendingDecision, type PendingOriginDetail, type PendingRun, type WitnessInfo, type WitnessStatus } from './types';
import { BUTTON_PRIMARY } from './ui-bits';

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
export function PendingDecisionPanel({ pending, ambiguousIds, witness, onResend }: { readonly pending: PendingDecision; readonly ambiguousIds: readonly string[]; readonly witness: WitnessStatus; readonly onResend: () => void }): React.JSX.Element {
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
      ) : isUnresolvedWitness(witness) ? (
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
