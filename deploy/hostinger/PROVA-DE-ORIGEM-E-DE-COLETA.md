# Implantação — prova de ORIGEM e prova de COLETA da Auditoria por Link

> **Atualização 21/11/2026 (onda G1.a dos portões de produção):** `stack.yml`, `Dockerfile` e `docker-entrypoint.sh` **passaram a entregar** ao web as pastas e as chaves da Fase 6 (§3). **Nada foi feito na VPS**: criar as pastas e os secrets e implantar continua sendo ação do responsável, pelo CI.
>
> **Status original: SOMENTE DOCUMENTAÇÃO.** `stack.yml`, `Dockerfile` e `docker-entrypoint.sh` **NÃO foram alterados** (até a G1.a); nada foi feito na VPS; **nenhum valor real** consta aqui (apenas nomes de variáveis e `<placeholders>`). Tudo abaixo é o que será **necessário** antes da primeira implantação do módulo. Referências: `docs/phase6-auditoria-link/onda6c-runbook-chaves.md`, `…-adr-prova-de-origem.md`, `…-adr-proveniencia-evidencias.md`, `…-checklist-producao.md`.

## 1. Variáveis (nomes) e onde ficam

| Nome | O que é | Segredo? | Onde |
|---|---|---|---|
| `GMN_LINK_AUDIT_ORIGIN_KEY` | Chave de ORIGEM: `<id>:<64 hex minúsculos de CSPRNG>` | **SIM** | `docker secret` → entrypoint → ambiente do **web** (nunca no Worker, nunca no `.env`) |
| `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS` | Chaves **aposentadas** (rotação planejada): `<id>:<64 hex>:<AAAA-MM-DD>` | **SIM** (tem material) | idem, só durante a janela da rotação |
| `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS` | **Ids** de chaves revogadas por comprometimento (sem material) | Não | `.env.production` |
| `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` | Chaves **públicas** de atestação de coleta: `<id>:<32 bytes base64url>` | Não | `.env.production` |
| `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR` | Pasta **dos manifestos** de coleta (somente leitura para o web; separada da pasta de evidências) | Não | `stack.yml` (bind `:ro`) |
| `GMN_LINK_AUDIT_LEDGER_KEY` | Chave do LIVRO de cabeças: `<id>:<64 hex>`, id e material **diferentes** dos de origem (runbook de chaves §7) | **SIM** | Swarm secret `gmn_link_audit_ledger_key` → `GMN_LINK_AUDIT_LEDGER_KEY_FILE` → entrypoint → ambiente do **web** |
| `GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS` | Chaves do livro **aposentadas** (rotação planejada): `<id>:<64 hex>:<AAAA-MM-DD>` | **SIM** | idem, só durante a janela da rotação (§3, item 5) |
| `GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS` | **Ids** de chaves do livro revogadas (sem material) | Não | arquivo de variáveis da implantação |
| `GMN_LINK_AUDIT_LOG_KEY` | Chave de LOG: `<id>:<64 hex>`, exclusiva; pseudonimiza o e-mail do operador nos logs (`operatorRef`). Repetir id ou material da chave de origem ou do livro ⇒ recusada (`UNAVAILABLE`) | **SIM** | Swarm secret `gmn_link_audit_log_key` → `GMN_LINK_AUDIT_LOG_KEY_FILE` → web |
| `GMN_LINK_AUDIT_GUARD_DB_URL` | **Credencial da guarda** externa (provedor Supabase, G0): conexão do papel de escrita da guarda (`gmn_guard_writer`: só `EXECUTE` na função de publicação e `SELECT`) | **SIM** | **Entra na G1.b** (com o código que a lê): Swarm secret `gmn_link_audit_guard_db_url` → `GMN_LINK_AUDIT_GUARD_DB_URL_FILE` → web. Não faz parte da stack nem da ativação da G1.a |
| `GMN_LINK_AUDIT_GUARD_KEY` | Chave HMAC **própria da guarda** que pseudonimiza o `auditId` publicado (`audit_ref`): `<id>:<64 hex>`, diferente das demais (spec dos portões §5.1.7) | **SIM** | **Entra na G1.b**: Swarm secret `gmn_link_audit_guard_key` → `GMN_LINK_AUDIT_GUARD_KEY_FILE` → web. Não faz parte da stack nem da ativação da G1.a |
| Pastas da Fase 6 (seis) | Decisões, recibos das decisões, resultados, recibos dos resultados, livro e manifestos, cada uma com origem por marcador `GMN_RAIZ_DADOS_*` | Não | `stack.yml` (binds); procedimento no `GUIA-DE-IMPLANTACAO.md` §3.3 e backup no `PLANO-DE-BACKUP-E-RESTAURACAO.md` |

## 2. Como criar o segredo SEM expor o valor
- Gere o material **direto para o destino**, sem imprimir e sem gravar em arquivo comum nem em histórico do shell: por exemplo, canalize `openssl rand -hex 32` para o comando que cria o `docker secret` (o conteúdo do secret é `<id>:<hex>`; o `<id>` é um rótulo público como `ok-AAAA-MM-a`, **independente** do segredo).
- As três chaves HMAC do web na G1.a (origem, livro, log) são **três materiais diferentes, com três ids diferentes** (o servidor recusa repetição); a chave da guarda, na G1.b, será um quarto. Um material por comando, nunca reaproveitado. Todo bloco que gera ou lê segredo começa com `set +x`: com o rastreamento do shell ligado (`set -x`, comum em sessões de diagnóstico), o bash imprimiria cada comando já expandido, inclusive o valor de `K` ou `V`, no terminal e em logs de sessão.
  ```bash
  set +x                                                  # nunca rastrear comandos que carregam segredo
  K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_CHAVE_ORIGEM>' "$K" | docker secret create gmn_link_audit_origin_key -; unset K
  K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_CHAVE_LIVRO>'  "$K" | docker secret create gmn_link_audit_ledger_key -; unset K
  K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_CHAVE_LOG>'    "$K" | docker secret create gmn_link_audit_log_key -; unset K
  ```
  Antes do `unset`, guarde cada `<id>:<material>` no cofre pelo próprio cofre (nada de colar em chat, ticket ou documento).
- **Referência futura (G1.b, NÃO faz parte da ativação da G1.a):** os secrets da guarda entram na stack junto com o código que os lê, depois que o responsável aplicar a migração da guarda. Mesma regra, quando chegar a hora:
  ```bash
  set +x                                                  # nunca rastrear comandos que carregam segredo
  K="$(openssl rand -hex 32)"; printf '%s:%s' '<ID_CHAVE_GUARDA>' "$K" | docker secret create gmn_link_audit_guard_key -; unset K
  read -rsp 'conexão do papel de escrita da guarda: ' V; printf %s "$V" | docker secret create gmn_link_audit_guard_db_url -; unset V
  ```
- Registre **somente** o `<id>` e a data de criação no controle de mudanças. **Nunca** cole o valor em chat, ticket ou documento.
- Guarde uma cópia **cifrada** do segredo em cofre **separado dos dados** (perdê-lo torna inconcluíveis as pendências em andamento; o histórico confirmado segue legível).

## 3. Alterações de implantação (feitas na G1.a, 21/11/2026; nada aplicado na VPS)
1. **`docker-entrypoint.sh`:** a **lista fixa** que converte `*_FILE` em variáveis passou a incluir `GMN_LINK_AUDIT_ORIGIN_KEY`, `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS`, `GMN_LINK_AUDIT_LEDGER_KEY`, `GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS` e `GMN_LINK_AUDIT_LOG_KEY` (os da guarda entram na G1.b, com o código que os lê). A lista continua fixa (nada de varrer o ambiente) e o entrypoint **não exige** essas chaves: sem elas a aplicação já falha fechada (503 / `NOT_CONFIGURED`).
2. **`stack.yml` (só o serviço web):** os três secrets externos `gmn_link_audit_origin_key`, `gmn_link_audit_ledger_key` e `gmn_link_audit_log_key` (a stack só declara o que o código lê; os da guarda entram na G1.b), cada um com `<NOME>_FILE: /run/secrets/<secret>`; as listas públicas `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS`, `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS` e `GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS` por interpolação do arquivo de variáveis da implantação (vazias = nenhum id revogado / atestação fechada); as seis pastas novas por bind com origem em marcador obrigatório (`GMN_RAIZ_DADOS_*`), manifestos **somente leitura**; `update_config.order: stop-first` (R6-09). O **Worker não recebe** nenhuma variável `GMN_LINK_AUDIT_*` nem pasta nova.
3. **`Dockerfile`:** a imagem web cria os alvos de montagem (`10001:10001`, `0700`), porque a raiz do contêiner é só leitura.
4. **Pastas (host):** criar as seis pastas antes de implantar (`GUIA-DE-IMPLANTACAO.md` §3.3: dono `10001:10001`, modo `0700`, conferência por `stat`); a de manifestos **fora** da de evidências e de qualquer outra, escrita **só** pelo canal do CI.
5. **Rotação planejada (janela curta):** as listas `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS` e `GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS` **não ficam declaradas** no `stack.yml` (um secret vazio é recusado pelo entrypoint). Durante a rotação, numa mudança própria pelo CI, acrescentar ao web `GMN_LINK_AUDIT_<ORIGIN|LEDGER>_RETIRED_KEYS_FILE: /run/secrets/<SECRET_DAS_APOSENTADAS>` e o secret externo correspondente; tirar os dois quando a rotação terminar (runbook de chaves §2 e §7). Swarm secrets são imutáveis: trocar a chave atual é `docker service scale gmn_gmn-web=0`, recriar o secret com o mesmo nome a partir do cofre e implantar (nunca dois processos com chaves diferentes).
6. **Primeira implantação já com esta versão** (arquivos com `origin` não são lidos pela versão anterior; a versão anterior também não tem o bloqueio de proveniência).

## 3b. Ordem de ativação (obrigatória): volumes e chaves ⇒ guarda ⇒ primeiro `ENROLL`
1. **Volumes e chaves (G1.a):** as seis pastas criadas e conferidas, os três secrets da G1.a criados (origem, livro, log), a stack implantada pelo CI; conferir o 503/200 esperado (§4) **sem gravar nada**. Esta versão do `stack.yml` exige esses três secrets e as seis pastas no momento do deploy (secret externo ausente ou marcador de pasta indefinido recusa a implantação); **não** depende de nada da guarda. Sem guarda, a vista fica `externalGuard: NOT_CONFIGURED` e o portão G-1 continua fechado.
2. **Guarda (G1.b):** migração da guarda aplicada pelo responsável; secrets `gmn_link_audit_guard_db_url` e `gmn_link_audit_guard_key` criados (referência no §2); stack e código da G1.b implantados pelo CI; `externalGuard` = `CONSISTENT` na tela (portão G-1).
3. **Só então o primeiro `ENROLL`**, numa auditoria nova e vazia. Inverter a ordem cria auditoria sem cabeça publicada (spec dos portões §5.1.4, regra 1). Depois do primeiro `ENROLL`, rollback só para imagem posterior ao livro e sempre com `stop-first` (R6-09).

## 4. Comportamento esperado (para a verificação pós-deploy)
- **Sem `GMN_LINK_AUDIT_ORIGIN_KEY` válida:** decisão, revogação e finalização respondem **503** `ORIGIN_KEY_NOT_CONFIGURED`; leituras funcionam.
- **Sem manifesto/chave pública de coleta:** a prévia responde 200 com "Origem da coleta NÃO comprovada"; **a finalização responde 409 `NOT_FINALIZABLE`** — **isto é o estado esperado enquanto o produtor da prova não existir** (ADR 6C-03, §5 e §7).
- **Configuração contraditória** (id revogado ainda com material; chave fraca; lista malformada): escritas **503** (falha fechada), sem mensagem que revele material.

## 4b. Testemunha do histórico de decisões (R3-MINOR-2)
As rotas de **decisões** e de **prévia** leem as pastas de **resultados** (`GMN_LINK_AUDIT_RESULTS_DIR`, `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR`) apenas para conferir o histórico. **Elas são OBRIGATÓRIAS para as decisões:** sem as variáveis (ou com caminho relativo, as duas iguais ou sobrepostas às demais pastas, inexistentes ou ilegíveis) o histórico fica **NÃO resolvido** — `NOT_CONFIGURED`/`UNAVAILABLE` — e o sistema **falha fechado**: nenhuma decisão vigente, escritas de decisão recusadas (`409 DECISIONS_HISTORY_UNRESOLVED`), nada finalizável; a tela diz o motivo e só a consulta informativa continua. Se a cadeia de resultados estiver ilegível/adulterada (`UNTRUSTED`), idem — restaurar o **par** do mesmo instante a partir do backup. **Rotação de chave:** um resultado pendente cuja origem a chave de hoje não comprova **não** é testemunha, mas é um **indício**; se ele contradiz o histórico de decisões, o estado é `UNTRUSTED` (falha fechada). **Não** mover arquivos de decisão **nem resultados pendentes** para a quarentena sem ler `witness.status` e sem fonte independente (6B §15 item 3; ADR 6C-02 §4.5).

## 5. Proibido
Valores reais em `.env.production`, no repositório, em imagem, em `docker inspect` compartilhado, em log ou em documentação; reassinar registros antigos; manter material de chave revogada na configuração.
