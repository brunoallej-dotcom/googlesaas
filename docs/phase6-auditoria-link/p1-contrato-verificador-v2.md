# Onda W3 — Contrato do manifesto `v2` e do verificador `v2` (produtor P1 da Auditoria por Link)

> **Status: **APROVADO pelo responsável em 17/11/2026** ("de resto pode fazer a recomendação", em resposta à recomendação do método AISAC): o **fecho de aposentadoria com hash fixado na lista** como implementação da D12, **O2** (`MAX_TRUST_KEYS = 16`, aposentadas permanecem na lista), **O6** (formato `{headSeq, headSealSha256, keyIds}` gravado no resultado, onda R2) e **O7** (`MAX_CHAIN_SEALS = 256`, `MAX_CLASSIFY_BYTES = 16 MiB`, padrão do `dossier.id`, lacuna avaliada depois do pré-passo de revogação). Registrado na spec como **D14**. O código da W3 pode começar.** Histórico: proposto em 17/11/2026, para aprovar antes do código (onda W3). Documento normativo; nenhum código, teste, spec ou outro documento foi alterado por ele. Data: 17/11/2026. Exigência do plano: `docs/plan/implementation-waves.md` ("Onda W3") e `docs/specs/link-audit-p1-attestation.md` §14 (a W3 precisa de contrato próprio **aprovado antes** de qualquer código). Linhas citadas (`arquivo:linha`) foram conferidas no código e nos documentos em `e19b96e`.
>
> **Fontes:** spec P1 `docs/specs/link-audit-p1-attestation.md` (§5.1, §5.5, §5.6, §6, §7.1, §13.1, §13.3, §16); modelo de ameaças `docs/security/threats/link-audit-p1-atestacao.md` (RS-09, RS-10, RS-15, RS-16, RS-18, RS-20, pergunta 12, ator A7); verificador atual `src/lib/link-audit-evidence/provenance.ts`; seus testes `tests/link-audit-evidence-provenance.test.ts`; ADR 6C-03 `onda6c-adr-proveniencia-evidencias.md` (fase 4); contrato P1 `onda6c-contrato-p1-atestacao.md`; runbook `onda6c-runbook-chaves.md` §4; regra de época do livro (R6-06) em `onda6c-especificacao-livro-de-cabecas.md:246`.
>
> **Decisões do responsável de 17/11/2026 codificadas aqui (registradas na spec §13.1 pela onda W0, PR #26):** **D12** — uma chave aposentada **só verifica** o passado (nunca autentica nada novo); no máximo **2** chaves assinando ao mesmo tempo (titular e suplente, D10, **cada uma com par próprio**, intercalando-se livremente enquanto ativas); rotação periódica a cada **12 meses** (com o ensaio anual de restauração) e **sobreposição de assinatura = 0**; comprometimento ⇒ `keyId` revogado na hora; custódia K1 primeiro, K2 só após o teste RS-15 e exceção escrita e isolada a RS-14.
>
> **Aprovação específica (concedida em 17/11/2026, ver Status):** o mecanismo que **implementa** o "só verifica" da D12 — o **fecho de aposentadoria** (§6) — é **novo** e o responsável ainda não o viu; ver §13. Deve ser refletido na spec (§13.1) e no runbook (§4) na aprovação (§12, §13).

---

## 1. Objetivo, não-objetivos e limite de garantia

**Objetivo.** Dar ao servidor (lado verificador) a capacidade de aceitar o manifesto `v2` de forma **aditiva** (o `v1` continua legível e inalterado) e de provar, **sem rede e sem relógio**:

1. **continuidade** — o manifesto de maior `seq` descende, por hash, de todos os anteriores (nenhum apagado, trocado ou pulado);
2. **cumulatividade** — cada manifesto atesta tudo que o anterior atestou, com os mesmos hashes;
3. **vínculo ao dossiê** — `dossier.sha256` dentro da parte assinada (spec D1; RS-10);
4. **anti-rebaixamento** — no caminho percorrido (§8-B) e em produção (`acceptedVersions = [2]`), `v1` nunca é aceito depois de um `v2` e só `v2` vale em **toda** posição; no caminho de compatibilidade (§8-A, `[1,2]` com `v1` último) **não**: `v2 v1` autentica, como o V2-16 registra;
5. **papéis de chave:** `active` assina; `retired` só verifica, e só o que um **fecho de aposentadoria fixado por hash** (assinatura como defesa adicional) cobre; `revoked` nunca vale (D12);
6. **montagem a partir de assinatura externa** (K2), com o mesmo formato bit a bit (aditivo);
7. **vetor-ouro** do formato (RS-09).

**Não-objetivos (declarados).**
- Não é o produtor: `export`/`sign` são W2/W4. A W3 entrega as primitivas puras (`provenance.ts`) e o verificador.
- Não verifica o **conteúdo** do dossiê (só o formato do hash e do `id`); a prova de que o dossiê existe e confere é humana (spec §9).
- Não usa **data** para decidir nada: `sealedAt` é escolhido por quem assina (spec §7.3; D12). Nenhuma validade por data, nenhum `Date.now()`.
- Não prova origem junto ao provedor nem atualidade (contrato P1 §1; **reversão** a um estado antigo autêntico é atualidade, RS-17).
- Não adota `entries[].source` (RS-10; spec §13.3): incluí-lo exigirá `v3`.
- Não trata aprovação assinada pelo conferente (RS-03), fingerprint da lista (RS-18) nem alerta de regressão (RS-19).
- Não altera `EvidenceToProve` (`provenance.ts:57-61`), o leitor, o coletor nem o layout das evidências.

**Quem edita a lista de chaves está FORA da garantia (declaração explícita).** Quem altera `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (ator A7 do modelo de ameaças, T-014 item 3; o RS-18, fingerprint da lista, **não** foi adotado) pode acrescentar a **própria** chave como `active`, **desfazer** uma revogação, trocar `revoked` por `retired`, **fixar outro hash de fecho** e assim fazer valer qualquer manifesto que assine. O verificador não tem como impedir isso; o controle é humano (quem escreve a lista, procedimento W5, livro de manifestos RS-17). Idem para quem substitui a **pasta** de manifestos inteira por outra coerente e antiga (atualidade).

---

## 2. Formato `v2` (exato)

Arquivo `seal-NNNN.json` (`SEAL_FILE`, `provenance.ts:31`; NNNN = `seq` assinado), JSON de um só objeto, **esquema estrito** (zod `.strict()`, como `provenance.ts:79-91`: campo desconhecido, ausente ou de tipo errado ⇒ `SEAL_INVALID`).

| Campo | Tipo / regra | Na parte assinada |
|---|---|---|
| `schemaVersion` | literal `2` | sim |
| `kind` | literal `"LINK_AUDIT_EVIDENCE_SEAL"` (`SEAL_KIND`, `provenance.ts:29`) | sim |
| `auditId` | `AUDIT_ID_PATTERN` (`types.ts:10`), **sem normalização** | sim |
| `seq` | inteiro **1…256** (`MAX_CHAIN_SEALS`); igual ao NNNN do nome do arquivo. (O `v1` segue com 1…9999, `provenance.ts:85`) | sim |
| `sealedAt` | `YYYY-MM-DDTHH:MM:SS.mmmZ` (`provenance.ts:86`). **Informativo**: o verificador não o usa para decidir | sim |
| `keyId` | `^[a-z0-9][a-z0-9-]{3,31}$` (`TRUST_KEY_ID`, `provenance.ts:33`); rótulo público | sim |
| `entries` | 1…2000 itens `{ref, contentSha256}`; `ref` ∈ `REF` (`provenance.ts:36`); `contentSha256` = 64 hex **minúsculos**; **estritamente ordenados** por `ref` (unidades de código, `provenance.ts:234`), sem repetição | sim |
| `dossier` | `{ id, sha256 }` estrito; `sha256` = 64 hex minúsculos (SHA-256 dos **bytes** do dossiê de aprovação lidos uma vez pelo `sign`, spec §5.5 passo 6); `id` = `^[a-z0-9][a-z0-9._-]{2,63}$` (rótulo curto **sem PII**) | sim |
| `prevSealSha256` | 64 hex minúsculos **ou** `null` | sim |
| `signature` | base64url **canônico** de 64 bytes (86 caracteres; decodificar e recodificar devolve a mesma cadeia, como `provenance.ts:155`) | **não** |

**O que é assinado.** `signingBytes = UTF-8(canonicalJson(corpo))`, `corpo` = arquivo **sem** `signature`; `canonicalJson` = `src/lib/link-audit/canonical.ts` (id `gmn-canonical-json-v1`, `canonical.ts:11`: chaves ordenadas, sem espaços, NFC). Assinatura **Ed25519 pura** (`crypto.sign(null, …)`/`crypto.verify(null, …)`), **sem pré-hash e sem contexto** (mesmo enquadramento do `v1`, `provenance.ts:104,235`; único compatível com K2, RS-15). Separação de domínio: `schemaVersion` e `kind` estão nos bytes assinados e o esquema é estrito.

**Maleabilidade e texto.**
- Assinatura com `S ≥ L` (ex.: `S+L`) é **recusada** (`SEAL_INVALID`). Se `crypto.verify` do Node não a recusar sozinho, a implementação confere `S < L` explicitamente; teste trava o comportamento (V2-02).
- **Chave duplicada no JSON** (`{"seq":1,"seq":2}`) é **recusada** (`SEAL_INVALID`): `JSON.parse` aceita a última em silêncio, **qualquer barra invertida `\` no texto bruto é recusada** (nenhum campo válido precisa de escape), o que torna trivial a detecção por **varredura do texto bruto** (tokenizador que registra as chaves de cada objeto, sem decodificar escapes), antes do parse; vale também para o arquivo de fecho (§6). Texto que não é UTF-8 válido (decodificação estrita) ou com BOM ⇒ `SEAL_INVALID`.
- **Todos** os campos do `v2` são ASCII por regex. **Qualquer campo futuro não-ASCII exige `v3`**: o `canonicalJson` normaliza para NFC (`canonical.ts:30,67`), então duas cadeias brutas distintas poderiam ter bytes assinados iguais.

**`sealSha256`.** `sealSha256(arquivo)` = SHA-256, hex minúsculo, de `UTF-8(canonicalJson(arquivo completo, com signature))`, calculado **depois** do parse estrito (`v1` ou `v2`). Independe de espaços, quebras de linha e ordem de chaves da cópia em disco; `schemaVersion` está dentro, logo `v1` e `v2` nunca colidem. `prevSealSha256 = sealSha256(manifesto seq-1)`; `null` **se e somente se** `seq = 1`.

**Limites:** arquivo ≤ `MAX_SEAL_BYTES` = 256 KiB (`provenance.ts:32`; leitura que estoura marca aquela posição e o veredito final é `VERIFICATION_ERROR`, sem abortar o pré-passo, §7.2); ≤ 2000 entradas; fecho ≤ `MAX_CLOSURE_BYTES` = 256 KiB e ≤ 1000 `heads` (§6); ≤ `MAX_CHAIN_SEALS` = 256 manifestos por auditoria; **orçamento total de bytes por `classify`**: `MAX_CLASSIFY_BYTES` = 16 MiB (proposto) somando manifestos e fechos lidos; estourar interrompe a leitura dos restantes (§7.2) e o veredito final é `VERIFICATION_ERROR`. **Cada arquivo é lido uma única vez por `classify`** (teste com `fs` espião).

**Primitivas puras aditivas** (não alteram `createEvidenceSeal`, `provenance.ts:101`):

| Função | Contrato |
|---|---|
| `buildEvidenceSealBodyV2(input)` | `{auditId, seq, sealedAt, keyId, entries, dossier, prevSealSha256}` → `{ body, signingBytes }`. Ordena `entries` como o `v1`; valida pelo esquema; **sem** chave |
| `assembleEvidenceSealV2(body, signature, publicKey)` | Assinatura vinda de fora (K2). **Verifica** com `crypto.verify(null, signingBytes, publicKey, …)` antes de devolver o arquivo; falha ⇒ `EvidenceSealError` tipado (`SIGNATURE_DOES_NOT_VERIFY`, sem material de chave). Nunca recebe chave privada |
| `createEvidenceSealV2(input + privateKey)` | K1: `build` + `crypto.sign` + `assemble`. Mesma chave e corpo ⇒ arquivo **idêntico bit a bit** ao do caminho externo (Ed25519 é determinístico) |
| `sealSha256(arquivo)` | como acima; `v1` e `v2` |
| `buildKeyRetirementClosureBody` / `assembleKeyRetirementClosure` / `createKeyRetirementClosure` | análogas, para o fecho (§6) |

---

## 3. Semântica cumulativa e continuidade

Seja `N` o maior `seq` (SEAL_FILE) da pasta `<sealsDir>/<auditId>/`. Quando a cadeia é percorrida (último `v2`, ou política `acceptedVersions = [2]`), o verificador lê **todos** os `seal-0001 … seal-N` (isto **estende** a spec §5.6 item 2, que previa só o antecessor; ver §12-C1) e exige, para cada posição `i`:

1. o arquivo é regular (não link, não diretório), parseia pelo esquema da sua `schemaVersion`, tem `auditId` igual ao pedido, `seq` igual ao nome, `entries` ordenadas e sem repetição; **entrada ilegível** (não-JSON, vazia, diretório, link, I/O) ⇒ falha fechada;
2. a **assinatura** confere com a pública do `keyId` na lista (§5); `keyId` ausente da lista ⇒ `SEAL_INVALID` (§12-C3);
3. **continuidade (7b):** para `i ≥ 2` e manifesto `v2`, `sealSha256(i-1) = prevSealSha256(i)`; `i = 1` exige `prev = null`; `seq>1` com `prev=null`, lacuna de numeração ou incoerência ⇒ `SEAL_CHAIN_BROKEN` (a lacuna é regra de nomes mas é julgada aqui, **depois** do pré-passo de revogação, §8). **Nomes (7a, antes de qualquer leitura):** só `seal-0000` e `N > 256` ⇒ `SEAL_CHAIN_BROKEN`;
4. **cumulatividade:** para todo par adjacente, `entries(i-1) ⊆ entries(i)` com os **mesmos** `contentSha256`; senão `SEAL_NOT_CUMULATIVE`. `entries(i) = entries(i-1)` é permitido.

Depois disso a cobertura **bidirecional atual permanece, sobre o último** (`provenance.ts:236-247`): base ⊆ manifesto (`EVIDENCE_NOT_SEALED`, `EVIDENCE_HASH_MISMATCH`) e manifesto ⊆ base (`EVIDENCE_MISSING`, `missingRefs` ≤ 5). A `v2` **acrescenta**; não afrouxa nada. Regra herdada: o de **maior `seq`**; se não valer, **não se recua** (`provenance.ts:226`).

---

## 4. Anti-rebaixamento e versões aceitas

1. **Monotonia.** Em qualquer pasta, a sequência de versões por `seq` é `v1* v2*`. **Todo `v1` com `seq` maior que o de algum `v2` ⇒ `SEAL_DOWNGRADE`** (cobre `v2 v1 v2`), mesmo com assinatura válida. Aplica-se no **caminho percorrido** (§8-B), que lê **todos** os arquivos: um que declara `schemaVersion: 2` mas é inválido **conta** como `v2`; arquivo ilegível ⇒ falha fechada. No caminho de compatibilidade (§8-A, `v1` último com `[1,2]`) **não há** varredura.
2. **`acceptedVersions` vale para TODA posição, não só a última.** `SealedEvidenceOptions` ganha `acceptedVersions: readonly (1 | 2)[]`. Com `[2]` (modo produção) a cadeia é **sempre percorrida** (§8, caminho B) e **qualquer** `v1` em qualquer posição, inclusive o último ⇒ `SEAL_VERSION_NOT_ALLOWED`. Valor `[]`, desconhecido (`[3]`) ou repetido (`[2,2]`) ⇒ política fechada `PROOF_NOT_CONFIGURED`. Com `[1]` (emula o verificador antigo), `v2` ⇒ `SEAL_INVALID`.
3. **Padrão de biblioteca `[1,2]`** — mantido **só** para os testes do `v1` passarem sem alteração (`tests/link-audit-evidence-provenance.test.ts:108,489`; critério do plano). **Limite declarado do modo `[1,2]`:** com `v1` último vale **exatamente** o comportamento de hoje (§8, caminho A, sem percorrer a cadeia): se o signatário do `v1` for uma chave `active`, apagar o `v2` abaixo ainda autentica (um `v1` de chave `retired` ou `revoked` é recusado pelo status, §9); só o `[2]` fecha o caso. Portanto **não** se afirma que a monotonia "compensa" o padrão. **Exigência (teste estático V2-19):** todo chamador de `createSealedEvidenceProvenance`/`evidenceProvenanceFromConfig` **fora de `tests/`** passa `acceptedVersions` **explicitamente** — produção `[2]` (`shared.ts:92`), **inclusive o autoteste do `sign`** (W4). O `v1` só por opção explícita de homologação.
4. **Ordem de implantação** (spec §5.6 item 1): o verificador `v2` precisa estar **implantado antes** de qualquer `v2` ser entregue e de qualquer lista com status ou fecho, porque o verificador antigo recusa `v2` e itens de 3 partes (`provenance.ts:170`, política fechada).
5. O produtor (W4) **nunca** emite `v1` (spec §5.1).

---

## 5. Lista de chaves de confiança: formato (retrocompatível) e papéis

Variável `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (runbook §4; `provenance.ts:165`). **Novo formato (superconjunto):**

```
<id>:<pública base64url 43>                         ⇒ active   (formato antigo, 2 partes)
<id>:<pública>:active | :revoked
<id>:<pública>:retired                              ⇒ aposentada SEM fecho fixado: suas assinaturas NUNCA contam
<id>:<pública>:retired:<closureSha256>              ⇒ aposentada com o fecho FIXADO por hash (64 hex minúsculos), §6
```

| Status | Autentica manifesto novo? | Conta no limite de 2? |
|---|---|---|
| `active` | sim (titular e suplente se intercalam: `A S A` vale) | **sim** (no máximo 2) |
| `retired` | **nunca por si.** Só vale a posição que o **fecho fixado** (§6) cobre; sem hash fixado, as assinaturas **nunca** contam | não |
| `revoked` | nunca; posição assinada por ela (assinatura conferida, no `auditId` pedido) ⇒ `SEAL_KEY_REVOKED` (§7) | não |

**Validade da lista** (qualquer violação invalida **tudo** ⇒ `PROOF_NOT_CONFIGURED`, como `provenance.ts:260-262`): item com 2 ou 3 partes, ou 4 partes **somente** com `retired` e hash de 64 hex minúsculos (5 partes, `revoked:x`, `active:x`, `retired:<não-hex>`, hash em maiúsculas ⇒ inválido); status fora de `active|retired|revoked`, em maiúsculas ou com espaços; item vazio / vírgula final; `id` ∈ `TRUST_KEY_ID`; pública aceita por `publicKeyFromRaw` (recusa ordem pequena, `provenance.ts:152-162`); `id` repetido; **a mesma pública sob dois `id`** (RS-16: suplente com par **próprio**, nunca cópia); mais de **2** `active`; mais de `MAX_TRUST_KEYS` = 16 itens (§13-O2). **Zero** `active` é lista **válida** (nada novo autentica; fechos fixados e sinais de revogação continuam funcionando). Lista antiga (2 partes) = todas `active`; com mais de 2 entradas passa a ser fechada (nenhuma lista de produção existe, ADR 6C-03 §5).

API: `parseTrustKeyring(raw)` → `ReadonlyMap<id, {key, status, closureSha256}> | null`. **`parseTrustKeys` (`provenance.ts:165`) não muda.** A opção `trustedKeys` (Map, tudo `active`) é **restrita a testes** (teste estático V2-19); `keyring` é a opção de produção; **ambas juntas ⇒ `PROOF_NOT_CONFIGURED`**. `evidenceProvenanceFromConfig` passa a usar `parseTrustKeyring`.

---

## 6. Fecho de aposentadoria fixado por hash ("só verifica", D12)

**Problema que resolve.** Uma regra de "o sucessor já assinou" **não** impede que `retired` aja como `active` para quem ainda tenha a privada: ela assinaria `seal-0001…k` de um `auditId` **novo**; a cadeia `R1 R2 S3` pode ser **truncada** e reassinada; uma lista com zero `active` ainda autenticaria auditorias novas. E um fecho **só assinado** não basta: duas aposentadas sobreviventes assinariam fechos uma para a outra; quem escreve a pasta troca o fecho por outro válido (rascunho, versão antiga, o de outra chave ativa); revogar o signatário derrubaria todo o histórico de `R` sem caminho de reemissão. Por isso o fecho é **fixado na lista** por hash.

**Arquivo.** `<sealsDir>/_closures/<R>.json` (nome que `AUDIT_ID_PATTERN` não casa, logo nunca colide com um `auditId`; o diretório é verificado com `lstat` **sem seguir link**, tem de ser diretório real, e o arquivo tem de ser regular; fecho de id que **não** está `retired` é **ignorado**):

```jsonc
{ "schemaVersion": 1, "kind": "LINK_AUDIT_KEY_RETIREMENT_CLOSURE",
  "retiredKeyId": "<R>", "signerKeyId": "<S>", "sealedAt": "…Z",         // sealedAt informativo
  "heads": [ { "auditId": "…", "seq": 1..256, "sealSha256": "<hex64>" } ],   // 0…1000 itens; estritamente ordenados por auditId; um por auditoria
  "signature": "<base64url 86 canônico>" }
```

Mesmo esquema estrito, enquadramento de assinatura e canonicalização do §2; limite `MAX_CLOSURE_BYTES` = 256 KiB (1000 itens ≈ 175 KB; 2000 estourariam). Lido **uma vez**, no orçamento do §2.

**Autoridade = o hash fixado.** O verificador exige **SHA-256 dos bytes do arquivo de fecho exatamente como lidos** (não canônico) **igual** ao `closureSha256` do item `retired` da lista. Lista sem hash, arquivo ausente/ilegível/de outro tipo, hash diferente ⇒ as assinaturas de `R` **nunca contam**. Isso elimina emissão nova, troca do arquivo, retrocesso a versão antiga e "dois fechos". **Reemissão = refixar o hash na lista após conferência independente** (quem edita a lista já está fora da garantia, §1).

**Assinatura do fecho = defesa em profundidade, não a âncora.** Depois do hash, o verificador confere o esquema, `retiredKeyId` = nome do arquivo, `signerKeyId ≠ R`, `signerKeyId` presente na lista (**qualquer** status) e a assinatura com a pública dele. **Se o item do signatário for removido da lista** (p.ex. no teto de 16 itens), a assinatura do fecho **não pode mais ser conferida**: isso degrada **só** a defesa em profundidade; o hash fixado segue como autoridade e o histórico **não cai** (o teste V2-47 trava isto; remover o item do signatário continua sendo mudança a evitar, O2). Fechos devem ser entregues **byte a byte** idênticos ao que foi fixado (nota para o runbook: nenhuma reformatação, conversão de fim de linha ou recompressão). **Se o signatário for depois revogado, o histórico NÃO cai**: o hash fixado é a autoridade e a assinatura continua conferindo com a pública que permanece na lista. O id do signatário entra em `keyIds` do resultado `AUTHENTICATED` (§7.3), de modo que a interseção com ids revogados marca os resultados para revisão humana, sem invalidar nada em silêncio. (Signatário revogado = a conferência que levou à fixação deve ser refeita: reemitir e refixar.)

**Regra.** Uma posição assinada por `R` (`retired`) vale **somente se**: o fecho está fixado e confere (acima); `heads` contém a auditoria, com `seq_cabeça`; `seq(posição) ≤ seq_cabeça`; **a cadeia contém o manifesto `seq_cabeça`** e o `sealSha256` dele é igual ao do fecho. Como o `v2` encadeia por hash, isso prende **todas** as posições ≤ cabeça. Posição `v1` de `R` **nunca** é coberta. Tudo o mais assinado por `R` ⇒ `SEAL_KEY_RETIRED_UNCOVERED` (auditorias novas, extensões depois da cabeça, truncamento seguido de reassinatura, retrocesso a posição anterior à cabeça, aposentada sem hash fixado). Posições posteriores à cabeça assinadas por `active` são normais; `A S A` entre ativas vale. A regra de época/sucessão foi retirada (§13.1).

**Procedimento (W5/runbook), nesta ordem:** (1) **`R` para de assinar**; (2) as `heads` vêm do **registro EXTERNO** de recibos/livro de manifestos (RS-17), **nunca** da pasta do servidor; (3) o comando de fecho (escopo W4) lista as cadeias assinadas por `R` presentes no servidor e **ausentes do registro externo** como `UNKNOWN_SEAL_ON_SERVER` e **não** as cobre; (4) uma chave `active` `S ≠ R` (o sucessor, ou o titular remanescente quando o suplente é desativado) assina o fecho, offline; (5) o fecho é entregue e o **hash é fixado** na lista (`retired:<closureSha256>`) — sem fixação `R` não conta; (6) **destruir TODAS as cópias da privada de `R`, inclusive o backup cifrado de D10**, com **registro**; (7) **qualquer dúvida** ⇒ `revoked`, **nunca** `retired`. Rotação periódica: 12 meses. A W3 entrega só as primitivas e o verificador (§2).

**Residual honesto.** (a) **Reversão** da pasta a um estado antigo **autêntico** (atualidade, RS-17; a perda do manifesto da cabeça de auditoria fechada já é detectada); (b) **quem edita a lista** (inclui fixar outro hash, §1). Quem ainda possua a privada de `R` **não** consegue mais autenticar nada novo com ela.

---

## 7. Comprometimento, revogação e o sinal para o histórico (pergunta 12)

1. **Efeito imediato:** o `keyId` passa a `revoked` na lista (o item **permanece**, com a pública). **Remover** o item não é revogação: item ausente ⇒ `SEAL_INVALID` (fail-closed, sem o sinal).
2. **Pré-passo de revogação (antes de continuidade, cumulatividade e fecho):** o verificador lê cada arquivo **uma vez**, **tolerando falha por arquivo** (arquivo > 256 KiB, erro de E/S, não regular, ilegível: aquela posição é marcada e a leitura **continua**; só o estouro do orçamento de bytes interrompe a leitura dos restantes), verifica a assinatura de cada posição **independentemente** e calcula `revokedKeyIds` = `keyId` de toda posição cuja assinatura **confere** sob chave `revoked` **e** cujo corpo tem `auditId` igual ao **pedido** e `seq` igual ao do **nome do arquivo** (uma cópia do manifesto de outra auditoria `Y` na pasta de `X` **não** gera sinal: ninguém fabrica o sinal). Se não vazio, a razão é **`SEAL_KEY_REVOKED`**, com precedência sobre as linhas seguintes da §8, e `revokedKeyIds` (≤ 2 ids públicos, sem PII) é devolvido em **qualquer** `UNAUTHENTICATED` produzido depois da leitura. **Residuais declarados:** (i) o sinal não sai quando **nada** foi lido (pasta apagada ⇒ `NO_SEAL`; `seal-0000` ou `N > 256`, que não leem por custo); (ii) arquivos não lidos por estouro do orçamento não são examinados. Ambos só são aceitáveis com o **GATE** do item 3.
3. **GATE antes do primeiro resultado de produção (onda R2 do plano, definida no PR da W0, `docs/plan/implementation-waves.md` na branch `docs/link-audit-p1-w0`, ainda não integrado à `main`; não é "onda posterior" opcional):** (a) o resultado confirmado **grava** `{headSeq, headSealSha256, keyIds}` devolvidos em `AUTHENTICATED` pelo caminho `v2` (`keyIds` = ids distintos e ordenados das chaves das posições, **mais** o signatário do fecho usado); a marcação posterior é a **interseção** dos `keyIds` gravados com os ids revogados de hoje (ADR 6C-03 fase 4; muda o formato persistido, nova rodada de aprovação); (b) **qualquer `UNAUTHENTICATED` ao reler um resultado já confirmado vai a revisão humana**. Sem R2 os residuais (i) e (ii) não são aceitos. Nada é reescrito nem invalidado em silêncio: o verificador só devolve códigos e campos; o consumidor sinaliza. Fora do código da W3.
4. **Recuperação (recomendação; o responsável aprova):** a cadeia com posição de chave revogada **não volta a autenticar** por manifesto novo (a continuidade por hash a mantém), **enquanto ninguém substituir a pasta**; a reabilitação é **nova coleta sob novo `auditId`** por fonte independente, mesma filosofia da D3; sem `v3` de reatestação (§13.1).
5. **Intervalo comprometimento → revogação:** manifestos forjados nele são indistinguíveis (limite declarado).

---

## 8. Modos de falha (todo caso malformado/adversarial ⇒ `UNAUTHENTICATED`; `classify` **nunca lança**)

**Dois caminhos, escolhidos de forma explícita.** (A) **Caminho de compatibilidade:** `acceptedVersions` = `[1,2]` e o último manifesto é `v1` ⇒ comportamento **exatamente igual ao de hoje** (`provenance.ts:226-248`): sem percorrer a cadeia, sem varredura de versões; só se acrescentam o **status** do signatário (`revoked` ⇒ `SEAL_KEY_REVOKED`; `retired` ⇒ `SEAL_KEY_RETIRED_UNCOVERED`, o `v1` nunca é coberto) e a resposta continua exatamente `{status:'AUTHENTICATED'}`; os testes do `v1` significam o que significavam. (B) **Caminho percorrido:** último `v2`, **ou** `acceptedVersions = [2]` (qualquer último), **ou** `[1,2]` cujo arquivo **mais recente** é ilegível ou tem `schemaVersion` fora de {1,2} (falha fechada, preservando o sinal de revogação): aplicam-se as linhas 4 a 14 abaixo, lendo e julgando **todos** os arquivos.

| # | Situação | Razão |
|---|---|---|
| 1 | política fechada / lista inválida (§5) / `acceptedVersions` inválido / `keyring` e `trustedKeys` juntos; pasta de manifestos sobreposta a outra pasta de dados (inclusive link simbólico) | `PROOF_NOT_CONFIGURED` |
| 2 | `auditId` fora de `AUDIT_ID_PATTERN` (sem normalizar), base vazia | `NO_SEAL` |
| 3 | pasta ausente/vazia (legado ⇒ `LEGACY_NO_SEAL`); pasta é link/não-diretório | `NO_SEAL` / `LEGACY_NO_SEAL` / `SEAL_INVALID` (como `provenance.ts:215-225`) |
| 4 | **(7a, só nomes, zero leituras)** existe `seal-0000` ou `N > 256` | `SEAL_CHAIN_BROKEN` |
| 5 | leitura única de todos os arquivos e fechos **tolerante a falha por arquivo** (sem veredito; §7.2) | — |
| 6 | **pré-passo de revogação** (§7.2) | `SEAL_KEY_REVOKED` (+`revokedKeyIds`) |
| 7 | falha de leitura em algum arquivo (> 256 KiB, E/S, orçamento de 16 MiB estourado) | `VERIFICATION_ERROR` |
| 8 | último ou qualquer posição: não-JSON, vazia, diretório, link, **`\` no texto**, chave duplicada, esquema estrito, `auditId`≠, `seq`≠nome, `keyId` fora da lista, assinatura inválida/não canônica/`S ≥ L`, `entries` desordenadas | `SEAL_INVALID` |
| 9 | monotonia: `v1` com `seq` maior que algum `v2` | `SEAL_DOWNGRADE` |
| 10 | `acceptedVersions` não inclui a versão de **alguma** posição (para `v2` com `[1]`, linha 8) | `SEAL_VERSION_NOT_ALLOWED` |
| 11 | **(7b)** lacuna; `prev` ≠ hash do antecessor; `seq=1` com `prev`≠null; `seq>1` com `prev=null` | `SEAL_CHAIN_BROKEN` |
| 12 | `entries(i-1) ⊄ entries(i)` ou hash diferente | `SEAL_NOT_CUMULATIVE` |
| 13 | posição de chave `retired` fora de fecho fixado e válido (§6) | `SEAL_KEY_RETIRED_UNCOVERED` |
| 14 | base com evidência fora do manifesto / hash diferente / manifesto com evidência ausente | `EVIDENCE_NOT_SEALED` / `EVIDENCE_HASH_MISMATCH` / `EVIDENCE_MISSING` (+`missingRefs` ≤ 5) |
| 15 | qualquer outra exceção | `VERIFICATION_ERROR` |

A lacuna (linha 11) é regra de **nomes**, mas é avaliada **depois** do pré-passo para não suprimir o sinal; só `seal-0000` e `N > 256` (linha 4) falham sem ler. Leitura sem seguir link e sem travar em FIFO, como hoje. Razões são códigos fixos, nunca dados do arquivo.

**Novos valores de `EvidenceTrustReason`** (6, aditivos; os 8 atuais, `provenance.ts:41-49`, não mudam):

| Valor | Significado |
|---|---|
| `SEAL_CHAIN_BROKEN` | Cadeia por hash não fecha: antecessor ausente/trocado, lacuna, `prev` incoerente com `seq`, `seal-0000`, mais de 256 |
| `SEAL_NOT_CUMULATIVE` | Um manifesto omite ou muda a entrada de um anterior |
| `SEAL_DOWNGRADE` | Um `v1` aparece depois de um `v2` |
| `SEAL_VERSION_NOT_ALLOWED` | A política (produção: só `v2`) não aceita a versão de alguma posição |
| `SEAL_KEY_RETIRED_UNCOVERED` | Posição de chave aposentada que nenhum fecho fixado por hash cobre: aposentada só verifica o que o fecho congelou |
| `SEAL_KEY_REVOKED` | A cadeia tem assinatura autêntica, deste `auditId`, de chave revogada: não vale para nova finalização e o histórico confirmado com ela exige revisão humana |

`EvidenceTrust` (`provenance.ts:51-54`) ganha, aditivamente: `revokedKeyIds?: readonly string[]` em `UNAUTHENTICATED`; e `headSeq`, `headSealSha256`, `keyIds` em `AUTHENTICATED` **somente no caminho `v2`**. O caminho `v1` devolve **exatamente** `{ status: 'AUTHENTICATED' }` (o teste existente `tests/link-audit-evidence-provenance.test.ts:121` usa `deepEqual`).

---

## 9. `v1` continua legível e inalterado

- `sealBodySchema`/`sealFileSchema` do `v1`, `createEvidenceSeal`, `parseTrustKeys`, `publicKeyFromRaw`, `isWeakEd25519PublicKey`, `EvidenceToProve` e os 8 motivos atuais **não mudam**. `tests/link-audit-evidence-provenance.test.ts` passa **sem alteração** (`git diff --quiet origin/main -- tests/link-audit-evidence-provenance.test.ts`, critério do plano).
- Último `v1` com `acceptedVersions` padrão `[1,2]`: caminho de hoje (`provenance.ts:226-248`), **sem** leitura de cadeia nem varredura de versões, resposta exatamente `{status:'AUTHENTICATED'}`. Acrescenta-se só o **status** do signatário: `revoked` ⇒ `SEAL_KEY_REVOKED`; `retired` ⇒ `SEAL_KEY_RETIRED_UNCOVERED` (o `v1` nunca é coberto por fecho). Mesmo caminho A do §8. Lista antiga = todas `active`: sem efeito sobre os testes atuais.
- Lista antiga com ≤ 2 chaves continua válida e equivale a `active`.

---

## 10. O que NÃO muda e escopo ampliado da W3

Não mudam: coletor, formato das capturas, `EvidenceToProve`, leitor (`scoring-basis.ts`), `preview.ts` (só repassa `reason`, `preview.ts:299`), resultados, livro, `stack.yml`, volumes, `canonicalJson`. Nenhum import novo em `provenance.ts` (só `node:crypto`, `node:path`, `zod`, módulos já importados); nenhuma rede.

**Escopo ampliado (decidido pelo responsável em 17/11/2026; o plano de ondas será atualizado):** a W3 **deixa de ser só `provenance.ts`** e passa a incluir, de forma aditiva: (a) `src/components/link-audit/audit-page/labels.ts:79-85` (`PROVENANCE_REASON_LABELS`) e `validators.ts:97` (`PROVENANCE_REASONS`, que valida o DTO da prévia e pode **rejeitar** razão nova) com os 6 motivos novos; (b) `src/app/api/link-audit/scoring/shared.ts:92`: `acceptedVersions: [2]` explícito e uso de `keyring` (aceitar `v1` só por opção explícita de homologação); (c) a **edição do runbook** `onda6c-runbook-chaves.md` §4 (§12-C3). O registro de `{headSeq, headSealSha256, keyIds}` nos resultados **não** entra na W3 (§7.3).

---

## 11. Vetor-ouro (RS-09) e testes

**Exigências do vetor** (arquivo de teste próprio; módulo importável pelo W4 para a paridade com o artefato do `sign`, IA-03/IA-24):
1. **Chave de teste determinística**: semente de 32 bytes fixa em hex, de teste, **nunca** PEM/PKCS#8 em texto (evita gitleaks), montada em memória, nunca usada fora dos testes.
2. **Valores gerados por rota independente do código sob teste** (ex.: `openssl pkeyutl -sign -rawin` e SHA-256 externo), revisados na PR; os testes **só leem** os valores.
3. Vetores: **G1** `v2` `seq=1`, `prev=null` (corpo, bytes canônicos em hex, assinatura, `sealSha256`); **G2** `v2` `seq=2` com `prev = G1.sealSha256`; **G3** continuação com **outra** chave; **G4** `v1` de não regressão; **G5** sonda de `canonicalJson` (chaves fora de ordem, NFD/NFC, números, aninhamento); **G6** fecho de aposentadoria cobrindo G1–G2, travando os **bytes exatos do arquivo de fecho** e o **`closureSha256` fixado** (a autoridade é o hash dos bytes brutos, **não** da forma canônica), além do corpo canônico, hex e assinatura.
4. Os testes recalculam `canonicalJson`, comparam **byte a byte** com o hex, verificam a assinatura com a pública bruta no formato da lista, verificam `sealSha256`, passam pelo **verificador**, e falham com 1 byte alterado em cada campo.
5. **Mudou `canonicalJson`, o esquema ou o enquadramento da assinatura ⇒ novo `schemaVersion`.** Nunca regravar o vetor para "consertar" o teste.

**Testes de aceite** (cada um escrito **antes** do código e visto falhar; `tests/link-audit-evidence-provenance-v2*.test.ts`; os nomes citam os IDs, pois o *goal command* faz `grep` de `IA-21` e `RS-20`).

| ID | Verifica | Mapeia |
|---|---|---|
| V2-01 | `v2` válido (cadeia de 1) de `createEvidenceSealV2` é `AUTHENTICATED` com a pública derivada, evidências de `readScoringBasis`; resposta traz `headSeq`, `headSealSha256`, `keyIds` | IA-03, IA-21 |
| V2-02 | Esquema estrito: campo extra/faltando, tipos, `seq` 0 / 257 / 9999, refs desordenadas/repetidas, hash em maiúsculas, `dossier` malformado, assinatura de tamanho errado ou não canônica, **`S+L` recusada**, **chave JSON duplicada**, UTF-8 inválido, BOM ⇒ `SEAL_INVALID` | RS-09, RS-10 |
| V2-03 | Matriz de 1 byte: `contentSha256`, `ref`, `signature`, `seq`, `keyId`, `sealedAt`, `dossier.id`, `dossier.sha256`, `prevSealSha256`, `auditId` ⇒ `UNAUTHENTICATED`; reassinado com chave válida e `prev` errado ⇒ `SEAL_CHAIN_BROKEN` | IA-03(a–c), RS-09 |
| V2-04 | 1 byte no arquivo de evidência ⇒ `EVIDENCE_HASH_MISMATCH` | IA-03(d), IA-21 |
| V2-05 | Cobertura bidirecional: omite evidência presente ⇒ `EVIDENCE_NOT_SEALED`; lista ausente ⇒ `EVIDENCE_MISSING` (≤ 5) | IA-21 |
| V2-06 | Suíte do `v1` inalterada (diff vazio); `v1` último ainda `AUTHENTICATED` com `deepEqual {status:'AUTHENTICATED'}` | plano W3, IA-21 |
| V2-07 | `[1]` recusa `v2` (`SEAL_INVALID`); o esquema `v1` literal recusa `schemaVersion: 2` | IA-21, RS-10 |
| V2-08 | Cadeia `1→2→3` válida ⇒ `AUTHENTICATED` | IA-21 |
| V2-09 | Antecessor ausente, lacuna (`0001`,`0003`), `seq=2` sem `0001` ⇒ `SEAL_CHAIN_BROKEN` | IA-21 |
| V2-10 | Antecessor trocado por **outro manifesto válido**, ou com 1 byte mudado ⇒ `SEAL_CHAIN_BROKEN`/`SEAL_INVALID` | IA-21, RS-10 |
| V2-11 | `seq=1` com `prev≠null`; `seq>1` com `prev=null` (reassinados) ⇒ `SEAL_CHAIN_BROKEN` | IA-21 |
| V2-12 | Omite/muda entrada do antecessor ⇒ `SEAL_NOT_CUMULATIVE`, também em par **intermediário** | IA-21, IA-08 |
| V2-13 | Rasselagem com `entries` iguais ou ⊋ é aceita | IA-08 |
| V2-14 | `sealSha256` e autenticação independem de formatação/ordem de chaves; `v1` e `v2` de mesmo conteúdo lógico têm hashes diferentes | §2 |
| V2-15 | Nome ≠ `seq` assinado ⇒ `SEAL_INVALID`; nomes fora de `SEAL_FILE` (caixa) ignorados e não preenchem lacuna | IA-07, IA-21 |
| V2-16 | **Monotonia (caminho percorrido):** `[2]` com `v2 v1` (`v1` último) e com **`v2 v1 v2`** (`v1` bem assinado) ⇒ `SEAL_DOWNGRADE`; `v2 v1` com `[1,2]` ⇒ caminho A (`AUTHENTICATED`, limite declarado, o teste o **registra**) | IA-21 |
| V2-17 | `[2]` com `v1` em qualquer posição **sem `v2` antes dele** (cadeia só `v1`, prefixo `v1 v1 v2`) ⇒ `SEAL_VERSION_NOT_ALLOWED`; `v1` **depois** de um `v2` (no meio ou último) ⇒ `SEAL_DOWNGRADE` (linha 9 antes da 10); `[1,2]` aceita `v1…v2` (promoção, elo por `sealSha256`) | IA-21 |
| V2-18 | `v1` último com `[2]`: o `v2` abaixo **apagado** ⇒ `SEAL_VERSION_NOT_ALLOWED`; **substituído** por não-JSON / vazio / diretório / link ⇒ `SEAL_INVALID` (linha 8 antes das 9–10); erro de E/S ⇒ `VERIFICATION_ERROR`; com `[1,2]` o caminho A **não olha** os arquivos abaixo (comportamento de hoje; o teste o **registra**); `v1` último de chave `retired`/`revoked` com `[1,2]` ⇒ `SEAL_KEY_RETIRED_UNCOVERED`/`SEAL_KEY_REVOKED` | M3, N5 |
| V2-19 | `acceptedVersions` `[]`, `[3]`, `[2,2]` ⇒ `PROOF_NOT_CONFIGURED`; `keyring` + `trustedKeys` juntos ⇒ `PROOF_NOT_CONFIGURED`; **teste estático:** todo chamador fora de `tests/` passa `acceptedVersions` explícito (produção `[2]`) e nenhum usa `trustedKeys` | M3 |
| V2-20 | Lista: 2 partes = `active`; `:active`/`:retired`/`:revoked`/`:retired:<hex64>`; **malformadas ⇒ fechada:** 5 partes, `revoked:x`, `active:x`, `retired:x` (não-hex), `retired:<HEX64 em maiúsculas>`, status em maiúsculas, espaços, vírgula final, item vazio, `id` repetido, **mesma pública sob dois `id`**, > 2 `active`, > 16 itens; `parseTrustKeys` antigo inalterado; zero `active` é válida | RS-16, RS-18 (limite), D12 |
| V2-21 | Entre ativas: `A S A` e `S A S` ⇒ `AUTHENTICATED` | D10, D12 |
| V2-22 | **(a)** chave `retired` assina `seal-0001…k` de `auditId` **novo** com `[2]` ⇒ `SEAL_KEY_RETIRED_UNCOVERED` (mesmo com fecho existente para outras auditorias) | B1(a) |
| V2-23 | **(b)** cadeia `R1 R2 S3` com fecho (cabeça 3): apagar o 3 ⇒ falha; apagar o 3 e `R` assinar 3' ⊇ entradas do 2 ⇒ `SEAL_KEY_RETIRED_UNCOVERED`; retroceder a `R1 R2` ⇒ idem | B1(b) |
| V2-24 | **(c)** lista com **zero** `active` e só `retired`: auditoria nova ⇒ `SEAL_KEY_RETIRED_UNCOVERED`; auditoria **coberta** por fecho, cadeia intacta ⇒ `AUTHENTICATED` | B1(c) |
| V2-25 | Fecho fixado: `retired` **sem hash fixado** ⇒ assinaturas não contam; **hash fixado ≠ SHA-256 dos bytes do arquivo** (1 byte, reformatação do JSON, `heads` editado) ⇒ idem; arquivo ausente, diretório, link, > 256 KiB ⇒ idem; esquema, `retiredKeyId`≠nome, `signerKeyId = R`, assinatura inválida com o signatário **presente** na lista ⇒ idem (signatário **fora** da lista: a conferência da assinatura é omitida e o hash fixado decide, §6 e V2-47 — correção de 19/11/2026 de uma célula que contradizia o §6); `R` como **último** signatário dentro da cabeça ⇒ `AUTHENTICATED`; posição `v1` de `R` nunca coberta; extensão por `S`/`A` depois da cabeça autentica | D12, §6 |
| V2-26 | **Signatário do fecho depois `revoked`, com hash fixado válido** ⇒ o histórico **continua** `AUTHENTICATED` (a fixação é a autoridade) e o id do signatário aparece em `keyIds`; fecho de id que não está `retired` é ignorado; `_closures` como link simbólico/arquivo ⇒ fecho ignorado (assinaturas de `R` não contam) | N1, N6 |
| V2-27 | `revoked` em qualquer posição ⇒ `SEAL_KEY_REVOKED` + `revokedKeyIds`; arquivo com `keyId` revogado e assinatura **inválida** ⇒ `SEAL_INVALID` sem o sinal | D12, pergunta 12 |
| V2-28 | **Precedência (M1):** posição autêntica de chave revogada **e** último corrompido / lacuna / não cumulativo / cadeia quebrada / `v1` rebaixado ⇒ `SEAL_KEY_REVOKED` com `revokedKeyIds`; pasta apagada ⇒ `NO_SEAL` sem sinal (limite declarado) | M1 |
| V2-29 | Revogação não toca o histórico: `fs` espião prova leituras só em `<sealsDir>/<auditId>` e `_closures`, **zero escritas**; a prévia repassa `reasonCode = SEAL_KEY_REVOKED` sem alterar resultado gravado | pergunta 12 |
| V2-30 | `keyId` desconhecido em qualquer posição, ou item removido da lista (não revogado) ⇒ `SEAL_INVALID` | D12 |
| V2-31 | Orçamento e leitura única: `N > 256` ou `seal-0000` ⇒ `SEAL_CHAIN_BROKEN` com **zero leituras** (`fs` espião); cada arquivo lido **exatamente uma vez**; estouro de `MAX_CLASSIFY_BYTES` ⇒ `VERIFICATION_ERROR` | m2, m5 |
| V2-32 | Entradas ilegíveis em posição qualquer (não-JSON, vazia, diretório, link simbólico, FIFO, > 256 KiB, erro de E/S, exceção forçada) ⇒ `UNAUTHENTICATED` com razão fixa, sem lançar, sem travar | IA-13, RS-20 |
| V2-33 | Manifesto e evidências de A sob B ⇒ `SEAL_INVALID`/`EVIDENCE_*`, nunca `AUTHENTICATED` | RS-20, IA-06(1) |
| V2-34 | `auditId` não normalizado (maiúsculas, espaços, `../`, `%2e%2e`, barra final, Unicode, `body.auditId` com caixa diferente) ⇒ `NO_SEAL`/`SEAL_INVALID`, **sem acesso ao `fs`** para os malformados | RS-20 |
| V2-35 | Nada decide por data: `sealedAt` retrodatado/adiantado/fora de ordem não muda o veredito; `Date`/`Date.now` armadilhados não são chamados | D12, RS-20 |
| V2-36 | Montagem externa: `signingBytes` assinados por "dispositivo simulado" ⇒ arquivo **idêntico bit a bit** ao do K1; assinatura errada/de outra chave ⇒ `EvidenceSealError`, nada devolvido; vale também para o fecho | D5, RS-15 |
| V2-37 | Interoperabilidade (RS-15): assinatura Ed25519 pura gerada **fora do Node** (OpenSSL) sobre `signingBytes` verifica com `crypto.verify(null, …)` e a pública no formato da lista | RS-15, IA-22 |
| V2-38 | Vetores-ouro G1–G6 (§11) | RS-09, IA-03 |
| V2-39 | Herdados reexecutados com `v2`: pasta de manifestos como link/FIFO/sobreposta a outra pasta falha fechada | R3-MINOR-6 |
| V2-40 | Consumidores: rótulo e validador de DTO aceitam os 6 motivos novos; `typecheck` passa; `EvidenceToProve` inalterado | §10 |
| V2-41 | Isolamento: o grafo de imports de `provenance.ts` não ganha dependência nem rede (teste estático) | IA-05 (espírito) |
| V2-42 | **N1:** **troca** do fecho por outro fecho válido (rascunho, versão antiga, o de outra chave ativa) ⇒ hash não confere ⇒ `SEAL_KEY_RETIRED_UNCOVERED`; **retrocesso** do arquivo a versão antiga ⇒ idem; **dois fechos** (`_closures/R.json` e outro nome/versão) ⇒ só vale o fixado; **duas aposentadas sobreviventes** assinando fechos uma para a outra, sem hash fixado ⇒ nada conta (B1 com duas chaves) | N1 |
| V2-43 | **N3:** manifesto da auditoria `Y` (assinado por `K` revogada) copiado para a pasta de `X` ⇒ **sem** `revokedKeyIds` (corpo com `auditId`≠ pedido ou `seq`≠nome não conta) e razão `SEAL_INVALID` | N3 |
| V2-44 | **N4:** posição com > 256 KiB, erro de E/S ou diretório **não** suprime o pré-passo: com posição autêntica de chave revogada em outro arquivo, a razão é `SEAL_KEY_REVOKED`; estouro do orçamento de 16 MiB interrompe a leitura dos restantes e o veredito é `VERIFICATION_ERROR` (residual (ii) registrado) | N4 |
| V2-45 | **N6:** qualquer `\` no texto de manifesto ou de fecho ⇒ `SEAL_INVALID`; chave duplicada ⇒ `SEAL_INVALID`; fecho com 1000 `heads` cabe em `MAX_CLOSURE_BYTES`; 1001 ⇒ recusado | N6 |
| V2-46 | **N2 — aceite da W4, fora da DoD da W3 (registrado aqui):** o comando de fecho lista cadeias de `R` presentes no servidor e ausentes do registro externo como `UNKNOWN_SEAL_ON_SERVER` e **não** as inclui em `heads` | N2 |
| V2-47 | Fecho fixado com `signerKeyId` **removido da lista** ⇒ continua `AUTHENTICATED` (só a conferência da assinatura é omitida); com `signerKeyId` presente e **assinatura inválida** ⇒ fecho recusado | O2, N1 |
| V2-48 | `[1,2]` com o arquivo mais recente ilegível ou com `schemaVersion` 3 ⇒ caminho B, falha fechada com o sinal de revogação preservado | N5, M1 |

---

## 12. Contradições e divergências entre spec, modelo de ameaças, runbook e código (a conciliar na aprovação)

- **C1 — assinatura do antecessor.** Spec §5.6 item 2 e §13.3: confere só o **hash** do antecessor ("a assinatura do antecessor não é exigida"). D12 e o fecho exigem conhecer cada posição e sua chave. **Segue-se D12**: lê toda a cadeia e verifica todas as assinaturas; aposentadas **ficam na lista** (C3).
- **C2 — anti-rebaixamento "só com opção explícita" × testes do `v1` sem alteração.** Spec §5.6 item 5 quer `v1` recusado por padrão; os testes do `v1` autenticam `v1` por `evidenceProvenanceFromConfig` sem opção (`tests/link-audit-evidence-provenance.test.ts:108,489`). Solução: padrão `[1,2]` só de biblioteca (limite declarado, §4.3) + `acceptedVersions` explícito em todo chamador de produção, travado por teste estático.
- **C3 — runbook §4 × D12/RS-18.** O runbook manda **remover** a pública antiga após a rotação e, no comprometimento, "remover imediatamente a pública da lista". Com cadeia verificada, item removido torna as cadeias `SEAL_INVALID` (fail-closed, sem sinal de revogação). **O runbook (`onda6c-runbook-chaves.md` §4) precisa passar de "remover a pública antiga" para marcá-la `retired:<closureSha256>` (fecho assinado, entregue e **fixado por hash**, na ordem do §6) ou `revoked`, permanecendo na lista; essa edição do runbook pertence à W3 (documento)**, para que verificador e procedimento nunca divirjam. O runbook também registra: **todas** as cópias da privada destruídas (inclusive o backup de D10), com registro; dúvida ⇒ `revoked`.
- **C4 — D8 × D12.** D8 previa "período de convivência das duas chaves"; D12 fixa **sobreposição de assinatura = 0**. Convivência passa a ser só coexistência **na lista** (aposentada só verifica). D8 deve ser marcada como substituída.
- **C5 — escopo da W3 (decidido: amplia).** Ver §10.
- **C6 — `sign` e lista de chaves.** O `sign` usa `--trust-keys <id:pub,...>` e verifica o manifesto anterior (spec §5.5 passo 7, §7.1). Na W4 terá de aplicar **as mesmas regras** (status, fecho, cadeia); `--trust-keys` herda o formato novo (§5). A primitiva de verificação deve ser a mesma (importável sem dependências novas, RS-14).
- **C7 — spec §16 RS-10.** "verificador v1 recusa v2 e vice-versa": só a primeira metade; o `v2` aceita `v1` (padrão `[1,2]`). Teste V2-07.
- **C8 — RS-16/RS-18 × limite de chaves × rotação anual.** A lista cresce ~1–2 itens/ano (aposentadas permanecem); limite proposto 16 (O2).
- **C9 — autoteste do `sign` (spec §5.5 passo 14 e §7.1).** O passo 14 verifica "com a pública derivada como única de confiança" e o §7.1 usa `--trust-keys` só para o **último** manifesto; isto **contradiz** a verificação da cadeia inteira e do fecho. O autoteste do `sign` (W4) deve usar a **lista completa com status** e os fechos da pasta, com `acceptedVersions: [2]`, ou concordaria com cadeias que o servidor recusa.

---

## 13. Pontos em aberto para o responsável

**Decidido em 17/11/2026 (D14 da spec): aprovado como a implementação da D12 (mecanismo novo):** o **fecho de aposentadoria** (§6), incluindo: o arquivo `_closures/<R>.json`; o ato offline de assinatura por uma chave `active` na aposentadoria ou no descomissionamento do suplente; a **fixação do hash do fecho na lista** (`retired:<closureSha256>`), que é a autoridade; a assinatura do fecho como defesa em profundidade e o efeito de revogação posterior do signatário (o histórico não cai; o id entra em `keyIds`); o novo comando de assinatura do fecho (W4); a edição do runbook (C3).

| # | Ponto | Proposta (**aprovada** em 17/11/2026, D14) |
|---|---|---|
| **O2** | **Limite total** de itens da lista (RS-18) e retenção permanente das aposentadas (item removido ⇒ `SEAL_INVALID`) | `MAX_TRUST_KEYS = 16`. Alternativa: tolerar `keyId` desconhecido em posição anterior (preso por hash), ao custo de perder o sinal de revogação se o item for removido em vez de marcado |
| **O6** | Gravar `{headSeq, headSealSha256, keyIds}` nos resultados e "`UNAUTHENTICATED` ao reler ⇒ revisão humana" é **GATE antes do primeiro resultado de produção**, onda **R2** do plano (PR da W0, §7.3); resta ao responsável aprovar o formato persistido | R2 |
| **O7** | Números: `MAX_CHAIN_SEALS = 256`, `MAX_CLASSIFY_BYTES = 16 MiB`, padrão do `dossier.id`; e a **ordem** da lacuna (avaliada depois do pré-passo, §8) em vez de "antes de qualquer leitura" | Os propostos |

Decididos em 17/11/2026 e já incorporados: escopo ampliado da W3 (§10); sinal de revogação e recomendação de nova coleta (§7). Pré-requisitos que **não** são desta onda, mas condicionam a W4 (spec §13.2): titular/suplente, dispositivo concreto, exceção escrita a RS-14 para K2.

### 13.1 Alternativas rejeitadas

- **Leniente: aposentada pode assinar o último numa cadeia que o sucessor nunca tocou (O1 literal, versão anterior deste contrato).** Rejeitada: faz toda `retired` agir como `active` para quem ainda tem a privada (assinar auditoria nova; truncar `R1 R2 S3` e reassinar o 3'; lista sem `active` ainda autentica). Contraria a intenção "a aposentada só verifica".
- **Estrita: aposentada nunca assina o último, rasselagem obrigatória por auditoria a cada rotação.** Rejeitada pelo responsável: degradaria toda auditoria histórica a cada rotação anual.
- **Regra de época/sucessão** (`retired:<successorId>`, "R só vale se nenhuma posição anterior é do sucessor, transitivamente"): não impõe "só verifica" (mesmos ataques) e adiciona sintaxe e ciclos. Retirada; no lugar, o fecho.
- **Época entre as duas chaves `active`** (`A B A` inválido entre titular e suplente): rejeitada; D10/D12 permitem 2 assinando ao mesmo tempo.
- **`v3` de reatestação após revogação:** romperia a cumulatividade; não nesta onda.
- **Fecho só assinado, sem fixação por hash na lista:** permite duas aposentadas sobreviventes assinarem fechos uma para a outra, troca do arquivo por outro fecho válido (rascunho, versão antiga, outra chave ativa) e derruba o histórico inteiro ao revogar o signatário. Substituído pela fixação por hash (§6).
- **Monotonia "sempre ligada" como compensação do padrão `[1,2]`:** falsa com `v1` último (o caminho de hoje não percorre a cadeia); substituída por `acceptedVersions` em toda posição, chamadores explícitos e a separação entre caminho A (compatibilidade) e B (percorrido), §8.

---

## 14. Rastreabilidade (requisito → seção → teste)

| Requisito | Seção | Testes |
|---|---|---|
| IA-21 (verificador `v2`) | §3, §4, §8 | V2-01, 05–18 |
| IA-03 (ida e volta, vetor-ouro) / RS-09 | §2, §11 | V2-01, 02, 03, 04, 38 |
| RS-10 (`dossier`, `prev`, `v1`/`v2`) | §2, §3, §4 | V2-02, 07, 10 |
| RS-15 (Ed25519 puro, interoperabilidade) | §2 | V2-36, 37 |
| RS-16 (suplente com par próprio) | §5, §6 | V2-20, 21 |
| RS-20 (A sob B, `auditId` não normalizado) | §8 | V2-32, 33, 34, 35 |
| D12/D10 (só verifica; 2 ativas; fecho fixado; revogação) | §5–§7 | V2-20 a V2-30, V2-42 a V2-46 |
| B1 (a, b, c; fecho fixado) | §6 | V2-22, 23, 24, 42 |
| M1 (precedência e registro do sinal) | §7, §8 | V2-27, 28, 43, 44 |
| M3 (versões em toda posição; chamadores explícitos) | §4 | V2-17, 18, 19 |
| Pergunta 12 | §7 | V2-26, 27, 28, 29 |
| Plano W3 (`v1` inalterado; 1 byte em cada campo) | §9, §11 | V2-03, 06 |
