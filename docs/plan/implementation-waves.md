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
| R1 | ADR-0002: confirmação de resultados pelo livro de cabeças (fase C do resultado só pelo autor) | W0 (§16.17 revisada), W1, W3 | W2 | 🟡 R1.1 (#39), R1.2 (#41), R1.3 (#45), R1.4 (#46) e R1.5 mergeadas; R1.6 a seguir |
| R2 | Resultado confirmado registra a proveniência que o atestou (`headSeq`, `headSealSha256`, `keyIds`); `UNAUTHENTICATED` na releitura ⇒ revisão humana | W3, R1 | W4 | ⬜ |
| W4 | CLI `sign` (manifesto `v2`) | W1, W3, decisões §13.2 itens 1, 2 e 4 (tomadas: D10, D11, D12/D14) | — | 🟡 W4.1 (#38), W4.2 (#40), W4.3 (#42), W4.4 (#44) e W4.5 (#48) mergeadas; W4.6 em revisão |
| W5 | Procedimento, dossiê e ensaio ponta a ponta em homologação com chave descartável | W4, R1, R2 | — | ⬜ decisões tomadas (D15, spec §13.4) |
| W6 | Coleta LIVE nova da TUVAPLAST (fora do código) | W5 + autorização escrita específica (**dada em 20/11/2026, D16**) | — | ⬜ autorizada; roda depois do ensaio da W5 |

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
- **Fatias (19/11/2026, manager, a partir do mapa RL-01…RL-39; decisões na spec do livro §16.17.13; um PR por fatia,
  testes antes do código, revisão independente; escrita antes da leitura estrita, D-R1-5):**

  | Fatia | Entrega | Fecha | Risco |
  |---|---|---|---|
  | R1.1 | Esquema, replay e capacidade: registros `RUN_*` v2 (S-1…S-7), slot `openRun` e I-1…I-6 com o autor no fecho (D-R1-1, inclusive o `CONFIRMED` das decisões), `RUN_CLOSING_ALLOWANCE` e `runsAvailable`, `CHECKPOINT`/`RECEIPT_REISSUED` contando `openRun`, cópia congelada do leitor pré-R1 | RL-21, RL-22, RL-23, RL-30, RL-36; M-R39 | médio |
  | R1.2 | Vista e leitura em sanduíche: `decisionHead` separado do `head`, `runs` na vista, testemunhas antes das receitas, R2 condicional no `revalidate` e no serviço de decisões | RL-13, RL-14, RL-16, RL-17, RL-24, RL-34 | alto |
  | R1.3 | Finalização pelo livro, caminho feliz e fase A: porta de escrita (D-R1-3), guarda conferida antes do `RUN_INTENT`, resultado → recibo → `RUN_CONFIRMED`, prazo do dono, aborto da fase A vencida com releitura TOCTOU, concorrência entre processos, sync estrito; autorização de uso único emitida pelo `prepare()` e exigida por `reissue()`/`intent()`/`RUN_INTENT` (revisão da R1.2) | RL-04 (caminho feliz), RL-11, RL-15, RL-18, RL-19, RL-20, RL-25, RL-37 | alto |
  | R1.4 | Conclusão B/C só pelo autor, fechos intercalados da família `RUN_*`, portão do runbook da chave de origem (D-R1-6) | RL-01, RL-02, RL-04 (B/C), RL-05, RL-06, RL-07, RL-32 (`RUN_*`) | **muito alto** |
  | R1.5 | Leituras pelo livro: `list`/`get` conferem o hash do objeto devolvido contra o `runSha256`, razões novas, `RECEIPT_ONLY` no legado e sem livro, 503/409, DTOs e validadores da interface | RL-03, RL-08, RL-10, RL-12, RL-26, RL-27, RL-29, RL-31, RL-35, RL-38, RL-39 | **muito alto** |
  | R1.6 | Reemissão do recibo: `POST …/results {"action":"REISSUE_RECEIPT"}` com a resposta da D-R1-2, sync estrito do reenvio confirmado, botão no painel do livro | RL-09, RL-28, RL-33 | alto |

  Entre a R1.3 e a R1.4, uma queda em B/C deixa a operação de resultado aberta (bloqueia novas finalizações) até a
  R1.4 entrar. É aceitável porque o livro não está ligado em produção. R1 e W4 andam em paralelo: arquivos disjuntos.
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
  | W4.5 | Comando de fecho `close-key` (cabeças só dos recibos; cadeia de R sem recibo = `UNKNOWN_SEAL_ON_SERVER`, excluída; fecho assinado por S ativa, autotestado com R `retired:<closureSha256>` e gravado em `_closures/<R>.json` com criação exclusiva) e autoteste do passo 14 com a lista completa e os fechos (`acceptedVersions: [2]`), sobre a mesma fotografia da cadeia; decisões nas notas da W4.5 (spec §5.5.1) | V2-46, C9 | **maior** |
  | W4.6 | Artefato único: núcleo do verificador separado do `FsOps` de disco, build com `esbuild`, lista literal de imports, execução sob `node --permission` no CI, hash versionado conferido pelo CI. Critérios da confirmação da revisão da W4.5: execução por `env -i` com `node` por caminho absoluto e `--permission`; a barreira do runtime confere também `/proc/self/cmdline` e `/proc/self/environ` (preload que limpa `process.env`); `bothForms()` da custódia (`sign-key.ts`) trata EACCES/EIO do `realpath` como custódia não comprovada (mapa da W4.6). Entregue: `provenance-core.ts` + fachada `provenance.ts`; `fs-ops.ts`/`node-fs-ops.ts`; entrada `scripts/link-audit-sign-artifact.ts`; build `npm run link-audit:sign-artifact`; hash em `docs/phase6-auditoria-link/p1-sign-artifact.sha256`; job `sign-artifact`. Decisões do manager depois do CI: `fsync` obrigatório mantido; estação na linha 22 do Node (o Node ≥ 24.22 bloqueia fsync sob `--permission`); sondagem antecipada `SIGN_RUNTIME_NO_FSYNC`; upload do artefato no CI fixado por SHA. Revisão independente da W4.6: custódia e hash pelo descritor do artefato (`SIGN_ARTIFACT_UNSAFE`), guarda de imports da saída completa, grants limitados; pendência pré-existente `publishExclusive` (fsync da pasta ignorado) para o plano. Decisões, linha do runbook e o limite do `close-key` sob `--permission` (W5) nas notas da W4.6 (spec §5.5.1). | IA-03 (artefato), IA-24 | alto |

- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-seal-sign*.test.ts tests/link-audit-seal-close-key*.test.ts tests/link-audit-evidence-provenance*.test.ts && for id in IA-01 IA-03 IA-04 IA-06 IA-07 IA-08 IA-11 IA-12 IA-15 IA-16 IA-18 IA-22 IA-23 IA-24; do grep -lq "$id" tests/link-audit-seal-sign*.test.ts || exit 1; done, stop after 10 tries`

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
  - runbook avisa que reexportar muda o `packageSha256` (observedHours no hash); conferir e assinar sempre os mesmos bytes;
  - **chave e KDF (revisão da W4.4, 19/11/2026):** nenhuma chave real antes da W5. O runbook do custodiante fixa parâmetros
    fortes e verificáveis para cifrar a chave K1 (PKCS#8 PBES2: scrypt com custo definido, ou PBKDF2 com número alto de
    iterações) e frase de alta entropia, e diz como conferir os parâmetros do arquivo antes do uso. O `sign` só AVISA (saída
    de erro) abaixo dos mínimos provisórios do código (PBKDF2 600000 iterações; scrypt N = 2^17), que o runbook confirma ou
    substitui; o aviso não confere `r`, `p` nem o PRF, então o runbook confere o perfil completo.
  - **estação de assinatura (revisões da W4.4):** Linux (a custódia é provada pelo descritor via `/proc/self/fd`; em outro
    sistema o `sign` recusa); o arquivo de chave fica numa pasta 0700 cujas pastas ACIMA também não sejam graváveis por
    outros usuários (condição do resíduo declarado da corrida); ambiente sem variáveis com nome de segredo (`*TOKEN*`,
    `*SECRET*`, `*PASSWORD*`…), que o `sign` recusa; sem `NODE_OPTIONS` nem outra variável `NODE_*` (salvo `NODE_ENV`) e sem opções
    extras do node (revisão da W4.5, T-008: `sign` e `close-key` recusam); a pasta de recibos do `close-key` é do custodiante, sem escrita para
    grupo e outros, e as pastas acima dela pertencem ao custodiante ou ao root (o código confere o modo delas, não o dono).
  - **node da estação (decisão do manager na W4.6, 20/11/2026):** a linha **22** do Node, a mesma do CI e da produção, validada pelo job
    `sign-artifact` (assinatura completa sob `--permission`). O Node 24.22 em diante bloqueia `fsync` sob `--permission`, e o artefato recusa cedo
    (`SIGN_RUNTIME_NO_FSYNC`). O artefato roda pela linha fixada nas notas da W4.6 (spec §5.5.1): `env -i`, node por caminho absoluto,
    `--disable-sigusr1`, `--permission` e grants estreitos. Imediatamente antes de cada execução, a estação confere o SHA-256 do artefato com o
    versionado (`sha256sum -c`) e as pastas do caminho do artefato (`namei -m`: nenhuma com escrita para grupo/outros, salvo sticky); o artefato é
    0444, do custodiante ou do root (revisão independente da W4.6).
  - **`close-key` sob `--permission` (limite declarado na W4.6):** a conferência das pastas acima da pasta de recibos e da cópia do servidor exige
    grants largos (o Node concede a subárvore inteira de uma pasta); decidir entre a linha larga (`--allow-fs-read=/`, escrita só na cópia do
    servidor) e uma conferência que não dependa do `lstat` das pastas acima.
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
