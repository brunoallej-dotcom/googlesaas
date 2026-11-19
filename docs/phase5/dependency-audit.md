# Fase 5: análise dos 9 avisos do `npm audit`

## Atualização 17/11/2026: picomatch (GHSA-fc5q-39xc-vjpf)
O job `sca (npm audit)` passou a falhar em todos os PRs com um aviso **alto** novo: **GHSA-fc5q-39xc-vjpf**, ReDoS no `picomatch` até 4.0.7 (CVSS 7.5). Padrões extglob de um só ramo repetido, como `+(*)`, causam backtracking exponencial e bloqueiam o event loop. **Não há versão corrigida** (`first_patched_version: null` no banco de avisos do GitHub).

| Pacote (instalado) | Como entra | Em execução no servidor? |
|---|---|---|
| `picomatch` 2.3.2 e 4.0.7 | origem do aviso | **Não** |
| `anymatch` 3.1.3, `chokidar` 3.6.0, `readdirp` 3.6.0, `micromatch` 4.0.8, `fast-glob` 3.3.3 | Tailwind 3 (watch e varredura dos arquivos de conteúdo) | **Não** |
| `sucrase` 3.35.1, `tinyglobby` 0.2.17, `fdir` 6.5.0 | Tailwind 3 (leitura do `tailwind.config`) | **Não** |
| `tailwindcss` 3.4.19 | `devDependencies` | **Não** |

- **Só build e desenvolvimento.** Os 11 pacotes estão marcados `dev` no lockfile. Nenhum entra nas imagens de produção: a web copia só a saída *standalone* do Next, e o worker instala com `npm ci --omit=dev`.
- **O ataque exige que o atacante forneça o padrão glob.** Aqui os padrões são os de `content` no nosso `tailwind.config`, versionados por nós. Nenhuma rota, fila ou arquivo de entrada vira padrão glob.
- **Decisão:** exceção com prazo curto (`review_by` 17/12/2026, 30 dias), uma entrada por pacote e versão, **todas presas ao GHSA**. Para isso, o gate passou a seguir a cadeia `via` dos pacotes que só herdam o aviso (`docs/how-to/ci-security-scans.md`). Um aviso novo em qualquer desses pacotes volta a bloquear.
- **Ao reavaliar:** remover as exceções quando sair versão corrigida do `picomatch` (atualizar pelo Dependabot); se não sair, avaliar a opção C abaixo (Tailwind 4, PR #8), conferindo antes se a cadeia nova ainda depende do `picomatch`.

## Atualização 16/11/2026 (o quadro abaixo é o registro histórico de 16/10/2026)
`npm audit --json` sobre o `package-lock.json` atual: **1 aviso moderado, 0 alto, 0 crítico**.

| Pacote | Instalado | Sev. | Aviso | Em execução no servidor? |
|---|---|---|---|---|
| `postcss-selector-parser` (transitivo, via Tailwind 3) | 6.1.4 | moderada | GHSA-rj75-hqrm-r3gf (complexidade quadrática em seletores planos; corrigido em ≥ 6.1.5) | **Não** (só no build, com o CSS do próprio projeto) |

- Os outros 8 itens do quadro histórico **não são mais reportados**. O `postcss` aninhado no `next` está em **8.5.30** pelo `overrides` do `package.json` (a opção B abaixo, na prática, já está aplicada). `braces` 3.0.3, `micromatch` 4.0.8 e `tailwindcss` 3.4.19 continuam nas mesmas versões: o banco de avisos deixou de apontá-los (não investigado se por retirada ou revisão do aviso).
- O CI passa a ter o job **SCA** (`npm audit` + gate com lista de exceções versionada, `.github/security/npm-audit-exceptions.json`): bloqueia `high`/`critical` sem exceção; moderados aparecem só como informação. A lista de exceções começa **vazia** (nenhum aviso atual a exige). Procedimento: `docs/how-to/ci-security-scans.md`.

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
