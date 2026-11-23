# Teste local da migration 003 (PostgreSQL descartável)

Executa `003_rls_hardening.sql`, o rollback e `audit/rls-audit-json.sql` num PostgreSQL local descartável
(papéis anon/authenticated/service_role como no Supabase), **sem tocar produção**. 12 verificações:
estado antes/depois, política permissiva antiga, privilégios, service_role, trigger `updated_at`,
idempotência, reversão e as 3 pré-validações que abortam sem alterar nada.

Não faz parte do `npm test` (usa um pacote que não é dependência do projeto). Para rodar:

```bash
mkdir /tmp/gmn-pgtest && cd /tmp/gmn-pgtest && npm init -y && npm i embedded-postgres
cp <repo>/supabase/proposed/local-test/run.mjs . && node run.mjs <caminho-do-repositório>
```

# Teste local da migration 004 (guarda externa do livro, G1.b.2a)

`guard-run.sh` aplica `004_link_audit_guard.sql` e o rollback num PostgreSQL **do Supabase** descartável: a imagem
`public.ecr.aws/supabase/postgres` **já presente na máquina** (`--pull never`, nada é baixado), num contêiner com
`--network none` (sem rede, nenhuma porta publicada) e `--rm`. A imagem tem os papéis `anon`, `authenticated`,
`service_role`, `authenticator` e `supabase_admin` e o `postgres` **sem superusuário**, como no projeto real
(PostgreSQL 17.11). A migração roda como `postgres`; as conferências, como `supabase_admin` com `SET ROLE`, ou com login
real pelo loopback **do contêiner** quando o que se confere é ajuste de papel. 33 verificações: pré-validação e
conferência final que abortam e desfazem tudo (inclusive privilégio vazado por `pg_read_all_data`), o catálogo do PG-G08,
a regra 7 na função, a trava consultiva com duas sessões, 42501 para `anon`/`authenticated`/`service_role`/`authenticator`,
os gatilhos mesmo para quem tem o privilégio, o prazo de 3 s no servidor, NOLOGIN do dono, idempotência, associações
indevidas feitas por fora e o rollback (recusado com cabeças sem confirmação; com ela, catálogo idêntico ao de antes).
Na etapa final, `guard-adapter-run.ts` roda o **adaptador real** (`createPostgresGuard`, com o SQL fixo dele e o `pg`) contra a
migração aplicada, pelo soquete Unix do contêiner montado numa pasta temporária, como `gmn_guard_writer`: regra 7, rotação da
chave do pseudônimo, só o `audit_ref` no banco e nenhuma conexão aberta ao fim. O TLS do conector de produção é provado nos
testes do repositório (`tests/link-audit-guard-pg.test.ts`), não aqui.

Revisão do PR #61: inventário fechado do esquema (um objeto não esperado preexistente, de qualquer tipo, aborta e desfaz),
definição exata do que a reaplicação não recria (colunas, cada restrição, o índice e os gatilhos pelo texto canônico do
PostgreSQL: nome certo com semântica errada aborta), ACL de todos os objetos e associação administrativa só do criador. Pré-requisitos **obrigatórios** (faltando, o script falha;
nenhuma etapa é pulada): a imagem já presente, o Node e o `pg` (`npm ci`).

```bash
bash supabase/proposed/local-test/guard-run.sh            # imagem padrão, por digest: public.ecr.aws/supabase/postgres:17.11.0.018
bash supabase/proposed/local-test/guard-run.sh <imagem>   # outra imagem já presente localmente
```

**No CI:** `.github/workflows/guard-migration.yml` puxa a imagem pelo mesmo digest e roda este script, só quando mudam a 004, esta
pasta ou `src/lib/link-audit-ledger/guard-*`. A saída verde desse job no SHA exato da 004 é **evidência obrigatória** antes de
aplicá-la (spec dos portões, GE-E4 e PG-G08).

Não substitui o PG-G08 no laboratório: a prova pela Data API (REST) e o *Exposed schemas* só existem num projeto
Supabase de verdade.
