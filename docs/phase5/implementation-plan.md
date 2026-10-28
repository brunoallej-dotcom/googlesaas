# Fase 5: plano de implementação (executado)

Atualizado em 16/10/2026. Processo: analisar → planejar → implementar → testar → corrigir → revisar → documentar, em ondas sequenciais. Restrições mantidas: sem SaaS, sem novos serviços pagos, sem DataForSEO/GBP, sem migration, sem consulta paga, `.env.local` intocado, nada histórico apagado/movido/sobrescrito.

| Onda | Entrega | Estado |
|---|---|---|
| 5.0 Diagnóstico | `technical-audit.md`, `risk-register.md`, `.gitignore`, sondas somente leitura | Concluída |
| 5.1 Segurança | Login Supabase + allowlist, sessão assinada, middleware + guarda por rota, anti-CSRF, limites, erros seguros, redação de segredos, cabeçalhos | Concluída (ações do usuário pendentes) |
| 5.2 Maestro/Worker | Trava Redis, 409 por empresa+palavra-chave, `claimAudit` CAS, sem regressão de estado, `maxStalledCount: 0`, falha persistida, heartbeat, estado Interrompida derivado, retomada sem consultas | Concluída |
| 5.3 Persistência/histórico | `/api/campaigns`, seletor "Campanhas salvas", "Resultado histórico recuperado", `db:check` | Concluída |
| 5.4 Battlefield/mapas | 49 pontos preservados; `MbtilesProvider` + contingência; guia | Código concluído; **extrato real BLOQUEADO** (Java/download) |
| 5.5 PDFs | `.data/audits` privada, nome versionado sem sobrescrever, rota autenticada única, validação de caminho, recomposição do banco, plano de migração (dry-run) | Concluída para PDFs novos; **históricos PENDENTES** |
| 5.6 Monitoramento | `/api/system/health`, indicador no cabeçalho, logs estruturados com redação, estados na UI | Concluída |
| 5.7 Homologação/docs | 326 testes, typecheck, build, validação HTTP real, runbook, checklist, relatório | Concluída (teste operacional real **PENDENTE de autorização**) |

## Decisões do usuário incorporadas
1. Autenticação por **Supabase Auth + lista de e-mails**.
2. PDFs novos em **pasta privada com rota autenticada**; históricos não são movidos/apagados; plano de migração e bucket privado para depois; filesystem local não é armazenamento definitivo (recomposição do banco + bucket privado opcional); validação de que não autenticados não acessam, mesmo com a URL.

## Decisões de projeto
- Estado "Interrompida" **derivado** (sem alterar o enum): evita migration.
- Chave de sessão derivada de segredo existente: evita nova variável secreta.
- Retomada **somente por ação explícita** do operador.
- Limitadores em memória: suficientes para instância única.
