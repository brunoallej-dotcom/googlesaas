# P1 — Modelo do dossiê de atestação (parte A, parte B e aceite formal de risco)

> **Status:** modelo escrito na fatia **W5.1** (22/11/2026). Fonte: contrato `onda6c-contrato-p1-atestacao.md` §5 (ajuste da W0:
> duas partes), spec `docs/specs/link-audit-p1-attestation.md` §5.4, §5.5 (passos 6, 9 e 16), §5.6 e §9, decisões D4, D15.1,
> D15.2 e D15.6.
>
> **Este arquivo é só o MODELO, sem nenhum dado real.** O dossiê preenchido nunca entra no repositório (público): fica offline,
> cifrado, junto do livro de manifestos, enquanto o resultado existir (D15.6(b); RS-21). Os campos `<…>` são preenchidos no
> dossiê real.

## Como as partes se ligam

| Parte | Quando | Ligação criptográfica |
|---|---|---|
| **A. Dossiê de aprovação** | congelada **antes** da assinatura | o SHA-256 dos bytes vai em `approval.dossier.sha256` e, assinado, em `dossier.sha256` do manifesto `v2` |
| **B. Registro de assinatura** | depois do `sign` | o recibo do passo 16 cita `dossierSha256`, `packageSha256` e `sealSha256` |
| **Aceite formal de risco** | antes da assinatura, enquanto não houver segunda pessoa | o SHA-256 dos bytes vai em `approval.riskAcceptance.sha256` e o `sign` confere com `--risk-acceptance` |

`seq`, `keyId`, `sealSha256` e a data da assinatura **não** podem estar na parte A: o manifesto assina o hash dela (spec §5.6).
Depois de calcular o hash da parte A, nada nela muda; uma correção é uma parte A nova, com nova aprovação.

Formato livre (texto, PDF ou planilha), desde que os bytes sejam fixos e o `sign` os leia (até 16 MiB, spec §5.5.1, notas da
W4.3). O `sign` confere só existência e hash; o conteúdo é humano.

## 1. Parte A — dossiê de aprovação

```
DOSSIÊ DE APROVAÇÃO P1 (parte A)
id do dossiê ............ <ID_DO_DOSSIE>            (padrão ^[a-z0-9][a-z0-9._-]{2,63}$, sem dado pessoal)
auditId ................. <AUDITORIA>
ambiente ................ <HOMOLOGACAO | PRODUCAO>

1. Fonte
   tipo .................. execução LIVE
   autorização ........... <ID_DA_AUTORIZACAO>  validade: <DE> a <ATE>
   operador .............. <ROTULO_DO_OPERADOR>
   hash do coletor (--json), registrado em canal separado:
     c0001 = <HASH_DO_COLETOR>   canal: <CANAL_SEPARADO>   registrado em: <DATA_HORA>
   data/hora da coleta ... <COLLECTED_AT>

2. Pacote candidato
   comando ............... npm run link-audit:seal -- export (opções usadas, sem caminhos reais)
   packageSha256 ......... <PACKAGE_SHA256>
   12 primeiros caracteres (para a confirmação do sign): <PRIMEIROS_12>
   sha256sum do arquivo .. <SHA256_DO_ARQUIVO_DO_PACOTE>
   entradas .............. <N> (capturas <C>, revisões de relatório <R>, artefatos <A>)
   lista ref → contentSha256: anexo A1 (cópia exata de "entries" do pacote)
   intervalo coleta→export: <H> h (limite 24 h; justificativa: <nenhuma | texto>)
   delta contra a cópia dos manifestos: novas <n>, alteradas 0, ausentes 0

3. Verificações mecânicas (do pacote)
   INTEGRITY_LOCAL <PASS> · COLLECTOR_HASH_MATCHES <PASS> · COLLECTION_GAP_WITHIN_LIMIT <PASS>
   HTTP_2XX_AND_COLLECTED_AT <PASS> · REPORT_REPRODUCES <NOT_EXECUTED>
   AUTHORIZATION_CONSUMED / PROVIDER_PANEL_CREDITS / URL_QUERY_COHERENCE <NOT_EXECUTED>

4. Conferência humana (contrato §4.1) — o que foi feito e o resultado
   4.1 autorização consumida uma vez ........ <PASS> <como foi conferido>
   4.2 hash do coletor = captura ............ <PASS> (COLLECTOR_HASH_MATCHES)
   4.3 coerência URL/consulta/identidade .... <PASS> <como>
   4.4 painel de créditos do provedor ....... <PASS> <como; o que foi visto>
   4.5 relatório reproduz offline ........... <PASS> <como>
   Recusas do §4.3 consideradas: <nenhuma | qual e por quê>

5. Papéis (D4, D15.1)
   conferente (approvedBy) ... <CONF-01 | CUST-01>
   custodiante previsto ...... CUST-01
   operador .................. <ROTULO_DO_OPERADOR>
   acúmulo de papéis ......... <não | SIM: conferente = custodiante; operador = custodiante>
   aceite formal de risco .... <ID_DO_ACEITE> sha256 <SHA256_DO_ACEITE>   (obrigatório se houver acúmulo)
   requiresLaterReview esperado: <true | false>

6. Decisão
   decisão ................ <APROVADO | RECUSADO>
   motivo da recusa ....... <se recusado>
   observações e exceções . <texto, com justificativa>
   data/hora da aprovação . <APPROVED_AT>

Anexos: A1 lista ref → contentSha256; A2 saída do export (sem caminhos nem dados da empresa fora do resumo); A3 evidências da
conferência humana (capturas de tela do painel etc., só no dossiê offline).
```

## 2. Parte B — registro de assinatura

```
REGISTRO DE ASSINATURA P1 (parte B)
dossiê (parte A) ........ <ID_DO_DOSSIE>  sha256 <SHA256_DO_DOSSIE_A>
recibo do sign (cópia exata do arquivo da pasta de recibos):
  auditId <AUDITORIA> · seq <N> · schemaVersion 2 · keyId <KEY_ID>
  sealedAt <SEALED_AT> · sealSha256 <SEAL_SHA256> · prevSealSha256 <PREV | null>
  packageSha256 <PACKAGE_SHA256> · dossierSha256 <SHA256_DO_DOSSIE_A> · entries <N>
  approvedBy <…> · operator <…> · custodian CUST-01
  roleException <true|false> · requiresLaterReview <true|false> · artifactSha256 <ARTIFACT_SHA256>

estação
  versão do node (saída de <NODE22> --version) ... <v22.x.y>
  hash do artefato conferido por sha256sum -c ..... <ARTIFACT_SHA256>   commit de origem: <COMMIT>
  pública impressa pelo sign ...................... <KEY_ID>:<PUBLICA>

entrega pelo canal (p1-canal-de-entrega-manifestos.md)
  identificador da entrega (execução do CI) ....... <ID_DA_EXECUCAO>
  resultado da verificação no canal ............... <AUTHENTICATED>
  data/hora ....................................... <DATA_HORA>

verificação pós-entrega
  prévia da auditoria: origem da coleta autenticada <sim | não>   data/hora <…>
  resultado finalizado (se houver): runSeq <N> · confirmação LEDGER · RUN_CONFIRMED <sim>

incidentes ................ <nenhum | descrição e registro no livro>
```

## 3. Aceite formal de risco (D15.1, D4, D10)

Documento do responsável, assinado por ele (D15.7), **antes** da cerimônia da chave real. O `sign` confere só o hash dos bytes;
o arquivo fica no dossiê offline. Um arquivo vazio não vale (`SIGN_ROLE_SEPARATION`).

```
ACEITE FORMAL DE RISCO — operação do P1 por uma só pessoa
id do aceite ............ <ID_DO_ACEITE>
data .................... <DATA>
quem aceita ............. o responsável (rótulo CUST-01)

1. Escopo: atestações P1 assinadas pela chave <KEY_ID_REAL> (e pelas seguintes, até revogação deste aceite), enquanto não houver
   segunda pessoa para conferir ou para ser suplente.
2. Riscos aceitos:
   a) conferente = custodiante (D4): não há quatro olhos entre conferir e assinar; uma conferência falha vira atestado falso;
   b) operador = conferente = custodiante: quem coleta também confere e assina;
   c) sem suplente (D10): com o titular indisponível ou as duas cópias perdidas, novas atestações congelam; o histórico continua
      verificando;
   d) revisão amostral trimestral feita pelo próprio titular, marcada como tal (D15.6(b)).
3. Condições: toda atestação sai com requiresLaterReview = true; dossiê completo; livro de manifestos em dia; revisão trimestral
   (um dossiê ou 10 %, o que for maior) registrada no livro.
4. Fim: este aceite cai quando houver conferente distinto (a aprovação passa a ter approvedBy ≠ custodiante) e/ou suplente com
   par próprio registrado.

Assinatura do responsável: ______________________
```

No **ensaio** (W5.3) o aceite é um arquivo de ensaio com o mesmo formato e a palavra ENSAIO no título; ele não vale para a chave
real.
