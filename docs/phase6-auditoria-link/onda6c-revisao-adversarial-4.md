# Onda 6C — Revisão adversarial INDEPENDENTE de segurança (4ª rodada)

Data: 01/11/2026 · Objeto: `review-r4/proj/` (árvore atual, NÃO commitada) · Revisor: agente Claude (Opus 5.5), subagente independente, sem acesso ao raciocínio do implementador. Sou da **mesma família de modelo** do implementador, então pontos cegos correlacionados são possíveis; esta revisão **não substitui revisão humana**.
Ordem seguida: patches e código das fronteiras alteradas → experimentos próprios (`review-r4/rv4/`) → reexecução de todas as provas anteriores → por último os documentos do implementador, lidos como hipótese a refutar.

---

## 1. Veredito

**APROVADO COM RESSALVAS** — as cinco correções funcionam contra os ataques reportados e nenhum MAJOR/BLOCKER novo foi encontrado. Ficam 2 MINOR e 10 INFO.

- O **LIMITE declarado** (nenhum resultado selado depois da revogação) foi **reproduzido**: a revogada volta a valer **e é finalizada**. Na minha avaliação ele é **BLOQUEADOR para produção, não para encerrar a Onda**. Motivos:
  - Para reativar a decisão é preciso escrever em **duas pastas** (recibos de decisões + decisões) ou contar com um operador que mova a pendente apesar do aviso da tela e do §15 3(a). É a mesma classe do limite de duas pastas já declarado.
  - Nada foi implantado.
  - Sem o produtor P1, toda finalização em produção já responde `NOT_FINALIZABLE`.
- Condição para essa avaliação: **R4-MINOR-1** (rotação de chave) mostra que, depois de uma rotação, o procedimento escrito (§15 3(d) e runbook) leva o próprio operador a mover a pendente. Por isso a correção do procedimento precisa entrar **antes de qualquer rotação em produção**, junto com o marcador durável.

---

## 2. Achados

Escala: BLOCKER · MAJOR · MINOR · INFO. "CONFIRMADO" = reproduzido por mim nesta rodada, com política de coleta REAL e fiação de produção (`createResultsKnownHeads` injetado), salvo indicação.

### R4-MINOR-1 — Rotação ou ausência da chave de origem apaga a testemunha do resultado PENDENTE; o procedimento manda pôr em quarentena pendências "de chave antiga" e a revogada volta a valer e é finalizada — CONFIRMADO

- **Onde:**
  - `src/lib/link-audit-scoring-runs/results.ts:623`: só um resultado pendente com veredito `PROVEN` entra nas cabeças.
  - `src/app/api/link-audit/decisions/shared.ts:107` e `scoring/shared.ts:95`: com `originConfig` inválida, o provedor é montado **sem** autenticador e nenhum pendente conta.
  - Procedimento: `onda6b-decisoes-humanas.md:133` §15 3(d) ("Só uma pendente com origem NÃO comprovada (… de chave revogada) pode ir para a quarentena").
  - `onda6c-runbook-chaves.md:27` (§2 passo 2, "concluir ou colocar em quarentena as pendências em andamento"), `:31` ("pendências assinadas pela antiga … entram em quarentena"), `:40` (§3 passo 5).
  - `onda6c-integracao-orquestracao.md:654` ("quarentena manual do `sNNNN` pendente").
- **Passos** (`rv4/zz-rv4-a-witness.test.ts`, RV4-A7):
  1. O servidor "depois da rotação" verifica com `OTHER_ORIGIN`. op-0001 é criada e depois revogada.
  2. s1 é finalizado e assinado com a chave **antiga** (`TEST_ORIGIN`); ele registra o head seq 2, que é a revogação.
  3. Quem escreve só nos **recibos de resultados** remove `a0001`.
  4. Quem escreve só nos **recibos de decisões** remove `a0002`.
  5. A pendente `d0002` vai para a quarentena (pelo §15 3(d), ela é `UNPROVEN` depois da rotação).
  6. `s0001`, pendente e sem origem comprovável, vai para a quarentena (orquestração §11).
- **Saída (`rv4/rv4-a.out`):**
  ```
  A7 depois da rotação, nada removido: witness=CONSISTENT/1 …
  A7 recibo do resultado removido: witness=CONSISTENT/0 …          ← a testemunha sumiu
  A7 + recibo da revogação removido: witness=CONSISTENT/0 … pending=2
  A7 + d0002 em quarentena: witness=CONSISTENT/0 vigentes=["op-0001"] … applied=["op-0001"] allowed=true blockers=[]
  A7 finalização ⇒ CONFIRMADO s1 appliedIds=["op-0001"]
  A7 controle sem rotação (mesmos passos até a quarentena de d0002): witness=HISTORY_REGRESSED/1 vigentes=[] …
  A7 sem autenticador, recibos removidos + quarentena de d0002: witness=CONSISTENT/0 vigentes=["op-0001"] …
  ```
- **Impacto:**
  - A frase "remover o recibo do resultado não apaga a testemunha" (ADR 6C-02 `:55`, `:97`) só vale enquanto a chave que assinou o resultado ainda estiver no anel e a configuração de origem for válida.
  - Depois de uma rotação planejada (a aposentada vence em ≤ 93 dias), de uma rotação por comprometimento, ou com `ORIGIN_CONFIG_INVALID` (ex.: aposentada além do teto), quem escreve só nos recibos de resultados apaga a testemunha do último resultado.
  - Nessa situação a pendente de decisão também passa a `UNPROVEN`, e o §15 3(d) **autoriza** movê-la. É o mesmo efeito do LIMITE, numa janela maior: já não basta existir um resultado selado depois da revogação.
  - Em produção, hoje, nada definitivo é gravado (finalização fechada até o P1). A prévia e a lista de decisões, porém, mostram a revogada como vigente, sem alarme.
- **Correção sugerida:**
  - Em `createResultsKnownHeads`, contar a cabeça de **qualquer** resultado pendente, independentemente do veredito de origem, ou devolver `{ok:false}` se o pendente não for `PROVEN`. Isso **não** dá capacidade nova a quem escreve na pasta de resultados, que já congela tudo quebrando a cadeia (R4-INFO-2).
  - No §15: nunca mover uma pendente de **REVOGAÇÃO/SUBSTITUIÇÃO** cujo `originDetail` seja `KEY_EXPIRED`/`KEY_MISMATCH`/`KEY_REVOKED` sem fonte independente. Nunca mover um resultado pendente cujo head possa ser a única testemunha.
  - Harmonizar o runbook §2/§3 e a orquestração §11 com o §15 3(a) e com o texto da tela ("Não apague nem mova").

### R4-MINOR-2 — Documentação ainda afirma mais do que o código/testes demonstram — CONFIRMADO (leitura + provas)

| Trecho | Problema | Prova |
|---|---|---|
| ADR 6C-02 `:68`, `:97`; modelo I2 `:30`; checklist `:10` ("sem nenhum resultado selado depois da **decisão**") | A condição real é "depois da **revogação/substituição**". Um resultado selado depois da criação de op-0001, mas antes da revogação, não protege: a revogada volta e é finalizada | RV4-A3, variante 2: `s1 antes da revogação ⇒ CONFIRMADO s1` → `d0002 em quarentena: witness=CONSISTENT/1 vigentes=["op-0001"]` → `finalização ⇒ CONFIRMADO s1 appliedIds=["op-0001"]` |
| Modelo I2 `:30` ("…ou **perder a testemunha** NÃO reativa decisão") e ADR 6C-02 `:55` ("remover o recibo do resultado não apaga a testemunha") | Falso depois de rotação ou com configuração de origem inválida (R4-MINOR-1) e quando as duas pastas de resultados somem (declarado em outro ponto, mas não aqui) | RV4-A7; RV4-A4 "DUAS pastas ⇒ CONSISTENT … applied=["op-0001"]" |
| Checklist `:40` ("Sem eles a testemunha fica `NOT_CONFIGURED` **e isso é exibido**") | Sem pendente, a interface não exibe nada sobre a testemunha | RV4-E2: `witness = NOT_CONFIGURED ; a tela menciona testemunha? false` |
| Orquestração `:654` (quarentena manual do `sNNNN` pendente) e runbook §2 passo 2 / §3 passo 5 | Contradizem a tela ("Não apague nem mova o arquivo deste resultado") e o §15 3(a). O R3-MINOR-5 pedia "a mesma regra da 6B" para resultados | leitura; RV4-C2 (texto da tela) |
| ADR 6C-02 §10 / §4.5 ("concorrência" demonstrada) | O teste cobre dois reenvios simultâneos do autor, não a janela "cabeças lidas fora da trava" | RV4-A8 (R4-INFO-3) |

Correto e não exagerado:
- Contrato P1 (`onda6c-contrato-p1-atestacao.md:11`: a assinatura **não** prova a origem junto ao Google/Serper).
- ADR 6C-03 §4 (bidirecional, `legacy-status`, link simbólico), confere com RV4-B1..B4.
- §4.6 (avaliação do marcador durável): opções e custos plausíveis. "Cobre a janela … contra quem escreve uma pasta" é afirmação de projeto, ainda **não demonstrada**.
- O texto do LIMITE em si ("o sistema NÃO detecta e NÃO impede") é exato quanto ao efeito. Ver a imprecisão de "depois da decisão" acima.

### INFO

- **R4-INFO-1 — `NOT_CONFIGURED` falha aberta e a proteção é opcional por construção.**
  - Sem `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR` (ou `…_RESULTS_DIR`), a rota de decisões não monta a testemunha.
  - RV4-D1, após a quarentena: `decisões witness = NOT_CONFIGURED vigentes = ["op-0001"] finalizable = true` e `prévia … applied = ["op-0001"] allowed = true`. A finalização responderia 503, então nada definitivo é gravado.
  - `createDecisionService` sem `knownHeads` volta ao comportamento antigo, sem aviso. A prova original RV3-A1, que usa os serviços das fixtures sem testemunha, ainda mostra `finalização ⇒ CONFIRMADO s2 appliedIds=["op-0001"]`.
  - Sugestão:
    - tornar o provedor obrigatório (opção explícita `null`);
    - tratar `NOT_CONFIGURED` como não finalizável em produção;
    - mostrar um aviso também sem pendente.
- **R4-INFO-2 — Disponibilidade: quem escreve SÓ nos resultados congela as decisões.**
  - RV4-A6c: cadeia de resultados quebrada com decisões íntegras ⇒ `witness=UNAVAILABLE vigentes=[] … blockers=["DECISIONS_HISTORY_UNRESOLVED"]` e `escrita legítima ⇒ DECISIONS_HISTORY_UNRESOLVED`, inclusive revogações.
  - **Nada pior:**
    - pendente forjado (cadeia íntegra, head seq 9, sem etiqueta ou com outra chave) **não** é testemunha (A6a/A6b ⇒ `CONSISTENT`);
    - essa pessoa não produz `REGRESSED` nem `RECEIPT_LOST_WITNESSED`;
    - a prévia segue sem decisões e sem finalização.
  - Lacuna operacional: se o único backup de decisões for **anterior** ao último resultado, `HISTORY_REGRESSED` fica permanente e não há caminho de recuperação documentado.
- **R4-INFO-3 — Cabeças lidas fora da trava.**
  - RV4-A8: um resultado é finalizado e o histórico regride entre a leitura das cabeças e a trava ⇒ `escrita com cabeças desatualizadas ⇒ GRAVADA seq 2`.
  - A leitura seguinte acusa `HISTORY_DIVERGES` e congela, então nada fica reativado de forma persistente.
  - Sugestão: reler as cabeças dentro da trava.
- **R4-INFO-4 — O validador do cliente aceita prévias incoerentes.**
  - Com `HISTORY_REGRESSED`, aceita `applied:["op-0002"]` (`true`), `count:2` (`true`) e a ausência do bloqueio `DECISIONS_HISTORY_UNRESOLVED` (`true`).
  - Também aceita `UNAUTHENTICATED` sem o bloqueio `EVIDENCE_PROVENANCE_UNPROVEN` (`true`).
  - `finalization.allowed` incoerente é recusado (`false`), e o validador de **decisões** recusa todas as variações testadas (RV4-C1). Só importa com servidor defeituoso ou hostil.
- **R4-INFO-5 — O painel de resultado pendente não recebe a testemunha das decisões.**
  - Com histórico `HISTORY_REGRESSED`, o autor ainda vê "Concluir" (RV4-C2: `botão Concluir visível? true`). O servidor recusa (`autor tenta concluir ⇒ NOT_FINALIZABLE`).
  - O reenvio de um resultado **confirmado** com histórico não resolvido responde `200 definitive replayed=true`, sem gravar nada (RV4-D1).
- **R4-INFO-6 — Tela 5B ("Coleta de evidências").**
  - O cabeçalho ainda diz **"Integridade confirmada"**, sem "local/SHA-256", na posição 132 do texto, antes do nome forjado (634).
  - "Verificada no relatório" (1671) aparece em verde ao lado de fatos forjados. O aviso "não comprova quem fez a coleta" vem logo depois (1777), e "Origem … não avaliada nesta tela" fica no rodapé (7661 de 8153).
  - A 5B **não distingue** coleta autenticada de não comprovada. Não afirma autenticidade, mas a Onda 7 não deve consumir esse DTO sem proveniência.
  - A observação de site (não atestada, fora da base) também é exibida ali.
- **R4-INFO-7 — Provedor que nunca resolve pendura a leitura** (RV4-A5: `TIMEOUT 3s`). Não é alcançável com o provedor real: FIFO, diretório e link simbólico nos resultados e nos recibos falham em ≤ 48 ms (A4/E1). Sugestão: tempo limite como defesa.
- **R4-INFO-8 — Aninhamento por caminho real não cobre bind mount** (a mesma pasta montada duas vezes). PLAUSÍVEL, não testado: o ambiente isolado não tem namespace de montagem. Sugestão: comparar `dev`/`ino`.
- **R4-INFO-9 — Qualidade de testes.**
  - `link-audit-decisions-revocation-receipt.test.ts:344-358`: título "uma pendente não é testemunha" e mensagem "resultado SEM recibo não é testemunha". Passa só porque o provedor é criado **sem** autenticador, e contradiz o teste da `:303` e o ADR.
  - `link-audit-evidence-provenance.test.ts:249` aceita `NOT_FINALIZABLE || INPUT_CHANGED`, mas exercita o motivo certo (RV4-F1: `com o hash REAL ⇒ NOT_FINALIZABLE ["EVIDENCE_PROVENANCE_UNPROVEN"]`).
  - Provas da 3ª rodada copiadas **sem adaptação** "falham/passam" pelo motivo errado:
    - RV3-B4 (parâmetro `evidenceDir` removido: `direta ⇒ AUTHENTICATED ; via link ⇒ AUTHENTICATED`);
    - RV3-A1 (campo `decisionsWitness` removido);
    - RV3-F1 (passa com `undefined`).
  - As variantes adaptadas pelo implementador (`b4-api`, `a1-prod`, `f1-prod`) testam o motivo certo. Reexecutei-as.
  - O R3-INFO-7 foi corrigido (`:84` exige `DECISION_PENDING`).
- **R4-INFO-10 — Limites de duas pastas (declarados), reconfirmados.**
  - Evidências + manifestos ⇒ estado antigo autêntico (RV4-B2: `captura 2 E manifesto 2 apagados ⇒ … trust={"status":"AUTHENTICATED"}`).
  - Resultados + recibos de resultados ⇒ testemunha apagada (RV4-A4).
  - RV2-A3a, RV2-W1 e RV-03b continuam como antes.

---

## 3. Situação das correções desta rodada

| Item | Situação | Base |
|---|---|---|
| **R3-MINOR-1** (manifesto incompleto) | **RESOLVIDO** | RV4-B1 (detalhes abaixo) |
| **R3-MINOR-2** (reativação de revogada) | **RESOLVIDO para o cenário reportado e variantes de UMA pasta**; LIMITE confirmado; ressalva R4-MINOR-1 | RV4-A1/A2/A4/A6, D1 (detalhes abaixo) |
| **R3-MINOR-3** (`serper-status.json`) | **RESOLVIDO** | RV4-B3 (detalhes abaixo) |
| **R3-MINOR-4** (interface × autenticidade) | **RESOLVIDO na página Lumos**; **parcial na 5B** (R4-INFO-6) | RV4-C4 |
| **R3-MINOR-5** (recibo ausente) | **RESOLVIDO**; ressalvas R4-INFO-5 e doc `:654` (R4-MINOR-2) | RV4-C2, D1 |
| **6º — documentação (R3-MINOR-6)** | **PARCIAL** | itens antigos corrigidos; novos excessos em R4-MINOR-2 |
| Teto de 93 dias / relógio inválido / mensagens | **OK** | RV4-E3 |
| Aninhamento por caminho real | **OK** (exceto bind mount, R4-INFO-8) | RV4-B4 |
| Isolamento | **OK** | `src/lib/link-audit/scoring/` idêntico ao instantâneo r3 e ao workspace; `results.ts` não importa a 6B (o tipo do provedor é estrutural; a dependência transitiva via `preview.ts` já existia) |

**R3-MINOR-1 (RV4-B1):**
- Apagar a captura mais nova, a revisão r0002, ambas, captura + revisão ou só o relatório da captura ⇒ `EVIDENCE_MISSING` com `missingRefs` corretos.
- Captura do meio ⇒ `INTEGRITY_FAILED` (lacuna). Troca c0002↔c0003 ⇒ `INTEGRITY_FAILED`.
- Captura nova depois do manifesto ⇒ `EVIDENCE_NOT_SEALED`.
- `legacy-status` a mais no versionado ⇒ `EVIDENCE_MISSING`.
- `site:`/`capture:c1` ⇒ o próprio `createEvidenceSeal` recusa.
- O conjunto verificado é o mesmo objeto `basis` que vai ao mapeador (`preview.ts:205`), e `trust` entra no fingerprint.

**R3-MINOR-2 (RV4-A1/A2/A4/A6, D1):**
- Quarentena ⇒ `HISTORY_REGRESSED`, zero vigentes, `NOT_FINALIZABLE`, escritas e reenvio do autor ⇒ 409 `DECISIONS_HISTORY_UNRESOLVED`, para outros operadores e em serviço novo.
- Também cobertos: substituição, restauração parcial (arquivo sem recibo ⇒ `RECEIPT_LOST_WITNESSED` e o autor recupera; recibo sem arquivo ⇒ `DECISIONS_TRUNCATED`) e danos à testemunha de UMA pasta (nunca `CONSISTENT`).
- LIMITE confirmado (A3). Ressalvas: R4-MINOR-1 e R4-INFO-1/2/3.

**R3-MINOR-3 (RV4-B3):**
- Status 200→500, ou só espaço extra ⇒ `EVIDENCE_HASH_MISMATCH`. Removido ⇒ `INTEGRITY_FAILED`. Linha duplicada ⇒ `INTEGRITY_FAILED`.
- `serper-attempts`, `summary`, `run-stdout`/datas e `MANIFEST.json` reescritos ⇒ base e prévia **inalteradas** (`located=true coverage=9 refDate=2026-10-22`). Não achei arquivo fora do manifesto que mude perfil, data de referência, website/UTM, cobertura ou elegibilidade.
- No versionado, a observação de site não entra na base (apagá-la ⇒ continua `AUTHENTICATED` sem mudar nada).

**R3-MINOR-4 (RV4-C4):**
- Painel da empresa: "Integridade local verificada (SHA-256)" + "Origem da coleta NÃO comprovada" + motivo `EVIDENCE_MISSING` + "(ausente: report:c0001-r0002)" e rótulo por item.
- 5B: textos honestos, mas sem o veredito de origem e com o cabeçalho "Integridade confirmada".

**R3-MINOR-5 (RV4-C2, D1):**
- DTO com `receipt:"MISSING"` e `blocksFinalization:true` para todos.
- O validador recusa `PRESENT`/`false`/`isMine` sem `PROVEN`.
- Outro operador vê "NÃO confirmado", "removido", "não é uma confirmação" e "Não apague nem mova", sem botão e sem o e-mail do autor.

**Documentação (R3-MINOR-6):**
- Corrigidos: checklist `_PREVIOUS`, ADR 6C-03 §4, link simbólico, ADR 6C-02 §7/§8.
- Novos excessos: R4-MINOR-2.

### O LIMITE declarado

- Reproduzi as duas variantes (sem resultado; resultado só antes da revogação). Nas duas a revogada é **aplicada e finalizada**.
- O texto declara o efeito com exatidão e sem exagero. Ele é **impreciso** na condição ("depois da decisão") e **otimista** na mitigação procedimental depois de rotação (R4-MINOR-1).
- **BLOQUEADOR para produção, não para encerrar a Onda**, desde que:
  - o checklist mantenha o portão (ele está na `:10`);
  - o procedimento de rotação e quarentena seja corrigido antes de qualquer rotação em produção.

---

## 4. O que tentei e NÃO funcionou

**Revogação e testemunha:**
- Quarentena com testemunha (revogação e substituição) ⇒ `HISTORY_REGRESSED`.
- Reinício (serviço novo) ⇒ igual.
- Recibo sem arquivo ⇒ `DECISIONS_TRUNCATED`.
- Remover a pasta da auditoria nos resultados, truncar ou adulterar `s0001`, trocá-lo por FIFO, diretório ou link simbólico; raiz ausente; arquivo estranho; FIFO no recibo `a0001` ou na pasta de recibos ⇒ sempre `UNAVAILABLE`, em ≤ 48 ms.
- Remover o recibo do resultado sem rotação ⇒ pendente `PROVEN` continua testemunha (`HISTORY_REGRESSED`).
- Provedor que lança, `null`, sem `heads`, seq 0/10000, sha maiúsculo, getter que lança ⇒ `UNAVAILABLE`.
- Cabeças repetidas, fora de ordem ou 100 000 cabeças ⇒ correto (38 ms).
- Pendente de resultado forjado (cadeia íntegra, head além, sem etiqueta ou com outra chave) ⇒ não é testemunha e não congela.
- Evidência falhando (FIFO) com recibo removido ⇒ a 6B ainda informa `RECEIPT_LOST_WITNESSED` (o falso negativo do RV3-F1 sumiu).
- Pela API, com 3 operadores, nova decisão, revogação, conclusão pelo autor e finalização ⇒ 409, nada gravado; sem vazamento de motivo, caminho ou chave.

**Evidências:**
- Todas as remoções e trocas de UMA pasta da RV4-B1/B3 bloqueadas.
- Manifesto com `ref` fora do padrão: recusado já na produção do manifesto.
- Pasta de manifestos via link simbólico para dentro ou para o pai das evidências, ou outra pasta apontando para ela; `..`/barra final ⇒ `PROOF_NOT_CONFIGURED`.

**Chaves:**
- Aposentada até hoje+93 ⇒ aceita; +94 ou +3650 ⇒ `ORIGIN_CONFIG_INVALID`.
- Relógio `NaN` ou ausente na configuração ⇒ `ORIGIN_CONFIG_INVALID`.
- Na verificação: último segundo do dia ⇒ `PROVEN`; dia seguinte ⇒ `KEY_EXPIRED`; relógio inválido ⇒ `KEY_EXPIRED` (não lança).
- Nenhuma mensagem contém material.

**Provas anteriores, que continuam sem funcionar:**
- RV-01 e RV-04 (forja ⇒ `UNPROVEN`/`INVALID_BODY`, `vigentes = []`).
- RV2-A1/A2 (todas as variantes).
- RV2-A3b (`vigentes = []`, prévia bloqueada).
- RV2-F1 com política real (`NOT_FINALIZABLE`).
- RV3-B1/B2/B3 (`EVIDENCE_MISSING`/`EVIDENCE_HASH_MISMATCH`).
- RV3-B4 adaptada (`PROOF_NOT_CONFIGURED` nas duas formas).
- RV-02 (FIFO não trava).

---

## 5. Limitações

- Não rodei `next build`, o servidor Next ponta a ponta nem o navegador (B16). A interface foi conferida por renderização estática dos componentes reais, com DTOs reais dos serviços.
- Não testei bind mount (sem namespace de montagem no ambiente isolado) nem desempenho (P-3).
- Não houve corrida multiprocesso real: a janela "fora da trava" foi simulada deterministicamente.
- A rotação foi simulada com duas chaves de teste (`TEST_ORIGIN` → `OTHER_ORIGIN`), não com um anel com aposentada vencida. O veredito (`KEY_MISMATCH`/`KEY_EXPIRED` ⇒ não `PROVEN`) é o mesmo pelo código (`results.ts:623`).
- Mesma família de modelo do implementador ⇒ independência limitada.
- O `npm test` criou uma pasta vazia `proj/.data`; removi-a (`rmdir`). Nenhum outro arquivo do instantâneo foi alterado. As cópias temporárias `proj/tests/zz-rv4-*` foram removidas (0 arquivos `zz` restantes).
- Não abri nenhum `.env*`. Nada foi commitado nem enviado, e nada fora de `review-r4/` foi alterado.

---

## 6. Comandos e saídas-chave

Tudo em `review-r4/proj` via `scripts/run-isolated.sh` (namespace sem rede, `env -i`). Provas e saídas em `review-r4/rv4/`.

| Comando | Resultado |
|---|---|
| `scripts/run-isolated.sh npx tsc --noEmit --incremental false` | `TSC_EXIT=0` (`rv4/tsc.out`) |
| `scripts/run-isolated.sh npm test` | `# tests 1675 · # pass 1674 · # fail 0 · # skipped 1`, `SUITE_EXIT=0`, 163 s (`rv4/suite.out`) |
| `… --test tests/zz-rv4-a-witness.test.ts` | 8/8 (`rv4/rv4-a.out`) — A1/A2 protegidos; A3 LIMITE (`CONFIRMADO s1 appliedIds=["op-0001"]`); A4 uma pasta nunca `CONSISTENT`; A5; A6 (DoS); **A7 rotação**; A8 corrida |
| `… --test tests/zz-rv4-b-evidence.test.ts` | 4/4 (`rv4/rv4-b.out`) — B1..B4 |
| `… --test tests/zz-rv4-c-ui.test.tsx` | 4/4 (`rv4/rv4-c.out`) — validador, pendente de resultado, painel de decisões, 5B / painel da empresa |
| `… --test tests/zz-rv4-d-api.test.ts` | 1/1 (`rv4/rv4-d.out`) — rotas com 3 operadores; `NOT_CONFIGURED` |
| `… --test tests/zz-rv4-e-misc.test.tsx` | 3/3 (`rv4/rv4-e.out`) — FIFO nos recibos de resultados, `NOT_CONFIGURED` na tela, chaves |
| `… --test tests/zz-rv4-f-testquality.test.ts` | 1/1 (`rv4/rv4-f.out`) |
| Provas anteriores (`rv4/orig/*.out`, 18 arquivos) | r2a 5/2 (A3b e A7 falham ⇒ ataques não funcionam); rv-01 0/1 e rv-04 0/1 (não funcionam); rv3-b 3/4 (B1–B3 bloqueados pelo motivo certo; B4 pelo motivo ERRADO); rv3-b4-api (B4 pelo motivo certo); rv3-a 5/1 (A1 falha só pelo campo removido; o log mostra a reativação com serviços SEM testemunha); rv3-a1-prod 1/1 e rv3-f1-prod 1/1 (fiação de produção protege); rv3-g 1/1 (LIMITE presente); r2f 2/0 (só com o double que autentica tudo); r2f-real (`NOT_FINALIZABLE`); rv-02/rv-03/r2w/rv3-c/rv3-d/rv3-e ok |
