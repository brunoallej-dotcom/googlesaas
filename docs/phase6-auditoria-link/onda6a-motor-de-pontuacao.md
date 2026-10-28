# Fase 6 · Onda 6A — Motor de pontuação da metodologia Lumos reconstruída

Status: implementada em 22/10/2026. Régua `regua-d3b-r2` homologada (D3B-1 a D3B-16, com as condições da D3B §0.1). **Módulo puro e ainda não conectado** a interface, armazenamento, PDF, coleta ou qualquer rota. **Nenhuma chamada a Serper/Google/sites, nenhum crédito, nenhuma IA, nenhuma migration; `.env.local`, Supabase, Redis, Worker, prospecção, Juiz e a captura da TUVAPLAST não foram tocados.**

> **Esta é uma metodologia reconstruída pelo projeto GMN** (`methodologyVersion = lumos-reconstruida-v1`, `scoreModelVersion = regua-d3b-r2`). Não é o agente original recuperado e não garante comportamento idêntico a ele. O resultado do motor sempre traz o aviso "O Índice Lumos não é uma nota oficial do Google" e o aviso de metodologia reconstruída.

## 1. Reconciliação prévia (feita antes de codificar)
A D3B foi atualizada com as decisões finais, sem contradição essencial pendente:
- **D3B-8 (X5):** UTM ausente comprovado na URL do website do perfil = 0, *exclusivamente* porque o subcritério avalia o uso de UTM; nunca se conclui "sem rastreamento". URL não verificada = Não verificado.
- **D3B-15:** só conta como "critério avaliado" o que tem **≥ 3 pontos possíveis efetivamente avaliados** (os obtidos podem ser 0), para o requisito de 3 critérios incluindo NAP ou Avaliações.
- **Escopo de site:** `SITEMAP_COMPLETE` **não basta sozinho**; ausência/faixa intermediária só com escopo documentado (`SITEMAP_COMPLETE` ou `DOCUMENTED_FULL_REVIEW`) **mais** atestado do operador; senão Não verificado.
- **PDFs históricos (correção):** a afirmação "todos os outros PDFs tinham cobertura ≥ 52 %" estava errada. O relatório da Estética Daniele Cardoso de 21/10/2026 tem **cobertura de 11 %** (base 7/11, índice 64 "provisório"); a VRA tem 26 %. A regra atual (mínimo de 40 %, 3 critérios com ≥ 3 pontos, NAP ou Avaliações) é uma escolha conservadora da versão reconstruída (D3B §6.2, §8.1).
- **Confirmação humana:** contrato aprovado; armazenamento definitivo só na Onda 6B.

## 2. Arquivos
**Criados** — `src/lib/link-audit/scoring/` (26 arquivos): `versions.ts`, `math.ts`, `dates.ts`, `types.ts`, `ruler.ts`, `input.ts`, `tiers.ts`, `context.ts`, `results.ts`, `nap-compare.ts`, `eval-common.ts`, `eval-profile.ts`, `eval-reputation.ts`, `eval-visuals-posts.ts`, `eval-site.ts`, `eval-conversion.ts`, `eval-authority.ts`, `na.ts`, `aggregate.ts`, `publication.ts`, `confidence.ts`, `report-text.ts`, `fingerprint.ts`, `integrity.ts`, `engine.ts`, `index.ts`.
Testes — `tests/link-audit-scoring-{ruler,subcriteria,engine,publication,isolation}.test.ts` (91 testes) e `tests/helpers/link-audit-scoring-fixtures.ts` (fixtures fictícias).
**Modificados** — `package.json` (somente a lista de arquivos do script `test`); `tests/link-audit-isolation.test.ts` (lista de arquivos do módulo e o antigo teste "sem pontuação (D3 pendente)", que agora permite pontuação **somente** em `scoring/` e proíbe `Math.round`/`toFixed`/`parseFloat` ali; as demais garantias de isolamento foram mantidas); documentação (`D3B`, este arquivo, `E0` §24, `NOTES.md`).
**Não modificados** — `methodology.ts`, `src/agents`, Juiz, prospecção, rotas, componentes, workers, filas, `supabase/`, `.env.local` e a captura da TUVAPLAST (conferidos por hash).

## 3. Como o motor funciona
`scoreAudit(raw, { scoreModelVersion? })` — nunca lança; devolve `{ ok: true, result }` ou `{ ok: false, issues }`.
1. **Entrada = fatos e evidências, nunca pontos.** O schema (`zod`, `.strict()`) recusa qualquer campo de pontos/índice/cobertura/classificação/confiança/resultado em qualquer profundidade (`findClientProvidedScoreKeys`) e chaves desconhecidas. Validação cruzada: ids únicos, evidências citadas existem, datas coerentes e não posteriores ao snapshot, escopo de site consistente, registros do operador válidos (e-mail, justificativa ≥ 20 caracteres, sem duplicidade, causa de N/A não contrariada pelos fatos).
2. **Normalização** independente da ordem dos arrays (ordem estável) e **hash da entrada** (`inputSha256`, JSON canônico).
3. **Contexto de evidências** (`context.ts`): cada fato cita evidências que precisam ser **VERIFICADAS**, de **origem permitida** para o subcritério (fonte externa nunca comprova atributo nativo), **não históricas** (relatório em PDF não fundamenta pontos) e com **≤ 180 dias** em relação ao snapshot. Captura mais recente prevalece; mesma data com valores distintos = **conflito aberto** (campo vira Não verificado e entra na confiança).
4. **Não aplicável** (`na.ts`): lista fechada. Causas provadas pelos fatos (0 avaliações, website vazio, nenhuma resposta) são **derivadas e registradas pelo próprio motor**; as demais (`FEATURE_UNAVAILABLE`, `BUSINESS_MODEL`, `NO_ADDITIONAL_NEEDED`) exigem registro do operador cuja causa **não pode ser contrariada** pelos fatos (senão a entrada é recusada).
5. **35 avaliadores** (`eval-*.ts`), um por subcritério, usando **faixas por intervalo** (`tiers.ts`): um valor conhecido só como [lo, hi] (lista truncada, texto de data relativa, escopo de site limitado) pontua apenas se os dois extremos caem na **mesma** faixa; senão Não verificado. É a regra do limite inferior: com ∞ como limite superior, só a faixa máxima se comprova.
6. **Agregação** (`aggregate.ts`) em **meios-pontos inteiros**: obtidos, avaliados, N/A, amostra insuficiente e Não verificado particionam exatamente o peso de cada critério; cobertura = Σ avaliados ÷ 100; cobertura dos elegíveis à parte; índice = `obtidos × 100 ÷ avaliados` com **arredondamento meio-para-cima por divisão inteira** (`⌊(2n + d) / 2d⌋`), fração exata reduzida e duas casas decimais por inteiros; classes sobre o **inteiro exibido**.
7. **Publicação** (`publication.ts`): sem dados ou cobertura < 40 % ⇒ índice indisponível; 40–64 % ⇒ provisório; ≥ 65 % ⇒ publicável (sempre com cobertura, confiança e limitações); além disso, 3 critérios com ≥ 3 pontos avaliados incluindo NAP ou Avaliações e integridade.
8. **Confiança** (`confidence.ts`): o **menor** de seis fatores — cobertura, amplitude, confiabilidade (evidência primária), atualidade, conflitos e peso N/A —, cada um com valor, limiar exato (comparação por inteiros) e justificativa de modelo fixo, com os subcritérios/registros que a sustentam (`refs`) e os fatores limitantes.
9. **Integridade** (`integrity.ts`): invariantes `0 ≤ obtidos ≤ avaliados ≤ peso`, partição de estados, rastreabilidade (todo ponto cita evidência ou registro do operador), recálculo de critérios, totais, publicação, índice, confiança e registro de N/A. Qualquer falha ⇒ `ok: false`.
10. **Resultado**: `resultSha256`, objeto **congelado profundamente** e registrado em um `WeakSet` (`isEngineResult`): um JSON clonado ou forjado não é um resultado do motor. `verifyScoreResult(resultRaw, inputRaw)` aceita um resultado de fora **somente** se o recálculo com a mesma versão e as mesmas evidências der exatamente o mesmo conteúdo.

### Estados do subcritério
`SCORED` (faixa atingida, inclusive a faixa 0) · `ABSENCE_PROVEN` (zero comprovado por leitura suficiente) · `NOT_VERIFIED` (fora do denominador; **nunca zero**) · `NOT_APPLICABLE` (fora do denominador; N/A é neutro: cobertura e índice idênticos aos de Não verificado) · `SAMPLE_INSUFFICIENT` (dado exibido, mas sem ponto: R1 com 1–4 avaliações; L1/L2 com < 3 concorrentes elegíveis). Cada **critério** tem status próprio (`EVALUATED`, `PARTIAL`, `NOT_VERIFIED` — exibir "N/V", nunca 0/… —, `NOT_APPLICABLE`).

### Contrato da confirmação humana (sem armazenamento ainda)
Registros tipados do operador: `JUDGEMENT` (C2, C3, P3), `NOT_APPLICABLE`, `SITE_SCOPE_ATTESTATION` (S5, V5, X4), `IMAGES_CONFIRMATION` (V5), `OBSERVATION_CONFIRMATION` (S5, X4) e `NAME_EQUIVALENCE` (N5), todos com autor, data, justificativa ≥ 20 caracteres e anexo opcional com hash. Na 6A eles são **entradas** validadas; persistir é a Onda 6B. Nenhum ponto vem de IA: sem o registro, o subcritério qualitativo fica Não verificado.

## 4. Versionamento e reprodutibilidade
- `methodologyVersion = lumos-reconstruida-v1` e `scoreModelVersion = regua-d3b-r2` são campos **separados** do resultado, junto com `rulerFingerprint` (SHA-256 canônico de pesos, faixas, regras e causas de N/A) e `inputSha256`.
- `SCORE_MODELS` (congelado) registra os modelos. **Uma revisão futura da régua adiciona um modelo novo com nova versão; o antigo permanece** para reproduzir resultados históricos — nunca se edita um modelo publicado.
- Dois guardas contra mudança silenciosa: a impressão digital da régua está **fixada em teste** e há **hashes dourados** de dois resultados completos. Se a lógica ou os números mudarem sem nova `scoreModelVersion`, os testes falham.

## 5. Exemplos reproduzíveis
Comando: `node --require ./tests/register-typescript.cjs --test tests/link-audit-scoring-*.test.ts` (91 testes). Saídas do motor sobre as fixtures fictícias (meios-pontos obtidos/avaliados):
| Cenário | O/E | Cobertura | Estado | Índice |
|---|---|---|---|---|
| Perfil completo fictício (todos os subcritérios no máximo) | 200/200 | 100 % | publicável, confiança Alta | 100 (100.00) · Referência local |
| Nota 4,49 (R1 = 4 pontos) e avaliação mais recente há 91 dias (R3 = 2 pontos) | 184/200 | 100 % | publicável | 92 (92.00) |
| Perfil com 3 avaliações, nota 4,7 (R1 e L1: amostra insuficiente; nota continua exibida) | 150/166 | 83 % | publicável, confiança Média | 90 (90.36) |
| Fotos citadas só do site (V2 não pontua) | 194/194 | 97 % | publicável | 100 |
| Sitemap sem atestado e 0 ofertas (S5) | 194/194 | 97 % | S5 = Não verificado (`SITE_SCOPE_LIMITED`), nunca zero | 100 |
Aritmética do índice (`computeIndex`): 54,5/65 → **84** (83.85, fração 1090/13, Forte) · 74,5/100 → **75** (Forte) · 50,5/85 → **59** (Fraco) · 42/57 → **74** (Em desenvolvimento) · 0/40 → **0** (Crítico, índice zero válido). Cobertura exata em 39 % (indisponível), 40 %, 64 % (provisório), 65 %, 89 %, 90 % (publicável) por combinação de fatos. TUVAPLAST (captura preservada, somente leitura): 28–30 pontos avaliáveis ⇒ **índice indisponível**, nenhuma nota. X5 sem UTM: ausência comprovada (0) com a ressalva fixa "não comprova ausência de rastreamento em geral".

## 6. Testes e verificações
- Novos: **91** (régua e fronteiras de todas as faixas com oráculo independente; **todos os 35 subcritérios** em todos os estados; motor; publicação e confiança; isolamento). Total do projeto: **863/863**.
- `npm run typecheck` e `npm run build`: sem erros. Suíte completa com captura de sockets/DNS/`fetch`: **0 tentativas externas**.
- Hashes (SHA-256) de `src`, `tests`, `scripts`, `supabase`, `public`, `assets`, `docs`, `package.json` e `.env.local`: apenas os arquivos previstos mudaram; captura da TUVAPLAST idêntica.

## 7. Revisão independente (subagente de contexto limpo, somente leitura)
Escopo: segurança e matemática de todo `scoring/`, testes e a alteração no teste de isolamento. **Nenhum achado crítico.** Conferido sem problema: todas as faixas e fronteiras contra a D3B §4; aritmética inteira e arredondamento; L1/L2 (empates, mediana, amostra); gates de publicação; os 6 fatores de confiança; N/A e Amostra insuficiente; datas relativas; escopo de site e sitemap sem atestado; X5 sem vazar a URL; schema estrito (`__proto__`, ReDoS, falsos positivos); congelamento/`WeakSet`/`verifyScoreResult`; isolamento (nenhum consumidor; relaxamento só dentro de `scoring/`).
Achados e tratamento (todos corrigidos, com teste de regressão):
| # | Sev. | Achado | Correção |
|---|---|---|---|
| 1 | Alto | Régua mutável em execução (`TIERS`, `RULES`, `VALIDATED_DETECTORS`…) sem mudar a impressão digital | `deepFreeze` de toda a régua no carregamento; teste de imutabilidade e de que `sha256(RULER_DATA)` = `RULER_FINGERPRINT` |
| 2 | Médio-alto | N/A `FEATURE_UNAVAILABLE` escondia um zero comprovado (lista exposta e vazia) e aceitava só hash de anexo | recusado se o campo foi lido/exposto (mesmo vazio); exige `causeEvidenceIds` aterradas |
| 3 | Médio | V5 zero sem nenhuma evidência | confirmação de imagens sempre cita evidência; `checkCore` exige evidência armazenada em todo ponto avaliado |
| 4 | Médio | Gate INTEGRITY fixo; agregador apresentado como perfil do Google | `AGGREGATOR` só com origem `THIRD_PARTY`; a regra "secundária reduz a confiança, não impede o ponto" (D3B §6.3) foi mantida e documentada |
| 5 | Médio | `referenceDate` sem âncora externa | **invariante de integração da 6B** (abaixo); não é decidível num módulo puro |
| 6 | Médio | Varredura de chaves recursiva (estouro de pilha, saída gigante) | varredura iterativa com limite de nós (200 mil) e de achados (20); `parseScoringInput` com `try/catch` |
| 7 | Médio-baixo | Sitemap incoerente com o limite do coletor | recusado (`urlsRead > requestCap`) |
| 8 | Médio-baixo | `DOCUMENTED_FULL_REVIEW` não rebaixava a confiabilidade | S5, X4 e V5 passam a secundários nesse escopo |
| 9 | Baixo-médio | N2 com texto e `parsed` vazio virava zero | zero só com `parsed.none = true`; senão Não verificado (`ADDRESS_UNPARSED`) |
| 10 | Baixo | X5: texto incorreto com valores UTM vazios; nomes arbitrários ecoados | texto "com valor preenchido"; só nomes `utm_*` conhecidos são ecoados |
| 11 | Baixo | R3 ignorava leitura incompleta | `lo = 0` quando incompleta |
| 12 | Baixo | E-mail do operador, hash de valores conflitantes e `blockers` no resultado | `recordedBy = OPERATOR_RECORD`; conflitos guardam só evidências e datas; bloqueios só contados |
| 13 | Baixo | Chaves herdadas (`constructor`) aceitas como versão | `Object.hasOwn` |
| 14 | Baixo | `checkResult` público parecia verificação de autenticidade | exportado como `checkResultConsistency` (documentado: só coerência interna) |
| 15 | Baixo | Hora impossível aceita; capturas antigas descartadas não registradas; concorrentes clones | hora validada; demais itens documentados como limites (abaixo) |
Observação do revisor aceita e documentada: `OPERATOR_STATEMENT`/`AGGREGATOR` (secundárias) fundamentam pontos mas reduzem a confiabilidade (D3B §6.3); o `justification` do operador (texto livre) aparece nos motivos de N/A.

## 8. Limites e pendências para a Onda 6B
0. **Invariante de integração (achado 5):** `referenceDate` deve ser derivada do snapshot armazenado (nunca do cliente) e `recordedAt` dos registros do operador não pode ser futura; o motor puro só garante que nenhuma evidência é posterior à data de referência. Também deduplicar concorrentes (mesma entidade/clones) e registrar as capturas antigas descartadas no histórico, na camada que conhece o armazenamento.
1. **Armazenamento** da confirmação do operador e do registro de N/A (hoje só entradas validadas).
2. **Conexão** do motor à leitura das evidências armazenadas (mapa `report.json`/capturas → entrada do motor) e à tela, com rótulos "provisório" e exibição de cobertura, confiança, limitações e `naSensitivity`.
3. **Detectores determinísticos validados** para S5/X4/V5 (na 6A só vale a confirmação do operador; a lista de detectores validados é vazia).
4. **Coleta**: lista de ações do perfil (X3), Google Posts (A1–A3), datas de avaliações (R3/P2) e respostas dependem de painel/prints ou de Serper Reviews (exige autorização escrita); concorrentes (L1/L2) dependem de D5; leitura ampliada de sites também.
5. Sem interface, sem PDF e sem rota nesta onda.

## 9. Riscos conhecidos
- Faixas e limiares são julgamento do projeto, não do Lumos (D3B-16: v1 revisável).
- Viés ascendente: como ausência/zero de site é Não verificado, perfis lidos em parte pontuam só o que se comprova no nível máximo; a cobertura mínima, o selo "provisório" e a confiança contêm o efeito.
- O resultado contém o e-mail do operador nos registros de N/A (rastreabilidade); tratar como dado interno ao exibir.
- O hash de integridade detecta alteração acidental ou inconsistência; **não** é assinatura.
