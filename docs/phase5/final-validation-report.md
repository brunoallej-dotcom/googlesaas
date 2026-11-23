# Fase 5: relatório final de validação (encerramento)

Data: 16/10/2026. **Resultado: a GMN está segura e estável para a operação interna no que depende de código; restam 6 decisões suas (portões G1 a G6) que alteram produção e não foram executadas.**

## Evidências
| Verificação | Resultado |
|---|---|
| Testes automatizados | **343/343** (286 na Fase 4 → 326 → 343) |
| Typecheck | 0 erros |
| Build de produção | Compilado; rotas protegidas + middleware |
| `.env.local` | **Não foi tocado por mim.** O hash mudou porque você adicionou `GMN_OPERATOR_EMAILS` (arquivo editado às 17:55, antes desta rodada; nenhum código do projeto escreve nele). Nova referência registrada |
| Login real | **Feito por você** (Supabase Auth); cadastro público **desligado** (confirmado: `disable_signup: true`, 1 usuário) |
| HTTP (sem sessão) | `/`, `/api/*` e `/audits/*` → 401/307; `/dev/*` → 404 em produção |
| Recuperação sem custo | `npm run validate:recovery`: **32/32**, 0 chamadas externas, 8 conjuntos (5 tabelas + 3 PDFs) idênticos antes/depois |
| Integridade | `npm run db:check`: 6 auditorias, 80 leads, 0 problemas |
| Backup local dos PDFs | 6 arquivos, SHA-256 conferido (`.data/backups/…`) |
| Mapa na tela | 12/12 tiles carregados (regressão do `Referrer-Policy` corrigida) |
| Créditos gastos / chamadas pagas | **0** |
| `public/audits/` | 3 PDFs oficiais inalterados |

## Correções desta rodada
1. **Regressão minha (mapa):** `Referrer-Policy: no-referrer` fazia o OpenStreetMap devolver "403 Access blocked" nos tiles da tela. Agora `strict-origin-when-cross-origin`, com teste.
2. **Custo oculto:** "Retomar" aparecia para auditoria `FAILED` sem dados e refaria as 49 consultas. Agora só existe com o Campo de Batalha de 49 pontos gravado (409 `NOTHING_TO_RESUME` caso contrário).
3. **Duplicação entre campanhas:** a trava olhava o `lead_id`; a mesma empresa vira um lead novo a cada campanha (ex.: *<CLIENTE_G>* tem 5 linhas). Agora casa por `place_id`.
4. **PDFs históricos:** a leitura prefere a pasta privada e tem cadeia local → bucket privado → recomposição do banco.

## Checklist por subsistema
| Subsistema | Estado | Observação |
|---|---|---|
| Autenticação, sessão e proteção de rotas | **APROVADO** | Login real validado; falha fechada; testes e HTTP |
| Cadastro público do Supabase | **APROVADO** | Desligado e conferido |
| PDFs novos | **APROVADO** | Privados, versionados, rota autenticada, recomponíveis |
| PDFs históricos: inventário, backup, procedimento, verificação de links | **APROVADO** | Feitos e documentados (`pdf-migration-plan.md`) |
| PDFs históricos: cópia ao bucket privado (G1) | **APROVADO** (16/10/2026) | 4 objetos + 3 cópias locais, 32/32 verificações, nada além do escopo mudou |
| Bucket público `gmn-audit-pdfs` (G2) | **APROVADO** (16/10/2026) | Agora privado: 3 links antigos → 400; operador baixa os 3 (SHA conferido); só a visibilidade mudou |
| Remoção dos originais de `public/audits` (G4) | **APROVADO** (17/10/2026) | 3 arquivos removidos por caminho exato, 6 fontes conferidas; estático 401/404; só eles sumiram |
| RLS: observado contra anon | **APROVADO COM RESSALVA** | Única barreira; anon tem privilégio de SELECT/UPDATE/DELETE |
| RLS: políticas/privilégios/Storage (catálogo) | **APROVADO** (17/10/2026) | Auditoria real: RLS ligado, **0 políticas**, anon/authenticated com todos os privilégios (inclui TRUNCATE), Storage privado; evidência em `docs/phase5/evidence/` |
| RLS: papel `authenticated` | **PENDENTE** | `npm run rls:probe -- --authenticated` (sua senha) |
| Migration `003_rls_hardening` (G5) | **PENDENTE** | Revisão 2 + rollback ajustado ao estado real, testados localmente (13/13); **não aplicada**; aguarda sua autorização (`rls-audit.md`, seção G5) |
| Idempotência e Worker (6 camadas) | **APROVADO** (lógica) | Sem execução real do Worker nesta fase |
| Recuperação e histórico | **APROVADO** | 32/32 sem custo |
| Retomada sem custo | **APROVADO** | 0 chamadas ao Serper; só com dados gravados |
| Battlefield 49 pontos | **APROVADO** | Inalterado |
| Mapa na tela | **APROVADO** | OSM público, 12/12 tiles |
| Mapa-base no PDF fora de Anápolis/Goiânia | **BLOQUEADO** | Sem Java/extrato (decisão sua); PDF sai sem ruas, com aviso |
| Monitoramento e saúde | **APROVADO** | Indicador e `/api/system/health` |
| Dependências (`npm audit`) | **APROVADO COM RESSALVA** | 9 avisos, nenhum em execução do servidor; sem upgrades (`dependency-audit.md`) |
| Homologação real (49 consultas) (G6) | **PENDENTE** | Plano pronto, não executado |

## Pedidos de autorização (nada foi feito sem eles)
- ~~G1~~ **EXECUTADO** (bucket privado criado e PDFs copiados, verificado);
- ~~G2~~ **EXECUTADO** (bucket antigo privado; reversível);
- ~~G3~~ **EXECUTADO** (ponteiros dos 3 históricos → rota protegida);
- ~~G4~~ **EXECUTADO** (originais removidos de `public/audits`, verificado);
- **G5** aplicar a migration de RLS (você cola no SQL Editor);
- **G6** executar a homologação real.
Antes de G5: colar no SQL Editor o `supabase/audit/rls-audit.sql` (só SELECT) e me enviar os resultados.

## Testes reais NÃO realizados
Geração de auditoria real (49 consultas); Worker + Redis + Serper reais; mapa com extrato MBTiles real; `rls:probe` como operador autenticado.
