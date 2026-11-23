# P1 — Modelo do relatório do ensaio da W5 (homologação, chave descartável)

> **Este arquivo é o MODELO e o roteiro**, escrito na fatia **W5.1** (22/11/2026). O relatório de verdade,
> `p1-relatorio-ensaio.md`, só é criado **depois** do ensaio real (fatia W5.3), copiando este modelo e preenchendo cada campo
> com a evidência observada. Ele é o goal da onda W5 (`docs/plan/implementation-waves.md`). Nenhum campo deste modelo vale como
> evidência.
>
> **Regras do ensaio:** só na pilha de homologação isolada (D-G0-12), sem dados reais, sem Serper e sem consulta paga; **nada em
> produção**; chave **descartável** (D15.7); W5 antes da G2, nunca as duas ao mesmo tempo na mesma pilha. Repositório público:
> no relatório, só rótulos, hashes e códigos; nada de host, IP, caminho real, nome de pessoa nem material de chave.
>
> **A captura do ensaio é SIMULADA, e isso é o esperado** (W5.2b, spec do P1 §5.7 e D15.8): o S-02 usa o modo SIMULATED do coletor,
> com dados sintéticos fixos ("Empresa de Ensaio"), e a captura e o relatório levam a marca persistente `provider: "SIMULATED"` /
> `simulated: true`, dentro do hash. A interface a mostra como "SIMULADA — ensaio" e a prévia traz o aviso `SIMULATED_EVIDENCE`. A
> trava `GMN_LINK_AUDIT_HOMOLOGATION=1` existe só no comando de coleta, no `export` e no web da pilha de homologação; **nunca em
> produção**, onde a captura simulada é recusada pelo `export` e não é finalizável.

## 0. Identificação

| Campo | Valor |
|---|---|
| Data(s) do ensaio | `<DATA>` |
| Quem conduziu (rótulos) | `<CUST-01 / CONF-01>` |
| Commit da `main` usado | `<COMMIT>` |
| Hash do artefato (`p1-sign-artifact.sha256`) | `<ARTIFACT_SHA256>` |
| Node da estação (`<NODE22> --version`) | `<v22.x.y>` |
| Pilha de homologação (rótulo; criada pelo responsável, D-G0-12) | `<PILHA_HOMOLOGACAO>` |
| Auditoria do ensaio | `<AUDITORIA_DO_ENSAIO>` |
| `keyId` descartável (começa por `ensaio-`, prefixo reservado) | `<KEY_ID_ENSAIO>` |

## 1. Pré-condições

| # | Pré-condição | Situação | Evidência |
|---|---|---|---|
| PC-1 | Pilha de homologação isolada pronta, sem dados reais nem Serper, com as pastas da Fase 6 e o volume de manifestos `:ro` no web | `<SIM/NÃO>` | `<…>` |
| PC-2 | Fatias W5.2a (D15.6(d) e, para o S-16, o `close-key` sob `--permission` com a linha larga) e W5.2b (coleta SIMULADA, spec §5.7) na `main`. O canal de entrega pelo CI **não** é pré-condição: o ensaio usa entrega manual (§5, desvio D-01) | `<SIM/NÃO>` | `<PR>` |
| PC-3 | Estação conforme o runbook do custodiante §1 (E1–E8), sem rede durante a assinatura | `<SIM/NÃO>` | linha da sessão no livro |
| PC-4 | Nenhum ensaio da G2 rodando na mesma pilha | `<SIM/NÃO>` | `<…>` |
| PC-5 | O web da pilha de homologação roda com `GMN_LINK_AUDIT_HOMOLOGATION=1` (exatamente `1`), exigido pelo S-12 e pelo S-13: sem a trava, a lista de chaves com a chave `ensaio-…` é recusada inteira e a evidência simulada bloqueia a finalização; **nunca em produção** (a `stack.yml` de produção não declara a variável, e isso é testado) | `<SIM/NÃO>` | `<rótulo da configuração da pilha>` |

## 2. Verificação de entrada (nota 6 da R2.1, `docs/plan/implementation-waves.md`)

Antes do primeiro passo, e registrada aqui:

1. **Só auditorias criadas depois da R2.1** (PR #55, commit `8fa6e49` na `main`) existem na pilha. Listar as auditorias e a data
   de criação de cada uma.
2. **Nenhum `RUN_INTENT` aberto com resultado pendente sem `evidenceProvenance`.** Para cada auditoria da pilha:
   - ler a vista do livro com a sessão de um operador: `GET /api/link-audit/decisions/{auditId}`, campo `ledger.runs.open`
     (`null` = nenhuma operação de resultado aberta; senão `phase`, `runSeq`, `originKid`);
   - fase `A`: nada publicado ainda; anotar (o prazo do dono a aborta);
   - fase `B` ou `C`: abrir **só para leitura** `<GMN_LINK_AUDIT_RESULTS_DIR>/<auditId>/s<runSeq com 4 dígitos>.json` e conferir
     que o campo `evidenceProvenance` existe. Ausente ⇒ **parar**: é pendente legada. Destino pela nota 6: descartar os dados
     daquela auditoria na homologação (pastas de resultados, recibos e livro), com registro, ou a quarentena administrativa
     quando existir (hoje 403). Nunca alterar, re-selar nem "completar" um resultado selado.

| auditId | criada em | depois da R2.1? | `ledger.runs.open` | fase | `evidenceProvenance` no pendente | resultado |
|---|---|---|---|---|---|---|
| `<AUDITORIA_DO_ENSAIO>` | `<DATA>` | `<SIM>` | `<null>` | — | — | `<OK>` |

## 3. Roteiro e evidências

Cada passo: o comando ou a ação (só com marcadores), o resultado observado e a evidência (código de saída, código da resposta,
hash, campo da vista). Um passo que falha para o ensaio; a falha e a correção ficam registradas.

| # | Passo | Comando / ação (referência) | Esperado | Observado | Evidência |
|---|---|---|---|---|---|
| S-01 | Auditoria nova na pilha, inscrita no livro (`ENROLL`) | interface ou `POST …/decisions/{auditId}/ledger` | inscrita, vazia | `<…>` | `<…>` |
| S-02 | Coleta SIMULADA, sem Serper e sem rede, com hash `--json` registrado em canal separado | `GMN_LINK_AUDIT_HOMOLOGATION=1 npm run link-audit:collect -- --simulated --audit <AUDITORIA_DO_ENSAIO> --operator <E-MAIL_DO_OPERADOR> --evidence-dir <PASTA_DE_EVIDENCIAS_DA_PILHA_NO_HOST> --json` (spec §5.7; sem `--link`, `--name`, `--city` nem `--uf`: a empresa é a sintética fixa) | saída 0; `--json` = UM objeto com `source.provider: "SIMULATED"` e `source.simulated: true`; `c0001.capture.json` (com `simulated: true`) e `c0001.report-r0001.json` no layout versionado; `source.capture.sha256` anotado em canal separado. Sem a trava, o mesmo comando sai 3 e não grava nada | `<…>` | `<HASH_DO_COLETOR>` |
| S-03 | Export da captura SIMULADA | `GMN_LINK_AUDIT_HOMOLOGATION=1 npm run link-audit:seal -- export --evidence-dir <COPIA_DAS_EVIDENCIAS> --audit <AUDITORIA_DO_ENSAIO> --collector-hash c0001=<HASH_DO_COLETOR> --max-gap-hours 24 --seals-dir <COPIA_DOS_MANIFESTOS> --out <FORA_DO_PROJETO>/<PACOTE>.json --simulated` (runbook do conferente §2, quadro do ensaio) | saída 0; a saída começa com "ATENÇÃO: SIMULADA — ensaio"; `attestable: true`; checks como na tabela do conferente; `packageSha256`. Controle negativo (recomendado, antes): o mesmo comando sem `--simulated`, ou sem a trava, sai 3 com `EXPORT_SIMULATED_CAPTURE` e não grava o `--out` | `<…>` | `<PACKAGE_SHA256>` |
| S-04 | Conferência e dossiê A congelado | runbook do conferente §3–§4 | dossiê A com hash; o pacote traz `"simulated": true` (dentro do `packageSha256`) e o dossiê o registra como pacote SIMULADO do ensaio; verificações humanas marcadas **ENSAIO** (sem Serper nem painel real: o `PASS` registra o roteiro, não uma conferência real) | `<…>` | `<SHA256_DO_DOSSIE_A>` |
| S-05 | Aceite de risco de ensaio e `approval.json` | modelo do dossiê §3; conferente §4 | `approvedBy` = `CUST-01`; `riskAcceptance` com o hash do aceite de ensaio; `packageSha256` = o do pacote SIMULADO (com a marca); o aceite de ensaio cita que o `sign` vai rodar com `--simulated` | `<…>` | `<SHA256_DO_ACEITE>` |
| S-06 | Chave descartável gerada e cifrada, com id `ensaio-…` | runbook do custodiante §4.3 | arquivo `0600` em pasta `0700`; pública anotada; `<KEY_ID_ENSAIO>` começa por `ensaio-` (o `sign --simulated` só aceita esse prefixo, e o `sign` real o recusa) | `<…>` | `<KEY_ID_ENSAIO>:<PUBLICA>` |
| S-07 | Perfil do KDF conferido | runbook do custodiante §4.4 (`asn1parse` filtrado) | PBES2, id-scrypt, N = 0x020000, r = 8, p = 1, aes-256-cbc (colar só as linhas de OID e INTEGER; se a forma divergir da tabela do runbook, registrar e corrigir o runbook) | `<…>` | `<linhas>` |
| S-08 | Lista de chaves da homologação com a chave do ensaio `active` e deploy da homologação | `onda6c-runbook-chaves.md` §4 | `<KEY_ID_ENSAIO>:<PUBLICA>:active` na pilha (aceita só porque o web tem a trava, PC-5; em produção, uma lista com id `ensaio-` é recusada inteira) | `<…>` | `<…>` |
| S-09 | Artefato conferido | custodiante §2 (`namei -m`, `stat`, `sha256sum -c`) | `link-audit-sign.cjs: OK`; `444`; nenhuma pasta com escrita de terceiros | `<…>` | `<…>` |
| S-10 | `sign` pelo artefato, sem rede, **com `--simulated`** | custodiante §3 (linha exata, mais `--simulated` no fim das opções do `sign`; quadro do ensaio no §3) | a tela da confirmação mostra "ATENÇÃO: SIMULADA — ensaio" antes da digitação; saída 0; recibo `{"ok":true…}` com `seq` 1, `roleException: true`, `requiresLaterReview: true`, `artifactSha256` = o conferido. Controle negativo (recomendado, antes): a mesma linha sem `--simulated` sai 3 com `SIGN_SIMULATED_PACKAGE`, sem pedir a confirmação nem a frase | `<…>` | `<SEAL_SHA256>` |
| S-11 | Entrega **manual** na homologação (desvio declarado D-01) | `p1-canal-de-entrega-manifestos.md` §6 item 1 | só os bytes do manifesto, criação exclusiva no volume da pilha (nada sobrescrito), `sha256sum` antes e depois iguais ao do livro; quem fez e quando | `<…>` | `<SHA256 antes/depois>` |
| S-12 | Verificador `v2` no servidor (exige PC-5) | prévia: `GET /api/link-audit/scoring/{auditId}`, proveniência e bloqueios | status `AUTHENTICATED` (lista da pilha, `[2]`); bloqueio `SIMULATED_EVIDENCE` com severidade `WARNING` ("SIMULADA — ensaio"). Se vier `BLOCKING`, o web está sem a trava: parar e corrigir a PC-5 | `<…>` | `<…>` |
| S-13 | Finalização (exige PC-5) | interface (I5) ou `POST /api/link-audit/scoring/{auditId}/finalize` com `{expectedHead, expectedInputSha256}` da prévia | resultado gravado (o mapeador real dá INCONCLUSIVO, D-G0-10). Sem a trava no web, a resposta correta é `NOT_FINALIZABLE` com `SIMULATED_EVIDENCE` `BLOCKING` (é o comportamento de produção) | `<…>` | `<runSeq>` |
| S-14 | Resultado confirmado pelo livro (`RUN_CONFIRMED`) | `GET /api/link-audit/scoring/{auditId}/results` e `GET /api/link-audit/decisions/{auditId}` | leitura pelo livro (`confirmation: "LEDGER"`), o resultado entre os **confirmados** e nenhum pendente (na leitura pelo livro, confirmado = hash conferido contra o `RUN_CONFIRMED`, `src/lib/link-audit-scoring-runs/results.ts:493`) e `ledger.runs.open: null` | `<…>` | `<…>` |
| S-15 | Proveniência gravada no resultado (R2.1) | leitura só do arquivo `s<runSeq>.json` do resultado | `evidenceProvenance` = `{headSeq: 1, headSealSha256: <SEAL_SHA256>, keyIds: [<KEY_ID_ENSAIO>]}` | `<…>` | `<…>` |
| S-16 | (opcional, só com a W5.2) `close-key` pelo artefato com a linha larga, usando uma segunda chave descartável `S` | custodiante §9 | fecho gravado em `_closures/<R>.json`, entregue como no S-11; `<R>:<pública>:retired:<closureSha256>` fixado na pilha; prévia continua `AUTHENTICATED` | `<…>` | `<CLOSURE_SHA256>` |
| S-17 | Destruição da(s) chave(s) do ensaio | custodiante §10 | `revoked` na lista da pilha; arquivo e frase destruídos; linha no livro | `<…>` | `<data, método>` |

## 4. Atestações

| # | Atestação | SIM/NÃO | Evidência |
|---|---|---|---|
| AT-W5-01 | Nada em produção: nenhum deploy, secret, lista de chaves, volume ou dado de produção foi tocado | `<…>` | `<…>` |
| AT-W5-02 | A chave do ensaio foi destruída e o fato está registrado no livro (data, método, estado `revoked` na pilha) | `<…>` | `<…>` |
| AT-W5-03 | O fluxo `export` → aprovação → `sign` → entrega → verificador `v2` `AUTHENTICATED` → resultado confirmado com `RUN_CONFIRMED` foi observado de ponta a ponta (S-03 a S-14), com a entrega manual do desvio D-01 | `<…>` | `<…>` |
| AT-W5-04 | Verificação de entrada da nota 6 da R2.1 feita e registrada (§2) | `<…>` | `<…>` |
| AT-W5-05 | Conferido e assinado sempre os mesmos bytes (nenhum reexport depois da conferência) | `<…>` | `<…>` |
| AT-W5-06 | Nenhuma consulta paga e nenhum dado real usado | `<…>` | `<…>` |
| AT-W5-07 | A entrega manual (D-01) aconteceu só na pilha de homologação, byte a byte, sem sobrescrever, com os hashes registrados | `<…>` | `<…>` |
| AT-W5-08 | A captura do ensaio é SIMULADA, com a marca persistente (`simulated: true` / `SIMULATED`) vista no `--json` do S-02, no pacote (S-04), na tela da confirmação do `sign` (S-10), na interface ("SIMULADA — ensaio") e no aviso da prévia (S-12); a trava `GMN_LINK_AUDIT_HOMOLOGATION=1` só existiu no comando de coleta, no `export` e no web da homologação, nunca em produção | `<…>` | `<…>` |

## 5. Desvios, incidentes e correções do runbook

| # | O que divergiu do roteiro | Impacto | Correção (runbook, código ou decisão) |
|---|---|---|---|
| D-01 | **Desvio declarado da D15.5:** a entrega do manifesto foi manual na homologação, não pelo canal do CI (decisão do manager sob a delegação D15, 22/11/2026) | o canal do CI não foi ensaiado aqui | a entrega pelo canal do CI é ensaiada de novo na G2, antes de produção (critério de entrada da produção); nunca há entrega manual em produção |
| D-02 | **Esperado, declarado (D15.8):** a captura é SIMULADA (dados sintéticos, sem Serper, sem autorização de coleta nem painel de créditos) | o S-02 não exercita o Serper, a autorização nem o painel; as verificações humanas correspondentes ficam marcadas **ENSAIO** (S-04) | a coleta real é a W6 (D16), atestada com a chave real na cerimônia; em produção a captura simulada é recusada pelo `export` e não é finalizável |

## 6. Conclusão

`<APROVADO / REPROVADO>`, por `<quem>` em `<data>`. Com o relatório aprovado e a chave do ensaio destruída, a homologação fica
livre para a G2 (com auditorias novas) e a W6 pode seguir para a cerimônia da chave real pelo responsável (D15.7, D16). Ao fim do
ensaio, a trava `GMN_LINK_AUDIT_HOMOLOGATION` é desligada no web da homologação (ou o motivo de mantê-la fica registrado aqui).
