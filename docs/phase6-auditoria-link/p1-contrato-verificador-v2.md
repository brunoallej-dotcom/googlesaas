# Onda W3 — Contrato do manifesto `v2` e do verificador `v2` (produtor P1 da Auditoria por Link)

> **Status: Proposto — aprovar antes do código (onda W3).** Documento normativo; nenhum código, teste, spec ou outro documento foi alterado por ele. Data: 17/11/2026. Exigência do plano: `docs/plan/implementation-waves.md` ("Onda W3") e `docs/specs/link-audit-p1-attestation.md` §14 (a W3 precisa de contrato próprio **aprovado antes** de qualquer código). Linhas citadas (`arquivo:linha`) foram conferidas no código e nos documentos em `e19b96e`.
>
> **Fontes:** spec P1 `docs/specs/link-audit-p1-attestation.md` (§5.1, §5.5, §5.6, §6, §7.1, §13.1, §13.3, §16); modelo de ameaças `docs/security/threats/link-audit-p1-atestacao.md` (RS-09, RS-10, RS-15, RS-16, RS-20, pergunta 12); verificador atual `src/lib/link-audit-evidence/provenance.ts`; seus testes `tests/link-audit-evidence-provenance.test.ts`; ADR 6C-03 `onda6c-adr-proveniencia-evidencias.md`; contrato P1 `onda6c-contrato-p1-atestacao.md`; runbook `onda6c-runbook-chaves.md` §4; regra de época do livro (R6-06) em `onda6c-especificacao-livro-de-cabecas.md:246`.
>
> **Decisões do responsável de 17/11/2026 que este contrato codifica (novas; ainda **não** estão na spec):** **D12** época de chave pela ordem da cadeia, como regra de **rotação** com sucessão explícita (`retired:<successorId>`); titular e suplente (D10) se intercalam livremente enquanto ativas; no máximo **2** chaves assinantes ao mesmo tempo (titular e suplente, **cada uma com par próprio**); rotação periódica a cada **12 meses** (com o ensaio anual de restauração) e **sobreposição de assinatura = 0**; comprometimento ⇒ `keyId` revogado na hora; custódia K1 primeiro, K2 só após o teste RS-15 e exceção escrita e isolada a RS-14. Deve ser refletido na spec (§13.1) e no runbook (§4) na aprovação deste contrato (ver §12 e §13).

---

## 1. Objetivo e não-objetivos

**Objetivo.** Dar ao servidor (lado verificador) a capacidade de aceitar o manifesto `v2` de forma **aditiva** (o `v1` continua legível e inalterado) e de provar, **sem rede e sem relógio**:

1. **continuidade** — o manifesto de maior `seq` descende, por hash, de todos os anteriores (nenhum apagado, trocado ou pulado);
2. **cumulatividade** — cada manifesto atesta tudo que o anterior atestou, com os mesmos hashes;
3. **vínculo ao dossiê** — `dossier.sha256` dentro da parte assinada (spec D1; RS-10);
4. **anti-rebaixamento** — depois de um `v2` na cadeia, `v1` nunca mais é aceito em posição posterior;
5. **épocas de chave pela ordem da cadeia, revogação e papéis de chave** (D12);
6. **montagem a partir de assinatura externa** (K2), com o mesmo formato bit a bit (aditivo);
7. **vetor-ouro** do formato (RS-09).

**Não-objetivos (declarados).**
- Não é o produtor: `export`/`sign` são W2/W4. A W3 entrega só as primitivas puras (`provenance.ts`) e o verificador.
- Não verifica o **conteúdo** do dossiê (só o formato do hash e do `id`); a prova de que o dossiê existe e confere é humana (spec §9).
- Não usa **data** para decidir nada: `sealedAt` é escolhido por quem assina (spec §7.3; D12). Nenhuma validade por data, nenhum `Date.now()`.
- Não prova origem junto ao provedor nem atualidade (contrato P1 §1; replay de manifesto autêntico antigo continua sendo atualidade).
- Não adota `entries[].source` (RS-10; spec §13.3): incluí-lo exigirá `v3`.
- Não trata aprovação assinada pelo conferente (RS-03), fingerprint da lista (RS-18) nem alerta de regressão (RS-19).
- Não altera `EvidenceToProve` (`provenance.ts:57-61`), o leitor, o coletor, o layout das evidências nem a pasta de manifestos.

---

## 2. Formato `v2` (exato)

Arquivo `seal-NNNN.json` (`SEAL_FILE`, `provenance.ts:31`; NNNN = `seq` assinado), JSON de um só objeto, **esquema estrito** (zod `.strict()`, como `provenance.ts:79-91`: campo desconhecido, ausente ou de tipo errado ⇒ `SEAL_INVALID`).

| Campo | Tipo / regra | Na parte assinada |
|---|---|---|
| `schemaVersion` | literal `2` | sim |
| `kind` | literal `"LINK_AUDIT_EVIDENCE_SEAL"` (`SEAL_KIND`, `provenance.ts:29`) | sim |
| `auditId` | `AUDIT_ID_PATTERN` (`types.ts`; minúsculas, 8–64), **sem normalização** | sim |
| `seq` | inteiro 1…9999; igual ao NNNN do nome do arquivo | sim |
| `sealedAt` | `YYYY-MM-DDTHH:MM:SS.mmmZ` (mesmo regex de `provenance.ts:86`). **Informativo**: o verificador não o usa para decidir | sim |
| `keyId` | `^[a-z0-9][a-z0-9-]{3,31}$` (`TRUST_KEY_ID`, `provenance.ts:33`); rótulo público | sim |
| `entries` | 1…2000 itens `{ref, contentSha256}`; `ref` ∈ `REF` (`provenance.ts:36`); `contentSha256` = 64 hex **minúsculos**; **estritamente ordenados** por `ref` (comparação por unidades de código, como `provenance.ts:234`) e sem repetição | sim |
| `dossier` | `{ id, sha256 }` estrito; `sha256` = 64 hex minúsculos (SHA-256 dos **bytes** do dossiê de aprovação lidos uma vez pelo `sign`, spec §5.5 passo 6); `id` = `^[a-z0-9][a-z0-9._-]{2,63}$` (rótulo curto, **sem PII**; padrão proposto, ver §13) | sim |
| `prevSealSha256` | 64 hex minúsculos **ou** `null` | sim |
| `signature` | base64url **canônico** de 64 bytes (86 caracteres; decodificar e recodificar tem de devolver a mesma cadeia, como `publicKeyFromRaw` faz em `provenance.ts:155`) | **não** (é o resultado) |

**O que é assinado.** `signingBytes = UTF-8(canonicalJson(corpo))`, onde `corpo` é o arquivo **sem** `signature` e `canonicalJson` é `src/lib/link-audit/canonical.ts` (id `gmn-canonical-json-v1`, `canonical.ts:11`: chaves ordenadas, sem espaços, NFC). Assinatura **Ed25519 pura** (`crypto.sign(null, bytes, chave)` / `crypto.verify(null, …)`), **sem pré-hash e sem contexto** — o mesmo enquadramento do `v1` (`provenance.ts:104,235`) e o único compatível com K2 (RS-15). Separação de domínio: `schemaVersion` e `kind` estão dentro dos bytes assinados e o esquema é estrito, logo um corpo `v2` nunca é um corpo `v1` válido e vice-versa.

**`sealSha256`.** `sealSha256(arquivo)` = SHA-256, em hex minúsculo, de `UTF-8(canonicalJson(arquivo completo, com signature))`, calculado **depois** do parse estrito (`v1` ou `v2`). Independe de espaços, quebras de linha e ordem de chaves da cópia em disco (cópia administrativa reformatada dá o mesmo hash). Como `schemaVersion` está dentro, `v1` e `v2` nunca colidem. `prevSealSha256 = sealSha256(manifesto seq-1)`; `null` **se e somente se** `seq = 1`.

**Limites** (herdados): arquivo ≤ `MAX_SEAL_BYTES` = 256 KiB (`provenance.ts:32`; estouro ⇒ a leitura lança ⇒ `VERIFICATION_ERROR`, comportamento atual); ≤ 2000 entradas. **Novo:** no máximo `MAX_CHAIN_SEALS = 256` manifestos por auditoria (valor proposto, §13); mais que isso ⇒ `SEAL_CHAIN_BROKEN` (limita o custo da leitura da cadeia inteira no servidor).

**Primitivas puras aditivas** (não alteram `createEvidenceSeal`, `provenance.ts:101`):

| Função | Contrato |
|---|---|
| `buildEvidenceSealBodyV2(input)` | `{auditId, seq, sealedAt, keyId, entries, dossier, prevSealSha256}` → `{ body, signingBytes }`. Ordena `entries` como o `v1`; valida pelo esquema; **não** recebe chave |
| `assembleEvidenceSealV2(body, signature, publicKey)` | Recebe assinatura de fora (K2). **Verifica** com `crypto.verify(null, signingBytes, publicKey, …)` antes de devolver o arquivo; falha ⇒ `EvidenceSealError` tipado (`SIGNATURE_DOES_NOT_VERIFY`, sem material de chave no erro). Nunca recebe chave privada |
| `createEvidenceSealV2(input + privateKey)` | K1: `build` + `crypto.sign` + `assemble`. Para a mesma chave e o mesmo corpo produz arquivo **idêntico bit a bit** ao do caminho externo (Ed25519 é determinístico) |
| `sealSha256(arquivo)` | como acima; `v1` e `v2` |

---

## 3. Semântica cumulativa e continuidade

Seja `N` o maior `seq` (SEAL_FILE) da pasta `<sealsDir>/<auditId>/`. Para último manifesto `v2`, o verificador lê **todos** os `seal-0001 … seal-N` (a época de chave, §6, exige a cadeia inteira; isto **estende** a spec §5.6 item 2, que previa só o antecessor — ver §12-C1) e exige, para cada posição `i`:

1. o arquivo existe, é regular, parseia pelo esquema da sua `schemaVersion`, tem `auditId` igual ao pedido, `seq` igual ao nome, `entries` ordenadas e sem repetição;
2. a **assinatura** confere com a chave pública do `keyId` na lista (§5). `keyId` ausente da lista ⇒ `SEAL_INVALID` (§12-C3);
3. **continuidade:** para `i ≥ 2` e manifesto `v2`, `sealSha256(i-1) = prevSealSha256(i)`; `i = 1` exige `prev = null`; `i ≥ 2` com `prev = null`, `i = 1` com `prev ≠ null` ou hash diferente ⇒ `SEAL_CHAIN_BROKEN`. Lacuna de numeração ⇒ `SEAL_CHAIN_BROKEN`;
4. **cumulatividade:** para todo par adjacente `(i-1, i)`, `entries(i-1) ⊆ entries(i)` com os **mesmos** `contentSha256`; senão `SEAL_NOT_CUMULATIVE`. `entries(i) = entries(i-1)` é permitido (rasselagem, p.ex. troca de chave sem evidência nova).

Depois disso a cobertura **bidirecional atual permanece, sobre o último** (`provenance.ts:236-247`): base ⊆ manifesto (`EVIDENCE_NOT_SEALED`, `EVIDENCE_HASH_MISMATCH`) e manifesto ⊆ base (`EVIDENCE_MISSING`, `missingRefs` ≤ 5). A `v2` **acrescenta**; não afrouxa nada.

Regra herdada e mantida: o de **maior `seq`**; se ele não valer **não se recua** (`provenance.ts:226`). Cadeia mista é permitida só no sentido `v1…v1 v2…v2` (§4); para posições `v1` não há `prevSealSha256` e o elo `v1 → v2` confere o hash do `v1` com a definição de `sealSha256`.

---

## 4. Anti-rebaixamento

1. **Monotonia de versão.** Em qualquer pasta, a sequência de versões por `seq` é `v1* v2*`. Um `v1` em `seq` maior que algum `v2` ⇒ `SEAL_DOWNGRADE`, **mesmo que a assinatura do `v1` seja válida**. A varredura de versão olha **todos** os `seal-NNNN.json` com `NNNN ≤ N` (leitura frouxa de `schemaVersion`): um arquivo que declara `schemaVersion: 2` mas é inválido pelo esquema **conta** como `v2` (falha fechada: o atacante não o invalida para "esconder" o `v2`).
2. **Versões aceitas.** `SealedEvidenceOptions` ganha `acceptedVersions: readonly (1 | 2)[]` (aditivo). Padrão da fábrica `createSealedEvidenceProvenance` e de `evidenceProvenanceFromConfig`: `[1, 2]` — **necessário** para os testes do `v1` passarem sem alteração (`tests/link-audit-evidence-provenance.test.ts:108,489`; critério do plano), compensado pela regra 1, que é **sempre ligada**. Modo produção: `[2]`; último manifesto `v1` ⇒ `SEAL_VERSION_NOT_ALLOWED`. Modo "verificador antigo": `[1]`; `v2` ⇒ `SEAL_INVALID` (equivale ao verificador só-`v1`, que falha no `z.literal(1)` de `provenance.ts:82`). A ligação do modo produção ao servidor (`src/app/api/link-audit/scoring/shared.ts:92`) entra na W3 (§10).
3. **Ordem de implantação** (spec §5.6 item 1): o verificador `v2` precisa estar **implantado antes** de qualquer `v2` ser entregue ao volume e antes de qualquer lista com status (§5), porque o verificador antigo recusa `v2` e recusa itens de 3 partes (`provenance.ts:170`, política fechada).
4. Residual declarado: numa cadeia **nova só `v1`**, quem tem a chave assina o que quiser — é o mesmo modelo de confiança do `v1` (limite do contrato P1 §7); o modo produção `[2]` fecha esse caso. O produtor (W4) **nunca** emite `v1` (spec §5.1).

---

## 5. Lista de chaves de confiança: formato (retrocompatível), papéis e sucessão

Variável `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (runbook §4; `provenance.ts:165`). **Novo formato (superconjunto):**

```
<id>:<pública base64url 43>                        ⇒ active   (formato antigo, 2 partes)
<id>:<pública>:active
<id>:<pública>:retired:<successorId>               ⇒ aposentada; <successorId> = id da chave que a sucede (obrigatório)
<id>:<pública>:revoked
```

| Status | Pode assinar posição nova? | Conta no limite de 2? |
|---|---|---|
| `active` | sim (titular e suplente podem se **intercalar**: `A S A` vale, D10/D12) | **sim** (no máximo 2) |
| `retired` | só enquanto **nenhum** manifesto da cadeia anterior à posição tenha sido assinado por seu sucessor, direto ou transitivo (regra de sucessão, §6). Em cadeia que o sucessor nunca tocou, pode ser o signatário do **último** (D12, leitura literal) | não |
| `revoked` | não: qualquer posição assinada por ela ⇒ `SEAL_KEY_REVOKED` (§7) | não |

Regras de validade da **lista** (qualquer violação invalida **tudo** ⇒ política fechada `PROOF_NOT_CONFIGURED`, como `provenance.ts:260-262`): item com 2, 3 ou 4 partes conforme a tabela; `id` ∈ `TRUST_KEY_ID`; pública aceita por `publicKeyFromRaw` (recusa ordem pequena, `provenance.ts:152-162`); `status` fora do conjunto; `retired` sem `successorId`, ou `successorId` com `active`/`revoked` ausente do mesmo conjunto de itens (**sucessor desconhecido**), igual ao próprio `id`, ou formando **ciclo**; `id` repetido; **a mesma chave pública sob dois `id`** (RS-16: suplente com par **próprio**, nunca cópia; reuso de chave após rotação também cai aqui); mais de **2** `active`; mais de `MAX_TRUST_KEYS` = 16 itens (proposto, §13-O2). `successorId` pode apontar para qualquer item presente (inclusive `revoked`). **Zero** `active` é lista **válida** (nenhuma assinatura nova de chave ativa; as razões de revogação continuam sendo reportadas, que é o sinal da pergunta 12). Compatibilidade: lista antiga (itens `id:pública`) = todos `active`; com mais de 2 entradas passa a ser fechada (nenhuma lista de produção existe, ADR 6C-03 §5).

Novo `parseTrustKeyring(raw)` devolve `ReadonlyMap<id, {key, status, successorId}> | null`. **`parseTrustKeys` (`provenance.ts:165`) não muda** (devolve `Map<id, KeyObject>`, `null` para item de 3 ou 4 partes); `SealedEvidenceOptions.trustedKeys` continua aceito (todas `active`); `keyring` é opção nova e tem precedência. `evidenceProvenanceFromConfig` passa a usar `parseTrustKeyring`.

---

## 6. Épocas de chave: sucessão por ROTAÇÃO, ordem da cadeia (D12, D10)

Mesma família da regra do livro (R6-06, `onda6c-especificacao-livro-de-cabecas.md:246`; runbook §7). **Referência = ordem da cadeia encadeada por hash, nunca `sealedAt`.** A regra trata de **rotação**, não de alternância entre as duas chaves ativas.

- Seja `succ*(R)` o fecho transitivo de sucessores de uma chave `retired` `R` (`R → S → T …`). **Violação (`SEAL_KEY_EPOCH_VIOLATION`):** existe posição `p` assinada por `R` e posição `q < p` assinada por alguma chave de `succ*(R)`. Equivale a: "`R` só vale na posição `p` se nenhuma posição anterior foi assinada por seu sucessor (transitivamente)"; `R` continua apenas verificando as posições anteriores à primeira assinada pela nova (D12).
- Chaves `active` não têm restrição de ordem entre si: `A S A` (titular, suplente, titular) vale. Mais de 2 `active` é lista inválida (§5).
- **Cadeia que o sucessor nunca tocou:** todas as posições são "anteriores à troca"; uma `retired` pode ser o signatário do **último** manifesto (a auditoria histórica **não** degrada a cada rotação anual; reaselagem obrigatória foi rejeitada, §13.1). Janela residual declarada abaixo.
- `sealedAt` retrodatado, adiantado ou fora de ordem **não muda** o resultado (nenhum relógio é lido).
- **Rotação periódica (12 meses) e sobreposição 0 (exigência de procedimento para a W5/runbook):** (1) par novo, `id` novo, nunca reutilizado; (2) lista, no mesmo ato: nova `active`, antiga `retired:<id da nova>`; (3) a antiga **não assina mais nada**; (4) o **material privado da antiga é destruído na rotação**; (5) **qualquer dúvida** sobre a destruição ou a custódia ⇒ marcar `revoked`, nunca `retired`. A "convivência" da D8 passa a significar só coexistência **na lista** (§12-C4).
- **Janela residual declarada (mesma família da R6-06; travada em teste):** numa cadeia que o sucessor **nunca tocou**, o verificador não distingue um manifesto da chave `retired` feito **antes** da rotação de um feito **depois** (quem ainda tem a privada e escreve no volume anexa manifestos indistinguíveis). Só a destruição da privada (procedimento, item 4), a revogação do `id` e a guarda externa (livro de manifestos, W5/RS-17) cobrem isso. Depois que o sucessor assina uma vez, a aposentada fica inutilizável naquela cadeia.

---

## 7. Comprometimento e revogação (resposta à pergunta 12 do modelo de ameaças)

1. **Efeito imediato:** o `keyId` passa a `revoked` na lista (o `id` **permanece** na lista com a pública; **remover** o item não é revogação: item ausente ⇒ `SEAL_INVALID`, também fail-closed, mas sem o sinal de revogação).
2. **Novas finalizações (falha fechada):** qualquer cadeia que contenha **qualquer posição** assinada por chave `revoked` ⇒ `UNAUTHENTICATED` com `reason: 'SEAL_KEY_REVOKED'` e campo aditivo `revokedKeyIds` (≤ 2 `id`, públicos, sem PII). A razão só é emitida para posição cuja **assinatura confere** (um arquivo forjado com o `keyId` revogado e assinatura inválida é `SEAL_INVALID`, para que ninguém fabrique o sinal).
3. **Resultados já confirmados com essa chave** (histórico): o verificador **não** reescreve, não invalida e não lê resultados (só a pasta de manifestos). A resposta à pergunta 12 é: **sim, vão a revisão humana**, e o sinal é o **código `SEAL_KEY_REVOKED`** devolvido por `classify` para a auditoria afetada; o consumidor que mostra/relê um resultado confirmado (R1 / procedimento W5) o usa para **sinalizar** "revisão humana necessária" **sem** mudar o resultado gravado (decisão aberta de onde, §13-O6; fora do código da W3). `PROVENANCE_REASON_LABELS` ganha texto próprio (§10).
4. **Recuperação:** a cadeia de uma auditoria que contém posição revogada **não volta a autenticar** por manifesto novo (a continuidade por hash a mantém); reabilitação = **nova coleta sob novo `auditId`** por fonte independente, como o runbook §3 (reassinar não torna confiável). **Recomendação** (o responsável ainda aprova): nova coleta sob novo `auditId`, mesma filosofia da D3 ("NÃO ATESTÁVEL → coleta nova"); sem `v3` de reatestação nesta onda (§13.1).
5. **Intervalo comprometimento → revogação:** manifestos forjados nele são indistinguíveis (limite declarado, igual ao do livro).

---

## 8. Modos de falha (todo caso malformado/adversarial ⇒ `UNAUTHENTICATED`; `classify` **nunca lança**)

Ordem de avaliação (a primeira que casar vence; determinística, para os testes):

| # | Situação | Razão |
|---|---|---|
| 1 | política fechada / lista inválida; pasta de manifestos sobreposta a outra pasta de dados (inclusive link simbólico) | `PROOF_NOT_CONFIGURED` |
| 2 | `auditId` fora de `AUDIT_ID_PATTERN` (sem normalizar), base vazia | `NO_SEAL` |
| 3 | pasta ausente/vazia (legado ⇒ `LEGACY_NO_SEAL`); pasta é link/não-diretório | `NO_SEAL` / `LEGACY_NO_SEAL` / `SEAL_INVALID` (como `provenance.ts:215-225`) |
| 4 | último manifesto: JSON inválido, esquema estrito, `auditId`≠, `seq`≠nome, `keyId` fora da lista, assinatura inválida/não canônica, `entries` desordenadas/repetidas | `SEAL_INVALID` |
| 5 | último é `v1` e existe `v2` abaixo (válido ou não) | `SEAL_DOWNGRADE` |
| 6 | último é `v1` e `acceptedVersions` não o inclui | `SEAL_VERSION_NOT_ALLOWED` (para `v2` com `[1]`: `SEAL_INVALID`) |
| 7 | lacuna, nome faltando, `> MAX_CHAIN_SEALS`, `prev` ≠ hash do antecessor, `seq=1` com `prev`≠null, `seq>1` com `prev=null` | `SEAL_CHAIN_BROKEN` |
| 8 | posição anterior inválida pelos itens do §3.1–3.2 | `SEAL_INVALID` |
| 9 | `entries(i-1) ⊄ entries(i)` ou hash diferente | `SEAL_NOT_CUMULATIVE` |
| 10 | época/sucessão violada (§6): `retired` assina depois de seu sucessor ter assinado | `SEAL_KEY_EPOCH_VIOLATION` |
| 11 | posição assinada por chave `revoked` (assinatura conferida) | `SEAL_KEY_REVOKED` (+`revokedKeyIds`) |
| 12 | base com evidência fora do manifesto / hash diferente / manifesto com evidência ausente | `EVIDENCE_NOT_SEALED` / `EVIDENCE_HASH_MISMATCH` / `EVIDENCE_MISSING` (+`missingRefs` ≤ 5) |
| 13 | qualquer exceção (leitura, FIFO, arquivo > 256 KiB, erro de E/S) | `VERIFICATION_ERROR` |

Os passos 8 a 11 só rodam depois de **toda** posição ter parseado e conferido assinatura, para que nenhum sinal (`SEAL_KEY_REVOKED`) saia de arquivo não autenticado. Leitura sem seguir link e sem travar em FIFO (`FsOps.lstat/readFile` com limite), como hoje. `SEAL_*` carregam só códigos fixos, nunca dados do arquivo.

**Novos valores de `EvidenceTrustReason`** (6, aditivos; os 8 atuais, `provenance.ts:41-49`, não mudam):

| Valor | Significado |
|---|---|
| `SEAL_CHAIN_BROKEN` | A cadeia por hash não fecha: antecessor ausente/trocado, lacuna, `prev` incoerente com `seq`, cadeia acima do limite |
| `SEAL_NOT_CUMULATIVE` | Um manifesto omite ou muda a entrada de um anterior |
| `SEAL_DOWNGRADE` | Um `v1` aparece depois de um `v2` |
| `SEAL_VERSION_NOT_ALLOWED` | A versão do último manifesto não é aceita pela política (produção exige `v2`) |
| `SEAL_KEY_EPOCH_VIOLATION` | Uma chave aposentada assina depois de a sua sucessora (direta ou transitiva) já ter assinado na cadeia (rotação, D12) |
| `SEAL_KEY_REVOKED` | A cadeia contém posição assinada por chave revogada: não vale para nova finalização e o histórico confirmado com ela exige revisão humana |

`EvidenceTrust` (`provenance.ts:51-54`) ganha o campo opcional `revokedKeyIds?: readonly string[]` (só em `SEAL_KEY_REVOKED`). Consumidores com `switch`/lista exaustiva: ver §10.

---

## 9. `v1` continua legível e inalterado

- `sealBodySchema`/`sealFileSchema` do `v1`, `createEvidenceSeal`, `parseTrustKeys`, `publicKeyFromRaw`, `isWeakEd25519PublicKey`, `EvidenceToProve` e os 8 motivos atuais **não mudam**. `tests/link-audit-evidence-provenance.test.ts` passa **sem alteração** (`git diff --quiet origin/main -- tests/link-audit-evidence-provenance.test.ts`, critério do plano).
- Último manifesto `v1`, sem `v2` abaixo e com `acceptedVersions` padrão: o caminho de hoje (`provenance.ts:226-248`), sem leitura de cadeia e sem época. Acrescenta-se só o **status** da chave (`revoked` ⇒ `SEAL_KEY_REVOKED`); lista antiga = todas `active`, logo sem efeito sobre os testes atuais.
- Lista antiga de 2 partes, com ≤ 2 chaves, continua válida e equivale a `active`.

---

## 10. O que NÃO muda / impacto fora de `provenance.ts`

Não mudam: coletor, formato das capturas, `EvidenceToProve`, leitor (`scoring-basis.ts`), `preview.ts` (só repassa `reason`, `preview.ts:299`), resultados, livro, `stack.yml`, volumes, `canonicalJson`. Nenhum import novo em `provenance.ts` (só `node:crypto`, `node:path`, `zod`, os módulos já importados); nenhuma rede.

**Impacto (decidido pelo responsável em 17/11/2026: entra na W3):** `src/components/link-audit/audit-page/labels.ts:79-85` (`PROVENANCE_REASON_LABELS`) e `src/components/link-audit/audit-page/validators.ts:97` (`PROVENANCE_REASONS`, usado para validar o DTO da prévia) **enumeram os 8 motivos**; sem acréscimo aditivo dos 6 novos o texto fica sem rótulo e o validador do DTO pode **rejeitar** uma prévia com razão nova. Entram também na W3: a ligação do modo produção `acceptedVersions: [2]` em `src/app/api/link-audit/scoring/shared.ts:92` (aceitar `v1` só por opção explícita de homologação) e a **edição do runbook de chaves** (§12-C3). **Isto amplia a W3 além de `provenance.ts`** (o plano de ondas será atualizado pelo responsável da coordenação); continua aditivo, sem mudar `EvidenceToProve`.

---

## 11. Vetor-ouro (RS-09) e testes

**Exigências do vetor** (arquivo de teste próprio; módulo importável pelo W4 para a paridade com o artefato do `sign`, IA-03/IA-24):
1. **Chave de teste determinística**: semente de 32 bytes fixa em hex, claramente de teste, **nunca** PEM nem PKCS#8 em texto (evita gitleaks), montada em memória; nunca usada fora dos testes.
2. **Valores gerados por rota independente do código sob teste** (ex.: `openssl pkeyutl -sign -rawin` e um cálculo SHA-256 externo), revisados na PR; os testes **só leem** os valores.
3. Vetores: **G1** `v2` `seq=1`, `prev=null` (corpo, bytes canônicos em hex, assinatura base64url, `sealSha256`); **G2** `v2` `seq=2` com `prev = G1.sealSha256`; **G3** continuação com **outra** chave (rotação A→B); **G4** `v1` de não regressão (corpo, hex, assinatura); **G5** sonda de `canonicalJson` (objeto com chaves fora de ordem, não-ASCII em NFD/NFC, números, aninhamento) cujo hex travado detecta qualquer mudança de serialização.
4. Os testes recalculam `canonicalJson` e comparam **byte a byte** com o hex; verificam a assinatura com a pública bruta no formato da lista; verificam `sealSha256`; passam pelo **verificador** de ponta a ponta; e falham com 1 byte alterado em cada um.
5. **Mudou `canonicalJson`, o esquema ou o enquadramento da assinatura ⇒ novo `schemaVersion`** (regra de RS-09). Nunca regravar o vetor para "consertar" o teste.

**Testes de aceite** (cada um escrito **antes** do código e visto falhar; arquivos `tests/link-audit-evidence-provenance-v2*.test.ts`; o texto dos nomes cita os IDs, pois o *goal command* faz `grep` de `IA-21` e `RS-20`).

| ID | Verifica | Mapeia |
|---|---|---|
| V2-01 | `v2` válido (cadeia de 1) produzido por `createEvidenceSealV2` é `AUTHENTICATED` com a pública derivada, evidências lidas por `readScoringBasis` | IA-03, IA-21 |
| V2-02 | Esquema estrito: campo extra/faltando, tipos, `seq` 0/10000, refs desordenadas/repetidas, hash em maiúsculas, `dossier` malformado, assinatura de tamanho errado ou **não canônica** (bits finais) ⇒ `SEAL_INVALID` | RS-09, RS-10 |
| V2-03 | Matriz de 1 byte: `contentSha256`, `ref`, `signature`, `seq` (nome ajustado), `keyId`, `sealedAt`, `dossier.id`, `dossier.sha256`, `prevSealSha256`, `auditId` ⇒ `UNAUTHENTICATED` (e `SEAL_CHAIN_BROKEN` quando reassinado com chave válida e `prev` errado) | IA-03(a–c), RS-09 |
| V2-04 | 1 byte no arquivo de evidência ⇒ `EVIDENCE_HASH_MISMATCH` | IA-03(d), IA-21 |
| V2-05 | Cobertura bidirecional no `v2`: omite evidência presente ⇒ `EVIDENCE_NOT_SEALED`; lista ausente ⇒ `EVIDENCE_MISSING` (≤ 5) | IA-21 |
| V2-06 | Suíte do `v1` inalterada (diff vazio) + manifesto `v1` ainda `AUTHENTICATED` pelo verificador novo (padrão) | plano W3, IA-21 |
| V2-07 | Verificador "só-`v1`" (`acceptedVersions: [1]`) recusa `v2` (`SEAL_INVALID`); o esquema `v1` literal recusa `schemaVersion: 2` | IA-21, RS-10 |
| V2-08 | Cadeia `seq 1→2→3` válida ⇒ `AUTHENTICATED` | IA-21 |
| V2-09 | Antecessor ausente, lacuna (`0001`,`0003`), `seq=2` sem `0001`, cadeia > 256 ⇒ `SEAL_CHAIN_BROKEN` | IA-21 |
| V2-10 | Antecessor trocado por **outro manifesto válido**, ou com 1 byte mudado ⇒ `SEAL_CHAIN_BROKEN`/`SEAL_INVALID` (conforme o caso) | IA-21, RS-10 |
| V2-11 | `seq=1` com `prev≠null`; `seq>1` com `prev=null` (reassinados com chave válida) ⇒ `SEAL_CHAIN_BROKEN` | IA-21 |
| V2-12 | Omite entrada do antecessor / muda hash dela ⇒ `SEAL_NOT_CUMULATIVE`, inclusive num par **intermediário** (não só o último) | IA-21, IA-08 |
| V2-13 | Rasselagem com `entries` iguais é aceita; `entries` ⊋ aceita | IA-08 |
| V2-14 | `sealSha256` e autenticação independem de formatação/ordem de chaves da cópia em disco; `v1` e `v2` com mesmo conteúdo lógico têm hashes diferentes | §2 |
| V2-15 | Nome do arquivo ≠ `seq` assinado ⇒ `SEAL_INVALID`; nomes fora de `SEAL_FILE` (caixa diferente) são ignorados e não preenchem lacuna | IA-07, IA-21 |
| V2-16 | Monotonia: `v2` seguido de `v1` válido e bem assinado ⇒ `SEAL_DOWNGRADE`; `v1` último com `v2` abaixo (inclusive `v2` inválido pelo esquema) ⇒ `SEAL_DOWNGRADE` | IA-21 (anti-rebaixamento) |
| V2-17 | `v1` último sem `v2`: `[2]` ⇒ `SEAL_VERSION_NOT_ALLOWED`; `[1,2]` ⇒ `AUTHENTICATED`; `v1…v2` (promoção) aceito, elo `v1→v2` por `sealSha256` | IA-21 |
| V2-18 | Lista: 2 partes = `active`; `active`/`revoked` explícitos; `retired:<successorId>`; `retired` sem sucessor, **sucessor desconhecido**, sucessor = si mesmo, **ciclo**, `status` inválido, `id` repetido, **mesma pública sob dois `id`**, > 2 `active`, > 16 itens, item malformado ⇒ política fechada (`PROOF_NOT_CONFIGURED`); `parseTrustKeys` antigo inalterado; zero `active` é válida | RS-16, RS-18 (limite), D12 |
| V2-19 | Entre chaves `active`: `A S A` (titular, suplente, titular) e `S A S` ⇒ `AUTHENTICATED` (D10/D12); com 2 pares próprios | D12, D10, RS-16 |
| V2-20 | Época independe de data: `sealedAt` retrodatado/adiantado/fora de ordem não muda o veredito; `Date`/`Date.now` trocados por armadilha não são chamados | D12, RS-20 |
| V2-21 | Sucessão: `R` (`retired>S`) em posições antes de qualquer assinatura de `S` ⇒ `AUTHENTICATED`; **`R` como signatário do último numa cadeia que `S` nunca assinou ⇒ `AUTHENTICATED`**; `R` depois de `S` (`R S R`, ou `R S S R`) ⇒ `SEAL_KEY_EPOCH_VIOLATION`; sucessão transitiva (`R>S`, `S>T`: `R T R` e `S T S` ⇒ violação) | D12 |
| V2-22 | `revoked` em **qualquer** posição ⇒ `SEAL_KEY_REVOKED` + `revokedKeyIds`; arquivo com `keyId` revogado e assinatura inválida ⇒ `SEAL_INVALID` (sem o sinal) | D12, pergunta 12 |
| V2-23 | Revogação não toca o histórico: `fs` espião prova leituras só em `<sealsDir>/<auditId>` e **zero escritas**; a prévia repassa `reasonCode = SEAL_KEY_REVOKED` sem alterar resultado gravado | pergunta 12 |
| V2-24 | `keyId` desconhecido em posição anterior, ou item removido da lista (não revogado) ⇒ `SEAL_INVALID` | D12 |
| V2-25 | Titular e suplente, **dois pares próprios** `active`, cadeia intercalada autentica; rotação `A`(active)→`A`(`retired>B`)+`B`(active): `A A B B` autentica, `A B A` viola; janela residual travada: `R` assinando último em cadeia que `B` nunca tocou autentica (comportamento declarado) | RS-16, D12 |
| V2-26 | Manifesto e evidências de A sob B (cópia do `seal-*.json` de A na pasta de B; `classify(B, evidênciasDeA)`) ⇒ `SEAL_INVALID`/`EVIDENCE_*`, nunca `AUTHENTICATED` | RS-20, IA-06(1) |
| V2-27 | `auditId` não normalizado (maiúsculas, espaços, `../`, `%2e%2e`, barra final, Unicode, `body.auditId` com caixa diferente) ⇒ `NO_SEAL`/`SEAL_INVALID` e **nenhum acesso ao `fs`** para os malformados | RS-20 |
| V2-28 | Montagem externa: `signingBytes` assinados por "dispositivo simulado" (assinatura produzida fora de `createEvidenceSealV2`) ⇒ arquivo **idêntico bit a bit** ao do K1; assinatura errada ou de outra chave ⇒ `EvidenceSealError`, nada devolvido; as funções não aceitam chave privada em `assemble` | D5, RS-15 |
| V2-29 | Interoperabilidade (RS-15): assinatura Ed25519 pura gerada **fora do Node** (OpenSSL) sobre `signingBytes` verifica com `crypto.verify(null, …)` e a pública no formato da lista | RS-15, IA-22 |
| V2-30 | Vetores-ouro G1–G5 (§11) | RS-09, IA-03 |
| V2-31 | Falhas: JSON inválido, link simbólico, FIFO, arquivo > 256 KiB, erro de E/S em posição anterior, exceção forçada ⇒ `UNAUTHENTICATED` com razão fixa, sem lançar, sem travar | IA-13 (herdado), RS-20 |
| V2-32 | Herdados reexecutados com `v2`: pasta de manifestos como link/FIFO/sobreposta a outra pasta falha fechada | R3-MINOR-6 |
| V2-33 | Compatibilidade de consumidores: rótulo e validador de DTO aceitam os 6 motivos novos; `typecheck` passa; `EvidenceToProve` inalterado (teste de tipo) | §10 |
| V2-34 | Isolamento: o grafo de imports de `provenance.ts` não ganha dependência nem rede (teste estático) | IA-05 (espírito) |

---

## 12. Contradições e divergências encontradas entre spec, modelo de ameaças, runbook e código (a conciliar na aprovação)

- **C1 — assinatura do antecessor.** Spec §5.6 item 2 e §13.3: confere só o **hash** do antecessor; "a assinatura do antecessor não é exigida, pois a chave dele pode ter sido aposentada". D12: "uma chave aposentada continua verificando as posições anteriores à troca" e a época exige conhecer a cadeia inteira. **Este contrato segue D12** (§3): lê toda a cadeia e verifica todas as assinaturas; consequência: chaves aposentadas **ficam na lista** como `retired>sucessor` (C3).
- **C2 — anti-rebaixamento "só com opção explícita" × testes do `v1` sem alteração.** Spec §5.6 item 5 quer `v1` recusado em produção por padrão; mas os testes do `v1` autenticam `v1` por `evidenceProvenanceFromConfig` sem opção (`tests/link-audit-evidence-provenance.test.ts:108,489`) e o plano exige que passem sem alteração. Solução: padrão permissivo `[1,2]` + monotonia sempre ligada + modo produção `[2]` ligado fora de `provenance.ts` (§4, §10).
- **C3 — runbook §4 × D12/RS-18.** O runbook manda **remover** a pública antiga após a rotação ("só então remover a antiga") e, no comprometimento, "remover imediatamente a pública da lista". Com cadeia verificada (C1), item removido torna as cadeias que o contêm `SEAL_INVALID` (fail-closed, sem sinal de revogação). **O runbook (`onda6c-runbook-chaves.md` §4) precisa passar de "remover a pública antiga" para marcá-la `retired:<successorId>` (rotação) ou `revoked` (comprometimento), permanecendo na lista; essa edição do runbook pertence à W3 (documento)**, para que verificador e procedimento nunca divirjam. O runbook também deve registrar: privada da aposentada **destruída** na rotação; dúvida ⇒ `revoked` (§6).
- **C4 — D8 × D12.** D8 (spec §13.1) previa "período de convivência das duas chaves"; D12 fixa **sobreposição de assinatura = 0**. Reconciliado em §6 (coexistência só na lista). D8 deve ser marcada como substituída.
- **C5 — escopo da W3 (decidido: amplia).** O plano diz "`provenance.ts`, com acréscimos e sem mudar `EvidenceToProve`"; mas `labels.ts:79` e `validators.ts:97` enumeram as razões (§10) e o ponto de ligação do modo produção está em `shared.ts:92`.
- **C6 — `sign` e lista de chaves.** O `sign` usa `--trust-keys <id:pub,...>` e verifica o manifesto anterior (spec §5.5 passo 7, §7.1). Na W4 ele terá de aplicar **as mesmas regras** (status, época, cadeia) para não assinar sobre cadeia que o servidor recusaria; o formato de `--trust-keys` herda o novo formato (§5, incluindo `retired:<successorId>`). Não é decisão da W3, mas a primitiva de verificação precisa ser a mesma (importável sem dependências novas, RS-14).
- **C7 — spec §16 RS-10.** A spec registra "verificador v1 recusa v2 e vice-versa: só a primeira metade; o `v2` aceita `v1`". Confirmado e mantido aqui; o teste V2-07 cobre a primeira metade com o modo `[1]` e com o esquema `v1` literal.
- **C8 — RS-16 × limite de chaves × rotação anual.** RS-18 pede limite máximo de chaves na lista; com rotação a cada 12 meses e aposentadas permanentes (C3) a lista cresce ~1–2 itens por ano; o limite proposto (16) precisa de decisão (O2).

---

## 13. Pontos em aberto para o responsável (só onde as fontes não decidem)

(O1, O3 e O5 foram **decididos** em 17/11/2026 e estão incorporados; O4 virou **recomendação**, §7 item 4. A numeração dos que restam foi mantida.)

| # | Ponto | Proposta deste contrato |
|---|---|---|
| **O2** | **Chaves desconhecidas em posições anteriores** ⇒ `SEAL_INVALID` obriga as aposentadas a permanecerem na lista para sempre; **limite total** de itens da lista (RS-18) | Estrito; `MAX_TRUST_KEYS = 16`. Alternativa: tolerar `keyId` desconhecido em posição anterior (preso por hash), ao custo de perder o sinal de revogação se o item for removido em vez de marcado |
| **O6** | **Quem sinaliza "revisão humana" para resultados já confirmados com chave revogada** e em que tela/onda (R1, W5 ou outra). A W3 só entrega o código `SEAL_KEY_REVOKED` | Sinalizar sem alterar o resultado; onda a definir |
| **O7** | Números: `MAX_CHAIN_SEALS = 256`; padrão do `dossier.id` (`^[a-z0-9][a-z0-9._-]{2,63}$`) | Os propostos; baixo impacto |

### 13.1 Alternativas rejeitadas (por decisão do responsável de 17/11/2026)

- **Estrita: aposentada nunca assina o último (O1).** Exigiria uma rasselagem por auditoria após cada rotação anual e degradaria todas as auditorias históricas a cada rotação. Rejeitada; vale D12 literal (§6), com a janela residual declarada e o procedimento de destruição da privada.
- **Época entre as duas chaves `active` (O3):** `A B A` inválido também entre titular e suplente. Rejeitada: D12/D10 permitem até 2 chaves assinando ao mesmo tempo; a regra é de **rotação** (sucessão explícita `retired:<successorId>`).
- **`v3` de reatestação após revogação (O4):** romperia a cumulatividade; não nesta onda (a recomendação é nova coleta sob novo `auditId`).
- **Tolerar `keyId` desconhecido em posição anterior** segue como alternativa de O2, não adotada.

Pré-requisitos que **não** são desta onda, mas condicionam a W4 (já na spec §13.2): titular/suplente, dispositivo concreto, exceção escrita a RS-14 para K2.

---

## 14. Rastreabilidade (requisito → seção → teste)

| Requisito | Seção | Testes |
|---|---|---|
| IA-21 (verificador `v2`) | §3, §4, §8 | V2-01, 05–17 |
| IA-03 (ida e volta, vetor-ouro) / RS-09 | §2, §11 | V2-01, 02, 03, 04, 30 |
| RS-10 (`dossier`, `prev`, `v1`/`v2`) | §2, §3, §4 | V2-02, 07, 10 |
| RS-15 (Ed25519 puro, interoperabilidade) | §2 | V2-28, 29 |
| RS-16 (suplente com par próprio) | §5, §6 | V2-18, 19, 25 |
| RS-20 (A sob B, `auditId` não normalizado) | §8 | V2-20, 26, 27, 31 |
| D12/D10 (sucessão por rotação, 2 ativas, revogação) | §5–§7 | V2-18 a V2-25 |
| Pergunta 12 (resultados confirmados × revogação) | §7 | V2-22, 23 |
| Plano W3 (`v1` inalterado; 1 byte em cada campo) | §9, §11 | V2-03, 06 |
