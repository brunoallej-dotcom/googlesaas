# PDFs de exemplo da Fase 4 (revisão final de 16/10/2026)

Gerados em 16/10/2026 só com leitura do banco e fixtures. Nenhuma consulta paga. Apenas o PDF `…com-verificacao-do-site` inclui uma verificação HTTP pública do site do lead (sem custo). O mapa-base usa os 6 tiles de teste do repositório (`GMN_PDF_BASEMAP=local-dir`), não o OpenFreeMap em tempo de execução.

| Arquivo | O que é |
|---|---|
| `dossie-auditoria-real-com-verificacao-do-site.pdf` | **Base de desenvolvimento.** Auditoria real `859b4021…` reavaliada pelas regras da Fase 4 com uma verificação técnica gratuita do site do lead. Mostra, em blocos separados, o **Score Juiz histórico armazenado (56,4%)**, a **pontuação recalculada (64%)** e o **desempenho verificado (57,6%)**, cada um com metodologia e denominador. 7 de 21 critérios verificados (37% do peso). |
| `dossie-auditoria-real-historico-conservador.pdf` | A mesma auditoria **exatamente como gravada** (score histórico 56,4%), com a classificação de evidências conservadora (5 de 21 verificados). |
| `TESTE-dossie-fixture-anapolis-fontes-de-teste.pdf` | **Fixture de teste** (dados sintéticos) com fontes simuladas por fixtures, para mostrar critérios verificados e parciais. Faixa de teste em todas as páginas. |
| `TESTE-dossie-fixture-goiania-tiles-reais.pdf` | **Fixture de teste** em Goiânia com **tiles reais** de Goiânia: prova que o mapa não depende de Anápolis. |
| `TESTE-dossie-fixture-portoalegre-sem-mapa.pdf` | **Fixture de teste** no Sul do país **sem mapa-base** (comportamento padrão de produção para qualquer cidade sem tiles). |
| `TESTE-dossie-fixture-legado-reavaliado.pdf` | **Fixture de teste** no formato anterior à Fase 4, reavaliada: mostra score armazenado × recalculado e os critérios simulados marcados como sintéticos. |

Nenhum PDF `TESTE-…` é resultado de auditoria: todos os dados são sintéticos e nenhuma consulta foi feita ao Serper.

Comparação e explicação das diferenças: `docs/phase4/validation-report.md`.

O PDF oficial de desenvolvimento (`public/audits/…859b4021.pdf`, da Fase 3) **não foi alterado**.
