# Fase 5: migração dos PDFs históricos para armazenamento privado

Atualizado em 16/10/2026. **Estado: preparada e com backup local feito; NENHUMA alteração em produção foi executada. Aguarda sua autorização por etapa (G1 a G4).**

## 1. Inventário real (somente leitura)
Bucket `gmn-audit-pdfs`: **público**, sem limite de tamanho nem de tipo. Criado em 15/10/2026. Contém 3 objetos; `public/audits/` contém 3 arquivos.

| Auditoria | `public/audits` | Bucket | Acesso sem credencial ao bucket | Conteúdo |
|---|---|---|---|---|
| 4323da26 (Goyaz Barbearia) | 13.517 B · `4f6e4cfd…` | 13.517 B · `4f6e4cfd…` | **HTTP 200** | idêntico |
| 312ebf57 (Clínica de Estética Dra. Rayane) | 13.451 B · `7cd7c299…` | 13.451 B · `7cd7c299…` | **HTTP 200** | idêntico |
| 859b4021 (Dra. Anna Vitória) | **271.346 B** · `fd41a6b3…` (oficial, com mapa) | **13.332 B** · `a670948b…` (versão antiga, 3 pág.) | **HTTP 200** | **DIFERENTE** |

**Achado importante:** a auditoria 859b4021 tem **duas versões distintas**. A pública do bucket é a antiga; a oficial (a que você escolheu como versão de desenvolvimento) só existe em `public/audits`. A migração preserva **as duas**: a oficial vira a cópia principal e a antiga vai para `versao-anterior-do-bucket/`. Nenhuma é descartada.

Total: 338.614 B (0,32 MB). Ponteiros no banco: `pdf_storage_path` com caminho do Windows (`<PASTA_PROJETO_V100>\public\audits\…`) e `pdf_download_url` com a URL pública do bucket.

## 2. Acesso aos links antigos (verificado)
| Link | Hoje |
|---|---|
| URL pública do bucket (3) | **HTTP 200 sem login** (exposição real) |
| `/audits/<arquivo>.pdf` pelo Next (3) | **HTTP 401** sem sessão (bloqueado pelo middleware; mitigação parcial) |
| `/api/audit/<id>/pdf` | 401 sem sessão; 200 com sessão (SHA igual ao oficial) |
| Listagem do bucket com chave anon | `[]` (não lista), mas **quem tem o caminho baixa** |

Depois do G2 (bucket fechado) o esperado para os links públicos é falha (400/404), e o download passa a existir **somente** pela rota autenticada.

## 3. Backup (já executado, local)
`npm run pdf:migrate -- backup` gravou **6 arquivos** (3 de `public/audits` + 3 do bucket), com SHA-256 conferido após a cópia, em:
`.data/backups/pdf-migration-2026-10-16T21-36-14-088Z/` (`public-audits/`, `bucket/`, `manifest.json`).
O manifesto inclui o inventário e o **snapshot dos ponteiros do banco** (para reversão). Nada foi alterado em produção. A pasta está fora de `public/` e no `.gitignore`. **Recomendação:** copie essa pasta para um disco externo ou nuvem sua; é a rede de segurança de todas as etapas.

## 4. Procedimento (cada fase só com `--apply` + digitar MIGRAR; sem `--apply` é simulação)
| Portão | Comando | O que altera em produção | Reversão |
|---|---|---|---|
| — | `npm run pdf:migrate -- inventory` / `backup` / `verify-links` | nada | — |
| **G1** | `copy --backup <pasta> --bucket gmn-audit-pdfs-private --apply` | **Cria** o bucket privado (só PDF, limite 20 MB) e **copia** (sem sobrescrever) os 3 oficiais + a versão antiga; cópias na pasta privada `.data/audits/`. Confere SHA-256 de tudo. Depois você adiciona `SUPABASE_PRIVATE_AUDIT_BUCKET=gmn-audit-pdfs-private` ao `.env.local` | Remover só o bucket novo; originais intactos |
| **G2** | `close-public --backup <pasta> --bucket gmn-audit-pdfs-private --apply` | **Fecha** o bucket antigo (`public=false`). **Recusa** se as cópias privadas não conferirem | `rollback --scope buckets --apply` reabre; nada é apagado |
| G3 (opcional) | `pointers --backup <pasta> --apply` | Atualiza `pdf_storage_path`, `pdf_download_url` e `diagrammer_payload` dos 3 históricos para a rota autenticada | `rollback --scope pointers --apply` restaura os valores do manifesto |
| **G4** | **manual, depois de G1 a G3 verificados** | Remover os originais de `public/audits` | Restaurar do backup. **Não há código de exclusão no projeto** |

Como a rota procura primeiro a pasta privada pelo nome do arquivo (e depois a cópia no bucket privado, e só então recompõe do banco), **o G1 já passa a servir os históricos da área privada sem alterar nenhuma linha do banco**; o G3 é só higiene dos ponteiros.

## 5. Verificação depois de cada etapa
1. `npm run pdf:migrate -- inventory` (agora com os dois buckets) e `verify-links --base http://localhost:3000`.
2. `npm run rls:probe`: `GET público SEM credencial` deve passar de EXPOSED para NOT_EXPOSED após o G2.
3. Baixar os 3 PDFs pela rota autenticada e comparar SHA-256 com o manifesto (a versão oficial da 859b4021 deve ter 271.346 B).
4. `npm run validate:recovery` e `npm run db:check`.

## 6. Plano de reversão
Antes do G4 tudo é reversível: reabrir o bucket (`rollback`), restaurar ponteiros (manifesto), descartar o bucket novo. Depois do G4 só o backup restaura os arquivos; por isso o G4 só será proposto com G1–G3 verificados e o backup copiado para fora desta máquina.

## 7. Código e testes
`src/lib/pdf/migration.ts` (lógica pura, **sem caminho de exclusão**), `migration-supabase.ts` (portas reais), `scripts/migrate-pdfs.ts` (CLI com confirmação digitada), `tests/pdf-migration.test.ts` (Supabase falso: inventário e backup sem escrita em produção, cópia idempotente que nunca sobrescreve, bucket público recusado como destino, fechar bucket só muda a visibilidade, rollback restaura bucket e ponteiros).

## 8. G1: roteiro autorizado (condicionado ao backup externo)
**Estado:** código e verificações prontos e testados (349 testes); simulação do `copy` rodada (sem `--apply`): pré-condições OK e plano de 7 operações (3 cópias na pasta privada + 3 objetos oficiais + 1 versão anterior da 859b4021 no bucket privado). **Nada foi criado nem copiado em produção.** Início somente depois da confirmação escrita do backup externo.

Conferir o backup externo (qualquer pasta, ex.: disco externo montado no WSL):
`npm run pdf:migrate -- verify-backup --backup <pasta-da-copia>` (compara SHA-256 e tamanho de cada arquivo com o `manifest.json`). Sem acesso pelo WSL: `cd <pasta> && find . -type f -exec sha256sum {} +` nos dois lados e comparar.

Sequência: `verify-backup` → `inventory` + comparação com o manifesto (deriva aborta) → `snapshot --label antes` → `copy --apply` (cria bucket privado `gmn-audit-pdfs-private`, só PDF, 20 MB; envia sem sobrescrever; 4 objetos + 3 arquivos em `.data/audits/`) → `verify-private` (SHA-256 de tudo; cadeia de leitura só com o bucket privado; rota real com sessão servindo do bucket privado; rota sem sessão = 401; anônimo/anon/token forjado negados) → `snapshot --label depois` + `compare-snapshots` (só os destinos novos podem mudar) → `validate:recovery`. G2, G3, G4, G5 e G6 não fazem parte.

## 9. G1 EXECUTADO em 16/10/2026 (autorizado após confirmação do backup externo)
**Resultado: APROVADO.** Backup reverificado (6 arquivos, hashes OK), `.env.local` inalterado, pré-condições todas OK (sem deriva do inventário). Bucket privado `gmn-audit-pdfs-private` criado (`public=false`, só `application/pdf`, limite 20 MB). **4 objetos enviados, 0 falhas, nenhum sobrescrito; 3 cópias em `.data/audits/`.**

| Auditoria | Destino no bucket privado | SHA-256 (16 primeiros) | Cópia local privada |
|---|---|---|---|
| 4323da26 | `audits/4323da26…/auditoria-gmn-goyaz-barbearia-tradicional-4323da26.pdf` (13.517 B) | `4f6e4cfd0bf9541b` | `.data/audits/` (idêntica) |
| 312ebf57 | `audits/312ebf57…/auditoria-gmn-cl-nica-de-est-tica-dra-rayane-havilla-…-312ebf57.pdf` (13.451 B) | `7cd7c299e80389e4` | `.data/audits/` (idêntica) |
| 859b4021 (oficial, com mapa) | `audits/859b4021…/auditoria-gmn-dra-anna-vit-ria-…-859b4021.pdf` (271.346 B) | `fd41a6b3e7a2f957` | `.data/audits/` (idêntica) |
| 859b4021 (versão anterior do bucket) | `audits/859b4021…/versao-anterior-do-bucket/…859b4021.pdf` (13.332 B) | `a670948b9ab6f973` | só no bucket privado e no backup |

`verify-private`: **32/32 verificações aprovadas** (integridade SHA-256 de todas as cópias; cadeia de leitura só com o bucket privado; rota real com sessão servindo do bucket privado e da pasta privada com o SHA correto; rota sem sessão 401; URL pública, chave anon e token forjado negados; listagem anon vazia; bucket novo invisível ao anon; 0 chamadas externas).
Foto antes × depois: **21 entradas, 8 novas só nos destinos permitidos, 0 removidas, 0 alteradas** (banco, `public/audits`, bucket antigo e `.env.local` idênticos). `validate:recovery`: 32/32.
**Não executados:** G2 (bucket antigo **continua público**: 3 links com HTTP 200 sem credencial), G3 (ponteiros do banco intactos), G4, G5, G6.
O app só passa a consultar o bucket privado depois de `SUPABASE_PRIVATE_AUDIT_BUCKET=gmn-audit-pdfs-private` no `.env.local` (ação sua); até lá serve a pasta privada `.data/audits`.

## 10. G2 EXECUTADO em 16/10/2026: bucket antigo `gmn-audit-pdfs` agora PRIVADO
**Resultado: APROVADO.** Única alteração: `public: true → false` (nenhum objeto movido ou apagado; limite e tipos do bucket inalterados; bucket privado inalterado).

Verificações **antes** de alterar (todas aprovadas): app em execução lê a variável (`privatePdfBucket: true`); `verify-private` 32/32 com a rota real servindo do bucket privado; SHA-256 dos 3 oficiais `4f6e4cfd…`, `7cd7c299…`, `fd41a6b3…` iguais ao manifesto; backup íntegro; `validate:recovery` 32/32; nenhum fluxo do código depende dos links públicos (a interface usa só `/api/audit/<id>/pdf`; a coluna `pdf_download_url` dos 3 históricos ainda guarda a URL antiga, **não é lida** e fica para o G3).

| Verificação depois do G2 | Resultado |
|---|---|
| 3 URLs públicas antigas, sem credencial | **HTTP 400 "Bucket not found"** (antes: 200) |
| Mesmos 3 objetos com a chave anon | HTTP 400 (negado) |
| Listagem de objetos com a chave anon | `[]` |
| `rls:probe`, "GET público SEM credencial" | **NOT_EXPOSED** (antes: EXPOSED); **EXPOSTO: 0** |
| Operador autenticado, rota `/api/audit/<id>/pdf` (servidor em execução) | **200 nos 3**, SHA `4f6e4cfd…`, `7cd7c299…`, `fd41a6b3…` (conferem); sem sessão: 401 |
| Leitura forçada pelo bucket privado (`verify-private`) | 200 e SHA correto nos 3; 32/32 |
| `/audits/*.pdf` sem sessão | 401 |
| Objetos do bucket antigo (service role) | 3 presentes, mesmos hashes (`4f6e4cfd…`, `7cd7c299…`, `a670948b…`); acessíveis sem credencial: 0 |
| Foto antes × depois (21 entradas) | **1 alteração: `bucket-source/gmn-audit-pdfs/public`**, exatamente a esperada (o comparador acusa "inesperada" só porque foi configurado com os destinos do G1). Banco, `public/audits`, objetos, bucket privado e `.env.local` idênticos |
| `validate:recovery` | 32/32, 0 chamadas externas |

**Reversão (não necessária):** `npm run pdf:migrate -- rollback --backup <pasta> --scope buckets --apply --confirm-phrase MIGRAR` reabre o bucket (o escopo é obrigatório: `pointers` nunca reabre o bucket); alternativa manual no painel (Storage → `gmn-audit-pdfs` → Edit bucket → Public). `applied.json` registra `closedBuckets: ["gmn-audit-pdfs"]`.
**Ressalva:** links antigos que você tenha guardado ou enviado a terceiros deixaram de funcionar (400). **Continuam abertos:** G3, G4 (os originais ainda estão em `public/audits/`, servidos só por rota bloqueada pelo middleware), G5 e G6.

## 11. G3 EXECUTADO em 16/10/2026: referências dos 3 PDFs históricos no banco
**Resultado: APROVADO.** Pré-condições todas OK (backup íntegro; inventário ao vivo igual ao manifesto, inclusive ponteiros; cópias privadas conferem; bucket antigo privado e 3 links antigos → 400; formato `/api/audit/<id>/pdf` compatível). Backup dos valores originais: `.data/migration/g3-before-2026-10-17T00-06-44-087Z.json` (+ despejo completo das 5 tabelas `g3-rows-antes-…`); o `manifest.json` do backup externo já guarda os mesmos valores.

**Mecanismo:** não há transação multi-linha via PostgREST sem criar função no banco (DDL, não autorizado). Proteção equivalente: pré-checagem das linhas contra o snapshot, UPDATE condicional (compare-and-set) por linha exigindo exatamente 1 linha afetada, compensação automática na 1ª falha e verificação campo a campo com reversão automática. Nenhuma compensação foi necessária.

| Registro | Campo | ANTES | DEPOIS |
|---|---|---|---|
| 4323da26 | `pdf_download_url` | `https://…supabase.co/storage/v1/object/public/gmn-audit-pdfs/audits/4323da26…pdf` | `/api/audit/4323da26-b73c-417e-9306-f4330d335bcd/pdf` |
| | `pdf_storage_path` | `<PASTA_PROJETO_V100>\public\audits\auditoria-gmn-goyaz-…-4323da26.pdf` | `<repo>/.data/audits/auditoria-gmn-goyaz-…-4323da26.pdf` |
| 312ebf57 | `pdf_download_url` | URL pública do bucket antigo | `/api/audit/312ebf57-edfc-41c4-ac62-9de45ef1e613/pdf` |
| | `pdf_storage_path` | `<PASTA_PROJETO_V100>\public\audits\…-312ebf57.pdf` | `<repo>/.data/audits/…-312ebf57.pdf` |
| 859b4021 | `pdf_download_url` | URL pública do bucket antigo (**versão antiga**) | `/api/audit/859b4021-404e-40fc-acba-da21e1fd4746/pdf` |
| | `pdf_storage_path` | `<PASTA_PROJETO_V100>/public/audits/…-859b4021.pdf` | `<repo>/.data/audits/…-859b4021.pdf` (**oficial com mapa, 271.346 B, `fd41a6b3…`**) |

O `diagrammer_payload` mudou **somente** nas chaves `pdfDownloadUrl` e `pdfStoragePath` (mesmos valores acima); `pageCount`, `fileSizeBytes`, `generatedAt`, `pdfFileName` e `auditId` ficaram iguais. A versão histórica antiga da 859b4021 (13.332 B, `a670948b…`) **não é referenciada** por nenhum ponteiro e segue separada em `versao-anterior-do-bucket/` (bucket privado), no bucket antigo e nos backups.

**Verificações:** comparação campo a campo de todas as tabelas: **3 linhas alteradas (as 3 previstas), 0 novas, 0 removidas**; nelas só `pdf_download_url`, `pdf_storage_path`, `diagrammer_payload` (2 chaves) e `updated_at` (trigger do banco); as outras 3 auditorias e as 4 outras tabelas idênticas. Foto antes × depois: só `db/gmn_audits` mudou; `public/audits`, `.data/audits`, objetos e visibilidade dos 2 buckets e `.env.local` idênticos. Rota real com sessão: **200 e SHA correto nos 3** (`4f6e4cfd…`, `7cd7c299…`, `fd41a6b3…`); **sem sessão: 401**; leitura forçada pelo bucket privado (`verify-private`): 32/32; `validate:recovery` 32/32; `db:check` sem problemas; `rls:probe` EXPOSTO 0; 3 links antigos → 400; 0 URLs públicas no banco; 0 chamadas externas.

**Achado (anterior ao G3, não alterado por ordem de escopo):** o `diagrammer_payload` da 859b4021 declara `pageCount: 3` e `fileSizeBytes: 13332` (a versão antiga); o PDF oficial tem **11 páginas** (contagem por dois métodos, conferida com uma biblioteca independente; o "12" dito antes veio de um PDF recomposto em memória, não do arquivo oficial) e 271.346 B. A interface mostra "3 páginas · 13 KB" para essa auditoria. Corrigir é decisão sua (correção isolada preparada: `npm run pdf:fix-metadata`, dry-run: pageCount 3→11, fileSizeBytes 13332→271346).

**Reversão (não necessária):** `rollback --backup <pasta> --scope pointers --apply --confirm-phrase MIGRAR` (limitação: `updated_at` não volta ao valor anterior; o trigger grava a hora do rollback).
**Continuam abertos:** G4 (originais em `public/audits/`), G5 (RLS), G6 (homologação real).

## 12. G4 EXECUTADO em 17/10/2026: originais removidos de `public/audits/`
**Resultado: APROVADO.** Uma primeira tentativa (16/10) foi interrompida pela trava porque a cópia externa não estava acessível; nada foi removido. Após a reconexão do pendrive, retomado exclusivamente o G4.

**Pré-condições (todas aprovadas antes de excluir):** cópia externa `<UNIDADE_EXTERNA>\pdf-migration-2026-10-16T21-36-14-088Z` relida por PowerShell/.NET: **7/7 arquivos com SHA-256 e tamanho iguais ao manifesto**, 0 extras; backup local íntegro; `.env.local` igual; `verify-private` 32/32 (3 PDFs servidos do bucket privado); inventário **idêntico ao aprovado**; cada arquivo confirmado com o mesmo SHA-256 em 6 lugares (public/audits, manifesto, `.data/audits`, bucket privado, backup local, backup externo).

**Inventário removido (3 arquivos, 300.314 B), um por vez, `fs.unlink` por caminho exato:**
| Arquivo | Tamanho | SHA-256 |
|---|---|---|
| `auditoria-gmn-goyaz-barbearia-tradicional-4323da26.pdf` | 13.517 B | `4f6e4cfd0bf9541b…` |
| `auditoria-gmn-cl-nica-de-est-tica-dra-rayane-havilla-botox-preenchimento-facial-312ebf57.pdf` | 13.451 B | `7cd7c299e80389e4…` |
| `auditoria-gmn-dra-anna-vit-ria-dentista-em-an-polis-859b4021.pdf` (oficial com mapa) | 271.346 B | `fd41a6b3e7a2f957…` |
Registros: `.data/migration/g4-remocao-plano-*.json` (gravado antes de excluir) e `g4-remocao-resultado-*.json`. A pasta `public/audits/` foi mantida, vazia.

**Depois da remoção:**
| Verificação | Resultado |
|---|---|
| Rota protegida com sessão (3) | **200**, SHA `4f6e4cfd…`, `7cd7c299…`, `fd41a6b3…` conferem; fonte `.data/audits` |
| Sem sessão | **401** nos 3 |
| Leitura forçada pelo bucket privado (`verify-private`) | 200, SHA correto, fonte `private-bucket`; 32/32 |
| Arquivos estáticos `/audits/<arquivo>.pdf` | sem sessão **401**; com sessão **404** (antes 200). Confirmado também em servidor de **produção** (`next start`) |
| `find .next -name '*.pdf'` | 0 |
| Foto antes × depois (21 → 18 entradas) | **somente os 3 arquivos de `public-audits` sumiram**; banco, `.data/audits`, objetos e visibilidade dos 2 buckets (ambos privados) e `.env.local` idênticos; backups íntegros |
| `validate:recovery` | 32/32; `db:check` sem problemas; `rls:probe` EXPOSTO 0 |
| `npm test` / `typecheck` / `build` | 367/367 / 0 erros / compilado |

**Git e deploy:** o projeto **não é um repositório Git**; não há `vercel.json`, Dockerfile, `.github`, `.vercel` nem `.next/standalone`, ou seja, **nenhum ambiente publicado**. `.gitignore` já ignora `public/audits/*.pdf` e `.data/`, então nada a refletir. Para um futuro deploy: não copiar `.data/` nem `.env.local` por pipeline público; sem `.data/audits`, a rota serve do bucket privado (verificado), desde que `SUPABASE_PRIVATE_AUDIT_BUCKET` esteja definido. Nada foi publicado.

**Reversão (não necessária):** copiar de `.data/audits/` ou do backup (local ou `<UNIDADE_EXTERNA>`) para `public/audits/` sem sobrescrever (`cp -n`), conferindo o SHA-256. **Efeito colateral esperado:** `pdf:migrate copy/pointers/inventory` passam a acusar ausência dos arquivos públicos (o manifesto é a referência).
**Continuam abertos:** G5 (RLS), G6 (homologação real), correção do metadado da 859b4021 (aguarda sua aprovação).
