# Critérios do Juiz sem evidência: o que falta para verificá-los de verdade

Atualizado em 16/10/2026. Documento da Fase 3 (dossiê PDF).

## Contexto

O dossiê classifica cada um dos 21 critérios do agente Juiz em três classes:

- **Comprovado:** o dado foi lido de uma fonte real.
- **Não verificado:** não há fonte real, ou o valor é fixo/estimado/apenas inferido. Não é aprovação nem reprovação.
- **Simulado:** o sistema gerou o dado no lugar de coletá-lo (conjuntos de avaliações e de vitrine).

Na auditoria real `859b4021-404e-40fc-acba-da21e1fd4746` (`<CIDADE>`/GO, "`<PALAVRA_CHAVE>`"): **7 critérios comprovados (37% do peso)**, **6 simulados** e **8 não verificados**. Ou seja, **14 critérios sem evidência**. A classificação é calculada dos dados a cada geração (`src/lib/pdf/report-evidence.ts`), então muda sozinha quando um agente passar a coletar dado real.

O Score Juiz oficial (fórmula do agente, média ponderada normalizada por 102) **não foi alterado**. Ele inclui os critérios sem comprovação com a pontuação que o agente lhes atribui; o PDF destaca por isso o "Desempenho nos critérios verificados" e mostra o Score oficial à parte, com a ressalva.

## Os 14 critérios (auditoria real)

| Nº | Critério | Peso | Classe | Por que não há evidência (código) | O que verificaria de verdade |
|---|---|---|---|---|---|
| 1 | Propriedade reivindicada e verificada | 6 | Não verificado | `is_claimed: true` fixo no adaptador do Serper (`head-prospector.ts:494`) e `item.is_claimed ?? true` (`:176`) | Campo de reivindicação do perfil: DataForSEO My Business Info (`is_claimed`, confirmado em anúncio do provedor) ou Google Business Profile API com acesso do proprietário (OAuth) |
| 2 | Otimização semântica do nome | 5 | Não verificado | Heurística: o nome contém a 1ª palavra da categoria (`judge-agent.ts:215`); não mede excesso de palavras-chave | Regra de análise textual do nome contra as diretrizes do Google, com revisão humana; não depende de API |
| 4 | Canal de WhatsApp habilitado | 5 | Não verificado | Só o formato do número indica "celular"; não confirma WhatsApp ativo (`whatsapp-contact.ts`) | Link público de WhatsApp na listagem (já tratado como comprovado quando existe) ou confirmação pelo proprietário/cliente |
| 6 | Aderência da categoria principal | 6 | Não verificado | Resultado fixo: sempre aprovado (`judge-agent.ts:333`) | Comparar a categoria principal com as dos líderes do território (dados do Battlefield) |
| 7 | Categorias secundárias | 4 | Não verificado | Derivadas de `types.slice(1)` do Serper (`head-prospector.ts:481`); ausência na coleta não prova ausência no perfil | DataForSEO My Business Info (categorias adicionais; campo exato **a confirmar** na documentação oficial) ou Business Profile API |
| 8 | Catálogo de serviços | 5 | Não verificado | Estimado como `types.length * 2` (`head-prospector.ts`, adaptador do Serper); padrão 3 (`:179`) | Lista de serviços do perfil: Business Profile API (proprietário). **A confirmar** se algum provedor terceirizado a expõe |
| 9 | Horários e atributos | 3 | Não verificado | Atributos fixos `{ verificado_serper: true }` (`head-prospector.ts`, adaptador do Serper) | DataForSEO My Business Info (atributos e horários, confirmados em exemplos do provedor) ou Business Profile API |
| 14 | Termos de serviço nas avaliações | 4 | Não verificado | Resultado fixo: sempre "parcial 60" (`judge-agent.ts:480`) | Texto real das avaliações (ver 12 e 13) e uma análise textual dos termos |
| 12 | Ritmo de avaliações em 30 dias | 6 | **Simulado** | Fallback com 10 avaliações fictícias ("Carlos Eduardo M." etc.), ids `rev_<placeId>_N` (`reputation-agent.ts:199`) | Avaliações reais com data: DataForSEO Reviews (ver nota abaixo) ou Business Profile API |
| 13 | Taxa de resposta do proprietário | 5 | **Simulado** | Mesmo fallback: 40% vem de `index % 3` | Avaliações reais com resposta do dono (`owner_answer`, `owner_timestamp`, citados na referência do DataForSEO) |
| 15 | Volume de fotos | 4 | **Simulado** | O agente chama a API e **descarta o resultado**, devolvendo sempre o payload determinístico (`vitrine-agent.ts:134` e `:152`) | Contagem de fotos: DataForSEO My Business Info (`total_photos`, confirmado em exemplos do provedor) ou Business Profile API |
| 16 | Vídeos | 3 | **Simulado** | Mesmo payload determinístico | **A confirmar** se há contagem de vídeos em algum provedor; Business Profile API (mídia) com proprietário |
| 17 | Recência da última mídia | 4 | **Simulado** | Mesmo payload determinístico | Datas de mídia: Business Profile API; **a confirmar** em provedores terceirizados |
| 18 | Cadência de publicações (Google Posts) | 4 | **Simulado** | Mesmo payload determinístico | Publicações do perfil: Business Profile API (proprietário). DataForSEO tem uma API de atualizações do Business Data; **a confirmar** cobertura |

Comprovados na auditoria real: 3 (endereço público), 5 (site), 10 (nota), 11 (volume vs. líder), 19, 20 e 21 (território). Os itens 10 e 11 só valem quando nota e avaliações não coincidem com os valores padrão do prospector (4,5/15 e 4,4/18) e do Battlefield (4,8/140).

### Notas sobre os provedores (confirmado x a confirmar)

- **Serper.dev (Maps):** a página pública mostra `rating`, `ratingCount`, `type`/`types`, `website`, `phoneNumber`, `description`, `cid`, `placeId`. **Não** mostra fotos, avaliações individuais, respostas do dono nem publicações. O adaptador lê `openingHours`, que **não aparece** na documentação pública consultada: **a confirmar**. Um endpoint de avaliações do Serper não está documentado na página consultada.
- **DataForSEO My Business Info:** existe endpoint **Live** (anunciado pelo provedor em fev/2024) e o provedor documenta `is_claimed`, `total_photos`, `attributes` e horários (`work_time`). **A confirmar** na referência oficial: categorias adicionais e quais atributos.
- **DataForSEO Google Reviews:** as referências encontradas descrevem o fluxo **assíncrono** (`task_post` → `task_get`) e os campos de resposta do dono (`owner_answer`, `owner_timestamp`). **Não** confirmei um endpoint `/live` para avaliações. O agente chama `.../business_data/google/reviews/live` (`reputation-agent.ts:122`); se esse endpoint não existir, é a causa provável de a chamada falhar sempre e cair no fallback simulado. **Verificar primeiro.**
- **Google Business Profile API:** exige OAuth 2.0 com consentimento do proprietário e uma solicitação de acesso comercial. Cobre dados internos (propriedade, serviços, fotos, publicações, respostas). É a única fonte autoritativa para esses itens, mas só para perfis que o cliente conectar.

## Correções de coleta que precisam de uma fase própria

Nenhuma delas foi feita na Fase 3 (a fase não altera os agentes). O PDF apenas as reconhece e as sinaliza.

1. **Vitrine descarta a resposta da API** (`vitrine-agent.ts:134`) e sempre devolve dados determinísticos. Usar o resultado da chamada, ou marcar a origem.
2. **Avaliações: endpoint `/live` possivelmente inexistente**; trocar pelo fluxo `task_post`/`task_get` (ou outro provedor) e **parar de cair silenciosamente** no fallback com autores fictícios (`reputation-agent.ts:199`).
3. **Distribuição de estrelas fabricada** com razões fixas 68/16/8/4% (`reputation-agent.ts:65`). Não é impressa no PDF, mas continua gravada.
4. **`is_claimed` fixo em `true`** e **atributos/serviços fabricados** no adaptador do Serper.
5. **Rivais com dados estimados** (`rivals-agent.ts:86-87,102`): fotos, avaliações em 30 dias e taxa de resposta (94,5 / 86 / 78,5) são inventadas. O PDF não as imprime.
6. **Padrões silenciosos:** nota 4,8 e 140 avaliações para líderes sem dados (`battlefield-agent.ts:375-376,448-449`); nota 4,5 e 15 avaliações para leads sem dados. O PDF trata os pares exatos como "não verificado".
7. **Fallback simulado do Battlefield** (`rivalPool`, `battlefield-agent.ts:480`): se faltarem as chaves de API, os 49 pontos são inventados. O PDF detecta os ids `ChIJ_RIVAL_DOMINATOR_*` e marca o território como simulado.
8. **Itens 6 e 14 do Juiz com resultado fixo**, e valores padrão `?? 180`/`?? 150` para o líder (`judge-agent.ts:177,214`).
9. **Estrategista com ações fixas** (as mesmas 10 sempre, algumas com promessas numéricas). O PDF monta o plano a partir de um catálogo que as vincula à evidência.
10. **Marcador explícito de origem:** adicionar um campo (`dataOrigin`) às saídas de Reputação, Vitrine e Battlefield eliminaria a detecção por marcadores (`rev_<placeId>_`, `med_<placeId>_`, `ChIJ_RIVAL_DOMINATOR_`).

## Como a classificação funciona (referência)

- `detectReputationOrigin`, `detectVitrineOrigin`, `detectBattlefieldOrigin` em `src/lib/pdf/report-evidence.ts`.
- `assessCriteria` aplica uma regra por critério (`VERDICTS`). Ausência de dado nunca vira aprovação nem reprovação.
- Testes: `tests/pdf-evidence.test.ts` (inclui a classificação exata 7/6/8 e os marcadores de simulação).
