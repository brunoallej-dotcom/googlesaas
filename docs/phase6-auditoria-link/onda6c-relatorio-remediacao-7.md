# Onda 6C — Relatório de REMEDIAÇÃO da revisão nº 7 (04/11/2026)

**Estado: SEM commit. Onda 6C NÃO encerrada.** Autorização recebida: corrigir R7-01 a R7-06; sem commit, push, merge, rebase, tag, deploy, VPS, `stack.yml`, Dockerfile, entrypoint, P1, D5 ou Onda 7. O registro da revisão está em `onda6c-revisao-adversarial-7.md` (o **texto verbatim do revisor nº 7 não existe neste workspace**; ver lá). Este arquivo é a remediação; o parecer do revisor não foi alterado.

**Contexto de recuperação.** O disco do WSL falhou em 03/11/2026 às 21h12 (último minuto de edição da sessão anterior). A árvore foi conferida em 04/11: idêntica, por hash, ao instantâneo `<INSTANTANEO_DE_RECUPERACAO>` (532 arquivos), `git fsck --full` sem erro e os 74 arquivos antes ilegíveis agora legíveis. O código R7 já estava parcialmente na árvore (R7-01…R7-07); esta rodada o verificou, corrigiu o que faltava e fechou a prova.

## 1. Causa-raiz de R7-01
A reserva de R6-01 (4 registros) era **por operação, não por classe**: `CREATE` consumia o espaço até ~4000 e deixava revogações e o `CHECKPOINT` da rotação sem lugar; a "reserva de 100 revogações" da 6B era uma constante anunciada, e 100 entradas de ledger são 50 operações, não 100. Detalhe e números: spec §16.12.

## 2. Política final e limites reais
`MAX` 4000 total. `RECORD` ≤ 3786, `REVOKE` ≤ 3992, manutenção ≤ 4000 (8 registros que decisões/revogações nunca usam; reserva de revogação = 206 registros = 100 revogações + checkpoints + folga). Uma `INTENT` só entra se ela e o fecho cabem na classe; a vista anuncia só o que a MESMA função executa e **desconta o fecho de operação aberta**. Limites reais: **1863 decisões novas / 1965 entradas por auditoria** (não 9999), **≥ 101 revogações completas** após a última decisão nova (propriedade exaustiva, ~650 mil estados). `limits.maxEntries` e `limits.reservedForRevocations` agora refletem isso. Limitação mantida e proposta de continuidade (segmentação por época, só com aprovação administrativa, NÃO implementada): spec §16.12.

## 3. Situação de R7-01 a R7-11

| Id | Situação | Prova |
|---|---|---|
| R7-01 | **Corrigido** | `-capacity` (modelo puro nas 11 posições; **serviço real nas 11 posições 3990–4000**; 5 processos na fronteira; "operação iniciada sempre termina"), `-authority` (porta), mutantes M01, M02, M14–M16, M23 |
| R7-02 | **Corrigido** | `-rotation` (perto da capacidade, chave a vencer, SIGKILL antes/depois do CHECKPOINT, retomada, idempotência, concorrência com CREATE/REVOKE, comprometida), mutantes M03, M04 |
| R7-03 | **Corrigido (documentação + prova)** | Runbook §7 passos 3–4 reescritos: **não existe botão** na rotação; é `POST …/ledger {"action":"RECOVER"}` + `keyCoverage.covered`; fase B coberta. Nenhuma ação administrativa criada. `-runbook` executa o procedimento pelas rotas reais |
| R7-04 | **Corrigido** (3 resíduos fechados nesta rodada: reenvio de entrada já confirmada; pai nunca ressincronizado; dono que adota CONFIRMED alheio) | `-durability`, `-replay-durability`, `-review7` (processos filhos reais + injeção de falha), mutantes M05–M08, M18, M20, M22 |
| R7-05 | **Corrigido** (resíduo da revisão: citação além da cabeça lida na releitura) | `-consistency` (corrida injetada em cada ponto; 4 processos × 60 leituras), `-review7` R2; M17, M21 |
| R7-06 | **Corrigido** | `-stale-evidence` (TOCTOU construído, evidência mudando no RECOVER, benigno × contraditório, testemunha das decisões, origem); M09, M10, M13 |
| R7-07 | **Corrigido** (nomes confundíveis falham fechado; nunca lidos como registro nem ignorados em silêncio) | `-names`; M12 |
| R7-08 | **(texto recuperado em 05/11)** INFO, pré-existente na 6B: nome de arquivo e texto nativo em `DECISIONS_INTEGRITY`; **não corrigido**; não permite DoS, autenticação indevida nem bloqueio de recuperação | confirmado também pela re-verificação (`-7b`) |
| R7-09 | **Corrigido** — era "limite travado", mas permitia negação de serviço **persistente** (regra do responsável: não aceitar). INTENT do futuro vence por observação monotônica (`observed.ts`, §16.15). A revisão independente achou um defeito na minha primeira versão (idade fracionária violava o esquema e o `ABORTED` nunca era gravado); corrigido | `-clock`, `-review7` R6 (relógio real); M11, M19 |
| R7-10 | **Risco residual documentado, limitado** (já havia leitura paralela limitada). Medido em 04/11 com 3990 registros, WSL, sob carga: `list` ≈ 3,4 s, `revoke` ≈ 3,3 s. Custo linear e limitado pelo teto de 4000; não é negação de serviço persistente. Otimizar mais exigiria índice/cache — fora do escopo | medição (script descartável) |
| R7-11 | **(texto recuperado em 05/11)** qualidade dos testes: MA1, MB2, MA12, MA13, MA15, MA16 continuam sobrevivendo aos testes atuais (código correto; MA16 equivalente); **testes ainda não escritos** | `-7b`, §R7-11 |

## 4. Revisão independente (agente novo, instantâneo, código lido antes das conclusões)
Veredito do revisor: **1 BLOCKER, 3 MAJOR, 3 MINOR, 3 INFO**. Não os aceitei por autoridade: reproduzi (as provas dele passavam quando o defeito existia) e corrigi.
- **B1 (BLOCKER)** ageMs fracionário ⇒ R7-09 não funcionava em produção — **corrigido** (`Math.floor`; teste com relógio real).
- **M1 (MAJOR)** dono adotava o CONFIRMED de outro processo sem sincronizar — **corrigido**.
- **M2 (MAJOR)** pai cujo fsync falhou nunca ressincronizado após reinício — **corrigido** (livro: `syncLedgerDirectory` inclui o pai; 6B: toda gravação e retomada sincronizam os pais; custo 2 fsyncs por gravação).
- **M3 (MAJOR)** corrida legítima ainda gerava `RESULT_LEDGER_MISMATCH` no `revalidate` — **corrigido** (citação além da cabeça lida ⇒ releitura limitada; citação dentro do lido que não confere continua bloqueando).
- **m1** vista anunciava 1 decisão a mais com operação aberta — **corrigido**.
- **m2** reenvio idempotente de decisão já confirmada é recusado por capacidade quando a classe esgotou (mensagem "nada gravado" é verdadeira; a decisão original segue confirmada) — **risco residual documentado**.
- **m3** `RECEIPT_REISSUED` sem limite de classe: cada tentativa de reemissão cujo recibo falha grava 1 registro — **risco residual documentado** (modelo de ameaças §8b.1: só quem tem escrita nas pastas ou disco falhando; a vista permanece honesta).
- INFO: `list` com relógio EPOCH (prévia) mostra a operação aberta como vencida (só a vista); descarte FIFO (não LRU) da memória de observação, limitada e sem vazamento; o runbook de rotação deve exigir **parar todos os processos com a chave antiga** antes de iniciar os da nova (uma atualização gradual gera `UNTRUSTED` pela regra de época) — acrescentado à lista de riscos.
- **Não conseguiu quebrar** (com prova do revisor): capacidade sem operação aberta (67.536 estados + testes de posições), concorrência na capacidade, recuperação indevida de operação viva, `GUARD_MISMATCH` falso, preservação da pendência, fase C.
- Limites do revisor: sem queda de energia real, sem guarda externa real, só os 4 arquivos de teste do livro, sem rotas HTTP para M3/B1.

**Parecer da revisão: houve BLOCKER e MAJOR ⇒ a autorização de commit fica INTERROMPIDA** (regra do responsável) mesmo com as correções feitas e testadas aqui: elas **não** foram revisadas por revisor independente. Recomendação: nova revisão curta **só destas correções** antes de qualquer commit.

## 5. Mutantes
24 mutações textuais no `src/` (capacidade por classe, INTENT sem fecho, reserva fixa/zero, rotação, fsync do pai/RECOVER/reenvio/adoção/ensureDurable, testemunha relida/não resolvida/origem, nomes, ordem guarda→livro, idade só de parede, floor, citação adiante, fecho da operação aberta): **todas mortas**, cada uma pelo motivo esperado. Sobreviveram inicialmente M01, M02, M08, M13 (e M20, M23 depois) — fraquezas reais dos testes, **fechadas** com `-authority`, ressincronização na retomada, retargeting e `-review7`. O corpo do script ficou no scratchpad da sessão (descartável).

## 6. Verificação final
Executada sobre a árvore FINAL (depois das correções da revisão independente), isolada, uma coisa por vez:
- `tsc --noEmit`: **0 erros**. Suíte completa `npm test`: **1888/1888** (a linha de base de hoje, antes de qualquer alteração, tinha 3 testes velhos reprovados — `-isolation` ×2 e `-r6` — por mensagens/nomes que a rodada R7 mudou; corrigidos na própria asserção, sem enfraquecê-la). O "1829/1830" anterior não foi usado.
- Build offline de produção: ok. Chromium: **I5 41/41, I6 107/107, I7 171/171 (+3 SKIPPED)**; **I7 repetido 5× isoladamente: 171/171 em todas** (estável).
- Os testes incluem: 5 processos reais concorrentes (`-concurrency`, `-capacity`, `-rotation`, `-consistency`), SIGKILL real antes/depois de cada etapa durável (`-crash`, `-rotation`), processos filhos com falha de fsync por injeção (`-durability`, `-replay-durability`, `-review7`).
- **24 mutantes** no `src/`: todos mortos (ver §5; M24 incluído).
- `git diff --check`: limpo. `src/lib/link-audit/scoring/` idêntico a `v1.0.1` (0 linhas de diferença).
- **Regressão minha, achada pelo Chromium e corrigida:** ao descontar o fecho da operação aberta na capacidade (m1) deixei `remainingRecords` com 1 a menos; o validador estrito da tela exige `usados + restantes = máximo` e recusou o payload de toda auditoria com operação aberta (I6/I7 caíram para 104/107 e 168/171). O teste de suíte NÃO pegou (só o navegador). Correção + teste de CONTRATO com o validador do cliente (`-review7`, fases A e B) + mutante M24. Lição: payload novo precisa de teste de contrato com o validador da tela.

## 7. Arquivos alterados nesta rodada (além dos 90 já pendentes)
Código: `src/lib/link-audit-ledger/{observed.ts (novo),model.ts,service.ts,store.ts,types.ts,index.ts}`, `src/lib/link-audit-decisions/{ledger-port.ts,store.ts,service.ts}`. Testes novos: `link-audit-ledger-{authority,clock,replay-durability,review7,runbook}`; ajustados: `-capacity`, `-durability`, `-isolation`, `-r6`, `-rotation`, helpers `ledger-child.ts` e `link-audit-ledger-fixtures.ts`; `package.json` (lista de testes). Docs: spec §16.12–§16.15, runbook §7, ADR 11.2, modelo de ameaças §8b.1, checklist, NOTES.md, `onda6c-revisao-adversarial-7.md`, este arquivo.

## 8. Riscos residuais
(a) m2 e m3 acima; (b) R7-10 ≈ 3 s com 4000 registros; (c) livro fixo de 4000 sem segmentação (continuidade só com papel administrativo que não existe); (d) fsync/queda de energia reais e o volume de produção não ensaiados; (e) guarda externa real e papel administrativo continuam **bloqueadores de produção**; (f) R7-08 e R7-11 sem texto do revisor; (g) atualização gradual de chave do livro (parar processos antigos antes dos novos); (h) as correções M1–M3/B1 **sem revisão independente**.

## 9. Atualização de 05/11/2026 — re-verificação independente
O revisor reverificou as correções: B1, M1 e M3 **fechados**; **M2 reaberto como MAJOR** (raiz do livro). Detalhes e texto integral em `onda6c-revisao-adversarial-7b.md`. Parecer: **BLOQUEAR COMMIT**. R7-08/R7-11 deixaram de ser "não classificáveis" (relatório original recuperado).

## 10. Parecer para autorização de commit (04/11/2026, anterior à re-verificação)
**NÃO recomendado agora.** O revisor independente achou BLOCKER e MAJORs; todos foram corrigidos e provados, mas só uma nova revisão focalizada pode retirá-los. Pendências do responsável: relatório verbatim do revisor nº 7 (R7-08, R7-11) e decisão sobre uma re-verificação curta.

## 11. Atualização de 05/11/2026 (2ª) — M2 e R7-11
M2 corrigido e R7-11 coberto por testes; reavaliação independente: **novo MAJOR D1** (regressão do pulo da reemissão). Ver `onda6c-relatorio-m2-r711.md` e `onda6c-revisao-adversarial-7c.md`. Parecer: **BLOQUEAR COMMIT**.

## 12. Atualização de 05/11/2026 (3ª) — D1, barreira antes de selar, D3
D1 corrigido; barreira de durabilidade antes de selar/concluir resultados implementada; D3 reproduzido e corrigido. Revisão independente da árvore final: sem BLOCKER/MAJOR novo. Ver `onda6c-relatorio-d1-barreira.md` e `onda6c-revisao-adversarial-7d.md`.
