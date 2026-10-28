# LACUNAS, CONFLITOS E DECISÕES — RECONSTRUÇÃO DO AGENTE DE AUDITORIA

**Complemento obrigatório:** `INSTRUCOES_MESTRAS_AGENTE_AUDITORIA_GBP_v1.md`  
**Data:** 20/10/2026  
**Importante:** esta tabela foi produzida independentemente a partir dos cinco anexos originais e do relato do Claude. **Não é a tabela C-01 a C-20 original nem a reconstrução do Claude**, cujo conteúdo completo não foi anexado aqui. As referências são indicadas para facilitar a auditoria pelo Claude Code.

## 1. Resumo do que é seguro afirmar

- A metodologia possui **nove critérios conhecidos**, pesos `15, 10, 12, 18, 8, 10, 8, 10, 9` (**100** pontos máximos).
- A fórmula escrita no manual é: **cobertura = pontos possíveis efetivamente avaliados / 100 × 100**; **índice = pontos obtidos / pontos avaliados × 100**.
- Um dado nativo do Google inacessível deve ser **não verificado**, nunca convertido automaticamente em `zero`, `avaliado` ou presumido a partir do site/redes.
- O PDF deve ser gerado **depois** da auditoria escrita e **sem investigação adicional**, usando `DADOS_TRAVADOS`.
- O padrão editorial validado apresenta **12 páginas A4 verticais**, com os dois PDFs seguindo a ordem do guia de espelhamento.
- O JSON exemplificativo demonstra a estrutura dos dados, mas é **inconsistente nos cálculos**.
- O método de pontuação interna dos nove critérios **não foi enviado**; não pode ser apresentado como recuperado do GPT original.

## 2. Confronto numérico demonstrável

| Fonte | Valores encontrados | Checagem matemática | Resultado |
|---|---|---|---|
| **Manual §2**, exemplo declarado correto | Base 54,5/65; Cobertura 65%; Índice 84 | 54,5 ÷ 65 × 100 = 83,846...; cobertura 65/100 = 65% | **Consistente**, para exibição do Índice arredondado |
| **JSON**, `metadata` | Índice 72; Cobertura 78; Base 54/75 | 54 ÷ 75 × 100 = 72; cobertura pela fórmula seria **75%**, não 78% | **Índice compatível com a base declarada; cobertura incompatível** |
| **JSON**, `score_breakdown[]` | Nove linhas, 68 pontos somados, 100 pesos máximos | 11+7+8+14+5+7+3+7+6 = **68**, diferente dos 54 pontos declarados em `metadata` | **Tabela incompatível com Base Observada** |
| **PDF Lumos**, página 4 | Critérios 8/15, 5/10, 9/12, N/V, N/V, 7/10, 6/8, 6/10, 6/9; Índice 64; Cobertura 58% | 47 pontos em 74 possíveis (dois critérios N/V: 18 e 8 excluídos). 47/74 ≈ 63,51 → 64; cobertura seria **74%** | **Índice compatível com 47/74; cobertura exibida incompatível** |
| **PDF Rio Radical**, página 4 e resumo da página 2 | 14/15, 7/10, 10/12, 17/18, 5/8, 8/10, 5/8, 10/10, 8/9; Índice 84; Cobertura 81% | 84 pontos somados, 100 máximos avaliados se todos os critérios forem considerados; cobertura seria **100%** | **Índice coincide com 84/100; cobertura exibida incompatível** |

### Problema de evidência nos exemplos

- **JSON:** `Publicacoes e atividade` consta **`Nao verificado` e recebe 3/8**; isso conflita com o manual quando a verificação nativa é necessária.
- **PDF Lumos:** alguns critérios recebem pontos mesmo quando a página de snapshot informa que informações nativas ficaram não verificadas. É preciso distinguir o que foi confirmado externamente do que seria exclusivamente nativo.
- **PDF Rio Radical:** páginas 3 e 7 registram Google Posts/respostas/fotos não inteiramente verificáveis, enquanto a página 4 pontua atividade, respostas e fotos como critérios completos, sem indicar denominador parcial.

**Condição de aceite:** não usar nenhum desses três exemplos para calibrar automaticamente a pontuação sem definir primeiro uma versão explícita da regra. O fato de a peça estar visualmente aprovada não confirma a integridade numérica.

## 3. Matriz de decisões necessárias

| ID (deste anexo) | Tema | Evidência concreta | Decisão ainda necessária | Recomendação **não aprovada** |
|---|---|---|---|---|
| **R-01** | Ordem das 12 páginas | Manual §7 coloca Índice na pág. 3 e outros capítulos em posições distintas; Guia §4 e PDFs colocam snapshot na 3, índice na 4, prioridades na 9 e plano na 10 | Qual ordem é definitiva? | Preferir **Guia/PDFs aprovados** para fidelidade visual |
| **R-02** | Densidade | Manual §6: 55%–82% e ≥2 módulos; Guia §5: 65%–85% e ≥3 módulos; PDFs possuem áreas amplas vazias | Qual regra tem prioridade? | Preservar a linguagem visual, proibir preenchimento artificial e exigir revisão humana |
| **R-03** | Validação por página | Manual §8 e §10 mencionam matemática na pág. 3 e prioridades na 10; Guia os coloca nas págs. 4 e 9 | Adaptar testes à paginação aprovada? | Sim, se escolhido o Guia |
| **R-04** | Identidade visual | Manual fornece paleta e faixas de tamanho; PDFs possuem aparência ligeiramente distinta | Prioridade: valores exatos do manual ou pixels dos modelos? | Tomar o PDF principal como referência visual e documentar tolerância |
| **R-05** | Fonte | Manual não fixa família; análise externa do Claude relatou Arimo no Lumos e DejaVu Sans no Rio; GMN atual usa Inter | Fonte obrigatória? | Escolher depois de ensaio visual; não declarar Arimo como regra original |
| **R-06** | Logo | Guia §1 cita `01_Logo_Oficial_Lumos.jpg`, **não entregue** | Fornecer/extrair/aprovar a marca? | Não recriar artificialmente nem substituir sem consentimento |
| **R-07** | Foto de capa | Guia pág. 1 pede faixa fotográfica; nenhum arquivo de capa separado foi entregue | Qual imagem aprovada pode ser usada? | Não reutilizar imagem de terceiros sem direito e aprovação |
| **R-08** | Marca/rodapé | Manual §11 exige atribuição Lumos; GMN é o software de destino | PDF sai em Lumos, GMN ou VRA? Mantém nome Índice Lumos? | Manter a atribuição original **até decisão explícita** |
| **R-09** | Cobertura do JSON | 54/75 exige 75%, mas exemplo afirma 78% | Regra canônica de cobertura? | Usar fórmula expressa no manual, não porcentagens inválidas dos exemplos |
| **R-10** | Base do JSON | Soma dos critérios = 68, mas `metadata` declara 54/75 | Como representar denominador por critério? | Exigir `pontos_avaliados` verificáveis em contrato versionado |
| **R-11** | Cobertura PDF Lumos | 47/74 dá índice 64, porém cobertura mostrada 58% | Corrigir o cálculo na automação? | Seguir fórmula do manual com cobertura 74% nesta tabela ilustrativa |
| **R-12** | Cobertura PDF Rio | 84/100 dá 84, porém cobertura mostrada 81% | Qual valor é canônico? | Não copiar 81% como fórmula; usar evidências reais do novo caso |
| **R-13** | Recursos N/V pontuados | Manual §3 manda excluir peso; JSON e PDFs demonstram pontos com acesso parcial/ausente | Qual granularidade e regra exata dos casos mistos? | Preservar N/V e jamais pontuar o que não foi confirmado |
| **R-14** | Sub-régua dos nove critérios | Apenas pesos máximos foram enviados | Definir subitens, descontos, critérios de parcialidade, âncoras e justificativas | Formular uma **nova** régua v1 e validar exemplos; não chamá-la de original |
| **R-15** | Classificação 40–59 | PDF exemplifica 0–39, 60–74, 75–89, 90–100 | Nome e significado da faixa 40–59 | Não inferir a classe; solicitar aprovação |
| **R-16** | Arredondamento/base zero | Manual dá exemplo 54,5/65→84, sem política completa | Precisão interna, apresentação, empate, base=0 | Cálculo decimal exato; sem índice para base=0, até aprovação |
| **R-17** | Confiança/limiares | PDF Lumos baixa, Rio média, JSON média; nenhum define intervalos | Definir cortes e aplicação da cobertura | Exibir ressalvas qualitativas sem classe automática até regulamentar |
| **R-18** | Concorrentes | Manual §4: nome, região, equivalência, fonte, ≥2 elementos; número e modo de busca indefinidos | Número máximo, algoritmo de seleção e região | Selecionar poucos equivalentes **com prova**, ou admitir ausência de comparativo |
| **R-19** | Prioridades | PDFs/JSON usam P0–P3 com impacto/esforço/prazo; não há função de classificação completa | Critérios formais P0/P1/P2/P3 e responsabilidades | Avaliação justificada e revisão do operador até ter regra |
| **R-20** | Ferramentas e IA originais | Não há instrução original das ferramentas; Claude reporta que GMN não chama modelo de IA | IA vs análise determinística; escolha de fornecedor; custo e aprovação | Não contratar nem executar API paga sem autorização |
| **R-21** | Entrada por URL | O sistema atual só avalia lead, sem parser de Maps, segundo Claude | Link completo, curto, identificação ambígua, URLs inválidas | Parser seguro, identificação antes de coleta paga |
| **R-22** | Contrato de armazenamento | O schema atual do JSON não contém denominador por critério; GMN `gmn_audits` exige lead/campanha, segundo Claude | Novo schema/tabela separada, integrações e migração | Domínio próprio para auditoria por link, sem mexer em campanhas |
| **R-23** | Segurança e custos | Serper `/maps` disponível, `/reviews` desabilitado, segundo Claude; no material original não há lista de APIs | Fontes verificáveis e orçamento aprovado por auditoria | Coleta monitorável, limitada e com orçamento explícito |
| **R-24** | PDF engine | Claude sugere PdfKit atual, mas modelos foram renderizados com WeasyPrint segundo análise externa | Motor com maior fidelidade visual, sem criar nova dependência desnecessária | Prototipar reprodução comparativa e decidir por evidência |

**Observação:** itens R-01 a R-24 são a nossa taxonomia deste anexo; **não afirmam corresponder diretamente** aos C-01 a C-20 do diagnóstico que o Claude Code numerou.

## 4. Decisões indispensáveis para concluir a E0

Recomendação de **ordem** de aprovação para liberar desenvolvimento sem promessas indevidas:

**Primeiro — autenticidade do método:**

1. Assumir oficialmente que estas são **instruções reconstruídas**, não o prompt original recuperado;
2. Aprovar ou mandar elaborar uma nova **régua objetiva de distribuição de pontos para nove critérios** e denominadores parciais;
3. Aprovar cobertura segundo fórmula do manual e política de não pontuar recursos nativos não verificados;
4. Aprovar faixa 40–59, arredondamento e base zero;
5. Definir confiança e como comunicar cobertura baixa.

**Depois — apresentação e operação:**

6. Autorizar a organização das páginas pelo Guia + PDFs em vez do Manual §7;
7. Decidir identidade (Lumos vs GMN/VRA), logo e capa;
8. Definir seleção de concorrentes e tolerância a fontes heterogêneas;
9. Aprovar mecanismo de coleta de URLs/custo, se aplicável, **antes de chamadas pagas**;
10. Escolher modelo de IA e motor de PDF somente após comparar custo, segurança e fidelidade.

A E0 documental pode ser marcada como **produzida**, mas **não como contrato 100% aprovado**, enquanto esses pontos permanecerem pendentes. O avanço em testes offline, parser de URL e estrutura de evidência pode ser planejado em waves independentes após a autorização do operador, sem prometer que o índice final já é reproduzível.

## 5. Exemplos de regressão que devem existir quando a régua for aprovada

- **Base zerada:** nenhum índice numérico, sem divisão por zero.
- **Componente nativo invisível:** status N/V; excluir o denominador correspondente e manter transparência.
- **Fonte externa apenas:** foto no Instagram não se torna foto do Google.
- **Dados contraditórios:** fonte oficial e diretório diferentes → conflito de fonte, não extrapolação.
- **Critério parcialmente verificável:** demonstrar como numerador e denominador são obtidos a partir da regra aprovada.
- **Auditoria demo do manual:** `54,5/65` → índice apresentado `84`, cobertura `65%`, classificação Forte.
- **JSON exemplo:** não permitir que `metadata` diga `54/75` e `score_breakdown` totalize 68.
- **PDF Lumos e Rio:** não copiar coberturas inconsistentes para novas auditorias.
- **Concorrência insuficiente:** relatório informa a limitação, sem empresas inventadas.
- **PDF travado:** regeneração não muda fonte, pontuação, concorrentes ou data.
- **Identidade errada:** URL ambígua não dispara auditoria da empresa homônima.
- **Regressão GMN:** campanhas, prospecção, Juiz existente, grade, histórico e PDFs antigos seguem funcionando.

## 6. Referências

- `01_Dados_Exemplo_Auditoria_Lumos_v2.json` — objetos `metadata`, `score_breakdown`, `diagnostics`, `competitors`, `priorities`, `plan_30_days`;
- `02_Manual_Visual_e_Qualidade_Lumos_v2.md` — §§1–11;
- `03_Guia_de_Espelhar_Modelos_Aprovados_Lumos.md` — §§1–7;
- `04_Referencia_Principal_Lumos_Marketing.pdf` — págs. 1–12, especialmente 3–4 e 8–12;
- `05_Referencia_Secundaria_Rio_Radical.pdf` — págs. 1–12, especialmente 3–4 e 7–12;
- Relato textual do Claude Code fornecido pelo operador sobre a análise da GMN, **não uma inspeção direta do repositório nesta rodada**.
