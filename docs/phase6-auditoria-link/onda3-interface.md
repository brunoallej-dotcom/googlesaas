# Fase 6 · Onda 3 — Interface isolada de Auditoria por Link

Status: implementada em 20/10/2026. Metodologia: reconstrução `lumos-reconstruida-v1` (não é o prompt original do agente). D3, D4 e D5 continuam pendentes.

## Como abrir
- Menu lateral → **Auditoria por Link** (logo abaixo de "Auditorias").
- Rota: **`/auditoria-por-link`**. Com `npm run dev`: `http://localhost:3000/auditoria-por-link`. Exige login (a página redireciona para `/login?next=…`).
- A aba **Auditorias** continua sendo a âncora `#auditoria` do dashboard, sem nenhuma mudança. Vista de fora do dashboard, as âncoras do menu viram `/#auditoria`, `/#leads` etc., e voltam ao dashboard.

## O que a tela faz
1. **Entrada do link** — campo para colar o link do Google Maps e botão **Validar link** (com indicador de carregamento, erros claros e botão **Limpar**).
2. **Resultado da análise** — mostra um dos seis estados do parser da Onda 1, com mensagem em português:
   | Estado | Quando | O que a tela diz |
   |---|---|---|
   | Identificado | o link traz cid, place_id ou fid | mostra os identificadores e pede confirmação |
   | Resolução pendente | link curto (`maps.app.goo.gl`, `goo.gl/maps`, `g.page`) | nada foi acessado; não existe mecanismo autorizado de resolução nesta etapa |
   | Ambíguo | só nome, busca, coordenadas, link genérico ou identificadores conflitantes | nenhum estabelecimento é escolhido |
   | Não suportado | outro site, rota, mapa incorporado etc. | explica o motivo |
   | Inválido | texto livre, link cortado, formato errado | explica o motivo |
   | Rejeitado | `http://`, `javascript:`, IP, credenciais, porta, host interno, caracteres que imitam o Google | rejeitado por segurança, sem repetir credenciais |
3. **Confirmação da empresa** (só com link *Identificado*) — campos opcionais de nome, cidade e UF ("informados por você; não são evidência do Google"), caixa de confirmação explícita e botão **Confirmar identidade**. Depois de confirmar, mostra operador e hora e permite **Desfazer confirmação**.
4. **Área da auditoria** — estrutura vazia e honesta para: identificação da empresa, evidências verificadas e não verificadas, diagnóstico, critérios da metodologia (9 nomes e pesos máximos, "pontuação bloqueada até a D3"), concorrentes, recomendações, histórico e relatório PDF. **Não existe botão de gerar auditoria** e nada é preenchido com dados.

## Como funciona por dentro
- **O parser roda só no servidor.** Ele usa `url-safety` (módulos `node:dns`/`node:net`), que não pode ir para o navegador. A tela chama duas rotas internas:
  - `POST /api/link-audit/parse` — `{ link }` → resultado do parser da Onda 1 (o mesmo; nenhuma regra nova).
  - `POST /api/link-audit/confirm` — `{ link, acknowledged: true, name?, city?, stateCode? }` → reanalisa o link **no servidor**, só aceita link *Identificado* e monta a identidade com o `confirmIdentity` da Onda 1. O operador é o **e-mail da sessão** e a hora é a **do servidor**; o cliente não consegue escolher nenhum dos dois, nem os identificadores (campos extras são recusados).
- **Autenticação:** a rota da página e as APIs passam pelo `middleware` existente (sem sessão → `/login` ou 401) e as APIs chamam `requireOperator`. POST de outra origem é recusado (403). Respostas com `Cache-Control: no-store`; corpo limitado a 16 KB; o link nunca é registrado em log.
- **Sem rede e sem gravação:** as rotas não fazem `fetch`, DNS, redirecionamento, leitura de ambiente nem escrita em disco, e não importam `snapshot`, `snapshot-store` nem `canonical`. As respostas trazem `externalLookup: false` e `persisted: false`.
- **Estado só em memória:** o estado da tela é um reducer puro. Mudar o link, validar de novo ou limpar descarta resultado, dados digitados e confirmação; respostas atrasadas de um link antigo são ignoradas. Nada usa `localStorage`, `sessionStorage` ou cookie, e recarregar a página perde tudo (intencional).
- **Texto do link é dado:** o link e o nome que aparece nele são exibidos como texto escapado (nunca como link clicável nem HTML). O nome do link é rotulado "não verificado".
- **Cabeçalho:** a tela não mostra o indicador de saúde do sistema (que consulta Redis/Supabase); o botão Sair continua.

## O que NÃO existe nesta onda (por decisão)
Gravação de snapshot pela interface (a estratégia de gravação segura em `/mnt/d` ainda não foi validada: o caminho sem `link()` não é atômico em caso de queda — ver `onda2-snapshot-e-armazenamento.md`), coleta, Serper e APIs pagas, IA, pontuação, classificação, PDF, resolução de links curtos, migrations, Supabase, Redis e filas.

## Arquivos
Novos: `src/app/auditoria-por-link/page.tsx`; `src/app/api/link-audit/{body.ts,parse/route.ts,confirm/route.ts}`; `src/components/link-audit/{state,messages,api-client}.ts` e `{link-audit-screen,link-entry-panel,parse-result-panel,identity-confirm-panel,audit-workspace}.tsx`; testes `tests/link-audit-{ui-state,ui-render,api}.test.ts`.
Alterados: `sidebar.tsx` (item de rota e prefixo das âncoras quando fora do dashboard), `dashboard-shell.tsx` e `dashboard-header.tsx` (props opcionais), `tests/link-audit-isolation.test.ts` (consumidores permitidos), `package.json` (só o script `test`).

## Correções da revisão independente
Corrigidos: tipo de conteúdo agora exato (`application/json`, com parâmetros aceitos); nome e cidade sem caracteres de controle, de direção de texto ou invisíveis (rota e exibição); respostas atrasadas ignoradas por um contador de pedidos que nunca volta atrás; formato das respostas validado no cliente; teste de isolamento com resolução real de imports e varredura transitiva do que o navegador alcança.

## Atualização da Onda 4A (21/10/2026)
As limitações abaixo sobre tokens na consulta e sobre o cookie malformado foram **resolvidas** na Onda 4A: o link é exibido e guardado em forma saneada (só host, caminho e parâmetros que são identificadores) e o cookie com `%` malformado responde 401. O corpo agora é lido em fluxo com limite de 16 KB e prazo de 10 s. Ver `onda4a-coleta-inventario.md`.

## Limitações
- O texto do link (inclusive parâmetros de consulta, como tokens) é devolvido ao operador tal como digitado; só credenciais `usuario:senha@` são mascaradas. A resposta é autenticada e `no-store`.
- Um cookie de sessão com `%` malformado faz a autenticação falhar com erro 500 em vez de 401 (falha fechada; pré-existente em `src/lib/auth/session.ts`, não alterado nesta onda).
- O corpo da requisição é lido inteiro antes de aplicar o limite de 16 KB (exige sessão válida).
- Os testes de tela são de renderização no servidor e do reducer; a interação real foi conferida em navegador headless, fora do `npm test`.
- Validar exige o servidor Next rodando (o parser usa módulos Node).
- A confirmação não é salva; a identidade confirmada só existe nesta sessão da tela.
- Sem consulta ao Google: o nome mostrado vem do texto do link e não é verificado.
- Links curtos não podem ser usados até existir um mecanismo de resolução autorizado.
