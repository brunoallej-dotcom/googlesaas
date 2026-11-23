# P1 — Canal de entrega dos manifestos pelo CI (procedimento e requisitos)

> **Status:** procedimento e requisitos escritos na fatia **W5.1** (22/11/2026). **O canal ainda não existe:** nenhum workflow
> entrega manifestos (`.github/workflows/ci.yml` só tem typecheck, test, build, sign-artifact, security, sca e sast) e o volume
> de manifestos no `stack.yml` é da onda G1.a (fase 2 do ADR 6C-03). O que falta de código está no §5 (pendências da W5.2).
> **O desenho do canal (quem, onde, credencial) aguarda a decisão do responsável sobre o deploy pelo CI (P-9)**; a recomendação
> do manager e as decisões que valem até lá estão no §6.
>
> **Decisões aplicadas:** D7 (o canal é o pipeline de CI, nunca cópia manual) e **D15.5** (só o canal do CI escreve no volume
> de manifestos; o servidor confere a assinatura contra a lista de chaves fixada antes de aceitar; o administrador da VPS fica
> fora da garantia). Spec `docs/specs/link-audit-p1-attestation.md` §13.1 e §13.4; spec dos portões
> `docs/specs/link-audit-production-gates.md` (linha do `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR` e item P-4 do portão).

## 1. O que o canal entrega

- `seal-NNNN.json` de uma auditoria, para `<VOLUME_DE_MANIFESTOS>/<auditId>/seal-NNNN.json`;
- `_closures/<R>.json` (fecho de aposentadoria), para `<VOLUME_DE_MANIFESTOS>/_closures/<R>.json`.

Os dois são **não secretos** e não têm dado pessoal por desenho: `auditId`, `seq`, hashes, `keyId`, `dossier.id`, datas e
assinatura. A chave, o pacote, a aprovação, o dossiê e os recibos **nunca** passam pelo canal.

## 2. Requisitos do canal

| # | Requisito | Origem |
|---|---|---|
| RC-01 | O volume de manifestos só é escrito pelo canal do CI; o serviço web o monta **somente leitura**; o Worker não o monta | D15.5; VC-E1/VC-E5 (G1.a) |
| RC-02 | Nenhuma cópia manual para a VPS, nem pelo custodiante nem pelo administrador | D7, D15.5 |
| RC-03 | Entrega **byte a byte**: sem reformatar, sem converter fim de linha, sem recomprimir (o fecho vale pelo SHA-256 dos bytes) | contrato do verificador `v2` §6 |
| RC-04 | Só **acréscimo**: um arquivo já existente nunca é sobrescrito, alterado ou apagado pelo canal; colisão de nome ⇒ a entrega falha | spec §7.3 regra 2; IA-12 |
| RC-05 | Gravação no volume à prova de queda: temporário fora do padrão `seal-NNNN.json`, `fsync`, `link()` exclusivo, `fsync` da pasta (o mesmo protocolo do `sign`, spec §5.5.1 item 4) | RS-12 |
| RC-06 | **Antes de gravar**, o canal verifica o manifesto (ou o fecho) com o verificador `v2` real, `acceptedVersions: [2]`, contra a **lista de chaves fixada** de destino: formato estrito, assinatura, cadeia (`prevSealSha256`, cumulatividade, `seq` = último + 1 no volume), estado da chave (`active`; aposentada só no fecho fixado) | D15.5 |
| RC-07 | Depois da entrega, o servidor só "aceita" pelo próprio verificador: a prévia e a finalização leem o volume com `[2]` e a lista fixada (`src/app/api/link-audit/scoring/shared.ts`); nada é autêntico sem isso. A pré-verificação do RC-06 é defesa adicional, não substitui esta | D15.5; contrato `v2` §4 |
| RC-08 | O canal registra, por entrega, o identificador da execução, o caminho relativo e o `sha256sum` dos bytes gravados, para o livro de manifestos | RS-17 |
| RC-09 | O canal não recebe nem guarda segredo de assinatura; a credencial que ele usa para escrever no volume é exclusiva desse fim (não é a do deploy da aplicação, se puder ser separada) e só escreve na pasta de manifestos | menor privilégio |
| RC-10 | O canal falha fechado: qualquer recusa do RC-04 ou do RC-06 ⇒ nada gravado, execução vermelha, motivo em código fixo (sem conteúdo de arquivo) | spec §5.2 (padrão do CLI) |

## 3. Procedimento (alvo, depois da W5.2)

1. **Custodiante, fora da estação de assinatura** (a estação fica sem rede): leva por mídia o `seal-NNNN.json` e o recibo;
   confere `sha256sum` do manifesto igual ao anotado no livro.
2. **Submete ao canal** pela entrada decidida na W5.2 (§4, ponto em aberto), sem abrir nem editar o arquivo.
3. **CI:** confere os RC-03 a RC-06, grava pelo RC-05 e publica o registro do RC-08. Recusa ⇒ nada gravado; o custodiante
   registra no livro (incidente, se não for erro de uso) e não tenta outro caminho.
4. **Servidor:** a prévia da auditoria passa a mostrar a origem da coleta autenticada (RC-07).
5. **Custodiante / conferente:** registram no livro (§2) e no dossiê B o identificador da execução, o `sha256sum` gravado e a
   verificação pós-entrega.

**Fecho de aposentadoria:** mesmo caminho para `_closures/<R>.json`. Depois da entrega, o responsável fixa
`<R>:<pública>:retired:<closureSha256>` na lista do servidor (configuração e deploy dele; `onda6c-runbook-chaves.md` §4).
Até a fixação, o fecho não vale nada (o verificador ignora fecho sem hash fixado).

**Dois custodiantes:** quem chega segundo com o mesmo `seq` é recusado (RC-04/RC-06); refaz a partir da cadeia atualizada, com
novo `--expect-seq` do livro (spec §7.3).

## 4. Limites declarados e pontos em aberto

- **Administrador da VPS (mantido pela D15.5):** quem administra a VPS pode escrever no volume por fora do canal, editar a lista
  de chaves (acrescentar uma chave própria, desfazer revogação, fixar outro hash de fecho) ou repor a pasta inteira num estado
  antigo autêntico. O verificador não impede isso (contrato do verificador `v2` §1). O controle é humano: a conferência
  periódica do livro contra o servidor (`p1-livro-de-manifestos.md` §5).
- **Mesma conta do GitHub** para código, CI, artefato do `sign` e canal: comprometê-la dá acesso a todos (spec dos portões,
  concentração; spec P1 §5.5.1 item 6).
- **Pendência do responsável: por onde o manifesto entra no CI** (parte da decisão do P-9; recomendação do manager no §6). O
  repositório é
  **público**. Pôr os manifestos em commits expõe `auditId`, datas e frequência das atestações (não há dado pessoal no
  manifesto, mas um `auditId` com nome de empresa revelaria o cliente). Alternativas: (a) commit no repositório público, com a
  regra de que o `auditId` nunca carrega nome de empresa; (b) repositório privado só para o canal (plano gratuito: sem proteção
  de branch, spec dos portões); (c) entrada manual do workflow com o arquivo anexado por outro meio que não fique público.
  Cada uma muda o código da W5.2.
- **Ponto em aberto: de onde o CI lê a "lista fixada"** para o RC-06. Precisa ser a mesma lista do servidor de destino; se ela
  for versionada no repositório, a edição desse arquivo passa a ser mais um ponto de controle a conferir no livro.

## 5. Pendências de código (W5.2)

| # | O que falta | Onde hoje |
|---|---|---|
| CE-1 | Workflow de entrega (gatilho, entrada do §4, permissões mínimas, actions fixadas por SHA como no job `sign-artifact`) | não existe; `.github/workflows/ci.yml` não tem job de entrega nem de deploy |
| CE-2 | Comando de pré-verificação para o CI (RC-06): verificador `v2` com `[2]`, lista fixada e fechos, evidências = entradas da cabeça (o mesmo método do `sign`, `src/lib/link-audit-attestation/sign-chain.ts`), saída em código fixo | não existe como comando; a lógica existe no núcleo `src/lib/link-audit-evidence/provenance-core.ts` |
| CE-3 | Receptor no host que grava no volume com criação exclusiva e `fsync` (RC-04, RC-05) e devolve o `sha256sum` (RC-08) | não existe; `publishExclusive` não serve (ignora falha do `fsync` da pasta, revisão da W4.6 item 4) |
| CE-4 | Volume de manifestos no `stack.yml`, `:ro` no web, ausente no Worker | onda G1.a (VC-E1, VC-E5), não desta fatia |
| CE-5 | Testes do canal sem rede (recusa de sobrescrita, de manifesto não assinado, de cadeia quebrada, de chave fora da lista) | não existem |

## 6. Decisões do manager sob a delegação D15 (22/11/2026) e pendência do responsável

1. **Ensaio da W5 com entrega manual (desvio declarado da D15.5).** O ensaio W5.3 pode rodar na pilha de homologação com a
   entrega **manual** do manifesto, registrada no relatório do ensaio como desvio declarado da D15.5. A entrega pelo canal do CI
   é ensaiada de novo na **G2**, antes de produção, e isso é **critério de entrada da produção**. Nunca há entrega manual em
   produção. Na homologação, a cópia manual segue o mesmo cuidado do canal:
   - só os bytes do `seal-NNNN.json` (ou do fecho), sem abrir nem reformatar;
   - criação exclusiva no destino: conferir antes que o nome não existe e nunca sobrescrever;
   - `sha256sum` antes e depois, iguais ao anotado no livro;
   - quem fez, quando e o hash, no relatório do ensaio e no livro.
2. **Conferência do livro contra o servidor:** antes de cada sessão de assinatura e, no mínimo, trimestralmente
   (`p1-livro-de-manifestos.md` §5).
3. **O canal (quem, onde, credencial) aguarda a decisão do responsável sobre o deploy pelo CI (P-9 da spec dos portões).**
   Pendência do responsável. **Recomendação do manager:**
   - um único pipeline de deploy pelo CI, com um job de entrega de manifestos;
   - o manifesto entra por **PR**, com `auditId` **opaco** (nunca nome de empresa, porque o repositório é público);
   - verificação `v2` no CI **antes do merge** (RC-06: formato, assinatura, cadeia e estado da chave contra a lista fixada);
   - entrega por um job num **ambiente protegido**, com aprovação do responsável, usando uma chave SSH **restrita a um único
     comando receptor** no host. O receptor confere de novo a assinatura e grava com criação exclusiva e `fsync` (RC-04, RC-05,
     RC-06).

   Com essa forma, as pendências CE-1 (workflow e ambiente protegido), CE-2 (verificação antes do merge) e CE-3 (receptor como
   comando único da chave SSH, com a segunda verificação) ficam definidas. Elas só viram código depois da decisão do P-9.
