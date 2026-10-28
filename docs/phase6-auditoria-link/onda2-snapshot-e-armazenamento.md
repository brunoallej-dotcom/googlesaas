# Fase 6 · Onda 2 — Snapshot de evidências (`DADOS_TRAVADOS`) e armazenamento local

Status: implementada em 20/10/2026 (offline). Metodologia: reconstrução `lumos-reconstruida-v1` (não é o prompt original do agente).

## O que é e o que não é
- **É** um registro fechado, versionado e com hash das evidências coletadas para uma empresa confirmada pelo operador.
- **Não é** uma auditoria final: não contém pontos, índice, cobertura, classificação nem confiança. Todo campo desse tipo é rejeitado (schemas `.strict()`), e `indexStatus` é sempre `PENDING_METHODOLOGY` até a D3 ser aprovada.
- Não envolve interface, PDF, Supabase, Redis, filas, rede, Serper, IA ou migrations.

## Decisão aprovada que a Onda 2 registra
Categorias, avaliações, respostas e Google Posts são atributos nativos: existência ou configuração no Google exige comprovação por fonte adequada. Serviços e elementos visuais são critérios mistos, mas **cada evidência mantém sua origem**: site ou Instagram não comprovam serviços, fotos ou vídeos cadastrados no Google. No snapshot, as evidências são preservadas exatamente como entraram (origem, fonte, data, status e contexto externo), e as regras da Onda 1 são reaplicadas na criação e em toda leitura.

## Conteúdo do snapshot
Envelope gravado: `canonicalization` (`gmn-canonical-json-v1`), `hash` (`sha256` + valor) e `content`.

`content` registra:
- identificação (`snapshotId`), `version`, `previous` (versão e hash anteriores; `null` na v1), `methodologyVersion`, `kind: EVIDENCE_SNAPSHOT`;
- `collectedAt` (data da coleta) e `frozenAt` (data do fechamento);
- `link.originalLink` (como foi informado) e `link.resolved` (`null` ou link resolvido, `resolvedAt`, `method`);
- `identity`: identificadores validados (cid, placeId, featureId) e **confirmação do operador** (obrigatória);
- `evidences` com fonte, data, origem, status, limitação e contexto externo;
- `criteria`: os 9 critérios com status e referências às evidências (sem pontos);
- `limitations`: limitações e informações não verificadas.

### Regras entre campos
- Datas: consulta ≤ coleta ≤ fechamento; confirmação ≤ fechamento.
- Link direto (com identificador): não tem link resolvido.
- Link curto: só congela com link resolvido que identifique o mesmo perfil, e a confirmação do operador deve ser **posterior** à resolução. **Nesta onda nada resolve links**: só o contrato existe.
- Identificadores da identidade = identificadores do link efetivo (resolvido, se houver; senão o original).
- Evidência nativa (`GOOGLE_NATIVE`) deve apontar para o mesmo perfil auditado.
- Critério nunca é mais forte do que suas evidências; fonte externa nunca comprova atributo nativo.

## Hash e serialização determinística
- JSON canônico: chaves ordenadas, sem espaços, textos em NFC, `undefined` equivale a ausente, ordem de arrays preservada. Valores sem representação inequívoca (NaN, Infinity, bigint, funções, Date, Map, ciclos, arrays esparsos, profundidade acima de 64) são recusados.
- Mesmo conteúdo ⇒ mesmo SHA-256; qualquer mudança ⇒ hash diferente.
- Na leitura o hash é recalculado e comparado; divergência = `HASH_MISMATCH`.
- **Limite do hash:** detecta alteração acidental ou inconsistência. **Não é assinatura, não é criptografia e não protege contra adulteração deliberada**: quem altera o arquivo também pode recalcular o hash (as regras entre campos barram apenas conteúdo incoerente). A cadeia `previous.hash` ajuda a achar inconsistências entre versões, com o mesmo limite. Proteção real exigiria assinatura com chave guardada fora do disco (decisão futura).

## Armazenamento local
- Pasta: `.data/link-audits/<snapshotId>/vNNNN.json` (`defaultLinkAuditDirectory`), fora de `public/` e ignorada pelo git. Texto simples, sem criptografia.
- Cada `vNNNN.json` é **fechado**: não há API para editar, substituir ou apagar. Mudar algo = nova versão, que precisa informar a versão que o chamador viu (`expectedPreviousVersion`); se divergir, `CONFLICT` e nada é gravado.
- Uma nova versão não pode mudar a empresa (identificadores e link original) nem ter `frozenAt` anterior ao da versão anterior.
- **Gravação:** temporário exclusivo `.tmp-vNNNN-<hex>.json` (modo 0600) + `fsync` → `chmod 0444` **no temporário** (nenhum `chmod` toca o caminho final) → `link()` para o nome final (criação exclusiva e atômica; `EEXIST` = conflito) → remove o temporário → `fsync` do diretório (melhor esforço) → relê e verifica antes de devolver sucesso. Se o sistema de arquivos não suportar `link` (por exemplo parte dos casos em `/mnt/d`), o arquivo final é criado com `wx` (exclusivo, modo 0444): **nunca substitui** uma versão existente (por isso não se usa `rename`), mas **não é atômico**: uma queda no meio pode deixar um `vNNNN.json` parcial, que a leitura reporta como `CORRUPT` e que bloqueia novas versões até decisão do operador.
- **Bytes canônicos:** na leitura, além do hash, o texto do arquivo precisa ser exatamente a serialização canônica do conteúdo. Chaves duplicadas, indentação, BOM, linha extra ou normalização Unicode diferente são `CORRUPT`: uma versão = uma sequência de bytes.
- **Leitura:** sem seguir symlink (`O_NOFOLLOW` + `fstat` do descritor), só arquivo comum, no máximo 2 MB.
- **Falhas:** erro de disco (incluindo EIO/EROFS) ⇒ `WRITE_FAILED`, sem nova tentativa. Uma queda no meio deixa no máximo um `.tmp-*`, que nenhum leitor trata como snapshot; `cleanupOrphanTempFiles` remove somente `.tmp-*` antigos e nunca um `vNNNN.json`.
- **Corrupção:** arquivo adulterado (`HASH_MISMATCH`), truncado (`CORRUPT`), copiado com outro nome (`CORRUPT`), lacuna na cadeia (`CHAIN_BROKEN`) ou symlink (`UNSAFE_PATH`) são **reportados**, nunca corrigidos ou apagados automaticamente, e bloqueiam novas versões até decisão do operador.
- O rascunho é lido uma única vez (cópia validada); o diretório do snapshot só é criado depois que tudo foi validado. Operações no mesmo snapshot são serializadas em memória (chave pelo caminho real) e a criação exclusiva do arquivo cobre processos diferentes.
- `snapshotId` só aceita `[A-Za-z0-9_-]` com 8 a 64 caracteres; o caminho final é conferido dentro do diretório base.

## Limites conhecidos (declarados, não resolvidos)
- **Resolução de link curto é autodeclarada:** nada nesta onda prova que o link resolvido veio do link curto; o snapshot só exige que o link resolvido identifique o mesmo perfil e que a confirmação do operador seja posterior. `resolvedAt` e `method` são afirmados, não verificados. A verificação real depende de uma onda futura (rede, SSRF, allowlist) e de autorização.
- **Local e sem criptografia:** quem tem acesso à pasta lê e pode alterar arquivos (a alteração é detectável apenas se o hash não for recalculado).
- **Corridas locais:** um atacante com escrita na pasta pode trocar arquivos entre a verificação e o uso; um hard link de fora da pasta com conteúdo íntegro é aceito; uma pasta base que seja symlink é aceita (só o diretório do snapshot é recusado se for symlink). Em sistemas de arquivos que ignoram maiúsculas, ids que diferem só na caixa caem na mesma pasta e são recusados como `CORRUPT` (seguro).
- **Sem `link()`:** o caminho alternativo não é atômico em caso de queda; não há garantia de atomicidade entre processos além da criação exclusiva.
- **Uso só no servidor:** `canonical.ts` e `snapshot-store.ts` dependem de `node:crypto` e `node:fs`; o `index.ts` não deve ser importado em código de navegador.

## Arquivos
`src/lib/link-audit/canonical.ts` · `snapshot.ts` · `snapshot-store.ts` (único com acesso a disco) · reexports em `index.ts`. Testes: `tests/link-audit-canonical.test.ts`, `-snapshot.test.ts`, `-snapshot-store.test.ts`, `-isolation.test.ts` (política por arquivo) e `tests/helpers/link-audit-fixtures.ts` (dados fictícios).
