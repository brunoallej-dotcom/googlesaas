# G5 (RLS) — relatório S0 de 07/11/2026: diferenças e origem da mudança

> ## Situação do G5: **IMPLEMENTAÇÃO APARENTE, PENDENTE DE HOMOLOGAÇÃO FUNCIONAL**
> A estrutura do banco em 07/11/2026 corresponde, item a item, ao efeito da `003_rls_hardening.sql`. Isso é uma prova **estrutural**. **Não conhecemos o SQL exato que foi executado** e **nenhum acesso real foi reconfirmado hoje**; a homologação funcional é tratada à parte (seção 4). Não declarar o G5 concluído até lá.

## Evidência e limites
- Evidência: `docs/phase5/evidence/rls-audit-2026-11-07.json` (28.621 bytes, `sha256` `3006111354a9a6b5d97f9f8ffcf9b631fa9ba785d2a45b7c930b0f5572217544`), cópia **byte a byte** do arquivo exportado pelo responsável; coletada em 2026-11-07T20:56:55Z, PostgreSQL 17.11 aarch64, usuário `postgres`. A auditoria de 17/10 (`rls-audit-2026-10-17.json`) não foi alterada.
- É o resultado da consulta `supabase/audit/rls-audit-json.sql` (uma única instrução SELECT; estrutura e contagens, sem dados nem e-mails). A comparação abaixo foi feita por diff estrutural seção a seção entre os dois arquivos.
- A prova é estrutural: mostra privilégios, políticas e padrões, **não** o comportamento HTTP real nem o funcionamento do app.

## 1. Diferenças 17/10 → 07/11 (diff completo; "inalterado" = idêntico nos dois arquivos)

| Seção | 17/10 | 07/11 | Leitura |
|---|---|---|---|
| Impressão digital | buckets `criado_em` 2026-10-15T15:43:13.881668Z e 2026-10-16T23:42:25.477441Z | idênticos | mesmo projeto |
| RLS nas 5 tabelas `public` | ligado, sem FORCE, dono `postgres` | idêntico | inalterado |
| **Políticas** | 0 | **5 × `gmn_deny_all`**: `RESTRICTIVE`, papéis `anon` e `authenticated`, comando `ALL`, `USING false`, `WITH CHECK false` | exatamente o que a `003` cria |
| **Privilégios de tabela** | `anon`, `authenticated`, `postgres`, `service_role` com os 8 (`arwdDxtm`); `PUBLIC` nenhum | `anon` e `authenticated` **removidos** das 5 tabelas; `postgres` e `service_role` mantêm os 8; `PUBLIC` nenhum | efeito do `revoke all ... from anon, authenticated, public` |
| **Privilégios efetivos** (7 × 5 tabelas) | `anon` 35/35, `authenticated` 35/35, `service_role` 35/35 | **0/35**, **0/35**, **35/35** | G5 aplicado na estrutura |
| Privilégios por coluna, sequências, views, Realtime | 0 | 0 | inalterado |
| Gatilhos / extensões / papéis / pertencimentos | 2 / 5 / `service_role` com `BYPASSRLS`, `anon` e `authenticated` sem / 9 | idênticos | inalterado |
| **Privilégios padrão de `postgres` em `public`** | tabelas, sequências e funções com `anon` e `authenticated` | `{postgres, service_role}` nas três (tabelas `arwdDxtm`, sequências `rwU`, funções `X`) | passo 3 da `003` **efetivo** (não caiu no tratamento de `insufficient_privilege`) |
| **Privilégios padrão de `supabase_admin` em `public`** | tabelas `arwdDxtm`, sequências `rwU`, funções `X` para `postgres`, `anon`, `authenticated`, `service_role` | **idênticos** | resíduo conhecido (seção 3) |
| Privilégios padrão em outros esquemas | 18 entradas (24 no total; 6 em `public`) | idênticas | só as 3 de `postgres`/`public` mudaram |
| **`trigger_set_updated_at`** | dono `postgres`, não `SECURITY DEFINER`; `EXECUTE`: `PUBLIC`, `postgres`, `anon`, `authenticated`, `service_role` | idêntico | a `003` não a altera (seção 3) |
| Storage: buckets | 2, ambos privados | idênticos | inalterado |
| Storage: objetos | `gmn-audit-pdfs` 3; `gmn-audit-pdfs-private` 4 | 3; **16** | **+12** no bucket privado (seção 3b) |
| Tabelas do esquema `storage` | 13 objetos listados em `public` e `storage` | +2 (`bucket_lifecycle_states`, `lifecycle_abandoned_artifacts`, dono `supabase_storage_admin`, RLS ligado) | atualização da plataforma Supabase, não é nossa |
| **Contas Auth** | 1 | **3** | **+2** (seção 3b) |

**Equivalência estrutural com a `003`:** toda diferença observada é efeito da `003` (5 políticas com o nome e os parâmetros exatos; `anon` e `authenticated` sem privilégios; padrões de `postgres` sem eles), e os itens que a `003` **omite de propósito** estão intactos (sem `FORCE`, `EXECUTE` da função, padrões de `supabase_admin`, esquema `storage`). Isso é coerente com a `003`, mas **não identifica o SQL executado nem quem o executou**.

## 2. Origem da mudança (investigação documental, sem presumir quem aplicou)

1. **17/10/2026 (`docs/phase5/rls-audit.md`, `NOTES.md`, memória do projeto):** auditoria real (0 políticas; 35/35); `rls:probe --authenticated` "executado por você" **antes** da migration: EXPOSTO 0, "só RLS" 30; `003` revisão 3 (pré-validação do projeto pelo bucket `gmn-audit-pdfs-private`), teste local 14/14; plano: o responsável cola a `003` no SQL Editor e depois se roda a homologação.
2. **17/10/2026 10:48:56 UTC (transcrição restaurada da sessão `c6a90949`, mensagem do papel `user`):** o texto **declara** que "a migration `003_rls_hardening.sql` foi executada no SQL Editor do projeto GMN", resultado "Success. No rows returned.", e pede a homologação pós-migration. **O SQL exato que foi colado não está registrado**; a transcrição guarda só a declaração e a resposta do editor.
3. **17/10/2026 10:48:59 a 10:51:18 UTC (mesma sessão):** o assistente executou parte da homologação (seção 2b). Às 10:51:18 a sessão foi cortada por "You've hit your weekly limit" e às 10:53:13 aparece `/rate-limit-options`. **Não chegaram a rodar:** `rls:probe` com o operador autenticado depois da migration, `g5:smoke`, `npm test`/`typecheck`/`build` e o relatório final.
4. **22 a 31/10/2026 (sessões `12d5e6e2`, `291f63a0`, `5a88b686`, `cda01505`):** repetem "RLS/G5 pendente" ao colar a lista de pendências do `NOTES.md`; nenhuma reverificou o banco.
5. **Documentos do repositório** (`NOTES.md:59`, `release-checklist.md:20`, `final-validation-report.md:40`, `risk-register.md` R13, `homologation-plan.md`): todos continuaram "PENDENTE/ABERTO"; **não foram atualizados depois do relato de 17/10** (nem neste commit; ver seção 4).
6. **Git:** nenhum commit registra a aplicação, coerente com o desenho (a `003` fica em `supabase/proposed/`; aplicação manual no SQL Editor). O único commit que toca esses arquivos é o baseline `ee093f0` (28/10).
7. **Nome da política:** `gmn_deny_all` só existe neste repositório na `003`, no rollback, no teste local e em `rls-audit.md`, **não** nas migrations `001`/`002`.
8. **Snapshots antes/depois:** `.data/migration/g1-snapshot-g5-antes-*.json` e `g1-snapshot-g5-depois-*.json` não constam nos backups restaurados; só `rls-audit.md` (números) e a transcrição de 17/10 os descrevem.

**Conclusão:** a hipótese mais consistente com todas as fontes é que a `003` foi executada em 17/10/2026, como o responsável declarou. A evidência é: (a) a declaração registrada, (b) a verificação feita nos minutos seguintes, (c) a equivalência estrutural de hoje. **Não prova** quem executou nem o SQL exato. Leituras no painel que fechariam a origem (somente leitura, a cargo do responsável): histórico do SQL Editor (consulta, data e conta) e, se ainda retidos, os logs do Postgres.

### 2b. Evidência pós-migration registrada na sessão de 17/10 (saída de ferramenta; tokens e IDs mascarados)

| Verificação (executada em 17/10, ~1 a 3 min depois do relato) | Resultado registrado |
|---|---|
| `npm run rls:probe` (anon, token forjado, `service_role`) | EXPOSTO 0; "só RLS como barreira" 0; inesperado 0; `service_role` sem acesso 0. `anon`: 15 × `BLOCKED_BY_PRIVILEGE` + 6 × `NOT_EXPOSED`; token forjado: 15 + 5; `service_role`: 15 × `SERVICE_ACCESS_OK`. HTTP 401 em SELECT/UPDATE/DELETE de `gmn_audits` |
| Snapshot `g5-antes` × `g5-depois` | **todas idênticas**: `prospecting_campaigns` 10, `gmn_leads` 80, `gmn_audits` 6, `gmn_battlefield_rounds` 3, `gmn_battlefield_points` 147; hashes dos 3 PDFs, dos 2 buckets e `public=false` iguais; nenhuma chave nova |
| `npm run db:check` | "Nenhum problema encontrado" (6 auditorias, 80 leads) |
| `npm run validate:recovery` | "RECUPERAÇÃO VALIDADA: 32 verificações"; nenhuma linha/arquivo alterado; 0 chamadas externas |
| Servidor local com sessão assinada pelo próprio app | `/login` 200; `/` sem sessão 307; Supabase Auth responde 400 `invalid_credentials`; `/`, `/api/campaigns`, `/api/audit/completed`, `/api/system/health` 200; health: Redis OK, Supabase OK, worker DOWN; 10 campanhas visíveis; 3 PDFs históricos 200 com SHA conferido (401 sem sessão) |

Limites: é a saída que o Claude Code registrou, não prova independente; foi uma execução do assistente da época com o ambiente local do responsável; **não inclui** o probe com o operador autenticado depois da migration, `g5:smoke`, `npm test`/`typecheck`/`build` nem o relatório final.

## 3. Os itens pedidos, agora com o JSON

**Privilégios padrão.** `postgres` em `public`: as entradas de tabelas, sequências e funções perderam `anon` e `authenticated` e ficaram só com `postgres` e `service_role` (confirma que o passo 3 da `003` foi efetivo). `supabase_admin` em `public`: **inalterado**, ainda concede acesso total a `anon`, `authenticated` e `service_role` em tabelas (`arwdDxtm`), sequências (`rwU`) e funções (`X`). A omissão é deliberada (`rls-audit.md:80`: papel da plataforma). **Resíduo:** um objeto criado pelo papel `supabase_admin` em `public` nasceria acessível a `anon`/`authenticated`; o risco prático é baixo (as tabelas da GMN nascem por `postgres`), mas **não é fechável por nós**. Mitigar por processo: tabela nova só por migration revisada, com RLS e política de negação, e repetir esta auditoria depois de cada migration. Vale testar no laboratório qual papel cria uma tabela feita pelo Table Editor.
**Correção:** a versão anterior deste relatório dizia que funções futuras de `postgres` ficariam executáveis via `PUBLIC`. O JSON mostra o contrário: o ACL padrão de funções (nos dois arquivos) não tem entrada `PUBLIC`, então funções futuras criadas por `postgres` nascem sem `EXECUTE` para `PUBLIC`, `anon` e `authenticated`.

**Estrutura das 5 políticas.** Idênticas entre si e ao que a `003` cria: `gmn_deny_all` em `gmn_audits`, `gmn_battlefield_points`, `gmn_battlefield_rounds`, `gmn_leads` e `prospecting_campaigns`; `permissiva = RESTRICTIVE`; papéis `["anon","authenticated"]`; comando `ALL`; `using = false`; `with_check = false`. A lista de políticas do JSON (`public` e `storage`) tem **somente** estas 5: não há política em `storage`.

**`trigger_set_updated_at`.** Inalterada: dono `postgres`, não `SECURITY DEFINER`, `EXECUTE` para `PUBLIC`, `postgres`, `anon`, `authenticated` e `service_role`. A `003` não revoga (decisão da revisão 2, `rls-audit.md:79`). A sonda de 17/10 recebeu 404 em `anon rpc/trigger_set_updated_at` (função não exposta, `rls-audit.md:16`). É defesa em profundidade opcional, não critério do G5; se for revogada, passo separado, revisado e com rollback.

### 3b. Mudanças que **não** vêm da `003` e precisam de explicação do responsável
| Item | 17/10 → 07/11 | O que fazer (leitura) |
|---|---|---|
| Contas Auth | 1 → **3** | Painel → Authentication → Users (sem expor e-mails fora do canal combinado): datas de criação e provedor; confirmar que o cadastro público continua **desligado**. O acesso ao app continua dependendo de `GMN_OPERATOR_EMAILS`; ainda assim registrar quem são as 2 contas novas |
| Objetos em `gmn-audit-pdfs-private` | 4 → **16** (+12) | Consistente com PDFs gerados pelo app com a `service_role` depois de 17/10; confirmar com a contagem de auditorias (SELECT) e o painel do Storage |
| Tabelas de `storage` | +2 | atualização da plataforma; sem ação |

## 4. Homologação funcional: tratada separadamente (escopo do PR #12 congelado)

Pendências para fechar o G5 (nada foi executado nesta etapa): (1) laboratório descartável com a mesma `003`, comparando o JSON do laboratório com o de produção; (2) matriz de acessos reais no laboratório, incluindo operador autenticado, `g5:smoke`, Storage, gatilhos e rollback; (3) em produção, **somente testes de leitura**; (4) decisão do responsável sobre uma eventual prova HTTP em produção (o `rls:probe` atual **não** é somente leitura: PATCH/DELETE com id impossível e RPC); (5) atualizar `release-checklist`, `final-validation-report`, `risk-register` (R13) e `homologation-plan` e só então marcar o G5 como concluído. Não reaplicar a `003`; o rollback continua disponível e não é necessário.

## 5. Limites
- Prova **estrutural** e documental; o SQL executado em 17/10 e quem o executou seguem desconhecidos.
- A evidência de 17/10 tem três semanas e é indireta (transcrição).
- Mudanças 3b sem causa documentada até o responsável responder.
- *Project Settings → Data API → Exposed schemas* não foi informado; o JSON mostra privilégios, não a exposição na API. Leitura pendente no painel.
- **Correções de rascunho:** (a) a primeira versão afirmou que a sessão de 17/10 não rodou nenhuma verificação pós-migration; estava errada (7 mensagens do assistente depois do relato; seção 2b). (b) a segunda versão afirmou risco de `EXECUTE` via `PUBLIC` em funções futuras; o JSON de 07/11 desmente (seção 3).
