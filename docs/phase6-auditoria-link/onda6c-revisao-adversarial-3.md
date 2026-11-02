# Onda 6C — Revisão adversarial INDEPENDENTE de segurança (3ª rodada)

Data: 01/11/2026 · Objeto: `review-r3/proj/` (árvore atual, NÃO commitada) · Revisor: agente Claude (Opus 5.5), subagente independente, sem acesso ao raciocínio do implementador. Mesma família de modelo do implementador ⇒ risco de pontos cegos correlacionados; **não substitui revisão humana**.
Ordem seguida: patches e código das fronteiras alteradas → experimentos próprios (`review-r3/rv3/`) → reexecução das provas anteriores → por último os quatro documentos do implementador.

---

## 1. Veredito

**APROVADO COM RESSALVAS** — nenhum BLOCKER/MAJOR aberto: a fabricação de fatos só na pasta de evidências não é mais finalizável (padrão de produção e política real), e nenhuma decisão revogada volta a ser aplicada **enquanto a pendência existir**; restam 6 MINOR (rollback de evidência autêntica, ressurreição após a quarentena sem uso da testemunha na finalização, status do legado fora do manifesto, telas que mostram fatos não autênticos como "Verificada", aviso de resultados só para o autor e documentação mais forte que o código) e 9 INFO.

---

## 2. Achados

Escala: BLOCKER · MAJOR · MINOR · INFO. "CONFIRMADO" = reproduzido por mim nesta rodada.

### R3-MINOR-1 — ROLLBACK por quem escreve SÓ na pasta de evidências: apagar a captura (ou a revisão de relatório) mais nova faz a anterior, também atestada, virar a base AUTENTICADA e FINALIZÁVEL — CONFIRMADO

- **Onde:** `src/lib/link-audit-evidence/provenance.ts:216-222` (só confere base ⊆ manifesto: cada evidência lida precisa estar no manifesto; NÃO confere que tudo o que o manifesto cumulativo atesta ainda existe); `scoring-basis.ts:252-276,313-329` (perfil = captura mais recente existente; revisões contíguas 1..n aceitam remover a última).
- **Passos:** `rv3/zz-rv3-b-evidence.test.ts`, RV3-B1: `world()` + 2ª captura legítima (telefone novo) → `sealAuditForTests` atesta c0001+c0002 (manifesto cumulativo, política REAL `createSealedEvidenceProvenance`) → apagar `c0002.capture.json`, `c0002.site.json` e `c0002.report-r0001.json` (só a pasta de evidências) → `evaluate` → `finalize`. RV3-B2: apagar `c0001.report-r0002.json` (revisão atestada mais nova).
- **Saída (`rv3/rv3-b.out`):**
  `ANTES: profileSource = {"ref":"capture:c0002",…} ; provenance = {"status":"AUTHENTICATED"} ; phone = "(62) 98888-7777"` →
  `DEPOIS: profileSource = {"ref":"capture:c0001",…} ; provenance = {"status":"AUTHENTICATED","reason":null} ; phone = "(62) 99999-0000" ; finalization.allowed = true` →
  `finalização sobre a base "recuada" ⇒ CONFIRMADO s1`.
  RV3-B2: `ANTES: reportEvidence = {"maps-name":"NOT_VERIFIED"}` → `DEPOIS (r0002 apagada): reportEvidence = {"maps-name":"VERIFIED",…} ; trust = {"status":"AUTHENTICATED"}`.
- **Impacto:** o atacante não fabrica fatos, mas **escolhe qual passado autêntico vale** e o resultado definitivo é gravado sobre ele (sem nenhuma marca de que existia coleta mais nova atestada). Contradiz o ADR 6C-03 ("apagar manifestos ou capturas impede a finalização (fail-safe), nunca a falsifica"; "o atacante não escolhe qual passado vale") e o modelo §5 ("remover manifestos/capturas bloqueia a finalização"). Atenuantes: só funciona se nenhum resultado anterior fixou a captura apagada (`changedPinnedEvidence` acusaria `EVIDENCE_HASH_CHANGED`, RV2-F2); juízo C2 carimbado na captura apagada fica retido; hoje o mapeador só produz INCONCLUSIVO; em produção o volume de evidências é `:ro` no web.
- **Correção sugerida:** no verificador, exigir também **manifesto ⊆ base** para `capture:`/`report:` (evidências são imutáveis e nunca apagadas legitimamente; faltando uma atestada ⇒ novo motivo `EVIDENCE_MISSING`, falha fechada); corrigir ADR 6C-03 §4/limites e modelo §5.

### R3-MINOR-2 — Revogação: a testemunha só é usada ENQUANTO há pendente; depois da quarentena (procedimento 6B §15 item 3) a decisão revogada volta a ser APLICADA e é FINALIZADA, sem alarme — CONFIRMADO

- **Onde:** `src/lib/link-audit-scoring-runs/results.ts:200-213,601` (`witnessDecisionReceipt` só roda com `pending`; recebe a pendente da PRÉVIA); `results.ts:497-500` (finalização compara o head só com `expectedHead` do cliente, nunca com o `decisionsHead` dos resultados confirmados); `docs/.../onda6b-decisoes-humanas.md:133` (§15 item 3: sem `head` guardado maior, "mova o `dNNNN.json` para a quarentena").
- **Passos e saídas:**
  (a) **Com testemunha** — `rv3/zz-rv3-a-revocation.test.tsx` RV3-A1: cria op-0001, revoga, finaliza s1 (head seq 2), remove `a0002` (só recibos) ⇒ `witness = RECEIPT_LOST_WITNESSED`; um operador move `d0002` (ou atacante de duas pastas remove d0002+a0002) ⇒ `vigentes = [["op-0001","ACTIVE"]] ; pending = null ; witness = NO_PENDING ; s1.decisionsHead = {"seq":2,…} ; head atual = {"seq":1,…}` → `prévia: applied = ["op-0001"] ; allowed = true ; blockers = []` → `finalização ⇒ CONFIRMADO s2 appliedIds=["op-0001"] head={"seq":1,…}`.
  (b) **Sem testemunha** — `rv3/zz-rv3-g-unwitnessed.test.ts` RV3-G1: mesmo cenário sem resultado posterior ⇒ `witness = NOT_WITNESSED ; pending = ["REVOKE","PROVEN",false]`; seguindo o §15 item 3 (autor indisponível, mover a pendente) ⇒ `applied = ["op-0001"] ; finalização ⇒ CONFIRMADO s1`.
  (c) **Falso negativo da testemunha** — `rv3/zz-rv3-f-witness.test.ts` RV3-F1: com a testemunha válida, uma falha de leitura da base de evidências (FIFO com nome de relatório) faz a prévia falhar e a lista de resultados dizer `NO_PENDING` havendo pendente: `testemunha com evidência íntegra ⇒ RECEIPT_LOST_WITNESSED ; com evidência falhando ⇒ NO_PENDING ; decisões: pending = ["REVOKE","PROVEN"] ambiguous = ["op-0001"]` (a tela some com o aviso de incidente).
- **Impacto:** a decisão (I2) "nunca reativar" vale enquanto o arquivo pendente existe. Um atacante só da pasta de recibos + o procedimento documentado (autor ausente, sem resultado posterior) — ou um operador que move a pendente apesar do aviso — ressuscita uma decisão revogada e ela entra num resultado definitivo; mesmo quando um resultado confirmado testemunha o head posterior, a finalização não o consulta. Contradiz ADR 6C-02 §7/§8 ("Recibos das decisões … NÃO consegue … reviver revogada") e modelo §6.1 ("nunca reativa").
- **Correção sugerida:** (1) na prévia/finalização, recusar (`HISTORY_REGRESSED`/`DIVERGES`) quando o head atual estiver atrás de qualquer `decisions.head` de resultado confirmado, ou diferir na mesma posição; (2) calcular a testemunha a partir da leitura das decisões (não da prévia inteira) e, se não der para calcular, dizer "testemunha indisponível", nunca `NO_PENDING`; (3) no §15: nunca mover uma pendente **PROVEN** de REVOGAÇÃO/SUBSTITUIÇÃO (ela foi gravada pelo servidor em nome de um operador autenticado); prever conclusão por administrador com origem comprovada em vez de mover; (4) corrigir os textos "nunca reativa".

### R3-MINOR-3 — LEGADO: `serper-status.json` decide se o perfil existe, mas não está no manifesto: base AUTENTICADA com o perfil autêntico suprimido, e finalizável — CONFIRMADO

- **Onde:** `src/lib/link-audit-evidence/scoring-basis.ts:345-366` (evidências do legado = corpo + relatórios) × `:371-394` (o perfil depende de `verifiedStatusText`, cujo hash só é conferido contra o `SHA256SUMS`, que quem escreve na pasta refaz).
- **Passos:** `rv3/zz-rv3-b-evidence.test.ts` RV3-B3: réplica legada (mesmo gerador dos testes do projeto) dentro do `world` → atesta tudo → reescreve `serper-status.json` (500) e a linha do `SHA256SUMS`.
- **Saída:** `manifesto atesta: ["capture:c0001","report:c0001-r0002"]` → `ANTES: located = true ; provenance = AUTHENTICATED ; coverage = 9 ; allowed = true` → `DEPOIS: located = false ; provenance = {"status":"AUTHENTICATED"} ; integridade = OK ; coverage = 0 ; allowed = true ; blockers = ["PROFILE_UNAVAILABLE"]`.
- **Impacto:** quem escreve só nas evidências altera o que chega ao motor numa coleta legada já atestada, sem perder a autenticidade (supressão; o inverso, 500→200, faria usar o corpo de uma resposta que a coleta registrou como falha). Contradiz a "regra de cobertura" do ADR 6C-03 §4 e a invariante I3. Limitado ao layout legado (que só fica autêntico por atestação explícita).
- **Correção sugerida:** incluir o hash do `serper-status.json` na evidência `capture:c0001` do legado (ex.: hash sobre corpo+status) ou como ref própria no manifesto; ou não depender do status no legado atestado.

### R3-MINOR-4 — Fatos NÃO autênticos aparecem rotulados como "Verificada"/"Integridade confirmada" fora do painel da prévia — CONFIRMADO

- **Onde:** `src/components/link-audit/stored-audit-detail.tsx:91,132` (tela "Coleta de evidências", 5B: sem nenhum campo de proveniência; o DTO do leitor não a tem); `audit-page/company-panel.tsx:28,52` (selo verde "Integridade das evidências OK" e lista "Evidências verificadas usadas" incluindo a captura forjada, sem marca por item; o rótulo de autenticidade é só uma linha da lista de dados).
- **Passos/saída:** RV3-A6 (render real do componente com o DTO real do leitor sobre captura forjada pelo pipeline): `Estabelecimento Nome Padaria FORJADA pelo invasor … | contém "Verificada"? true | … Integridade confirmada … | fala de origem/autenticidade/manifesto? false`. RV3-B6: o DTO do leitor 5B traz `"Padaria FORJADA pelo invasor"`, `integrity = "OK"`, nenhum campo de proveniência.
- **Impacto:** nenhum registro definitivo (a finalização continua bloqueada), mas o operador vê fatos fabricados apresentados como verificados; risco maior quando a Onda 7 (PDF) consumir essas telas/DTOs.
- **Correção sugerida:** levar o veredito de proveniência ao leitor 5B e à lista de auditorias (selo "coleta NÃO comprovada" ao lado da integridade), trocar "Evidências verificadas usadas" por "Evidências usadas (integridade OK; autenticidade: …)" e marcar por item o que o manifesto não cobre.

### R3-MINOR-5 — R2-MINOR-2(a) só foi tratado para DECISÕES: o painel de RESULTADO pendente ainda não avisa "interrompida × recibo removido" a quem não é o autor, e resultados não têm testemunha — CONFIRMADO

- **Onde:** `src/components/link-audit/audit-page/pending-panels.tsx:110`.
- **Saída:** RV2-B1 reexecutado (`rv3/orig-zz-rv2-b-ui.out`): `menciona "removido": resultado/outro = false ; decisão/outro = true`; RV3-D2: `"Resultado s0004 gravado e NÃO confirmado … Gravado por outro operador … Somente o autor pode concluí-lo …" ; menciona "removido"? false`.
- **Impacto:** quem conduz a quarentena de um resultado órfão (`onda6c-integracao-orquestracao.md:654`, "quarentena manual do sNNNN") não é avisado de que pode estar apagando o último resultado CONFIRMADO cujo recibo foi removido (RV-03a continua: confirmado → pendente PROVEN).
- **Correção sugerida:** o mesmo `PendingImpact` no painel de resultados para todos os perfis; procedimento de quarentena de resultado com a mesma regra da 6B.

### R3-MINOR-6 — Documentação mais forte que o código/testes — CONFIRMADO (por leitura + provas acima)

| Trecho | Problema | Prova |
|---|---|---|
| ADR 6C-03 l.43/52 ("Apaga… ⇒ disponibilidade"; "apagar manifestos ou **capturas** impede a finalização (fail-safe), nunca a falsifica"); l.31 ("o atacante não escolhe qual passado vale"); modelo l.61 ("remover manifestos/capturas bloqueia a finalização") | Apagar a captura/revisão mais nova é aceito, autenticado e finalizado | R3-MINOR-1 |
| ADR 6C-03 l.30 ("**toda** evidência que o leitor entrega à base…") e modelo I3 (l.31) | O status do legado influencia a base fora do manifesto | R3-MINOR-3 |
| ADR 6C-03 l.27 ("nunca … aninhada nela — a configuração que viole isso é tratada como fechada") | A recusa é só léxica (`provenance.ts:238-242`, `path.resolve`, sem `realpath`): a mesma pasta via link simbólico é aceita | RV3-B4: `aninhada direta ⇒ PROOF_NOT_CONFIGURED ; a MESMA pasta via link simbólico ⇒ AUTHENTICATED` |
| Modelo I2/§6.1 ("nunca reativa"), ADR 6C-02 l.88 e l.95 (§8: recibos "NÃO consegue … reviver revogada") | Verdade só enquanto a pendente existe; o procedimento documentado e a finalização sem testemunha reativam | R3-MINOR-2 |
| ADR 6C-02 §10 ("ambiguidade a todos os perfis") | Não vale para resultados | R3-MINOR-5 |
| `onda6c-checklist-producao.md:48` | Ainda manda rotacionar com `GMN_LINK_AUDIT_ORIGIN_KEY_PREVIOUS`, contradizendo a linha 47 e o runbook (no código a variável é ignorada ⇒ falha segura) | leitura; RV3-C1 `_PREVIOUS=vazada ⇒ KEY_MISMATCH` |

A tabela "garantia × teste" do ADR 6C-02 §10 aponta testes que existem e passam; ressalva em R3-INFO-7 (um deles passa por motivo errado).

### INFO

- **R3-INFO-1 — Pendente FORJADA (só pasta de decisões) derruba uma decisão legítima da PRÉVIA** (disponibilidade; a finalização já era bloqueada por qualquer pendente). RV3-A2: `pending = ["REVOKE","UNPROVEN","MISSING"] ; ambiguous = ["op-0001"]`; `antes applied = ["op-0001"] / coverage 15 ; depois applied = [] / coverage 11 ; allowed = false`; a prévia passa a oferecer C2 como nova (`reasonCode: null`), mas a gravação é recusada (`PENDING_UNCONFIRMED`). Nada pior encontrado. CONFIRMADO.
- **R3-INFO-2 — Validador do cliente não cruza pendente × vigentes/aplicadas** (`validators.ts:55,122-137`). RV3-A4: resposta com pendente REVOKE op-0001, op-0001 `ACTIVE` em `decisions` e `ambiguousDecisionIds: []` ⇒ aceita (`true`); prévia com pendente REVOKE op-0001 e `applied: ["op-0001"]` ⇒ aceita (`true`). Só importa com servidor defeituoso/hostil. CONFIRMADO.
- **R3-INFO-3 — Interface contraditória com `HISTORY_DIVERGES_FROM_WITNESS`:** o autor vê "Não conclua nada por esta tela" e, abaixo, o botão "Concluir a decisão" (`pending-panels.tsx:139,183`); o servidor não consulta a testemunha ao concluir. RV3-A5: `autor / HISTORY_DIVERGES_FROM_WITNESS: … botão "Concluir"? true ; diz "Não conclua"? true`. Nenhum botão sem origem comprovada; outro operador não vê motivo/conteúdo (vê o e-mail do autor da pendente PROVEN, que já é público no histórico). CONFIRMADO.
- **R3-INFO-4 — Chaves:** (a) aposentada sem teto de validade (`…:9999-12-31` aceita; a vazada posta como aposentada continua `PROVEN`); (b) a etiqueta não cobre o `kid`: o material vazado recolocado sob OUTRO id escapa da revogação por id (erro de operação); (c) `verify` "nunca lança", mas lança `RangeError` com relógio inválido (`index.ts:177`; inalcançável pelas rotas, que usam `new Date()`); (d) `sha256("senha123")` em hex passa no filtro (declarado: não prova entropia). RV3-C1. CONFIRMADO.
- **R3-INFO-5 — Maleabilidade inócua do manifesto:** bits de preenchimento do último caractere base64url e chave JSON duplicada (vale a última) continuam `AUTHENTICATED` (a assinatura cobre o valor, não os bytes). Sem impacto. CONFIRMADO.
- **R3-INFO-6 — Coerência de config:** a pasta de manifestos não é comparada com decisões/recibos/resultados (só com evidências) — sem impacto de forja (assinatura), só de disponibilidade.
- **R3-INFO-7 — Teste que passa pelo motivo errado:** `tests/link-audit-decisions-revocation-receipt.test.ts:76` envia `expectedInputSha256: 'a'×64` e é recusado por `INPUT_CHANGED`, não pelo bloqueio. Com o hash REAL o comportamento está correto: RV3-E1 `com "a"×64 ⇒ INPUT_CHANGED ; com o hash REAL ⇒ NOT_FINALIZABLE ["DECISION_PENDING"]`. CONFIRMADO.
- **R3-INFO-8 — Fixtures:** `previewOver` usa `TRUSTING_EVIDENCE_POLICY` em 15 arquivos de teste (assuntos não-proveniência); a prova RV2-F1 original ainda "passa" só por isso. Com o padrão de produção e com a política real ela é recusada (ver §3). Rotas (`proveEvidenceForRoutes`), finalização e conclusão de pendente têm testes com a política real. Nenhum `TRUSTING`/"confia em tudo" em `src`.
- **R3-INFO-9 — Fora do escopo, ainda presente:** `src/lib/link-audit-runtime/used-authorizations.ts:69` (`readFileSync` no runtime do coletor, não no web); `src/lib/pdf/serve.ts` (declarado). Provas anteriores ainda válidas e declaradas: RV2-A3a (recibo plantado confirma pendente legítima pulando reconferências), RV2-A4 (NFC/NFD), RV2-W1 (duas pastas criam ACTIVE sem etiqueta; o indicador não bloqueante recomendado não foi implementado), RV-03b (apagar as duas subpastas some com o histórico).

---

## 3. Situação de cada ponto desta rodada

| Ponto | Situação | Base |
|---|---|---|
| **(1) Evidências falsificadas (R2-MINOR-1)** | **RESOLVIDO para fabricação**; ressalvas R3-MINOR-1/3/4 | RV2-F1 reexecutado: com `previewOver` padrão (double que autentica tudo) ainda "CONFIRMADO", mas **com o padrão de produção** `finalizável = false … ⇒ NOT_FINALIZABLE` e **com coleta legítima atestada** `⇒ NOT_FINALIZABLE` (`rv3/orig-f1-*.out`). Selo refeito ⇒ `EVIDENCE_HASH_MISMATCH`; manifesto forjado/de outra auditoria/seq trocado/fora de ordem/campo extra ⇒ `SEAL_INVALID`; conclusão de pendente exige a prova; fingerprint inclui `trust`; política roda em cada leitura; hash comparado é o recalculado pelo leitor (`hashOk`/`SHA256SUMS` conferido). |
| **(2) Revogação por remoção de recibo (RV2-A3b)** | **RESOLVIDO enquanto a pendente existe**; ressalvas R3-MINOR-2/5 | RV2-A3b reexecutado: `recibo da REVOGAÇÃO removido ⇒ vigentes = [] … prévia {"applied":[],"allowed":false}` (o ataque não funciona mais). Sem caminho via `decisions`, `operatorRecords`, prévia, finalização, corrida (RV3-A3b ⇒ `INPUT_CHANGED`, nada gravado), dois recibos (⇒ `ANCHOR_INTEGRITY`). Testemunha implementada, só enum (sem vazamento). |
| **(3) Documentação** | **PARCIAL** | R3-MINOR-6 |
| **(4) Chaves e rotação (R2-MINOR-4)** | **RESOLVIDO**; INFO R3-INFO-4 | `link-audit-origin-keys` 6/6; RV3-C1: CRLF/maiúsculas/65 hex/espaço/unicode ⇒ `ORIGIN_KEY_WEAK`; `_PREVIOUS` ignorada (`KEY_MISMATCH`); revogada ⇒ `KEY_REVOKED`; revogada+configurada ⇒ `ORIGIN_CONFIG_INVALID`; aposentada só verifica e vence no fim do dia UTC; domínio/`kid` trocados ⇒ `INVALID`; mensagens sem material. |
| **(5) Endurecimento** | **RESOLVIDO**; INFO R3-INFO-7 | Primitivas recusam sem autenticador (RV3-D1: `appendEntry`/`appendRun` ⇒ `INTERNAL "Sem autenticador…"`, nenhum arquivo); RV2-A7 agora `ORIGIN_KEY_NOT_CONFIGURED`; rotas de escrita usam modo `write`; FIFO/diretório/arquivo grande nos manifestos falham fechado em ≤4 ms (RV3-B7); 14 chaves de ordem pequena/não canônicas recusadas. |

---

## 4. O que tentei e NÃO funcionou

Revogação/pendência: aplicar a decisão revogada via `list`/`decisions`/`operatorRecords`/prévia/finalização com a pendente presente; corrida remover-recibo entre avaliar e reler (⇒ `INPUT_CHANGED`); dois recibos finais removidos (⇒ `ANCHOR_INTEGRITY`); recibo do meio; substituição sem recibo (antiga e nova fora); pendente forjada concluída pelo autor nomeado (RV-04 ⇒ `vigentes = []`; RV2-A2 d1–d5); pendente forjada de RESULTADO (RV-01 e RV2-A1 v1–v9 ⇒ `UNPROVEN`/`RESULT_INTEGRITY`, nenhum recibo); outro operador/BIA concluir revogação de ANA; testemunha com falso POSITIVO por quem escreve uma pasta só (exige a entrada ter sido confirmada); `isMine` sem `PROVEN` (validador `originOk` recusa); botão sem origem comprovada (nenhum).
Evidências: captura nova forjada (⇒ `EVIDENCE_NOT_SEALED`); relatório reescrito com selo refeito (⇒ `EVIDENCE_HASH_MISMATCH`); manifesto de chave desconhecida, de outra auditoria, `seq` do nome ≠ assinado, entradas fora de ordem/duplicadas, campo extra, sem assinatura, JSON inválido, mais novo inválido sem recuo (testes do implementador, passaram); assinatura em base64 padrão, S+L (maleabilidade Ed25519), `keyId` desconhecido (⇒ `SEAL_INVALID`); 14 chaves públicas de ordem pequena/não canônicas (y=0,1,−1, y=p, y=p+1, ambos sinais, ordem 8 e variantes) ⇒ 0 aceitas; lista de confiança com espaço/CRLF/maiúsculas/vírgula final ⇒ lista inteira inválida; `seal-0001.json` diretório, pasta da auditoria FIFO, `seal-0002.json` FIFO, manifesto de 300 KiB ⇒ falha fechada sem travar; troca de captura entre números/auditorias (`captureNumber`/`auditId` internos ⇒ `CORRUPT`); legado: trocar `report.json` pelo v1 com `.sha256` refeito ⇒ hash diverge do atestado (análise); `auditId` com traversal (padrão validado antes do `join`); nenhum valor de configuração/variável/código de produção que "confie em tudo"; nenhum caminho de `src` com chave privada.
Chaves: chave vazada aceita após rotação por comprometimento (⇒ `KEY_REVOKED`/`KEY_MISMATCH`); aposentada assinando (assina sempre a atual); etiqueta de domínio cruzado; derivar o segredo do `kid` (id é rótulo livre).

---

## 5. Limitações

- Não rodei `next build`, servidor Next ponta a ponta nem os roteiros de navegador (B13–B15); as rotas foram cobertas pelos testes de API da suíte.
- A corrida multiprocesso com manifestos e o ensaio de rotação com processos de chaves diferentes não foram feitos (só propriedades no módulo).
- Não li o coletor nem o leitor 5B linha a linha; a análise de cobertura concentrou-se em leitor → base → política → mapeador → finalização.
- A verificação de S<L do OpenSSL foi testada só com S+L (recusada).
- **Transparência:** um `grep` meu sobre `deploy/` casou uma linha de `deploy/hostinger/.env.production.example` (`GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS=`, nome de variável com valor vazio). Não abri o arquivo nem vi segredo algum; registro por honestidade.
- Independência limitada (mesma família de modelo).

---

## 6. Comandos e saídas-chave

Tudo em `review-r3/proj` via `scripts/run-isolated.sh` (namespace sem rede, `env -i`, sem `.env*` além do exemplo permitido). Provas em `review-r3/rv3/`; cópias temporárias `proj/tests/zz-rv3-*` removidas (conferido: 0 arquivos `zz-` e nenhum arquivo do instantâneo com data posterior ao início da revisão).

| Comando | Resultado |
|---|---|
| `scripts/run-isolated.sh npx tsc --noEmit --incremental false` | `TSC_EXIT=0` (`rv3/tsc-and-suite.out`) |
| `scripts/run-isolated.sh npm test` | `# tests 1658 · # pass 1657 · # fail 0 · # skipped 1`, `SUITE_EXIT=0`, ~163 s; todos os `tests/*.test.ts*` estão no script `test` |
| `… --test tests/zz-rv3-b-evidence.test.ts` | 7/7 — R3-MINOR-1/3, INFO-5/6, B4, B7 (`rv3/rv3-b.out`) |
| `… --test tests/zz-rv3-a-revocation.test.tsx` | 6/6 — R3-MINOR-2(a), INFO-1/2/3, R3-MINOR-4 (`rv3/rv3-a.out`) |
| `… --test tests/zz-rv3-c-keys.test.ts tests/link-audit-origin-keys.test.ts` | 7/7 (`rv3/rv3-c.out`) |
| `… zz-rv3-d-hardening` · `-e-testquality` · `-f-witness` · `-g-unwitnessed` | 2/2 · 1/1 · 1/1 · 1/1 (`rv3/rv3-{d,e,f,g}.out`) |
| Provas anteriores (`rv3/orig-adapted/`, caminhos ajustados) | **RV-01**: falha ⇒ ataque NÃO funciona (`origin:"UNPROVEN"`, "a UI ofereceria concluir … false"). **RV-02**: não trava (`ENOTFILE`, "respondeu: ok"). **RV-03a/b**: continuam (MINOR-2 de resultados / limite de duas pastas). **RV-04**: falha ⇒ NÃO funciona (`vigentes = []`). **RV2-A1/A2**: todas as variantes recusadas. **RV2-A3a**: continua (declarado). **RV2-A3b**: falha ⇒ revogação NÃO ressuscita mais. **RV2-A4**: continua (INFO). **RV2-A5**: 1 resultado, 1 recibo. **RV2-A6**: falha por formato novo (chave base64 recusada). **RV2-A7**: falha ⇒ serviço sem chave não grava mais. **RV2-F1**: só "passa" com o double que autentica tudo; com produção/política real ⇒ `NOT_FINALIZABLE`. **RV2-F2**: continua (`stale`, depois `EVIDENCE_HASH_CHANGED`). **RV2-W1**: continua (duas pastas, declarado). **RV2-W2**: agora vira `RECEIPT_LOST_WITNESSED` e `vigentes = []`. **RV2-B1**: decisão/outro passou a avisar (`true`); resultado/outro ainda não (`false`). |

Nada foi commitado, enviado, mesclado ou etiquetado; `src/lib/link-audit/scoring/` não foi tocado.
