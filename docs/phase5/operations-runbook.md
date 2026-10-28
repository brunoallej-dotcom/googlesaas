# Fase 5: manual de operação interna

Atualizado em 16/10/2026. Para quem opera a plataforma no dia a dia. Nenhum comando abaixo gasta créditos do Serper, exceto "Gerar Auditoria" e "Capturar 10 Leads" (que mostram o custo antes de repetir).

## 1. Primeira configuração (uma vez)
1. Supabase → Authentication: **desligar "Allow new users to sign up"** e **criar o usuário operador** (e-mail + senha).
2. No `.env.local` adicionar `GMN_OPERATOR_EMAILS=seu@email.com`. (Sem isto tudo responde 503: é a falha fechada.)
3. Opcional: criar um bucket **privado** no Supabase e definir `SUPABASE_PRIVATE_AUDIT_BUCKET` para guardar uma cópia durável dos PDFs.

## 2. Iniciar e parar
| Ação | Comando |
|---|---|
| Interface (desenvolvimento) | `npm run dev` |
| Interface (produção local) | `npm run build` e `npm run start` |
| Worker de auditorias | `npm run worker:prod` (use **este**; `npm run worker` reinicia a cada edição e interrompe um job em andamento) |
| Parar | Ctrl+C no terminal (encerramento limpo). Worker ocioso consome comandos do Redis: desligue quando não usar |

O **Worker é obrigatório** para auditorias: sem ele a auditoria fica "Aguardando" e depois "Interrompida". O indicador no cabeçalho mostra "Worker inativo (npm run worker)".

## 3. Entrar e sair
Abra a plataforma → `/login` → e-mail e senha do operador. "Sair" no cabeçalho encerra a sessão (12 h de validade). 5 erros de senha em 15 min bloqueiam a tentativa por um tempo.

## 4. Verificar a saúde
- Indicador no cabeçalho (verde/âmbar/vermelho) com a causa ao passar o mouse.
- `GET /api/system/health` (logado): Redis, Worker (último batimento), Supabase, contagem da fila, últimas auditorias com duração e erro, e **presença** (sim/não) das configurações. Nunca mostra valores.
- `npm run db:check`: integridade do banco e dos PDFs (somente leitura).

## 5. Auditoria parada, falha ou duplicada
| O que você vê | Significado | O que fazer |
|---|---|---|
| **Aguardando** por mais de 2 min e "Worker inativo" | Worker desligado | `npm run worker:prod`; ela é processada sozinha. Se aparecer "Interrompida", use **Retomar** |
| **Interrompida** | Sem atualização há 15 min ou Worker ausente | Confirme o Worker e clique em **Retomar auditoria**: reaproveita o que já foi coletado, **não repete as 49 consultas** |
| **Falhou** | Erro no pipeline (motivo na tela) | Se mostrar **Retomar**, use-o (dados já gravados são reaproveitados). "Tentar novamente" faz coleta nova e consome consultas |
| Mensagem "Já existe uma auditoria…" | Proteção contra duplicação (409) | A existente é aberta na tela. Para nova coleta paga confirme explicitamente |
| "Fila de processamento indisponível" (503) | Redis fora do ar | Nada foi criado nem cobrado. Verifique `REDIS_URL`/Upstash e tente de novo |

Para investigar: os logs são JSON com `auditId`, `stage`, `status`, `errorCode`, segredos já redigidos; o `correlationId` da mensagem de erro aparece no registro do servidor.

## 6. Recuperar resultados sem gastar nada
- **Campanhas salvas** (seletor no topo): reabre a campanha e as auditorias concluídas dela. Rotulado como "Resultado histórico recuperado", com a data original da coleta.
- **PDF**: sempre pelo botão "Baixar PDF" (rota autenticada). Se o arquivo local sumir, é recomposto do banco (cabeçalho `X-GMN-PDF-Regenerated`), sem consultas externas.
- **Gerar nova revisão de um PDF**: `npm run pdf:regenerate -- <auditId> --store` grava `-r2`, `-r3`… sem sobrescrever o anterior.

## 7. Reiniciar um job sem duplicar
1. Pare o Worker (Ctrl+C).
2. Se havia job ativo, aguarde o limite de inatividade (15 min) ou use **Retomar** assim que aparecer "Interrompida".
3. Nunca enfileire de novo manualmente no Redis; use a tela.

## 8. PDFs
- Migração dos históricos para armazenamento privado: **`pdf-migration-plan.md`** (`npm run pdf:migrate -- inventory | backup | verify-links`; as fases que alteram produção só com `--apply` e confirmação digitada).
- Auditoria de acesso: `npm run rls:probe` (e `-- --authenticated`); verificação de recuperação sem custo: `npm run validate:recovery`.
- Novos: `.data/audits/` (privada). Históricos: `public/audits/` (**ainda públicos**, ver `security-review.md` §5).
- Faça backup de `.data/audits/` junto do `.env.local` (o PDF é recomponível do banco, mas o backup poupa tempo).

## 9. Mapa-base
Padrão: **sem mapa-base** (grade georreferenciada com os 49 pontos reais, sem inventar ruas). Mapa-base só com `GMN_PDF_BASEMAP=mbtiles` e extrato próprio (`basemap-mbtiles.md`) ou `local-dir` (Anápolis e Goiânia, só testes).

## 10. Variáveis (`.env.example`)
`GMN_OPERATOR_EMAILS`, `GMN_AUTH_DISABLED` (só dev local), `SUPABASE_PRIVATE_AUDIT_BUCKET`, `GMN_WORKER_CONCURRENCY`, `GMN_AUDIT_STALE_MINUTES`, `GMN_RATE_PROSPECT_PER_HOUR`, `GMN_RATE_ENQUEUE_PER_HOUR`, `GMN_PDF_BASEMAP`, `GMN_PDF_MBTILES_PATH`.
