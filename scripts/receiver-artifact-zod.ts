/**
 * P9.3a — o zod dos artefatos dos receptores roda SEM JIT, como o do `sign` (`scripts/link-audit-sign-artifact-zod.ts`, revisão da W4.6): cada
 * esquema de objeto decide na CONSTRUÇÃO se usa o caminho JIT, então esta configuração mora num módulo próprio, importado PRIMEIRO pela entrada
 * do artefato, antes de qualquer módulo construir um esquema. Com ela, `Function` nunca é chamado em execução.
 */
import { config } from 'zod';

config({ jitless: true });
