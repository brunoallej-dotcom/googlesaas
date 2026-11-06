# Onda 6C — Revisão independente nº 7c: re-verificação da correção final do M2 e dos testes R7-11 (05/11/2026)

**Parecer: BLOQUEAR COMMIT.** O revisor independente fechou o **M2**, mas achou **1 MAJOR novo — regressão introduzida por esta própria rodada** (D1: o pulo da reemissão de recibo "já registrada" devolve sucesso sem sincronizar o livro). Pela regra do responsável o processo foi **interrompido**: nenhuma correção foi iniciada depois do parecer. SEM commit; Onda 6C NÃO encerrada.

**Confirmação do implementador do D1 (leitura do código, `src/lib/link-audit-ledger/service.ts:408-409`):** `if (alreadyRecorded) return { kind: 'OK', pendingKind: null };` não passa por nenhum `fsync` do livro e a 6B então grava o recibo e devolve sucesso. Procedente. **Correção proposta, NÃO aplicada (aguarda autorização):** no pulo, chamar `syncLedgerDirectory` (pasta da auditoria + raiz) e recusar com `DECISIONS_DURABILITY_UNKNOWN` se não provar; teste = a reprodução T3 do revisor (reemissão publicada com fsync falho → reinício → reenvio só conclui depois de sincronizar o livro) + mutante.

**Revisor:** o mesmo da etapa anterior (contexto retomado), em instantâneo da árvore final (`review-r7c`, idêntico à árvore). Saída de revisor automatizado; não é aprovação do responsável.

## Parecer por item

| Item | Parecer independente |
|---|---|
| M2 (raiz do livro em toda publicação; precedência do fsync; fail-fast) | **FECHADO** — C1 e C2 originais deixaram de ocorrer; falha intermitente só na raiz / só na pasta da auditoria: sem sucesso, recuperação normal depois do reinício |
| Estado `DURABILITY_UNKNOWN` (leitura não protegida com a base travada) | **Sem problema encontrado** — payload real passa no validador da tela; não bloqueia a recuperação legítima nem cria negação de serviço persistente |
| Reemissão de recibo (consumo da reserva) | **MAJOR (D1, regressão):** pulo sem `fsync` do livro. O pulo em si não esconde troca de entrada (D2) |
| R7-11 (testes) | MA1, MB2, MA12, MA13, MA15, F7: **mortos**. MA16: **equivalente com condição**. P1 equivalente. **MB2b: lacuna de teste real (INFO)** |
| Janela pós-reinício (§16.13.1) | **MINOR evitável:** a finalização (`results.ts:387`) cita `ledgerHead` sem sincronizar o livro; um `ledger.port.sync` antes de selar fecharia a janela |

## Riscos residuais classificados
- D3: `RECEIPT_REISSUED` continua sem limite de CLASSE (1 por entrada confirmada cujo recibo é removido). Exige escrita na pasta de recibos + reenvio do autor; perto do limite pode deslocar a próxima revogação para fora da classe REVOKE (ex.: 3990 → 3991 → revogação +2 = 3993 > 3992). Disponibilidade; sem impacto de integridade; vetor que já existia (a alternativa do atacante é deixar a auditoria presa em `RECEIPT_REMOVED`).
- INTENT+ABORTED por tentativa falha: freio de 1 por 120 s confirmado (teste `-capacity-burn`); esgotamento exige horas de falha contínua com retentativas; não reproduzido.

## Texto integral do revisor (sem alteração)

```
RE-VERIFICAÇÃO Nº 3 (snapshot final review-r7c) — relatório

## Veredito
- **M2 está fechado.** Reproduzi os cenários C1 e C2 originais e os dois deixaram de ocorrer.
- **Há 1 MAJOR novo, regressão desta rodada:** a reemissão de recibo "já registrada" é pulada e devolve sucesso sem provar a durabilidade do livro (item D1).
- Nenhum BLOCKER.

## Como trabalhei
- Comparei review-r7b com review-r7c (diff -ru) e li o código antes de qualquer conclusão do implementador. As mudanças: store.ts e service.ts do livro (begin com DURABILITY_UNKNOWN, reissue com pulo), model.ts, ledger-port.ts e pending-panels.tsx; nos testes, m2, r711, capacity-burn, crash, review7 e ledger-child.
- Escrevi só na cópia rv7c e nas pastas temporárias do sistema. Sem rede, sem commit, sem tocar em ~/projects ou /mnt/d.
- Rodada de base, sem mutação, em 11 arquivos de teste do livro (r711, m2, review7, r6, durability, replay-durability, attacks, capacity-burn, keys, model, crash): 80/80 passam.

## A) M2 — fechado; não consegui quebrar
- Meus testes antigos C1 e C2 agora falham, ou seja, o defeito sumiu. C2: o fsync da raiz falhando junto com ENOSPC dá DECISIONS_DURABILITY_UNKNOWN nas duas inscrições, com 0 sucessos. C1: a inscrição com a raiz falhando não publica nada.
- T1 — falha intermitente, uma vez, só na RAIZ, na publicação do CONFIRMED: resposta DECISIONS_DURABILITY_UNKNOWN; o livro fica GENESIS,INTENT e o CONFIRMED não é publicado (falha antes de gravar); a lista passa a HISTORY_UNRESOLVED/DURABILITY_UNKNOWN, com 0 decisões e não finalizável; o RECOVER com a base travada é recusado; depois do reinício, o reenvio conclui por replay com a raiz sincronizada, e o livro fica GENESIS,INTENT,CONFIRMED.
- T2 — falha uma vez só na pasta da auditoria, na publicação da INTENT: sem sucesso. Depois do reinício: INTENT,ABORTED,INTENT,CONFIRMED, com a raiz sincronizada.
- Pelo código, a raiz agora é sincronizada antes de toda publicação (store.ts, publishLedgerRecord), e também em syncLedgerDirectory. Isso cobre RECOVER, replay e adoção. Os pais da 6B já estavam corrigidos.
- A única publicação que hoje devolve sucesso sem provar o livro é a do item D1.

## B) Garantias do fsync
- O modelo "um erro de fsync trava a base até reiniciar" está aplicado de forma consistente no livro e na 6B. Não achei nenhum sucesso devolvido no mesmo processo depois de um erro de fsync (exceto D1, que é pós-reinício).
- MINOR — janela pós-reinício declarada no §16.13.1, mas evitável: a finalização (results.ts:387) cita ledgerHead a partir da vista, sem sincronizar nem o livro nem as decisões. Um único ledger.port.sync (pasta da auditoria e raiz) antes de selar fecharia exatamente a janela que a especificação declara. É o único caminho que cria uma testemunha permanente sem sincronizar antes.
- INFO — escopo do novo estado: DURABILITY_UNKNOWN olha só a base do livro e vale para TODAS as auditorias daquela base até reiniciar. A trava da base da 6B não altera a vista do livro; não achei sucesso indevido por isso.

## C) Efeito do novo estado DURABILITY_UNKNOWN — sem problema encontrado
- O payload REAL da lista nesse estado passa no validador estrito da tela: motivo DURABILITY_UNKNOWN, capacity ausente, finalizable: false, zero decisões vigentes.
- O RECOVER nesse estado devolve falha (DECISIONS_DURABILITY_UNKNOWN), não um payload, então o validador do RECOVER nem entra em jogo.
- Não bloqueia a recuperação legítima: depois do reinício, T1 e T2 se recuperam normalmente. Não cria negação de serviço persistente, salvo se o fsync falhar sempre (limitação de plataforma já declarada).

## D) Reserva de capacidade

### D1 — MAJOR (regressão desta rodada)
- Onde: link-audit-ledger/service.ts:408-409. Quando já existe um RECEIPT_REISSUED, reissue() devolve OK sem gravar e sem sincronizar o livro. A 6B (decisions/store.ts:450 em diante) então grava o recibo e devolve sucesso.
- Reprodução (T3): (1) criação confirmada; removo o recibo. (2) O reenvio publica o RECEIPT_REISSUED (l000004), mas o fsync da pasta do livro falha: DECISIONS_DURABILITY_UNKNOWN e base travada. (3) Reinício. (4) O reenvio devolve ok. O livro fica GENESIS,INTENT,CONFIRMED,RECEIPT_REISSUED e o registro de fsyncs do livro é []: nenhum fsync do livro neste processo.
- Pelo mesmo caminho de código (sem fsync no pulo), basta o processo morrer entre o link() e o fsync. Não testei esse caso separadamente.
- Impacto: a cabeça do livro passa a ser esse RECEIPT_REISSUED de durabilidade não provada. Um resultado selado em seguida o cita. Se ele se perder numa queda, a auditoria fica RESULT_LEDGER_MISMATCH permanente, sem reabertura administrativa. Mesmo nível de impacto de M1 e M2. Sem resultado selado, perde-se só a evidência da reemissão.

### D2 — o pulo em si
- Não esconde mudança de entrada: o plano exige que a pendente case com o último CONFIRMED.
- T4: com 3 remoções do mesmo recibo fica só 1 registro no livro. É o custo já declarado: remoções repetidas ficam invisíveis no livro.
- Com 4000 registros, uma reemissão ainda não registrada continua sem caber (já declarado).

### D3 — INFO, outros consumidores da reserva
- RECEIPT_REISSUED continua sem limite de classe: 1 registro por operação confirmada cujo recibo é removido.
- Perto do limite, uma remoção mais o reenvio do autor gravam um registro que nenhuma classe barra. Exemplo: com 3990 registros a reemissão ocupa 3991, e a próxima revogação (+2 = 3993) passa do limite REVOKE de 3992. Exige escrita na pasta de recibos e o reenvio do autor. A alternativa para o atacante é deixar a auditoria presa em RECEIPT_REMOVED, então é um vetor de disponibilidade que já existia.
- INTENT+ABORTED: confirmei pela leitura do código e pelo teste capacity-burn o freio de 1 tentativa falha (2 registros) por período de 120 s. Só uma falha persistente com o operador insistindo ao longo de horas, já depois de 3786 registros, consome a reserva de revogação. Não reproduzi esgotamento real.

## E) Mutações contra os testes do repositório (com a rodada de base passando 80/80)
- MA1: morto (teste r711). MB2 (publishLedgerRecord sem trava): morto. MA12: morto. MA13: morto — concordo que NÃO é equivalente: com falha intermitente dentro de confirmAnchor, o syncStrict seguinte teria sucesso sem observar o erro anterior. MA15: morto. F7: morto. P2 (sem falha antecipada da raiz): morto. P3 (raiz não sincronizada): morto. P4 (sem o estado DURABILITY_UNKNOWN): morto. P5 (sem o pulo da reemissão): morto.
- MA16: sobrevive — concordo que é equivalente, com condição: a releitura exige replayLedger, que casa o opId com a INTENT. Deixa de ser equivalente se a checagem de MA15 também for removida.
- P1 (precedência antiga): sobrevive — equivalente: com a falha antecipada da raiz, o único fsync restante (o da pasta) só roda no caminho de sucesso de publishExclusive.
- MB2b (syncLedgerDirectory sem tripBase): sobrevive — lacuna de teste real (INFO). Nenhum teste prova que uma falha em RECOVER, replay ou adoção trava a base. Uma segunda chamada com o disco "saudável" teria sucesso. O código hoje trava; só falta o teste.

## F) Outros
Fora D1, não achei outra regressão. A tela aceita o novo motivo e a lista de motivos foi atualizada (pending-panels.tsx).

## O que NÃO verifiquei
Queda real de energia e o comportamento do volume de produção; rotas HTTP e o Next empacotado; o caso D1 com morte do processo (testei só com fsync falhando); os testes longos de capacidade nesta rodada.
```
