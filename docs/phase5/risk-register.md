# Fase 5: registro de riscos

Legenda de estado: **MITIGADO** (código + testes), **RESIDUAL** (aceito até ação do usuário), **ABERTO** (precisa de decisão).

| ID | Risco | Probabilidade × Impacto | Estado | Mitigação / ação |
|---|---|---|---|---|
| R1 | Uso não autorizado das rotas (gasto de créditos, vazamento) | Alta × Alta | MITIGADO após 5.1 | Login por Supabase Auth + allowlist, sessão assinada, middleware e guarda por rota; falha fechada |
| R2 | Cadastro público do Supabase ligado | Média × Média | **FECHADO** (16/10/2026) | Desligado pelo usuário e conferido (`disable_signup: true`, 1 usuário) |
| R3 | PDFs históricos expostos | Média × Alta | **FECHADO** (G1–G4, 16–17/10/2026) | Bucket antigo privado (links → 400), cópias privadas verificadas, originais removidos de `public/audits/` (estático: 401/404) |
| R4 | Auditoria duplicada por clique duplo / reenvio | Alta × Alta (custo) | MITIGADO após 5.2 | Trava Redis, 409 com auditoria existente, `claimAudit`, `force` explícito |
| R5 | Job travado refaz consultas pagas | Média × Alta | MITIGADO após 5.2 | `maxStalledCount: 0`; `failed` persiste estado; retomada reaproveita payloads |
| R6 | Worker/Redis fora do ar sem aviso | Média × Média | MITIGADO após 5.2/5.6 | Heartbeat, estado `INTERRUPTED`, `health` |
| R7 | Perda de PDF por falha de disco | Baixa × Média | MITIGADO | PDF é derivado do banco: regeneração sem custo; cópia em bucket **privado** opcional |
| R8 | Avisos do `npm audit` | Baixa × Baixa | RESIDUAL | Toolchain de build; sem upgrade major automático |
| R9 | Projeto sem controle de versão | Média × Média | **ABERTO (decisão do usuário)** | `.gitignore` criado; `git init` não executado |
| R10 | Mapa-base fora de Anápolis/Goiânia | Alta × Baixa | **BLOQUEADO (pendência)** | `MbtilesProvider` pronto; gerar o extrato exige Java e download de ~1 a 2 GB |
| R11 | Homologação real (Worker + Redis + Supabase + Serper) | — | **PENDENTE (autorização)** | Proposta documentada em `release-checklist.md` |
| R12 | Sessão: chave derivada da `SUPABASE_SERVICE_ROLE_KEY` | Baixa × Média | RESIDUAL | Girar a chave invalida as sessões (aceitável); chave nunca sai do servidor |
| R13 | RLS é a única barreira: anon tem SELECT/UPDATE/DELETE nas 5 tabelas (sonda real) | Baixa × Alta | **ABERTO** | `supabase/audit/rls-audit.sql` + `supabase/proposed/003_rls_hardening.sql` (G5) |
| R14 | Papel `authenticated` não testado | Baixa × Média | **PENDENTE** | `npm run rls:probe -- --authenticated` |
| R15 | Retomar auditoria sem dados refazia 49 consultas pagas | Média × Alta | **MITIGADO** (16/10) | Só com Battlefield gravado; 409 `NOTHING_TO_RESUME` |
| R16 | Mesma empresa auditada por leads de campanhas diferentes | Média × Alta | **MITIGADO** (16/10) | Trava e consulta por `place_id` |
| R17 | `Referrer-Policy: no-referrer` bloqueava tiles do OSM | Alta × Médio | **MITIGADO** (16/10) | `strict-origin-when-cross-origin` + teste |
| R18 | Duas versões do PDF da 859b4021 (bucket antigo × oficial local) | — | **MITIGADO** | Inventário aponta; migração preserva as duas |
