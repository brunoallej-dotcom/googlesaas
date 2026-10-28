'use client';

import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import type { ComponentStatus, HealthReport } from '@/lib/system-health';

const TONE: Record<ComponentStatus, string> = {
  OK: 'text-green-300 border-gmn-success/30',
  DEGRADED: 'text-amber-300 border-gmn-warning/40',
  DOWN: 'text-red-300 border-gmn-danger/40',
  UNKNOWN: 'text-gmn-muted border-white/10',
};

const LABEL: Record<ComponentStatus, string> = { OK: 'Operação normal', DEGRADED: 'Atenção', DOWN: 'Indisponível', UNKNOWN: 'Verificando' };

/** Indicador discreto de saúde (Redis, Worker, Supabase). Atualiza a cada 30 s; falhas não quebram a tela. */
export function SystemStatus(): React.JSX.Element | null {
  const [report, setReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/system/health');
        if (!res.ok) return;
        const body = (await res.json()) as HealthReport;
        if (!cancelled) setReport(body);
      } catch {
        /* indicador é opcional */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!report) return null;
  const issues = [
    report.redis.status !== 'OK' ? 'Redis indisponível' : null,
    report.worker.status === 'DOWN' ? 'Worker inativo (npm run worker)' : null,
    report.supabase.status !== 'OK' ? 'Banco indisponível' : null,
  ].filter(Boolean);
  return (
    <p
      role="status"
      title={issues.length > 0 ? issues.join(' · ') : 'Redis, Worker e banco respondendo.'}
      className={`hidden shrink-0 items-center gap-1.5 rounded-full border bg-gmn-card px-3 py-1.5 text-xs sm:inline-flex ${TONE[report.overall]}`}
    >
      <Activity className="h-3.5 w-3.5" aria-hidden="true" />
      {issues.length > 0 ? issues[0] : LABEL[report.overall]}
    </p>
  );
}
