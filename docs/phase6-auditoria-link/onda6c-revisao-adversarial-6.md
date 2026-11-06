# Onda 6C — 6ª revisão adversarial independente (específica do LIVRO DE CABEÇAS), 02/11/2026

> Relatório do revisor **preservado verbatim** abaixo (snapshot da árvore antes das correções R6-01..R6-03). A disposição de cada achado está em `onda6c-especificacao-livro-de-cabecas.md` §16.11. Os testes do revisor (`zz-rv6-*`) e os logs de mutação ficam fora do repositório, em `~/gmn-review-evidence-2026-10-31/round6-review/`.

# Revisão adversarial independente nº 6 — Livro de cabeças (Onda 6C)

Revisor: agente independente (sem acesso a rede, VPS, Redis, Supabase, Serper, `.env*`). Snapshot revisado: `$R/proj` (congelado; `src/` não foi alterado — `diff -rq proj/src mut/src` idêntico depois das mutações).
`$R` = `/tmp/claude-1000/-mnt-d-gmn-intelligence-platform-corrigido-gmn-intelligence-platform/dc0f56dc-9cae-4e32-bb13-6423658e8862/scratchpad/review-r6`.
Meus testes: `$R/proj/tests/zz-rv6-*.test.ts` (+ `$R/proj/tests/helpers/zz-rv6-child.ts`). Rodar: `cd $R/proj && node --require ./tests/register-typescript.cjs --test tests/zz-rv6-X.test.ts`.
Mutações: cópia em `$R/mut` (script `$R/mutate.py`; logs `$R/mutation-run1.log` e `$R/mutation-run2.log`).

Convenção: "reproduzido" = saída de um teste MEU colada abaixo. "Hipótese" = não reproduzido. Vários testes `zz-rv6-*` **passam apesar de documentarem um defeito** (eles só imprimem o comportamento observado); os que **falham de propósito** (reprodução do defeito) são `zz-rv6-rotation` (ROT-B e ROT-C). Resumo: `$R/my-tests-summary.txt`.

---

## (a) Resumo e VEREDITO

**VEREDITO para o livro de cabeças: APROVADO COM RESSALVAS** (como incremento local, sem commit, sem implantação).

- **Integridade: não consegui quebrá-la** com as capacidades de atacante modeladas (1 ou 2 pastas; com ou sem resultados; sem a chave do livro). A única forma de reativar uma decisão revogada que consegui foi reverter as **três** pastas (decisões + recibos + livro) sem resultados e sem guarda — exatamente o limite que a documentação declara (e trava em teste). Cobertura da etiqueta HMAC: 126 folhas de 7 tipos de registro mutadas e re-seladas, todas detectadas. Varredura de SIGKILL em **20** pontos de uma revogação: nenhum estado "revogada vigente", nenhuma duplicação, todos recuperáveis pelo autor.
- **Nenhum BLOCKER novo de integridade.** Os dois bloqueadores de produção já declarados continuam valendo e **não são afetados pela implementação**: (1) guarda externa imutável inexistente (só adaptador sintético); (2) inexistência do caminho administrativo (ADOPT/RESTORE_ACK/QUARANTINE_ACK), o que torna **permanente** qualquer congelamento.
- **2 MAJOR (disponibilidade/recuperação, falham fechado mas sem saída)** que devem ser corrigidos antes de qualquer implantação:
  - **R6-01** limite de 4000 registros: com a paridade errada o `INTENT` cai no registro 4000, a decisão **é publicada e recebe recibo**, o `CONFIRMED` (4001) é impossível, a resposta diz "nada foi gravado" (falso) e a auditoria fica congelada para sempre; a razão `LIMIT_REACHED` nunca é emitida e não há reserva para revogar.
  - **R6-02** rotação planejada: `needsCheckpoint` não grava o CHECKPOINT da chave nova quando o último CHECKPOINT é da chave antiga e nada da chave antiga vem depois; o passo (3) do runbook (§7) não protege, o estado segue `PROTECTED`, e quando a chave antiga vence a auditoria vira `KEY_EXPIRED` sem reabertura possível.
- **6 MINOR**: R6-03 (vazamento de caminho absoluto), R6-04 (fase C "roubada" de um dono vivo → erro falso), R6-05 (recuperação ignora a testemunha dos resultados e torna o `ledgerHead` irrecuperável), R6-06 (chave aposentada autentica registros NOVOS), R6-07 (falha de `fsync` de diretório engolida, contra o §12), R6-08 (legado × livro removido indistinguíveis, tela diz "nunca foi adotada").
- **INFO**: R6-09 a R6-13 (reversão/sobreposição de versão antiga congela auditoria inscrita; guarda aceita "sem registro"; imprecisões de documentação; `ledger?` opcional em `appendEntry`; ausência de saída após comprometimento).
- **Qualidade dos testes**: 39 mutações; 33 mortas, **6 sobreviventes** (M10, M22, M25, M29, M34, M38), 3 delas defesa em profundidade/equivalentes, 3 lacunas reais (M25, M29, M38). Um teste do implementador ("5 PROCESSOS escrevem ao mesmo tempo…") **falha sob carga de CPU** (falhou em 6 execuções de mutação enquanto eu rodava outros testes em paralelo; passa 83/83 em máquina ociosa) — frágil.

---

## (b) Achados

### R6-01 — MAJOR — Limite de 4000 registros: o `INTENT` pode cair em 4000 e o `CONFIRMED` é impossível; mensagem falsa; sem reserva para revogar
- **Descrição.** `MAX_LEDGER_RECORDS = 4000` (`src/lib/link-audit-ledger/types.ts:15`, `ledgerSeq … .max(4000)` em `:66`). O protocolo exige **dois** registros por operação (INTENT e CONFIRMED) mais CHECKPOINTs, mas nada reserva espaço para o segundo. Se o livro tem 3999 registros e a cauda é curta (< 64 desde o último CHECKPOINT, logo sem CHECKPOINT novo), o `INTENT` vira o registro **4000**, a entrada e o recibo são **publicados** (`src/lib/link-audit-decisions/store.ts:418-427` → publicação → recibo), e o `CONFIRMED` (4001) é recusado pelo **esquema** (`service.ts:177-178`), que devolve `LEDGER_UNAVAILABLE` com a frase "O registro do livro não segue o contrato (erro interno); **nada foi gravado**" — falsa: decisão e recibo existem. O estado fica `HISTORY_UNRESOLVED/LEDGER_BEHIND` com `recoverable:true`, mas `RECOVER` e o reenvio falham sempre pelo mesmo motivo. Se a operação fosse uma **revogação**, a auditoria fica sem poder sequer ser revogada (contraria o princípio da 6B `RESERVED_FOR_REVOCATIONS`). A razão `LIMIT_REACHED` (§16.2, `MESSAGES`, UI) **nunca é emitida**: a leitura de >4000 arquivos cai em `UNTRUSTED` (`service.ts:108`) e a escrita no 4001º cai no erro de esquema.
- **Impacto.** Disponibilidade permanente da auditoria (sem caminho administrativo); resposta enganosa ao operador; ~1 de 2 auditorias que chegam ao limite (a paridade depende do número de CHECKPOINTs). Alcançável só com ~1950 operações numa auditoria (a 6B permite 9999), logo é improvável hoje, mas é determinístico.
- **Reprodução.** `tests/zz-rv6-limit.test.ts` (constrói no disco um livro real-assinado de 3999 registros coerente com 1950 decisões):
```
# estado antes: {"state":"PROTECTED",...,"head":{"ledgerSeq":3999,...},"confirmed":1950}
# create -> {"ok":false,"code":"LEDGER_UNAVAILABLE","issues":["O registro do livro não segue o contrato (erro interno); nada foi gravado."]}
# arquivos: decisão 1951: true  recibo 1951: true  livro: 4000
# estado depois: {"state":"HISTORY_UNRESOLVED","reason":"LEDGER_BEHIND","recoverable":true,"phase":"C","decisions":0,"finalizable":false}
# RECOVER -> {"ok":false,"code":"LEDGER_UNAVAILABLE","issues":["O registro do livro não segue o contrato (erro interno); nada foi gravado."]}
# reenvio -> {"ok":false,"code":"LEDGER_UNAVAILABLE",...}
```
  Com exatamente 4000 registros a escrita é recusada **antes** de publicar (correto), mas com o mesmo código/mensagem "erro interno".
- **Recomendação.** Recusar o `INTENT` quando `ledgerSeq + 2 > MAX` (reserva de 2, e de pelo menos mais 2–4 registros só para revogação/ABORTED/CHECKPOINT); emitir `LIMIT_REACHED` de fato (código e mensagem fixos) e mapear a leitura de >4000 para `LIMIT_REACHED` em vez de `UNTRUSTED`; teste de limite nos dois lados da paridade; considerar subir o limite ou compactar via CHECKPOINT.

### R6-02 — MAJOR — Rotação planejada: o CHECKPOINT da chave nova não é gravado quando o último registro da chave antiga é um CHECKPOINT; a auditoria "morre" quando a antiga vence
- **Descrição.** `needsCheckpoint` (`src/lib/link-audit-ledger/model.ts:140-146`) olha só a **cauda depois do último CHECKPOINT** (`records.slice(lastCheckpoint)`) e pede um novo se houver `kid ≠ atual` nela. Se o último CHECKPOINT é da chave antiga (K1) e **nada de K1 vem depois**, a cauda está vazia (ou só tem K2) e nenhum CHECKPOINT de K2 é gravado. Quando K1 vence, os registros de K1 (inclusive o CHECKPOINT de K1, que deixa de ser `PROVEN`) ficam `KEY_EXPIRED` sem cobertura ⇒ `HISTORY_UNRESOLVED`, sem reabertura (admin bloqueado). O runbook §7 passo (3) afirma que "a primeira operação depois da rotação grava um CHECKPOINT assinado pela chave nova que cobre…" — falso neste caso, e o estado enquanto isso é `PROTECTED` (o operador não vê nada errado). Condição de disparo estreita (o último registro antes da rotação ser um CHECKPOINT: acontece quando o 64º registro é atingido por um `RECOVER` ou por um pedido **rejeitado** depois do `prepare`, e a auditoria fica ociosa), mas o dano é silencioso e irreversível.
- **Reprodução.** `tests/zz-rv6-rotation.test.ts` (`checkpointEvery: 3` só para atingir o caso rápido; a lógica é a mesma com 64):
```
# (ROT-A, controle: há registros de K1 depois do CHECKPOINT)  após o vencimento da K1: PROTECTED
# (ROT-B) antes da rotação: ["GENESIS","INTENT","CONFIRMED","CHECKPOINT"]
# após o RECOVER do runbook: [... "CHECKPOINT"] kids: ["lk-test-a","lk-test-a","lk-test-a","lk-test-a"] estado: PROTECTED
# após o vencimento da K1: {"state":"HISTORY_UNRESOLVED","reason":"KEY_EXPIRED","vig":0}
# (ROT-C, com ESCRITA bem-sucedida de K2 depois da rotação)
# eventos/kids: ["GENESIS:lk-test-a","INTENT:lk-test-a","CONFIRMED:lk-test-a","CHECKPOINT:lk-test-a","INTENT:lk-test-b","CONFIRMED:lk-test-b"]
# após o vencimento: {"state":"HISTORY_UNRESOLVED","reason":"KEY_EXPIRED","vig":0}
```
- **Recomendação.** `needsCheckpoint` deve ser verdadeiro sempre que **existir algum registro não coberto por CHECKPOINT assinado pela chave ATUAL** com `kid ≠ atual` (incluindo o próprio último CHECKPOINT antigo); ou gravar um CHECKPOINT de K2 na primeira operação após `begin` quando `records.some(kid≠atual)` e o último CHECKPOINT não é da chave atual. Acrescentar ao runbook uma verificação (`GET` mostrar "cobertura da chave atual") em vez de confiar no passo (3). Teste: rotação com CHECKPOINT no fim, e rotação logo depois de um pedido rejeitado no 64º registro.

### R6-03 — MINOR — Caminho absoluto do disco vaza na resposta 503 `LEDGER_UNAVAILABLE`
- **Descrição.** `LEDGER_UNAVAILABLE` está em `DETAILED` (`src/lib/link-audit-decisions/service.ts:208`) e `service.ts:187` do livro copia `published.issues` (de `describeError`, `src/lib/link-audit/snapshot-store.ts:152-155,373`) — mensagem nativa do Node com caminho. O teste do implementador de vazamento só cobre erros sem caminho.
- **Reprodução.** `tests/zz-rv6-leak.test.ts` (pasta da auditoria no livro sem permissão de escrita; resposta da ROTA `POST /api/link-audit/decisions/{id}`):
```
# ROTA -> 503 {"error":"O livro de cabeças não pôde ser gravado. ...","code":"LEDGER_UNAVAILABLE","issues":["escrita do temporário: EACCES EACCES: permission denied, open '/tmp/lad-led-hv2BaU/auditoria-teste-0001/.tmp-l000002.json-5875b46694516300'"]}
# vazamentos na ROTA: ["/tmp/lad-led-hv2BaU","/tmp/","EACCES","permission denied","l000002"]
```
- **Impacto.** Divulga a topologia do volume a operadores autenticados (baixo). Contradiz a declaração "Vista pública do livro (sem … caminhos …)" do tipo `LedgerView` e o próprio teste "nunca trazem caminhos".
- **Recomendação.** Não repassar `published.issues`/`ensured.issues` ao cliente; usar frase fixa por código (`ATOMIC_WRITE_UNAVAILABLE`, `STORAGE_FATAL`, …); teste com `EACCES`/`ENOSPC`/`EROFS` reais.

### R6-04 — MINOR — Fase C é "roubada" de um dono vivo: o dono recebe erro apesar de a decisão estar confirmada; o CONFIRMED sai com o `actor` de outro operador
- **Descrição.** `prepare` completa o `CONFIRMED` faltante (fase C) imediatamente (`ledger/service.ts:230-244`; `model.ts:264-273`), sem esperar nem distinguir "dono morto" de "dono vivo entre o recibo e o CONFIRMED" (a espera de 120 s só existe na fase A). Isso acontece em **qualquer** pedido de escrita de outro processo — até em um pedido que será rejeitado (`prepare` roda antes de `build`). O dono vivo então perde a corrida do `link()` e `confirmed()` devolve `LEDGER_UNAVAILABLE` ("Outro processo alterou o livro… reenvie", `service.ts:300`). Contradiz §16.5 ("o perdedor relê e vê a operação aberta do vencedor").
- **Reprodução.** `tests/zz-rv6-concurrency.test.ts` ("dono VIVO", 2 processos reais; o dono pausa 6 s antes do `CONFIRMED`):
```
# entrada de A publicada? true recibo de A? true
# A -> {"ok":false,"code":"LEDGER_UNAVAILABLE"}  B -> {"ok":false,"code":"SUPERSEDE_REQUIRED"}
# livro: ["GENESIS(ana)","INTENT(ana)","CONFIRMED(bia)"]
```
  (B nem gravou nada seu e ainda assim assinou o CONFIRMED da decisão de A.)
- **Impacto.** Sem perda de integridade (o CONFIRMED é determinístico e o reenvio é idempotente); resposta de erro falsa e atribuição confusa no registro de auditoria. Só ocorre com ≥ 2 processos escritores (hoje `replicas:1`, mas o desenho declara suportar).
- **Recomendação.** Na fase C, esperar um tempo curto (como na fase A) antes de completar quando a idade do INTENT for pequena, ou registrar `actor:"system"`/o autor; e fazer `confirmed()` reler o livro e devolver sucesso se o `CONFIRMED` idêntico já existe.

### R6-05 — MINOR — A recuperação automática ignora a testemunha dos resultados e torna o `ledgerHead` irrecuperável
- **Descrição.** Em `evaluateProtection`, o ramo `D.length > L.length` retorna `LEDGER_BEHIND` (`model.ts:264-273`) **antes** de conferir `results.ledgerHeads` (`:287-292`). Se alguém que só escreve no livro (A4) apaga o último `CONFIRMED` que um resultado v2 cita, a visão diz `recoverable:true`/`LEDGER_BEHIND`; qualquer escrita ou `RECOVER` grava um `CONFIRMED` **novo** (hora/`actor` diferentes ⇒ hash diferente) e só então aparece `RESULT_LEDGER_MISMATCH` — e a operação "falha" mas o livro já foi alterado; restaurar o registro original do backup exige remover o novo à mão.
- **Reprodução.** `tests/zz-rv6-results-witness.test.ts` (primeiro teste):
```
# VIEW antes do RECOVER: {"state":"HISTORY_UNRESOLVED","reason":"LEDGER_BEHIND","recoverable":true,"witness":"CONSISTENT"}
# RECOVER -> {"ok":false,"code":"DECISIONS_HISTORY_UNRESOLVED","issues":["livro: RESULT_LEDGER_MISMATCH",...]}
# events: ["GENESIS","INTENT","CONFIRMED"] novo hash difere do citado: true
# VIEW depois: {"state":"HISTORY_UNRESOLVED","reason":"RESULT_LEDGER_MISMATCH"}
```
- **Impacto.** Piora a recuperação humana (evidência original não pode voltar ao mesmo nome) e a UI oferece "Concluir recuperação verificável" para uma situação contradita por uma testemunha. Disponibilidade, não falsificação.
- **Recomendação.** Conferir `results.ledgerHeads`/`unverifiedLedgerHeads` **antes** de aplicar `COMPLETE_CONFIRMED` (simular o CONFIRMED novo contra as citações); se alguma citação cai na posição a ser escrita, não recuperar.

### R6-06 — MINOR — "Aposentada só verifica" não é verdade para registros NOVOS
- **Descrição.** `verifyTags` (`model.ts:120-137`) aceita como `PROVEN` qualquer registro assinado por chave aposentada **ainda válida** (até 93 dias), em qualquer posição — inclusive depois do CHECKPOINT da chave nova. A especificação (§16.6) e o runbook dizem que a aposentada "só verifica".
- **Reprodução.** `tests/zz-rv6-crypto.test.ts` (teste 4):
```
# registros forjados com K1 APÓS o CHECKPOINT de K2 -> verifyTags = null     (aceitos)
```
  Com K1 **revogada** tudo é `KEY_REVOKED` (controle no mesmo teste).
- **Impacto.** Quem furtou K1 sem que ninguém saiba (o motivo mais provável de rotação) segue forjando INTENT/ABORTED/CONFIRMED por até 93 dias; a "rotação planejada" não encerra essa superfície. É o limite L3 estendido, mas a documentação dá a entender o contrário.
- **Recomendação.** Rejeitar registro de chave aposentada posicionado depois do primeiro registro (ou CHECKPOINT) da chave atual (kid monotônico: uma vez que a chave atual assinou, a antiga não pode mais aparecer); declarar no runbook que a janela de comprometimento de K1 só fecha com a revogação.

### R6-07 — MINOR — Falha de `fsync` de diretório é engolida; o §12 diz que é "tratada como falha de durabilidade"
- **Descrição.** `publishExclusive` faz `await bestEffort(() => ops.syncDirectory(dir))` (`src/lib/link-audit/snapshot-store.ts:405`), usado por `publishLedgerRecord`. A especificação §12 (tabela, linha "Sistema de arquivos") diz que `fsync` do arquivo **e do diretório** são "tratados como falha de durabilidade quando falham". É o P-4 já conhecido, mas para o livro a cadeia INTENT→entrada→recibo→CONFIRMED depende de cada diretório estar durável antes do próximo passo.
- **Reprodução.** `tests/zz-rv6-durability.test.ts`:
```
# create com fsync(diretório) falhando em tudo -> SUCESSO  chamadas de syncDirectory que falharam: 5  livro: ["GENESIS","INTENT","CONFIRMED"]
# estado: PROTECTED vigentes: 1
```
- **Impacto.** Após queda de energia, o último passo reconhecido ao operador pode não existir em disco, em pastas diferentes de forma desigual. Consequências ainda falham fechadas (INTENT perdido + entrada presente ⇒ `UNLEDGERED_ENTRY`; CONFIRMED perdido ⇒ `LEDGER_BEHIND`), exceto a perda simultânea do último passo nas **três** pastas, que parece uma operação nunca feita.
- **Recomendação.** Para o livro (e, idealmente, decisões/recibos), tratar erro de `fsync` de diretório como falha da operação (`STORAGE_FATAL`) ou corrigir a frase do §12; manter o ensaio de queda em homologação.

### R6-08 — MINOR — Livro removido sem testemunha é rotulado como "histórico anterior ao livro e nunca foi adotada"
- **Descrição.** Pasta da auditoria no livro removida, ou volume substituído por um vazio, **sem** resultado v2 nem guarda ⇒ `LEGACY_READ_ONLY/LEDGER_ABSENT_WITH_HISTORY` (`model.ts:222-225`), e a UI diz "a auditoria tem histórico anterior ao livro e nunca foi adotada" (`pending-panels.tsx:245`). Não distingue "nunca protegida" de "protegida e apagada" (a regra de ouro Q1 só dispara com testemunha).
- **Reprodução.** `tests/zz-rv6-states.test.ts` (teste 2):
```
# livro da auditoria removido: {"state":"LEGACY_READ_ONLY","reason":"LEDGER_ABSENT_WITH_HISTORY",...,"vig":0,"fin":false}
# raiz do livro ausente:       {"state":"HISTORY_UNRESOLVED","reason":"UNAVAILABLE",...}
# volume novo vazio:           {"state":"LEGACY_READ_ONLY","reason":"LEDGER_ABSENT_WITH_HISTORY",...}
```
- **Impacto.** Falha fechada (nada vigente, nada gravável), mas a explicação ao operador pode ser falsa, e uma futura adoção administrativa "automática" legitimaria uma remoção. Um único `rm -rf` (A4) rebaixa qualquer auditoria `PROTECTED` a "legada".
- **Recomendação.** Texto neutro ("o livro desta auditoria está ausente; pode nunca ter existido ou ter sido removido; não há como distinguir sem fonte independente"); registrar na guarda/arquivo irmão a existência do livro (ex.: marcador em volume de resultados/guarda) para separar os casos quando houver provedor.

### R6-09 — INFO — Escritor de versão antiga (rollback de imagem ou sobreposição de réplicas) congela a auditoria inscrita para sempre
- **Reprodução.** `tests/zz-rv6-states.test.ts` (teste 3): serviço **sem** livro sobre as mesmas pastas grava depois do `ENROLL`:
```
# após escrita antiga: {"state":"HISTORY_UNRESOLVED","reason":"UNLEDGERED_ENTRY","recoverable":false,...}
# RECOVER -> {"code":"DECISIONS_HISTORY_UNRESOLVED","issues":["livro: UNLEDGERED_ENTRY","Há decisão confirmada que o livro nunca registrou."]}
```
- **Impacto.** Falha fechada, sem saída (admin bloqueado). O item de rollback do checklist (`onda6c-checklist-producao.md:99`) assume que "nada está em produção" e só trata do esquema `origin`/v2; a imagem pré-livro (que **lê e escreve** a pasta de decisões) não é mencionada. Atenção a `update_config order: start-first` no Swarm.
- **Recomendação.** Declarar no checklist/PLANO-DE-ROLLBACK: depois do primeiro `ENROLL` não se volta a imagem pré-livro nem se admite réplica antiga; atualizar com `stop-first`.

### R6-10 — INFO — Contrato da guarda externa frouxo para o adaptador real
- `latest()` com `ok:true, head:null` é tratado como "atrasada" (`model.ts:297`) para um livro de qualquer tamanho, e o próximo `prepare` republica a cabeça atual: uma guarda que "esquece" (prefixo errado, ciclo de vida do bucket, serviço novo) é aceita e **re-inicializada** a partir de um estado possivelmente revertido. Reproduzido com o adaptador sintético (`tests/zz-rv6-guard.test.ts`, último teste): `{"state":"PROTECTED",…,"guard":"BEHIND","vig":["op-0001"]}` depois de reverter as três pastas **e** apagar a pasta da auditoria na guarda. Além disso, `BEHIND` não tem limite de atraso e o resultado de `publishGuard` após `CONFIRMED`/`ABORTED`/`REISSUED` é ignorado (`ledger/service.ts:241,254,290,302`); só a escrita seguinte falha.
- **Recomendação** (para a etapa E4): `head:null` só é aceitável com livro em `ledgerSeq ≤ 1`/GENESIS; limitar o atraso a 1–2 registros; distinguir "nunca publicou" de "esqueceu" no contrato da porta.

### R6-11 — INFO — Imprecisões na documentação (nos dois sentidos)
- **Subdeclara a detecção** (§3 A7, §16.9, checklist): "escrita em ≥ 2 pastas incluindo o livro" não é detectada. Na matriz abaixo, pares (decisões+livro, recibos+livro, decisões+recibos) são detectados porque a terceira pasta contradiz; só **três** pastas (ou livro + a pasta que o contradiz) reativam. Impreciso para o lado seguro.
- **Superdeclara**: "só livro: truncar … ⇒ `UNTRUSTED`" (`onda6c-modelo-de-ameacas-recuperacao.md` §8b): truncar a cauda produz `UNLEDGERED_ENTRY`/`LEDGER_BEHIND`, e **apagar só registros de cauda que não são CONFIRMED (CHECKPOINT, ABORTED, RECEIPT_REISSUED) não gera alarme** (`tests/zz-rv6-tailtrunc.test.ts`: `antes:[GENESIS,INTENT,CONFIRMED,CHECKPOINT] depois:[GENESIS,INTENT,CONFIRMED] estado: PROTECTED`). Inofensivo para decisões, mas é perda silenciosa de evidência (p.ex. o ABORTED que explica `PUBLISHED_AFTER_ABORT`).

### R6-12 — INFO — Obrigatoriedade do livro é por convenção
- `WriteOptions.ledger` é **opcional** (`src/lib/link-audit-decisions/store.ts:64`): `appendEntry` sem `ledger` grava sem `begin/prepare/intent`. Só `service.ts` chama `appendEntry` e só passa sem livro para `LEDGER_NOT_REQUIRED`. O teste estático (`tests/link-audit-decisions-witness-rotation.test.ts:258-283`) garante que `LEDGER_NOT_REQUIRED` só aparece em porta/serviço/índice e que as rotas passam `knownHeads, ledger`, mas por regex; nada impede um novo chamador de `appendEntry`. **`LEDGER_NOT_REQUIRED` não é alcançável por configuração/ambiente** (é um símbolo de código; `ledgerForRoutes` só devolve serviço real ou `createUnconfiguredLedger`; matriz de 31 configurações defeituosas em `tests/zz-rv6-config.test.ts`, todas 503/409 sem gravar nada).
- **Recomendação.** Tornar `ledger` obrigatório no tipo de `appendEntry` com variante explícita para a 6B isolada; teste estático que proíba importar `appendEntry` fora do serviço.

### R6-13 — INFO — Sem saída administrativa, qualquer incidente de chave ou de rotação é congelamento permanente de TODAS as auditorias protegidas
- Declarado no runbook §7 e no checklist, mas com R6-02 e R6-01 há caminhos **não intencionais** para o mesmo beco. Tratar o procedimento administrativo (ou ao menos um "readopt" offline assistido por script e fonte independente) como **pré-requisito de produção** junto à guarda externa.

### R6-14 — Qualidade dos testes (ver seção (e))
- Lacunas reais: M29 (escrita aceita em `RESULT_LEDGER_MISMATCH`), M25 (separação HKDF por propósito), M38 (nomes suspeitos na pasta do livro), M22/M34 (defesa em profundidade sem teste que as distinga). Teste de concorrência frágil sob carga.

---

## Cenários de atacante (foco 2) — o que quebra e se está declarado

| Quem escreve | Resultado observado (meus testes) | Declarado? |
|---|---|---|
| só recibos | `RECEIPT_REMOVED`, nada vigente (`zz-rv6-attacks`) | sim |
| só decisões | `DECISIONS_TRUNCATED` (erro 6B), nada vigente | sim (código diferente do citado no §8b) |
| decisões+recibos (a "janela") | `HISTORY_REGRESSED`, nada vigente — inclui backup antigo e "mover pastas" | sim (fechado) |
| só livro: trunca INTENT+CONFIRMED | `UNLEDGERED_ENTRY` (congela) | parcialmente (doc diz `UNTRUSTED`) |
| só livro: trunca só o CONFIRMED | `LEDGER_BEHIND` → recuperação automática (R6-05) | não |
| só livro: apaga a pasta da auditoria | `LEGACY_READ_ONLY` (R6-08) | parcialmente |
| só livro: apaga CHECKPOINT/ABORTED da cauda | **sem alarme** (R6-11) | não |
| livro + decisões (sem tocar recibos) | `DECISIONS_TRUNCATED` (detectado) | doc diz "não coberto" (superdeclara o risco) |
| livro + recibos | `UNLEDGERED_PENDING` (detectado) | idem |
| **livro + decisões + recibos, sem resultado e sem guarda** | **`PROTECTED`, decisão revogada volta (não detectado)** | **sim (limite declarado, travado)** |
| as 3 pastas **com** guarda sintética | `GUARD_MISMATCH` | sim (só com provedor real) |
| as 3 pastas + guarda apagada | `PROTECTED/BEHIND` (R6-10) | não |
| só resultados (planta resultado) | `RESULTS_EVIDENCE_UNAVAILABLE`/congela; auditoria nova nunca mais é inscrita | sim (congelamento) |
| chave de origem + decisões/recibos (sem livro) | `UNLEDGERED_ENTRY` (**melhora** sobre a 6B: a chave de origem sozinha não forja histórico) | parcial (A6) |
| chave do livro + livro | forja registros até a revogação; aposentada ≤93 d também (R6-06) | sim (L3), mas a aposentada não |
| operador autenticado via API | não consegue ADOPT/RESTORE_ACK/QUARANTINE_ACK (403) | sim |

---

## (c) O que tentei e NÃO consegui quebrar (com os testes)

1. **Operações administrativas** — `ADOPT`/`RESTORE_ACK`/`QUARANTINE_ACK` × 5 estados do livro (a inscrever, protegida vazia, protegida com decisão, legada, adulterada) × 7 variantes de corpo (simples, com `approvers`, minúsculas, array, aninhado, chaves duplas, array raiz): sempre 403 `ADMIN_APPROVAL_UNAVAILABLE` ou 400, nada mudou no disco; só `POST` é exportado. `tests/zz-rv6-routes.test.ts`.
2. **Configuração** — 31 casos (dir ausente/vazio/relativo/inexistente; chave ausente/vazia/fraca/curta/maiúscula/com espaço; id=origem; material=origem; aposentada=origem; validade >93 d; revogada=atual; dir = cada uma das 6 pastas, dentro, pai, via symlink; sem pastas de resultados): toda configuração defeituosa recusa (503/409) e **não grava nada**; só a correta grava. `tests/zz-rv6-config.test.ts`.
3. **Autenticidade** — 126 folhas de GENESIS/INTENT/CONFIRMED/RECEIPT_REISSUED/CHECKPOINT/INTENT/ABORTED mutadas e **re-seladas** (atacante recalcula o SHA-256): todas detectadas (`verifyTags`+`replayLedger`); etiqueta com derivação de origem/domínio DECISION/RUN não vale como LEDGER; chave de origem não assina o livro e vice-versa; transplante entre auditorias, reescrever `auditId`, duplicar, reordenar, lacuna: detectados; CHECKPOINT forjado ou com tag corrompida não "lava" chave desconhecida. `tests/zz-rv6-crypto.test.ts` (testes 1, 2, 3, 5).
4. **Queda** — SIGKILL real **antes de cada uma das 20** chamadas mutantes ao FS de uma revogação: em nenhum ponto a revogada fica vigente com a entrada publicada; vigentes só com PROTECTED; livro sempre reproduzível; todo CONFIRMED tem entrada e recibo; o reenvio do autor recupera todos sem duplicar; fase A abortada pelo vencimento. `tests/zz-rv6-crash.test.ts` (saída: 20 linhas `RECUPERADO`).
5. **Concorrência entre processos** — 6 `ENROLL` simultâneos: 1 `GENESIS`, 5 recusas; `ENROLL` × 2 `create` × `ENROLL` (3 rodadas): nunca decisão antes do GENESIS; 3 `RECOVER` simultâneos sobre fase A vencida: 1 `ABORTED`. `tests/zz-rv6-concurrency.test.ts`.
6. **Matriz de ataques à revogação** (11 cenários): 10 detectados; o 11º (três pastas) é o limite declarado. `tests/zz-rv6-attacks.test.ts`.
7. **Guarda sintética** — sem guarda o rollback coordenado reativa `op-0001`; com guarda: `GUARD_MISMATCH`; indisponível: leitura não resolvida e escrita recusada; atrasada: `BEHIND` e a escrita seguinte republica. Condição de corrida GET×escrita com guarda: sem falso `GUARD_MISMATCH` (mascarada pela releitura). `tests/zz-rv6-guard.test.ts`, `zz-rv6-guardrace.test.ts`.
8. **Sistema de arquivos** — FIFO, symlink, diretório, arquivo de 5 KiB, lacuna e JSON inventado com nome válido: nenhum trava a leitura (≤ 8 s) e todos falham fechados; arquivos estranhos e `.tmp-` órfãos são ignorados; pasta da auditoria como symlink ⇒ `NOT_CONFIGURED`; registros `0444`. `tests/zz-rv6-fs.test.ts`.
9. **Resultados × livro** — livro removido com resultado v2 que o cita ⇒ `LEDGER_REMOVED_WITNESSED` (escrita e `ENROLL` recusados); fora de PROTECTED (livro removido, adulterado, INTENT aberto) a prévia tem `allowed:false`, bloqueio `DECISIONS_HISTORY_UNRESOLVED` e `finalize` ⇒ `NOT_FINALIZABLE`, sem arquivo de resultado. `tests/zz-rv6-results-witness.test.ts`.
10. **UI** — em 8 estados do livro só aparecem os botões "Inscrever…" e "Recuperar/Concluir recuperação verificável" (nenhum de adoção/restauração/aprovação); botões de escrita ficam **desabilitados** fora de PROTECTED; os validadores do cliente rejeitam decisão vigente ou "pode finalizar" fora de PROTECTED (com controle: PROTECTED aceito). A tela diz "Guarda externa NÃO configurada: um retrocesso coordenado de todos os volumes NÃO é detectado." `tests/zz-rv6-ui.test.ts`.
11. **Segredos** — nenhum material de chave em `console`/respostas/arquivos do repositório (grep); chaves do harness de navegador são aleatórias por execução; arquivos de implantação (`stack.yml`, Dockerfile, entrypoint, `.env.production.example`) não foram alterados.
12. **`LEDGER_NOT_REQUIRED` em produção** — só alcançável por código (símbolo); as duas composições de rotas sempre passam o livro (ver R6-12).

---

## (d) Afirmações da documentação que superam a prova

| Afirmação | Onde | O que eu consegui demonstrar |
|---|---|---|
| "ao atingi-lo [limite de 4000] as escritas falham fechado com `LIMIT_REACHED`" | spec §16.3; `LEDGER_REASON`/`MESSAGES` | Código é `LEDGER_UNAVAILABLE` "erro interno"; no registro 3999 a decisão e o recibo são publicados antes da recusa e a resposta diz "nada foi gravado" (R6-01) |
| "a primeira operação depois da rotação grava um CHECKPOINT … que cobre" | runbook §7 passo (3); spec §16.6 | Falso quando o último CHECKPOINT é da chave antiga (R6-02) |
| "aposentada só verifica" | spec §16.6, runbook | Aposentada válida autentica registros novos (R6-06) |
| "`fsync` do arquivo e do diretório tratados como falha de durabilidade quando falham" | spec §12 | Erro de `fsync` de diretório é engolido (R6-07) |
| `LedgerView` "sem … caminhos …"; respostas "sem caminhos" | `ledger-port.ts`, teste da API | A resposta 503 `LEDGER_UNAVAILABLE` traz o caminho absoluto (R6-03) |
| "só livro: truncar/remover/reordenar/duplicar ⇒ `UNTRUSTED`" | modelo de ameaças §8b | Truncar dá `UNLEDGERED_ENTRY`/`LEDGER_BEHIND`/legado; apagar CHECKPOINT/ABORTED de cauda não dá alarme (R6-05, R6-08, R6-11) |
| "o perdedor relê e vê a operação aberta do vencedor" | spec §16.5 | Na fase C o perdedor completa o CONFIRMED do vencedor, que recebe erro (R6-04) |
| LEGACY: "histórico anterior ao livro e nunca foi adotada" | UI | Também é o rótulo de um livro apagado sem testemunha (R6-08) |
| `LEDGER_BEHIND` "recuperável se a origem da decisão for comprovada" | spec §16.2 | Não considera a testemunha dos resultados (R6-05) |
| "≥ 2 pastas incluindo o livro NÃO coberto" (A7) | spec §3, §16.9, checklist | Superdeclara: pares com a 3ª pasta intacta são detectados; só 3 pastas (ou livro + a que o contradiz) não (R6-11) |
| Checklist de rollback: "arquivos gravados permanecem; a versão anterior simplesmente não os lê" | `onda6c-checklist-producao.md:99` | A imagem pré-livro **lê e escreve** a pasta de decisões e congela a auditoria inscrita (R6-09) |

---

## (e) Resultado das mutações (39 mutações em cópia; suíte `tests/link-audit-ledger-*.test.ts` = 83 testes, mais os de origem nas mutações de `link-audit-origin`)

Observação metodológica: a primeira rodada coincidiu com outros testes meus rodando em paralelo e o teste "5 PROCESSOS escrevem ao mesmo tempo…" falhou por carga em M01, M10, M23, M25, M29…; por isso M10, M25 e M29 foram **re-rodadas em máquina ociosa** (`mutation-run2.log`) e todas sobreviveram com 83/83 (109/109 para M25). Os demais "mortos" têm pelo menos um teste causal listado no log.

| Id | Mutação | Resultado |
|---|---|---|
| M01 | chave REVOGADA aceita se coberta por CHECKPOINT | morta (keys) |
| M02 | remove `PUBLISHED_AFTER_ABORT` | morta |
| M03 | fase C sem exigir origem comprovada | morta (3) |
| M04 | remove `RESULT_LEDGER_MISMATCH` | morta |
| M05 | remove contradição por indício | morta |
| M06 | livro removido citado por resultado não detectado | morta |
| M07 | resultado não conta como histórico | morta |
| M08 | `recordedAt` não monotônico | morta (14) |
| M09 | aborta INTENT sem esperar vencimento | morta |
| **M10** | **lacuna de nomes de arquivo ignorada na leitura** | **SOBREVIVEU** — equivalente na prática: `replayLedger` ainda detecta (`ledgerSeq !== index+1`); defesa em profundidade sem teste |
| M11 | aceita chave do livro igual à de origem | morta |
| M12 | replay aceita registro de outra auditoria | morta |
| M13 | replay não confere ordem das horas | morta |
| M14 | nunca grava CONFIRMED | morta (35) |
| M15 | ENROLL deixa de bloquear LEGACY | morta |
| M16 | ADOPT cai no RECOVER | morta |
| M17 | chave desconhecida sempre aceita | morta (5) |
| M18 | chave vencida sempre aceita | morta |
| M19 | `GUARD_MISMATCH` removido | morta |
| M20 | escrita segue com guarda que não publica | morta |
| M21 | CHECKPOINT nunca gravado | morta |
| **M22** | **fase C sem conferir que a entrada casa com o INTENT** | **SOBREVIVEU** — mascarada pela checagem do esquema do `anchorRef`; falta teste de entrada válida mas diferente do INTENT aberto |
| M23 | resultado novo sem `ledgerHead` | morta |
| M24 | `verify()` sem checar domínio×propósito | morta |
| **M25** | **HKDF sem separação por propósito (mesmo sal/rótulo)** | **SOBREVIVEU** nos testes do repositório; **meu** `zz-rv6-crypto` (teste 2) a **mata** (verificado em cópia) — lacuna real |
| M26 | livro à frente das decisões deixa de ser `HISTORY_REGRESSED` | morta |
| M27 | remove `HISTORY_DIVERGES` | morta |
| M28 | CHECKPOINT não confere o hash declarado | morta |
| **M29** | **`prepare` aceita escrita quando a razão é `RESULT_LEDGER_MISMATCH`** | **SOBREVIVEU** — lacuna real: nenhum teste do repositório exige que a escrita seja recusada nesse estado; meu `zz-rv6-writeblock` a **mata** (verificado) |
| M30 | CHECKPOINT só a cada N (sem o gatilho de rotação) | morta |
| M31 | escrita permitida em LEGACY_READ_ONLY | morta |
| M32 | escrita permitida em qualquer HISTORY_UNRESOLVED exceto LEDGER_BEHIND | morta (13) — a lacuna de M29 é específica de uma razão |
| M33 | recibo reemitido sem registrar RECEIPT_REISSUED | morta |
| **M34** | **`confirmed()` sem conferir que o INTENT é da mesma entrada** | **SOBREVIVEU** — mascarada pelo esquema (`anchorRef`); defesa em profundidade sem teste |
| M35 | guarda atrasada não informada | morta |
| M36 | RECEIPT_REMOVED deixa de ser reemissível | morta |
| M37 | resultados ilegíveis deixam de bloquear | morta |
| **M38** | **arquivos "suspeitos" (`l000004.json.bak`, `L…`) na pasta do livro ignorados** | **SOBREVIVEU** — nenhum teste planta nome suspeito |
| M39 | sobreposição de pastas não verificada | morta |

Totais: 39 mutações, 33 mortas, 6 sobreviventes (M10, M22, M25, M29, M34, M38). Nenhuma das mutações exercita R6-01 a R6-08 — **nenhum dos 83 testes cobre** o limite de 4000 pelo lado da paridade, rotação com CHECKPOINT no fim, caminho no 503, fase C com dono vivo, recuperação contra `ledgerHead`, aposentada em registro novo, nem `fsync` de diretório.

---

## Limites desta revisão
- Não executei `tsc`, o build do Next nem a suíte completa do repositório (só a do livro, 83/83 em máquina ociosa, e os meus testes). Não executei os roteiros de navegador (I5–I7). Não testei NFS/overlay, `ENOSPC`/`EROFS` reais, nem queda de energia (só SIGKILL).
- **Hipóteses não reproduzidas:** (i) `list` lê o livro **antes** dos resultados; se o livro avançar sem mudar as decisões entre as duas leituras (ex.: CHECKPOINT por `RECOVER` seguido de finalização) poderia surgir um `RESULT_LEDGER_MISMATCH` transitório — não consegui provocar; (ii) salto de relógio para o futuro tornaria uma fase A não abortável até o relógio alcançar (`laterOf` propaga a hora futura) — não testado.
