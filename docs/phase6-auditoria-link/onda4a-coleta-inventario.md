# Fase 6 · Onda 4A — Preparação da coleta: inventário de fontes, reuso, lacunas e consumo estimado

Status: implementada em 20/10/2026, **sem nenhuma coleta real**. Todos os testes usam provedores simulados e dados fictícios. Nenhuma chamada ao Serper, nenhum crédito consumido, nenhuma IA, nenhuma empresa real consultada. Metodologia: reconstrução `lumos-reconstruida-v1` (não é o prompt original).

## 1. O que a 4A entrega
1. **Correções de segurança** (seção 2).
2. **Motor de coleta** em `src/lib/link-audit/collector/` com provedores **injetados** (interfaces `MapsProvider`, `ReviewsProvider`, `SiteProvider`). O módulo não tem `fetch`, rede, ambiente nem relógio implícito (o teste de isolamento garante). A montagem com provedores reais fica para a 4B.
3. Este inventário e a estimativa de chamadas.

## 2. Correções de segurança
| Ponto | Correção |
|---|---|
| Corpo da requisição | Leitura em **fluxo** com limite de 16 KB: ao passar do limite o fluxo é cancelado (testes: de 1 000 pedaços de 1 KB, só ~17 são puxados) e a resposta é 413. `Content-Length` acima do limite recusa antes de ler; `Content-Length` mentindo não contorna; multibyte conta em bytes. **Prazo de leitura de 10 s** (fluxo gota a gota ⇒ 408 e cancelamento). Limite não verificado: o `middleware` do Next pode copiar o corpo (padrão de 10 MB em `middlewareClientMaxBodySize`) antes da rota; isso só se confirma com a aplicação rodando e `next.config.ts` não foi alterado. |
| Tokens e parâmetros de URL | `originalInput` do parser, a identidade, as respostas das APIs, a tela, as fontes das evidências e os motivos de falha passam por `sanitizeUrl`: ficam só protocolo, host, caminho e os parâmetros que são identificadores **cujo valor tem a forma do identificador** (`cid` numérico, `ftid`, `place_id`, `query_place_id`, `q=place_id:…`; um token colado dentro de `cid=` é descartado). Credenciais, fragmento e qualquer outro parâmetro (token, key, utm, igsh…) nunca saem; segredos reconhecíveis no caminho e na dica de nome são redigidos; esquemas que não são http(s) (`javascript:`…) não são ecoados; texto livre com pares `nome=valor` ou consulta sem esquema também é cortado/redigido. Limite conhecido: um token opaco no caminho da URL não é detectável. |
| Integridade dos identificadores | Teste de propriedade: para todos os formatos aceitos, `parse(saneado)` devolve **exatamente** os mesmos identificadores e `sanitizeUrl` é idempotente. |
| Fontes de evidência | `sourceUrl` com credenciais, fragmento ou parâmetros fora da lista passa a ser **recusada** (nada disso chega ao snapshot). |
| Erros | `safeFailureReason`: classe, código e mensagem saneada (URLs reduzidas, chaves do ambiente e padrões de segredo redigidos), truncada. As rotas respondem 500 genérico, sem mensagem interna nem o link. |
| Dado vindo do provedor | Tratado como hostil: texto sem controle/bidi/segredos e com tamanho limitado (motivos de falha, nomes, endereços, site); datas só valem se forem ISO com fuso e nunca depois de agora; formatos inesperados (lista que não é lista, resultado de site sem campos) não derrubam a coleta nem fazem evidências sumirem; cada chamada tem **prazo** (30 s por padrão) e, ao estourar, vira falha; o provedor de avaliações recebe o **teto de páginas** (`maxPages`) e contagens negativas/NaN viram 0, com alerta se o provedor gastar mais que o orçamento. |
| Cookie malformado | `readCookie` trata `%` inválido como "sem cookie" (401, antes era erro 500). Autorizado pelo usuário; nenhuma regra relaxada. |
| Não alterado (registrado) | `/api/audit/enqueue`, `/api/prospect` e `/api/auth/login` ainda leem o corpo sem limite de tamanho. São da prospecção/autenticação e ficaram como estavam. |

## 3. Reuso dos módulos existentes
| Módulo | Uso na 4A | Alterado? |
|---|---|---|
| `src/lib/url-safety.ts` | Reutilizado como está (forma da URL, SSRF) pelo parser, pelos adaptadores e, indiretamente, pelo `checkWebsite`. | Não |
| `src/lib/site-check.ts` | Reutilizado como está: `checkWebsite(url, { transport, resolver, now })` é o provedor de site (injeção do transporte). O adaptador só recebe o `SiteCheckResult` (tipo importado com `import type`). Teste de compatibilidade com o `checkWebsite` verdadeiro e transporte/resolvedor falsos. | Não |
| `src/lib/serper-reviews.ts` | Só tipos (`ReviewsFetchOutcome`). O endpoint continua **desligado por padrão** e o **formato da resposta não foi confirmado**: nada vindo dele passa de `NOT_VERIFIED`. | Não |
| `src/agents/head-prospector.ts` | **Não importado.** É privado, acoplado à prospecção (campanhas, fallback DataForSEO, demo). Só o *formato* do Serper `/maps` foi replicado num leitor defensivo novo (`maps-place.ts`): `POST /maps` com `q`, `ll` (`@lat,lng,Zz`), `gl:'br'`, `hl:'pt-br'`, cabeçalho `X-API-KEY`; itens com `title`, `address`, `latitude`, `longitude`, `rating`, `ratingCount`, `type`, `types`, `website`, `phoneNumber`, `openingHours`, `cid`, `fid`, `placeId`. | Não |
| `src/lib/redact.ts` | `redactSecrets` (valores literais de variáveis sensíveis e padrões de chave/token) usado em `url-redaction.ts`. | Não |

## 4. O que o sistema poderá coletar (e o que não)
Origem dos dados do Serper `/maps`: **`GOOGLE_NATIVE` com limitação registrada** ("obtido via Serper /maps, intermediário de coleta da listagem pública; o perfil não foi aberto diretamente no Google"), conforme decisão do usuário, e só para campos que a resposta realmente trouxer. A fonte de cada evidência é o link do perfil montado **dos identificadores confirmados pelo operador**.

| Critério | Dado | Fonte | Confirmado? | Como aparece |
|---|---|---|---|---|
| NAP | nome, endereço, telefone, horários | Serper `/maps` | sim (campos usados na prospecção) | `VERIFIED` se veio; senão `NOT_VERIFIED` ("a fonte não informou… não é prova de que não existe") |
| NAP | coerência telefone do perfil × telefone do site | `/maps` + `site-check` | sim | coincide ⇒ `VERIFIED`; **diverge ⇒ `NOT_VERIFIED`** ("requer conferência do operador"); origem `OFFICIAL_SITE`; só dígitos, sem o código 55 |
| CATEGORIES | categoria principal (`type`) | `/maps` | sim | `VERIFIED`; as categorias adicionais ficam sempre `NOT_VERIFIED` ("completude não comprovada"), então o critério fica `NOT_VERIFIED` |
| REVIEWS | nota e quantidade de avaliações | `/maps` | sim | `VERIFIED` (valor do momento da coleta) |
| REVIEWS | recência e contexto | — | **não** | `NOT_VERIFIED` (sem datas; endpoint de avaliações não confirmado) |
| REVIEW_REPLIES | respostas do dono | `/reviews` | **não** (formato) | `NOT_VERIFIED` |
| POSTS_ACTIVITY | Google Posts | — | **não** (o `/maps` não entrega) | `NOT_VERIFIED` |
| VISUALS | fotos e vídeos do perfil | — | **não** | `NOT_VERIFIED` |
| SERVICES | serviços, atributos e produtos nativos | — | **não** | `NOT_VERIFIED` |
| SERVICES | tipos `LocalBusiness` declarados no site | `site-check` | sim | `VERIFIED` como observação do site (não são serviços cadastrados no Google) |
| CONVERSION | site informado no perfil | `/maps` | sim | `VERIFIED` (o campo); se for rede social/agregador, o site não é consultado |
| CONVERSION | resposta HTTP, noindex/robots, links de telefone/WhatsApp/e-mail | `site-check` | sim | `VERIFIED`, origem `OFFICIAL_SITE`, sem custo de API; nunca comprova recurso nativo |
| LOCAL_AUTHORITY | presença digital externa | — | **não** | `NOT_VERIFIED`; se o "site" é Instagram/Facebook etc., registra só que o perfil aponta para lá (`nativeContext`) |

Regras que valem para tudo: `NOT_FOUND` **nunca** é produzido automaticamente (ausência numa resposta de intermediário não prova ausência no Google); dado de site, Instagram ou outra fonte externa nunca vira confirmação de recurso nativo; o status do critério segue uma regra **mecânica e conservadora** (`VERIFIED` só se todas as evidências do critério forem `VERIFIED`; qualquer outra combinação é `NOT_VERIFIED`) — a regra de avaliação parcial é da D3 e não foi implementada. Nada de pontuação, classificação ou confiança.

### Como o perfil é localizado
1. Busca por texto (formato confirmado): `q` = nome informado pelo operador (ou, se não houver, o nome que aparece no link, **não verificado**) + cidade/UF informadas; `ll` = coordenadas do link, se houver.
2. Casamento **só por identificador exato** (`cid`, `placeId`, `fid`). Nome nunca casa. Candidato que casa por um identificador e contradiz outro, ou dois negócios distintos casando ⇒ **ambíguo, nada é escolhido**. Nenhum resultado casando ⇒ "não localizado" (`NOT_VERIFIED`).
3. Estratégia por parâmetros `cid`/`placeId` no `/maps`: **desligada** (parâmetros não confirmados).
4. Sem nome e sem dica no link: nenhuma chamada é feita; o operador precisa informar o nome.
5. Links curtos continuam "resolução pendente": nada é resolvido pela internet nesta onda. O contrato do snapshot já prevê vincular link original, link resolvido, identidade e confirmação.

## 5. Estimativa de chamadas por auditoria
### Comprovado pelo código atual
| Fonte | Chamadas | Custo de API |
|---|---|---|
| Serper `/maps` | **1 por tentativa de busca**. A prospecção usa 2 páginas por campanha e até 3 tentativas por falha; a auditoria por link propõe **1 chamada, sem repetição automática**. | créditos por chamada **não confirmados** |
| `site-check` (site próprio) | 0 créditos. Até 4 requisições HTTP à página (1 + 3 redirecionamentos) e até 4 ao `robots.txt`: **no máximo 8**, tipicamente 2. | nenhum |
| Serper `/reviews` | **0 por padrão** (desligado: `GMN_REVIEWS_PROVIDER` ≠ `serper`). Se ligado, 1 a 5 páginas (`GMN_REVIEWS_MAX_PAGES`, padrão 1), cada página uma chamada. | créditos por chamada **não confirmados** |
| Grade de 49 pontos / DataForSEO | **0** — a Auditoria por Link não usa. | — |

### Depende de consulta ao provedor (não confirmado)
- Créditos cobrados por chamada do `/maps` e do `/reviews` (confirmar no painel do Serper).
- Se a busca por nome + cidade + coordenadas do link devolve o perfil entre os resultados (e se o item traz `cid`/`fid`).
- Se o `/maps` aceita `cid`/`placeId` como parâmetros (hoje desligado).
- O formato da resposta do `/reviews` (datas, respostas do dono).

### Consumo máximo proposto para a primeira auditoria real
**Serper `/maps`: no máximo 1 chamada. Serper `/reviews`: 0. `site-check`: até 8 requisições HTTP sem custo de API. IA: nenhuma.** Se a busca não localizar o perfil, a coleta termina com "não localizado" e **nenhuma segunda chamada é feita sem nova autorização**.

## 6. O que falta para habilitar a primeira auditoria real (Onda 4B)
1. **Sua autorização expressa**, por escrito: provedor, número máximo de chamadas (proposto: `/maps` ≤ 1, `/reviews` = 0), empresa-alvo (link completo com identificador — link curto não funciona) e data.
2. Confirmar no painel do Serper o **saldo** e o **custo por chamada** (o repositório não os registra).
3. **Raiz de composição dos provedores reais** (arquivo novo, somente servidor, fora do módulo isolado): provedor Serper `/maps` com `fetch` próprio, tempo limite, **sem repetição**, erros por `safeFailureReason`, contador de chamadas; provedor de site = `checkWebsite` existente; ligação ao `collectEvidence` com o orçamento acima. Nenhuma chave é lida fora desse arquivo.
4. Rota ou comando protegido para disparar a coleta com confirmação do operador e orçamento explícito (a interface atual não tem botão de gerar auditoria e continuará sem ele até esse passo).
5. Decidir **onde guardar** o resultado: gravação de snapshot só depois de validar a atomicidade em `/mnt/d` (ou exibir sem gravar).
6. Após a primeira chamada: **registrar o formato real da resposta**, atualizar a tabela de capacidades e só então decidir sobre `/reviews`, busca por parâmetros e novos campos.
7. Continuam pendentes e fora desta etapa: D3 (régua, avaliação parcial, pontuação), D4 (visual e PDF), D5 (concorrentes, narrativa, IA).

## 7. Lacunas conhecidas
Google Posts, fotos e vídeos do perfil, serviços/atributos/produtos nativos, respostas do dono, recência das avaliações, completude das categorias secundárias, presença em redes sociais além de saber que o perfil aponta para elas, concorrentes, narrativa e qualquer pontuação. O perfil não é aberto diretamente no Google: tudo que vem do `/maps` é de intermediário.

## 8. Arquivos
Novos: `src/lib/link-audit/url-redaction.ts`; `src/lib/link-audit/collector/{types,capabilities,maps-place,adapters,collect,index}.ts`; testes `tests/link-audit-{redaction,body-limit,collector}.test.ts`. Alterados (segurança): `src/app/api/link-audit/{body.ts,parse/route.ts,confirm/route.ts}`, `src/lib/link-audit/{maps-link.ts,evidence.ts,index.ts}`, `src/lib/auth/session.ts` (só `readCookie`), `tests/link-audit-isolation.test.ts` (política por arquivo), `tests/middleware.test.ts` (caso do cookie), `package.json` (só o script `test`).

## Atualização da Onda 4B (21/10/2026)
O código dos provedores reais, o orçamento/autorização, o DRY_RUN e o relatório estruturado foram implementados **sem coleta real**; a leitura antecipada do corpo pelo middleware foi confirmada e limitada a 64 KB. Ver `onda4b-integracao-provedores.md`.
