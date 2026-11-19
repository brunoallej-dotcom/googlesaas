# Implementation waves — Produtor P1 da Auditoria por Link (atestação offline da coleta)

> Spec de origem: `docs/specs/link-audit-p1-attestation.md` (§14 sugeria W0–W6; este arquivo os detalha e acrescenta
> a onda **R1**, do ADR-0002). Os testes seguem o padrão `tests/link-audit-seal-*.test.ts` da spec §5.2. Este arquivo é a fonte da verdade do roadmap de ondas; a tabela do `NOTES.md` espelha a
> coluna Status.
>
> **Contexto (16/11/2026):** a Onda 6C foi encerrada formalmente pelo responsável. A finalização continua falhando
> fechada (`NOT_FINALIZABLE`) até existir prova de coleta, e o P1 é o que a produz. Valem as decisões D1–D6 da spec
> (§13.1). Os bloqueadores de produção fora do P1 continuam fora deste plano: guarda externa imutável, papel
> administrativo com dupla aprovação, volumes e chaves no `stack.yml`, D5.

| Onda | Entrega | Depende de | Paralela com | Status |
|------|---------|------------|--------------|--------|
| W0 | Fundação documental: spec e modelo de ameaças aprovados, contrato P1 ajustado, **ADR-0002 aceito** e emenda §16.17 da spec do livro | — | — | ✅ mergeada (PR #26; decisões D9–D13; §16.17 revisada) |
| W1 | Função única `basis → EvidenceToProve[]` + teste de equivalência; esquemas do pacote e da aprovação; `packageSha256` determinístico | W0 | W3 | ✅ mergeada (PR #24, `bd07e35`) |
| W2 | CLI `export` (somente leitura) | W1 | W3, R1 | ✅ mergeada (PR #29) |
| W3 | Verificador `v2` (aditivo em `provenance.ts`) + contrato próprio | W0 + contrato aprovado | W1, W2 | ✅ concluída em 19/11/2026 (W3.1–W3.5: PRs #30, #32, #33, #34, #35) |
| R1 | ADR-0002: confirmação de resultados pelo livro de cabeças (fase C do resultado só pelo autor) | W0 (§16.17 revisada), W1, W3 | W2 | ⬜ |
| R2 | Resultado confirmado registra a proveniência que o atestou (`headSeq`, `headSealSha256`, `keyIds`); `UNAUTHENTICATED` na releitura ⇒ revisão humana | W3, R1 | W4 | ⬜ |
| W4 | CLI `sign` (manifesto `v2`) | W1, W3, decisões §13.2 itens 1, 2 e 4 (tomadas: D10, D11, D12/D14) | — | ⬜ desbloqueada |
| W5 | Procedimento, dossiê e ensaio ponta a ponta em homologação com chave descartável | W4, R1, R2 | — | ⬜ |
| W6 | Coleta LIVE nova da TUVAPLAST (fora do código) | W5 + autorização escrita específica | — | ⬜ |

Ordem prática: W0 → {W1 ∥ W3} → {W2 ∥ R1} → {R2 ∥ W4} → W5 → W6. A R1 espera a W3 porque as duas mexem nos validadores da
interface (`audit-page/validators.ts`).

**Regras de todas as ondas.**
- Uma branch e um PR por onda, com a spec atualizada no mesmo PR.
- Testes novos entram na lista `test` do `package.json`. O conflito dessa lista entre ondas paralelas se resolve por
  união (`googlesaas-worktrees/tools/merge-test-list.cjs`).
- Sem rede, sem chave real e sem `.env*`. Motor congelado: `git diff --quiet v1.0.1 -- src/lib/link-audit/scoring`.
- Cada critério de aceite da spec (IA-xx, RS-xx) vira ao menos um teste com o identificador no nome.

## Onda W0 — Fundação documental (sequencial, sem código)

- **Objetivo**: deixar decididos e escritos os contratos que as ondas de código vão seguir.
- **Escopo (slices/arquivos)**:
  - `docs/specs/link-audit-p1-attestation.md` e `docs/security/threats/link-audit-p1-atestacao.md`: aprovação;
  - `docs/phase6-auditoria-link/onda6c-contrato-p1-atestacao.md`: §3 passo 4, §5 dossiê em duas partes, §6, `v2`,
    D1–D6;
  - `docs/adr/0002-authenticate-result-receipts.md`: de Proposed para Accepted;
  - `docs/phase6-auditoria-link/onda6c-especificacao-livro-de-cabecas.md`: emenda §16.17, com os cinco pontos do
    ADR-0002.
- **Depende de / paralela com**: nada; toda onda de código depende dela.
- **Critérios de aceite**:
  - o ADR-0002 aparece como `Accepted` em `docs/adr/README.md`;
  - a spec do livro tem a seção `16.17`;
  - o contrato P1 cita D1–D6;
  - a spec do P1 marca como aprovada a si e ao modelo de ameaças.
  - As decisões em si são do responsável: um goal loop só confere que estão escritas.
- **Goal command**: `/goal grep -q "0002.*Accepted" docs/adr/README.md && grep -q "^## 16.17" docs/phase6-auditoria-link/onda6c-especificacao-livro-de-cabecas.md && grep -q "CONTRATO APROVADO" docs/phase6-auditoria-link/onda6c-contrato-p1-atestacao.md && grep -q "APROVADA na onda W0" docs/specs/link-audit-p1-attestation.md, stop after 3 tries`

## Onda W1 — Base comum do pacote

- **Objetivo**: uma única função transforma a base de pontuação na lista de evidências a provar, usada pela prévia e pelo
  `export`, com prova de que nada mudou.
- **Escopo (slices/arquivos)**:
  - extrair a montagem de `src/lib/link-audit-scoring-runs/preview.ts:219` para uma função pura;
  - novo módulo do P1 com os esquemas zod do pacote e da aprovação e o `packageSha256` determinístico;
  - viabilidade de `REPORT_REPRODUCES`;
  - testes `tests/link-audit-seal-*.test.ts` (base, pacote e isolamento).
- **Depende de / paralela com**: W0. Paralela com W3: arquivos disjuntos, e W3 não altera `EvidenceToProve`. Se precisar
  alterar, as duas viram sequenciais. **Não** é paralela com R1 (ambas mexem em `preview.ts`).
- **Critérios de aceite**:
  - IA-09 e IA-10 cobertos por testes com o identificador no nome;
  - o teste de equivalência prova saída idêntica da prévia antes e depois da extração;
  - `typecheck` limpo;
  - motor intacto.
- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-seal-*.test.ts tests/link-audit-scoring-preview-*.test.ts && grep -lq "IA-09" tests/link-audit-seal-*.test.ts && grep -lq "IA-10" tests/link-audit-seal-*.test.ts && git diff --quiet v1.0.1 -- src/lib/link-audit/scoring, stop after 6 tries`

## Onda W2 — Exportação (entregável sozinha, D2)

- **Objetivo**: CLI `export` somente leitura que produz o pacote candidato com as verificações mecânicas da spec §5.3.
- **Escopo (slices/arquivos)**:
  - CLI novo em `scripts/` (sem escrita fora da pasta de saída), com `--collector-hash` e janela entre coleta e
    exportação;
  - testes `tests/link-audit-seal-export*.test.ts`.
- **Depende de / paralela com**: W1 (função e esquemas). Paralela com W3 e R1: arquivos disjuntos e só leitura do
  armazenamento.
- **Critérios de aceite**:
  - IA-02 (1–4), IA-05, IA-13, IA-14, IA-17, IA-19 e IA-20 cobertos por testes com o identificador no nome;
  - o CLI não abre rede nem escreve fora da saída (teste);
  - stdout e `--json` estáveis;
  - herdado da revisão da W1 (esquemas já exigem): datas do pacote normalizadas com `toISOString()` (o leitor aceita
    0 ou 6 casas fracionárias, o esquema exige exatamente 3 e `Z`); os 8 `checks` gravados também no pacote legado
    (mecânicos em `NOT_EXECUTED`); pacote `attestable` com `INTEGRITY_LOCAL` ou `COLLECTOR_HASH_MATCHES` em `FAIL` é
    recusado pelo `export` (o esquema sozinho não recusa).
- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-seal-export*.test.ts && for id in IA-02 IA-05 IA-13 IA-14 IA-17 IA-19 IA-20; do grep -lq "$id" tests/link-audit-seal-export*.test.ts || exit 1; done, stop after 8 tries`

## Onda W3 — Verificador `v2` (contrato próprio antes do código)

- **Objetivo**: o servidor aceita o manifesto `v2` de forma aditiva (o `v1` continua legível), com continuidade e
  anti-rebaixamento.
- **Escopo (slices/arquivos)**:
  - contrato `docs/phase6-auditoria-link/p1-contrato-verificador-v2.md` (proposto em 17/11/2026), aprovado antes do código;
  - `src/lib/link-audit-evidence/provenance.ts`, com acréscimos e sem mudar `EvidenceToProve`;
  - formato da lista de confiança com estado da chave (ativa, aposentada, revogada; D12), compatível com o atual, e o
    **fecho de aposentadoria** (`<sealsDir>/_closures/<id>.json`, assinado por uma chave ativa) como único caminho para uma
    chave aposentada continuar valendo no histórico;
  - rótulos e validadores da interface para os motivos novos (`labels.ts`, `validators.ts`) e a configuração de produção
    só com `v2` (`acceptedVersions: [2]`), conforme o contrato;
  - runbook de chaves (`onda6c-runbook-chaves.md` §4): de "remover a pública antiga" para marcá-la aposentada ou revogada;
  - vetor-ouro em arquivo de teste;
  - testes `tests/link-audit-evidence-provenance-v2*.test.ts`.
- **Depende de / paralela com**: W0 e a aprovação do contrato. Paralela com W1 e W2: `provenance.ts`, os rótulos e
  validadores dos motivos de prova e o contrato novo, que nenhuma das duas toca (a W1 usa o arquivo próprio
  `evidence-to-prove.ts`). **Não** é paralela com R1: as duas mexem em `audit-page/validators.ts`.
- **Critérios de aceite**:
  - IA-21, a parte do vetor-ouro de IA-03 e RS-20 cobertos por testes;
  - 1 byte alterado em `contentSha256`, `signature`, `seq`, `keyId`, `sealedAt`, `dossier` ou `prevSealSha256` dá
    `UNAUTHENTICATED`;
  - `tests/link-audit-evidence-provenance.test.ts` (os testes do `v1`) passa sem alteração.
- **Fatias (definidas em 19/11/2026 pelo manager, a partir do mapa V2-01…V2-48 contra o código; um PR por fatia, cada
  um com revisão independente e a suíte verde; os testes do `v1` em `tests/link-audit-evidence-provenance.test.ts`
  ficam sem diff em todas):**

  | Fatia | Entrega | Fecha (contrato §11) | Arquivos de teste |
  |---|---|---|---|
  | W3.1 | Esquema estrito e parser bruto do `v2`, canonicalização e hash do selo, montagem externa (bytes da K1), assinatura Ed25519 pura gerada fora do Node | V2-02, V2-14, V2-36, V2-37, V2-45 | `tests/link-audit-evidence-provenance-v2-schema.test.ts` |
  | W3.2 | Selo único: `classify` do `v2`, caminho compatível do `v1`, `acceptedVersions` (padrão de biblioteca `[1,2]`; produção `[2]` em `src/app/api/link-audit/scoring/shared.ts:92`, repassado por `evidenceProvenanceFromConfig`), metadados da cabeça, os seis motivos novos em `labels.ts`/`validators.ts`, vetores-ouro G1–G6 gerados por rota independente, teste estático do grafo de imports | V2-01, V2-03 a V2-07, V2-19, V2-34, V2-35, V2-38, V2-40, V2-41 | `…-v2-single.test.ts`, `…-v2-golden.test.ts` |
  | W3.3 | Cadeia: leitura, continuidade, cumulatividade, nomes, monotonia/anti-rebaixamento, cobertura, links/FIFO, caminho B | V2-08 a V2-18, V2-30, V2-33, V2-39, V2-48 | `…-v2-chain.test.ts` |
  | W3.4 | Lista de chaves com estado, fecho de aposentadoria fixado por hash | V2-20 a V2-26, V2-42, V2-47 | `…-v2-keyring.test.ts` |
  | W3.5 | Pré-passo de revogação e precedências, orçamento de leitura e erros, integração com a prévia (só repassa `reason`); runbook de chaves §4 reescrito (C3: o texto antigo sai, a nota datada vira o procedimento) | V2-27 a V2-29, V2-31, V2-32, V2-43, V2-44 | `…-v2-revocation.test.ts` |

  O V2-46 é critério de aceite da W4 (comando de fecho), fora da W3. A W3 termina quando as cinco fatias estiverem na
  `main` e o goal command abaixo passar.
- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-evidence-provenance*.test.ts && grep -lq "IA-21" tests/link-audit-evidence-provenance-v2*.test.ts && grep -lq "RS-20" tests/link-audit-evidence-provenance-v2*.test.ts && git diff --quiet origin/main -- tests/link-audit-evidence-provenance.test.ts, stop after 8 tries`

## Onda R1 — Confirmação de resultados pelo livro (ADR-0002)

- **Objetivo**: recibo de resultado sem `RUN_CONFIRMED` no livro vira fase C, que só o autor conclui; resultado sem
  `RUN_INTENT` falha fechado.
- **Escopo (slices/arquivos)**:
  - `src/lib/link-audit-ledger/` (tipos de registro `RUN_INTENT`/`RUN_CONFIRMED`/`RUN_ABORTED`, capacidade, receitas,
    cabeça das decisões separada da cabeça do livro);
  - `src/lib/link-audit-scoring-runs/{results,results-store,results-types,preview}.ts` (inclui as leituras condicionadas
    ao `RUN_CONFIRMED`);
  - `src/lib/link-audit-decisions/` (porta do livro e serviço) e a interface `audit-page/{types,validators}.ts`;
  - mensagens;
  - testes `tests/link-audit-results-ledger*.test.ts`;
  - resíduo da correção antecipada do RL-32 (19/11/2026): o replay/modelo passa a rejeitar um `CONFIRMED` (e um
    `RUN_CONFIRMED`) cujo `actor` não é o autor da operação, com teste de fecho autenticado de não autor;
  - a spec do livro já emendada (§16.17, W0).
- **Depende de / paralela com**: W0 (ADR aceito e §16.17 revisada de forma independente), W1 (ambas mexem em
  `preview.ts`) e W3 (ambas mexem em `audit-page/validators.ts`). Paralela com W2: arquivos disjuntos.
- **Critérios de aceite** (testes escritos antes do código, falhando no código de hoje):
  - recibo fabricado para a pendente legítima de outro operador não confirma o resultado;
  - outro operador recebe `RESULT_PENDING_UNCONFIRMED`, e o reenvio do autor conclui;
  - resultado sem `RUN_INTENT` dá integridade não resolvida;
  - `ledgerHead` e `INPUT_CHANGED` não mudam com a finalização;
  - 100% das mutações dos pontos novos mortas (equivalentes justificadas);
  - toda a suíte de livro e resultados verde.
- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-results-ledger*.test.ts tests/link-audit-ledger-*.test.ts tests/link-audit-scoring-results-*.test.ts && git diff --quiet v1.0.1 -- src/lib/link-audit/scoring, stop after 10 tries`

## Onda R2 — Proveniência registrada no resultado (portão antes do primeiro resultado de produção)

- **Objetivo**: cada resultado confirmado guarda qual cadeia de manifestos e quais chaves o atestaram. Assim a
  revogação de uma chave marca os resultados afetados para reconferência (D12, pergunta 12 do modelo de ameaças) mesmo
  que alguém suprima o sinal apagando ou corrompendo os manifestos.
- **Escopo (slices/arquivos)**:
  - `src/lib/link-audit-scoring-runs/{results,results-types}.ts`: o resultado grava o `{headSeq, headSealSha256, keyIds}`
    que o verificador `v2` devolve em `AUTHENTICATED` (contrato da W3, §7.3);
  - a releitura de um resultado confirmado cruza os `keyIds` gravados com as chaves revogadas e trata qualquer
    `UNAUTHENTICATED` como "a reconferir", sem invalidar o histórico em silêncio;
  - rótulos e validadores da interface para o estado "a reconferir";
  - testes `tests/link-audit-results-provenance*.test.ts`.
  - **a decidir no início da R2 (levantado em 19/11/2026):** o DTO da prévia (`preview.ts:149`, montado em `:395`) só
    expõe status, motivo e `missingRefs`; a finalização precisa consumir os metadados `{headSeq, headSealSha256, keyIds}`
    do `EvidenceTrust` internamente (preferível: não vazam para a interface) ou ampliar o DTO, com nova versão do contrato
    da API.
- **Depende de / paralela com**: W3 (o verificador devolve os campos) e R1 (as duas mexem nos resultados). Paralela com
  W4: arquivos disjuntos.
- **Critérios de aceite**:
  - um resultado confirmado com chave depois revogada aparece "a reconferir" mesmo com a pasta de manifestos apagada,
    corrompida ou com lacuna;
  - um resultado confirmado cuja releitura dá `UNAUTHENTICATED` aparece "a reconferir";
  - resultados antigos (sem os campos) continuam legíveis e são rotulados "proveniência não registrada";
  - motor intacto.
- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-results-provenance*.test.ts tests/link-audit-scoring-results-*.test.ts && git diff --quiet v1.0.1 -- src/lib/link-audit/scoring, stop after 8 tries`

## Onda W4 — Assinatura

- **Objetivo**: CLI `sign` que produz o manifesto `v2` cumulativo com todas as recusas da spec §5.5.
- **Escopo (slices/arquivos)**:
  - núcleo de recusas, primeiro com chave de teste em memória;
  - depois: entrada da chave (token K2 e/ou PKCS#8 cifrado K1, D5), confirmação humana, autoteste, recibo e artefato
    empacotado;
  - testes `tests/link-audit-seal-sign*.test.ts`.
- **Depende de / paralela com**: W1, W3 e as decisões §13.2 itens 1 (titular e suplente), 2 (dispositivo) e 4 (prazo de
  rotação e limite de chaves). Sequencial: é a única que toca a chave.
- **Critérios de aceite**:
  - IA-01, IA-03, IA-04, IA-06, IA-07, IA-08, IA-11, IA-12, IA-15, IA-16, IA-18, IA-22, IA-23 e IA-24 cobertos por
    testes com o identificador no nome;
  - a ida e volta (IA-03 iii) é `AUTHENTICATED` pelo verificador `v2` real;
  - a chave nunca aparece em argv, ambiente, log ou arquivo temporário (teste);
  - herdado da W1: o formato do `dossier.id` definido antes (o esquema aceita só letras, dígitos, espaço, `.`, `_` e `-`;
    alinhar com o ponto O7 do contrato do verificador `v2`) e a regra "resultado humano só para checks que o pacote
    marca `NOT_EXECUTED`" implementada no `sign`;
  - herdado da W3: o V2-46 do contrato do verificador `v2` (o comando de fecho lista as cadeias da aposentada presentes
    no servidor e ausentes do registro externo como `UNKNOWN_SEAL_ON_SERVER` e não as inclui no fecho); o autoteste do
    `sign` usa a lista completa com estado e os fechos, com `acceptedVersions: [2]` (C9).
- **Fatias (19/11/2026, manager, a partir do mapa da W4; decisões na spec §5.5.1; um PR por fatia, testes antes do código,
  revisão independente):**

  | Fatia | Entrega | Fecha | Risco |
  |---|---|---|---|
  | W4.1 | Núcleo puro do `sign`: recusas na ordem do §5.5 (passos 1–6, 8–10), `dossier.id` da aprovação no formato do contrato, resultado humano só para checks `NOT_EXECUTED` | IA-01, IA-11, IA-06 (parte), IA-17 herdado | baixo |
  | W4.2 | Cadeia e manifesto: próximo `seq`, `--expect-seq`/`--first`, `entries` exatas, `prevSealSha256`, montagem `v2`, ida e volta pelo verificador real com os vetores-ouro | IA-03 (fonte), IA-06, IA-07, IA-08 | médio |
  | W4.3 | Disco e concorrência: pacote lido uma vez, gravação temporário + `link()` exclusivo + `fsync`, corrida pelo mesmo `seq` | IA-12, IA-18 | médio |
  | W4.4 | CLI, papéis e K1: parser estrito, segredo fora de argv/ambiente, TTY sem eco, confirmação dos 12 caracteres, chave PKCS#8 cifrada, separação de papéis e recibo, `external:` recusado | IA-04, IA-14, IA-15, IA-16, IA-22, IA-23 | alto |
  | W4.5 | Comando de fecho `close-key` e autoteste com a lista completa e os fechos (`acceptedVersions: [2]`) | V2-46, C9 | **maior** |
  | W4.6 | Artefato único: núcleo do verificador separado do `FsOps` de disco, build com `esbuild`, lista literal de imports, execução sob `node --permission` no CI, hash versionado conferido pelo CI | IA-03 (artefato), IA-24 | alto |

- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-seal-sign*.test.ts tests/link-audit-evidence-provenance*.test.ts && for id in IA-01 IA-03 IA-04 IA-06 IA-07 IA-08 IA-11 IA-12 IA-15 IA-16 IA-18 IA-22 IA-23 IA-24; do grep -lq "$id" tests/link-audit-seal-sign*.test.ts || exit 1; done, stop after 10 tries`

## Onda W5 — Procedimento, dossiê e ensaio

- **Objetivo**: o fluxo humano escrito e ensaiado de ponta a ponta em homologação, com chave descartável, até um
  resultado finalizado.
- **Escopo (slices/arquivos)**:
  - runbook do custodiante e do conferente;
  - modelo de dossiê (partes A e B);
  - livro de manifestos e conferência periódica;
  - procedimento do suplente;
  - canal de entrega do manifesto pelo CI (decidido em princípio em 16/11/2026; detalhes aqui);
  - relatório do ensaio.
- **Depende de / paralela com**: W4, R1 e R2 (o ensaio finaliza um resultado, então precisa da confirmação autenticada e
  do registro da proveniência).
  Depende também da fase 2 do ADR 6C-03 (volume de manifestos).
- **Critérios de aceite**:
  - o relatório do ensaio mostra `export` → aprovação → `sign` → entrega → verificador `v2` `AUTHENTICATED` → resultado
    confirmado com `RUN_CONFIRMED`;
  - nada em produção;
  - a chave do ensaio é destruída e o fato fica registrado;
  - runbook avisa que reexportar muda o `packageSha256` (observedHours no hash); conferir e assinar sempre os mesmos bytes.
- **Goal command**: `/goal test -f docs/phase6-auditoria-link/p1-relatorio-ensaio.md && grep -q "AUTHENTICATED" docs/phase6-auditoria-link/p1-relatorio-ensaio.md && grep -q "RUN_CONFIRMED" docs/phase6-auditoria-link/p1-relatorio-ensaio.md, stop after 3 tries`

## Onda W6 — Coleta LIVE nova da TUVAPLAST (fora do código)

- **Objetivo**: substituir o legado NÃO ATESTÁVEL (D3) por uma coleta nova atestada.
- **Escopo**: operação; ~3 créditos Serper.
- **Depende de / paralela com**: W5 e **autorização escrita específica** do responsável. Nenhuma consulta paga sem ela
  (CLAUDE.md).
- **Critérios de aceite**:
  - autorização registrada;
  - hash `--json` da coleta registrado em canal separado;
  - manifesto `v2` `AUTHENTICATED` para a coleta.
- **Goal command**: não se aplica a goal loop (ação humana com custo). Conferência:
  `/goal grep -q "W6.*✅" docs/plan/implementation-waves.md, stop after 1 tries`.

## Notas de execução

- Ondas sequenciais rodam na sessão principal, uma branch e um PR por onda (Conventional Commits). Merge por
  `--merge` com o CI verde no próprio commit, como na rodada de 16/11/2026.
- Uma onda sequencial pode rodar como **goal loop**: invoque o Goal command dela e deixe o avaliador manter a sessão
  presa aos critérios de aceite. Feche a onda com a skill `verify` antes de marcá-la como ✅.
- Grupos paralelos ({W1, W3}, depois {W2, R1}) podem rodar como subagents em worktrees isolados em
  `~/projects/googlesaas-worktrees/`, um PR por vez no merge.
- Quando uma onda terminar, marque ✅ aqui **e** no `NOTES.md` e atualize o status atual do `NOTES.md` antes de
  encerrar a sessão.
