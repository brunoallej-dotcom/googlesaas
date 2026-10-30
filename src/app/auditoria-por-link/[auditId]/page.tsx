import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AuditDetailScreen } from '@/components/link-audit/audit-page/audit-detail-screen';

export const metadata: Metadata = {
  title: 'Auditoria Lumos · GMN Intelligence Platform',
  description: 'Evidências, critérios, decisões humanas e resultados da Auditoria por Link.',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/** Mesma regra do armazenamento (um teste confere a igualdade): qualquer outro valor é 404, sem consultar nada. */
const AUDIT_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;

export default async function AuditPage({ params }: { params: Promise<{ auditId: string }> }): Promise<React.JSX.Element> {
  const { auditId } = await params;
  if (!AUDIT_ID.test(auditId)) notFound();
  return <AuditDetailScreen key={auditId} auditId={auditId} />;
}
