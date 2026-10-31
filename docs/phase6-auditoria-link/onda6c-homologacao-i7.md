# Onda 6C — Relatório de homologação (I7) — CHECKPOINT

> **Parecer: HOMOLOGAÇÃO FUNCIONAL APROVADA — REVISÃO ADVERSARIAL DE SEGURANÇA PENDENTE.**
> **Estado formal da Onda 6C: NÃO ENCERRADA.** O responsável aprovou os testes executados, mas **não autorizou** declarar a Onda encerrada enquanto a revisão adversarial **independente** de segurança e integridade não for concluída. Essa revisão **não** pode ser substituída por autoavaliação, e **nenhum resultado dela é registrado aqui** (nem APROVADO, nem reprovado): ela não foi executada até o fim.

HEAD homologado: **`dab23bc`** (`feat(link-audit): integrate Lumos audit navigation`), sobre `7223fbc`. Ambiente 100% isolado (sem rede, sem `.env*`, sem Redis/Supabase/Serper, dados fictícios, sessão com segredo aleatório por execução). Este relatório e o roteiro `i7-homologacao.cjs` são registrados no commit `test(link-audit): add 6C end-to-end acceptance evidence` (checkpoint; autorizado pelo responsável). D5 e Onda 7 não foram tocadas; `scoring/` idêntico à `v1.0.1`; régua D3B intacta.

## Portões de qualidade
| Portão | Resultado | Evidência |
|---|---|---|
| Suíte completa isolada | **PASS** | 1590/1590 |
| TypeScript (`tsc`) | **PASS** | limpo |
| Build offline | **PASS** | `scripts/run-isolated.sh --offline-fonts npm run build` |
| Integração das APIs | **PASS** | 87/87 (rotas + cliente) |
| Concorrência e recuperação (inclui multiprocesso) | **PASS** | 162/162 |
| Isolamento/arquitetura | **PASS** | 61/61 |
| Contrato da página com serviços reais | **PASS** | 7/7 |
| Navegador reproduzível (Chromium) | **PASS** | I5 41/41 · I6 106/106 · I7 117/117 (`scripts/browser/run.sh`) |
| Revisões independentes do I6 (2) | **PASS com ressalvas** | sem BLOCKER; MAJOR/MINOR corrigidos |
| **Revisão adversarial INDEPENDENTE de segurança/integridade** | **PENDENTE — OBRIGATÓRIA** | o revisor foi interrompido pelo limite semanal de uso (retomada possível a partir de 01/11/2026, 20h, Brasília). Nenhum achado foi emitido. A verificação própria (seção B abaixo) é evidência da implementação, **não** revisão independente. Roteiro de retomada no Apêndice |
| Segurança offline | PASS parcial / SKIPPED | PASS: sem `dangerouslySetInnerHTML`/`eval`/storage no código da área, cabeçalhos (`nosniff`, `DENY`, Referrer-Policy, CSP), só a própria origem no navegador. SKIPPED: `npm audit` (sem rede), eslint (não instalado) |
| Leitor de tela real · outros navegadores/dispositivo · `axe-core` | **SKIPPED** | indisponíveis; acessibilidade COMPLETA não é declarada |

## A. Fluxo operacional (14 passos) — PASS
Listagem → seleção → workspace → evidências verificadas → prévia do motor → decisão humana (hash da entrada e head mudam) → revogação (restaura o hash original; histórico guarda ambas) → elegibilidade → finalização INCONCLUSIVA com recibo em outro volume → resultado s0001 consultável e atual (`stale=false`) → nova decisão torna o s0001 HISTÓRICO → s0002 → conflito `expectedHead` (outra operadora; nada gravado) → sessão expirada vai ao login com retorno → decisão pendente reenviada e resultado pendente concluído (recibo só passa a existir ao concluir) → retorno à listagem com a mesma empresa.

## D. Estados distinguíveis pelo operador — PASS
Pronta · decisão pendente · bloqueada (integridade) · INCONCLUSIVA (sem índice) · **PONTUADA** (só fixture rica; detalhe mostra Índice Lumos e nível; faixa e prévia atual da mesma auditoria **não** mostram índice) · histórico desatualizado · verificado e atual (`stale=false`, `decisionsChanged=false`). Coleta real: todas as prévias são INCONCLUSIVO, cobertura 11% (≤ teto de 17%) < 40%.

## B. Integridade e segurança (API real) — PASS
Sem sessão: 401 em todas as 9 rotas; operador não autorizado: 403 em todas; `no-store`+`nosniff`; nenhuma resposta de resultados/prévia vaza e-mail de outro operador, justificativa, entrada, autor de decisão ou caminho (`finalizedBy` é contrato); id malformado 400 sem eco; hash errado 409, head velho 409, corpo malformado/campo extra 400 (nada gravado); decisão com head velho 409; idempotência (replay sem novo registro); **3 finalizações simultâneas → 1 criada (201) + 2 replay (200)**; evidência adulterada após resultado → prévia 409, finalizar com o corpo válido 409, resultado selado segue consultável; resultado adulterado em disco → detalhe e lista 409; recibo removido → detalhe 409 e o registro vira pendente (não conta).
Limite do navegador: `stateChangedAfterFinalization=true` só em testes do serviço.

## C. Experiência — PASS com defeitos encontrados e corrigidos
Corrigidos (todos no commit do I6, com teste de regressão): sem `<main>`; `<nav>` sem nome; salto h2→h4; anel de foco 2,96:1; rótulo no nome do botão "Atualizado"; reflow 320 px (linhas rótulo/valor); item ativo do menu deixava URL e tela divergentes (F5 abria outra empresa); foco do menu móvel mirava o elemento errado. Verificado: Tab/Shift+Tab, diálogo modal (foco não sai para o conteúdo), Esc, alvos 44 px, contraste medido no renderizado em 7 telas, nenhuma animação contínua (normal e movimento reduzido), zoom 200%/400% sem rolagem horizontal, mobile 390 px.

### Contraste: Auditoria por Link × dashboard em geral
| Risco | Auditoria por Link | Dashboard/login (fora de escopo) |
|---|---|---|
| Branco sobre `#247BFF` (3,92:1; hover `#36A3FF` 2,68:1) | corrigido (`#1D68DB` 5,18:1) | **4 botões**: `leads-table:324`, `audit-panel:202`, `top-filters:102`, `login/page:87` |
| `muted/60` (3,06–3,39:1) | corrigido (`/80`) | **4 usos**: `audit-panel:247`, `top-filters:22`, `sidebar:145` ("Em breve", desabilitado), `metric-card:70` |
| Anel de foco `/40` `/60` | `/60`→`/70`; `/40` só em campos com borda de foco opaca | `top-filters:22,123` |
**Decisão do responsável (aprovada; NÃO implementada neste checkpoint):** corrigir em **commit específico de acessibilidade**, depois de analisar os componentes afetados: (a) token `primary-strong` (referência inicial `#1D68DB`) para os 4 botões com texto branco; (b) os usos de `muted/60` sem contraste suficiente; (c) os anéis de foco com contraste insuficiente. Regras: **não alterar o token primário global da marca**; verificar o contraste por **combinação real** de primeiro plano e fundo, incluindo os estados `hover`, `focus` e `disabled` (controles desabilitados são isentos pelo WCAG, mas devem permanecer distinguíveis).

## Pendências para o encerramento da Onda 6C
1. **Revisão adversarial independente de segurança e integridade** (obrigatória; ver Apêndice). Sem ela, a Onda 6C **não** é declarada encerrada.
2. **Commit de acessibilidade do dashboard** (decisão acima), separado; **não** bloqueia a homologação funcional, mas fica registrado.
3. Autorização do responsável para o encerramento formal, depois do item 1.

## Riscos residuais e pendências de produção (nenhum deve ser omitido do parecer de prontidão)
- **CSP em modo Report-Only**, com `'unsafe-inline'` em `script-src` e `style-src` (não bloqueia nada hoje).
- **Limitadores de requisição em memória** (zeram ao reiniciar; por processo).
- **Quatro volumes graváveis** (decisões, recibos das decisões, resultados, recibos dos resultados) **com backup independente** — a estratégia ainda não existe/não foi ensaiada.
- **Recuperação de pendências** (decisão e resultado sem recibo): procedimento existe; alerta externo não.
- **Monitoramento** de integridade (409 em leitura) e de armazenamento (espaço, `ENOSPC`/`EIO`): inexistente.
- **Testes de rollback** não executados (nem em staging).
- **Revisão adversarial independente não concluída.**
- **Acessibilidade sem leitor de tela real** (NVDA/JAWS/VoiceOver), sem outros navegadores e sem dispositivo físico; `axe-core`, `eslint` e `npm audit` indisponíveis neste ambiente. Acessibilidade COMPLETA não é declarada.
- **Cobertura do Lumos sem a D5:** toda auditoria de coleta real sai INCONCLUSIVA (cobertura 11%, teto 17% < mínimo 40%); PONTUADO só com fixture rica.
- Contraste do restante do dashboard (4 botões, 4 usos de `muted/60`, 2 anéis) — correção aprovada, ainda não feita.
- Menores aceitos: o clique no item ativo do menu recarrega a página; a lista mostra até 50 empresas; filtros não voltam além do `auditId`; `stateChangedAfterFinalization=true` só é provado em testes do serviço (não no navegador).
Checklist de produção (**não executado**): `onda6c-checklist-producao.md`.

## Parecer
**HOMOLOGAÇÃO FUNCIONAL APROVADA — REVISÃO ADVERSARIAL DE SEGURANÇA PENDENTE.** Nenhum BLOCKER aberto foi encontrado pelas verificações executadas, mas isso **não** equivale a aprovação de segurança. Onda 6C: **NÃO ENCERRADA**.

## Apêndice — como retomar a revisão adversarial independente
**Situação preservada:** o agente interrompido (id de sessão `aba483da6b491226a`) só pode ser retomado na **mesma** sessão; em uma sessão nova, **abra um revisor novo** com o roteiro abaixo (o trabalho parcial dele não emitiu achados e não deve ser usado como conclusão).
**Independência:** o revisor deve formar sua opinião lendo o **código e as especificações**, sem receber primeiro as conclusões deste relatório nem a seção B do roteiro; só depois da primeira passada ele pode confrontar `scripts/browser/i7-homologacao.cjs`.
**Preparação (a partir de 01/11/2026, 20h, Brasília):**
1. `cd ~/projects/gmn-intelligence-platform && git log --oneline -3` (conferir o commit do checkpoint e que `src/lib` e `src/app/api` não mudaram desde `dab23bc`: `git diff dab23bc --stat -- src/lib src/app/api` deve sair vazio).
2. Snapshot só de leitura, sem `node_modules`: `D=$(mktemp -d) && git archive HEAD src tests scripts docs package.json | tar -x -C "$D" && echo "$D"`.
3. Opcional, para ele executar testes: `scripts/run-isolated.sh npm test` (ambiente sem rede e sem `.env*`).
**Restrições do revisor:** somente leitura; sem rede; sem ler `.env*`; sem acessar Redis, Supabase, Serper nem a VPS; sem executar migrations; **não** registrar APROVADO sem concluir todos os itens.
**Escopo obrigatório (foco definido pelo responsável):** autenticação e autorização das APIs; proteção de dados e ausência de vazamentos; validação de entradas e respostas; persistência imutável; integridade de resultados e recibos; corridas entre verificação e publicação; recuperação de falhas e pendências; idempotência e concorrência; truncamento, restauração e adulteração; segurança do leitor de arquivos (symlink, tamanho, escrita exclusiva); comportamento dos limitadores; CSP e demais cabeçalhos HTTP; riscos residuais documentados nas Ondas 6B e 6C.
**Arquivos de referência:** `src/lib/link-audit-scoring-runs/` (`results.ts`, `results-store.ts`, `results-verify.ts`, `preview.ts`, `outcome.ts`, `audit-id-alias.ts`); `src/lib/link-audit-decisions/`; `src/lib/link-audit-evidence/`; `src/lib/link-audit/snapshot-store.ts` e `canonical.ts`; `src/app/api/link-audit/**` (cada `shared.ts`); `src/lib/auth/**`; `src/lib/rate-limit.ts`; `next.config.*`; `docs/phase6-auditoria-link/onda6c-integracao-orquestracao.md`, `onda6b-decisoes-humanas.md`, `onda6b-adr-ancora-externa.md`.
**Prompt sugerido (colar no revisor novo):** "Você é revisor INDEPENDENTE, ADVERSARIAL e SOMENTE LEITURA de segurança e integridade da Auditoria por Link (Onda 6C). Tente ENCONTRAR defeitos reais, não confirmar a documentação. Para cada item do escopo, relate o que verificou e a evidência no código; achados com arquivo:linha, cenário passo a passo, severidade BLOCKER/MAJOR/MINOR e se já existe teste. Seja cético com a própria conclusão. Termine com APROVADO / APROVADO COM RESSALVAS / BLOQUEADO, justificado."
**Depois:** gravar o relatório em `docs/phase6-auditoria-link/onda6c-revisao-adversarial-seguranca.md`, tratar BLOCKER/MAJOR, repetir `run.sh all` e a suíte, e **só então** pedir a autorização do responsável para o encerramento formal.
