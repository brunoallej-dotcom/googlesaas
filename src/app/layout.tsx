import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GMN Intelligence Platform',
  description:
    'Inteligência territorial e posicionamento no Google Meu Negócio: prospecção de fronteira, auditoria multi-agente e Campo de Batalha Geográfico.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="min-h-screen bg-gmn-bg font-sans text-gmn-text antialiased">
        {children}
      </body>
    </html>
  );
}
