/**
 * O pacote `lucide-react` publica um arquivo CommonJS dentro de um pacote "type": "module", o que
 * o Node não consegue carregar nos testes. Os ícones são decorativos (aria-hidden): troca-se o pacote
 * por componentes vazios só neste processo de teste. Importe este arquivo ANTES dos componentes.
 */
import Module from 'node:module';

type Loader = (request: string, ...rest: unknown[]) => unknown;
const internal = Module as unknown as { _load: Loader };
const original = internal._load;

internal._load = function load(this: unknown, request: string, ...rest: unknown[]): unknown {
  if (request === 'lucide-react') {
    return new Proxy({}, { get: (_target, name) => (name === '__esModule' ? true : () => null) });
  }
  return original.call(this, request, ...rest);
};
