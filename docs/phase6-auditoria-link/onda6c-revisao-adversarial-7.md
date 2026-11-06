# Onda 6C — Revisão independente nº 7 do livro de cabeças (REGISTRO)

> **ATUALIZAÇÃO 05/11/2026:** o texto integral do revisor nº 7 FOI RECUPERADO (proveniência no fim deste arquivo) e está abaixo, sem alteração. As seções acima foram escritas em 04/11/2026, **antes** da recuperação, a partir da descrição do responsável; onde divergem do texto abaixo, **vale o texto do revisor**. Registro histórico do que se sabia em 04/11: o relatório verbatim do revisor nº 7 **não existia neste workspace** (nem em `~/gmn-review-evidence-2026-10-31/`, nem no instantâneo de recuperação de 03/11/2026, nem na cópia antiga do `D:`): a única fonte preservada é a descrição dos achados na mensagem de autorização do responsável de **04/11/2026**, transcrita abaixo **sem acréscimo de gravidade, evidência ou conclusão que ela não traga**. Quando o relatório original estiver disponível, **cole-o aqui, abaixo de uma linha divisória, sem reescrever esta página nem o parecer dele**. O parecer do revisor **não é alterado** por este registro nem pela remediação (`onda6c-relatorio-remediacao-7.md`).

**Objeto da revisão:** as correções da rodada anterior (revisão nº 6, `onda6c-revisao-adversarial-6.md`) — o livro de cabeças das decisões (`src/lib/link-audit-ledger/` + porta `link-audit-decisions/ledger-port.ts`), HEAD `f3168e7` mais a árvore local não commitada.

**Gravidade informada:** R7-01 **MAJOR** (o revisor o descreve como reabrindo parcialmente **R6-01**). R7-06: o responsável o declarou **obrigatório**. R7-07 a R7-11: tratados pelo responsável como **INFO**, a classificar individualmente (ver a regra abaixo). Nenhuma outra gravidade foi preservada.

**Regra do responsável para os INFO:** nenhum INFO é aceito automaticamente se permitir negação de serviço persistente, autenticação indevida ou bloqueio de recuperação; investigar em especial nomes de arquivos suspeitos, `INTENT` com horário futuro que nunca expira e o desempenho de `list`/`create` com ~3.996 registros; sem expandir o escopo para otimizações irrelevantes.

## Achados, como descritos na autorização de 04/11/2026

| Id | Tema (descrição preservada) |
|---|---|
| R7-01 | **MAJOR.** Reserva real de capacidade: o limite de 4.000 entradas é a capacidade TOTAL e inclui os registros que concluem operações já iniciadas; `CREATE` não pode consumir o que é da revogação; a reserva anunciada tem de ser a que o livro consegue executar (100 entradas de ledger ≠ 100 revogações completas) |
| R7-02 | Checkpoint de rotação: a rotação planejada não pode ser bloqueada porque `CREATE` consumiu o espaço do `CHECKPOINT`; sem sucesso se a transição entre chaves não é autenticada e durável; chave comprometida não aceita |
| R7-03 | Runbook: os passos 3 e 4 divergem da aplicação (botão de recuperação inexistente; operação aberta na fase B) |
| R7-04 | `fsync`: falha de fsync + reinicialização + reenvio idempotente + criação do diretório de auditoria + persistência do diretório-pai; o reenvio declarava durabilidade comprovada com uma sincronização incerta |
| R7-05 | Conflitos espúrios: leituras legítimas recebiam `RESULT_LEDGER_MISMATCH`/`GUARD_MISMATCH` por observarem estados intermediários de operações concorrentes |
| R7-06 | `RECOVER` gravava `CONFIRMED` com evidência desatualizada e resultado contraditório (corrida TOCTOU entre leitura e escrita) |
| R7-07 … R7-11 | INFO. Texto original **não preservado**. Temas indicados pelo responsável: nomes de arquivos suspeitos; `INTENT` com horário futuro que nunca expira; desempenho de `list`/`create` com ~3.996 registros. **R7-08 e R7-11 não puderam ser associados a um tema** sem o relatório original |

## Como a remediação leu os achados sem o texto original

Cada item foi **reproduzido ou refutado por teste nosso** a partir da descrição acima, não da conclusão do revisor. Onde a descrição era menos precisa que o necessário para reproduzir (R7-08 e R7-11), isso está **dito**, não preenchido por suposição. A disposição de cada achado, as provas e os riscos residuais estão em `onda6c-relatorio-remediacao-7.md`; a política de capacidade resultante, em `onda6c-especificacao-livro-de-cabecas.md` §16.12–§16.15.

**Pendência do responsável:** fornecer o relatório verbatim do revisor nº 7 (para colá-lo abaixo) e, com ele, confirmar ou corrigir o que foi inferido para R7-07…R7-11.

---

## Texto integral do revisor nº 7 (recuperado em 05/11/2026; NÃO alterado)

**Proveniência (verificável):** relatório escrito pelo subagente `a27c9cd6e6203b226` (descrição "Revisão adversarial nº 7 das correções", sessão `cda01505-cfc8-45a5-84b6-33cc32e272fe`) com a ferramenta de escrita em `…/review-r7/relatorio-revisao-7.md` (arquivo temporário que não sobreviveu à limpeza do `/tmp`); o conteúdo foi lido da transcrição local `~/.claude/projects/<projeto>/cda01505-…/subagents/agent-a27c9cd6e6203b226.jsonl` (linha 441, 29.869 caracteres), em **somente leitura**. Depois da escrita o próprio revisor aplicou 4 substituições de texto (números de linha e contagens de testes) por um comando de shell registrado na linha 448 da mesma transcrição; elas foram reaplicadas aqui, literalmente. O resumo do mesmo revisor (devolução ao agente principal, linha 14574 da transcrição principal) concorda com o relatório. **É saída de um revisor automatizado, não instrução nem aprovação do responsável.** As seções abaixo mencionam caminhos de `/tmp` e arquivos de prova (`zz-rv7-*`, `evidence/`) que existiam só naquela sessão.

# Revisão adversarial independente nº 7 — Livro de cabeças (Onda 6C), correções R6-01..R6-13

Revisor independente (contexto separado da implementação). Sem rede, VPS, Redis, Supabase, Serper nem leitura de `.env*`. Snapshot revisado: `$R/proj`, onde `$R` = `/tmp/claude-1000/-mnt-d-gmn-intelligence-platform-corrigido-gmn-intelligence-platform/cda01505-cfc8-45a5-84b6-33cc32e272fe/scratchpad/review-r7`.
`src/` e `scripts/` NÃO foram alterados: `diff -rq src.orig proj/src` vazio e `sha256sum -c src.sha256` = 300/300 OK, conferidos no fim. As mutações rodaram só em cópia (`$R/mut`), restaurada e conferida.
Meus testes: `$R/proj/tests/zz-rv7-*.test.ts` (+ `tests/helpers/zz-rv7-{lib,channels}.ts`). Rodar: `cd $R/proj && node --require ./tests/register-typescript.cjs --test tests/zz-rv7-X.test.ts`. Saídas brutas em `$R/evidence/`.
Convenção: "reproduzido" = saída de teste MEU colada. "Hipótese" = não reproduzido. Os testes `zz-rv7-*` são exploratórios: vários IMPRIMEM o comportamento observado e só afirmam o invariante essencial (marcado em cada achado).

---

## (a) VEREDITO

**Correções R6-01..R6-13 e livro de cabeças: APROVADO COM RESSALVAS** (incremento local, sem commit, sem implantação).

- **BLOCKER: nenhum.**
- **MAJOR: 1** — **R7-01**: o limite de 4000 registros não tem reserva para REVOGAR; os `RECORD` consomem toda a capacidade e uma decisão errada fica vigente para sempre (disponibilidade, falha fechada, sem saída administrativa). Contraria o princípio da 6B "a auditoria nunca fica congelada sem poder revogar" e a recomendação do próprio R6-01. A classificação "Corrigido" do R6-01 só vale para a parte INTENT/CONFIRMED/mensagem.
- **Integridade:** não consegui quebrar autenticidade, separação HKDF, Q5, nomes/arquivos do livro nem as conferências de citação (M29) pelos canais pedidos. O invariante M29 ("nenhuma escrita, em nenhum canal") sofre uma **violação estreita e só por TOCTOU construído** (R7-06, MINOR): a testemunha de resultados é lida UMA vez antes do livro na escrita; com evidência velha o `RECOVER` grava contra um resultado que a contradiz.
- **MINOR: 5** (R7-02..R7-06). **INFO: 5** (R7-07..R7-11, o último sobre qualidade dos testes).
- **Mutações:** 29 mutantes distintos do código NOVO; 22 mortos, 7 sobreviventes (5 lacunas reais fechadas por testes meus, 2 são defesa em profundidade) — seção (e).
- Não rodei `tsc`, build do Next, suíte completa nem navegador; limites na seção (g).

---

## (b) Achados

### R7-01 — MAJOR — Limite de 4000 registros sem reserva para revogação (a auditoria pode ficar sem poder revogar)
- **Descrição.** `LEDGER_OPERATION_RESERVE = 4` (`src/lib/link-audit-ledger/service.ts:152`) e a checagem `session.records.length + RESERVE > MAX_LEDGER_RECORDS` (`service.ts:266`) valem igualmente para `RECORD` e `REVOKE`. A 6B reserva as últimas 100 entradas (de `MAX_SEQ = 9999`) para revogações (`link-audit-decisions/service.ts:791`), mas o livro (4000 registros ≈ 1998 operações) enche muito antes; quando os `RECORD` consomem tudo até 3996+2, a revogação é recusada. O payload de `list` continua anunciando `limits.reservedForRevocations: 100` (`service.ts:732`), o que é enganoso com o livro ativo.
- **Impacto.** Uma decisão errada vigente não pode mais ser revogada nem substituída; o motor segue usando-a; sem papel administrativo não há reabertura. Alcançável só com ~1990 operações numa auditoria (improvável hoje, determinístico).
- **Reprodução.** `tests/zz-rv7-limit.test.ts` (RV7-LIM-1/2; livro real-assinado coerente com 1949 decisões; reproduzido):
```
# T=3996 revoke: ok=true  dec/anc/livro 1949,1949,3996->1950,1950,3998 estado=PROTECTED  PARCIAL=false
# T=3997 revoke: ok=false LEDGER_UNAVAILABLE ["livro: LIMIT_REACHED","O livro desta auditoria atingiu o limite de registros."] 1949,1949,3997->1949,1949,3997 PARCIAL=false
# (T=3998, 3999, 4000: idem; create idem em todos os totais >= 3997)
# RV7-LIM-2 (começa em 3990): create#1..#4 ok=true (livro 3992,3994,3996,3998); create#5 LIMIT_REACHED
# REVOGAR op-1949 (decisão errada) com o livro em 3998: ok=false LEDGER_UNAVAILABLE livro: LIMIT_REACHED
# estado=PROTECTED vigentes=5 ids=op-1949,op-1950,op-1951,op-1952,op-1953
```
  Pontos POSITIVOS verificados no mesmo teste: em nenhum total (3990..4000) houve gravação parcial (`PARCIAL=false`: contagens de decisões/recibos/livro idênticas antes e depois da recusa) e a resposta nunca disse "nada gravado" com gravação parcial. O R6-01 propriamente dito (INTENT sem espaço para o CONFIRMED) está corrigido.
- **Recomendação.** Reservar um bloco só para `REVOKE` (p.ex. aceitar `RECORD` até `MAX-8` e `REVOKE` até `MAX-4`), e expor o limite real no `limits` do `list`/UI; teste de "última operação possível é uma revogação"; reclassificar R6-01 como "Corrigido em parte" e tratá-lo como bloqueador de ENCERRAMENTO (é lógica de código, não infraestrutura).

### R7-02 — MINOR — A mesma reserva barra o CHECKPOINT de rotação (3997–3999) e as reemissões de recibo não têm reserva própria
- **Descrição.** (i) `RECOVER` com o livro em 3997–3999 é recusado pela reserva (`prepare` só chega ao CHECKPOINT depois de `service.ts:266`), embora o CHECKPOINT precise de 1 registro. (ii) `reissue()` (`service.ts:288`) não confere reserva: com o livro em 4000 a reemissão cai no esquema (`ledgerSeq ≤ 4000`) e a auditoria fica em `RECEIPT_REMOVED` para sempre.
- **Impacto.** (i) Auditoria "esgotada" não cobre a chave nova; quando a antiga vence vira `KEY_EXPIRED` e perde TODAS as decisões vigentes (de leitura). (ii) Beco sem saída, nicho.
- **Reprodução (reproduzido).** `zz-rv7-limit` RV7-LIM-3 e `zz-rv7-reissue-limit`:
```
# T=3996: RECOVER ok=true ...; após vencimento da antiga: PROTECTED/null vigentes=1
# T=3997: RECOVER ok=false LEDGER_UNAVAILABLE livro: LIMIT_REACHED ...; após vencimento da antiga: HISTORY_UNRESOLVED/KEY_EXPIRED vigentes=0
# (T=3998, 3999: idem)
# REISSUE: T=3998 OK (n=3999) | T=3999 OK (n=4000) | T=4000: LEDGER_UNAVAILABLE "O registro do livro não segue o contrato (erro interno); nada foi gravado." (estado RECEIPT_REMOVED permanente)
```
- **Recomendação.** Reserva diferenciada por tipo de registro (CHECKPOINT e ABORTED/REISSUE com reserva própria), mensagem `LIMIT_REACHED` (hoje "erro interno") também no `reissue`.

### R7-03 — MINOR — Runbook §7 passos (3) e (4) não funcionam como descritos; a janela residual é maior que a declarada para auditorias com operação aberta
- **Descrição.** O passo (3) diz "execute `RECOVER` em CADA auditoria protegida… a primeira operação grava o CHECKPOINT… isto também fecha a janela". Verificado: (a) com uma operação aberta em fase B (decisão publicada sem recibo) `prepare` devolve OK em `service.ts:263` ANTES do ramo do CHECKPOINT (`:268`): o `RECOVER` retorna **sucesso sem gravar CHECKPOINT** e a janela da chave antiga continua aberta; (b) a tela só mostra o botão "Recuperar" quando `ledger.recoverable` e dentro do bloco `openOperation` (`pending-panels.tsx:293-298,343`): numa auditoria ociosa e protegida (o caso normal da rotação) NÃO há botão, ao contrário do que o runbook afirma — só a API; (c) não há sinal observável de "CHECKPOINT da chave atual presente" (`LedgerView` não o expõe), então o passo (4) ("só depois de TODAS terem o CHECKPOINT remova a antiga") não é verificável pelo produto.
- **Impacto.** Com pendência aberta e ninguém reenviando, ao vencer a chave antiga (≤ 93 dias) a auditoria vira `KEY_EXPIRED` e a pendência deixa de poder ser concluída. Mesma morte silenciosa do R6-02 por outro caminho.
- **Reprodução (reproduzido).** `tests/zz-rv7-keys.test.ts` K3:
```
# pendência criada: ANCHOR_PENDING; livro: GENESIS,INTENT
# RECOVER (runbook passo 3) sob B: OK ledger=PROTECTED/B; livro: GENESIS,INTENT; kids=aa
# após o vencimento de A: HISTORY_UNRESOLVED/KEY_EXPIRED vig=0
# reenvio do autor após o vencimento: DECISIONS_HISTORY_UNRESOLVED livro: KEY_EXPIRED|Há registros do livro assinados por chave aposentada vencida e sem ponto de verificação...
```
- **Recomendação.** Runbook: "conclua ou aborte operações abertas ANTES de rotacionar" (como o §2 faz para a origem); `RECOVER` deve gravar o CHECKPOINT mesmo com operação aberta (o replay aceita CHECKPOINT em qualquer posição) ou recusar com mensagem; expor `keyCoverage` no `LedgerView`; corrigir "a tela oferece o botão".

### R7-04 — MINOR — R6-07 (fsync de diretório): sucesso sem durabilidade comprovada na RETOMADA e na criação de diretórios
- **Descrição.** `watchDurability` só observa `syncDirectory` DENTRO de `publishExclusive`. (1) **Retomada:** após uma falha de fsync (base travada), o reinício reenviando o MESMO pedido devolve SUCESSO sem nunca sincronizar de novo o diretório que falhou: o recibo existente é adotado por `adoptExistingReceipt` (`link-audit-storage/receipts.ts:226`, sem fsync) e a entrada de decisão pendente não é publicada de novo (nenhum `syncDirectory` em decisões). (2) **mkdir:** `ensureDirectory` (`link-audit-storage/files.ts:214-220`) cria `<base>/<auditId>` sem fsync do diretório-PAI, no livro (GENESIS), nas decisões e nos recibos; o fsync cobre só a pasta da auditoria.
- **Impacto.** Falha fechada após queda de energia (`HISTORY_REGRESSED`/`RECEIPT_REMOVED`), mas contradiz a afirmação "nenhum sucesso sem durabilidade comprovada… reenvio de pendente… GENESIS/ENROLL" (§16.4 e checklist) e o operador recebe sucesso. P-4 continua pré-requisito de homologação (ensaio de queda).
- **Reprodução (reproduzido).** `tests/zz-rv7-durability.test.ts`:
```
# D3 fsync de decisions falha: DECISIONS_STORAGE_UNAVAILABLE; livro: GENESIS,INTENT
#    2ª tentativa (disco saudável): SUCESSO; fsync de diretório na 2ª: [<REC>/aud, <LIVRO>/aud]; o diretório que falhou foi sincronizado de novo? false
# D3 fsync de anchors falha: ...; 2ª tentativa: SUCESSO; fsync na 2ª: [<LIVRO>/aud]; ... sincronizado de novo? false
# D1 mkdir: <LIVRO>/aud, <REC>/aud, <DEC>/aud | fsync: <LIVRO>/aud, <DEC>/aud, <REC>/aud | diretórios-PAI sincronizados? <LIVRO>=false <DEC>=false <REC>=false
```
  D2 (matriz fluxos × pasta com fsync falhando): create, revoke, ENROLL, REISSUE, COMPLETE_CONFIRMED, CHECKPOINT, ABORTED e reenvio de pendente FALHAM em toda pasta que o fluxo realmente sincroniza. Os "SUCESSO" que o D2 lista são células em que o fluxo não toca aquela pasta (não são escapes), exceto os dois casos de D3.
- **Recomendação.** Após falha de durabilidade, a retomada deve refazer `syncDirectory` do diretório (e do pai na criação) antes de devolver sucesso; ou declarar a limitação no §16.4/checklist.

### R7-05 — MINOR — Regressão de disponibilidade introduzida pela reordenação (R6-05): corridas legítimas viram bloqueio não retentado
- **Descrição.** As citações de resultados e a guarda agora são conferidas ANTES dos ramos transitórios (`model.ts:266-277`). `list` lê livro → decisões → resultados (`decisions/service.ts:655-659`); se, entre as leituras, outro operador grava e outro finaliza, o resultado cita posição mais nova que a do livro lido ⇒ `RESULT_LEDGER_MISMATCH`, que NÃO está em `TRANSIENT_LEDGER` (`service.ts:652`) e portanto não é relido. Antes da reordenação a mesma corrida caía em `UNLEDGERED_ENTRY` (retentado). Com guarda configurada ocorre o mesmo com `GUARD_MISMATCH` (`begin` lê a guarda DEPOIS do livro), inclusive no caminho de escrita (`prepare` → `refusedForState`, sem releitura).
- **Impacto.** Falso `HISTORY_UNRESOLVED` momentâneo em GET/prévia/finalização (a 2ª consulta resolve); não grava nada. Relevante para a guarda real (bloqueador de produção).
- **Reprodução (reproduzido, corrida injetada no provedor/guarda, mesmo ordem de leitura do código real).** `zz-rv7-order` O1 e `zz-rv7-misc` T-O4:
```
# O1 1ª consulta (corrida): HISTORY_UNRESOLVED/RESULT_LEDGER_MISMATCH vigentes=0 finalizable=false | 2ª consulta: PROTECTED/null vigentes=2
# T-O4 1ª consulta (corrida): HISTORY_UNRESOLVED/GUARD_MISMATCH guard=MISMATCH vigentes=0 | 2ª: PROTECTED/null vigentes=2
```
- **Recomendação.** Incluir `RESULT_LEDGER_MISMATCH` e `GUARD_MISMATCH` em `TRANSIENT_LEDGER` (uma releitura) e em `prepare` (`rechecks`), ou ler a testemunha ANTES do livro na leitura; manter o bloqueio se persistir.

### R7-06 — MINOR — M29/R6-05 incompleto: evidência velha e testemunha das decisões não consultada antes das receitas
- **Descrição.** (1) Nas ESCRITAS (`create`/`revoke`/`RECOVER`), `readKnownHeads` roda UMA vez ANTES de `appendEntry` (`decisions/service.ts:773,870,951`) e o resultado fica fixo durante toda a espera/retentativas (até ~2 s de `WAIT` e 5 tentativas); o livro, ao contrário, é relido a cada tentativa. Um resultado selado depois dessa leitura e uma remoção da cauda do livro dentro da janela fazem a receita gravar contra uma citação que ninguém consultou. (2) `evaluateProtection` confere só `ledgerHeads`/`unverifiedLedgerHeads`/guarda antes das receitas; a testemunha de DECISÕES da 6B (`evaluateKnownHeads`, `UNTRUSTED` por indício) roda em `build`, DEPOIS de `prepare`.
- **Impacto.** Violação estreita do invariante M29 sob TOCTOU (atacante A4 com precisão de milissegundos) e escrita de `ABORTED` sob testemunha 6B não resolvida (atacante A3 que planta resultado pendente forjado). Ambas falham fechado nas leituras seguintes.
- **Reprodução (reproduzido por construção).** `zz-rv7-order` O2 e O3:
```
# O2 RECOVER com evidência VELHA: OK; livro: GENESIS,INTENT,CONFIRMED | árvores iguais? false | leitura com evidência fresca: HISTORY_UNRESOLVED/RESULT_LEDGER_MISMATCH
# O3 leitura: ledger=PROTECTED/null witness6B=UNTRUSTED vigentes=0 | create: DECISIONS_HISTORY_UNRESOLVED testemunha: UNTRUSTED
#    livro antes: GENESIS,INTENT,CONFIRMED,INTENT  depois: GENESIS,INTENT,CONFIRMED,INTENT,ABORTED
```
- **Recomendação.** Reler a testemunha dentro do laço de `appendEntry` logo após `begin` (e antes de `prepare`), e passar o veredito da testemunha 6B ao `prepare`.

### R7-07 — INFO — Nomes parecidos com registro e rótulo do estado para arquivos hostis
- Aceitos como benignos (a pasta segue `PROTECTED` e o `ENROLL` de auditoria vazia GRAVA o GENESIS): `l-000004.json`, `l 000004.json`, `l١٢٣٤٥٦.json`, `l０００００４.json`, `ｌ000004.json`, `ℓ000004.json`, `README.txt`, `.l000004.json`, `.tmp-l000004.json`, `.TMP-…` (M38-1/M38-2). O §16.2 diz "sem nome que pareça registro"; o critério real é `^l\d` ASCII, caixa insensível. Em Linux/ext4 são inodes distintos que nenhum leitor abre (sem impacto); só importaria num FS com mapeamento de nomes (não é o alvo).
- FIFO, socket, diretório, symlink, 5 KiB, 4097 bytes no lugar de um registro/próximo registro: fecham `UNAVAILABLE` (não `UNTRUSTED`), ≤ 15 ms, sem travar; arquivo vazio/`{}`/truncado/BOM/cópia com seq trocada: `UNTRUSTED`. Rótulo só diagnóstico (ambos falham fechado), mas "indisponível" pode induzir a esperar em vez de investigar adulteração.

### R7-08 — INFO — Respostas HTTP: sem caminho absoluto, mas com texto nativo e nome de arquivo em códigos "DETAILED" de integridade (pré-existente, 6B)
- Em 1.950 chamadas de serviço (390 mundos: 10 operações × 10 códigos × 3 pastas × formatos de mensagem) e 7 rotas reais com falhas reais de disco (chmod 000/0555, arquivo no lugar da pasta, link circular) em 5 pastas: **nenhum** `/tmp/`, `lad-`, `.tmp-`, `l000002.json`, caminho genérico (`/home|/mnt|/var…`). `scrubPaths` troca por `[caminho]`.
- Restam, em `DECISIONS_INTEGRITY` (409; erro de LEITURA classificado como integridade): `"d0001.json: leitura: EACCES EACCES: simulated failure, readFile '[caminho]'"` e `"listagem: EACCES EACCES: permission denied, scandir '[caminho]'"` (nome de arquivo + errno + texto nativo). Contradiz o comentário de `decisions/shared.ts` ("nenhuma… mensagem interna"), mas não vaza topologia. O R6-03 em si (LEDGER_UNAVAILABLE) está corrigido: mutação que reverte a mensagem fixa é morta pelo teste do repositório.
- Reprodução: `zz-rv7-leaks` (saída em `evidence/rv7-leaks.out`; as asserções do meu teste usam regex amplas e "falham" por esses dois textos, não por caminho).

### R7-09 — INFO — Salto de relógio para o futuro congela o abortamento (hipótese (ii) do R6 reproduzida)
- INTENT com `recordedAt` futuro nunca vence: `ageMs=-18100800000 stale:false`; `RECOVER` espera ~2,2 s e devolve `LEDGER_OPERATION_IN_PROGRESS`; nova criação idem. Sem relógio monotônico ou salvaguarda; sem administrador não há como abortar. `zz-rv7-misc` T-CLK.

### R7-10 — INFO — Custo O(n) por chamada
- Com 3996 registros: `list` ≈ 4,7–5,0 s e `create` ≈ 4,8 s (leitura + zod + HMAC de todos os arquivos do livro e da 6B a cada chamada), com o limiter de leitura em 30/min por operador. Em tamanhos normais (dezenas) é desprezível. `zz-rv7-misc` T-TIME.

### R7-11 — INFO — Qualidade dos testes (ver seção (e))
- Mutantes sobreviventes que indicam lacunas reais: epoch no meio da cadeia (MA1), reserva 3 vs 4 (MA4), durabilidade no reenvio de pendente (MA12/MA13), travamento da base do livro (MB2). Todos mortos por testes meus.

---

## (c) O que tentei e NÃO consegui quebrar (com os testes)

1. **M29 em todos os canais** (`zz-rv7-mismatch`, `zz-rv7-channels`): citação **intermediária** (R1 cita 3, R2 cita 7; truncar de 4, 5 ou 7), cabeça citada **CHECKPOINT**, **RECEIPT_REISSUED**, **guarda divergente** (GUARD_MISMATCH antes da receita), resultado **pendente comprovado** (conclusão de recibo recusada), resultado pendente **forjado** com `ledgerHead` falso (UNTRUSTED, nada gravado) e com `ledgerHead` verdadeiro (ignorado: a receita legítima ABORTED continua), em serviço, 4 processos concorrentes (`runChild`), prévia e finalização. Em todos: `hashTree` de livro/decisões/recibos/resultados/recibos de resultados/guarda **idêntico** antes e depois; nenhum canal devolveu sucesso. Controle: cauda NÃO citada (só o CONFIRMED 9) continua recuperável.
2. **M25** (`zz-rv7-hkdf`, 7 testes): cálculo independente com `node:crypto` (HKDF-SHA256, salt/info do checkpoint `gmn.link-audit.origin.salt/.v1`): etiquetas de origem idênticas às do checkpoint (DECISION/RUN × 3 corpos); etiqueta do livro = HMAC da subchave `ledger`, diferente da subchave de origem, do material cru e do domínio errado; MESMO material nas duas famílias: nenhuma etiqueta cruza (3 domínios × 2 sentidos); `sign('DECISION')` no livro e `sign('LEDGER')` na origem lançam; `origin` enxertada de DECISION/RUN em cada um dos 3 primeiros registros do livro é recusada; revogação/validade independentes; 8 configurações (mesmo id, mesmo material, aposentadas cruzadas, revogada ainda configurada) ⇒ `LEDGER_CONFIG_INVALID`. Observação: a recusa de material repetido mora só no lado do livro (a origem aceita o material do livro; o livro então recusa e nada é gravado — falha fechada).
3. **M38** (`zz-rv7-names`, 5 testes; 32 nomes × livro protegido × auditoria vazia; FIFO/socket/diretório/symlink/hardlink/vazio/5 KiB/truncado/BOM/seq trocada; corrida entre `readdir` e `readFile` com adulteração/remoção/FIFO/symlink/diretório virando link para cópia completa ou antiga; 4000 `.tmp-` órfãos; 5000 nomes válidos): nenhum bypass, nenhuma cabeça avançou, nenhum travamento (≤ 15 ms), nenhum GENESIS com nome suspeito (`bak`, caixa, dígitos curtos/longos, espaço/quebra/tab/controle finais, stream NTFS, extensão).
4. **Q5** (`zz-rv7-q5`, `zz-rv7-legacy`): 3 ações × 9 variantes de corpo × 3 conjuntos de cabeçalhos × 7 estados (a inscrever, protegida vazia/com decisão, legada, livro adulterado, operação aberta, resultado selado + livro sem a cabeça) = 567 requisições pela ROTA (+7 com query string): nenhuma resposta < 400; só `403 ADMIN_APPROVAL_UNAVAILABLE` ou `400 INVALID_BODY`; só `POST` exportado; disco INALTERADO. Legada: `RECOVER`/criação/revogação ⇒ `LEDGER_LEGACY_READ_ONLY`, `ENROLL` ⇒ `ADMIN_APPROVAL_UNAVAILABLE`, nada gravado. Vacuidade: 96 combinações de `lstat/readdir/realpath/readFile` × EACCES/EIO/EMFILE/ENOTDIR × 6 fontes (decisões, recibos, livro, resultados, recibos de resultados, guarda): `lstat` e `readdir` falhando em QUALQUER fonte ⇒ nenhum GENESIS (48/48); `realpath`/`readFile` não são chamados em pastas vazias (as 48 "inscrições" são células não exercitadas; o `realpath` do `overlapping()` engole erro e cai no caminho léxico — INFO). `.tmp-` órfão nas decisões não é histórico (inscrição de vazia segue).
5. **Época de chave R6-06** (`zz-rv7-keys` K1–K7): A,B,A, reversão (A atual, com ou sem B aposentada), A→B→C com forja de A OU de B depois de C (UNTRUSTED), A e B fora da configuração ou vencidas (cobertas pelos CHECKPOINTs ⇒ PROTECTED), CHECKPOINT forjado com chave desconhecida não "lava" (KEY_UNKNOWN), processo antigo depois do novo recusa (KEY_UNKNOWN; sem congelar a auditoria). **A janela residual é exatamente "até o PRIMEIRO registro da chave nova"** (K4: CHECKPOINT forjado com A antes dele ⇒ PROTECTED; mesmo forjado depois ⇒ UNTRUSTED) — mas ver R7-03: o "primeiro registro" pode demorar para auditorias com operação aberta.
6. **R6-02 caso nominal** (último registro é CHECKPOINT antigo): K1 (`kids: aaab`), RECOVER grava o CHECKPOINT de B; testes do repositório passam.
7. **R6-01 propriamente dito:** em nenhum total 3990..4000 houve gravação parcial ou mensagem "nada gravado" falsa; reinício/concorrência: o teste concorrente do repositório (14/14, incluindo SIGKILL em cada etapa) passou em baseline.
8. **R6-04:** teste do repositório com 2 processos reais passa; mutação que reverte o tratamento do CONFLICT é morta (MB1).
9. **Rotas de decisões/ledger sob falhas reais de disco** (R7-08): sem caminho absoluto em nenhuma resposta nem cabeçalho.
10. **Efeitos colaterais na 6B isolada:** `watch = ledger ? watchDurability(ops) : null; atomicOnly(watch?.ops ?? ops)` — sem livro o comportamento é o de antes (leitura do patch; e rodei, sem alteração, 148 testes de conformância/armazenamento/6B isolada: `storage-{conformance,differential,files,receipts}`, `decisions-{store,service,recovery,anchor,isolation}`, `ledger-isolation` — 148/148 passam). Os checks do navegador (`i7-homologacao.cjs`) só ficaram MAIS estritos: a espera passou a exigir o estado final (`/Erro de integridade/`; rótulo + fim do carregamento + um dos três estados), e as asserções `check(...)` seguintes não mudaram — não mascara regressão (o `go()` só aguarda; quem decide é o `check`).

---

## (d) Afirmações da documentação que superam a prova

| Afirmação | Onde | O que demonstrei |
|---|---|---|
| R6-01 "Corrigido" e "a auditoria nunca fica congelada sem poder revogar" (princípio da 6B) | §16.11; `decisions/service.ts:791` | Corrigido só o INTENT/CONFIRMED; sem reserva de revogação (R7-01); `limits.reservedForRevocations:100` continua anunciado |
| Runbook §7 (3): "a tela oferece o botão… a primeira operação grava um CHECKPOINT… isto também fecha a janela" | runbook §7 | Sem botão na auditoria ociosa; com operação aberta o RECOVER devolve sucesso SEM CHECKPOINT; sem sinal de cobertura para o passo (4) (R7-03) |
| "Janela residual: entre a rotação e o PRIMEIRO registro da chave nova" (e "o runbook manda gravar o ponto de verificação logo após") | §16.6 | Correto, mas o primeiro registro pode não ser gravável (operação aberta, 3997+, estados não protegidos): a janela pode durar até 93 dias nessas auditorias |
| "a falha do fsync… NÃO é engolida: a operação não devolve sucesso" (entrada, recibo, livro; reenvio de pendente, GENESIS/ENROLL) | §16.4, checklist | Verdade para a 1ª falha; falsa na retomada (sucesso sem refazer fsync) e na criação de diretórios (pai sem fsync) (R7-04) |
| "Citações e guarda conferidas ANTES de qualquer receita… nada é gravado em canal algum" | §16.4 (R6-05) | Verdade com a evidência lida no momento; a escrita usa evidência lida antes do livro (R7-06) e a testemunha 6B é consultada depois da receita |
| "nenhuma resposta traz caminho do disco, credencial ou mensagem interna" | `decisions/shared.ts` | Sem caminho absoluto; mas texto nativo e nome de arquivo em `DECISIONS_INTEGRITY` (R7-08) |
| "sem nome que pareça registro" (vacuidade) | §16.2 | Critério ASCII `^l\d`; `l-000004.json` e `l０００００４.json` não contam (R7-07) |
| "reserva de 4 registros" | §16.11 | Os testes não distinguem 4 de 3 (MA4) |

---

## (e) Mutações (cópia `$R/mut`; testes do repositório pertinentes; restauradas e conferidas)

Logs: `evidence/mut-run1.log`, `mut-run2.log`, `mut-run3.log`; configuração `mut-cfg*.json`; runner `mutate.py`. 25 + 6 execuções; MA14 e MA24 foram refeitas porque escolhi os arquivos de teste errados na 1ª vez (MA14r, MA24r).

| Id | Mutação | Resultado |
|---|---|---|
| MA1 | `keyEpochViolation`: remove a checagem `finished.has(kid)` no laço (A,B,A…) | **SOBREVIVEU** (r6, keys, model); morta pelo meu K7 (A,B,A,B com B atual; A,B,A com C atual) |
| MA2 | remove a checagem de reversão (atual já substituída) | morta |
| MA3 | `needsCheckpoint` volta a olhar só a cauda (bug R6-02) | morta (4 testes) |
| MA4 | reserva 4 → 3 | **SOBREVIVEU** (review6, protocol); morta pelo meu KILL-MA4 (3997 registros + CHECKPOINT necessário) |
| MA5 | remove a reserva | morta |
| MA6 | remove citações `ledgerHeads` | morta (5) |
| MA7 | remove indícios `unverifiedLedgerHeads` | morta |
| MA8 | remove guarda divergente do bloco pré-receita | morta |
| MA9 | `publishLedgerRecord` ignora `watch.failure()` | morta |
| MA10 | decisões: entrada sem durabilidade devolve sucesso | morta |
| MA11 | decisões: recibo sem durabilidade devolve sucesso | morta |
| MA12 | reenvio de pendente: remove checagem pós-recibo | **SOBREVIVEU**; morta pelo meu KILL-MA12/13 |
| MA13 | reenvio de pendente: recibo fora do observador | **SOBREVIVEU**; morta pelo meu KILL-MA12/13 |
| MA14/MA14r | reverte a mensagem fixa (R6-03) | 1ª: sobreviveu por teste errado (r6, api); MA14r com `review6`: **morta** |
| MA15 | R6-04: aceita CONFIRMED concorrente sem `verifyTags`/`replayLedger` | **SOBREVIVEU** (r6, attacks) — defesa em profundidade (sem teste negativo) |
| MA16 | R6-04: aceita CONFIRMED sem conferir `opId` | **SOBREVIVEU** — equivalente por `replayLedger` (um CONFIRMED por INTENT; = mutante equivalente conhecido) |
| MA17 | `watchDurability` nunca registra falha | morta |
| MA18a/b | HKDF: sal / rótulo compartilhados | mortas |
| MA19 | M38: flag `i` removida | morta |
| MA20 | M38: nome suspeito ignorado | morta (3) |
| MA21 | Q5: `RESTORE_ACK` cai no RECOVER | morta |
| MA22 | Q5: resultado não conta como histórico | morta |
| MA23 | Q5: resultados ilegíveis não bloqueiam | morta |
| MA24/MA24r | desliga `PUBLISHED_AFTER_ABORT` | 1ª com testes errados; MA24r (r6+protocol) **morta** |
| MB1 | R6-04 revertida (CONFLICT sempre erro) | morta |
| MB2 | R6-07: base do livro não trava após falha de durabilidade | **SOBREVIVEU** (r6); morta pelo meu KILL-MB2 |
| MB4 | época: `finished` nunca preenchido | morta |
| MB6 | R6-05 revertida (citações ignoradas se D>L) | morta (3) |

Totais (29 mutantes distintos): **22 mortos, 7 sobreviventes** (MA1, MA4, MA12, MA13, MB2 = lacunas reais; MA15 = defesa em profundidade sem teste negativo; MA16 = equivalente conhecido). Os 5 de lacuna real foram mortos por `zz-rv7-keys` K7 e `zz-rv7-kill`.

---

## (f) Avaliação individual R6-01..R6-13 (classificação do §16.11)

| Achado | Classificação do implementador | Minha avaliação |
|---|---|---|
| R6-01 | Corrigido | **Discordo em parte.** INTENT sem espaço, mensagem falsa e gravação parcial: corrigidos (verificado). Falta reserva de revogação (R7-01 MAJOR) e do CHECKPOINT de rotação (R7-02). Reclassificar "Corrigido em parte" e **bloqueador de encerramento** |
| R6-02 | Corrigido | **Concordo** para o caso nominal (último CHECKPOINT antigo). O mesmo beco subsiste com operação aberta/limite (R7-02/03): "Corrigido + risco residual documentado" exige corrigir o runbook |
| R6-03 | Corrigido | **Concordo.** Sem caminho absoluto em ~2.000 chamadas e 7 rotas; INFO R7-08 (texto nativo/nome de arquivo em DETAILED, pré-existente) |
| R6-04 | Corrigido + residual (atribuição) | **Concordo.** MA15/MA16 mostram testes negativos ausentes (não bloqueia) |
| R6-05 | Corrigido | **Concordo no núcleo** (5 canais + meus 6 cenários, mutações MB6/MA6/MA7/MA8 mortas). Rebaixar a afirmação "nada é gravado em canal algum" a "com a evidência lida no momento" (R7-06) |
| R6-06 | Corrigido + residual (janela) | **Concordo com a regra** (K1–K7; MA2/MB4 mortas). A janela residual não é "exatamente" a declarada para auditorias com operação aberta (R7-03) |
| R6-07 | Corrigido + residual P-4 | **Concordo em parte.** Primeira falha: correto em todos os fluxos que sincronizam. Retomada e `mkdir`: não (R7-04); incluir no residual P-4 |
| R6-08 | Residual (texto corrigido) | **Concordo.** Só a guarda real distingue; texto novo verificado no patch |
| R6-09 | Residual + pré-requisito de produção | **Concordo**; exigir no checklist como bloqueador de produção (perda permanente se a imagem antiga escrever) |
| R6-10 | Bloqueador de produção | **Concordo.** Reforço: R7-05 mostra que a guarda real exigirá releitura para o mesmo falso `GUARD_MISMATCH` |
| R6-11 | Residual (doc corrigida) | **Concordo.** Mantido |
| R6-12 | Residual | **Concordo.** Teste estático por regex; sem mutação minha |
| R6-13 | Bloqueador de produção | **Concordo.** R7-01/02/03 criam beco não intencional parecido: mais um motivo |

---

## (g) Limites desta revisão

- Não rodei `tsc`, `next build`, suíte completa (`npm test`) nem roteiros de navegador. Rodei (baseline, sem alteração) `link-audit-ledger-{model,r6,review6,results-mismatch,concurrency,crash}` e os 148 testes de armazenamento/6B citados em (c)10: todos passaram.
- Sem NFS/overlay, sem `ENOSPC`/`EROFS` reais (falhas por injeção em `FsOps` e por `chmod`/arquivo-no-lugar-de-pasta/link circular), sem queda de energia real (só SIGKILL do repositório), sem dispositivo de bloco/caractere (precisa de root; FIFO e socket testados).
- R7-05 e R7-06 foram reproduzidos por **construção** (provedor/guarda injetado com a mesma ordem de leitura do código real), não por corrida natural.
- Hipótese não reproduzida: múltiplas rotações seguidas com réplicas em `start-first` em carga real (K6 cobre só dois processos em sequência).
- Limpeza: ~450 pastas `/tmp/lad-*` e `/tmp/rv7-*.out` ficaram (uso ~600 MB em tmpfs); a exclusão em massa foi negada pelo ambiente e não foi contornada.
