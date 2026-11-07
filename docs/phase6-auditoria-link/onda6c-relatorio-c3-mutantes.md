# C3 — Reexecução dos mutantes pendentes da Onda 6C (relatório PARCIAL)

Worktree isolado, `scripts/run-isolated.sh` (rede vazia). Cada mutante foi aplicado por substituição exata em `src/`, testado e restaurado com `git checkout -- src`.

## Resumo executivo

| Resultado | Qtde | Mutantes |
|---|---|---|
| MORTO | 11 | B2, B3, B4, B5, B6, B7, E1, E3, E4, E5 (execução interrompida, ver nota) e B1 (já confirmado pelo revisor 7d, não reexecutado aqui) |
| SOBREVIVEU, equivalente (por leitura) | 2 | E2, MA16 |
| SOBREVIVEU, LACUNA DE TESTE | 1 | E6 |
| PENDENTE | 0 | (E5: ver nota) |

Nota E5: a execução foi interrompida a pedido do coordenador. O log tem 3 reprovações já impressas (casos 1, 2 e 3 de `capacity`) e não tem a linha final de contagem. Como já há testes reprovados, o mutante está morto. Mas o resultado não tem o "exit=" de uma rodada completa.

A linha de base ficou verde, e todos os mutantes foram aplicados um por vez (nunca em paralelo), então não houve disputa de CPU entre rodadas.

## Linha de base (sem mutação)

- Conjunto rápido (15 arquivos `tests/link-audit-ledger-*`: d1, seal-barrier, m2, r711, review7, crash, authority, replay-durability, durability, consistency, concurrency, stale-evidence, q5, results, results-mismatch): **86/86 passam**, 78,6 s.
- Conjunto rápido + `link-audit-ledger-capacity.test.ts` (12 casos, ~5 min por causa do caso das posições 3990–4000 e da propriedade exaustiva): **98/98 passam** (rodada completa anterior, 370 s). Usado só para E4 e E5.
- Incidente de processo, sem efeito no resultado: a primeira bateria rodou sem lista de arquivos e executou a suíte inteira (1916 passam, 1 skip, 415 s). Foi descartada e refeita com a lista correta.

## Tabela por mutante

Os números de linha referem-se ao código da árvore de partida (`7013b2a`).

| Id | Mutação | Local mutado | Testes | Resultado | Teste que matou / justificativa |
|---|---|---|---|---|---|
| B1 | barreira sem a 2ª leitura | `link-audit-decisions/service.ts` `durabilityBarrier`, 2ª `api.list` | — | MORTO (revisor 7d, não reexecutado) | seal-barrier "BARREIRA sem janela TOCTOU…" |
| B2 | barreira sem `ledgerPort.sync` | `link-audit-decisions/service.ts` ~1032 | rápido | MORTO (5 reprovações) | seal-barrier: "BARREIRA: antes de selar, o livro (pasta E raiz)…", "BARREIRA com falha de fsync…", "…sem janela TOCTOU…", "CONCLUIR um resultado PENDENTE…", "CONTRATO da barreira com a base TRAVADA…" |
| B3 | barreira sem `syncDecisionDirectories` | `link-audit-decisions/service.ts` ~1035 | rápido | MORTO (1) | seal-barrier "BARREIRA: antes de selar, o livro…, as decisões, os recibos e os diretórios-pai são sincronizados…" |
| B4 | sem conferir a cabeça das decisões | `link-audit-decisions/service.ts` ~1022 | rápido | MORTO (1) | seal-barrier "CONTRATO da barreira (chamada direta): só `ok` com exatamente as cabeças avaliadas…". Atenção: a expectativa do revisor era "equivalente". Pelo caminho do serviço de resultados ela é de fato redundante (a vista já exige livro PROTECTED, sem operação aberta, e a avaliação da finalização reconfere). Mas o contrato público de `durabilityBarrier` a exige e o teste de chamada direta a mata. |
| B5 | sem conferir a cabeça do livro | `link-audit-decisions/service.ts` ~1023 (`false &&`) | rápido | MORTO (1) | o mesmo "CONTRATO da barreira (chamada direta)…" |
| B6 | sem barreira na conclusão | `link-audit-scoring-runs/results.ts` ~471 (`false && last.ledgerHead`) | rápido | MORTO (1) | seal-barrier "CONCLUIR um resultado PENDENTE que cita o livro também passa pela barreira…" |
| B7 | sem barreira na finalização | `link-audit-scoring-runs/results.ts` ~515 (`false && cited`) | rápido | MORTO (3) | seal-barrier "BARREIRA: antes de selar…", "BARREIRA com falha de fsync…", "…sem janela TOCTOU…" |
| MA16 | R6-04 aceita CONFIRMED sem conferir `opId` | `link-audit-ledger/service.ts` ~436 (`r.op?.opId === intentOp.opId` removido) | rápido (inclui r711, review7, crash) | SOBREVIVEU, **EQUIVALENTE com condição** | ver abaixo. Sem o falso "morto" do crash #18 do revisor: aqui o crash passou. |
| E1 | `begin` sem a prova de durabilidade (`ensureLedgerProven`) | `link-audit-ledger/service.ts` ~133 | rápido | MORTO (2) | d1/replay-durability: "REINÍCIO não é comprovação: depois de um fsync que falhou, o processo novo só lê o livro como PROTECTED DEPOIS de sincronizar…" e "a revalidação é UMA vez por processo e auditoria…" |
| E2 | `tripBase` não apaga as provas | `link-audit-storage/files.ts` ~176 | rápido | SOBREVIVEU, **EQUIVALENTE** | ver abaixo |
| E3 | reemissão "já registrada" sem sincronizar | `link-audit-ledger/service.ts` ~414-416 | rápido | MORTO (2) | d1: "D1 entre PROCESSOS: OUTRO processo publicou o RECEIPT_REISSUED com o fsync falho…" e "D1: se o fsync do livro FALHA no caminho 'reemissão já registrada'…" |
| E4 | vista (`simulateOperations`) sem a margem da reemissão | `link-audit-ledger/model.ts` ~210-211 | rápido + capacity | MORTO (1) | capacity "R7-01/D3: o que a vista anuncia desde o PRIMEIRO dia é um PISO… ≥ 1311 entradas…" |
| E5 | fórmula antiga da reserva (sem a reemissão) | `link-audit-ledger/types.ts` ~52 | rápido + capacity | MORTO (3 reprovações impressas) | capacity: "porta: `intent` recusa por CLASSE…", "política: os números, o alinhamento com a 6B e a conta das reservas", "propriedade exaustiva…". Rodada interrompida, ver nota. |
| E6 | `syncDecisionDirectories` sem travar a base | `link-audit-decisions/store.ts` ~566-567 | rápido | SOBREVIVEU, **LACUNA DE TESTE** | ver abaixo |

### Definições de E1–E6: derivadas
`onda6c-relatorio-d1-barreira.md` §5 só agrupa P01–P17 sem descrever E1–E6. A lista de `onda6c-revisao-adversarial-7d.md` §F dá um nome curto a cada um (E1 "sem a prova no begin", E2 "travar não apaga as provas", E3 "reemissão já registrada sem sincronizar", E4 "vista sem a margem da reemissão", E5 "fórmula antiga da reserva", E6 "syncDecisionDirectories sem trava"). Derivei a mutação mínima de cada nome lendo o código. B1–B7 seguem a ordem da lista do §F (B2 = sincronização do livro, B3 = pastas, B4 = cabeça das decisões, B5 = cabeça do livro, B6 = barreira da conclusão, B7 = barreira da finalização). E5 (fórmula antiga) foi derivado do §6 do relatório D1: 206 = 100 × 2 + checkpoints + 2, sem a reemissão.

## Sobreviventes

### MA16 (equivalente com condição)
Sem a conferência do `opId` em `confirmed()`, o CONFIRMED concorrente adotado ainda é validado por `verifyTags(...) === null && replayLedger(...).ok`. O `replayLedger` só aceita um CONFIRMED que case com a INTENT aberta por `sameOp`, e `sameOp` compara `opId` (`SAME_FIELDS`). Um CONFIRMED com `opId` alheio não casa com a INTENT, então o replay falha e a adoção é recusada, igual ao caso com a conferência. A condição é que o `replayLedger` continue exigindo `opId`. Se alguém afrouxar `SAME_FIELDS`, o MA16 deixa de ser equivalente. Nenhum teste razoável distingue os dois, e o teste MA16 do r711 prova a recusa pelas duas camadas.

### E2 (equivalente)
`begin()` (service.ts:119) devolve `DURABILITY_UNKNOWN` quando `ledgerDurabilityTripped`, ANTES de chegar em `ensureLedgerProven`. A única chamada de `ensureLedgerProven` fica depois dessa checagem (linha 133). `syncLedgerDirectory` também recusa antes com `isBaseTripped`. A base só destrava por `clearStorageFatal`, que já apaga as provas da raiz (ou por reinício, que zera o `Set`). Portanto não existe caminho de código em que uma raiz travada tenha prova residual consultada, e apagar as provas no `tripBase` é defesa em profundidade sem efeito observável. Nenhum teste de comportamento distingue (só um teste de unidade que inspecione `isDurabilityProven` direto após `tripBase`).

### E6 (LACUNA DE TESTE, MINOR a MAJOR conforme a plataforma)
Sem `tripBase(root)`/`tripBase(anchorRoot)`, uma falha de fsync nas pastas de decisões ou de recibos (ou nos diretórios-pai) durante a barreira devolve `STORAGE_FATAL`/`RESULT_DURABILITY_UNKNOWN` na 1ª finalização, mas NÃO trava as bases. Uma 2ª finalização com o disco "saudável" refaz o fsync, passa e sela citando uma cabeça cuja durabilidade foi posta em dúvida (efeito fsyncgate). Também ficam destravadas as escritas de decisões (store.ts:369). Por que sobrevive: o teste "BARREIRA com falha de fsync…" (seal-barrier, caso 75) injeta a falha só em `ledgerPort.sync` (proxy da porta do livro), que trava a base do LIVRO por outro caminho. Nenhum teste injeta falha no fsync das pastas de decisões/recibos dentro da barreira.
- Caso de teste proposto (não escrito): em `link-audit-ledger-seal-barrier.test.ts`, com a fixture do caso 75, injetar `fs.syncDirectory` que lança `EIO` só para o diretório de decisões (ou de recibos) da auditoria na 1ª chamada de `finalize`. Asserções: (1) 1ª finalização recusada com `RESULT_DURABILITY_UNKNOWN`, nada selado; (2) restaurar o `fs` saudável e finalizar de novo: continua recusada (`RESULT_DURABILITY_UNKNOWN`), nada selado; (3) `isStorageFatal` verdadeiro para a base de decisões e a de recibos; (4) uma gravação de decisão nova é recusada com `STORAGE_FATAL`; (5) após `clearStorageFatal` (reinício), finaliza e cita a cabeça comprovada. Mesma ideia, em chamada direta, para `syncDecisionDirectories` em `decisions-store`.
- Gravidade: a barreira ainda falha fechada na 1ª tentativa, então o risco real depende de a plataforma aceitar fsync bem-sucedido depois de um erro. Em ext4/xfs o erro costuma deixar o volume somente-leitura. Para o projeto, que declara "depois de um erro de fsync não se presume nada", é invariante central: **MAJOR de teste, risco prático MINOR**.

## Lacunas de teste propostas
1. **E6** (acima).
2. Opcional: teste de unidade que fixe a intenção de E2 (`tripBase` esquece provas). Hoje a propriedade é garantida por uma ordem de checagens, não por um teste.

## Limitações
- B1 não foi reexecutado (já confirmado MORTO pelo revisor 7d; fora da lista pedida).
- E5: execução interrompida a pedido do coordenador (ver acima). Vale reexecutar o mutante com o `capacity` completo, se for exigido o `exit=` de uma rodada inteira.
- Os testes do conjunto "rápido" não incluem `capacity` (lento); os mutantes B*, E1–E3, E6, MA16 só rodaram nos 15 arquivos listados, não na suíte completa nem em `decisions-*`/`scoring-results-*`. Uma sobrevivência (E2, E6, MA16) poderia ser morta por um desses, mas a primeira rodada acidental com a suíte inteira só foi concluída para B2–B4 (todos mortos); o resultado dos demais nesses arquivos não foi medido.
- A análise de equivalência de E2 e MA16 é por leitura de código, sem prova formal.
- A máquina esteve suspensa durante parte da bateria (os horários dos logs têm salto de ~1h30); nenhum resultado depende de tempo, e todos os mortos têm testes reprovados identificados por nome.

Nenhum arquivo de produção foi alterado de forma permanente.

## Atualização 07/11/2026 — lacuna E6 coberta (branch `chore/saneamento-tecnico`)

O caso de teste proposto acima foi implementado em `tests/link-audit-ledger-e6-barrier-fsync.test.ts` (6 testes; registrado no script `test`), **sem alterar nenhum arquivo de produção**:
- falha `EIO` injetada, só na 1ª tentativa, no fsync da pasta de decisões, da pasta de recibos e dos respectivos diretórios-pai, DENTRO da barreira de selamento;
- prova: (1) a 1ª finalização é recusada (`RESULT_DURABILITY_UNKNOWN`) e nada é selado; (2) com o disco saudável a 2ª continua recusada, nada é selado; (3) as bases de decisões e de recibos ficam travadas; (4) uma nova decisão é recusada (`DECISIONS_STORAGE_UNAVAILABLE`); (5) só depois do restabelecimento (`clearStorageFatal`) a finalização volta a funcionar e cita a cabeça comprovada; mais chamadas diretas de `syncDecisionDirectories` e `durabilityBarrier`.
- **Resultado no código real:** 6/6 passam. **No mutante E6** (removendo `tripBase(root); tripBase(anchorLocated.value.root);` de `syncDecisionDirectories`, aplicado só numa cópia de laboratório fora do repositório): **6/6 falham**, nos casos 1–4 com a 2ª finalização selando com o disco saudável (o efeito fsyncgate descrito acima). Mutantes parciais (só uma das duas linhas) falham em 5/6.
- **Não foi encontrada vulnerabilidade:** o código real trava as bases e a 2ª finalização continua recusada. O E6 deixa de ser lacuna de teste.
- Limites: a injeção é no `FsOps` do serviço (não em fsync real de disco); o ramo `unreadable` de `syncDecisionDirectories` não é coberto; não há teste com processo filho real para o E6.
