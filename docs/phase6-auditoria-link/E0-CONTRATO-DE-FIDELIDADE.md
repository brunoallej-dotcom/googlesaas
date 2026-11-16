# E0 — Contrato de fidelidade · Fase 6 Auditoria por link (v2, 20/10/2026)

**Status da E0: documentação produzida; contrato NÃO aprovado.** Há bloqueios essenciais (seção 6). Nenhum código, migration, dado ou serviço foi tocado.

**Reprodução 100% idêntica ao agente antigo não é afirmável.** O prompt original e a configuração de ferramentas continuam perdidos; também faltam a régua de pontos, o logo e a foto de capa. O que existe é uma reconstrução a partir dos materiais, tratada aqui como hipótese formal.

## 0. Histórico e fontes
- v1 (19/10/2026): contrato inicial, antes da reconstrução do agente.
- v2 (20/10/2026): integra o pacote de reconstrução. A v1 foi mantida; nenhum ID existente foi renumerado, exceto o nome dos requisitos (nota abaixo).

Fontes lidas integralmente: `diagnostico-e-plano.md`; `INSTRUCOES_MESTRAS_AGENTE_AUDITORIA_GBP_v1.md` (“mestre”); `INSTRUCOES_EXECUTAVEIS_AGENTE_AUDITOR_GBP_v1.md` (“executável”); `LACUNAS_E_DECISOES_DE_FIDELIDADE.md` (“LACUNAS”); `LEIA_ME_PRIMEIRO.md`; `PROMPT_ENTREGA_CLAUDE_CODE_FASE6.md`; os cinco materiais de referência (JSON, manual, guia, PDF Lumos, PDF Rio); `.data/resgate-wsl-20261019-230005/*`; `NOTES.md`.

**Convenção de IDs (evita colisão de siglas):**
- `REQ-01…REQ-21` = requisitos desta E0 (na v1 chamavam-se R-01…R-21).
- `LAC-R-01…LAC-R-24` = itens R-01…R-24 do anexo LACUNAS (taxonomia independente).
- `C-01…C-20` = conflitos do diagnóstico; **numeração reconstruída**, pois a tabela original não foi recuperada. Se ela reaparecer, prevalece.
- `A-xx` critérios de aceitação · `B-x` bloqueios · `K-xx` achados de compatibilidade · `D1…D5` decisões prioritárias.

**Rótulos:** **[DOCUMENTADO]** consta literalmente em fonte citada ou foi lido no código · **[RECONSTRUÇÃO]** organização operacional do mestre/executável, hipótese · **[RECOMENDAÇÃO]** proposta técnica minha, não aprovada · **[PENDENTE]** depende de decisão ou material ausente.

**Hierarquia de precedência (proposta, não aprovada):** referências originais (com a hierarquia do guia: PDF Lumos > PDF Rio > manual; JSON = exemplo) → mestre (hipótese formal) → executável (proposta operacional subordinada ao mestre). Em conflito entre mestre e executável, vale o mestre.

---

## 1. Escopo e restrições [DOCUMENTADO: PROMPT_01 e pedidos do operador]
- A Fase 6 **não é SaaS**: área independente dentro da GMN interna.
- Permanecem intactos: prospecção, Juiz (21 critérios, peso 102), grade 7x7 de 49 pontos, campanhas, auditorias e relatórios antigos, PDFs históricos, autenticação, RLS e downloads privados.
- A metodologia nova (Lumos) não é adaptada ao Juiz e não inclui a grade.
- Referências (PDFs e JSON) são de apresentação/forma, não fonte de fatos de outras empresas. Dados fictícios só em testes identificados.
- Sem Serper, APIs pagas, DataForSEO, Google Business Profile ou IA paga sem autorização expressa. **Nenhum modelo de IA foi escolhido.**
- Cadeia obrigatória: coleta → auditoria/validação → `DADOS_TRAVADOS` → diagramação (manual §1; guia §6; mestre §10).

## 2. Requisitos

### 2.1 Integridade matemática [DOCUMENTADO — manual §2; mestre §6]
REQ-01 Pontos avaliados de cada critério ≤ peso.
REQ-02 Pontos obtidos ≤ pontos avaliados.
REQ-03 Pontos possíveis avaliados = soma dos pesos efetivamente avaliados.
REQ-04 Cobertura = pontos possíveis avaliados ÷ 100.
REQ-05 Índice = pontos obtidos ÷ pontos possíveis avaliados × 100.
REQ-06 A soma da tabela coincide com a Base Observada.
REQ-07 A classificação corresponde ao Índice final.
Exemplo válido do manual: base 54,5/65 → cobertura 65% → índice 83,85 (exibido 84) → “Forte”.
Pesos (JSON, Lumos p4, Rio p4, mestre §5): NAP 15 · Categorias 10 · Serviços/produtos/descrição/atributos 12 · Avaliações e reputação 18 · Respostas 8 · Fotos/vídeos/identidade visual 10 · Publicações e atividade 8 · Conversão e jornada 10 · Autoridade local e competitividade 9 = **100**.

### 2.2 Nativo × externo [DOCUMENTADO — manual §3; mestre §4]
REQ-08 Site, Instagram, Facebook e LinkedIn reforçam autoridade, identidade, portfólio, conversão e coerência externa, mas não comprovam categorias, serviços, avaliações, respostas, fotos, vídeos, Posts, produtos ou atributos do Google. Exemplos do mestre §4: formulário no site ≠ formulário no Google; Instagram semanal ≠ Google Posts semanal; Tripadvisor 5★ ≠ 5★ no Google.
REQ-09 Recurso nativo inacessível = “Não verificado”; o peso sai da base avaliada. Falta de acesso ≠ ausência do recurso, ≠ nota zero, ≠ “Avaliado”.

### 2.3 Concorrentes [DOCUMENTADO — manual §4, §9; mestre §8]
REQ-10 Só concorrentes presentes na auditoria em texto; cada um com nome real, região, critério de equivalência, URL de fonte pública e ≥ 2 elementos verificáveis. Quantidade variável (nenhum número fixo nos materiais). Sem comparação suficiente: limitação metodológica, nunca nomes inventados. Citar a plataforma de cada métrica (nota Google ≠ nota Tripadvisor); sem ranking local sem medição geolocalizada.

### 2.4 Estrutura e visual
REQ-11 A4 vertical, 12 páginas; páginas 2–12 numeradas 02–12 (guia §3).
REQ-12 Cabeçalho nas páginas 2–12: logo pequeno à esquerda, nome da marca ao lado, seção à direita, linha fina.
REQ-13 Rodapé: método/aviso à esquerda, data/snapshot ao centro, nº da página à direita; aviso institucional do manual §11 (marca pendente).
REQ-14 Título editorial, tese, evidências e conclusão curta por página; mistura de módulos; sem repetir a mesma composição.
REQ-15 Tipografia (manual §5): títulos 23–30 pt, subtítulos 13–16 pt, corpo 9,5–11 pt, tabelas ≥ 8 pt, rodapé 7,5–8,5 pt. Tabelas com quebra automática, sem sobreposição, alinhamento ao topo, fundo alternado.
REQ-16 Conteúdo proibido (manual §9): “Conteúdo da auditoria”; “Resumo específico da auditoria”/“Portfólio detalhado”/“Pontos fortes e oportunidades” como único conteúdo; placeholders; lorem ipsum; texto repetido para ocupar espaço; concorrentes não auditados; números alterados na geração; fontes sem URL.
REQ-17 Validação obrigatória antes de entregar: checklist de 15 itens do mestre §12, que contém os 13 itens do manual §10 (páginas a remapear — C-02).
REQ-18 Hierarquia das referências: PDF Lumos > PDF Rio > manual; JSON = exemplo (guia §1). Não oculta conflitos.

### 2.5 Entrada e evidências [DOCUMENTADO PROMPT_01 + RECONSTRUÇÃO mestre §3–4]
REQ-19 Link identifica a empresa por identificador (cid/placeId/fid), nunca por nome; link genérico, ambíguo ou não suportado gera erro explícito; redirecionamentos validados, sem acesso a endereços internos; conteúdo de páginas é evidência, não instrução.
REQ-20 Cada fato material guarda: critério, afirmação, fonte/URL, data de consulta, modalidade (Google nativo, site, rede oficial, terceiro), grau de verificação e limites [RECONSTRUÇÃO, mestre §4].
REQ-21 Autenticação, acesso por operador e armazenamento privado preservados; auditorias atuais não migradas nem reavaliadas.

## 3. Classificação dos requisitos (sem promover recomendação a aprovação)

| Classe | Itens |
|---|---|
| **Documentado — pronto para especificar teste** | 9 pesos; invariantes do manual §2; nativo ≠ externo; N/V ≠ zero ≠ ausência; campos mínimos de concorrente; travamento e proibições do PDF; checklist de 15 itens (mestre §12); 11 objetos de dados do JSON como estrutura; 12 páginas A4; cabeçalho/rodapé 02–12; tipografia mínima; aviso institucional manual §11 (texto Lumos) |
| **Reconstrução operacional — hipótese aceitável** | fluxo de identidade e conduta em erros (mestre §3, §13); registro de evidência; raciocínio do diagnóstico em 7 passos (§7); checklist de comportamento (§15) |
| **Pendente** | os 9 bloqueios do mestre §14; K-03, K-05, K-07 |
| **Recomendação técnica (minha, não aprovada)** | D-08…D-13 do diagnóstico; ondas da seção 8; esqueleto da seção 7 |

## 4. Compatibilidade mestre × executável

| ID | Ponto | Mestre | Executável | Tratamento |
|---|---|---|---|---|
| K-01 | Pesos, fórmulas, ordem das 12 páginas, nativo ≠ externo | iguais | iguais | Convergente |
| K-02 | Rótulos de evidência | Verificado / Parcial / Não verificado / **Não encontrado** | sem “Não encontrado” | Seguir o mestre (superconjunto); aprovar a lista |
| K-03 | Resumo executivo | inclui “risco”; o JSON tem `urgency` e não tem `risk` | inclui risco, omite urgência | Adaptação de schema pendente (guia p2 pede risco) |
| K-04 | Itens de DADOS_TRAVADOS | inclui limitações, plano, cobertura e base | lista menor | Seguir o mestre |
| K-05 | Paleta | manual (§5) e tolerância a decidir | “use a paleta do manual” | Conflita com LAC-R-04 (PDF principal como referência); ligado a C-19 |
| K-06 | Mensagem sem índice | “índice não calculado por falta de evidência” (base zero) | “Índice pendente de definição metodológica” (sem régua) | Dois estados distintos; textos a aprovar |
| K-07 | Formato | especificação | escrito como prompt de LLM (“Você é…”) | A GMN não tem LLM; decisão de arquitetura da narrativa (D5) |
| K-08 | Fontes de coleta (§4) | lista ampla, atribuída aos PDFs p3 e p12 | resumida | Parte **não reconferida** (seção 5) |

## 5. Verificações desta rodada
**Confirmado por leitura direta do código** (fecha a ressalva do mestre §16, que tratava esses fatos como relato não verificado):
- `gmn_audits.lead_id` NOT NULL com FK (`supabase/migrations/001_gmn_schema.sql:65`); `gmn_battlefield_rounds.lead_id` idem (`:110`).
- Nenhuma dependência de IA no `package.json`.
- Navegação por âncoras (`src/components/dashboard/sidebar.tsx:30-34`, `href="#…"` em `:123`).
- Nenhum parser de link do Maps em `src`/`scripts`.
- Motor de PDF: `pdfkit ^0.16.0` (`package.json:32`).
- `/reviews` só roda com `GMN_REVIEWS_PROVIDER=serper` (`src/lib/serper-reviews.ts:234,268`).
- Runner de testes: lista explícita de 36 arquivos.

**Aritmética conferida** (LACUNAS §2): JSON 11+7+8+14+5+7+3+7+6 = 68 ≠ base declarada 54/75; 54/75 = 72 (índice confere), cobertura correta seria 75%, não 78%. Lumos p4: 47/74 = 63,5 → 64; cobertura correta 74%, não 58%. Rio p4: 84/100 = 84; cobertura correta 100%, não 81%. Manual: 54,5/65 = 83,85 → 84, cobertura 65%. Coincide com as medições da Rodada 1.

**Não reconferido nesta rodada** (o `pdftoppm` não está instalado e instalar está vetado): referências a “Rio p7” e “Rio p2 resumo” (LACUNAS §2) e a lista de fontes do mestre §4 atribuída às páginas 3 e 12 dos PDFs (Tripadvisor, Viator, GBP Help, fontes institucionais). A Rodada 1 comprovou apenas que a p12 de ambos lista fontes sem URL.

## 6. Matriz de conflitos C-01 a C-20 (mantida da v1, numeração reconstruída)
Nenhum conflito foi resolvido. A coluna “Recomendação” é minha e **não** é aprovação. A coluna “LAC” indica correspondência **apenas temática** com o anexo LACUNAS (mesmo assunto/mesmas seções citadas), sem afirmar identidade entre os itens.

| # | Fonte A | Fonte B | Divergência | Impacto | Decisão necessária | Recomendação (não aprovada) | LAC (temática) |
|---|---|---|---|---|---|---|---|
| C-01 | Manual §7: Índice p3; pontos fortes p9; prioridades p10; 30 dias p11 | Guia §4 e ambos PDFs: escopo p3, Índice p4, prioridades p9, 30 dias p10, ativos p11, veredito p12 | Ordem e conteúdo das 12 páginas | Modelo de páginas e testes de PDF | Qual estrutura vale | Guia+PDFs, se confirmado (mestre §2 propõe o mesmo) | R-01 |
| C-02 | Manual §8/§10: validar p3 (matemática), p8, p10, p11, p12 | Guia §4 e PDFs: matemática na p4 | Validações apontam páginas do manual | Testes nas páginas erradas | Remapear à estrutura de C-01 | Remapear por conteúdo | R-03 |
| C-03 | Manual §6: 55–82% | Guia §5: ≈65–85% | Faixa de ocupação | Teste de densidade | Faixa oficial | Aguardar; nunca inventar conteúdo para preencher | R-02 |
| C-04 | Manual §6: ≥ 2 módulos | Guia §5: ≥ 3 módulos (págs. 2–11) | Mínimo de módulos | Teste de composição | Mínimo oficial | Aguardar | R-02 |
| C-05 | Manual §6 / guia §5 | Medições: Rio p5, p8, p11, p12 e Lumos p7 com > 1/3 em branco | Referências violam a régua | Teste visual poderia reprovar as referências | Régua rígida ou guia | Tolerância documentada, decisão do operador | R-02 |
| C-06 | Guia §3 (rodapé numerado) | Lumos p9: sem rodapé; conteúdo a ~97% | Defeito na referência principal | Risco de copiar o defeito | Confirmar que é defeito | Não reproduzir (mestre §11 diz “corrigir lacunas de rodapé” sem torná-las norma) | — |
| C-07 | JSON `score_breakdown`: soma 68/100 | JSON `metadata`: base 54/75, índice 72, cobertura 78 | Números não fecham; sem “pontos avaliados” | JSON não serve de oráculo | Confirmar JSON como forma, não como conta | Usar só o schema | R-09, R-10 |
| C-08 | Manual §2 | Lumos p3–4: 47/74 → 64 (confere), cobertura exibida 58% | Fórmula daria 74% | Cobertura impressa | Qual fórmula vale | Fórmula do manual | R-11 |
| C-09 | Manual §2 | Rio p3–4: 84/100 = 84, cobertura exibida 81% | Fórmula daria 100% | Idem | Idem | Fórmula do manual | R-12 |
| C-10 | Manual §3 | JSON: Publicações N/V com 3/8 | Pontua o que devia ser excluído | Cálculo e cobertura | N/V exclui peso? | Sim (manual §3) | R-13 |
| C-11 | Manual §3 | Lumos p3 (categorias, fotos, publicações = N/V) × p4 (5/10, 7/10, 6/8); p7 atividade via LinkedIn | Pontua nativo com evidência externa | Viola REQ-08 | Idem + regra de evidência externa | Idem | R-13 |
| C-12 | Manual §3 | Rio p3 (publicações “não verificadas”, respostas “não verificadas integralmente”, fotos “não auditada integralmente”) × p4 (5/8, 5/8, 8/10) | Pontuação parcial sem regra | “Avaliação parcial” sem definição | Regra de parcial | Aguardar | R-13 |
| C-13 | Lumos p4, Rio p4, JSON | Manual §2 | Faixa 40–59 inexistente; sem arredondamento, confiança, base zero | Classificação e confiança indefinidas | Faixa, arredondamento, confiança, base zero | Sem classe automática; base zero ⇒ “não calculado” | R-15, R-16, R-17 |
| C-14 | Manual §4 | Lumos p8, Rio p8 sem região/equivalência/fonte | Referências omitem campos exigidos | Tabela da p8 | Campos mínimos; seleção; quantidade | Poucos equivalentes com prova, ou limitação | R-18 |
| C-15 | Manual §9–10 (fonte com URL) | Lumos p12, Rio p12 sem URL | Idem | Teste de URLs na p12 | Exigir URL | Exigir | — (coberto pelo checklist 12 do mestre §12) |
| C-16 | Manual §7: P0–P3 com prazo | Guia p9 e PDFs: impacto/esforço sem prazo; JSON só P0–P2 | Modelo de prioridade | Dados e p9 | Campos e níveis | Mestre §9: P0–P3 + problema/impacto/ação/dificuldade/prazo, regra dos níveis pendente | R-19 |
| C-17 | Manual §7: responsáveis sugeridos | Guia p10, PDFs, JSON: ausentes | Exigência × referências | p10/p11 | Exigir? | Aguardar | R-19 |
| C-18 | Guia §1: `01_Logo_Oficial_Lumos.jpg` | Pacote sem o logo; foto de capa sem origem/licença | Ativo ausente | Capa e cabeçalhos | Fornecer com direito de uso | Não recriar logo | R-06, R-07, R-08 |
| C-19 | Manual §5: #071044, #152A68, #F2F4F8, #D8DCE6; fonte não nomeada | PDFs medidos: navy #03084C; fundo #F9F7F3/#F8F6F2; bege #F4EFE7, sálvia #9EA28E, taupe #9E958C; Arimo (Lumos), DejaVu Sans (Rio) | Paleta e fonte divergem; marca final Lumos/GMN/VRA indefinida | Tema, rodapé §11 | Marca, paleta e fonte finais | Não declarar Arimo como regra original (LAC-R-05) | R-04, R-05, R-08 |
| C-20 | LEIA-ME original passo 3 | Pacote | Instruções e ferramentas originais ausentes | Metodologia incompleta | Fornecer ou aprovar a reconstrução | **Atenuado:** reconstrução existe como hipótese (D1) | R-20 |

Observações sem conflito, defeitos a não reproduzir: elipses no lugar de círculos (Lumos p10); títulos encostando em boxes (Lumos p6, p8); corpo/rodapé do Rio aparentemente abaixo dos mínimos do manual §5.

**Itens do anexo LACUNAS sem C correspondente** (eram pendências ou decisões técnicas, não conflitos): LAC-R-14 (sub-régua dos nove critérios; = bloqueio B-1) · LAC-R-21 (entrada por URL; = D-12/E2) · LAC-R-22 (armazenamento; = diagnóstico §1.3/E6) · LAC-R-23 (segurança e custos; = pendência P8) · LAC-R-24 (motor de PDF; = D-08).

## 7. Esqueleto da régua — **ESQUELETO SEM VALORES — NÃO APROVADO — não originou do agente antigo**
Os subitens abaixo vêm **somente** da coluna “O que o diagnóstico observa” do mestre §5. **Nenhum número de ponto foi proposto**: a distribuição cabe ao operador (mestre §5 proíbe improvisá-la).

| # | Critério (peso máx.) | Subitens observados (mestre §5) | Natureza indicada no mestre | Pontos por subitem | Regra de parcial | Se inacessível |
|---|---|---|---|---|---|---|
| 1 | Dados essenciais e NAP (15) | nome; endereço ou área de atendimento; telefone; horários; coerência entre fontes | misto | ⟨em branco⟩ | ⟨em branco⟩ | N/V → sai de `pontos_avaliados` |
| 2 | Categorias e relevância (10) | categoria principal; complementares; compatibilidade com a atividade real; clareza da presença no perfil | nativo Google | ⟨em branco⟩ | ⟨em branco⟩ | idem |
| 3 | Serviços, produtos, descrição e atributos (12) | oferta empresarial comprovada; o que está configurado no Google (quando acessível) | misto (site prova oferta; só o Google prova cadastro) | ⟨em branco⟩ | ⟨em branco⟩ | idem |
| 4 | Avaliações e reputação (18) | nota; quantidade; recência; contexto (avaliações do Google) | nativo Google | ⟨em branco⟩ | ⟨em branco⟩ | idem |
| 5 | Respostas às avaliações (8) | existência; consistência; qualidade das respostas no Google | nativo Google | ⟨em branco⟩ | ⟨em branco⟩ | idem |
| 6 | Fotos, vídeos e identidade visual (10) | evidências visuais públicas; pertinência; identidade; atividade no perfil | nativo, distinguindo fontes externas | ⟨em branco⟩ | ⟨em branco⟩ | idem |
| 7 | Publicações e atividade (8) | Google Posts e atividade nativa observada | nativo (redes = evidência externa distinta) | ⟨em branco⟩ | ⟨em branco⟩ | idem |
| 8 | Conversão e jornada (10) | caminhos públicos até contato, orçamento, reserva ou compra, em site e recursos do perfil, com fonte definida | misto | ⟨em branco⟩ | ⟨em branco⟩ | idem |
| 9 | Autoridade local e competitividade (9) | coerência e alcance do ecossistema público; prova externa; cenário competitivo qualitativo | externo | ⟨em branco⟩ | ⟨em branco⟩ | idem |

Sem esta tabela preenchida e aprovada, o sistema **não emite índice** (A-21).

## 8. Bloqueios (B-x)
- **B-1 Régua de pontos por critério e subcritério** — BLOQUEIO ESSENCIAL. Ausente em todas as fontes e confirmada como pendente no mestre §5 e §14.1. Esqueleto na seção 7.
- **B-2 Tratamento de N/V e de avaliação parcial; fórmula de cobertura** — BLOQUEIO ESSENCIAL. O manual manda excluir o peso; as referências divergem (C-08…C-12). Mestre §14.2.
- **B-3 Coleta e seleção de concorrentes** — BLOQUEIO ESSENCIAL para o comparativo. Descoberta sem a grade de 49 pontos não está definida (mestre §8, §14.8).
- **B-4 Estrutura definitiva do PDF e régua de densidade** — bloqueia a E8 (C-01…C-06).
- **B-5 Identidade visual e marca** — bloqueia a E8 (C-18, C-19): logo, foto com licença, marca final, paleta, fonte.
- **B-6 Instruções e ferramentas do agente** — **reclassificado**: de “ausentes” para “reconstruídas como hipótese; prompt e ferramentas originais continuam ausentes”. Não é mais bloqueio para especificar; continua impedindo qualquer afirmação de identidade com o agente antigo.
- **B-7 Motor da narrativa (novo)** — o executável pressupõe um LLM (K-07) e a GMN não tem nenhum. Nenhum modelo foi escolhido; o mestre §13 diz que a metodologia não autoriza contratar IA.
- **B-8 Renderizador para teste visual (novo)** — não há poppler, pdfjs nem equivalente; a comparação visual da E8 exige autorização de ferramenta (D-11).
- **B-9 Itens menores** — cópia verificada do pacote original de referências para a pasta (não feita); tabela original dos conflitos.

**A E0 não pode ser declarada concluída** enquanto B-1, B-2, B-3 permanecerem e enquanto o contrato não for aprovado (D1…D5).

## 9. Anápolis no código (verificado na v1; sem alterações)
| Local | Natureza | Pertence a |
|---|---|---|
| `src/agents/maestro-orchestrator.ts:91-92` | `const cityGuessed = lead.businessName.split('-').pop()?.trim() ?? 'Anápolis';` usado em `:117` (`city: cityGuessed`) | **Pipeline de auditoria / grade territorial** |
| `src/agents/battlefield-agent.ts:72-82` (`sanitizePureKeyword`), chamada em `:140` | consome a cidade para limpar a palavra-chave | Grade territorial |
| `src/app/page.tsx:22` | default de UI `useState('Anápolis')` (`GO` na linha seguinte) | Formulário da prospecção (editável) |
| `src/components/dashboard/top-filters.tsx:63` | placeholder | UI da prospecção |
| `src/dev/report-fixture.ts:29`, `src/dev/battlefield-fixture.ts:30` | fixtures | Dev |
| `src/lib/pdf/report-model.ts:188` | comentário de exemplo | Documentação |

1. O fallback está no **orquestrador da auditoria, que alimenta a grade territorial**, não na prospecção; `head-prospector.ts` e `brazil-municipality.ts` não contêm “Anápolis”.
2. O `?? 'Anápolis'` nunca dispara (`split('-').pop()` sempre devolve valor). O comportamento real: a “cidade” é o último trecho do nome da empresa separado por hífen (ou o nome inteiro).
3. A auditoria por link não usa a grade e não herda isso. Não alterado; correção seria item separado fora da Fase 6.

## 10. Critérios de aceitação verificáveis
Valores marcados ⟨decisão⟩ só se fixam após aprovação.

**Separação do Juiz e da prospecção**
A-01 Nenhum arquivo de `src/lib/link-audit/**` importa `src/lib/evidence/criteria.ts`, `src/lib/judge-scoring.ts`, `src/lib/pdf/report-model.ts`, `report-metrics.ts`, `report-evidence.ts`, `map/**` nem `battlefield-agent.ts` (teste de imports).
A-02 O relatório novo não contém “Score Juiz”, “21 critérios”, “7x7”, “49 pontos”, “Serper” nem classes de evidência do Juiz (teste de texto).
A-03 `npm test` atual (36 arquivos), `typecheck`, `build`, `db:check`, `validate:recovery` passam; hashes de PDFs históricos e de `.data/` inalterados; nenhum arquivo de prospecção modificado.
A-04 Nenhuma rede em testes; nenhuma chamada Serper/IA sem autorização registrada.

**Cálculo**
A-05 Testes para REQ-01…REQ-07, incluindo 54,5/65 → 65% → 84 → Forte.
A-06 Casos de borda conforme regras aprovadas ⟨decisão⟩: base zero, 40–59, arredondamento, confiança, N/V, parcial.
A-07 Números do JSON e dos PDFs de exemplo **não** servem de oráculo (C-07…C-09).
A-21 O índice e a classificação só são emitidos se a `methodology_version` tiver régua aprovada. Sem ela, `index_status` = “pendente de definição metodológica” (K-06); com base avaliada zero = “não calculado”. Nunca há divisão por zero.
A-22 Os casos de regressão do LACUNAS §5 viram testes, entre eles: o validador **rejeita** o JSON de exemplo (68 contra 54/75); rejeita a cobertura 58% da Lumos e 81% do Rio; **aceita** 54,5/65 → 84, 65%, “Forte”; fonte externa não vira nativa; URL ambígua não dispara auditoria; regeneração do PDF não muda fonte, pontuação, concorrentes nem data.
A-23 O relatório indica “reconstrução baseada nos materiais, versão X” e nunca declara ser o agente original.

**Evidência e dados travados**
A-08 Todo fato tem valor, status, fonte com URL, data e origem nativo/externo; fato externo nunca vira “Avaliado” para recurso nativo.
A-09 `DADOS_TRAVADOS` com SHA-256 e versão da metodologia; o renderer só aceita o snapshot, sem rede e sem recálculo; mudar um valor muda o hash.
A-10 Concorrentes do PDF ⊂ concorrentes da auditoria escrita; cada um com os campos do REQ-10.

**Link e identidade**
A-11 Tabela de casos sem rede: link longo com `!1s0x…:0x…`, `cid`, `place_id`, `@lat,lng` isolado, link curto, busca, genérico, host não Google, IP interno, redirect para fora da allowlist → classificação correta ou erro explícito; nunca resolve por nome.

**PDF**
A-12 Exatamente 12 páginas A4 (595,28 × 841,89 pt), rodapé 02–12.
A-13 Estrutura de páginas igual à aprovada em C-01 ⟨decisão⟩.
A-14 Texto extraído de todas as páginas: nenhuma vazia, nenhum termo proibido (REQ-16), fontes com URL.
A-15 Nenhum corpo/tabela < 8 pt; faixas do manual §5 ⟨decisão⟩.
A-16 Ocupação por página na faixa aprovada ⟨C-03⟩; módulos ≥ mínimo ⟨C-04⟩; sem sobreposição de caixas.
A-17 Comparação lado a lado (render PNG) com Lumos (principal) e Rio (secundário): grid, margens, cabeçalho/rodapé, hierarquia, capa, página do Índice como dashboard, prioridades e timeline com círculos reais. Revisão assinada pelo usuário; “ficou parecido” não basta. Páginas 1, 3, 8, 10, 12 revisadas explicitamente (mestre §12).
A-18 Nenhum texto, número, nome ou concorrente das referências em auditoria de outra empresa (busca por lista de termos).
A-19 Marca, logo, paleta e fonte conforme C-18/C-19 ⟨decisão⟩.

**Segurança e persistência**
A-20 Download só como operador, por caminho próprio; armazenamento privado; nenhum ponteiro em `gmn_audits`; migration só em `supabase/proposed/`, não aplicada sem autorização.

## 11. Plano E1–E9 revisado (ondas) — [RECOMENDAÇÃO, não aprovada]
Princípio: o que não depende da régua nem de rede avança primeiro. Índice, classificação e PDF final com nota esperam aprovação. Em todas as ondas ficam intactos prospecção, Juiz, grade de 49 pontos, campanhas, relatórios e PDFs antigos, autenticação e RLS; a E9 verifica isso ao fim de cada onda.

| Onda | Etapas | Pode começar quando |
|---|---|---|
| 1 — Domínio offline (sem rede, banco ou UI) | E1 contrato de dados + validador; E2 parser de link; E3 modelo de evidência | D1 e D2 aprovadas |
| 2 — Congelamento e armazenamento local | E5 DADOS_TRAVADOS; E6a armazenamento privado em `.data/link-audits/<id>/` | Onda 1 |
| 3 — UI isolada | E7 | Onda 2 + D-13 |
| 4 — Coleta | E4 | autorização expressa de custo e fontes (D5) |
| 5 — Narrativa | E4b | D5 (motor da narrativa) |
| 6 — Índice | E1b | D2 + D3 (régua v1 aprovada) |
| 7 — PDF | E8 | D4 + autorização do renderizador (B-8) + Onda 6 para a página do Índice |
| 8 — Banco | E6b | G5/RLS + autorização de migration |
| Contínua | E9 regressão | ao fim de cada onda |

**Onda 1** (`src/lib/link-audit/`): E1 — schema zod versionado dos 11 objetos, com `pontos_avaliados` por critério (o JSON não tem) e registro de evidência; o validador aplica REQ-01…REQ-07 e **apenas valida** números recebidos, não atribui pontos; índice desligado (A-21). E2 — `maps-link.ts` classifica cid, `!1s0x…:0x…`, place_id, `@lat,lng`; trata link curto, busca, genérico e host não Google; link curto fica “requer resolução” até a D-12. E3 — rótulos (K-02), origem, URL e data. Testes `tests/link-audit-*.test.ts` na lista do `npm test`, casos A-22 e teste de imports A-01.
**Onda 2**: E5 DADOS_TRAVADOS com SHA-256 e versão; E6a armazenamento local sem migration. Testes: hash muda com o dado; renderer/leitor sem rede; sem sobrescrever (padrão `wx` de `persist.ts`).
**Onda 3**: rota `/auditoria-link` e item na `sidebar.tsx` (links atuais viram `/#secao` fora de `/`); operador cola o link e confirma a identidade; entrada assistida de evidências (URL, data, status). Testes: `middleware.test.ts`; ordem atual de `NAV_ITEMS`; `page.tsx` e prospecção sem alteração.
**Onda 4**: Serper `/maps` só para confirmar identidade por id; `site-check.ts`; `/reviews` opcional; custo por auditoria; sem DataForSEO e sem grade. Testes com mocks; “zero chamadas em teste”.
**Onda 5**: textos do diagnóstico escritos pelo operador, ou por IA no futuro. Testes: termos proibidos, nenhum fato sem evidência, nada copiado das referências (A-18).
**Onda 6**: cálculo com régua, faixas, arredondamento e confiança aprovados; testes com casos sintéticos identificados.
**Onda 7**: PDF lê só DADOS_TRAVADOS; testes A-12…A-19.
**Onda 8**: `supabase/proposed/004_link_audits.sql` e rollback, aplicada só após G5 e autorização; harness local; nenhum ponteiro em `gmn_audits`.
**E9 (cada onda)**: `npm test` (36 suítes + novas), `typecheck`, `build`, `db:check`, `validate:recovery` com hashes iguais, PDFs históricos intactos.

**Funcionalidades que podem ser feitas sem a régua:** parser seguro de link, modelo de evidência, validador de invariantes (só valida), DADOS_TRAVADOS, armazenamento local, UI isolada com entrada assistida, coleta de identidade (após autorização).
**Devem esperar aprovação:** índice, classificação e confiança; PDF final com nota; qualquer texto “Índice Lumos” calculado automaticamente; seleção automática de concorrentes; narrativa por IA; migration.

**Primeira etapa autorizável: Onda 1** (E1 validador + E2 parser + E3 evidência) — 100% offline, sem custo, sem banco, sem UI; depende apenas de D1 e D2.

## 12. Decisões prioritárias (máximo cinco)
1. **D1 — Status da metodologia:** aceitar o mestre como especificação “reconstrução v1” (executável subordinado) e fixar o nome da versão.
2. **D2 — Regra numérica canônica:** fórmulas do manual §2; N/V exclui o peso; exemplos JSON/PDF valem só como forma, nunca como calibração; adotar os rótulos do mestre (com “Não encontrado”).
3. **D3 — Régua v1 dos nove critérios** (a elaborar e aprovar pelo operador): pontos por subitem e regra de parcial (esqueleto da seção 7), nome da faixa 40–59, arredondamento, base zero, limiares de confiança. Até lá, índice “pendente”.
4. **D4 — Padrão visual:** ordem das páginas (guia/PDFs × manual §7), densidade, marca (Lumos ou outra) e aviso §11, logo e foto com licença, paleta, fonte, motor de PDF (protótipo comparativo, LAC-R-24).
5. **D5 — Coleta e IA:** fontes autorizadas (Serper `/maps` só para identidade, `site-check`, entrada assistida), descoberta de concorrentes sem a grade, motor da narrativa (operador agora ou IA futura). Nenhum modelo escolhido; nenhum custo autorizado.

## 13. Registro de decisões e andamento (atualizado em 20/10/2026)

**Decisões do operador**
- **D1 — APROVADA:** o documento mestre é a especificação reconstruída da metodologia, versão 1 (`lumos-reconstruida-v1`). Não se afirma reprodução integral do agente original (instruções e ferramentas antigas não recuperadas).
- **D2 — APROVADA PARCIALMENTE:** adotadas as fórmulas do manual (cobertura = possíveis avaliados ÷ 100 × 100; índice = obtidos ÷ possíveis avaliados × 100); critério sem evidência suficiente fica “Não verificado”, com o peso excluído da base, e não vale zero; exemplos antigos que não fecham não são referência matemática; “Não encontrado” é observação de coleta, permitida só com fonte adequada consultada e ausência documentada, sem pontuação automática.
- **D3 — PENDENTE:** arredondamento, avaliação parcial, classificação (incluindo 40–59), confiança e base zero; régua de pontos por critério. **Nada disso foi implementado.** *(Atualização 07/11/2026: D3 resolvida — régua `regua-d3b-r2` homologada e autorizada em 22/10/2026, D3B-17, e implementada na Onda 6A; ver §23 e `D3B-REGUA-LUMOS-V1-REVISADA.md` §11. O texto acima é o registro histórico de 19/10/2026.)*
- D4 (padrão visual) e D5 (coleta e IA) seguem pendentes.

**Onda 1 — implementada, offline**
- Código: `src/lib/link-audit/{methodology,maps-link,evidence,audit,validate,index}.ts`. Testes: `tests/link-audit-{maps-link,evidence,contract,isolation}.test.ts` (55 testes), incluídos no script `test`.
- Critérios de aceitação cobertos: A-01 (isolamento, nos dois sentidos), A-04 (zero rede nos testes), A-08 (fato com origem, fonte, data e status; externo não prova nativo), A-11 (tabela de links), A-21 (`indexStatus` fixo em `PENDING_METHODOLOGY`; nenhum campo de pontos/índice/cobertura/classificação é aceito) e A-23 (`METHODOLOGY_STATUS` declara reconstrução). Não cobertos nesta onda por dependerem de ondas futuras: A-05/A-06/A-07 (cálculo), A-09/A-10 (congelamento e concorrentes), A-12…A-19 (PDF), A-20 (persistência).
- Decisões de implementação a registrar (todas conservadoras, sujeitas à sua revisão):
  - só links `https://` canônicos de uma lista exata de hosts Google; `http`, IP, credenciais, porta ≠ 443, barra invertida e host não ASCII são rejeitados;
  - identidade só por cid, placeId ou featureId (`!1s0x…:0x…` apenas no segmento `data=` posterior ao nome do lugar); nome e coordenadas nunca identificam; ids nulos (`cid=0`, `0x0:0x0`) são inválidos; ids conflitantes tornam o link ambíguo;
  - links curtos viram `RESOLUTION_PENDING` (sem rede);
  - critérios que são recursos do Google (`CATEGORIES`, `REVIEWS`, `REVIEW_REPLIES`, `POSTS_ACTIVITY`) e atributos `google_*` só são comprovados por origem `GOOGLE_NATIVE` com link de perfil que contenha identificador; fonte externa sobre eles só existe como “Não verificado” + contexto. **Esta lista de critérios é minha leitura do manual §3 e do mestre §5; `SERVICES` e `VISUALS` foram tratados como mistos. Peço revisão.**
  - evidência nativa precisa ter ao menos um identificador em comum, e nenhum divergente, com a identidade confirmada;
  - `identity.originalLink` precisa reproduzir exatamente os identificadores (um link curto resolvido exigirá, futuramente, um campo próprio de link resolvido).

**Verificação (20/10/2026):** `npm test` 423/423 (368 existentes + 55 novos), `npm run typecheck` e `npm run build` sem erros. Hashes SHA-256 de `src`, `supabase`, `scripts`, `assets`, `.data/audits` e `public` iguais ao estado anterior, exceto os 6 arquivos novos em `src/lib/link-audit/`; `package.json` alterado somente na string do script `test`; `.env.local` intocado. Revisão independente (subagente, somente leitura) encontrou 9 achados; 1–5 e 8 corrigidos com testes, 6 e 7 resolvidos pela exigência de `https://` canônico e host ASCII, 9 documentado (o texto de dica deve ser escapado na UI).

**Pendências para a Onda 2 (não iniciada):** DADOS_TRAVADOS (snapshot com SHA-256 e versão) e armazenamento privado local `.data/link-audits/<id>/` sem migration; campo para link resolvido; decisão sobre listar `SERVICES`/`VISUALS` como nativos; aprovação de D3 antes de qualquer índice.

## 14. Onda 2 — snapshot de evidências e armazenamento local (20/10/2026)

**Decisão aprovada registrada:** categorias, avaliações, respostas e Google Posts são atributos nativos (exigem comprovação por fonte adequada); serviços e elementos visuais são critérios mistos, e cada evidência mantém sua origem — site ou Instagram não comprovam serviços, fotos ou vídeos cadastrados no Google. A pontuação continua bloqueada até a D3.

**Implementado (offline):** `src/lib/link-audit/{canonical,snapshot,snapshot-store}.ts`, testes `tests/link-audit-{canonical,snapshot,snapshot-store}.test.ts` e `tests/helpers/link-audit-fixtures.ts` (dados fictícios), política por arquivo em `tests/link-audit-isolation.test.ts`. Documento técnico: `onda2-snapshot-e-armazenamento.md`.

**Critérios de aceitação cobertos:** A-09 (snapshot com SHA-256 e versão; leitura só do snapshot, sem rede; mudar um valor muda o hash), A-20 parcial (armazenamento privado local fora de `public`; sem ponteiro em `gmn_audits`; **sem migration**), A-08 e A-21/A-23 reafirmados. Continuam fora desta onda: A-05…A-07 (cálculo), A-10 (concorrentes), A-12…A-19 (PDF).

**Decisões de implementação (conservadoras, sujeitas a revisão):**
- snapshot ≠ auditoria final: `kind: EVIDENCE_SNAPSHOT`, `indexStatus: PENDING_METHODOLOGY`, schemas estritos sem pontos/índice/cobertura/classificação/confiança;
- identidade confirmada é obrigatória; nova versão não pode trocar a empresa nem o link original, nem retroceder `frozenAt`;
- contrato de link curto: link original + link resolvido + identidade + confirmação posterior à resolução; **a resolução é autodeclarada** (nada a prova nesta onda);
- versões fechadas nunca são editadas, substituídas ou apagadas; corrupção é reportada e bloqueia novas versões;
- o hash é verificação de integridade, **não** assinatura (`HASH_DISCLAIMER`).

**Verificação:** `npm test` 473/473 (368 existentes + 105 da Fase 6), `typecheck` e `build` sem erros; hashes SHA-256 do repositório inalterados exceto os arquivos listados no `NOTES.md`; módulos da Onda 1 idênticos byte a byte. Revisão independente de segurança: sem achados graves; corrigidos o `rename` que podia sobrescrever (substituído por criação exclusiva), a dupla leitura do rascunho, a aceitação de bytes não canônicos e a criação de diretório antes da validação.

**Riscos e pendências:** hash não é assinatura; `/mnt/d` pode não suportar `link()` (caminho alternativo exclusivo porém não atômico em queda); corridas locais por quem escreve na pasta; hard link externo íntegro é aceito; pasta base que seja symlink é aceita; dados em texto simples; resolução real de links curtos, concorrentes, narrativa, PDF e UI seguem pendentes (D3–D5, D-13). A Onda 3 não foi iniciada.

## 15. Onda 3 — interface isolada de Auditoria por Link (20/10/2026)

**Decisão D-13 aprovada:** novo item de menu **Auditoria por Link** → rota **`/auditoria-por-link`** (os documentos anteriores citavam `/auditoria-link`; vale `/auditoria-por-link`). A aba **Auditorias** (`#auditoria`) permanece exatamente como antes. D3, D4 e D5 seguem pendentes.

**Implementado:** tela com entrada do link, resultado nos seis estados do parser, confirmação explícita da empresa e área da auditoria com estados vazios; rotas internas `POST /api/link-audit/parse` e `/confirm` (somente servidor, autenticadas, sem rede e sem gravação). Documento técnico: `onda3-interface.md`.

**Decisões de implementação (conservadoras):**
- o parser da Onda 1 é o único; roda no servidor (depende de `node:dns`/`node:net`) e a tela só importa tipos e `methodology.ts`;
- a confirmação reanalisa o link no servidor, usa o e-mail da sessão e a hora do servidor, e recusa campos enviados pelo cliente; nome, cidade e UF digitados são “informados pelo operador” e **não** são evidência do Google;
- link curto permanece “resolução pendente”: nenhum mecanismo de resolução é autorizado;
- o link é exibido como texto (nunca como âncora) e o nome que vem nele é rotulado “não verificado”;
- a tela não mostra o indicador de saúde do sistema (evita leituras em Redis/Supabase);
- sem gravação pela interface: o risco de atomicidade em `/mnt/d` (caminho sem `link()` não é atômico em queda) continua aberto.

**Critérios de aceitação cobertos:** A-01/A-02 (isolamento, agora com lista fechada de consumidores e varredura transitiva do navegador), A-04 (zero rede nos testes das rotas), A-08/A-21/A-23 reafirmados; nada de pontuação, classificação, PDF ou coleta.

**Verificação:** `npm test` 517/517 (368 existentes + 149 da Fase 6), `typecheck` e `build` sem erros; navegador real (Chromium headless, 1440 px e 390 px): 30 verificações sem falha e sem erros de console; hashes SHA-256 inalterados exceto os arquivos listados no `NOTES.md`; módulos das Ondas 1–2, `middleware`, autenticação, `url-safety` e a página do dashboard idênticos byte a byte. Revisão independente: sem falhas graves; correções aplicadas listadas no `NOTES.md`.

**Limitações e pendências:** parâmetros de consulta do link são devolvidos como digitados (só `usuario:senha@` é mascarado); cookie com `%` malformado causa 500 (pré-existente em `session.ts`, fora do escopo); corpo lido inteiro antes do limite; a confirmação existe só em memória; D3 (régua), D4 (visual/PDF), D5 (coleta/IA), resolução de links curtos, gravação segura e Onda 4 não iniciadas.

## 16. Onda 4A — preparação da coleta e correções de segurança (21/10/2026)

**Decisões do usuário:** dados do Serper `/maps` classificados como **`GOOGLE_NATIVE` com limitação registrada** ("obtido via Serper, intermediário de coleta"; fonte = link do perfil montado dos identificadores confirmados), valendo só para campos que a resposta trouxer; correção do erro 500 do cookie malformado autorizada. Nenhuma coleta real, nenhum crédito consumido, nenhuma IA, nenhuma empresa real.

**Implementado:** (1) correções de segurança (corpo em fluxo com limite efetivo e prazo; saneamento de URLs e de mensagens de erro; evidência com fonte saneada; rotas com erro genérico; cookie malformado ⇒ 401); (2) motor de coleta isolado em `src/lib/link-audit/collector/` com provedores simulados; (3) inventário de fontes e estimativa de chamadas (`onda4a-coleta-inventario.md`).

**Decisões de implementação (conservadoras, sujeitas a revisão):**
- localização do perfil por busca de texto (formato confirmado) e casamento **só por identificador exato**; estratégia por parâmetros `cid`/`placeId` desligada; ambiguidade ou contradição ⇒ nada é escolhido;
- `NOT_FOUND` nunca é produzido automaticamente; campo ausente ou não entregue ⇒ `NOT_VERIFIED` com limitação;
- site, Instagram e outras fontes externas nunca confirmam recurso nativo; o `/reviews` (formato não confirmado) nunca passa de `NOT_VERIFIED`;
- status de critério por regra **mecânica**: `VERIFIED` só se todas as evidências do critério forem `VERIFIED`, senão `NOT_VERIFIED` — **sem** avaliação parcial (D3) e sem pontuação;
- categorias adicionais sempre `NOT_VERIFIED` e divergência de telefone perfil × site é achado `NOT_VERIFIED`, de modo que "VERIFIED" no critério não esconda lacunas;
- orçamento de chamadas validado (0–10 por fonte), prazo por provedor e teto de páginas de avaliações repassado ao provedor.

**Critérios de aceitação cobertos:** A-01/A-02/A-04 (isolamento por arquivo; zero rede, ambiente, relógio ou disco no coletor), A-08/A-10 parcial (evidência com origem/fonte/data; nada inventado), A-21/A-23 reafirmados. Não coberto: A-05…A-07 (cálculo), A-12…A-19 (PDF), concorrentes, coleta real.

**Verificação:** `npm test` 570/570 (368 existentes + 202 da Fase 6), `typecheck` e `build` sem erros; navegador real 34/34; hashes inalterados exceto os arquivos listados no `NOTES.md`; revisão independente sem falha grave e achados corrigidos.

**Pendências e riscos:** créditos por chamada, formato do `/reviews` e parâmetros do `/maps` por identificador **não confirmados** (exigem a primeira chamada real autorizada, Onda 4B); `middleware` do Next pode copiar o corpo antes da rota (não verificado); rotas `enqueue`/`prospect`/`login` sem limite de corpo (fora do escopo); D3, D4, D5, resolução de links curtos e gravação segura em `/mnt/d` seguem abertos.

## 17. Onda 4B — integração controlada dos provedores reais, sem coleta real (21/10/2026)

- **Escopo:** código do provedor Serper `/maps` (1 chamada, sem retry, sem `/reviews`), da verificação segura do site (≤ 8 requisições, sem login/áreas autenticadas), do orçamento/razão de chamadas, da autorização de consumo (LIVE), do modo DRY_RUN, do relatório estruturado e do comando `npm run link-audit:collect`. **Nenhuma chamada paga nem consulta a empresa real foi feita.**
- **Fidelidade:** nenhuma regra metodológica nova; sem pontuação, índice, classificação, confiança, PDF ou IA (`scoring: NOT_AVAILABLE_PENDING_D3`). Dados do Serper `/maps` seguem como `GOOGLE_NATIVE` com a limitação "intermediário, não é a API oficial do Google Business Profile, consultado em <data>"; dados do site ficam separados e nunca são promovidos a nativos; o que não foi comprovado é `NOT_VERIFIED` (nunca "ausente").
- **Identificação da empresa:** o perfil só é aceito por identificador exato (`cid`, `fid` ou `placeId`) igual ao do link; sem identificador comparável ⇒ "não pôde ser confirmado".
- **Controle de custos:** DRY_RUN por padrão; LIVE só com travas de comando + ambiente + autorização única registrada antes da chamada; teto 1 chamada ao `/maps`, 0 ao `/reviews`. Não existe rota HTTP de coleta.
- **Segurança herdada:** `middlewareClientMaxBodySize: '64kb'` (o middleware copiava até 10 MB do corpo antes das rotas).
- **Pendências:** custo real em créditos e formato do `/maps` por identificador (exigem a primeira chamada real autorizada); D3, D4, D5. Detalhes: `onda4b-integracao-provedores.md`.

## 18. Onda 4C — identidade CID/FID offline (21/10/2026)
- Derivação do CID decimal a partir da 2ª metade do FID (BigInt), rotulada como **derivada**; sem Place ID inventado; identidade original e confirmações do operador preservadas.
- Confirmação do perfil **só por identificador** na saída do Serper `/maps` (CID direto ou via `fid` do resultado; `placeId` igual); contradição ou ausência de identificador comparável ⇒ não confirmado; nome nunca confirma. Metodologia Lumos, pontuação e prospecção intactas.
- Custo do `/maps` atualizado para 3 créditos (fonte independente, não oficial; conferência no painel exigida antes do LIVE). Nenhuma chamada real. Detalhes: `onda4c-identidade-cid-fid.md`.

## 19. Onda 4D — pós-LIVE: resgate da evidência e estabilização (22/10/2026)
- Evidência da primeira consulta LIVE (Serper `/maps`, TUVAPLAST) preservada com SHA-256 e manifesto, **sem** chaves/cabeçalhos; cópia no mesmo disco, não é backup independente. Relatório gerado offline, identificando que os dados vêm do Serper (intermediário), não da API oficial do Google; sem pontuação, índice ou Lumos.
- Fidelidade de identidade: o CID é "comprovado" só quando comparado com o retorno do provedor; origem (link × derivado × retornado) sempre registrada. Site: nenhuma afirmação de "exige login" sem evidência (401 + desafio). Nenhuma nova coleta, nenhuma regra metodológica nova. Detalhes: `onda4d-pos-live-resgate.md`.

## 20. Onda 5A — persistência automática e leitura das evidências (22/10/2026)
- Toda coleta paga futura deixa a resposta original do provedor, o status, as tentativas e os créditos informados em arquivos imutáveis com hash (detecção de alteração acidental; **não é assinatura**), antes de qualquer outro processamento; sem armazenamento seguro a coleta é bloqueada. Dados rotulados como Serper (intermediário), nunca como API oficial do Google; sem pontuação, índice ou Lumos.
- O leitor da futura interface exige autorização, nunca expõe o corpo bruto e separa verificado × não verificado; nenhuma rota foi criada e a coleta pela interface permanece desligada. Detalhes: `onda5a-persistencia-e-leitura.md`.

## 21. Onda 5B — visualização das evidências armazenadas (22/10/2026)
- A interface apenas **lê** evidências já preservadas, por rotas autenticadas e de leitura, e as apresenta como **coleta de evidências**, nunca como auditoria estratégica finalizada. Verificado × não verificado separados, origem Serper (intermediário; não é a API oficial do Google), limitações e histórico visíveis; **sem pontuação, índice ou classificação** (D3 pendente); dados externos exibidos só como texto. Dado de arquivo cuja integridade não confere **não é exibido**. Nenhuma coleta, geração de auditoria, PDF ou IA pela interface. Detalhes: `onda5b-visualizacao-das-evidencias.md`.

---
**Parada:** Onda 4B concluída e verificada (sem coleta real); contrato ainda não aprovado integralmente (D3–D5 pendentes). Nenhuma Onda 2 será iniciada sem sua autorização.

## 22. D3A — proposta da régua de pontuação (22/10/2026)
Somente documento: `D3A-PROPOSTA-REGUA-LUMOS-V1.md`. Subcritérios, faixas, zero comprovado, parcial, conflito, arredondamento, 40–59, confiança e condições de publicação são **PROPOSTA PARA APROVAÇÃO** (não pertencem ao agente original). Nenhum código, índice, UI, PDF, consulta externa ou crédito. TUVAPLAST: só mapeamento de evidências (cobertura prevista 30–32 %, sem nota). Aguarda aprovação D3-1…D3-14.

## 23. D3B — régua revisada (22/10/2026)
Somente documento: `D3B-REGUA-LUMOS-V1-REVISADA.md` (a D3A fica como histórico). Corrige faixas sobrepostas de L1/L2, a duplicidade website NAP×Conversão, categorias adicionais, estados de evidência, confiança composta, X5 (URL do website do perfil) e **resolve a divergência com o E0 §7/§13: Serviços e Visuais passam a mistos (9+3 e 8+2 pontos)**. Tudo é PROPOSTA (não pertence ao agente original). TUVAPLAST: 28–30 pontos avaliáveis, `INSUFFICIENT`, sem nota. Onda 6A bloqueada até aprovação D3B-1…D3B-17.
**Ajustes finais de homologação (22/10/2026), régua `regua-d3b-r2`:** escopo de leitura de sites registrado (ausência/zero só com escopo completo; leitura limitada ⇒ N/V); R1 com 1–4 avaliações ⇒ novo estado "Amostra insuficiente" (nota e quantidade preservadas); cobertura final <40 % indisponível · 40–64 % provisório · ≥65 % publicável (o agente original publicou provisórios <40 %, p.ex. VRA 26 %: escolha conservadora); seis fatores de confiança determinísticos e rastreáveis; N/A com registro obrigatório e neutro (≡ N/V); 24 (07/10) e 49 (22/10) são observações distintas, sem causa inferida. Onda 6A **não autorizada**.

## 24. Onda 6A — motor de pontuação (22/10/2026)
Régua `regua-d3b-r2` **homologada** (D3B-1 a D3B-16, com as condições da D3B §0.1: X5 só avalia o uso de UTM; critério avaliado = ≥ 3 pontos possíveis avaliados; sitemap sozinho não comprova o domínio; correção do dado histórico — Daniele Cardoso 21/10/2026 tem cobertura de **11 %**). Implementado `src/lib/link-audit/scoring/` como **módulo puro e não conectado** (sem UI, PDF, coleta, rota, persistência, IA ou rede). Metodologia **reconstruída**, não o agente original recuperado. `methodologyVersion = lumos-reconstruida-v1`, `scoreModelVersion = regua-d3b-r2`, impressão digital da régua e hashes dourados fixados em teste. Detalhes e pendências da 6B em `onda6a-motor-de-pontuacao.md`.

## 25. Onda 6B — persistência das decisões humanas (28/10/2026)
A divisão aprovada das ondas de execução é **6A** (motor, concluída) → **6B** (persistência das decisões humanas e APIs autenticadas, concluída) → **6C** (integração com o motor e interface operacional) → **Onda 7** (PDF). A tabela do §11 permanece como registro do plano original; a coleta ampliada (D5) e os concorrentes continuam dependentes de autorização, e o banco (Onda 8 do §11) só depois de G5/RLS e autorização de migration — por isso as decisões ficam em **arquivos imutáveis**, separados das evidências, e **não** no Supabase.
A 6B guarda o contrato de confirmação humana já aprovado (D3B-13) sem alterá-lo: arquivos `dNNNN.json` encadeados por SHA-256 e **ancorados em pasta separada** (recibos `aNNNN.json`; ADR `onda6b-adr-ancora-externa.md`), histórico append-only (criação, substituição explícita com `supersedes` que só pode ampliar, revogação), `expectedHead` obrigatório nas escritas, autoria da sessão e hora do servidor, evidências citadas verificadas pelo leitor (`capture:cNNNN`, `report:cNNNN-rNNNN`), conjunto vigente validado pelo `parseScoringInput` da 6A e devolvido como `operatorRecords`. Nenhum ponto é calculado, aceito do cliente ou armazenado; `scoring/` não foi alterado. **Emenda 1 do ADR (28/10/2026):** uma decisão só é **confirmada** quando o arquivo `dNNNN` e o recibo `aNNNN` estão gravados; sem o recibo ela é **pendente** (não vale, não é sucesso: 503 `ANCHOR_PENDING`), o leitor devolve só as confirmadas e reenviar o mesmo pedido é idempotente — assim nenhuma decisão prometida pode desaparecer sem ser detectada. Detalhes, contratos, testes e limites: `onda6b-decisoes-humanas.md`. Volume gravável de produção (somente plano): `deploy/hostinger/PLANO-DE-VOLUME-DE-DECISOES.md`.
