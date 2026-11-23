# P1 — Runbook do conferente (export, conferência de procedência, aprovação)

> **Status:** procedimento escrito na fatia **W5.1** (22/11/2026), **ainda não ensaiado** (W5.3). Só documentação. Aplica o
> contrato `onda6c-contrato-p1-atestacao.md` §3–§5, a spec `docs/specs/link-audit-p1-attestation.md` §5.3, §5.4 e §9 e as
> decisões D4, D13, D15.1 e D15.6. Repositório público: só marcadores, nunca valor real. O lado do custodiante está em
> `p1-runbook-custodiante.md`; o modelo do dossiê, em `p1-modelo-dossie.md`.

## 0. Princípio e separação de papéis

**Assinar não cria procedência: registra uma conferência** (contrato §4). A assinatura vale exatamente o que vale esta
conferência. Sem fonte independente, o resultado correto é **NÃO ATESTÁVEL**.

- **Regra (D4):** conferente ≠ custodiante. O `sign` compara os rótulos `approvedBy` e `--custodian` depois de NFKC, sem caixa e
  sem separadores (`CONF-01` ≡ `conf 01`), e recusa a coincidência sem aceite formal (`SIGN_ROLE_SEPARATION`).
- **Hoje não há segunda pessoa (D15.1).** O conferente é o próprio titular (`CUST-01`). Então:
  - `approval.json` sai com `approvedBy` = `CUST-01` e `riskAcceptance` = `{id, sha256}` do aceite formal do responsável
    (`p1-modelo-dossie.md` §3);
  - o dossiê A marca o acúmulo de papéis na seção "Papéis";
  - toda atestação sai com `requiresLaterReview: true` e entra na revisão amostral trimestral (D15.6(b),
    `p1-livro-de-manifestos.md` §4). Sem segunda pessoa, a revisão também é do titular, **marcada** como tal.
- **Operador = conferente** só marca `requiresLaterReview`, sem bloquear (D15.6(c)).

## 1. Antes do export

1. Ter o registro do operador, **feito em canal separado** e antes de qualquer outra operação, com o hash
   `source.capture.sha256` do relatório que o coletor imprimiu em `--json` (um por captura nova). Sem esse registro, a captura
   **não é atestável** (RS-05): coletar de novo.
2. Ter uma **cópia** (ou montagem somente leitura) da pasta de evidências da auditoria e uma cópia da pasta de manifestos do
   servidor, trazidas sem escrever nada na origem.
3. Ter a autorização de coleta da execução (identificador e validade) e acesso ao painel de créditos do provedor, para as
   verificações humanas do §3.

## 2. Export (somente leitura)

Na máquina do conferente, com o repositório, **sem rede** (de preferência por `scripts/run-isolated.sh`), nunca na estação de
assinatura:

```
npm run link-audit:seal -- export --evidence-dir <COPIA_DAS_EVIDENCIAS> --audit <AUDITORIA> \
  --collector-hash c0001=<HASH_DO_COLETOR> --max-gap-hours 24 \
  --seals-dir <COPIA_DOS_MANIFESTOS> --out <FORA_DO_PROJETO>/<PACOTE>.json
```

Opções: `scripts/link-audit-seal.ts:31-46`. Um `--collector-hash cNNNN=<hex64>` por captura nova; `--max-gap-hours 24` (D13);
`--out` é arquivo novo, fora da pasta de evidências e da árvore do projeto (`EXPORT_OUT_UNSAFE`). `--show-summary` só se for
preciso ver nome/cidade/UF na tela; o arquivo do pacote sempre tem o resumo.

> **Só no ensaio da W5 (homologação, captura SIMULADA, spec do P1 §5.7):** o `export` de uma captura simulada exige `--simulated`
> **e** `GMN_LINK_AUDIT_HOMOLOGATION=1` no ambiente do comando; a saída começa com "ATENÇÃO: SIMULADA — ensaio". Sem os dois, a captura
> simulada é recusada (`EXPORT_SIMULATED_CAPTURE`, código 3), e `--simulated` numa auditoria real também. **Em produção, nunca se usa
> nenhum dos dois.** O comando do ensaio está no S-03 de `p1-relatorio-ensaio-modelo.md`.

Conferir na saída (ou no `--json`) e anotar no dossiê A:

| O quê | Esperado | Se não |
|---|---|---|
| `Integridade local` | `OK` | o `export` já recusa (`EXPORT_INTEGRITY_NOT_OK`) |
| `atestável` | `sim` (`attestable: true`) | coleta legada ou mista: **NÃO ATESTÁVEL**; parar |
| `COLLECTOR_HASH_MATCHES` | `PASS` | o `export` recusa (`EXPORT_COLLECTOR_HASH_MISMATCH`/`_REQUIRED`) |
| `COLLECTION_GAP_WITHIN_LIMIT` | `PASS` (até 24 h) | acima sem justificativa: `EXPORT_GAP_EXCEEDED`; com justificativa: anotar e decidir |
| `HTTP_2XX_AND_COLLECTED_AT` | `PASS` | `FAIL`: o `sign` recusa; parar |
| `INTEGRITY_LOCAL` | `PASS` | — |
| `REPORT_REPRODUCES` | `NOT_EXECUTED` (viabilidade não confirmada) | conferência humana (§3, item 5) |
| `AUTHORIZATION_CONSUMED`, `PROVIDER_PANEL_CREDITS`, `URL_QUERY_COHERENCE` | sempre `NOT_EXECUTED` | conferência humana (§3) |
| `Delta` (informativo) | só entradas novas; nada `changed` nem `missing` | atestado anterior mudou ou sumiu: o `sign` recusa (`SIGN_EVIDENCE_CHANGED`); parar e investigar |
| `Pacote:` | o `packageSha256` | — |

E também: `sha256sum <PACOTE>.json` (os bytes do arquivo, para o transporte até a estação).

> **Depois de conferir, nunca reexporte.** `gap.observedHours` entra no `packageSha256` arredondado para cima à hora (spec
> §5.3.2). Outro `export` em outra hora dá outro hash, e o `sign` recusa o pacote que não foi o aprovado. O que se confere, o
> que se aprova e o que se assina são os **mesmos bytes**.

## 3. Conferência de procedência (contrato §4.1)

Registrar no dossiê A, item por item, o que foi feito e o resultado. Os quatro itens marcados entram em `approval.humanChecks`
com `result: "PASS"` e nota curta (sem e-mail, telefone nem dado pessoal). Um `NOT_EXECUTED` sem `PASS` humano é recusado pelo
`sign` (`SIGN_CHECK_NOT_EXECUTED`), e um resultado humano para verificação que o pacote não marca `NOT_EXECUTED` também
(`SIGN_APPROVAL_INVALID`).

| # | Verificação | `humanChecks.id` |
|---|---|---|
| 1 | A execução autorizada existe, corresponde à auditoria e à identidade confirmada, está dentro da validade e foi consumida **uma vez** | `AUTHORIZATION_CONSUMED` |
| 2 | O hash registrado pelo operador em canal separado é igual ao da captura (o `export` já conferiu: `COLLECTOR_HASH_MATCHES`) | — |
| 3 | Coerência: URL do provedor e consulta compatíveis com a identidade confirmada; `collectedAt` na janela; HTTP 2xx | `URL_QUERY_COHERENCE` |
| 4 | O consumo de créditos no painel do provedor coincide com a execução (mostra que **houve** a chamada; não prova o conteúdo) | `PROVIDER_PANEL_CREDITS` |
| 5 | Os relatórios referenciam a captura atestada e reproduzem quando o gerador é reexecutado offline; só se atesta o que reproduz | `REPORT_REPRODUCES` |

**Recusar (contrato §4.3)** se a integridade não for `OK`, se a identidade divergir entre capturas, se faltar captura ou revisão
(lacuna) ou houver uma a mais sem explicação, ou se o conjunto candidato diferir do que foi conferido.

## 4. Aprovação

1. **Congelar o dossiê A** (`p1-modelo-dossie.md` §1): depois de preenchido, nada muda nele. Calcular `sha256sum <DOSSIE_PARTE_A>`.
2. Escrever `approval.json` (spec §5.4; esquema estrito, `src/lib/link-audit-attestation/schemas.ts`):

```
{
  "schemaVersion": 1, "kind": "LINK_AUDIT_P1_APPROVAL",
  "auditId": "<AUDITORIA>", "packageSha256": "<PACKAGE_SHA256>",
  "decision": "APPROVED",
  "approvedBy": "CUST-01", "operator": "<ROTULO_DO_OPERADOR>",
  "approvedAt": "<AAAA-MM-DDTHH:MM:SS.mmmZ>",
  "dossier": { "id": "<ID_DO_DOSSIE>", "sha256": "<SHA256_DO_DOSSIE_A>" },
  "humanChecks": [
    { "id": "AUTHORIZATION_CONSUMED", "result": "PASS", "note": "<nota curta>" },
    { "id": "PROVIDER_PANEL_CREDITS", "result": "PASS", "note": "<nota curta>" },
    { "id": "REPORT_REPRODUCES", "result": "PASS", "note": "<nota curta>" },
    { "id": "URL_QUERY_COHERENCE", "result": "PASS", "note": "<nota curta>" }
  ],
  "riskAcceptance": { "id": "<ID_DO_ACEITE>", "sha256": "<SHA256_DO_ACEITE>" }
}
```

   - `dossier.id` no padrão `^[a-z0-9][a-z0-9._-]{2,63}$` (`DOSSIER_ID_PATTERN`, `schemas.ts:136`), sem dado pessoal;
   - `approvedBy`/`operator`: rótulos curtos (iniciais ou ID), nunca e-mail nem telefone;
   - `riskAcceptance`: obrigatório enquanto `approvedBy` = custodiante (hoje, sempre); `null` quando houver conferente distinto;
   - qualquer `decision` diferente de `APPROVED` é recusa. Para **recusar** uma coleta, não se escreve `approval.json`: registra-se
     a recusa e o motivo no dossiê A.
3. Entregar ao custodiante, por mídia: o pacote (os mesmos bytes), `approval.json`, o dossiê A e o aceite de risco. Os 12
   primeiros caracteres de `packageSha256` ficam no dossiê A, para o custodiante digitar na confirmação do `sign`.

## 5. Depois da assinatura

1. Receber do custodiante o recibo (dossiê B) e conferir: `packageSha256` e `dossierSha256` iguais aos aprovados, `seq` igual ao
   esperado pelo livro, `requiresLaterReview: true` enquanto não houver segunda pessoa.
2. Depois da entrega pelo canal, conferir na prévia da auditoria que a origem da coleta aparece autenticada e registrar no
   dossiê B.
3. Arquivar dossiê A, aprovação, recibo e o resultado da verificação offline, junto do livro (D15.6(b)).
