# Fase 5: revisão de segurança

Atualizado em 16/10/2026. Escopo: ferramenta **interna** (não SaaS). Nenhuma migration, nenhum serviço novo, `.env.local` intacto (hash conferido ao final).

## 1. O que foi implementado

| Controle | Como funciona | Onde |
|---|---|---|
| **Login fechado** | E-mail + senha conferidos no **Supabase Auth** (`signInWithPassword` no servidor). Só entra quem está em `GMN_OPERATOR_EMAILS`; e-mail fora da lista **nem chega ao Supabase** e recebe a mesma resposta de "senha errada" | `src/lib/auth/*`, `src/app/api/auth/login` |
| **Sessão** | Cookie `gmn_session` assinado (HMAC-SHA-256, Web Crypto), `HttpOnly`, `SameSite=Strict`, `Secure` em HTTPS, 12 h. A chave é derivada da `SUPABASE_SERVICE_ROLE_KEY` (sem segredo novo). A lista de operadores é reavaliada a **cada requisição**: remover um e-mail revoga a sessão na hora | `src/lib/auth/session.ts`, `guard.ts` |
| **Logout** | `POST /api/auth/logout` expira o cookie; botão "Sair" no cabeçalho | `src/app/api/auth/logout` |
| **Proteção no backend** | `middleware` cobre páginas, `/api/*` e `/audits/*`; **cada rota chama também `requireOperator`** (defesa em profundidade). Falha **fechada**: sem allowlist ou sem chave, tudo responde 503 | `src/middleware.ts`, `require-operator.ts` |
| **Anti-CSRF** | `SameSite=Strict` + recusa de `POST` com `Origin` de outro site ou `Sec-Fetch-Site: cross-site` | `guard.ts` |
| **Força bruta** | 5 tentativas por e-mail+origem e 20 por origem, a cada 15 min (429) | `login/route.ts`, `rate-limit.ts` |
| **Gasto de créditos** | Limites por operador: prospecção 20/h e auditoria 30/h (configuráveis) | `api-limits.ts` |
| **Bypass de desenvolvimento** | `GMN_AUTH_DISABLED=true` só vale com `NODE_ENV=development` **e** host `localhost/127.0.0.1/[::1]`. Em produção é ignorado | `guard.ts` |
| **Entradas** | IDs validados como UUID (400); `enqueue` carrega o lead **só do banco** (o `leadSnapshot` do cliente é ignorado); centro de interesse a ≤ 5 km do lead; palavra-chave limitada | rotas |
| **Erros seguros** | O cliente recebe mensagem genérica + `code` + `correlationId`; o detalhe vai (redigido) ao log | `src/lib/errors.ts` |
| **Segredos nos logs** | Redação automática de chaves, tokens, senhas, JWTs, `Bearer` e URLs com credenciais, em mensagens e metadados | `src/lib/redact.ts`, `logger.ts` |
| **Cabeçalhos** | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` (com `no-referrer` o OpenStreetMap bloqueia os tiles do mapa da tela), `Permissions-Policy`, `COOP` | `next.config.ts` |
| **`/dev/*`** | 404 em produção (confirmado por HTTP) | `middleware.ts` |
| **SSRF** | Preservado (Fase 4): IP fixado, revalidação por salto, ≤ 3 redirecionamentos | `url-safety.ts` |
| **Service role** | Só no servidor; nunca em `NEXT_PUBLIC_*`; a anon key só é usada no login e **não** dá acesso a dados (consulta anônima às tabelas devolve `[]`) | `supabase.ts` |

## 2. PDFs

**Novos PDFs (protegidos):** gravados em `.data/audits/` (fora de `public/`, portanto nunca servidos pelo Next) com nome versionado e `flag: 'wx'` (nunca sobrescreve: gera `-r2`, `-r3`…). O download só existe em `GET /api/audit/<id>/pdf`, que exige operador, valida UUID, **só lê de pastas permitidas** (`.data/audits`, `GMN_PDF_OUTPUT_DIR` e, somente leitura, `public/audits` para os históricos), sanitiza o nome do arquivo e responde `Cache-Control: no-store`. A UI usa sempre essa rota. Nada é enviado ao bucket público; a cópia durável é **opcional** e só em bucket **privado** (`SUPABASE_PRIVATE_AUDIT_BUCKET`).

**ATUALIZAÇÃO 16/10/2026 (G1+G2): o bucket antigo agora é PRIVADO (links públicos → 400) e há cópias privadas verificadas; resta apenas o resíduo dos originais em `public/audits/` (G4).** Texto original da rodada anterior:

**PDFs históricos (NÃO protegidos, risco residual aberto):** os 3 PDFs oficiais continuam em `public/audits/` e as URLs públicas do bucket `gmn-audit-pdfs` continuam válidas. Adicionar o `middleware` bloqueia a rota `/audits/<arquivo>.pdf` quando o Next serve a pasta, **mas isso é mitigação parcial**: não protege as cópias no bucket público, não protege o arquivo em disco e não vale se a pasta for servida por outro servidor/CDN. Por isso o risco permanece **ABERTO** até a migração autorizada (item 5).

**Validação HTTP real** (servidor de produção local, porta 3100, sem gastar nada):

| Requisição | Sem sessão | Cookie forjado/adulterado | Sessão válida |
|---|---|---|---|
| `GET /` | 307 → `/login` | n/a | 200 |
| `GET /api/audit/<id>/pdf` | **401** | **401** | 200 `application/pdf` (bytes idênticos ao arquivo oficial, SHA-256 conferido) |
| `GET /audits/<histórico>.pdf` | **401** | n/a | 200 |
| `GET /audits/nao-existe.pdf` | **401** (não revela existência) | n/a | n/a |
| `GET /api/audit/completed`, `/status`, `/api/campaigns`, `/api/system/health` | **401** | n/a | 200 |
| `POST /api/prospect`, `/api/audit/enqueue`, `/api/audit/<id>/resume` | **401** (nenhum crédito gasto) | n/a | n/a |
| `GET /api/audit/123/status`, `/api/audit/..%2F..%2Fetc%2Fpasswd/pdf` | n/a | n/a | **400** |
| `POST` com `Origin` de outro site | n/a | n/a | **403** |
| `GET /dev/battlefield-preview` | **404** (produção) | n/a | n/a |

## 3. Persistência do armazenamento na hospedagem
Não há `vercel.json` nem indício de Vercel, e o Worker BullMQ é um processo longo que **não roda em funções serverless**: a operação é uma máquina própria (VM/servidor). Em VM com disco persistente, `.data/audits` é aceitável, **mas não é tratado como armazenamento definitivo**: o PDF é derivado dos payloads persistidos no Supabase. Se o arquivo faltar, a rota o **recompõe do banco** (sem Serper, sem LLM, sem gravar nada; cabeçalho `X-GMN-PDF-Regenerated: true`). Para cópia durável, crie um bucket **privado** e defina `SUPABASE_PRIVATE_AUDIT_BUCKET`. **Se a hospedagem mudar para Vercel/serverless, o filesystem local não pode ser o armazenamento definitivo**: nesse caso o bucket privado passa a ser obrigatório e o Worker precisa de um host próprio.

## 4. O que VOCÊ precisa fazer (eu não toquei em nada disto)
1. ~~Desligar "Allow new users to sign up"~~ **FEITO** (confirmado em 16/10/2026: `disable_signup: true`).
2. ~~Criar o operador~~ **FEITO** (1 usuário Auth; login real validado).
3. ~~`GMN_OPERATOR_EMAILS`~~ **FEITO**. Opcional: `SUPABASE_PRIVATE_AUDIT_BUCKET` (depois do portão G1).
4. Reiniciar o Next e o Worker depois de editar o `.env.local`.

## 5. Migração dos PDFs históricos e bucket privado (**preparada; nada alterado em produção**)
> Procedimento completo, inventário real, backup feito e portões G1–G4: **`pdf-migration-plan.md`**. Auditoria de RLS e Storage: **`rls-audit.md`**. Dependências: **`dependency-audit.md`**.
Inventário real (simulação `npm run pdf:migrate-plan`, somente leitura): **3 PDFs, 0,28 MB, todos em `public/audits` e com URL pública no bucket, 0 ausentes.**

1. **Preparar:** criar bucket privado no painel e definir `SUPABASE_PRIVATE_AUDIT_BUCKET`.
2. **Copiar (sem mover):** copiar cada PDF para `.data/audits/` e para o bucket privado, conferindo o SHA-256 (o script de simulação já calcula).
3. **Apontar:** atualizar `pdf_storage_path`/`diagrammer_payload` para o novo local; o link continua sendo a rota autenticada.
4. **Validar:** baixar cada PDF pela rota autenticada e comparar o SHA-256 com o original.
5. **Fechar a exposição (com sua autorização):** tornar o bucket `gmn-audit-pdfs` privado no painel e, somente depois, remover os originais de `public/audits`.
6. **Reversão:** enquanto os originais existirem, nada se perde; o passo 5 é o único irreversível.

## 6. Riscos residuais e pendências
| ID | Pendência | Estado |
|---|---|---|
| R2 | Cadastro público do Supabase | **FECHADO** (desligado e conferido) |
| R3 | PDFs históricos em locais públicos | **ABERTO** (migração aguardando autorização) |
| R12 | Chave de sessão derivada da service role (girar a chave encerra as sessões) | Aceito |
| R13 | RLS: o anon **tem privilégio** de SELECT/UPDATE/DELETE nas 5 tabelas e só o RLS barra (sonda real). Políticas não versionadas. Segurança **não comprovada** só por consulta vazia (`rls-audit.md`) | **PENDENTE** (G5) |
| — | Limitadores em memória (um processo). Com mais de uma instância do Next eles não são compartilhados | Aceito (uso interno, instância única) |
| — | `npm audit`: 9 avisos (6 altos, 3 moderados), todos na cadeia de build CSS (tailwindcss/postcss/braces/micromatch/chokidar). Correção exige upgrades **major** (tailwind 4, next 16) e **não foi aplicada**. Sem exposição em runtime para uso interno | Aceito/monitorar |
| — | Login real (Supabase Auth) | **APROVADO** (você entrou em 16/10/2026) |
