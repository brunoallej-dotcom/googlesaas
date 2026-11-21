# 0003. Guarda externa do livro de cabeças da Auditoria por Link: tabela append-only no Supabase

- **Date**: 2026-11-20
- **Status**: Accepted (2026-11-20, onda G0)
- **Deciders**: responsável pelo projeto (Q1; "tudo aprovado", em resposta à proposta do manager de seguir as doze
  recomendações da spec). O pseudônimo do `auditId` (Q5) foi escolhido pelo manager, pelo lado fechado, dentro da
  recomendação aprovada
- **Tags**: security, link-audit, fase-6, infra, portões-de-produção

## Context

O livro de cabeças da Auditoria por Link detecta adulteração em **uma** pasta (decisões, recibos, resultados ou o
próprio livro). Não detecta o **rollback coordenado** de todos os volumes, nem quem escreve em duas ou mais pastas
incluindo o livro: tudo volta junto e o conjunto continua coerente. Uma revogação some e a decisão revogada volta a
valer em silêncio. É o risco nº 1 do índice de ameaças (`docs/security/threats/INDEX.md`, T-L01/L-T2) e um dos
bloqueadores de produção do encerramento da Onda 6C (`NOTES.md`, rodada de 16/11/2026).

A única defesa é uma **testemunha imutável** da cabeça do livro, num domínio de falha separado da VPS (spec do livro
`docs/phase6-auditoria-link/onda6c-especificacao-livro-de-cabecas.md` §9 camada 5, §13 L1/L2, §16.7). O código já tem a
porta `ExternalGuardPort`, com `publish` e `latest` (`src/lib/link-audit-ledger/guard.ts:12-17`), mas só o adaptador
**sintético** de teste (`guard.ts:21-25`). As rotas não ligam guarda nenhuma
(`src/app/api/link-audit/decisions/ledger-wiring.ts:18-21`), e a vista diz `externalGuard: 'NOT_CONFIGURED'`
(`src/lib/link-audit-ledger/model.ts:460`, em `3899a67`).

Forças em jogo:

- **Sem serviço pago novo** sem autorização do responsável (`CLAUDE.md`, "Architecture rules").
- **O risco a cobrir** é a VPS comprometida (root no host, escrita nos volumes) e a restauração errada de backup. O
  administrador da VPS já está fora da garantia "web comprometido não falsifica" (P1, D15.5).
- **O que a VPS guarda hoje:** o web e o Worker recebem a `service_role` do Supabase (`deploy/hostinger/stack.yml:27`,
  `:32`, `:134`, `:139`). Pelo arquivo de implantação, a senha do `postgres`, as chaves de JWT, o token da API de gestão
  e o painel **não** estão na VPS (a confirmar na VPS).
- **Uma pessoa opera** e é ao mesmo tempo dona do projeto Supabase, do repositório e da VPS.
- **Disponibilidade:** a leitura da Fase 6 passa a depender do provedor, com falha fechada (D-G0-3).

As três opções analisadas estão na spec `docs/specs/link-audit-production-gates.md` §5.1.6.

## Decision

**A guarda externa do livro de cabeças será uma tabela append-only num esquema dedicado do projeto Supabase que o
sistema já usa** (opção 1 da spec §5.1.6), **para o risco "VPS comprometida" e para a restauração errada de backup.**

O desenho mínimo é o da spec §5.1.6, todo por migração versionada em `supabase/proposed/`, aplicada pelo responsável:

1. esquema dedicado, **fora** da Data API (REST), com prova registrada de que a tabela e a função não respondem pela API
   com as chaves `anon`, `authenticated` e `service_role` (PG-G08);
2. dono dedicado sem login (`gmn_guard_owner`). A escrita passa só por uma função de publicação `SECURITY DEFINER` com
   `SET search_path = ''`, que aplica a regra 7 da §5.1.4 de forma atômica por auditoria: trio idêntico aceito; mesmo
   `ledgerSeq` com outro hash ⇒ `CONFLICT`; `ledgerSeq` menor que o maior ⇒ `STALE`; maior ⇒ gravado;
3. papel de escrita `gmn_guard_writer` (credencial na VPS como Swarm secret, `GMN_LINK_AUDIT_GUARD_DB_URL`), só com
   `USAGE`, `EXECUTE` na função e `SELECT`. Papel de leitura `gmn_guard_reader`, cuja credencial **não** fica na VPS;
4. `REVOKE ALL` de `PUBLIC`, `anon`, `authenticated` e `service_role`, conferido no próprio SQL. Como defesa em
   profundidade: restrição única e gatilhos que recusam `UPDATE`, `DELETE`, `TRUNCATE` e `INSERT` fora da regra 7;
5. o `auditId` **não** vai em claro: a tabela guarda o pseudônimo `audit_ref` = HMAC-SHA-256 com a chave própria
   `GMN_LINK_AUDIT_GUARD_KEY`, mais o id da chave (D-G0-5; rotação na spec §5.1.7);
6. reconciliação externa semanal, depois de cada backup do livro e antes de qualquer restauração, pelo responsável,
   fora da VPS (D-G0-2).

**Limite declarado:** a guarda fica fora da VPS, mas **dentro do projeto Supabase**. O dono ou um administrador do
projeto, ou quem tomar a conta, consegue alterar ou remover gatilhos, privilégios e linhas e restaurar o banco. Esta
decisão **não** protege contra eles.

## Consequences

### Positive

- Fecha o risco nº 1 para o ator modelado: quem tem root na VPS ou escrita nos volumes não esconde um retrocesso
  anterior à última cabeça publicada. Com a credencial de escrita, só consegue **congelar** auditorias (regra 7). Restaurar
  o banco do Supabase a um ponto anterior exige o painel, que não está na VPS.
- Restauração errada de backup e escrita só nos volumes passam a ser detectadas **na hora** (`GUARD_MISMATCH`).
- Nenhum serviço novo e nenhum custo novo no plano atual (o plano é **a confirmar**). Os resultados (`RUN_*`) estão no
  mesmo livro, então a guarda cobre também a confirmação de resultados (ADR-0002) sem trabalho a mais.
- Reaproveita a porta existente e o processo de migração versionada do projeto (`supabase/proposed/003_rls_hardening.sql`
  como modelo de conferência de privilégios no SQL).

### Negative

- **Não há independência contra o dono do projeto Supabase.** Com uma pessoa só, quem administra a VPS e quem é dono do
  projeto são a mesma pessoa. A guarda protege contra o **host** comprometido, não contra a pessoa nem contra a conta
  dela. A mitigação é MFA na conta e a cópia própria das cabeças guardada pela reconciliação.
- **Raio de impacto:** o projeto é o mesmo dos dados de prospecção, cujo RLS (G5) está "pendente de homologação
  funcional" (`NOTES.md`, G5). Um erro de privilégio no esquema novo (esquema exposto, `REVOKE` faltando) deixaria a
  `service_role`, que já está na VPS, publicar uma sequência falsa e congelar auditorias. Por isso o PG-G08 é condição de
  aprovação.
- **Disponibilidade acoplada:** toda leitura da Fase 6 passa a depender do Supabase. Queda, pausa por inatividade (a
  confirmar no plano) ou credencial inválida ⇒ nenhuma decisão vigente, nada finalizável (falha fechada, D-G0-3).
- **Dependência nova:** um cliente Postgres para a conexão direta ou pelo *pooler*, com revisão de cadeia de
  suprimento; e, a confirmar, se a conexão direta do plano exige IPv4 pago.
- **Mais uma credencial e mais uma chave na VPS** (escrita da guarda e chave do pseudônimo), mais a credencial de leitura
  e a chave do pseudônimo sob custódia do responsável.
- **Detecção depois do fato contra o web comprometido:** quem controla o processo web mente para a própria aplicação
  sobre o `latest` e esconde um retrocesso das telas. Só a reconciliação semanal detecta (L8 da spec do livro).

### Neutral / follow-ups

- **Implementação:** onda G1.b (adaptador, contrato R6-10, ligação nas rotas, migração proposta, reconciliação e runbook),
  com os números da spec §5.1.7 (`L_max` = 5, `T` = 15 min, 3 s). Os segredos da guarda no `stack.yml` e no entrypoint
  também entram na G1.b (a G1.a declara só o que o código já lê).
- **Ensaio:** onda G2, em homologação isolada com laboratório Supabase descartável (D-G0-12).
- **Revisão futura: Object Lock (opção 3).** Reabrir esta decisão, com custo autorizado pelo responsável, quando
  qualquer um destes ocorrer:
  1. uso com clientes;
  2. mais de um operador, ou um dono do projeto Supabase diferente de quem administra a VPS;
  3. exigência de independência também contra o dono ou administrador do projeto;
  4. incidente ou suspeita envolvendo a conta do Supabase.
  
  Com Object Lock em modo *compliance*, nem a conta raiz encurta a retenção (a confirmar por fornecedor). O critério
  dessa opção já está escrito (PG-G11, hoje não aplicável). A porta `ExternalGuardPort` não muda; muda o adaptador, e a
  migração entre provedores exige publicar a cabeça atual de cada auditoria no novo provedor sob reconciliação.
- **Monitorar:** idade do último resumo externo (GE-R7), alarmes de `CONFLICT`, `GUARD_MISMATCH`, `GUARD_LAGGING` e
  `BEHIND` acima de 15 min (GE-E6).
- Ameaças desta decisão: `docs/security/threats/link-audit-portoes-producao.md`.

## Alternatives considered

**(2) Repositório GitHub privado separado**, com regra de proteção sem push forçado e token fine-grained só com
`contents:write`. O registro seria o histórico de commits. Rejeitada: no plano gratuito de conta pessoal, a proteção de
branch em repositório privado não estava disponível (`NOTES.md`, S0 de 07/11/2026), então dependeria de plano pago ou de
repositório público, que expõe datas e frequência de atividade mesmo com pseudônimo. Além disso, a conta dona do
repositório é a mesma do código, do CI e do canal de manifestos (D7): comprometê-la derruba a guarda junto com o resto.

**(3) Armazenamento com Object Lock** (bucket versionado, retenção em modo *compliance*, credencial só com `PutObject`).
É a imutabilidade mais forte e o único domínio separado também do dono da conta. Não foi escolhida agora porque é
fornecedor e custo novos, que exigem autorização, e mais uma custódia de credenciais; o encerramento da conta por falta de
pagamento interromperia o serviço (a confirmar). Fica como a revisão futura acima.

**Seguir sem guarda real** (só o adaptador sintético, `externalGuard: NOT_CONFIGURED`). Rejeitada: o rollback coordenado
continuaria não detectado e o portão de produção não abre com `NOT_CONFIGURED` (spec §10.1, G-1; PG-G07).

## References

- Related ADRs: ADR-0001; ADR-0002 (`0002-authenticate-result-receipts.md`, confirmação de resultados pelo livro); ADR 6C-02
  `docs/phase6-auditoria-link/onda6c-adr-prova-de-origem.md`.
- Spec: `docs/specs/link-audit-production-gates.md` (§5.1.4 regras do contrato, §5.1.6 opções e desenho, §5.1.7 números,
  §6 PG-G08, §11 decisões D-G0-1 a D-G0-5).
- Spec do livro: `docs/phase6-auditoria-link/onda6c-especificacao-livro-de-cabecas.md` (§9, §12, §13 L1/L2/L6/L8, §16.7,
  §16.11 R6-10).
- Plano: `docs/plan/implementation-waves.md`, ondas G1.b e G2.
- Ameaças: `docs/security/threats/link-audit-portoes-producao.md`, `link-audit-ledger-e-resultados.md` (T-L01).
