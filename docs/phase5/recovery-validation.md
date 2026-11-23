# Fase 5: validação da recuperação de auditorias existentes

Atualizado em 16/10/2026. **Resultado: RECUPERAÇÃO VALIDADA (32 de 32 verificações), com zero chamadas externas e zero alteração de dados.** Comando: `npm run validate:recovery`.

## Método
1. **Foto antes:** hash SHA-256 de todas as linhas das 5 tabelas (inclui `updated_at`) e dos 3 PDFs oficiais de `public/audits`.
2. **Guarda de rede:** `fetch` só aceita o host do Supabase; qualquer outro destino (Serper, LLM, OpenStreetMap…) lança erro e é contabilizado. Redis, fila e Worker não são carregados.
3. **Leitura como a UI faz:** estado da auditoria, "última concluída por empresa + palavra-chave", lead e campanha, cadeia de leitura do PDF.
4. **Recomposição em memória** do relatório pelo caminho legado (sem gravar nada) e conferência do Score histórico.
5. **Foto depois** e comparação.

## Resultado
| Auditoria | Estado | Battlefield | Score Juiz histórico (gravado = mostrado) | Relatório recomposto | PDF oficial servido |
|---|---|---|---|---|---|
| 4323da26 <CLIENTE_D> | COMPLETED | 49 pontos | **65,1%** = 65,1% | 11 páginas | do disco (13.517 B) |
| 312ebf57 <CLIENTE_E> | COMPLETED | 49 pontos | **59,7%** = 59,7% | 11 páginas | do disco (13.451 B) |
| 859b4021 <CLIENTE_F> | COMPLETED | 49 pontos | **56,4%** = 56,4% | 12 páginas | do disco (**271.346 B**, versão oficial com mapa) |
| 12b63268, fffc69aa, 5b986fa4 (15/10) | FAILED ("Invalid URL") | sem dados | n/d | n/d | n/d |

- **Integridade:** 8 conjuntos (5 tabelas + 3 PDFs) com hash idêntico antes e depois.
- **Rede:** 0 chamadas bloqueadas; 22 leituras ao Supabase.
- **Histórico preservado:** o Score gravado nunca é recalculado; a linha "Score Juiz histórico (armazenado)" do relatório recomposto é igual ao valor gravado nas 3 concluídas. A origem aparece como "legado".
- **Falhas antigas:** as 3 `FAILED` não oferecem "Retomar" (não há Battlefield gravado) e o enfileiramento as trata como "sem dado a reaproveitar". Corrigido nesta rodada: antes o botão apareceria e uma retomada refaria as 49 consultas pagas.

## HTTP real (servidor local, somente leitura)
Com sessão de teste: `status`, `completed`, `campaigns` e o PDF respondem 200 e o PDF baixado tem o SHA do arquivo oficial. Sem sessão: 401 em tudo. (Detalhes em `security-review.md` §2.)

## Limites
Não valida a **geração** de uma auditoria nova (exige as 49 consultas pagas): isso é a homologação real, ainda **PENDENTE** (`homologation-plan.md`).
