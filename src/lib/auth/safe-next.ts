/** Só caminhos internos: rejeita `//`, `/\\`, caracteres de controle e qualquer URL que mude de origem. */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\u0000-\u001f]/.test(next)) return '/';
  try {
    const base = 'http://internal.invalid';
    const url = new URL(next, base);
    return url.origin === base ? `${url.pathname}${url.search}` : '/';
  } catch {
    return '/';
  }
}
