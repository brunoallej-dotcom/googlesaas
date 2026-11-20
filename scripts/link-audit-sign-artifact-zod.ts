/**
 * Confirmação da revisão da W4.6 (defesa em profundidade): o zod do artefato roda SEM JIT. Na versão travada (4.6.7), cada esquema de objeto decide
 * na CONSTRUÇÃO se usa o caminho JIT (`const jit = !globalConfig.jitless`, em `core/schemas.js`), e o teste `util.allowsEval` (que chama
 * `new Function("")`) só roda se o JIT estiver ligado. Por isso esta configuração mora num módulo próprio, importado PRIMEIRO pela entrada do
 * artefato: roda antes de qualquer módulo do `sign` construir um esquema. Com ela, `Function` nunca é chamado em execução (o teste conta).
 */
import { config } from 'zod';

config({ jitless: true });
