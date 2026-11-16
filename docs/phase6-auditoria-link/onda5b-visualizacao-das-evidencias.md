# Fase 6 · Onda 5B — Visualização das auditorias e evidências armazenadas

Status: implementada em 22/10/2026. **Nenhuma chamada externa** (Serper, Google, site da TUVAPLAST); nenhum crédito consumido; LIVE não executado; `.env.local`, ACLs, Supabase, Redis, migrations, prospecção, Juiz e metodologia Lumos intocados; sem pontuação, PDF, IA ou coleta pela interface.

## Onde fica e como ativar
- **Endereço:** `/auditoria-por-link` (menu **Auditoria por Link**). O formulário de validação de link continua no topo; a nova área **Auditorias armazenadas** vem logo abaixo; a "Área da auditoria" (placeholders) continua depois.
- **Configuração (servidor):** a pasta privada de evidências é definida **somente** pela variável `GMN_LINK_AUDIT_EVIDENCE_DIR` (caminho **absoluto** no sistema de quem executa o Next). Com o Next rodando no WSL: `GMN_LINK_AUDIT_EVIDENCE_DIR=/mnt/d/gmn-evidencias-privadas/link-audit`; no Windows: `D:\\gmn-evidencias-privadas\\link-audit`. Eu **não** alterei o `.env.local`: adicione a linha você mesmo e reinicie o servidor (ou passe a variável na linha de comando). Sem ela a área mostra "armazenamento não configurado" (503 controlado); se a pasta não estiver acessível ao processo, "armazenamento indisponível". **Nenhuma permissão é alterada pela aplicação.**

## Rotas de leitura (somente GET; `requireOperator` em todas)
| Rota | Resposta |
|---|---|
| `GET /api/link-audit/evidence?limit=&offset=` | `{ audits[], total, limit, offset }` (limite 1–50, padrão 20; offset ≤ 10 000) |
| `GET /api/link-audit/evidence/{auditId}?capture=&revision=` | `{ audit }` (DTO de detalhe) |
| `GET /api/link-audit/evidence/{auditId}/versions` | `{ auditId, versions[] }` |
Regras: autentica → limita (30 requisições/min por operador, 429 + `Retry-After`) → confere a configuração → só então valida parâmetros (sem sessão: 401, nunca 400); parâmetros **só números pequenos**, desconhecidos/repetidos ⇒ 400; `auditId` só `^[a-z0-9][a-z0-9_-]{7,63}$` (traversal, barras, `%2e`, NUL, maiúsculas ⇒ 400); o navegador **nunca** envia caminhos; a raiz vem só da configuração do servidor e é recusada se estiver em `public/`, `src/`, `.next/`, `node_modules/`; `Cache-Control: no-store, private, max-age=0`, `Pragma`, `nosniff`, `Vary: Cookie` em todas as respostas (inclusive erros); mensagens genéricas, sem caminhos, sem `reason` do sistema; sem exportar POST/PUT/PATCH/DELETE; `dynamic = 'force-dynamic'`.
**Integridade antes da exibição:** se **qualquer** arquivo da coleta não confere (captura, site, relatório, vínculo, hashes legados), o detalhe e as versões respondem **409 `INTEGRITY_FAILED`** sem dados e a lista mostra só o estado "Integridade comprometida" (sem nome, CID ou datas). Coleta incompleta ⇒ 409 `AUDIT_INCOMPLETE`; inexistente, symlink ou arquivo no lugar da pasta ⇒ 404 (nunca 500).
**O que nunca sai:** corpo bruto do Serper, `bodyText`, miniatura, chaves, tokens, cookies, caminhos do disco. O servidor monta objetos de apresentação **campo a campo** (`src/lib/link-audit-evidence/present.ts`), com tetos de tamanho.

## Interface (`src/components/link-audit/`)
- `stored-audits-panel.tsx` (contêiner, estados e consultas), `stored-audit-list.tsx` (filtro local por empresa/cidade/UF/CID, cartões com nome, CID confirmado, data, fonte, selo "Hashes conferem", capturas e versões), `stored-audit-detail.tsx` (aviso "Coleta de evidências — não é uma auditoria estratégica finalizada"; Estabelecimento; Horário; Identificadores; **verificadas × não verificadas** lado a lado; Site; Limitações; Origem dos dados; Histórico de versões com troca de versão; Integridade), `evidence-api-client.ts` (único `fetch`: GET, sem corpo, mesma origem, `redirect:'error'`, valida o formato), `evidence-state.ts` (estado puro, respostas atrasadas ignoradas), `evidence-labels.ts` (vocabulário e formatação fixa de Brasília).
- Estados: carregando (esqueleto, `role="status"`), vazio, filtro sem resultado, erro e indisponível (`role="alert"`, "Tentar novamente"), detalhe atualizando (`aria-busy`). Responsivo: lista e detalhe lado a lado no desktop, empilhados no celular; texto quebra, sem rolagem horizontal.
- **Sem botões fictícios:** não há "Gerar auditoria", "Gerar PDF" nem "Executar coleta". Sem pontuação, índice ou classificação (D3 pendente). Dados externos viram **texto** (nenhum HTML, nenhum link clicável).

## Primeira empresa real (TUVAPLAST COMÉRCIO)
Lida **somente para leitura** de `D:\\gmn-evidencias-privadas\\link-audit\\tuvaplast-20261022-maps01\\` (formato legado, integridade conferida na exibição). A tela mostra: CID **4193491131727734142** (derivado do FID do link e conferido com `cid` e a 2ª metade do `fid` devolvidos), HTTP 200, 1 chamada, 3 créditos informados, nota **5,0**, **49** avaliações, endereço, telefone, site, categorias, horários, coordenadas (texto), **8 evidências verificadas e 11 não verificadas**, site observado (resposta restrita, código não registrado), limitações, versões (1 substituída, 2 atual). Nada foi copiado para `public/`; hashes e datas dos arquivos idênticos antes e depois (D: e C:).

## Verificação
`npm test` 772/772 (inclui rotas, autenticação/autorização, traversal, integridade, vazamentos, estados e acessibilidade da interface, isolamento do navegador), typecheck e build ok; **navegador real** (Chromium headless, desktop 1440 px e celular 390 px, servidor local com `GMN_AUTH_DISABLED` só na linha de comando): 48 verificações, 0 falhas, sem erros de console, sem rolagem horizontal e **nenhuma requisição fora do servidor local**; captura de sockets/DNS/`fetch` externos na suíte: 0.

## Revisão independente (sem achados graves)
Corrigidos: dados de coleta com captura adulterada e relatório íntegro não aparecem mais; lista e versões legadas adulteradas não mostram conteúdo; symlink/arquivo na raiz não derruba a lista nem vira 500; validação só depois de autenticar; limite de 30/min; tetos em todos os campos do DTO; chaves React únicas; selo da lista "Hashes conferem" (a ressalva "hash não é assinatura" fica no detalhe); mensagens de erro sem falsos caminhos.

## Riscos pendentes
Leitura relê e confere os arquivos a cada requisição (I/O; mitigado por limite e pelo número pequeno de auditorias); limitador em memória por processo; o bypass de desenvolvimento (`GMN_AUTH_DISABLED=true`) decide por `Host` (pré-existente): **não use com a rede aberta**; ACL do Windows e backup independente fora do alcance do código; coleta pela interface, "Gerar auditoria", PDF, pontuação (D3), identidade visual (D4) e concorrentes/IA (D5) seguem pendentes.

## Intermitência investigada
Um teste antigo de snapshot (`identificadores e caminhos perigosos…`) falhou uma vez porque listava o `/tmp` inteiro antes e depois: processos do sistema e testes em paralelo criam e removem entradas ali. O pai da base passou a ser um diretório privado do teste (mesma asserção: nada é criado fora da base). Depois disso, 3 rodadas completas seguidas: 772/772 sem falhas.


## Emenda (16/11/2026) — links exibidos só como esquema + host
Revisão adversarial independente (16/11/2026): `GET /api/link-audit/evidence/{auditId}` devolvia o CAMINHO do website do perfil e do endereço consultado no site (`establishment.website`, `site.requestedUrl`), que pode carregar segredo (ex.: `;jsessionid=`), em desacordo com o critério da Onda 6C (§19.2 item 5: URL bruta nunca exibida). **Contrato novo:** os dois campos trazem só `esquema://host[:porta]/` (sem caminho, consulta, credenciais nem fragmento) ou `null` quando o valor não é URL http(s) com host. O estado de UTM do website continua na prévia da pontuação (regra `lumos-url-derive-v1`). Compatibilidade: a tela e a API são publicadas juntas (mesmo app Next); nenhum dado gravado muda. Teste: `tests/link-audit-evidence-present.test.ts`.
