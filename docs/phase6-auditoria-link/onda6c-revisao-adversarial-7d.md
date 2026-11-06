# Onda 6C — Revisão independente nº 7d: correção do D1, revalidação pós-reinício e barreira antes de selar (05/11/2026)

**Parecer do revisor: SEM BLOCKER e SEM MAJOR novo; D1 FECHADO.** Ressalvas do próprio revisor (INFO/MINOR, abaixo e no relatório técnico): a vista deste processo não percebe registros publicados por OUTRO processo depois da prova (o resultado selado, sim, passa pela barreira); fsyncgate é limite de plataforma; a garantia de 100 revogações é exata mas SEM margem diante de tentativas falhas. O item de MUTAÇÕES do revisor foi entregue **incompleto** (a rodada dele estava em andamento) e foi pedido um complemento — registrado na seção "Complemento do revisor" abaixo. SEM commit; Onda 6C NÃO encerrada.

**Revisor:** o mesmo das etapas anteriores (contexto retomado), em instantâneo da árvore final (`review-r7d`, idêntico à árvore). Saída de revisor automatizado; não é aprovação do responsável.

## Texto integral do revisor (sem alteração)

```
RE-VERIFICAÇÃO Nº 4 (instantâneo final review-r7d) — relatório PARCIAL

## Veredito
- Não achei BLOCKER nem MAJOR novo nesta rodada.
- D1 está fechado (reproduzido).
- A garantia de 100 revogações vale, mas sem nenhuma folga e só enquanto nenhuma tentativa falha.
- **O item F (mutações) ficou incompleto.** A rodada de mutações estava em andamento quando o envio foi exigido; sei os 15 mutantes que configurei, mas não os resultados. Registro: /tmp/claude-1000/-mnt-d-gmn-intelligence-platform-corrigido-gmn-intelligence-platform/f5d0e6cd-abcd-4264-b1ea-afee3af963f4/scratchpad/r7b-mut/r7d.log (e results7d.json, quando terminar).
- **Também não rodei a base de N4 sem mutação.** N4 é o conjunto de testes do livro que cada mutante roda: d1, seal-barrier, m2, r711, review7, crash e authority (E4 e E5 também rodam capacity). Sem essa base, um "morto" pode ser falha que já existia. Rode-a antes de confiar nos resultados.

## Como trabalhei
- Comparei review-r7c com review-r7d e li o diff completo das fontes antes de concluir: reissue com sincronização, ensureLedgerProven/markDurabilityProven, durabilityBarrier com syncDecisionDirectories, barreira na finalização e na conclusão de pendente, política nova de capacidade.
- Trabalhei só na cópia rv7d. Sem rede, sem commit, sem tocar em ~/projects ou /mnt/d.
- Provas novas: rv7d/tests/zz-r7d.test.ts (2 de 2 passam); rv7d/tests/zz-r7c.test.ts, re-rodado aqui. O T3 agora **falha**, ou seja, o defeito D1 sumiu.

## A) D1 — fechado
- Reproduzi o T3: RECEIPT_REISSUED publicado, fsync da pasta do livro falhando (DECISIONS_DURABILITY_UNKNOWN), reinício, reenvio. Antes da correção o reenvio tinha sucesso com 0 fsyncs do livro. Agora o reenvio tem sucesso **depois** de 4 fsyncs: pasta da auditoria e raiz no begin (prova da primeira leitura) e de novo no caminho "já registrada" (service.ts, perto da linha 412). O livro continua GENESIS,INTENT,CONFIRMED,RECEIPT_REISSUED, sem duplicata.
- O T4 continua igual: 3 remoções do mesmo recibo geram 1 registro só. É o custo declarado; remoções repetidas ficam invisíveis no livro.
- Revalidação: T1 e T2 passam (falha intermitente só na raiz ou só na pasta, depois reinício). O recuperado só tem sucesso com a raiz provada.
- Não testei o "entre processos" da reemissão separadamente; a parte entre processos que testei está no item D.

## B) Durabilidade dos caminhos idempotentes
- Pelo código, todos sincronizam pasta da auditoria e raiz antes do sucesso: replay de confirmada, reenvio de pendente, fase C, adoção, RECOVER e reemissão (nova ou já registrada).
- syncLedgerDirectory e syncDecisionDirectories travam a base quando falham.
- O mutante MB2b agora tem testes dedicados no repositório (d1.test: RECOVER, replay, adoção). Não confirmei se o mutante morre; o resultado está no registro pendente.

## C) Barreira antes de selar
- **R4a — o que a barreira cobre e o que não cobre:** (1) Este processo já tinha provado a auditoria. (2) Um processo filho grava o CONFIRMED l000005 e o fsync dele falha: o filho responde DECISIONS_DURABILITY_UNKNOWN. (3) A **lista deste processo** mostra PROTECTED, cabeça 5, finalizável, 2 decisões vigentes, com **0 fsyncs do livro na leitura**. A prova fica guardada por processo e não percebe publicações de outro processo. (4) Chamada direta, a barreira devolve {ok:true} **só depois de** sincronizar <livro>/auditoria, <livro>, <decisões>/auditoria, <recibos>/auditoria, <decisões> e <recibos>. Conclusão: o resultado selado nunca cita uma cabeça que este processo não sincronizou; só a vista fica sem prova. Classifico como **INFO**.
- **INFO — limite de plataforma (fsyncgate, sem reprodução):** se o erro de fsync já foi visto por OUTRO processo (ou pelo processo antes do reinício), um fd novo pode receber sucesso no fsync mesmo que o kernel tenha descartado o que estava pendente. A prova pós-reinício e a barreira são então mais fracas que "provado". Em ext4/xfs um erro de journal costuma deixar o volume somente-leitura, e aí o fsync seguinte também falha.
- Pelo código: a barreira lê, sincroniza e relê, exigindo as mesmas cabeças; uma gravação depois da releitura não muda o que é citado (o livro só cresce e o citado já foi sincronizado); a conclusão de um resultado pendente passa pela barreira com {}: exige PROTECTED, nenhuma operação aberta, nenhuma decisão pendente e estado finalizável.
- Não achei negação de serviço persistente: as recusas são INPUT_CHANGED ou DURABILITY_UNKNOWN e se resolvem ao tentar de novo ou ao reiniciar.
- Não testei, pelo serviço de resultados: dois processos finalizando ao mesmo tempo, CHECKPOINT ou ABORTED concorrentes durante a barreira, e auditoria sem pastas de decisões.

## D) Depois de DURABILITY_UNKNOWN e reinício
- A leitura só volta a PROTECTED depois da prova: o begin sincroniza pasta e raiz uma vez por processo e auditoria (T1).
- O payload real da lista nesse estado passa no validador da tela (re-rodado: T1 ok).
- O estado vale para o volume inteiro até reiniciar. Isso é defensável (depois de um erro não se presume nada), mas transforma um erro de fsync em indisponibilidade de todas as auditorias até o reinício.
- Única exceção a "PROTECTED só com prova": registros publicados por outro processo depois da prova deste (R4a, INFO).

## E) Reserva de capacidade (números reais)
- Política: max 4000, RECORD 3685, REVOKE 3992, MAINTENANCE 4000, reserva 307. Vista de um livro recém-inscrito: 1210 decisões novas e 1311 revogações (são pisos).
- **R4b, modelo adversarial:** de qualquer estado em que a última decisão nova foi admitida (used de 3682 a 3685, since de 0 a 69), com 1 reemissão da última decisão e 1 reemissão depois de CADA revogação: o escritor admite **no mínimo exatamente 100 revogações** (pior caso: used=3685, since=27, total final 3990); o maior total observado foi 3993; o CHECKPOINT de rotação ainda cabe; nenhuma INTENT admitida ficou sem lugar para o fecho.
- **MINOR — a garantia não tem margem:** cada tentativa falha (INTENT+ABORTED = 2 registros, ritmo de 1 a cada 120 s) reduz o piso abaixo de 100. Causar falhas persistentes na publicação das revogações (escrita na pasta de decisões ou disco cheio), com o operador insistindo, consome a reserva em cerca de 100 a 200 minutos perto do limite. Não reproduzi o esgotamento ponta a ponta; é aritmética sobre o freio já provado em capacity-burn.
- Invariantes conferidos no código: operationCost não mudou (INTENT só entra se ela e o fecho cabem na classe), e a reemissão só é barrada pelo teto de 4000.

## F) Mutações (15 configuradas; resultados pendentes)
- Mutantes: MB2b, MA16, B1 a B7 (barreira: segunda conferência, sincronização do livro, sincronização das pastas, conferência da cabeça das decisões, conferência da cabeça do livro, barreira da conclusão, barreira da finalização), E1 (sem a prova no begin), E2 (travar não apaga as provas), E3 (reemissão já registrada sem sincronizar), E6 (syncDecisionDirectories sem trava), E4 (vista sem a margem da reemissão), E5 (fórmula antiga da reserva).
- Expectativa pela leitura do código, ainda não confirmada: **B4** deve ser equivalente (com o livro PROTECTED, sem operação aberta e com a mesma cabeça do livro, as decisões confirmadas são as mesmas); **MA16** é equivalente com condição (depende da conferência de MA15 continuar no lugar).

## O que NÃO verifiquei
Os resultados das mutações e a base de N4 sem mutação (ver topo); os testes longos de capacidade nesta rodada; rotas HTTP e o Next empacotado; queda real de energia.
```

## Complemento do revisor (mutações e linha de base) — PARCIAL, sem alteração

**Leitura do implementador:** a linha de base independente PASSA (50/50 + 6/6). Mutação independente confirmada só para MB2b e B1 (mortos pelo teste certo); MA16 o revisor não considera confiável (reprovou um teste de SIGKILL por tempo, sob disputa de CPU com a linha de base dele) e a equivalência com condição é a mesma demonstrada no teste `-r711`; **12 dos 15 ficaram sem resultado do revisor**. A cobertura completa de mutação é do **implementador** (`onda6c-relatorio-d1-barreira.md` §5: 17 + 5 mutantes novos mortos, bateria anterior reexecutada), **não** confirmada por segundo par de olhos além dos dois acima. Observação: o teste `crash` #18 falhou UMA vez no revisor sob carga paralela; na suíte completa isolada passou (1917/1917).

```
COMPLEMENTO do item F (rv7d) — PARCIAL: 3 de 15 mutantes concluídos

**(1) Linha de base sem mutação: PASSA**
- N4 (d1, seal-barrier, m2, r711, review7, crash, authority): 50/50 passam.
- Testes rápidos de capacidade (política, propriedade exaustiva, modelo puro nas 11 posições, PRIMEIRO dia, D3, mais o de fronteira e o de política pequena): 6/6 passam.

**(2) Mutações concluídas antes do envio exigido**
- **MB2b** (syncLedgerDirectory sem tripBase): MORTO. Primeiro teste reprovado: "D1: se o fsync do livro FALHA no caminho 'reemissão já registrada'…". Também reprovam "MB2b/RECOVER…" e os seguintes.
- **B1** (barreira sem a segunda conferência): MORTO. Primeiro teste reprovado: "BARREIRA sem janela TOCTOU: uma gravação CONCORRENTE entre a primeira leitura e a releitura…" (seal-barrier).
- **MA16** (adoção sem conferir opId): o registro diz MORTO, mas **não confio nesse resultado**. O único teste reprovado foi "SIGKILL ANTES do recibo…" (crash.test #18), que não exercita a adoção. Esse teste rodou ao mesmo tempo que a minha linha de base, com processos filhos disputando CPU, e o mais provável é ter falhado por tempo. Pelo código o mutante continua EQUIVALENTE com condição: se a conferência de MA15 (verifyTags/replayLedger) continuar no lugar, um CONFIRMED com opId de outra operação não casa com a INTENT no replay e nunca é adotado. O teste MA16 do r711 prova isso pela releitura. Para confirmar, rode MA16 de novo isolado.

**Ainda sem resultado: 12 mutantes** — B2 a B7, E1 a E6, e E4/E5 (que também rodam o teste de capacidade).

**Expectativa pela leitura do código (não confirmada por mutação)**
- B4 (barreira sem conferir a cabeça das decisões): deve ser EQUIVALENTE. Com o livro PROTECTED, sem operação aberta e com a mesma cabeça do livro, as decisões confirmadas são as mesmas.
- Os demais devem ser mortos pelos testes de d1 e seal-barrier.

**(3) Sobreviventes não equivalentes**
Nenhum até agora. Os 12 restantes não foram confirmados, então essa resposta ainda não está completa.
```
