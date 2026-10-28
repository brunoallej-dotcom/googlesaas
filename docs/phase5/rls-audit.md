# Fase 5: auditoria de RLS e acesso (Supabase)

Atualizado em 16/10/2026. **Conclusão: segurança NÃO comprovada; há exposição conhecida (bucket público) e uma única barreira (RLS) nas tabelas.** Mudanças preparadas, **não aplicadas**.

## 1. Princípio
Uma consulta anônima que volta vazia **não** prova segurança: pode ser RLS filtrando (privilégio presente) ou falta de dados. Por isso a auditoria usa três evidências: sondas por papel (`npm run rls:probe`), SQL de leitura do catálogo (`supabase/audit/rls-audit.sql`) e a comparação com a contagem real (service role).

## 2. Evidências coletadas (sondas reais, sem efeito)
Tabelas (linhas reais): `prospecting_campaigns` 10 · `gmn_leads` 80 · `gmn_audits` 6 · `gmn_battlefield_rounds` 3 · `gmn_battlefield_points` 147.

| Papel | Operação | Resultado | Leitura |
|---|---|---|---|
| anon | SELECT nas 5 tabelas | HTTP 200, **0 linhas visíveis** (há linhas reais) | **FILTERED_BY_RLS**: o RLS barra, mas o papel **tem privilégio** |
| anon | UPDATE e DELETE (filtro impossível) nas 5 tabelas | HTTP 200, 0 linhas | O papel **tem privilégio de escrita**; só o RLS impede |
| token forjado (diz ser `service_role`) | tudo | **401** | Assinatura validada: aceita-se só JWT legítimo |
| anon | `rpc/trigger_set_updated_at` | 404 | Função não exposta |
| anon | listar buckets / objetos | `[]` | Não lista |
| anon | **GET público de objeto conhecido** | **HTTP 200** | **EXPOSTO** (bucket público ignora o RLS) |
| anon | `auth/admin/users` | 403 | OK |
| Auth | cadastro público | `disable_signup: true` (você desligou); 1 usuário (o operador) | OK |
| Cliente | segredos no bundle público | nenhum (anon, service role, Serper) | OK |

Resumo da sonda: **EXPOSTO 2** (o mesmo objeto, por dois caminhos do bucket público), **só RLS como barreira 15** (3 operações × 5 tabelas), inesperado 0.

## 3. Cenários
| Cenário | Situação hoje | Depois da proposta |
|---|---|---|
| **Anônimo** (só a chave anon, pública por natureza) | Tabelas: barradas apenas pelo RLS (privilégios existem). PDFs: **expostos** se souber o caminho | Tabelas: 401/403 por falta de privilégio + RLS + política de negação. PDFs: bucket fechado (G2) |
| **Operador autenticado** (JWT `authenticated`, p.ex. chamando o PostgREST direto) | **Não testado** (exige a sua senha; eu não a tenho). Se existir política permissiva para `authenticated`, ele leria tudo sem passar pelo app | Negado por política `USING (false)` e sem privilégio. O app usa só a service role |
| **Acesso indevido** (sem sessão no app, JWT forjado, conta que não é operador, quem conhece o caminho do PDF) | App: 401. JWT forjado: 401. Conta não-operador: não existe (signup off, 1 usuário). Caminho do PDF: **200 enquanto o bucket for público** | Caminho do PDF: falha após G2; conta extra: sem privilégio |

Rodar a sonda como operador: `npm run rls:probe -- --authenticated` (a senha é pedida no terminal, oculta; nada é gravado).

## 4. O que ainda não se sabe (depende de você colar o SQL)
`supabase/audit/rls-audit.sql` é **só SELECT**. Ele revela o que as sondas não alcançam: `FORCE RLS`, **políticas existentes** (inclusive em `storage.objects`), privilégios para `authenticated`/`PUBLIC`, funções `SECURITY DEFINER`, privilégios padrão, views e publicações Realtime. Até haver essas respostas, o item "RLS" fica **PENDENTE**. Não há política versionada no repositório (as migrations 001/002 não têm RLS), então o estado atual existe só no banco.

## 5. Proposta (não aplicada) e riscos
`supabase/proposed/003_rls_hardening.sql` (+ `.rollback.sql`), fora de `supabase/migrations/` de propósito:
1. `ENABLE` + `FORCE ROW LEVEL SECURITY` nas 5 tabelas;
2. política explícita `gmn_deny_all` (`USING (false) WITH CHECK (false)`) para `anon` e `authenticated`;
3. `REVOKE ALL` de `anon`, `authenticated` e `PUBLIC` nas tabelas e sequências (defesa em profundidade);
4. `REVOKE EXECUTE` só da função `trigger_set_updated_at` (não de todas, para não afetar funções de extensões usadas em defaults);
5. privilégios padrão: objetos novos não nascem acessíveis a `anon`/`authenticated`.

Risco de quebrar o app: baixo, porque toda leitura/escrita usa a **service role** (BYPASSRLS), e o login usa só o endpoint de Auth. Mesmo assim: aplicar (portão G5) colando no SQL Editor, rodar `npm run rls:probe` (as 15 linhas "só RLS" devem virar BLOQUEADO POR PRIVILÉGIO), `npm run db:check`, `npm run validate:recovery` e abrir a plataforma. Reversão: `003_rls_hardening.rollback.sql`.

## 6. Estado
| Item | Estado |
|---|---|
| Cadastro público desligado, 1 usuário, segredos fora do bundle | **APROVADO** |
| RLS efetivo contra anon (observado) | **APROVADO COM RESSALVA** (única barreira) |
| Políticas, privilégios e Storage (catálogo) | **PENDENTE** (rodar o SQL de auditoria) |
| Papel `authenticated` | **PENDENTE** (`rls:probe --authenticated`) |
| Bucket público | **PENDENTE** (G2) |
| `003_rls_hardening.sql` | **PENDENTE** (G5, depende da auditoria) |


---
# G5: diagnóstico e preparação (17/10/2026): NADA foi aplicado em produção

## A. O que foi confirmado
- **`supabase/audit/rls-audit.sql` só lê:** 10 instruções, todas `SELECT` (conferido com o parser real do PostgreSQL). Foi criada a versão `rls-audit-json.sql`: **uma única instrução `SELECT`** (1 `SelectStmt` no parser) que devolve **um JSON** com 15 seções (inclui privilégios efetivos, por papel, de `anon`/`authenticated`/`service_role` nas 5 tabelas, triggers, extensões e Storage). O SQL Editor costuma mostrar só o resultado da última instrução; por isso a versão única.
- **Superfície exposta pela API:** só as 5 tabelas; **nenhuma função RPC**; **pg_graphql desativado**.
- **Quem acessa o quê:** todo acesso a dados usa `service_role` no servidor (`getSupabaseAdmin`). A chave anon só faz `signInWithPassword` (esquema `auth`). Nenhum cliente de navegador, Realtime, RPC. Storage só via service role.
- **Sonda real (agora também com `service_role`):** anon: 15 casos "só RLS como barreira"; token forjado: 401; **service_role: 15/15 acessos mantidos** (`SERVICE_ACCESS_OK`); EXPOSTO 0.

## B. Como executar a auditoria (você)
1. Supabase → **SQL Editor** → **New query**.
2. Cole **todo** o conteúdo de `supabase/audit/rls-audit-json.sql` e clique **Run** (só leitura).
3. Clique na célula da coluna `audit` → **Copy** (ou "Download CSV") e envie o conteúdo.
4. (Recomendado) No **seu terminal**: `npm run rls:probe -- --authenticated` (senha oculta, nada é gravado) e envie o resumo.
Sem o JSON não é possível afirmar quais políticas e privilégios existem hoje (o catálogo `pg_*` não é acessível pela API).

## C. Revisão da proposta `003_rls_hardening.sql` (revisão 2)
| Achado na revisão | Ajuste feito |
|---|---|
| Política de negação **permissiva** é somada (OU) a uma política antiga permissiva e não negaria nada | **`AS RESTRICTIVE`** (E). Provado localmente: com `USING (true)` antigo, anon lia leads e authenticated lia/escrevia audits **antes**; **depois** todos recebem 42501 |
| `FORCE ROW LEVEL SECURITY` não protege anon/authenticated e pode bloquear o dono | removido |
| `REVOKE EXECUTE` da função de trigger: função não exposta e EXECUTE não é checado ao disparar o trigger | removido (menos risco) |
| Privilégios padrão de `supabase_admin` (papel da plataforma) | removido; só `postgres` (quem roda nossas migrations) |
| `BEGIN/COMMIT` varia no SQL Editor | **um único bloco `DO`** (atômico) |
| Se `service_role` não tiver BYPASSRLS/privilégios o app quebra | **pré-validações** abortam sem alterar nada; **pós-validações** desfazem tudo se anon/authenticated ainda tiverem privilégio ou se service_role perder algum |
| Rollback devolvendo "ALL" pode ampliar o estado original | rascunho; será ajustado ao estado EXATO lido pela auditoria (seção 3 do JSON) antes de aplicar |

## D. Teste local (PostgreSQL descartável; `supabase/proposed/local-test/`)
**12 de 12 aprovados**, sem tocar produção: auditoria JSON executa e descreve o "antes"; política permissiva antiga expõe dados (prova do risco); 003 aplica sem erro; anon e authenticated recebem **42501** em SELECT/INSERT/UPDATE/DELETE nas 5 tabelas **mesmo com a política antiga**; **service_role lê, insere, atualiza (trigger `updated_at` dispara) e apaga**; auditoria "depois" mostra 5 políticas RESTRICTIVE, anon/authenticated/PUBLIC sem privilégio, RLS ativo e sem FORCE; tabela futura do `postgres` não é acessível a anon; 003 é idempotente; **reversão** remove a política, devolve privilégios e mantém o RLS ligado; 3 pré-validações abortam sem alterar nada (sem BYPASSRLS, sem INSERT, tabela ausente).
**Limitação:** é um Postgres genérico que imita os papéis e privilégios padrão do Supabase; o estado real (políticas antigas, privilégios exatos) só a auditoria em produção revela.

## E. O que a migration alterará (exato) e riscos
**Altera (nas 5 tabelas do esquema `public`):** habilita RLS (já está), cria a política restritiva `gmn_deny_all` para `anon`/`authenticated`, **revoga todos os privilégios** de `anon`, `authenticated` e `PUBLIC` nas tabelas e sequências, e impede que tabelas futuras do `postgres` herdem acesso de `anon`/`authenticated`.
**Não altera:** dados, `storage.*`, esquema `auth`, funções, triggers, FORCE RLS, políticas antigas (ficam inertes), service_role.
| Componente | Risco |
|---|---|
| Dashboard, login, Maestro, Worker, recuperação, `/api/system/health`, scripts | **Nenhum**: usam service_role (com pré/pós-validação) ou o esquema `auth` |
| `anon`/`authenticated` via API | passam a 401/403 (objetivo) |
| Aplicação | bloqueio momentâneo de tabela ao habilitar RLS (tabelas minúsculas); erro ao colar (bloco único atômico) |
| Fase 6 (SaaS) | exigirá políticas próprias; bloqueada |
Reversão: `003_rls_hardening.rollback.sql` (ajustado ao estado lido pela auditoria).
**Testes depois de aplicar:** `rls:probe` (anon, token forjado, authenticated: tudo BLOQUEADO; "só RLS" = 0; service_role OK; contagens 10/80/6/3/147), `db:check`, `validate:recovery`, rota de PDF e `health` com sessão, auditoria JSON de novo, e **logout/login** na tela.

## F. Estado do G5
| Item | Estado |
|---|---|
| Auditoria SQL somente leitura | **APROVADO** (verificado) |
| Políticas e privilégios reais | **PENDENTE** (aguarda o JSON do SQL Editor) |
| Papel `authenticated` | **PENDENTE** (`rls:probe --authenticated`, no seu terminal) |
| Proposta 003 + rollback revisados e testados localmente | **APROVADO** (12/12) |
| Aplicação em produção | **PENDENTE** (aguarda sua autorização específica, depois do resultado da auditoria) |


---
# G5: resultado da auditoria REAL do banco (17/10/2026, 10:10 UTC) e conclusão
Fonte: `rls-audit-json.sql` executado no SQL Editor (PostgreSQL 17.11, usuário `postgres`); JSON guardado em `docs/phase5/evidence/rls-audit-2026-10-17.json` (é o "estado antes", base do rollback).

## O que o banco realmente tem
| Item | Resultado real |
|---|---|
| RLS | **ligado** nas 5 tabelas (dono `postgres`), **sem FORCE**; também ligado em todas as tabelas de `storage` |
| **Políticas** | **ZERO** em `public` e em `storage` (inclui `storage.objects`). Hoje o RLS nega por padrão (sem política = nada passa) |
| Privilégios de tabela | `anon`, `authenticated`, `service_role` e `postgres` têm **todos** os privilégios (`arwdDxtm` = SELECT, INSERT, UPDATE, DELETE, **TRUNCATE**, REFERENCES, TRIGGER, MAINTAIN) nas 5 tabelas; **PUBLIC: nenhum**; sem privilégios por coluna; sem sequências; sem views |
| Papéis | `service_role` **BYPASSRLS = true**; `postgres` BYPASSRLS = true (não superusuário); `anon`/`authenticated` sem BYPASSRLS; `authenticator` (login do PostgREST) é membro de anon, authenticated e service_role |
| Função `trigger_set_updated_at` | EXECUTE para PUBLIC e todos os papéis (padrão); **não é exposta** como RPC; triggers `set_gmn_audits_updated_at` e `set_gmn_leads_updated_at` ativos |
| Privilégios padrão | para objetos criados por `postgres` e `supabase_admin` em `public`: acesso total a anon/authenticated/service_role (padrão Supabase) |
| Storage | 2 buckets, **ambos privados** (3 e 4 objetos); bucket novo só PDF, limite 20 MB; sem políticas em `storage.objects` |
| Outros | Realtime: nenhuma tabela publicada; `pg_graphql` não instalado; extensões `uuid-ossp`, `pgcrypto`, `supabase_vault`, `pg_stat_statements`; **1 conta Auth** |

## Conclusão
1. **Hoje não há acesso indevido por esta via:** com RLS ligado e zero políticas, `anon` e `authenticated` não leem nem alteram linhas (confirmado pela sonda real: 200 vazio). **Não existe nenhuma política permissiva escondida** (a hipótese de risco, em que uma política antiga `USING (true)` abriria tudo, **não se confirmou**).
2. **Mas a proteção é uma barreira só** e os papéis públicos mantêm privilégios que o RLS não cobre: **TRUNCATE, REFERENCES, TRIGGER, MAINTAIN** (RLS não se aplica a TRUNCATE). Pela API REST esses comandos não existem, então não há exploração prática hoje; seria possível apenas com conexão SQL direta como `anon`/`authenticated` (que não é oferecida). É o excesso de privilégio que a migration remove.
3. **O app não depende de nada que a migration retira:** só `service_role` (BYPASSRLS, privilégios completos) acessa dados; a chave anon só faz login pelo esquema `auth`.

## Comparação com `003_rls_hardening.sql` (rev. 2) e rollback ajustado
- Pré-validações: todas **passam** com este estado (`service_role` com BYPASSRLS e SELECT/INSERT/UPDATE/DELETE nas 5 tabelas; 5 tabelas existem).
- `revoke all ... from anon, authenticated, public` cobre todos os 8 privilégios reais (inclusive MAINTAIN, do PG17). `revoke all on all sequences` é inofensivo (não há sequências). Privilégios padrão do `postgres` em `public` existem exatamente como a migration espera.
- Como não há política alguma, a política restritiva `gmn_deny_all` é **cinto e suspensório** (documenta a intenção e protege contra uma futura política permissiva).
- **Rollback ajustado ao estado exato lido:** `GRANT ALL` aos três papéis e privilégios padrão de `postgres` iguais aos originais; sem PUBLIC; RLS permanece ligado; política removida. Provado em PostgreSQL local espelhando esse estado (**13/13**), inclusive: o **conjunto de ACLs das 5 tabelas e os privilégios padrão voltam idênticos** aos de antes da migration.
- Limitação do teste local: PostgreSQL 18.4 genérico (produção: 17.11); os privilégios envolvidos são os mesmos.

## Riscos de aplicar (por componente)
| Componente | Risco | Motivo |
|---|---|---|
| Dashboard | **Nenhum** | usa só `service_role` (verificado no código: todo `.from()` é via `getSupabaseAdmin`) |
| Login | **Nenhum** | `signInWithPassword` usa o esquema `auth` (a migration não toca `auth`) |
| **Maestro e Worker** | **Nenhum** | gravam/leem pelas mesmas funções com `service_role`; trigger `updated_at` continua (função e triggers intocados; provado localmente) |
| Recuperação de auditorias, `validate:recovery`, `db:check`, `/api/system/health`, scripts de PDF | **Nenhum** | service role |
| PostgREST (`authenticator`) | Nenhum | continua assumindo `service_role` normalmente |
| SQL Editor / painel do Supabase | Nenhum | usam `postgres`/`supabase_admin` (BYPASSRLS) |
| `anon` e `authenticated` | passam a **401/403** nas tabelas | é o objetivo; nada atual os usa |
| Execução | bloqueio momentâneo das tabelas (minúsculas); se algo falhar, o bloco único **desfaz tudo** |
Plano de teste depois de aplicar: `rls:probe` (anon, forjado e authenticated: tudo bloqueado por privilégio; "só RLS" = 0; service_role 15/15; contagens 10/80/6/3/147), auditoria JSON de novo (esperado: 5 políticas restritivas; anon/authenticated sem privilégios), `db:check`, `validate:recovery`, PDF e `health` com sessão, e **logout/login** na tela.
**Estado:** análise **APROVADA**; aplicação **PENDENTE** da sua autorização específica.


---
# G5: conferência final e roteiro de aplicação (17/10/2026)
**Teste `rls:probe --authenticated` (executado por você):** EXPOSTO 0; "só RLS" 30 (15 anon + 15 authenticated, como previsto pelo JSON); inesperado 0; service_role sem acesso 0; token forjado bloqueado.

**Conferência 003 + rollback × JSON real:** consistente (5 tabelas idênticas; 0 políticas; pré-validações passam; estado original `arwdDxtm` para anon/authenticated/service_role/postgres e nada para PUBLIC, reproduzido exatamente pelo rollback; sem sequências/views/privilégios por coluna; privilégios padrão do `postgres` em `public` simétricos; a migration não referencia função, `storage.*` nem `auth.*` para alterar).
**Ajuste final (revisão 3):** pré-validação "projeto correto": aborta sem alterar nada se o banco não tiver o bucket `gmn-audit-pdfs-private`. Teste local: **14/14** (inclui "projeto errado ⇒ aborta e nada muda"); sintaxe validada com o parser real do PostgreSQL.

## Roteiro para aplicar (você)
1. Abra o SQL Editor do projeto **`tzcybiivxxlcqqcpnpix`** (o mesmo do `.env.local`): `https://supabase.com/dashboard/project/tzcybiivxxlcqqcpnpix/sql/new`. Confirme o ref na barra de endereço.
2. Abra `D:\gmn-intelligence-platform-corrigido\gmn-intelligence-platform\supabase\proposed\003_rls_hardening.sql`, Ctrl+A, copie e cole numa query nova (não use "Run selected" parcial).
3. **Run.** Esperado: **"Success. No rows returned"**. Mensagens `G5 abortado…`/`G5 falhou…` significam que **nada foi alterado** (bloco atômico): envie o texto.
4. Avise "aplicada". Em caso de comportamento estranho: cole `003_rls_hardening.rollback.sql` da mesma forma.
5. Rode `supabase/audit/rls-audit-json.sql` de novo e envie o JSON; rode no terminal `npm run rls:probe -- --authenticated`.

**Antes da aplicação (referência):** snapshot das 5 tabelas `db/prospecting_campaigns=10`, `gmn_leads=80`, `gmn_audits=6`, `gmn_battlefield_rounds=3`, `gmn_battlefield_points=147` (`.data/migration/g1-snapshot-g5-antes-*.json`); Redis OK, Worker desligado, fila vazia (0 waiting/active), `.env.local` igual.

## Verificações que eu executo depois ("aplicada")
Sonda (anon, forjado, service_role), snapshot das tabelas antes×depois idêntico, `validate:recovery`, `db:check`, PDFs (200/401), `health`, Dashboard (captura headless), Worker ligado ~20 s, **teste sintético Maestro+Worker** (`npm run g5:smoke`: escrita real com limpeza por ID exato e antes/depois idêntico; Serper simulado, 0 chamadas externas), `npm test`, `typecheck`, `build`. G6 e Fase 6 **não** fazem parte.
