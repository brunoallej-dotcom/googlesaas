# Fase 4, Onda 4.0: auditoria das fontes de dados dos 21 critérios

Atualizado em 16/10/2026. Gerado a partir da leitura do código (`src/agents/*`, `src/lib/*`) e dos resultados persistidos; nenhuma consulta externa foi feita para este documento.

## Decisão definitiva de infraestrutura (16/10/2026)

Não serão usados **DataForSEO** nem **Google Business Profile API**, e não serão contratadas novas APIs ou serviços pagos para aumentar a cobertura. A auditoria usa: (1) o Serper já contratado; (2) os dados reais das integrações existentes; (3) verificações técnicas de sites públicos, sem custo de API. O que não puder ser comprovado por essas fontes permanece **NÃO VERIFICADO**, sem simulação. Consultas que consumam créditos só com autorização expressa. As colunas "fonte alternativa" abaixo foram ajustadas a essa decisão; menções históricas aparecem apenas onde explicam o comportamento anterior.

## Como ler

- **Antes** descreve o comportamento até a Fase 3. **Depois** descreve a Fase 4 (implementada em `src/lib/evidence/criteria.ts`).
- Classes: **VERIFICADO** (evidência real suficiente), **PARCIALMENTE VERIFICADO** (evidência real que não comprova todos os requisitos), **NÃO VERIFICADO** (evidência insuficiente ou indisponível) e **SIMULADO** (gerado pelo sistema). Valores fixos nunca contam como dado verificado.
- Os 21 critérios e os pesos históricos (soma 102) não mudaram.
- Capacidades de provedores: só o que foi confirmado em documentação pública está afirmado; o resto está marcado "a confirmar".

## Provedores configurados neste ambiente

| Provedor | Estado | Observação |
|---|---|---|
| Serper.dev (Maps) | Configurado | Devolve nota, avaliações, categorias, site, telefone, endereço, coordenadas e ids. Não informa fotos, vídeos, publicações, serviços nem reivindicação (página pública consultada em 16/10/2026). |
| Serper.dev (Reviews) | Desligado por padrão | Parâmetros da requisição confirmados em cliente público (`fid` obrigatório; `cid`, `placeId`, `sortBy`, `nextPageToken`, `gl`, `hl`). **Formato da resposta não confirmado.** |
| DataForSEO | **Descartado** (decisão de 16/10/2026) | Não será configurado. Os trechos de código antigos que o mencionam são caminhos dormentes e nunca executam sem credenciais. |
| Google Business Profile API | **Descartada** (decisão de 16/10/2026) | Não será integrada. |
| Verificação do site | Nova, sem custo | Requisições HTTP públicas com proteção SSRF. |

## Resumo da auditoria real analisada (`859b4021…`)

Dados persistidos, sem nova coleta. Classificação conservadora de uma auditoria anterior à Fase 4: **5 verificados (26% do peso), 2 parciais (12%), 6 simulados (25%) e 8 não verificados (37%)**. A classificação da Fase 3 era 7/6/8 (37% do peso); a queda de 7 para 5 vem do rebaixamento dos critérios 3 e 5 a parcialmente verificados. Detalhes e comparação: `validation-report.md`.

## Os 21 critérios

### 1. Propriedade Reivindicada e Verificada no GBP

| Campo | Conteúdo |
|---|---|
| Peso original | 6 |
| Dados necessários | Estado de reivindicação do perfil (dono verificado). |
| Fonte utilizada antes da Fase 4 | `lead.claimedByOwner`, que o prospector preenchia com `is_claimed: true` fixo para o Serper (`head-prospector.ts`, `mapSerperPlaceToListing`) e `?? true` na leitura. |
| Existe coleta real? | Não (o Serper Maps não informa reivindicação). |
| Cálculo heurístico? | Não. |
| Valor fixo? | **Sim** (`true` fixo). |
| Simulação? | Não. |
| A evidência comprova todo o critério? | Não comprova nada: o valor era um padrão do sistema. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | Sim, para qualquer dado interno do perfil; sem integração prevista. |
| Custo ou consultas adicionais | Nenhum: sem novas contratações. |
| Grau de confiança | Nenhuma (campo ausente). |
| Próxima ação recomendada | Manter NÃO VERIFICADO e apontar no relatório como validar manualmente com o proprietário. |
| Classificação antes | COMPROVADO (falso) |
| Classificação depois (Fase 4) | NÃO VERIFICADO (`NOT_EVALUATED`, sem pontuação). Só passa a verificado se a origem do campo for `COLLECTED`. |

### 2. Otimização Semântica do Nome Comercial (Sem Keyword Stuffing)

| Campo | Conteúdo |
|---|---|
| Peso original | 5 |
| Dados necessários | Nome do perfil e regras do Google para nomes. |
| Fonte utilizada antes da Fase 4 | `judge-agent.ts`: o nome contém a primeira palavra da categoria (`hasKeywordInName`). |
| Existe coleta real? | Parcial (o nome vem da listagem). |
| Cálculo heurístico? | **Sim** (heurística de texto). |
| Valor fixo? | Não. |
| Simulação? | Não. |
| A evidência comprova todo o critério? | Não: a conformidade com as diretrizes depende do nome real do negócio. |
| Fonte alternativa tecnicamente disponível | Revisão humana comparando com o nome registrado/CNPJ. |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Sem custo de API. |
| Grau de confiança | — |
| Próxima ação recomendada | Revisão manual guiada pelo checklist de diretrizes. |
| Classificação antes | NÃO VERIFICADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO (a heurística não é evidência). |

### 3. Consistência de Endereço Físico vs. Área de Cobertura (Regra SAB)

| Campo | Conteúdo |
|---|---|
| Peso original | 6 |
| Dados necessários | Endereço da listagem, endereço do site/CNPJ/cadastros e modelo de atendimento. |
| Fonte utilizada antes da Fase 4 | `lead.addressRaw` e `isAddressHidden` (derivado de endereço ausente) da listagem; regra SAB por palavras no nome/categoria. |
| Existe coleta real? | Sim, só o endereço da listagem. |
| Cálculo heurístico? | Sim (SAB por palavras-chave). |
| Valor fixo? | Não. |
| Simulação? | Não. |
| A evidência comprova todo o critério? | **Parcial**: o endereço existir não prova consistência com outros canais. |
| Fonte alternativa tecnicamente disponível | JSON-LD `PostalAddress` do site (implementado, sem custo); CNPJ (fonte oficial, não integrada). |
| Exige autorização do proprietário? | Não para o site; sim para áreas internas do perfil. |
| Custo ou consultas adicionais | Sem custo de API (1 a 2 requisições HTTP ao site do lead). |
| Grau de confiança | Média (site) / baixa (inferência SAB). |
| Próxima ação recomendada | Integrar consulta pública de CNPJ em fase própria, se desejado. |
| Classificação antes | COMPROVADO (excessivo) |
| Classificação depois (Fase 4) | **PARCIALMENTE VERIFICADO, sempre, e sem pontuação**: a coincidência entre listagem e site comprova consistência entre dois canais, mas não a regra SAB, a área de cobertura nem o CNPJ (limitações impressas). Divergência: parcial com pontuação indicativa 40. |

### 4. Canal de WhatsApp Habilitado para Conversão Direta

| Campo | Conteúdo |
|---|---|
| Peso original | 5 |
| Dados necessários | Existência de conta WhatsApp ativa que atende mensagens. |
| Fonte utilizada antes da Fase 4 | Formato do telefone (celular provável) ou link `wa.me` na listagem (`whatsapp-contact.ts`). |
| Existe coleta real? | Sim (telefone/link da listagem). |
| Cálculo heurístico? | Sim (formato do número). |
| Valor fixo? | Não. |
| Simulação? | Não. |
| A evidência comprova todo o critério? | **Parcial no máximo**: número ou link não comprovam conta ativa. |
| Fonte alternativa tecnicamente disponível | Link no site (implementado); confirmação pelo proprietário. |
| Exige autorização do proprietário? | Sim para confirmar o atendimento. |
| Custo ou consultas adicionais | Sem custo de API. |
| Grau de confiança | — |
| Próxima ação recomendada | Pedir ao proprietário a confirmação do canal; nunca chamar de verificado pelo formato. |
| Classificação antes | PARCIAL/NÃO VERIFICADO |
| Classificação depois (Fase 4) | PARCIALMENTE VERIFICADO (link ou celular provável) ou NÃO VERIFICADO (fixo ou ausente). Nunca VERIFICADO. |

### 5. Domínio Próprio Indexável Vinculado com LocalBusiness Schema

| Campo | Conteúdo |
|---|---|
| Peso original | 6 |
| Dados necessários | Domínio próprio, resposta HTTP, indexabilidade (noindex, robots.txt) e JSON-LD LocalBusiness. |
| Fonte utilizada antes da Fase 4 | `lead.websiteStatus === 'OWN_DOMAIN'` (apenas o tipo do link na listagem). |
| Existe coleta real? | Sim, o link. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Não. |
| Simulação? | Não. |
| A evidência comprova todo o critério? | Antes: nada além do link. Agora: componentes verificados separadamente. |
| Fonte alternativa tecnicamente disponível | Verificação HTTP do site (implementada, com proteção SSRF); Search Console (indexação efetiva) só com o proprietário. |
| Exige autorização do proprietário? | Search Console: sim. Verificação técnica: não. |
| Custo ou consultas adicionais | Sem custo de API. |
| Grau de confiança | Alta para resposta/noindex; média para o schema (pode ser injetado por JavaScript). |
| Próxima ação recomendada | Conectar Search Console do proprietário se a indexação efetiva for requisito. |
| Classificação antes | COMPROVADO (excessivo) |
| Classificação depois (Fase 4) | VERIFICADO (passa) só com 2xx, sem noindex, sem bloqueio no robots.txt e JSON-LD LocalBusiness; sem schema: PARCIAL; site fora do ar ou não verificado: PARCIAL sem pontuação; noindex: VERIFICADO e reprovado. A indexação efetiva fica como limitação. |

### 6. Aderência da Categoria Principal ao Dominador #1 da Grade

| Campo | Conteúdo |
|---|---|
| Peso original | 6 |
| Dados necessários | Categoria da empresa e categorias dos líderes da grade. |
| Fonte utilizada antes da Fase 4 | **Nenhuma**: `status: 'PASS', scoreAwarded: 100` fixos em `judge-agent.ts`. |
| Existe coleta real? | Não (o resultado era fixo). |
| Cálculo heurístico? | Não. |
| Valor fixo? | **Sim** (PASS 100 fixo). |
| Simulação? | Não. |
| A evidência comprova todo o critério? | Antes: nada. |
| Fonte alternativa tecnicamente disponível | Categorias dos líderes de cada ponto do Battlefield (dados reais já coletados). |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Sem custo adicional. |
| Grau de confiança | Média (categorias da listagem pública). |
| Próxima ação recomendada | Revisar a categoria com o proprietário antes de qualquer mudança. |
| Classificação antes | NÃO VERIFICADO |
| Classificação depois (Fase 4) | VERIFICADO quando há ao menos 10 pontos com líder: compara a categoria com a dos líderes; pontuação 100/60/25 conforme a coincidência (≥50%, ≥20%, abaixo). |

### 7. Densidade de Categorias Secundárias Complementares

| Campo | Conteúdo |
|---|---|
| Peso original | 4 |
| Dados necessários | Categorias adicionais do perfil. |
| Fonte utilizada antes da Fase 4 | `secondaryCategories` = `types.slice(1)` do Serper. |
| Existe coleta real? | Sim, o que a listagem traz. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Não. |
| Simulação? | Não. |
| A evidência comprova todo o critério? | **Parcial**: não há garantia de que a lista pública seja a do painel. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | Sim para o painel. |
| Custo ou consultas adicionais | Nenhum: sem novas contratações. |
| Grau de confiança | Média. |
| Próxima ação recomendada | Confirmar o campo do provedor com 1 chamada autorizada. |
| Classificação antes | NÃO VERIFICADO |
| Classificação depois (Fase 4) | PARCIALMENTE VERIFICADO se houver categorias; NÃO VERIFICADO se não houver (ausência na coleta não prova ausência no perfil). |

### 8. Catálogo Estruturado de Serviços com Descrição Semântica

| Campo | Conteúdo |
|---|---|
| Peso original | 5 |
| Dados necessários | Lista de serviços cadastrados e descrições. |
| Fonte utilizada antes da Fase 4 | `servicesListedCount = types.length * 2` (estimativa) ou 3 por padrão. |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | **Sim** (estimativa/padrão). |
| Simulação? | Não. |
| A evidência comprova todo o critério? | Não comprova nada. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | **Sim.** |
| Custo ou consultas adicionais | Sem custo de API. |
| Grau de confiança | — |
| Próxima ação recomendada | Documentar o procedimento de autorização do proprietário. |
| Classificação antes | NÃO VERIFICADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO. |

### 9. Horário de Funcionamento, Feriados e Atributos Operacionais

| Campo | Conteúdo |
|---|---|
| Peso original | 3 |
| Dados necessários | Horários, feriados e atributos do perfil. |
| Fonte utilizada antes da Fase 4 | `businessHoursConfigured` (presença de `openingHours` no Serper) e `attributesCount` fixo (`{verificado_serper: true}`) ou 4. |
| Existe coleta real? | Parcial (horário, quando o Serper o devolve; o campo `openingHours` não aparece na documentação pública consultada: a confirmar). |
| Cálculo heurístico? | Não. |
| Valor fixo? | Sim (atributos). |
| Simulação? | Não. |
| A evidência comprova todo o critério? | **Parcial**: feriados e atributos não são coletados. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | Sim para o painel. |
| Custo ou consultas adicionais | Nenhum: sem novas contratações. |
| Grau de confiança | Média. |
| Próxima ação recomendada | Validar o formato real de `openingHours` do Serper. |
| Classificação antes | NÃO VERIFICADO |
| Classificação depois (Fase 4) | PARCIALMENTE VERIFICADO se houver horário (pontuação indicativa 85); senão NÃO VERIFICADO. |

### 10. Nota Média de Estrelas na Zona de Alta Conversão (4.6 a 4.9)

| Campo | Conteúdo |
|---|---|
| Peso original | 5 |
| Dados necessários | Nota pública do perfil. |
| Fonte utilizada antes da Fase 4 | `lead.rating` do Serper (`rating`); padrão 4,5/4,4 quando ausente. |
| Existe coleta real? | **Sim**. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Padrão silencioso (removido). |
| Simulação? | Não. |
| A evidência comprova todo o critério? | Sim, para a nota pública (arredondada pelo Google). |
| Fonte alternativa tecnicamente disponível | — |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Incluída na prospecção. |
| Grau de confiança | Alta. |
| Próxima ação recomendada | Manter. |
| Classificação antes | COMPROVADO |
| Classificação depois (Fase 4) | VERIFICADO apenas com nota e total coletados e diferentes dos padrões antigos (4,5/15 e 4,4/18); sem dado: NÃO VERIFICADO. |

### 11. Volume Total de Avaliações vs. Dominador #1 do Território

| Campo | Conteúdo |
|---|---|
| Peso original | 6 |
| Dados necessários | Total de avaliações do perfil e do líder territorial. |
| Fonte utilizada antes da Fase 4 | `lead.totalReviews` e `rivals.topDominators[0].totalReviews` (listagem). Líder sem dados vinha com 4,8/140 (padrão). |
| Existe coleta real? | **Sim**. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Padrão silencioso (removido). |
| Simulação? | Não. |
| A evidência comprova todo o critério? | Sim, quando ambos os valores são reais. |
| Fonte alternativa tecnicamente disponível | — |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Incluída no Battlefield. |
| Grau de confiança | Alta. |
| Próxima ação recomendada | Manter. |
| Classificação antes | COMPROVADO |
| Classificação depois (Fase 4) | VERIFICADO apenas com valores reais dos dois lados; líder sem nota/avaliações vira `null` e o critério fica NÃO VERIFICADO. |

### 12. Ritmo de Novas Avaliações nos Últimos 30 Dias (Recência)

| Campo | Conteúdo |
|---|---|
| Peso original | 6 |
| Dados necessários | Avaliações com data, em número suficiente para cobrir 30 dias. |
| Fonte utilizada antes da Fase 4 | **Simulação**: 10 avaliações fictícias (`rev_<placeId>_N`, autores inventados) quando a API falhava ou não havia credencial (`reputation-agent.ts`). |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Sim. |
| Simulação? | **Sim.** |
| A evidência comprova todo o critério? | Nada comprovado. |
| Fonte alternativa tecnicamente disponível | Serper `/reviews` (implementado, DESLIGADO; formato da resposta NÃO confirmado; cada página consome créditos e exige sua autorização). |
| Exige autorização do proprietário? | Não para avaliações públicas. |
| Custo ou consultas adicionais | Cada página do Serper `/reviews` consome créditos do plano já contratado (quantidade por chamada a confirmar). Só com autorização. |
| Grau de confiança | Média (depende da cobertura da janela). |
| Próxima ação recomendada | Autorizar 1 chamada de teste do Serper `/reviews` para confirmar o formato (ver `implementation-plan.md`). |
| Classificação antes | SIMULADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO sem fonte; VERIFICADO só com todas as avaliações datadas e a janela de 30 dias coberta. Amostra curta: NÃO VERIFICADO (o número seria apenas um mínimo). |

### 13. Taxa de Resposta do Proprietário às Avaliações (>90%)

| Campo | Conteúdo |
|---|---|
| Peso original | 5 |
| Dados necessários | Avaliações com a resposta do dono. |
| Fonte utilizada antes da Fase 4 | **Simulação**: `index % 3 === 0` ⇒ 40% de resposta nas avaliações fictícias. |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Sim. |
| Simulação? | **Sim.** |
| A evidência comprova todo o critério? | Nada comprovado. |
| Fonte alternativa tecnicamente disponível | Idem critério 12 (campo de resposta do dono). |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Idem critério 12. |
| Grau de confiança | Média. |
| Próxima ação recomendada | Idem critério 12. |
| Classificação antes | SIMULADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO sem fonte ou sem o campo de resposta na API; PARCIALMENTE VERIFICADO sobre amostra parcial; VERIFICADO só se a amostra cobre ≥90% das avaliações do perfil. |

### 14. Presença de Termos de Serviços nos Depoimentos de Clientes

| Campo | Conteúdo |
|---|---|
| Peso original | 4 |
| Dados necessários | Texto de avaliações reais. |
| Fonte utilizada antes da Fase 4 | **Fixo**: `status: 'PARTIAL', scoreAwarded: 60` em `judge-agent.ts`. |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | **Sim.** |
| Simulação? | Não (mas as avaliações-base eram simuladas). |
| A evidência comprova todo o critério? | Nada comprovado. |
| Fonte alternativa tecnicamente disponível | Idem critério 12 (textos). |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Idem critério 12. |
| Grau de confiança | Baixa/média. |
| Próxima ação recomendada | Idem critério 12. |
| Classificação antes | NÃO VERIFICADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO sem pelo menos 5 textos reais; PARCIALMENTE VERIFICADO com amostra (correspondência por palavras, não semântica). |

### 15. Acervo Total de Fotografias Proprietárias e de Clientes

| Campo | Conteúdo |
|---|---|
| Peso original | 4 |
| Dados necessários | Quantidade de fotos do perfil. |
| Fonte utilizada antes da Fase 4 | **Simulação**: o `VitrineAgent` chamava a API e descartava a resposta, devolvendo sempre `buildDeterministicVitrinePayload` (9 mídias fictícias). |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Sim. |
| Simulação? | **Sim.** |
| A evidência comprova todo o critério? | Nada comprovado. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | Sim para detalhes; contagem pública via provedor. |
| Custo ou consultas adicionais | Nenhum: sem novas contratações. |
| Grau de confiança | Média. |
| Próxima ação recomendada | Manter NÃO VERIFICADO e apontar no relatório como validar manualmente com o proprietário. |
| Classificação antes | SIMULADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO sem fonte; VERIFICADO só se a fonte informou `totalPhotosCount`. |

### 16. Presença de Vídeos Nativos Demonstrativos (<30s)

| Campo | Conteúdo |
|---|---|
| Peso original | 3 |
| Dados necessários | Quantidade de vídeos. |
| Fonte utilizada antes da Fase 4 | Idem 15 (1 vídeo fictício). |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Sim. |
| Simulação? | **Sim.** |
| A evidência comprova todo o critério? | Nada comprovado. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | Sim. |
| Custo ou consultas adicionais | — |
| Grau de confiança | — |
| Próxima ação recomendada | Pesquisar provedor ou usar a conta do proprietário. |
| Classificação antes | SIMULADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO (sem fonte). |

### 17. Recência da Última Mídia Publicada (<14 Dias)

| Campo | Conteúdo |
|---|---|
| Peso original | 4 |
| Dados necessários | Data da mídia mais recente. |
| Fonte utilizada antes da Fase 4 | Idem 15 (datas fictícias). |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Sim. |
| Simulação? | **Sim.** |
| A evidência comprova todo o critério? | Nada comprovado. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | Sim. |
| Custo ou consultas adicionais | — |
| Grau de confiança | — |
| Próxima ação recomendada | Idem 16. |
| Classificação antes | SIMULADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO (sem fonte). |

### 18. Cadência de Publicações no Mural de Atualizações (Google Posts)

| Campo | Conteúdo |
|---|---|
| Peso original | 4 |
| Dados necessários | Data da última publicação (Google Posts). |
| Fonte utilizada antes da Fase 4 | Idem 15 (post fictício de 54 dias). |
| Existe coleta real? | Não. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Sim. |
| Simulação? | **Sim.** |
| A evidência comprova todo o critério? | Nada comprovado. |
| Fonte alternativa tecnicamente disponível | Nenhuma fonte contratada ou gratuita confirmada (DataForSEO e Business Profile API descartados, ver decisão de 16/10/2026). |
| Exige autorização do proprietário? | Sim. |
| Custo ou consultas adicionais | — |
| Grau de confiança | — |
| Próxima ação recomendada | Idem 16. |
| Classificação antes | SIMULADO |
| Classificação depois (Fase 4) | NÃO VERIFICADO (sem fonte). |

### 19. Taxa de Domínio no Local Pack (Top 3 na Grade de 49 Coordenadas)

| Campo | Conteúdo |
|---|---|
| Peso original | 6 |
| Dados necessários | Posição da empresa em cada ponto da grade. |
| Fonte utilizada antes da Fase 4 | Battlefield: `/maps` do Serper por coordenada, encontrando o perfil por `placeId`/`cid`. |
| Existe coleta real? | **Sim**. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Não (mas havia fallback simulado sem chave de API). |
| Simulação? | Fallback simulado (removido; só com `GMN_DEMO_MODE=true`). |
| A evidência comprova todo o critério? | Sim, para as buscas feitas (variam no tempo). |
| Fonte alternativa tecnicamente disponível | — |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | 49 consultas por auditoria (créditos do Serper; custo por consulta a confirmar). |
| Grau de confiança | Alta. |
| Próxima ação recomendada | Manter; comparar só rodadas compatíveis. |
| Classificação antes | COMPROVADO |
| Classificação depois (Fase 4) | VERIFICADO com ≥40 pontos válidos; PARCIAL com menos; NÃO VERIFICADO sem leitura; SIMULADO se o Battlefield for demonstração. |

### 20. Densidade de Presença Competitiva até o Top 7 Regional

| Campo | Conteúdo |
|---|---|
| Peso original | 4 |
| Dados necessários | Idem 19. |
| Fonte utilizada antes da Fase 4 | Idem 19. |
| Existe coleta real? | **Sim**. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Não. |
| Simulação? | Idem 19. |
| A evidência comprova todo o critério? | Sim. |
| Fonte alternativa tecnicamente disponível | — |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Idem 19. |
| Grau de confiança | Alta. |
| Próxima ação recomendada | Idem 19. |
| Classificação antes | COMPROVADO |
| Classificação depois (Fase 4) | Idem 19. |

### 21. Controle de Zonas de Invisibilidade (>20 na Grade)

| Campo | Conteúdo |
|---|---|
| Peso original | 5 |
| Dados necessários | Idem 19 (pontos fora do Top 20). |
| Fonte utilizada antes da Fase 4 | Idem 19. |
| Existe coleta real? | **Sim**. |
| Cálculo heurístico? | Não. |
| Valor fixo? | Não. |
| Simulação? | Idem 19. |
| A evidência comprova todo o critério? | Sim: mede pontos em que a empresa não aparece; a posição real nesses pontos é desconhecida. |
| Fonte alternativa tecnicamente disponível | — |
| Exige autorização do proprietário? | Não. |
| Custo ou consultas adicionais | Idem 19. |
| Grau de confiança | Alta. |
| Próxima ação recomendada | Idem 19. |
| Classificação antes | COMPROVADO |
| Classificação depois (Fase 4) | Idem 19. |

## Outras fontes que não são critérios, mas alimentavam o dossiê

| Dado | Antes | Depois |
|---|---|---|
| Distribuição de estrelas (68/16/8/4%) | Fabricada por razões fixas (`reputation-agent.ts`) | Removida (`starDistribution: null`) |
| Fotos, avaliações em 30 dias e taxa de resposta dos rivais | Estimadas (`rivals-agent.ts`) | Removidas (`null`) |
| Nota/avaliações do líder do ponto | Padrão 4,8 / 140 quando ausentes | `null` |
| Nota/avaliações do lead | Padrão 4,5/15 ou 4,4/18 quando ausentes | 0 com `provenance: UNKNOWN` |
| `isServiceAreaBusiness` / `isAddressHidden` | `true` sempre que a listagem não traz endereço | Mantido (contrato), mas apresentado como inferência |
| Itens 6 e 14 do Juiz | Resultado fixo | Calculados com dados reais ou não verificados |
| Ações do Estrategista | As mesmas 10 sempre, com promessas ("+25% a 40%") | Geradas das evidências, sem promessas |
| Battlefield sem chave de API | Fallback com rivais `ChIJ_RIVAL_DOMINATOR_*` | 49 pontos sem leitura; fallback só com `GMN_DEMO_MODE=true` |
| Coordenadas do lead sem latitude/longitude | Centro da cidade | **Mantido** (pendente; ver `implementation-plan.md`) |
