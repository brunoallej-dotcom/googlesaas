# Spec: Observabilidade da Auditoria por Link (Fase 6)

> Spec-Driven Development: este documento é escrito **antes** da implementação.
> Estado: **PROPOSTA**. Nada aqui está implementado. Itens marcados **DECISÃO PENDENTE** pertencem ao responsável.
> Convenção: nomes de eventos e campos em inglês; texto em pt-BR.

## 1. Objetivo

Hoje nenhum módulo nem rota da Fase 6 emite log estruturado. Os blocos `catch` das rotas devolvem `INTERNAL_ERROR`
e **não registram nada** (`shared.ts` de evidências, decisões e pontuação: "nada do erro ... é devolvido ou registrado"),
e o checklist de produção declara "hoje não há log estruturado nem alerta" (`onda6c-checklist-producao.md` §5 e §6).
Esta spec define:

- os eventos de log estruturado de toda operação da Fase 6 (rotas e CLI), com quem, ação, recurso, resultado e
  correlation ID, **sem dado pessoal**;
- como identificar o operador sem gravar o e-mail;
- métricas e alertas ligados aos sinais do checklist, sem ferramenta paga;
- critérios de aceite testáveis e um plano em fatias pequenas.

Fatos verificados no código (base da spec):

| Fato | Onde |
|---|---|
| `StructuredLogger(agent, correlationId?)` emite JSON em `console.log/warn/error`; `agent` é `AgentName \| 'SYSTEM'`; **sem** `try/catch` em `emit` | `src/lib/logger.ts:36-60` |
| `redactValue` redige chaves sensíveis (`password`, `*token`, `api-key`, `authorization`, `cookie`...) e padrões de segredo; **não redige e-mail** nem a chave `reason`/justificativa; limita strings a 2000 caracteres, arrays a 50, profundidade 6 | `src/lib/redact.ts:42-57,60-73` |
| Redação NÃO remove query string de URL comum (só credenciais embutidas e `token=`, `api_key=` etc.) | `src/lib/redact.ts:19-24` |
| Não existe correlation ID no middleware | `src/middleware.ts` (41 linhas, sem cabeçalho de correlação) |
| Já existe geração de `correlationId` (`randomUUID`) na rota, só em `apiFailure`, **não usada pela Fase 6** | `src/lib/errors.ts:51-66` |
| A sessão é um cookie HMAC próprio (`gmn_session`) com payload `{ e, iat, exp, v }`. **Só há o e-mail** (`e`); não há id de usuário. Não é sessão do Supabase Auth | `src/lib/auth/session.ts:11-17`, `guard.ts:150-155` |
| `requireOperator` devolve `{ operator: <e-mail minúsculo> }`; no bypass de desenvolvimento o operador é `dev@localhost` | `src/lib/auth/require-operator.ts:4-6`, `guard.ts:129` |
| O e-mail do operador é usado como chave dos limitadores em memória e como `actor.email` do leitor/serviços | `evidence/shared.ts:63`, `decisions/shared.ts:73`, `scoring/shared.ts:93` |
| Os módulos de serviço devolvem resultado tipado (`ok` ou `{code, ...}`); as rotas mapeiam o código para HTTP | `HTTP_STATUS` em `link-audit-decisions/service.ts:85`; `PREVIEW_HTTP_STATUS` em `link-audit-scoring-runs/preview.ts:33`; `RESULTS_HTTP_STATUS` em `results.ts:59` |
| A vista do livro (`LedgerView`) traz `state`, `reason`, `capacity.level` (`OK`/`REVOKE_ONLY`/`EXHAUSTED`), `openOperation`, `recoverable` e já é devolvida ao cliente nas respostas de decisões | `link-audit-decisions/ledger-port.ts:95-130` |
| `EIO`/`EROFS` travam a base de evidências (`STORAGE_FATAL`) e o livro até reiniciar; `ENOSPC` só aparece em comentário (reemissão de recibo). **Não verificado** se o `errno` chega até onde a rota decide logar | `link-audit-evidence/store.ts:68`, `snapshot-store.ts:358`, `link-audit-ledger/service.ts:409` |

## 2. Non-goals

- Nenhuma mudança nos protocolos de gravação e leitura, nos formatos persistidos, no contrato HTTP, nas mensagens
  públicas ou em `src/lib/link-audit/scoring/`.
- Não registrar, para "depurar", o corpo da requisição, o link, as justificativas, as evidências nem caminhos.
- Não escolher, contratar nem instalar ferramenta de monitoramento (Prometheus, Grafana, Datadog, Sentry etc.).
- Não criar papel administrativo, nem trilha de auditoria legal/forense. O **log é diagnóstico**; a fonte de verdade
  das decisões continua sendo o histórico encadeado, os recibos e o livro de cabeças.
- Não resolver as pendências de segurança do checklist (guarda externa, operação administrativa etc.).

## 3. Atores

- **Operador autenticado** (sessão HMAC + `GMN_OPERATOR_EMAILS`): origem de toda requisição das rotas.
- **Operador de infraestrutura**: lê os logs do container (stdout/stderr) e executa os runbooks do checklist.
- **CLI** (`scripts/link-audit-collect.ts`, `scripts/link-audit-evidence.ts`): executado na máquina do operador/VPS.
- **Revisor de segurança**: verifica que o log não é canal de vazamento.

## 4. Histórias

- Como operador de infraestrutura, quero ver um 409 de integridade em leitura como evento `ERROR` com `auditId` e
  código, para tratá-lo como incidente (checklist §6).
- Como operador de infraestrutura, quero correlacionar o 503 `ANCHOR_PENDING` que o usuário viu com a linha de log
  pelo `correlationId` devolvido na resposta.
- Como responsável, quero saber **qual operador** gravou uma decisão sem que o e-mail apareça no log.
- Como revisor, quero um teste que falhe se e-mail, justificativa ou URL com parâmetros chegarem ao log.

## 5. Contratos

### 5.1 HTTP

Não há `openapi.yaml` para a Fase 6 e **esta spec não cria um**. A única mudança observável por clientes é um
cabeçalho de resposta **novo e aditivo**, `X-Correlation-Id`, em todas as respostas `/api/**` (§8.2). Corpos, códigos
HTTP e mensagens permanecem idênticos.

### 5.2 Envelope do log

Reutiliza `StructuredLogger` sem alterar a assinatura. Cada evento é uma linha JSON com:

- `message` = nome do evento (ex.: `link_audit.decision.create`);
- `agent` = `'SYSTEM'` (não ampliar `AgentName`);
- `correlationId` = ID da requisição/execução (§8);
- `durationMs` = duração da operação;
- `metadata` = **somente** os campos permitidos de §6 (lista fechada).

### 5.3 Módulo novo (proposto)

`src/lib/link-audit-observability/` (puro, isolado como o resto da Fase 6):

- `emit(event: LinkAuditEvent): void` — **nunca lança** (§11);
- `LinkAuditEvent` — união discriminada com **campos fechados** (tipo, não `Record<string, unknown>`), de modo que um
  campo fora da lista não compila;
- `sanitizeForLog(value)` — último filtro em tempo de execução (§11.2);
- `operatorRef(email)` — pseudônimo (§7);
- `classifyErrno(error)` — devolve só `'ENOSPC' | 'EIO' | 'EROFS' | 'OTHER'`, nunca mensagem nem caminho.

Dependência permitida: `src/lib/logger.ts` e `src/lib/redact.ts` (já importado por `link-audit/url-redaction.ts:1`).
Nenhuma dependência de `link-audit-decisions` etc.: as rotas traduzem o resultado do serviço para o evento.

## 6. Inventário de eventos

### 6.1 Campos comuns

**Permitidos em todo evento:** `event`, `correlationId`, `route` (o **padrão** da rota, ex.
`/api/link-audit/decisions/[auditId]`, nunca a URL real), `method`, `status` (HTTP), `code` (código estável do serviço),
`outcome` (`OK` | `REPLAYED` | `REFUSED` | `FAILED`), `durationMs`, `operatorRef` (§7), `auditId` (validado por
`AUDIT_ID_PATTERN`; ver questão aberta Q4), `seq` (inteiro), `mode` (`read`/`write`), `ledgerState`, `ledgerReason`,
`ledgerCapacityLevel`, `errno` (apenas o enum de `classifyErrno`), `retryAfterSeconds`, `issueCount` (número),
`blockerCount` (número), `pendingAgeSeconds` (número).

**Proibidos em todo evento (qualquer evento, qualquer nível):**
e-mail do operador (ou do `actor`, `confirmedBy`, `author`), senha, token, cookie, chave HMAC/origem/livro, **texto de
justificativa** (`reason` de revogação, `rationale`, qualquer campo livre de decisão), **o link do Google Maps** e qualquer
URL com query string ou fragmento (inclui o URL do site auditado), nome da empresa, cidade, corpo bruto de requisição
ou de provedor, conteúdo de evidência, `issues[]` (texto), `blockers[]` (texto), `message` de exceção, `stack`, qualquer
caminho de arquivo (inclui nomes de arquivo de decisão/recibo), valores de `head`/`pending` do cliente (`expectedHead`
é entrada do cliente), `ledger` inteiro (só os três campos escalares acima), IP do cliente, cabeçalhos.

### 6.2 Rotas (todas exigem sessão; a autenticação é feita antes)

Níveis: sucesso de **escrita** = INFO; sucesso de **leitura** = DEBUG (volume, §10); recusa por regra de negócio = WARN;
falha de integridade/armazenamento/inesperada = ERROR.

| Operação (rota) | Evento | Nível | Campos permitidos além dos comuns | Código / HTTP |
|---|---|---|---|---|
| Qualquer rota, sem sessão válida | `link_audit.auth.denied` | WARN | `route`, `method`, `status`, `code` | `NO_SESSION` 401, `INVALID_SESSION` 401, `NOT_ALLOWED` 403, `CROSS_ORIGIN` 403, `AUTH_NOT_CONFIGURED` 503. **Sem** `operatorRef` (a identidade não foi provada) |
| `POST /parse` | `link_audit.parse` | DEBUG | `outcome`, `linkStatus`, `linkCode` (enums do parser) | 200; 400/413/415/408 → `link_audit.request.rejected` |
| `POST /confirm` | `link_audit.confirm` | INFO (200) / WARN (409) | `outcome`, `linkStatus`, `linkCode` | 200; 409 `IDENTITY_NOT_CONFIRMABLE`, 409 `CONFIRMATION_REJECTED`; nada é gravado |
| `GET /evidence` | `link_audit.evidence.list` | DEBUG | `returned` (contagem), `total` | 200 |
| `GET /evidence/{id}` | `link_audit.evidence.get` | DEBUG / ERROR | `integrityStatus` (enum) | 200; 404 `NOT_FOUND`; **409 `INTEGRITY_FAILED` = ERROR (incidente)**; 409 `AUDIT_INCOMPLETE` = WARN |
| `GET /evidence/{id}/versions` | `link_audit.evidence.versions` | DEBUG / ERROR | `versionCount` | 200; 404; **409 `INTEGRITY_FAILED` = ERROR** |
| `GET /decisions/{id}` | `link_audit.decision.list` | DEBUG / ERROR | `ledgerState`, `ledgerReason`, `ledgerCapacityLevel`, `activeCount`, `historyCount` | 200; **409 `DECISIONS_INTEGRITY`, `DECISIONS_TRUNCATED`, `ANCHOR_MISMATCH`, `ANCHOR_INTEGRITY`, `EVIDENCE_INTEGRITY`, `DECISIONS_HISTORY_UNRESOLVED` = ERROR**; 409 `PENDING_UNCONFIRMED` = WARN; **409 `PENDING_ORIGIN_UNPROVEN` = ERROR**; 404 `AUDIT_NOT_FOUND` |
| `POST /decisions/{id}` | `link_audit.decision.create` | INFO | `outcome` (`OK`/`REPLAYED`), `seq`, `ledgerCapacityLevel` | 201 / 200 (reenvio) |
| idem, recusa | `link_audit.decision.refused` | WARN | `code`, `issueCount` | 400 `INVALID_*`/`CONTRACT_REJECTED`/`FORBIDDEN_FIELDS`; 403 `OPERATOR_IDENTITY_INVALID`; 409 `HEAD_MISMATCH`, `SUPERSEDE_*`, `WRITE_CONFLICT`, `LIMIT_REACHED`, `LEDGER_*` (409); 409 `HISTORY_REGRESSED` = ERROR |
| idem, pendente | `link_audit.decision.pending` | WARN | `code`, `retryAfterSeconds` | **503 `ANCHOR_PENDING`** (gravada, não confirmada) |
| idem, armazenamento | `link_audit.storage.failure` | ERROR | `code`, `errno` | 503 `DECISIONS_DURABILITY_UNKNOWN`, `DECISIONS_STORAGE_UNAVAILABLE`, `ANCHOR_STORAGE_UNAVAILABLE`, `LEDGER_UNAVAILABLE`, `LEDGER_GUARD_UNAVAILABLE`, `*_NOT_CONFIGURED`, `DECISIONS_MISCONFIGURED`, `ORIGIN_KEY_NOT_CONFIGURED` |
| `POST /decisions/{id}/revocations` | `link_audit.decision.revoke` | INFO | `outcome`, `seq`, `ledgerCapacityLevel` | 201 / 200. Mesmos eventos de recusa/pendente/armazenamento. **Proibido: `reason`** |
| `POST /decisions/{id}/ledger` | `link_audit.ledger.action` | INFO / WARN | `action` (`ENROLL`/`RECOVER`/`ADOPT`/`RESTORE_ACK`/`QUARANTINE_ACK`), `ledgerState`, `ledgerReason`, `ledgerCapacityLevel`, `recoverable` | 200; 400 `LEDGER_ACTION_INVALID`; **403 `ADMIN_APPROVAL_UNAVAILABLE` = WARN** (tentativa de ação administrativa inexistente) |
| `GET /scoring/{id}` (prévia) | `link_audit.scoring.preview` | DEBUG / ERROR | `coverageStatus` (enum, se já existir na resposta), `blockerCount` | 200; 409 `READ_INCONSISTENT` (WARN, `Retry-After: 2`), `EVIDENCE_INTEGRITY`, `AUDIT_IDENTITY_MISMATCH` (ERROR) |
| `POST /scoring/{id}/finalize` | `link_audit.result.finalize` | INFO | `outcome` (`OK`/`REPLAYED`), `seq` | 201 / 200 |
| idem, recusa | `link_audit.result.refused` | WARN | `code`, `blockerCount`, `issueCount` | 409 `NOT_FINALIZABLE`, `INPUT_CHANGED`, `EVIDENCE_HASH_CHANGED`, `WEBSITE_DERIVATION_MISMATCH`, `RESULT_WRITE_CONFLICT`, `RESULTS_LIMIT_REACHED`, `RESULT_PENDING_UNCONFIRMED`. **Proibido: `blockers[]`, `head`** |
| idem, pendente | `link_audit.result.pending` | WARN | `code`, `retryAfterSeconds` | **503 `RESULT_ANCHOR_PENDING`** |
| idem, armazenamento | `link_audit.storage.failure` | ERROR | `code`, `errno` | 503 `RESULT_DURABILITY_UNKNOWN`, `RESULTS_STORAGE_UNAVAILABLE`, `RESULT_ANCHOR_STORAGE_UNAVAILABLE`, `RESULTS_NOT_CONFIGURED`, `RESULT_ANCHOR_NOT_CONFIGURED`, `RESULTS_MISCONFIGURED`, `ORIGIN_KEY_NOT_CONFIGURED` |
| `GET /scoring/{id}/results` e `/results/{seq}` | `link_audit.result.list` / `link_audit.result.get` | DEBUG / ERROR | `returned`, `staleLatest` (bool) | 200; 404 `RESULT_NOT_FOUND`; **409 `RESULT_INTEGRITY`, `RESULT_TRUNCATED`, `RESULT_ANCHOR_MISMATCH`, `RESULT_ANCHOR_INTEGRITY` = ERROR**; **409 `RESULT_PENDING_ORIGIN_UNPROVEN` = ERROR** |
| Evidências / decisões / pontuação: limitador | `link_audit.rate_limited` | WARN | `mode`, `retryAfterSeconds` | **429 `RATE_LIMITED`** |
| Evidências: armazenamento fora de `READY` | `link_audit.storage.failure` | ERROR | `code`, `reason` (enum do `storageStatus`) | 503 `EVIDENCE_STORAGE_UNAVAILABLE`, `EVIDENCE_NOT_CONFIGURED` |
| Qualquer rota: exceção não tratada | `link_audit.internal_error` | ERROR | `errorClass` (nome do tipo, p.ex. `TypeError`; **nunca** `message`/`stack`), `errno` | 500 `INTERNAL_ERROR` |
| Qualquer rota: corpo inválido | `link_audit.request.rejected` | DEBUG | `code` | 400 `INVALID_PARAMS`/`INVALID_JSON`/`INVALID_BODY`, 408, 413, 415 |

Observações:

1. **Um evento por requisição.** A rota emite exatamente um evento final (mais o `auth.denied` quando aplicável),
   no ponto único onde a resposta é montada (`reply`/`failureResponse`/`resultsFailureResponse`/`guarded`), não em cada
   ramo.
2. **Chave de classificação.** O mapeamento código para nível/evento vive em **uma tabela** no módulo de observabilidade
   (`CODE_SEVERITY`), com teste que falha se um código de `HTTP_STATUS`/`PREVIEW_HTTP_STATUS`/`RESULTS_HTTP_STATUS`
   não estiver classificado (novo código sem classificação quebra o build, em vez de virar silêncio).
3. A regra "409 em **leitura** = integridade quebrada, incidente" do checklist §6 é codificada pelo `mode` da rota:
   409 de integridade em `mode: 'read'` ⇒ ERROR; em `write`, os 409 de concorrência (`HEAD_MISMATCH`, `WRITE_CONFLICT`)
   são WARN.
4. Os eventos de dentro dos serviços (recuperação de pendente, aborto de operação vencida) não são emitidos pelo
   serviço, que continua puro: a rota deriva `ledgerState`/`openOperation`/`recoverable` do resultado. Se for preciso um
   evento interno, o serviço recebe uma porta opcional `observer` (§12, fatia 6), nunca o logger.

### 6.3 CLI

Os CLI já têm saída própria (`out`/`err`, `--json`, códigos de saída). **A saída existente não muda.** Adiciona-se, **no
stderr**, uma única linha JSON final por execução (não toca o stdout, para não corromper `--json`).

| Operação | Evento | Nível | Campos permitidos | Resultado (código de saída) |
|---|---|---|---|---|
| `link-audit:collect` (DRY_RUN) | `link_audit.cli.collect` | INFO | `correlationId`, `mode` (`DRY_RUN`), `exitCode`, `durationMs` | 0 plano ok; 1 uso inválido; 2 link não confirmável |
| `link-audit:collect --live` | `link_audit.cli.collect` | INFO / ERROR | `mode` (`LIVE`), `exitCode`, `mapsCalls` (número), `storedReport` (bool), `persistErrorCount`, `operatorRef`, `durationMs` | 0 ok; 3 recusa de orçamento/ambiente; 4 relatório não armazenado ou falha inesperada; 5 erros de persistência (`collect.ts:242-243,268-272`) |
| `link-audit:evidence persist/verify/report` | `link_audit.cli.evidence` | INFO / ERROR | `subcommand` (`persist`/`verify`/`report`), `exitCode`, `integrityStatus` (enum), `fileCount` (número), `durationMs` | 0 ok; 1 falha/uso (`evidence.ts:267-288`); 4 falha inesperada |

**Proibido no CLI (além do §6.1):** os valores de `--link`, `--name`, `--city`, `--operator`, `--from`, `--to`, `--dir`,
`--evidence-dir`, `--authorization-id` e o conteúdo das mensagens de erro (o CLI hoje imprime a mensagem do erro após
`redactUrlsInText`; isso permanece só no stdout/stderr humano, nunca no evento estruturado).

## 7. Identificador do operador sem PII

**Problema.** O e-mail é a identidade gravada nas decisões e resultados (contrato, não muda), mas o log não pode
conter e-mail. A sessão só carrega o e-mail (`SessionPayload.e`); **não existe id de usuário** (a autenticação não usa
o Supabase Auth), então a opção "id do Supabase Auth" **não está disponível** sem mudar o modelo de sessão.

### 7.1 Opções

| Opção | Como funciona | Prós | Contras | Rotação |
|---|---|---|---|---|
| **A. HMAC-SHA-256 do e-mail com chave dedicada de log**, truncado (p.ex. 12 hex) e prefixado com o id da chave (`k1:ab12...`) | `operatorRef = keyId + ':' + hex(HMAC(logKey, email_minúsculo)).slice(0,12)` | Estável entre execuções; não reversível sem a chave; **a chave é necessária** porque a lista de operadores é pequena (poucos e-mails) e um hash simples seria quebrado por dicionário; isola a chave de log das de sessão/origem/livro; o mesmo e-mail dá o mesmo valor no CLI e nas rotas | Novo segredo de ambiente (sem custo financeiro); sem a chave não há pseudônimo; hash truncado pode, em teoria, colidir (irrelevante para poucos operadores) | Mudar a chave muda os valores. O `keyId` no prefixo deixa claro qual chave gerou a linha; para correlacionar histórico, recalcula-se offline os poucos e-mails da lista com a chave antiga e a nova (ferramenta `scripts` offline, sem ler logs). Manter a chave antiga arquivada enquanto houver retenção de logs |
| **B. Derivar a chave de log da `SUPABASE_SERVICE_ROLE_KEY`** (como a sessão faz, `session.ts:5-6,39-42`) com contexto próprio (`gmn-linklog-v1:`) | Igual a A, sem variável nova | Nenhum segredo novo para operar | Acopla a rotação do log à da chave de serviço; a rotação dessa chave (que já derruba as sessões) também muda todos os pseudônimos, sem `keyId` próprio; ampliar o uso de um segredo muito sensível; no CLI a chave nem sempre está no ambiente | Junto com a chave de serviço; sem controle independente |
| **C. Pseudônimo estável sem segredo** (índice na lista `GMN_OPERATOR_EMAILS`, ou apelido configurado como `op1`, `op2`) | Mapa servidor-lado e-mail para apelido | Legível por humanos; nada derivável do e-mail; sem criptografia | Índice posicional **muda** ao reordenar/remover e-mail (reatribui o apelido a outra pessoa: perigoso); mapa configurado é dado novo a manter, com e-mail ao lado do apelido (é PII em configuração); lista vive em env que não deve ser impressa | Manual; risco de reatribuição |
| **D. Sem identificação do operador no log** | Só `correlationId` | Zero PII e zero segredo | Perde o "quem" exigido pelo método de engenharia; quem investiga precisa abrir o arquivo da decisão (que contém o e-mail) | n/a |
| **E. id do Supabase Auth** | `sub` do usuário | Padrão, sem segredo | **Indisponível**: a sessão não o tem; exigiria migrar a autenticação | n/a |

### 7.2 Recomendação (DECISÃO PENDENTE do responsável)

**Opção A**, com variável nova `GMN_LINK_AUDIT_LOG_KEY` (formato `<id>:<64 hex>`, mesmo estilo das demais chaves da
Fase 6) e estas regras:

- chave **ausente ou fraca ⇒ `operatorRef: "UNAVAILABLE"`** e o evento continua sendo emitido. **Nunca** cair para hash sem
  chave nem para o e-mail (falha fechada para PII, aberta para o log);
- normalizar o e-mail (minúsculas, `trim`) antes do HMAC, exatamente como a sessão (`session.ts:46`);
- `dev@localhost` (bypass de desenvolvimento) tem o mesmo tratamento;
- a chave de log **não** pode ser igual às de origem e do livro (mesma regra que o livro já aplica a si);
- não é segredo pago nem serviço novo; **não** altera `stack.yml`/`Dockerfile`/entrypoint nesta spec.
  A entrega por variável de ambiente de processo (como as demais); `docker secret`/`*_FILE` fica para quando o
  entrypoint for revisado (lista fixa do entrypoint, ver checklist).

Se o responsável não quiser segredo novo, a alternativa aceitável é a **B**, ciente do acoplamento de rotação. A **C**
não é recomendada pelo risco de reatribuição.

## 8. Correlation ID

### 8.1 Onde nasce

No **middleware** (`src/middleware.ts`), porque ele roda antes de qualquer rota e também responde 401/403/503 sozinho.
O middleware gera `crypto.randomUUID()` (disponível no Edge) e:

1. passa o valor à rota como cabeçalho de **requisição** `x-correlation-id` (`NextResponse.next({ request: { headers } })`);
2. devolve o mesmo valor no cabeçalho de **resposta** `X-Correlation-Id`, inclusive nas respostas que o próprio
   middleware produz (401/403/503, `NextResponse.json(...)` das linhas 30-34) e nos redirecionamentos de login;
3. nas rotas, o módulo de observabilidade lê o cabeçalho; **se ausente** (testes que chamam a rota diretamente, ou rotas
   fora do middleware), gera um `randomUUID()` local. Assim a rota funciona sem o middleware.

### 8.2 Cabeçalho vindo do cliente: entrada não confiável

**Recomendação: ignorar.** O middleware **sobrescreve** qualquer `x-correlation-id` recebido (a rota nunca confia no
valor que o cliente mandou). Motivos: ferramenta interna sem rastreamento distribuído a montante; aceitar o valor abre
injeção em log (quebra de linha, tamanho, conteúdo arbitrário) e falsificação de correlação para confundir uma
investigação. Alternativa, se o responsável quiser propagar IDs de cliente: aceitar **somente** se casar
`^[A-Za-z0-9-]{8,64}$`, gravando-o em campo **separado** (`clientRequestId`), nunca no lugar de `correlationId`.

### 8.3 Como chega aos serviços e ao CLI

- **Serviços (`link-audit-*`)**: **não recebem** o ID. Continuam puros. A rota (que já recebe o resultado tipado) é quem
  emite o evento com o ID. Se uma fatia futura precisar de eventos internos, passa-se o ID por uma porta `observer`
  injetada, não por `AsyncLocalStorage` global.
- **Resposta ao cliente**: o cabeçalho `X-Correlation-Id` (aditivo). Não se altera o corpo JSON dos erros da Fase 6
  (`{ error, code, ... }`), para não mudar o contrato; `apiFailure` de `src/lib/errors.ts` (que põe `correlationId` no
  corpo) segue como está e **não** é usado pela Fase 6.
- **CLI**: gera um `randomUUID()` no início da execução, usa-o na linha final do stderr (§6.3) e o **imprime** na saída
  humana do próprio CLI apenas quando for adicionado um campo à saída **sem alterar o JSON** (ver questão Q6; por padrão,
  só no stderr).
- **Limite**: o `correlationId` é aleatório, sem relação com operador, auditoria ou horário (não vira identificador
  indireto).

## 9. Métricas e alertas

### 9.1 Infraestrutura existente × inexistente

**Não existe** hoje: coletor de métricas, painel, alertador, agregador de logs nem canal de notificação
(checklist §5/§6: "monitoramento externo ainda não existe"). O limitador de requisições é em memória, por processo
(zera ao reiniciar, uma réplica não vê a outra), portanto contadores em memória têm a **mesma limitação**.

Por isso a spec define **sinais derivados do log** (a fonte é o evento da §6, linhas JSON no stdout do container) e, em
cada linha, diz o que **exige infraestrutura que não existe**. Nenhuma ferramenta paga é escolhida. Opções gratuitas
que o responsável pode avaliar (todas **inexistentes hoje**): `docker logs` + `jq` + `cron` com e-mail local/webhook
próprio; ou agregador de código aberto auto-hospedado (custo de operação da VPS, não de licença).

### 9.2 Mapa sinal para evento para alerta

| Sinal do checklist | Evento / campo | Condição de alerta sugerida | Severidade | Exige infraestrutura nova? |
|---|---|---|---|---|
| 409 de integridade em **leitura** (§6) | `link_audit.*.get/list` com `status=409` e `code` em `INTEGRITY_FAILED`, `DECISIONS_INTEGRITY`, `DECISIONS_TRUNCATED`, `ANCHOR_MISMATCH`, `ANCHOR_INTEGRITY`, `EVIDENCE_INTEGRITY`, `DECISIONS_HISTORY_UNRESOLVED`, `RESULT_INTEGRITY`, `RESULT_TRUNCATED`, `RESULT_ANCHOR_*`, `HISTORY_REGRESSED` | **Qualquer ocorrência** (limiar 1) | Incidente (P1) | Sim: alguém precisa ler o log e avisar |
| `ANCHOR_PENDING` / `RESULT_ANCHOR_PENDING` (§5) | `link_audit.decision.pending`, `link_audit.result.pending` | 1 ocorrência = informativo; **3 seguidas na mesma `auditId` em 10 min**, ou qualquer ocorrência com `pendingAgeSeconds > N` | Aviso, subindo a incidente em série (sintoma de volume de recibos inacessível, §6 último item) | Sim |
| `DURABILITY_UNKNOWN` (§12) | `link_audit.storage.failure` com `code` em `DECISIONS_DURABILITY_UNKNOWN`, `RESULT_DURABILITY_UNKNOWN`; `ledgerReason=DURABILITY_UNKNOWN` | Qualquer ocorrência | Incidente (P1): reiniciar só depois de investigar o disco | Sim |
| `*_ORIGIN_UNPROVEN` (§5) | `link_audit.decision.list`/`result.list` com `code` `PENDING_ORIGIN_UNPROVEN`, `RESULT_PENDING_ORIGIN_UNPROVEN` | Qualquer ocorrência | Incidente (P1): quarentena, possível adulteração ou chave trocada | Sim |
| `ENOSPC` / `EIO` / `EROFS` (§6) | `link_audit.storage.failure` com `errno` | `EIO`/`EROFS`: qualquer ocorrência (a base fica travada até reiniciar). `ENOSPC`: qualquer ocorrência | Incidente (P1) | Sim. **Pré-requisito de código:** confirmar que o `errno` chega ao ponto de log; se o serviço o descarta, é preciso expô-lo como enum (fatia 4). Espaço em disco a 80% (§6) é **medida do host, não do log**: exige coletor de disco que não existe |
| `ledger.capacity.level` (§12 R7-01) | `ledgerCapacityLevel` nos eventos de decisões/ledger | `REVOKE_ONLY`: aviso; `EXHAUSTED`: incidente (auditoria precisa de intervenção que o sistema não tem) | Aviso / Incidente | Sim. Só aparece quando alguém consulta a auditoria; **não há varredura periódica** de todas as auditorias (ver Q7) |
| Pendências antigas, > N min (§5; sugestão N=15) | `pendingAgeSeconds` (calculado no momento da leitura, a partir da data da pendente na vista pública, **sem** o caminho do arquivo) | `pendingAgeSeconds > 900` | Aviso | Sim: hoje só é visível na tela. Como é calculado **na leitura**, uma pendência que ninguém abre **não gera evento**; alerta confiável exige varredura periódica (Q7) |
| 429 (§6) | `link_audit.rate_limited` | **> 10 em 5 min** para o mesmo `operatorRef` | Aviso | Sim. Limitador em memória: o contador por processo zera ao reiniciar |
| 5xx | `link_audit.internal_error`, `link_audit.storage.failure` | Qualquer `INTERNAL_ERROR`; taxa de 5xx > 5% em 10 min | Incidente | Sim |
| `auth.denied` em série | `link_audit.auth.denied` | > 20 em 10 min | Aviso de segurança | Sim |

### 9.3 Métricas (contadores derivados do log)

Sem biblioteca nova: contagem por `jq`/script sobre as linhas JSON. Se um dia houver coletor, os mesmos nomes servem:
`link_audit_requests_total{route,status,code}`, `link_audit_request_duration_ms{route}`,
`link_audit_integrity_failures_total{route,code}`, `link_audit_pending_total{kind}`,
`link_audit_storage_failures_total{code,errno}`, `link_audit_rate_limited_total{mode}`,
`link_audit_ledger_capacity{level}`. **Rótulos nunca incluem** `operatorRef` nem `auditId` (cardinalidade e privacidade).

## 10. Critérios de aceite (cada um vira ao menos um teste automatizado)

Todos os testes rodam isolados (sem rede, Supabase, Redis ou Serper), com o logger substituído por um coletor em
memória e `console.*` espionado, como pedem `CLAUDE.md` e `testing.md`.

### 10.1 Eventos

- [ ] Dado uma escrita de decisão bem-sucedida (201), então exatamente **um** evento `link_audit.decision.create`
  INFO com `correlationId`, `route`, `status`, `outcome`, `operatorRef` e `auditId`.
- [ ] Dado um reenvio idempotente (200), então `outcome: "REPLAYED"`.
- [ ] Dado `ANCHOR_PENDING` (503), então `link_audit.decision.pending` WARN com `retryAfterSeconds` e a resposta HTTP
  idêntica à de hoje (corpo, status, `Retry-After`).
- [ ] Dado `RESULT_ANCHOR_PENDING`, idem para `link_audit.result.pending`.
- [ ] Dado cada código de `HTTP_STATUS`, `PREVIEW_HTTP_STATUS` e `RESULTS_HTTP_STATUS`, então existe classificação em
  `CODE_SEVERITY`; **o teste falha se um código novo não for classificado**.
- [ ] Dado um 409 de integridade em rota de **leitura**, então o evento é ERROR; o mesmo código em escrita segue a tabela.
- [ ] Dado `DECISIONS_DURABILITY_UNKNOWN`, `RESULT_DURABILITY_UNKNOWN`, `*_ORIGIN_UNPROVEN`, então ERROR.
- [ ] Dado `ledger.capacity.level` `REVOKE_ONLY`/`EXHAUSTED` na vista, então `ledgerCapacityLevel` aparece no evento.
- [ ] Dado erro com `errno` `ENOSPC`/`EIO`/`EROFS`, então `errno` está no evento como enum; outro `errno` vira `OTHER`.
- [ ] Dado uma exceção não tratada, então `link_audit.internal_error` com `errorClass` e **sem** `message` nem `stack`;
  a resposta continua `500 INTERNAL_ERROR` genérica.
- [ ] Dado 429, então `link_audit.rate_limited`; dado 401/403, então `link_audit.auth.denied` sem `operatorRef`.

### 10.2 Proibição de PII (teste de vazamento)

- [ ] **Teste "log não vaza"**: executa cada rota (sucesso e cada família de falha) com entradas-armadilha:
  e-mail do operador (`operador.teste@exemplo.com`), texto de justificativa (`JUSTIFICATIVA-SENTINELA-123`), link com
  parâmetros (`https://www.google.com/maps/place/Nome+Secreto/@-23.5,-46.6,17z?authuser=0&token=abc`), URL de site com
  query (`https://site.exemplo/?utm=SENTINELA`), um caminho de arquivo (a raiz temporária do teste) e uma chave de
  ambiente. Serializa **todo** o log capturado (`JSON.stringify` + o que foi para `console.log/warn/error`) e **falha**
  se contiver qualquer substring sentinela, o e-mail (também em maiúsculas e codificado em URL), `@` seguido de domínio
  em campo de identidade, `?`, `authuser`, a raiz temporária ou o valor da chave.
- [ ] **Teste de esquema fechado**: todo `metadata` emitido só tem chaves da lista permitida de §6.1/§6.2; chave extra
  (inclusive em objeto aninhado) falha o teste. Valores de string só podem ser enums conhecidos, `auditId` válido,
  `operatorRef` com formato `^(k\d+:[0-9a-f]{12}|UNAVAILABLE)$` ou `route` do conjunto de padrões.
- [ ] **Teste de tipo**: o tipo `LinkAuditEvent` não aceita campo fora da lista (verificado por `tsc` em arquivo de teste
  com `// @ts-expect-error`).
- [ ] `operatorRef` é determinístico para o mesmo e-mail (case-insensitive), diferente para e-mails diferentes e para
  chaves diferentes; sem chave ⇒ `UNAVAILABLE` e nunca contém parte do e-mail.
- [ ] O corpo de requisição e de resposta nunca é logado (teste com corpo grande contendo a sentinela).

### 10.3 Correlation ID

- [ ] O middleware devolve `X-Correlation-Id` (UUID v4) em 200, 401, 403, 503 e redirecionamentos.
- [ ] Um `x-correlation-id` enviado pelo cliente (inclusive com quebra de linha, 10 000 caracteres ou valor igual ao de
  outra requisição) **não** aparece em log nem na resposta.
- [ ] A rota chamada sem o middleware gera um ID local; dois pedidos distintos têm IDs distintos.
- [ ] CLI: dois comandos produzem `correlationId` distintos; o stdout (inclusive `--json`) é **byte a byte idêntico** ao de hoje.

### 10.4 Casos-limite

- [ ] **Falha do logger não altera a resposta nem a durabilidade.** Com `console.error` lançando, `JSON.stringify`
  falhando (objeto cíclico/`BigInt`) ou o logger lançando: a resposta HTTP (status, corpo, cabeçalhos) é igual à de
  referência; a decisão/resultado continua gravado e confirmado exatamente como sem falha (mesmos arquivos, mesmo
  recibo, mesmo `head`); nenhuma exceção sobe; o evento é descartado e, no máximo, um contador interno em memória
  (`droppedLogEvents`) é incrementado (sem novo log, para não gerar laço). O log é emitido **depois** da gravação, e a
  emissão **não é aguardada** de forma que possa atrasar ou reordenar o fluxo de durabilidade.
- [ ] **Volume em leituras longas.** Uma leitura de decisões/resultados que percorre até ~4000 registros (limite do
  livro; ~8 mil arquivos, ordem de 3 s) emite **no máximo 1 evento por requisição** (mais o de auth, se houver). Nenhum
  evento é emitido **por registro**, por arquivo ou por verificação interna. Teste: leitura sobre 4000 entradas
  sintéticas conta as chamadas de `emit` e exige `<= 2`. Leituras bem-sucedidas são DEBUG e **desligadas por padrão em
  produção** (nível mínimo `INFO`), logo o custo de logar uma leitura saudável é ~0.
- [ ] **Anti-tempestade.** Falhas repetidas (p.ex. `ANCHOR_PENDING` em série) são limitadas a **1 evento por
  (`code`, `auditId`) a cada 10 s** por processo; o excedente incrementa `suppressedCount`, emitido no próximo evento
  daquele par. O limitador é em memória, com tamanho máximo (descarta as chaves mais antigas), para não virar vazamento
  de memória.
- [ ] **Logs não são canal de caminhos.** Nenhum campo contém caminho absoluto, relativo, nome de arquivo de decisão/
  recibo/livro, nem `errno` com `path`. O `errno` é um enum de 4 valores; `errorClass` é nome de tipo; não se loga
  `message` de exceção (o `fs` coloca o caminho na mensagem). Teste: forçar `ENOSPC` em um arquivo sob a raiz temporária e
  conferir que a raiz não aparece no log serializado. As rotas **não** passam objetos de erro a `StructuredLogger`
  (`redactValue` converteria `Error` em `message`).
- [ ] **Limite de tamanho:** cada linha de log tem no máximo 2 KB (truncamento determinístico dos campos livres que
  restarem, que devem ser nenhum).
- [ ] **Sem efeito sobre contrato:** os testes existentes das rotas e dos serviços da Fase 6 passam **sem alteração**.
- [ ] **Fronteira de isolamento:** nenhum arquivo de `src/lib/link-audit-*/` (serviços) importa o logger; só
  `src/app/api/link-audit/**`, os scripts CLI e o módulo de observabilidade (teste por busca de imports).

## 11. Casos-limite e segurança

### 11.1 Falha do logger (regra de ouro)

O log é **melhor-esforço e subordinado** ao fluxo principal. O módulo `emit`: monta o evento, passa por
`sanitizeForLog`, envolve **tudo** (inclusive `JSON.stringify` e `console.*`) em `try/catch` que **engole** a falha de
logging (a única exceção à regra "nunca engolir erros" do `code-style.md`, justificada em comentário e contada em
`droppedLogEvents`). `StructuredLogger.emit` hoje **não** protege `JSON.stringify` nem `console.*` (`logger.ts:48-59`);
por isso a Fase 6 chama o logger **só** através do `emit` protegido.

### 11.2 `sanitizeForLog` (defesa em profundidade, além do esquema fechado)

Roda depois do tipo fechado, como última rede: remove qualquer string que case `/[^\s@]+@[^\s@]+\.[^\s@]+/` (e-mail),
contenha `?` seguido de `=` (query), comece com `/` ou `[A-Za-z]:\\` (caminho), ou seja maior que 200 caracteres.
Substitui por `[REDACTED]` e **conta** a ocorrência (`sanitizerHits`): um acerto em produção indica bug de código, não
uso normal, e é ele próprio um sinal para investigar. `redactValue` do projeto **não** cobre e-mail nem justificativa;
esta spec **não** altera `redact.ts` (outros módulos dependem dele).

### 11.3 Ameaças

- **Injeção em log**: `correlationId` gerado no servidor; nenhum campo livre do cliente entra no log.
- **Enumeração por log**: `auditId` e `operatorRef` não são rótulos de métrica; logs com retenção curta e acesso restrito
  ao operador de infraestrutura.
- **Reidentificação do pseudônimo**: mitigada pela chave dedicada (§7); sem a chave, dicionário sobre poucos e-mails seria
  trivial, por isso não existe a opção de hash sem chave.
- **Reversão de segredo**: a chave de log não é derivada nem reutilizada das demais.
- Se a superfície mudar materialmente, registrar em `docs/security/threats/link-audit-observability.md` (não criado
  por esta spec).

## 12. Plano de implementação (fatias pequenas)

Cada fatia é independente, entra com testes e não altera comportamento observável de negócio.

1. **Módulo `link-audit-observability`, sem uso**: tipos fechados, `emit` protegido, `sanitizeForLog`, `operatorRef`,
   `classifyErrno`, `CODE_SEVERITY` + testes de §10.2 (esquema, tipo, determinismo) e §10.4 (falha do logger).
2. **Correlation ID**: middleware gera, repassa e devolve `X-Correlation-Id` (200/401/403/503/redirect); leitura na rota
   com fallback. Testes de §10.3. Sem eventos ainda.
3. **Ponto único nas rotas de decisões**: `reply`/`failureResponse`/`withDecisions` emitem o evento final;
   `internal()` passa a emitir `link_audit.internal_error`. Teste "log não vaza" para decisões, revogações e livro.
4. **Resultados e prévia**: idem em `scoring/shared.ts` (`resultsFailureResponse`, `guarded`); expor `errno` como enum se
   o serviço hoje o descarta (mudança só de **campo de diagnóstico** no resultado de falha, sem tocar nos protocolos —
   avaliar antes; se exigir mexer no fluxo de gravação, **não fazer** e declarar o limite).
5. **Evidências e `parse`/`confirm`**: idem em `evidence/shared.ts` e rotas avulsas; anti-tempestade e limite de volume.
6. **CLI**: linha final no stderr + `correlationId` por execução; teste de stdout inalterado. (Opcional: porta `observer`
   nos serviços para eventos internos, só se algum alerta da §9 provar que precisa.)
7. **Runbook de monitoramento**: `docs/phase6-auditoria-link/` ganha uma seção com os comandos `docker logs | jq` para
   cada alerta da §9.2 e a decisão sobre varredura periódica (Q7). Atualização do checklist §5/§6 só **depois** que a
   fatia correspondente existir.

### O que NÃO muda

- **Protocolos de gravação e de leitura**: ordem decisão/entrada, recibo, livro, `fsync`, travas, `expectedHead`,
  recuperação de pendentes, verificação de integridade, origem HMAC e testemunha.
- **`src/lib/link-audit/scoring/`** (motor Lumos) e o mapeador.
- **Formatos persistidos** (decisões, recibos, resultados v1/v2, livro, manifestos) e a gravação do e-mail do operador
  neles.
- **Contrato HTTP**: corpos, códigos, mensagens públicas e `Retry-After`. Só se **acrescenta** `X-Correlation-Id`.
- **Saída e códigos de saída dos CLI** (stdout e `--json` idênticos).
- `src/lib/logger.ts` e `src/lib/redact.ts` (usados por outras áreas) e o limitador de requisições.
- Nenhum teste existente é alterado; nenhuma dependência npm nova; nenhum serviço pago.

## 13. Rollout

- Sem feature flag de negócio. Variável `GMN_LINK_AUDIT_LOG_LEVEL` (padrão `INFO` em produção, `DEBUG` em
  desenvolvimento) controla o volume de leituras; sem `GMN_LINK_AUDIT_LOG_KEY`, `operatorRef` fica `UNAVAILABLE`.
- Compatibilidade: clientes ignoram o cabeçalho novo.
- Rollback: remover as chamadas de `emit` (fatias independentes); nada persistido muda, então reverter não exige
  migração nem toca nos volumes.
- Nunca modificar `.env.local` automaticamente; a variável nova é documentada, não injetada.

## 14. Questões abertas

> **Decisões registradas em 16/11/2026** (o responsável adotou as recomendações do método AISAC): **Q1 = opção A**,
> **Q2 = ignorar o cabeçalho do cliente**, **Q3 = retenção de 90 dias** (prazo proposto, a confirmar na implantação). As
> demais questões seguem abertas.

- **Q1 — DECIDIDA (16/11/2026): opção A.** `operatorRef` = HMAC do e-mail normalizado com o segredo novo e exclusivo
  `GMN_LINK_AUDIT_LOG_KEY` (`<id>:<64 hex>`, prefixado pelo id da chave; nunca derivado da chave de serviço nem de outra
  chave da Fase 6; sem a chave, `UNAVAILABLE`). Motivo: sem dado pessoal em log e uma chave por finalidade (privilégio
  mínimo). Observação LGPD: HMAC é pseudonimização, não anonimização; o `operatorRef` continua dado pessoal (ver Q3).
- **Q2 — DECIDIDA (16/11/2026): ignorar** `x-correlation-id` do cliente; o id nasce sempre no servidor (Zero Trust).
- **Q3 — DECIDIDA EM PARTE (16/11/2026): retenção de 90 dias** para os logs da Fase 6, com expurgo automático
  (prazo proposto; confirmar na implantação). **Acesso decidido (16/11/2026, recomendação AISAC):** privilégio mínimo,
  só o responsável e quem opera o servidor. **Continua aberto:** onde os logs ficam (fora da VPS).
- **Q4:** `auditId` é um slug que casa `^[a-z0-9][a-z0-9_-]{7,63}$`; confirmar que **não é derivado do nome da empresa**
  nem do link (se for, tratá-lo como dado sensível e logar apenas um hash dele).
- **Q5:** `ENOSPC`/`EIO`/`EROFS`: o `errno` chega hoje ao ponto de decisão da rota? Se só vira `STORAGE_UNAVAILABLE`/
  `DURABILITY_UNKNOWN`, o alerta por `errno` só existe depois da fatia 4 (e talvez nunca, sem tocar nos protocolos).
- **Q6:** imprimir o `correlationId` na saída humana do CLI? (Por padrão, só no stderr, para não mudar a saída.)
- **Q7:** pendência "antiga" e `ledger.capacity.level` só são observados quando alguém consulta. Aceitar essa limitação
  ou criar uma **varredura periódica** (script `ops` somente leitura, sem Serper nem rede), o que é código novo e
  infraestrutura de agendamento que não existe?
- **Q8:** quem recebe os alertas e por qual canal (não existe canal definido); qual **N** de minutos para pendência
  (checklist sugere 15).
- **Q9:** deve o `auth.denied` ser emitido no middleware (Edge, com `console`) ou só nas rotas? O middleware também
  bloqueia páginas e `/audits/*`, fora da Fase 6.
- **Q10:** as rotas de login/logout (`/api/auth/*`) ficam fora desta spec; precisam da mesma regra de PII (hoje a
  mensagem de falha de login pode citar o e-mail?), fora do escopo desta Fase.

## 15. Referências

- `docs/phase6-auditoria-link/onda6c-checklist-producao.md` §5 (recuperação), §6 (monitoramento), §12 e notas finais
  (capacidade do livro, `DURABILITY_UNKNOWN`, custo de leitura ~3 s com ~3990 registros).
- `src/lib/logger.ts`, `src/lib/redact.ts`, `src/lib/errors.ts`, `src/middleware.ts`, `src/lib/auth/*`.
- `src/app/api/link-audit/**/shared.ts` (pontos únicos de resposta), `HTTP_STATUS` em
  `src/lib/link-audit-decisions/service.ts`, `RESULTS_HTTP_STATUS` em `src/lib/link-audit-scoring-runs/results.ts`.
- Regras do projeto: `CLAUDE.md` (Security by Design: nunca logar PII; sem `any`; sem chamadas externas em testes).
- ADR: nenhum ainda; recomenda-se um ADR curto para a decisão Q1.
