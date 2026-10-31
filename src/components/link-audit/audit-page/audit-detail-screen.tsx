'use client';

import { ArrowLeft, ClipboardList, FileClock, Gauge, Hand, ListChecks, Building2, RefreshCw, ScrollText, ShieldCheck, Fingerprint } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { CompanyPanel } from './company-panel';
import * as flow from './controller';
import { CriteriaMatrix } from './criteria-matrix';
import { DecisionsPanel } from './decisions-panel';
import { FinalizationPanel } from './finalization-panel';
import { ResultPanel } from './result-panel';
import { ResultsPanel } from './results-panel';
import { BlockersPanel, MissingPanel, TraceabilityPanel } from './side-panels';
import { StatusStrip } from './status-strip';
import { deriveHeadline, deriveRegistry } from './status';
import { safeText } from './labels';
import { BUTTON_QUIET, restoreFocus, Section, SectionStatus } from './ui-bits';
import { useAuditPage } from './use-audit-page';

const COOLDOWN_MS = 5000;

/**
 * Página individual da auditoria (Onda 6C, I5): leitura da prévia real (I3), decisões humanas (6B) e resultados finalizados (I4).
 * Três leituras independentes (+ a identidade da coleta); cada uma falha sozinha. Sem polling: atualização manual com intervalo mínimo
 * para respeitar os limites de taxa. Nada de pontuação é calculado aqui.
 */
export function AuditDetailScreen({ auditId }: { readonly auditId: string }): React.JSX.Element {
  const { state, ctx } = useAuditPage(auditId);
  const [cooling, setCooling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = (): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handleLogout = async (): Promise<void> => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  };
  const refresh = (): void => {
    if (cooling || busy) return;
    setCooling(true);
    timer.current = setTimeout(() => setCooling(false), COOLDOWN_MS);
    void flow.loadAll(ctx);
  };

  const { preview, decisions, results, evidence } = state;
  const changedAfter = state.finalize.phase === 'done' ? state.finalize.changedAfter : null;
  const headline = deriveHeadline(state);
  const registry = deriveRegistry(state, changedAfter);
  const busy = state.finalize.phase === 'submitting' || state.finalize.phase === 'verifying';
  // ao FECHAR o formulário de decisão/revogação, o foco volta a quem o abriu (ou ao título da seção de decisões)
  const editing = state.form.phase !== 'closed' || state.revoke.phase !== 'closed';
  const wasEditing = useRef(false);
  const waiting = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      const target = opener.current;
      opener.current = null;
      // logo depois de gravar as leituras recarregam e os botões ficam desabilitados por instantes: o foco ESPERA o botão voltar
      if (target && target.isConnected && target.matches(':disabled')) waiting.current = target;
      else restoreFocus(target, 'decisoes');
    }
    if (editing) waiting.current = null;
    wasEditing.current = editing;
  }, [editing]);
  const canWrite = decisions.phase === 'ready' && !busy && state.form.phase !== 'submitting' && state.revoke.phase !== 'submitting';
  useEffect(() => {
    if (!waiting.current) return;
    if (decisions.phase === 'error' || decisions.phase === 'unavailable' || decisions.phase === 'integrity' || decisions.phase === 'denied') waiting.current = null; // a recarga falhou: não fica esperando para sempre
    else if (canWrite) {
      const target = waiting.current;
      waiting.current = null;
      // só devolve o foco se o operador ainda não o levou a outro controle
      if (!document.activeElement || document.activeElement === document.body) restoreFocus(target, 'decisoes');
    }
  }, [canWrite, decisions.phase]);
  const retry = (name: 'evidence' | 'preview' | 'decisions' | 'results') => (): void => void flow.loadSection(ctx, name);
  const name = safeText(evidence.data?.company.name) || 'Auditoria';

  return (
    <DashboardShell onLogout={() => void handleLogout()} activeRoute="/auditoria-por-link" sectionLabel="Auditoria por Link" hideSystemStatus>
      {/* a faixa de estado fica fixa só a partir de `md`: ao focar, a rolagem deixa margem para ela não cobrir o controle */}
      <div className="space-y-4 md:[&_a]:scroll-mt-52 md:[&_button]:scroll-mt-52 md:[&_input]:scroll-mt-52 md:[&_select]:scroll-mt-52 md:[&_summary]:scroll-mt-52 md:[&_textarea]:scroll-mt-52 md:[&_[tabindex='-1']]:scroll-mt-52">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Navegação da auditoria" className="flex items-center gap-2 text-sm">
            <a href={`/auditoria-por-link?auditId=${encodeURIComponent(auditId)}#auditorias-armazenadas`} aria-label="Voltar para Auditorias armazenadas" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-gmn-muted hover:text-gmn-text focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Auditorias</a>
            <span aria-hidden="true" className="text-gmn-muted">/</span>
            <span className="min-w-0 break-words font-medium text-gmn-text" aria-current="page">{name}</span>
          </nav>
          <button type="button" onClick={refresh} disabled={cooling || busy} className={BUTTON_QUIET} aria-label={cooling ? 'Atualizado: aguarde alguns segundos para atualizar de novo' : 'Atualizar prévia, decisões e resultados'}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {cooling ? 'Atualizado' : 'Atualizar'}
          </button>
        </div>

        <StatusStrip headline={headline} registry={registry} notice={state.notice} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          {/* trilho de ação: no celular vem ANTES (estado → bloqueios → finalização) */}
          <aside aria-label="Finalização, bloqueios e pendências" className="space-y-4 xl:order-2 xl:self-start">
            <Section id="finalizacao" icon={ClipboardList} title="Finalização" subtitle="Registro definitivo do resultado">
              <FinalizationPanel
                state={state}
                onOpen={() => flow.openFinalize(ctx)}
                onCancel={() => flow.cancelFinalize(ctx)}
                onAck={(acknowledged) => ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged })}
                onConfirm={() => void flow.confirmFinalize(ctx)}
                onRetry={() => void flow.retryFinalize(ctx)}
                onCompletePending={() => void flow.completePendingRun(ctx)}
                onReloadPreview={retry('preview')}
              />
            </Section>
            <Section id="bloqueios" icon={ShieldCheck} title="Bloqueios" subtitle={preview.data ? `${preview.data.blockers.filter((b) => b.severity === 'BLOCKING').length} impedem registrar` : undefined}>
              <SectionStatus phase={preview.phase} hasData={preview.data !== null} message={preview.message} code={preview.code} onRetry={retry('preview')} what="a prévia" />
              {preview.data && <BlockersPanel blockers={preview.data.blockers} />}
            </Section>
            <Section id="faltas" icon={ListChecks} title="O que falta" subtitle="Potencial de cobertura, não comprovado" open={false}>
              {preview.data ? <MissingPanel missing={preview.data.missing} /> : <p className="text-xs text-gmn-muted">Disponível quando a prévia carregar.</p>}
            </Section>
          </aside>

          <div className="min-w-0 space-y-4 xl:order-1">
            <Section id="empresa" icon={Building2} title="Empresa e evidências" subtitle="Identidade confirmada, captura e integridade">
              <SectionStatus phase={evidence.phase} hasData={evidence.data !== null} message={evidence.message} code={evidence.code} onRetry={retry('evidence')} what="a identificação da coleta" />
              <SectionStatus phase={preview.phase} hasData={preview.data !== null} message={preview.message} code={preview.code} onRetry={retry('preview')} what="as evidências da prévia" />
              {(evidence.data || preview.data) && <CompanyPanel evidence={evidence.data} preview={preview.data} />}
            </Section>

            <Section id="resultado" icon={Gauge} title="Resultado da prévia" subtitle="Calculado agora pelo motor Lumos — não é um registro definitivo">
              <SectionStatus phase={preview.phase} hasData={preview.data !== null} message={preview.message} code={preview.code} onRetry={retry('preview')} what="a prévia" />
              {preview.data && (preview.data.state === 'SEM_EVIDENCIA' ? <p className="text-sm text-gmn-muted">Não há evidência armazenada para esta auditoria: nada foi calculado.</p> : <ResultPanel outcome={preview.data.outcomePreview} result={preview.data.result} criteria={preview.data.criteria} />)}
            </Section>

            <Section id="criterios" icon={ListChecks} title="Critérios Lumos" subtitle="9 critérios · 35 subcritérios · origem e estado de cada um">
              <SectionStatus phase={preview.phase} hasData={preview.data !== null} message={preview.message} code={preview.code} onRetry={retry('preview')} what="a prévia" />
              {preview.data && preview.data.state !== 'SEM_EVIDENCIA' && <CriteriaMatrix preview={preview.data} canAct={canWrite} onRegister={(key) => { rememberOpener(); flow.openForm(ctx, key); document.getElementById('decisoes')?.setAttribute('open', ''); }} />}
            </Section>

            <Section id="decisoes" icon={Hand} title="Decisões humanas" subtitle={decisions.data ? `${decisions.data.decisions.length} vigente(s) · histórico de ${decisions.data.history.length}` : undefined}>
              <SectionStatus phase={decisions.phase} hasData={decisions.data !== null} message={decisions.message} code={decisions.code} onRetry={retry('decisions')} what="o histórico de decisões" />
              {decisions.data && (
                <DecisionsPanel
                  decisions={decisions.data}
                  preview={preview.data}
                  form={state.form}
                  revoke={state.revoke}
                  canWrite={canWrite}
                  onOpenForm={(key) => { rememberOpener(); flow.openForm(ctx, key); }}
                  onCloseForm={() => ctx.dispatch({ type: 'FORM_CLOSE' })}
                  onFormField={(patch) => ctx.dispatch({ type: 'FORM_FIELD', patch })}
                  onSubmitForm={() => void flow.submitForm(ctx)}
                  onResendForm={() => void flow.resendForm(ctx)}
                  onOpenRevoke={(decisionId) => { rememberOpener(); ctx.dispatch({ type: 'FORM_CLOSE' }); ctx.dispatch({ type: 'REVOKE_OPEN', decisionId }); }}
                  onCloseRevoke={() => ctx.dispatch({ type: 'REVOKE_CLOSE' })}
                  onRevokeField={(reason) => ctx.dispatch({ type: 'REVOKE_FIELD', reason })}
                  onSubmitRevoke={() => void flow.submitRevoke(ctx)}
                  onResendRevoke={() => void flow.resendRevoke(ctx)}
                  onResendListed={() => void flow.resendListedPending(ctx)}
                />
              )}
            </Section>

            <Section id="resultados" icon={FileClock} title="Resultados finalizados" subtitle="Versões imutáveis, confirmadas com recibo e verificadas na leitura">
              <SectionStatus phase={results.phase} hasData={results.data !== null} message={results.message} code={results.code} onRetry={retry('results')} what="o histórico de resultados" />
              {results.data && <ResultsPanel results={results.data} detail={state.detail} changedAfter={changedAfter} onSelect={(seq) => void flow.selectResult(ctx, seq)} />}
            </Section>

            <Section id="rastreabilidade" icon={Fingerprint} title="Rastreabilidade" subtitle="Identificadores, versões e hashes permitidos pelo contrato público" open={false}>
              {preview.data ? <TraceabilityPanel preview={preview.data} /> : <p className="text-xs text-gmn-muted">Disponível quando a prévia carregar.</p>}
              <p className="mt-3 flex items-start gap-2 text-xs text-gmn-muted"><ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />Nada aqui expõe URLs brutas, justificativas ocultadas pela API, caminhos do servidor ou material interno.</p>
            </Section>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
