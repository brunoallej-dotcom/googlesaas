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
| [`plataforma-download-de-pdf.md`](plataforma-download-de-pdf.md) | `GET /api/audit/[id]/pdf`, `serve.ts`, bucket privado | Detalha R2-INFO-3 (FIFO; corrigido na branch, Draft PR) |

Modelo pré-existente e normativo para a recuperação de pendências e a fronteira de evidências: [`docs/phase6-auditoria-link/onda6c-modelo-de-ameacas-recuperacao.md`](../../phase6-auditoria-link/onda6c-modelo-de-ameacas-recuperacao.md).

## Maiores riscos residuais (visão consolidada)

| # | Risco | Documento | Status |
|---|---|---|---|
| 1 | Rollback coordenado de decisões + recibos + livro **não é detectado**: não existe guarda externa (só adaptador sintético de teste) | ledger-e-resultados (L-T2) | aberto — bloqueador de produção declarado |
| 2 | Auditoria congelada (`HISTORY_UNRESOLVED`/`UNTRUSTED`/`EXHAUSTED`/incidente de chave) sem reabertura: papel administrativo com dupla aprovação não existe | ledger-e-resultados (L-D2) | aberto — bloqueador declarado |
| 3 | Rotas da Fase 6 sem nenhum log estruturado; erros 500 engolidos sem registro | api-e-interface (A-R1), decisões (D-R1) | aberto |
| 4 | FIFO na pasta de PDF compartilhada com o Worker trava o pool de I/O do web | download-de-pdf (P-D1) | corrigido na branch (Draft PR; não mergeado) |
| 5 | Nenhuma evidência é autêntica até existir o produtor P1; finalização fechada por desenho (disponibilidade) e telas de evidências mostram só a integridade | evidências-e-selos (E-S1, E-T1) | aberto (dependência P1) |

## Ações transversais

- Log estruturado + envio para fora da VPS (A-C1, A-D1, A-A1).
- Decidir formalmente o aceite da ausência de ACL por auditoria/autor (E-I2, D-E1, P-S1).
- Conferir na VPS os itens marcados "NÃO VERIFICADO" (cabeçalhos efetivos, entrega de chaves por `*_FILE`, permissões dos volumes, RLS/R13) durante a homologação, sem deploy local.
