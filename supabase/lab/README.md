# Laboratório Supabase (G5/RLS): seed fictício

> **SOMENTE para o projeto Supabase DESCARTÁVEL do laboratório.** Nunca na produção. O script se recusa a rodar lá e em qualquer banco com dados reais, mas a primeira defesa é você conferir o projeto antes de colar.

- `seed-ficticio.sql`: 2 campanhas, 4 leads, 2 auditorias, 2 rodadas e 98 pontos, **todos inventados** (ids `1ab…`, nomes `(LAB)`, URLs `.invalid`, telefones só zeros). Spec: `docs/specs/g5-homologacao-funcional.md`.
- Por que existe: sem linhas nas tabelas, um `200` vazio de um papel sem acesso é **inconclusivo** (`rls:probe --read-only` devolve `INCONCLUSIVE_EMPTY`). Com o seed, "vazio" passa a significar "o RLS filtrou" ou "sem privilégio".
- Como usar: pré-requisito, migrations `001` e `002`. Supabase do **laboratório** → SQL Editor → New query → cole o arquivo inteiro → Run. Resultado esperado: "Success. No rows returned" e, depois, contagens 2 / 4 / 2 / 2 / 98.
- É um único bloco atômico (tudo ou nada) e idempotente (rodar de novo não duplica). Só `INSERT ... ON CONFLICT DO NOTHING`.
- Não cria usuários do Auth nem objetos do Storage (os buckets privados `gmn-audit-pdfs-private` e `gmn-audit-pdfs` se criam à parte, pelo painel).
- Os testes automáticos (`tests/lab-seed.test.ts`) provam a estrutura, as guardas e as restrições do schema nas linhas explícitas, **sem executar o SQL num PostgreSQL**. A primeira execução no laboratório é o teste de integração.
