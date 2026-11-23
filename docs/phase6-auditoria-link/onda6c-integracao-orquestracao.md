# Fase 6 · Onda 6C — Integração e orquestração da Auditoria por Link

**Versão 2.2 — decisões D6C-1…D6C-6 aprovadas em 29/10/2026; M-4a DEFINITIVA em modo estrito (a contagem de avaliações NÃO alimenta o motor). I0, I1, I2 e I3 concluídos e versionados (checkpoints locais); I4 (armazenamento e finalização) autorizado em 30/10/2026, sem commit; I5…I7 e a D5 NÃO estão autorizados.** Este documento é análise, arquitetura e especificação: não cria migration e não toca em produção, na VPS, em Redis, Supabase, Serper ou nas evidências reais da AUD-001. Cada incremento só começa com a aprovação explícita do relatório do anterior (§23).

Base: branch `feat/onda-6c-integracao` (criada em 29/10/2026 a partir de `feat/onda-6b-decisoes`), commit-base `d7b0eec418b56762174b78595c78c9689a094cd5` (1041 testes; `src/lib/link-audit/scoring/` idêntico à tag `v1.0.1`). Metodologia Lumos **reconstruída** (`lumos-reconstruida-v1`), régua `regua-d3b-r2`. **Nada aqui altera pesos, faixas, mínimo de cobertura, fórmulas ou as decisões D3B-1…17.**

## 0. Registro de revisão (v1 → v2)
Revisão feita com as decisões D6C-1…6 do usuário (29/10/2026) e uma releitura **linha a linha do código do motor e da D3B**. O que mudou e por quê:

| Mudança | Motivo (evidência no código) |
|---|---|
| Matriz completa dos 35 subcritérios (§10), no lugar da tabela resumida | D6C-1 exigiu fonte, evidência, condições, ausência, decisão humana e pontos por subcritério |
| **`ABSENCE_PROVEN` conta como avaliado** (0 ponto, peso cheio na cobertura) | `results.ts:49-50`: emitir `null`+`complete:true` sem prova **inflaria a cobertura** — exatamente a "fabricação" proibida |
| **N/A não sai do denominador da publicação** | `aggregate.ts:52` / `publication.ts:12,25`: `coveragePercent = avaliado ÷ 200` e é a absoluta que se compara com 40 %; N/A nunca ajuda a chegar a 40 % (só reduz o potencial) |
| **X5 passa a ser assimétrico** (só prova positiva de UTM pontua) | `eval-conversion.ts:30-32`: com `complete:false` o X5 é N/V antes de olhar a URL; com URL válida e sem UTM o motor dá `ABSENCE_PROVEN_URL` (0/4, **conta cobertura**). A URL vem de um intermediário que pode normalizar ⇒ ausência de UTM **não é prova** |
| Teto de cobertura de hoje cai de "25–39 %" para **23–29 %** | X5 deixa de ser garantido (§5.2) |
| Horários passam a ser emitidos como `TEXT` (observado, não estruturado) | produz o N/V honesto `HOURS_UNSTRUCTURED` em vez de `NO_OBSERVATION` |
| Categorias adicionais emitidas com `complete:false`; **C3 não é oferecido** na decisão humana | `eval-profile.ts:135,143,150` + `na.ts:73-81`: juízo C3 exige lista completa; `NO_ADDITIONAL_NEEDED` contrariado ⇒ `ctx.reject` ⇒ a auditoria inteira dá `ok:false` |
| Formulário inicial reduzido a **C2 e N/A de S4 (BUSINESS_MODEL)**; equivalência de nomes só quando existir fonte NAP | D6C-4 + `na.ts`: `FEATURE_UNAVAILABLE` exige evidência de apoio que a 6C não tem (sem anexos) |
| Novo contrato **pontuado × inconclusivo** (§12) | D6C-2 |
| Nova rota de **simulação** de decisão (§14.5) | D6C-4: impedir decisão impossível usando o **próprio motor** como juiz, sem duplicar regras |
| `contentSha256` do website derivado: **o valor bruto nunca é persistido** (§9.6) | D6C-3 (nada de parâmetros sensíveis em UI, logs, erros — nem em disco) |
| Nova seção **D5 — Coleta ampliada** (§21), potencial por família, cenários | D6C-6 |
| Plano I0–I7 com contratos e critérios de aceite (§23) | pedido de revisão do plano |
| Seções 21 (D5), 22 (bloqueadores), 24 (critérios para autorizar o I0) | entrega solicitada |

### 0.1 Revisão v2.1 (29/10/2026) — aprovação condicionada
| Mudança | Motivo |
|---|---|
| **M-4a corrigida:** o limite de 1000 avaliações **deixa de existir**; `complete:true` nunca é inferido de um número | D6C-1: exigir evidência íntegra, valor numérico inequívoco e **semântica de completude comprovada** conforme o contrato do motor; senão, não verificado. Uma fixture não comprova o comportamento real do provedor |
| **Nova regra M-3b:** `complete` é `false` por padrão; `true` só com prova positiva inerente ao valor (X5 com UTM completo) ou atestação de semântica do provedor | generalização da correção acima; o motor pontua valores presentes independentemente de `complete` (nome, telefone, categoria, website, nota com ≥ 5 avaliações) |
| **Cobertura revisada:** R2 só pontua com ≥ 100 avaliações (leitura como piso). Automático certo = **34 hp (17 %)**; 46 hp (23 %) com ≥ 100 avaliações; teto de hoje continua **58 hp (29 %)** | consequência de `complete:false` no R2 (`INDECISIVE_RANGE` abaixo de 100) — §5.2, §21 recalculados para as duas populações |
| **D6C-3 reforçada:** o registro preserva a **referência íntegra à evidência de origem** do website (`sourceEvidence`), além do hash do bruto; nenhum valor sensível é persistido | decisão do usuário (29/10/2026) |
| **Testes de contagem** acrescentados ao plano (0, 999, 1000, 1001, abreviados, ausentes) | decisão do usuário; sem tratamento especial do número 1000 |
| **I0 autorizado (Plano A)** com critérios de aceite detalhados; **I1+ e D5 não autorizados** | §23, §24 |

### 0.2 Revisão v2.2 (29/10/2026) — M-4a estrita, I0 concluído, I1 autorizado
| Mudança | Motivo |
|---|---|
| **M-4a DEFINITIVA (modo estrito):** a contagem e a nota de avaliações **não entram no `ScoringInput`**; `reviews` é **omitido por inteiro** (R1 e R2 sempre N/V; L1/L2 também) enquanto não houver fonte e política de verificação comprovadas | decisão do usuário (29/10/2026). Sem limiar de 1000, sem piso artificial, sem `complete:true` sem prova, sem `ABSENCE_PROVEN` por ausência de informação. Os valores podem ser **preservados como informativos**, com a origem identificada, mas **nunca** como fato verificado do cálculo. A D5 pode reavaliar |
| **Cobertura recalculada:** automático certo **22 hp (11 %)**; com X5 (UTM completo comprovado) e C2 (decisão humana) o **teto de hoje é 34 hp (17 %)** | R1 e R2 leem o **mesmo** fato `reviews` (`eval-reputation.ts`); omiti-lo remove os dois (−24 hp do teto anterior de 58 hp). **Correção:** o relatório do I0 informou "teto 46 hp (23 %)" para o modo estrito — estava **errado** (só descontava o R1); o correto é 34 hp (17 %) |
| **Novo efeito nos portões:** o critério Avaliações deixa de contar; com a coleta atual **só NAP (12 hp) e Categorias (6–14 hp)** têm ≥ 6 hp avaliados. O 3º critério exige **X5 comprovado** (Conversão = X1 4 + X5 4 = 8 hp) | `aggregate.ts:57` (critério com ≥ 3 pts = 6 hp) e `publication.ts:13-14`. O portão `CRITERIA_MIN` passa a falhar também em perfis sem UTM completo |
| **§21 (D5) recalculado** para uma única população (sem R1/R2); a reabilitação de R1/R2 (+24 hp) vira item explícito da D5 | M-4a estrita |
| **I1 definido** (§23): leitor de pontuação que expõe `informational.reviews` (preservado, rotulado) **separado** do perfil elegível ao motor | pedido do usuário (preservar dado informativo com origem) |

## 1. Resumo executivo
Hoje a tela só lista evidências (5B), as decisões (6B) são API sem tela e o motor (6A) não tem consumidor. A 6C os liga num fluxo **íntegro e rastreável**:

> evidências armazenadas e verificadas **+** decisões humanas confirmadas → **mapeador** (só fatos observados) → entrada do motor → `scoreAudit` → **prévia** (nunca definitiva) → o operador **finaliza** → o servidor grava um **registro imutável** (entrada exata, resultado, hashes das evidências, versão da régua, `head` das decisões), classificado como **PONTUADO** ou **INCONCLUSIVO**.

Pontos de maior consequência:
1. **O motor já permite o registro inconclusivo**: `scoreAudit` devolve `ok:true` com `publication = INSUFFICIENT|NO_DATA`, `index:null`, `confidence:null` (`engine.ts:65-66`). **Não é preciso alterar a régua nem criar envelope no motor**; a 6C deriva um `outcome` do resultado e **proíbe** apresentar nota, índice, classificação ou "selo pontuado" em registros inconclusivos (§12).
2. **Com os dados que a coleta atual fornece, o teto de cobertura comprovável é 17 %** (11 % automático certo; 17 % com UTM completo comprovado e a decisão humana C2) (§5.2), abaixo dos 40 %, porque a contagem de avaliações **não alimenta o motor** (M-4a estrita). A 6C entrega fluxo, integridade e rastreabilidade; **o índice só aparece quando existirem evidências suficientes**. Nada é fabricado para chegar a 40 %.
3. **Caminho até 40 % (D5, §21):** nenhum conjunto de melhorias **sem custo** (parsers + site) passa de **27 %**. Chega-se a ≥ 40 % combinando avaliações recentes e respostas completas (Serper `/reviews`, incluindo o juízo P3), ou o painel do perfil anexado pelo operador (S1–S4, V1–V4 e mais), ou site com confirmações do operador — sempre **somadas** às melhorias sem custo (§21.3). Reabilitar R1/R2 (+24 hp) exige fonte e política de verificação comprovadas. A D5 **não está autorizada**; este documento só a dimensiona.
4. **Regras de integridade preservadas:** só decisões confirmadas; `finalizable:false`, pendente (inclusive revogação), falha de integridade ou `ok:false` do motor **impedem a finalização**; ausência vira **N/V**, nunca zero; o cliente não fornece pontos, cobertura nem `referenceDate`; **nenhum protocolo da 6B muda** (§23, I0 com plano B que não toca a 6B).

---

## 2. Decisões D6C-1…D6C-6 consolidadas
| # | Decisão do usuário | Como a especificação a cumpre | Situação (29/10/2026) |
|---|---|---|---|
| **D6C-1** Política de fatos | Aprovada em princípio, **condicionada à revisão de M-1…M-12** e à comparação com os 35 subcritérios e a D3B | §9 (M-1…M-12 revisadas) e §10 (matriz de 35 linhas, conferida com `ruler.ts`, avaliadores e D3B). Regra central: **não inventar evidência, não inferir ausência global de observação parcial, nunca zero por dado desconhecido** | **Aprovada.** **M-4a definitiva em modo estrito** (§9): a contagem de avaliações é omitida do cálculo; sem limiar, sem piso, sem `complete:true` sem prova. M-5, M-6 e M-7 aprovadas junto |
| **D6C-2** Resultado sem índice | Persistir **registro técnico imutável** com cobertura insuficiente, rotulado `COBERTURA_INSUFICIENTE` (ou equivalente); **sem nota, índice definitivo ou selo**; nunca com pendente, `finalizable:false` ou falha de integridade | §12: `outcome = INCONCLUSIVO` com `reasonCode`; o contrato do motor **permite** (sem alterar a régua), então **não há envelope paralelo no motor**; projeção de leitura que **remove** pontos agregados | **Aprovada.** Requisito herdado pela Onda 7: tratar `INCONCLUSIVO` como "registro técnico", sem nota |
| **D6C-3** Website bruto | Usar a URL original verificada **só no servidor** para o X5; provar origem e integridade; URL saneada ≠ prova de ausência de UTM; nada sensível em UI/logs/erros; sem evidência verificável ⇒ N/V; sem mudar a D3B | §9.6: origem = captura armazenada e íntegra, lugar casado por CID/placeId; **o valor bruto não é gravado** (grava-se uma **URL derivada mínima**, o hash do bruto e a **referência íntegra à evidência de origem**); X5 **assimétrico** (prova positiva pontua; ausência ⇒ N/V) | **Aprovada** (X5 assimétrico; só prova positiva e verificável de UTM completo) |
| **D6C-4** Decisões humanas | Formulário inicial limitado a **C2, N/A e equivalência de nomes**, só quando motor e evidências permitirem; impedir decisões impossíveis/contraditórias/sem suporte; preservar `expectedHead`, histórico, revogação | §11: oferecido hoje **C2** e **N/A S4 (BUSINESS_MODEL)**; equivalência de nomes só com fonte NAP comparável (hoje indisponível); simulação pelo motor; nenhuma mudança nas rotas da 6B | **Aprovada** (interface inicial limitada ao que as evidências e o motor permitem) |
| **D6C-5** Armazenamento | `GMN_LINK_AUDIT_RESULTS_DIR` e `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR`; resultados e recibos separados; integridade, histórico, idempotência, recuperação; **sem alterar volumes da VPS** | §15; `stack.yml`/`Dockerfile` **não** são alterados (só `PLANO-DE-VOLUME-DE-RESULTADOS.md`) | **Aprovada** |
| **D6C-6** Cobertura insuficiente | Não reduzir o mínimo, não alterar pesos, não fabricar dados; identificar os dados adicionais; plano mínimo da D5; ganho por família com pesos reais; **potencial ≠ comprovado**; cenários que chegam a 40 % e os que não; **D5 não autorizada** | §5.2 e §21 (todos os números vêm de `ruler.ts`) | **Aprovada.** A D5 é planejada à parte e **não está autorizada** para implementação |

### 2.1 Autorizações registradas em 29/10/2026
*(1ª rodada — I0; mantida como histórico. A 2ª rodada está no fim desta seção.)*
- **Branch** `feat/onda-6c-integracao` criada a partir do commit `d7b0eec` (sem reset, clean ou checkout forçado; este documento, ainda não commitado, foi preservado).
- **Implementação autorizada exclusivamente para o I0, pelo Plano A** (extrair para módulo neutro, com reexports compatíveis com a 6B). **Nenhum commit** sem nova autorização; **I1 e seguintes não autorizados**; ao concluir o I0 o trabalho **para** e aguarda a revisão do relatório técnico.
- **Segurança:** só localhost isolado; sem Redis, Supabase ou Serper de produção; sem migration, worker de produção, deploy ou VPS; evidências reais da AUD-001 intocadas; `scoring/` e a régua D3B preservados.

**3ª rodada (29/10/2026, após o relatório do I1):** I1 **aprovado de forma condicionada** à verificação de compatibilidade com as evidências legadas; a verificação foi feita **somente em leitura** e resultou **COMPATÍVEL** (ver o resultado em §23, I1); **commit local do I1 autorizado** (`feat(link-audit): add verified scoring evidence basis`) e **início do I2 autorizado** somente após essa verificação, **sem commit do I2**; I3…I7 e a D5 seguem não autorizados; sem push, merge, rebase, tag ou deploy. **Decisão sobre a URL:** mantém-se **somente a URL derivada mínima** (sem caminho original e sem informação confidencial). Ela **não pode ser tomada como prova de UTM completo** (os valores foram substituídos por `x`); a **prova positiva** deriva de parâmetros **efetivamente observados no bruto**, com **valores não vazios** e **proveniência verificável** (`rawSha256` + `sourceEvidence`), conforme a D3B/§9.6.

**2ª rodada (29/10/2026, após o relatório do I0):** I0 aprovado; **commit local de checkpoint do I0 autorizado** (`refactor(link-audit): extract shared receipt storage`) e commit de documentação **separado** para esta especificação; **M-4a definida em modo estrito**; **I1 autorizado** (leitor de evidências para o motor — sem mapeador, pontuação, finalização ou interface). **I1 não é commitado** sem nova autorização; **I2…I7 e a D5 não estão autorizados**; sem push, merge, rebase, tag ou deploy.

---

## 3. Objetivo e limites
**Dentro:** carregar e verificar evidências; classificar cada subcritério (automático / decisão humana / bloqueado / sem dado); registrar, substituir e revogar decisões **pelas rotas da 6B**; montar a entrada do motor; calcular uma **prévia**; exibir cobertura, bloqueios e o que falta; finalizar e guardar o registro de forma rastreável; marcar registros desatualizados.

**Fora (não implementar):** coleta ampliada (D5), PDF (Onda 7), novos critérios/pesos/faixas, qualquer alteração em `src/lib/link-audit/scoring/`, banco/migration, rede, alteração de autenticação (`guard.ts`), redesign de outras áreas, mudança de volumes da VPS.

**Desenvolvimento:** só localhost; `scripts/run-isolated.sh`; fixtures fictícias; sessão assinada por segredo fictício gerada fora da árvore; sem Redis/Supabase/Serper reais, sem worker, sem tocar nas evidências reais da AUD-001 (**testes do layout legado usam uma réplica fictícia da estrutura**).

---

## 4. Estado atual: implementado × a criar
| Peça | Estado |
|---|---|
| Parser de link, confirmação de identidade (CID) — Onda 3 | **Pronto** |
| Evidências: armazenamento, leitor, integridade, lista/detalhe — 5A/5B | **Pronto** |
| Motor Lumos (`scoreAudit`, `verifyScoreResult`) — 6A | **Pronto, sem consumidor** |
| Decisões: histórico, revogação, âncoras, pendente, `finalizable`, `head` — 6B | **Pronto, sem tela** |
| Autenticação por sessão, allowlist, origem cruzada; design system | **Pronto** |
| Mapeador evidências + decisões → `ScoringInput` | **Não existe** (o único é um teste que **inventa** dados: endereço `x/1`, horários `08:00–17:00`) |
| Base de pontuação no leitor (hashes, valores brutos mínimos) | **Não existe** (o leitor público não expõe hashes) |
| Serviço de pontuação, simulação, rotas, armazenamento de resultados, identidade do operador | **Não existe** |
| Tela de trabalho da auditoria | **Não existe** (`AuditWorkspace` é um espaço reservado) |
| `site:cNNNN` verificável; hash de páginas do site; parsers de endereço/horário | **Não existem** (D5) |

---

## 5. Achados da análise do código

### 5.1 Reutilizável
`scoreAudit`, `verifyScoreResult`, `parseScoringInput`, `SUBCRITERIA`, `NA_RULES`, `RULER_FINGERPRINT`; `createDecisionService().list()` (`head`, `pending`, `finalizable`, `operatorRecords` no formato da 6A); `createEvidenceReader`; `matchPlace` (`collector/maps-place.ts`, casamento por CID/placeId); `canonicalJson`, `sha256Hex`; `publishExclusive`, `withLock`, `FsOps`; primitivas `seal`/`readSealedFile`/`atomicOnly`/`assertBase`; padrões `withDecisions`, `failureResponse`, `successStatus`, `readJsonBody`; `Panel`, `StatusBadge`, `MetricCard`, `DashboardShell`; reducer + `*-api-client.ts` + testes `renderToStaticMarkup`; a bateria da 6B (`world()`, `crashAfter`, fuzz, harness de mutação).

### 5.2 O que o motor faz com a cobertura (regras que a 6C herda)
Todas verificadas no código (`aggregate.ts`, `publication.ts`, `results.ts`):
- `coveragePercent = evaluatedHalfPoints ÷ 2` (denominador **fixo** = 200 hp = 100 pontos). **N/A não sai do denominador** e não ajuda a chegar a 40 %.
- Cada subcritério `SCORED` **ou `ABSENCE_PROVEN`** conta seu peso **cheio** como avaliado (o `ABSENCE_PROVEN` obtém 0). `NOT_VERIFIED`, `NOT_APPLICABLE` e `SAMPLE_INSUFFICIENT` avaliam 0.
- **Publicação:** `NO_DATA` (0 avaliado) · `INSUFFICIENT` (cobertura < 40 %, **ou** < 3 critérios com ≥ 3 pts avaliados, **ou** nem NAP nem Avaliações com ≥ 3 pts, **ou** integridade) · `PROVISIONAL` (40–64 %) · `PUBLISHED` (≥ 65 %). Não há caminho para ter `index` com cobertura < 40 %.
- **Consequência de projeto:** emitir `value:null`+`complete:true` onde só há desconhecimento transformaria "não sei" em `ABSENCE_PROVEN` (0 ponto, **cobertura aumenta**) e, no website, derivaria `NO_WEBSITE_PROVEN` (N/A de X2/X4/X5). Por isso a política M-3 (§9) **proíbe** isso sem prova.

**Cobertura comprovável com a coleta atual** (pesos em meios-pontos; 1 ponto = 2 hp; a régua soma 200). **M-4a estrita: a contagem/nota de avaliações não entra no motor ⇒ R1 e R2 são N/V** (os dois leem o mesmo fato `reviews`):

| Fonte | Subcritérios | hp | Acumulado |
|---|---|---|---|
| Perfil automático "certo" (Serper `/maps` armazenado, `complete:false`) | N1 6 · N3 6 · C1 6 · X1 4 | 22 | **11,0 %** |
| + X5 somente com **UTM completo comprovado** (§9.6) | X5 4 | 26 | 13,0 % |
| + decisão humana de juízo | C2 8 | 34 | **17,0 %** |

**Teto de hoje: 34 hp = 17 %.** Excluídos pela M-4a estrita: R1 12 + R2 12 = 24 hp (o teto anterior era 58 hp = 29 %). Portões de publicação com a coleta atual: (a) **cobertura** (< 40 %) falha sempre; (b) **`CRITERIA_MIN`** (3 critérios com ≥ 6 hp avaliados): NAP (N1+N3 = 12) e Categorias (C1 6; 14 com C2) atendem; o **3º** só existe com **X5 comprovado** (Conversão = 8 hp), pois Avaliações deixou de contar; (c) `NAP_OR_REVIEWS` é atendido pelo NAP. Isso coincide com a AUD-001 (28–30 pts, `INSUFFICIENT`).

### 5.3 Divergências código × D3B que a 6C herda **sem corrigir** (registrar para manutenção futura da régua)
A 6C não altera a régua; as divergências abaixo foram achadas na releitura e devem ser levadas a uma decisão própria (D3B-x) em outra oportunidade.
1. **X5, valor vazio:** D3B diz "presentes"; o código exige valor **não vazio** (mais estrito). **X5, fragmento (`#`)** e **URL sem esquema** (`www.x.com`): o motor só lê a query ⇒ UTM só no fragmento vira `ABSENCE_PROVEN` (falso zero); sem `http(s)://` o X5 fica N/V enquanto X1 pontua. A política M-5 evita ambos ao **nunca afirmar ausência**.
2. **N/A (D3B §3.4):** `causeEvidenceIds` "obrigatório" na D3B, mas o código só exige para `FEATURE_UNAVAILABLE`; a mensagem fala em "evidência armazenada", mas `ground` com qualquer origem aceita `OPERATOR_STATEMENT`.
3. **`ctx.reject` em C3/P3/N/A** derruba a auditoria inteira (`ok:false`); a D3B só prevê recusa para N/A contrariado. A 6C trata isso com **simulação** e **bloqueios** (§11, §14.5).
4. **`contentSha256`:** o motor só valida o **formato**; nunca confere contra conteúdo (a D3B fala em "hash conferido"). A conferência é responsabilidade do **leitor** (`verifyAudit`) — por isso a base de pontuação só entrega hashes de evidências íntegras.
5. **N5:** o código não verifica status 2xx nem identidade da fonte e ignora o campo `kind`; **P3** aceita < 5 respostas se for o total; **`complete` é ignorado** em P1/P2/P3.
6. **L3:** achado `corroborated:true` sem fundamento é descartado em silêncio e pode gerar `ABSENCE_PROVEN_PROTOCOL`.
7. **Datas relativas:** a conversão `MONTH=30`, `YEAR=365` está só no código ("PROPOSTA D3B-12").
8. **Estado `REJECTED`** previsto na D3B não existe: o motor devolve `ok:false`.

---

## 6. Arquitetura da integração
```
 navegador                              servidor (route handlers)                          armazenamento (arquivos)
 /auditoria-por-link ──────────────┐
 /auditoria-por-link/[auditId]     │   GET  /api/link-audit/evidence*          ─► link-audit-evidence (5A/5B)    EVIDENCE_DIR (:ro)
  reducers + *-api-client.ts       ├─► GET/POST /api/link-audit/decisions*     ─► link-audit-decisions  (6B)     DECISIONS_DIR + ANCHOR_DIR
  (só tipos locais)                │   GET  /api/link-audit/scoring/{id}       ─┐
                                   │   POST /api/link-audit/scoring/{id}/simulate ┤
                                   │   POST /api/link-audit/scoring/{id}/finalize ┼► link-audit-scoring-runs (NOVO)  RESULTS_DIR + RESULTS_ANCHOR_DIR (NOVOS)
                                   │   GET  …/results , …/results/{n}         ─┘     ├ assemble (puro: mapeador)
                                   └─► GET  /api/link-audit/operator                  ├ service  (preview/simulate/finalize/list)
                                                                                      ├ store    (sNNNN + recibos)
                                                                                      └ usa: scoring/index (motor), decisions.list(), readScoringBasis (leitor)
```
Princípios: **(a)** o navegador nunca importa motor, decisões nem armazenamento; **(b)** as rotas de decisões **continuam sem** importar o motor; **(c)** a UI recebe DTOs prontos (inclusive rótulos de critérios); **(d)** toda gravação usa `publishExclusive` + `atomicOnly`; **(e)** o motor é o **único juiz** — a 6C só explica o que ele decide.

| Peça nova | Justificativa |
|---|---|
| `readScoringBasis` (leitor, só servidor) | O motor exige `contentSha256`; o leitor público não o expõe e a política proíbe o armazenamento interno |
| `src/lib/link-audit-scoring-runs/` | Orquestração fora de `link-audit-decisions/` (quebraria 4 testes de isolamento) |
| `src/lib/link-audit-storage/` (I0, opção A) | Reuso das primitivas de selo/recibo **sem copiar** — ou plano B sem tocar a 6B (§23) |
| Rotas de pontuação/simulação/identidade | A UI precisa de prévia, simulação, finalização, histórico e do e-mail do operador |

---

## 7. Fluxo completo do usuário
```
 1 Entrada do link ► 2 Identificação (CID/nome) ► 3 Auditorias armazenadas (lista, 5B)
                                    │ "Abrir auditoria"
                                    ▼
 ┌────────────── /auditoria-por-link/[auditId] ──────────────────────────────────────────────┐
 │ GET evidence/{id} · GET decisions/{id} · GET scoring/{id}   (3 leituras; erros isolados)  │
 │ 4 Faixa de estado ► 5 Empresa e coleta ► 6 Evidências e integridade                        │
 │ 7 Matriz de critérios (Automático | Decisão humana | Bloqueado | Sem dado)                 │
 │ 8 Decisões: pendentes ► formulário ► [Simular] ► registrar (POST decisions + expectedHead) │
 │ 9 Resultado (prévia): PONTUADO ou INCONCLUSIVO — e "o que falta para o mínimo de 40 %"     │
 │10 Bloqueios ► 11 Rastreabilidade ► [Finalizar] (só sem bloqueios)                          │
 └───────────────────────────────┬────────────────────────────────────────────────────────────┘
                                 ▼ POST scoring/{id}/finalize {expectedHead, expectedInputSha256}
        lock ► relê evidências+decisões ► recalcula ► compara ► grava sNNNN ► recibo ► 201/200
                                 ▼
        Registro DEFINITIVO: PONTUADO  ou  INCONCLUSIVO (registro técnico, sem nota)  ─► Onda 7 (PDF)
              └ se evidências/decisões mudarem depois: DESATUALIZADO (nova versão; a anterior permanece)
```

---

## 8. Estados
**Auditoria (um por vez; ícone + texto):** `SEM_EVIDENCIA` · `FALHA_INTEGRIDADE_EVIDENCIAS` · `FALHA_INTEGRIDADE_DECISOES` · `DECISAO_PENDENTE` · `PRONTO_PARA_CALCULAR` · `CALCULADO_NAO_FINALIZAVEL` · `CALCULADO_FINALIZAVEL` · `DEFINITIVO` (com `outcome` PONTUADO ou INCONCLUSIVO) · `DESATUALIZADO`.
**Subcritério (do motor):** Avaliado · Ausência comprovada (0, conta cobertura) · Não verificado (N/V) · Não aplicável (N/A, com registro) · Amostra insuficiente. **Fonte (campo próprio):** `AUTOMATICO` · `DECISAO_HUMANA` · `BLOQUEADO` (com motivo) · `SEM_DADO`.
**Distinções obrigatórias na interface (textos fixos e distintos):** resultado **definitivo** × **prévia** × **não finalizável**; evidência **não verificada** × **não aplicável**; decisão **pendente** × **confirmada**; **falha de integridade** (some o dado, aparece o aviso); registro **pontuado** × **inconclusivo**.

---

## 9. Política de fatos revisada (M-1 … M-12)
Princípios (D6C-1): **emitir somente o observado**; **ausência de dado ⇒ omitir o fato** (N/V); **nunca** `null`+`complete:true` sem prova (daria `ABSENCE_PROVEN`: 0 ponto **e cobertura**); **nunca** inferir ausência global de leitura parcial (ex.: lista de categorias do `/maps` não é a lista completa); **nunca** zero para desconhecido.

- **M-1 Evidências.** Para cada captura armazenada **íntegra** (`verifyAudit` COMPLETE/LEGACY sem divergência): `capture:cNNNN` `{origin:'GOOGLE_NATIVE', capture:'STORED_CAPTURE', status:'VERIFIED', observedAt:<collectedAt>, contentSha256:<hash da captura>}`; idem `report:cNNNN-rNNNN` (hash do relatório; `observedAt` = coleta da captura, **não** a data de geração). Hashes vêm só da base de pontuação. O Serper entra como `STORED_CAPTURE` **GOOGLE_NATIVE** (conta como evidência **primária**; rotulado "intermediário" na interface). `site:cNNNN` **continua recusado**. Evidência > 180 dias da `referenceDate` não fundamenta (o motor devolve N/V `EVIDENCE_TOO_OLD`): a prévia mostra "evidência antiga".
- **M-2 `referenceDate`.** Dia (como escrito) da evidência verificada **mais recente de TODA a base** (Emenda I2: o contrato do motor recusa evidência posterior à referência; uma captura posterior sem resposta utilizável pode envelhecer o perfil, avisado por `PROFILE_EVIDENCE_AGED/TOO_OLD`), derivado do armazenamento; nunca do cliente nem do relógio. Verificado: o motor compara a data de referência com **evidências e fatos datados**, **não** com `recordedAt` das decisões (`input.ts:365-393`) ⇒ sem conflito com decisões posteriores à coleta. O mapeador valida por conta própria que nenhuma decisão tenha data futura (a frase "recordedAt nunca futura" do doc da 6A **não é imposta pelo motor**; o doc será corrigido). O registro grava `referenceDateSource`.
- **M-3 Só o observado.** Fato presente e a evidência correspondente `VERIFIED` ⇒ observação `{evidenceIds:[capture], complete, value}`. Ausente/desconhecido ⇒ **omitido**. Proibido: `null`+`complete:true`; `reviewCount:0` com `complete:true`; `website:null` com `complete:true`; listas vazias com `complete:true`. Teste de propriedade: nenhuma combinação de fixtures produz `ABSENCE_PROVEN` sem prova explícita (§18). **M-3b — `complete`:** o valor padrão é **`false`**; `complete:true` só é emitido com (i) **prova positiva inerente ao valor** (X5 com UTM completo, §9.6) ou (ii) **atestação de semântica do provedor** homologada para aquele campo (hoje: nenhuma), sempre registrada em `completenessBasis`. Para valores presentes e não vazios o motor pontua independentemente de `complete`; `complete:false` só reduz o que depende de leitura exaustiva (contagens por faixa, listas, horários estruturados).
- **M-4 Avaliações (DEFINITIVA em modo estrito, 29/10/2026).** O mapeador **não emite `reviews`** no `ScoringInput`: nem `ratingShown`, nem `reviewCount`, em nenhuma circunstância, **enquanto não existir fonte e política de verificação de sua semântica e completude comprovadas** (decisão do usuário). Consequências medidas no motor: **R1 e R2 N/V** (`NO_OBSERVATION`), e também L1/L2/R3/P1/P2/P3 dependentes de `reviews` ou de fontes ausentes; **nunca** `reviewCount:0`, **nunca** `NO_REVIEWS_PROVEN` (removeria R1/R3/L1/P1/P2/P3 por N/A), **nunca** `ABSENCE_PROVEN`.
  - **Proibido:** limite de 1000 (ou qualquer número) como garantia; piso artificial de pontuação; `complete:true` sem evidência; transformar ausência de informação em `ABSENCE_PROVEN`.
  - **Dado informativo preservado, fora do cálculo.** O leitor (I1) continua a ler `rating` e `ratingCount` da captura íntegra e os expõe **somente** em `informational.reviews` — com `scoringUse:'EXCLUDED_M4A'`, a origem (`capture:cNNNN`), o hash da captura, `observedAt` e o motivo ("semântica de completude não comprovada"). A interface pode mostrá-los como "Informativo — não pontua". **Nenhum** código de `assemble` (I2) pode ler `informational`: um teste estático e um teste de propriedade garantem que o `ScoringInput` nunca contém `reviews`.
  - **Reabilitação (D5):** R1 (+12 hp) e R2 (+12 hp) só voltam com (i) fonte comprovada (ex.: contagem exata lida pelo operador no painel, com anexo e hash, ou atestação de semântica do provedor sustentada por amostra real autorizada), (ii) política de verificação versionada e (iii) autorização própria. Nesse caso reutilizam-se as regras anteriores: `complete:false` por padrão; R1 pontua com ≥ 5 avaliações; R2 só pontua a faixa máxima (≥ 100 ⇒ 12 hp) com leitura como piso.
  - **Testes futuros (I2):** `ratingCount` = 0, 999, 1000, 1001, abreviados ("1,2 mil", "1.2K", "1k+"), texto, fracionário, negativo, `NaN`/`Infinity`, `null`/ausente ⇒ em **todos** os casos o `ScoringInput` **não** contém `reviews` (e o I1 classifica o valor informativo de forma inequívoca, sem tratamento especial do 1000). **Fixtures testam a lógica, não o provedor.**
- **M-5 Website e X5** — ver §9.6 (D6C-3).
- **M-6 Endereço e horários.** `address{raw}` **sem `parsed`** ⇒ N2 N/V `ADDRESS_UNPARSED`. `hours{kind:'TEXT', raw}` ⇒ N4 N/V `HOURS_UNSTRUCTURED`. Nenhum campo é inventado (como faz o teste atual).
- **M-7 Categorias.** `primaryCategory` (C1/C2). `additionalCategories` emitido com **`complete:false`** (lista observada, completude não comprovada) ⇒ C3 N/V; **não** emitir `complete:true`.
- **M-8 Capturas múltiplas.** Fatos vêm da captura mais recente íntegra; as antigas entram só como evidência **citável** por decisões. Valores divergentes no mesmo dia viram `CONFLICT_OPEN` do motor, **exibido** como conflito.
- **M-9 Decisões.** `operatorRecords` = exatamente `decisions.list().operatorRecords` (somente confirmadas), sem alteração. Decisões impossíveis são impedidas na UI e explicadas por **bloqueios** traduzidos do `ok:false` do motor; nenhum registro da 6B é alterado.
- **M-10 `auditId` com `_`.** O motor aceita `^[a-z0-9][a-z0-9-]{5,63}$`; evidências/decisões aceitam `_`. A 6C **não altera a régua** e **não troca a identidade em silêncio**: usa um **alias determinístico e verificável** apenas dentro da entrada do motor (Emenda I2: trecho legível com `_`→`-` + `-ux` + 32 hex do SHA-256 de `lumos-audit-id-alias-v1\n<id>`, ≤ 64 caracteres; um id comum que já termine em `-ux<32 hex>` também é aliasado, o que torna disjuntos ids inalterados e aliases; substitui os 8 hex da v2.2). **Limites reais (homologação D2, 29/10/2026):** a ausência de colisão entre ids distintos repousa em SHA-256 truncado a 128 bits (suposição criptográfica, não prova matemática); a enumeração de 2,78 milhões de ids feita na revisão é evidência empírica, não demonstração. `sourceAuditId` e `scoringAuditId` ficam SEMPRE separados e o par é gravado; **o alias nunca localiza dados** (evidências, decisões e resultados são sempre lidos pelo `sourceAuditId` da rota); o serviço falha fechado se o alias não for reproduzível a partir do id de origem (`verifyAuditIdAlias`), se o `auditId` da base ou das decisões diferir do pedido, ou se o resultado do motor trouxer outro id. O registro grava `auditIdAlias:{applied, rule, sourceAuditId}` e a UI mostra "identificador adaptado para o motor". Ids sem `_` passam **inalterados**. O armazenamento usa sempre o `auditId` real.
- **M-11 Layout legado (AUD-001).** Suportado pelo mesmo método (captura 1, revisão 2; hash do legado = corpo bruto do provedor, `legacy:true`). **Testes só com réplica fictícia da estrutura legada**; a pasta real não é lida nem alterada.
- **M-12 Versionamento.** `mapperVersion = lumos-map-v1` entra no registro; qualquer mudança de política exige nova versão + fixtures de ouro. O mapeador **nunca** lê qualquer valor vindo do cliente.

### 9.6 D6C-3 — Website bruto e X5 (detalhe)
**Comprovação de origem e integridade da URL.** A URL só é aceita se: (1) a captura passou por `verifyAudit` (hash da captura e `bodySha256` conferidos); (2) o lugar foi casado por **CID ou placeId** (`matchPlace`; nome nunca confirma; `identityProven:true`); (3) o campo `website` do lugar casado é uma string; (4) a evidência `maps-website` do relatório é `VERIFIED`. Qualquer falha ⇒ o fato `website` **não é emitido** (X1…X5 N/V). A URL é lida **do corpo armazenado**, pelo mesmo leitor defensivo do coletor — **não** por regex.

**O valor bruto nunca é persistido, exibido, logado nem enviado em erro.** O mapeador deriva uma **URL mínima** (`lumos-url-derive-v1`): `scheme://host/path` + **somente** parâmetros `utm_*` conhecidos (`utm_source|medium|campaign|content|id|term`) com **valor substituído por `x`** quando não vazio; descarta credenciais, fragmento e **todos** os demais parâmetros. É isso que entra no `ScoringInput` e no registro. Grava-se também `websiteDerivation:{rule, rawSha256, sourceEvidence:{ref, contentSha256, bodySha256}}` — o SHA-256 do bruto **e a referência íntegra à evidência de origem** (a captura `capture:cNNNN` com os seus hashes) — para verificar depois contra a captura, sem guardar a URL. A UI mostra apenas **host** e o rótulo "UTM completo detectado / não verificável". Mensagens de erro e logs nunca contêm a URL (o módulo não usa `console`; `scrubPaths` + testes).

**Política assimétrica do X5 (aprovada em 29/10/2026).** O motor só avalia UTM com `complete:true` e dá `ABSENCE_PROVEN_URL` (0/4, **conta cobertura**) quando não há UTM. Como o Serper é um intermediário que pode normalizar a URL, **ausência de UTM não é prova**. Logo:
| Situação na URL bruta verificada | `complete` | Resultado do X5 |
|---|---|---|
| `utm_source` **e** `utm_medium` com valor | `true` | **Pontua 4 hp** (prova positiva) |
| algum `utm_*` mas não ambos | `false` | N/V (pode haver truncamento do provedor) |
| nenhum `utm_*` | `false` | **N/V** — nunca "ausência comprovada" |
| URL sem esquema / não http(s) / ilegível | `false` | N/V (`WEBSITE_URL_UNPARSABLE`/incompleta) |
| origem/integridade não comprovadas | (fato omitido) | N/V |
X1 continua pontuando com URL não vazia (o motor ignora `complete` quando há valor). A atestação de **fidelidade da URL** (que permitiria afirmar ausência) fica para a D5 (§21).

---

## 10. Matriz completa dos 35 subcritérios (D6C-1)
Pesos em meios-pontos (hp; ponto = 2 hp), conferidos com `ruler.ts`, os avaliadores (`eval-profile/reputation/site/visuals-posts/conversion/authority.ts`) e a D3B. **E-cap** = evidência `capture:cNNNN` (Serper `/maps` armazenado, `GOOGLE_NATIVE`, `STORED_CAPTURE`, `VERIFIED`, ≤ 180 dias da `referenceDate`, hash válido, identidade do lugar provada por CID/placeId). **Ausência** descreve o que o mapeador faz quando a informação não existe. "Avaliável" = hp que o subcritério pode **avaliar** (hoje / com dado futuro). Divergências código × D3B: §5.3.

### 10.1 NAP (15 pts · 30 hp)
| Sub. | Fonte real hoje | Evidência necessária | Verificado quando | N/V quando | Ausência de informação | Decisão humana | Avaliável |
|---|---|---|---|---|---|---|---|
| **N1** Nome presente (6) | Serper `/maps` `title` → `maps-name` | E-cap | nome não vazio no lugar casado ⇒ **6** (`PRESENT`; vale até com `complete:false`) | sem captura íntegra; identidade não provada; evidência não `VERIFIED`/> 180 d; conflito no mesmo dia | **omitir** (N/V `NO_OBSERVATION`). Vazio+completo daria `ABSENCE` (0, conta cobertura): só com detector validado — não existe | não | **6 / 6** |
| **N2** Endereço/área (6) | `address` em **texto cru** → `maps-address` | E-cap + **decomposição determinística validada** (parser versionado, D5) | `parsed` rua+nº+cidade+UF ⇒ 6; rua+cidade ⇒ 3; `serviceArea` ⇒ 6 | sem `parsed` (`ADDRESS_UNPARSED`); decomposição indecidível | emitir `address{raw}` sem `parsed`; **nunca zero por texto indecidível**; `parsed.none` só com prova (inexistente) | não | **0 / 6** |
| **N3** Telefone (6) | `phoneNumber` → `maps-phone` | E-cap | como N1 | como N1 | como N1 | não | **6 / 6** |
| **N4** Horários (4) | `openingHours` (dia→texto) → `maps-hours` | E-cap + **estruturação validada** (D5) | `STRUCTURED` 7 dias ⇒ 4; 1–6 dias ⇒ 2 (completo) | `TEXT` (`HOURS_UNSTRUCTURED`); incompleto indecidível | emitir `hours{TEXT}`; `days:[]`+completo = ausência só com prova | não | **0 / 4** |
| **N5** Consistência entre fontes (8) | perfil × **fonte externa** (site/rede/diretório); `nap.sources` | ≥ 1 fonte com origem permitida, `VERIFIED`, ≤ 180 d, hash; **o leitor ainda não comprova `site:`** | ≥ 2 campos comparáveis: 0 divergências ⇒ 8; 1 ⇒ 5; 2 ⇒ 2; ≥ 3 ⇒ 0 | nenhuma fonte com ≥ 2 campos comparáveis (`NAP_NOT_COMPARABLE`) | omitir `nap` (nunca zero por falta de fonte) | `NAME_EQUIVALENCE` — **só tem efeito com fonte comparável** ⇒ desabilitado hoje | **0 / 8** |

### 10.2 Categorias (10 pts · 20 hp)
| Sub. | Fonte | Evidência | Verificado | N/V | Ausência | Decisão humana | Avaliável |
|---|---|---|---|---|---|---|---|
| **C1** Categoria principal (6) | `type` → `maps-category` | E-cap | string não vazia ⇒ **6** | como N1 | omitir | não | **6 / 6** |
| **C2** Compatibilidade (8) | categoria (C1) + **juízo** | E-cap (C1) + registro `JUDGEMENT` com justificativa ≥ 20 | `COMPATIBLE` 8 · `PARTIAL` 4 · `INCOMPATIBLE` 0 (`INCOMPATIBLE` é **avaliado com 0**) | sem categoria (`BASIS_MISSING`); sem juízo (`OPERATOR_CONFIRMATION_REQUIRED`) | omitir; sem juízo nunca zero | **sim** (único tipo) | **8 / 8** |
| **C3** Adicionais (6) | `types[]` → `maps-secondary-categories` (**completude não comprovada**) | lista **completa** comprovada (painel, D5) | juízo `ALL/MOSTLY_RELEVANT/MOSTLY_IRRELEVANT` com lista OK e completa; `MISSING_NEEDED` com lista vazia | lista incompleta (`FIELD_NOT_EXPOSED_OR_INCOMPLETE`); sem juízo | emitir com **`complete:false`** (M-7) | **não oferecer**: juízo exige lista completa; `NO_ADDITIONAL_NEEDED` seria contrariado e **rejeita a auditoria inteira** | **0 / 6** |

### 10.3 Serviços (12 pts · 24 hp)
| Sub. | Fonte | Evidência | Verificado | N/V | Ausência | Decisão humana | Avaliável |
|---|---|---|---|---|---|---|---|
| **S1** Descrição (4) | **nenhuma** (o parser ignora `description`; existência no `/maps` **não verificável** no repositório) | painel anexado ou campo do provedor (D5) | `lengthChars` completo: ≥ 250 ⇒ 4; 1–249 ⇒ 2 | sem observação; incompleto < 250 | omitir; "0 caracteres + completo" = ausência (cobertura) **só com prova de painel** | não | **0 / 4** |
| **S2** Serviços (6) | nenhuma | painel (D5) | contagem completa: ≥ 5 ⇒ 6; 3–4 ⇒ 4; 1–2 ⇒ 2 | sem observação; incompleto < 5 | omitir | não | **0 / 6** |
| **S3** Atributos (4) | nenhuma | painel (D5) | contagem: ≥ 3 ⇒ 4; 1–2 ⇒ 2 | sem observação; incompleto < 3 | omitir | N/A `FEATURE_UNAVAILABLE` exige **evidência de apoio** (anexo) — **não oferecido hoje** | **0 / 4** |
| **S4** Produtos (4) | nenhuma | painel (D5) | contagem: ≥ 3 ⇒ 4; 1–2 ⇒ 2 | sem observação | omitir | N/A `BUSINESS_MODEL` (operador; exige `products` omitido ou 0) — **oferecido** | **0 / 4** |
| **S5** Oferta em fonte própria (6) | **site** | `site.scope` com **hash de páginas** + `offers` com detector validado (lista **vazia**) ou confirmação do operador + atestado de escopo | ≥ 5 ofertas ⇒ 6; 1–4 ⇒ 3 (só com escopo suficiente) | `SITE_NOT_READ`; `DETERMINATION_NOT_VALIDATED`; `SITE_SCOPE_LIMITED` | omitir `site` | `OBSERVATION_CONFIRMATION`/atestado (6B) — **não oferecer** (sem escopo o motor recusa a entrada) | **0 / 6** |

### 10.4 Avaliações (18 pts · 36 hp)
| Sub. | Fonte | Evidência | Verificado | N/V / Amostra insuficiente | Ausência | Decisão humana | Avaliável |
|---|---|---|---|---|---|---|---|
| **R1** Nota média (12) | `rating` + `ratingCount` (**informativo**, M-4a estrita) | — (não alimenta o motor) | **não emitido** ⇒ N/V (`NO_OBSERVATION`) | sempre N/V enquanto a M-4a estrita vigorar | **nunca** derivar `NO_REVIEWS_PROVEN` | não | **0 / 12** |
| **R2** Volume (12) | `ratingCount` (**informativo**, M-4a estrita) | — (não alimenta o motor) | **não emitido** ⇒ N/V | sempre N/V | **nunca** `ABSENCE_PROVEN` | não | **0 / 12** |
| **R3** Recência (12) | **nenhuma** (o `/maps` não traz a data) | Serper `/reviews` (D5-1) ou painel (D5-2) | idade ≤ 30 d ⇒ 12 · ≤ 90 ⇒ 8 · ≤ 180 ⇒ 4 · ≤ 365 ⇒ 2 · > 365 ⇒ 0 | `value:null` (`DATE_NOT_AVAILABLE`); faixa indecisa; data relativa ⇒ grau secundário | omitir | não | **0 / 12** |

### 10.5 Respostas às avaliações (8 pts · 16 hp)
| Sub. | Fonte | Evidência | Verificado | N/V | Ausência | Decisão humana | Avaliável |
|---|---|---|---|---|---|---|---|
| **P1** Taxa de resposta (8) | nenhuma (`/reviews`: só `hasOwnerReply`) | `/reviews` (D5-1) ou painel; **amostra** ≥ 10 lidas ou todas | taxa ≥ 90 % ⇒ 8 · ≥ 70 % ⇒ 6 · ≥ 50 % ⇒ 4 · > 0 ⇒ 2; 0 respostas com amostra ⇒ ausência (0) | campo não exposto; amostra pequena | omitir | não | **0 / 8** |
| **P2** Tempo (4) | nenhuma (o parser **não guarda** data da resposta) | pares data-avaliação/data-resposta (≥ 3) | mediana ≤ 7 d ⇒ 4 · ≤ 30 d ⇒ 2 · > 30 ⇒ 0 | < 3 pares (`DATE_NOT_AVAILABLE`); amostra pequena | omitir | não | **0 / 4** |
| **P3** Qualidade (4) | **juízo humano** sobre respostas lidas | respostas coletadas (D5) | `SPECIFIC` 4 · `GENERIC_OR_MIXED` 2 · `INAPPROPRIATE` 0, com `sampleSize ≥ min(5, respondidas)` | sem respostas; `sampleSize` curto | sem fatos de respostas o juízo é **ignorado** | **não oferecer** hoje (`sampleSize > respondidas` **rejeita a auditoria inteira**) | **0 / 4** |

### 10.6 Visuais (10 pts · 20 hp) e Publicações (8 pts · 16 hp)
| Sub. | Fonte hoje | Evidência necessária | Verificado | N/V | Ausência | Decisão humana | Avaliável |
|---|---|---|---|---|---|---|---|
| **V1** Logo e capa (4) | nenhuma (`thumbnailUrl` = presença de miniatura, **≠ logo/capa**) | painel (D5) | 2 ⇒ 4 · 1 ⇒ 2 (completo) | sem observação; incompleto | omitir; `{false,false}`+completo = ausência só com prova | não | **0 / 4** |
| **V2** Fotos (6) | nenhuma | painel (D5) | ≥ 20 ⇒ 6 · 10–19 ⇒ 4 · 5–9 ⇒ 2 · 1–4 ⇒ 1 hp | incompleto que não fecha faixa | omitir | não | **0 / 6** |
| **V3** Vídeos (2) | nenhuma | painel (D5) | ≥ 1 ⇒ 2 | 0 incompleto | omitir | não | **0 / 2** |
| **V4** Recência da mídia (4) | nenhuma | painel (D5) | ≤ 90 d ⇒ 4 · ≤ 365 d ⇒ 2 · > 365 ⇒ 0 | `value:null` ⇒ `DATE_NOT_AVAILABLE` (mesmo completo) | omitir (ausência derivada só com fotos=0 e vídeos=0 completos) | não | **0 / 4** |
| **V5** Presença visual própria (4) | **site/rede** | `IMAGES_CONFIRMATION` com evidência `OFFICIAL_SITE`/`OFFICIAL_SOCIAL` (o leitor **não comprova `site:`**) | ≥ 2 tipos ⇒ 4; escopo suficiente: 1 ⇒ 2 | sem registro (`OPERATOR_CONFIRMATION_REQUIRED`); `SITE_SCOPE_LIMITED` | sem registro ⇒ N/V | **não oferecer** (sem evidência comprovável) | **0 / 4** |
| **A1** Publicação vigente (6) | nenhuma | painel (D5) | ≥ 1 vigente ⇒ 6; lista completa sem vigente ⇒ 2 | `exposed:false`; incompleto | omitir | N/A `FEATURE_UNAVAILABLE` (anexo) — **não oferecido** | **0 / 6** |
| **A2** Recência da última (6) | nenhuma | painel (D5) | ≤ 30 d ⇒ 6 · ≤ 60 ⇒ 4 · ≤ 90 ⇒ 2 · > 90 ⇒ 0 | `exposed:false`; faixa indecisa | omitir | idem A1 | **0 / 6** |
| **A3** Frequência 90 d (4) | nenhuma | painel (D5) | ≥ 4 ⇒ 4 · 2–3 ⇒ 2 · 0–1 ⇒ 0 | incompleto indecisivo | omitir | idem A1 | **0 / 4** |

### 10.7 Conversão (10 pts · 20 hp) e Autoridade local (9 pts · 18 hp)
| Sub. | Fonte hoje | Evidência necessária | Verificado | N/V | Ausência | Decisão humana | Avaliável |
|---|---|---|---|---|---|---|---|
| **X1** Website no perfil (4) | `website` → `maps-website` (**bruto só no servidor**, §9.6) | E-cap + origem/integridade da URL | string não vazia ⇒ **4** (`PRESENT`) | origem/integridade não comprovadas (fato omitido) | **omitir**. `null`+completo daria `ABSENCE` (0) **e** `NO_WEBSITE_PROVEN` (N/A de X2/X4/X5): proibido sem prova | não | **4 / 4** |
| **X2** Site acessível (2) | **site** | `site.accessibility` + `scope.pagesRead[]` com **sha256** (não coletado) | `OK` 200–399 ⇒ 2; `HTTP_ERROR` persistente (404/410/5xx) ⇒ 0 | `SITE_NOT_READ` | omitir `site` | não | **0 / 2** |
| **X3** Canais de ação (4) | nenhuma (telefone presente ≠ botão "Ligar"; D3B-9) | painel (D5) | ≥ 3 ⇒ 4 · 2 ⇒ 3 · 1 ⇒ 2 hp | incompleto indecisivo | omitir | não | **0 / 4** |
| **X4** Jornada no site (6) | **site** | `site.journey` com detector validado (vazio) ou confirmação + atestado | 3 elementos ⇒ 6 · 2 ⇒ 4 · 1 ⇒ 2 (escopo suficiente) | `SITE_NOT_READ`; `DETERMINATION_NOT_VALIDATED` | omitir | não oferecer | **0 / 6** |
| **X5** Marcação UTM (4) | URL **bruta** da captura, **derivada** (§9.6) | E-cap + URL comprovada | `utm_source` **e** `utm_medium` ⇒ **4**; (parcial só se `complete:true` — M-5 não emite) | qualquer outra situação (**inclusive "sem UTM"**) | **nunca afirmar ausência** (assimetria) | não | **4 / 4 (só com UTM completo)** |
| **L1** Nota × concorrentes (6) | **nenhuma** (`competitors` ausente) | ≥ 3 concorrentes elegíveis (≥ 5 avaliações, ≥ 2 elementos verificáveis) | nota ≥ maior ⇒ 6 · ≥ mediana ⇒ 4 · ≥ menor ⇒ 2 · < menor ⇒ 0 | **Amostra insuficiente** (`competitors` omitido ⇒ 0 avaliado) | omitir | não | **0 / 6** |
| **L2** Volume × concorrentes (6) | nenhuma | idem L1 | volume ≥ maior ⇒ 6 · ≥ mediana ⇒ 4 · ≥ ½ mediana ⇒ 2 · abaixo ⇒ 0 | idem | omitir | não | **0 / 6** |
| **L3** Autoridade externa (6) | nenhuma | `authority` com protocolo registrado nas 4 classes | ≥ 2 tipos ⇒ 6; 1 ⇒ 3 (protocolo completo) | `NO_OBSERVATION`; `PROTOCOL_INCOMPLETE` | omitir | não | **0 / 6** |

**Totais da matriz:** 35 subcritérios, 200 hp. **Avaliáveis hoje (automático):** N1 6 + N3 6 + C1 6 + X1 4 = **22 hp**; **+ X5** 4 (UTM completo comprovado); **+ C2** 8 (decisão humana) = **34 hp** (teto de hoje; R1 e R2 excluídos pela M-4a estrita). O teste `criteria-sources` falha se a régua ganhar ou perder um subcritério sem classificação.

---

## 11. Integração com as decisões humanas (6B) e formulário (D6C-4)

### 11.1 Leitura e escrita
- **Leitura única:** `decisions.list()` fornece `head`, `pending`, `finalizable`, `operatorRecords`, `decisions`, `history`. A 6C **não relê** os arquivos de decisão.
- **Escrita:** a UI chama as rotas da 6B **sem intermediário e sem alterá-las**, sempre com o `expectedHead` visto. Retornos: 200/201 ⇒ recarrega; `HEAD_MISMATCH` ⇒ preserva o rascunho e recarrega; `HISTORY_REGRESSED` ⇒ alerta de integridade; `ANCHOR_PENDING` (503) ⇒ "gravada, **não confirmada**" + **Reenviar** o mesmo corpo (200 `replayed`; conferir `replayed` e `status`); `PENDING_UNCONFIRMED` ⇒ mostra a pendente (autor, tipo, texto **escapado**) e, se for do próprio operador, oferece reenvio.
- **Pendente nunca é confirmada:** bloco próprio "Pendente — não vale", fora da matriz e do cálculo. **Revogação pendente:** a decisão possivelmente revogada fica com selo "pode estar revogada — resultado não finalizável" e **nenhum** registro definitivo é apresentado nem criado.

### 11.2 O que o formulário oferece (só quando motor e evidências permitem)
| Tipo | Oferecido? | Condição verificável | Motivo quando indisponível |
|---|---|---|---|
| Juízo **C2** | **sim** | C1 avaliado com evidência E-cap; sem C2 vigente (senão, "substituir") | "sem categoria principal verificada" |
| N/A **S4** `BUSINESS_MODEL` | **sim** | `products` não observado (6C não emite) ⇒ não é contrariado; justificativa ≥ 20 | — |
| N/A **S3** / **A1–A3** `FEATURE_UNAVAILABLE` | não | exige evidência de apoio (anexo do operador) — sem fluxo de anexos na 6C | "requer anexo do painel (D5)" |
| N/A **C3** `NO_ADDITIONAL_NEEDED` | **nunca** hoje | exige lista completa e vazia; seria contrariado ⇒ `ok:false` | "lista de categorias adicionais não comprovada" |
| Juízo **C3**, **P3** | não | exigem lista completa / respostas; fora disso são ignorados ou **rejeitam a auditoria** | "sem dados de respostas/categorias completas" |
| **Equivalência de nomes** (N5) | só com fonte NAP comparável | existe `nap.sources` com nome divergente | hoje: "sem fonte externa verificada" |
| Atestado de escopo / confirmação de observação / imagens | não | exigem site com escopo e evidência `site:` (não comprovável) | "requer leitura do site (D5)" |

### 11.3 Impedir decisões impossíveis, contraditórias ou sem suporte
Três camadas, **sem duplicar regras**: (1) a API de prévia devolve `decisionOptions[]` (tipo, subcritério, `available`, `reasonCode`) calculado no servidor a partir da matriz e dos fatos emitidos; (2) o botão **Simular** chama `POST …/simulate`, que monta a entrada com o candidato **em memória** e roda o motor — o `ok:false` ou a mudança de estado do subcritério é o veredito; (3) se mesmo assim um registro aceito pela 6B tornar a entrada recusável, a prévia mostra **bloqueio** ligado ao `op-NNNN` com a ação "revogar". Nenhum registro da 6B é alterado ou apagado.

---

## 12. Contrato do registro: PONTUADO × INCONCLUSIVO (D6C-2)

### 12.1 Derivação do `outcome` (feita no servidor, a partir do resultado do motor — nunca pelo cliente)
| `result.publication.status` | `outcome` | `level` / `reasonCode` | `index` | `confidence` |
|---|---|---|---|---|
| `PUBLISHED` | `PONTUADO` | `PUBLICAVEL` | presente | presente |
| `PROVISIONAL` | `PONTUADO` | `PROVISORIO` (rótulo "provisório" obrigatório) | presente | presente |
| `INSUFFICIENT` | **`INCONCLUSIVO`** | `COBERTURA_INSUFICIENTE` se o portão de cobertura falhou; senão `CRITERIOS_INSUFICIENTES` ou `SEM_NAP_OU_AVALIACOES` (lista `failedGates[]`) | **`null`** | **`null`** |
| `NO_DATA` | **`INCONCLUSIVO`** | `SEM_DADOS_AVALIADOS` | `null` | `null` |

Como o motor **já** devolve `ok:true` com `index:null` nesses casos (`engine.ts:65-66`, `publication.ts`), **não é necessário envelope paralelo no motor** e a régua permanece intacta. `ok:false` (entrada recusada) **nunca** gera registro: é bloqueio.

### 12.2 Regras de apresentação (testadas)
- **INCONCLUSIVO:** rótulo fixo "Registro técnico — cobertura insuficiente (sem índice)"; visual **neutro/tracejado**, nunca verde nem "aprovado". **Proibido** exibir: índice, classificação, "nota Lumos", pontos obtidos agregados ou por critério, razão obtido÷avaliado, percentual de "nota", ranking, selo/medalha de "auditoria pontuada". **Permitido:** cobertura (com o mínimo de 40 % ao lado), estado de cada portão, lista de subcritérios com **estado e faixa factual** (ex.: "nota do Google 4,8 — dado do perfil, não nota Lumos"), o que falta (§12.4).
- **PONTUADO:** pode exibir índice e classificação **com o rótulo** `PROVISÓRIO`/`PUBLICÁVEL`, confiança, pontos por critério, limitações, sensibilidade a N/A.
- O arquivo guarda o **resultado completo do motor** (necessário para `verifyScoreResult`), mas a **projeção pública** (`toPublicView`) **remove** `totals.obtained*` e `criteria[].obtained*` quando `outcome = INCONCLUSIVO`. A Onda 7 consome a projeção e não pode imprimir pontos agregados de registros inconclusivos.

### 12.3 Esquema do registro (`<RESULTS>/<auditId>/sNNNN.json`, selado e encadeado) — **implementado no I4** (`results-types.ts`, Zod estrito)
```
{ schemaVersion:1, kind:'LINK_AUDIT_SCORE_RUN', auditId, seq, finalizedAt, finalizedBy,
  outcome: 'PONTUADO' | 'INCONCLUSIVO',
  scored:       null | { level:'PROVISORIO'|'PUBLICAVEL' },
  inconclusive: null | { reasonCode, failedGates:[…], coveragePercent, minimumCoveragePercent:40 },
  scoringAuditId, auditIdAlias:{applied,rule,reason,sourceAuditId},
  decisions:{ head:{seq,sha256}|null, count, appliedIds:[…], applied:[{decisionId,kind,seq,stampCapture,stampCollectedAt}] },
  layout:'VERSIONED'|'LEGACY',
  evidenceBasis:[{ ref, kind, observedAt, contentSha256, bodySha256|null, legacy, superseded }],
  profileSource: null | { ref, observedAt, contentSha256, bodySha256 },
  referenceDate, referenceDateSource:{ ref, observedAt, rule },
  websiteDerivation: null | { rule, rawSha256, sourceEvidence:{ ref, contentSha256, bodySha256 }, utmLevel, x5Proof },
  mapperVersion, methodologyVersion, scoreModelVersion, rulerFingerprint,
  input:  <ScoringInput exato enviado ao motor>,
  result: <ScoreResult completo>,
  inputSha256, resultSha256, prevSha256, contentSha256 }
```
Recibo `aNNNN.json` (pasta separada, protocolo genérico do I0): `{ schemaVersion, kind:'LINK_AUDIT_SCORE_RUN_ANCHOR', auditId, seq, headSha256 (= contentSha256 do resultado), anchoredAt, prevAnchorSha256, contentSha256 }`.

**Invariantes verificadas na gravação (`validate`, antes de publicar) e em TODA leitura (`verifyRunRecord`, `results-verify.ts`; texto fixo, nunca ecoa valores):** entrada aceita por `parseScoringInput` e idêntica à normalizada; `inputSha256`/`resultSha256` conferem; `verifyScoreResult(result, input)` (o motor REPRODUZ o resultado); versões e `rulerFingerprint` iguais ao modelo em `SCORE_MODELS`; `mapperVersion` conhecido; alias reproduzível (`verifyAuditIdAlias`), `sourceAuditId = auditId` e `input.auditId = result.auditId = scoringAuditId`; `outcome`/`scored`/`inconclusive` derivam de `deriveOutcome(result)` (INCONCLUSIVO sem índice nem confiança); `referenceDate` = a da entrada e do resultado e = dia da fonte; cada evidência da entrada está em `evidenceBasis` com o mesmo hash e a mesma data, sem evidência posterior à data de referência; `appliedIds` = ids de `input.operatorRecords`; **M-4a** (sem `reviews` na entrada); só o `website` pode ter `complete:true` e apenas com a derivação registrada (`x5Proof:'PROVEN'`, `utmLevel:'COMPLETE'`). A verificação bem-sucedida é memorizada por `contentSha256` (o registro é imutável e o hash é recalculado a cada leitura): ~6,7 ms por registro sem a memória.
**Tamanho medido (I4):** ~49 KB (PONTUADO com a entrada rica), ~32 KB (INCONCLUSIVO), ~50 KB (com website); teto `MAX_RUN_BYTES` = 1 MiB (arquivo maior é recusado antes de publicar e não é lido na releitura).

### 12.4 "O que falta para o mínimo" (registros e prévias inconclusivos)
A prévia mostra, em linguagem factual, as famílias de dado que **ainda não existem** e o **potencial** (§21) — nunca uma promessa: "Avaliações recentes (R3, P1, P2): até +12 pontos de cobertura · Painel do perfil: até +30 · Leitura do site: até +5…". Rotulado "potencial, ainda não comprovado".

---

## 13. Regras de finalização e bloqueio
Finalizar exige **todas**: integridade das evidências OK; integridade das decisões OK; `finalizable:true` e `pending == null`; `scoreAudit` devolveu `ok:true`; `expectedHead` e `expectedInputSha256` iguais aos recalculados **dentro da trava**; nenhuma referência de evidência não comprovada; operador autenticado e autorizado; pastas de resultados e de recibos configuradas e distintas das demais raízes. **Nunca** finaliza com decisão pendente, `finalizable:false` ou falha de integridade (D6C-2).

**Ordem das checagens implementada (I4, `results.ts`):** corpo estrito → [dentro da trava] reenvio idêntico? → pendente de outro pedido? → avaliação (a MESMA da prévia, leitura dupla concordante) → `expectedHead` (`HISTORY_REGRESSED` se o head atual é menor que o esperado, senão `HEAD_MISMATCH`, devolvendo o head atual) → `expectedInputSha256` (`INPUT_CHANGED`) → bloqueios (`NOT_FINALIZABLE` com `blockers`) → **reconferência do website no bruto íntegro** (`verifyWebsiteDerivation`: relê os bytes, reverifica selo e hashes e rederiva; `WEBSITE_DERIVATION_MISMATCH`; o bruto nunca sai do leitor) → **hashes das evidências já usadas em resultados anteriores não podem ter mudado** (`EVIDENCE_HASH_CHANGED`: captura trocada com o mesmo número e a mesma data) → **releitura final da impressão digital** (head + pendente + registros + base) igual à da avaliação (`INPUT_CHANGED`) → montagem → `verifyRunRecord` → publicação do resultado → recibo → releitura informativa (`stateChangedAfterFinalization`, não persistida).

| Código | Origem | Ação |
|---|---|---|
| `NO_STORED_CAPTURE` | sem captura | coletar (fora da onda) |
| `EVIDENCE_INTEGRITY` | leitor | quarentena/restauração (doc 5B) |
| `DECISIONS_INTEGRITY` | 6B | quarentena (6B §15) |
| `DECISION_PENDING` | `finalizable:false` | reenviar a pendente |
| `ENGINE_REJECTED_INPUT` | `ok:false` do motor | revogar/ajustar a decisão citada |
| `DECISION_NEEDS_SITE_SCOPE` | `siteDependent` vigente | revogar |
| `DECISION_EVIDENCE_NOT_IN_BASE` | decisão cita evidência fora da base | revogar/substituir |
| `INPUT_CHANGED` | `expectedInputSha256` ≠ recalculado | recarregar a prévia |
| `HEAD_MISMATCH` / `HISTORY_REGRESSED` | `expectedHead` | recarregar / alerta |
| `RESULT_PENDING_UNCONFIRMED` | resultado anterior sem recibo | reenviar (só o autor conclui; para outro operador é transitório se havia finalização em curso: `Retry-After`) |
| `WEBSITE_DERIVATION_MISMATCH` | bruto íntegro reaberto não confere com a derivação | recarregar a prévia / investigar a evidência |
| `EVIDENCE_HASH_CHANGED` | evidência já usada em resultado anterior mudou de hash | investigar (captura trocada) |
| `RESULT_INTEGRITY` · `RESULT_TRUNCATED` · `RESULT_ANCHOR_MISMATCH` · `RESULT_ANCHOR_INTEGRITY` | histórico de resultados | quarentena; nenhum dado é exibido |

**Não é bloqueio:** cobertura < 40 % (gera `INCONCLUSIVO`, com confirmação "Este registro não tem nota"). **Nunca** se exibe "0", "nota geral" ou `\d+/100` para registros sem índice.

---

## 14. Contratos de entrada e saída
Todas as rotas: `requireOperator`; cabeçalhos `no-store, private`, `nosniff`, `Vary: Cookie`; `auditId` validado após a autenticação; mensagens públicas fixas; `issues` ≤ 10×300; nenhum caminho, URL, parâmetro ou exceção em respostas e logs.

### 14.1 `GET /api/link-audit/scoring/{auditId}` — prévia (nunca definitiva; 20/min)
```
200 { definitive:false, auditId, scoringAuditId, auditIdAlias:{applied,rule|null}, state,
      company:{ operatorProvidedName, confirmedCid, located, source:'Serper (intermediário)', websiteHost|null },
      evidence:{ integrity:{status,checkedFiles}, referenceDate, referenceDateSource:{ref,observedAt},
                 bases:[{ref,kind,observedAt,origin,contentSha256,legacy}] },
      decisions:{ head, count, pending:PendingDto|null, finalizable },
      decisionOptions:[{ type, subcriterionId|null, available, reasonCode|null }],
      criteria:[{ id,label,maxPoints,state, subcriteria:[{ id,label,maxHalfPoints,source,state,reasonCode|null,decisionIds:[],potential:{family|null,halfPoints} }] }],
      outcomePreview: null | { outcome, level|null, reasonCode|null, failedGates:[], coveragePercent, minimumCoveragePercent:40 },
      result:   null | <projeção pública (§12.2)>,
      blockers:[{ code,severity,message,decisionIds:[],subcriterionIds:[] }],
      missing:[{ family, label, potentialHalfPoints, note:'potencial, ainda não comprovado' }],
      finalization:{ allowed, expectedHead, expectedInputSha256, latest:{seq,finalizedAt,outcome,stale}|null } }
```
Erros: 404; 409 `EVIDENCE_INTEGRITY`/`DECISIONS_*` (**sem dados**); 503 de configuração; 429.

### 14.2 `POST /api/link-audit/scoring/{auditId}/finalize` (6/min) — **implementado no I4**
Corpo estrito `{ expectedHead:Head|null, expectedInputSha256:hex64 }`; **qualquer outro campo ⇒ 400 `FORBIDDEN_FIELDS`** (pontuação, entrada, `referenceDate`, autor, hora, hashes…); malformado ⇒ 400 `INVALID_BODY`. Autor e hora vêm da sessão e do servidor (hora monotônica dentro da auditoria). `requireOperator` antes de validar (inclusive bloqueio de origem cruzada); qualquer parâmetro de consulta ⇒ 400. **201** novo registro confirmado (arquivo + recibo) — `{ definitive:true, replayed:false, head, anchored:true, stateChangedAfterFinalization, run }`; **200** `replayed:true` (qualquer operador, resultado confirmado; o reconhecimento vem ANTES da avaliação, que só serve para calcular `stateChangedAfterFinalization` — compara entrada do motor, head, decisão pendente e `finalizable` de HOJE; `null` = não foi possível comparar; `recoveredPending:true` quando o pedido concluiu o recibo de um resultado que ficara pendente: as evidências citadas precisam existir hoje com os mesmos hashes, senão `EVIDENCE_HASH_CHANGED` e o recibo NÃO é dado); **409** `NOT_FINALIZABLE` (com `blockers`), `INPUT_CHANGED`, `HEAD_MISMATCH`/`HISTORY_REGRESSED` (com o `head` atual), `RESULT_PENDING_UNCONFIRMED` (`Retry-After`), `WEBSITE_DERIVATION_MISMATCH`, `EVIDENCE_HASH_CHANGED`, `RESULT_INTEGRITY`/`RESULT_TRUNCATED`/`RESULT_ANCHOR_*`, `RESULTS_LIMIT_REACHED`, `RESULT_WRITE_CONFLICT`; **503** `RESULT_ANCHOR_PENDING` (`Retry-After`; **nunca 2xx**: gravado e NÃO confirmado), `RESULTS_NOT_CONFIGURED`, `RESULT_ANCHOR_NOT_CONFIGURED`, `RESULTS_MISCONFIGURED`, `RESULTS_STORAGE_UNAVAILABLE`, `RESULT_ANCHOR_STORAGE_UNAVAILABLE`. **INCONCLUSIVO (`index:null`) é resultado válido e selável**; "NÃO FINALIZÁVEL" nunca persiste.

### 14.3 `GET …/results` e `GET …/results/{n}` (30/min) — **implementado no I4**
Lista: `{ definitive:true, auditId, results:[{ seq, finalizedAt, finalizedBy, outcome, level|null, reasonCode|null, coveragePercent, inputSha256, resultSha256, contentSha256, decisionsHead, superseded, stale, decisionsChanged }], head, currentDecisionsHead, pending (resumo, FORA de `results`), anchors, currentInputSha256, integrity }`. `stale` só no mais recente (`null` nos demais ou se a base atual não pôde ser relida: resultados selados continuam consultáveis). Detalhe `{n}` (`^[1-9]\d{0,3}$`): registro **verificado por inteiro** (selo, bytes, encadeamento, recibos, `verifyRunRecord` de TODOS os registros) em projeção pública por lista de campos (sem `input`, sem `rawSha256`, sem e-mails nem justificativas das decisões, `result` por `toPublicView`). Qualquer falha de integridade ⇒ **409 sem dados**; pendente nunca aparece como resultado (`get` de uma pendente ⇒ 409 `RESULT_PENDING_UNCONFIRMED`); auditoria sem nenhum resultado e sem evidências ⇒ 404.

### 14.4 `GET /api/link-audit/operator` — **ADIADO (preparação do I5; verificar antes se já existe forma segura de obter a identidade; NÃO implementado)**
`{ email }` da sessão. Só para exibição; o servidor sempre revalida a autorização.

### 14.5 `POST …/simulate` (20/min) — impede decisões impossíveis (D6C-4) — **ADIADO (depois do I4; reavaliar antes do I5; sempre transitório; NÃO implementado)**
Corpo estrito `{ candidate: <registro no formato do formulário da 6B>, supersedes?: op-NNNN }`. Valida o formato com o esquema da 6B, monta a entrada com o candidato **em memória** e roda o motor. Resposta `{ accepted, blockers[], effect:{ subcriterionId, before, after }[] }`. **Não grava nada**, não altera a 6B, não é fonte de verdade (a gravação continua nas rotas da 6B).

### 14.6 Variáveis (só servidor)
`GMN_LINK_AUDIT_RESULTS_DIR`, `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR` (D6C-5): pastas dedicadas, absolutas, existentes, distintas entre si e das de evidências/decisões/âncoras, nenhuma dentro de outra. Ausentes ⇒ 503 **na finalização e nas consultas de resultados** (a prévia funciona; a simulação segue adiada). A configuração insegura (iguais, aninhadas, relativas, ou iguais/aninhadas às de evidências, decisões e âncoras das decisões) ⇒ 503 `RESULTS_MISCONFIGURED`. **Em dev/teste usar pastas ISOLADAS; nenhum volume é criado na VPS por esta onda.**

### 14.7 Nota de contrato (16/11/2026) — `obtainedHalfPoints` nunca é 0 para ausência
Critério de aceite §19.2 item 4 ("ausência nunca vira zero"). Nos DTOs da prévia (`criteria[].subcriteria[]` e `criteria[]`) e da projeção pública do resultado (`result.subcriteria[]` e `result.criteria[]`, finalização e consulta), em desfecho PONTUADO:
- subcritério `SCORED` ou `ABSENCE_PROVEN` ⇒ `obtainedHalfPoints` é número (o zero comprovado continua 0); `NOT_VERIFIED`, `NOT_APPLICABLE` e `SAMPLE_INSUFFICIENT` ⇒ `null` (antes saía `0`);
- critério `EVALUATED` ou `PARTIAL` ⇒ número; `NOT_VERIFIED` e `NOT_APPLICABLE` ⇒ `null`;
- INCONCLUSIVO não muda: o campo continua omitido (nada que pareça nota). `null` e não omissão em PONTUADO porque o campo sempre existe nesse desfecho e `null` já é a convenção dos demais campos sem valor do DTO; `totals.obtainedHalfPoints` segue numérico (soma só do avaliado).
- Compatibilidade: o registro selado e o formato persistido não mudam (o campo é só projeção do DTO); verificação e reprodução de resultados não são afetadas. O validador do cliente (falha fechada) agora recusa número em estado não avaliado e `null` em estado avaliado. Cliente e servidor são publicados juntos no mesmo app Next, então não há janela de versões mistas.
- Limite conhecido: a falha fechada do validador do cliente vale para a **prévia**. O validador do detalhe de registros (`resultOk`) não valida `result.subcriteria` nem `result.criteria` (só índice, confiança, publicação, limitações e totais), e a tela de registro não exibe a matriz de critérios; nesse caminho a regra depende do servidor (`toPublicView`). Não é regressão: o validador já era assim antes desta nota.

---

## 15. Persistência e rastreabilidade
- **Protocolo = o da 6B (Emenda 1):** arquivo `sNNNN` → recibo `aNNNN` (pasta separada) → só então sucesso; sem recibo o registro é **pendente** (existe, não vale, não é definitivo); reenvio idêntico (mesmo autor, mesmo `inputSha256`, mesmo `expectedHead`) conclui; leitura devolve só o confirmado e mostra a pendente à parte; registros nunca são sobrescritos nem apagados; versões novas são `sNNNN+1`.
- **Rastreabilidade (D6C-2/3 e pedido do usuário):** cada registro grava os **hashes das evidências**, a **versão da régua** (`rulerFingerprint`, `scoreModelVersion`, `methodologyVersion`), o `mapperVersion`, o **`head` confirmado das decisões** e `referenceDateSource`. Ao abrir, o servidor recalcula a entrada atual: `inputSha256` diferente ⇒ **DESATUALIZADO** (o registro antigo continua válido e consultável).
- **Por que guardar a entrada exata:** `verifyScoreResult(result, input)` exige a entrada; `inputSha256` do motor é do objeto normalizado. A entrada **não contém** o website bruto (§9.6) nem parâmetros sensíveis.
- **Limites (I4):** `MAX_RUN_BYTES` = 1 MiB (medido: ~32–50 KB por registro); até 500 versões por auditoria (`LIMIT_REACHED`, sem sobrescrever).
- **Por que o I4 não reutiliza `appendEntry` da 6B:** ele é amarrado a `DecisionEntry` (esquema, projeção semântica) e generalizá-lo exigiria mexer na 6B, congelada. `results-store.ts` repete só a mecânica (trava, releitura, `link()` exclusivo, recibo, pendente) sobre as primitivas do I0 (`link-audit-storage`), com `build` ASSÍNCRONO dentro da trava e um perfil de recibo próprio (prefixo `a`, tipo `LINK_AUDIT_SCORE_RUN_ANCHOR`).
- **Não depende de dado inventado:** o registro só contém o que veio de evidência verificada, decisões confirmadas ou derivações determinísticas versionadas.
- **Extração de primitivas (I0):** `seal`, `serialize`, `readSealedFile`, `atomicOnly`, `assertBase`, `dirStatus`, `ensureDirectory`, `scrubPaths`, `fail`, trava de erro fatal, `splitNames` (prefixo generalizado) e `confirmAnchor/readAnchors/verifyAnchors` migram para `link-audit-storage/` com reexport (§23).

---

## 16. Plano visual e UX

### 16.1 Princípios
Manter a identidade (tema escuro, Inter, tokens `gmn-*`, `Panel`, `StatusBadge` com ícone, cards `rounded-xl border-white/[0.06] bg-gmn-tile/50`); não redesenhar outras áreas; estado nunca só por cor; um `h1`; linguagem honesta.

### 16.2 Página `/auditoria-por-link/[auditId]` (desktop ≥ xl)
```
┌ Cabeçalho ─ Auditoria por Link ▸ <Empresa> ───────────────────────────────────────── [Voltar à lista] ┐
│ ┌ FAIXA DE ESTADO (sticky, aria-live) ─────────────────────────────────────────────────────────────┐ │
│ │ ◌ CALCULADO — NÃO FINALIZÁVEL · 2 bloqueios · cobertura 27 % (mínimo 40 %) · sem índice  [Bloqueios]│ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Empresa e coleta ───────────┐ ┌ Evidências e integridade ──────────────────────────────────────────┐ │
│ │ Nome informado pelo operador│ │ ✔ Integridade OK · 1 captura · relatório r0002 · referência 2026-10-22│ │
│ │ CID confirmado · localizado │ │ capture:c0001 ab12… [copiar]   report:c0001-r0002 9f3c… [copiar]   │ │
│ │ Fonte: Serper (intermediário)│ │ origem rotulada · legado: não · host do site: exemplo.com.br       │ │
│ └─────────────────────────────┘ └────────────────────────────────────────────────────────────────────┘ │
│ ┌ Critérios Lumos ─────────────────────────────────────────────────────────────────────────────────┐ │
│ │ NAP ▾    Estado   Fonte                      Ação                                                  │ │
│ │  N1 Nome  Avaliado ● Automático                                                                    │ │
│ │  N2 End.  N/V      ▲ Bloqueado: sem leitura estruturada (D5)                                       │ │
│ │  C2 Compat. N/V    ✎ Decisão humana           [Simular] [Registrar]                                │ │
│ │  R3 Recência N/V   ○ Sem dado (não coletado)   potencial: +6 pts de cobertura                      │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Decisões humanas ─────────────────┐ ┌ Resultado (prévia) ────────────────────────────────────────┐ │
│ │ ▲ PENDENTE (não vale): revogação  │ │ ┈┈ REGISTRO TÉCNICO — COBERTURA INSUFICIENTE (sem índice) ┈┈ │ │
│ │   autor · data   [Reenviar]       │ │ Cobertura 27 %  ▕███████░░░░░░░░░▏ mínimo 40 %             │ │
│ │ Vigentes (2) · Histórico (7)      │ │ Portões: ✖ cobertura  ✔ critérios  ✔ NAP/Avaliações        │ │
│ │ [Nova decisão ▾] (só as possíveis)│ │ Nota do Google 4,8 = dado do perfil, não nota Lumos        │ │
│ └───────────────────────────────────┘ └────────────────────────────────────────────────────────────┘ │
│ ┌ O que falta (potencial, não comprovado) ┐ ┌ Bloqueios ─────────────────────────────────────────────┐ │
│ │ Avaliações recentes · Painel do perfil… │ │ ✖ DECISION_PENDING → [Reenviar]                        │ │
│ └─────────────────────────────────────────┘ └────────────────────────────────────────────────────────┘ │
│ ┌ Rastreabilidade ──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ head 12 · 7e1c… · regra regua-d3b-r2 · ruler 957f88fd… · mapper lumos-map-v1 · input 4d2a…         │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│  [ Finalizar registro ]  (desabilitado com bloqueios)      Histórico: s0002 (atual) · s0001 (desatualizado)│
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
**Mobile (< md):** coluna única, faixa de estado fixa; seções colapsáveis (`<details>`) na ordem Estado → Bloqueios → Resultado → Critérios → Decisões → Evidências → Rastreabilidade; matriz em **cartões** por critério; alvos ≥ 44 px; hashes com `break-all` e botão copiar.

### 16.3 Resultado pontuado × inconclusivo
Dois componentes **distintos** (não variantes do mesmo): `ScoredResultPanel` (índice com rótulo `PROVISÓRIO`/`PUBLICÁVEL`, confiança, pontos por critério) e `InconclusiveRecordPanel` (borda tracejada, ícone neutro, sem nenhum número de pontos). Testes de renderização garantem que o painel inconclusivo **não contém** `índice`, `classificação`, `pontos obtidos`, `/100`, "selo" nem cores de sucesso.

### 16.4 Formulário de decisão
Seleção do tipo (somente `decisionOptions.available`; os demais aparecem desabilitados **com o motivo**) → campos do esquema da 6B (valor, justificativa ≥ 20; referências de evidência escolhidas **de uma lista** das que o leitor comprova) → **Simular** → resumo "o que muda" → registrar. Estados: validação inline (`aria-invalid`), 409 (recarrega e mantém o rascunho), 503 pendente (reenviar), sucesso (foco no item criado).

### 16.5 Estados de tela e acessibilidade
Carregando, erro (`role="alert"` + "Tentar novamente"), conflito, vazio, acesso negado (401 ⇒ login; 403 ⇒ mensagem), falha de integridade (bloco vermelho, **sem dados**), indisponível (503). Cada leitura é independente. Cabeçalhos coerentes, `caption`/`scope`, `aria-live="polite"`, foco programático após ações e conflitos, teclado completo, ícones `aria-hidden`, datas pt-BR (Brasília). Componentes novos mínimos: `ConfirmDialog`, `CopyHash`, `Disclosure`.

### 16.6 Textos
Fixos e honestos; "N/V = não verificado ≠ zero"; origem rotulada ("Serper, intermediário"). Os testes "honestos" atuais (`link-audit-ui-render.test.ts` L196-220) serão **reescritos de propósito**, preservando o essencial: nunca exibir nota sem `outcome = PONTUADO`.

---

## 17. Segurança, autenticação e autorização
- **Autenticação/autorização:** sessão HMAC existente; `requireOperator` em toda rota; bloqueio de origem cruzada nos POST; lista de operadores reavaliada a cada requisição; sem ACL por auditoria (modelo atual, documentado).
- **O cliente nunca fornece fonte de verdade:** `finalize` e `simulate` são estritos; `findClientProvidedScoreKeys`; `referenceDate`, autor, hora, hashes e versões vêm do servidor.
- **Dado bruto fora do navegador, do disco derivado e dos logs:** a URL bruta só existe em memória no servidor durante a derivação (§9.6); o registro guarda URL derivada + hash do bruto; erros/logs sem URL, parâmetros ou caminhos.
- **Injeção:** texto livre e `pending` renderizados como texto; `displayText()` remove controle/bidi; nenhum `dangerouslySetInnerHTML`.
- **Taxa:** prévia 20/min, simulação 20/min, finalização 6/min, resultados 30/min, por operador.
- **Dados pessoais:** e-mail do operador em decisões/registros é interno; a Onda 7 não pode imprimi-lo sem decisão.
- **Ambiente:** sem `.env*`; sessão assinada por segredo fictício gerada fora da árvore; `guard.ts` intacto (o bypass `dev@localhost` continua recusado pelas decisões).

---

## 18. Idempotência, concorrência e recuperação
- **Finalização idempotente:** mesmo `inputSha256` já finalizado ⇒ 200 `replayed` (não duplica); `RESULT_ANCHOR_PENDING` ⇒ reenviar conclui o recibo.
- **Concorrência (política explícita, I4):** (1) trava por auditoria (em processo) + `link()` exclusivo do `sNNNN` (entre processos); perdendo a corrida relê e REAVALIA (até 5×); (2) dentro da trava: reenvio → avaliação → conferências → recheca do website bruto → hashes fixados → releitura final da impressão digital → publicação; (3) o registro grava o `head` e os hashes realmente usados; resta uma **janela inevitável** entre a última releitura e o `link()` (as pastas de evidências e decisões não compartilham trava): o registro continua verdadeiro SOBRE o estado que grava e fica detectavelmente `DESATUALIZADO` (`stale`); depois do recibo, `stateChangedAfterFinalization` avisa; (4) duas finalizações simultâneas do mesmo estado ⇒ **um** registro (as demais, `replayed`); quem chega entre o resultado e o recibo de OUTRO operador recebe 409 transitório e, ao reenviar, 200; (5) o relógio do cliente nunca é usado.
- **Mudança entre prévia e finalização:** `expectedHead`/`expectedInputSha256` ⇒ 409; nunca grava sobre visão velha.
- **Quedas:** varredura "queda após cada operação de disco" (padrão da 6B); registro pendente nunca vale; quarentena documentada (nunca apagar).
- **Falhas isoladas na tela:** erro em uma das três leituras não derruba as demais. **Prévia é pura e repetível** (mesma base ⇒ mesmos hashes).

---

## 19. Casos de teste e critérios de aceite

### 19.1 Testes (ambiente isolado, fixtures fictícias e réplica fictícia do layout legado)
| Grupo | Cobertura |
|---|---|
| **Mapeador × matriz** | uma bateria por linha da matriz §10 (35): verificado, N/V, ausência e "não oferecido"; fixtures: perfil rico, mínimo, **réplica legada**, conflito no mesmo dia, evidência > 180 d, identidade não provada, captura corrompida; cobertura esperada por fixture = **22 hp** (automático certo), **26 hp** (+ UTM completo) e **34 hp** (+ C2), **independentemente da contagem de avaliações** (M-4a estrita), conforme §5.2 |
| **Contagens de avaliações (M-4a estrita)** | `ratingCount` = **0**, **999**, **1000**, **1001**, valores **abreviados** ("1,2 mil", "1.2K", "1k+"), texto numérico ("120"), fracionário, negativo, `NaN`/`Infinity`, `null`/ausente ⇒ em **todos** os casos o `ScoringInput` **não contém `reviews`** (R1 e R2 N/V; nunca `NO_REVIEWS_PROVEN`/`ABSENCE_PROVEN`; 1000 sem tratamento especial); `informational.reviews` classifica o valor de forma inequívoca; **fixtures testam a lógica, não o provedor** |
| **Invariantes** | **propriedade:** nenhuma combinação gera `ABSENCE_PROVEN`/N/A derivado sem prova; ausência ⇒ fato omitido; **`complete:true` nunca sem atestação nem prova positiva (M-3b)**; `referenceDate` ≥ todo `observedAt` (parametrizado perto da meia-noite); `_` ⇒ alias determinístico sem colisão e id sem `_` inalterado; nenhuma chave de pontuação; determinismo; `criteria-sources` = `SUBCRITERIA` |
| **X5 / URL (D6C-3)** | UTM completo ⇒ 4; parcial/ausente/sem esquema/fragmento ⇒ N/V; credenciais e parâmetros sensíveis **nunca** chegam à entrada, ao registro, a respostas, logs ou erros (varredura de strings); `rawSha256` confere com a captura; origem/integridade falhando ⇒ X1…X5 N/V |
| **Motor/regressão** | `scoring/` idêntico à tag; hashes dourados da 6A intactos; `ok:false` ⇒ bloqueio com `decisionIds` |
| **Decisões** | pendente ⇒ `NOT_FINALIZABLE`; revogação pendente nunca definitiva; `finalizable:false`; integridade falha ⇒ nenhum dado; `siteDependent` ⇒ bloqueio; N/A contrariado; evidência não comprovada; `site:` recusado; `decisionOptions` coerentes com o motor (**simular** concorda com a prévia) |
| **Contrato PONTUADO × INCONCLUSIVO** | derivação para os 4 estados de publicação; INCONCLUSIVO sem `index`/`confidence`; projeção pública sem `obtained*`; painel inconclusivo sem os termos proibidos; NO_DATA ⇒ INCONCLUSIVO; nunca grava com `ok:false`, pendente, `finalizable:false` ou integridade falha |
| **Serviço/rotas** | 401/403/429/413/415; campos de pontuação ⇒ 400; todos os 409; prévia nunca `definitive:true`; sem pasta de resultados ⇒ prévia ok e finalização 503 |
| **Armazenamento** | selo/bytes canônicos; encadeamento; recibos; queda após cada operação; truncamento, restauração, pendente forjada, reenvio, 6 finalizações simultâneas ⇒ 1; fuzz com modelo; **mutação ≥ 25 mutantes mortos** |
| **Extração (I0)** | 1041 testes da 6B **sem alteração**; fixture de ouro v1 inalterada; M01–M25 reexecutados; comparação de árvores de arquivos antes × depois |
| **Leitor** | `readScoringBasis`: hashes, `observedAt`, legado fictício, `CORRUPT/MISMATCH` ⇒ vazio, nada de corpo bruto/URL/caminho nos DTOs públicos |
| **UI** | estado (pedidos fora de ordem, erros por leitura, rascunho no 409, reenvio no 503); render (cada estado de §8, `pending` escapado, mobile, acessibilidade) |
| **Isolamento/deploy** | cliente sem imports de servidor; só `*api-client.ts` usam `fetch`; rotas de decisões ainda proíbem o motor; `stack.yml` **não** alterado |

### 19.2 Critérios objetivos de aprovação (fim da 6C)
1. Suíte completa verde (≥ 1041 + novos), `tsc` limpo, build offline ok (ESLint **não** conta: não instalado).
2. `git diff v1.0.1 -- src/lib/link-audit/scoring` vazio; fixture de ouro v1, hashes dourados do motor e **testes da 6B** inalterados.
3. Nenhum resultado é definitivo sem registro gravado, verificado e atual; nenhum registro é gravado com `finalizable:false`, pendente, integridade falha ou `ok:false`.
4. Provado por teste: ausência nunca vira zero; o cliente não injeta pontos, cobertura ou `referenceDate`; **INCONCLUSIVO nunca exibe nota**.
5. `referenceDate` derivada de evidência armazenada; `_` tratado por alias registrado; `site:` recusado; URL bruta nunca persistida/exibida/logada.
6. Mutação dos pontos críticos: 100 % mortos (equivalentes justificados).
7. Revisão adversarial independente do código final **sem BLOCKER**.
8. Validação visual no localhost (sessão fictícia, headless, desktop e mobile).
9. Nenhuma rede, segredo ou `.env` no conjunto; nada na VPS; nenhuma migration.

---

## 20. Arquivos a criar ou modificar (padrão; sem enumerar todos)
**Criar (servidor):** `src/lib/link-audit-storage/` (I0); `src/lib/link-audit-scoring-runs/{assemble,derive-url,criteria-sources,blockers,outcome,service,store,types,index}.ts`; `src/app/api/link-audit/scoring/{shared.ts,[auditId]/route.ts,[auditId]/simulate/route.ts,[auditId]/finalize/route.ts,[auditId]/results/route.ts,[auditId]/results/[seq]/route.ts}`; `src/app/api/link-audit/operator/route.ts`.
**Criar (cliente):** `src/app/auditoria-por-link/[auditId]/page.tsx` (fina); `src/components/link-audit/audit-work/*` (estado, `*-api-client.ts` ×3, rótulos, painéis incl. `ScoredResultPanel`/`InconclusiveRecordPanel`); `src/components/ui/{confirm-dialog,copy-hash,disclosure}.tsx`.
**Criar (testes/docs):** `tests/link-audit-scoring-runs-*.test.ts`, `tests/link-audit-work-ui-{state,render}.test.ts`, fixtures fictícias (inclui réplica legada); `deploy/hostinger/PLANO-DE-VOLUME-DE-RESULTADOS.md` (só plano); ADR/Emenda se o protocolo mudar.
**Modificar:** `src/lib/link-audit-evidence/{reader.ts,index.ts}` (`readScoringBasis`, servidor-only); `src/lib/link-audit-decisions/*` (**apenas** reexport do I0, sem mudar comportamento); `stored-audit-list/detail.tsx` (link "Abrir auditoria"); `audit-workspace.tsx`; `messages.ts`; `package.json` (lista do `test`); `NOTES.md`/docs; **testes de isolamento** (ajustes estreitos abaixo).
**Não modificar:** `src/lib/link-audit/scoring/**`, `site-check.ts`, `url-safety.ts`, `stack.yml`, `Dockerfile`, `supabase/**`, `guard.ts`, `.env*`.
**Ajustes deliberados nos testes de isolamento:** (1) `link-audit-isolation` — consumidor novo declarado; (2) idem — novo importador do índice público do leitor; (3) `link-audit-scoring-isolation` — primeiro consumidor do motor, só `scoring/index`, só a nova lib; (4) `link-audit-decisions-isolation` — a nova lib pode importar o **índice** das decisões (a proibição do motor nas **rotas** de decisões é mantida); (5) listas exatas de arquivos e política de `fetch` do cliente.

---

## 21. D5 — Coleta Ampliada (proposta de planejamento; **NÃO autorizada para implementação**)

### 21.1 Escopo, restrições e definições
Objetivo de produto (D6C-6): permitir auditorias Lumos **com pontuação real** quando existirem evidências suficientes — **sem** reduzir o mínimo de 40 %, **sem** alterar pesos, **sem** fabricar dados. Restrições vigentes (repositório): decisão de **16/10/2026** — *sem DataForSEO, sem Google Business Profile API, sem novos serviços pagos*; Serper `/maps` com teto LIVE `maps:1, reviews:0, siteHttpRequests:8`; autorização escrita **por consulta**, validade ≤ 24 h, uma empresa por 24 h; custo do `/maps` observado = **3 créditos** (US$ por crédito **não confirmado**); custo de `/reviews` **desconhecido**; verificador de site sem custo de API. Qualquer provedor novo ou pago exige **revogação explícita** dessa regra.
**Potencial ≠ comprovado:** *potencial* = soma dos pesos dos subcritérios cuja fonte passaria a existir; *comprovado* = `coveragePercent` do motor sobre evidência verificada de uma auditoria real. O potencial **não** é meta, nota nem promessa; só conta o que o motor avalia a partir de evidência verificada (e `ABSENCE_PROVEN` conta cobertura **apenas com prova**).

### 21.2 Ganho potencial por família (pesos reais de `ruler.ts`; 200 hp = 100 pts)
| Família | Subcritérios | hp | pontos | Fonte | Custo/estado |
|---|---|---|---|---|---|
| **F0** Perfil automático "certo" (já existe) | N1 · N3 · C1 · X1 | 22 | 11,0 | Serper `/maps` armazenado (`complete:false`) | feito |
| **R1/R2** (**EXCLUÍDOS pela M-4a estrita**; reabilitáveis só na D5, §9) | R1 · R2 | 24 | 12,0 | contagem/nota de avaliações com fonte e política comprovadas | **não autorizado** |
| F0+ UTM comprovado | X5 | 4 | 2,0 | URL bruta verificada (M-5) | feito (condicional) |
| F0+ juízo humano | C2 | 8 | 4,0 | operador (6B) | feito |
| **F1** Parsers sobre dado **já coletado** | N2 · N4 | 10 | 5,0 | endereço/horários do `/maps` | sem custo de coleta |
| **F2** Site: hash de página, NAP do JSON-LD, acesso | N5 · X2 | 10 | 5,0 | verificador de site (≤ 8 requisições) + leitor `site:` | sem custo de API |
| **F3** Avaliações recentes e respostas | R3 · P1 · P2 · (P3 humano) | 20–28 | 10,0–14,0 | Serper `/reviews` (formato **não confirmado**) | custo **desconhecido**; 1 chamada de teste pendente de autorização |
| **F4** Painel do perfil anexado pelo operador | S1–S4 18 · V1–V4 16 · A1–A3 16 · X3 4 · C3 6 | 60 | 30,0 | operador (anexo com hash) | sem custo de API; trabalho humano; **não há fluxo de upload** |
| **F5** Site profundo + confirmações | S5 · X4 · V5 | 16 | 8,0 | escopo `SITEMAP_COMPLETE`/revisão documentada + atestado | exige mais leitura e trabalho humano |
| **F6** Concorrentes e autoridade | L1 · L2 · L3 | 18 | 9,0 | busca por categoria (Serper `/maps`), protocolo de L3 | custo por chamada; regra "sem grade de 49" |
| **Total** | | **200** | 100 | | (22+24+4+8+10+10+28+60+16+18) |

### 21.3 Caminhos até ≥ 40 % (80 hp) e portões (≥ 3 critérios com ≥ 6 hp avaliados; NAP ou Avaliações)
**População única** (M-4a estrita: R1/R2 N/V para qualquer número de avaliações). *base* = F0 (22) + X5 (4) + C2 (8) = **34 hp**. ✔ = alcança 40 %. Os totais abaixo **ainda não** incluem a reabilitação de R1/R2 (+24 hp).
| Caminho | hp · % | Observação |
|---|---|---|
| **Hoje** (F0 + X5 + C2) | 34 · 17,0 % | teto; típico 11–17 % |
| + F1 + F2 (**tudo sem custo**) | 54 · 27,0 % | **ninguém alcança 40 %** |
| base + **F3** (R3 + P1) | 54 · 27,0 % | |
| base + F3 (R3+P1+**P2**) | 58 · 29,0 % | P2 exige datas de resposta |
| base + F3 (R3+P1) + F1 | 64 · 32,0 % | |
| base + F3 **completo** (R3+P1+P2+P3) + F1 | 72 · 36,0 % | P3 é juízo humano; ainda abaixo |
| base + F1 + F2 + F3 (R3+P1) | 74 · 37,0 % | |
| base + F1 + F2 + F3 (R3+P1+P2) | 78 · 39,0 % | **a 2 hp do mínimo** |
| base + F1 + F2 + F3 **completo** | 82 · **41,0 %** ✔ | exige `/reviews` com datas, respostas e o juízo P3 |
| base + **F4 parcial** (S1–S4 + V1 = 22) | 56 · 28,0 % | só com o operador |
| base + F4 (S1–S4 + V1–V4 = 34) | 68 · 34,0 % | só com o operador |
| base + F3 **completo** + F4 parcial | 84 · **42,0 %** ✔ | |
| base + F1 + F2 + F4 (34) | 88 · **44,0 %** ✔ | painel + parsers + site |
| base + F3 (R3+P1) + F4 (34) | 88 · **44,0 %** ✔ | |
| tudo menos F5/F6 | 142 · 71,0 % ✔ | publicável (≥ 65 % = 130 hp) |
| **+ R1/R2 reabilitados** (+24, D5) a qualquer linha acima | +12,0 pontos percentuais | ex.: base + F1 + F2 + F3 (R3+P1) = 98 hp (49 %) ✔ |
Nenhum caminho **só de site** (F0…F2) chega a 40 %. Para ≥ 65 % (publicável = 130 hp) é preciso, além de F0–F3 (82 hp), **pelo menos 48 hp** vindos de F4, F5, F6 ou da reabilitação de R1/R2. **Portões:** sem o critério Avaliações, o `CRITERIA_MIN` depende de NAP, Categorias e de um terceiro critério (Conversão com X5 comprovado; ou, na D5, Avaliações via R3, Respostas via P1, Serviços/Visuais via F4).

### 21.4 Cenários após a ampliação
| Cenário | Máximo estimado | Atinge 40 %? |
|---|---|---|
| **D5 sem custo** (F1+F2), sem `/reviews` e sem painel | 54 hp (27 %) | **Não — todos continuam sem índice** |
| D5 sem custo + `/reviews` (≥ 10 avaliações datadas, respostas expostas) | 74 hp (R3+P1) · 78 hp (+P2) · 82 hp (+P3 humano) = 37–41 % | **Só com F3 completo (limite)** |
| Perfil com poucas avaliações ou sem avaliações | igual ao cenário anterior (R1/R2 já são N/V por política) | idem |
| Perfil **sem avaliações comprovado por painel** (N/A em R3, P1, P2, P3 = 28 hp de potencial perdido) | sem painel: 54 hp (27 %); com F4: 114 hp (57 %); 126 hp (63 %) se o painel também atestar a contagem exata (R2 ausência comprovada, +12) | **só com o painel (F4)** |
| Site **bloqueado** (401/403/WAF) ou inexistente | −26 hp (F2+F5); com `/reviews`: 72 hp (36 %) | **Não** sem o painel (F4) |
| Perfil cujo provedor **não expõe** data/respostas e **sem** painel | ≤ 54 hp (27 %) | **Não** |
Observação: **N/A nunca aumenta a cobertura** (o denominador da publicação é fixo); ele só retira potencial.

### 21.5 Dados adicionais necessários (lista objetiva)
(1) data e texto resumido de cada avaliação **e** data da resposta do proprietário; (2) endereço e horários **estruturados** (parser validado); (3) hash SHA-256 e sinalização de truncamento das páginas lidas do site, mapeamento de acesso e `site:cNNNN` verificável; (4) descrição, serviços, atributos, produtos, fotos, vídeos, logo/capa, data da mídia, publicações, ações e **lista completa** de categorias adicionais — por **anexo do painel** do perfil; (5) concorrentes elegíveis (mesma região/categoria/intenção, ≥ 5 avaliações) e protocolo de autoridade; (6) atestação de **fidelidade da URL** (permitiria afirmar ausência de UTM).

### 21.6 Plano mínimo da D5 (priorizado por dado verificável, custo e ganho; **cada onda exige autorização própria**)
| Onda | Conteúdo | Ganho | Custo/risco | Pré-requisitos |
|---|---|---|---|---|
| **D5-0** (sem custo de API) | (a) parsers determinísticos de endereço BR e de horários sobre **dado já armazenado**, versionados, com fixtures; (b) verificador de site com hash/truncamento, `accessibility`, JSON-LD→`nap.sources`, `site:cNNNN` no leitor | +20 hp (F1+F2) → 78 hp | `site-check.ts`/`url-safety.ts` hoje "intocados" por política; tráfego a sites de terceiros (robots, identificação); sem LGPD nova | autorização para tocar esses módulos e para ampliar leitura do site |
| **D5-1** (`/reviews`) | 1 chamada de teste → confirmar formato real → novo tipo de captura `serper-reviews` com corpo bruto e hash → parser estendido (data da avaliação, data/ texto da resposta) | +20–28 hp (R3, P1, P2, P3) | custo **desconhecido**; teto LIVE de reviews hoje **0**; avaliações contêm nomes/textos de terceiros ⇒ **política de retenção/LGPD a decidir** (a Fase 4 optou por não gravar nomes); regra de 24 h por empresa precisa de decisão para uma 2ª chamada | autorização escrita específica; ajuste de `LIVE_HARD_LIMITS`/`ProviderId`/`captureSchema` |
| **D5-2** (painel do operador) | fluxo de **anexos** com hash (`OPERATOR_ATTACHMENT`), digitação assistida dos fatos com conferência, interface | até +60 hp (F4) | **upload de arquivos** = nova superfície de segurança (tipos, tamanho, varredura); trabalho humano por auditoria | decisão de segurança de upload; Onda própria |
| **D5-3** (concorrentes) | busca por categoria via Serper `/maps`, critérios de equivalência, seleção sem grade de 49 | +12 hp (L1, L2) | 3 créditos/chamada; B-3 do E0 (bloqueio) | decisão de fonte e custo |
| **D5-4** (autoridade e site profundo) | protocolo de L3; sitemap/revisão documentada + atestado + confirmações | +22 hp (L3 + F5) | trabalho humano; mais requisições | após D5-0 |
**Ordem recomendada:** D5-0 → D5-1 → D5-2 (maior ganho por esforço e custo de API zero) → D5-3 → D5-4. Provedores fora do repositório (DataForSEO, GBP API, Places) **não** fazem parte do plano e exigiriam revogar a decisão de 16/10/2026; **o que eles forneceriam não é verificável no repositório**.

---

## 22. Bloqueadores de implementação e riscos residuais

### 22.1 Bloqueadores (precisam de decisão ou correção **antes** do I0/I1)
| # | Bloqueador | Tratamento |
|---|---|---|
| B-1 | ~~Homologar M-4a e M-5~~ | **Resolvido em 29/10/2026**: M-4a **definitiva em modo estrito** (contagem de avaliações fora do cálculo) e M-5 aprovada |
| B-2 | O leitor não expõe hashes/valores brutos mínimos | `readScoringBasis` servidor-only (I1); ajuste estreito da política de isolamento |
| B-3 | `auditId` com `_` | alias M-10 (sem mexer em `scoring/`) |
| B-4 | Decisões da 6B podem derrubar o cálculo (`ok:false`: N/A contrariado, C3/P3, atestado sem escopo) | `decisionOptions` + `simulate` + bloqueios traduzidos |
| B-5 | Extração de primitivas toca código de segurança da 6B | plano A com provas objetivas **ou plano B** que não toca a 6B (§23, I0) |
| B-6 | Testes "honestos" da UI proíbem botões e notas; 5 políticas de isolamento | reescrita deliberada com a garantia "nunca nota sem PONTUADO" |
| B-7 | Falta rota de identidade do operador | `GET /operator` |
| B-8 | Layout legado sem dado real | réplica **fictícia** da estrutura legada |
| B-9 | Semântica de completude de `ratingCount` **não comprovada** | contagem **fora do cálculo** (M-4a estrita) até existir fonte e política de verificação (D5); **não bloqueia o I1** |

### 22.2 Riscos residuais
1. **Cobertura sempre < 40 % com a coleta atual (teto 17 %)** ⇒ a 6C produz registros `INCONCLUSIVO`; é o comportamento correto, mas a **expectativa de produto precisa ser alinhada** (D5 não autorizada).
2. **Fidelidade do Serper:** nota arredondada a 1 casa (faixas de R1 em centésimos), contagem possivelmente abreviada, `website` possivelmente normalizado; mitigados por M-4a estrita (a contagem não alimenta o motor), M-3b e M-5; **intermediário rotulado**; a prova do comportamento real do provedor exige amostra autorizada (fixtures não bastam).
3. **X5 subpontua** (ausência/parcial ⇒ N/V) até existir atestação de fidelidade — escolha conservadora deliberada.
4. **`ok:false` opaco:** o motor devolve mensagens, não códigos; a tradução em bloqueios é por texto (`op-NNNN`) e precisa de testes de contrato para não quebrar se o texto mudar.
5. **Orçamento de taxa:** abrir a página gasta ~3 leituras; prévia/simulação recalculam; avaliar cache em memória por (`head`, hashes) no I3.
6. **Tamanho do registro** (entrada + resultado) a medir no I4.
7. **Divergências código × D3B (§5.3)** permanecem até decisão própria.
8. **Dado interno:** e-mail do operador em registros; Onda 7 não pode imprimi-lo sem decisão.
9. **Produção:** dois volumes e duas variáveis novos — **só plano**; sem volume, finalizar falha fechada (503), prévia funciona.
10. **A lista de auditorias do leitor corta em 100**; sem paginação (fora do escopo).
11. **Resultado pendente órfão (I4):** só o autor conclui; se ele sair da lista de operadores, a auditoria fica sem novas finalizações. Nada apaga a pendente; procedimento: quarentena manual do `sNNNN` pendente por quem administra o volume (fora do sistema) e registro do incidente. `Retry-After` é só uma dica. **REVISADO (R4-MINOR-1/2):** a tela diz "não apague nem mova"; a quarentena só vale para pendência de **criação simples** com origem NÃO comprovada e **nunca** para **revogação/substituição** (qualquer origem, inclusive `KEY_REVOKED`) nem para resultado pendente sem fonte independente (6B §15 item 3, revisada após o achado M-3 da 5ª revisão).
12. **Escrita privilegiada só na pasta de resultados (I4) — CORRIGIDO (remediação do MAJOR-1, ADR 6C-02):** um `s(N+1)` forjado e autoconsistente vira "pendente"; **a versão anterior deste item tratava "a conclusão exige o autor" como mitigação, mas o pedido de conclusão é montado a partir do próprio arquivo e o resultado forjado (inclusive PONTUADO, com fatos fabricados que citam hashes reais) era CONFIRMADO com um clique (RV-01)**. Agora a conclusão exige a **etiqueta de origem** (HMAC do servidor, chave fora das pastas) além do autor autenticado, do registro que se explica, das evidências com os mesmos hashes e da não regressão do histórico; sem ela, 409 `RESULT_PENDING_ORIGIN_UNPROVEN`. Quem altera as DUAS pastas (dados + recibos) continua não detectado sem guarda externa do `head`; remover o ÚLTIMO recibo é indistinguível de uma gravação interrompida (ver o modelo de ameaças).
13. **Menores aceitos (I4):** pastas vazias criadas antes do `build` (ruído, 6/min); verificação semântica síncrona em lote com cache frio (~6,7 ms/registro, até 500); `finalizedAt` tomado antes da avaliação; amarrações extras de `verifyRunRecord` só para registro forjado (website presente ⇒ derivação; `kind` × prefixo da ref); no limite de 500 um pedido desatualizado recebe antes `HEAD_MISMATCH`/`INPUT_CHANGED`.

---

## 23. Plano de implementação I0–I7 (contratos e critérios de aceite)
Cada incremento fecha com testes verdes no ambiente isolado, `tsc` limpo e, quando tocar rotas/UI, build offline. **Sem commit sem autorização; sem avançar de incremento sem aprovação do anterior.**

### I0 — Extração das primitivas (**CONCLUÍDO e aprovado em 29/10/2026 — Plano A**; checkpoint local `refactor(link-audit): extract shared receipt storage`; sem alterar os protocolos da 6B)
- **Objetivo:** extrair as primitivas reutilizáveis de armazenamento e integridade para o módulo neutro `src/lib/link-audit-storage/`, mantendo **reexports compatíveis** em `link-audit-decisions` (mesmos símbolos, mesmas assinaturas, mesmas mensagens e códigos).
- **Contrato:** `link-audit-storage` exporta `seal`, `serialize`, `hashOk`, `readSealedFile`, `atomicOnly`, `assertBase`, `locateIn` (com o padrão de id **por parâmetro**), `dirStatus`, `ensureDirectory`, `scrubPaths`, `fail`, a trava de erro fatal, `splitNames` (prefixo generalizado) e o **protocolo de recibos genérico** (`readReceipts`, `verifyReceipts`, `writeReceipt`, `confirmReceipt`, `prepareReceiptDirectory`, `receiptBody`) parametrizado por um **perfil** (prefixo, padrão de nome, esquema, tamanho máximo, textos). A 6B define o seu perfil com os textos atuais, de modo que a saída seja **byte a byte a mesma**.
- **Não muda:** formato dos arquivos `dNNNN`/`aNNNN`, `expectedHead`, `ANCHOR_PENDING`, `PENDING_UNCONFIRMED`, reenvio, recuperação, revogação, integridade, códigos de erro e mensagens, `StoreErrorCode`, `scoring/` e a régua D3B. **Nada em 5A/5B/6A é tocado.**
- **Aceite:** (1) **nenhum** arquivo `tests/link-audit-decisions-*.test.ts` alterado (única exceção: as listas de imports/invariantes do teste de isolamento, §20 item 5, com justificativa); (2) **1041 testes** da linha de base continuam verdes; (3) fixture de ouro v1 byte a byte igual; (4) **teste de conformidade do protocolo** gravado **antes** da refatoração (árvores de arquivos e respostas — códigos, mensagens, `head`, `pending` — de um cenário roteirizado: criar, substituir, revogar, `HEAD_MISMATCH`, `HISTORY_REGRESSED`, recibo que falha, pendente, reenvio, truncamento, adulteração) e **idêntico depois**; (5) testes **específicos do módulo neutro** (selo e leitura estrita, atomicidade, trava fatal, localização, perfis de recibo distintos do da 6B, adoção de recibo, truncamento, tentativas); (6) isolamento do módulo neutro (lista exata de arquivos, imports, sem rede/ambiente/relógio/destruição, só a 6B o consome); (7) M01–M25 **remapeados** para os novos locais e **todos mortos**, mais mutantes do módulo neutro; (8) `tsc` e build offline limpos; (9) `scoring/` idêntico à `v1.0.1`; (10) **revisão independente** da refatoração (comparação com o commit-base); (11) relatório técnico e **parada** — sem commit e sem I1.
- **Resultado (29/10/2026):** 1082/1082 testes; `tsc` e build offline limpos; conformidade (35 passos) e diferencial (71 cenários, referência gerada no commit-base `d7b0eec`) idênticos; mutação 58/58 (lote 1) e 27/28 (lote 2; o sobrevivente é o texto inalcançável `noAttempt`, equivalente); `scoring/` 0 linhas de diferença; revisão independente **APROVADO COM RESSALVAS**, todas atendidas (R1–R5). Ver o relatório técnico do I0.
- **Plano B** (não adotado; fica como contingência se um critério acima falhar de forma irrecuperável): **copiar** as primitivas e **não tocar na 6B**. A troca exigiria nova autorização do usuário.
### I1 — Base de pontuação (leitor) (**CONCLUÍDO e aprovado em 29/10/2026**; checkpoint local `feat(link-audit): add verified scoring evidence basis`; sem mapeador, pontuação, finalização ou interface)
- **Resultado (29/10/2026):** 1132/1132 testes (linha de base do I0: 1082; +50 do I1, incluindo o teste do vínculo ausente/malformado); `tsc` limpo; `scoring/` 0 linhas de diferença contra `v1.0.1`; revisão independente **APROVADO COM RESSALVAS**, todas tratadas. **Verificação do legado real (somente leitura, nada impresso além de booleanos): COMPATÍVEL.** O relatório vigente e o superado trazem `source.capture.sha256` (64 hexadecimais) **igual** ao SHA-256 do `serper-body.json` conferido pelo `SHA256SUMS`; o sidecar de cada relatório confere; o leitor devolveu `READY` (`LEGACY`, 3 evidências com hash, identidade `PROVEN` por CID, perfil `AVAILABLE`, `informational.reviews` rotulado `EXCLUDED_M4A`). **O leitor não aceita relatório sem vínculo criptográfico verificável:** hash ausente, nulo, não textual, em lista, curto, vazio, em maiúsculas, com espaço/prefixo ou bloco `capture`/`source` ausente ⇒ `INTEGRITY_FAILED`/`NO_EVIDENCE` sem nenhum dado (teste dedicado, 12 variantes).
- **Onde:** `src/lib/link-audit-evidence/scoring-basis.ts` (+ `derive-url.ts`, puro) e a extração literal do leitor legado para `legacy.ts` (comportamento do 5B inalterado, provado pelos testes existentes). **Não** é exportado pelo índice público do módulo (o índice é importado por código de cliente só para tipos): o único importador permitido em I1 é o próprio módulo; qualquer rota futura (I3) exige decisão e teste de isolamento próprios.
- **Contrato:** `createScoringBasisReader(options: EvidenceReaderOptions).readScoringBasis(actor, auditId) → ScoringBasisOutcome`:
  - `{status:'NOT_FOUND'}` (pasta ausente, symlink ou não diretório) · `{status:'NO_EVIDENCE', integrity}` (sem captura+relatório) · `{status:'INTEGRITY_FAILED', integrity}` (qualquer arquivo da coleta não confere) · `{status:'READY', basis}`. **Nos três primeiros casos nenhum dado de perfil, hash ou valor é devolvido** (só estado e as mensagens de integridade já sanitizadas). Id inválido lança erro (igual ao leitor 5B); ator não autorizado lança `EvidenceAccessError` (falha fechada).
  - `basis = { version:'scoring-basis-v1', auditId, layout:'VERSIONED'|'LEGACY', evidences:[{ref, kind:'CAPTURE'|'REPORT', capture, revision, observedAt, generatedAt, contentSha256, bodySha256, superseded, legacy, origin:'GOOGLE_NATIVE', provider:'serper-maps', intermediary:true}], profile: {state:'AVAILABLE', …} | {state:'UNAVAILABLE', reason}, informational:{reviews} }`.
  - `observedAt` = data da coleta da captura (também para o relatório, nunca a data de geração). `contentSha256` = hash selado do arquivo (legado: SHA-256 do arquivo conferido pelo `SHA256SUMS`/hash declarado). Os `ref` são os mesmos `capture:cNNNN`/`report:cNNNN-rNNNN` que a 6B aceita; `site:` segue **fora** (recusado).
  - **Perfil elegível ao motor** (somente da captura **de maior data de coleta com resposta utilizável**, HTTP 2xx e corpo presente, desempate pelo número; **nunca** mistura capturas; o I2 deve usar `profile.source` como fonte da data de referência): `source{ref,observedAt,contentSha256,bodySha256}`, `identity{state:'PROVEN', matchedBy{cid,placeId}, expectedCidOrigin}`, `name`, `phone`, `primaryCategory`, `additionalCategories` (`null` se nenhuma observada; lista como observada, nunca completa), `address{raw}`, `hoursRaw` (texto COMPOSTO `dia: horário; …`, não o bruto), `website`, `reportEvidence{maps-*→status}` (do relatório mais recente daquela captura). Campo ausente = `null`; **nada é inferido** (nenhum `complete`, nenhum zero, nenhuma lista vazia fabricada).
  - **Identidade:** a identidade confirmada do operador (`input.identity.confirmation` na captura; `identifiers.fromLink` do relatório no legado) é casada com o corpo **só por CID/placeId** (`matchPlace`). Nome nunca confirma. Sem confirmação, não localizado, ambíguo, corpo ilegível ou captura sem resposta utilizável ⇒ `profile:{state:'UNAVAILABLE', reason}` (campos vazios).
  - **Website (D6C-3, endurecida na revisão do I1):** o bruto é lido do corpo íntegro e **nunca sai da função**. Sai `website:{state:'DERIVED'|'UNPARSABLE', derived, utm:{level:'COMPLETE'|'PARTIAL'|'NOT_OBSERVED', names}|null, derivation:{rule:'lumos-url-derive-v1', rawSha256, sourceEvidence:{ref,contentSha256,bodySha256}}}`. `derived` = `scheme://host[:porta]/` + só os parâmetros `utm_*` conhecidos com valor não vazio **substituído por `x`**; credenciais, **CAMINHO** (pode carregar token, chave ou `;jsessionid=`), fragmento e demais parâmetros descartados — **desvio deliberado da §9.6, que previa manter o caminho**. `level` conta qualquer `utm_*` com valor (como o motor); `NOT_OBSERVED` **não é ausência comprovada**; em `UNPARSABLE`, `utm` é `null` (não confundir com 'sem UTM'). `rawSha256` = SHA-256 do texto do website **após `trim`**. Sem esquema `http(s)`, malformado ou vazio ⇒ `UNPARSABLE` (`derived:null`).
  - **M-4a estrita:** `informational.reviews = {rating, ratingCount, scoringUse:'EXCLUDED_M4A', reason, source{ref,observedAt,contentSha256}}` — **sempre rotulado como excluído do cálculo**; nenhuma outra parte de `basis` contém nota ou contagem. O I2 não pode ler `informational`.
  - **Integridade adicional (revisão independente):** vínculo relatório↔captura reconferido na 2ª leitura; revisões de relatório contíguas por captura; todas as capturas da auditoria com a **mesma identidade**; legado: relatório **vigente** obrigatório (o superado nunca é promovido), com `source.capture.sha256` igual ao hash conferido do corpo, data de coleta válida e status HTTP lido do texto **verificado**; `generatedAt` só se ISO válido. **Limitações herdadas do 5B:** o sidecar `.sha256` do relatório legado não está no `SHA256SUMS` (quem edita o relatório recalcula o sidecar) e a "confirmação" do legado é afirmação post-hoc — a âncora real é o CID no corpo hasheado; a cauda de revisões/capturas removida é indetectável sem manifesto.
- **Segurança:** o leitor só lê (nenhuma escrita, rede, ambiente ou relógio); o corpo bruto, `request`, `input.originalLink`, cabeçalhos, caminhos de disco e parâmetros de URL **nunca** aparecem na saída; textos de fonte externa passam por `cleanText`/`sanitizeForOutput`.
- **Aceite:** testes com fixtures fictícias e **réplica fictícia do layout legado** (nunca a pasta real); integridade (captura, relatório, site, lacuna, symlink, arquivo ausente/truncado/adulterado ⇒ nada devolvido); proveniência e hashes; website com/sem UTM (completo, parcial, vazio, maiúsculas, fragmento, sem esquema, credenciais, porta, parâmetros desconhecidos, valores sensíveis); varredura de strings na saída (nenhuma URL bruta/parâmetro/caminho/`SENTINELA`); dados ausentes e incompletos sem inferência (`null`, nunca `complete`); contagens 0/999/1000/1001/abreviadas/ausentes só em `informational`; falhas de leitura (`EIO`, `EACCES`, JSON inválido); isolamento (importadores, nada de rede/ambiente/relógio/escrita); API pública e comportamento 5B inalterados; `scoring/` e a D3B idênticos à `v1.0.1`.
### I2 — Mapeador, matriz e política de fatos (**CONCLUÍDO e aprovado em 29/10/2026**; commit local `feat(link-audit): assemble verified Lumos scoring input`)
- **Onde:** `src/lib/link-audit-scoring-runs/{assemble,audit-id-alias,criteria-sources,types,index}.ts`; sem consumidor; importa só o contrato/régua-dados/datas do motor (nunca o que calcula). `assembleScoringInput(basis, records, {now}) → {input|null, inputSha256, finalizable, traceability, blockers, criteriaView, contractIssues}`. **`finalizable` é a única checagem válida**: `input` pode existir com bloqueio `BLOCKING` (ex.: `DECISION_NOT_SUPPORTED`). Decisões fora do contrato aprovado (só juízo C2 e N/A S4/BUSINESS_MODEL) bloqueiam; a URL derivada só vai ao motor se for idêntica à renderização canônica da regra; website exige `maps-website` VERIFIED. Códigos de bloqueio do mapeador diferem dos da §13 (`ENGINE_CONTRACT_REJECTED`, `BASIS_INVALID`, `DECISION_NOT_SUPPORTED`): o I3 traduz.
- **Resultado (29/10/2026):** 1240/1240 testes; `tsc` e build offline limpos; mutação 45/45; revisão independente APROVADO COM RESSALVAS (achados 1–6 e 8–9 tratados). **Validação real, somente leitura, no legado da AUD-001:** leitor `READY` (LEGACY, 3 evidências), os 7 fatos observáveis enviados, nenhum bloqueio, UTM não observada (X5 sem prova), motor `ok`, **22 hp = 11 %**, `INSUFFICIENT`, `index:null`, 4 subcritérios pontuados, 0 `ABSENCE_PROVEN`, 0 N/A derivado. Desvios D1–D4 homologados pelo usuário em 29/10/2026. Pendências para o I3/I4: reler a captura e reconferir `rawSha256`/`deriveWebsite` na finalização; vínculo da decisão C2 com a categoria julgada.
- **Contrato:** `assembleScoringInput(basis, operatorRecords, options) → { input, traceability, blockers[], criteriaView }`, puro; `criteria-sources` = tabela da §10 validada contra `SUBCRITERIA`; `auditIdAlias`.
- **Aceite:** a bateria "mapeador × matriz" (§19.1), propriedade "sem ausência fabricada", **medição de cobertura real** das fixtures (**22/26/34 hp**, independente da contagem de avaliações — M-4a estrita), entrada sempre aceita por `parseScoringInput`; **`ScoringInput` nunca contém `reviews`** e `assemble` nunca lê `informational`; **testes de contagem 0/999/1000/1001/abreviados/ausentes (M-4a)**; nada lido do cliente.
### I3 — Prévia, simulação e identidade (**CONCLUÍDO e aprovado em 29/10/2026 na parte autorizada: serviço de prévia + `GET /api/link-audit/scoring/[auditId]`; commit local `feat(link-audit): add authenticated Lumos scoring preview`**). **Decisões do usuário (30/10/2026), SEM funcionalidade concluída:** `POST …/simulate` (§14.5) **ADIADO para depois do I4** — não implementar agora; reavaliar a necessidade antes do I5; qualquer simulação futura será transitória e nunca poderá ser confundida com decisão confirmada ou resultado definitivo. `GET /operator` (§14.4) **ADIADO para a preparação do I5** — antes de criar a rota, verificar se já existe forma segura de obter a identidade do operador autenticado
- **Implementado:** `src/lib/link-audit-scoring-runs/{preview,blockers,outcome}.ts` e `src/app/api/link-audit/scoring/{shared.ts,[auditId]/route.ts}`. Só GET; só o `auditId` vem do cliente (qualquer parâmetro de consulta ⇒ 400); `requireOperator` antes de validar o id; 20 req/min por operador; respostas privadas, sem cache; nenhuma escrita, nenhum recibo, `definitive:false` sempre.
- **Fluxo:** (1) decisões CONFIRMADAS (`list()` da 6B: `head`, `pending`, `finalizable`) e base verificada (I1); (2) **segunda leitura** das duas coisas: só vale se `head`, pendente, `finalizable`, registros e base (hash canônico) forem idênticos; senão relê (até 3×) e por fim `409 READ_INCONSISTENT`; uma mudança DEPOIS da 2ª leitura é inevitável numa prévia — por isso a resposta carrega o `head` consultado e o I4 reconfere tudo na trava; (3) decisões **retidas** (não entram na entrada, `BLOCKING` com `op-NNNN`): fora do contrato aprovado (`DECISION_NOT_SUPPORTED`), dependentes do site (`DECISION_NEEDS_SITE_SCOPE`), juízo C2 de outra captura (`DECISION_CATEGORY_MISMATCH`); (4) mapeador I2 → motor → `verifyScoreResult` → desfecho (§12.1) e projeção pública (§12.2).
- **C2 e a categoria:** o juízo carrega (no arquivo de decisão, âncorado) o número da captura mais recente existente quando foi tomado (`basis.capture`). Ele só vale se esse número for ≥ ao da captura que fundamenta o perfil hoje (a fonte do perfil já era a mesma então, porque a fonte é o máximo sobre as capturas existentes). Captura utilizável posterior ⇒ juízo retido até ser substituído. Captura HTTP 500 posterior não muda a fonte, não gera fatos e não retira o juízo. **Emenda da revisão independente:** o juízo também é retido (`DECISION_BASIS_UNVERIFIABLE`) se a captura carimbada não existir mais nas evidências atuais ou se a data dela diferir da registrada (restauração/adulteração). Captura de número maior e data anterior à da fonte não é a fonte; o juízo carimbado nela vale para a fonte (a fonte já era a mesma quando o operador decidiu). A interface (I5) precisa mostrar o perfil da captura-fonte (`evidence.profileSource`). **Limite:** o vínculo é à captura, não ao texto da categoria (o registro da 6B não traz a categoria); mesma categoria numa captura nova também exige novo juízo.
- **Erros ligados à decisão por EXPERIMENTO, não por texto:** `attributeFailure` reexecuta o juiz (contrato do mapeador ou motor) sem cada registro (delta debugging/bisseção, custo ~k·log n, rodadas até o juiz aceitar; orçamento de 120 execuções; se estourar devolve CANDIDATOS ⊇ culpados com `ATTRIBUTION_INCOMPLETE`; `NOT_CAUSED_BY_DECISIONS` se a falha persiste sem decisões).
- **Identidade (D2):** o alias nunca localiza dados (todas as leituras usam o `auditId` da rota); falha fechada `409 AUDIT_IDENTITY_MISMATCH` se `auditId` da base ou das decisões diferir do pedido, se o alias não for reproduzível ou se o resultado trouxer outro id/hash de entrada.
- **Contrato da resposta (difere de §14.1 apenas onde a base não tem o dado):** `{definitive:false, auditId, scoringAuditId, auditIdAlias{applied,rule,reason}, state, company{located, profileState, unavailableReason, identityMatchedBy, websiteHost, source}, evidence{integrity, layout, referenceDate, referenceDateSource, profileSource, bases[]}, decisions{head, count, pending{resumo sem autor nem texto}, finalizable, applied[], held[]}, decisionOptions[], criteria[9→35 subcritérios com source/sourceReason/state/stateReason/tier/potential], outcomePreview, result (projeção pública), blockers[], missing[], finalization{allowed, expectedHead, expectedInputSha256, latest:null}}`. Estados: `SEM_EVIDENCIA · DECISAO_PENDENTE · ENTRADA_RECUSADA · CALCULADO_NAO_FINALIZAVEL · CALCULADO_FINALIZAVEL` (`ENTRADA_RECUSADA` = nenhuma entrada/resultado, com bloqueio `BLOCKING`). Erros: 400 · 401/403 · 404 · 409 (`EVIDENCE_INTEGRITY`, `DECISIONS_*`, `ANCHOR_*`, `READ_INCONSISTENT`, `AUDIT_IDENTITY_MISMATCH`; sem dados) · 429 · 503 (configuração).
- **Projeção pública por lista de campos permitidos (revisão independente):** nada do resultado do motor é repassado por omissão. A justificativa livre do operador (N/A) nunca sai (texto fixo por código em `reason`, `naRegistry` e limitações) e, em INCONCLUSIVO, o texto "(X de Y pontos)" do motor é removido junto com todo ponto obtido. **Exceção documentada ao determinismo:** a resposta não depende do relógio do servidor, salvo se ele estiver ANTES da evidência mais recente (`EVIDENCE_DATED_IN_FUTURE`, `ENTRADA_RECUSADA`, falha fechada).
- **Cobertura insuficiente não é erro:** `INCONCLUSIVO` (`index:null`) é 200 e **finalizável**; bloqueio, decisão pendente e falha de integridade são estados distintos. `finalization.allowed` exige resultado, nenhum `BLOCKING`, `finalizable` da 6B e nenhuma pendente.
- **Contrato:** §14.1, §14.4, §14.5; `decisionOptions`; bloqueios traduzidos; `outcomePreview`; projeção pública.
- **Aceite:** matriz de bloqueios; **simular concorda com a prévia** (teste que compara `effect` com recálculo); nenhuma resposta `definitive:true`; INCONCLUSIVO sem termos proibidos; limites de taxa; sem gravação em disco.
### I4 — Armazenamento e finalização (**IMPLEMENTADO em 30/10/2026, SEM commit (decisão do usuário); aguarda aprovação para o I5**)
- **Implementado:** `src/lib/link-audit-scoring-runs/{results-types,results-store,results-verify,results}.ts`; refatoração de `preview.ts` (expõe `evaluate`/`fingerprintNow`) e extensão `verifyWebsiteDerivation` do leitor (I1); rotas `POST …/finalize`, `GET …/results`, `GET …/results/[seq]` e `shared.ts` (`withResults`). `src/lib/link-audit/scoring/` idêntico à `v1.0.1` e `src/lib/link-audit-decisions/` intocado.
- **Resultado (revisão final, 30/10/2026):** suíte completa isolada, `tsc` e build offline limpos (números no commit); **mutação: 66 mutantes, 60 mortos, 6 sobreviventes** — F07 (equivalente: dominada por `derived !== emitted`), V04 e V13 (redundantes com `verifyScoreResult`), V12 (a 1ª classificação "redundante" estava ERRADA: a revisão mostrou que uma entrada refeita com outra `referenceDate` só é pega por essa checagem; teste novo cobre a lacuna), F21 (chave do memo mais estreita que `contentSha256` = só desempenho; teste novo com cache primado cobre chave larga) e F22 (teto do memo, não determinístico; ~64 B por registro distinto). *Correção de registro: o relatório anterior dizia "61 mortos, 5 sobreviventes"; o correto é 60/6.* Duas revisões independentes: ambas APROVADO COM RESSALVAS, sem BLOCKER/MAJOR; ressalvas corrigidas: pendente expõe `decisionsHead`/`inputSha256`/`isMine` (sem e-mail), reenvio no limite de 500 continua 200, `stale` × `decisionsChanged` × `stateChangedAfterFinalization` unificados (incluem decisão pendente), conclusão da pendente reconfere as evidências, evidência removida (`ausente:`) é recusada, releitura pós-recibo protegida.
- **Contrato:** §12.3, §14.2, §14.3, §15; `outcome` derivado do motor; registro `PONTUADO|INCONCLUSIVO`; recibos; `DESATUALIZADO`.
- **Aceite:** **persiste `INCONCLUSIVO`** quando as condições de integridade estão satisfeitas e **recusa** com pendente/`finalizable:false`/integridade falha/`ok:false`; registra hashes, versão da régua e `head`; bateria adversarial completa (queda após cada operação, truncamento, restauração, reenvio, concorrência, fuzz) e **mutação ≥ 25 mutantes mortos**; nenhum dado inventado no registro.
### I5 — Cliente da UI (**CONCLUÍDO e aprovado em 30/10/2026; commit local `feat(link-audit): add Lumos audit operator workspace`; I6 autorizado em seguida**)
- **Implementado:** `src/app/auditoria-por-link/[auditId]/page.tsx` (404 para id inválido) e `src/components/link-audit/audit-page/` (`types`, `labels`, `api` — cliente HTTP, `state` — reducer e elegibilidade, `status` — estado/obsolescência, `controller` — fluxos com API injetada, `use-audit-page`, painéis e `audit-detail-screen`); link "Abrir auditoria Lumos" no detalhe da coleta. Nenhuma rota nova (`GET /operator` e `simulate` seguem ADIADOS: a identidade não é necessária — a API devolve `isMine` — e o servidor impõe as regras).
- **Regras de interface:** finalizar só com `finalization.allowed:true` na prévia exibida e sem pendências/bloqueios; o pedido (`expectedHead`, `expectedInputSha256`) é capturado da prévia EXIBIDA na abertura da confirmação, com aceite explícito; 409 de mudança invalida a prévia, recarrega e não reaproveita a confirmação; `RESULT_ANCHOR_PENDING` nunca é sucesso (só reenvia o MESMO pedido); depois de 201/200 o resultado é relido e verificado antes de se dizer "verificado"; `stale`, `decisionsChanged` e `stateChangedAfterFinalization` são exibidos separadamente e o último registro só é "coerente com o estado atual" quando os dois primeiros são conhecidos e falsos; o navegador não calcula índice nem pontos (só converte meio-ponto em ponto para exibição); texto sempre escapado; sem armazenamento do navegador nem polling.
- **Validação (30/10/2026):** testes do cliente HTTP, do estado, do controlador, da renderização, da segurança estática, da validação aninhada (mutações), do **contrato com os serviços reais em todos os estados alcançáveis** e da integração do cliente contra as ROTAS REAIS; build offline; navegador headless (Chromium) em localhost isolado com sessão fictícia: **40/41** — a única falha são os 3 botões do menu compartilhado (escopo do I6). Duas revisões independentes: a 1ª achou 1 MAJOR (decisão na própria tela deixava o resultado "coerente"); a de correções achou **1 BLOCKER real (B1: `status:null` de critério, devolvido pelo servidor em SEM_EVIDENCIA/ENTRADA_RECUSADA, era recusado pelo validador novo — regressão minha, hoje coberta pelo teste de contrato) e 3 MAJOR (guarda do 429 por todas as rotas de envio, restauração de foco depois de gravar, trilha lateral sob a faixa fixa)**, todos corrigidos.
- **Validação das respostas (falha fechada):** `validators.ts` confere formas aninhadas, enums que a lógica usa (`state`, `outcome`, `level`, `severity`, `status` de decisão), identidade da auditoria pedida e coerências do contrato (finalizável ⇒ estado finalizável, sem bloqueio, sem pendência, sem decisão retida, integridade OK e mesmo head; inconclusivo sem índice e sem confiança; pontuado com índice de duas casas e nível; resultados 1..n, só o último "mais recente", `head` = último, pendente = n+1; `head` da finalização = hash do registro). Não recalcula metodologia. Enumerações só de exibição (ex.: tipo de opção de decisão) não derrubam a tela.
- **HTTP 429 na finalização:** o limitador responde ANTES de processar, então nada foi gravado (não é confirmado nem pendência de recibo). `Retry-After` só é aceito como inteiro (1 s a 1 h) ou data HTTP contra o `Date` do servidor; ausente/inválido ⇒ 60 s estimados e dito na tela. Fase própria `rate_limited` com o pedido original preservado; nenhum envio (confirmar, reenviar, concluir pendente) antes do prazo — guarda única em `submitFinalize`; nada é reenviado automaticamente; numa recuperação a lista de resultados é relida.
- **Foco:** o formulário de decisão/revogação leva o foco ao primeiro campo; Escape fecha (não durante o envio nem em composição); ao fechar, o foco volta a quem abriu (espera o botão reabilitar; fallback: título da seção); o desfecho da finalização recebe o foco; a faixa de estado só é fixa a partir de `md` e há margem de rolagem para ela não cobrir controles (70 Tab no navegador: 0 cobertos).
- **Contagem de testes (reconciliação):** I3 1295 → I4 1441 (1ª rodada) → 1453 → **1459 (commit do I4)** → I5 1527 → 1532 → 1550 → **1563** (com as correções finais). O relatório do I4 citou 1441 como baseline por ser a 1ª rodada; o commit já tinha 1459 (+18 testes da revisão final). Sem erro de teste: 1459 + 73 = 1532."
- **Limitações registradas (I5):** (1) os 3 botões do menu compartilhado (alvo < 40 px no celular) ficam para o I6; (2) validadores checam formas e coerências, não a metodologia (de propósito); (3) contraste dos tokens não medido no I5 (medição no I6); (4) o `<dialog>` nativo foi exercitado no Chromium headless, não em leitores de tela reais; (5) a faixa de estado fixa (md+) pode ficar alta com muitas linhas.
- **Contrato:** reducers, 3 `*-api-client.ts` (tipos locais), rótulos; rota `/auditoria-por-link/[auditId]`; `ScoredResultPanel` × `InconclusiveRecordPanel`.
- **Aceite:** testes de estado e de renderização por estado de §8; painel inconclusivo **sem** os termos proibidos; `pending` escapado; mobile; acessibilidade; isolamento (cliente sem imports de servidor).
### I6 — Integração e textos (**CONCLUÍDO — commit `feat(link-audit): integrate Lumos audit navigation`**)
- **Implementado:** link contextual "Abrir auditoria Lumos" em cada cartão da listagem (só um link: a lista NÃO consulta prévia, decisões nem resultados); retorno do workspace à listagem com `?auditId=<id>` (a empresa volta selecionada); menu com alvos de 44 px; textos do espaço antigo reescritos sem inventar dados; contraste AA corrigido onde medido; faixa de estado do workspace fixa só a partir de `md`. Nenhum endpoint, índice ou persistência novos; `GET /operator` e `POST /simulate` continuam adiados.
- **Regra do endereço (correção final):** um `?auditId=` presente que NÃO se atende — válido porém fora da lista carregada (a lista traz até 50 empresas), malformado, vazio ou repetido — mostra um **aviso explícito** (`role="alert"`) e **não seleciona nenhuma empresa nem consulta detalhe**; a identidade pedida permanece no endereço e o aviso oferece abrir a auditoria Lumos pedida (id codificado) ou escolher na lista. O valor malformado nunca é ecoado. Sem `?auditId=`, vale a primeira empresa (comportamento da 5B). A decisão é pura e testável (`resolveAuditRequest`, `planFromLocation`).
- **Endereço = empresa exibida:** a escolha do operador faz `history.replaceState` (preserva `history.state`, `#fragmento` e demais parâmetros; não cria entrada de histórico); `popstate` reconcilia a exibição com o endereço; "dispensar" remove o parâmetro e não volta a escolher a primeira por conta própria. O item **ativo** do menu é um link de documento (`<a>`): pelo roteador do Next o endereço perdia o `?auditId=` sem a tela mudar (e o F5 abria outra empresa; reproduzido no navegador). O detalhe entregue com `auditId` diferente do escolhido é descartado (falha fechada).
- **Foco, menu e reflow:** escolha do operador foca o título do detalhe; volta pelo endereço foca o cartão só se nada estiver focado (não rouba o foco de quem digita) e a rolagem respeita `prefers-reduced-motion`; menu móvel com `aria-expanded`, `invisible` quando fechado, foco em "Fechar menu" ao abrir e de volta em "Abrir menu" ao fechar; `<main>` na casca; `<nav>` com nome; títulos sem salto (`h3`); anel de foco ≥ /70 na Auditoria por Link; linhas rótulo/valor quebram (sem rolagem horizontal a 320 px).
- **Contraste (WCAG 2.2 AA; medido sobre os tokens reais e no navegador):** achados e corrigidos na Auditoria por Link: branco sobre `#247BFF` = 3,92:1 → botão `#1D68DB` (5,18:1, hover `#1A5FCF`); placeholder `muted/60` = 3,29:1 → `muted/80`; borda de campo `white/10` = 1,32:1 → `white/40`; anel de foco `/60` = 2,96:1 → `/70` (3,53:1; campos mantêm a borda de foco opaca). **Não corrigido (fora da Auditoria por Link):** 4 botões do dashboard/login ainda com `#247BFF` e texto branco, 4 usos de `muted/60` e 2 anéis `/40`/`/60` em `top-filters` (relatório do I7).
- **Validação (30–31/10/2026):** 1590 testes, `tsc` e build offline limpos; navegador (Chromium headless, localhost isolado, sessão assinada por segredo ALEATÓRIO por execução, dados fictícios, APIs reais) com os roteiros **reproduzíveis em `scripts/browser/`**: I5 41/41 e I6 106/106 verificações aprovadas sobre a versão final do código. Duas revisões independentes (APROVADO COM RESSALVAS, sem BLOCKER; os MAJOR foram corrigidos e a segunda revisão cobriu o que mudou depois da primeira).
- **Não executado:** leitor de tela real (NVDA/JAWS/VoiceOver), navegadores além do Chromium headless, dispositivo móvel físico, `axe-core` (indisponível offline; usado só um verificador próprio e reduzido). Acessibilidade COMPLETA não é declarada.
### I7 — Validação final
- **Contrato:** validação no localhost com **sessão assinada por segredo fictício** (gerada fora da árvore) e navegador headless (desktop e mobile); revisão adversarial independente; documentação (ADR/Emenda, NOTES, E0, onda6a corrigida); `PLANO-DE-VOLUME-DE-RESULTADOS.md`.
- **Aceite:** critérios de §19.2; **commit só com autorização**.
Paralelização possível: I5 pode começar com os DTOs de §14 fixados, depois do I3.

---

## 23.1 Emenda 2 — remediação da revisão adversarial (prova de ORIGEM) — implementada na árvore, SEM commit
Origem: `onda6c-revisao-adversarial-seguranca.md` (commit `b1c7412`; parecer do revisor: **BLOQUEADO — CORREÇÕES OBRIGATÓRIAS**). O que muda na especificação (as seções acima descrevem o desenho original):
- **§14 (DTOs) e §22.2 risco 12:** a pendente passa a trazer `origin` (`PROVEN`|`UNPROVEN`|`UNVERIFIABLE`), `originDetail`, `isMine` (só com origem comprovada **e** autor = sessão) e, para resultados, `outcome|level|coveragePercent|appliedDecisionCount|matchesCurrent` (nulos se a origem não está comprovada). `recordedBy`, `record` e `reason` das decisões só saem com origem comprovada e, o conteúdo, só para o autor.
- **Protocolo de conclusão (resultado):** origem comprovada → o registro se explica (motor reexecutado) → as evidências citadas existem com os mesmos hashes → o histórico de decisões não regrediu → recibo. Reenvio de resultado já confirmado também exige que o registro se explique.
- **Escritas:** exigem a chave de origem (`GMN_LINK_AUDIT_ORIGIN_KEY`); sem ela 503 `ORIGIN_KEY_NOT_CONFIGURED` e nada é gravado. Novos códigos: `PENDING_ORIGIN_UNPROVEN` (6B) e `RESULT_PENDING_ORIGIN_UNPROVEN` (6C), ambos 409.
- **Interface (§17):** a tela **nunca** monta reenvio automático a partir de dados do servidor; só oferece concluir quando `origin === 'PROVEN' && isMine`, mostra o que será concluído, diz que "gravação interrompida" e "recibo removido" são indistinguíveis, e exige caixa de confirmação marcada. Sem origem comprovada: sem botão, sem conteúdo, sem autor.
- **Leitura de arquivos (MINOR-1):** `nodeFsOps.readFile` abre com `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` e confere tipo/tamanho no descritor (FIFO e afins são recusados na hora).
- **Fora do escopo desta emenda (declarado):** a distinção "recibo removido × gravação interrompida" (MINOR-2) exige testemunha externa do `head`; escrita nas duas pastas continua sem detecção; autenticar recibos não foi adotado. Ver `onda6c-adr-prova-de-origem.md` §6 e `onda6c-modelo-de-ameacas-recuperacao.md` §6.
- **Aceite da emenda:** nova revisão adversarial **independente** (agente separado) e autorização expressa do responsável para commitar. **A Onda 6C permanece NÃO encerrada.**

## 23.2 Emenda 3 — decisões de 01/11/2026 após a 2ª revisão independente (implementada na árvore, SEM commit)
Origem: `onda6c-revisao-adversarial-2.md` (APROVADO COM RESSALVAS) e as decisões do responsável. O que muda na especificação:
- **Evidências falsificadas (R2-MINOR-1):** a pasta de evidências é **raiz NÃO confiável**; integridade (SHA-256) ≠ autenticidade. Nova condição de finalização: **coleta autêntica** (manifesto assinado fora da pasta de evidências; ADR 6C-03). O padrão é **fechado**: sem prova configurada, `EVIDENCE_PROVENANCE_UNPROVEN` bloqueia a finalização e a conclusão de pendente; a **prévia continua consultável** e rotulada (`evidence.provenance`). O **lado produtor** da prova aguarda aprovação do plano (ADR 6C-03 §7).
- **Revogação restaurada por remoção de recibo (RV2-A3b):** a decisão alvo de uma operação pendente (revogação ou substituição) fica **EM DÚVIDA** (`AMBIGUOUS`) e **não** é aplicada pelo motor nem pela prévia; `ambiguousDecisionIds` e `decisionsWitness` (testemunha do `decisionsHead`) são expostos a **todos** os operadores, sem conteúdo privado.
- **Chaves e rotação (R2-MINOR-4):** formato estrito (`<id>:<64 hex>`), id público independente do segredo, rotação **planejada** (aposentada com validade) distinta da rotação por **comprometimento** (id revogado, material removido); a variável `…_PREVIOUS` foi **removida**. Runbook: `onda6c-runbook-chaves.md`.
- **Gravação sem autenticador:** serviço e primitiva **recusam** (`ORIGIN_KEY_NOT_CONFIGURED`).
- **Documentação:** ADR 6C-02 reescrito (momentos de autenticação; confirmados **não** reautenticados na leitura; testemunhas; detecção de remoção; limites de um diretório comprometido); modelo de ameaças corrigido.
- **Fora da 6C, registrado:** `src/lib/pdf/serve.ts` com FIFO (corrigir antes de expor o download de PDF).
- **A Onda 6C permanece NÃO encerrada.**

## 23.3 Emenda 4 — fechamento de segurança (01/11/2026, após a 3ª revisão independente)
- **Testemunha do histórico (R3-MINOR-2):** `DecisionServiceOptions.knownHeads` (injetado pelas rotas; `createResultsKnownHeads` sobre os resultados selados). `ListPayload.witness`; estados `NOT_CONFIGURED|CONSISTENT|RECEIPT_LOST_WITNESSED|HISTORY_REGRESSED|HISTORY_DIVERGES|UNAVAILABLE`; os três últimos ⇒ integridade NÃO resolvida (falha fechada). Novo código `DECISIONS_HISTORY_UNRESOLVED` (409) e bloqueio `DECISIONS_HISTORY_UNRESOLVED` na prévia. **Substitui** o `decisionsWitness` dos resultados (removido). **Limite BLOQUEADOR** declarado (sem resultado selado posterior).
- **Emenda 5 — R4-MINOR-1 e INFO-1 (01/11/2026, sem commit):** (a) `knownHeads` passa a ser **obrigatório** em `DecisionServiceOptions` (`WitnessSource = KnownHeadsProvider | WITNESS_NOT_REQUIRED`; a dispensa só existe em testes da 6B isolada, com teste estático); as duas composições de rotas **sempre** montam a fonte (sem as pastas de resultados: `NOT_CONFIGURED`). (b) `KnownHeadsRead` ganhou `reason` (`NOT_CONFIGURED|STORAGE_UNAVAILABLE|UNTRUSTED`) e `unverifiedHeads` (indícios de resultado **pendente de origem não comprovada**: nunca testemunha; se contradizem o histórico ⇒ `UNTRUSTED`). (c) `WitnessStatus` = `NOT_REQUIRED|UNWITNESSED|CONSISTENT|RECEIPT_LOST_WITNESSED|HISTORY_REGRESSED|HISTORY_DIVERGES|UNTRUSTED|UNAVAILABLE|NOT_CONFIGURED`; **não resolvidos** (falha fechada): `HISTORY_REGRESSED`, `HISTORY_DIVERGES`, `UNTRUSTED`, `UNAVAILABLE`, `NOT_CONFIGURED` (**este era o fail-open do INFO-1**). (d) `ListPayload.witness`/`payload.decisions.witness` ganham `coveredSeq` e `unwitnessedAffecting` (cobertura declarada; `UNWITNESSED` não é garantia). (e) `createResultsKnownHeads` exige `otherDirs` (obrigatório no tipo; as rotas passam decisões, recibos das decisões e evidências) e trata pastas iguais/aninhadas (inclusive por link simbólico) como `NOT_CONFIGURED`; uma **sonda `lstat`** das raízes e das pastas da auditoria separa "não consigo ler" (raiz ausente ou erro de E/S ⇒ `STORAGE_UNAVAILABLE`) de "não é um diretório comum" (arquivo/link ⇒ `NOT_CONFIGURED`); erro de leitura/listagem do SO nos resultados **ou nos recibos**, e exceção desconhecida, ⇒ `STORAGE_UNAVAILABLE` (5ª revisão, I-1). Rótulo é só diagnóstico: todos falham fechado. (f) Bloqueio da prévia `DECISIONS_HISTORY_UNRESOLVED` carrega o estado em `reasonCode`. (g) Referência `protocol-conformance-v2.json` regenerada (só o campo `witness` mudou; SHA repinado). (h) Roteiro I7: B17 (rotação + dependência ausente). **Limite BLOQUEADOR mantido** (todos os vestígios removidos): especificação do livro de cabeças em `onda6c-especificacao-livro-de-cabecas.md`.
- **Prova de coleta (R3-MINOR-1/3):** verificação bidirecional (manifesto ⊆ base ⇒ `EVIDENCE_MISSING`) e artefato `legacy-status:cNNNN`; `evidence.provenance.missingRefs`.
- **Resultados pendentes (R3-MINOR-5):** `receipt:'MISSING'` e `blocksFinalization:true` no DTO, aviso a todos os perfis.
- **Interface (R3-MINOR-4):** estados distintos por texto (integridade local verificada SHA-256 × origem da coleta autenticada/NÃO comprovada × adulterada/incompleta); 5B deixa claro que não avalia a origem.
- **Chaves:** teto de 93 dias para a chave aposentada; relógio inválido ⇒ vencida.
- **P1:** direção aprovada, contrato em `onda6c-contrato-p1-atestacao.md`, **nada implementado**. **A Onda 6C permanece NÃO encerrada.**

## 24. Critérios para autorizar o início do I0 — situação em 29/10/2026 (I0 concluído; ver 2ª rodada em §2.1)
| # | Critério | Situação |
|---|---|---|
| 1 | Aprovação explícita da especificação pelo usuário | **Atendido** (aprovação condicionada, 29/10/2026; M-4a corrigida nesta v2.1) |
| 2 | Homologação de M-1…M-12, M-4a e M-5, e da lista de decisões oferecidas (§11.2) | **Atendido** (M-4a ajustada; M-5 aprovada em D6C-3; D6C-4 aprovada) |
| 3 | Escolha do Plano A ou B para o I0 | **Atendido: Plano A** |
| 4 | Autorização para criar `feat/onda-6c-integracao` a partir de `d7b0eec` | **Atendido** (criada; sem reset/clean/checkout forçado; documento preservado) |
| 5 | Linha de base verde no ambiente isolado | **Atendido:** 1041/1041 na nova branch antes de qualquer alteração; `scoring/` idêntico à `v1.0.1` (0 linhas de diferença); hashes dos fontes da 6B registrados |
| 6 | Ambiente de desenvolvimento isolado (sem `.env*`, sem credenciais reais) | **Atendido** (`scripts/run-isolated.sh`: rede externa e porta 6379 do host inalcançáveis; `env -i`) |
| 7 | Escopo do I0 não altera protocolos da 6B; ajustes de isolamento limitados aos de §20 | **Atendido** como condição de aceite (§23, I0) |
| 8 | Reconhecimento de que a coleta atual gera registros `INCONCLUSIVO` e de que a D5 não está autorizada | **Atendido** (D6C-6) |
| 9 | Nenhuma operação em produção, VPS, migration ou chamada externa prevista | **Atendido** |

**Autorizado na 1ª rodada:** somente o **I0** (concluído). **Autorizado na 2ª rodada:** commit do I0, commit desta spec e o **I1**. **Não autorizados:** I2…I7, D5, commit do I1. O I1 termina com um relatório técnico e **para**, aguardando a revisão do usuário (parecer APROVADO/BLOQUEADO para o I2).

## 25. Fora do escopo e continuidade
Onda 7 (PDF) consumirá `sNNNN.json` **verificado** na projeção pública (nunca recalcula; `INCONCLUSIVO` vira "registro técnico"). A D5 (§21), os parsers, o hash de páginas do site, detectores validados para S5/X4/V5, `site:` verificável, concorrentes e autoridade — cada um exige autorização própria. **Em execução: apenas o I1. Aguardando a revisão do relatório do I1 antes de qualquer outro incremento.**
