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
