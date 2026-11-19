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
- **Atestar legado** (capturas anteriores ao layout versionado, ex.: TUVAPLAST): **NÃO ATESTÁVEL** (decisão de 16/11). `sign` recusa qualquer pacote com item legado. Um eventual fluxo de "fonte independente" seria spec futura com os critérios de RS-08 (§16).
- **Campo `entries[].source`** no manifesto (RS-10, terceira parte): não adotado (§16).
- **Aprovação criptograficamente assinada** pelo conferente com segundo par de chaves (RS-03): **não adotada** nesta versão (§16; segue aberta, §13.2).
- **Comando automático de conferência do livro de manifestos**, exposição do fingerprint da lista de chaves e alerta de regressão de autenticação no servidor (RS-17..RS-19): ficam como procedimento humano (W5) ou em outra spec (observabilidade).
- **Ferramenta de reassinatura** de registros antigos (proibida pelo runbook de chaves §3/§5) e **qualquer atestação automática**.
- Geração do par de chaves (máquina limpa, offline, pelo custodiante; só a pública sai), rotação e backup (runbook de chaves §4; custódia no contrato §2).
- Chamadas a Serper, Google, Supabase, Redis, VPS ou qualquer rede. A coleta LIVE nova da TUVAPLAST (W6) é **fora do escopo de código** e depende de autorização escrita específica.
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
| `--seals-dir` | Pasta de manifestos **da estação** (cópia do servidor + novo arquivo). Fora/não aninhada em pasta de evidências (por `realpath`, inclusive link simbólico) |
| `--expect-seq N` | **Obrigatório.** `seq` esperado, tirado do registro externo do dossiê/cofre, **não** da pasta. Divergência do calculado (`último + 1`) ⇒ recusa |
| `--first` | Obrigatório **se e somente se** `N = 1` |
| `--key-id` | `^[a-z0-9][a-z0-9-]{3,31}$` (rótulo público) |
| `--key-source` | `file:<caminho>` (K1) ou `external:<id>` (K2). **Nunca** o valor da chave (§8) |
| `--custodian` | Rótulo de quem assina |
| `--trust-keys` | Opcional: chaves públicas para verificar o manifesto anterior quando a chave dele foi aposentada |

**Ordem das verificações** (cada falha ⇒ código 3, **nada gravado**; a chave só é pedida/aberta **depois** de todas as que não precisam dela):

1. Recusar se houver variável de ambiente de segredo (§8.1) ou argumento com nome de segredo. Esquemas estritos de `--package` e `--approval`; `auditId` igual nos quatro lugares ⇒ senão `SIGN_AUDIT_MISMATCH`.
2. Recalcular `packageSha256` dos campos do pacote; ≠ campo do próprio pacote ⇒ `SIGN_PACKAGE_INVALID`.
3. **(c)** `approval.decision = APPROVED` e `approval.packageSha256` = hash recomputado ⇒ senão `SIGN_PACKAGE_MISMATCH` (pacote a assinar não é o aprovado) / `SIGN_APPROVAL_INVALID`.
4. **(d)** `package.integrity.status = OK`, `attestable = true` e nenhuma `checks[]` com `FAIL` ⇒ senão `SIGN_INTEGRITY_NOT_OK`. Cada `NOT_EXECUTED` exige `approval.humanChecks[id].result = PASS` com nota; senão `SIGN_CHECK_NOT_EXECUTED`.
5. **(b)** qualquer `entries[].legacy = true` ⇒ `SIGN_LEGACY_NOT_ATTESTABLE` (sem opção que contorne, RS-08).
6. SHA-256 de `--dossier` = `approval.dossier.sha256` ⇒ senão `SIGN_DOSSIER_MISMATCH`.
7. Cadeia de manifestos em `--seals-dir/<auditId>/` (§7.1): `último seq + 1` = `--expect-seq` ⇒ senão `SIGN_SEQ_MISMATCH`; último inválido/ausente-quando-esperado ⇒ `SIGN_SEAL_CHAIN_INVALID`.
8. **(a)** toda entrada do último manifesto existe no pacote **com o mesmo hash** ⇒ senão `SIGN_EVIDENCE_CHANGED` (informa `ref`, até 5). Entradas **novas** são permitidas. `entries` não vazio.
9. **Separação de papéis (RS-01, decisão de 16/11):** `approvedBy ≠ --custodian`; coincidência exige `approval.riskAcceptance` (aceite formal e escrito; existência e hash, conteúdo humano), senão `SIGN_ROLE_SEPARATION`. Com aceite, o recibo marca `roleException: true` e `requiresLaterReview: true`. `operator = approvedBy` não bloqueia, mas também marca `requiresLaterReview` (§13.3).
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

**Confirmação da revisão da W4.1 (19/11/2026, `junin-03`), pontos novos para a W4.2:**

- **`SIGN_KEY_NOT_ACTIVE` (§5.5.1 item 2) antes da confirmação humana:**
  - **Posição:** imediatamente antes do passo 11, isto é, depois de todas as recusas dos passos 1–10 e antes de `confirm` e de `openKey`. O custodiante nunca é chamado a confirmar, nem a chave é aberta, para uma chave que não assina.
  - **O que se confere:** `runSignWithChain` recebe `keyId` (o `--key-id`) e consulta o estado dele na lista `--trust-keys` já parseada pelo verificador (`parseTrustKeyring`). Ausente, `retired` ou `revoked` ⇒ `SIGN_KEY_NOT_ACTIVE`; só `active` segue. A mensagem diz o estado, sem repetir o id.
  - **Como chega ao núcleo:** o estado vai como fato estrutural (`signingKeyStatus: 'active' | 'retired' | 'revoked' | 'absent'`), e o núcleo continua sem importar o verificador. Qualquer valor diferente de `active`, inclusive fora de forma, é recusa.
  - **Lista inválida:** o estado é `absent`, mas a cadeia já a recusa no passo 7 (`PROOF_NOT_CONFIGURED`).
- **Formato do `--key-id`:** fora de `^[a-z0-9][a-z0-9-]{3,31}$` ⇒ `USAGE`, antes de ler qualquer coisa (nem a cadeia). O padrão é o do verificador (`TRUST_KEY_ID`, que ele não exporta). Foi copiado em `SIGN_KEY_ID_PATTERN`, sem mudar o verificador, com a paridade travada por teste contra `parseTrustKeyring`.
- **`SIGN_KEY_MISMATCH`:** depende da chave aberta e fica para depois do passo 12, na W4.3.
- **Isolamento:** nos arquivos do `sign` (`sign-*.ts`), nenhum `import(` cujo argumento não seja uma string literal simples e nenhuma forma de `require` (`require(`, `require.resolve`, `module.require`, `createRequire`). O código atual não tinha esse padrão; o teste pega a inserção de `import('./' + 'x')`.

- **Confirmação da W4.2 pelo `junin-03` (19/11/2026, aprovar com mudanças):** (i) a guarda contra `import()` com nome calculado e `require` passou a valer para todos os arquivos alcançáveis a partir dos arquivos do `sign`, inclusive o verificador e suas dependências, e não só para os `sign-*`; (ii) a mensagem de `--key-id` fora do formato diz "nada foi assinado nem gravado", porque na W4.3 as entradas já foram lidas quando ela sai; (iii) o achado de que `$` aceitaria um `\n` final foi conferido e não procede em JavaScript (sem a flag `m`, `/^…$/.test('abcd\n')` é falso).

- **Limite declarado da guarda estática (19/11/2026):** o teste de isolamento procura carregamento dinâmico por texto (qualquer `require` solto, `createRequire`, `import()` não literal) em todo o grafo alcançável. É defesa em profundidade contra erro no nosso próprio código, não contra quem escreve código malicioso no repositório: formas ainda mais indiretas de carregar módulos escapam de uma busca textual. O controle forte do artefato é o da W4.6: lista literal de imports do pacote gerado e execução sob `node --permission`.

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

## 6. Critérios de aceite (cada item vira ao menos um teste automatizado)

Invariantes (i)–(v) do contrato §3:

- [ ] **IA-01 (i) — recusas (a)–(d):** um teste por recusa, fixtures em memória/pasta temporária **sem** chave real: (a) hash mudado e entrada sumida no manifesto anterior ⇒ `SIGN_EVIDENCE_CHANGED`; (b) pacote com item legado ⇒ `SIGN_LEGACY_NOT_ATTESTABLE` (inclusive com dossiê e aprovação válidos); (c) pacote ≠ aprovado ⇒ `SIGN_PACKAGE_MISMATCH`; (d) `FAIL` em verificação ⇒ `SIGN_INTEGRITY_NOT_OK`; integridade ≠ `OK` ⇒ `SIGN_PACKAGE_INVALID` já no passo 1, porque o esquema da W1 fixa `integrity.status = "OK"` (notas da W4.1 e revisão da W4.1 no §5.5.1). Em todas: código 3, **nenhum** manifesto criado, chave **não aberta** (espião no leitor de chave: 0 chamadas).
- [ ] **IA-02 (ii) — nunca escreve na pasta de evidências, e o `sign` nem a abre:** (1) o `FsOps` do leitor no `export` é um proxy que falha o teste em qualquer escrita; (2) árvore em modo `0444/0555`: `export` funciona; (3) hash da árvore idêntico antes e depois; (4) `--out` dentro da pasta ⇒ `EXPORT_OUT_UNSAFE`; (5) `sign` com `fs` falso que **falha em qualquer caminho fora de pacote, aprovação, dossiê, pasta de manifestos e arquivo de chave** (RS-04).
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
- [ ] **IA-16 — separação de papéis (RS-01):** `approvedBy = custodian` sem `riskAcceptance` ⇒ `SIGN_ROLE_SEPARATION`; com aceite ⇒ assina e recibo traz `roleException` e `requiresLaterReview`; `operator = approvedBy` ⇒ assina com `requiresLaterReview`.
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
- **Legado (TUVAPLAST): NÃO ATESTÁVEL** (decisão de 16/11). Permanece consultável e rotulado; **nunca finalizável**. `export` ainda serve como relatório (`attestable: false`); `sign` recusa. **Quando o P1 existir, fazer coleta LIVE nova** (W6) em vez de atestar o legado; premissa a confirmar na autorização: a nova coleta usa **`auditId` novo**, senão a pasta conteria legado e o pacote seria recusado.
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
- Compatibilidade: capturas existentes inalteradas; o legado TUVAPLAST permanece não finalizável. A finalização continua fechada até existir manifesto + chave de confiança + volume de manifestos (fase 2 do ADR) + verificador `v2` implantado.
- Reversão: remover a chave pública da lista de confiança volta à política fechada (runbook §4).

## 13. Decisões registradas e questões abertas

### 13.1 Decisões registradas (responsável, 16/11/2026, seguindo a recomendação do método AISAC)

| # | Decisão | Onde se reflete |
|---|---|---|
| D1 | **Manifesto `v2` ANTES do primeiro resultado de produção**, com `dossier.sha256` e `prevSealSha256` na parte assinada (RS-10). Exige mudança aditiva no verificador (aceitar `v2`, conferir continuidade com o antecessor), **onda própria e contrato próprio**; o `v1` continua legível | §1, §5.1, §5.5, §5.6, §7.1, §14 (W3), IA-21 |
| D2 | **Comando de exportação entregue ANTES do de assinatura** (ondas separadas) | §1, §14 (W2 antes de W4) |
| D3 | **TUVAPLAST (legado): NÃO ATESTÁVEL.** Quando o P1 existir, **coleta LIVE nova** (autorização escrita específica; ~3 créditos Serper) em vez de atestar o legado | §2, §7.2, §14 (W6), IA-01(b) |
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
| **W6** | **Coleta LIVE nova da TUVAPLAST** (fora do escopo de código) | W5 e **autorização escrita específica** do responsável (~3 créditos Serper; sem consulta paga sem autorização, CLAUDE.md) | Registrar o hash `--json` em canal separado; seguir §3 e §5.3 |

## 15. Referências

- Contrato (base): `docs/phase6-auditoria-link/onda6c-contrato-p1-atestacao.md` (§2 custódia, §3 processo e invariantes, §4 conferência, §5 dossiê, §6 fronteiras, §7 riscos, §8 perguntas).
- ADR 6C-03: `docs/phase6-auditoria-link/onda6c-adr-proveniencia-evidencias.md` (§4 verificador, §6 legado, §7 plano e fases).
- Runbook de chaves: `docs/phase6-auditoria-link/onda6c-runbook-chaves.md` (§4 chave de atestação).
- Código reutilizado: `src/lib/link-audit-evidence/provenance.ts`, `scoring-basis.ts`, `reader.ts`, `legacy.ts`, `store.ts`, `types.ts`; `src/lib/link-audit-scoring-runs/preview.ts`; `src/lib/link-audit/canonical.ts`; `src/lib/link-audit/collector/capture-report.ts` (`source.capture.sha256`); `scripts/link-audit-collect.ts` (modo `--json`); padrão de CLI em `scripts/link-audit-evidence.ts`.
- Layout das evidências e legado TUVAPLAST: `docs/phase6-auditoria-link/onda5a-persistencia-e-leitura.md`, `onda4d-pos-live-resgate.md`.
- Modelo de ameaças do P1: `docs/security/threats/link-audit-p1-atestacao.md`.

## 16. Rastreabilidade: requisitos de segurança (modelo de ameaças) → esta spec

Situação: **A** = adotado; **P** = adotado em parte (com o que ficou de fora); **N** = não adotado (com motivo).

| RS | Situação | Seção / critério | Nota |
|---|---|---|---|
| RS-01 papéis distintos | **P** | §5.5 passo 9; IA-16 | Conferente ≠ custodiante bloqueia (D4); operador = conferente só marca revisão posterior (§13.3); exceção por aceite formal escrito, não "assinado pelo responsável" |
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
