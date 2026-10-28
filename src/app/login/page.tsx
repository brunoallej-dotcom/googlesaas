'use client';

import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { safeNextPath } from '@/lib/auth/safe-next';

/** Acesso restrito a operadores autorizados. Sem cadastro, sem recuperação pública de senha. */
export default function LoginPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (response.ok) {
        const next = new URLSearchParams(window.location.search).get('next');
        // Só caminhos internos: nunca redireciona para outro site.
        window.location.assign(safeNextPath(next));
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Não foi possível entrar.');
    } catch {
      setError('Não foi possível conectar ao servidor.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section
        aria-labelledby="login-title"
        className="w-full max-w-sm rounded-2xl border border-white/[0.06] bg-gmn-card p-6 shadow-xl shadow-black/30"
      >
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gmn-primary/15 text-gmn-accent">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 id="login-title" className="text-lg font-semibold text-gmn-text">
              GMN Intelligence Platform
            </h1>
            <p className="text-xs text-gmn-muted">Acesso restrito a operadores autorizados</p>
          </div>
        </div>
        <form onSubmit={(event) => void submit(event)} className="space-y-3.5" noValidate>
          <label className="block text-xs font-medium text-gmn-muted">
            E-mail
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-gmn-tile px-3 py-2 text-sm text-gmn-text outline-none focus:border-gmn-primary"
            />
          </label>
          <label className="block text-xs font-medium text-gmn-muted">
            Senha
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-gmn-tile px-3 py-2 text-sm text-gmn-text outline-none focus:border-gmn-primary"
            />
          </label>
          {error && (
            <p role="alert" className="rounded-lg border border-gmn-danger/30 bg-gmn-danger/10 px-3 py-2 text-xs text-gmn-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || email.length === 0 || password.length === 0}
            className="w-full rounded-lg bg-gmn-primary px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-gmn-primary/25 transition-colors hover:bg-gmn-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </section>
    </main>
  );
}
