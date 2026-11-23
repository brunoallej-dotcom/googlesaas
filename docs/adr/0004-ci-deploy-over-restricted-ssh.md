# 0004. Deploy pelo CI por SSH restrito a receptores de comando único, com a entrega dos manifestos no mesmo pipeline

- **Date**: 2026-11-23
- **Status**: Accepted (2026-11-23). O responsável aceitou a recomendação do manager em
  `docs/phase6-auditoria-link/p1-canal-de-entrega-manifestos.md` §6.3. Os detalhes que o manager escolheu dentro dessa
  recomendação (stack instalada pelo responsável, lista de confiança versionada, sobreposição de homologação) estão na spec
  e podem ser revistos sem novo ADR, desde que não mudem a decisão abaixo
- **Deciders**: responsável pelo projeto (decisão do P-9 e do canal); manager (detalhamento, spec
  `docs/specs/ci-deploy-and-seal-delivery.md`)
- **Tags**: infra, security, deploy, link-audit, fase-6, portões-de-produção

## Context

O `CLAUDE.md` proíbe deploy local de produção ("CI only"), mas nenhum pipeline de deploy existe. O `.github/workflows/ci.yml`
só tem typecheck, test, build, artefato do `sign`, gitleaks, SCA e SAST. A implantação preparada em 24/10/2026 (etapa H1/P0, nunca executada na VPS) é manual (`docker save` → `scp` →
`docker load`, `deploy/hostinger/GUIA-DE-IMPLANTACAO.md` §1–§2). A spec dos portões exige o **P-9**: deploy pelo
CI, por decisão do responsável, com verificação pós-deploy.

O produtor P1 também precisa de um **canal** para levar os manifestos assinados (`seal-NNNN.json`) e os fechos de aposentadoria
até o volume de manifestos da VPS. A D7 diz que o canal é o pipeline de CI, nunca cópia manual. A D15.5 diz que só o canal
escreve no volume e que o servidor confere a assinatura contra a lista fixada. Os requisitos RC-01 a RC-10 estão em
`p1-canal-de-entrega-manifestos.md` §2.

Forças em jogo:

- **Repositório público** (desde 17/11/2026): o log do Actions é público; nenhum host, domínio, IP, projeto Supabase ou dado
  de cliente pode aparecer em arquivo versionado ou em log (`docs/security/README.md`; `tests/repo-client-data-guard.test.ts`).
- **Sem serviço pago novo.** Armazenamento privado de imagens no GHCR pode ser cobrado; imagem pública é proibida, porque a URL
  do Supabase é embutida no build.
- **VPS compartilhada** com Traefik, n8n, Evolution, Portainer, PostgreSQL e outro Redis (`stack.yml:1-3`). Root no host atinge
  todos eles.
- **Uma só pessoa** revisa, dispara e aprova; a mesma conta do GitHub concentra código, CI e artefatos (limite já declarado,
  spec do P1 §5.5.1 item 6).
- **Separação de credenciais** (RC-09): a credencial que escreve manifestos não pode ser a do deploy.

## Decision

1. **Um workflow, `.github/workflows/deploy.yml`**, com três jobs. O `deploy` roda só por `workflow_dispatch` na `main`, para
   `homologacao` ou `producao`. O `seals-verify` e o `seals-deliver` rodam no push na `main` que toca o caminho de manifestos, ou
   por dispatch. Cada ambiente é um **GitHub Environment** com o responsável como revisor obrigatório e só a `main`. Os segredos
   são de ambiente. Permissão `contents: read` (mais `actions: read` só no `deploy`). Actions fixadas por SHA. Sem artefato,
   registry nem cache nos jobs com segredo.
2. **As imagens são construídas no próprio job**, a partir do commit exato, com tag `<ambiente>-<sha40>`, e seguem pelo SSH como
   um `docker save` comprimido. Nunca viram artefato nem vão a registry.
3. **SSH restrito a receptores de comando único.** São dois usuários de host por ambiente: o de deploy (grupo `docker`) e o de
   manifestos (sem `docker`). Cada um tem um `authorized_keys` com `restrict,command="<wrapper>"`. A chave de host é fixada por
   segredo, sem TOFU. Os receptores são artefatos Node com hash versionado, instalados pelo responsável e nunca atualizados pelo
   CI.
4. **O receptor de deploy** só aceita uma gramática fechada. Confere hashes, as tags das imagens, o arquivo de variáveis do host
   e as pastas, roda `docker stack deploy --resolve-image never` e faz verificações somente leitura. A **stack é a do host**:
   instalada pelo responsável a partir do commit e conferida por hash a cada deploy.
5. **Os manifestos entram por PR** em `link-audit-seals/<ambiente>/seals/`, com `auditId` opaco `aud-<16 hex>`. O job `seals` do
   `ci.yml` (sem segredo, check obrigatório) exige só acréscimos, forma canônica dos bytes e a cadeia autenticada pelo
   verificador `v2` real antes do merge.
6. **O receptor de manifestos** verifica de novo, no host, contra a pasta real (`seq` = último + 1). Grava com temporário,
   `fsync`, `link()` exclusivo e `fsync` da pasta. Bytes idênticos já presentes são idempotentes; bytes diferentes recusam.
7. **A lista de confiança tem fonte única**, `link-audit-seals/<ambiente>/trust-keys.txt`. O CI a lê do commit. O receptor de
   deploy a passa ao servidor (a mesma variável de hoje) e a instala no host. O receptor de manifestos confere o hash dela a cada
   entrega. A chave de manifestos nunca troca a lista.
8. **A homologação** é a stack `gmn-hml` na mesma VPS: sobreposição própria, pastas, secrets, Redis, domínio e laboratório
   Supabase separados, Worker em 0 e sem Serper. É implantada pelo mesmo workflow.

## Consequences

### Positive

- O P-9 e o canal da D7/D15.5 ficam num caminho só, revisável e aprovado pelo responsável a cada execução.
- Uma chave de deploy vazada dá, no pior caso, o comprometimento **da aplicação** (imagens arbitrárias), não root no host: a
  stack não vem do CI.
- Uma chave de manifestos vazada só consegue acrescentar arquivos que o verificador `v2` aceita contra uma lista que ela não
  troca. Na prática, não consegue nada sem a chave de assinatura.
- Cada manifesto passa duas vezes pelo verificador real, antes do merge e antes de gravar. O sha256 dos bytes é conferível de
  ponta a ponta: livro → PR → resumo do CI → receptor.
- O CI e o servidor usam a mesma lista por construção, e as mudanças nela ficam no histórico do git.
- Sem serviço novo, sem custo novo, sem runner próprio.

### Negative

- **Manual no host continua existindo:** instalar a stack quando ela muda, os receptores, o Node 22, usuários, chaves, pastas e
  secrets. O deploy recusa (`E_STACK_FILE_MISMATCH`) até o responsável instalar a stack do commit.
- **O Node 22 passa a existir no host**, fora de contêiner, só para os receptores.
- **A porta SSH da VPS** precisa aceitar os runners do GitHub, que saem de faixas grandes e variáveis.
- **Uma pessoa** dispara e aprova as próprias execuções.
- O manifesto expõe publicamente `auditId` opaco, datas, `keyId` e frequência das atestações (sem dado pessoal).
- O build dura alguns minutos no runner a cada deploy (sem cache, de propósito).
- O alias DNS `gmn-web` não é único na rede externa compartilhada quando as duas stacks estão no ar.

### Neutral / follow-ups

- Fatias P9.2 a P9.5 no plano de ondas; emendas a VC-E3, VC-E8, PG-V04, EN-12, P-7, runbooks e guias (spec §11.3).
- Rever o ADR se houver uma segunda pessoa (autoaprovação), registry sem custo ou necessidade de stack vinda do CI. Neste último
  caso, com uma política mecânica sobre a configuração renderizada.
- Fixar por digest a imagem-base do `Dockerfile` (`node:22.23.2-bookworm-slim` vai por tag), em fatia própria.

## Alternatives considered

**Runner próprio na VPS.** Daria acesso direto ao Docker sem SSH. O GitHub desaconselha runner próprio em repositório público,
porque um PR de fork pode executar código nele. Na VPS compartilhada, isso é root para qualquer PR mal configurado.

**Registry de imagens (GHCR privado) e `docker pull` no host.** É o padrão da indústria, mas o armazenamento privado pode ser
cobrado (serviço pago novo), exige token de leitura no host e coloca as imagens, que levam a URL do Supabase, num terceiro. Uma
imagem pública está fora de questão.

**Agente na VPS que puxa do GitHub** (*pull-based*: verifica e implanta sozinho). Exige token do GitHub guardado no host, um
componente novo sempre ligado e tira a aprovação por execução do ambiente protegido.

**Deploy manual por scripts do responsável.** Proibido pelo `CLAUDE.md` em produção e incompatível com a D7 para os manifestos.

**Chave SSH com shell e `sudo`.** É simples, mas qualquer vazamento vira root no host. Sem restrição de comando também não há
como provar RC-04/RC-06 no host.

**Stack vinda do CI no pacote.** Dispensaria a instalação manual a cada mudança, mas com o grupo `docker` uma stack arbitrária
monta o `/` do host. Fica como evolução, com uma política mecânica sobre a configuração renderizada.

**Manifestos num repositório privado só para o canal** (alternativa (b) do p1-canal §4). Sem proteção de branch no plano
gratuito, outra conta ou credencial para guardar, e a revisão fica fora do fluxo normal.

**Manifesto como entrada do `workflow_dispatch` ou anexo** (alternativa (c)). Não passa por revisão nem por check antes da
entrega, e o conteúdo apareceria no log ou dependeria de outro meio de transporte.

**Lista de confiança só no arquivo de variáveis do host** (como hoje). O CI não teria como ler a mesma lista. Para o receptor
ler, ou ela seria copiada à mão (duas fontes), ou a chave de manifestos precisaria instalá-la (fere o RC-09).

## References

- Spec: `docs/specs/ci-deploy-and-seal-delivery.md`; ameaças: `docs/security/threats/deploy-pelo-ci.md`.
- `docs/phase6-auditoria-link/p1-canal-de-entrega-manifestos.md` (§2, §4, §5, §6.3); spec do P1 (D7, D15.5); spec dos portões
  (P-9, D-G0-12, §10.4).
- ADR-0003 (guarda externa no Supabase): o laboratório de homologação é o mesmo projeto descartável do PG-G08.
