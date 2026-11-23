# Fase 4: relatório de validação

> **Decisão definitiva de infraestrutura (16/10/2026):** sem DataForSEO, sem Google Business Profile API e sem novos serviços pagos. Tudo que não puder ser comprovado com o Serper já contratado, com os dados existentes e com verificações técnicas de sites públicos permanece NÃO VERIFICADO.

Atualizado em 16/10/2026.

> **CORREÇÃO (16/10/2026, ajustes finais).** Versões anteriores deste relatório afirmaram que o PDF com verificação do site "preservava o score histórico de 56,4%". Isso estava **errado**: os PDFs reavaliados rotulavam como "SCORE JUIZ HISTÓRICO" valores **recalculados** (55,5% sem site; 68,2% com site). A seção "Ajustes finais de confiabilidade" abaixo descreve a correção; as tabelas de cobertura e pontuação mais antigas devem ser lidas com essa ressalva.

## Verificações executadas

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | 0 erros |
| `npm test` | **286 testes, 286 aprovados, 0 falhas** (eram 144 ao final da Fase 3; 264 antes dos ajustes finais) |
| `npm run build` | Compilado com sucesso; 7/7 páginas geradas |
| Lint | Não configurado (ESLint não está instalado); não executado |
| `.env.local` | Intacto (hash SHA-256 idêntico ao do início da sessão, conferido várias vezes) |
| Consultas externas pagas | **Nenhuma.** Nenhuma chamada ao Serper ou ao LLM (DataForSEO foi descartado). |
| Consultas externas gratuitas | Leituras do banco (Supabase) e **1 verificação técnica pública do site do lead** (`--check-site`), descrita abaixo |

### Testes novos da Fase 4 (por assunto)

| Arquivo | Testes | O que cobre |
|---|---|---|
| `tests/evidence-criteria.test.ts` | 16 | Classificação dos 21 critérios; ausência de fonte; fonte parcial; reivindicação, endereço, WhatsApp, site (sem schema, noindex, robots, fora do ar, rede social), nota/volume, avaliações, vitrine, território; simulado não persistido; determinismo |
| `tests/judge-scoring.test.ts` | 10 | Fórmula histórica idêntica à original; critério sem nota fora do cálculo; desempenho verificado; parcial à parte; cobertura ponderada; resumo gravado coerente com os itens |
| `tests/battlefield-metrics.test.ts` | 11 | Empresa em #1, #7, #20, fora do Top 20, posição ausente, grade parcial, grade completa; dashboard e PDF usam a mesma metodologia |
| `tests/history-compat.test.ts` | 8 | Rodadas compatíveis e incompatíveis (centro, zoom, passo, cobertura, simulada, sem parâmetros); sem evolução inventada |
| `tests/serper-reviews.test.ts` | 13 | Desligado por padrão; limite de páginas; falhas; interpretador defensivo; datas relativas; recência só com janela coberta; amostra parcial; taxa de resposta sem o campo; termos de serviço |
| `tests/url-safety.test.ts` | 14 | SSRF: IPs internos/metadados/IPv6 mapeado, representações numéricas, esquemas, portas, credenciais, DNS misto, rebinding, redirecionamentos, limite de redirecionamentos, prazo total, transporte real fixando o IP |
| `tests/phase4-agents.test.ts` | 21 | Reputação, Vitrine, Battlefield, Rivais e Prospecção sem simulação; modo demonstração explícito; falhas parciais preservam dados válidos; reprocessamento idempotente; gravar e ler evidências; compatibilidade histórica |
| `tests/recommendations.test.ts` | 13 | Contrato das recomendações; hipótese x ação comprovada x não aplicável; sem promessas; coerência com os dados; Revisor |
| `tests/dashboard-evidence.test.ts` | 6 | Bloco de cobertura, nomenclatura, auditoria antiga, falhas de coleta, categoria sem pontuação |
| `tests/pdf-render.test.ts` (novos) | +6 | PDF com evidências parciais, com fontes de teste, sem leitura territorial, nome longo no mapa, vírgula decimal da Inter |

Os testes que existiam foram **atualizados**, não removidos: a Fase 4 muda de propósito a classificação de auditorias antigas (7 → 5 critérios verificados), e cada alteração de expectativa está explicada no próprio teste.

## Validação com dados persistidos (auditoria real `859b4021…`, sem nova coleta)

PDFs gerados só com leitura do banco (sem custo), com os 6 tiles de teste para o mapa:

- `docs/exemplos-fase4/dossie-auditoria-real-historico-conservador.pdf`: auditoria **exatamente como gravada**, classificada de forma conservadora (12 páginas).
- `docs/exemplos-fase4/dossie-auditoria-real-reavaliado-fase4.pdf`: Juiz e Estrategista **reavaliados com as regras da Fase 4 sobre os mesmos dados gravados**, usados só no PDF (12 páginas). Nada foi gravado no banco.
- `docs/exemplos-fase4/dossie-fixture-com-fontes-de-teste.pdf`: empresa de teste ("EMPRESA DE TESTE (fixture)") com fontes simuladas por fixtures, para mostrar como ficam critérios verificados, parciais e as fontes (12 páginas). **Não é uma auditoria real.**

O PDF oficial de desenvolvimento em `public/audits/` **não foi alterado**.

### Cobertura antes e depois (mesma auditoria e os mesmos dados)

| Indicador | Dossiê da Fase 3 | Fase 4 (conservador, como gravado) | Fase 4 (reavaliado) |
|---|---|---|---|
| Critérios verificados | 7 (37% do peso) | **5 (25,5%)** | **6 (31,4%)** |
| Parcialmente verificados | não existia | 2 (11,8%) | 4 (19,6%) |
| Simulados | 6 (25,5%) | 6 (25,5%) | 7 (29,4%) |
| Não verificados | 8 | 8 (37,3%) | 4 (19,6%) |
| Desempenho nos critérios verificados | 57,6% | **38,1%** | **49,7%** |
| Score histórico do Juiz | 56,4% | **56,4%** (preservado) | 55,5% |
| Posição média apresentada | "Posição média 20,2" | Índice de posição 20,2 (fora do Top 20 = 21); média no Top 20: 12,8 (5 pontos) | idem |

**Por que a cobertura caiu.** A queda de 7 para 5 critérios verificados não é piora da auditoria: é a remoção de aprovações indevidas.

- **Critério 3 (endereço):** existir endereço público não comprova consistência com outros canais. Passou a parcialmente verificado, sem pontuação.
- **Critério 5 (site):** ter um domínio não comprova que ele é indexável nem que tem LocalBusiness. Passou a parcialmente verificado. Como a verificação real do site **não foi executada** (não autorizada), ele fica assim; com a verificação, pode chegar a verificado.
- **Efeito no desempenho verificado (57,6% → 38,1%):** esses dois critérios entravam com 100% cada. Sem eles, restam nota (100%), volume vs. líder (45%), Top 3 (15%), Top 7 (20%) e invisibilidade (10%).

**Por que a versão reavaliada tem mais critérios verificados (6)** sem violar a regra de não reclassificar: o critério 6 (categoria x líderes) passa a ser **calculado** de dados reais já coletados (78% dos 49 pontos têm líder com a mesma categoria), em vez de ser um "aprovado" fixo. A reavaliação **não** promove nenhuma evidência antiga; ela produz evidências novas das mesmas coletas. Os critérios simulados continuam simulados porque os dados gravados de avaliações e vitrine são simulados (6 no modo conservador: 12, 13 e 15 a 18; 7 na reavaliação, que inclui também o 14).

**Por que o score histórico mudou de 56,4% para 55,5% na reavaliação:** no cálculo antigo, o critério 6 valia 100 (fixo) e o 14 valia 60 (fixo); na reavaliação, o 6 vale 100 (calculado) e o 14, sem base de pontuação, fica fora do cálculo (nem 0 nem 100).

## Revisão de segurança, cálculos e integridade

Feita pelo próprio agente que implementou (não é uma revisão de terceiros). Defeitos reais **encontrados pelos testes e corrigidos** durante a fase:

1. **Transporte do site-check:** o `lookup` fixando o IP falhava no Node atual (`ERR_INVALID_IP_ADDRESS`), porque o Node pede a lista de endereços (`all: true`). Em produção, toda verificação de site teria falhado. Corrigido e coberto por teste com servidor local.
2. **Prazo total:** o `timeout` do socket mede só inatividade; um servidor que envia um byte por vez seguraria a auditoria. Adicionados prazo total por requisição e prazo total (20 s) para a verificação inteira.
3. **Vírgula decimal sobreposta ("57|1%") no PDF:** causa raiz no fontkit, que trata trechos só com dígitos como script padrão e aplica o dobro do kerning da Inter em "7," e ",1". O PDF passou a compor com script latino. Teste de regressão compara com o fontkit original (defeito) e verifica o valor corrigido nos quatro pesos.
4. **Quebra de linha impressa como "?":** o sanitizador trocava `\n` por "?". Corrigido.
5. **Amostra de avaliações "completa":** "sem próxima página" não basta; a API pode devolver menos que o perfil. Passou a exigir cobertura de ao menos 90% do total conhecido.
6. **Rótulos longos:** "Parcialmente verificado" sobrepunha o texto na legenda e estourava a coluna da tabela; indicadores de duas linhas passavam da borda do cartão. Corrigidos.

Verificações de segurança sem defeito encontrado: validação de esquema, porta, credenciais embutidas e host; resolução DNS com bloqueio de resposta mista; revalidação em cada redirecionamento; IP fixado na conexão; corpo limitado a 512 KB; `Accept-Encoding: identity`; nenhuma credencial em log ou em evidência; textos e nomes de clientes não são gravados; evidência simulada nunca é persistida; nenhum endpoint novo foi criado.

Limitações conhecidas: o formato da resposta do Serper Reviews não foi confirmado (o leitor é defensivo e está desligado); `value` de uma evidência pode guardar o endereço estruturado de um site de terceiro (limitado a 200 caracteres por campo); `provenance` de um lead não é persistida (sem coluna), por isso os leads relidos do banco são tratados de forma conservadora.

## Critérios de aceitação

| # | Critério | Situação |
|---|---|---|
| 1 | Fontes dos 21 critérios documentadas | Atendido (`evidence-audit.md`) |
| 2 | Sem simulação silenciosa em produção | Atendido (demo só com `GMN_DEMO_MODE=true`; testes) |
| 3 | Evidência com origem e data | Atendido (`AuditEvidence`; críticos verificados exigem fonte e data, testado) |
| 4 | Score histórico x desempenho verificado | Atendido (`judge-scoring.ts`; dashboard e PDF) |
| 5 | Cobertura matematicamente correta | Atendido (testes de fórmula e de pesos) |
| 6 | Métricas territoriais identificadas | Atendido (índice x média conhecida, com denominador) |
| 7 | Resultados históricos preservados | Atendido (nada reescrito; testes de compatibilidade) |
| 8 | Dashboard continua funcionando | Build e testes de renderização no servidor; **não** houve verificação visual no navegador (exigiria uma auditoria carregada, e a prospecção/auditoria real consome créditos) |
| 9 | Battlefield continua funcionando | Estrutura e mapa intactos; testes |
| 10 | Maestro e Worker BullMQ | Compilam e a orquestração foi só estendida (site-check e falhas de provedor); **não** foi executado um job real (consome créditos) |
| 11 | PDF premium continua sendo gerado | Atendido (3 PDFs gerados e revisados página a página) |
| 12 | Recomendações coerentes com as evidências | Atendido (testes de coerência e de promessas) |
| 13 | `.env.local` inalterado | Atendido |
| 14 | Testes, typecheck e build | Atendido |
| 15 | Limitações das APIs documentadas | Atendido (`evidence-audit.md`, `data-provenance.md`) |

## Verificação técnica do site do lead (16/10/2026, sem custo)

Executada uma vez (`npm run pdf:regenerate -- 859b4021… --reevaluate --check-site`), com a proteção SSRF ativa, só leitura do banco para o resto.

| Item | Resultado |
|---|---|
| Resposta | HTTP 200, URL final `https://<SITE_CLIENTE_F>/` (sem redirecionamento para fora) |
| Indexação | Sem `noindex`; `robots.txt` permite a raiz (**a indexação efetiva no Google não foi verificada**) |
| Dados estruturados | JSON-LD `Dentist` + `LocalBusiness` encontrado no HTML inicial |
| Contatos públicos | 1 link de WhatsApp no site; nenhum `tel:` nem e-mail |
| Endereço | O endereço estruturado do site **coincide** com o da listagem |

Efeito nos critérios (PDF `docs/exemplos-fase4/dossie-auditoria-real-com-verificacao-do-site.pdf`):

- **3 (endereço):** parcial → **verificado** (listagem x site coincidem). Limitação registrada: CNPJ e outros cadastros não foram comparados.
- **5 (site):** parcial → **verificado**, com a ressalva de que a indexação efetiva exige o Search Console.
- **4 (WhatsApp):** continua **parcial** (link público existe, atendimento não confirmado).
- Cobertura: **8 de 21 critérios verificados (43% do peso)**, 3 parciais; desempenho nos critérios verificados **63,4%**; score histórico preservado como gravado na auditoria (56,4%). A cobertura subiu em relação aos 26% do modo conservador sem nenhum custo e sem simulação.

## O que continua sem solução dentro da decisão de infraestrutura

Critérios 1, 2, 7, 8, 16, 17 e 18 (e partes do 9, 12, 13, 14, 15) dependem de dados do painel do proprietário ou de avaliações datadas. Permanecem NÃO VERIFICADOS ou parciais. O único caminho que ainda poderia ajudar sem nova contratação é o Serper `/reviews` (critérios 12, 13 e 14), que consome créditos do plano e depende da sua autorização.

## Ajustes finais de confiabilidade (16/10/2026)

### 1. Pontuações separadas (56,4% × 55,5% × 68,2%)

| Valor | O que é | Metodologia | Denominador |
|---|---|---|---|
| **56,4%** | **Score Juiz histórico**, o único gravado na auditoria `859b4021…` | Original: soma de (pontuação × peso) ÷ soma dos pesos dos 21 critérios, inclusive critérios com dado simulado, estimado ou fixo | 102 (100% do peso) |
| 55,5% | Pontuação **recalculada**, reavaliação **sem** verificação do site (PDF antigo) | Mesma média ponderada, só sobre critérios com pontuação (inclui indicativos de parciais) | 40 (39,2%) |
| 68,2% | Pontuação **recalculada**, reavaliação **com** verificação do site, critério 3 ainda verificado (PDF antigo, hoje substituído) | Idem | 52 (51,0%): o critério 3 contava com 100% (peso 6) |
| **64,0%** | Pontuação recalculada **atual** (critério 3 agora parcial e sem pontuação) | Idem | 46 (45,1%) |
| **57,6%** | **Desempenho nos critérios verificados** (7 de 21) | Mesma média, restrita aos critérios VERIFICADOS | 38 (37,3%) |

Implementado: `JudgeScoreSummary.recalculatedScore` (renomeado de `historicalScore`), `scoreMethod: 'PHASE4_SCORED_WEIGHT'`, `ReportSourceData.storedJudge` (valor gravado, nunca recalculado) e `ReportModel.judge.scoreLines`. O PDF mostra, na metodologia, um cartão por pontuação com valor, metodologia e denominador; "histórico" só aparece no valor armazenado. A coluna da tabela dos 21 critérios vira "PONTUAÇÃO RECALCULADA" quando as notas são recalculadas. O dashboard rotula "Score Juiz histórico (armazenado)" ou "Pontuação do Juiz (Fase 4)" conforme `scoreMethod`.

### 2. Critério 3 (endereço)
Endereço da listagem coincidindo com o do site passa a **PARCIALMENTE VERIFICADO**, sem pontuação: a regra SAB, a área de cobertura e o CNPJ não foram avaliados. Efeito na auditoria real (com verificação do site): de 8 para **7 critérios verificados (37% do peso)**, 3 parciais (14%), 4 não verificados (20%), 7 simulados legados (29%). O critério 5 **permanece verificado** (decisão do usuário): a limitação "indexação efetiva no Google não verificada" continua impressa.

### 3. Simulado legado × atual
- `simulationOriginOf`: **LEGACY** (gravado por auditoria anterior à Fase 4), **DEMO** (modo demonstração) ou **FIXTURE** (teste). O PDF mostra "SIMULADO (LEGADO)", "SIMULADO (DEMONSTRAÇÃO)" ou "SINTÉTICO (TESTE)" e explica na legenda.
- Guarda fail-closed no Maestro (`assertNoSimulatedDataOutsideDemo`): se uma coleta nova trouxer marcadores de simulação **fora** do modo demonstração, a auditoria falha antes do Juiz e nenhum PDF é gerado (teste de integração). Auditorias históricas e reavaliações continuam legíveis.

### 4. PDFs de fixture
Toda fixture é marcada (`testFixture`): faixa "DOCUMENTO DE TESTE · DADOS SINTÉTICOS · NÃO É O RESULTADO DE UMA AUDITORIA · NENHUMA CONSULTA REAL AO SERPER" em todas as páginas, rodapé e título do PDF; os provedores viram "Dados sintéticos de teste (fixture)"; nenhuma evidência é atribuída ao Serper nem tem data de coleta real. Teste: nenhum texto de PDF de fixture menciona "Serper" fora de frases que o negam.

### 5. Integração com Maestro, Worker e Supabase
`tests/maestro-integration.test.ts` (6 testes): o Maestro roda de ponta a ponta com o Serper simulado em memória. Confirmado: 49 chamadas ao Serper Maps e nenhuma outra URL; etapas 15→55→72→92→100; ficha do Juiz com evidências; Revisor aprova o novo Estrategista; PDF gravado só em pasta temporária (`GMN_PDF_OUTPUT_DIR`, novo e opcional) e `public/audits` inalterado; o estado volta íntegro após ida e volta JSON (como as colunas JSONB do Supabase) e alimenta `reportSourceFromAuditState` e o relatório sem recoletar; reprocessar o mesmo `auditId` não duplica; simulação fora de demonstração interrompe a auditoria. O Worker (`audit-worker.ts`) só chama `maestroOrchestrator.runAuditPipeline`, que é o método testado. **Não verificado:** um job real no BullMQ/Redis/Upstash e a escrita real no Supabase (consomem créditos e gravam em produção); os esquemas (`NUMERIC`, `CHECK`, colunas anuláveis) foram conferidos por leitura das migrations, sem escrita.

### 6. Mapa em outras cidades
- **Sem mapa-base** (padrão de produção): 6 cidades de regiões e latitudes diferentes (Manaus, Fortaleza, Brasília, Curitiba, Porto Alegre, Rio Branco): pontos dentro do retângulo, 500 m entre vizinhos na escala (tolerância de 3%), nenhum `NaN`, aviso impresso.
- **Tiles reais de Goiânia** (6 tiles baixados manualmente, exceção de download offline, sem custo): ruas e nomes desenhados, janela 3×2 tiles, atribuição impressa. Prova que o desenho não depende de Anápolis.
- **Rede (OpenFreeMap) simulada**: o pipeline atende Curitiba e Porto Alegre, com User-Agent próprio, só o host permitido, teto de 16 tiles por relatório e cache em disco (nenhuma nova requisição ao repetir).
- **Fato operacional:** sem `GMN_PDF_BASEMAP` o padrão é **sem mapa-base**. Com a pasta local, só Anápolis e Goiânia têm tiles; para qualquer outra cidade o PDF sai sem ruas e com aviso. Cidades arbitrárias com ruas em produção exigem a autorização do OpenFreeMap (pendente) ou um extrato próprio.

### Defeitos encontrados e corrigidos nesta rodada
1. Rótulo "histórico" em valores recalculados (item 1).
2. O símbolo "Σ" não existe na fonte Inter e saía como "?" no PDF; trocado por texto e criado um teste que varre todos os textos do relatório por caracteres sem glifo.
3. Rótulos dos cartões de pontuação invadiam a coluna de texto; layout refeito.
4. Rodapé de fixture quebrava em duas linhas sobrepostas; marca movida para a segunda linha.
5. A legenda de evidências (4 itens) ficava sozinha numa página quase vazia; textos abreviados.

### Revisão visual
Revisadas todas as páginas dos seis PDFs de validação (`docs/exemplos-fase4/`): real com verificação do site (12 p.), real sem reavaliação (12 p.), e quatro de fixture (11 a 12 p.). Nenhum texto cortado ou sobreposto restante; permanecem áreas em branco no fim de algumas páginas por quebra de seção.
