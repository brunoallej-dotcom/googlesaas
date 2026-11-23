# Spec: Produtor P1 da Auditoria por Link — atestação offline da coleta (manifesto Ed25519, v2)

> **Status: APROVADA na onda W0 (17/11/2026)** pelo responsável ("Vamos seguir essa recomendação", em resposta à proposta de registrar as decisões e fechar a W0), com as decisões D1–D13 (§13.1). Implementação por ondas em `docs/plan/implementation-waves.md`. Histórico: **PROPOSTA — NADA DISTO FOI IMPLEMENTADO.** O responsável aprovou P1 como **direção** (01/11/2026), sujeita ao contrato técnico e à verificação de procedência, e registrou **decisões em 16/11/2026** (§13). Esta spec detalha o contrato `docs/phase6-auditoria-link/onda6c-contrato-p1-atestacao.md` (a base; em caso de dúvida ele prevalece, **exceto** onde a §13 registra decisão posterior do responsável, que exige ajuste do contrato na onda W0) em requisitos testáveis. Foi **conciliada com o modelo de ameaças** (`docs/security/threats/link-audit-p1-atestacao.md`, requisitos RS-01..RS-21; rastreabilidade na §16). Nomes de comandos, formatos e códigos de saída são **propostas pendentes de aprovação**.
>
> Esta spec **não altera** o coletor, `stack.yml`, `docker-entrypoint.sh`, volumes nem o verificador. A mudança aditiva do verificador (aceitar `v2`) é **onda própria com contrato próprio** (W3, §5.6), a aprovar antes de qualquer código.
>
> Estrutura de `docs/specs/_template.md`, adaptada: o produtor é um **CLI offline** (não há HTTP, eventos nem OpenAPI/AsyncAPI).

## 1. Objetivo

Hoje existe o **verificador** (`src/lib/link-audit-evidence/provenance.ts`): a finalização de resultados responde `NOT_FINALIZABLE` enquanto não houver um manifesto `seal-NNNN.json` assinado por uma chave de confiança. **O produtor não existe**: nenhum script chama `createEvidenceSeal`. Esta spec define o produtor como **dois comandos offline e separados** (entregues em ondas separadas, **exportação antes da assinatura**), executados na estação do custodiante (fora da VPS):

1. **Exportar o pacote candidato** (somente leitura): lista exata `ref → contentSha256` do que a base de pontuação usa, resumo, integridade local, verificações mecânicas e hash do pacote.
2. **Assinar o manifesto cumulativo** a partir de um pacote **aprovado** por um conferente, com as recusas (a)–(d) do contrato §3 passo 4, produzindo **manifesto `v2`** (liga o hash do dossiê de aprovação e o hash do manifesto anterior dentro da parte assinada).

A assinatura vale exatamente o que vale a conferência humana feita antes dela (contrato §1): ela autentica **bytes exatos**; **não** prova que o Google/Serper os forneceu, que são verdadeiros nem que são atuais.

## 2. Fora de escopo (non-goals)

- **P2** (serviço de atestação dedicado) e **P3** (coletor assina): não recomendados agora (ADR 6C-03 §7).
- **Qualquer alteração do coletor**, do formato das capturas, de `stack.yml`, `docker-entrypoint.sh` ou dos volumes de produção. O hash da captura vem do modo `--json` **já existente** do coletor (§5.3, decisão de 16/11). O volume (novo, somente leitura para o web) da pasta de manifestos é a fase 2 do ADR, documento de implantação à parte.
- **Atestar legado** (capturas anteriores ao layout versionado, ex.: AUD-001): **NÃO ATESTÁVEL** (decisão de 16/11). `sign` recusa qualquer pacote com item legado. Um eventual fluxo de "fonte independente" seria spec futura com os critérios de RS-08 (§16).
- **Campo `entries[].source`** no manifesto (RS-10, terceira parte): não adotado (§16).
- **Aprovação criptograficamente assinada** pelo conferente com segundo par de chaves (RS-03): **não adotada** nesta versão (§16; segue aberta, §13.2).
- **Comando automático de conferência do livro de manifestos**, exposição do fingerprint da lista de chaves e alerta de regressão de autenticação no servidor (RS-17..RS-19): ficam como procedimento humano (W5) ou em outra spec (observabilidade).
- **Ferramenta de reassinatura** de registros antigos (proibida pelo runbook de chaves §3/§5) e **qualquer atestação automática**.
- Geração do par de chaves (máquina limpa, offline, pelo custodiante; só a pública sai), rotação e backup (runbook de chaves §4; custódia no contrato §2).
- Chamadas a Serper, Google, Supabase, Redis, VPS ou qualquer rede. A coleta LIVE nova da AUD-001 (W6) é **fora do escopo de código** e depende de autorização escrita específica.
- Conferência da procedência em si (contrato §4): é **processo humano**; o comando apenas **executa o que é mecanizável**, **exige e registra** o resto (§9).
- Alterar `scoring-basis`, o leitor ou a rota de finalização. (O **verificador** só muda na W3, de forma aditiva.)

## 3. Atores

| Ator | Papel | Faz |
|---|---|---|
| **Operador da coleta** | Executa a coleta LIVE autorizada **com `--json`** | Registra o hash `source.capture.sha256` do relatório impresso, **em canal separado**, antes de qualquer outra operação (contrato §4.1 item 2) |
| **Conferente** | Confere a procedência e aprova/recusa por escrito | Roda `export`, preenche o dossiê de aprovação, grava `approval.json` |
| **Custodiante** (titular/suplente) | Detém a chave privada | Roda `sign` na estação confiável, desbloqueia a chave, entrega `seal-NNNN.json`. **Regra padrão: pessoa diferente do conferente** (§5.5 passo 9) |
| **Administrador do servidor** | Entrega do manifesto | Copia o arquivo (não secreto) para a pasta de manifestos; o web só lê |
| Servidor web / Worker | **Não participa** | Nunca tem a privada nem roda estes comandos |

## 4. Histórias de usuário

- Como **conferente**, quero exportar a lista exata `ref → hash`, o resumo e o resultado das verificações mecânicas sem escrever nada na pasta de evidências, para conferir a procedência sobre um conjunto imutável identificado por um hash.
- Como **custodiante**, quero assinar somente o conjunto que o conferente aprovou, lido **uma única vez**, e que a ferramenta se recuse a assinar se qualquer coisa tiver mudado, para que a minha assinatura nunca ultrapasse a conferência.
- Como **responsável**, quero que a chave privada nunca apareça em argumento, variável de ambiente, log ou arquivo temporário, para que um comprometimento da estação não exponha a chave.
- Como **revisor**, quero que o manifesto produzido passe no verificador e falhe com 1 byte alterado, para ter prova de que produtor e verificador falam o mesmo formato.

## 5. Contratos

### 5.1 Reuso e acréscimos

| Item | Fonte | Observação |
|---|---|---|
| Formato `v1` | `provenance.ts:29-93` (`SEAL_KIND`, `SEAL_SCHEMA_VERSION = 1`, `sealBodySchema`) | **Continua legível** e inalterado. O produtor **não** emite `v1` |
| Formato `v2` | §5.6 | **Novo, aditivo**, onda W3 com contrato próprio |
| Produção | `createEvidenceSeal` (`provenance.ts:101`) | Mantido. O `v2` exige acréscimo aditivo equivalente (`createEvidenceSealV2`; e, para token, montagem a partir de assinatura externa) |
| Verificação | `createSealedEvidenceProvenance` / `parseTrustKeys` / `publicKeyFromRaw` (`provenance.ts:152-254`) | Usada no autoteste (§5.5) e nos testes de ida e volta; depois da W3, em sua versão que aceita `v2` |
| Conjunto de evidências | `createScoringBasisReader(...).readScoringBasis` (`scoring-basis.ts`) | O mesmo conjunto que a prévia entrega ao verificador: `[...basis.evidences, ...(basis.artifacts ?? [])]` (`src/lib/link-audit-scoring-runs/preview.ts:219`) |
| Nome do arquivo | `SEAL_FILE = /^seal-(\d{4})\.json$/` | `seal-NNNN.json`, NNNN = `seq` assinado, dentro de `<seals-dir>/<auditId>/` (o verificador lê `path.join(sealsDir, auditId)`) |
| `auditId` | `AUDIT_ID_PATTERN` (`types.ts`) | minúsculas, 8–64 car. |

**O conjunto exato** (nada a mais, nada a menos) é o `ref → contentSha256` de:

- **Layout versionado**: `capture:cNNNN` (um por captura) e `report:cNNNN-rNNNN` (todas as revisões, inclusive superadas). `artifacts` é vazio.
- **Layout legado** (pasta plana com `MANIFEST.json`; `scoring-basis.ts:360-375,410-411`): `capture:c0001`, `report:c0001-rNNNN` e `legacy-status:c0001` (se conferiu), todas `legacy: true`. **O `export` descreve e marca como não atestável (§5.3); o `sign` recusa.**

O comando **não reimplementa** a seleção: usa o leitor. Para impedir deriva entre o que o comando atesta e o que o verificador recebe, a montagem `basis → EvidenceToProve[]` fica em **uma função única**, extraída de `preview.ts:219` e compartilhada, protegida por **teste de equivalência** (onda W1).

### 5.2 Módulo e CLI propostos

- Núcleo puro e isolado (como a Fase 6): `src/lib/link-audit-attestation/` (esquemas, montagem do pacote, regras de recusa, leitura da cadeia de manifestos, entrada da chave). Sem importar Supabase, Serper, Redis, `fetch` ou o `.env`.
- CLI fino: `scripts/link-audit-seal.ts`, script npm `link-audit:seal`. Subcomandos: `export` e `sign`. Testes entram no script `test` do `package.json` (CLAUDE.md), espelhando `tests/link-audit-seal-*.test.ts`.
- Convenções do CLI existente (`scripts/link-audit-evidence.ts`): `runXCli(argv, out, err, now)` injetável, mensagens em pt-BR, `process.exitCode`, `Falha inesperada.` no catch final, nunca ecoar conteúdo de arquivo. **Diferença:** analisador próprio e estrito (sinalizadores booleanos; flag desconhecida, repetida ou sem valor ⇒ uso, código 1; **única exceção** `--collector-hash`, repetível).
- **Artefato do `sign` (RS-14, forma adotada):** o caminho de assinatura é empacotado em **um único arquivo JavaScript** gerado em CI a partir do mesmo código testado (inclui `zod` e `canonicalJson` embutidos, versões do lockfile), **sem dependências npm em tempo de execução, sem `child_process`, sem rede**; imports do artefato restritos a `node:crypto|node:fs|node:path|node:readline|node:process`; executado com `node --permission` (leitura apenas de pacote, aprovação, dossiê, pasta de manifestos e arquivo de chave; escrita apenas na pasta de manifestos). O SHA-256 do artefato é publicado em dois lugares e conferido pela estação antes do uso e anotado no recibo. Ferramenta de empacotamento e local de publicação do hash: **a escolher na W4** (sem serviço pago novo). O `export` pode rodar via `tsx` (não toca chave).
- **Exceção ao logger do projeto:** o `sign` **não** usa `src/lib/logger.ts` (objetos de erro podem carregar material secreto, RS-13). Não engole erros: emite **código fixo** em stderr e código de saída. Registrar a exceção na W4.

### 5.3 Comando (a) `export` — pacote candidato

```
npm run link-audit:seal -- export --evidence-dir <base> --audit <auditId> \
    [--collector-hash cNNNN=<hex64> ...] --max-gap-hours <N> [--gap-justification <texto curto>] \
    [--seals-dir <pasta>] [--out <arquivo>] [--show-summary] [--json]
```

| Argumento | Obrigatório | Regra |
|---|---|---|
| `--evidence-dir` | sim | **Cópia** ou montagem `:ro` da base de evidências. Passa por `assertAllowedBase` (`store.ts`) |
| `--audit` | sim | `AUDIT_ID_PATTERN` |
| `--collector-hash cNNNN=<hex64>` | **sim, uma por captura não legada** | Hash que o operador registrou do relatório impresso pelo coletor em **`--json`** (`source.capture.sha256`, `capture-report.ts:87`; é o `contentSha256` de `capture:cNNNN`). Divergência, captura sem valor ou valor sem captura ⇒ recusa. **Não há opção que dispense** (captura sem esse registro não é atestável) |
| `--max-gap-hours` | **sim** para captura nova | Limite entre `collectedAt` e a exportação. **Sem valor padrão** (limite ainda não decidido, §13.3). Acima do limite sem `--gap-justification` ⇒ recusa |
| `--seals-dir` | não | Se dado, inclui o `delta` informativo (adicionadas/alteradas/ausentes). **Não** é lido para decidir nada aqui |
| `--out` | não | Arquivo novo, criado com `wx`; por `realpath`, **recusado dentro de `--evidence-dir`** e, desde a W2, **dentro da árvore do projeto** (§5.3.2). Sem `--out`, o pacote vai para stdout |
| `--show-summary` | não | Sem ele, a saída humana mostra só `auditId`, contagens, hashes e códigos (RS-21). Com ele, imprime também nome/cidade/UF da empresa. O **arquivo** do pacote sempre contém o resumo |
| `--json` | não | stdout = um único objeto JSON |

**Efeitos:** somente leitura sobre `--evidence-dir` (IA-02). O único arquivo que pode ser escrito é `--out`. Abertura de arquivos com `O_RDONLY|O_NOFOLLOW` (via `nodeFsOps`).

**Formato do pacote** (`LINK_AUDIT_P1_CANDIDATE`, `schemaVersion: 1`, zod **estrito**):

```jsonc
{
  "schemaVersion": 1,
  "kind": "LINK_AUDIT_P1_CANDIDATE",
  "auditId": "…",
  "layout": "VERSIONED" | "LEGACY",
  "attestable": true,                       // false se containsLegacy
  "summary": {
    "company": { "name": "…"|null, "city": "…"|null, "stateCode": "…"|null },   // null = NOT_VERIFIED; nunca inventado
    "firstCollectedAt": "ISO", "lastCollectedAt": "ISO",
    "captures": 0, "reportRevisions": 0, "artifacts": 0, "containsLegacy": false
  },
  "integrity": { "status": "OK", "algorithm": "SHA-256", "checkedFiles": 0 },
  "checks": [ { "id": "INTEGRITY_LOCAL", "status": "PASS" | "FAIL" | "NOT_EXECUTED" } ],   // §5.3.1
  "gap": { "maxHours": 24, "observedHours": 0.0, "justification": null },                  // dentro do hash
  "entries": [ { "ref": "capture:c0001", "contentSha256": "<hex64>", "legacy": false } ],  // ordenadas por ref, sem repetição
  "delta": { "added": [], "changed": [], "missing": [] } | null,                           // FORA do hash
  "packageSha256": "<hex64>",
  "generatedAt": "ISO"                                                                      // FORA do hash
}
```

- `packageSha256` = SHA-256 de `canonicalJson({schemaVersion, kind, auditId, layout, attestable, summary, integrity, checks, gap, entries})` (`src/lib/link-audit/canonical.ts`). `generatedAt` e `delta` ficam de fora; `gap.observedHours` é arredondado à hora para o hash ser reproduzível (**a verificar na W2**: se a reprodutibilidade exigir, `observedHours` sai do hash e fica só informativo).
- Dados pessoais: o pacote traz **apenas** nome/cidade/UF da empresa e hashes; **nunca** corpo bruto, telefone, endereço, e-mail do operador, URL de website, caminhos de disco nem chaves.
- **Saída humana (pt-BR):** `auditId`, contagens, camada, `Integridade local: OK`, resultado das verificações mecânicas, `Pacote: <hash>` e o aviso fixo: "Hash não é assinatura; a conferência de procedência (contrato §4) ainda é necessária."

#### 5.3.1 Verificações mecânicas (RS-02)

O `export` executa e grava em `checks[]` (`PASS|FAIL|NOT_EXECUTED`) o que for mecanizável **offline sobre a cópia**:

| `id` | O que faz | Observação |
|---|---|---|
| `INTEGRITY_LOCAL` | `readScoringBasis` = `READY` | `FAIL` ⇒ o `export` já recusa (`EXPORT_INTEGRITY_NOT_OK`) |
| `COLLECTOR_HASH_MATCHES` | `--collector-hash` igual ao `contentSha256` da captura | `FAIL` ⇒ recusa |
| `COLLECTION_GAP_WITHIN_LIMIT` | `exportação − lastCollectedAt` ≤ `--max-gap-hours` (ou justificado) | |
| `HTTP_2XX_AND_COLLECTED_AT` | status HTTP 2xx e `collectedAt` presentes, **na medida em que o leitor os expõe** | Se o leitor não expõe, `NOT_EXECUTED` (não se amplia o leitor) |
| `REPORT_REPRODUCES` | reexecuta offline o gerador do relatório sobre a captura e compara | **Viabilidade a confirmar na W1/W2**; enquanto não for confirmada, `NOT_EXECUTED` e conferência humana (contrato §4.1.5) |
| `AUTHORIZATION_CONSUMED`, `PROVIDER_PANEL_CREDITS`, `URL_QUERY_COHERENCE` | **não mecanizáveis offline** (marcador de autorização e painel estão fora da cópia) | Sempre `NOT_EXECUTED`; resultado humano em `approval.json` |

**Códigos de saída:** 0 sucesso · 1 uso · 3 recusado · 4 inesperado.

| Código | `code` estável | Quando |
|---|---|---|
| 0 | — | pacote produzido (inclui pacote **não atestável** por legado, `attestable: false`, útil só como relatório) |
| 1 | `USAGE` | argumentos inválidos/ausentes/repetidos |
| 3 | `EXPORT_NOT_FOUND` | auditoria inexistente, ou pasta é link simbólico/não diretório |
| 3 | `EXPORT_INTEGRITY_NOT_OK` | `readScoringBasis` ≠ `READY` — **nunca** exporta "para conferir mesmo assim" |
| 3 | `EXPORT_COLLECTOR_HASH_REQUIRED` / `EXPORT_COLLECTOR_HASH_MISMATCH` | RS-05 |
| 3 | `EXPORT_GAP_EXCEEDED` | RS-06 |
| 3 | `EXPORT_OUT_UNSAFE` | `--out` existente, sem pasta, dentro da pasta de evidências ou (W2) dentro da árvore do projeto, inclusive se isso mudar entre a conferência e a gravação |
| 3 | `EXPORT_TOO_MANY_ENTRIES` | mais de 2000 entradas |
| 3 | `EXPORT_CLOCK_REGRESSION` | **(acréscimo da W2)** `lastCollectedAt` posterior ao relógio da estação; recusa mesmo com `--gap-justification` |
| 3 | `EXPORT_OUT_WRITE_FAILED` | **(acréscimo da W2, revisão)** a gravação do `--out` falhou depois de conferido o destino (sem espaço, erro de disco, `EEXIST` por corrida); pode ter ficado um arquivo parcial no caminho informado, que **não** é pacote válido; o `export` nunca apaga |
| 4 | `UNEXPECTED` | erro não previsto (mensagem genérica) |

#### 5.3.2 Decisões de implementação da W2 (17/11/2026)

Implementado em `src/lib/link-audit-attestation/export.ts` (montagem pura), `export-run.ts` (único arquivo do módulo com disco: só os leitores existentes, `FsOps` injetado, e a criação exclusiva do `--out`) e `scripts/link-audit-seal.ts`; testes `tests/link-audit-seal-export*.test.ts`. Onde a spec era ambígua, valeu a opção que falha fechado:

- **`gap.observedHours`: fica DENTRO do hash, arredondado PARA CIMA à hora.** O limite é conferido em milissegundos exatos; o teto nunca subestima o intervalo e mantém `observedHours ≤ maxHours` ⇔ dentro do limite. Duas exportações na mesma hora dão o mesmo `packageSha256`; em horas diferentes, hashes diferentes, o que a reprodutibilidade do fluxo não proíbe, porque o `sign` nunca reexporta (RS-04): assina os bytes do pacote aprovado. **Consequência para o procedimento:** depois que o conferente revisou o pacote, o operador **não reexporta**; conferência e assinatura usam sempre os mesmos bytes (runbook da W5).
- **`HTTP_2XX_AND_COLLECTED_AT`** usa o que o leitor de evidências **já expõe** (`VersionEntry.httpStatus`/`collectedAt`, via `getAudit`), sem ampliar leitor nenhum. `PASS` se todas as capturas têm status 2xx e `collectedAt`; `FAIL` se alguma não tem (o pacote sai; quem recusa é o `sign`). Se as duas leituras divergirem (captura a mais ou a menos, ou `collectedAt` diferente), a recusa é `EXPORT_INTEGRITY_NOT_OK`. **Para a W4:** esta verificação não está em `HUMAN_CHECK_IDS`, então um `NOT_EXECUTED` dela nunca seria assinável. Pelo `export` ela nunca sai `NOT_EXECUTED` numa captura nova.
- **Empresa no resumo:** nome/cidade/UF **informados pelo operador** (`identity.operatorProvided` do relatório mais recente, como o leitor de evidências já expõe). Valor fora de forma vira `null` e nunca é corrigido.
- **Sem `--out` (tensão §5.3 × IA-14/RS-21):** o pacote contém nome/cidade/UF, então só vai para a saída padrão **com `--show-summary`**; sem os dois, é erro de uso. Nesse modo, a saída padrão traz exatamente os bytes do arquivo do pacote, e o resumo humano vai para stderr. Com `--json`, o objeto único inclui `package`.
- **Legado:** as 8 verificações são gravadas, **todas** `NOT_EXECUTED`, inclusive `INTEGRITY_LOCAL`, conforme a leitura literal do critério herdado da W1. No legado, todas as verificações saem `NOT_EXECUTED` porque o pacote não é atestável; `integrity.status` informa o resultado da leitura (`OK`, já que um legado com integridade quebrada é recusado com `EXPORT_INTEGRITY_NOT_OK`). Mantido assim na revisão da W2: deixa o esquema da W1 intocado. Além disso, `gap = null`, `--max-gap-hours` não é exigido e `--collector-hash` é recusado com `EXPORT_COLLECTOR_HASH_MISMATCH` ("valor sem captura não legada").
- **Argumentos:**
  - `--max-gap-hours` é inteiro de 1 a 8760 (teto de sanidade; continua sem valor padrão);
  - `--gap-justification` passa pela regra de texto seguro do esquema (sem e-mail, telefone nem controle), exige `--max-gap-hours` e nunca é ecoada (o `--json` só diz `justified`);
  - `--evidence-dir` na área do projeto dá erro de uso, e inexistente dá `EXPORT_NOT_FOUND`;
  - `--out` é recusado (`EXPORT_OUT_UNSAFE`) dentro da pasta de evidências **e em qualquer lugar da árvore do projeto** (não só `public/`: o pacote tem nome/cidade/UF), conferido pelo caminho real **e** pelo caminho informado (um link em `public/` apontando para fora continua servido) e reconferido imediatamente antes de gravar (TOCTOU);
  - falha de gravação depois da conferência dá `EXPORT_OUT_WRITE_FAILED`, distinto de destino inseguro. O `export` nunca apaga nada; a mensagem avisa do possível arquivo parcial, sem imprimir o caminho;
  - opção desconhecida ecoa só o nome (até 20 caracteres, padrão `--[a-z-]`), nunca o valor da forma `--x=valor`; fora do padrão, texto fixo.
- **Outros pontos:**
  - `integrity.checkedFiles` é o número de entradas do pacote;
  - o `delta` (`--seals-dir`) não confere assinatura e informa `deltaStatus` (`NOT_REQUESTED`, `NO_SEALS`, `COMPUTED` ou `UNREADABLE`); uma pasta de manifestos inexistente conta como `UNREADABLE`, não como "nenhum manifesto";
  - lixo com nome **fora** do conjunto (ex.: um FIFO `lixo.fifo`) não é aberto nem atestado (§7.2: o comando não acrescenta leitura própria).

### 5.4 Arquivo de aprovação (entrada do `sign`)

O conferente aprova (ou recusa) **por escrito no dossiê de aprovação** (contrato §3 passo 3). Forma de máquina, **não secreta**, `approval.json` (`LINK_AUDIT_P1_APPROVAL`, `schemaVersion: 1`, estrito):

```jsonc
{
  "schemaVersion": 1, "kind": "LINK_AUDIT_P1_APPROVAL",
  "auditId": "…", "packageSha256": "<hex64>",
  "decision": "APPROVED",                         // qualquer outro valor ⇒ recusa
  "approvedBy": "<rótulo curto, ex.: iniciais/ID; sem e-mail nem telefone>",
  "operator": "<rótulo curto de quem coletou>",
  "approvedAt": "ISO",
  "dossier": { "id": "…", "sha256": "<hex64>" },   // dossiê de aprovação, congelado ANTES da assinatura (§5.6)
  "humanChecks": [ { "id": "AUTHORIZATION_CONSUMED", "result": "PASS", "note": "<curto>" } ],
  "riskAcceptance": { "id": "…", "sha256": "<hex64>" } | null   // aceite formal escrito de acúmulo de papéis (§5.5 passo 9)
}
```

Limite declarado: o arquivo **não é assinado** (não é criptograficamente ligado ao conferente); liga a aprovação ao hash do pacote e do dossiê e deixa rastro. A aprovação **assinada** pelo conferente (RS-03) **não** está nesta versão (§16, §13.2).

### 5.5 Comando (b) `sign` — manifesto cumulativo `v2`

```
npm run link-audit:seal -- sign --audit <auditId> --package <pacote.json> --approval <approval.json> --dossier <arquivo> \
    [--risk-acceptance <arquivo>] \
    --seals-dir <pasta de manifestos> --expect-seq <N> --key-id <ek-AAAAMM-a> \
    --key-source <file:<caminho>|external:<id>> --custodian <rótulo> [--first] [--trust-keys <id:pub,...>] [--json]
```

**O `sign` NÃO recebe nem abre a pasta de evidências** (RS-04; diferença em relação à versão anterior desta spec, que reexportava). Ele lê **uma vez** os bytes de `--package`, `--approval` e `--dossier`, calcula os hashes sobre os bytes lidos e assina exatamente `entries` desses bytes (nunca relê por caminho). A integridade e a coerência com a coleta foram fixadas no `export` e travadas pelo hash aprovado; se a pasta mudar depois, o servidor responde `UNAUTHENTICATED` (fail-closed; indisponibilidade, não falsificação).

| Argumento | Regra |
|---|---|
| `--audit` | Confrontado com pacote, aprovação e nome da subpasta de entrega `<seals-dir>/<auditId>/` |
| `--package` | Pacote que o conferente recebeu |
| `--approval` | `approval.json` (§5.4) |
| `--dossier` | Arquivo do dossiê de aprovação; o comando calcula o SHA-256 e compara com `approval.dossier.sha256` (**só existência e hash**; o conteúdo é humano) |
| `--risk-acceptance` | Opcional (W4.4). Arquivo do aceite formal e escrito de risco citado em `approval.riskAcceptance` (passo 9): **só existência e hash**, o conteúdo é humano. Lido uma vez, como as outras entradas; indicado e ilegível ⇒ recusa. Só conta quando conferente e custodiante coincidem; sem ele, papéis coincidentes são recusados |
| `--seals-dir` | Pasta de manifestos **da estação** (cópia do servidor + novo arquivo). Fora/não aninhada em pasta de evidências (por `realpath`, inclusive link simbólico) |
| `--expect-seq N` | **Obrigatório.** `seq` esperado, tirado do registro externo do dossiê/cofre, **não** da pasta. Divergência do calculado (`último + 1`) ⇒ recusa |
| `--first` | Obrigatório **se e somente se** `N = 1` |
| `--key-id` | `^[a-z0-9][a-z0-9-]{3,31}$` (rótulo público) |
| `--key-source` | `file:<caminho>` (K1) ou `external:<id>` (K2). **Nunca** o valor da chave (§8) |
| `--custodian` | Rótulo de quem assina |
| `--trust-keys` | Opcional: chaves públicas para verificar o manifesto anterior quando a chave dele foi aposentada. **Obrigatório desde o §5.5.1 item 2** (lista com estado; fora de forma ⇒ USAGE, notas da W4.4) |

**Ordem das verificações** (cada falha ⇒ código 3, **nada gravado**; a chave só é pedida/aberta **depois** de todas as que não precisam dela):

1. Recusar se houver variável de ambiente de segredo (§8.1) ou argumento com nome de segredo. Esquemas estritos de `--package` e `--approval`; `auditId` igual nos quatro lugares ⇒ senão `SIGN_AUDIT_MISMATCH`.
2. Recalcular `packageSha256` dos campos do pacote; ≠ campo do próprio pacote ⇒ `SIGN_PACKAGE_INVALID`.
3. **(c)** `approval.decision = APPROVED` e `approval.packageSha256` = hash recomputado ⇒ senão `SIGN_PACKAGE_MISMATCH` (pacote a assinar não é o aprovado) / `SIGN_APPROVAL_INVALID`.
4. **(d)** `package.integrity.status = OK`, `attestable = true` e nenhuma `checks[]` com `FAIL` ⇒ senão `SIGN_INTEGRITY_NOT_OK`. Cada `NOT_EXECUTED` exige `approval.humanChecks[id].result = PASS` com nota; senão `SIGN_CHECK_NOT_EXECUTED`.
5. **(b)** qualquer `entries[].legacy = true` ⇒ `SIGN_LEGACY_NOT_ATTESTABLE` (sem opção que contorne, RS-08).
6. SHA-256 de `--dossier` = `approval.dossier.sha256` ⇒ senão `SIGN_DOSSIER_MISMATCH`.
7. Cadeia de manifestos em `--seals-dir/<auditId>/` (§7.1): `último seq + 1` = `--expect-seq` ⇒ senão `SIGN_SEQ_MISMATCH`; último inválido/ausente-quando-esperado ⇒ `SIGN_SEAL_CHAIN_INVALID`.
8. **(a)** toda entrada do último manifesto existe no pacote **com o mesmo hash** ⇒ senão `SIGN_EVIDENCE_CHANGED` (informa `ref`, até 5). Entradas **novas** são permitidas. `entries` não vazio.
9. **Separação de papéis (RS-01, decisão de 16/11):** `approvedBy ≠ --custodian`; coincidência exige `approval.riskAcceptance` (aceite formal e escrito; existência e hash, conteúdo humano), senão `SIGN_ROLE_SEPARATION`. Com aceite, o recibo marca `roleException: true` e `requiresLaterReview: true`. `operator = approvedBy` não bloqueia, mas também marca `requiresLaterReview` (§13.3); `operator = --custodian` também não bloqueia e também marca (D15.6(d), W5.2a).
10. Relógio: `sealedAt` (= `now().toISOString()`) ≥ `sealedAt` do último manifesto **e** ≥ `package.summary.lastCollectedAt` ⇒ senão `SIGN_CLOCK_REGRESSION`.
11. **Confirmação humana:** o comando exige TTY e pede ao custodiante que **digite os 12 primeiros caracteres de `packageSha256` conforme o dossiê** (lidos fora desta tela); divergência ⇒ `SIGN_CONFIRMATION_FAILED`. Sem TTY ⇒ recusa.
12. Abrir a chave (§8) ⇒ `SIGN_KEY_REJECTED` / `SIGN_KEY_UNPROTECTED`; derivar a pública e **imprimir `<keyId>:<pública base64url>`** (não secreta).
13. Montar o corpo `v2` (§5.6) com `prevSealSha256` (hash do último manifesto; `null` se `seq = 1`) e `dossier = {id, sha256}`; assinar. `entries` = **o conjunto exato** do pacote lido.
14. **Autoteste** com o verificador (versão W3, `FsOps` em memória, pública derivada como única de confiança), com cadeia anterior e evidências = `entries` do pacote: tem de dar `AUTHENTICATED`; senão `SIGN_SELFTEST_FAILED`, nada gravado. Por não ler as evidências reais, este autoteste prova **formato e cadeia**, não coerência com a pasta (esta é do `export` e da verificação pós-entrega).
15. Gravar `seal-NNNN.json` em `--seals-dir/<auditId>/` com criação **exclusiva** (`wx`/`link` sem sobrescrever): se existir ⇒ `SIGN_SEQ_CONFLICT`.
16. **Recibo de assinatura** (vai ao registro de assinatura do dossiê, §9): `{ok, auditId, seq, schemaVersion: 2, keyId, sealedAt, sealSha256, prevSealSha256, packageSha256, dossierSha256, entries: n, approvedBy, operator, custodian, roleException, requiresLaterReview, artifactSha256}`. Nunca a assinatura completa nem a chave.

**Códigos de saída:** 0 · 1 `USAGE` · 3 (qualquer recusa acima, prefixo `RECUSADO:`) · 4 `UNEXPECTED`.

**Mensagens** (pt-BR, sem conteúdo de arquivo): `RECUSADO: evidência já atestada mudou de hash ou sumiu (capture:c0002). Nada foi assinado.` · `RECUSADO: o pacote a assinar não é o aprovado (hash difere). Reexporte, reconfira e reaprove.` · `RECUSADO: pacote com coleta legada não é atestável.` · `RECUSADO: conferente e custodiante coincidem sem aceite formal de risco.`

#### 5.5.1 Decisões de implementação da W4 (19/11/2026, manager, a partir do mapa da W4 e do contrato do verificador `v2`)

Fecham lacunas apontadas no mapa da W4; prevalecem sobre o texto acima onde houver conflito.

1. **K2 fica fora desta W4 (D11).** `--key-source external:<id>` ⇒ `SIGN_KEY_SOURCE_UNSUPPORTED` (código 3), antes de qualquer abertura. K2 só entra depois do teste de compatibilidade da RS-15 e de uma exceção escrita e isolada à RS-14.
2. **`--trust-keys` é obrigatório** e usa o formato da lista com estado do contrato `v2` (§5, C6), com a chave `--key-id` presente como `active` (senão `SIGN_KEY_NOT_ACTIVE`). A pública derivada da chave aberta (passo 12) tem de ser igual à da lista para `--key-id` (senão `SIGN_KEY_MISMATCH`). O passo 7 e o **autoteste do passo 14 usam a lista completa e os fechos `_closures/` da pasta, com `acceptedVersions: [2]`** (C9), no lugar de "pública derivada como única de confiança".
3. **`dossier.id` segue o contrato** (`^[a-z0-9][a-z0-9._-]{2,63}$`) também no esquema da aprovação da W1 (§5.4); não há aprovação real a migrar.
4. **Gravação à prova de queda (RS-12, IA-12):** o manifesto é escrito num temporário não secreto `.<seal-NNNN>.tmp-<aleatório>` na pasta da auditoria, com `fsync`; depois `link()` exclusivo para `seal-NNNN.json` (existe ⇒ `SIGN_SEQ_CONFLICT`), remoção do temporário e `fsync` da pasta. Uma queda deixa no máximo o temporário, que o verificador ignora (nome fora do padrão, V2-15); o runbook manda apagá-lo.
5. **Empacotador do artefato único:** `esbuild`, já travado no lockfile (0.28.2, hoje via `tsx`). A W4.6 o declara como devDependency exata **sem mudar a versão**; se isso exigir rede, ele fica transitivo, com um teste que confere a versão do lockfile. Nenhuma dependência nova.
6. **SHA-256 do artefato em dois lugares:** (i) o artefato e o hash gerados pelo CI (artefato do workflow); (ii) o hash versionado em `docs/phase6-auditoria-link/p1-sign-artifact.sha256`, atualizado por PR. O CI recompila e **falha se o hash recompilado diferir do versionado** (build reprodutível). A estação confere o hash antes do uso e o anota no recibo. **Limite declarado:** os dois lugares estão sob a mesma conta do GitHub; não protegem contra comprometimento da conta.
7. **Imports do artefato (RS-14):** a lista passa a ser `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`, `node:readline`, `node:process` (`node:fs/promises` é a mesma capacidade de `node:fs`). O grafo do verificador hoje alcança `node:dns`/`node:net` por `snapshot-store → evidence → url-safety`; por isso a W4.6 **separa o núcleo do verificador do `FsOps` padrão de disco**, para o artefato importá-lo sem essa cadeia. O teste examina o arquivo final e exige a lista literal.
8. **Frase da chave sem eco (§8, IA-04, IA-15):** TTY herdado em modo bruto, sem eco, restaurado em `finally`; stdin sem TTY ⇒ recusa. Testado com TTY injetável; execução em pseudo-terminal no CI se for viável sem dependência nova.
9. **Comando de fecho (V2-46, subcomando `close-key`, W4.5):** o registro externo é a pasta de **recibos de assinatura** (passo 16), um JSON por assinatura, indicada por `--receipts-dir`; a correspondência é por `{auditId, seq, sealSha256}` com `keyId = R`. Cadeia presente na cópia do servidor com posição assinada por `R` e sem recibo correspondente ⇒ listada como `UNKNOWN_SEAL_ON_SERVER` e **excluída** do fecho; recibos duplicados idênticos são tolerados; recibos divergentes para a mesma posição ⇒ recusa. O fecho é montado e assinado pela chave `active` indicada, com o mesmo autoteste do item 2.


**Notas da W4.1 (19/11/2026, núcleo puro `sign-core.ts`):**

- **Ordem dentro dos passos 4 e 5:** `FAIL` ⇒ `SIGN_INTEGRITY_NOT_OK`; depois `attestable = false` ou entrada legada ⇒ `SIGN_LEGACY_NOT_ATTESTABLE`; só então a cobertura humana ⇒ `SIGN_CHECK_NOT_EXECUTED`. Pelo esquema da W1 (`attestable ⇔ sem legado`) a condição `attestable` do passo 4 e o passo 5 são o mesmo predicado; julgá-los juntos, antes da cobertura humana, é o que torna a IA-01 (b) alcançável.
- **IA-01 (d):** `integrity.status ≠ OK` nunca chega ao passo 4, porque o esquema da W1 fixa o literal `"OK"`; o pacote é recusado no passo 1 (`SIGN_PACKAGE_INVALID`). Falha fechada, travada por teste.
- **Resultado humano para verificação que o pacote não marca `NOT_EXECUTED`** ⇒ `SIGN_APPROVAL_INVALID` (sem código novo). "Com nota" = nota não vazia depois de `trim()`.
- **Separação de papéis (passo 9):** rótulos comparados depois de NFKC, sem caixa e sem separadores (`CONF-01` ≡ `conf 01`), errando para "coincide" (falha fechada).
- **`dossier.id`:** padrão do contrato **e** a regra de texto seguro (um id com cara de telefone é recusado); paridade com o construtor do manifesto `v2` travada por teste. O padrão é copiado, não importado: o esquema não pode puxar o verificador (grafo de rede, item 7).
- **Ficam para a W4.4:** (i) o passo 9 fala em "existência e hash" do aceite de risco, mas o CLI não tem argumento para esse arquivo; hoje só se exige a referência presente; (ii) a subpasta `<seals-dir>/<auditId>/` deriva só do `--audit` validado (quarto lugar do passo 1, por construção).
- **Pergunta aberta (junto da §13.3):** operador = custodiante não marca `requiresLaterReview`; a spec não trata o caso.

**Notas da W4.2 (19/11/2026, cadeia e manifesto, `sign-chain.ts`; onde a spec era ambígua, valeu o lado que falha fechado):**

- **Verificação:** `sign-chain.ts` é o único arquivo do `sign` que importa o verificador (o núcleo recebe só fatos estruturais, item 7). Usa o verificador `v2` real em modo produção (`parseTrustKeyring(--trust-keys)`, fechos de `<seals-dir>/_closures/`, `acceptedVersions: [2]`), com evidências = entradas da própria cabeça: prova formato, cadeia, estados e fechos, não a pasta de evidências. `seq` e `prevSealSha256` vêm do que ele autenticou (`headSeq`, `headSealSha256`). Cada arquivo é lido do disco uma vez, por uma cópia somente leitura do `FsOps` em memória, compartilhada entre a leitura da cabeça e o verificador (sem corrida entre as duas leituras).
- **Ordem:** a cadeia é **lida** antes do passo 1 (leitura sem efeito, sem chave) e **julgada** no passo 7, então as recusas dos passos 1–6 continuam vindo antes. Dentro do passo 7, cadeia que não verifica ⇒ `SIGN_SEAL_CHAIN_INVALID` **antes** da comparação de `seq` (o texto do passo cita `SIGN_SEQ_MISMATCH` primeiro, mas um `seq` calculado de cadeia não verificada não vale nada).
- **`--expect-seq`/`--first`:** `--expect-seq` que não é inteiro de 1 a 256 (`MAX_CHAIN_SEALS`) ⇒ `USAGE`; `--first` com `--expect-seq ≠ 1` ⇒ `USAGE` (o "só se" da tabela de argumentos). Pasta sem manifesto: `--expect-seq > 1` ⇒ `SIGN_SEAL_CHAIN_INVALID` (`NO_SEAL_EXPECTED_SEQ`, manifesto apagado); `--expect-seq 1` sem `--first` ⇒ `SIGN_SEAL_CHAIN_INVALID` (`NO_SEAL_WITHOUT_FIRST`, tabela do §7.1, não `USAGE`). Com cadeia: `--first` ou `último + 1 ≠ --expect-seq` ⇒ `SIGN_SEQ_MISMATCH`. Cadeia com 256 manifestos não aceita `--expect-seq` válido (257 é `USAGE`).
- **"Pasta sem manifesto"** é só ENOENT da subpasta `<seals-dir>/<auditId>/`, ou uma subpasta sem nenhum `seal-NNNN.json` (temporário de queda e outros nomes não contam). Recusas com `SIGN_SEAL_CHAIN_INVALID`:
  - `--seals-dir` inexistente ou que não é diretório ⇒ `SEALS_DIR_UNREADABLE`: provável erro de digitação, como no `delta` do `export`; nunca "começar do 1";
  - EACCES/EIO ⇒ `VERIFICATION_ERROR`;
  - subpasta que é link ou arquivo ⇒ `SEAL_INVALID`;
  - nome de manifesto em outra caixa (`seal-0002.JSON`, `Seal-0001.json`), mesmo sem duplicata ⇒ `SEAL_NAME_CASE_VARIANT`. É mais estrito que o verificador, que os ignora (V2-15), porque num disco que ignora a caixa eles colidiriam.
- **`--trust-keys` fora do formato** ⇒ `SIGN_SEAL_CHAIN_INVALID` (`PROOF_NOT_CONFIGURED`), também com a pasta vazia e `--first`. **Para a W4.4:** o parser do CLI deve recusá-la antes, como `USAGE`.
- **`chainReason`:** a recusa da cadeia leva o código fixo (razão do verificador ou do `sign`), nunca dado de arquivo; o que não tem forma de código não é repassado.
- **Corpo (passo 13):** um plano com `entries` desordenadas ou repetidas é recusado (`UNEXPECTED`), nunca reordenado nem deduplicado em silêncio; `seq`/`prevSealSha256` incoerentes também. Nesta fatia a assinatura só usa chave de teste. `signSealManifest` confere a assinatura com a pública derivada antes de devolver e nunca repassa o objeto de erro (RS-13).
- **Vetores-ouro:** o `sign` reproduz G1 → G2 → G3 a partir do pacote, inclusive G3 sobre o fecho G6 fixado. O dossiê dos testes é `ouro|dossie-0N`, rótulo deduzido da regra do cabeçalho dos vetores (`sha256("ouro|<rótulo>")`) e conferido contra o hash.
- **Ficam para depois:**
  - ~~`SIGN_KEY_NOT_ACTIVE`/`SIGN_KEY_MISMATCH` do item 2: W4.4, porque precisam de `--key-id` e da chave aberta;~~ **Corrigido na confirmação da revisão da W4.1 (nota no fim desta seção):** `SIGN_KEY_NOT_ACTIVE` precisa só do `--key-id` e da lista, não da chave aberta, e entrou na W4.2; só `SIGN_KEY_MISMATCH` precisa da chave aberta e fica para depois do passo 12 (W4.3);
  - o autoteste: W4.5;
  - a gravação (com o nome de `sealFileName`): W4.3;
  - `SIGN_TOO_MANY_ENTRIES` do §7.1: hoje é inalcançável (pacote ≤ 2000 entradas ⇒ manifesto < 256 KiB); a W4.3 confere sobre os bytes gravados.

- **Revisão independente da W4.2 (19/11/2026, `junin-02`, aprovar com mudanças):** (i) erro de E/S na própria raiz `--seals-dir` (EACCES, EIO em `realpath` ou `lstat`) passou a ser `VERIFICATION_ERROR`; só ENOENT/ENOTDIR ou "não é diretório" continuam `SEALS_DIR_UNREADABLE` (antes, toda falha da raiz virava "inexistente"; a recusa já era fechada, o motivo é que estava errado). (ii) Limite declarado: a leitura da cabeça feita pelo `sign` antes do verificador fica fora do orçamento de 16 MiB dele quando o verificador recusa antes de lê-la; o acréscimo é de no máximo 256 KiB (um manifesto), e em todos os outros casos a fotografia somente leitura faz o verificador contar os mesmos bytes.

**Notas da W4.3 (19/11/2026, disco e concorrência, `sign-run.ts`; onde a spec era ambígua, valeu o lado que falha fechado):**

- **Leitura única (RS-04, IA-18):** `--package`, `--approval` e `--dossier` são lidos uma vez cada, nesta ordem, por `readFileBytes` do `FsOps` injetado (`BytesFsOps`, em `snapshot-store.ts`, com o mesmo código do `readFile`: sem seguir link, sem travar em FIFO, tipo e tamanho conferidos no descritor). Os bytes não são decodificados, porque o dossiê pode ser binário, e o `sign` guarda uma cópia deles. Falha de leitura ⇒ `SIGN_INPUT_UNREADABLE` (código novo), que nomeia o argumento e nunca o caminho.
- **Limites de leitura** (nem a spec nem os esquemas definem): pacote 2 MiB (o maior pacote válido tem menos de 0,5 MiB); aprovação 64 KiB (a maior válida tem menos de 8 KiB); dossiê 16 MiB, o mesmo teto do `MAX_CLASSIFY_BYTES`. Acima disso, recusa. O limite do dossiê pode ser revisto na W4.4/W5 se um dossiê real (PDF com capturas) passar dele.
- **"1 byte do pacote" (IA-18):** `packageSha256` cobre o corpo canônico, não os bytes do arquivo (§5.3). Toda troca dentro do corpo é recusada, e o teste varre todas as posições. Uma troca só em `generatedAt`, em `delta` ou em espaços não muda o que é assinado e não é recusada.
- **Raiz fixada:** o caminho real de `--seals-dir` é resolvido uma vez, e a cadeia é lida e o manifesto gravado nessa mesma raiz; trocar um link no meio não desvia a gravação. A gravação recusa uma raiz que não seja o próprio caminho real.
- **Temporário:** `.seal-NNNN.json.tmp-<32 hex>` na pasta da auditoria. `.<seal-NNNN>` foi lido como o nome do arquivo, como no teste da W4.2. O arquivo nasce em 0444 e o `link()` leva esse modo. A subpasta é criada se ausente, com fsync da raiz (a spec só pede o fsync da pasta da auditoria).
- **Sem `link()` (EPERM, EXDEV, ENOSYS, ENOTSUP)** ⇒ `SIGN_WRITE_FAILED`. O `sign` nunca grava o nome final direto, que é o recurso não atômico do `publishExclusive`. Por isso, e porque lá o fsync da pasta é só tentativa, o `publishExclusive` não foi reaproveitado.
- **Códigos novos da gravação:**
  - `SIGN_WRITE_FAILED`: falha antes do `link()`. Nada é gravado como manifesto; o temporário deste processo é removido, mas um temporário alheio com o mesmo nome (EEXIST) nunca é tocado.
  - `SIGN_WRITE_UNCONFIRMED`: falha depois do `link()` (na remoção do temporário ou no fsync da pasta). O manifesto existe e nunca é apagado, mas isso não é sucesso: não se entrega nem se emite recibo, e o caso vai para o runbook como incidente.
  - `SIGN_TOO_MANY_ENTRIES`: conferido sobre os bytes a gravar (mais de 2000 entradas ou mais de 256 KiB), antes de tocar o disco. Esses bytes também têm de voltar, pelo parser estrito do verificador, ao mesmo `sealSha256`.
- **Concorrência (IA-12):** numa corrida pelo mesmo `seq`, exatamente um grava. Quem perde no `link()` recebe `SIGN_SEQ_CONFLICT`; quem já vê o manifesto vencedor ao ler a cadeia recebe `SIGN_SEQ_MISMATCH`. Testado com processos filhos e com 8 gravações simultâneas no mesmo processo.
- **Limites declarados:** o fsync do arquivo é o de `FsOps.writeExclusive`, conferido no disco real. Um componente do caminho trocado depois da última conferência e antes do `link()` não é detectado (o mesmo resíduo do `--out` do `export`). **Para a W4.4:** o CLI não imprime o caminho gravado, só `seq` e o nome do arquivo (IA-14).

**Revisão independente da W4.1 (19/11/2026, `junin-03`):**

- **Confirmação humana antes da chave (passo 11):** `runSignCore` passou a ser assíncrono e recebe a porta injetada `confirm(facts) → Promise<string>`; a tela TTY real é da W4.4.
  - A porta é chamada uma vez, depois de todas as recusas dos passos 1–10 e antes de `openKey`.
  - O texto devolvido é comparado exatamente (sem `trim`, caixa nem NFKC) com os 12 primeiros caracteres de `packageSha256`. Diferente ⇒ `SIGN_CONFIRMATION_FAILED`, e a chave não é aberta. Quem implementa a tela tira só o fim de linha.
  - `facts` = `{auditId, entries}`, onde `entries` é o número de entradas a atestar. Nunca leva o hash do pacote nem parte dele: o custodiante lê os 12 caracteres no dossiê, fora da tela. A mensagem de recusa também não repete o esperado nem o digitado.
  - Porta que lança ou rejeita ⇒ `SIGN_CONFIRMATION_FAILED` (código 3), com mensagem própria ("a confirmação humana não foi obtida"), nunca sucesso; o objeto de erro não sai do núcleo. Foi escolhido em vez de `UNEXPECTED` porque o caso típico é falta de TTY ou entrada interrompida, que o passo 11 já trata como recusa.
  - `sealedAt` continua lido no passo 10, antes da confirmação: a espera humana não muda o instante assinado.
- **Aceite de risco com existência e hash (passo 9):** o núcleo recebe `riskAcceptanceBytes`, os bytes do arquivo lidos uma vez por quem chama (`null` se não foi indicado). Com os papéis coincidindo, cada falta é `SIGN_ROLE_SEPARATION` com a sua mensagem, sem caminho, hash nem conteúdo:
  - `riskAcceptance` nulo ⇒ "sem aceite formal de risco";
  - bytes ausentes ou vazios ⇒ "o arquivo do aceite formal de risco não foi fornecido (ou está vazio)". Um arquivo vazio não é aceite escrito, mesmo com o hash do vazio citado (lado fechado);
  - SHA-256 dos bytes ≠ `riskAcceptance.sha256` ⇒ "não confere com o da aprovação".

  Com os papéis distintos, os bytes são ignorados. Isso substitui o item (i) de "Ficam para a W4.4" das notas acima: a leitura única do arquivo é da W4.3 (`runSign`). **Para a W4.4:** o CLI ganha `--risk-acceptance <arquivo>` (opcional; sem ele, papéis coincidentes são recusados), a acrescentar na sintaxe e na tabela de argumentos do §5.5.
- **Papéis com caixa Unicode:** a chave do rótulo é NFKC sem nenhum grupo de separadores. Os papéis coincidem se as chaves coincidirem em minúsculas, em maiúsculas ou na dobra maiúsculas(minúsculas): `ΟΣ`/`οσ`/`ος` e `ß`/`SS` coincidem. A dobra é acréscimo desta revisão, no mesmo sentido: pega `ẞ`/`SS`, que nem minúsculas nem maiúsculas pegam. Limites declarados: acentos não são removidos (`JOSÉ` ≠ `JOSE`) e o `İ` turco não coincide com `i`; os rótulos são iniciais ou IDs da lista de permissão.
- **Telefone com `_` ou `/`:** `isSafeText` passou a ignorar também `_` e `/` entre dígitos. O `_` é aceito pela lista de permissão dos rótulos e pelo padrão do `dossier.id` (`119_1234_5678` passava nos dois); a `/` só cabe nas notas de texto livre. Isso endurece também os rótulos e notas da W1 e a justificativa de lacuna do CLI do `export`; os vetores existentes da W1 continuam válidos. Limite declarado: outros traços Unicode (`–`, `—`) não contam como separador; a heurística não é completa.
- **IA-01 (d):** o texto do critério foi ajustado para dizer que integridade ≠ `OK` sai como `SIGN_PACKAGE_INVALID` no passo 1. O esquema não muda.
- **Isolamento:** o teste do `sign-core.ts` percorre todos os imports locais alcançáveis a partir dele (`package-hash → canonical`, `schemas → types`), fixa esse conjunto e os módulos externos (`node:crypto`, `zod`) e proíbe o verificador, disco, rede, processos e `snapshot-store` em qualquer ponto do grafo.
- **Propagação na W4.2:** `runSignWithChain` repassa `confirm` e `riskAcceptanceBytes` ao núcleo, e a ordem continua: cadeia lida antes do passo 1 e julgada no passo 7, confirmação depois do passo 10, chave por último. Os fatos da tela ganham `seq` (último verificado + 1, igual a `--expect-seq`), ficando `{auditId, seq, entries}`. Uma recusa da cadeia nunca chega à confirmação; confirmação errada ou porta que falha não assina nada, não abre a chave e não muda a cópia da estação.
- **Propagação na W4.3:** `runSign` pede `confirm` (repassada à cadeia e ao núcleo) e ganha `riskAcceptancePath` (`null` se não indicado). Decisões:
  - quando indicado, o arquivo do aceite é lido uma vez, depois do dossiê, pelo mesmo `readFileBytes` do `FsOps` injetado, sem seguir link;
  - o limite é `MAX_RISK_ACCEPTANCE_BYTES` = 16 MiB, o mesmo do dossiê, porque também é documento humano, só existência e hash;
  - arquivo indicado e ilegível ⇒ `SIGN_INPUT_UNREADABLE` nomeando `--risk-acceptance`, mesmo com os papéis distintos (argumento dado e não lido é recusa);
  - o critério IA-02 (5) passa a admitir também o arquivo do aceite entre os caminhos permitidos.

  Confirmação errada ou porta que falha ⇒ nenhuma escrita (nem subpasta, temporário, `link()` ou fsync) e a chave não é aberta, também sobre uma cadeia existente.

- **Revisão independente da W4.3 (19/11/2026, `junin-01`, aprovar com mudanças):** o `SIGN_SEQ_CONFLICT` passou a avisar do temporário restante quando, depois do `link()` recusado por já existir o nome final, a remoção do temporário também falha (antes só o `SIGN_WRITE_FAILED` avisava). O manifesto existente continua intacto em todos os casos.

**Confirmação da revisão da W4.1 (19/11/2026, `junin-03`), pontos novos para a W4.2:**

- **`SIGN_KEY_NOT_ACTIVE` (§5.5.1 item 2) antes da confirmação humana:**
  - **Posição:** imediatamente antes do passo 11, isto é, depois de todas as recusas dos passos 1–10 e antes de `confirm` e de `openKey`. O custodiante nunca é chamado a confirmar, nem a chave é aberta, para uma chave que não assina.
  - **O que se confere:** `runSignWithChain` recebe `keyId` (o `--key-id`) e consulta o estado dele na lista `--trust-keys` já parseada pelo verificador (`parseTrustKeyring`). Ausente, `retired` ou `revoked` ⇒ `SIGN_KEY_NOT_ACTIVE`; só `active` segue. A mensagem diz o estado, sem repetir o id.
  - **Como chega ao núcleo:** o estado vai como fato estrutural (`signingKeyStatus: 'active' | 'retired' | 'revoked' | 'absent'`), e o núcleo continua sem importar o verificador. Qualquer valor diferente de `active`, inclusive fora de forma, é recusa.
  - **Lista inválida:** o estado é `absent`, mas a cadeia já a recusa no passo 7 (`PROOF_NOT_CONFIGURED`).
- **Formato do `--key-id`:** fora de `^[a-z0-9][a-z0-9-]{3,31}$` ⇒ `USAGE`, antes de ler qualquer coisa (nem a cadeia). O padrão é o do verificador (`TRUST_KEY_ID`, que ele não exporta). Foi copiado em `SIGN_KEY_ID_PATTERN`, sem mudar o verificador, com a paridade travada por teste contra `parseTrustKeyring`.
- **`SIGN_KEY_MISMATCH`:** depende da chave aberta e fica para depois do passo 12, na W4.3.
- **Isolamento:** nos arquivos do `sign` (`sign-*.ts`), nenhum `import(` cujo argumento não seja uma string literal simples e nenhuma forma de `require` (`require(`, `require.resolve`, `module.require`, `createRequire`). O código atual não tinha esse padrão; o teste pega a inserção de `import('./' + 'x')`.
- **Na W4.3:**
  - **`--key-id` repassado:** `runSign` repassa o `--key-id` a `runSignWithChain`. As entradas já foram lidas, só para leitura, antes do `USAGE` de um `--key-id` fora do padrão; nada é gravado.
  - **`SIGN_KEY_MISMATCH` (§5.5.1 item 2), logo depois do passo 12 e antes da assinatura (13):** a pública derivada da chave aberta é comparada byte a byte (SPKI) com a pública de `--key-id` na lista. Outra semente, chave aleatória, a outra chave ativa da lista ou chave de outro tipo ⇒ `SIGN_KEY_MISMATCH`: nada assinado nem gravado.
  - **Falha na conferência:** qualquer falha na própria conferência (chave que nem deriva pública) também é recusa, e o objeto de erro não sai (RS-13).
  - **Onde fica o código:** a conferência fica em `keyMismatchRefusal` (`sign-chain.ts`, o único arquivo do `sign` que lê a lista pelo verificador), chamada por `sign-run.ts`, que continua sem importar o verificador.
  - **Comportamento anterior:** antes desta mudança, uma chave trocada assinava e gravava um manifesto em nome do `--key-id`; o autoteste da W4.5 o recusaria, mas só depois.

- **Confirmação da W4.2 pelo `junin-03` (19/11/2026, aprovar com mudanças):** (i) a guarda contra `import()` com nome calculado e `require` passou a valer para todos os arquivos alcançáveis a partir dos arquivos do `sign`, inclusive o verificador e suas dependências, e não só para os `sign-*`; (ii) a mensagem de `--key-id` fora do formato diz "nada foi assinado nem gravado", porque na W4.3 as entradas já foram lidas quando ela sai; (iii) o achado de que `$` aceitaria um `\n` final foi conferido e não procede em JavaScript (sem a flag `m`, `/^…$/.test('abcd\n')` é falso).

- **Limite declarado da guarda estática (19/11/2026):** o teste de isolamento procura carregamento dinâmico por texto (qualquer `require` solto, `createRequire`, `import()` não literal) em todo o grafo alcançável. É defesa em profundidade contra erro no nosso próprio código, não contra quem escreve código malicioso no repositório: formas ainda mais indiretas de carregar módulos escapam de uma busca textual. O controle forte do artefato é o da W4.6: lista literal de imports do pacote gerado e execução sob `node --permission`.

**Notas da W4.4 (19/11/2026, CLI do `sign`, papéis e chave K1: `sign-args.ts`, `sign-cli.ts`, `sign-key.ts`, `sign-terminal.ts`; onde a spec era ambígua, valeu o lado que falha fechado):**

- **Onde fica:** `scripts/link-audit-seal.ts` só entrega o subcomando `sign` a `sign-cli.ts`, com a raiz do projeto. O caminho de assinatura inteiro fica em `src/lib/link-audit-attestation/`, sem o `export`: é o ponto de partida do artefato da W4.6. O `sign` não usa o logger do projeto (exceção do §5.2, agora registrada): só códigos fixos na saída de erro.
- **Ordem no CLI**, antes do §5.5 passo 1 propriamente dito:
  1. relatórios de diagnóstico do Node desligados (`process.report`, RS-13);
  2. opção com nome de segredo, ou material de chave em qualquer argumento ⇒ `SECRET_VIA_ARGV_FORBIDDEN` (código 3);
  3. variável de ambiente com nome de segredo ⇒ `SECRET_VIA_ENV_FORBIDDEN` (código 3);
  4. analisador estrito ⇒ USAGE (código 1);
  5. `external:` ⇒ `SIGN_KEY_SOURCE_UNSUPPORTED` (código 3), sem ler nada;
  6. `runSign` (W4.3).

  As barreiras de segredo vêm antes do analisador: um segredo colado nunca vira simples erro de uso. Nenhuma recusa ecoa o valor de uma opção.
- **Opção com nome de segredo:** o nome contém pass, senha, secret, segredo, pin, token, priv, chave, key, pwd, credential/credencia, seed/semente ou mnemonic, sem diferenciar caixa e também na forma `--x=valor`. Exceções: `--key-id`, `--key-source` e `--trust-keys`, que não recebem segredo.
- **Material de chave em qualquer argumento:** armadura PEM (`-----BEGIN`, `PRIVATE KEY`) e o prefixo do PKCS#8 Ed25519 em base64/base64url e em hex. `--key-source` fora de `file:`/`external:` também é `SECRET_VIA_ARGV_FORBIDDEN`: pode ser o material colado, e um erro de digitação é recusado do mesmo jeito. `file:` sem caminho é USAGE.
- **Ambiente (§8.1):** nomes recusados, sem diferenciar caixa:
  - `GMN_*` com KEY, PASS, PIN, SECRET ou TOKEN. Inclui `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS`, que só tem públicas: a estação não tem ambiente do projeto e a lista vai por `--trust-keys`;
  - qualquer nome com PASSPHRASE, PASSWORD, PASSWD ou SENHA;
  - `LINK_AUDIT*`, `SEAL*`, `SIGN*` e `ATTEST*` com KEY, PASS, PIN ou SECRET.

  Só os NOMES são lidos (até 3 citados na mensagem, para o custodiante limpar o shell); valores, nunca (teste com `Proxy`). O único valor de ambiente lido é TMPDIR/TMP/TEMP, para as pastas temporárias proibidas.
- **Argumentos:** `--trust-keys` fora de forma ⇒ USAGE, pelo próprio parser do verificador (`isTrustKeyringText`, em `sign-chain.ts`; pendência da W4.2). `--risk-acceptance <arquivo>` entrou na sintaxe e na tabela do §5.5, e o texto do critério IA-02 (5) passou a admiti-lo.
- **Terminal (§5.5.1 item 8):**
  - O modo bruto (eco desligado) é ligado na primeira leitura e mantido até o fim do `sign`: confirmação e frase ficam na mesma sessão, e o que for digitado adiantado entre as duas não ecoa. O modo de antes é restaurado no `finally` do CLI, em qualquer resultado.
  - stdin sem TTY, sem `setRawMode` ou cujo modo bruto não liga ⇒ nada é lido.
  - Ctrl-C, Ctrl-D, fim de entrada, erro do terminal, outra tecla de controle (setas, Esc) ou texto acima do limite (64 bytes na confirmação, 1024 na frase) ⇒ recusa. Backspace (o caractere UTF-8 inteiro) e Ctrl-U editam.
  - Limites declarados: um sinal externo (`kill`) com o terminal em modo bruto não restaura o eco (o custodiante usa `reset`); o Node pode manter cópias internas do que foi digitado, que o código não alcança.
- **Confirmação também sem eco (passo 11):** os 12 caracteres digitados não aparecem na tela, porque o eco mostraria o prefixo correto do hash (lado fechado de "sem mostrar o hash na tela"). A tela mostra só `auditId`, `seq` e o número de entradas. Sem TTY ⇒ `SIGN_CONFIRMATION_FAILED` na posição do passo 11, não antes do passo 1: a ordem das recusas da spec continua valendo.
- **Pseudo-terminal real:** `link-audit-seal-sign-pty.test.ts` roda o `sign` sob o `script` do util-linux (presente no Linux e no runner do CI; nenhuma dependência nova) e prova que a frase não volta na tela e que o terminal termina fora do modo bruto. Sem `script`, o teste é pulado.
- **Chave K1 (passo 12)**, tudo depois da confirmação, nesta ordem: custódia → uma leitura do arquivo → formato → frase → chave.
  - **Custódia (IA-22) ⇒ `SECRET_PATH_UNSAFE`:**
    - dentro da raiz do projeto;
    - numa pasta temporária: TMPDIR, TMP, TEMP e sempre `/tmp`, `/var/tmp` e `/dev/shm` (superconjunto de `os.tmpdir()` sem importar `node:os`, que está fora da lista do artefato, item 7);
    - algum `.git` (pasta, ou arquivo de worktree) numa pasta acima;
    - o próprio caminho é link simbólico;
    - arquivo com permissão diferente de exatamente 0600 (0400 também é recusado: leitura literal da IA-22);
    - pasta do arquivo com permissão diferente de exatamente 0700;
    - uma pasta acima não pôde ser inspecionada.

    Os lugares valem pelo caminho dado e pelo caminho real (um link numa pasta do caminho não esconde nada). A permissão do arquivo é a do descritor aberto (`O_NOFOLLOW|O_NONBLOCK`, `fstat`), sem corrida entre conferir e ler. **(Corrigido na revisão independente da W4.4, nota abaixo: o lugar era conferido por um caminho e o arquivo aberto por outro, e havia corrida.)**
  - **Formato:** só PEM `ENCRYPTED PRIVATE KEY` (PKCS#8 cifrado). Chave que o Node abre sem frase (PEM, DER PKCS#8/SEC1/PKCS#1 ou JWK) ⇒ `SECRET_NOT_ENCRYPTED`. Outro formato (só pública, lixo, PEM legado), arquivo inexistente, diretório ou acima de 16 KiB ⇒ `SIGN_KEY_REJECTED`.
  - **`SECRET_NOT_ENCRYPTED` × `SIGN_KEY_UNPROTECTED`** (o §8 e a IA-04 falam em chave "sem proteção", a IA-22 em "texto claro"): texto claro é `SECRET_NOT_ENCRYPTED`; `SIGN_KEY_UNPROTECTED` é o recipiente cifrado que não protege: abre com frase vazia, ou usa cifra que não é PBES2 (PBES1 legado). As duas recusas saem antes de pedir a frase.
  - **Frase:** pedida uma vez, sem nova tentativa (frase errada ⇒ rodar de novo). Vazia, interrompida ou não obtida ⇒ `SIGN_KEY_REJECTED`. Chave aberta que não é Ed25519 ⇒ `SIGN_KEY_REJECTED`. Os buffers da frase e do arquivo são zerados; o `KeyObject`, não (limite do §8).
  - **Pendência (W5, runbook do custodiante):** o `sign` exige PBES2, mas não impõe parâmetros mínimos do KDF (iterações do PBKDF2 ou custo do scrypt); a exportação padrão do Node usa PBKDF2 com 2048 iterações. Fixar a forma de geração no runbook.
- **IA-02 (5) e custódia:** o `sign` só LÊ o arquivo de chave. A custódia faz `lstat` (metadados) do arquivo, da pasta dele e de `<pasta acima>/.git` até a raiz, e `realpath` do arquivo, da raiz do projeto e das pastas temporárias. **Para a W4.6:** sob `node --permission`, esses `lstat` exigem permissão de leitura das pastas acima do arquivo de chave.
- **Saída:**
  - recusa: linha `RECUSADO: <mensagem>` seguida de `Código: <código>` (com `chainReason` entre parênteses, quando houver), código 3. As telas do terminal, quando houve, vêm antes, na mesma saída de erro;
  - `--json`: um objeto `{ok: false, code, message}`, mais `refs`/`chainReason` quando houver;
  - a pública derivada sai como `<keyId>:<pública base64url>`: na saída padrão, ou na de erro com `--json`;
  - sucesso com `--json`: UM objeto, o recibo do passo 16, com exatamente os campos e a ordem da spec;
  - sucesso sem `--json`: o nome do arquivo (nunca a pasta nem o `file` interno da W4.3), os campos do recibo e o recibo em JSON numa linha (para a pasta de recibos da W4.5).
- **`artifactSha256: null`** até existir o artefato da W4.6 (o comando roda do código-fonte, sem artefato conferido). Um aviso na saída de erro lembra que o autoteste do passo 14 (W4.5) ainda não existe e que o manifesto não deve ser entregue antes dele.
- **Pergunta aberta mantida:** operador = custodiante continua sem marca (nota da W4.1).

**Revisão independente da W4.4 (19/11/2026, `junin-03`, BLOQUEAR; achados conferidos pelo manager, todos procedentes):**

- **BLOCKER, custódia desligada do arquivo aberto.** A custódia conferia o caminho e as permissões antes, e a leitura abria o caminho de novo. O `O_NOFOLLOW` só protege o último componente: trocar uma pasta do caminho por um link entre a conferência e a abertura fazia ler (e assinar com) um arquivo de lugar proibido, e um hardlink dava ao mesmo arquivo um nome fora da árvore com `.git`. As duas brechas foram reproduzidas no código anterior: o `sign` assinava. A promessa "sem corrida entre conferir e ler" das notas da W4.4 era falsa. Corrigido:
  1. o arquivo é aberto UMA vez (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`);
  2. pelo `fstat` do descritor: arquivo comum, permissão exatamente 0600, **um só nome (`nlink = 1`, senão `SECRET_PATH_UNSAFE`)** e tamanho até 16 KiB;
  3. o caminho REAL vem do próprio descritor (`readlink('/proc/self/fd/<fd>')`), e todas as conferências de lugar rodam sobre ele: projeto, pastas temporárias, `.git` acima e a pasta-mãe com 0700 (por `lstat` da pasta, pelo caminho real);
  4. a leitura é feita pelo MESMO descritor, e o caminho do descritor é lido de novo no fim: se mudou, `SECRET_PATH_UNSAFE`;
  5. o lugar pelo caminho DADO continua sendo conferido antes de abrir, só para antecipar a recusa; a prova é a do descritor.

  Caminho do descritor indisponível (sistema sem `/proc`), que não é absoluto e normalizado, ou de arquivo apagado (` (deleted)`) ⇒ `SECRET_PATH_UNSAFE`, recusa fechada. **Limite declarado:** o `sign` só prova a custódia onde existe `/proc/self/fd` (Linux, a estação dedicada da D11); em outro sistema, recusa. Resíduo: uma pasta acima do arquivo renomeada entre a leitura do caminho do descritor e o `lstat` dos `.git` não é detectada; a releitura do caminho no fim estreita a janela, que só o próprio usuário da estação alcança. **Para a W4.6:** `node --permission` precisa permitir a leitura de `/proc/self/fd`.
- **MAJOR, `external:` com sufixo arbitrário.** `--key-source external:<id>` só segue para `SIGN_KEY_SOURCE_UNSUPPORTED` com `<id>` no padrão do `--key-id` (`SIGN_KEY_ID_PATTERN`). Qualquer outro sufixo (vazio, com espaço, maiúscula, `_`, curto ou longo demais, frase ou PEM) ⇒ `SECRET_VIA_ARGV_FORBIDDEN`, sem eco, com o aviso de que o valor deve ser tratado como exposto (histórico do shell, `/proc`).
- **MINOR, ambiente.** A barreira do §8.1 passou a recusar também nomes genéricos de segredo em qualquer posição, sem diferenciar caixa: `SECRET`, `PASSWORD`/`PASSWD`, `PASSPHRASE`, `PRIVATE_KEY`/`PRIVATEKEY`, `CREDENTIAL`, `API_KEY`/`APIKEY` e `TOKEN`, além dos padrões anteriores. Continua lendo só os nomes. Efeito declarado: variáveis comuns com esses nomes (ex.: `GITHUB_TOKEN`) também barram o `sign`; a estação dedicada não deve tê-las.
- **MINOR, buffer.** O buffer lido do arquivo de chave é alocado antes de qualquer leitura e zerado em toda saída que não devolve a chave: falha de leitura depois de leitura parcial, falha no `close` (que também vira recusa, `SIGN_KEY_REJECTED`), recusa posterior (formato, frase); e também depois do sucesso.
- **KDF (decisão do manager, aceita pelo revisor com portão; não bloqueia a W4.4).** Nenhuma chave real antes da W5. O runbook da W5 fixa parâmetros fortes e verificáveis: scrypt com custo definido, ou PBKDF2 com número alto de iterações, mais frase de alta entropia (critério de aceite da W5 em `docs/plan/implementation-waves.md`). Sem dependência nova, o `sign` lê os parâmetros do PBES2 no DER e imprime na saída de erro, antes de pedir a frase, `Aviso (KDF): …` quando:
  - o PBKDF2 tem menos de 600000 iterações (a exportação padrão do Node usa 2048);
  - o scrypt tem custo N abaixo de 2^17;
  - os parâmetros não puderam ser conferidos.

  Os mínimos são provisórios (recomendação atual da OWASP para PBKDF2-HMAC-SHA256 e para scrypt com r = 8 e p = 1) até o runbook confirmá-los ou substituí-los. O aviso não recusa.
- **Achado na verificação desta correção (fora da lista do revisor):** a tela da confirmação era mostrada ANTES de o modo bruto ser ligado. Sob a carga da suíte completa, o teste em pseudo-terminal pegou a confirmação digitada logo depois da tela sendo ecoada; o mesmo valeria para uma colagem rápida do custodiante. Corrigido: o eco é desligado antes de cada tela (confirmação e frase), com teste que confere o modo do terminal no instante em que cada linha da tela é escrita. O teste em pseudo-terminal passou 18 vezes em 18, com 6 cópias simultâneas e outra suíte rodando ao lado.

- **Confirmação da revisão da W4.4 (19/11/2026, `junin-03`, aprovar com mudanças):** (i) o resíduo da corrida entre o caminho do descritor e o `lstat` dos `.git` só fica restrito ao usuário da estação se as pastas ACIMA do arquivo de chave não forem graváveis por outros usuários; o código confere só a pasta-mãe (0700). Isso vira condição do runbook da W5 (local da chave com ancestrais não graváveis por terceiros). (ii) Um valor com formato de identificador depois de `external:` é indistinguível de um id público; toda recusa de `external:` agora avisa que o valor é público e que, se era um segredo, deve ser tratado como exposto. (iii) O aviso de KDF confere só as iterações do PBKDF2 ou o custo `N` do scrypt (não `r`, `p` nem o PRF) e diz isso na própria mensagem; não é validação do perfil. A W5 confere o perfil completo antes de qualquer chave real.

**Notas da W4.5 (20/11/2026, autoteste do passo 14 e comando de fecho `close-key`: `sign-chain.ts`, `sign-run.ts`, `sign-receipts.ts`, `sign-closure.ts`, `sign-args.ts`, `sign-terminal.ts`, `sign-cli.ts`; onde a spec era ambígua, valeu o lado que falha fechado):**

- **Autoteste (passo 14; item 2 e C9 do contrato do verificador `v2`):**
  - roda depois da assinatura (13) e antes da gravação (15), sobre os BYTES que serão gravados (`serializeSealFile`); por isso `SIGN_TOO_MANY_ENTRIES` vem antes dele;
  - usa o verificador `v2` real em modo produção: `parseTrustKeyring(--trust-keys)` com os estados, os fechos de `_closures/` da pasta e `acceptedVersions: [2]`; as evidências são as `entries` do pacote;
  - usa a mesma fotografia somente leitura da leitura da cadeia: `runSign` cria a fotografia (`chainSnapshot`, idempotente) e a repassa à cadeia e ao autoteste, e o manifesto novo entra em memória (`withVirtualFile`). Entre a chave aberta e a primeira escrita não há leitura de arquivo nem de pasta (teste com espião);
  - só passa com `AUTHENTICATED` cuja cabeça é exatamente o manifesto novo (`headSeq` e `headSealSha256`). Senão `SIGN_SELFTEST_FAILED` (código 3), com o código do verificador em `chainReason` (ou `SELFTEST_HEAD_MISMATCH`), e nada é gravado;
  - o arquivo em memória nunca esconde um arquivo real de mesmo nome: nome já listado na pasta ⇒ recusa;
  - na prática, ele recusa o que o passo 7 aceitou quando a cadeia anterior verifica mas o servidor recusaria a cadeia com o manifesto novo (ex.: o orçamento de 16 MiB do `classify`, testado com 64 manifestos). Os outros casos do C9 (posição de aposentada fora do fecho, chave aposentada ou revogada) já são recusados antes, pelo passo 7 ou por `SIGN_KEY_NOT_ACTIVE`; o teste do autoteste os prova direto, contra a "pública derivada como única de confiança", que os aceitaria;
  - a saída humana registra o autoteste. O aviso de autoteste ausente (notas da W4.4) saiu; fica o do `artifactSha256` nulo (W4.6).
- **`close-key`, sintaxe:** `npm run link-audit:seal -- close-key --retired-key-id <R> --seals-dir <pasta> --receipts-dir <pasta de recibos> --key-id <S> --key-source file:<caminho> --custodian <rótulo> --trust-keys <lista> [--json]`. O fecho é gravado em `<seals-dir>/_closures/<R>.json` com criação exclusiva (decisão, no lugar de `--out`: é o arquivo que o verificador lê, o nome deriva de R, não há caminho arbitrário e nada é sobrescrito; reemissão exige retirar o fecho existente pelo runbook).
- **Ordem** (cada recusa: nada assinado nem gravado; a chave só depois de todas as recusas que não precisam dela, como no `sign`):
  1. barreiras de segredo em argv e ambiente e analisador estrito (as mesmas do `sign`; `--retired-key-id` é rótulo público); `S = R` ⇒ USAGE;
  2. sem ler nada: R presente e não revogada na lista (`CLOSE_KEY_STATE_INVALID`; dúvida ⇒ `revoked`, nunca `retired`) e S `active` (`SIGN_KEY_NOT_ACTIVE`). R pode estar `active`, `retired` ou `retired:<hash>` (reemissão);
  3. raiz da cópia do servidor, recibos, varredura, `_closures/<R>.json` ainda inexistente (`CLOSE_ALREADY_EXISTS`), cabeças (no máximo 1000, `CLOSE_TOO_MANY_HEADS`) e relógio (`sealedAt` ≥ o da cabeça e o do último manifesto de cada auditoria coberta, `SIGN_CLOCK_REGRESSION`);
  4. confirmação humana, chave K1 (custódia, frase sem eco) e `SIGN_KEY_MISMATCH`;
  5. fecho, autoteste e gravação.
- **Recibos (registro externo):**
  - a pasta é um diretório real, fora da cópia do servidor e sem contê-la; vazia ⇒ recusa (provável erro; uma chave que nunca assinou fica `retired` sem fecho ou `revoked`); no máximo 10 000 arquivos (`MAX_RECEIPT_FILES`);
  - toda entrada tem de ser um arquivo comum `*.json` de nome simples: link, diretório, FIFO, oculto ou outra extensão ⇒ recusa, porque nada é ignorado em silêncio;
  - cada recibo tem até 4 KiB (`MAX_RECEIPT_BYTES`), é lido uma vez como bytes, sem seguir link, e passa pelo texto estrito (UTF-8, sem BOM, sem barra invertida, sem chave repetida) e pelo esquema zod estrito do recibo do passo 16 (`prevSealSha256` nulo se e somente se `seq = 1`). Qualquer falha ⇒ `CLOSE_RECEIPTS_INVALID`;
  - duplicados idênticos (qualquer formatação) contam uma vez; divergentes na mesma posição `{auditId, seq}` ⇒ `CLOSE_RECEIPTS_CONFLICT`, também em posição sem R (o registro está incoerente).
- **Cabeças (contrato do verificador `v2` §6):**
  - a varredura lê, somente leitura, TODA a cópia do servidor: as subpastas com nome de auditoria e cada manifesto delas, uma vez, até 256 MiB no total. Erro de E/S ou nome de manifesto em outra caixa ⇒ `CLOSE_SERVER_COPY_INVALID`;
  - posição que declara `keyId = R` sem recibo de R da mesma posição com o mesmo `sealSha256` (e manifesto estrito assinado por R) ⇒ a cadeia INTEIRA vai para `UNKNOWN_SEAL_ON_SERVER` e fica fora do fecho. Decisão: "excluída" vale para a cadeia, não só para a posição, inclusive com a posição abaixo da cabeça; cobrir só a parte recibada faria o autoteste recusar o fecho;
  - a cabeça de cada auditoria é o MAIOR `seq` de R no REGISTRO, e ela tem de estar na cópia do servidor, idêntica e assinada por R. Senão a auditoria fica fora e é listada (`receiptedHeadsNotOnServer`). Decisão: nunca se fecha numa cabeça menor tirada da pasta; a leitura literal "maior `seq` com recibo e presente no servidor" legitimaria um retrocesso da pasta, que o §6 manda detectar.
- **Confirmação (terminal sem eco e frase da W4.4):** a tela mostra S e as contagens (cobertas, desconhecidas no servidor, cabeças ausentes), nunca R. O custodiante digita o id de R conforme o registro de rotação, comparado exatamente (decisão: o equivalente aos 12 caracteres do dossiê no `sign`).
- **Fecho e autoteste:**
  - o corpo tem as `heads` ordenadas por `auditId`; a assinatura é Ed25519 pura de S, e a montagem confere a assinatura com a pública derivada. Os bytes são JSON compacto com quebra de linha (até 256 KiB, relidos pelo parser estrito), e `closureSha256` é o SHA-256 desses bytes;
  - o autoteste põe o fecho em memória em `_closures/<R>.json`, sobre a fotografia da varredura, com a lista em que o item de R vira `R:<pública>:retired:<closureSha256>`. O fecho por si (parser estrito, R, S, cabeças, assinatura de S, item fixado) e cada cadeia coberta, pelo verificador real (`[2]`, evidências = entradas do último manifesto da cadeia), têm de dar `AUTHENTICATED` com R e S em `keyIds`;
  - uma cadeia coberta que o servidor recusaria por outro motivo (ex.: posição de chave revogada) ⇒ `SIGN_SELFTEST_FAILED` citando a auditoria, e o fecho inteiro é recusado. Decisão: é uma dúvida, e o runbook decide ("qualquer dúvida ⇒ `revoked`, nunca `retired`").
- **Vetor-ouro G6:** fechar G1–G2 (chave `a`) com a chave `b` no instante de G6 reproduz o corpo canônico e a assinatura de G6; os bytes entregues são outros (formatação), por isso o `closureSha256` também é outro.
- **Saída:** `RECUSADO:` seguido de `Código:` (código 3), USAGE (1), falha inesperada (4). Com `--json`, UM objeto `{ok, retiredKeyId, signerKeyId, custodian, sealedAt, closureSha256, fileName, heads, unknownSealsOnServer, receiptedHeadsNotOnServer, pinnedTrustKey}`. Sem `--json`: o nome relativo `_closures/<R>.json`, o `closureSha256`, o item da lista a fixar, o que ficou fora e o aviso de que, sem a fixação, R não conta. Nunca caminho de disco nem chave.
- **Isolamento:** `sign-closure.ts` é o segundo (e último) arquivo do `sign` que importa o verificador; a W4.6 separa o núcleo do verificador do `FsOps` de disco para os dois. `sign-receipts.ts` só lê e não importa o verificador, e a gravação do fecho é a mesma criação exclusiva de `sign-run.ts` (`publishClosure`).
- **Limites declarados:** a varredura inteira fica na memória (até 256 MiB). A exigência de R e S em `keyIds` é defesa em profundidade: com R `retired:<hash>`, toda cadeia coberta que autentica já usou o fecho.
- **Ficam para depois:** o runbook da aposentadoria (W5): entrega byte a byte, fixação do hash, destruição de todas as cópias da privada de R e retirada de um fecho anterior numa reemissão; o artefato único (W4.6).

**Revisão independente da W4.5 (20/11/2026, `junin-03`, BLOQUEAR; achados conferidos pelo manager, todos procedentes; corrigidos com testes antes do código):**

- **MAJOR (era BLOCKER, vem da W4.4 e vale para `sign` e `close-key`): frase da chave e diagnóstico do runtime (T-008).** Desligar `process.report` não bastava: `NODE_OPTIONS=--heapsnapshot-signal=SIGUSR2` (ou `--inspect`, `--heap-prof`, `--diagnostic-dir`, `--report-*`, pré-carga extra…) despejaria o heap com a frase ou abriria um depurador. Corrigido com uma barreira nova, `SIGN_RUNTIME_UNSAFE` (código 3), logo depois da barreira de ambiente do §8.1 e antes do analisador: nada é lido, o terminal não é tocado e a frase nunca é pedida.
  - **Ambiente (só os NOMES, como no §8.1):** qualquer `NODE_*` é recusa, salvo `NODE_ENV`. Inclui `NODE_OPTIONS` mesmo vazio (decisão: olhar o valor quebraria a regra "só os nomes"), `NODE_DEBUG`, `NODE_V8_COVERAGE` e `NODE_PATH`.
  - **`process.execArgv`, lista permitida explícita:**
    - o par do carregador do `npm run link-audit:seal`. Conferido num processo real: o `tsx` põe exatamente `--require <…>/tsx/dist/preflight.cjs --import file://<…>/tsx/dist/loader.mjs` e nada em `NODE_OPTIONS`. O par vale uma vez, nesta ordem, e os dois arquivos têm de ser, pelo caminho real, os do `node_modules` do próprio projeto;
    - o modelo de permissões do artefato da W4.6: `--permission` (ou `--experimental-permission`), `--allow-fs-read=…` e `--allow-fs-write=…` (só com `=`), e `--disable-sigusr1`, que só restringe;
    - qualquer outra opção ⇒ recusa, sem ecoar o valor.
  - **Inspector:** `node:inspector` não é importado (ficaria fora da lista RS-14). Na partida ele só liga por `NODE_OPTIONS` ou `execArgv`, que a barreira cobre; `process.debugPort` existe sempre (9229) e não indica nada.
  - **Limite declarado:** outro processo do MESMO usuário pode ligar o inspector depois (SIGUSR1) ou ler a memória (`/proc/<pid>/mem`). Isso fica fora da garantia (estação dedicada, W5), e a W4.6 pode rodar com `--disable-sigusr1`, já aceito.
  - **Testes:** por injeção (`execArgv` e ambiente são injetáveis no CLI) e em processo REAL pelo `tsx`: o carregador do projeto passa; `NODE_OPTIONS` e uma opção extra (`--expose-gc`) recusam. Os testes que rodam o CLI injetam um `execArgv` limpo: o do processo de teste é o carregador dos testes, e o `node --test` põe `NODE_TEST_CONTEXT` no ambiente.
- **MAJOR (era BLOCKER): pasta de recibos não vinculada à leitura (TOCTOU).** O `lstat` seguido de `realpath` deixava trocar a pasta (a raiz de confiança do fecho) por um link e fazer de um recibo forjado uma cabeça. Corrigido no molde da custódia da chave da W4.4:
  - a pasta é aberta UMA vez com `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`. O `fstat` do descritor exige diretório do usuário que roda o comando, sem escrita para grupo e outros (fora do Linux, sem `getuid`, é recusa);
  - a enumeração e cada leitura vão SEMPRE por `/proc/self/fd/<fd>/…`;
  - cada recibo é aberto dentro dela com `O_NOFOLLOW|O_NONBLOCK` e conferido no próprio descritor: arquivo comum, do usuário, sem escrita para grupo e outros, até 4 KiB e sem mudar durante a leitura. Decisão: `nlink` não é exigido, porque quem protege o conteúdo é o dono e o modo do próprio arquivo, e o nome está preso ao descritor da pasta;
  - as pastas ACIMA (pelo caminho real do descritor) não podem ser graváveis por grupo ou outros, salvo com sticky bit (como `/tmp`). O dono delas não é conferido: num namespace de usuário (o executor isolado dos testes), as pastas de root aparecem com dono não mapeado. Fica como condição do runbook (W5), igual à pasta da chave;
  - a sobreposição com `--seals-dir` passa a ser pela identidade `dev`/`ino`: a pasta e as de cima contra a cópia do servidor e as de cima dela, inclusive por link;
  - teste: a troca da pasta por um link para recibos forjados, feita depois da abertura, não muda o que é lido.
- **MINOR: limites aplicados depois de enumerar tudo.** Os recibos e a raiz da cópia do servidor passam a ser enumerados com `opendir`, de forma iterativa, parando na entrada máximo + 1 (`collectUpTo`). Na raiz da cópia o teto conta entradas (`MAX_SERVER_ENTRIES` = 10 000, inclusive `_closures`).
- **MINOR: nomes de recibo nas mensagens.** As recusas citam a posição ordinal na ordem alfabética ("o 3º arquivo"), nunca o nome, que pode carregar dado de cliente.
- **NIT: isolamento transitivo.** `SIGN_KEY_ID_PATTERN` mudou para `sign-core.ts` (`sign-chain.ts` o reexporta). `sign-receipts.ts` importa só `node:fs/promises`, `node:path`, `zod`, `schemas` e `sign-core`, e o teste de isolamento confere pelo grafo que ele não alcança o verificador nem o `snapshot-store`.
- **NIT: limites exatos.** Exatamente 10 000 recibos não esbarram no teto e 10 001 são recusados antes de qualquer leitura. Exatamente 1000 auditorias cobertas gravam o fecho e 1001 são recusadas. O teto de recibos também é provado com limite injetado (só nos testes).

**Confirmação da revisão da W4.5 (20/11/2026, `junin-03`):** itens 2–6 fechados. No item 1 ficou um caso: um preload (`NODE_OPTIONS=--require <arquivo>`) roda ANTES do CLI e pode apagar `process.env.NODE_OPTIONS`, escondendo de `execArgv` e do ambiente uma opção como `--heapsnapshot-signal`. **Decisão do manager: limite declarado, não bloqueio.** Um preload já é código arbitrário dentro do processo: poderia capturar a frase direto no terminal (ou trocar qualquer função que a barreira usa), e nenhuma barreira dentro do próprio processo se defende de código que roda antes dela. A barreira da W4.5 protege contra configuração acidental e opções de diagnóstico, não contra a estação comprometida. O controle forte passa a ser critério da W4.6/W5: (i) o artefato roda por `env -i` com `node` por caminho absoluto e `--permission`, na linha de comando fixada pelo runbook; (ii) a barreira confere também `/proc/self/cmdline` e `/proc/self/environ` (o argv e o ambiente ORIGINAIS do `exec`, que limpar `process.env` não altera), o que pega um preload que só limpou o ambiente; (iii) o caso entra no modelo de ameaças junto da T-008. Sugestão não adotada: o teste de mudança de tamanho do recibo altera os bytes depois da leitura, em vez de reproduzir a troca entre as chamadas de sistema; ele prova a conferência "tamanho informado × bytes devolvidos", que é a guarda.

**Notas da W4.6 (20/11/2026, artefato único: `provenance-core.ts`, `fs-ops.ts`, `node-fs-ops.ts`, `sign-runtime.ts`, `scripts/link-audit-sign-artifact.ts`, `scripts/build-sign-artifact.ts` e o job `sign-artifact` do CI; onde a spec era ambígua, valeu o lado que falha fechado):**

- **Núcleo do verificador (item 7):** `provenance-core.ts` tem todo o verificador `v2`, SEM disco padrão. A fábrica dele, `createSealedEvidenceProvenanceOver`, exige a porta de leitura `fs`; sem ela, a política é a FECHADA, nunca o disco em silêncio. `provenance.ts` virou fachada compatível para o servidor e os testes W3:
  - reexporta os mesmos valores do núcleo;
  - acrescenta `createSealedEvidenceProvenance` (sem `fs` ⇒ `nodeFsOps`) e `evidenceProvenanceFromConfig`;
  - os vetores-ouro não mudaram.

  A porta de disco saiu do `snapshot-store.ts`, que a reexporta: os tipos `FsOps`/`FileInfo`/`BytesFsOps` e `errorCode` ficam em `fs-ops.ts` (sem imports), e o adaptador `nodeFsOps` em `node-fs-ops.ts` (só `node:fs/promises`). `sign-chain.ts` e `sign-closure.ts` usam o núcleo, e o grafo do `sign` não alcança mais `snapshot-store → evidence → url-safety` (`node:dns`/`node:net`). A guarda estática da V2-19 passou a tratar o par núcleo + fachada como o verificador: a fábrica do núcleo segue a mesma regra (`acceptedVersions` literal). A V2-41 prova que o núcleo só alcança `node:crypto`, `node:path` e `zod` e que a fachada preserva o comportamento.
- **Entrada e recibo (item 6):** `scripts/link-audit-sign-artifact.ts` despacha só `sign` e `close-key`; o `export` fica fora. Empacotada (`LINK_AUDIT_SIGN_ARTIFACT` definido pelo build):
  - a raiz do "projeto" é a pasta do artefato (a chave nunca pode estar nela);
  - o recibo leva `artifactSha256` = SHA-256 dos bytes do próprio arquivo em execução, lido logo depois das barreiras. O esperado não é embutido (seria autorreferência);
  - artefato ilegível ⇒ `SIGN_ARTIFACT_UNREADABLE` (código novo, código 3), antes de ler qualquer entrada.

  Fora do artefato (`npm run link-audit:seal`), `artifactSha256` continua `null`, com aviso. O `close-key` mostra o hash do artefato na saída de erro; o objeto `--json` do fecho não mudou (forma da W4.5).
- **Declaração do esbuild (item 5):** `npm install --save-dev --save-exact --package-lock-only --offline esbuild@0.28.2` funcionou sem rede. O lockfile só ganhou a declaração na raiz; resolução e integridade ficaram iguais. O plano B não foi preciso.
- **Build (itens 5 e 6):** `npm run link-audit:sign-artifact -- [--out <pasta>] [--check]`, com opções FIXAS:
  - bundle, `platform: node`, `format: cjs`, `target: node22`, sem sourcemap, `legalComments: 'none'`, ASCII, zod embutido;
  - `minifyWhitespace`: só espaço em branco e comentários; nomes e sintaxe ficam como estão. Decisão: sem ela, o esbuild preserva comentários das dependências, e um comentário do zod com `import()` fazia a guarda textual recusar. Assim a guarda textual fica exata, e o fonte auditável continua sendo o do repositório;
  - `preserveSymlinks` (num worktree, o `node_modules` é link) e `tsconfigRaw: {}`, para um ajuste do `tsconfig.json` do Next não mudar o hash.

  Guardas sobre a SAÍDA, antes de gravar (falha ⇒ `ArtifactBuildError`, nada gravado):
  - pelo `metafile`, todo import que sobrou é externo, por `require` estático, e da lista literal;
  - pelo texto final, todo `require(` tem como argumento uma string literal da lista, e não há `import(`, `require.resolve`, `module.require`, `createRequire`, `process.binding`/`process.dlopen` nem caminho absoluto da máquina do build.

  O artefato atual carrega só `node:crypto`, `node:fs/promises` e `node:path` (751 417 bytes). O build é reprodutível: o mesmo SHA-256 em pastas de saída diferentes, numa cópia do repositório em outro caminho e com o Node 24 local. Ele não depende da versão do node que chama o esbuild (o binário nativo é o travado no lockfile): o CI (Node v22.23.5) recompilou o mesmo hash.
- **Hash versionado (item 6):** `docs/phase6-auditoria-link/p1-sign-artifact.sha256`, no formato do `sha256sum -c` (`<sha256>  link-audit-sign.cjs`); hoje `395d5ba946e3f6b45c9689828947ca49107d3a9940db4f4ca4574233c1dda17d` (depois da segunda confirmação da revisão independente, abaixo; conferido de novo em duas pastas e numa cópia do repositório em outro caminho). Muda a cada mudança de CÓDIGO no grafo do artefato (comentários não contam), e o PR que muda o código atualiza o arquivo; o teste e o CI recompilam e recusam a diferença. O limite declarado do item 6 continua: os dois lugares estão sob a mesma conta do GitHub.
- **Barreira do runtime (confirmação da revisão da W4.5, critério ii):** confere também o bloco ORIGINAL do exec:
  - em `/proc/self/cmdline`, só as opções do node ANTES do script, com a mesma lista permitida; o script e os argumentos do comando nunca são decodificados;
  - em `/proc/self/environ`, só os NOMES, com as regras do §8.1 (`SECRET_VIA_ENV_FORBIDDEN`) e do `NODE_*`; nenhum valor é decodificado;
  - bloco ilegível, vazio ou sem o nome do programa ⇒ `SIGN_RUNTIME_UNSAFE`.

  Testado em processo real: uma pré-carga por `NODE_OPTIONS=--require …` que apaga `NODE_OPTIONS` de `process.env` (e esvazia `execArgv`) é recusada, pelo `tsx` e pelo artefato. No artefato, além disso:
  - sem o carregador do `tsx`;
  - `--permission` (ou `--experimental-permission`) e `--disable-sigusr1` obrigatórios em `execArgv` E na linha original;
  - ambiente VAZIO no original e em `process.env`: o próprio artefato impõe o `env -i`.

  Decisão: o caminho absoluto do node não é conferido pelo código (um node trocado no PATH já é código arbitrário e mentiria); fica na linha do runbook. Limite declarado: código que roda antes da barreira (pré-carga, `LD_PRELOAD`) pode reescrever a memória do processo; a barreira pega a configuração que ficou no bloco do exec, não uma estação comprometida (W5).
- **Custódia (critério iii):** `bothForms()` só segue com a forma dada quando a raiz proibida não existe (ENOENT/ENOTDIR). EACCES, EIO, EPERM, ELOOP, `ERR_ACCESS_DENIED` (modelo de permissões) ou erro sem código ⇒ `SECRET_PATH_UNSAFE` ("raiz proibida"), antes de abrir a chave. Consequência sob `--permission`: a linha precisa de leitura de `/tmp`, `/var/tmp` e `/dev/shm`, porque o modelo do Node não separa metadados de conteúdo.
- **Linha do runbook (critério i):** testada por `env -i` com o node por caminho absoluto, num pseudo-terminal (`script`), com chave gerada no teste. O node é da **linha 22** (a do CI e da produção, validada pelo job `sign-artifact`; decisão do manager, critério da W5):

  ```
  namei -m <pasta do artefato>/link-audit-sign.cjs   # nenhuma pasta do caminho com escrita para grupo/outros, salvo sticky (revisão abaixo)
  ( cd <pasta do artefato> && sha256sum -c <cópia conferida de p1-sign-artifact.sha256> ) && \
  env -i /caminho/absoluto/do/node-22 --disable-sigusr1 --permission \
    --allow-fs-read=<pasta do artefato> --allow-fs-read=<pasta das entradas> \
    --allow-fs-read=<pasta de manifestos> --allow-fs-write=<pasta de manifestos> \
    --allow-fs-read=<pasta da chave> --allow-fs-read=<cada pasta acima da chave>/.git (até /.git) \
    --allow-fs-read=/tmp --allow-fs-read=/var/tmp --allow-fs-read=/dev/shm \
    --allow-fs-read=/proc/self/cmdline --allow-fs-read=/proc/self/environ --allow-fs-read=/proc/self/fd \
    <pasta do artefato>/link-audit-sign.cjs sign <opções do §5.5>
  ```

  Os `.git` acima da chave são os caminhos que a custódia consulta por `lstat`; `/proc/self/fd` dá o caminho real do descritor da chave. Achado no Node 24.22: um grant que tem outro como prefixo de texto (`/var/tmp` e `/var/tmpfoo`, ou um mais longo dado antes do mais curto) faz o Node negar o mais curto. Por isso nenhum grant da linha pode ser prefixo de texto de outro (o teste confere).
- **fsync sob `--permission`: Node 22 × 24.22 (fato do CI) e decisões do manager (20/11/2026):** desde o Node 24.22.0, o modelo de permissões BLOQUEIA `fsync`/`fdatasync` (nodejs/node#65431); localmente (Node 24.22.3), `fsync` de arquivo e de pasta dá `ERR_ACCESS_DENIED`, e só `O_SYNC` funciona. No CI (Node v22.23.5), a assinatura COMPLETA sob `--permission` funcionou: `fsync` permitido, manifesto gravado, autoteste ok, e o hash do build igual ao versionado. O job ficou vermelho só por causa da sonda do TESTE, que tratava qualquer saída diferente de 0 como "fsync bloqueado". Decisões:
  1. **Gravação:** o `fsync` continua obrigatório, no arquivo e na pasta (§5.5.1 item 4). Nada de `O_SYNC` no lugar do `fsync` da pasta: sem prova de durabilidade, nunca sucesso.
  2. **Node da estação:** a linha 22, a mesma do CI e da produção, validada pelo job `sign-artifact`. É critério da W5 (plano) e está na linha do runbook acima.
  3. **Sondagem antecipada no código:** logo depois do analisador, o `sign` e o `close-key` abrem a raiz de `--seals-dir` só para leitura (`O_RDONLY|O_DIRECTORY`) e fazem `fsync` nesse descritor, com a mesma operação da gravação (`FileHandle.sync()`, `nodeFsyncProbe` em `sign-runtime.ts`).
     - `ERR_ACCESS_DENIED` no `fsync` ⇒ recusa `SIGN_RUNTIME_NO_FSYNC` (código novo, código 3, escolhido para separar do diagnóstico da T-008): "este node bloqueia fsync sob --permission; use a versão do node fixada no runbook (linha 22); nada foi lido nem assinado". Ela sai antes de ler qualquer entrada, da confirmação, da custódia e da frase.
     - Abertura que falha (pasta inexistente, arquivo, sem grant) é `unprobed` e segue para as recusas próprias do fluxo.
     - Roda também fora do modelo de permissões (`npm run`), onde o `fsync` funciona. Nada é gravado na sondagem.
     - Testes: por injeção (`blocked`, `ok`, `unprobed`; ordem depois da barreira do runtime e do analisador) e em processo real com o node local, que bloqueia: a recusa sai antes da confirmação e do pedido da frase.
  4. **Sonda do teste:** usa a mesma operação do produto, roda de um arquivo (não de `-e`) e distingue "fsync negado" (`ERR_ACCESS_DENIED` no sync, saída própria) de "sonda quebrou" (qualquer outra saída: o teste FALHA mostrando a saída). No modo estrito do CI exige a assinatura completa. Com o node local 24.22, o caminho esperado é a recusa antecipada do item 3, não mais `SIGN_WRITE_FAILED` depois da frase. Hipótese, não conferida (sem Node 22 local), para a falha da sonda antiga no CI: ela usava `fs.fsyncSync`, outra API que não a do produto.
  5. **Upload no CI:** último passo do job `sign-artifact`, com `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9` (v7.0.2, SHA de commit conferido pelo manager). Artefato `link-audit-sign-artifact` com o `.cjs` e o `.sha256` versionado lado a lado (`sha256sum -c` funciona no download), `if-no-files-found: error`, `retention-days: 90`.
- **`close-key` sob `--permission` (limite declarado, W5; não exercitado nesta fatia, o CI cobre o `sign`; a sondagem de fsync vale para ele também):** a revisão da W4.5 confere por `lstat` o modo das pastas ACIMA da pasta de recibos e a identidade das pastas acima da cópia do servidor. Como o modelo de permissões do Node concede a subárvore inteira de uma pasta, essas leituras exigem grants largos (na prática, `--allow-fs-read=/`, com a escrita só na cópia do servidor). Fica para a W5 decidir entre essa linha larga e uma conferência que não dependa do `lstat` das pastas acima.
- **CI:** job novo `sign-artifact` (os jobs existentes não mudaram), com `contents: read` e as actions fixadas por SHA de commit. Passos: `npm ci` → build → `sha256sum -c` contra o hash versionado → `tests/link-audit-seal-sign-artifact.test.ts` com `LINK_AUDIT_ARTIFACT_STRICT=1` (nada pode ser pulado) → upload do artefato e do hash (decisão 5 acima). O teste recompila na própria pasta e exige o mesmo hash versionado, então os bytes que ele executa são os do passo de build.
- **Isolamento:** testes novos ou ajustados:
  - o grafo de fontes a partir da entrada do artefato não alcança o `export`, o `snapshot-store`, a fachada do verificador, `evidence` nem `url-safety`, e os módulos de fora são só os da lista literal e o `zod`;
  - `sign-runtime.ts` só lê, por um descritor, com teto; a sondagem de fsync abre a pasta `O_RDONLY|O_DIRECTORY` e só sincroniza esse descritor;
  - a porta de disco é estreita, e o `snapshot-store` reexporta os mesmos objetos.

**Revisão independente da W4.6 (20/11/2026, `junin-02`, BLOQUEAR sobre `9711155`; achados 1–3 conferidos pelo manager e procedentes; corrigidos com testes antes do código):**

1. **MAJOR (era BLOCKER): `artifactSha256` × bytes executados.** O hash era calculado reabrindo `__filename` por caminho depois de o Node já ter carregado o artefato: quem escreve na pasta poderia trocar o arquivo, executar e restaurar o original antes do hash, ou editar o mesmo inode.
   - **Decisão do manager:** o hash do recibo é ANOTAÇÃO do próprio processo, não prova (um artefato alterado poderia imprimir o hash esperado fixo). O controle é a conferência ANTES da execução, com `sha256sum -c` imediatamente antes, na linha do runbook, sobre um arquivo sob custódia.
   - **Correção:** `artifactDigestUnderCustody` (`sign-runtime.ts`) reaproveita as rotinas que já existiam, sem duplicar: da custódia da chave, a abertura única (`openKeyFile`, `O_NOFOLLOW`), o caminho real do descritor e a leitura pelo mesmo descritor; dos recibos, a regra da pasta (`isProtectedDir`, agora exportada). Exige:
     - arquivo comum, sem nenhum bit de escrita (`mode & 0o222 = 0`), com dono = usuário que roda o comando ou root (`KeyFileStat` ganhou `uid`);
     - pasta do artefato, pelo caminho real do descritor, sem escrita para grupo e outros, salvo sticky (como na W4.5);
     - o caminho do descritor conferido de novo depois da leitura (troca durante a leitura ⇒ recusa).

     Violação ⇒ `SIGN_ARTIFACT_UNSAFE` (código novo, código 3) antes de qualquer entrada; falha de leitura continua `SIGN_ARTIFACT_UNREADABLE`. A linha do runbook ganhou `/proc/self/fd` também para o artefato.
   - **Pastas ACIMA da pasta do artefato (aceito pelo manager como limite declarado; ver a confirmação abaixo):** O manager pediu que elas também não fossem graváveis por terceiros. Sob `--permission` isso não é conferível dentro do processo: o `lstat` de uma pasta exige grant de leitura nela, e o grant do Node vale para a subárvore inteira (`/` no fim). Isso contraria o item 3 (grants estreitos; `/` recusado); foi conferido no Node 24.22 que, com só a pasta concedida, o `lstat` das pastas acima dá `ERR_ACCESS_DENIED`. O código confere o arquivo e a pasta dele; as pastas acima ficam com o runbook, imediatamente antes da execução (`namei -m <artefato>`), como já era para as pastas acima da chave (W4.4). Limite declarado: atacante com o mesmo usuário ou root fica fora da garantia (como na W4.5).
2. **MAJOR: guarda de imports da saída incompleta.** Passavam `process.getBuiltinModule('node:net')` e `require` usado como valor. No Node 22 o modelo de permissões não restringe rede, então esta guarda é o controle. Correção sem dependência nova (`checkArtifactText`):
   - toda ocorrência do identificador `require` no texto final é uma chamada direta `require("<módulo da lista>")`; como valor, membro (`x.require`) ou com nome calculado ⇒ recusa;
   - também são recusados `getBuiltinModule`, `process.binding`, `_linkedBinding`, `createRequire`, `module.constructor`, `_load`, `mainModule`, `process.dlopen`, `import(`, `import.meta`, `eval` (inclusive como valor) e `Function` (inclusive como valor, que escaparia de `new Function`/`Function(`);
   - exceções do zod embutido (`ZOD_FUNCTION_EXCEPTIONS`; na confirmação abaixo passaram a fixar o trecho INTEIRO, com SHA-256), cada uma retirada uma única vez e contada no teste (uma versão nova do zod que mude isso falha o build): o teste de eval de `util.allowsEval`, o JIT de `Doc.compile` (`core/doc.js`), o `z.compile` (`core/compile.js`, que o `sign` não usa, mas vem com o namespace `z`) e uma mensagem de erro. Quatro usos, não três: o quarto (`z.compile`) apareceu na conferência;
   - fixtures de mutação para cada caso. O esbuild normaliza `(require)('x')` e `module.require('x')` para `require("x")` estático; nesses casos a saída cai na lista literal (fixture com `node:net`), e a forma de membro no texto final é recusada no teste de `checkArtifactText`.

   Limite declarado (o mesmo da W4.2): a guarda é textual, e acesso por nome calculado (`process["getBuilt" + "inModule"]`) escapa dela. É defesa contra erro nosso e de dependência, não contra código malicioso no repositório. Sugestão, não adotada (muda a linha do runbook; decisão do manager): `--disallow-code-generation-from-strings` neutralizaria `eval`/`Function` em tempo de execução; o zod cai no caminho sem JIT.
3. **MAJOR: grants sem limite no modo artefato.** `artifactGrantsRefusal` (`sign-args.ts`) roda depois do analisador e antes da sondagem de fsync, sobre os grants de `execArgv` e da linha original do exec. Falha ⇒ `SIGN_RUNTIME_UNSAFE`. Critério mais simples que falha fechado:
   - todo grant é caminho absoluto, normalizado (sem `..` nem barra final), sem vírgula e sem `*`, e diferente de `/`;
   - `sign`: `--allow-fs-write` só na raiz REAL de `--seals-dir` (resolvida por `realpath`) ou dentro dela; `close-key`: só em `<seals-dir>/_closures`;
   - `sign`: leitura com pelo menos dois componentes (`/a/b`), o que recusa `/home`, `/etc`, `/usr` e `/root`. Exceções: `/tmp` exato (raiz temporária que a custódia resolve) e caminhos que terminam em `.git` (os `lstat` da custódia da chave, inclusive `/.git`). Leitura com dois componentes ou mais pode ainda ser ampla (ex.: a pasta inteira do usuário): limite declarado;
   - `close-key`: a leitura ampla continua limite declarado até a W5, mas `/` e `*` também são recusados lá; com isso, o `close-key` não completa sob o artefato (item 5).
4. **MINOR, pré-existente (não corrigido aqui; o manager leva ao plano):** `publishExclusive` (`snapshot-store.ts`) ignora a falha do fsync da pasta e devolve `ok`. Não é o caminho do `sign`, que usa `sign-run.ts` e responde `SIGN_WRITE_UNCONFIRMED`.
5. **MINOR: `close-key` com sucesso sob o artefato** fica para a W5. Os limites já registrados são as leituras amplas das pastas acima dos recibos e da cópia do servidor, agora também barradas pelo item 3 (`/` recusado).

**Confirmação da revisão da W4.6 (20/11/2026, `junin-02`, sobre `1af8ba7`; três itens parciais, corrigidos com testes antes do código):**

1. **Pastas acima da pasta do artefato: limite declarado, aceito pelo manager.** O manager não pediu mudança de código.
   - **Por que não é conferido no código:** sob `--permission`, o `lstat` de uma pasta exige grant de leitura NELA. O grant do Node vale para a subárvore inteira, e as pastas acima chegam a `/`. Conferi-las exigiria grants de leitura largos, que o item 3 da revisão proíbe; a estação é dedicada (D15.3).
   - **O que o código confere:** pelo descritor aberto, o arquivo (comum, sem escrita, dono = usuário ou root) e a pasta imediata (sem escrita para grupo e outros, salvo sticky).
   - **O que o runbook confere, imediatamente antes da execução:** `namei -m <artefato>` (nenhuma pasta do caminho com escrita para grupo/outros, salvo sticky) e `sha256sum -c` contra o hash versionado.
   - **Ataque que sobra:** um terceiro com escrita numa pasta ACIMA da pasta do artefato pode trocá-la (renomear a pasta e pôr outra no lugar) DEPOIS do `namei`/`sha256sum` e antes do `node` abrir o arquivo. Fica fora da garantia, como o atacante com o mesmo usuário ou root. A condição do runbook (pastas acima sem escrita de terceiros) é o que fecha isso.
2. **Exceções do zod na guarda da saída: fixadas inteiras.**
   - **(a)** Antes eram prefixos (`compile(){const F=Function;`, `const F=Function;const factoryCode=`): uma mudança depois do prefixo poderia usar o apelido `F` sem disparar a guarda. Agora cada exceção (`ZOD_FUNCTION_EXCEPTIONS`) fixa a função ou o trecho INTEIRO, do começo ao fim, pelo texto exato da saída e pelo SHA-256 dele (conferido antes do uso; texto e hash divergentes ⇒ `ArtifactBuildError`):
     - `util.allowsEval` (227 bytes);
     - `Doc.compile` (227 bytes);
     - `compileFn` do `z.compile` (1072 bytes);
     - a mensagem do JSON Schema.

     Qualquer diferença deixa o `Function` do trecho sem exceção, e a guarda recusa. Testes: o prefixo antigo seguido de outro uso de `F`, 1 caractere mudado, um `F()` acrescentado no fim e a repetição são recusados; as quatro, inteiras, passam; cada uma aparece exatamente uma vez no artefato.
   - **(b) Defesa em profundidade:** `scripts/link-audit-sign-artifact-zod.ts`, importado PRIMEIRO pela entrada do artefato, faz `config({ jitless: true })`. No zod 4.6.7 travado, cada esquema de objeto decide o JIT na CONSTRUÇÃO (`const jit = !globalConfig.jitless`, `core/schemas.js`), e `util.allowsEval` não testa `new Function` quando `jitless`. Por isso a configuração precisa rodar antes de qualquer módulo do `sign` construir um esquema. Teste: no artefato real, com uma pré-carga que só observa (`Proxy` sobre `Function`, contando `construct`/`apply`), carregar todos os módulos dá `FUNCTION_CALLS=0`; sem o `jitless` (mutação), o teste do `allowsEval` já chama `Function` na carga. A configuração vale só para o artefato; o `npm run link-audit:seal` e o servidor não mudam.
   - **Mutações:** exceção reduzida ao prefixo, 1 caractere no texto fixado e o `jitless` removido são pegos pelos testes.
3. **Grants pelo caminho real.** No artefato, cada caminho de `--allow-fs-read`/`--allow-fs-write` tem de existir e ser igual ao próprio `realpath`: nenhum componente é link. A escrita é comparada com a raiz REAL de `--seals-dir` (resolvida por `realpath`), então `--seals-dir` dado por um link passa com o grant do caminho real. Exceções, cada uma com a regra que falha fechado:
   - concedidos LITERALMENTE, só para leitura: `/proc/self/cmdline`, `/proc/self/environ` e `/proc/self/fd` (links do próprio kernel; o Node confere o texto do caminho), e `/tmp`, `/var/tmp` e `/dev/shm` (as raízes que a custódia resolve; podem faltar ou ser link numa distribuição);
   - leitura que não existe só passa se terminar em `.git` (a custódia da chave consulta a AUSÊNCIA desses caminhos). Um `.git` que existe e é link é recusado;
   - escrita que não existe (a subpasta que o `sign` ainda vai criar, ou `_closures` no `close-key`) só passa se a pasta existente mais próxima acima for o próprio caminho real e o texto estiver dentro da área de escrita;
   - qualquer outra falha do `realpath` ⇒ recusa.

   Testes: grant que é link para fora, grant com um componente intermediário que é link, leitura inexistente, escrita que, resolvida, cai fora de `--seals-dir` (link dentro da pasta de manifestos), escrita por um apelido da própria pasta e `.git` que é link. Todos dão `SIGN_RUNTIME_UNSAFE` antes de qualquer entrada. As pastas dos testes passaram a ser usadas pelo caminho real.

O hash versionado passou a `2198b1bea7fe59c25ba21f465de17e65462c626ec1970ff3a6863949529f9513` (749 964 bytes). O módulo do `jitless` muda o artefato. Foi conferido em duas pastas e numa cópia do repositório em outro caminho.

**Segunda confirmação da revisão da W4.6 (20/11/2026, `junin-02`, sobre `980e6f1`):** itens 1 e 2 fechados. O item 3 tinha dois furos, corrigidos com testes antes do código:

- **(a) Manifesto nunca em pasta temporária.** A comparação aceitava igualdade com a raiz de `--seals-dir`: com `--seals-dir /tmp` (ou `/var/tmp`, `/dev/shm`, ou o caminho real de uma delas), um grant de escrita igual à raiz passava, contra a regra de que as raízes temporárias são só leitura. Agora, no artefato:
  - a raiz REAL de `--seals-dir` que coincide com uma raiz temporária, fica dentro dela ou a contém é recusada (`SIGN_RUNTIME_UNSAFE`);
  - qualquer grant de escrita que se sobreponha a uma raiz temporária também é recusado;
  - as raízes são as PADRÃO da custódia (`/tmp`, `/var/tmp`, `/dev/shm` e TMPDIR/TMP/TEMP do ambiente, vazio no artefato), pelo caminho dado e pelo real (`bothForms` da custódia, agora exportado), nunca as injetáveis dos testes;
  - raiz temporária cujo caminho real não se resolve por qualquer motivo que não seja inexistência (EACCES, EIO, ELOOP, `ERR_ACCESS_DENIED` do modelo de permissões, erro sem código) ⇒ recusa (a linha do runbook já concede leitura às três). Raiz INEXISTENTE (`ENOENT`/`ENOTDIR`, ex.: estação sem `/dev/shm`) segue só com a forma dada: nenhum arquivo real pode estar dentro dela, e recusá-la impediria estações legítimas (decisão do manager na confirmação final do junin-02).

  Testes: cada raiz como `--seals-dir`, uma pasta dentro de cada uma (com e sem grant de escrita) e o caso válido fora delas. Os testes do artefato em processo passaram a manter a pasta de manifestos numa estação no HOME (as entradas e a chave continuam em pastas temporárias); a assinatura completa no pseudo-terminal já criava a estação no HOME.
- **(b) Pai real do `.git` ausente.** Uma leitura inexistente terminada em `.git` passava sem conferir o pai: `link/.git` ausente sob um pai que é link também passava. Agora o pai tem de existir e ser o próprio caminho real:
  - prova direta: `realpath(pai) = pai`;
  - sob `--permission`, o pai (uma pasta acima da chave, como `/home` ou `/`) não é concedido e a leitura dele é negada. Aí a prova é o pai ser a própria pasta ou uma pasta acima de um grant já conferido como o próprio caminho real e existente: sem nenhum componente link nesse grant, as pastas acima dele também não têm link e existem;
  - qualquer outra falha (pai inexistente, link, outro erro) ⇒ recusa.

  Testes: `.git` ausente sob pai que é link e sob pai inexistente, em processo e sob `--permission` (pai fora dos grants); `.git` ausente cujo pai está acima de um grant real passa.
- **Achado na verificação:** o teste em processo real com o artefato montado em `/tmp` concedia a pasta do artefato antes de `/tmp`. Pelo comportamento já registrado do Node 24.22 (grant mais longo dado antes do mais curto), a leitura de `/tmp` era negada. O teste passou a conceder só `/tmp`, que já cobre o artefato.

O hash versionado passou a `395d5ba946e3f6b45c9689828947ca49107d3a9940db4f4ca4574233c1dda17d` (751 417 bytes), conferido em duas pastas e numa cópia do repositório em outro caminho.

**Notas da W5.2a (22/11/2026, pendências 1 e 2 da W5.2: `sign-core.ts`, `sign-args.ts`, o teste do artefato e o job `sign-artifact`; prevalecem sobre o limite do `close-key` registrado nas notas da W4.6 e no item 3 e no item 5 da revisão independente da W4.6):**

- **D15.6(d), operador = custodiante:** o passo 9 passa a marcar `requiresLaterReview: true` também quando `approval.operator` coincide com `--custodian` (mesma comparação de rótulos da W4.1: NFKC, sem caixa e sem separadores, errando para "coincide"). Não bloqueia e não liga `roleException`, que continua sendo só conferente = custodiante. Testes IA-16 no núcleo (`link-audit-seal-sign-core.test.ts`) e no recibo do CLI (`link-audit-seal-sign-cli.test.ts`). Mutação: retirar o caso ⇒ os dois testes falham. Isso fecha a pergunta aberta das notas da W4.1 e da W4.4.
- **`close-key` sob `--permission`, linha final (decisão do manager sob a delegação D15):**

  ```
  mkdir -p <pasta de manifestos>/_closures
  namei -m <pasta do artefato>/link-audit-sign.cjs
  ( cd <pasta do artefato> && sha256sum -c <cópia conferida de p1-sign-artifact.sha256> ) && \
  env -i /caminho/absoluto/do/node-22 --disable-sigusr1 --permission \
    --allow-fs-read=/ --allow-fs-write=<pasta de manifestos>/_closures \
    <pasta do artefato>/link-audit-sign.cjs close-key <opções das notas da W4.5>
  ```

  - **Regra no código (`grantsShapeRefusal`, `sign-args.ts`):** no artefato, `--allow-fs-read=/` passa SÓ no `close-key` e SÓ como o único grant de leitura. Os grants de `execArgv` e da linha original do exec contam juntos, e o mesmo texto repetido conta como um. `/` junto de qualquer outro grant de leitura (inclusive `/proc/self/*`, as raízes temporárias e os `.git`) ⇒ `SIGN_RUNTIME_UNSAFE` com mensagem própria: `/` é prefixo de texto de qualquer caminho, e o Node nega o grant mais curto (notas da W4.6). `/` como grant de escrita, `/` no `sign` e `*` continuam recusados pela forma, como antes. A escrita continua só em `<seals-dir>/_closures`.
  - **`_closures` tem de existir antes da execução.** Achado na conferência (Node 24.22, sonda local): para um caminho que não existe, o Node concede só o próprio caminho, não a subárvore. Com `--allow-fs-write=<seals>/_closures` e `_closures` ausente, o `mkdir` da pasta passa, mas gravar o temporário dentro dela dá `ERR_ACCESS_DENIED`. Com a pasta já criada, gravar, `link()` e remover dentro dela funcionam. O código do `close-key` criaria a pasta e só falharia na gravação, depois da confirmação e da frase. **Decisão (lado que falha fechado):** no artefato, um grant de escrita do `close-key` que não existe ⇒ `SIGN_RUNTIME_UNSAFE` ("`_closures` tem de existir antes da execução"), antes de ler qualquer entrada. O `mkdir -p` da linha acima é obrigatório. **Aprovado pelo manager (22/11/2026):** por decisão do manager, isso altera, só para o `close-key`, a exceção do item 3 da confirmação da revisão da W4.6, que aceitava `_closures` inexistente.
  - **O mesmo tratamento no `sign` (decisão do manager, 22/11/2026):** o `sign` aceitava um grant de escrita inexistente dentro de `--seals-dir` (a subpasta da auditoria). Pelo mesmo comportamento do Node, esse grant não deixa gravar o manifesto dentro da subpasta, e a recusa vinha tarde, como `SIGN_WRITE_FAILED` depois da confirmação e da frase, sem nada assinado. Agora, no artefato, todo grant de escrita do `sign` que não existe ⇒ `SIGN_RUNTIME_UNSAFE` ("cada --allow-fs-write tem de existir antes da execução"), antes de ler qualquer entrada, da confirmação e da frase, e nada é criado. Com isso, a exceção de "escrita que não existe" do item 3 da confirmação da revisão da W4.6 deixa de valer também para o `sign`. A linha do runbook do `sign` concede a raiz de `--seals-dir`, que existe, e não muda. Testes: direto, em processo (nenhuma entrada lida, nem confirmação nem frase, subpasta não criada) e em processo real sob `--permission`, antes da sondagem de fsync. Mutação: tirar a checagem no `sign` ⇒ 3 testes falham.
  - **Limite declarado:** a leitura larga **não amplia a escrita**, que continua só em `_closures`. Ela deixa o processo ler qualquer arquivo que o usuário da estação lê. Isso é aceito porque a estação é dedicada e fica sem rede durante a execução (D15.3), e o artefato não carrega módulo de rede (guarda de imports da W4.6). No Node 22, o modelo de permissões não restringe rede: quem fecha esse lado é a estação desligada da rede.
  - **Testes:** a regra pelas combinações, com a mensagem de cada recusa fixada, de modo que cada mutação cai numa recusa diferente da esperada; a exigência de `_closures` existente; o `close-key` completo do artefato em processo (fecho gravado, objeto `--json` conferido com os bytes, a cadeia coberta `AUTHENTICATED` com R `retired:<closureSha256>`); e o mesmo em processo REAL, por `env -i`, com `--permission` e a linha acima, num pseudo-terminal. Em processo real também são conferidos `_closures` ausente, `/` com outra leitura e `/` no `sign`. Mutações: aceitar `/` no `sign`, aceitar `/` como grant de escrita, aceitar `/` junto de outro grant de leitura e tirar a regra de `_closures` existente. Todas são pegas.
  - **Exercitado no CI:** o job `sign-artifact` roda esse arquivo de teste em modo estrito com a linha 22, e o `close-key` em processo real tem de completar. O sucesso prova o `fsync` do temporário e da pasta `_closures`, porque a gravação só devolve sucesso depois dos dois (`SIGN_WRITE_FAILED`/`SIGN_WRITE_UNCONFIRMED` se não). Com o node local (24.22), o caso para na sondagem antecipada (`SIGN_RUNTIME_NO_FSYNC`), antes dos recibos, da confirmação e da frase. Conferência local adicional, fora do repositório: numa cópia descartável do artefato com o `fsync` neutralizado, o `close-key` completou sob `--permission` real no Node 24.22 (fecho gravado em `_closures` e cadeia autenticada). Isso mostra que nada além do `fsync` é negado pela linha decidida.
- **`.git` que é link simbólico pendente (revisão do PR #59, `wk2`, MENOR):** um grant de leitura terminado em `.git` com `realpath` em ENOENT virava "ausente" sem conferir o próprio caminho. O `realpath` de um link PENDENTE também dá ENOENT, e esse `.git` passava no pré-teste dos grants. A custódia da chave o recusava, mas só depois de ler as entradas e da confirmação. Agora o `.git` só conta como ausente se o `lstat` dele também der ENOENT (`gitTrulyAbsent`). Link pendente, ou qualquer outra resposta do `lstat`, ⇒ `SIGN_RUNTIME_UNSAFE` ("próprio caminho real") no pré-teste, antes de qualquer leitura. O `lstat` vem da mesma porta de disco da custódia (`KeyFileOps`). Sob `--permission`, o `lstat` do próprio caminho concedido é permitido. Testes: em processo (nenhuma entrada lida, nem confirmação nem frase) e em processo real sob `--permission`. Mutação: voltar ao ENOENT sem `lstat` ⇒ os dois testes falham.
- **Hash do artefato:** o código do grafo do artefato mudou quatro vezes nesta fatia. O build da base reproduziu `395d5ba9…` antes das mudanças. A mudança do D15.6(d) deu `893b9c21edf7765e14879cc6595f9dc40e898c37f2752cafc51e05f5cc36c76b`; a regra dos grants do `close-key`, `a4c2842d4b0105046641a1a41b73a56a2f027f2dd577f3b535017c9b614fc43a`; o mesmo tratamento no `sign`, `26c6aba810f9da1ec5456fb0e2addb79b1f20e0f58ca1dc3338069d493ea0622`; e a correção do `.git` pendente deu o valor final, `d2df18c525de54bab0e241d15b2e12e2d0009e76f6571cf1892fd07adb369a4a` (753 267 bytes), versionado em `docs/phase6-auditoria-link/p1-sign-artifact.sha256`. O teste e o CI recompilam e recusam qualquer diferença.
- **Hash do artefato depois da W5.2b (22/11/2026):** a W5.2b mudou o esquema da captura (`src/lib/link-audit-evidence/types.ts`, marca da coleta SIMULADA, §5.7), que o artefato empacota; sozinha, sobre `395d5ba9…`, ela dava `08ee1c75dc771c1d6ca5c52afe7b81161068c19fc3d58c00c6b9074989437a03`. No merge com a W5.2a o hash foi REFEITO pelo build reprodutível com as duas mudanças juntas (nenhum dos dois valores foi escolhido): `78de412ec59a944ca75b00d80f2daadd9b511ffe88816059a1942c26469002cb` (753 462 bytes), igual em duas pastas e conferido por `sha256sum -c`. O comportamento do `sign` e do `close-key` não muda com a W5.2b.
- **Hash do artefato depois da revisão do PR #62 (22/11/2026):** a marca da coleta SIMULADA entrou no pacote (`schemas.ts`) e o `sign` ganhou a opção
  `--simulated` (`sign-args.ts`, `sign-core.ts`, `sign-terminal.ts`, `sign-run.ts`, `sign-cli.ts`; §5.7). O build reprodutível dá
  `37797893cdcc5fb64578cc41f08f0b403793ad464b2663a657a5d539eeefb5a1` (754 422 bytes), igual em duas pastas e conferido por `sha256sum -c`; os testes do artefato passam com ele. Para pacote real, o
  `sign` se comporta exatamente como antes (mesmo plano, mesma tela, mesmo recibo).
- **Hash do artefato depois da confirmação da revisão do PR #62 (22/11/2026):** o `sign` passou a exigir chave de ensaio (id `ensaio-…`) com
  `--simulated` e a recusá-la sem ele (`sign-core.ts`, `sign-args.ts`, `sign-chain.ts`; §5.7). O build reprodutível dá
  `2fbf9851c34b2dd309d082cbb974669a0534eacd0b6aa3b7902d8ac841d440ab` (755 532 bytes), igual em duas pastas e conferido por `sha256sum -c`; os 19 testes do artefato passam.
- **Hash do artefato depois da P9.3b (23/11/2026):** a criação exclusiva do `sign` (`linkExclusive`, `commitFile`, `subDir` e `rootIsReal`) saiu
  de `sign-run.ts` para o módulo compartilhado `src/lib/link-audit-attestation/exclusive-write.ts`, **sem mudança de comportamento** (as recusas
  continuam as do `sign`, passadas pelo chamador), para o receptor de manifestos do host usar a mesma gravação (spec
  `docs/specs/ci-deploy-and-seal-delivery.md` §5.7 passo 7). O build reprodutível dá
  `978121b48fb3486b4de087cef1095051dd51cf6bd310fdb1edb2f0eef7578255` (755 844 bytes), igual em duas pastas e conferido por `sha256sum -c`; os
  testes do artefato, do disco do `sign` e do `close-key` passam sem alteração. Depois da revisão do PR #72, a gravação compartilhada ganhou um
  gancho OPCIONAL de conferência logo antes do `link()` (`beforeLink`, usado só pelo receptor: lista relida, raiz e subpasta conferidas, `fsync` da
  raiz); o `sign` não o passa e se comporta como antes. O build reprodutível dá `4d16072f87744ab3a1a47ac85e2f331a7b35695342fa4f56631fa0c0d67c8224` (756 102 bytes), igual em
  duas pastas e conferido por `sha256sum -c`.
- **Teste, isolamento:** a limpeza da estação no HOME dos testes do artefato passou a ser registrada no nível do arquivo. Registrada dentro de um teste antes de qualquer `await`, ela ficava presa àquele teste e apagava a pasta para os seguintes (aparecia só ao rodar parte dos testes). Registrada tarde, numa execução completa, ela não rodava e deixava a pasta no HOME.

### 5.6 Manifesto `v2` e verificador `v2` (onda W3, contrato próprio)

**Decisão de 16/11:** `v2` **antes do primeiro resultado de produção**, com `dossier.sha256` e `prevSealSha256` **dentro da parte assinada**.

```jsonc
{ "schemaVersion": 2, "kind": "LINK_AUDIT_EVIDENCE_SEAL", "auditId": "…", "seq": 1, "sealedAt": "…Z",
  "keyId": "…", "entries": [ { "ref": "…", "contentSha256": "<hex64>" } ],
  "dossier": { "id": "…", "sha256": "<hex64>" },
  "prevSealSha256": "<hex64>" | null,            // null se e somente se seq = 1
  "signature": "<base64url 86>" }
```

- `sealSha256(arquivo)` = SHA-256 de `canonicalJson` do arquivo completo (corpo + `signature`) — **proposta**, a fixar no contrato W3 (evita dependência de espaços/quebras de linha numa cópia administrativa).
- **Dossiê congelado antes da assinatura:** `dossier.sha256` cobre o **dossiê de aprovação** (pacote, resultado das verificações, aprovação, observações). Os dados que só existem **depois** (`seq`, `keyId`, `sealSha256`, data) vão para o **registro de assinatura** (recibo), arquivado ao lado e ligado ao dossiê. **O contrato §5 lista esses dados no dossiê: ajustar o texto do contrato na W0.**
- **Verificador `v2` (mudança aditiva em `provenance.ts`, a aprovar no contrato W3):**
  1. aceita `schemaVersion` 1 e 2 (`v1` **continua legível**); um verificador **antigo** só-`v1` recusa `v2` (`SEAL_INVALID`) ⇒ **o verificador `v2` deve estar implantado antes de qualquer `v2` ser entregue**;
  2. para `v2` com `seq > 1`: o antecessor `seal-(seq-1).json` existe, é parseável (`v1` ou `v2`) e `sealSha256(antecessor)` = `prevSealSha256` (**só o hash**; a assinatura do antecessor **não** é exigida, pois a chave dele pode ter sido aposentada); `seq = 1` exige `prevSealSha256 = null`; caso contrário, novo motivo `SEAL_CHAIN_BROKEN`;
  3. **cumulatividade:** `entries` do último ⊇ `entries` do antecessor com os mesmos hashes (`SEAL_NOT_CUMULATIVE`) — acréscimo desta spec ao pedido de "continuidade", a confirmar no contrato;
  4. a cobertura **bidirecional** atual permanece (base ⊆ manifesto: `EVIDENCE_NOT_SEALED`/`EVIDENCE_HASH_MISMATCH`; manifesto ⊆ base: `EVIDENCE_MISSING`);
  5. **anti-rebaixamento (a confirmar):** em produção o último manifesto deve ser `v2`; `v1` só com opção explícita (homologação/testes). Sem isso, uma chave comprometida assinaria um `v1` com `seq` maior e escaparia das checagens 2–3;
  6. novos motivos entram em `EvidenceTrustReason` de forma aditiva (conferir consumidores que fazem `switch` exaustivo).
- Testes adicionais de RS-20 entram na W3 (manifesto e evidências de A sob B; `auditId` não normalizado).

### 5.7 Coleta SIMULADA para o ensaio da W5 (W5.2b, 22/11/2026; manager sob a D15)

**Problema.** O ensaio da W5 roda numa pilha de homologação sem Serper e sem dados reais (D-G0-12), mas o passo S-02 precisa de uma
captura `c0001` no layout versionado e do hash `source.capture.sha256` impresso em `--json` (IA-19), que o `export` exige. O coletor
só tinha DRY_RUN e LIVE; o modo SIMULATED existia só no runtime, sem gravar evidência. Regra que manda: uma evidência simulada **nunca**
passa por real.

**Comando** (homologação, sem rede):
`GMN_LINK_AUDIT_HOMOLOGATION=1 npm run link-audit:collect -- --simulated --audit <auditId> --operator <e-mail> --evidence-dir <pasta> --json`.
Link, identificadores e empresa são **fixos e sintéticos** (`Empresa de Ensaio`, `Cidade de Ensaio`/`ZZ`, FID `0x0:0xe5a10`, CID `940560`,
sem site nem telefone); `--link`, `--name`, `--city`, `--uf` e as opções do LIVE são recusados. O corpo é gerado em memória; nenhuma rede,
nenhum arquivo de ambiente lido, nenhum provedor real criado. A captura grava `request.url` = `simulado://ensaio-homologacao/maps`,
`attempts: 0` e status 200 (não houve HTTP: o status é o que o pipeline exige para gerar o relatório, e a captura inteira vai marcada).
Códigos de saída como no LIVE (0 ok, 1 uso, 3 recusado antes de gravar, 4/5 falha na gravação).

**Travas, em camadas:**

1. **Defesa principal (já existia).** Em produção a lista de chaves só tem a chave real; o manifesto do ensaio é assinado pela chave
   descartável, que não está na lista ⇒ `SEAL_INVALID` (verificador `v2`: `verifiedPositions` em `provenance-core.ts`, "a key absent from
   the list is SEAL_INVALID (V2-30)"; caminho `v1`: `classifyLatestV1`) ⇒ `UNAUTHENTICATED` ⇒ `EVIDENCE_PROVENANCE_UNPROVEN` bloqueia a
   finalização.
2. **Coletor.** Só com `--simulated` **e** `GMN_LINK_AUDIT_HOMOLOGATION=1` (exatamente `1`, do ambiente do comando). Sem a trava (com ou
   sem `NODE_ENV=production`) ⇒ recusa, código 3, antes de qualquer pasta ou provedor. O runtime também só grava evidência simulada com
   `homologation: true`, só com o gerador sintético (provedor injetado ou real ⇒ recusa) e só com a identidade sintética (defesa em
   profundidade).
3. **Marca persistente, dentro do hash.** A captura leva `provider: "SIMULATED"` e `simulated: true` (o esquema exige os dois juntos ou
   nenhum); o relatório leva `source.provider: "SIMULATED"`, `source.simulated: true` e uma limitação explícita. A marca entra no
   `contentSha256` da captura, que é o `source.capture.sha256` do `--json`, o `--collector-hash` do `export`, a entrada `capture:c0001`
   do pacote e do manifesto. **Revisão do PR #62 (decisão do manager):** a marca também ENTRA no pacote, como campo opcional
   `simulated: true` (só o literal, só no simulado), dentro do `packageSha256`; nos pacotes reais o campo não existe, e a forma e o hash
   deles não mudam. Aprovação e manifesto `v2` **não mudam de formato** (D15.6(e): `entries[].source` continua fora; nada de `v3`). Captura simulada e captura real não se misturam na mesma auditoria: o pré-voo do armazenamento recusa nos dois sentidos
   (no LIVE, antes de pagar). A pré-checagem falha fechada (revisão do PR #62): só a pasta da auditoria comprovadamente inexistente (ENOENT)
   conta como vazia; listagem que falha por outro motivo, ou captura existente que não se lê, é recusa.
   **Reserva exclusiva do modo (confirmação da revisão do PR #62, decisão do manager):** o modo da auditoria (`LIVE` ou `SIMULATED`) é
   reservado UMA vez, antes da primeira captura, no marcador `audit-mode.json` da pasta da auditoria, publicado com `publishExclusive`
   (temporário + `link()` que nunca sobrescreve; selado com `contentSha256`). O runtime reserva no pré-voo, antes de consumir a autorização
   e de pagar; o pré-voo e cada gravação (`writeCapture`) conferem o marcador e recusam o outro modo nos dois sentidos (`MODE_CONFLICT`;
   marcador ilegível ⇒ recusa). Duas coletas concorrentes de modos diferentes: exatamente uma reserva, a outra é recusada (testes com duas
   gravações no mesmo processo, dois processos e dois runtimes). Auditoria antiga sem marcador: o modo vem das capturas (todas legíveis e do
   mesmo modo). **Resposta paga nunca descartada (QUARENTENA, 3ª rodada da revisão do PR #62, decisão do manager):** se a gravação de uma
   resposta LIVE paga na auditoria pedida falhar por QUALQUER motivo (modo trocado numa corrida, marcador ilegível depois do pré-voo, disco),
   o runtime grava o mesmo corpo e os metadados da captura, mais o motivo (código) e o `auditId` pedido, num arquivo NOVO da quarentena: a
   subpasta reservada `_quarentena-resgate-live` da raiz de evidências (o nome começa por `_` e nunca é um `auditId` válido; o leitor, as
   listagens e o armazenamento não a tratam como auditoria), criado com escrita exclusiva (`wx`), modo 0600 e fsync, com nome
   `<auditId>-<carimbo da coleta>-<16 hex aleatórios>.json` (nunca reutiliza, sobrescreve nem deduplica). Nada entra na auditoria pedida,
   nenhum relatório é gerado e o caso sai como erro (código 5 no CLI), com o nome do arquivo. Se a quarentena também falhar, a mensagem de
   sempre ("NÃO foi persistida") traz os dois códigos. A quarentena **nunca** é lida pelos fluxos de auditoria; a recuperação é manual e fica
   com o responsável (runbook do custodiante §11.1). Substitui a auditoria de resgate `<auditId>-resgate-live` da rodada anterior, que tinha
   id previsível (podia cair numa auditoria existente, ou num `MODE_CONFLICT` que perdia a resposta) e colidia por causa do corte em 64
   caracteres. **Casos com marca própria (rodada final da revisão do PR #62):** (i) captura PUBLICADA na auditoria pedida cuja releitura falha:
   a cópia vai igualmente para a quarentena, com `reason.publishedUnverified: true` e `reason.publishedCaptureNumber`, e a mensagem avisa que a
   captura pode já estar na auditoria (conferir antes de recuperar); "não publicada" mantém o motivo simples; (ii) pasta da quarentena: depois do
   `mkdir` e do `chmod 0700`, o `lstat` confere diretório comum (link ou não diretório ⇒ recusa: o arquivo iria para outro lugar), dono = usuário do
   processo (quando há `getuid`) e `mode & 0o077 === 0`; se não der para garantir, o arquivo AINDA é gravado 0600 (preservar a resposta paga vem
   primeiro) e o retorno leva `dirPermissionsUnverified`, que o runtime informa como erro; (iii) fsync da pasta que falha ⇒ sucesso com
   `durability: "UNCONFIRMED"` e a mensagem "gravada na quarentena; durabilidade não confirmada (fsync da pasta falhou)", nunca "PRESERVADA". Em
   todos, o caso sai como erro (código 5). **Limite declarado:** a janela entre o `lstat` da pasta e a criação do arquivo não é fechada (não
   reproduzimos `openat`); só o próprio usuário do volume de evidências consegue explorá-la, e ele já pode escrever na pasta de qualquer modo.
   O marcador de modo não é evidência (fica fora do conjunto atestado) nem assinatura.
4. **`export`.** Auditoria com captura simulada ⇒ `EXPORT_SIMULATED_CAPTURE` (código 3), salvo com `--simulated` **e** a mesma trava,
   conferida em duas camadas testadas cada uma sozinha (a recusa antecipada do CLI e a montagem pura do `export`, que recebe a opção e a
   trava separadas);
   `--simulated` sem a trava, ou numa auditoria sem captura simulada ⇒ a mesma recusa. Com a trava, a saída avisa "SIMULADA — ensaio" e o
   `--json` traz `simulated: true` (ausente nas exportações reais: a forma estável não muda). A trava é a única leitura do ambiente do
   processo no `export`, feita em `src/lib/link-audit-evidence/simulated.ts` (só a variável da trava; o CLI e os módulos do `export`
   continuam sem olhar o ambiente); a lista fechada de imports do CLI ganhou esse módulo (teste de isolamento revisto).
5. **Leitor e interface.** A fonte aparece como "SIMULADA — ensaio" (lista e detalhe das evidências), com selo próprio. O relatório
   simulado atribui os dados ao gerador sintético, nunca ao Serper: `data.googleMaps.source: "SIMULATED"`, `verified[].viaSerper: false`
   e os textos do pipeline que diziam "obtido via Serper" reescritos (revisão do PR #62); o detalhe das evidências troca os rótulos de origem.
   Na confirmação da revisão: a base de pontuação leva `provider: "SIMULATED"` na evidência simulada (o mapeador só aceita o par coerente
   `provider SIMULATED` + `simulated: true`), o relatório gravado registra `calls.simulatedMaps` no lugar das chamadas ao Serper, o relatório em
   memória da coleta simulada gravada é reescrito para o gerador sintético, e a prévia expõe `company.source` ("Gerador sintético do ensaio
   (SIMULADA)") e `evidence.simulated`, usados pela matriz de critérios e pelo painel da empresa. Nas coletas reais, chaves e textos não mudam.
5a. **`sign` (revisão do PR #62).** Pacote com `simulated: true` só é assinado com a opção própria `--simulated` (o `sign` roda com `env -i`:
   nada de variável de ambiente); sem ela ⇒ `SIGN_SIMULATED_PACKAGE` (código 3), e `--simulated` com pacote real também. A recusa vem logo
   depois de o pacote aprovado e íntegro ser conhecido, antes da confirmação humana e da frase. Com `--simulated`, a tela da confirmação
   mostra "ATENÇÃO: SIMULADA — ensaio" antes da digitação. O recibo não muda de forma.
5b. **Chaves de ensaio `ensaio-…` (confirmação da revisão do PR #62, decisão do manager, sem `v3`):** o id da chave descartável do ensaio
   começa pelo prefixo reservado `ensaio-`, e o modo fica visível no próprio manifesto assinado (o `keyId`). (a) `sign --simulated` só aceita
   chave `ensaio-…` (a chave ativa de produção é recusada); (b) `sign` sem `--simulated` recusa chave `ensaio-…` (as duas: `SIGN_KEY_MODE_MISMATCH`,
   código 3, no analisador, antes de ler qualquer entrada, e de novo no núcleo da cadeia); (c) a lista de confiança do servidor
   (`GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS`, composta em `src/app/api/link-audit/scoring/shared.ts`) com qualquer id `ensaio-` é recusada inteira
   (política fechada: nada autentica) salvo com `GMN_LINK_AUDIT_HOMOLOGATION=1` no web; (d) o runbook do custodiante e o roteiro do ensaio
   mandam gerar a chave descartável com id `ensaio-…`. Nenhum teste ou fixture usa `ensaio-` para chave real.
6. **Prévia e finalização (ponto escolhido: o bloqueio da prévia, que a finalização já respeita).** Base com evidência simulada ⇒
   bloqueio `SIMULATED_EVIDENCE`: `BLOCKING` sem a trava no servidor (a finalização responde `NOT_FINALIZABLE`; a conclusão de uma
   pendente também é recusada) e `WARNING` com `GMN_LINK_AUDIT_HOMOLOGATION=1` no web da pilha de homologação (o S-13 depende disso).
   A `stack.yml` de produção não declara a variável (teste de configuração).

**Limites declarados.** (a) Quem escreve na pasta de evidências pode tirar a marca e recalcular os hashes (o SHA-256 não é assinatura,
§5.3): a marca é defesa em profundidade; a garantia continua sendo a lista de chaves de produção (camada 1). (b) O resultado gravado
sobre a captura simulada (só na homologação) não leva a marca no próprio arquivo: ela é alcançável pelo hash da captura citada, e as
chaves do ensaio não estão na lista de produção (reconferência da R2.2). (c) O artefato do `sign` empacota o esquema da captura
(`src/lib/link-audit-evidence/types.ts`): o hash versionado do artefato muda nesta fatia, sem mudança de comportamento do `sign`
(histórico no §5.5.1: `08ee1c75…` sobre a base; `78de412e…` depois do merge com a W5.2a; `37797893…` depois da revisão do
PR #62; `2fbf9851…` depois da confirmação dela). (d) **Limite declarado (decisão do manager na revisão do PR #62):** o modo SIMULATED do runtime SEM armazenamento e com provedores
injetados, que vem da Onda 4B e só os testes usam, não exige a trava; ele não grava nada. O runtime antigo não muda; um teste estático garante
que o único chamador do runtime é o CLI de coleta, que nenhuma chamada dele injeta provedores (o SIMULATED do CLI usa só o gerador
sintético, com a trava e gravando) e que nenhuma rota, página, componente ou worker importa o runtime.

## 6. Critérios de aceite (cada item vira ao menos um teste automatizado)

Invariantes (i)–(v) do contrato §3:

- [ ] **IA-01 (i) — recusas (a)–(d):** um teste por recusa, fixtures em memória/pasta temporária **sem** chave real: (a) hash mudado e entrada sumida no manifesto anterior ⇒ `SIGN_EVIDENCE_CHANGED`; (b) pacote com item legado ⇒ `SIGN_LEGACY_NOT_ATTESTABLE` (inclusive com dossiê e aprovação válidos); (c) pacote ≠ aprovado ⇒ `SIGN_PACKAGE_MISMATCH`; (d) `FAIL` em verificação ⇒ `SIGN_INTEGRITY_NOT_OK`; integridade ≠ `OK` ⇒ `SIGN_PACKAGE_INVALID` já no passo 1, porque o esquema da W1 fixa `integrity.status = "OK"` (notas da W4.1 e revisão da W4.1 no §5.5.1). Em todas: código 3, **nenhum** manifesto criado, chave **não aberta** (espião no leitor de chave: 0 chamadas).
- [ ] **IA-02 (ii) — nunca escreve na pasta de evidências, e o `sign` nem a abre:** (1) o `FsOps` do leitor no `export` é um proxy que falha o teste em qualquer escrita; (2) árvore em modo `0444/0555`: `export` funciona; (3) hash da árvore idêntico antes e depois; (4) `--out` dentro da pasta ⇒ `EXPORT_OUT_UNSAFE`; (5) `sign` com `fs` falso que **falha em qualquer caminho fora de pacote, aprovação, dossiê, aceite formal de risco (`--risk-acceptance`, quando indicado), pasta de manifestos e arquivo de chave** (RS-04); a custódia da IA-22 só consulta **metadados** (`lstat`/`realpath`) da pasta do arquivo de chave, dos `.git` das pastas acima dele, da raiz do projeto e das pastas temporárias, sem ler conteúdo (notas da W4.3 e da W4.4 no §5.5.1).
- [ ] **IA-03 (iii) — ida e volta:** o manifesto `v2` produzido é `AUTHENTICATED` pelo verificador `v2` real, com a pública derivada, sobre as evidências lidas por `readScoringBasis` (layout versionado). **Falha com 1 byte alterado** (a) de qualquer `contentSha256`, (b) de `signature`, (c) de `seq`/`keyId`/`sealedAt`/`dossier`/`prevSealSha256`, (d) do arquivo de evidência ⇒ `UNAUTHENTICATED`. **Vetor-ouro** (RS-09): corpo, bytes canônicos em hex e assinatura de chave de teste, travados em arquivo de teste e verificados pelo verificador **e** pelo artefato do `sign`; mudança de `canonicalJson`/esquema exige nova `schemaVersion`.
- [ ] **IA-04 (iv) — a chave privada nunca é impressa nem gravada:** com chave e frase-senha sentinela, capturar stdout, stderr, `--json`, mensagens de erro (inclusive exceções forçadas), `argv`, `process.env`, `os.tmpdir()`, diretório de trabalho e **todas** as escritas de arquivo: nenhuma contém a chave em hex/base64/base64url/PEM nem a frase-senha. Forçar erro durante a assinatura ⇒ saída genérica (código fixo). Chave sem proteção ⇒ `SIGN_KEY_UNPROTECTED`. Relatórios de diagnóstico do Node desligados (`process.report`) (RS-13).
- [ ] **IA-05 (v) — sem rede:** com `fetch`, `net.Socket#connect`, `dns.*`, `http(s).request` trocados por armadilhas, `export` e `sign` completam; teste estático garante que o grafo de imports **não** inclui Supabase, Serper, Redis, `ioredis`, `bullmq` nem leitura de `.env*`; **para o artefato do `sign`:** nenhum `import`/`require` fora de `node:crypto|node:fs|node:path|node:readline|node:process` e sem `child_process`. Roda também em `scripts/run-isolated.sh`.

Adicionais:

- [ ] **IA-06 — manifesto de outra auditoria é recusado:** (1) o verificador rejeita manifesto da auditoria A na pasta da B; (2) `sign` recusa `--audit` ≠ `auditId` do pacote/aprovação/subpasta (`SIGN_AUDIT_MISMATCH`); (3) `sign` recusa cadeia cujo último manifesto tem `auditId` diferente (`SIGN_SEAL_CHAIN_INVALID`).
- [ ] **IA-07 — `seq` correto:** sem manifesto + `--first --expect-seq 1` ⇒ `seal-0001.json`; com `seal-0003.json` válido ⇒ `seq = 4`; `--expect-seq` ≠ calculado ⇒ `SIGN_SEQ_MISMATCH`; sem `--first` e sem manifestos ⇒ recusa; `--first` com manifesto existente ⇒ recusa; nome do arquivo = `seq` assinado.
- [ ] **IA-08 — cumulativo e exato:** `entries` = exatamente o conjunto do pacote, ordenado e sem repetição; contém todas as entradas do anterior com os mesmos hashes; nova revisão de relatório entra, nada some; `prevSealSha256` = `sealSha256` do anterior (`null` só no `seq = 1`).
- [ ] **IA-09 — conjunto idêntico ao do verificador:** a lista do `export` é igual, ref a ref e hash a hash, à que `preview.ts:219` entrega ao `classify` para a mesma pasta, **via a função única extraída na W1** (teste de equivalência, versionado).
- [ ] **IA-10 — determinismo:** duas exportações do mesmo conjunto e mesmos argumentos produzem o mesmo `packageSha256`; qualquer mudança em ref/hash/resumo/verificação muda o hash.
- [ ] **IA-11 — pacote adulterado:** alterar uma entrada do `--package` sem refazer o hash ⇒ `SIGN_PACKAGE_INVALID`; refazendo o hash sem reaprovar ⇒ `SIGN_PACKAGE_MISMATCH`.
- [ ] **IA-12 — não sobrescreve:** `seal-NNNN.json` existente nunca é alterado (`SIGN_SEQ_CONFLICT`); duas execuções simultâneas para o mesmo `seq` ⇒ exatamente uma grava.
- [ ] **IA-13 — lixo na pasta:** symlink, FIFO e arquivo acima do limite na pasta da auditoria ⇒ `EXPORT_INTEGRITY_NOT_OK`/`EXPORT_NOT_FOUND`, **sem travar**, sem seguir o link.
- [ ] **IA-14 — dados pessoais (RS-21):** nenhuma saída de `sign` nem a saída padrão de `export` contém nome da empresa, telefone, endereço, URL, corpo, e-mail do operador ou caminho de disco; só `auditId`, `seq`, códigos, rótulos curtos e hashes.
- [ ] **IA-15 — falha fechada na entrada e segredo:** flag desconhecida/repetida/sem valor ⇒ código 1; `--key-source` com valor de chave ⇒ recusa sem eco; opções com nome de senha/chave/PIN ⇒ `SECRET_VIA_ARGV_FORBIDDEN`; variável de ambiente de segredo ⇒ `SECRET_VIA_ENV_FORBIDDEN`; stdin não-TTY ⇒ recusa.
- [ ] **IA-16 — separação de papéis (RS-01):** `approvedBy = custodian` sem `riskAcceptance` ⇒ `SIGN_ROLE_SEPARATION`; com aceite ⇒ assina e recibo traz `roleException` e `requiresLaterReview`; `operator = approvedBy` ⇒ assina com `requiresLaterReview`; `operator = custodian` ⇒ assina com `requiresLaterReview` (D15.6(d), W5.2a).
- [ ] **IA-17 — verificações (RS-02):** `FAIL` ⇒ recusa sempre; `NOT_EXECUTED` sem resultado humano `PASS` ⇒ `SIGN_CHECK_NOT_EXECUTED`; um teste por `id` mecânico do §5.3.1.
- [ ] **IA-18 — leitura única (RS-04):** mutar `--package` entre a leitura e a assinatura (`fs` injetado devolvendo bytes diferentes numa 2ª leitura) não altera o que foi assinado; trocar 1 byte do pacote depois da aprovação ⇒ recusa.
- [ ] **IA-19 — hash do coletor em `--json` (RS-05):** (1) teste do coletor com `deps.out` injetado, sem rede, prova que a saída `--json` contém `source.capture.sha256` de 64 hex **igual** ao `contentSha256` relido da captura, e que o modo legível **não** o contém (documenta por que o procedimento exige `--json`); (2) `export` sem `--collector-hash` para captura nova ⇒ `EXPORT_COLLECTOR_HASH_REQUIRED`; hash divergente ⇒ `EXPORT_COLLECTOR_HASH_MISMATCH`.
- [ ] **IA-20 — janela (RS-06):** intervalo acima de `--max-gap-hours` sem justificativa ⇒ `EXPORT_GAP_EXCEEDED`; sem `--max-gap-hours` para captura nova ⇒ uso (1); o intervalo entra no pacote e no hash.
- [ ] **IA-21 — verificador `v2` (W3):** aceita `v1` e `v2`; antecessor ausente/hash diferente ⇒ `SEAL_CHAIN_BROKEN`; `seq = 1` com `prev ≠ null` ou `seq > 1` com `null` ⇒ inválido; manifesto que **omite** evidência presente ⇒ `EVIDENCE_NOT_SEALED`; que lista evidência **ausente** ⇒ `EVIDENCE_MISSING`; que omite entrada do antecessor ⇒ `SEAL_NOT_CUMULATIVE`; `v1` com `seq` maior em modo produção ⇒ recusado; verificador só-`v1` recusa `v2`; manifesto/evidências de A sob B e `auditId` não normalizado ⇒ recusa (RS-20).
- [ ] **IA-22 — custódia (RS-12/RS-15):** arquivo de chave sob árvore com `.git`, no projeto, em `os.tmpdir()`, com permissão diferente de 0600/0700 ⇒ `SECRET_PATH_UNSAFE`; em texto claro ⇒ `SECRET_NOT_ENCRYPTED`; `find` na árvore temporária após rodar não acha arquivo novo; **token (K2):** teste de interoperabilidade — assinatura Ed25519 pura do dispositivo verificada por `crypto.verify(null, …)` com a pública no formato de `TRUST_KEYS`.
- [ ] **IA-23 — confirmação humana (passo 11):** sem TTY ⇒ recusa; prefixo digitado errado ⇒ `SIGN_CONFIRMATION_FAILED`; certo ⇒ prossegue (TTY injetado).
- [ ] **IA-24 — execução restrita (RS-14):** o artefato do `sign` sob `node --permission` falha com `ERR_ACCESS_DENIED` ao tocar qualquer caminho fora da lista; paridade `canonicalJson` artefato ≡ verificador.

## 7. Casos-limite

### 7.1 Cadeia de manifestos anterior

**Divergência registrada:** o verificador atual usa só o maior `seq` e **não** confere continuidade, validade do antecessor nem cumulatividade (`provenance.ts:226-247`); logo, hoje o produtor seria a única barreira contra um manifesto que omita algo antes atestado. **Como fica resolvida:**

1. **Produtor (passo 7–8 do `sign`):** recusa `seq` fora de `último + 1`, cadeia inválida e qualquer entrada anterior removida/alterada.
2. **`v2` (`prevSealSha256`, dentro da parte assinada) + verificador `v2` (§5.6):** o último manifesto prova de qual antecessor descende; apagar, substituir ou pular manifestos quebra `prevSealSha256` (`SEAL_CHAIN_BROKEN`); a cumulatividade é conferida também no servidor.
3. **O verificador continua recusando, nos dois sentidos, manifesto que omita evidência presente:** evidência da base fora do manifesto ⇒ `EVIDENCE_NOT_SEALED`; manifesto que lista o que a base não tem ⇒ `EVIDENCE_MISSING`. A v2 **acrescenta** continuidade; não afrouxa nada.
4. Resíduo declarado: até a W3 estar implantada, vale só a barreira do produtor; por isso a **W3 precede a W4** e nenhum `v2` é entregue antes do verificador `v2`. Quem tem a chave privada continua podendo assinar o que quiser (limite do contrato §7).

| Situação | Comportamento do `sign` |
|---|---|
| Pasta de manifestos ausente/vazia e `--first` + `--expect-seq 1` | `seq = 1`, `prevSealSha256 = null`. Sem `--first`: `SIGN_SEAL_CHAIN_INVALID` |
| Pasta ausente/vazia mas `--expect-seq > 1` | Recusa: indica manifesto **apagado** na cópia da estação. Nunca "recomeçar" |
| Último manifesto malformado, assinatura inválida, chave desconhecida ou `auditId` diferente | `SIGN_SEAL_CHAIN_INVALID`. **Não** assina por cima nem recua. Recuperação = incidente (runbook de chaves §4) |
| Lacuna de numeração ou nomes duplicados em caixas diferentes | `SIGN_SEAL_CHAIN_INVALID` |
| Chave do último manifesto aposentada | Verifica com `--trust-keys <id:pub,...>`; desconhecida ⇒ `SIGN_SEAL_CHAIN_INVALID` |
| Mais de 2000 entradas ou manifesto > 256 KiB (`MAX_SEAL_BYTES`) | `SIGN_TOO_MANY_ENTRIES`; nada gravado |

### 7.2 Evidência

- **Já atestada que sumiu ou mudou:** recusa (a). Capturas/relatórios novos entram; o resto permanece idêntico.
- **Pacote aprovado ≠ pacote a assinar:** recusa (c) (hash dos bytes lidos uma vez).
- **Legado (AUD-001): NÃO ATESTÁVEL** (decisão de 16/11). Permanece consultável e rotulado; **nunca finalizável**. `export` ainda serve como relatório (`attestable: false`); `sign` recusa. **Quando o P1 existir, fazer coleta LIVE nova** (W6) em vez de atestar o legado; premissa a confirmar na autorização: a nova coleta usa **`auditId` novo**, senão a pasta conteria legado e o pacote seria recusado.
- **Pacote misto (legado + novo):** `attestable = false`; recusado.
- **Symlink / FIFO / arquivo grande:** o leitor existente recusa; o comando traduz em `EXPORT_INTEGRITY_NOT_OK`/`EXPORT_NOT_FOUND` e **não adiciona** leitura própria.
- **Captura sem hash registrado do coletor** (coletada antes do procedimento, ou sem `--json`): não atestável (RS-05, fail-closed); coletar de novo.
- **Arquivos fora do conjunto** (`site-*`, `serper-attempts`, `summary`, `run-*`): **não** são atestados; o resumo declara "não cobertos".

### 7.3 Ambiente e concorrência

- **Sem rede:** nenhuma verificação online de chave, relógio ou revogação.
- **Dois custodiantes ao mesmo tempo:** `wx` impede sobrescrita na mesma pasta; entre estações o conflito só aparece na **entrega**. Regras: (1) `--expect-seq` vem do registro externo único; (2) o administrador **nunca sobrescreve** `seal-NNNN.json` entregue; o segundo refaz a partir da cadeia atualizada; (3) manifesto assinado sobre cadeia desatualizada **não deve** ser entregue (com `prevSealSha256` o verificador `v2` o recusaria).
- **Relógio:** regressão ⇒ recusa; adiantamento arbitrário não é detectável (declarar).
- **Interrupção:** arquivo temporário **sem segredo** no mesmo diretório de manifestos + `link` sem sobrescrever; sobra nunca é lida como manifesto (`SEAL_FILE`).

## 8. Como o comando recebe a chave privada — **decisão de 16/11/2026**

Requisito (contrato §2): a chave **nunca** em argv, variável de ambiente, log ou arquivo temporário; fora da VPS, do repositório e das pastas de evidências/manifestos.

| Opção | Estado | Como funciona |
|---|---|---|
| **K2 — token de hardware com Ed25519 puro** (`external:<id>`) | **PREFERIDA** | O comando monta o **corpo canônico** e o entrega ao dispositivo; a assinatura é produzida **dentro** dele (PIN no dispositivo/SO); o comando monta o `seal-NNNN.json` e o verifica com a pública antes de gravar. A privada nunca chega ao processo. **Exige** Ed25519 **puro**, compatível com `crypto.verify(null, …)` (RS-15; OpenPGP assina outro enquadramento, incompatível) e um acréscimo aditivo a `provenance.ts` (montar o manifesto a partir de assinatura externa), parte da W3/W4 |
| **K1 — chave PKCS#8 cifrada + frase-senha** (`file:<caminho>`) | **Alternativa, na falta de K2** | `createPrivateKey({passphrase})`; a frase vem **só do terminal sem eco** (exige TTY). Recusa chave sem criptografia (`SIGN_KEY_UNPROTECTED`) e caminho inseguro (`SECRET_PATH_UNSAFE`, `SECRET_NOT_ENCRYPTED`). Limite declarado: o Node não zera `KeyObject` |
| ~~K3 — chave por stdin~~ | **Descartada** | Incompatível com "frase digitada no terminal sem eco" e com `stdin` não-TTY ⇒ recusa (RS-11) |
| ~~Chave em argv, variável de ambiente, PEM sem proteção em disco/temporário~~ | **Proibidas** | Aparecem em `ps`/histórico/`/proc`; contrariam o contrato §2 |

Requisitos comuns: (1) só depois de todas as verificações que não precisam da chave (§5.5 passos 1–11); (2) a pública derivada é impressa; (3) o autoteste usa **só** a pública; (4) nenhuma persistência nem cache da frase; (5) erro sem detalhe do material.

**Tensão a resolver (não resolvível só com documentos):** token por PKCS#11/PIV costuma exigir biblioteca nativa ou utilitário externo (`child_process`), o que **conflita** com RS-14 ("sem `child_process`, sem dependência em tempo de execução"). A forma de acesso ao dispositivo depende do **dispositivo concreto** (decisão aberta, §13.3). Se exigir utilitário externo, abrir exceção explícita e isolada (o utilitário só assina o corpo canônico) ou ficar em K1.

### 8.1 Variáveis de ambiente de segredo (IA-15)

O `sign` recusa se existir variável cujo nome case com um padrão fixo no código (ex.: `GMN_*` contendo `KEY|PASS|PIN|SECRET`, `*PASSPHRASE*`). É uma barreira de higiene, não prova de ausência.

## 9. Dossiê (contrato §5): o que o comando faz e o que é processo humano

O dossiê tem **duas partes** (§5.6): **(A) dossiê de aprovação**, congelado antes da assinatura (hash dentro do manifesto `v2`); **(B) registro de assinatura** (recibo), posterior.

| Elemento | Quem produz | Papel do comando |
|---|---|---|
| `auditId`, lista `ref → contentSha256`, hash do pacote | **Comando** (`export`) | Gera |
| Integridade local `OK`, verificações mecânicas `PASS/FAIL/NOT_EXECUTED`, intervalo coleta→exportação | **Comando** | Gera e **bloqueia** se `FAIL` (RS-02, RS-06) |
| Resumo (empresa, datas, contagens) | **Comando** | Gera (`NOT_VERIFIED`/`null` onde não há prova) |
| Hash do pacote aprovado = hash do assinado | **Comando** | **Valida** (recusa (c)) |
| Hash do dossiê de aprovação | **Comando** (`sign`) | Calcula e **liga ao manifesto** |
| `seq`, `keyId`, `sealSha256`, data, custodiante, hash do artefato do `sign` | **Comando** (`sign`) | Gera o **recibo** (parte B) |
| **Fonte** (execução LIVE) e o **hash do coletor em canal separado** | **Humano** | Registra; o `export` confronta o hash |
| Resultado de cada verificação **não mecanizável** (autorização consumida, painel do provedor, coerência de URL/consulta) | **Humano** (conferente) | Exige `humanChecks` com `PASS` e nota; não sabe se foi feita **bem** |
| Aprovação/recusa, observações, exceções, `riskAcceptance` | **Humano** | Só exige `approval.json` mínimo |
| Separação de papéis | **Humano**, com checagem do comando | `SIGN_ROLE_SEPARATION` |
| Revisão posterior de dossiês com `requiresLaterReview` | **Humano** (pessoa fora do fluxo) | Não executa |
| Entrega do `seal-NNNN.json` ao servidor | **Humano** (administrador) | Não entrega |
| Verificação pós-entrega ("Origem da coleta autenticada") | **Humano** | Não executa |
| Arquivamento cifrado do dossiê fora da VPS; registro do último `seq` | **Humano** | Não arquiva; `--expect-seq` depende disto |
| Livro de manifestos e conferência periódica contra o volume (RS-17); fingerprint da lista de chaves (RS-18) | **Humano**, procedimento da W5 | Não automatizado nesta spec |

## 10. Segurança

- **Autenticação/autorização:** CLI local, offline, na estação do custodiante/conferente; sem sessão nem Supabase. O leitor exige `authorize`: o CLI injeta adaptador **local, sem rede**; nunca usa `requireOperator`/Supabase.
- **Classificação:** chave privada = **segredo máximo**; manifesto, pacote, aprovação, recibo = **não secretos**; PII só nome/cidade/UF da **empresa**, apenas no arquivo do pacote e em `--show-summary`.
- **Entrada externa:** zod estrito na fronteira (pacote, aprovação, manifestos lidos, flags).
- **Escrita:** o único destino do `sign` é `--seals-dir/<auditId>/`; o do `export` é `--out`. Nenhum dentro da pasta de evidências (por `realpath`).
- **Estação:** a decisão sobre estação dedicada (sem navegador/IDE, disco cifrado, swap/hibernação desligados) **segue aberta** (§13.3); o `sign` não consegue impor isso, só recusar caminho inseguro de chave.
- **Limites residuais** (contrato §7): janela entre coleta e atestação (reduzida pelo hash `--json` em canal separado, **não** eliminada se o atacante for o próprio operador), fator humano, disponibilidade, replay de manifesto antigo, nada prova que o provedor disse a verdade.
- **Modelo de ameaças:** `docs/security/threats/link-audit-p1-atestacao.md` (conciliado nesta versão; §16).

## 11. Observabilidade

CLI offline, sem métricas nem alertas. Saída estável e testável: `--json` com `code` fixo por recusa; recibo arquivado no dossiê; nenhum log de conteúdo de evidência. O alerta quando uma auditoria `AUTHENTICATED` deixa de ser (RS-19) é do servidor e **não** entra aqui (ver `docs/specs/link-audit-observability.md`). Auditoria periódica dos dossiês é humana.

## 12. Rollout, compatibilidade e reversão

- Sem feature flag: **opt-in**. Nenhum arquivo existente é reescrito; formatos novos: `v2` do manifesto (aditivo no verificador, W3), pacote e aprovação (fora do repositório).
- Compatibilidade: capturas existentes inalteradas; o legado AUD-001 permanece não finalizável. A finalização continua fechada até existir manifesto + chave de confiança + volume de manifestos (fase 2 do ADR) + verificador `v2` implantado.
- Reversão: remover a chave pública da lista de confiança volta à política fechada (runbook §4).

## 13. Decisões registradas e questões abertas

### 13.1 Decisões registradas (responsável, 16/11/2026, seguindo a recomendação do método AISAC)

| # | Decisão | Onde se reflete |
|---|---|---|
| D1 | **Manifesto `v2` ANTES do primeiro resultado de produção**, com `dossier.sha256` e `prevSealSha256` na parte assinada (RS-10). Exige mudança aditiva no verificador (aceitar `v2`, conferir continuidade com o antecessor), **onda própria e contrato próprio**; o `v1` continua legível | §1, §5.1, §5.5, §5.6, §7.1, §14 (W3), IA-21 |
| D2 | **Comando de exportação entregue ANTES do de assinatura** (ondas separadas) | §1, §14 (W2 antes de W4) |
| D3 | **AUD-001 (legado): NÃO ATESTÁVEL.** Quando o P1 existir, **coleta LIVE nova** (autorização escrita específica; ~3 créditos Serper) em vez de atestar o legado | §2, §7.2, §14 (W6), IA-01(b) |
| D4 | **Separação de papéis:** conferente ≠ custodiante como regra padrão; se só uma pessoa operar, exige **aceite formal e escrito do risco** e **revisão posterior** dos dossiês | §5.4, §5.5 passo 9, IA-16 |
| D5 | **Custódia:** preferência por token de hardware com Ed25519 puro (compatível com `crypto.verify(null, …)`, RS-15); na falta, PKCS#8 cifrado com frase-senha digitada no terminal sem eco. A chave nunca entra por argv, variável de ambiente, log ou arquivo temporário | §8, IA-04, IA-15, IA-22 |
| D6 | **Hash da coleta via `--json`, sem mudar o coletor** | §3, §5.3, IA-19 |
| D7 | **Canal do manifesto até a VPS (decidido em princípio, 16/11/2026):** pelo pipeline de CI (deploy só por CI), nunca por cópia manual; o servidor confere a assinatura contra a chave pública fixada, que é o portão. Detalhes (onde o custodiante deposita o manifesto e quem escreve no volume) ficam para a W5 | §13.2 item 3, §14 (W5) |
| D8 | **Política de rotação da chave de atestação (forma decidida, 16/11/2026; completada pela D12 em 17/11/2026):** troca imediata por comprometimento (revogação do `keyId` na lista de confiança) e troca periódica ~~com período de convivência das duas chaves~~ em que as duas chaves **convivem só na lista** (a antiga apenas verifica; sobreposição de assinatura = 0, D12); limite de chaves que assinam ao mesmo tempo. Os números estão na D12 | §13.2 item 4, §14 (W4) |
| D9 | **ADR-0002 aceito (17/11/2026)**: a confirmação de resultados passa pelo livro de cabeças (`RUN_INTENT`/`RUN_CONFIRMED`; fase C do resultado só pelo autor). **Condição:** a emenda §16.17 da spec do livro passa por revisão independente antes do código da onda R1 | `docs/adr/0002-authenticate-result-receipts.md`, plano (R1) |
| D10 | **Pessoas (regra, 17/11/2026):** titular = o responsável, de preferência quem **não** administra a VPS (o administrador edita a lista de chaves); suplente = outra pessoa com **par próprio** registrado na lista (RS-16, nunca cópia). Se ninguém mais operar: titular sem suplente, com o **aceite formal e escrito** da D4, assinado pelo responsável antes de a chave real entrar (fim da W4). Perder a chave não invalida manifestos já assinados (a pública continua verificando); só bloqueia novas atestações até outro par ser gerado e registrado. Backup cifrado em local físico separado, restauração testada uma vez por ano | §8, §9, §14 (W4, W5), RS-16 |
| D11 | **Dispositivo (17/11/2026):** começar por **K1** (PKCS#8 cifrado, frase longa digitada sem eco) numa **estação dedicada e sem rede** (responde a pergunta 8 do modelo de ameaças). **K2** (token que assine Ed25519 puro pela PIV, ex.: YubiKey 5 com firmware ≥ 5.7) só depois do teste de interoperabilidade da RS-15 **e** de uma exceção escrita e isolada à RS-14 (o utilitário só assina o corpo canônico). A W4 começa com chave de teste em memória; a chave real entra no fim dela | §8, §14 (W4), RS-14, RS-15 |
| D12 | **Rotação, números (17/11/2026; completa a D8):** troca periódica a cada **12 meses**, junto com o teste anual de restauração; **convivência para assinar = 0** (a antiga para de assinar na troca); a aposentada continua **só verificando** o histórico (**sem validade por data**, que quem assina escolhe). **Mecanismo (revisão adversarial de 17/11/2026):** a regra "posições anteriores à primeira assinada pela nova" não é imponível sozinha (truncar a cadeia ou abrir auditoria nova reabriria a aposentada para quem guardasse a privada); o contrato do verificador `v2` propõe o **fecho de aposentadoria**, assinado por uma chave ativa, que lista as cabeças de cadeia em que a aposentada assinou; fora dele, ela não vale. **A aprovar com o contrato da W3;** no máximo **2 chaves que assinam** ao mesmo tempo (titular e suplente), aposentadas não contam. **Comprometimento:** revogar o `keyId` na hora; os manifestos dele deixam de valer para finalizações **novas** (falha fechada) e os resultados já confirmados com ele ficam **marcados para reconferência humana** (responde a pergunta 12 do modelo de ameaças). Requisitos do verificador `v2` (W3) | §5.6, §14 (W3), contrato do verificador `v2` |
| D13 | **`--max-gap-hours` = 24** (17/11/2026), igual à validade da autorização de coleta; quanto menor o intervalo, menos tempo a evidência fica sem atestação. Quem monitora: o conferente, no dossiê (o `export` bloqueia acima do limite) | §5.3, §14 (W2) |
| D14 | **Contrato do verificador `v2` aprovado (17/11/2026)** (`docs/phase6-auditoria-link/p1-contrato-verificador-v2.md`, PR #25): o **fecho de aposentadoria** (`<sealsDir>/_closures/<id>.json`, assinado offline por uma chave `active`, com o hash **fixado na lista de chaves** como `retired:<closureSha256>`) é a implementação da D12; **O2:** no máximo **16** itens na lista, e as aposentadas **permanecem** (item removido ⇒ `SEAL_INVALID`, nunca chave desconhecida tolerada); **O6:** o resultado grava `{headSeq, headSealSha256, keyIds}` (onda R2); **O7:** `MAX_CHAIN_SEALS = 256`, `MAX_CLASSIFY_BYTES = 16 MiB`, padrão do `dossier.id` do contrato, lacuna avaliada depois do pré-passo de revogação | §5.6, §14 (W3, R2), runbook §4 |

### 13.2 Questões que continuam abertas (do responsável)

1. ~~Titular e suplente~~ **regra decidida (D10)**; os **nomes** (e o do conferente) entram no runbook da W5.
2. ~~Dispositivo concreto~~ **decidido (D11)**: K1 primeiro; K2 só depois do teste da RS-15 e da exceção escrita à RS-14.
3. ~~Canal de entrega do manifesto à VPS~~ **decidido em princípio (D7)**; continua aberto **quem escreve no volume de manifestos** (o administrador da VPS, que também edita a lista de chaves, está fora da garantia "web comprometido não falsifica"), a fechar na W5.
4. ~~Política de rotação~~ **decidida**: forma na D8; prazo (12 meses), convivência para assinar (0) e chaves assinando ao mesmo tempo (2) na D12; limite total da lista (16, aposentadas permanecem) na D14.
5. ~~Limite de tempo entre coleta e exportação~~ **decidido (D13)**: 24 h; o conferente monitora no dossiê.

### 13.3 Pontos que esta conciliação deixou **sem decisão** (a confirmar)

- **Aprovação assinada pelo conferente (RS-03)**, com segundo par de chaves: não adotada; segue como pergunta 6 do modelo de ameaças.
- ~~Estação do custodiante dedicada~~ **decidida (D11: dedicada e sem rede)**; continua aberto o **arquivamento/revisão amostral de dossiês** (pergunta 10).
- ~~Resultados já confirmados antes de uma revogação de chave~~ **decidido (D12)**: marcados para reconferência humana, sem invalidar o histórico em silêncio.
- **`operator = conferente`:** a decisão D4 trata de conferente ≠ custodiante; aqui o acúmulo operador/conferente só gera `requiresLaterReview`. Confirmar se deve bloquear como no contrato Q2.
- **`entries[].source`** (RS-10): fora da D1; sem legado atestável, toda entrada é `LIVE`; incluir depois exige `v3`.
- **Detalhes do `v2`** da W3: `sealSha256` sobre `canonicalJson`, cumulatividade no verificador, anti-rebaixamento, novos motivos em `EvidenceTrustReason`.
- **Ferramenta de empacotamento** do artefato do `sign` e onde publicar o hash.

### 13.4 Decisões da W5 delegadas ao manager e autorização da W6 (20/11/2026)

O responsável delegou as decisões da W5 ao manager ("W5: pode decidir por mim Manager") e autorizou a W6 ("W6: Autorizado"). As decisões seguem o lado que falha fechado. Os nomes reais e os locais físicos **nunca** entram no repositório (público): aparecem só no dossiê e no livro de manifestos, guardados offline. No repositório valem os rótulos.

| # | Decisão |
|---|---|
| D15.1 | **Pessoas (§13.2 item 1; D10, D4).** O titular (custodiante) é o responsável, com o rótulo `CUST-01`. Hoje não há segunda pessoa, e vale a cláusula da D10: **sem suplente**, com aceite formal do responsável no dossiê antes da cerimônia da chave real. Risco declarado: se o titular ficar indisponível, as novas atestações congelam; o histórico não é afetado. O conferente tem de ser diferente do custodiante (D4). Enquanto não houver segunda pessoa, a chave real só assina com `--risk-acceptance` (aceite formal do responsável, com bytes e hash no dossiê), e toda atestação sai com `requiresLaterReview: true`, até haver um conferente distinto. |
| D15.2 | **Cópias da chave.** A K1 (PKCS#8 cifrada) fica em **duas mídias offline**, em dois locais físicos distintos sob controle do titular. Nunca vai para a VPS, a nuvem, o e-mail ou o repositório, e a frase-senha nunca fica junto da mídia. A restauração é testada na cerimônia e a cada 6 meses, com registro no livro de manifestos. Os locais ficam só no dossiê offline. |
| D15.3 | **Estação de assinatura (D11).** Linux dedicada, **sem rede durante a assinatura** e com **Node da linha 22**: a mesma do CI e da produção, validada pelo job `sign-artifact`, com a versão exata anotada no livro. O artefato vem do CI e é conferido por `sha256sum -c` contra o hash versionado imediatamente antes do uso. A estação não tem clone do repositório (a custódia recusa árvores com `.git`). A pasta da chave é 0700, e as pastas acima não podem ser graváveis por outros usuários. |
| D15.4 | **Derivação da frase (KDF).** PBES2 com **scrypt N = 2^17, r = 8, p = 1** (é o `MIN_SCRYPT_COST` do código) e AES-256-CBC. Frase-senha diceware de **7 ou mais palavras**. PBKDF2-HMAC-SHA256 só com 600 000 iterações ou mais (`MIN_PBKDF2_ITERATIONS`). O runbook confere o perfil completo (o aviso do código confere só o custo). |
| D15.5 | **Quem escreve no volume de manifestos (§13.2 item 3; D7).** Só o canal de entrega pelo CI. O servidor confere a assinatura contra a lista de chaves fixada antes de aceitar, e não há cópia manual. Limite declarado e mantido: o administrador da VPS, que também edita a lista de chaves, continua fora da garantia (§1). Os detalhes do canal fecham na W5. |
| D15.6 | **§13.3 e a pergunta da W4.1.** (a) A aprovação assinada pelo conferente com um segundo par de chaves (RS-03) **não é adotada agora**: sem segunda pessoa, não acrescenta nada. Volta à mesa quando houver conferente distinto. (b) **Dossiês:** arquivados offline junto do livro de manifestos enquanto o resultado existir. Revisão amostral trimestral (um dossiê ou 10 %, o que for maior), registrada no livro; sem segunda pessoa, a revisão é do próprio titular e fica marcada. (c) **`operator = conferente`:** continua só marcando `requiresLaterReview`, sem bloquear; o aceite formal da D15.1 cobre o acúmulo. (d) **`operator = custodiante`:** passa a marcar `requiresLaterReview: true` (mudança de código na W5). (e) **`entries[].source`:** continua fora (toda entrada é `LIVE`; incluir depois exige `v3`). |
| D15.7 | **Continua com o responsável (não delegável):** a cerimônia da chave real (gerar e guardar), a assinatura do aceite formal de risco, os locais físicos das cópias e todo deploy de produção. O ensaio da W5 usa **chave descartável** em homologação. |
| D15.8 | **Coleta SIMULADA do ensaio (W5.2b, 22/11/2026, manager sob a delegação da W5).** O S-02 usa o modo SIMULATED do coletor, só em homologação: dados sintéticos fixos, trava `--simulated` + `GMN_LINK_AUDIT_HOMOLOGATION=1`, marca `simulated: true` e provedor `SIMULATED` gravados dentro do hash da captura, `export` e finalização recusando a captura simulada sem a trava, interface rotulando "SIMULADA — ensaio". Forma, camadas e limites no §5.7. |
| D16 | **W6 autorizada** pelo responsável em 20/11/2026: **uma** coleta LIVE nova da AUD-001, no escopo da linha da W6 no plano (estimativa de cerca de 3 créditos Serper; nenhuma outra consulta paga). Ela **só roda depois do ensaio da W5 aprovado**, porque depende dele. A consulta usa a chave do Serper do ambiente de dev, que o manager não lê: o responsável executa o comando preparado no runbook. A atestação da coleta usa a chave real, na cerimônia (D15.7). |

## 14. Fatiamento em ondas

(Sugestão original desta spec. **Desde 16/11/2026 a fonte da verdade é `docs/plan/implementation-waves.md`**, que detalha estas ondas, acrescenta a onda **R1** (ADR-0002, confirmação de resultados pelo livro, antes do primeiro resultado de produção) e traz critérios verificáveis por onda. Cada onda: spec atualizada, testes no `package.json`, `typecheck` + testes do arquivo alterado, sem rede, sem chave real.)

| Onda | Entrega | Depende de | Observação |
|---|---|---|---|
| **W0** | Aprovar esta spec e o modelo de ameaças; ajustar o **contrato** `onda6c-contrato-p1-atestacao.md` (§3 passo 4, §5: dossiê em duas partes; §6; `v2` decidido; D1–D6); responder §13.2 | — | Sem código |
| **W1** | **Extrair a função única** `basis → EvidenceToProve[]` (de `preview.ts:219`) + **teste de equivalência**; esquemas do pacote/aprovação; `packageSha256` determinístico; viabilidade de `REPORT_REPRODUCES` | W0 | Nenhum CLI, nenhuma chave. IA-09, IA-10 |
| **W2** | **Exportação:** CLI `export` (somente leitura), `--collector-hash`, janela, verificações mecânicas | W1 | **Entregável sozinha** (D2). IA-02(1–4), IA-05, IA-13, IA-14, IA-17, IA-19, IA-20 |
| **W3** | **Verificador `v2`** (aditivo em `provenance.ts`) + **contrato próprio** (novo documento em `docs/phase6-auditoria-link/`, a aprovar **antes** do código): `v2`, `prevSealSha256`, `dossier`, continuidade/cumulatividade, anti-rebaixamento, assinatura externa para K2, vetor-ouro | W0 | Deve estar **implantado** antes de qualquer `v2` ser entregue. IA-21, IA-03 (parte do vetor-ouro), RS-20 |
| **W4** | **Assinatura:** núcleo de recusas com chave de teste em memória; depois entrada da chave (K2 e/ou K1), confirmação humana, autoteste, recibo, artefato empacotado | W1, W3, §13.2 (dispositivo) | IA-01, IA-03, IA-04, IA-06, IA-07, IA-08, IA-11, IA-12, IA-15, IA-16, IA-18, IA-22, IA-23, IA-24 |
| **W5** | **Procedimento e dossiê:** runbook do custodiante/conferente, modelo de dossiê (partes A e B), livro de manifestos e conferência periódica, procedimento do suplente; **ensaio ponta a ponta** em homologação com chave descartável (depende da fase 2 do ADR, volume de manifestos) | W4 | Documentação + ensaio; não toca produção |
| **W6** | **Coleta LIVE nova da AUD-001** (fora do escopo de código) | W5 e **autorização escrita específica** do responsável (~3 créditos Serper; sem consulta paga sem autorização, CLAUDE.md) | Registrar o hash `--json` em canal separado; seguir §3 e §5.3 |

## 15. Referências

- Contrato (base): `docs/phase6-auditoria-link/onda6c-contrato-p1-atestacao.md` (§2 custódia, §3 processo e invariantes, §4 conferência, §5 dossiê, §6 fronteiras, §7 riscos, §8 perguntas).
- ADR 6C-03: `docs/phase6-auditoria-link/onda6c-adr-proveniencia-evidencias.md` (§4 verificador, §6 legado, §7 plano e fases).
- Runbook de chaves: `docs/phase6-auditoria-link/onda6c-runbook-chaves.md` (§4 chave de atestação).
- Código reutilizado: `src/lib/link-audit-evidence/provenance.ts`, `scoring-basis.ts`, `reader.ts`, `legacy.ts`, `store.ts`, `types.ts`; `src/lib/link-audit-scoring-runs/preview.ts`; `src/lib/link-audit/canonical.ts`; `src/lib/link-audit/collector/capture-report.ts` (`source.capture.sha256`); `scripts/link-audit-collect.ts` (modo `--json`); padrão de CLI em `scripts/link-audit-evidence.ts`.
- Layout das evidências e legado AUD-001: `docs/phase6-auditoria-link/onda5a-persistencia-e-leitura.md`, `onda4d-pos-live-resgate.md`.
- Modelo de ameaças do P1: `docs/security/threats/link-audit-p1-atestacao.md`.

## 16. Rastreabilidade: requisitos de segurança (modelo de ameaças) → esta spec

Situação: **A** = adotado; **P** = adotado em parte (com o que ficou de fora); **N** = não adotado (com motivo).

| RS | Situação | Seção / critério | Nota |
|---|---|---|---|
| RS-01 papéis distintos | **P** | §5.5 passo 9; IA-16 | Conferente ≠ custodiante bloqueia (D4); operador = conferente ou operador = custodiante só marca revisão posterior (§13.3; D15.6(c) e (d)); exceção por aceite formal escrito, não "assinado pelo responsável" |
| RS-02 verificações `PASS/FAIL/NOT_EXECUTED` | **A** | §5.3.1; §5.5 passo 4; IA-17 | Itens não mecanizáveis offline ficam `NOT_EXECUTED` + resultado humano |
| RS-03 aprovação assinada (segundo par) | **N** | §2, §5.4, §13.3 | Decisão não tomada (pergunta 6); mitigação parcial: hash do pacote e do dossiê, confirmação digitada de 12 hex (IA-23), `v2` liga o dossiê |
| RS-04 pacote lido uma vez; não abre evidências | **A** | §5.5 (preâmbulo); IA-02(5), IA-18 | Mudança em relação à versão anterior (que reexportava) |
| RS-05 hash do coletor | **A (ajustado)** | §3, §5.3, §7.2; IA-19 | Via `--json` (`source.capture.sha256`), **sem alterar o coletor**; só o hash da captura, não o do relatório (este vai por reprodução, §5.3.1) |
| RS-06 somente leitura + janela | **A** | §5.3; IA-02, IA-13, IA-20 | Limite sem padrão (aberto, §13.2) |
| RS-07 recusas (a)–(d) + `seq`, entradas, `entries` vazio, `auditId` | **A** | §5.5 passos 1–8; §7.1; IA-01, IA-06, IA-07, IA-08 | |
| RS-08 legado só com fonte independente | **P** | §2, §7.2; IA-01(b) | Mais restritivo: `sign` **sempre** recusa legado (D3); fluxo de fonte independente = spec futura |
| RS-09 ida e volta + vetor-ouro + `schemaVersion` | **A** | IA-03, IA-24; §5.6 | |
| RS-10 `v2` com `dossier.sha256`, `prevSealSha256`, `source` | **P** | §5.6; W3; IA-21 | `source` **não adotado** (fora de D1). "Verificador v1 recusa v2 e vice-versa": só a primeira metade; o verificador `v2` **aceita** `v1` (D1: "continua legível"), com anti-rebaixamento em produção |
| RS-11 segredo fora de argv/env; TTY | **A** | §8, §8.1; IA-15, IA-04 | |
| RS-12 sem temporário; caminho/permissão do material | **P** | §8; IA-22 | Arquivo parcial do **manifesto** não é segredo; regra de `0600`/`.git`/tmp aplica-se ao arquivo de chave |
| RS-13 sem logger; códigos fixos; diagnóstico Node off | **A** | §5.2; IA-04 | Exceção ao logger do projeto registrada |
| RS-14 artefato único, sem dependências, `--permission` | **P** | §5.2; IA-05, IA-24 | `zod` embutido no artefato (não reescrito à mão); ferramenta de empacotamento e publicação do hash a decidir (W4); tensão com token (§8) |
| RS-15 hardware Ed25519 puro | **A** | §8 (K2); IA-22 | |
| RS-16 suplente, `keyId`, procedimentos, backup | **P** | §5.5 passo 16, §9; W5 | Procedimentos na W5; **não** há lista local de `keyId` autorizados no `sign` (a lista de confiança do servidor é o portão) |
| RS-17 livro e comando de conferência | **P** | §9; W5 | Procedimento humano; **comando automático não adotado** nesta spec; `v2` já detecta quebra de cadeia |
| RS-18 fingerprint da lista de chaves | **N** | §9; W5 | Exige mudança no servidor (fora do escopo); o administrador entra na decisão do canal de entrega (§13.2) |
| RS-19 alerta de regressão de autenticação | **N** | §11 | Servidor/observabilidade, outra spec |
| RS-20 testes do verificador e `sealedAt ≥ collectedAt` | **P** | W3; IA-21; §5.5 passo 10 | Testes adotados; a checagem fica **no produtor** (`lastCollectedAt` do pacote), não no verificador (`EvidenceToProve` não traz `collectedAt`) |
| RS-21 sem PII; dossiê cifrado | **A** | §5.3 (`--show-summary`), §9, §10; IA-14 | Arquivamento cifrado é procedimento (W5) |
