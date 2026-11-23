# Portões de produção da Fase 6: relatório do laboratório do PG-G08 (guarda externa no Supabase)

> Roteiro seguido: `producao-g1b-laboratorio-pg-g08.md`. Executado pelo **responsável**, na própria máquina, em **23/11/2026**, com o
> manager acompanhando passo a passo pela conversa. **Repositório público:** este relatório não traz host, ref de projeto, IP, chave,
> senha nem e-mail. O registro completo, com os hosts, fica com o responsável, fora do repositório.
>
> **Escopo:** só o **laboratório descartável** (D-G0-12). Produção segue a §11 do roteiro, com autorização própria. **Situação:** os itens
> que dependem da máquina do responsável estão feitos. Os que precisam ser medidos **da VPS** (TLS da conexão direta, latência e
> alcance IPv4/IPv6) ficam para a preparação da pilha de homologação (ações H-01 a H-10 de `deploy/hostinger/RUNBOOK-DEPLOY-PELO-CI.md`).

## Ambiente

- Projeto de laboratório criado pelo responsável numa organização própria, **plano gratuito** (sem custo novo, Q-1 da spec do P-9),
  computação *Nano*, PostgreSQL 17.12.
- Máquina do responsável: WSL (Ubuntu 26.04), `psql` 18.6, OpenSSL 3.5.5, `curl` 8.18. **Sem IPv6:** a conexão direta do Supabase
  só tem endereço IPv6 e ficou inacessível daqui (`Network is unreachable`). Toda a sequência usou o **Session pooler** (porta 5432),
  com os usuários no formato `<papel>.<ref>`. O complemento pago de IPv4 **não** foi contratado.
- Sessão segura da §0.1: `umask 077`, pasta temporária apagada no `exit`, `PGSSLMODE=verify-full` com a CA do projeto
  (`Supabase Root 2021 CA`, válida até 2031), senhas só pelo `PGPASSFILE` 0600 e pelos `read -rs`, chaves da Data API só pelos
  arquivos de cabeçalho. Nada colado em argumento, URL ou histórico.

## Resultados (§10 do roteiro)

| Item | Resultado | Evidência (sanitizada) | Data |
|---|---|---|---|
| Job `guard-migration` verde no SHA exato da 004 e `sha256` conferido (§1, passo 0) | **SIM** | commit `b0ce587` (última mudança da 004), execução 45101276626 verde; `sha256` da migração `277e825b…a3a23` e do rollback `11e79167…3a6a`, iguais aos do arquivo local | 23/11/2026 |
| 004 aplicada como `postgres`, reaplicada sem alteração | **PASSOU** | `COMMIT` nas duas; na segunda, só `NOTICE … already exists, skipping` | 23/11/2026 |
| Senhas definidas por `\password` (escritor e leitor distintos) | **SIM** | geradas pelo responsável e guardadas no cofre dele; a do leitor não vai para a VPS | 23/11/2026 |
| Catálogo e privilégios (§2) | **PASSOU** | `gmn_guard_owner \| t \| {"search_path=\"\""}`; ACL `0 \| 0`; 20 × `f` na tabela e 4 × `f \| f` no esquema e na função para `anon`, `authenticated`, `service_role` e `authenticator`; papéis da guarda só com `rolcanlogin` em escritor e leitor; 0 associações | 23/11/2026 |
| Privilégios padrão globais ou no esquema da guarda (§2, "a confirmar" da §11.1) | **PASSOU** | `pg_default_acl` com `defaclnamespace = 0` ou no esquema da guarda: **0 linhas**. Os privilégios padrão do Supabase existem só nos esquemas dele (`public`, `storage`, `auth`, `graphql`, `graphql_public`, `extensions`, `realtime`) | 23/11/2026 |
| Data API: tabela e função recusadas para `anon`, `authenticated`, `service_role` (§3) | **PASSOU** | 9/9 pedidos com `406 PGRST106 "Invalid schema: gmn_link_audit_guard"` (dica: só `public` e `graphql_public` expostos); tabela com 0 linhas depois; `pg_graphql` desligado no projeto (`extension is not enabled`), introspecção sem tipo da guarda | 23/11/2026 |
| *Exposed schemas* sem o esquema da guarda (§4) | **PASSOU** | painel (*Integrations → Data API → Settings*): expostos `public` e `graphql_public`; `gmn_link_audit_guard` desmarcado; *Extra search path* `public, extensions`; tabelas expostas 0 de 1; a única função exposta é `public.rls_auto_enable`, do próprio Supabase, e as três funções da guarda aparecem como não expostas | 23/11/2026 |
| TLS direto: cadeia e nome (§5) | **PENDENTE (VPS)** | inacessível da máquina do responsável (só IPv6); medir da VPS | — |
| TLS pooler sessão / transação (§5) | **PASSOU** | `Verify return code: 0 (ok)` nas portas 5432 e 6543; certificado `*.pooler.supabase.com` emitido pela `Supabase Intermediate 2021 CA` | 23/11/2026 |
| Verificador `gate` sem backup: `connection: OK`, `reader: OK` (§5) | **PASSOU** | código 2, `EXTERNAL_GUARD_NOT_VERIFIED`, `configuration: READY`, `connection: OK`, `reader: OK`, `externalGuard: NOT_VERIFIED`, `lMax: 5` (pelo pooler, modo sessão) | 23/11/2026 |
| Ajustes do papel pelo host escolhido (3 s, read committed, read only) (§5) | **PASSOU** (pooler, modo sessão) | escritor: `statement_timeout = 3s`, `lock_timeout = 3s`, `read committed`; leitor: `default_transaction_read_only = on`. O modo transação (6543) não foi usado para os papéis | 23/11/2026 |
| Latência escrita / leitura: p50, p95, máx (§6) | **PENDENTE (VPS)** | o que conta é o caminho da VPS até o host escolhido | — |
| IPv4/IPv6 e host escolhido para a VPS (§7) | **PENDENTE (VPS)** | conexão direta só IPv6 no plano gratuito; sem IPv6 na VPS, a guarda usa o pooler em modo sessão com `gmn_guard_writer.<REF>` | — |
| Pausa por inatividade (§8) | **ANOTADO** | projeto no plano gratuito: o Supabase pausa projetos gratuitos depois de cerca de uma semana sem atividade (conferir o aviso no painel); reativar pelo painel. Laboratório pausado = guarda indisponível = Fase 6 parada, com falha fechada. Conferir que está ativo antes do ensaio W5.3 e da G2. **Para produção, a guarda não pode ficar num projeto que pausa:** ponto para a decisão de produção | 23/11/2026 |
| Regra 7 e gatilhos no laboratório (§9) | **PASSOU** | escritor, pseudônimo aleatório: posições 1 e 3 `RECORDED`, a 3 repetida `ALREADY_RECORDED`, a 2 `STALE`, a 3 com outro hash `CONFLICT`; leitor publicando: `permission denied for function publish_head`; `postgres` com `update`, `delete` e `truncate`: `permission denied for table ledger_heads` (recusado já pelo privilégio, antes do gatilho de imutabilidade, que é a segunda camada e fica provado pelo `guard-run.sh` local e no CI) | 23/11/2026 |

## Observações

1. **Pooler como caminho padrão do laboratório.** Sem IPv6 na máquina do responsável, o pooler em modo sessão foi o único caminho. Ele
   atendeu a todos os requisitos da §5 (TLS verificado com nome, ajustes dos papéis valendo na sessão, verificador do portão OK). A
   escolha do host para a VPS sai do §7, medido de lá.
2. **Senhas redefinidas uma vez.** Na §5, a primeira tentativa como escritor falhou porque a colagem de duas linhas fez o `read -rs`
   ler a segunda linha como senha. As senhas dos dois papéis foram redefinidas pelo `postgres` (`\password`), com as do cofre, e o
   resto seguiu normal. Lição para o roteiro: **comando que pede senha vai sozinho**, sem a linha seguinte colada junto.
3. **Usuário de teste do `authenticated`** criado só no laboratório (`teste-guarda@example.com`, confirmado na criação) para obter o JWT
   da §3. Ele some com o projeto.
4. **Linhas de teste da §9** ficam na tabela (append-only), sob um pseudônimo aleatório que nenhuma auditoria tem.

## Próximos passos

- Da VPS, na preparação da homologação: §5 (TLS direto), §6 (latência, 30 chamadas como escritor e como leitor) e §7 (IPv4/IPv6 e
  host escolhido). Atualizar este relatório.
- Encerrar o laboratório quando a G2 terminar: revogar as senhas dos papéis e apagar o projeto, com a data (AT-G2-02).
