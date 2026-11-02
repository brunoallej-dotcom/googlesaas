# Onda 6C — Revisão adversarial INDEPENDENTE (5ª rodada): R4-MINOR-1 e INFO-1

Data: 01/11/2026 · Objeto: instantâneo da árvore não commitada após a correção de R4-MINOR-1 e INFO-1 · Revisor: subagente independente (sem acesso ao parecer do implementador; recebeu apenas o texto literal das duas exigências, o código e os patches).
Este arquivo **preserva sem edição** os dois relatórios do revisor: a 1ª passada (`relatorio-revisao-5.md`) e a re-verificação curta posterior às correções (`relatorio-revisao-5b.md`). O que foi feito com cada achado está em `onda6c-relatorio-r4minor1-info1.md` §5. Provas e mutações do revisor ficaram fora do repositório (`~/gmn-review-evidence-2026-10-31/round5-review/`). Resumo dos vereditos: 1ª passada — R4-MINOR-1 FECHADO COM RESSALVAS, INFO-1 FECHADO COM RESSALVAS; re-verificação — R4-MINOR-1 FECHADO COM RESSALVAS (resta o limite BLOQUEADOR da janela sem testemunha), INFO-1 FECHADO.

---

## PARTE 1 — Relatório da 1ª passada (texto original do revisor)

# Revisão independente adversarial 5 — R4-MINOR-1 e INFO-1 (GMN, auditoria por link)

Instantâneo: `.../review-r5/proj` (cópia). Tudo rodou por `scripts/run-isolated.sh` (rede vazia, `env -i`, sem `.env*`). Chaves de teste: as fictícias de `tests/helpers/link-audit-origin-fixtures.ts`. Evidências: `~/gmn-review-evidence-2026-10-31/round5-review/` (saídas `*.out`, tabelas `*.txt`, testes de prova em `tests-zz/`, mutações em `mutation/`).

## 1. Veredito (uma linha por alvo)

- **R4-MINOR-1: FECHADO COM RESSALVAS** — em 112 combinações (2 cenários x 7 perdas de prova x 8 estados de chave, cada uma lida por 2 serviços novos = reinício, mais escrita e finalização) nenhuma decisão revogada voltou a valer, nada ficou finalizável, nenhuma escrita/finalização foi aceita. Ressalvas: (a) o procedimento documentado (6B §15.3(d), runbook §2/§3.5) manda quarentenar justamente o que reativa (achado M-3); (b) o teste-matriz e a guarda estática não rodam em `npm test` (achado M-1); (c) o limite "janela sem testemunha" é mais largo do que a descrição dele (achado I-2).
- **INFO-1: FECHADO COM RESSALVAS** — todas as variações de configuração/armazenamento que tentei (25 casos pelas rotas, 6 com `chmod 000` real, 10 com E/S falha injetada, 28 respostas malformadas do provedor) terminam em estado bloqueante, sem escrita. Ressalvas: a defesa contra pastas sobrepostas é um parâmetro OPCIONAL e metade dos pontos de fiação não tem teste (M-2); o rótulo do motivo diverge do documentado em vários caminhos de E/S (I-1); volume de resultados vazio/novo é `UNWITNESSED` não bloqueante (limite declarado).
- **Algum caso COM vestígio remanescente ainda reativa uma revogada?** Sim, e é o mesmo limite declarado, só que mais largo do que o texto dele. Quando o resultado selado mais recente tem cabeça ANTERIOR à revogação (ou a revogação nunca foi seguida de resultado), perder `a000N` + mover `d000N` reativa a decisão com o resultado antigo intacto: `CONSISTENT`, `finalizable=true`, finalização aceita aplicando `op-0001` (prova E1). Não achei nenhum caso em que um resultado (confirmado, ou pendente) que COBRE a revogação permaneça e mesmo assim reative.

## 2. O que foi executado (provas)

| Linha | Arquivo de prova | Resultado |
|---|---|---|
| a. Matriz chave x perda | `tests-zz/zz-rv5-a.test.ts`, `A1-matrix.txt` | 112 linhas, 0 violações. Chaves: atual igual, aposentada válida/vencida, revogada, desconhecida, sem autenticador, relógio que passa a `Invalid Date` após o boot, config aposentada+revogada com o mesmo id (inválida). Perdas: recibo da revogação, recibo do resultado, os dois, +quarentena de `d0002`, só quarentena. Cenários: R1(head 2) e R1(head 1)+R2(head 2). `J1-extra-losses.txt`: mais 6 perdas da cadeia de resultados (todas `UNTRUSTED`, exceto o limite). |
| b. Indícios | `zz-rv5-b.test.ts`, `B-hints.txt` | Propriedade (40 000 casos): um indício só pode AGRAVAR (nunca suaviza um estado já não resolvido, não altera `knownHeads`/`coveredSeq`); sem cabeças e sem indícios nunca é `CONSISTENT`. 28 respostas de provedor (maiúsculas, seq 0/10000/1.5/"2"/NaN/null, duplicata, ordem, 2000/2001 indícios, `ok:"true"`, array, undefined, provedor que lança/rejeita/síncrono/`knownHeads` omitido em runtime) — todas bloqueiam ou são ignoradas por conferirem com o histórico; nada é promovido a testemunha. |
| c. Configuração | `zz-rv5-c.test.ts`, `C1-routes-config.txt` | 25 casos pelas ROTAS (decisões GET/POST/revogação, prévia, finalização, lista de resultados): ausente, vazia, só espaços, relativa, arquivo comum, link simbólico, A==B, aninhadas nos dois sentidos, A/B == decisões/recibos/evidências, `..`, `/` final, maiúsculas, inexistente. Em todos: `NOT_CONFIGURED`/`UNAVAILABLE`, 0 vigentes, 409 `DECISIONS_HISTORY_UNRESOLVED`, prévia `allowed=false` e `applied=[]`, finalização 503, nada gravado. `\0` não cabe em variável de ambiente; coberto no provedor (`assertBase`). `chmod 000` REAL: `zz-rv5-g.test.ts` com `setpriv --bounding-set=-dac_override,-dac_read_search` (o `unshare -r` dá root à namespace, que ignoraria o chmod; confirmei que a permissão foi aplicada), `G1-chmod000-real.txt`. `WITNESS_NOT_REQUIRED` só existe em `witness.ts`, `service.ts`, `index.ts` (re-exportado) e em 3 helpers de teste; os 2 únicos `createDecisionService(` de `src/` passam `knownHeads`. |
| d. Bloqueios | `zz-rv5-d.test.ts`, `D1-pending-conclusion.txt` | Nada ACTIVE (revogadas seguem `REVOKED`, as vigentes viram `AMBIGUOUS`), motor com 0 decisões. Conclusão de resultado PENDENTE com histórico não resolvido: autor com origem comprovada = `NOT_FINALIZABLE` (`DECISIONS_HISTORY_UNRESOLVED`); origem não comprovada = `RESULT_PENDING_ORIGIN_UNPROVEN`; outro operador = `RESULT_PENDING_UNCONFIRMED`; nenhum recibo nasce. Reenvio de resultado já CONFIRMADO devolve 200 `replayed` (não grava; `decisionsChanged` vem verdadeiro porque `!finalizable`). |
| e. Cobertura | `B1` + `E1` | `coveredSeq`/`unwitnessedAffecting` batem com a definição em todos os 40 000 casos (inclui a pendente testemunhada). A nota da UI só aparece com `unwitnessedAffecting>0` e diz "não é garantia"; some quando o ataque do E1 tem êxito (inerente). |
| f. Mutação | `mutation/*.out`, `mutate.py` | 30 mutantes, suíte focada de 187 testes (+ suíte ampla de 806 para o M18). Ver §4. |
| tsc | `tsc.out` | `npx tsc --noEmit --incremental false` na cópia limpa: sem erros. |

Suíte (42 arquivos link-audit decisions/scoring/origin/storage-conformance/audit-page = 806 testes): 805 passam, **1 falha** (M-1). Não rodei `npm test` inteiro nem os roteiros de navegador.

## 3. Achados

### M-1 MINOR (processo) — o teste-matriz de R4-MINOR-1 e a guarda estática de INFO-1 não rodam em `npm test`, e a suíte do projeto fica VERMELHA
- `package.json` (`scripts.test`, idêntico ao da rodada 4) não lista `tests/link-audit-decisions-witness-rotation.test.ts`. O meta-teste `tests/link-audit-decisions-isolation.test.ts:157-162` falha: `not ok 160 - o script de testes do package.json inclui TODOS os arquivos de teste da Onda 6B` / `link-audit-decisions-witness-rotation.test.ts não está no script de testes` (`baseline-42files.out`, linha 958).
- Esse arquivo contém a matriz 6 chaves x 5 perdas e o único teste que garante que `WITNESS_NOT_REQUIRED` não vaza para `src/` e que as duas rotas sempre passam `knownHeads`. Fora do `npm test`, uma regressão passa em silêncio (ou, com o meta-teste, o gate fica vermelho e alguém pode ignorá-lo).
- Correção: acrescentar o arquivo ao `scripts.test`.

### M-2 MINOR (defesa opcional + lacuna de teste) — `otherDirs` é opcional; sem ele, pastas sobrepostas voltam a ser fail-open
- `src/lib/link-audit-scoring-runs/results.ts` (`ResultsKnownHeadsOptions.otherDirs?`, uso em `createResultsKnownHeads`). Prova `zz-rv5-i.test.ts`: sem `otherDirs`, resultados apontando para a pasta de DECISÕES ou de EVIDÊNCIAS devolve `{ok:true, heads:[]}` (= `UNWITNESSED`, não bloqueante); com `otherDirs`, `NOT_CONFIGURED`. É a mesma classe do INFO-1 (configuração insegura lida como "sem inconsistência"). As rotas passam `otherDirs`, mas:
  - mutante M28 (remover `otherDirs` de `scoring/shared.ts`): **sobreviveu** (nenhum teste falha); M27 (mesma remoção em `decisions/shared.ts`) é pego por 1 teste.
  - mutantes M25/M26 (rotas montam o provedor SEM autenticador — a causa-raiz do RV4): **sobrevivem**. Efeito sobre segurança é benigno (indício e testemunha bloqueiam igual), mas só se altera rótulo/cobertura; fica sem teste de fiação.
- Correção: tornar `otherDirs` obrigatório (como `knownHeads`) ou checar sobreposição com as pastas de dados já na construção; teste de rota que prove `NOT_CONFIGURED` para "resultados == decisões/evidências" também na prévia.

### M-3 MINOR (procedimento perigoso) — a regra "pode quarentenar se NÃO comprovada" reabre a janela depois de uma rotação (mesma causa-raiz do R4-MINOR-1)
- 6B §15.3(d) ("Só uma pendente com origem NÃO comprovada pode ir para a quarentena ... `UNPROVEN`: forjada, sem etiqueta ou de chave revogada"), runbook `onda6c-runbook-chaves.md` §2 último item e §3 passo 5 ("Quarentena das pendências afetadas"), `onda6c-integracao-orquestracao.md:654` ("a quarentena só vale para pendência com origem NÃO comprovada").
- Mas depois de uma rotação por comprometimento uma revogação LEGÍTIMA com recibo perdido vira `UNPROVEN/KEY_REVOKED`. Prova `zz-rv5-e.test.ts` (E2, `E2-doc-6b-15.txt`): sem resultado selado, após a rotação `pending.origin=UNPROVEN/KEY_REVOKED, action=REVOKE, witness=UNWITNESSED`; seguindo §15.3(d) (quarentena de `d0002`) o resultado é `UNWITNESSED / vigentes=[op-0001] / finalizable=true`. A ressalva do runbook §6 ("ao ver UNTRUSTED/HISTORY_* não mova") não dispara, porque o estado é `UNWITNESSED`.
- Contradiz ADR §4.5 e runbook §6.2. Correção: a proibição de mover deve depender da AÇÃO (`REVOKE`/`SUPERSEDE`), nunca da prova de origem; remover do runbook §2/§3 a instrução de quarentena e trocá-la por "restaurar o par do backup independente".

### I-1 INFO — o rótulo do motivo diverge do documentado em E/S (todos falham FECHADO; só o diagnóstico engana)
`F1-errno-classes.txt` (E/S injetada) e `G1-chmod000-real.txt` (chmod 000 real):

| Falha | Rótulo obtido | Documentado (ADR §4.5 / modelo de ameaças 10d) |
|---|---|---|
| `readdir`/`readFile` de resultados (EACCES/EIO) | `UNAVAILABLE` | ok |
| `readdir`/`readFile` da pasta de RECIBOS dos resultados | `UNTRUSTED` ("cadeia não confere") | `UNAVAILABLE` |
| `lstat` falha (EACCES/EIO) na base ou na pasta da auditoria; `chmod 000` na pasta de resultados ou de recibos | `NOT_CONFIGURED` ("não está configurada") | `UNAVAILABLE` |
| exceção do tipo TypeError em `readdir` | `UNTRUSTED` | `UNAVAILABLE` |

Causa: `dirStatus` devolve `ERROR` e `readRunFiles`/`readReceipts` tratam tudo que não é `EXISTS` como `UNSAFE_PATH`; erros da pasta de recibos viram `ANCHOR_INTEGRITY` e `READ_ERRNO` só reconhece `CORRUPT` com "leitura:/listagem:". O teste 13 de `revocation-receipt` só simula `readdir` negado (um único ponto). Risco: operador procura variável de ambiente ou adulteração quando o problema é permissão/disco.

### I-2 INFO (honestidade da descrição do limite) — o limite real é "revogação/substituição sem resultado selado POSTERIOR", e basta perder `a000N` + `d000N`
- Prova `zz-rv5-e.test.ts` E1 (`E-limit.txt`): R1 selado com `head=1`; revogação `d0002` depois, sem novo resultado. Antes: `CONSISTENT, coveredSeq=1, unwitnessedAffecting=1`. Remover `a0002` e mover `d0002`: `CONSISTENT, unwitnessedAffecting=0, vigentes=[op-0001], finalizable=true` e a finalização é ACEITA com `appliedIds ["op-0001"]` (o resultado antigo R1 e o recibo dele continuam no lugar). `J1-extra-losses.txt`: com R2 e o recibo de R2 também removidos, idem.
- Código, UI (`WitnessCoverageNote`) e ADR §4.5 (primeira frase) dizem isso corretamente; checklist (bloqueador), 6B §16.10b, modelo de ameaças 10c e a descrição repetida em quatro documentos dizem "se TODOS os vestígios somem (decisão, recibo, resultado e recibo dele)", o que subestima a janela (a janela abre na revogação e só fecha no próximo resultado selado). Também: o rótulo `CONSISTENT` com cobertura parcial soa a garantia; só o campo/nota diz o contrário.

### I-3 INFO (qualidade de testes) — mutantes sobreviventes e testes que passam por acidente
- **M18 (real)**: remover `DECISIONS_HISTORY_UNRESOLVED` da guarda (2b) da CONCLUSÃO de resultado pendente (`results.ts`, dentro de `finalize`, ~linha 463) sobrevive aos 806 testes. Prova `zz-rv5-h.test.ts`: com testemunha `STORAGE_UNAVAILABLE`/`UNTRUSTED`/`NOT_CONFIGURED` e histórico local íntegro, o código atual responde `NOT_FINALIZABLE` e NÃO cria o recibo; com a mutação o autor conclui e o recibo é criado. É a única barreira nesses casos (a checagem `hoje.seq < gravado.seq` só pega o retrocesso).
- **M23**: validar/não validar `unverifiedHeads` com `HEAD_OK` não muda nenhum teste: o teste "indícios malformados" passa por acidente (um indício não conferido já resulta `UNTRUSTED`).
- **M32**: ignorar indício com `seq > len+1` (histórico perdido em vários passos) sobrevive: só se testa `seq = len+1`.
- **M13** (hash em maiúsculas aceito) é equivalente em segurança (a comparação falha igual).
- B17f (`i7-homologacao.cjs`) afirma "ZERO decisões vigentes (inclusive as que existem)" sem verificar antes que `IDS.main` tinha decisão vigente (plausível, não verificado: o passo 13a cria uma); B17i só confere `!== 'NOT_CONFIGURED'`. Não executei o roteiro.

### I-4 INFO (docs)
- 6B §15.3(c) lista `HISTORY_REGRESSED, HISTORY_DIVERGES, UNAVAILABLE` e esquece `UNTRUSTED` e `NOT_CONFIGURED`. ADR §7 cita o estado inexistente `HISTORY_DIVERGES_FROM_WITNESS`. ADR §4.5 diz que a conclusão de pendente "responde `NOT_FINALIZABLE`": são três códigos (ver D1), todos recusam.

### Lacunas de segurança da especificação do livro de cabeças (`onda6c-especificacao-livro-de-cabecas.md`) — só especificação, nada executável
1. §6 tabela, linha "livro atrasado de um": a recuperação "confere entrada + recibo + encadeamento e acrescenta o CONFIRMED". Falta exigir que exista um `INTENT` com o MESMO `seq/sha256` e que a etiqueta HMAC (domínio `DECISION`) da entrada confira. Sem isso, quem escreve em decisões + recibos (duas pastas; A1+A2 não está na tabela de atacantes, que só lista A7 = decisões+livro+resultados) forja entrada e recibo encadeados e o servidor os "abençoa" no livro. Além disso, entrada vencida por chave aposentada não é verificável: precisa de regra.
2. §6 mesma linha: "(não vigente enquanto não recuperado)" é ambíguo. Tem de dizer que o ALVO de uma revogação/substituição publicada sem `CONFIRMED` fica EM DÚVIDA (como a pendente de hoje); se "não vigente" significar que a revogação não vale, uma falha de escrita do livro reativa a decisão a cada leitura.
3. §8 `QUARANTINE_ACK` de uma pendente de revogação/substituição: não pode reativar o alvo em silêncio; exigir nova decisão humana explícita e dupla aprovação (Q5 aberta). `ABORTED`/`QUARANTINE_ACK` não distinguem "nunca publicada" de "removida": definir que só vale se o recibo também não existe E o ledger só tem `INTENT`.
4. §7 comprometimento de chave: o livro fica `UNTRUSTED` até conciliação com a guarda externa, que é a fase 4 e depende de decisão (Q6). Sem guarda, não há procedimento definido (congelamento permanente ou re-adoção às cegas — L4). Definir re-adoção a partir de backup independente com comparação de cabeças. `CHECKPOINT` só dentro da janela de aposentadoria (93 dias): perder a janela deixa a cauda do livro não verificável para todas as auditorias.
5. §11: definir o que é `LEDGER_ABSENT` para auditoria nova (histórico vazio: permitido) versus pasta do livro apagada/volume vazio (histórico não vazio: bloquear), e que a adoção após volume perdido compare com fonte independente.
6. §6 protocolo assume `replicas: 1` e trava por processo; o checklist §7 mencionou `replicas: 1`, mas a spec deveria declarar a premissa (com mais de uma réplica, `INTENT`/`CONFIRMED` intercalam: falso `LEDGER_BEHIND`) — plausível, não reproduzido.
7. Leitura do livro fora da trava de escrita (registrado como INFO anterior no código) precisa estar explícito na spec para não gerar falso `HISTORY_REGRESSED`.

## 4. Tabela de mutação (suíte focada: witness-rotation, revocation-receipt, decisions-api/service, scoring-preview-api/service, scoring-results-service, audit-page-validators)
Mortos (nº de testes que falham, motivo certo): M01 descartar `unverifiedHeads` (9); M02 ignorar indícios (8); M03 `NOT_CONFIGURED` não bloqueante (3); M04 `UNAVAILABLE` não bloqueante (4); M05 `UNTRUSTED` não bloqueante (9); M06/M07 rota sem pasta vira lista vazia (2/2); M08 erro de leitura vira lista vazia (5); M09 caminho inseguro vira lista vazia (1); M10 sem checagem de sobreposição (3); M11 provedor que lança vira lista vazia (2); M12 pendente sem prova promovida a testemunha (8); M14/M15 create/revoke ignoram o não resolvido (15/14); M16 decisões continuam vigentes (18); M17 prévia sem bloqueio (15); M19 sem cabeças = `CONSISTENT` (8); M20 cobertura 0 em vez de null (1); M21/M22 `ok:false`/malformado vira lista vazia (4/1); M27 rota de decisões sem `otherDirs` (1); M30 sem autenticador descarta indícios (4); M31 indício confere só pela posição (3).
Sobreviventes: M13 (equivalente), M18 (lacuna real, I-3), M23 (redundante/teste acidental), M25/M26 (fiação do autenticador), M28 (`otherDirs` da prévia), M32 (indício muito além do histórico).

## 5. Comandos
`scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test <arquivo(s)>` (zz-rv5-a..j, witness-rotation, revocation-receipt e a suíte de 42 arquivos); `scripts/run-isolated.sh npx tsc --noEmit --incremental false`; `scripts/run-isolated.sh setpriv --bounding-set=-dac_override,-dac_read_search --inh-caps=-dac_override,-dac_read_search node ... zz-rv5-g.test.ts`; mutações por `mutate.py` em 3 cópias do instantâneo (`mut`, `mut2`, `mut3`; a árvore `proj` ficou sem alterações além dos meus `zz-rv5-*`, removidos ao final e arquivados em `tests-zz/`).

## 6. Não verifiquei
Roteiros de navegador (B17 só lido e criticado); `npm test` completo; qualquer coisa fora de `src/lib/link-audit-decisions`, `link-audit-scoring-runs`, `link-audit-origin`, rotas e UI de witness; comportamento em Docker/volumes reais (volume não montado/vazio é `UNWITNESSED` por desenho, não testado em ambiente real); bind mounts, hard links, corridas de substituição de pasta durante a leitura e provedor que nunca responde (fora do escopo desta rodada); NTFS/drvfs reais; replicas > 1; a cobertura do UI com `unwitnessedAffecting>0` além da leitura do componente.

Tempo gasto: cerca de 50 minutos de relógio (inclui ~25 min de mutações em paralelo).


---

## PARTE 2 — Relatório da re-verificação (texto original do revisor)

# Re-verificação 5b — correções posteriores à revisão 5 (R4-MINOR-1 / INFO-1)

Instantâneo revisado: `.../review-r5b/proj` (versão ANTERIOR ao delta que moveu `probeDirectory` de `results.ts` para `results-store.ts`; o coordenador declarou comportamento idêntico e não pediu nova prova — **não re-verifiquei o delta**). Tudo por `scripts/run-isolated.sh`. Evidências: `~/gmn-review-evidence-2026-10-31/round5-review/rerun/` (saídas, `tests-zz/`, `mutation/`).

## Resultado por item

### 1. M-2 (`otherDirs` obrigatório + fiação das rotas) — FECHADO
- `ResultsKnownHeadsOptions.otherDirs` é obrigatório no tipo; `tsc --noEmit --incremental false` na cópia limpa: sem erros. As duas rotas (`decisions/shared.ts:108`, `scoring/shared.ts:95`) o passam.
- Um chamador JS que o omita **falha fechado em runtime**: `options.otherDirs.filter` lança dentro do `try` e vira `STORAGE_UNAVAILABLE` (prova `zz-rv5-i`: os 3 casos "resultados == decisões / recibos == recibos das decisões / resultados == evidências" sem `otherDirs` ⇒ `STORAGE_UNAVAILABLE`; com `otherDirs` ⇒ `NOT_CONFIGURED`).
- Mutação (suíte focada: witness-rotation, revocation-receipt, decisions-api, scoring-preview-api, decisions-isolation), todos MORTOS pelo motivo certo:
  - M25 (rota de decisões sem autenticador no provedor): morto por "FIAÇÃO das rotas…" (1 teste).
  - M26 (rota da prévia sem autenticador): morto por "FIAÇÃO da rota da prévia…" (1 teste).
  - M28b (prévia com `otherDirs: []`): morto por "INFO-1 pela rota da prévia…" (os novos casos resultados==decisões/evidências) — 1 teste.
  - M27b (decisões com `otherDirs: []`): morto por "INFO-1 pela API…" — 1 teste.
  - M28 / M27 (propriedade removida): 4 e 15 testes falham (tudo bloqueia por `UNAVAILABLE`).
- Os testes de fiação provam o que dizem: com a chave em vigor a pendente de resultado é testemunha (`HISTORY_REGRESSED`); com `GMN_LINK_AUDIT_ORIGIN_KEY` trocada e a antiga em `…_REVOKED_KEY_IDS` é só indício (`UNTRUSTED`).
- Bônus M-1 (achado da rodada anterior): `package.json` agora lista `witness-rotation`; os 5 arquivos (isolation, witness-rotation, revocation-receipt, decisions-api, scoring-preview-api) = 93/93 passam.

### 2. I-1 (rótulos) e sonda `probeDirectory` — FECHADO
- Rerun F1 (E/S injetada) e G1 (`chmod 000` REAL com `setpriv` descartando `CAP_DAC_OVERRIDE`/`CAP_DAC_READ_SEARCH`; permissão confirmada aplicada): **todos** os 10 + 6 casos agora dão `STORAGE_UNAVAILABLE` (`F1-errno-classes.txt`, `G1-chmod000-real.txt`): readdir/readFile/lstat em resultados E em recibos, base e pasta da auditoria, chmod 000 em qualquer ponto, TypeError em readdir. `NOT_CONFIGURED` ficou só para relativo/sobreposto/"existe e não é diretório comum" (arquivo, link simbólico — testado para resultados e recibos, base e pasta da auditoria).
- Fail-open pela sonda: **não encontrei**. `probeDirectory` só pode acrescentar recusas (nunca devolve `ok:true`); o único caminho que a deixa passar é ENOENT na pasta da auditoria (`mustExist=false`), que é o mesmo comportamento anterior (auditoria nova). Prova `zz-rv5-k` (`K1-probe-failopen.txt`, 26 casos):
  - `auditId` inválido (9 variantes: curto, `../etc`, maiúsculas, 70 chars, vazio, `a/../b`, com `\0`, número, null) ⇒ `STORAGE_UNAVAILABLE`.
  - base/recibos relativos ou vazios ⇒ `NOT_CONFIGURED`.
  - auditoria nova (sem nada em nenhuma pasta) ⇒ `ok heads=0` (legítimo, `UNWITNESSED`); resultados da auditoria removidos com recibos presentes ⇒ `UNTRUSTED`; `resultados/<audit>` ou `recibos/<audit>` trocado por arquivo ou link ⇒ `NOT_CONFIGURED`.
  - corrida simulada (1ª `lstat` da pasta da auditoria dá ENOENT falso, depois real) ⇒ `ok heads=1` (leitura seguinte é a real, o resultado é o correto); ENOENT permanente falso só nos resultados com recibos reais ⇒ `UNTRUSTED`; `lstat` sem `code` ⇒ `STORAGE_UNAVAILABLE`.
- NOVO ACHADO **INFO** (rótulo apenas; bloqueia igual): `baseDir` com `\0` (só alcançável fora das rotas, que já descartam `\0`) agora devolve `STORAGE_UNAVAILABLE` em vez de `NOT_CONFIGURED` (a sonda passa por `path.isAbsolute` e o `lstat` lança `ERR_INVALID_ARG_VALUE`). Também a regex `READ_ERRNO` (`results.ts`, `/\b(?:leitura|listagem)[^:]*: (?:E[A-Z0-9]+|DESCONHECIDO)\b/`) casa em texto de nome de arquivo suspeito ("Arquivo suspeito … leitura: EIO"), podendo trocar `UNTRUSTED` por `UNAVAILABLE`; mesma classe (ambos bloqueiam). Não executei esse spoof de nome (só o li no código).

### 3. I-3 (M18, M32) — FECHADO
- M18 (remover `DECISIONS_HISTORY_UNRESOLVED` da guarda de conclusão de pendente): MORTO por 2 testes novos de `witness-rotation` ("CONCLUSÃO de um resultado PENDENTE … NÃO resolvido…" e "… com a testemunha INDISPONÍVEL / NÃO CONFIÁVEL / NÃO CONFIGURADA e o histórico LOCAL íntegro…"). O segundo traz o controle: com a testemunha restaurada o MESMO pedido conclui, logo a recusa é por causa dela.
- M32 (ignorar indício com `seq > len+1`): MORTO pelo teste puro de `revocation-receipt` (`hint([], [head(9,'z')])` ⇒ `UNTRUSTED`).
- Os demais sobreviventes da rodada anterior (M13 equivalente; M23 redundante) não foram refeitos (fora do escopo pedido).

### 4. M-3 / I-2 / I-4 (documentos) — PARCIALMENTE FECHADO: restam descrições antigas
Corrigidos e coerentes: 6B §15.3 (a)-(e) (a proibição de mover pendente de revogação/substituição agora depende da AÇÃO, "qualquer origem", e (c) lista os 5 estados; (d) só criação simples); runbook §2 (impacto), §3.5, §6 (2/2b); orquestração item 11; checklist (bloqueador: "janela abre na revogação e fecha no próximo resultado", inclui `KEY_REVOKED`); modelo de ameaças 10c; 6B §16.10b; ADR §4.5 tabela/LIMITE (primeira parte) e a frase da conclusão de pendente (três códigos corretos).
Ainda existe a descrição ANTIGA (mais estreita) em:
- **ADR 6C-02 §4.5, parágrafo LIMITE, última frase** (`onda6c-adr-prova-de-origem.md:82`): "A regra de procedimento (nunca mover pendente **`PROVEN`** de revogação/substituição; …)". É exatamente a regra que o M-3 corrigiu; contradiz a 6B §15.3(a) (qualquer origem). **MINOR (doc)**: corrigir para "pendente de revogação/substituição de QUALQUER origem".
- `NOTES.md:97`: "a quarentena manual de uma pendente PROVEN de revogação ainda reativa a decisão" (só PROVEN, só "sem resultado depois da decisão"). INFO.
- `onda6c-relatorio-fechamento-seguranca.md:9` e `:97` (lista de BLOQUEADORES): idem (PROVEN, "depois da decisão"). INFO (relatório histórico, mas ainda lista o bloqueador).
- `onda6c-relatorio-r4minor1-info1.md:29` e `:35` (relatório novo): descreve o bloqueador como "com **todos** os vestígios removidos… volta" — a forma estreita. INFO/MINOR: o relatório de fechamento deve usar a forma exata (janela abre na revogação, fecha no próximo resultado).
- Nenhuma instrução restante manda quarentenar pendência de REVOGAÇÃO/SUBSTITUIÇÃO por causa da origem (verificado por busca em `docs/`, `deploy/`, `NOTES.md`) — salvo o ADR:82 acima, que é descrição de regra, não passo de procedimento.
- NOVO ACHADO **INFO**: o procedimento "**finalize logo depois de revogar/substituir**" (checklist bloqueador; runbook §6 (2b)) não é executável hoje: o mesmo checklist declara "FINALIZAÇÃO FECHADA POR DESENHO" até existir o produtor da prova de coleta (P1) — toda finalização responde `NOT_FINALIZABLE`. Em produção atual nenhum resultado selado pode nascer, logo a janela nunca fecha. Acrescentar a ressalva.

### 5. Especificação do livro de cabeças — as 7 lacunas FECHADAS; 1 NOVA lacuna MINOR + 1 INFO
Tratadas de forma segura: (1) §6 recuperação do "livro atrasado" exige `INTENT` casando `seq/sha256` + etiqueta `DECISION` verificável + recibo + encadeamento, senão "não recupera" (atacante A2b acrescentado à tabela); (2) o alvo de revogação/substituição sem `CONFIRMED` fica `AMBIGUOUS`, "não vigente" nunca significa "a revogação não vale"; (3) `QUARANTINE_ACK` com dupla aprovação, só sem recibo e sem `CONFIRMED`, sem efeito de reativação; `ABORTED` exige entrada ausente E recibo ausente E nenhum `CONFIRMED`; (4) comprometimento de chave: congelamento até re-adoção explícita a partir de backup independente; `CHECKPOINT` periódico (não só na rotação) e precondição de rotação; (5) §11 `LEDGER_ABSENT` com os dois sentidos (auditoria nova permitido × histórico não vazio/volume apagado bloqueia; adoção após volume perdido compara com fonte independente); (6) §6.1 premissa `replicas: 1`; (7) §6.1 leitura do livro dentro da trava na escrita e releitura única antes de concluir regressão na consulta.
- NOVO ACHADO **MINOR (spec)**: o `QUARANTINE_ACK` promete que "o alvo continua EM DÚVIDA", mas o registro do livro (§5) só guarda `decisions: { seq, sha256, affectsPrior }` — **não há o id da decisão alvo**. Depois que a entrada sai da cadeia (quarentena), nada identifica quem está em dúvida; a projeção da 6B (que já deriva o "em dúvida" do arquivo pendente) não teria o que ler. Correção: gravar no `INTENT`/`CONFIRMED` os ids afetados (`revokes`/`supersedes`) ou, na falta, tratar TODAS as decisões vigentes como em dúvida (histórico não resolvido).
- NOVO ACHADO **INFO (spec)**: o `CHECKPOINT` diário "sob a chave vigente" torna irreversível a confiança em registros forjados por uma chave comprometida ANTES de ser revogada (o servidor os verifica e depois os checkpointa). Declarar em L3 que, no incidente, os checkpoints posteriores à data suspeita de comprometimento precisam ser descartados na re-adoção.

### 6. B17 (`scripts/browser/i7-homologacao.cjs`, lido, não executado) — FECHADO
- B17f0 lê a auditoria principal com a configuração íntegra e exige `vigentes > 0` e `witness.status !== 'NOT_CONFIGURED'` antes de derrubar a variável: se a auditoria não tiver decisão vigente (ou seção A não rodou), a precondição falha em voz alta em vez de o B17f passar por vacuidade. Correto: nada entre B17f0 e B17i altera decisões (só variáveis de ambiente e reinícios); o passo 13a (A) é quem cria a decisão vigente de `IDS.main`; não há revogação posterior em `IDS.main`.
- B17i agora exige o mesmo número de vigentes e o mesmo `finalizable` do estado anterior. Nota **INFO**: o rótulo diz "e a escrita volta", mas nenhuma escrita é feita/afirmada; remover a frase ou acrescentar um POST.
- O delta do coordenador (isolamento): no instantâneo 5b que eu li, `tests/link-audit-scoring-runs-isolation.test.ts` falha ("I4: só results-store.ts toca o disco…" — `not ok 8`; 12 passam, 1 falha) porque `probeDirectory` estava em `results.ts`. Era vermelho ANTES do delta, como o coordenador indicou; não re-executei depois do delta.

## Comandos
`scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test …` (zz-rv5-f/g/i/k adaptados com `otherDirs`, mais os 5 arquivos de baseline e `scoring-runs-isolation`); `scripts/run-isolated.sh setpriv --bounding-set=-dac_override,-dac_read_search --inh-caps=-dac_override,-dac_read_search node … zz-rv5-g.test.ts`; `scripts/run-isolated.sh npx tsc --noEmit --incremental false`; `mutate5b.py` (M18, M25, M26, M27, M27b, M28, M28b, M32) em cópias do 5b. Meus testes `zz-rv5-*` removidos do instantâneo e arquivados em `rerun/tests-zz/`.

## Não verificado
Execução dos roteiros de navegador; `npm test` completo; o delta (`probeDirectory` em `results-store.ts` e o ajuste do teste de isolamento); spoof de nome de arquivo no `READ_ERRNO` (só leitura de código); volumes/Docker reais.

## Veredito
- **R4-MINOR-1: FECHADO COM RESSALVAS** — o código e os testes fecham o defeito (matriz da rodada anterior segue valendo; M18/M32 agora mortos); restam só a regra antiga em `onda6c-adr-prova-de-origem.md:82` (PROVEN) e o limite "janela sem testemunha" declarado, que continua BLOQUEADOR para produção (e não pode ser fechado por "finalize logo" enquanto a finalização estiver fechada por desenho).
- **INFO-1: FECHADO** — dependências da testemunha ausentes/ilegíveis/inseguras/sobrepostas falham fechado com o rótulo documentado (`otherDirs` obrigatório, fiação e rótulos de E/S provados por execução e por mutação); ressalva única já declarada: volume de resultados vazio/novo é `UNWITNESSED` por desenho.
