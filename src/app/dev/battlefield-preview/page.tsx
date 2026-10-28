import { notFound } from 'next/navigation';
import type { AuditJobTracker } from '@/components/dashboard/types';
import {
  FIXTURE_BANNER,
  FIXTURE_VARIANTS,
  buildFixtureBattlefield,
  buildFixtureLead,
} from '@/dev/battlefield-fixture';
import type { FixtureVariant } from '@/dev/battlefield-fixture';
import { PreviewClient } from './preview-client';

// Só existe em desenvolvimento: responde 404 em produção e nunca é pré-renderizada.
export const dynamic = 'force-dynamic';

const VARIANT_LABEL: Record<FixtureVariant, string> = {
  full: 'Completo (49 pontos)',
  partial: 'Parcial (30 pontos)',
  unreadable: 'Com pontos sem leitura',
  empty: 'Sem auditoria',
  error: 'Auditoria com erro',
};

export default async function BattlefieldPreviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly variant?: string }>;
}): Promise<React.JSX.Element> {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  const { variant: requested } = await searchParams;
  const variant: FixtureVariant = FIXTURE_VARIANTS.find((v) => v === requested) ?? 'full';

  const lead = buildFixtureLead();
  const battlefield =
    variant === 'empty' || variant === 'error' ? null : buildFixtureBattlefield(variant);

  let tracker: AuditJobTracker | null = null;
  if (variant === 'error') {
    tracker = {
      auditId: 'fixture-audit',
      leadId: lead.id,
      status: 'FAILED',
      progressPercent: 15,
      currentAgent: 'BATTLEFIELD',
      errorMessage: 'Mensagem de erro de teste (fixture).',
    };
  } else if (battlefield) {
    tracker = {
      auditId: 'fixture-audit',
      leadId: lead.id,
      status: 'COMPLETED',
      progressPercent: 100,
      currentAgent: 'MAESTRO',
      battlefield,
    };
  }

  return (
    <main className="mx-auto max-w-[1680px] space-y-5 px-5 py-6">
      <div
        role="note"
        className="rounded-xl border-2 border-dashed border-gmn-warning/60 bg-gmn-warning/10 px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-amber-200"
      >
        {FIXTURE_BANNER}
      </div>
      <nav aria-label="Variantes da fixture" className="flex flex-wrap gap-2 text-xs">
        {FIXTURE_VARIANTS.map((v) => (
          <a
            key={v}
            href={`?variant=${v}`}
            aria-current={v === variant ? 'page' : undefined}
            className={`rounded-full border px-3 py-1.5 transition-colors ${
              v === variant
                ? 'border-gmn-primary bg-gmn-primary/20 text-white'
                : 'border-white/10 text-gmn-muted hover:text-gmn-text'
            }`}
          >
            {VARIANT_LABEL[v]}
          </a>
        ))}
      </nav>
      <PreviewClient battlefield={battlefield} lead={lead} tracker={tracker} />
    </main>
  );
}
