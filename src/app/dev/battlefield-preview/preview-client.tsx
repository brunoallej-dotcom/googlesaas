'use client';

import { useMemo } from 'react';
import type { BattlefieldMetrics, FrontierLead } from '@/types/gmn';
import { toBattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { BattlefieldCard } from '@/components/dashboard/battlefield-card';
import { TerritorySummary } from '@/components/dashboard/territory-summary';
import type { AuditJobTracker } from '@/components/dashboard/types';

interface PreviewClientProps {
  readonly battlefield: BattlefieldMetrics | null;
  readonly lead: FrontierLead;
  readonly tracker: AuditJobTracker | null;
}

/** Monta o card e o resumo exatamente como o dashboard, mas com a fixture recebida do servidor. */
export function PreviewClient({ battlefield, lead, tracker }: PreviewClientProps): React.JSX.Element {
  const model = useMemo(
    () => toBattlefieldMapModel({ battlefield, lead, auditId: tracker?.auditId }),
    [battlefield, lead, tracker]
  );
  return (
    <div className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(380px,1fr)]">
      <BattlefieldCard model={model} lead={lead} tracker={tracker} isStaleResult={false} />
      <TerritorySummary campaign={null} lead={lead} tracker={tracker} model={model} />
    </div>
  );
}
