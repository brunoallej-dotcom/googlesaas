'use client';

import { Check, ChevronDown, Copy, LoaderCircle, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { shortHash } from './labels';
import type { Phase } from './state';

export const BUTTON_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#1D68DB] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#1A5FCF] focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent focus-visible:ring-offset-2 focus-visible:ring-offset-gmn-bg disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-gmn-muted';
export const BUTTON_QUIET =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/[0.1] px-3 text-sm text-gmn-text transition-colors hover:border-white/25 hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70 disabled:cursor-not-allowed disabled:opacity-50';
export const FIELD_CLASS =
  'w-full rounded-lg border border-white/40 bg-gmn-tile px-3 py-2 text-sm text-gmn-text placeholder:text-gmn-muted/80 hover:border-white/60 focus:border-gmn-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/40';

/** Seção recolhível (`<details>`): no celular as seções começam recolhidas quando `compact`; no desktop ficam abertas. */
export function Section({ id, icon: Icon, title, subtitle, actions, open = true, children }: { readonly id: string; readonly icon: LucideIcon; readonly title: string; readonly subtitle?: React.ReactNode; readonly actions?: React.ReactNode; readonly open?: boolean; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <details id={id} open={open} className="group scroll-mt-24 rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#121F36] to-gmn-card shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-3 rounded-2xl p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70 sm:p-5 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 h-[22px] w-[22px] shrink-0 text-gmn-primary" aria-hidden="true" />
          <span className="min-w-0">
            <h2 className="text-[17px] font-semibold leading-tight text-gmn-text">{title}</h2>
            {subtitle && <span className="mt-0.5 block text-xs text-gmn-muted">{subtitle}</span>}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {actions}
          <ChevronDown className="h-4 w-4 text-gmn-muted transition-transform group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="px-4 pb-4 sm:px-5 sm:pb-5">{children}</div>
    </details>
  );
}

/** Devolve o foco a quem iniciou a interação, se ele ainda existe e está utilizável; senão, ao título da seção de fallback. */
export function restoreFocus(target: HTMLElement | null, fallbackId?: string): void {
  if (target && target !== document.body && target.isConnected && !target.matches(':disabled') && target.getClientRects().length > 0) {
    target.focus();
    return;
  }
  const holder = fallbackId ? document.getElementById(fallbackId) : null;
  (holder?.querySelector<HTMLElement>('summary') ?? holder)?.focus();
}

/** `true` quando o instante `until` (ms) já passou; re-renderiza UMA vez no vencimento (sem intervalo, sem rede). */
export function useExpired(until: number): boolean {
  const [, bump] = useState(0);
  const expired = Date.now() >= until;
  useEffect(() => {
    if (expired) return;
    const timer = setTimeout(() => bump((n) => n + 1), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [until, expired]);
  return expired;
}

export function CopyHash({ value, label }: { readonly value: string | null | undefined; readonly label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-gmn-muted">—</span>;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* sem permissão de área de transferência: o valor completo continua selecionável no title */
    }
  };
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <code title={value} className="break-all rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-gmn-text">
        {shortHash(value)}
      </code>
      <button type="button" onClick={() => void copy()} aria-label={`Copiar ${label} completo`} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-gmn-muted md:h-7 md:w-7 hover:bg-white/[0.06] hover:text-gmn-text focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70">
        {copied ? <Check className="h-3.5 w-3.5 text-green-300" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copiado' : ''}
      </span>
    </span>
  );
}

/** Estado de carregamento/erro de UMA leitura. Integridade: bloco vermelho SEM dados. */
export function SectionStatus({ phase, hasData, message, code, onRetry, what }: { readonly phase: Phase; readonly hasData: boolean; readonly message: string | null; readonly code: string | null; readonly onRetry: () => void; readonly what: string }): React.JSX.Element | null {
  if (phase === 'idle' || (phase === 'loading' && !hasData)) {
    return (
      <div role="status" aria-live="polite" className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-gmn-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Carregando {what}…
        </p>
        <div aria-hidden="true" className="h-16 animate-pulse rounded-xl border border-white/[0.06] bg-gmn-tile/50" />
      </div>
    );
  }
  if (phase === 'loading') return <p role="status" className="mb-2 flex items-center gap-2 text-xs text-gmn-muted"><LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Atualizando {what}…</p>;
  if (phase === 'integrity') {
    return (
      <div role="alert" className="rounded-xl border border-gmn-danger/50 bg-gmn-danger/[0.08] p-4">
        <p className="flex items-start gap-2 text-sm font-semibold text-gmn-text"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />Falha de integridade em {what}</p>
        <p className="mt-1 text-sm text-gmn-muted">{message ?? 'A verificação de integridade falhou.'} Por segurança, nenhum dado é exibido. Avise quem administra o servidor.</p>
        {code && <p className="mt-2 text-xs text-gmn-muted">Código: <code>{code}</code></p>}
      </div>
    );
  }
  if (phase === 'ready') return null;
  const denied = phase === 'denied';
  return (
    <div role="alert" className="mb-3 rounded-xl border border-gmn-warning/40 bg-gmn-warning/[0.06] p-4">
      <p className="flex items-start gap-2 text-sm font-semibold text-gmn-text"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />{denied ? `Acesso negado a ${what}` : phase === 'unavailable' ? `${what[0]?.toUpperCase()}${what.slice(1)} indisponível` : `Não foi possível carregar ${what}`}</p>
      <p className="mt-1 text-sm text-gmn-muted">{message}</p>
      {!denied && (
        <button type="button" onClick={onRetry} className={`${BUTTON_QUIET} mt-3`}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Tentar novamente
        </button>
      )}
    </div>
  );
}

/** Diálogo modal NATIVO (foco preso, Esc fecha). O conteúdo só é montado quando aberto. */
export function ConfirmDialog({ open, titleId, descriptionId, onClose, fallbackFocusId, children }: { readonly open: boolean; readonly titleId: string; readonly descriptionId: string; readonly onClose: () => void; readonly fallbackFocusId?: string; readonly children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; // quem iniciou a interação
      if (typeof dialog.showModal === 'function') dialog.showModal(); // o foco vai para o primeiro controle do diálogo
      wasOpen.current = true;
    }
    if (!open && dialog.open) dialog.close();
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      restoreFocus(opener.current, fallbackFocusId); // ao fechar, volta a quem abriu (ou ao título da seção se ele sumiu/está desabilitado)
      opener.current = null;
    }
  }, [open, fallbackFocusId]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); onClose(); }} className="w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-white/15 bg-gmn-card p-0 text-gmn-text shadow-2xl backdrop:bg-black/60">
      {open && <div className="p-5">{children}</div>}
    </dialog>
  );
}
