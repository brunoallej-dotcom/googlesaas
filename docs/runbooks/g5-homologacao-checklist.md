# Checklist: homologação funcional do G5 (laboratório) e verificação não destrutiva da produção

> **Status:** preparação. Nada deste checklist foi executado. Spec: `docs/specs/g5-homologacao-funcional.md`.
> **Situação do G5:** implementação aparente, pendente de homologação funcional. Só marcar "concluído" com as partes A e B verdes.
> **Regra de ouro:** antes de qualquer comando, confira o **host** (`alvo (host): ...` do probe `--read-only`, ou o identificador do projeto no painel). Laboratório e produção são projetos diferentes.
> **Sempre o `--` antes das opções:** `npm run rls:probe -- --read-only`. O script recusa (código 2) opção desconhecida e o caso do npm engolir a opção, porque o modo completo (que escreve) é o padrão.

## A. Laboratório (projeto Supabase descartável, organização Free, custo zero)

| # | Passo | Aceite |
|---|---|---|
| A0 | Conferir a vaga gratuita (limite de 2 projetos ativos) e criar `gmn-lab-rls-descartavel` **sem extras** (sem PITR, add-ons nem compute pago). Salvar em `~/.gmn-lab/lab.env` (modo 600, fora do repositório; nunca no chat) as **3 variáveis** `NEXT_PUBLIC_SUPABASE_URL` (só `https://<ref>.supabase.co`), `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` (as que faltarem seriam preenchidas por qualquer `.env*` na pasta: não deve haver nenhum). | Faturamento US$ 0; arquivo criado por você |
| A1 | SQL Editor: colar `supabase/migrations/001_gmn_schema.sql` e `002_audit_payloads.sql`. Painel do Storage: criar os buckets **privados** `gmn-audit-pdfs-private` e `gmn-audit-pdfs`. | 5 tabelas, 2 buckets privados |
| A2 | Rodar `supabase/lab/seed-ficticio.sql`. Contar: `select count(*) from` cada tabela. | "Success. No rows returned"; 2 / 4 / 2 / 2 / 98; repetir o seed não muda as contagens |
| A3 | **Linha de base:** `supabase/audit/rls-audit-json.sql`, comparada com `docs/phase5/evidence/rls-audit-2026-10-17.json`. | RLS ligado, 0 políticas, `anon` e `authenticated` 35/35 (se a plataforma nova diferir, o laboratório não representa a produção: parar e registrar) |
| A4 | `( set -a; . ~/.gmn-lab/lab.env; set +a; npm run rls:probe -- --read-only )` | `anon`: `FILTERED_BY_RLS` (só o RLS barra); forjado: `BLOCKED_BY_PRIVILEGE`; `service_role`: OK; código 0 |
| A5 | Probe **completo** (só no laboratório; ele escreve com filtro impossível e **não imprime o alvo**, então confira antes): `( set -a; . ~/.gmn-lab/lab.env; set +a; [ "$NEXT_PUBLIC_SUPABASE_URL" = "https://<ref-do-lab>.supabase.co" ] && npm run rls:probe )` | "só RLS" > 0, EXPOSTO 0 |
| A6 | Aplicar `supabase/proposed/003_rls_hardening.sql`; rodar de novo o SQL de auditoria. | Sem erro; JSON com 5 `gmn_deny_all` e `anon`/`authenticated` 0/35 |
| A7 | **Equivalência com a produção:** comparar o JSON do laboratório (A6) com `rls-audit-2026-11-07.json` (veio no PR #12; se ele ainda não foi mergeado, use o arquivo da branch `chore/saneamento-tecnico`) nas seções 1 a 6, 8, 9 e 12. | Iguais (ignorar `coletado_em`, datas dos buckets, contas e contagens de objetos) |
| A8 | Depois da `003`: `( set -a; . ~/.gmn-lab/lab.env; set +a; npm run rls:probe -- --read-only --expect-hardened )` e o probe completo (A5). | Somente leitura: `anon` e forjado `BLOCKED_BY_PRIVILEGE`, `service_role` 5/5, código 0. Completo: "só RLS" 0, EXPOSTO 0, `service_role` 15/15 |
| A9 | App contra o laboratório (variáveis do `lab.env`): `npm run db:check`, `mkdir -p public/audits && npm run validate:recovery` (o script lê essa pasta e falha sem ela) e **`npm run g5:smoke`** (grava e apaga; o lugar certo para ele). | Sem erro; o seed só tem auditorias `FAILED`, então não há PDF para conferir; gatilhos de `updated_at` funcionando |
| A10 | Objetos futuros: criar tabela e função de teste (pelo SQL Editor e pelo Table Editor), checar `anon`/`authenticated`; remover. | Sem acesso; anotar qual papel o Table Editor usa (decide o peso do resíduo de `supabase_admin`) |
| A11 | Ensaio do rollback `003_rls_hardening.rollback.sql`, comparar com A3, reaplicar a `003`; controle negativo (a `003` num projeto sem o bucket aborta sem alterar nada). | Volta à linha de base; o controle aborta |
| A12 | Descartar: Settings → General → Delete project; apagar `lab.env`; conferir o faturamento. | Projeto removido; nenhum custo |

Guardar as saídas **sem chaves** em `docs/phase5/evidence/` com a data no nome.

## B. Produção: somente leitura (com autorização escrita; nada de escrita, `rls:probe` completo, `g5:smoke` nem seed)

| # | Verificação | Como | Aceite |
|---|---|---|---|
| B1 | Estrutura | SQL Editor: `supabase/audit/rls-audit-json.sql` (já feito em 07/11; repetir depois de qualquer mudança) | Igual à auditoria de 07/11 |
| B2 | Contagens | SQL Editor (SELECT): `select 'campanhas', count(*) from public.prospecting_campaigns union all select 'leads', count(*) from public.gmn_leads union all select 'auditorias', count(*) from public.gmn_audits union all select 'rodadas', count(*) from public.gmn_battlefield_rounds union all select 'pontos', count(*) from public.gmn_battlefield_points;` | Não caíram (referência 17/10: 10 / 80 / 6 / 3 / 147; podem ter crescido) |
| B3 | Acesso real, **só leitura** | `( set -a; . <arquivo-de-variaveis-fora-do-repositorio>; set +a; npm run rls:probe -- --read-only --expect-hardened )`, com autorização. O arquivo traz a service role de **produção** (só para as GETs de contagem): crie-o só para este passo e **apague-o depois** | `alvo (host)` é a produção; `anon` e forjado `BLOCKED_BY_PRIVILEGE`; "só RLS" 0; EXPOSTO 0; `service_role` OK; código 0 (com `--expect-hardened`, "só RLS" reprova) |
| B4 | Integridade | `npm run db:check` e `npm run validate:recovery` (este grava só um JSON local e lê `public/audits/`: crie a pasta vazia). **Ambos conferem os PDFs oficiais no disco**: sem eles, PDF ausente aparece como ponto de atenção e reprova as auditorias concluídas | Onde os PDFs existem (a máquina que os tem, ou a VPS): "Nenhum problema" / "RECUPERAÇÃO VALIDADA". Sem os PDFs: nenhum problema de **banco** (campos e payloads) e nenhuma falha de leitura |
| B5 | Painel (leitura) | Data API → Exposed schemas; Auth → cadastro público e lista de Users (sem expor e-mails); histórico do SQL Editor; plano de backup | Cadastro público desligado; `public` exposto ou não, anotado; origem da `003` documentada |
| B6 | Explicar o que mudou fora da `003` | Contas Auth 1 → 3; objetos em `gmn-audit-pdfs-private` 4 → 16 (relatório S0, PR #12) | Causa registrada |

**Não fazer em produção:** `rls:probe` sem `--read-only` (PATCH e DELETE com id impossível, RPC, Storage), `rls:probe --authenticated` (o login é uma escrita de sessão no `auth`), `g5:smoke`, o seed (ele recusa, mas não teste), a `003` e qualquer escrita.

**O que o modo somente leitura não cobre:** Storage (a listagem usa envio de dados) e o papel `authenticated`. Ficam por conta do SQL (`10_storage` e `12_privilegios_efetivos`) e do probe completo no laboratório (A5 e A8).
