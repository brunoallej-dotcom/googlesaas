# Matriz de liberação — GMN Intelligence Platform

> **Status: PREPARAÇÃO. Nada aqui foi executado.** Este documento só reúne critérios, evidências exigidas e comandos de verificação.
> Os comandos marcados como "exige acesso" **não** devem ser rodados sem autorização escrita do responsável (ver `docs/runbooks/verificacao-somente-leitura.md`).
> Elaborado em 07/11/2026 sobre a branch `chore/saneamento-tecnico` (base `7013b2a`); estados de P-30/P-31 atualizados no fechamento da branch (commits em Draft PR; nada mergeado).

## Estratégia de duas entregas (aprovada pelo responsável)

1. **Entrega 1 — Plataforma GMN** (prospecção, Maestro multiagente, grade 7x7, PDFs, Worker/BullMQ/Redis, Supabase) em produção com a **Auditoria por Link DESLIGADA**: sem as variáveis `GMN_LINK_AUDIT_*` as rotas respondem 503 e falham fechadas.
2. **Entrega 2 — Auditoria Lumos completa** (Fase 6: livro de cabeças, produtor P1, guarda externa etc.), só depois, com matriz própria (Seção 2).

As duas seções são **independentes**: nenhum item da Seção 2 bloqueia a Entrega 1, **desde que** o critério P-LA (Seção 1) esteja verde.

## Legenda de estado

| Símbolo | Significado |
|---|---|
| ✅ | verificado no repositório (arquivo lido nesta preparação) |
| ⚠️ | existe só como documento/plano; sem implementação ou sem execução comprovada |
| ❌ | ausente (nem código nem documento que o cumpra) |
| ❓ | exige acesso a ambiente (VPS, Supabase, GitHub, Redis) — não verificável a partir do repositório |

"Dono": **responsável** = decisão/autorização/ação em ambiente do dono; **técnico** = implementação no repositório.
Ressalva geral: ✅ prova só o que está no repositório; **não** prova o estado da produção.

---

## Seção 1 — Plataforma GMN (Entrega 1)

### 1.A Banco e dados (Supabase)

| ID | Critério | Evidência exigida | Como verificar (somente leitura) | Estado | Dono | Fonte |
|---|---|---|---|---|---|---|
| P-01 | **G5 — RLS endurecido**: `003_rls_hardening.sql` aplicado; anon/authenticated sem privilégio nas 5 tabelas `gmn_*`/`prospecting_*` | Saída de `rls:probe` com 0 EXPOSTO e 0 "só RLS"; JSON de `rls-audit-json.sql` novo mostrando 0 privilégios para anon/authenticated | `npm run rls:probe`; colar `supabase/audit/rls-audit-json.sql` no SQL Editor (só SELECT) | ⚠️ migration **testada só localmente, não aplicada**; auditoria real de 17/10 mostrou RLS ligado, 0 políticas, privilégios totais para anon/authenticated | responsável (aplicar) + técnico (conferir) | `docs/phase5/rls-audit.md:59-170`; `docs/phase5/evidence/rls-audit-2026-10-17.json`; `supabase/proposed/003_rls_hardening.sql`; `NOTES.md:58` |
| P-02 | Reversão do G5 disponível e ensaiada | `003_rls_hardening.rollback.sql` revisado; ensaio local registrado | Ler o arquivo; rodar em PostgreSQL descartável (`supabase/proposed/local-test/`) | ✅ arquivo existe; ⚠️ ensaio só local | técnico | `supabase/proposed/003_rls_hardening.rollback.sql`; `docs/phase5/rls-audit.md:85-100` |
| P-03 | Papel `authenticated` testado | Saída de `rls:probe -- --authenticated` sem exposição | `npm run rls:probe -- --authenticated` (pede senha do operador no terminal) | ❓ risco R14 "pendente" | responsável | `docs/phase5/risk-register.md` (R14); `scripts/rls-probe.ts` |
| P-04 | Integridade dos dados históricos | `db:check` sem problemas; `validate:recovery` 100% | `npm run db:check`; `npm run validate:recovery` | ❓ último resultado documentado: 32/32 e sem problemas em 16/10 (desatualizado) | responsável | `docs/phase5/homologation-plan.md` (§2); `scripts/check-integrity.ts`; `scripts/validate-recovery.ts` |
| P-05 | Migrations versionadas e imutáveis | Só `001` e `002` aplicadas; `003` em `proposed/` | `ls supabase/migrations supabase/proposed` | ✅ | técnico | `supabase/migrations/`, `supabase/proposed/` |
| P-06 | Backup e restauração **testada** do Supabase (banco e buckets) e dos dados da VPS | Rotina agendada + registro de um restore real em ambiente descartável | Consultar painel Supabase (backups); listar destino do backup; checar data do último restore | ⚠️ plano escrito (restic/rsync); nada agendado nem ensaiado comprovado | responsável | `deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:1-30` |

### 1.B Homologação real

| ID | Critério | Evidência exigida | Como verificar | Estado | Dono | Fonte |
|---|---|---|---|---|---|---|
| P-07 | **G6 — homologação real**: 1 auditoria completa (Belo Riso, "Clínica Odontológica", grade 7x7 = **49 consultas Serper**, ~49 créditos; até ~98 com repetições) | `COMPLETED`, 49 pontos válidos, PDF baixável só autenticado, **uma** auditoria para o lead, `db:check` limpo, `validate:recovery` repetido 100% | Pós-execução: `npm run db:check`; `npm run validate:recovery`; `/api/system/health`. **A execução em si custa crédito e exige autorização escrita explícita** | ⚠️ só plano; nunca executada (só mocks) | responsável | `docs/phase5/homologation-plan.md:1-45`; `docs/phase5/release-checklist.md` ("Homologação real (G6) PENDENTE"); `NOTES.md:59` |
| P-08 | Trava do Worker: nasce desligado e só liga após validação | `GMN_WORKER_REPLICAS` documentado e ativado conscientemente | Ler `stack.yml`; na VPS: `docker service ls` (réplicas do worker) | ✅ no repo (`replicas: ${GMN_WORKER_REPLICAS:-0}`); ❓ estado real | responsável | `deploy/hostinger/stack.yml:166` |

### 1.C Pipeline, CI e cadeia de suprimento

| ID | Critério | Evidência exigida | Como verificar | Estado | Dono | Fonte |
|---|---|---|---|---|---|---|
| P-09 | **Deploy somente por CI** (regra do projeto) | Workflow de release que constrói a imagem, publica em registry privado e implanta; nenhum `scp`/`docker load` manual | `ls .github/workflows`; ler `ci.yml` | ❌ **inexistente**: `ci.yml` só tem typecheck, test, build (`npm run build`, **não** Docker) e gitleaks; nenhum job de imagem nem de deploy. O guia de implantação manda `docker save` → `scp` → `docker load`, o que **contradiz** a regra "Deploy prod: CI only" | técnico (criar) + responsável (aprovar) | `.github/workflows/ci.yml:17,29,41,53`; `deploy/hostinger/GUIA-DE-IMPLANTACAO.md:13,32-37`; `deploy/hostinger/build-images.sh:3`; `CLAUDE.md:39` |
| P-10 | CI mínima verde e obrigatória | Checks `typecheck`, `test`, `build`, `security` verdes; proteção de branch exigindo-os | `gh run list`; `gh api repos/OWNER/REPO/branches/main/protection` (GET) | ✅ jobs existem; ❓ proteção de `main` e estado das execuções | responsável | `.github/workflows/ci.yml`; `docs/runbooks/verificacao-somente-leitura.md` §4 |
| P-11 | Lint | Job de lint | `npm run lint` | ❌ ESLint **não instalado**; `next lint` inutilizável; sem job | técnico | `package.json` (script `lint`); `CLAUDE.md:25,35` |
| P-12 | Varredura de imagem (Trivy ou equivalente) e build Docker em CI | Job `docker build` + Trivy sem HIGH/CRITICAL corrigíveis | ler `ci.yml` | ❌ ausente | técnico | `.github/workflows/ci.yml` |
| P-13 | Dependabot configurado para o que o projeto usa | `dependabot.yml` só com `npm`, `github-actions`, `docker` (diretórios corretos) | ler o arquivo | ❌ ainda é o template com `[CUSTOMIZE]` e ecossistemas inexistentes (pip, gomod, cargo, terraform); `docker` aponta `/` (Dockerfile está em `deploy/hostinger/`) | técnico | `.github/dependabot.yml:3-6,22-45` |
| P-14 | Imagens fixadas **por digest** | `image: ...@sha256:<digest>` para web, worker e redis; base do Dockerfile por digest | `grep -n "@sha256" deploy/hostinger/stack.yml deploy/hostinger/Dockerfile`; na VPS: `docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'` | ❌ stack usa tag (`gmn-web:${GMN_IMAGE_TAG}`, `redis:7.4.11-alpine`); Dockerfile usa `node:22.23.2-bookworm-slim` por tag. O guia só cita digest como alternativa | técnico + responsável | `deploy/hostinger/stack.yml:13,124,188`; `deploy/hostinger/Dockerfile:3`; `GUIA-DE-IMPLANTACAO.md:41` |
| P-15 | **Dependências**: `npm audit` reavaliado e decisão registrada | Saída atual do `npm audit` + decisão por aviso | `npm audit --omit=dev` e `npm audit` (consulta ao registro: **exige rede** e autorização) | ⚠️ `dependency-audit.md` é de **16/10/2026** e lista 9 avisos (6 altos, 3 moderados), todos de toolchain de build; está **desatualizado** (há `overrides` de `postcss` em `package.json`, que o documento trata como "opção B não executada") | técnico | `docs/phase5/dependency-audit.md:1-30`; `package.json:55-59` |
| P-16 | Cobertura de testes medida | Relatório de cobertura (alvo ≥ 80% em domínio/aplicação) | `node --experimental-test-coverage ...` (não configurado) | ❌ "Coverage: not configured"; só contagem de testes (157 arquivos em `tests/`, `npm test` lista explícita) | técnico | `CLAUDE.md:30`; `package.json` (script `test`) |
| P-17 | Suíte de testes verde, offline | `npm test`, `npm run typecheck`, `npm run build` verdes via `scripts/run-isolated.sh` | `scripts/run-isolated.sh npm test` (local, sem rede) | ❓ não executado nesta preparação; último registro: 1590 testes (I7) | técnico | `scripts/run-isolated.sh`; `NOTES.md:94` |

### 1.D Infraestrutura e operação

| ID | Critério | Evidência exigida | Como verificar | Estado | Dono | Fonte |
|---|---|---|---|---|---|---|
| P-18 | **Redis exclusivo da GMN** (serviço `gmn-redis` na rede `gmn_internal`; **NUNCA** a porta 6379 do host, que é de outro projeto) | `REDIS_URL` com senha e host `gmn-redis`; stack sem `ports:`; nenhum acesso ao 6379 do host | Repo: ler entrypoint e stack. VPS: `docker service ps gmn_gmn-redis`; consultas só via contêiner `gmn-redis` (runbook §3) | ✅ no repo: entrypoint recusa outro host; `stack.yml` não publica portas; `maxmemory-policy noeviction`, AOF `everysec`; ❓ estado real | técnico (repo) / responsável (VPS) | `deploy/hostinger/docker-entrypoint.sh:43-46`; `deploy/hostinger/stack.yml:187-248`; `CLAUDE.md` (regra Redis) |
| P-19 | Segredos como `docker secret` externos, nunca na imagem nem no repo | 6 secrets externos existentes; entrypoint recusa `.env*` na imagem | `docker secret ls` (só nomes); `gitleaks` no CI | ✅ desenho no repo; ❓ existência real dos secrets | responsável | `deploy/hostinger/stack.yml` (`secrets:`); `docker-entrypoint.sh:14-24,31-34`; `ci.yml:53-64` |
| P-20 | **Rotação de segredos** (service role, anon, Serper, Redis, chave que assina a sessão derivada da service role) | Runbook de rotação com ordem, janela e verificação; data da última rotação | Ler runbook; `docker secret ls` mostra datas de criação | ⚠️ risco R12 documentado (girar a service role invalida sessões); **não há runbook de rotação da plataforma** (só o de chaves da Fase 6) | técnico (escrever) + responsável | `docs/phase5/risk-register.md` (R12); `docs/phase6-auditoria-link/onda6c-runbook-chaves.md` (só Fase 6) |
| P-21 | **Monitoramento e alertas** (Worker/Redis fora do ar, disco, falha de auditoria, expiração de certificado) | Alerta externo configurado e testado; destinatário definido | Verificar ferramenta de monitoramento (fora do repo) | ❌ apenas `/api/system/health` e heartbeat internos; sem alerta externo | responsável (decidir) + técnico | `src/app/api/system/health/route.ts`; `onda6c-checklist-producao.md:30` ("monitoramento inexistente") |
| P-22 | **TLS e IP real atrás do ingress** (`shared:false`) | `/api/system/client-address` logado mostra seu IP público, `shared:false`, ignora `X-Real-IP`/XFF forjados; certificado Let's Encrypt válido; sem `forwardedHeaders.insecure` | Procedimento manual em `VERIFICACAO-POS-DEPLOY.md` §5; `curl -sI https://HOST` | ❓ nunca verificado em produção; risco: NAT do ingress do Swarm dá `shared:true` e o limite de login vira balde global | responsável | `deploy/hostinger/CHECKLIST-DE-SEGURANCA.md:8-9`; `src/lib/auth/guard.ts:63-97`; `src/app/api/system/client-address/route.ts` |
| P-23 | **Limitadores em memória** conhecidos e aceitos | Decisão registrada: limites por processo, zeram ao reiniciar; réplicas = 1 | Ler `rate-limit.ts` | ⚠️ implementado e documentado como limitação; aceite formal ausente | responsável (aceitar) | `src/lib/rate-limit.ts:2-25`; `src/lib/api-limits.ts:10-11`; `onda6c-checklist-producao.md:28` |
| P-24 | **CSP** imposta (hoje só Report-Only com `'unsafe-inline'`) | Cabeçalho `Content-Security-Policy` efetivo, ou aceite de risco | `curl -sI https://HOST/login \| grep -i content-security` | ⚠️ apenas `Content-Security-Policy-Report-Only` (não bloqueia) | técnico | `next.config.ts:24-28` |
| P-25 | Aplicação do `stack.yml` validada e pré-requisitos do host | `docker stack config` sem erro; diretórios `/srv/gmn/*` com dono/modo corretos; placement no nó certo | `docker stack config -c stack.yml`; `stat -c '%u:%g %a' /srv/gmn/*` | ❓ | responsável | `deploy/hostinger/stack.yml`; `tests/deploy-config.test.ts` |
| P-26 | Plano de rollback da plataforma (imagem anterior guardada com tag e digest) | Tag/digest anterior anotados; `PLANO-DE-ROLLBACK.md` revisado | Ler plano; `docker image ls` | ⚠️ plano escrito, nunca ensaiado | responsável | `deploy/hostinger/PLANO-DE-ROLLBACK.md`; `stack.yml:88-96` |
| P-27 | Estratégia de atualização do web coerente com o rollback | Decisão registrada sobre `start-first` × `stop-first` | Ler `update_config` | ⚠️ web usa `order: start-first` (duas réplicas gravando por instantes); o checklist da Fase 6 exige `stop-first` **para a Lumos** (R6-09). Para a Entrega 1 (sem escrita Lumos) é aceitável, mas deve ser **mudado antes da Entrega 2** | técnico | `deploy/hostinger/stack.yml:88` (web) vs `:94` (rollback) e `:183` (worker); `onda6c-checklist-producao.md:16,97` |

### 1.E Documentação de segurança e correções em andamento

| ID | Critério | Evidência exigida | Como verificar | Estado | Dono | Fonte |
|---|---|---|---|---|---|---|
| P-28 | **Modelos de ameaça (STRIDE)** da plataforma (rotas públicas, Worker, Serper, Supabase, PDFs) | `docs/security/threats/<feature>.md` por superfície | `ls docs/security/threats` | ❌ só existe `_template.md`; os únicos modelos de ameaça reais são da Fase 6 (`onda6c-modelo-de-ameacas-recuperacao.md`) e `docs/phase5/security-review.md` (revisão, não STRIDE) | técnico | `docs/security/threats/_template.md`; `docs/phase5/security-review.md` |
| P-29 | ADRs das decisões da plataforma | `docs/adr/` com decisões de deploy, Redis, RLS | `ls docs/adr` | ❌ só `0001` e template | técnico | `docs/adr/` |
| P-30 | **FIFO no download de PDF** (`src/lib/pdf/serve.ts`) | Leitura com `O_NONBLOCK`/`O_NOFOLLOW` + `fstat().isFile()` e teste que prove recusa de FIFO | Ler `serve.ts`; teste correspondente em `tests/` | ⚠️ **corrigido em 07/11/2026 na branch `chore/saneamento-tecnico` (Draft PR; ainda não mergeado)**: `readRegularPdf` em `src/lib/pdf/serve.ts` abre com `O_NONBLOCK`/`O_NOFOLLOW`, confere `fstat().isFile()` e o teto `MAX_PDF_BYTES` no descritor aberto, e recusa FIFO, diretório, dispositivo e link simbólico final (WARN estruturado `PDF_NOT_REGULAR_FILE`/`PDF_TOO_LARGE`, sem caminho). Teste de regressão: `tests/pdf-serve-special-files.test.ts` (registrado no script `test`). Só vira ✅ com a suíte verde no CI e o merge. **Limite conhecido:** `O_NOFOLLOW` protege só o último componente; link simbólico em pasta intermediária ainda é seguido (baixo: exige escrita na pasta de PDFs e no banco) | técnico | `src/lib/pdf/serve.ts` (`readRegularPdf`); `tests/pdf-serve-special-files.test.ts`; `docs/security/threats/plataforma-download-de-pdf.md` |
| P-31 | **Contraste (acessibilidade)** do dashboard | Tokens `primary-strong`, `muted/60`, anéis de foco; razão ≥ 4,5:1; comparação visual | `git diff --stat`; teste `link-audit-contrast` cobre só a Lumos | ⚠️ **corrigido em 07/11/2026 na branch `chore/saneamento-tecnico` (Draft PR; não mergeado)**: tokens `primary-strong` e `danger-strong`, `muted/80`, anéis de foco e `focus-visible` (contorno de 2px + borda `accent`) nos inputs do login (`login/page.tsx`, `audit-panel`, `leads-table`, `sidebar`, `top-filters`, `metric-card`, `tailwind.config.ts`); testes `tests/dashboard-contrast.test.ts`; conferido por teclado e medido num Chrome 157 real (headless, só a tela de login). **Não verificado em navegador:** o botão "Tentar novamente" (exige auditoria falha com sessão); sem leitor de tela real e sem outros navegadores | técnico | `git status`; `NOTES.md:93-94`; `tests/link-audit-contrast.test.ts` |
| P-32 | Vulnerabilidades e segredos no repositório | gitleaks verde; alertas do Dependabot e secret scanning tratados | `gh api repos/OWNER/REPO/dependabot/alerts` e `.../secret-scanning/alerts` (GET) | ❓ gitleaks no CI ✅; alertas do GitHub não consultados | responsável | `ci.yml:53-64` |
| P-33 | `SECURITY.md` real | Contato de divulgação preenchido | ler o arquivo | ❌ é template ("Template file") | responsável | `SECURITY.md:1-5` |

### 1.F Critério-chave da Entrega 1: Auditoria por Link desligada, segura e inoperante

| ID | Critério | Evidência exigida | Como verificar | Estado | Dono | Fonte |
|---|---|---|---|---|---|---|
| P-LA | **O deploy da plataforma SEM as variáveis da Fase 6 é seguro e inoperante para a auditoria por link** | (a) Nenhuma variável `GMN_LINK_AUDIT_*` no ambiente de produção; (b) rotas de decisão/pontuação respondem 503 (`DECISIONS_NOT_CONFIGURED`, `ANCHOR_NOT_CONFIGURED`, `EVIDENCE_NOT_CONFIGURED`, `RESULTS_NOT_CONFIGURED`, `LEDGER_NOT_CONFIGURED`, `ORIGIN_KEY_NOT_CONFIGURED`); (c) nenhuma gravação possível; (d) modo LIVE recusado sem `GMN_LINK_AUDIT_LIVE=on` | Código: ler `scoring/shared.ts` e `decisions/shared.ts`. Ambiente: `docker service inspect gmn_gmn-web --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'` e procurar nomes `GMN_LINK_AUDIT_` (não imprimir valores); `curl` autenticado nas rotas (somente GET) esperando 503 | ✅ falha fechada comprovada no código e por testes (`link-audit-scoring-results-api`, "sem pasta de resultados"); ⚠️ **não exercitada em produção**; **atenção:** `stack.yml` **já define** `GMN_LINK_AUDIT_EVIDENCE_DIR=/data/evidence` e monta `/srv/gmn/evidence` e `/srv/gmn/link-audits` — a **leitura** de evidências (rota `evidence`) fica ativa e as demais rotas respondem 503. Para "totalmente desligada", remover essas três linhas do `stack.yml` na Entrega 1 ou registrar aceite de que só a consulta de evidências fica ligada. Nenhuma das chaves (`ORIGIN_KEY`, `LEDGER_KEY`) está no `stack.yml`/entrypoint, logo as escritas são impossíveis | técnico + responsável | `docs/phase6-auditoria-link/onda6c-checklist-producao.md:38-55`; `src/app/api/link-audit/scoring/shared.ts:78-88,161-163`; `src/app/api/link-audit/decisions/shared.ts:90`; `src/lib/link-audit-decisions/service.ts:72,114,157`; `src/lib/link-audit-runtime/config.ts:16,36`; `deploy/hostinger/stack.yml:26,40-46` |
| P-LB | Menu/telas da Lumos não induzem o uso | Tela diz o motivo do 503; time instruído | Navegação manual | ❓ | responsável | `onda6c-checklist-producao.md` §9 |

---

## Seção 2 — Auditoria Lumos (Entrega 2)

Premissa: nada da Seção 2 foi implantado. `stack.yml` e `docker-entrypoint.sh` **não** foram alterados para a Fase 6 (só `GMN_LINK_AUDIT_EVIDENCE_DIR`). Não implantar sem fechar os itens ❌ marcados como **bloqueador**.

| ID | Critério | Evidência exigida | Como verificar | Estado | Dono | Fonte |
|---|---|---|---|---|---|---|
| L-01 | **Guarda externa imutável** (testemunha WORM/terceiro em domínio de falha separado da VPS) — **BLOQUEADOR** | Provedor contratado, adaptador real implementado, contrato R6-10 atendido (`head:null` só com `ledgerSeq ≤ 1`, atraso limitado etc.), teste de rollback coordenado detectado | Ler `guard.ts` e `ledger-wiring.ts`; teste `link-audit-ledger-guard` | ❌ só a **porta** `ExternalGuardPort` e o adaptador **sintético** (`createSyntheticGuard`); `ledgerForRoutes` **não injeta guarda alguma**; estado `externalGuard: NOT_CONFIGURED`; nenhum provedor escolhido | responsável (provedor) + técnico | `src/lib/link-audit-ledger/guard.ts:12,25`; `src/app/api/link-audit/decisions/ledger-wiring.ts:6-8,22-26`; `onda6c-checklist-producao.md` (Q6, R6-10) |
| L-02 | **Produtor P1** (atestação offline da coleta com manifesto Ed25519) — **BLOQUEADOR da finalização** | Produtor implementado e revisado; titular/suplente da custódia definidos; chave privada fora da VPS; ao menos uma coleta atestada ponta a ponta | Tentar finalizar em ambiente de teste (hoje deve falhar) | ❌ contrato **proposto, nada implementado**; verificador existe. Sem produtor, a finalização responde `NOT_FINALIZABLE` (bloqueio `EVIDENCE_PROVENANCE_UNPROVEN`) por desenho | responsável (custódia) + técnico | `onda6c-contrato-p1-atestacao.md:1-30`; `src/lib/link-audit-scoring-runs/results.ts:37,61,464,492`; `src/lib/link-audit-evidence/provenance.ts` |
| L-03 | **Papel administrativo com dupla aprovação** — **BLOQUEADOR** | Identidade administrativa verificável distinta de `GMN_OPERATOR_EMAILS`, dupla aprovação, auditável; `ADOPT`/`RESTORE_ACK`/`QUARANTINE_ACK` deixam de responder 403 | `POST /api/link-audit/decisions/{id}/ledger` com essas ações (ambiente de teste) → hoje 403 `ADMIN_APPROVAL_UNAVAILABLE` | ❌ ausente; as três operações respondem **403** (confirmado no código). Auditoria que cair em `HISTORY_UNRESOLVED` não tem reabertura pela aplicação | técnico + responsável | `src/app/api/link-audit/decisions/[auditId]/ledger/route.ts:11`; `src/lib/link-audit-decisions/service.ts:77,119,162,969-984`; `onda6c-checklist-producao.md` (Q5, R6-13) |
| L-04 | **Volumes e chaves no `stack.yml` e no entrypoint** | `stack.yml` com os 5 binds graváveis + volume de manifestos (somente leitura); entrypoint lendo por `*_FILE` as chaves `ORIGIN_KEY` e `LEDGER_KEY`; variáveis `GMN_LINK_AUDIT_*` completas no serviço web; Worker **sem** montar nenhuma | `grep -n GMN_LINK_AUDIT deploy/hostinger/stack.yml deploy/hostinger/docker-entrypoint.sh` | ❌ hoje só `GMN_LINK_AUDIT_EVIDENCE_DIR` (`stack.yml:26`); a lista fixa do entrypoint tem só 4 segredos (service role, anon, Serper, Redis); faltam `*_DECISIONS_DIR`, `*_DECISIONS_ANCHOR_DIR`, `*_RESULTS_DIR`, `*_RESULTS_ANCHOR_DIR`, `*_DECISIONS_LEDGER_DIR`, `*_EVIDENCE_SEALS_DIR`, `*_EVIDENCE_TRUST_KEYS`, `*_ORIGIN_KEY`, `*_LEDGER_KEY` | técnico | `deploy/hostinger/stack.yml:26,40-46`; `deploy/hostinger/docker-entrypoint.sh:14`; `onda6c-checklist-producao.md:38-55`; `deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md` |
| L-05 | **Rollback / stop-first (R6-09)**: depois do primeiro `ENROLL` não se volta à imagem anterior ao livro; sem réplica antiga sobreposta | `update_config.order: stop-first` no web; `PLANO-DE-ROLLBACK.md` tratando o livro; rollback ensaiado | `grep -n order deploy/hostinger/stack.yml` | ❌ web em `start-first` (linha 88); plano de rollback não menciona o livro; testes de rollback "não executados" | técnico | `deploy/hostinger/stack.yml:88,94`; `onda6c-checklist-producao.md:16,29,97`; `deploy/hostinger/PLANO-DE-ROLLBACK.md` |
| L-06 | **Ensaio de queda de energia** no sistema de arquivos escolhido (ext4/xfs; **não** drvfs/NTFS/NFS/SMB) | Relatório do ensaio com `fsync` de diretório; filesystem registrado | `df -T /srv/gmn/*` (leitura); ensaio em homologação | ❌ não feito; P-4 (`fsync` de diretório best-effort em resultados/recibos/evidências) sem aceite | responsável + técnico | `onda6c-checklist-producao.md:17,156`; `onda6c-riscos-p1-p4.md` (P-4) |
| L-07 | **Rotação de chaves** (origem, livro, atestação) | Runbook aplicado e ensaiado: planejada × por comprometimento; CHECKPOINT antes do vencimento da chave aposentada do livro | Ler runbook; ensaio em ambiente de teste | ⚠️ runbook escrito (§2 planejada, §3 comprometimento, §4 atestação, §7 livro); sem ensaio em produção | técnico + responsável | `onda6c-runbook-chaves.md:23,33,44,67`; `src/lib/link-audit-ledger/config.ts:10` |
| L-08 | **Backup independente de 5–6 volumes** (decisões, recibos de decisões, resultados, recibos de resultados, livro, + manifestos) em disco/domínio diferente de cada dado que ancoram | Destino por volume, rotina agendada, restore testado | `docker volume ls`; `stat` dos diretórios; verificar destino de backup | ❌ "ainda não definido nem ensaiado"; o plano de backup vigente cobre só `evidence`, `link-audits`, `audits`, `redis` | responsável | `onda6c-checklist-producao.md:28`; `deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:3-12` |
| L-09 | **Capacidade do livro** (`MAX_LEDGER_RECORDS = 4000`) com monitoramento e plano de renovação | Alerta de ocupação; procedimento de CHECKPOINT/renovação | Estado do livro via API `GET .../ledger` (somente leitura) | ⚠️ política de capacidade implementada e testada (`link-audit-ledger-capacity*`); sem monitoramento externo | técnico | `src/lib/link-audit-ledger/types.ts:15`; `src/lib/link-audit-ledger/model.ts:219-225` |
| L-10 | **P-1 a P-4** com decisão formal do responsável | Cada risco aceito/corrigido por escrito | Ler `onda6c-riscos-p1-p4.md` | ⚠️ análise pronta; **nenhum aceito nem corrigido** | responsável | `docs/phase6-auditoria-link/onda6c-riscos-p1-p4.md` |
| L-11 | **Aprovação formal e encerramento da Onda 6C** | Commit de homologação I6, checkpoint I7 e revisão independente aprovados; tag aponta para commit conhecido | `git log`; NOTES.md | ❌ "Onda 6C NÃO encerrada"; remediações (origem, proveniência, livro) já commitadas (`8412d02`, `f3168e7`, `f7c98ee`, `7db92d8`; o NOTES.md traz os registros históricos "sem commit") | responsável | `NOTES.md:94-96`; `onda6c-checklist-producao.md:32-36` |
| L-12 | **Revisão adversarial independente final** sobre o código atual | Relatório de revisor independente com "APROVADO" | Ler `onda6c-revisao-adversarial-*.md` | ❌ 1ª revisão BLOQUEADA; a 2ª "aprovado com ressalvas"; as rodadas seguintes são reexames do próprio projeto; falta revisão **final independente** sobre livro/guarda | responsável | `NOTES.md:94-96`; `onda6c-revisao-adversarial-seguranca.md` |
| L-13 | **D5 — cobertura Lumos** | Coleta que eleve a cobertura acima do mínimo de 40% | Rodar auditoria sintética e ler o resultado | ❌ não autorizada; **sem D5 toda auditoria real sai INCONCLUSIVA** (cobertura 11% automática, teto 17% com UTM + decisão humana, abaixo de 40%); resultado `PONTUADO` só existe com fixture | responsável (autorizar) | `onda6c-checklist-producao.md:29,36,107-108` |
| L-14 | **D4 / Onda 7 (PDF Lumos)** | Escopo autorizado | — | ❌ não autorizadas | responsável | `onda6c-checklist-producao.md:125`; `NOTES.md:94` |
| L-15 | Janela sem testemunha para auditorias **legadas** | Política do legado real definida | — | ⚠️ legado fica `LEGACY_READ_ONLY` sem adoção administrativa (depende de L-03) | responsável | `onda6c-checklist-producao.md` (livro de cabeças) |
| L-16 | Monitoramento de integridade e armazenamento da Lumos; recuperação de pendências | Alertas de `TRUNCATED`/`HISTORY_REGRESSED`/espaço | — | ❌ inexistente | técnico + responsável | `onda6c-checklist-producao.md:30` |
| L-17 | Chave de origem (`GMN_LINK_AUDIT_ORIGIN_KEY`) e do livro **distintas** e fora de dados/imagem/log | Dois segredos distintos em cofre separado | Código recusa chaves iguais | ✅ validação no código; ⚠️ segredos não criados | responsável | `src/lib/link-audit-ledger/config.ts:10-16`; `onda6c-checklist-producao.md` (chave do livro) |

---

## Ordem recomendada

**Entrega 1 (Plataforma, Lumos desligada)**

1. Fechar a árvore local: concluir e commitar (com autorização) a correção de contraste (P-31); decidir sobre o FIFO (P-30); corrigir NOTES/checklist desatualizados.
2. Decidir P-LA: remover `GMN_LINK_AUDIT_EVIDENCE_DIR` e os binds `evidence`/`link-audits` do `stack.yml` ou aceitar a leitura de evidências ligada.
3. Higiene de CI e dependências: `dependabot.yml` real (P-13), `npm audit` atualizado (P-15), lint e Trivy (P-11, P-12), cobertura (P-16).
4. Criar o pipeline de release **somente CI** (build Docker, registry privado, digest, deploy por workflow) e **abolir** o `scp`/`docker load` do guia (P-09, P-14).
5. Banco: auditoria real de RLS novamente (somente leitura), aplicar G5 com autorização, repetir `rls:probe`, `db:check`, `validate:recovery` (P-01..P-04).
6. Infra: confirmar secrets, Redis exclusivo, TLS/IP real (`shared:false`), backup e restore, monitoramento, rotação (P-06, P-18..P-22).
7. Homologação real G6 (49 consultas Serper) com autorização por escrito (P-07).
8. Liberar o Worker (`GMN_WORKER_REPLICAS=1`) e acompanhar.

**Entrega 2 (Lumos), só depois**

1. Aprovações de escopo e custódia: titular/suplente P1, provedor da guarda externa, papel administrativo (L-01..L-03).
2. Implementar o que falta: produtor P1, adaptador de guarda real, papel administrativo; `stack.yml`/entrypoint com volumes e chaves, web `stop-first` (L-04, L-05).
3. Infra Lumos: filesystem ext4/xfs, ensaio de queda de energia, backup independente dos 5–6 volumes, monitoramento (L-06, L-08, L-09, L-16).
4. Decidir P-1..P-4, ensaiar rotação de chaves e rollback (L-05, L-07, L-10).
5. Revisão adversarial independente final, aprovação formal e encerramento da 6C (L-11, L-12).
6. D5 (cobertura) só então; sem ela toda auditoria real sai INCONCLUSIVA (L-13). D4/Onda 7 por último (L-14).

## Fora de escopo desta matriz

- Executar qualquer comando, deploy, `docker`, `gh`, consulta Supabase/Redis/VPS, ou gastar consultas Serper.
- Alterar código (`src/`, `tests/`), `scoring/`, contratos normativos ou documentos existentes; corrigir as contradições listadas abaixo.
- Commits, pull requests, tags, publicação de imagem.
- Funcionalidades novas da plataforma (mapa-base MBTiles, revisão jurídica das atribuições do mapa: R10 e item do checklist da Fase 5 seguem como estão).
- Migração para Tailwind 4/Next 16 (projetos separados, ver `dependency-audit.md`).
- Atestação de que a produção atual está no estado descrito: os itens ❓ dependem de acesso autorizado.

## Contradições entre documentos e código encontradas (não corrigidas)

1. `CLAUDE.md` e a tarefa dizem "deploy somente por CI", mas `GUIA-DE-IMPLANTACAO.md` e `build-images.sh` prescrevem `docker save` + `scp` + `docker load` manual.
2. `ci.yml` **tem** job `build` (`npm run build`), mas nenhum build de imagem Docker nem deploy.
3. `dependency-audit.md` trata o override de `postcss` do `next` como "opção B não executada"; `package.json` já tem `overrides.next.postcss = 8.5.30`.
4. `NOTES.md`/`onda6c-checklist-producao.md` listam FIFO em `src/lib/pdf/serve.ts` como pendência. **Resolvida nesta branch (07/11/2026; Draft PR, não mergeado)** por `readRegularPdf` + `tests/pdf-serve-special-files.test.ts`; a observação anterior de que o arquivo "já continha" a leitura segura veio de uma leitura feita durante a edição.
5. `stack.yml` mantém web em `start-first`; o checklist da Fase 6 (R6-09) exige `stop-first` para o web antes da Lumos.
6. `stack.yml` já injeta `GMN_LINK_AUDIT_EVIDENCE_DIR`, o que contradiz a descrição "sem as variáveis `GMN_LINK_AUDIT_*`" (a leitura de evidências fica ativa).
7. `homologation-plan.md` e `operations-runbook.md` falam em Redis Upstash e `.env.local`; a produção usa `gmn-redis` na stack (documentos da Fase 5 anteriores ao `deploy/hostinger/`). `operations-runbook.md` ainda diz que `public/audits/` é público, mas o G4 o esvaziou.
8. `dependabot.yml` lista ecossistemas inexistentes e `docker` com diretório `/`, onde não há Dockerfile.
9. `SECURITY.md` é template ("Template file").
10. `.claude/rules/testing.md` e `git-workflow.md` ainda têm `[CUSTOMIZE]`; o projeto usa `node --test` com lista explícita em `package.json`.
