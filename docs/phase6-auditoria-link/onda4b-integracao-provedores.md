# Fase 6 · Onda 4B — Integração controlada dos provedores reais (sem coleta real)

Status: implementada em 21/10/2026. **Nenhuma chamada paga, nenhuma consulta a empresa real e nenhuma requisição de rede foi feita** (provas abaixo). Metodologia: reconstrução `lumos-reconstruida-v1`. D3, D4 e D5 continuam pendentes. Sem pontuação, índice, classificação, PDF ou IA.

## O que foi construído
Código que liga o motor de coleta da 4A ao Serper `/maps` e à verificação do site próprio, com orçamento, autorização, modo DRY_RUN e relatório estruturado. O caminho de coleta real (LIVE) existe como código, mas só pode ser acionado por um comando deliberado do operador e foi exercitado apenas com transporte falso.

| Peça | Arquivo | Papel |
|---|---|---|
| Orçamento, razão de chamadas e autorização | `src/lib/link-audit/collector/budget.ts` | Puro. `CallLedger` registra cada tentativa **antes** da chamada; tentativa que falhou **nunca** é repetida; `evaluateAuthorization` falha fechada. |
| Estimativa de custo | `collector/cost.ts` | Puro. Faixas, sempre `confirmed:false`; parâmetro desconhecido vira "desconhecido". |
| Resumos e divergências | `collector/summaries.ts` | Puro. Perfil (Maps) e site ficam **separados**; divergências de telefone, nome e domínio. |
| Relatório | `collector/report.ts` | Puro. `CollectionReport` sem pontos/índice/classificação (`scoring: NOT_AVAILABLE_PENDING_D3`). |
| Provedor Serper `/maps` | `src/lib/link-audit-runtime/serper-maps-provider.ts` | Única chamada paga; **único** arquivo com `fetch(`. |
| Provedor do site | `link-audit-runtime/site-provider.ts` | Sobre `checkWebsite` (inalterado) com transporte limitador. |
| Configuração | `link-audit-runtime/config.ts` | Recebe o `env` por argumento; nunca devolve a chave. |
| Autorizações usadas | `link-audit-runtime/used-authorizations.ts` | Marcador exclusivo (`wx`) criado **antes** da chamada. |
| Orquestração | `link-audit-runtime/run.ts` | `runLinkAuditCollection`: DRY_RUN (padrão), SIMULATED, LIVE. |
| Comando | `scripts/link-audit-collect.ts` (`npm run link-audit:collect`) | Único consumidor do runtime. |

Alterados: `collector/{collect,types,capabilities}.ts` (aditivo: razão opcional, `profile`, `siteObservation`, `divergences`, `provenIdentifiers`, `queriedAt`; limitação de origem agora diz "Serper /maps, intermediário… não é a API oficial do Google Business Profile"), `next.config.ts`, `package.json`, `tests/link-audit-isolation.test.ts`.

## Regras do Serper `/maps`
- Máximo **1 chamada por tentativa**, sem retry automático, sem refresh, sem `/reviews` (orçamento fixo em 0 no LIVE).
- Corpo: `{ q, ll?, gl:'br', hl:'pt-br', page:1 }`; cabeçalho `X-API-KEY`; `redirect:'error'` (a chave não acompanha redirecionamento); URL obrigatoriamente `https://*.serper.dev/maps`, validada **antes** de enviar; resposta ≤ 1 MB; falha HTTP revela só o código.
- **Nenhum perfil é aceito por semelhança de nome.** A busca por texto só traz candidatos; o perfil só vale se algum identificador (`cid`, `fid`, `placeId`) for **igual** ao do link. Se os resultados não trazem identificador do mesmo tipo do link, o resultado é "não pôde ser confirmado" com a limitação explícita.
- Cada evidência registra origem (Serper `/maps`), data da consulta e a limitação de que não é a API oficial do Google Business Profile.

## Site próprio
Máximo **8 requisições HTTP** por verificação (a 9ª é recusada); caminhos de login/admin/conta/checkout e respostas 401/403/`WWW-Authenticate` não são coletados (inclusive como destino de redirecionamento); SSRF, DNS fixado e revalidado em cada salto, bloqueio de endereços privados/metadados, 8 s, 512 KB e leitura por expressões regulares **sem executar JavaScript** vêm de `site-check.ts`/`url-safety.ts` (não alterados) e têm testes de regressão com resolvedor falso. Dados do site ficam em `found.site`; dados do Maps em `found.googleMaps`.

## Controle de custos
- Nada acontece ao abrir a página nem ao validar o link: **não existe rota HTTP de coleta** (teste estático: nenhuma rota, página, componente ou worker importa o runtime).
- **DRY_RUN é o padrão** (função e comando): devolve plano e estimativa, não lê o ambiente, não cria provedores e não devolve dado de empresa.
- **LIVE** exige, juntos: `--live --authorization-id <id> --max-maps-calls 1 --ack-cost`; `GMN_LINK_AUDIT_LIVE=on`, `GMN_LINK_AUDIT_MAX_MAPS_CALLS=1` e `GMN_LINK_AUDIT_AUTH_ID=<mesmo id>` no ambiente do comando; chave utilizável; URL do Serper válida; identidade confirmada; autorização válida (≤ 24 h, mesma auditoria, mesma empresa pelos identificadores, ciência do custo, limites ≤ teto) e **ainda não usada**. O marcador `.data/link-audit-live/<id>.json` (id, operador, auditoria, limite, hora; nenhum dado da empresa) é criado de forma exclusiva **antes** da chamada; se não puder ser gravado, não há chamada.
- Teto absoluto no LIVE: 1 chamada ao `/maps`, 0 ao `/reviews`, 8 requisições HTTP ao site.

## Estimativa de custo (NÃO confirmada)
Por auditoria: **1 chamada paga** (`/maps`) + site sem custo de API (até 8 requisições HTTP).
- A página oficial de preços não está acessível (`serper.dev/pricing` devolve 404); `serper.dev` anuncia apenas 2.500 consultas grátis.
- Fontes **secundárias**: pacotes de US$ 50 (50 mil) a US$ 3.750 (12,5 mi) ≈ US$ 1,00–0,30 por mil consultas; "até 10 resultados = 1 crédito; 11–100 = 2".
- Estimativa mostrada pelo comando: **1 a 2 créditos ⇒ ≈ US$ 0,0003 a 0,002** por auditoria; **US$ 0** se ainda houver créditos gratuitos. O custo real em créditos do `/maps` **não está confirmado** em fonte oficial: conferir no painel do Serper.

## Dados coletáveis × indisponíveis
**Coletáveis (se o Serper devolver):** nome, endereço, telefone, site, categoria e categorias adicionais, nota e quantidade de avaliações, horários, identificadores; do site: status HTTP, redirecionamentos, `noindex`, `robots.txt`, links `tel:`/WhatsApp/e-mail, nome/telefone/tipo declarados em `LocalBusiness`.
**Indisponíveis nesta onda (ficam NÃO VERIFICADOS, nunca "ausentes"):** avaliações datadas e respostas (`/reviews` desligado e formato não confirmado), Google Posts, fotos/visuais nativos, serviços nativos, concorrentes, IA, pontuação.

## Resultado estruturado (`CollectionReport`)
Identidade e link; identificadores comprovados; `located`; dados por fonte; evidências (fonte, data, status); não verificados com motivo; limitações; divergências (telefone, nome, domínio); resumo de chamadas (planejadas/simuladas/enviadas/negadas por fonte); `mode`; `externalTraffic`; estimativa de custo. Persistência: **somente memória/terminal**; nada é gravado além do marcador de autorização usada (LIVE).

## Endpoints futuros
Qualquer rota de coleta deverá exigir `requireOperator`, limitador por operador (`api-limits`), corpo limitado, DRY_RUN por padrão e a autorização acima, e **não** pode ser criada sem nova decisão.

## Corpo lido pelo middleware (item de segurança herdado da 4A)
Confirmado no código do Next 15.5.28 (`getCloneableBody`): o middleware copia o corpo para memória até `middlewareClientMaxBodySize` (padrão 10 MB) antes da rota. Medição em servidor real (dev na porta 3100, bypass só na linha de comando, corpo em fluxo de 40 MB para `/api/link-audit/parse`, memória RSS do `next-server`): **antes** a memória cresceu até ≈ +12 MB por requisição de 40 MB (a primeira medição, que inclui a compilação da rota, mostrou +55 MB); **depois** de `experimental.middlewareClientMaxBodySize: '64kb'` ≈ +1 a +2 MB. A medição de RSS é ruidosa (coleta de lixo); o código do Next é a evidência principal. Todas as respostas foram 413 e uma requisição pequena válida continuou respondendo normalmente. Nenhuma rota existente usa corpo maior que 64 KB (login, enqueue, prospect e link-audit recebem JSON pequeno; não há upload).

## Evidências de que nada real foi executado
- `npm test` rodado com um `--require` que registra **qualquer** `connect`, DNS ou `fetch` para destino que não seja loopback: **0 tentativas** em 637 testes (o gancho foi validado contra um endereço da faixa de documentação).
- Varredura estática: `fetch(` aparece em **um** arquivo (`serper-maps-provider.ts`); teste de isolamento garante.
- DRY_RUN real do comando com link fictício: plano e custo, `externalTraffic:false`, `.env.local` com data de modificação inalterada (`2026-10-16 20:45:44`), nenhuma pasta `.data/link-audits` ou `.data/link-audit-live` criada.
- Os testes usam transporte falso, resolvedor falso e dados fictícios.

## Procedimento para autorizar UMA auditoria real
1. Você escolhe a empresa (link **completo** com identificador) e confirma no painel do Serper o saldo e os créditos por chamada do `/maps`.
2. Rodamos o DRY_RUN: `npm run link-audit:collect -- --link "<link>" --operator voce@empresa.com --name "<nome>" --city "<cidade>" --uf <UF>` e você confere plano e estimativa.
3. Você me autoriza **por escrito**: empresa, `/maps` ≤ 1, `/reviews` = 0, prazo.
4. Você mesmo define, só no terminal daquele comando: `GMN_LINK_AUDIT_LIVE=on GMN_LINK_AUDIT_MAX_MAPS_CALLS=1 GMN_LINK_AUDIT_AUTH_ID=<id único>` (eu nunca altero o `.env.local`).
5. Comando LIVE: o mesmo comando do passo 2 mais `--live --authorization-id <id> --max-maps-calls 1 --ack-cost`. Cria o marcador, faz **uma** chamada e imprime o relatório; repetir é recusado.
6. Registramos o formato real da resposta e atualizamos as capacidades antes de qualquer outra consulta.

## Limites e riscos declarados
Créditos por chamada e formato do `/maps` por identificador **não confirmados**; o caminho LIVE só foi exercitado com transporte falso; `/reviews` continua desligado; a gravação segura de snapshots em `/mnt/d` segue pendente; rotas `enqueue`/`prospect`/`login` seguem sem limite próprio de corpo (agora limitadas a 64 KB pelo middleware); D3, D4 e D5 abertas.

## Revisão independente (subagente de contexto limpo, somente leitura)
Sem achados graves. Corrigidos: (1) as travas `GMN_LINK_AUDIT_*` só valem se já estavam no ambiente do comando; valores que apareçam só depois de carregar o `.env.local` são ignorados; (2) uma segunda autorização (id diferente) para a **mesma empresa** em 24 h é recusada (o marcador guarda a impressão dos identificadores, sem dados da empresa); (3) a pasta de autorizações usadas é ancorada na raiz do projeto, não no diretório atual; (4) `<a href="tel:">` vazio não gera divergência falsa de telefone; (5) o modo SIMULATED recusa provedores marcados como reais; (6) detecção de login mais ampla (`oauth2`, `saml`, `idp`, `ServiceLogin`, hosts `login.*`/`sso.*`/`accounts.*`); (8) a chave é aparada na criação do provedor.
**Limites aceitos/registrados:** a autorização do comando é montada a partir dos argumentos (o freio real é o id inédito + a regra por empresa + as travas de ambiente); 401/403 do site aparecem como "bloqueada por segurança" (mensagem do `site-check`, não alterado); a contagem das até 8 requisições do site não entra no resumo de chamadas; `site-check` não detecta `noindex` com `content` sem aspas (código existente, não alterado); alguns testes de CLI/site são mais fracos que o ideal (a prova da chave está nos testes do provedor Serper).

## Atualização da Onda 4C (21/10/2026)
O casamento passou a usar o CID (derivável do FID) e a estimativa do `/maps` passou a 3 créditos (fonte independente, não oficial). Ver `onda4c-identidade-cid-fid.md`.

## Atualização da Onda 4D (22/10/2026)
O transporte do site não trata mais 401/403 como bloqueio de segurança (classificação própria), o `--json` do comando passou a ser sanitizado por valor, e a evidência da primeira consulta LIVE foi preservada. Ver `onda4d-pos-live-resgate.md`.

## Atualização da Onda 5A (22/10/2026)
O LIVE agora exige `--evidence-dir` (pré-voo do armazenamento antes de consumir a autorização; resposta paga gravada automaticamente). Ver `onda5a-persistencia-e-leitura.md`.
