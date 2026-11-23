# Índice dos modelos de ameaças (STRIDE)

> Rascunhos de 2026-11-07 (branch `chore/saneamento-tecnico`), feitos a partir do código. Modelo para novos documentos: [`_template.md`](_template.md). Status: **mitigado** (código + teste) · **parcial** (lacuna conhecida) · **aberto** (sem mitigação no código). "NÃO VERIFICADO" = depende da VPS/Supabase, que não foram inspecionados.

## Documentos

| Documento | Componente | Relação com documentos já existentes |
|---|---|---|
| [`link-audit-coleta-e-provedores.md`](link-audit-coleta-e-provedores.md) | Coleta LIVE (Serper `/maps`, site próprio), SSRF, custo, autorização de uso único, redação da chave | Novo |
| [`link-audit-evidencias-e-selos.md`](link-audit-evidencias-e-selos.md) | Evidências imutáveis, manifestos Ed25519, leitor endurecido, API de evidências | Complementa ADR 6C-03 e o modelo da recuperação (itens 13–16) |
| [`link-audit-decisoes-e-recibos.md`](link-audit-decisoes-e-recibos.md) | Decisões humanas 6B, recibos/âncoras, testemunha, chaves de origem e do livro | Complementa ADR da âncora, ADR 6C-02 e o runbook de chaves |
| [`link-audit-ledger-e-resultados.md`](link-audit-ledger-e-resultados.md) | Livro de cabeças, finalização, resultados selados — **só lacunas** | Remete ao modelo da recuperação, que é a referência principal |
| [`link-audit-api-e-interface.md`](link-audit-api-e-interface.md) | Rotas `/api/link-audit/*`, sessão, CSRF, limitadores, zod, CSP, páginas | Complementa `docs/phase5/security-review.md` |
| [`plataforma-download-de-pdf.md`](plataforma-download-de-pdf.md) | `GET /api/audit/[id]/pdf`, `serve.ts`, bucket privado | Detalha R2-INFO-3 (FIFO; corrigido no PR #12, mergeado em 16/11/2026) |
| [`link-audit-p1-atestacao.md`](link-audit-p1-atestacao.md) | Produtor P1 (atestação offline da coleta, manifesto Ed25519, custódia da chave) — 18 ameaças, requisitos RS-01..RS-21 | Novo (16/11/2026); requisitos rastreados em `docs/specs/link-audit-p1-attestation.md` §16 |
| [`link-audit-portoes-producao.md`](link-audit-portoes-producao.md) | Portões de produção: guarda externa no Supabase (sequência falsa, `latest` mentiroso, dono do projeto, indisponibilidade, configuração, pseudônimo, falso `GUARD_LAGGING`, reconciliação), caminho administrativo em 403, logs exportados, backups, homologação — 17 ameaças PP-xx | Novo (20/11/2026, onda G0); ameaças da §8 de `docs/specs/link-audit-production-gates.md`; ADR-0003 |
| [`deploy-pelo-ci.md`](deploy-pelo-ci.md) | Deploy pelo CI (P-9) e entrega dos manifestos selados: workflow `deploy.yml` e job `seals`, GitHub Environments, chaves SSH restritas a receptores de comando único, receptores de deploy e de manifestos, caminho `link-audit-seals/` e lista de confiança versionada, logs públicos, pilha de homologação — 22 ameaças DC-xx | Novo (23/11/2026, fatia P9.1); spec `docs/specs/ci-deploy-and-seal-delivery.md`; ADR-0004 |

Modelo pré-existente e normativo para a recuperação de pendências e a fronteira de evidências: [`docs/phase6-auditoria-link/onda6c-modelo-de-ameacas-recuperacao.md`](../../phase6-auditoria-link/onda6c-modelo-de-ameacas-recuperacao.md).

## Maiores riscos residuais (visão consolidada)

| # | Risco | Documento | Status |
|---|---|---|---|
| 1 | Rollback coordenado de decisões + recibos + livro **não é detectado**: não existe guarda externa (só adaptador sintético de teste) | ledger-e-resultados (L-T2) | aberto — bloqueador de produção declarado; provedor decidido em 20/11/2026 (Supabase, ADR-0003), implementação na onda G1.b; ameaças da guarda em portoes-producao |
| 2 | Auditoria congelada (`HISTORY_UNRESOLVED`/`UNTRUSTED`/`EXHAUSTED`/incidente de chave) sem reabertura: papel administrativo com dupla aprovação não existe | ledger-e-resultados (L-D2) | aberto — bloqueador declarado; para o piloto, 403 mantido e risco aceito (D-G0-6, portoes-producao PP-E2) |
| 3 | Rotas da Fase 6 sem nenhum log estruturado; erros 500 engolidos sem registro | api-e-interface (A-R1), decisões (D-R1) | aberto — spec de correção em `docs/specs/link-audit-observability.md` (16/11/2026) |
| 4 | FIFO na pasta de PDF compartilhada com o Worker trava o pool de I/O do web | download-de-pdf (P-D1) | mitigado (PR #12, mergeado em 16/11/2026) |
| 5 | Nenhuma evidência é autêntica até existir o produtor P1; finalização fechada por desenho (disponibilidade) e telas de evidências mostram só a integridade | evidências-e-selos (E-S1, E-T1) | aberto (dependência P1) |
| 6 | Chave de deploy do CI no grupo `docker` equivale a root no host compartilhado; uma stack vinda do CI montaria o `/` | deploy-pelo-ci (DC-02) | aberto — no desenho, a stack é instalada pelo responsável e conferida por hash, e o receptor tem gramática fechada (P9.3a, P9.4); a chave vazada fica limitada à aplicação (DC-01) |

## Ações transversais

- Log estruturado + envio para fora da VPS (A-C1, A-D1, A-A1).
- Decidir formalmente o aceite da ausência de ACL por auditoria/autor (E-I2, D-E1, P-S1).
- Conferir na VPS os itens marcados "NÃO VERIFICADO" (cabeçalhos efetivos, entrega de chaves por `*_FILE`, permissões dos volumes, RLS/R13) durante a homologação, sem deploy local.
