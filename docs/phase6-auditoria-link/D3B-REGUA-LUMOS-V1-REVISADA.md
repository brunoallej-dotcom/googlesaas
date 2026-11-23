# D3B — Régua de Pontuação Lumos v1 · revisão técnica e ajustes de homologação (Fase 6 · Auditoria por Link)

Status: **HOMOLOGADA em 22/10/2026 (D3B-1 a D3B-16, com as condições da §0.1)** e autorizada para implementação na Onda 6A · `methodologyVersion = lumos-reconstruida-v1` · `scoreModelVersion = regua-d3b-r2` (a `r1` era a versão anterior aos ajustes finais). **É uma metodologia reconstruída pelo projeto GMN, não o agente original recuperado.**
A D3A permanece **intacta como histórico** (`D3A-PROPOSTA-REGUA-LUMOS-V1.md`, SHA-256 `099c3a59…9f54`, inalterado).

**Limites desta especificação e da Onda 6A:** o motor é um módulo puro (`src/lib/link-audit/scoring/`), sem interface, PDF, IA, consulta externa, crédito, Supabase/Redis/migrations, e sem tocar na evidência preservada da AUD-001 ou na prospecção. **Nenhuma nota da AUD-001 é calculada ou publicada.** O armazenamento definitivo da confirmação humana fica para a Onda 6B (aqui só o contrato).

## 0. Avisos de fidelidade

- Os **nove critérios e os pesos** são os da reconstrução, preservados de `methodology.ts` (15 · 10 · 12 · 18 · 8 · 10 · 8 · 10 · 9 = **100**). A divisão interna dos pesos, as faixas e as regras de evidência **não vieram do agente original** (o prompt original nunca foi recuperado). Tudo isso é **PROPOSTA** e nunca deve ser descrito como reprodução do Lumos original.
- Rótulos: `FONTE` = comprovado nas instruções fornecidas (mestre, executáveis, lacunas, manual, guia, JSON, E0). `INDÍCIO` = aparece só nos PDFs de saída do agente original; não vale como regra. `PROPOSTA` = regra nova deste projeto.
- Cobertura continua sendo a fórmula aprovada (D2/manual): **cobertura = Σ pontos avaliados ÷ 100**. Esta revisão não a altera; só acrescenta métricas separadas (§6).

### 0.1 Homologação final e condições (22/10/2026)
O usuário homologou a régua `regua-d3b-r2` (D3B-1 a D3B-16) e autorizou a Onda 6A, com estas condições, que **prevalecem sobre qualquer texto anterior deste documento**:
1. **D3B-8 (X5):** a ausência comprovada de UTM na URL do website cadastrado no perfil vale **0 exclusivamente porque o subcritério avalia o uso de UTM**; nunca se conclui que ausência de UTM equivale a ausência de rastreamento em geral. URL não verificada = Não verificado.
2. **D3B-15 (critério avaliado):** para o requisito de três critérios, só conta o critério com **pelo menos 3 pontos possíveis efetivamente avaliados** (`avaliados_i ≥ 3`); os pontos obtidos podem ser zero. Os três precisam incluir NAP ou Avaliações.
3. **Escopo de site:** um sitemap integralmente percorrido **não comprova sozinho** que todas as páginas ou funcionalidades do domínio foram verificadas. Zero por ausência (e faixa intermediária de contagem) só com **evidência efetivamente suficiente e escopo documentado**: escopo `SITEMAP_COMPLETE` ou `DOCUMENTED_FULL_REVIEW` **mais** um atestado registrado do operador de que o escopo documentado basta para aquele subcritério. Mesmo então, o zero vale **no escopo documentado**. Do contrário, Não verificado.
4. **PDFs históricos (correção):** a afirmação anterior de que os demais PDFs tinham cobertura ≥ 52 % estava **errada**. Há um relatório da <CLIENTE_B> de **21/10/2026 com cobertura de 11 %** (base 7/11, índice 64 "provisório"). Ver §6.2 e §8.1.
5. **Confirmação humana:** o modelo (contrato) está aprovado; o armazenamento definitivo só na Onda 6B.
6. **Versionamento:** `methodologyVersion` e `scoreModelVersion` são registrados separadamente em toda pontuação; uma revisão futura da régua exige nova `scoreModelVersion` e **não altera resultados históricos** (cada resultado carrega a versão e a impressão digital da régua com que foi calculado).

## 1. Histórico de correções

### 1.1 D3A → D3B (primeira revisão)
| # | Defeito ou lacuna na D3A | Correção na D3B | Seção |
|---|---|---|---|
| A1 | **L1**: faixas "≥ mediana = 2", "< mediana = 1", "< menor = 0" se sobrepõem; a faixa 0 era inalcançável (verificado por varredura) | quatro faixas mutuamente exclusivas, com empates e amostras de valores iguais tratados | §5 |
| A2 | **L2** com mediana zero: "≥ maior = 3" dava 3 pontos a quem tem 0 avaliações perante concorrentes com 0 (verificado) | só entram concorrentes com ≥ 5 avaliações; sem 3 elegíveis, L2 = Amostra insuficiente; mediana sempre > 0; x = 0 ⇒ 0 | §5 |
| B | **N5 (website no NAP) e X1 (website na Conversão)** pontuavam o mesmo fato | o website pontua **só em X1**; o ponto do NAP foi para a consistência entre fontes (N5: 3 → 4) | §4.1, §4.8 |
| C | **Categorias adicionais**: ">4 = 1,5" penalizava quantidade; não havia o caso "nenhuma necessária" | sem limite de quantidade; relevância e coerência por evidência nativa + confirmação registrada do operador; "nenhuma necessária" = N/A justificado | §4.2 |
| D | **Serviços e Visuais** tratados como 100 % nativos na D3A, contra E0 §7/§13 ("mistos") | Serviços = 9 nativos + 3 externos; Visuais = 8 nativos + 2 externos; fonte externa nunca comprova o equivalente nativo | §2 |
| E | Evidência "Parcial" tratada em bloco (sempre N/V); "zero" exigia fonte nativa em tudo | estados distintos; leitura suficiente **da fonte própria de cada subcritério** | §3 |
| F | Confiança só por cobertura | confiança composta (mínimo de seis fatores) | §6.3 |
| G | X5 chamado "UTM no link do perfil" | X5 renomeado e reinterpretado: **URL de destino do website configurada no perfil**, não o link do Maps; ausência de UTM ≠ ausência de rastreamento | §4.8 |
| H | Perfil sem avaliações, avaliações sem respostas, sem datas, posts ausentes/antigos/expirados, N/A | tabela de decisão por situação | §4.11 |
| extra-2 | N/A sem lista fechada de causas | lista fechada + registro obrigatório | §3.4 |
| extra-3 | "Zero com 3 critérios e ≥ 40 %" não testado | provado impossível (teto 37 %); índice zero só aparece com ≥ 4 critérios | §9 |

### 1.2 Ajustes finais de homologação (esta revisão)
| # | Pedido | Alteração | Seção |
|---|---|---|---|
| 1 | "Raiz + 3 páginas" não prova ausência no domínio inteiro | **escopo de leitura registrado**; páginas lidas comprovam só fatos observados nelas e o limite inferior de contagens; ausência e faixas intermediárias de contagem exigem escopo suficiente; leitura limitada ⇒ Não verificado; nunca zero por ausência global. A regra "raiz + 3 páginas" deixou de ser critério de suficiência | §3.2, §4.3, §4.6, §4.8, §4.9 |
| 2 | R1 com menos de 5 avaliações | separados: **nota exibida** (dado verificado), **quantidade** (dado verificado) e **elegibilidade** (n ≥ 5). Novo estado **Amostra insuficiente** (`SAMPLE_INSUFFICIENT`), distinto de N/V, N/A e zero | §3.1, §4.4, §4.9, §5 |
| 3 | Cobertura mínima | < 40 % indisponível · 40–64 % provisório · ≥ 65 % publicável com cobertura e confiança explícitas; precedente do agente original registrado como contraste | §6.2, §8.1 |
| 4 | Confiança e aplicabilidade | os seis fatores ganham entrada, fórmula, limiar fechado e **justificativa rastreável**; N/A exige registro completo e é **neutro** (igual a N/V) para cobertura e índice | §3.4, §6.3, §6.4 |
| 5 | Calibração temporal | 24 (07/10) e 49 (22/10) são observações distintas no tempo; nenhuma causa é inferida | §3.3, §7, §8.2 |
| 6 | **Condições da homologação (§0.1)** | X5 sem inferir ausência de rastreamento; critério avaliado ≥ 3 pontos; sitemap sozinho não basta (atestado do operador + escopo documentado); correção do dado histórico de cobertura (<CLIENTE_B> 11 %) | §0.1, §3.2.1, §4.8, §6.2, §8 |

## 2. Reconciliação com o contrato E0 (Serviços e Visuais)

| Critério | E0 §7 (mestre §5) | E0 §13 (decisão aprovada) | D3A | D3B |
|---|---|---|---|---|
| Serviços, produtos, descrição e atributos | **misto** — "site prova oferta; só o Google prova cadastro" | critérios mistos; cada evidência mantém a origem | todos nativos; site só contexto (**divergia do E0**) | **S1–S4 nativos (9 pts)** + **S5 oferta em fonte própria (3 pts)** |
| Fotos, vídeos e identidade visual | "nativo, distinguindo fontes externas" | critérios mistos | todos nativos (**divergia do E0**) | **V1–V4 nativos (8 pts)** + **V5 presença visual em fonte própria (2 pts)** |
| Publicações e atividade | nativo (redes = evidência externa distinta) | nativo | nativo | nativo; atividade de redes **não pontua** (só contexto) |
| NAP / Conversão | misto | — | misto | misto (N1–N4 e X1/X3/X5 nativos; N5 cruza fontes; X2/X4 site) |

**Resolução proposta:** adotar o E0 (critérios mistos). Cada subcritério declara **uma** fonte que o comprova. Um subcritério externo (S5, V5) mede *o que a fonte externa prova* (a oferta ou as imagens existem nas páginas lidas), jamais "o que está cadastrado no Google". Um achado no site **nunca** preenche, confirma ou dispensa o subcritério nativo equivalente: fotos do site não pontuam V2; produtos do site não pontuam S2/S4; serviços do site não pontuam S2. Se o nativo não foi lido, ele fica N/V mesmo com o externo completo. Em `methodology.ts` isso corresponde a `requiresGoogleNativeProof` (atributos `google_*`) para S1–S4/V1–V4 e a atributos externos novos (a definir na Onda 6A) para S5/V5.

## 3. Modelo de evidência e estados

### 3.1 Estados de um subcritério `PROPOSTA`
Cada subcritério está, em cada auditoria, em **exatamente um** estado: `avaliados + N/A + Amostra insuficiente + N/V = máx.`
| Estado | Pontos obtidos | Pontos avaliados | Quando |
|---|---|---|---|
| **Evidência completa, desempenho intermediário** | 0,5 … (máx. − 0,5) | = máx. | valor lido por inteiro, cai em uma faixa intermediária |
| **Evidência completa, desempenho máximo** | = máx. | = máx. | idem, faixa máxima |
| **Ausência comprovada** | 0 | = máx. | leitura **de escopo suficiente da fonte apropriada** (§3.2) mostra a ausência |
| **Não aplicável** (N/A) | 0 | **0** | causa da lista fechada (§3.4), com registro completo |
| **Amostra insuficiente** (`SAMPLE_INSUFFICIENT`) | 0 | **0** | o dado existe e é **verificado e exibido**, mas a amostra é pequena demais para pontuar o subcritério (R1 com 1–4 avaliações; L1/L2 com concorrentes insuficientes) |
| **Não verificado** (N/V) — inclui **evidência incompleta** | 0 | **0** | evidência incompleta ou ausente; não fundamenta pontuação nem zero; a lacuna é listada |
`FONTE` (D2): N/V sai do denominador e **não é zero**. "Não encontrado" é só observação: nunca vira zero.
**Quem é quem entre os que não pontuam:** *N/V* = falta dado ou leitura; *Amostra insuficiente* = há dado, não há base estatística; *N/A* = o subcritério não existe para este negócio; *zero comprovado* = leitura suficiente mostra que o elemento não existe. Os quatro são distintos no relatório.

### 3.2 Leitura suficiente depende da fonte do subcritério `PROPOSTA`
| Fonte do subcritério | "Leitura suficiente" (necessária para zero e para faixa) | Não é suficiente (⇒ N/V) |
|---|---|---|
| **Google nativo** | o campo/lista é exposto pela fonte (captura do provedor, exportação ou print autorizado) e foi lido por inteiro | provedor não expõe o campo; lista truncada; texto relativo; erro; resposta vazia por falha |
| **Site oficial** | depende do **escopo registrado** — ver §3.2.1 | escopo `NONE`, `ROOT_ONLY`, `PARTIAL` ou `FIRST_LEVEL_COMPLETE` para qualquer afirmação de ausência ou de faixa intermediária de contagem |
| **Rede social / cadastro / terceiro** | fonte específica lida com 2xx e identidade corroborada (nome + cidade ou CNPJ), ou captura datada do operador; ausência exige o protocolo de busca registrado (§4.9, L3) | página inacessível; homônimo não corroborado; uma única busca sem registro |
| **Operador** | registro com autor, data, justificativa (≥ 20 caracteres) e vínculo ao subcritério | confirmação sem justificativa |
| **Concorrentes** | amostra elegível (§5.1) | menos de 3 elegíveis (⇒ Amostra insuficiente) |
Por isso o zero de V2 exige a **lista nativa** (não o site), o zero de X4 exige **escopo suficiente e documentado do site** (não o perfil) e o zero de L3 exige o **protocolo de busca** nas fontes externas.

#### 3.2.1 Escopo de leitura de sites (ajuste 1)
**Registro obrigatório (`readScope`)** em toda evidência de site, a partir das requisições **efetivamente feitas** (não do que se pretendia ler): lista de páginas lidas (URL pedida, URL final, status, bytes, SHA-256, horário); limite de requisições do coletor e se foi atingido; bloqueios (401/403/desafio/robots/timeout); uso do sitemap (URLs listadas × URLs lidas); e o tipo de escopo:
| `scopeKind` | Significado |
|---|---|
| `NONE` | nada lido (bloqueio ou erro) |
| `ROOT_ONLY` | só a página inicial |
| `PARTIAL` | página inicial + algumas páginas, sem cobrir todos os links de 1º nível |
| `FIRST_LEVEL_COMPLETE` | página inicial + todas as páginas de 1º nível linkadas nela, dentro do limite e sem bloqueio |
| `SITEMAP_COMPLETE` | sitemap lido e todas as URLs listadas lidas (dentro do limite e sem bloqueio). **Sozinho não comprova** que todas as páginas ou funcionalidades do domínio foram verificadas (o sitemap pode omitir páginas, conteúdo dinâmico e recursos) |
| `DOCUMENTED_FULL_REVIEW` | revisão completa registrada pelo operador (escopo, método, páginas ou consultas, data, justificativa); evidência **secundária** |
**O que cada escopo comprova:**
| Escopo | Comprova | Não comprova |
|---|---|---|
| `ROOT_ONLY`, `PARTIAL`, `FIRST_LEVEL_COMPLETE` | **fatos observados nas páginas lidas** (cada fato cita a URL) e o **limite inferior** de contagens ("pelo menos N") | ausência de recurso no domínio; faixa intermediária de contagem; zero |
| `SITEMAP_COMPLETE` ou `DOCUMENTED_FULL_REVIEW` **+ atestado do operador de suficiência para o subcritério** (= **escopo suficiente**) | tudo acima + ausência e contagem **"no escopo documentado"** ("nas N URLs do sitemap", "nas páginas e funcionalidades revisadas") | ausência fora do escopo documentado (o relatório diz isso); sem atestado, `SITEMAP_COMPLETE` vale como escopo limitado |
**Efeito nos subcritérios que dependem de site (nunca zero por ausência global):**
| Sub. | Escopo limitado (`NONE` … `FIRST_LEVEL_COMPLETE`, ou sitemap sem atestado) | Escopo suficiente (com atestado) |
|---|---|---|
| S5 oferta própria | ≥ 5 ofertas observadas ⇒ 3; senão **N/V** | 1–4 ⇒ 1,5; 0 ⇒ 0 |
| V5 presença visual (com confirmação do operador) | ≥ 2 tipos de imagem real ⇒ 2; senão **N/V** | 1 tipo ⇒ 1; 0 ⇒ 0 |
| X4 jornada | 3 elementos observados ⇒ 3; senão **N/V** | k elementos ⇒ k (0 ⇒ 0) |
| X2 site acessível | fato sobre a **URL configurada** (status da resposta); 404/410/5xx persistente ⇒ 0 é zero **da URL**, não do domínio; 401/403/desafio/timeout ⇒ N/V | idem |
| N5 consistência | medida **entre o perfil e as fontes/páginas listadas** (o relatório lista quais); exige ≥ 2 campos comparáveis | idem |
| L3 prova externa | ver protocolo de busca (§4.9) | idem |
**Texto obrigatório no relatório:** "observado em *N* páginas lidas (lista); não representa o domínio inteiro", ou "no escopo documentado: …". A regra anterior "raiz + 3 páginas" **foi retirada como critério de suficiência**; resta apenas como descrição do escopo típico do coletor atual (até 8 requisições). Com esse limite, o escopo suficiente será raro: **N/V é o resultado normal** dos subcritérios de site, e zeros de site só aparecem com escopo documentado e atestado do operador (ou coleta ampliada, que depende de D5).

### 3.3 Regras auxiliares `PROPOSTA`
- **Contagem incompleta:** se a lista lida pode estar truncada, o subcritério só pontua quando o **limite inferior já alcança a faixa máxima** (ex.: ≥ 4 posts nos últimos 90 dias); senão N/V.
- **Datas:** só pontuam datas com precisão de dia. Texto relativo ("há 3 meses") só pontua se os limites inferior e superior estimados caem na **mesma faixa**; senão N/V.
- **Observações no tempo (ajuste 5):** cada observação tem data (`observedAt`) e origem. Observações de datas distintas são **observações distintas**, nunca "o mesmo dado corrigido". Só observações de **captura armazenada** (ou leitura/print com hash) fundamentam pontos; valores de **relatórios antigos em PDF** são históricos e **não fundamentam pontos**. Comparar datas é descritivo ("em 07/10 constava X; em 22/10 consta Y") e **não infere causa**.
- **Julgamento humano sem IA:** C2, C3 (coerência), P3 e V5 só pontuam com confirmação registrada do operador (quem, quando, justificativa). Nenhum ponto vem de texto gerado por IA.
- **Conflito entre fontes:** (1) atributo nativo: o nativo prevalece sobre o externo; (2) duas capturas nativas: a mais recente prevalece, a antiga fica no histórico; (3) mesmo nível e mesma data, valores distintos: N/V + `CONFLICT_OPEN` (rebaixa a confiança); (4) divergência de NAP entre perfil e fontes externas **não é conflito a resolver**: é o objeto de N5.
- **Fonte externa nunca comprova atributo nativo** (`FONTE`): site e redes só entram como contexto do nativo.

### 3.4 Não aplicável — lista fechada e registro obrigatório `PROPOSTA` (ajuste 4)
| Código | Quando | Atinge | Evidência da causa |
|---|---|---|---|
| `NO_REVIEWS_PROVEN` | 0 avaliações comprovadas na leitura nativa | R1, R3, L1, P1–P3 | total = 0 lido |
| `NO_REPLIES_PROVEN` | avaliações existem e nenhuma tem resposta (leitura suficiente, campo de resposta exposto) | P3 | campo presente e vazio |
| `NO_WEBSITE_PROVEN` | campo "website" lido e vazio | X2, X4, X5 | campo nativo lido |
| `FEATURE_UNAVAILABLE` | recurso inexistente para a categoria/tipo de perfil (atributos, Posts) | S3, A1–A3 | print/documentação ou confirmação do operador |
| `BUSINESS_MODEL` | modelo de negócio sem o elemento (ex.: não vende produtos) | S4 | confirmação do operador |
| `NO_ADDITIONAL_NEEDED` | a categoria principal cobre toda a atividade | C3 | confirmação do operador |
**Registro obrigatório de cada N/A:** `{subcriterionId, code, justification (≥ 20 caracteres), causeEvidenceIds (obrigatório), recordedBy, recordedAt}`. Sem qualquer campo, com código fora da lista ou com causa contrariada pela evidência ⇒ **recusado** (N/A não é escolha por falta de dado: isso é N/V).
**N/A não eleva cobertura nem índice (validado):**
1. N/A **não soma à cobertura** (a cobertura continua Σavaliados/100).
2. Para o índice, N/A e N/V são **idênticos** (ambos fora de `O` e de `E`): trocar qualquer N/A por N/V não muda cobertura nem índice (500 casos aleatórios, §9).
3. O relatório exibe a lista de N/A com justificativa, o **peso N/A** e a **sensibilidade**: "índice se os N/A fossem zero" = `O ÷ (E + W_na) × 100`, e o peso N/A entra no fator 6 da confiança (§6.3).
4. A única forma de N/A "ajudar" seria esconder um zero verdadeiro; por isso as causas exigem prova (leitura nativa, print ou confirmação registrada) e ficam visíveis.

## 4. Matriz final dos nove critérios

Fontes: **Nat** = Google nativo · **Site** · **Ext** = fonte própria/pública (rede, cadastro) · **Op** = confirmação do operador · **Comp** = concorrentes. Passo de pontos: 0,5. Intervalos escritos de modo que **cada valor caia em uma única faixa** (verificado por varredura, §9). Todos os valores numéricos de faixa são `PROPOSTA`.

### 4.1 Dados essenciais e consistência NAP — peso 15 (misto)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A |
|---|---|---|---|---|---|
| N1 | Nome do perfil presente | 3 | Nat | presente 3 | ausente comprovado 0 |
| N2 | Endereço ou área de atendimento | 3 | Nat | logradouro+nº+cidade+UF, ou área declarada 3 · logradouro e cidade, faltando nº 1,5 · nenhum 0 | texto indecidível por regra ⇒ N/V; área de serviço sem endereço: vale a área |
| N3 | Telefone | 3 | Nat | presente 3 | ausente 0 |
| N4 | Horários | 2 | Nat | 7 dias (ou 24 h/fechado explícito) 2 · 1 a 6 dias 1 · nenhum 0 | — |
| N5 | Consistência entre fontes (nome, endereço, telefone, horário) | 4 | Nat × Site/Ext | D = nº de campos divergentes **nas fontes listadas**: D=0 → 4 · D=1 → 2,5 · D=2 → 1 · D≥3 → 0 | N/V se < 2 campos comparáveis em ≥ 1 fonte externa lida; comparação normalizada (dígitos, caixa, acentos); ambíguo ⇒ N/V; o operador pode registrar equivalência de nomes (justificada); o relatório lista as fontes/páginas comparadas (escopo declarado) |
Soma: 3+3+3+2+4 = **15**. O website do perfil **não** pontua aqui (X1).

### 4.2 Categorias e relevância comercial — peso 10 (nativo)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A |
|---|---|---|---|---|---|
| C1 | Categoria principal definida | 3 | Nat | definida 3 | ausente 0 |
| C2 | Compatibilidade da principal com a atividade real | 4 | Nat + Op | compatível 4 · parcialmente (genérica/próxima) 2 · incompatível 0 | sem confirmação registrada ⇒ N/V |
| C3 | Categorias adicionais: relevância e coerência (**sem limite de quantidade**) | 3 | Nat + Op | lista nativa lida e todas pertinentes (qualquer quantidade ≥ 1) 3 · maioria pertinente, ≥ 1 incoerente 1,5 · maioria incoerente 0 | lista não lida ⇒ N/V; 0 adicionais: operador registra "nenhuma necessária" ⇒ **N/A** (`NO_ADDITIONAL_NEEDED`); registra que faltam ⇒ **0**; sem registro ⇒ N/V |
Soma: 3+4+3 = **10**.

### 4.3 Serviços, produtos, descrição e atributos — peso 12 (misto)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A |
|---|---|---|---|---|---|
| S1 | Descrição nativa | 2 | Nat | ≥ 250 caracteres 2 · 1–249 → 1 · 0 → 0 | — |
| S2 | Serviços/itens cadastrados no Google | 3 | Nat | ≥ 5 → 3 · 3–4 → 2 · 1–2 → 1 · 0 → 0 | listagem não exposta ⇒ N/V |
| S3 | Atributos do perfil | 2 | Nat | ≥ 3 → 2 · 1–2 → 1 · 0 → 0 | N/A `FEATURE_UNAVAILABLE` |
| S4 | Produtos cadastrados no Google | 2 | Nat | ≥ 3 → 2 · 1–2 → 1 · 0 → 0 | N/A `BUSINESS_MODEL` |
| S5 | **Oferta pública em fonte própria** (ofertas nomeadas distintas, com a URL de cada observação) | 3 | Site/Ext | **escopo limitado:** ≥ 5 observadas → 3, senão N/V · **escopo suficiente:** ≥ 5 → 3 · 1–4 → 1,5 · 0 → 0 | contagem só por detector validado ou confirmação do operador, senão N/V; **nunca zero por ausência global** (§3.2.1) |
Soma: 2+3+2+2+3 = **12** (9 nativos + 3 externos).

### 4.4 Avaliações e reputação — peso 18 (nativo)
Três coisas ficam **separadas** (ajuste 2): a **nota exibida pelo Google** (dado verificado, sempre preservado e mostrado), a **quantidade de avaliações** (dado verificado) e a **elegibilidade estatística** para pontuar R1 (regra `n ≥ 5`). Dado verificado **não** é ponto.
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A / Amostra |
|---|---|---|---|---|---|
| R1 | Nota média | 6 | Nat | [4,8; 5,0] 6 · [4,5; 4,8) 5 · [4,2; 4,5) 4 · [4,0; 4,2) 3 · [3,5; 4,0) 2 · [3,0; 3,5) 1 · < 3,0 → 0 | `n ≥ 5` ⇒ pontua; **`1 ≤ n ≤ 4` ⇒ `SAMPLE_INSUFFICIENT` (`REVIEWS_BELOW_MIN_SAMPLE`)**: nota e quantidade continuam exibidas, 0 ponto avaliado, fora do denominador; `n = 0` ⇒ N/A `NO_REVIEWS_PROVEN`; nota não lida ⇒ N/V |
| R2 | Volume | 6 | Nat | ≥ 100 → 6 · [50; 100) 5 · [25; 50) 4 · [10; 25) 3 · [5; 10) 2 · [1; 5) 1 · 0 → 0 | 0 comprovado = 0 (quantidade é um fato, vale com qualquer n) |
| R3 | Recência da avaliação mais recente | 6 | Nat | 0–30 d → 6 · 31–90 → 4 · 91–180 → 2 · 181–365 → 1 · ≥ 366 → 0 | sem datas ⇒ N/V; `n = 0` ⇒ N/A |
Soma: 6+6+6 = **18**. O "contexto" das avaliações citado no mestre não é subcritério (D3B-14). Exemplo: 3 avaliações, nota 5,0 ⇒ relatório mostra "nota 5,0 · 3 avaliações (verificado)"; R1 = Amostra insuficiente; R2 = 1/6.

### 4.5 Respostas às avaliações — peso 8 (nativo)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A |
|---|---|---|---|---|---|
| P1 | Taxa de resposta | 4 | Nat | r ≥ 90 % → 4 · [70; 90) 3 · [50; 70) 2 · (0; 50) 1 · r = 0 → 0 | amostra ≥ 10 avaliações lidas (todas, se < 10) **com o campo de resposta exposto**; senão N/V |
| P2 | Tempo de resposta (mediana) | 2 | Nat | ≤ 7 d → 2 · (7; 30] → 1 · > 30 → 0 | ≥ 3 pares avaliação/resposta com data de dia; senão N/V; nenhuma resposta existe ⇒ 0 |
| P3 | Qualidade (revisão humana de ≥ 5 respostas) | 2 | Nat + Op | específicas/humanas 2 · genéricas ou mistas 1 · inadequadas 0 | sem revisão registrada ⇒ N/V; nenhuma resposta ⇒ N/A |
Soma: 4+2+2 = **8**.

### 4.6 Fotos, vídeos e identidade visual — peso 10 (misto)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A |
|---|---|---|---|---|---|
| V1 | Logo e capa no perfil | 2 | Nat | ambos 2 · um 1 · nenhum 0 | — |
| V2 | Fotos no perfil | 3 | Nat | ≥ 20 → 3 · 10–19 → 2 · 5–9 → 1 · 1–4 → 0,5 · 0 → 0 | contagem incompleta: regra do limite inferior |
| V3 | Vídeos no perfil | 1 | Nat | ≥ 1 → 1 · 0 → 0 | — |
| V4 | Recência da mídia nativa | 2 | Nat | ≤ 90 d → 2 · 91–365 → 1 · ≥ 366 ou sem mídia → 0 | sem data ⇒ N/V |
| V5 | **Presença visual em fonte própria** (imagens reais do negócio: local, produto/serviço em uso, equipe/processo) | 2 | Site/Ext + Op | **escopo limitado:** ≥ 2 tipos → 2, senão N/V · **escopo suficiente:** ≥ 2 → 2 · 1 → 1 · 0 → 0 | exige confirmação do operador de que as imagens são reais e próprias; sem ela, N/V; nunca zero por ausência global |
Soma: 2+3+1+2+2 = **10** (8 nativos + 2 externos).

### 4.7 Publicações e atividade — peso 8 (nativo)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A |
|---|---|---|---|---|---|
| A1 | Publicação **vigente** (datada ≤ 180 dias e, se oferta/evento, não expirada) | 3 | Nat | ≥ 1 vigente → 3 · existem publicações, nenhuma vigente → 1 · lista lida vazia → 0 | lista não exposta/inacessível ⇒ N/V; publicação sem data ⇒ vigência N/V |
| A2 | Recência da última publicação datada | 3 | Nat | 0–30 d → 3 · 31–60 → 2 · 61–90 → 1 · ≥ 91 ou lista vazia → 0 | sem datas ⇒ N/V |
| A3 | Frequência nos últimos 90 dias | 2 | Nat | ≥ 4 → 2 · 2–3 → 1 · 0–1 → 0 | lista truncada: limite inferior |
Soma: 3+3+2 = **8**. `FEATURE_UNAVAILABLE` ⇒ A1–A3 N/A. Conteúdo de blog/LinkedIn/Instagram **não** comprova Google Posts.

### 4.8 Conversão e jornada — peso 10 (misto)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A |
|---|---|---|---|---|---|
| X1 | **Website configurado no perfil** | 2 | Nat | informado 2 · campo lido e vazio → 0 | vazio ⇒ X2, X4, X5 N/A (`NO_WEBSITE_PROVEN`) |
| X2 | Site acessível (a URL configurada) | 1 | Site | 2xx/3xx final 1 · 404/410/5xx persistente 0 | **401/403/desafio/timeout ⇒ N/V**; o zero é da URL, não do domínio |
| X3 | Canais de contato/ação no perfil (telefone, WhatsApp, mensagens, reserva/pedido; **website não conta**) | 2 | Nat | ≥ 3 → 2 · 2 → 1,5 · 1 → 1 · 0 → 0 | contagem incompleta: limite inferior só vale na faixa máxima |
| X4 | Jornada no site (elementos: chamada clara; catálogo/serviço; contato/compra) | 3 | Site | **escopo limitado:** 3 elementos observados → 3, senão N/V · **escopo suficiente:** k elementos → k | detector validado ou confirmação do operador; nunca zero por ausência global |
| X5 | **Marcação de campanha (UTM) na URL de destino do website configurada no perfil** | 2 | Nat (campo "website") | utm_source e utm_medium presentes → 2 · apenas parte dos parâmetros utm_* → 1 · URL lida sem nenhum utm_* → 0 (**exclusivamente porque se avalia o uso de UTM**) | URL não lida ou não verificada ⇒ N/V |
Soma: 2+1+2+3+2 = **10**.
**Interpretação de X5 (obrigatória no relatório):** analisa **apenas a string da URL do website salva no perfil** — não o link do Google Maps colado pelo operador, e não segue redirecionamentos. UTM presente indica marcação para atribuição; **UTM ausente não comprova ausência de rastreamento** (pode haver auto-tagging, GA4, GTM, redirecionador, rastreamento de chamadas). O 0 significa "nenhuma marcação UTM nesta URL" e vem com essa ressalva textual fixa; **nunca** se conclui ausência de rastreamento em geral. Decisão final (D3B-8): ausência comprovada = 0; URL não verificada = N/V.

### 4.9 Autoridade local e competitividade — peso 9 (externo)
| Id | Subcritério | Máx | Fonte | Faixas | Zero / N/V / N/A / Amostra |
|---|---|---|---|---|---|
| L1 | Nota frente aos concorrentes | 3 | Comp | x ≥ maior → 3 · mediana ≤ x < maior → 2 · mínimo ≤ x < mediana → 1 · x < mínimo → 0 | empresa com 1–4 avaliações ⇒ `SAMPLE_INSUFFICIENT` (`REVIEWS_BELOW_MIN_SAMPLE`); menos de 3 elegíveis ⇒ `SAMPLE_INSUFFICIENT` (`COMPETITOR_SAMPLE_BELOW_MIN`); empresa sem avaliações ⇒ N/A |
| L2 | Volume de avaliações frente aos concorrentes | 3 | Comp | x ≥ maior → 3 · mediana ≤ x < maior → 2 · mediana/2 ≤ x < mediana → 1 · x < mediana/2 → 0 | menos de 3 elegíveis ⇒ `SAMPLE_INSUFFICIENT` (`COMPETITOR_SAMPLE_BELOW_MIN`); x = 0 ⇒ 0 |
| L3 | Prova externa de autoridade: tipos corroborados entre **site oficial, rede ativa, cadastro oficial, terceiro independente** | 3 | Ext | ≥ 2 tipos → 3 (limite inferior) · 1 tipo → 1,5 · 0 → 0 **somente com protocolo de busca registrado nas quatro classes** (método, consulta, data de cada uma) | sem protocolo completo: 1 tipo ou 0 ⇒ N/V; fontes só citadas e não lidas ⇒ N/V |
Soma: 3+3+3 = **9**.

### 4.10 Resumo e soma
| Critério | Peso | Subcritérios | Soma |
|---|---|---|---|
| Dados essenciais e consistência NAP | 15 | N1 3 · N2 3 · N3 3 · N4 2 · N5 4 | 15 |
| Categorias e relevância comercial | 10 | C1 3 · C2 4 · C3 3 | 10 |
| Serviços, produtos, descrição e atributos | 12 | S1 2 · S2 3 · S3 2 · S4 2 · S5 3 | 12 |
| Avaliações e reputação | 18 | R1 6 · R2 6 · R3 6 | 18 |
| Respostas às avaliações | 8 | P1 4 · P2 2 · P3 2 | 8 |
| Fotos, vídeos e identidade visual | 10 | V1 2 · V2 3 · V3 1 · V4 2 · V5 2 | 10 |
| Publicações e atividade | 8 | A1 3 · A2 3 · A3 2 | 8 |
| Conversão e jornada | 10 | X1 2 · X2 1 · X3 2 · X4 3 · X5 2 | 10 |
| Autoridade local e competitividade | 9 | L1 3 · L2 3 · L3 3 | 9 |
| **Total** | **100** | | **100** |

### 4.11 Situações-limite (H e ajustes)
| Situação | Resultado |
|---|---|
| Perfil **sem avaliações** (0 comprovado) | R2 = 0 (avaliado); R1, R3, L1, P1–P3 = N/A `NO_REVIEWS_PROVEN` ⇒ REVIEWS 0/6, REPLIES fora |
| **1 a 4 avaliações** (ex.: 3, nota 5,0) | nota e quantidade exibidas como dado verificado; R1 = Amostra insuficiente; R2 pontua (1/6); R3 pontua se houver datas; L1 = Amostra insuficiente |
| Avaliações existem, **nenhuma respondida** (leitura suficiente e campo de resposta exposto) | P1 = 0, P2 = 0 (avaliados); P3 = N/A `NO_REPLIES_PROVEN` ⇒ REPLIES 0/6 |
| Avaliações existem, **o provedor não expõe o campo de resposta** | P1–P3 = N/V (não é zero) |
| Respostas existem, **sem datas** utilizáveis | P2 = N/V; P1 pontua se a taxa é decidível |
| **Ausência comprovada de publicações** (lista nativa lida e vazia) | A1 = A2 = A3 = 0 ⇒ POSTS 0/8 |
| Publicações **só antigas ou expiradas** | A1 = 1, A2 = 0, A3 = 0 ⇒ 1/8 |
| Lista de publicações **não exposta** / recurso inacessível | A1–A3 = N/V |
| **Site com leitura limitada** (raiz, parcial ou 1º nível) | só faixa máxima observada ou N/V; **nunca** zero por ausência global (§3.2.1) |
| **Site bloqueado** (401/403/desafio) | escopo `NONE` ⇒ N5 (fonte), S5, V5, X2, X4 = N/V |
| Subcritério **não aplicável** | exclui o peso com registro completo (§3.4) |
| Coleta **não comprova** a ausência | N/V, nunca 0 |

## 5. Concorrentes — L1 e L2

### 5.1 Amostra elegível `PROPOSTA`
Concorrentes com critério de equivalência documentado (mesmo município/categoria/intenção, ≥ 2 elementos verificáveis cada), **nota e volume lidos no Google nativo** e **≥ 5 avaliações**. Menos de **3** elegíveis ⇒ L1 e L2 em **Amostra insuficiente** (`COMPETITOR_SAMPLE_BELOW_MIN`). A empresa precisa de ≥ 5 avaliações em L1 (a mesma barreira de R1; senão `REVIEWS_BELOW_MIN_SAMPLE`). Mediana: valor central; com número par de elegíveis, média dos dois centrais (aritmética exata).

### 5.2 L1 — faixas mutuamente exclusivas (x = nota da empresa; M = maior; m = mediana; μ = menor)
`x ≥ M → 3` · `m ≤ x < M → 2` · `μ ≤ x < m → 1` · `x < μ → 0`.
| Caso (amostra) | x | L1 | Observação |
|---|---|---|---|
| todos iguais [4,8; 4,8; 4,8] | 4,8 | 3 | empata com o maior ⇒ topo |
| todos iguais [4,8; 4,8; 4,8] | 4,7 | 0 | abaixo do mínimo |
| topo empatado [4,9; 4,9; 4,5] | 4,9 | 3 | |
| [4,9; 4,5; 4,3] | 4,5 | 2 | igual à mediana, abaixo do topo |
| [4,9; 4,5; 4,3] | 4,3 | 1 | igual ao mínimo, abaixo da mediana |
| [4,9; 4,5; 4,3] | 4,2 | 0 | abaixo do mínimo |
| mediana = mínimo < topo [3; 3; 5] | 3 | 2 | faixa "1" vazia (μ = m) — consistente |
| mediana = topo > mínimo [5; 5; 3] | 3 | 1 | faixa "2" vazia (m = M) |
Verificado por enumeração (todas as amostras de 3 a 5 valores): exatamente **uma** faixa por valor e pontuação **monotônica** em x.

### 5.3 L2 — volume (a mediana nunca é 0)
`x ≥ M → 3` · `m ≤ x < M → 2` · `m/2 ≤ x < m → 1` · `x < m/2 → 0`; `x = 0 ⇒ 0`.
Como só entram concorrentes com ≥ 5 avaliações, `m ≥ 5`. Regressão D3A: volume 0 contra [0; 0; 0] dava **3**; na D3B os três concorrentes são inelegíveis ⇒ **Amostra insuficiente**. Exemplo: x = 24 contra [5; 93; 263] (m = 93; m/2 = 46,5) ⇒ **0**.

## 6. Fórmulas e publicação

### 6.1 Aritmética `FONTE` + `PROPOSTA`
- `avaliados_i` = Σ máx. dos subcritérios com ponto (faixa ou zero comprovado); `obtidos_i` = Σ pontos; invariantes `FONTE`: `0 ≤ obtidos_i ≤ avaliados_i ≤ peso_i`, e (partição) `avaliados_i + N/A_i + Amostra_i + N/V_i = peso_i`.
- `O = Σ obtidos`, `E = Σ avaliados`, `W_na = Σ máx. dos N/A`, `W_am = Σ máx. dos Amostra insuficiente`.
- **Cobertura global** (fórmula aprovada) = `E ÷ 100 × 100` = `E` %.
- **Índice** = `O ÷ E × 100` (aritmética exata em meios-pontos); exibido por **arredondamento meio-para-cima** (74,5 → 75); classe calculada sobre o **inteiro exibido**.
- Classes: 0–39 Crítico · **40–59 Fraco** (`INDÍCIO`) · 60–74 Em desenvolvimento · 75–89 Forte · 90–100 Referência local (`FONTE` exceto a faixa 40–59).
- `E = 0` ⇒ **índice indisponível** (nunca 0).

### 6.2 Cobertura mínima e estados de publicação (decisão final do usuário, ajuste 3)
| Estado | Condição | Exibição |
|---|---|---|
| `NO_DATA` | E = 0 | índice indisponível |
| `INSUFFICIENT` | **cobertura < 40 %**, ou < 3 critérios com pontos avaliados, ou sem NAP/Avaliações entre eles | **índice indisponível**; mostra critérios avaliáveis, dados verificados e lacunas |
| `PROVISIONAL` | **40 % a 64 %** e as condições mínimas | índice **explicitamente provisório**, não é relatório definitivo; cobertura e confiança sempre exibidas |
| `PUBLISHED` | **≥ 65 %** e as condições mínimas | índice **publicável**, **sempre com cobertura e confiança explícitas** e as limitações |
| `REJECTED` | invariante violada ou ponto sem evidência armazenada e íntegra | nenhum índice; erro registrado |
Condições mínimas **continuam obrigatórias**: ≥ 3 critérios com **pelo menos 3 pontos possíveis efetivamente avaliados** (`avaliados_i ≥ 3`, decisão final D3B-15; os pontos obtidos podem ser zero), entre eles NAP ou Avaliações (também com `avaliados_i ≥ 3`); **integridade**: invariantes válidas, todo ponto ligado a evidência **Verificada** armazenada com hash conferido, `methodologyVersion` e `rulerVersion` registradas, rótulo "Índice Lumos não é nota oficial do Google". Número de evidências verificadas **não** é número de critérios avaliados: a cobertura conta pontos.
**Registro de contraste (corrigido):** o agente original **publicou índices provisórios com cobertura inferior a 40 %** em determinados relatórios: **VRA** (07/10/2026, cobertura 26 %, base 14/26, índice 54 "pontuação provisória") e **<CLIENTE_B>** (21/10/2026, cobertura **11 %**, base 7/11, índice 64 "pontuação provisória"). Os demais PDFs lidos tinham cobertura de 52 % a 58 % (<CLIENTE_B> 07/10: 52 %; <CLIENTE_C>, 16 unidades e 4 variantes: 55 %; AUD-001 07/10: 57 %; Lumos Marketing: 58 % exibida, 74 % pela soma) ou 81 % exibida/100 % pela soma (Rio Radical). **Diferença entre a metodologia histórica e a regra atual:** o histórico publicava um índice provisório mesmo com 11 % ou 26 % de cobertura e com apenas 2–3 critérios parcialmente avaliados (no relatório de 21/10/2026 só NAP, Conversão e Autoridade, com 6, 3 e 2 pontos avaliados); a regra atual exige cobertura ≥ 40 %, ≥ 3 critérios com ≥ 3 pontos avaliados (incluindo NAP ou Avaliações) e integridade, e abaixo disso declara o índice **indisponível**. É uma **escolha conservadora da versão reconstruída**, não uma regra do agente original.

### 6.3 Confiança composta determinística (ajuste 4)
Confiança final = **a menor** entre seis fatores (Alta > Média > Baixa). Nenhum fator sozinho concede "Alta". Todas as comparações usam **aritmética exata** (frações), sem arredondar antes de comparar; limiares são fechados nos lados indicados.
| # | Fator | Entrada (campo) | Fórmula | Alta | Média | Baixa | Justificativa rastreável registrada |
|---|---|---|---|---|---|---|---|
| 1 | Cobertura global | `E` | `E` % | ≥ 90 | 65 – 89 | 40 – 64 | valor de `E` e os subcritérios avaliados (ids) |
| 2 | Amplitude | por critério: `avaliados_i`, `N/A_i`, `peso_i` | `B` = nº de critérios com `peso_i − N/A_i > 0` e `2·avaliados_i ≥ peso_i − N/A_i` | B ≥ 7 | B 5–6 | B ≤ 4 | lista dos critérios que contaram e dos que não |
| 3 | Confiabilidade | origem de cada evidência | `Q` = 100 · Σ máx. dos subcritérios avaliados **cujas evidências são todas primárias** ÷ `E` | Q ≥ 90 | 60 ≤ Q < 90 | Q < 60 | ids dos subcritérios com evidência secundária e a origem de cada uma |
| 4 | Atualidade | `observedAt` de cada evidência vs. data do snapshot | `T` = 100 · Σ máx. dos subcritérios avaliados com **alguma** evidência > 90 dias ÷ `E` (> 180 dias não fundamenta pontos) | T ≤ 10 | 10 < T ≤ 40 | T > 40 | ids, datas e idade em dias |
| 5 | Conflitos | registros `CONFLICT_OPEN` | `K` = nº de conflitos abertos | K = 0 | K = 1–2 | K ≥ 3 | cada conflito: subcritério, fontes, valores, datas |
| 6 | Peso não aplicável | registros de N/A | `W_na` = Σ máx. dos N/A | ≤ 15 | 16 – 30 | > 30 | cada N/A: código, justificativa, evidência da causa |
**Tabelas fechadas usadas:**
- *Tipo de captura → primária/secundária/nenhuma (nomes do motor, Onda 6A):* `STORED_CAPTURE` (captura ou leitura do provedor/site armazenada, com SHA-256) e `OPERATOR_ATTACHMENT` (exportação/print do operador, com SHA-256) = **primária**; `OPERATOR_STATEMENT` (declaração sem anexo) e `AGGREGATOR` (agregador de terceiros) = **secundária**; `PREVIOUS_AUDIT_PDF` = **nenhuma** (não fundamenta pontos). Um subcritério que dependa de **data relativa** estimada ou de revisão `DOCUMENTED_FULL_REVIEW` conta como **secundário** na confiabilidade. Confirmações humanas qualificadas (juízo, atestado, equivalência) não rebaixam o grau: o grau vem da evidência factual que elas qualificam.
- *Idade (dias inteiros entre `observedAt` e a data do snapshot):* ≤ 90 fresca · 91–180 envelhecida · > 180 não fundamenta (o subcritério vira N/V). Evidência sem `observedAt` é inválida (⇒ N/V).
**Determinismo e rastreabilidade:** o resultado depende só das entradas acima (independe da ordem dos subcritérios); o relatório grava, para cada fator, `{valor, nível, limiar, ids de evidência}` e lista o(s) **fator(es) limitante(s)** (os de nível igual ao mínimo). O texto de justificativa vem de **modelo fixo por fator e nível**, nunca de texto livre nem de IA. Também exibidos, **sem alterar a cobertura aprovada**: peso N/A, peso em Amostra insuficiente e **cobertura dos elegíveis** = `E ÷ (100 − W_na)`.

### 6.4 Não aplicável e Amostra insuficiente — efeitos (resumo)
| Estado | Soma à cobertura? | Altera o índice? | Aparece no relatório | Entra na confiança |
|---|---|---|---|---|
| N/A | não | não (idêntico a N/V) | lista com código, justificativa e evidência; sensibilidade "se fossem zero" | fator 6 (`W_na`) e fator 2 (reduz o peso elegível do critério) |
| Amostra insuficiente | não | não (idêntico a N/V) | dado verificado exibido + código + peso | peso `W_am` exibido (sem fator próprio) |
| N/V | não | não | lacuna listada | indiretamente, via cobertura e amplitude |

## 7. Aplicação à AUD-001 — somente dados preservados, **sem nota**

Base: `aud-001-autorizacao-01` (somente leitura): 19 evidências, **8 Verificadas** e 11 Não verificadas; 1 chamada `/maps` (consumida); site respondeu 401/403/desafio ⇒ **escopo de leitura `NONE`**; nenhum concorrente; nenhuma pontuação.

| Subcritério | Situação | Evidência preservada | Lacuna / como fechar |
|---|---|---|---|
| N1 nome · N2 endereço · N3 telefone | suficiente | `maps-name`, `maps-address`, `maps-phone` | — |
| N4 horários | suficiente (7 dias a conferir no campo) | `maps-hours` | — |
| N5 consistência | **N/V** | site não lido (`NONE`); `external-presence` N/V | leitura autorizada do site ou prints |
| C1 principal | suficiente | `maps-category` | — |
| C2 compatibilidade | N/V | sem confirmação do operador | operador confirma, com justificativa |
| C3 adicionais | N/V | `maps-secondary-categories` N/V | painel/prints |
| S1–S4 | N/V | `unavailable-services/attributes/products` | painel/prints |
| S5 oferta própria | N/V | escopo `NONE` | site lido (e, para faixa intermediária ou zero, escopo suficiente) |
| R1 nota · R2 volume | suficiente: **nota exibida 5,0 · 49 avaliações (dados verificados) · elegível (≥ 5)** | `maps-rating`, `maps-review-count` | — |
| R3 recência · P1–P3 | N/V | `unavailable-review-recency/replies` | Serper Reviews (exige autorização escrita) ou prints |
| V1–V4 · V5 | N/V | `unavailable-photos/videos`; V5 sem confirmação | painel/prints; operador |
| A1–A3 | N/V | `unavailable-posts` | painel/prints |
| X1 website do perfil | suficiente | `maps-website` | — |
| X2 acessível · X4 jornada | N/V | `site-reachable` N/V (escopo `NONE`) | leitura autorizada ou prints |
| X3 canais | N/V (só o telefone é verificado; lista de ações não exposta) | — | painel/prints |
| X5 UTM na URL do website | **elegível, ainda não calculada** | URL do campo "website" preservada | conferir offline na Onda 6A |
| L1–L3 | N/V (L1/L2 virariam Amostra insuficiente se houvesse < 3 elegíveis) | sem concorrentes; `external-presence` N/V | decisão D5 |

**Pontos avaliáveis (teto de cobertura com os dados atuais):** NAP 11 + CATEGORIES 3 + REVIEWS 12 + CONVERSION 2 = **28**; com X5 confirmada, **30** → cobertura prevista **28 %–30 %**, em **4 de 9 critérios com algum ponto avaliado** (e **3 ou 4 critérios com ≥ 3 pontos avaliados**: NAP 11, Categorias 3, Avaliações 12; Conversão só conta se X5 for confirmada, 4 pontos). Pelo mínimo de 40 %, o estado seria **`INSUFFICIENT` — índice indisponível**. As 8 evidências verificadas cobrem 4 critérios; cobertura é medida em pontos e o critério só conta para o mínimo com ≥ 3 pontos avaliados. (A D3A estimava 30–32 %; a diferença vem de N5 e X1 terem sido separados.)
**Caminho até ≥ 40 %, sem tocar na evidência:** leitura autorizada do site (N5 4 + X2 1 + X4 3 + S5 3, **supondo observações no nível máximo**, pois o escopo seria limitado) ⇒ até 39–41 %; confirmação do operador em C2 (+4) ⇒ 43–45 %. Só então haveria índice provisório. Como X4 e S5 só pontuam com observação no nível máximo se o escopo for limitado, o caminho é uma **estimativa de teto**, não uma promessa.
**Observações distintas no tempo (ajuste 5):** (A) **24 avaliações** — auditoria antiga do agente original, snapshot de **07/10/2026**, origem PDF, método de coleta desconhecido, **histórica e sem poder de fundamentar pontos**; (B) **49 avaliações** — captura Serper `/maps` de **22/10/2026**, armazenada com hash, **observação vigente**. São duas observações em datas diferentes; **a causa da diferença não é inferida** e nenhuma hipótese (amostra, crescimento, método) é adotada.

## 8. Comparação com os relatórios originais (hipótese de calibração, não regra)

### 8.1 O que é regra comprovada × observação dos PDFs
| Tema | `FONTE` (instruções) | `INDÍCIO` (PDFs do agente) | Esta proposta |
|---|---|---|---|
| Pesos dos nove critérios | sim | iguais | preservados |
| N/V exclui o peso; ≠ 0 | sim | declarado em todos | mantido |
| Cobertura = Σavaliados/100; índice = Σobtidos/Σavaliados | sim | usado | mantido |
| Site/redes não comprovam nativo | sim | "regra de integridade" em todos | mantido |
| Classes 0–39, 60–74, 75–89, 90–100 | sim | — | mantidas |
| 40–59 = "Fraco" | **não** | legenda "40–59 Fraco" (AUD-001), "0–59 Crítico/Fraco" (VRA) | proposta |
| Provisório abaixo de 65 % | **não** | "cobertura inferior a 65 %: pontuação provisória" | provisório entre 40 % e 64 % (decisão do usuário) |
| **Publicar índice com cobertura < 40 %** | **não** | **sim**: VRA (26 %, índice 54) e <CLIENTE_B> de 21/10/2026 (**11 %**, base 7/11, índice 64), ambos "provisórios" | **não publicar** (índice indisponível): escolha conservadora da versão reconstruída |
| Pontos avaliados parciais dentro do critério (ex.: 12 de 18) | pendente (R-13) | usado | adotado via subcritérios |
| Subcritérios, faixas, confiança numérica | **não existem** | só qualitativa (baixa 58 %, média 81 %) | proposta |

### 8.2 AUD-001 — o PDF de 07/10 × a régua D3B aplicada **aos fatos do PDF** (ilustração; **não** é a nota da AUD-001; o somatório não foi calculado de propósito)
Os fatos abaixo são os **do PDF de 07/10** (observação histórica, §7); a captura de 22/10 (49 avaliações) é outra observação e não foi misturada.
| Critério | PDF (obtidos/avaliados) | Régua D3B com os fatos do PDF | Divergência |
|---|---|---|---|
| NAP | 10,5/15 | N1–N4 = 11; N5: 3 campos divergentes (nome, endereço, horário) ⇒ 0 ⇒ **11/15** | ≈ igual; a régua não "descontou" por rótulo |
| Categorias | 9/10 | C1 3; C2 e C3 dependem de confirmação do operador (se confirmadas: 4 e 3) ⇒ 3/3 ou **10/10** | o PDF atribuiu julgamento do próprio agente |
| Serviços | N/V (critério inteiro fora) | S1–S4 N/V; S5: se o site tivesse ≥ 5 ofertas observadas ⇒ **3/3**; com menos, N/V | o PDF ignorou a parte externa do critério misto |
| Avaliações | 10,5/12 | R1 6 (5,0; 24 ≥ 5); R2 (24 → faixa [10;25)) 3; R3 N/V ⇒ **9/12** | −1,5; o PDF não explica |
| Respostas | N/V | N/V | igual |
| Visuais | 2,5/3 | V1–V4 N/V; V5 só com confirmação ⇒ N/V ou 2/2 | base do 3 do PDF não é reproduzível |
| Publicações | N/V | N/V | igual |
| Conversão | 7,5/8 | X1 N/V (o PDF diz que o vínculo do website não foi comprovado); X2 1; X4 3 se 3 elementos observados ⇒ **4/4** | avaliados 8 × 4 |
| Autoridade | 7,5/9 | L1 3 (5,0 ≥ 4,9); L2 0 (24 < 46,5); L3 3 ⇒ **6/9** | −1,5 |
Pontos avaliados nesta ilustração: 15+10+3+12+2+4+9 = 55 (PDF: 57). A ordem de grandeza é compatível; **as diferenças não foram "ajustadas" para imitar o PDF**.

### 8.3 Outros PDFs (observações estruturais)
- **<CLIENTE_C>** (47,5/55 → 86): NAP 12,5/15 × régua ≈ 12/15 (nome e CEP divergentes ⇒ D = 2 ⇒ N5 = 1); Avaliações 10,5/12 × régua 11/12 (4,8 · 75 ⇒ 6 + 5, R3 N/V); Conversão 8/10 avaliados 10, apesar de "website e WhatsApp vinculados: não verificado" ⇒ régua 4/4 (se X4 observar 3 elementos); Serviços fora no PDF × S5 só se ≥ 5 ofertas observadas (4 planos nomeados ⇒ N/V em escopo limitado); Autoridade 8/9: valores dos concorrentes não constam no PDF ⇒ L1/L2 não reproduzíveis.
- **<CLIENTE_B>, duas versões:** a de **07/10/2026** (33,5/52 → 64, cobertura 52 %) e a de **21/10/2026** (7/11 → 64, **cobertura 11 %**, só NAP 6/4, Conversão 3/2 e Autoridade 2/1; legenda "40–59 Fraco"; pela régua atual: índice indisponível e menos de 3 critérios com ≥ 3 pontos). Sobre a de 07/10: Avaliações 7/12 × régua 8/12 (4,5 · 18 ⇒ 5 + 3); Categorias 6,5/8 com "categoria principal não confirmada" ⇒ régua: C1 N/V.
- **VRA** (14/26 → 54, cobertura 26 %): NAP 6/9, Categorias 3/4, Conversão 2/4 e Autoridade 3/9 **apesar de nome, endereço, telefone, website e categoria estarem listados como N/V** na p. 3 ⇒ o PDF pontuou o que declara não verificado; nenhuma regra coerente com "N/V ≠ pontuar" o reproduz. Pela régua final, cobertura de 26 % ⇒ índice indisponível.
- **Lumos Marketing** (47/74 → 64, cobertura exibida 58 %) e **Rio Radical** (84/100, cobertura exibida 81 %): soma real = 74 % e 100 %; ambos pontuam categorias/fotos/publicações/respostas que o próprio texto diz não verificados (E0 C-10…C-12).
- Em Avaliações, o PDF dá o mesmo 10,5/12 a "5,0 · 24" e "4,8 · 75": nenhuma tabela monotônica em nota e volume reproduz isso.
Conclusão: **os PDFs não fornecem uma régua reproduzível**; servem como ordem de grandeza e como catálogo de erros a evitar (§9, regressões).

## 9. Validação matemática (offline, modelo de referência fora do projeto)
Scripts de referência no scratchpad da sessão (`d3b_check.py` e `d3b_rev_check.py`; não fazem parte do projeto, sem rede, sem arquivos do projeto); **todos os testes passaram**, inclusive a reexecução completa da validação anterior após os ajustes finais:
| Verificação | Resultado |
|---|---|
| Soma dos subcritérios de cada critério = peso; total = 100 | ok (9 critérios) |
| Website do perfil pontua em um único subcritério (X1) | ok |
| Faixas mutuamente exclusivas e exaustivas (R1, R2, R3, P1, P2, S1–S5, V2–V5, A2, A3, X3–X5, N4, N5, L3), passo 0,5, pontos ≤ máximo | 8007 valores varridos, ok |
| L1/L2: uma faixa por valor, monotônico em x, x = 0 ⇒ L2 = 0, empates e amostras iguais | 379 110 combinações, ok |
| Regressões D3A: L1 faixa 0 inalcançável; L2 com mediana 0 dando 3 | reproduzidas e eliminadas |
| Concorrentes acima / dentro / abaixo da amostra | 3 / 2 e 1 / 0 (§5.2) |
| **Escopo de sites:** S5, V5, X4 × 5 tipos de escopo | escopo limitado ⇒ só faixa máxima ou N/V, **nunca zero**; zero e faixa intermediária só em escopo suficiente; escopo `NONE` ⇒ N/V |
| **R1 / amostra:** n = 0, 1, 2, 3, 4, 5, 49 | 0 ⇒ N/A; 1–4 ⇒ Amostra insuficiente com nota e quantidade preservadas; 5 e 49 ⇒ faixa (5,0 ⇒ 6) |
| Amostra insuficiente é distinta de N/V, N/A e zero; recusada sem código/dado ou fora de R1/L1/L2 | ok (mesmo efeito numérico de N/V no denominador, registro próprio) |
| Concorrentes elegíveis (≥ 5 avaliações; ≥ 3 elegíveis) | ok |
| Cobertura 0, 39, 40, 64, 65, 89, 90, 100 | `NO_DATA`, `INSUFFICIENT`, `PROVISIONAL`, `PROVISIONAL`, `PUBLISHED`, `PUBLISHED`, `PUBLISHED`, `PUBLISHED`; < 3 critérios, sem NAP/Avaliações ou integridade falha continuam bloqueando; cobertura 26 % (caso VRA) ⇒ indisponível |
| **Seis fatores de confiança:** limiares exatos (40, 64, 65, 89, 90; B = 4/5/6/7; Q 59,9/60/89,9/90; T 10/10,1/40/40,1; K 0/1/2/3; W_na 15/16/30/31) | ok; resultado = mínimo; fator limitante identificado; 216 combinações determinísticas |
| Confiança não é Alta só por pontos avaliados | 95 pontos com só 50 % primários ⇒ Baixa (limitada por confiabilidade); 90 % com 1 conflito ⇒ Média; com 3 ⇒ Baixa; evidência antiga ⇒ Baixa; W_na = 34 ⇒ Baixa |
| **N/A neutro:** trocar N/A por N/V não muda cobertura nem índice | 500 casos aleatórios, ok; sensibilidade "se fossem zero" calculada |
| N/A recusado sem código fechado, sem justificativa ≥ 20 caracteres ou sem evidência da causa | ok |
| N/V com pontos é recusado; E = 0 ⇒ `NO_DATA` | ok |
| Arredondamento: 38,5→39 Crítico · 39,5→40 Fraco · 59,5→60 · 74,5→75 · 89,5→90 · 99,5→100 · 50,5/85→59 · 42/57→74 · 54,5/65→84 | ok |
| **Índice zero com exatamente 3 critérios** | **impossível publicar**: teto de pontos avaliados com índice 0 em 3 critérios = **37 %** (< 40 %) ⇒ `INSUFFICIENT` |
| Índice zero publicável | perfil novo (sem avaliações, posts, mídia, website, adicionais) com 7 critérios com algum ponto (**6 com ≥ 3 pontos avaliados**; NAP só tem 2), E = 40, O = 0 ⇒ `PROVISIONAL`, índice 0, Crítico, confiança Baixa, N/A = 26 |
| Sem NAP/Avaliações (E = 47) | `INSUFFICIENT` |
| Fontes contraditórias | captura nativa mais recente prevalece; mesma data e valores distintos ⇒ N/V + conflito aberto; NAP com 1 divergência e horários em conflito = 11,5/13 |
| **Observações no tempo:** 24 (PDF, 07/10) e 49 (captura, 22/10) | só a captura fundamenta pontos; PDF antigo = histórico; nenhum campo de causa |
| Critérios isolados | REVIEWS 17/18 · parcial 11/12 · sem avaliações 0/6 (+12 N/A) · REPLIES sem respostas 0/6 (+2 N/A) · POSTS vazio 0/8 · só antigos 1/8 · CATEGORIES sem adicional necessária 7/7 (+3 N/A) · 6 categorias coerentes 10/10 |
| AUD-001 | 28–30 pontos avaliáveis em 4 critérios ⇒ `INSUFFICIENT`; nenhuma nota |

## 10. Decisões já adotadas pelo usuário (a homologar com a régua)
| Decisão | Seção |
|---|---|
| Arredondamento meio-para-cima | §6.1 |
| 40–59 = Fraco | §6.1 |
| Índice sem dados = indisponível, nunca zero | §6.1, §6.2 |
| **Cobertura final:** < 40 % indisponível · 40–64 % provisório · ≥ 65 % publicável com cobertura e confiança explícitas; condições mínimas de critérios (≥ 3, incluindo NAP ou Avaliações) e integridade mantidas | §6.2 |
| **D3B-8 final:** UTM ausente comprovado = 0, só porque se avalia o uso de UTM; nunca conclui ausência de rastreamento; URL não verificada = N/V | §4.8 |
| **D3B-15 final:** critério avaliado = ≥ 3 pontos possíveis avaliados (obtidos podem ser 0) | §6.2 |
| **Sitemap sozinho não comprova o domínio:** zero só com escopo documentado + atestado do operador | §3.2.1 |
| Qualitativas só com justificativa e confirmação registradas | §3.3 |
| Nenhum ponto de informação inventada por IA | §3.3 |
| Fonte externa nunca comprova atributo nativo | §2, §3.3 |
| Escopo de leitura de sites; Não verificado quando limitada; nunca zero por ausência global | §3.2.1 |
| Nota exibida, quantidade e elegibilidade separadas; R1 com < 5 avaliações ⇒ Amostra insuficiente | §3.1, §4.4 |
| 24 (07/10) e 49 (22/10) são observações distintas; causa não inferida | §3.3, §7 |
Estas decisões **não substituem** a homologação final da régua (D3B-17).

## 11. Decisões D3B-1 a D3B-17 (texto exato, recomendação, impacto, prontidão, dependências)
Legenda de dependência: **D5** = decisão pendente de coleta/IA/concorrentes; **Coleta** = exige coleta adicional (painel/prints, site, Serper Reviews) para *aplicar* a regra a dados reais — a **regra** em si é homologável antes.
| # | Decisão (texto exato) | Regra recomendada | Impacto sobre a pontuação | Pronta para homologação? | Depende de D5 / coleta |
|---|---|---|---|---|---|
| D3B-1 | Aprovar a matriz final de subcritérios da §4 (9 critérios; Σ = 100): NAP N1–N5 = 3·3·3·2·4; Categorias C1–C3 = 3·4·3; Serviços S1–S5 = 2·3·2·2·3; Avaliações R1–R3 = 6·6·6; Respostas P1–P3 = 4·2·2; Visuais V1–V5 = 2·3·1·2·2; Publicações A1–A3 = 3·3·2; Conversão X1–X5 = 2·1·2·3·2; Autoridade L1–L3 = 3·3·3. | Aprovar | Define a distribuição dos 100 pontos; N5 recebe o ponto do website; AUD-001 hoje: 28–30 pontos avaliáveis | Sim | Não (aplicação depende de coleta) |
| D3B-2 | Resolver a divergência com o E0 §7/§13 tratando Serviços (9 nativos + 3 externos) e Fotos/vídeos/identidade visual (8 nativos + 2 externos) como critérios mistos; nenhum achado em site ou rede comprova automaticamente o elemento equivalente cadastrado no Google. | Aprovar | Move 5 pontos (S5 3 + V5 2) para observação externa; os 17 pontos nativos de S1–S4/V1–V4 seguem só com prova nativa; efeito atual na AUD-001: nenhum (site não lido) | Sim | Não |
| D3B-3 | Adotar o modelo de escopo de leitura de sites (§3.2.1): registrar o escopo efetivamente lido; páginas lidas comprovam apenas fatos observados nelas e o limite inferior de contagens; ausência e faixas intermediárias de contagem exigem escopo suficiente (sitemap integralmente lido ou revisão completa documentada, **mais** atestado do operador de que o escopo documentado basta para o subcritério; um sitemap sozinho não comprova o domínio); leitura limitada ⇒ Não verificado; nunca zero por ausência global. | Aprovar | Até 11 pontos (S5 3, V5 2, X4 3, L3 3) dependem do escopo; com escopo limitado só pontuam no nível máximo, senão ficam fora do denominador; zero de site quase inalcançável com o coletor atual (≤ 8 requisições); AUD-001: escopo `NONE` ⇒ 0 pontos de site | Sim (regra) | **Coleta** (ler o site) e **D5** (ampliar o coletor/sitemap) |
| D3B-4 | Adotar a lista fechada de causas de Não aplicável (§3.4) com registro obrigatório (código, justificativa ≥ 20 caracteres, evidência da causa, autor, data); N/A não soma à cobertura, não altera o índice em relação a N/V, e seu peso é exibido e entra na confiança (fator 6). | Aprovar | Cobertura e índice idênticos aos de N/V (validado); peso N/A > 15 limita a confiança a Média, > 30 a Baixa; sensibilidade "se fossem zero" exibida | Sim | Não |
| D3B-5 | Adotar a confiança composta determinística (§6.3): mínimo de seis fatores (cobertura, amplitude, confiabilidade, atualidade, conflitos, peso N/A), cada um com entrada, fórmula, limiar exato e justificativa rastreável registrados. | Aprovar | Não altera pontos, cobertura nem índice; define só o rótulo de confiança (Alta exige ≥ 90 % de cobertura, evidência primária, atualidade, 0 conflitos, W_na ≤ 15) | Sim | Não |
| D3B-6 | Concorrentes (§5): amostra elegível = ≥ 3 concorrentes equivalentes com nota e volume lidos no Google nativo e ≥ 5 avaliações cada; mediana (média dos dois centrais se par); L1 e L2 com as faixas mutuamente exclusivas da §5; amostra insuficiente ⇒ estado Amostra insuficiente. | Aprovar a regra | L1 + L2 = 6 pontos (6 %); sem amostra elegível ficam fora do denominador; AUD-001 hoje: fora (sem concorrentes) | Sim (regra) | **D5** (coleta e equivalência de concorrentes) |
| D3B-7 | R1 (nota média): preservar a nota exibida pelo Google e a quantidade de avaliações como dados verificados; pontuar R1 apenas com ≥ 5 avaliações; com 1 a 4 avaliações, R1 recebe o estado Amostra insuficiente (nem Não verificado, nem zero, nem Não aplicável): sai do denominador e a nota continua exibida. | Aprovar | Até 6 pontos (6 %) saem do denominador em perfis com 1–4 avaliações; AUD-001 (49): sem efeito, R1 pontuável | Sim | Não |
| D3B-8 | X5 analisa a URL de destino do website configurada no perfil (não o link do Maps): UTM completo = 2, parcial = 1, URL lida sem UTM = 0, com ressalva fixa de que isso não prova ausência de outro rastreamento (alternativa: ausência = Não verificado, UTM só soma). **Decisão final:** ausência comprovada = 0, exclusivamente porque se avalia o uso de UTM; nunca concluir ausência de rastreamento em geral; URL não verificada = Não verificado. | Ausência = 0 com ressalva | 2 pontos; ausência de UTM custa até 2 pontos avaliados | **Homologada** | Não |
| D3B-9 | X3 (canais de contato/ação do perfil): contam telefone, WhatsApp, mensagens e reserva/pedido; o website não conta (já pontua em X1). | Aprovar | 2 pontos; evita dupla contagem do website | Sim | **Coleta** (a lista de ações não vem do `/maps`; painel/prints) |
| D3B-10 | Publicações: vigência = datada há ≤ 180 dias e, se oferta/evento, não expirada; A1 = 3 (vigente), 1 (só antigas ou expiradas), 0 (lista lida vazia); lista não exposta = Não verificado. | Aprovar | 8 pontos (A1–A3); só antigas ⇒ 1/8 em vez de 0/8 | Sim | **Coleta** (Posts não vêm do `/maps`) |
| D3B-11 | Contagem incompleta: só pontua quando o limite inferior já alcança a faixa máxima; senão Não verificado (vale também para os subcritérios de site, §3.2.1). | Aprovar | Evita faixa intermediária falsa em S2, S5, V2, V5, X3, X4, A3; reduz cobertura quando listas são truncadas | Sim | Não |
| D3B-12 | Datas relativas ("há N meses") só pontuam se os limites inferior e superior estimados caem na mesma faixa; senão Não verificado. | Aprovar | Afeta R3, P2, A2, A3, V4 (15 pontos) quando a data é imprecisa | Sim | **Coleta** (datas vêm do Serper Reviews/painel) |
| D3B-13 | Formato da confirmação do operador (autor, data, justificativa ≥ 20 caracteres, subcritério, valor confirmado, anexo opcional com hash); o armazenamento fica para a Onda 6B. | Aprovar o formato | C2 4, C3 3, P3 2, V5 2 = 11 pontos só pontuam com esse registro; sem ele, N/V | Parcial — formato sim; **armazenamento ainda não desenhado** (6B) | Onda 6B |
| D3B-14 | O "contexto" das avaliações citado no mestre §5 não é subcritério da v1. | Aprovar | Nenhum ponto novo; Avaliações segue 18 em R1–R3 | Sim | Não |
| D3B-15 | "Critério avaliado" = critério com ≥ 3 pontos possíveis efetivamente avaliados (os obtidos podem ser zero). **Decisão final do usuário** (a alternativa de ≥ 1 ponto foi descartada). | ≥ 3 pontos avaliados | Só afeta o portão de publicação (≥ 3 critérios, incluindo NAP ou Avaliações); critérios com 1–2 pontos avaliados não contam | **Homologada** | Não |
| D3B-16 | Adotar as faixas numéricas (nota, volume, recência, respostas, fotos, posts, serviços) como v1 revisável após dados reais. | Aprovar | Define todos os pontos intermediários; revisão futura muda pontos sem mudar pesos | Sim (como v1 revisável) | Calibração real depende de **Coleta/D5** |
| D3B-17 | Homologação final da régua D3B revisada (`regua-d3b-r2`) e autorização da Onda 6A. | Só após D3B-1 a D3B-16 | Libera o motor puro da 6A | **Homologada e autorizada em 22/10/2026** | — |

## 12. Plano objetivo da Onda 6A (autorizada em 22/10/2026 e **implementada** como motor puro; ver `onda6a-motor-de-pontuacao.md`)
**Objetivo:** motor de pontuação **puro**, testado, **não conectado** à interface, ao armazenamento, ao PDF ou à coleta.
**Entregas:**
1. `src/lib/link-audit/scoring/` (sem I/O, rede, `process.env`, `fs`, Supabase, Redis, prospecção ou Juiz): `ruler.ts` (matriz como dados + `rulerVersion`), `tiers.ts` (faixas exclusivas), `states.ts` (os seis estados, incl. Amostra insuficiente), `read-scope.ts` (tipos e regras do escopo de site), `evaluate.ts` (entrada → estado do subcritério), `competitors.ts` (L1/L2), `aggregate.ts` (meios-pontos inteiros; O, E, W_na, W_am, cobertura, índice, meio-para-cima, classes), `confidence.ts` (seis fatores + justificativas por modelo fixo), `na-registry.ts` (validação do registro de N/A), `publication.ts` (estados de §6.2), `validate.ts` (invariantes), `index.ts`. `methodology.ts` não muda (teste confere Σ subcritérios = `maxWeight`).
2. Testes: tabela de casos da seção 9; varreduras de exclusividade; recusas (N/A sem registro, N/V com pontos, Amostra insuficiente fora de R1/L1/L2, soma divergente, cobertura/classe declaradas ≠ calculadas); escopo de site (nunca zero em escopo limitado); N/A ≡ N/V; limiares exatos da confiança; regressões C-10…C-12 e PDFs; isolamento (nenhum import proibido, nenhuma rede); estático: só testes importam o módulo; leitura **somente leitura** da evidência preservada da AUD-001 (esperado `INSUFFICIENT`, 28–30 pontos avaliáveis, nenhum índice) com hash antes/depois.
3. Documento da onda, `NOTES.md`, E0 e memória.
**Critérios de aceite:** Σ subcritérios = pesos; faixas exclusivas; invariantes e partição de estados; nenhum índice para a AUD-001; zero chamadas externas (captura de sockets/DNS/`fetch`); `npm test`, `typecheck` e `build` verdes; hashes dos arquivos protegidos e `.env.local` conferidos; revisão independente de segurança (subagente limpo, somente leitura); **parada ao final**.
**Fora de escopo:** interface, PDF, rota HTTP, persistência da confirmação do operador e do registro de N/A (Onda 6B), ampliação do coletor de sites, concorrentes reais (D5), Serper Reviews, qualquer IA.
**Ondas seguintes (propostas):** 6B conectar o cálculo à leitura das evidências e à tela, com rótulos "provisório", e armazenar confirmações; 6C coleta ampliada (D5); 6D concorrentes; PDF após D4.

> **Atualização de numeração (28/10/2026; texto NÃO normativo — pesos, faixas, regras, invariantes e decisões D3B-1…17 não mudam).** A divisão aprovada das ondas é: **6B** = persistência das decisões humanas e APIs autenticadas (implementada: `onda6b-decisoes-humanas.md`); **6C** = integração com o Motor Lumos (mapeamento das evidências armazenadas → entrada do motor) e interface operacional; **Onda 7** = relatório PDF. A coleta ampliada (D5) e os concorrentes continuam dependentes de autorização e não têm número de onda definido.

## 13. Riscos
1. Faixas e limiares são julgamento do projeto, não do Lumos; revisar com dados reais após a 6B.
2. **Viés ascendente:** como ausência/zero de site é N/V, subcritérios de site só pontuam no nível máximo; isso pode inflar o índice de perfis parcialmente lidos. Mitigação: cobertura mínima de 40 %, rótulo "provisório", confiança (confiabilidade e amplitude) e relatório do escopo lido.
3. O coletor atual (até 8 requisições) raramente produz escopo suficiente (e o sitemap sozinho não basta); o normal será N/V nos subcritérios de site.
4. Detectores de S5, X4 e contagens precisam de métodos determinísticos validados; sem eles, N/V.
5. Serper `/maps` é intermediário, não a API oficial; a origem aparece em cada ponto.
6. O provedor pode não expor respostas, posts ou datas; o resultado esperado é N/V, não zero.
7. Dependência de confirmações do operador (C2, C3, P3, V5): sem registro, N/V.
8. Amostra insuficiente em R1 tira 6 pontos do denominador de perfis novos; o dado continua exibido.
9. O hash de integridade detecta alteração acidental; **não** é assinatura.

## 14. Verificações desta etapa
- D3A, `methodology.ts` e a pasta privada da AUD-001 (hash agregado dos arquivos): conferidos antes e depois — iguais. A Onda 6A (22/10/2026) implementou o motor puro em `src/lib/link-audit/scoring/`; verificações e revisão independente em `onda6a-motor-de-pontuacao.md`.
- Nenhum arquivo de código, teste, interface ou migration foi tocado; nenhuma consulta externa; nenhum crédito.
- **`.env.local`:** não foi lido nem alterado por esta etapa; o hash e o mtime (22/10/2026 17:50, edição anterior do usuário) permanecem os da baseline registrada.
