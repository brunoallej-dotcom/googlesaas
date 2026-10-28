# D3A — Proposta da Régua de Pontuação Lumos v1 (Fase 6 · Auditoria por Link)

Status: **PROPOSTA PARA APROVAÇÃO** · documento escrito em 22/10/2026 · metodologia `lumos-reconstruida-v1`.
Nada aqui está implementado: nenhum código de pontuação, nenhuma interface, nenhum PDF, nenhuma IA, nenhuma consulta externa, nenhum crédito, nenhuma alteração em Supabase/Redis/migrations, nos arquivos privados da TUVAPLAST ou na prospecção.

## 0. Aviso de fidelidade (leia primeiro)

- **A régua de pontos por subcritério NÃO foi recuperada.** O prompt original do agente nunca foi encontrado. As instruções fornecidas (mestre, executáveis, lacunas, manual, guia, JSON, PDFs) dão: os nove critérios, os pesos, as fórmulas gerais, a regra "Não verificado ≠ zero" e a separação nativo × site × redes. Elas **não** dão a divisão interna dos pesos nem as faixas de atribuição de pontos (lacunas R-13 a R-17 do documento de lacunas).
- Portanto **tudo o que for marcado `PROPOSTA PARA APROVAÇÃO` é regra nova**, escrita para este projeto, e **não pertence ao agente original**. Não se deve afirmar que reproduz o Lumos original. As auditorias em PDF do agente original (Lumos Marketing, Rio Radical, TUVAPLAST, VRA, Daniele Cardoso, Paz Universal) foram usadas só como **hipótese de calibração** (§10), nunca como regra.
- O que é **comprovado nas fontes** está marcado `FONTE`. O que é um indício (aparece só nos PDFs de saída do agente, não nas instruções) está marcado `INDÍCIO`.

## 1. Fontes lidas integralmente

| Fonte | Uso |
|---|---|
| `INSTRUCOES_MESTRAS_AGENTE_AUDITORIA_GBP_v1.md` | critérios, pesos, separação nativo × externo, fórmulas, pendências |
| `INSTRUCOES_EXECUTAVEIS_AGENTE_AUDITOR_GBP_v1.md` | fluxo e rótulos de evidência |
| `LACUNAS_E_DECISOES_DE_FIDELIDADE.md` | R-13 a R-17 (o que falta), D1–D5 |
| `LEIA_ME_PRIMEIRO.md`, `PROMPT_ENTREGA_CLAUDE_CODE_FASE6.md` | restrições e ordem de trabalho |
| Referências 01 (JSON), 02 (manual visual/qualidade), 03 (guia de espelhar modelos) | fórmulas, exemplo numérico, limiares de cobertura |
| PDFs 04 (Lumos Marketing) e 05 (Rio Radical) | exemplos de saída |
| Auditorias Lumos em PDF: TUVAPLAST, VRA, Estética Daniele Cardoso, Funerária Paz Universal (2) | calibração (hipótese) |
| `src/lib/link-audit/methodology.ts` | nomes e pesos preservados (inalterado) |
| `E0-CONTRATO-DE-FIDELIDADE.md`, docs das ondas 1–5B, `report.json` preservado da TUVAPLAST (somente leitura) | estado do projeto e dados reais disponíveis |

Os 16 PDFs de unidades da Paz Universal (ZIP) foram apenas listados; as duas já lidas têm o mesmo gabarito.

## 2. Regras gerais (valem para todos os critérios)

### 2.1 Estados de um subcritério
| Estado | Pontos obtidos | Pontos avaliados | Entra no índice? |
|---|---|---|---|
| `SCORED` | 0 … máx. (passo 0,5) | = máx. do subcritério | sim |
| `ABSENCE_PROVEN` (zero comprovado) | 0 | = máx. | sim |
| `NOT_VERIFIED` (Não verificado) | 0 | **0** | **não** (sai do denominador) |
| `NOT_APPLICABLE` | 0 | **0** | não (motivo obrigatório) |

`FONTE` (manual): "recurso nativo não verificado sai do denominador"; "Não verificado ≠ zero". `FONTE` (D2 aprovada): "Não encontrado" é só observação documentada, não zero.

### 2.2 Zero comprovado × Não encontrado × Não verificado `PROPOSTA`
- **Zero comprovado** só existe quando a **fonte nativa foi lida por completo** e mostra a ausência (ex.: perfil com 0 avaliações; lista de publicações lida e vazia). Exige evidência com `readComplete = true`, origem e data.
- "Não encontrado" (a busca não achou, ou leitura incompleta) **nunca** vira zero: o subcritério fica `NOT_VERIFIED`.
- Recurso ausente comprovado **zera** os subcritérios de *manutenção* dele (A2, A3, V4) e torna **não aplicáveis** os de *qualidade do que existe* (R1, R3, P1–P3).

### 2.3 Evidência "Parcial" `PROPOSTA`
Evidência parcial **não pontua**: o subcritério fica `NOT_VERIFIED` e a lacuna é listada. Os subcritérios abaixo são pequenos de propósito para que cada um se apoie em uma única evidência completa (uma evidência parcial de um campo não vira "meia nota").

### 2.4 Quem pode comprovar `FONTE` + `PROPOSTA`
- **Nativos** (só o perfil do Google comprova; coluna "Nat."): categorias, serviços, produtos, atributos, avaliações, respostas, fotos, vídeos, Google Posts (`methodology.ts`: `NATIVE_ONLY_ATTRIBUTES`, `NATIVE_ONLY_CRITERIA`). Site, Instagram, LinkedIn e diretórios **nunca** elevam esses subcritérios; entram como contexto ou em "Não verificado".
- Origem "Google nativo" aceita: leitura do `/maps` do Serper (intermediário, não é API oficial), prints/exportações autorizados do painel, captura manual do operador com data. A origem é sempre exibida.
- **Julgamento humano sem IA:** subcritérios qualitativos (C2, C3-coerência, P3) só pontuam com **confirmação registrada do operador** (quem, quando). Sem ela: `NOT_VERIFIED`. Nenhum subcritério é pontuado por texto gerado por IA.

### 2.5 Conflito entre fontes `PROPOSTA`
1. **Nativo × externo** num atributo nativo: o nativo prevalece; o externo fica como contexto.
2. **Duas capturas nativas** de datas diferentes: a mais recente pontua; a antiga fica no histórico.
3. **Mesma fonte/mesmo nível, valores diferentes, sem data decisiva** (ou mesma data): `CONFLICT_OPEN` → o subcritério dependente fica `NOT_VERIFIED`, a divergência é listada e a **confiança cai um nível** (§5.3).
4. **Divergência de NAP entre perfil e site/redes não é "conflito a resolver"**: é o objeto de N6 e reduz pontos ali.

### 2.6 Arredondamento e aritmética `PROPOSTA`
- Pontos são múltiplos de 0,5; os máximos dos subcritérios são inteiros. Cálculo **exato** (em meios-pontos inteiros ou fração), sem ponto flutuante acumulado.
- Índice exibido = inteiro por **arredondamento "meio para cima"** (74,5 → 75; 59,5 → 60). O valor exato com uma casa decimal pode ser mostrado ao lado.
- Cobertura = `E` (inteiro, porque Σ máximos é inteira) %; não precisa arredondar.
- **A classificação usa o inteiro exibido** (nunca "75 — Em desenvolvimento").

## 3. Matriz completa — nove critérios, nomes e pesos de `methodology.ts` preservados

Legenda: **Nat.** = só o Google nativo comprova. Passo de pontos 0,5. Cada critério soma exatamente o peso (verificado por script, §12). Total = 100.

### 3.1 NAP — Dados essenciais e consistência NAP (peso 15)
Fontes: perfil nativo (N1–N5); N6 exige ≥ 2 fontes lidas (perfil + site/rede/diretório).
| Id | Subcritério | Máx. | Integral | Parcial | Zero comprovado |
|---|---|---|---|---|---|
| N1 | Nome do perfil presente | 3 | presente = 3 | — | ausente = 0 |
| N2 | Endereço ou área de atendimento | 3 | rua+nº+cidade+UF, ou área declarada = 3 | sem nº ou sem CEP = 1,5 | nenhum dos dois = 0 |
| N3 | Telefone | 3 | presente = 3 | — | ausente = 0 |
| N4 | Horários | 2 | 7 dias ou fechamento explícito = 2 | alguns dias = 1 | ausente = 0 |
| N5 | Website informado | 1 | presente = 1 | — | ausente = 0 |
| N6 | Consistência entre fontes (nome, endereço, telefone, horário) | 3 | 0 divergências = 3 | 1 divergência = 1,5 | ≥ 2 divergências = 0 |
Comparação de N6 determinística (telefone só dígitos; endereço sem acentos/caixa/abreviações comuns); caso ambíguo → `NOT_VERIFIED`, nunca palpite. **Exemplo:** perfil e site com o mesmo telefone, endereço igual, horário de sexta diferente → 1 divergência → N6 = 1,5.

### 3.2 CATEGORIES — Categorias e relevância comercial (peso 10) · Nat.
| Id | Subcritério | Máx. | Integral | Parcial | Zero comprovado |
|---|---|---|---|---|---|
| C1 | Categoria principal definida | 4 | definida = 4 | — | ausente = 0 |
| C2 | Aderência da principal ao negócio (confirmação do operador) | 3 | aderente = 3 | parcialmente = 1,5 | não aderente = 0 |
| C3 | Categorias adicionais (lista nativa lida; coerência confirmada) | 3 | 2–4 coerentes = 3 | 1 = 2; > 4 ou parte incoerente = 1,5 | 0 comprovado = 0 |
Sem lista nativa lida: C3 `NOT_VERIFIED`. Sem referência do negócio confirmada: C2 `NOT_VERIFIED`. **Exemplo:** principal "Fabricante de brinquedos" (C1 = 4); adicionais não lidas (C3 N/V); operador não confirmou aderência (C2 N/V) → 4/4 avaliados.

### 3.3 SERVICES — Serviços, produtos, descrição e atributos (peso 12) · Nat.
| Id | Subcritério | Máx. | Integral | Parcial | Zero comprovado |
|---|---|---|---|---|---|
| S1 | Descrição nativa | 3 | ≥ 250 caracteres = 3 | menor = 1,5 | ausente = 0 |
| S2 | Serviços/itens cadastrados | 4 | ≥ 5 itens = 4 | 1–4 = 2 | 0 = 0 |
| S3 | Atributos do perfil | 2 | ≥ 3 = 2 | 1–2 = 1 | 0 = 0 (N/A se a categoria não oferece atributos) |
| S4 | Produtos nativos | 3 | ≥ 3 = 3 | 1–2 = 1,5 | 0 = 0 (N/A se o negócio não vende produtos) |
Catálogo do site **não** comprova S2/S4. **Exemplo:** site com 40 produtos, perfil não lido → S2/S4 N/V (o site vira contexto).

### 3.4 REVIEWS — Avaliações e reputação (peso 18) · Nat.
| Id | Subcritério | Máx. | Faixas |
|---|---|---|---|
| R1 | Nota média | 6 | ≥ 4,8 = 6 · ≥ 4,5 = 5 · ≥ 4,2 = 4 · ≥ 4,0 = 3 · ≥ 3,5 = 2 · ≥ 3,0 = 1 · < 3,0 = 0 |
| R2 | Volume de avaliações | 6 | ≥ 100 = 6 · 50–99 = 5 · 25–49 = 4 · 10–24 = 3 · 5–9 = 2 · 1–4 = 1 · 0 comprovado = 0 |
| R3 | Recência (avaliação mais recente; exige datas lidas) | 6 | ≤ 30 d = 6 · ≤ 90 d = 4 · ≤ 180 d = 2 · ≤ 365 d = 1 · > 365 d = 0 |
Com 0 avaliações comprovadas: R2 = 0 avaliado; R1 e R3 não aplicáveis. R3 sem datas (Serper Reviews não consultado ou painel não fornecido) = `NOT_VERIFIED`. As faixas são **propostas**, não calibradas com concorrentes. **Exemplo:** 4,9 e 60 avaliações, última há 20 dias → 6 + 5 + 6 = 17/18.

### 3.5 REVIEW_REPLIES — Respostas às avaliações (peso 8) · Nat.
| Id | Subcritério | Máx. | Faixas |
|---|---|---|---|
| P1 | Taxa de resposta (amostra ≥ 10 avaliações lidas, ou todas se < 10) | 4 | ≥ 90 % = 4 · ≥ 70 % = 3 · ≥ 50 % = 2 · > 0 % = 1 · 0 % = 0 |
| P2 | Tempo de resposta (mediana) | 2 | ≤ 7 d = 2 · ≤ 30 d = 1 · > 30 d = 0 |
| P3 | Qualidade (revisão humana de ≥ 5 respostas) | 2 | específicas/humanas = 2 · genéricas = 1 · inadequadas = 0 |
Perfil sem avaliações: os três `NOT_APPLICABLE`. Sem amostra de respostas lida: `NOT_VERIFIED`. **Exemplo:** 8 de 10 avaliações respondidas (80 %), mediana 3 dias, revisão humana não feita → P1 = 3, P2 = 2, P3 N/V → 5/6.

### 3.6 VISUALS — Fotos, vídeos e identidade visual (peso 10) · Nat.
| Id | Subcritério | Máx. | Faixas |
|---|---|---|---|
| V1 | Logo e capa | 2 | ambos = 2 · um = 1 · nenhum comprovado = 0 |
| V2 | Fotos | 4 | ≥ 20 = 4 · 10–19 = 3 · 5–9 = 2 · 1–4 = 1 · 0 = 0 |
| V3 | Vídeos | 2 | ≥ 1 = 2 · 0 comprovado = 0 |
| V4 | Recência das mídias (data da mais recente) | 2 | ≤ 90 d = 2 · ≤ 365 d = 1 · > 365 d ou sem mídia = 0 |
Fotos do site/Instagram não comprovam nada aqui. **Exemplo:** site com galeria de 120 fotos → V2 continua N/V.

### 3.7 POSTS_ACTIVITY — Publicações e atividade (peso 8) · Nat.
| Id | Subcritério | Máx. | Faixas |
|---|---|---|---|
| A1 | Existência de Google Posts/atualizações | 3 | ≥ 1 vigente = 3 · 0 comprovado = 0 |
| A2 | Recência da última | 3 | ≤ 30 d = 3 · ≤ 60 d = 2 · ≤ 90 d = 1 · > 90 d = 0 |
| A3 | Frequência (últimos 90 dias) | 2 | ≥ 4 = 2 · 2–3 = 1 · ≤ 1 = 0 |
Conteúdo recente no blog/LinkedIn **não** comprova Google Posts. Se A1 = 0 comprovado, A2 e A3 = 0 (avaliados). Recurso indisponível para o tipo de perfil → `NOT_APPLICABLE`.

### 3.8 CONVERSION — Conversão e jornada (peso 10)
| Id | Subcritério | Máx. | Fonte | Faixas |
|---|---|---|---|---|
| X1 | Website vinculado ao perfil | 2 | Nat. | informado = 2 · ausente comprovado = 0 |
| X2 | Site acessível | 1 | requisição ao site | resposta 2xx/3xx = 1 · 404/5xx confirmados = 0 · **401/403/desafio/timeout = N/V** |
| X3 | Canais de contato/ação no perfil (telefone, WhatsApp, mensagens, reserva/pedido) | 2 | Nat. | ≥ 3 = 2 · 2 = 1,5 · 1 = 1 · 0 comprovado = 0 |
| X4 | Jornada no site (elementos presentes: chamada clara, catálogo/serviço, contato/compra) | 3 | site lido | 3 = 3 · 2 = 2 · 1 = 1 · 0 = 0 |
| X5 | Rastreamento (UTM) no link do perfil | 2 | URL do perfil | UTM presente = 2 · URL lida sem UTM = 0 |
X2 e X4 usam o site apenas para o que ele prova (acesso e jornada), nunca para recursos nativos. **Exemplo:** site responde 403 → X2 e X4 N/V; website informado → X1 = 2.

### 3.9 LOCAL_AUTHORITY — Autoridade local e competitividade (peso 9)
| Id | Subcritério | Máx. | Faixas |
|---|---|---|---|
| L1 | Nota frente à amostra de concorrentes | 3 | ≥ maior da amostra = 3 · ≥ mediana = 2 · < mediana = 1 · < menor = 0 |
| L2 | Volume de avaliações frente à amostra | 3 | ≥ maior = 3 · ≥ mediana = 2 · ≥ 50 % da mediana = 1 · abaixo = 0 |
| L3 | Prova externa de autoridade (site oficial lido, rede ativa, cadastro oficial) | 3 | ≥ 2 tipos corroborados = 3 · 1 = 1,5 · 0 comprovado = 0 |
L1/L2 exigem **≥ 3 concorrentes** com critério de equivalência documentado (mesmo município/categoria/intenção, ≥ 2 elementos verificáveis por concorrente, como nos PDFs); sem isso `NOT_VERIFIED` (depende da decisão D5, concorrentes). L3 exige fontes lidas, não apenas citadas.

### 3.10 Resumo e soma
| Critério | Peso | Subcritérios (máx.) | Soma |
|---|---|---|---|
| NAP | 15 | 3+3+3+2+1+3 | 15 |
| CATEGORIES | 10 | 4+3+3 | 10 |
| SERVICES | 12 | 3+4+2+3 | 12 |
| REVIEWS | 18 | 6+6+6 | 18 |
| REVIEW_REPLIES | 8 | 4+2+2 | 8 |
| VISUALS | 10 | 2+4+2+2 | 10 |
| POSTS_ACTIVITY | 8 | 3+3+2 | 8 |
| CONVERSION | 10 | 2+1+2+3+2 | 10 |
| LOCAL_AUTHORITY | 9 | 3+3+3 | 9 |
| **Total** | **100** | | **100** |

## 4. Evidências obrigatórias por critério (resumo)
Cada subcritério pontuado precisa de: valor lido, **origem** (Google nativo / site / rede / terceiro / operador), **data da leitura**, estado de completude (`readComplete`) quando o zero for comprovado, e vínculo com a captura armazenada (`captureSha256`). Sem esses campos → `NOT_VERIFIED`. O rótulo da evidência (Verificado / Parcial / Não verificado / Não encontrado) continua sendo o do snapshot; a pontuação só lê evidências **Verificado**.

| Critério | Evidência obrigatória | Fontes aceitáveis |
|---|---|---|
| NAP | nome, endereço, telefone, horários, site do perfil; para N6, ≥ 1 fonte externa lida | perfil nativo; site/rede/diretório (só N6) |
| CATEGORIES | categoria principal; lista adicional completa | nativo; confirmação do operador (C2/C3) |
| SERVICES | descrição, itens, atributos, produtos nativos | nativo (site só contexto) |
| REVIEWS | nota, total, datas | nativo (Maps, Reviews, painel) |
| REVIEW_REPLIES | respostas e datas de uma amostra | nativo; revisão humana (P3) |
| VISUALS | contagem e data de fotos/vídeos; logo/capa | nativo |
| POSTS_ACTIVITY | lista de posts com datas | nativo |
| CONVERSION | URL do perfil, canais, resposta do site, elementos da jornada | nativo (X1, X3, X5); site (X2, X4) |
| LOCAL_AUTHORITY | ≥ 3 concorrentes equivalentes; fontes de autoridade lidas | nativo dos concorrentes; site/cadastros (L3) |

## 5. Regras matemáticas

### 5.1 Definições
Para cada critério `i` (peso `w_i`) e subcritério `s` (máx. `m_s`):
- `avaliados_i = Σ m_s` dos subcritérios `SCORED` ou `ABSENCE_PROVEN`;
- `obtidos_i = Σ pontos` desses subcritérios;
- invariante `FONTE`: `0 ≤ obtidos_i ≤ avaliados_i ≤ w_i`;
- `O = Σ obtidos_i`, `E = Σ avaliados_i`.

### 5.2 Fórmulas
- **Pontos obtidos** = `O` · **Pontos possíveis avaliados** = `E`.
- **Cobertura (%)** = `E / 100 × 100` = `E` (porque Σ pesos = 100). `FONTE`.
- **Índice Lumos (%)** = `O / E × 100`; exibido = `round_half_up`. `FONTE` (fórmula); arredondamento `PROPOSTA`.
- **Base observada** exibida como `O/E` (ex.: 54,5/65). `FONTE`.
- Pontos de um critério sem nenhum avaliado: exibidos como "N/V", **não 0/…**.

### 5.3 Confiança `PROPOSTA` (hoje só qualitativa; `INDÍCIO`: 58 % = baixa, 81 % = média)
| Cobertura | Confiança base | Rótulo do índice |
|---|---|---|
| < 65 % | Baixa | **pontuação provisória** (`INDÍCIO`: "cobertura inferior a 65 %" nos PDFs do agente) |
| 65 % a 89 % | Média | — |
| ≥ 90 % | Alta | — (`INDÍCIO`: meta "cobertura superior a 90 %") |
Cai **um nível** se houver `CONFLICT_OPEN`. A confiança nunca sobe por haver muitas evidências: conta **pontos avaliados**, não a quantidade de evidências nem de critérios.

### 5.4 Classificações `FONTE` + `PROPOSTA` (faixa 40–59)
| Índice exibido | Classificação | Origem |
|---|---|---|
| 0–39 | Crítico | `FONTE` |
| **40–59** | **Fraco** | `PROPOSTA`; `INDÍCIO`: o nome "Fraco" aparece nos PDFs TUVAPLAST/VRA/Daniele, não nas instruções |
| 60–74 | Em desenvolvimento | `FONTE` |
| 75–89 | Forte | `FONTE` |
| 90–100 | Referência local | `FONTE` |

### 5.5 Base zero e avaliação parcial `PROPOSTA`
- `E = 0` → **sem índice** (estado `NO_DATA`); nunca "0". `FONTE`: "cobertura zero: não calcule índice".
- `E > 0` com `O = 0` → índice 0 **válido** (zero comprovado), se passar as condições de §5.6.
- Avaliação parcial: critério com `0 < avaliados_i < w_i` mostra "obtidos/avaliados (peso w)" e entra no índice só com a parte avaliada.

### 5.6 Condições mínimas para publicar um número `PROPOSTA`
Estados de saída: `NO_DATA` (E = 0) · `INSUFFICIENT` (abaixo do mínimo; só mostra critérios, sem índice) · `PROVISIONAL` (mínimo ≤ cobertura < 65 %) · `PUBLISHED` (≥ 65 %).
Mínimo recomendado para exibir o número: **cobertura ≥ 40 % e ≥ 3 critérios com pontos avaliados, incluindo NAP ou REVIEWS** (alternativa 25 %, ver D3-8). Além disso: nenhuma violação de invariante, todos os pontos ligados a uma evidência **Verificada** armazenada, `methodologyVersion` registrada, rótulo "Índice Lumos não é nota oficial do Google" e, abaixo de 65 %, o aviso "pontuação provisória".

### 5.7 Validação de entrada (regressões que a implementação deve recusar)
`obtidos > avaliados` · `avaliados > peso` · pontos atribuídos a item Não verificado · soma dos critérios ≠ `O`/`E` declarados · cobertura/classificação declaradas ≠ calculadas (ex.: JSON de exemplo: 54/75 declarado × 68 na tabela; PDF Lumos pág. 4: soma 47/74, cobertura calculada 74 %, exibida 58 %).

## 6. Quadro-resumo dos critérios (nomes e pesos preservados)
Dados essenciais e consistência NAP (15) · Categorias e relevância comercial (10) · Serviços, produtos, descrição e atributos (12) · Avaliações e reputação (18) · Respostas às avaliações (8) · Fotos, vídeos e identidade visual (10) · Publicações e atividade (8) · Conversão e jornada (10) · Autoridade local e competitividade (9) = 100.

## 7. Aplicação à TUVAPLAST COMÉRCIO (somente dados já preservados; **sem nota**)
Base: `tuvaplast-20261022-maps01` (`report.json`, somente leitura; 8 evidências Verificadas, 11 Não verificadas, 1 chamada `/maps` já consumida). **Nenhum número de índice é calculado ou publicado aqui.**

| Subcrit. | Situação | Evidência preservada | Lacuna / como fechar |
|---|---|---|---|
| N1 nome | suficiente | `maps-name` | — |
| N2 endereço | suficiente (completude do campo a conferir na implementação) | `maps-address` | — |
| N3 telefone | suficiente | `maps-phone` | — |
| N4 horários | suficiente (7 dias a conferir) | `maps-hours` | — |
| N5 website | suficiente | `maps-website` | — |
| N6 consistência | **não verificado** | site não lido (401/403) | ler o site ou receber capturas |
| C1 principal | suficiente | `maps-category` | — |
| C2 aderência | não verificado | sem confirmação do operador | operador confirma |
| C3 adicionais | **não verificado** | `maps-secondary-categories` N/V | painel/prints |
| S1–S4 | **não verificado** | `unavailable-services/attributes/products` | painel/prints |
| R1 nota | suficiente | `maps-rating` (5) | — |
| R2 volume | suficiente | `maps-review-count` (49) | — |
| R3 recência | **não verificado** | `unavailable-review-recency` | Serper Reviews (exige autorização) ou prints |
| P1–P3 | **não verificado** | `unavailable-review-replies` | mesmo acima |
| V1–V4 | **não verificado** | `unavailable-photos/videos` | painel/prints |
| A1–A3 | **não verificado** | `unavailable-posts` | painel/prints |
| X1 website vinculado | suficiente | `maps-website` | — |
| X2 acessibilidade | **não verificado** | `site-reachable` N/V (401/403/desafio) | outro caminho de leitura autorizado ou prints |
| X3 canais | não verificado (só telefone é verificado; definição de "canal" a fechar) | — | painel/prints |
| X4 jornada | não verificado | site não lido | idem X2 |
| X5 UTM | elegível, **ainda não calculado** | URL do perfil preservada | conferir offline na implementação |
| L1/L2 | não verificado | sem concorrentes | decisão D5 |
| L3 | não verificado | `external-presence` N/V | site/rede lidos |

Pontos potencialmente avaliáveis: NAP 12 + CATEGORIES 4 + REVIEWS 12 + CONVERSION 2 (+2 se X5 confirmar) = **30 a 32 de 100** → cobertura prevista **30–32 %** em **4 de 9 critérios**. Isso é apenas o teto de cobertura com os dados atuais. Pelo mínimo recomendado (§5.6, 40 %), o resultado seria `INSUFFICIENT`: a TUVAPLAST **não teria número publicado** hoje, só os critérios avaliáveis e as lacunas; pelo mínimo alternativo (25 %) seria `PROVISIONAL`, confiança baixa. As 8 evidências verificadas não equivalem a 8 critérios avaliados: elas cobrem 4 critérios, e a cobertura se mede em pontos.

## 8. Casos de teste e exemplos matemáticos (valores conferidos por cálculo exato)
| # | Cenário | Entrada | Resultado esperado |
|---|---|---|---|
| T01 | Critério totalmente verificado | REVIEWS: 4,9 / 60 aval. / última há 20 d → 6+5+6 | 17/18 (peso 18, avaliados 18) |
| T02 | Critério parcial | REVIEWS: R3 N/V → 6+5 | 11/12 (peso 18); entra com 12 avaliados |
| T03 | Critério não verificado | REVIEW_REPLIES: P1–P3 N/V | exibe "N/V"; avaliados 0; fora do denominador |
| T04 | Zero comprovado | POSTS: lista nativa lida, 0 posts → A1=0, A2=0, A3=0 | 0/8, avaliados 8 (puxa o índice para baixo, legitimamente) |
| T05 | Sem avaliações | REVIEWS: 0 aval. comprovadas | R2=0/6; R1, R3 N/A; REPLIES todos N/A → REVIEWS 0/6, REPLIES fora |
| T06 | Fontes contraditórias (a) | telefone: perfil ≠ site | N3=3 (nativo); N6 = 1,5 (1 divergência) |
| T07 | Fontes contraditórias (b) | horários: duas capturas nativas, mesma data, valores distintos | N4 N/V + `CONFLICT_OPEN`; confiança −1 nível |
| T08 | NAP com T06+T07 | N1=3,N2=3,N3=3,N4 N/V,N5=1,N6=1,5 | 11,5/13 |
| T09 | Ausência total de dados | E = 0 | sem índice (`NO_DATA`); jamais "0" |
| T10 | Cobertura baixa | O = 18, E = 20 (90 %) | cobertura 20 % < mínimo → `INSUFFICIENT`, **sem** mostrar "90" |
| T11 | Cobertura completa | O = 82,5, E = 100 | índice 82,5 → **83**, Forte, cobertura 100 %, confiança Alta |
| T12 | Exemplo do manual | O = 54,5, E = 65 | 83,846… → **84**, Forte, cobertura 65 %, confiança Média, **não** provisório (65 não é < 65) |
| T13 | Arredondamento | 74,5/100 → 75 Forte · 59,5/100 → 60 Em desenvolvimento · 39,5/100 → 40 Fraco · 89,5/100 → 90 Referência · 50,5/85 = 59,41 → 59 Fraco · 42/57 = 73,68 → 74 Em desenvolvimento | conforme descrito |
| T14 | Limites das classes | 38,5→39 Crítico · 40 Fraco · 59 Fraco · 60 Em desenv. · 74 Em desenv. · 75 Forte · 89 Forte · 90 Referência · 100 Referência | idem |
| T15 | Índice zero válido | O = 0, E = 40, cobertura 40 % | índice 0, Crítico, publicável (mínimo 40 %) |
| T16 | Nativo × site | site com 120 fotos; perfil não lido | V2 N/V (site não comprova) |
| T17 | Evidências ≠ critérios | 8 evidências verificadas em 4 critérios | cobertura por pontos (30–32 %), nunca por contagem |
| T18 | Regressão: PDF Lumos pág. 4 | 8/15, 5/10, 9/12, 7/10, 6/8, 6/10, 6/9; N/V em 2 | O = 47, E = 74 → 63,51 → **64** Em desenv.; cobertura **74 %** (o PDF mostra 58 %: inconsistência do original) |
| T19 | Regressão: JSON de exemplo | declarado 54/75; tabela soma 68 | `INVALID_INPUT` (soma divergente) |
| T20 | Violações | obtidos > avaliados; avaliados > peso; pontos em item N/V | recusado |
| T21 | Calibração PDFs (informativo) | TUVAPLAST 47,5/57 → 83 · Paz 47,5/55 → 86 · VRA 14/26 → 54 · Rio Radical 84 | a aritmética dos PDFs de unidades fecha; não são calibradores automáticos |
| T22 | Provisório na borda | cobertura 64 % → provisória; 65 % → não | idem |

## 9. Fronteiras desta proposta
Prospecção, Juiz (21 critérios), grade de 49 pontos, campanhas e PDFs históricos **não são tocados**; o Lumos não se mistura com o Juiz. A régua só vive em `link-audit` quando aprovada. Pontuação continua `NOT_AVAILABLE_PENDING_D3` na leitura e na interface até a aprovação.

## 10. Calibração com os PDFs do agente original (hipótese, não regra)
Os PDFs dão pontos por critério, com divisões internas visíveis (ex.: REVIEWS "12 avaliados" quando só nota+volume foram lidos; CATEGORIES "6 avaliados" na Paz Universal, "10" na TUVAPLAST). Isso sugere sub-réguas, mas sem tabela de faixas. Comparação com esta proposta: REVIEWS desta proposta daria TUVAPLAST 10/12 (PDF 10,5/12), Paz 11/12 (10,5) e Daniele 8/12 (7); NAP 15 avaliados no PDF contra 12 aqui (N6 N/V). **Divergências pequenas, porém a régua do PDF não é reproduzida e não deve ser descrita como idêntica.** Os PDFs também contêm erros de cobertura (Lumos 58 % × 74 %; Rio Radical 81 % × 100 %), o que reforça a validação de §5.7.

## 11. Riscos
1. Faixas numéricas (R1–R3, P1–P2, V2, S2…) são julgamento do projeto, não do Lumos.
2. Pequenas bases (poucas avaliações) distorcem L1/L2; por isso exigir ≥ 3 concorrentes.
3. Cobertura baixa + nota alta pode enganar: por isso o mínimo de §5.6 e o selo "provisória".
4. Serper `/maps` não é API oficial do Google; a origem precisa aparecer em cada ponto.
5. Julgamento humano (C2, C3, P3) depende de processo do operador; sem registro, vira N/V.

## 12. Verificação aritmética
Script de apoio (fora do projeto) conferiu: soma dos subcritérios = peso em cada um dos nove critérios, total = 100, e todos os resultados da §8 (frações exatas, arredondamento meio para cima). Nenhum arquivo do projeto, nenhuma chamada externa.

## 13. Decisões que precisam da sua aprovação (D3A)
| # | Decisão | Recomendação |
|---|---|---|
| D3-1 | Aprovar a divisão de subcritérios (§3) como v1 própria do projeto (não do agente original) | aprovar, ajustando o que quiser |
| D3-2 | Faixas numéricas de nota, volume, recência, respostas, fotos, posts | aprovar como v1 revisável |
| D3-3 | "Zero comprovado" só com leitura nativa completa; "Não encontrado" nunca é zero; dependentes: manutenção = 0, qualidade = N/A | aprovar |
| D3-4 | Evidência "Parcial" não pontua (fica N/V) | aprovar |
| D3-5 | Julgamento humano registrado (C2, C3, P3); nenhuma pontuação por IA | aprovar |
| D3-6 | Conflito: nativo prevalece; empate = N/V + `CONFLICT_OPEN` + confiança −1 | aprovar |
| D3-7 | Arredondamento meio-para-cima; classificação sobre o inteiro exibido | aprovar |
| D3-8 | Mínimo para exibir número: 40 % + 3 critérios (ou 25 %, como parece ter feito o agente original) | 40 % |
| D3-9 | Faixa 40–59 = "Fraco" | aprovar |
| D3-10 | Confiança: <65 baixa · 65–89 média · ≥90 alta | aprovar |
| D3-11 | Definição de "canal" em X3 (telefone conta? website conta?) | contar telefone, WhatsApp, mensagens, reserva/pedido; website não |
| D3-12 | Site com 401/403/desafio = N/V (sem contorno) | aprovar |
| D3-13 | Concorrentes (L1/L2): mínimo 3 e critério de equivalência (depende de D5) | aprovar mínimo 3 |
| D3-14 | Autorizar a Onda 6A: implementar a régua como módulo puro e testado (sem UI nem coleta) após aprovação | só depois das respostas acima |

**Aguardando sua aprovação antes de implementar qualquer coisa.**
