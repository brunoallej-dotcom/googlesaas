import type { Metadata } from 'next';
import { LinkAuditScreen } from '@/components/link-audit/link-audit-screen';

export const metadata: Metadata = {
  title: 'Auditoria por Link · GMN Intelligence Platform',
  description: 'Identificação da empresa a partir do link do perfil no Google Maps.',
};

export default function LinkAuditPage(): React.JSX.Element {
  return <LinkAuditScreen />;
}
