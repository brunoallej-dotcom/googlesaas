import { withAuditIdParam } from './evidence-state';

/**
 * Mantém o `?auditId=` do endereço igual à empresa que a tela MOSTRA. Troca a entrada atual do histórico (`replaceState`), sem criar
 * outra: atualizar a página ou voltar a ela não restaura uma empresa diferente da exibida. O estado do histórico (usado pelo Next) e
 * o `#fragmento` são preservados; os demais parâmetros também. `null` remove o pedido.
 */
export function syncAuditIdInUrl(auditId: string | null): void {
  const { pathname, search, hash } = window.location;
  const next = withAuditIdParam(search, auditId);
  if (next === search) return;
  window.history.replaceState(window.history.state, '', `${pathname}${next}${hash}`);
}
