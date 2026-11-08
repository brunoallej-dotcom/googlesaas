# Spec: ferramentas para a homologação funcional do G5 (seed do laboratório e `rls:probe --read-only`)

> Spec-Driven Development: escrito antes da implementação e entregue no mesmo PR.

## 1. Goal

O G5 (RLS) está com **implementação aparente**: a estrutura do banco de produção bate com o efeito da `003_rls_hardening.sql`, mas ninguém reconfirmou os acessos reais. Esta entrega cria o que falta para homologar **sem tocar a produção**: (a) um **seed 100% fictício** das 5 tabelas, para o laboratório Supabase descartável, e (b) um modo **`--read-only`** do `rls:probe`, que prova o bloqueio por `GET` apenas, para poder ser usado também contra a produção.

## 2. Non-goals

- Criar o laboratório, acessar a produção, aplicar migrações ou rodar o probe em qualquer ambiente (nada disso acontece neste PR).
- Alterar o `rls:probe` completo existente (continua igual, para o laboratório), a `003`, o rollback ou o schema.
- Testar o Storage no modo somente leitura (a listagem do Storage usa `POST`); o Storage fica coberto pelo SQL de auditoria (`10_storage`) e pelo probe completo no laboratório.
- Testar o papel `authenticated` no modo somente leitura (exige `POST` de login ou um token de usuário, que é segredo).

## 3. Users / actors

O responsável pelo projeto, que executa os comandos no laboratório e, com autorização escrita, a verificação de leitura na produção. Nenhum usuário final.

## 4. User stories

- Como responsável, quero um seed fictício que **recuse rodar na produção** e em qualquer banco com dados reais, para poder homologar o G5 no laboratório sem risco.
- Como responsável, quero um probe que **nunca escreva**, para conferir a produção de forma não destrutiva.
- Como responsável, quero que o relatório do probe **só tenha status, códigos e contagens**, para poder colá-lo em chat ou ticket sem expor dados, JWTs nem chaves.

## 5. Contracts

### 5.1 Seed (`supabase/lab/seed-ficticio.sql`)

- **Um único bloco `DO`** (atômico: qualquer erro desfaz tudo). Roda no SQL Editor como `postgres`.
- **Guardas, antes de qualquer insert:** (1) aborta se detectar o projeto de produção pela impressão digital dos buckets (`criado_em` de `gmn-audit-pdfs` e de `gmn-audit-pdfs-private`, medidos nas auditorias de 17/10 e 07/11); (2) aborta se qualquer das 5 tabelas tiver linha cujo `id` não seja do seed (prefixos `1ab…`).
- **Somente `INSERT ... ON CONFLICT DO NOTHING`**: idempotente; sem `UPDATE`, `DELETE`, `TRUNCATE`, DDL ou `GRANT`.
- **Conteúdo:** 2 campanhas, 4 leads, 2 auditorias (`FAILED`, sem payload, para não gerar ruído em `db:check` e `validate:recovery`), 2 rodadas e 98 pontos (49 por rodada). Todos os `id` começam com `1ab`; nomes e cidades terminam em `(LAB)`; URLs só em `.invalid`; telefones só zeros; coordenadas em torno de (0,01; 0,01), no oceano.
- Restrições do schema (`001`/`002`) respeitadas por construção e conferidas pelos testes.

### 5.2 Probe somente leitura (`npm run rls:probe -- --read-only`)

- **Só `GET`** em `/rest/v1/<tabela>?select=id&limit=1`, nas 5 tabelas, com `Prefer: count=exact`. Nada de `PATCH`, `DELETE`, `POST`, `PUT`, RPC, Auth ou Storage. Um `fetch` protegido **lança** antes de enviar qualquer outra coisa.
- **Papéis:** `service_role` (controle: contagem real e verificação de que o app mantém acesso), `anon` e token forjado.
- **Classificação** (reaproveita `classifyRead`): `BLOCKED_BY_PRIVILEGE` (401/403: nem tem permissão), `FILTERED_BY_RLS` (200 vazio, mas a tabela tem linhas: só o RLS barra), `EXPOSED` (200 com linhas), `INCONCLUSIVE_EMPTY` (200 vazio e tabela vazia: não prova nada; semear o laboratório), `SERVICE_ACCESS_OK`/`SERVICE_ACCESS_LOST`, `UNEXPECTED`.
- **Saída:** status HTTP, código de erro do PostgREST (ex.: `42501`), veredito e **contagens** (visíveis e reais). Nunca corpo de resposta, mensagem de erro, chave, JWT ou token. Imprime só o **host** do alvo (para conferir se é o laboratório ou a produção).
- **Códigos de saída:** `0` tudo OK; `1` exposição, `service_role` sem acesso ou inesperado; `2` erro de uso ou de configuração; `3` sem exposição, mas inconclusivo (tabela vazia).
- `--read-only` com `--authenticated` é **erro de uso** (código 2, sem nenhuma requisição).
- **`--expect-hardened`** (só com `--read-only`; é o critério do G5): "só o RLS barra" (o papel ainda tem privilégio) passa a **reprovar** (código 1). Sem ele, é só um aviso (linha de base de um banco ainda sem a `003`).
- **`anon` só conta como "sem privilégio" com o SQLSTATE `42501`:** um 401 ou 403 de outro tipo (JWT expirado, chave ruim) vira `UNEXPECTED`, nunca falsa garantia.
- **Validação dos argumentos, antes de qualquer rede:** o modo completo (que escreve) é o padrão, então **só são aceitos exatamente `--read-only`, `--authenticated` e `--expect-hardened`**. Qualquer outro argumento (opção com um ou dois hífens, texto solto como `readonly`, `--` sozinho, texto vazio, `--opção=valor`), `--expect-hardened` sem `--read-only` e o caso do npm engolir a opção (`npm run rls:probe --read-only`, sem o `--`, que chega ao script como `npm_config_read_only`) encerram com código 2 e **não** caem no modo completo. O argumento rejeitado só é repetido na saída se parecer uma opção curta e inofensiva.
- **URL do projeto:** só `https://<host>` (ou loopback), sem credenciais, caminho, consulta nem fragmento; a saída nunca repete uma URL inválida. Os redirecionamentos não são seguidos (`redirect: 'error'`).

## 6. Acceptance criteria

- [ ] Em todos os cenários (bloqueado, filtrado, vazamento, `service_role` perdida, falha de rede), todas as requisições são `GET`, sem corpo, na URL exata de uma das 5 tabelas, e são 15 no total.
- [ ] O `fetch` protegido lança, sem chamar o `fetch` real, para `POST`, `PATCH`, `PUT`, `DELETE`, corpo, `rpc`, `auth`, `storage`, tabela fora da lista, `Prefer` diferente de `count=exact` e entrada que não seja texto.
- [ ] O código-fonte do módulo (sem comentários) não contém métodos de escrita, `rpc`, `storage` nem `auth`, e só importa `./rls-probe`; no script, o ramo `--read-only` vem antes de qualquer `fetch` ou pedido de senha.
- [ ] O relatório não contém as chaves, o JWT forjado, o conteúdo de linhas vazadas nem mensagens de erro, mesmo quando o `fetch` falha com uma mensagem que as inclui.
- [ ] Bloqueio, filtro por RLS, vazio inconclusivo e exposição produzem vereditos diferentes; 401 do `anon` sem `42501` é inesperado; `--expect-hardened` reprova "só o RLS barra".
- [ ] Argumento fora dos documentados (texto solto, um hífen, `--`, vazio, misto com uma opção válida), `--expect-hardened` sozinho, o npm engolindo `--read-only` e URL inválida terminam com código 2 **sem nenhuma requisição**; provado de ponta a ponta com o script real contra um servidor local que registra tudo (e com controles positivos: sem argumentos o probe completo continua escrevendo).
- [ ] O seed: guarda primeiro, só `INSERT ... ON CONFLICT DO NOTHING`, só as 5 tabelas, ids do laboratório, nada que se pareça com dado real, e as linhas explícitas respeitam as restrições do schema (enumerações, faixas, chaves estrangeiras, unicidade); contagens e agregados das rodadas batem com a fórmula dos pontos.

## 7. Edge cases

- Tabela vazia: o probe não conclui (`INCONCLUSIVE_EMPTY`, código 3); o seed existe para evitar isso no laboratório.
- Cabeçalho `Content-Range` ausente em resposta 2xx: usa o tamanho do corpo apenas para contar, sem imprimir.
- Falha de rede: registra status 0 e o código `NETWORK_ERROR`, sem a mensagem do erro.
- **Limite conhecido:** uma opção que o próprio npm engole (antes do `--`) com um nome que **não** é uma das três documentadas não deixa rastro confiável no ambiente do script (o npm define 12 variáveis `npm_config_*` por padrão, e o `.npmrc` do usuário acrescenta outras), então não é detectável sem mudar o comportamento de quem usa o comando normalmente. A defesa é usar sempre `npm run rls:probe -- <opção>`; uma melhoria possível é um script do `package.json` com a opção embutida.
- Seed rodado por engano na produção ou em banco com dados reais: aborta sem alterar nada.
- Seed rodado duas vezes: não duplica.
- Os testes não executam o SQL num PostgreSQL real (o ambiente não permite instalar um). A primeira execução no laboratório é o teste de integração do seed, e como é um bloco único, uma falha não deixa meio-estado.
