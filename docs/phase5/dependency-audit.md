# Fase 5: análise dos 9 avisos do `npm audit`

Atualizado em 16/10/2026. **Nada foi atualizado** (nenhum `npm audit fix`, nenhuma versão maior). Fonte: `npm audit --json` e consulta ao registro do npm. Resultado: 6 altas, 3 moderadas, 0 críticas.

## Quadro
| Pacote | Instalado | Sev. | Problema | Em execução no servidor? | Versão que corrige |
|---|---|---|---|---|---|
| `postcss` **aninhado no `next`** | 8.4.31 | alta | XSS por `</style>` na saída; leitura de arquivo por `sourceMappingURL` em CSS controlado por atacante (2 avisos, o 2º é correção incompleta do 1º) | **Não.** O PostCSS só processa o CSS **do próprio projeto no build**; o servidor em produção não processa CSS de usuários | `next@16.4.2` (**major**). O `postcss` do projeto (devDependency) já é **8.5.30** (corrigido) |
| `next` | 15.5.28 | moderada | herda o item acima | **Não** (mesma razão) | `next@16.4.2` (**major**). Não existe 15.x corrigido: a última é 15.5.28 |
| `braces` | 3.0.3 | alta | negação de serviço por esgotamento de pilha com padrões glob muito aninhados | **Não.** Só no build, com os globs do nosso `tailwind.config` | **Nenhuma na linha 3** (3.0.3 é a última). Some ao sair do Tailwind 3 |
| `micromatch` | 4.0.8 | alta | herda `braces` | Não (build) | idem |
| `chokidar` | 3.6.0 | alta | herda `braces` | Não (build/watch) | idem (5.0.0 existe, mas é dependência do Tailwind) |
| `fast-glob` | 3.3.3 | alta | herda `micromatch` | Não (build) | idem |
| `tailwindcss` | 3.4.19 | alta | herda os três acima | Não (build) | `tailwindcss@4.3.3` (**major**) |
| `postcss-selector-parser` | 6.1.4 | moderada | complexidade quadrática em seletores planos (CPU) | Não (build) | 7.1.6 (via Tailwind 4) |
| `postcss-nested` | 6.2.0 | moderada | herda o item acima | Não (build) | 9.0.0 (via Tailwind 4) |

## Dependências de execução do servidor
`@supabase/supabase-js`, `bullmq`, `ioredis`, `leaflet`, `lucide-react`, `next`, `pdfkit`, `react`, `react-dom`, `react-leaflet`, `zod`. **Nenhuma** delas tem aviso próprio. O único aviso em pacote de execução é `next`, e é uma dependência **de build** embutida (PostCSS), não uma falha do servidor HTTP.

## Impacto no seu uso (interno)
Os ataques descritos exigem que um **atacante controle o CSS ou os padrões glob** que entram no build. Aqui o CSS e os globs são arquivos nossos, versionados por nós; o servidor de produção não aceita CSS de terceiros. **Risco prático para a operação: baixo.** O risco existiria se, no futuro, a plataforma passasse a compilar CSS enviado por usuários, o que está fora do escopo.

## Opções (nenhuma executada)
| Opção | O que muda | Risco | Recomendação |
|---|---|---|---|
| **A. Aceitar e monitorar** | Nada | Baixo (acima) | **Recomendada agora** |
| B. `overrides` do PostCSS do `next` para 8.5.x (mesma versão maior, 8) | `package.json` | Pode haver incompatibilidade sutil com o CSS do Next; exige build + comparação visual | Só com sua aprovação; resolve 3 dos 9 avisos (`postcss`, `next`) |
| C. Tailwind 4 | Configuração, `@tailwind` → `@import`, tokens de cor | **Alto para o design aprovado** | Projeto separado, com comparação visual lado a lado |
| D. Next 16 | Major do framework | Alto (API, middleware, React) | Projeto separado, depois de C |
| E. `npm audit fix --force` | Aplica C e D juntos e sem controle | **Muito alto** | **Não fazer** |

## Reavaliação
Rodar `npm audit` a cada release; reavaliar B/C/D quando houver uma janela para testes visuais completos.
