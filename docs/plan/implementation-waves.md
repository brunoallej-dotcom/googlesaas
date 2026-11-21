# Implementation waves — Produtor P1 da Auditoria por Link (atestação offline da coleta) e portões de produção da Fase 6

> Spec de origem: `docs/specs/link-audit-p1-attestation.md` (§14 sugeria W0–W6; este arquivo os detalha e acrescenta
> a onda **R1**, do ADR-0002). Os testes seguem o padrão `tests/link-audit-seal-*.test.ts` da spec §5.2. Este arquivo é a fonte da verdade do roadmap de ondas; a tabela do `NOTES.md` espelha a
> coluna Status.
>
> **Contexto (16/11/2026):** a Onda 6C foi encerrada formalmente pelo responsável. A finalização continua falhando
> fechada (`NOT_FINALIZABLE`) até existir prova de coleta, e o P1 é o que a produz. Valem as decisões D1–D6 da spec
> (§13.1). Os bloqueadores de produção fora do P1 (guarda externa imutável, papel administrativo com dupla aprovação,
> volumes e chaves no `stack.yml`, D5) têm spec própria, `docs/specs/link-audit-production-gates.md` (20/11/2026), e
> ondas G0–G3 na seção [Portões de produção da Fase 6 (fora do P1)](#portões-de-produção-da-fase-6-fora-do-p1), antes
> das notas de execução. A tabela abaixo é só do P1.

| Onda | Entrega | Depende de | Paralela com | Status |
|------|---------|------------|--------------|--------|
| W0 | Fundação documental: spec e modelo de ameaças aprovados, contrato P1 ajustado, **ADR-0002 aceito** e emenda §16.17 da spec do livro | — | — | ✅ mergeada (PR #26; decisões D9–D13; §16.17 revisada) |
| W1 | Função única `basis → EvidenceToProve[]` + teste de equivalência; esquemas do pacote e da aprovação; `packageSha256` determinístico | W0 | W3 | ✅ mergeada (PR #24, `bd07e35`) |
| W2 | CLI `export` (somente leitura) | W1 | W3, R1 | ✅ mergeada (PR #29) |
| W3 | Verificador `v2` (aditivo em `provenance.ts`) + contrato próprio | W0 + contrato aprovado | W1, W2 | ✅ concluída em 19/11/2026 (W3.1–W3.5: PRs #30, #32, #33, #34, #35) |
| R1 | ADR-0002: confirmação de resultados pelo livro de cabeças (fase C do resultado só pelo autor) | W0 (§16.17 revisada), W1, W3 | W2 | ✅ R1.1–R1.6 mergeadas (#39, #41, #45, #46, #49 e o PR da R1.6); portão da R1 satisfeito no código, nada implantado |
| R2 | Resultado confirmado registra a proveniência que o atestou (`headSeq`, `headSealSha256`, `keyIds`); `UNAUTHENTICATED` na releitura ⇒ revisão humana | W3, R1 | W4 | 🟡 R2.1 (prova na avaliação, campo gravado e validado) neste PR; R2.2 (reconferência, porta, interface) a seguir |
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
    da API. **Decidido na R2.1 (20/11/2026): internamente** (nota 1 abaixo).
- **Depende de / paralela com**: W3 (o verificador devolve os campos) e R1 (as duas mexem nos resultados). Paralela com
  W4: arquivos disjuntos.
- **Critérios de aceite**:
  - um resultado confirmado com chave depois revogada aparece "a reconferir" mesmo com a pasta de manifestos apagada,
    corrompida ou com lacuna;
  - um resultado confirmado cuja releitura dá `UNAUTHENTICATED` aparece "a reconferir";
  - resultados antigos (sem os campos) continuam legíveis e são rotulados "proveniência não registrada";
  - motor intacto.
- **Fatias (20/11/2026, manager; um PR por fatia, testes antes do código):**

  | Fatia | Entrega | Risco |
  |---|---|---|
  | R2.1 | A prova autenticada vai da prévia até o resultado gravado: `Evaluation.provenance` interna; campo opcional `evidenceProvenance` nas versões 1 e 2 do resultado (sem v3); escrita nova exige o campo e recusa sem prova v2 completa; campo malformado = integridade; R1.6 e 11b preservam bytes e hash | médio |
  | R2.2 | Reconferência na releitura (revogação ∩ `keyIds` gravados; `UNAUTHENTICATED` ⇒ "a reconferir"), porta de proveniência injetada a partir de `shared.ts` (RL-29), estado calculado nos DTOs e rótulos da interface ("A reconferir", "Proveniência não registrada") | alto |

- **Notas da R2.1 (20/11/2026; decisões onde a spec era ambígua, sempre pelo lado que falha fechado):**
  1. **DTO da prévia (o ponto "a decidir").** A prova fica **interna**: `Evaluation.provenance` (`{headSeq, headSealSha256,
     keyIds}` ou `null`), que nunca sai por rota. O DTO público continua `{status, reason, missingRefs}`, sem nova versão do
     contrato da API nem dos validadores do cliente (a W3.2 já registrava que os metadados ficam no servidor). Motivo: a
     finalização roda no servidor e não precisa do DTO; ampliar a superfície pública não acrescenta garantia. A projeção
     pública dos resultados (`toPublicRun`, lista, detalhe, resposta da finalização) também não expõe o campo; o estado
     calculado e os rótulos são da R2.2, sem `keyIds` nem hashes.
  2. **Mais de uma cadeia.** O contrato (§3) e o código definem **uma** cadeia por auditoria (`<sealsDir>/<auditId>/`),
     classificada pelo `auditId` da rota (o alias do motor nunca localiza dados). O fecho de aposentadoria não é outra
     cadeia: o signatário entra em `keyIds`, como o verificador devolve. A prova gravada é a da leitura dupla que concordou
     (a impressão digital inclui a resposta CRUA do verificador). A releitura do passo 6 (`fingerprintNow`) reclassifica e é
     o **ponto de corte**: cadeia estendida, trocada ou com outras chaves entre a avaliação e essa releitura ⇒
     `INPUT_CHANGED`, nada gravado (teste com uma política que muda a prova só na releitura). Depois dela resta uma janela
     até a publicação: a barreira de durabilidade (aguardada depois da releitura quando o resultado cita o livro), o
     `RUN_INTENT` e o `link()`. O resultado grava a prova que era verdadeira no ponto de corte; uma mudança posterior
     (chave revogada, cadeia trocada) não é vista pela finalização e fica coberta pela reconferência na releitura da R2.2
     (revisão do PR #55). Não há união nem escolha entre cadeias.
  3. **Resposta do caminho v1 (modo `[1,2]` com `v1` por último).** Ela é só `{status: 'AUTHENTICATED'}`, sem cabeça: não há
     o que gravar. Para a prévia não dizer "finalizável" a algo que a finalização recusa, `AUTHENTICATED` sem a prova v2
     completa vira `SEAL_VERSION_NOT_ALLOWED` na projeção pública e no bloqueio `EVIDENCE_PROVENANCE_UNPROVEN` (código e
     rótulo já existentes: "este servidor só aceita manifestos no formato novo"). A impressão digital continua sobre a
     resposta crua. Produção usa `[2]` (contrato §4.2) e não muda.
  4. **Validação da prova na prévia (`headProofOf`).** Cópia estrita da resposta: cabeça inteira em 1..256, hash hex
     minúsculo de 64, `keyIds` de 1 a 16 ids distintos, em ordem estrita e no padrão da lista de chaves. Forma inesperada
     vinda da política ⇒ sem prova (falha fechada), nunca uma prova "consertada" (nada é reordenado nem deduplicado). O
     esquema do registro (`evidenceProvenanceSchema` em `results-types.ts`) aplica os mesmos limites; o padrão do id foi
     copiado para lá, para não abrir a lista fechada de imports, e um teste o confere contra `parseTrustKeyring`.
  5. **Escrita nova: três barreiras.** (a) O bloqueio da prévia. (b) O serviço (passo 3b): avaliação sem `provenance` ⇒
     `NOT_FINALIZABLE` com o mesmo bloqueio, mesmo que a prévia diga "finalizável"; `draftFrom` também devolve `null`. (c) O
     armazenamento: `appendRun` recusa rascunho sem o campo (`INTERNAL`), e o esquema estrito recusa o malformado antes de
     publicar. O tipo `ScoreRunDraft` exige o campo. O campo é coberto pelo selo (`contentSha256`), pela etiqueta de origem
     (HMAC sobre o corpo inteiro) e pelo `runSha256` do `RUN_INTENT`/`RUN_CONFIRMED`. O rascunho grava a prova da avaliação
     tal como veio (só os três campos).
  6. **Pendente legada (além da letra).** A conclusão de uma pendente SEM o campo é recusada: `NOT_FINALIZABLE` com o
     bloqueio `EVIDENCE_PROVENANCE_UNPROVEN`, motivo `PROVENANCE_NOT_RECORDED`, a pendente continua dita e nenhum recibo é
     gravado. É o mesmo tratamento da pendente anterior à prova de origem: concluí-la daria um resultado confirmado sem a
     proveniência que o atestou, contra o objetivo da R2. Custo declarado (revisão do PR #55): a recusa deixa o `RUN_INTENT`
     aberto, e o prazo do dono e o `RUN_ABORTED` só cobrem a fase A; em B ou C a auditoria fica com as novas finalizações
     recusadas (`RESULT_PENDING_UNCONFIRMED`) até a quarentena. Teste com o livro real nas fases B e C: nenhum recibo, livro
     sem registro novo, `RUN_INTENT` aberto, novas finalizações recusadas como hoje. **Decisão do manager:** o comportamento
     fica, porque nada foi implantado e a W5 e a produção começam com auditorias novas. Daí duas regras:
     - **condição de entrada da W5 e da produção:** só auditorias criadas depois da R2.1, e uma verificação antes de
       começar de que não há `RUN_INTENT` aberto cujo resultado pendente não tenha `evidenceProvenance` (o ensaio da W5
       registra a verificação no relatório);
     - **destino de uma pendente legada em desenvolvimento:** descartar os dados de desenvolvimento daquela auditoria
       (pastas de resultados, recibos e livro, só em desenvolvimento e com registro) ou, quando houver, a quarentena pelo
       caminho administrativo, que hoje responde 403 (spec dos portões de produção, G1.c). Em nenhum caso um resultado
       selado é alterado, re-selado ou "completado" com o campo.
  7. **Leitura.** Ausente = legado sem proveniência: legível, com os mesmos bytes e o mesmo hash (fixtures douradas v1 e
     v2 geradas pelo código da base `3899a67`, com SHA fixado em `tests/link-audit-results-provenance.test.ts`). Presente e
     malformado (inclusive `null`) ⇒ esquema ⇒ `RESULT_INTEGRITY` (409), nenhum dado; a testemunha dos resultados o trata
     como `UNTRUSTED`. A releitura não ganha semântica nova nesta fatia.
  8. **Formato.** Sem v3: a D-5 da spec do livro (§16.17.12) continua valendo; o campo é opcional nas versões 1 e 2. A
     reemissão do recibo (R1.6) e o reenvio confirmado (11b) não reescrevem o resultado, e os testes provam bytes e hash
     iguais com o campo. A referência `protocol-conformance-v2.json` não mudou.
  9. **Isolamento (RL-29).** As listas fechadas de imports não mudaram: `results.ts` passou a usar o valor `previewBlocker`
     de `./blockers` (já na lista; antes só o tipo) e `preview.ts` passou a importar `MAX_CHAIN_SEALS`, `MAX_TRUST_KEYS` e
     `EvidenceHeadProof` do mesmo `../link-audit-evidence/provenance`. `scoring-runs` continua sem importar o livro.
  10. **Testes ajustados.** Os helpers (a política "confia em tudo" e a avaliação fictícia) passam a trazer uma prova v2
     fictícia; em `link-audit-evidence-provenance.test.ts`, os seis cenários em que a coleta legítima precisa ser
     finalizável atestam com manifesto v2; o rascunho mínimo de `link-audit-scoring-results-store.test.ts` ganhou o campo.
     Novos: `tests/link-audit-results-provenance.test.ts` e `tests/link-audit-results-provenance-ledger.test.ts`.
  11. **Mutações:** manuais, cada uma desfeita (`git checkout`), rodando os dois arquivos novos: **22 rodadas, 22 mortas, nenhuma
     equivalente.** Omitir a prova numa escrita nova: no rascunho (M1a), no rascunho e na guarda do armazenamento juntos
     (M1b), só a guarda de `appendRun` (M1c), só o passo 3b do serviço (M1d), a prévia sem tratar o caminho v1 (M1e) e a
     conclusão aceitando pendente legada (M1f). Gravar cabeça ou chaves diferentes das devolvidas pelo v2: `headSeq + 1`
     (M2a), só a primeira chave (M2b, morta pela cadeia com fecho), outro hash (M2c) e a prévia "consertando" `keyIds`
     (reordenar e deduplicar, M2d). Aceitar campo malformado: `keyIds` fora de ordem (M3a), esquema não estrito (M3b),
     `null` (M3c), qualquer valor (M3d), cabeça 0 (M3e), `keyIds` vazios na prévia (M3f), hash malformado na prévia (M3g) e
     padrão de id mais largo que o da lista (M3h). Expor a proveniência: na prévia pública (M4a) e na projeção pública do
     resultado (M4b). Quebrar o hash dos antigos: campo obrigatório (M5a) e valor padrão preenchido na leitura do legado
     (M5b). Uma âncora (M3b) foi corrigida no roteiro antes da rodada válida. **Revisão do PR #55 (`junin-02`, aprovar com
     ajustes):** mais 3 mutações, 3 mortas: aceitar `.` no padrão de id do registro (M6a) e no da prévia (M6b), mortas pelo
     corpus determinístico de ids comparado com `parseTrustKeyring` (pontuação, maiúsculas, unicode, tamanhos de 1 a 34,
     hífen inicial e 600 casos gerados com semente fixa); e tirar a resposta do verificador da impressão digital (M7), morta
     pelo teste da prova que muda na releitura do passo 6. A M1f (conclusão aceitando a pendente legada) foi rodada de novo
     e também morre nos testes novos das fases B e C com o livro. Total: 25 rodadas, 25 mortas.
  12. **Fica para a R2.2:** a reconferência na releitura (ids revogados de hoje ∩ `keyIds` gravados; `classify` sobre o
     `evidenceBasis` gravado; `UNAUTHENTICATED` ⇒ "a reconferir"), a porta injetada, o estado nos DTOs e na interface e o
     rótulo do legado. Também fica para lá decidir se a conclusão de uma pendente deve exigir que a cabeça gravada continue
     na cadeia de hoje; nesta fatia ela exige só a prova v2 atual, além das conferências que já existiam.
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
  `/goal grep -qE "^\| W6 \|.*✅" docs/plan/implementation-waves.md, stop after 1 tries` (ancorado na linha da tabela: o padrão antigo casava com o próprio texto do comando e saía sempre verdadeiro).

## Portões de produção da Fase 6 (fora do P1)

> Spec de origem: `docs/specs/link-audit-production-gates.md` (PROPOSTA de 20/11/2026). Ela cobre a guarda externa
> (§5.1), o papel administrativo (§5.2), os volumes e as chaves do `stack.yml` (§5.3) e a consequência da D5 (§5.4), e
> consolida o portão de produção (§10.1) e o piloto mínimo (§10.2). Os critérios PG-xx são os da spec §6. Valem as
> **regras de todas as ondas** acima. Por cima delas:
>
> - **nenhuma onda G faz deploy**, aplica migração no Supabase, cria secret real ou contrata serviço: são ações do
>   responsável (spec §10.1);
> - a migração da guarda (se a Q1 for a opção 1) fica em `supabase/proposed/` até o responsável aplicar;
> - testes do provedor da guarda usam um provedor simulado, sem rede.

| Onda | Entrega | Depende de | Paralela com | Status |
|------|---------|------------|--------------|--------|
| G0 | Decisões Q1–Q12 da spec; ADR-0003 (provedor da guarda); modelo de ameaças da guarda e do caminho administrativo; números do contrato da guarda (`L_max`, `T`, prazo de resposta) | spec | todas as ondas do P1 | ⬜ |
| G1.a | Volumes, segredos e chave de log: `stack.yml`, lista do entrypoint, `stop-first`, plano de backup e `operatorRef` com `GMN_LINK_AUDIT_LOG_KEY` | G0 (Q8, Q9 e o nome do secret da guarda) | G1.b, G1.c, R2, W4.6 | ⬜ |
| G1.b | Guarda: adaptador real, contrato R6-10, ligação nas rotas, migração proposta, reconciliação externa e runbook | G0 (Q1–Q5); R1.6 na `main` | G1.a; G1.c só se Q6 = 3 | ⬜ |
| G1.c | Papel administrativo (só se Q6 = 1 ou 2; com Q6 = 3, só o aceite formal) | G0 (Q6, Q7) e emenda da §16.8 da spec do livro; **se Q6 = 1 ou 2, também a G1.b na `main`** (as duas mexem no livro) | G1.a; G1.b só se Q6 = 3 (sem código) | ⬜ |
| G2 | Integração e ensaio em homologação: os 16 ensaios e as 2 atestações da spec §10.4 | G1.a, G1.b, G1.c (ou o aceite), o ambiente de homologação (Q12) e o **relatório da W5 aprovado** | nenhuma (com a W5, só em ambiente totalmente isolado, spec §10.4) | ⬜ |
| G3 | Portão de produção (spec §10.1) ou piloto mínimo declarado (spec §10.2) | G2, os portões do P1 (R1, R2, W4.6, W5, W6) e as decisões e ações do responsável | — | ⬜ |

Ordem prática, conforme a Q6:

- **Q6 = 3** (manter o 403): G0 → {G1.a ∥ G1.b ∥ G1.c (só o aceite)} → [relatório da W5 aprovado] → G2 → G3.
- **Q6 = 1 ou 2** (com código): G0 → {G1.a ∥ (G1.b → G1.c)} → [relatório da W5 aprovado] → G2 → G3.

Motivos:

- **G1.b espera a R1.6** porque as duas mexem em `src/lib/link-audit-ledger/service.ts`.
- **G1.c vem depois da G1.b** quando tem código: as duas mexem no livro (a G1.c grava registros `*_ACK`). Com Q6 = 3
  não há código, e o aceite corre junto.
- **G2 depois da W5:** a G2 faz rollback, restaurações e derruba o provedor; a W5 grava e finaliza um resultado de
  ensaio. Na mesma pilha, uma corromperia a outra (spec §10.4). Em paralelo, só com pilhas, volumes, guarda e
  credenciais totalmente separados.
- **G1.a e W5:** a G1.a é dona do `stack.yml`, incluindo o volume de manifestos (fase 2 do ADR 6C-03), que a W5 usa.
  Isso evita duas ondas editando o mesmo arquivo.

### Onda G0 — Decisões e contratos (sequencial, sem código)

- **Objetivo**: deixar decididas as questões da spec §11 e escritos os contratos que as ondas de código vão seguir.
- **Escopo (slices/arquivos)**:
  - `docs/specs/link-audit-production-gates.md`: §11 com as respostas do responsável e o status "APROVADA na onda G0";
  - `docs/adr/0003-<provedor-da-guarda>.md` (novo) e `docs/adr/README.md`;
  - `docs/security/threats/link-audit-portoes-producao.md` (novo, STRIDE), mais a linha no `INDEX.md`;
  - números do contrato da guarda: `L_max` (contagem do protocolo), `T` e prazo de resposta;
  - se a Q6 for 1 ou 2: proposta de emenda à §16.8 da spec do livro, com revisão independente antes do código.
- **Depende de / paralela com**: só da spec. Paralela com todo o P1 (só documentação).
- **Critérios de aceite**:
  - as 12 questões têm resposta registrada, com data e quem decidiu;
  - o ADR-0003 aparece em `docs/adr/README.md`;
  - o modelo de ameaças novo lista as ameaças da spec §8 com status.
  - As decisões são do responsável: o goal loop só confere que estão escritas.
- **Goal command**: `/goal grep -q "APROVADA na onda G0" docs/specs/link-audit-production-gates.md && ls docs/adr/0003-*.md >/dev/null && grep -q "0003" docs/adr/README.md && test -f docs/security/threats/link-audit-portoes-producao.md, stop after 3 tries`

### Onda G1.a — Volumes, segredos e chave de log

- **Objetivo**: o `stack.yml` e o entrypoint entregam ao serviço web tudo o que o código da Fase 6 lê, sem valor real, e
  a chave de log passa a ser usada.
- **Escopo (slices/arquivos)**:
  - `deploy/hostinger/stack.yml`: as seis pastas que faltam (manifestos só leitura), os secrets novos por `*_FILE`, as
    variáveis comuns, `stop-first` no web e nada novo no Worker (spec §5.3.3, VC-E1–E4);
  - `deploy/hostinger/docker-entrypoint.sh`: os nomes novos na lista fixa;
  - `deploy/hostinger/Dockerfile`: alvos de montagem, se a G1 confirmar que precisam existir na imagem;
  - `tests/deploy-config.test.ts`, estendido (VC-E5);
  - `deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md` e `PROVA-DE-ORIGEM-E-DE-COLETA.md`, mais o checklist de
    produção (VC-E6, VC-E7);
  - `deploy/hostinger/GUIA-DE-IMPLANTACAO.md`: procedimento das pastas no host (VC-E8);
  - a fatia 1 da spec de observabilidade, no mínimo `operatorRef` com `GMN_LINK_AUDIT_LOG_KEY` (spec §5.3.4), em
    `src/lib/link-audit-observability/` (nome da spec de observabilidade), com testes `tests/link-audit-observability*.test.ts`.
- **Depende de / paralela com**: G0 (destino dos logs e dos backups, nome do secret da guarda). Paralela com G1.b e G1.c
  (arquivos disjuntos) e com R2 e W4.6.
- **Critérios de aceite**:
  - PG-V01 e PG-L01 cobertos por testes com o identificador no nome;
  - **PG-V02 (VC-E6):** o plano de backup cita as seis variáveis de pasta da Fase 6 com destinos independentes (em
    marcador) para os recibos e para o livro;
  - **PG-V03 (VC-E7):** `PROVA-DE-ORIGEM-E-DE-COLETA.md` cita a chave do livro, a chave de log e a credencial da
    guarda, e a ordem de ativação;
  - **PG-V04 (VC-E8):** `deploy/hostinger/GUIA-DE-IMPLANTACAO.md` traz o procedimento de criação e conferência das
    pastas no host (dono `10001:10001`, modo `0700`, `stat`). A execução fica registrada no EN-12 da G2 e na linha G-3
    do portão;
  - **atestações item a item** em `docs/phase6-auditoria-link/producao-g1a-atestacoes.md`, uma linha por item no formato `| AT-G1A-xx | SIM | arquivo:linha |`,
    apontando onde cada item está cumprido:
    - **AT-G1A-01** destinos de backup independentes (marcadores distintos) para os dois volumes de recibos e para o
      livro, fora do disco dos dados que eles ancoram (VC-E6);
    - **AT-G1A-02** nenhum comando de backup ou de restauração com `--delete` nem sobrescrita (VC-E6);
    - **AT-G1A-03** pares do mesmo instante, `sha256sum` por arquivo e as cabeças guardadas junto do backup (VC-E6,
      GE-R9);
    - **AT-G1A-04** procedimento das pastas no host: dono `10001:10001`, modo `0700`, conferência por `stat` (VC-E8);
    - **AT-G1A-05** chave do livro, chave de log e credencial da guarda documentadas como Swarm secrets, com nome em
      marcador, e na lista do entrypoint (VC-E2, VC-E7);
    - **AT-G1A-06** ordem de ativação: volumes e chaves ⇒ guarda ⇒ primeiro `ENROLL` (VC-E7);
    - **AT-G1A-07** nenhum valor real, host ou caminho de produção nos arquivos alterados (VC-E1);
  - nenhum valor literal, host ou caminho real nos arquivos de implantação: só marcadores;
  - o Worker continua sem nenhuma variável `GMN_LINK_AUDIT_*`;
  - `src/lib/logger.ts` e `src/lib/redact.ts` sem diff (spec de observabilidade, "O que NÃO muda").
- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/deploy-config.test.ts tests/link-audit-observability*.test.ts && grep -q "PG-V01" tests/deploy-config.test.ts && grep -lq "PG-L01" tests/link-audit-observability*.test.ts && for v in GMN_LINK_AUDIT_DECISIONS_DIR GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR GMN_LINK_AUDIT_RESULTS_DIR GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR; do grep -q "$v" deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md || exit 1; done && grep -q "GMN_LINK_AUDIT_LEDGER_KEY" deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md && grep -q "GMN_LINK_AUDIT_LOG_KEY" deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md && grep -q "10001:10001" deploy/hostinger/GUIA-DE-IMPLANTACAO.md && grep -q "0700" deploy/hostinger/GUIA-DE-IMPLANTACAO.md && grep -q "stat -c" deploy/hostinger/GUIA-DE-IMPLANTACAO.md && for n in 01 02 03 04 05 06 07; do grep -qE "^\| AT-G1A-$n \| SIM \|[^|]*[A-Za-z0-9_./-]+:[0-9]+[^|]*\|" docs/phase6-auditoria-link/producao-g1a-atestacoes.md || exit 1; done && git diff --quiet origin/main -- src/lib/logger.ts src/lib/redact.ts, stop after 6 tries` (cada atestação precisa de `SIM` e de um `arquivo:linha`)

### Onda G1.b — Guarda externa

- **Objetivo**: a guarda real fica atrás de `ExternalGuardPort`, com o contrato R6-10 fechado, ligada nas rotas e
  conferível de fora da VPS.
- **Escopo (slices/arquivos)**:
  - `src/lib/link-audit-ledger/`: adaptador do provedor (GE-E1), leitura da credencial no módulo do livro, as regras 1 a
    5 da spec §5.1.4 em `model.ts` e `service.ts` (razões `GUARD_HEAD_MISSING` e `GUARD_LAGGING`, sucesso com `BEHIND`
    depois do fecho) e eventos de alarme (GE-E6);
  - `src/app/api/link-audit/decisions/ledger-wiring.ts`: a guarda passa a `createLedgerService` (GE-E2);
  - rótulos e validadores da interface para as razões novas;
  - se a Q1 for a opção 1: `supabase/proposed/<NNN>_link_audit_guard.sql` e o rollback, com a conferência de privilégios
    no próprio SQL (GE-E4, PG-G08);
  - `scripts/link-audit-guard-reconcile.ts` (GE-E5) e o runbook da guarda em `docs/phase6-auditoria-link/` (GE-E7);
  - testes `tests/link-audit-guard-*.test.ts`. O `tests/link-audit-ledger-guard.test.ts` atual continua travando o
    limite **sem** guarda.
- **Depende de / paralela com**: G0 (Q1–Q5 e os números do contrato) e a R1.6 na `main` (mesmo `service.ts`). Paralela
  com G1.a.
- **Critérios de aceite**:
  - PG-G01 a PG-G07 e PG-G09 cobertos por testes com o identificador no nome, todos sem rede (provedor simulado);
  - PG-G03 com **nove** testes, um por ponto S1–S9 da spec §5.1.2 (`CHECKPOINT` e `RECEIPT_REISSUED` incluídos);
  - PG-G05 com a regra do trio idempotente, `CONFLICT` e `STALE` (spec §5.1.4, regra 7);
  - o critério do provedor escolhido, com evidência anexada ao PR: **PG-G08** (opção 1, laboratório Supabase descartável,
    incluindo a prova de que a tabela não responde pela Data API com `anon`, `authenticated` e `service_role`),
    **PG-G10** (opção 2) ou **PG-G11** (opção 3). Nada disso roda em produção pela onda;
  - 100 % das mutações dos pontos novos do modelo mortas (equivalentes justificadas);
  - toda a suíte do livro e dos resultados verde;
  - motor intacto.
- **Fatias (sugestão; o manager confirma no início da onda)**: G1.b.1 contrato R6-10 no modelo e no serviço, com o
  adaptador sintético; G1.b.2 adaptador real e ligação; G1.b.3 migração proposta e reconciliação.
- **Goal command**: `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-guard-*.test.ts tests/link-audit-ledger-*.test.ts tests/link-audit-results-ledger*.test.ts && for id in PG-G01 PG-G02 PG-G04 PG-G05 PG-G06 PG-G07 PG-G09; do grep -lq "$id" tests/link-audit-guard-*.test.ts || exit 1; done && for s in S1 S2 S3 S4 S5 S6 S7 S8 S9; do grep -lqE "PG-G03.*\b$s\b" tests/link-audit-guard-*.test.ts || exit 1; done && git diff --quiet v1.0.1 -- src/lib/link-audit/scoring, stop after 10 tries`

### Onda G1.c — Papel administrativo (condicional à Q6)

- **Objetivo**: conforme a Q6. Com a opção 1 ou 2, `ADOPT`, `RESTORE_ACK` e `QUARANTINE_ACK` passam a ser aceitos só sob
  a regra decidida. Com a opção 3, as ações continuam em 403, com o aceite formal registrado.
- **Escopo (slices/arquivos)** (só para a opção 1 ou 2):
  - emenda à §16.8 da spec do livro, revisada de forma independente antes do código;
  - `src/lib/link-audit-decisions/service.ts` (`ledgerAction`) e um módulo novo de identidade e aprovação;
  - registros novos do livro (`src/lib/link-audit-ledger/`), área de custódia e interface;
  - testes `tests/link-audit-ledger-admin*.test.ts`. O `tests/link-audit-ledger-q5.test.ts` é reescrito só onde a
    emenda mudar a regra.
- **Depende de / paralela com**: G0 (Q6, Q7) e, com código (Q6 = 1 ou 2), a G1.b na `main`, porque as duas mexem no
  livro. Paralela com G1.a. Com Q6 = 3 não há código e o aceite corre junto com a G1.b.
- **Critérios de aceite**:
  - PG-A01 a PG-A03 (e PG-A04, se a Q6 for 2) cobertos por testes com o identificador no nome;
  - uma identidade só nunca conclui uma ação;
  - nada é apagado: o que for afastado vai para a custódia com o hash citado.
- **Goal command** (só para a opção 1 ou 2): `/goal scripts/run-isolated.sh npm run typecheck && scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/link-audit-ledger-admin*.test.ts tests/link-audit-ledger-*.test.ts && for id in PG-A01 PG-A02 PG-A03; do grep -lq "$id" tests/link-audit-ledger-admin*.test.ts || exit 1; done, stop after 10 tries`. **Com a opção 2**, o mesmo comando com `PG-A04` acrescentado ao laço (`for id in PG-A01 PG-A02 PG-A03 PG-A04`). Com a opção 3 não há goal loop: a conferência é o aceite registrado na spec §11.

### Onda G2 — Integração e ensaio de rollback e restauração (homologação)

- **Objetivo**: provar, num ambiente isolado e sem dados reais, que a guarda detecta o rollback coordenado, que a
  restauração dos pares do mesmo instante funciona e que as falhas do provedor fecham.
- **Escopo**:
  - pilha de homologação (Q12) com as pastas, as chaves descartáveis e a guarda num projeto ou esquema de laboratório;
  - auditorias **novas**, inscritas depois de ligar a guarda; as da W5 não são reaproveitadas (spec §5.1.4, regra 1);
  - o roteiro da spec §10.4 (16 ensaios: EN-01, EN-02a a EN-02e, EN-03 a EN-12): rollback coordenado, restaurações, rollback de imagem, queda do provedor,
    falha de publicação depois do fecho, sequência falsa, reconciliação, `ANCHOR_PENDING`, `ENOSPC`, ações
    administrativas e pastas no host;
  - relatório `docs/phase6-auditoria-link/producao-relatorio-ensaio-g2.md`, com uma linha por ensaio no formato
    `| EN-xx | PASSOU ou FALHOU | resultado observado | evidência |` e uma linha por atestação no formato
    `| AT-G2-xx | SIM | evidência |` (AT-G2-01 nada em produção; AT-G2-02 chaves e credenciais do ensaio destruídas ou
    revogadas, com data).
- **Depende de / paralela com**: G1.a, G1.b, G1.c (ou o aceite da opção 3), o ambiente de homologação autorizado pelo
  responsável e o **relatório da W5 aprovado** (a W5 fecha antes: chave do ensaio destruída, relatório arquivado). Usa
  o mesmo ambiente da W5 só depois disso. Em paralelo com a W5, só em ambiente totalmente isolado (pilha, volumes,
  guarda e credenciais separados), com o isolamento registrado nos dois relatórios.
- **Critérios de aceite**:
  - as 16 linhas de ensaio em `PASSOU`, cada uma com o resultado observado e a evidência não vazios (vista do livro,
    código da resposta, saída da reconciliação, do `stat` ou do `docker service inspect`), e nenhuma em `FALHOU`;
  - **AT-G2-01** (nada em produção) e **AT-G2-02** (chaves e credenciais do ensaio destruídas ou revogadas, com data)
    em `SIM`, com evidência.
- **Goal command**: `/goal test -f docs/phase6-auditoria-link/producao-relatorio-ensaio-g2.md && for n in 01 02a 02b 02c 02d 02e 03 04 05 06 07 08 09 10 11 12; do grep -qE "^\| EN-$n \| PASSOU \| *[^| ][^|]*\| *[^| ][^|]*\|" docs/phase6-auditoria-link/producao-relatorio-ensaio-g2.md || exit 1; done && ! grep -qE "^\| EN-[0-9]+[a-e]? \| FALHOU" docs/phase6-auditoria-link/producao-relatorio-ensaio-g2.md && for n in 01 02; do grep -qE "^\| AT-G2-$n \| SIM \| *[^| ][^|]*\|" docs/phase6-auditoria-link/producao-relatorio-ensaio-g2.md || exit 1; done, stop after 3 tries` (cada ensaio em `PASSOU` com resultado e evidência que não sejam vazios nem só espaços; nenhum em `FALHOU`; as duas atestações em `SIM` com evidência)

### Onda G3 — Portão de produção (fora do código)

- **Objetivo**: conferir, linha por linha, a tabela do portão (spec §10.1) antes do primeiro resultado de produção. Ou,
  por decisão do responsável, abrir o piloto mínimo declarado (spec §10.2).
- **Escopo**:
  - atualizar a tabela da spec §10.1 com o estado e a evidência de cada uma das 15 linhas (P-1 a P-9, G-1 a G-6);
  - no piloto, registrar o aceite formal com escopo, prazo e as condições 1 a 6 da §10.2;
  - deploy pelo CI, por decisão do responsável;
  - verificação pós-deploy;
  - primeiro teste de escrita só numa auditoria sintética combinada.
- **Depende de / paralela com**: G2, os portões do P1 (R1, R2, W4.6, W5, W6) e as ações do responsável (secrets,
  migração, pastas no host, cerimônia da chave, consulta paga, autorização escrita da implantação).
- **Critérios de aceite**:
  - todas as linhas da §10.1 atendidas, ou o piloto com aceite escrito;
  - autorização escrita do responsável para a implantação registrada.
- **Goal command**: não se aplica a goal loop (decisão e ação humanas). Conferência:
  `/goal grep -q "^| G3 |.*✅" docs/plan/implementation-waves.md, stop after 1 tries` (ancorado na linha da tabela, para o comando não casar com o próprio texto).

## Notas de execução

- Ondas sequenciais rodam na sessão principal, uma branch e um PR por onda (Conventional Commits). Merge por
  `--merge` com o CI verde no próprio commit, como na rodada de 16/11/2026.
- Uma onda sequencial pode rodar como **goal loop**: invoque o Goal command dela e deixe o avaliador manter a sessão
  presa aos critérios de aceite. Feche a onda com a skill `verify` antes de marcá-la como ✅.
- Grupos paralelos ({W1, W3}, depois {W2, R1}; nos portões, {G1.a, G1.b, G1.c}) podem rodar como subagents em worktrees
  isolados em `~/projects/googlesaas-worktrees/`, um PR por vez no merge.
- Quando uma onda terminar, marque ✅ aqui **e** no `NOTES.md` e atualize o status atual do `NOTES.md` antes de
  encerrar a sessão.
