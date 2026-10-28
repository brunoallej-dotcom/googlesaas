# Fase 5, Onda 5.0: auditoria técnica e de segurança

Data: 16/10/2026. Método: leitura do código e sondas **somente leitura** (consultas anônimas ao próprio projeto Supabase, `npm audit`). Nenhuma consulta paga, nenhuma escrita.

## Linha de base confirmada
Fase 4 reconfirmada no repositório antes de qualquer mudança: `npm test` 286/286, `npm run typecheck` sem erros, `.env.local` com hash idêntico ao do início do trabalho.

## Achados

| # | Achado | Evidência | Gravidade | Tratamento |
|---|---|---|---|---|
| 1 | **Nenhuma autenticação.** Sem `middleware`; as 5 rotas (`/api/prospect`, `/api/audit/enqueue`, `/status`, `/completed`, `/pdf`) estavam abertas. `prospect` e `enqueue` gastam créditos do Serper | `src/app` | Crítica | Onda 5.1 |
| 2 | Cadastro público do Supabase **ligado** (`disable_signup=false`) | `GET /auth/v1/settings` | Alta | Ação do usuário (painel) + allowlist de e-mails no código |
| 3 | PDFs em `public/audits/` servidos sem login em `/audits/<nome>.pdf` | `persist.ts` | Alta | Onda 5.5 (novos PDFs fora de `public/`; antigos: risco residual) |
| 4 | Bucket `gmn-audit-pdfs` **público** (HEAD sem credencial: 200); a UI usava a URL pública direto | sonda + `audit-panel.tsx` | Alta | Onda 5.5 (rota autenticada; migração só com autorização) |
| 5 | `pdfStoragePath` do banco lido sem validar a pasta; `id` da rota sem validação de UUID | `serve.ts`, rota | Média | Onda 5.5 |
| 6 | Rotas devolviam `error.message` bruto | todas as rotas | Média | Onda 5.1 |
| 7 | `enqueue` aceitava `leadSnapshot`, centro e palavra-chave do cliente | `enqueue/route.ts` | Média | Onda 5.1 |
| 8 | Sem idempotência por empresa+palavra-chave (cada clique = 49 consultas pagas) | `enqueue/route.ts` | Alta (custo) | Onda 5.2 |
| 9 | Worker sem `maxStalledCount`; evento `failed` só registrava log | `audit-worker.ts` | Alta | Onda 5.2 |
| 10 | Worker parado deixava a auditoria "Na fila" para sempre; sem estado "Interrompida" | `page.tsx` | Alta | Onda 5.2/5.6 |
| 11 | Sem retomada que reaproveite o Battlefield já persistido | Maestro | Alta (custo) | Onda 5.2 |
| 12 | Campanhas e leads antigos não recuperáveis pela UI | `page.tsx` | Média | Onda 5.3 |
| 13 | Logs sem redação de segredos e sem categoria de erro | `logger.ts` | Média | Onda 5.6 |
| 14 | `npm audit`: 9 avisos (6 altos), todos de toolchain de build (tailwindcss, postcss, braces, micromatch, chokidar; `next` só via postcss embutido). Correção exige upgrade **major** | `npm audit` | Baixa | Registrado; sem atualização automática |
| 15 | Não é repositório git e não havia `.gitignore` | raiz | Média | `.gitignore` criado |
| 16 | Sem cabeçalhos de segurança | `next.config.ts` | Baixa | Onda 5.1 |
| 17 | Mapa-base só em Anápolis e Goiânia | Fase 4 | Média | Onda 5.4 |

### Positivos
Service role só no servidor; a anon key não é usada no código; consultas anônimas às quatro tabelas devolveram `[]` (RLS ativo, sem política permissiva visível); SSRF do verificador de sites já protegido; retries automáticos do Maestro desligados (`attempts: 1`).

## Hospedagem
Não há `vercel.json` nem indício de Vercel. O Worker BullMQ é um processo longo e não roda em funções serverless: a operação é uma máquina própria. Mesmo assim o filesystem local não é tratado como armazenamento definitivo (ver `security-review.md`).
