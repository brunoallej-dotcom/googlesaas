# Modelo de ameaças: deploy pelo CI e entrega dos manifestos selados (P-9)

- **Data**: 2026-11-23 (fatia P9.1)
- **Autor(es)**: manager (subagente de documentação), a partir do código e dos documentos em `a711a36`
- **Status**: Rascunho (Draft), entregue com a spec. Nada do que está aqui foi implementado. As fatias P9.2 a P9.5 atualizam a
  coluna de status; a G2 (P9-O06) e a G3 (P9-O07) registram as conferências
- **Escopo**: workflow `deploy.yml` e job `seals` do `ci.yml`; GitHub Environments `homologacao` e `producao`; chaves SSH e
  segredos de ambiente; receptores de deploy e de manifestos no host; caminho `link-audit-seals/` e lista de confiança
  versionada; logs públicos do Actions; pilha de homologação `gmn-hml`
- **Spec vinculada**: `docs/specs/ci-deploy-and-seal-delivery.md`
- **ADR vinculado**: `docs/adr/0004-ci-deploy-over-restricted-ssh.md`

## 1. Visão geral

O pipeline constrói as imagens no runner do GitHub, a partir do commit exato, e as leva por SSH a um receptor de comando único
que roda `docker stack deploy` com a stack instalada pelo responsável. Os manifestos assinados do P1 entram por PR num caminho
versionado. O CI os verifica sem segredo antes do merge, e um job com a chave de manifestos os entrega a um segundo receptor,
que verifica de novo e só acrescenta. Os dados tratados não são pessoais: imagens da aplicação, manifestos (hashes, `auditId`
opaco, `keyId`, datas, assinatura), a lista pública de chaves e os segredos de conexão. A fronteira nova é entre o GitHub
(público, conta única) e a VPS compartilhada.

O que já está coberto em outros modelos e **não** se repete aqui: falsificação de manifesto sem a chave e custódia da chave de
assinatura (`link-audit-p1-atestacao.md`); verificador `v2` e leitor do servidor (`link-audit-evidencias-e-selos.md`); guarda
externa e homologação da G2 (`link-audit-portoes-producao.md`).

## 2. Ativos

- **Host da VPS** e os serviços de terceiros nele (Traefik e certificados, n8n, Evolution, Portainer, PostgreSQL, outro Redis).
- **Aplicação GMN em produção:** imagens, secrets do Swarm (Supabase `service_role`, Serper, chaves da Fase 6, guarda), pastas da
  Fase 6.
- **Pasta de manifestos** e a **lista de confiança** (definem o que é autêntico, D15.5).
- **Chaves SSH** de deploy e de manifestos, por ambiente.
- **Segredos de ambiente do GitHub:** host, porta, `known_hosts`, URL e chave anônima do Supabase do build, domínio.
- **Confidencialidade do repositório público:** nenhum host, domínio, IP, projeto ou cliente em arquivo ou log.
- **Disponibilidade** do deploy e da entrega.

## 3. Atores

| Ator | Confiança | Notas |
|---|---|---|
| Responsável | alta | revisa, dispara, aprova ambientes, administra a VPS; como administrador está fora da garantia (D15.5) |
| Manager / workers | média | escrevem PRs; não aprovam ambiente |
| Custodiante, conferente | média | abrem e conferem o PR do manifesto |
| Autor de PR externo (fork) | não confiável | dispara o job `seals` sem segredo |
| Leitor do log público | não confiável | qualquer pessoa |
| Dependência/action comprometida | hostil | roda dentro do job |
| Portador de chave SSH vazada | hostil | fala direto com o receptor |
| Administrador da VPS por fora do canal | fora da garantia | edita pasta, lista instalada, stack |
| Atacante na rede (MITM) | hostil | entre o runner e a VPS |

## 4. Diagrama de fluxo

```mermaid
flowchart LR
  pr[PR / fork] --> gh[GitHub: repositório público]
  gh --> ci[ci.yml: seals<br/>sem segredo]
  owner[Responsável] -->|dispatch + aprovação| env[Environment homologacao/producao]
  gh --> env
  env --> job[Job deploy / seals-deliver<br/>segredos de ambiente]
  job -.trust boundary: SSH, host fixado.-> rd[deploy-receiver<br/>grupo docker]
  job -.trust boundary: SSH, host fixado.-> rs[seal-receiver<br/>sem docker]
  rd --> docker[(Docker / Swarm)]
  rd --> tl[(Lista instalada)]
  rs --> seals[(Pasta de manifestos)]
  rs -.só lê.-> tl
  docker --> web[Web: lê manifestos só para leitura]
  job --> logs[Log e resumo públicos]
```

## 5. Análise STRIDE

| Componente | S | T | R | I | D | E | Notas |
|---|---|---|---|---|---|---|---|
| Workflow `deploy.yml` | DC-11 | DC-03, DC-21 | DC-14 | DC-08 | DC-16 | DC-11 | dispatch só na `main`; commit na cabeça da `main`; segredos de ambiente |
| Job `seals` (`ci.yml`) | — (sem credencial) | DC-04, DC-17 | — | — | DC-20 | — | PR de fork sem segredo |
| Environments | DC-11 | — | DC-14 | — | — | DC-11 | revisor único (risco aceito) |
| Chaves SSH | DC-01, DC-10 | — | DC-14 | DC-08 | — | DC-01 | Ed25519, por usuário e ambiente |
| Receptor de deploy | DC-01 | DC-07, DC-13, DC-21 | DC-14 | DC-08 | DC-12 | DC-02 | grupo `docker` = root; lista chega pelo stdin |
| Receptor de manifestos | DC-05 | DC-05, DC-06 | DC-14 | DC-08 | DC-12 | DC-18 | sem `docker`; só acrescenta |
| `link-audit-seals/` + lista | — | DC-04, DC-07, DC-17 | DC-14 | DC-09 | — | DC-07 | público |
| Logs públicos | — | — | — | DC-08 | — | — | só códigos fixos |
| Pilha `gmn-hml` | — | DC-13 | — | DC-13, DC-22 | DC-12 | DC-13, DC-22 | mesma VPS e mesma rede externa do Traefik |
| Administrador da VPS | — | DC-19 | — | — | — | — | limite declarado |
| Reversão de imagem | — | DC-15 | — | — | — | — | R6-09 |

Sem entrada (—) = não se aplica ao componente: o job `seals` não tem credencial a falsificar nem privilégio a escalar; os logs
não guardam estado.

## 6. Ameaças (priorizadas)

### DC-02 [CRÍTICA] Elevação — chave de deploy (grupo `docker`) vira root no host compartilhado

- **Vetor**: o usuário de deploy está no grupo `docker`. Uma stack com `bind` de `/`, `privileged` ou `pid: host`, ou um defeito
  do receptor que execute comando arbitrário, dá root no host e atinge os outros projetos.
- **Probabilidade**: Média (exige chave vazada ou PR malicioso aprovado). **Impacto**: Crítico. **Risco**: Alto.
- **Mitigação**:
  - Código: gramática fechada; `execFile` com argv fixo e sem shell; parser estrito do arquivo de variáveis (nunca executado como
    shell); tags conferidas no `manifest.json` antes do `docker load` (P9-D01, P9-D04, P9-D07, P9-D08).
  - Config: a stack **não** vem do CI. É instalada pelo responsável e conferida por hash (`E_STACK_FILE_MISMATCH`, P9-D03; desvio D-1
    da spec).
  - Infra: `restrict,command=` + `ForceCommand`; `authorized_keys` em pasta do root; wrapper confere o hash do artefato.
  - Processo: receptor só reinstalado pelo responsável, com `sha256sum -c`.
- **Residual**: imagem arbitrária ainda roda como a aplicação (DC-01); um defeito no próprio Docker fica fora do alcance. A lista de
  confiança também é escolhida por quem chama o `deploy` (vem no stdin). **Não é escalada nova:** quem implanta uma imagem
  arbitrária já pode ignorar o verificador. A regra de transição no host impede reverter a lista (DC-07, DC-21).
- **Status**: aberto (P9.3a, P9.4).

### DC-01 [ALTA] Falsificação — portador da chave de deploy implanta imagens próprias

- **Vetor**: chave privada vazada (segredo de ambiente exfiltrado, DC-03) usada direto contra o receptor, com pacote próprio.
- **Probabilidade**: Baixa. **Impacto**: Alto (aplicação, secrets do Swarm e dados da Fase 6 ao alcance da imagem). **Risco**:
  Médio.
- **Mitigação**: chave só como segredo de ambiente, liberado depois da aprovação; uma chave por ambiente; rotação a cada 12 meses
  e na hora, sob suspeita; o receptor exige `sha40` + hash do pacote + tags `<amb>-<sha40>` (dificulta erro, não impede o
  portador); o log local registra cada pedido; a tag com o SHA permite conferir contra o histórico de aprovações. Corte imediato:
  remover a linha do `authorized_keys`.
- **Residual**: aceito; é o mesmo poder de quem publica uma imagem.
- **Status**: aberto (P9.3a; conferência P9-O03).

### DC-03 [ALTA] Adulteração — action ou dependência comprometida no job com segredo

- **Vetor**: uma action fora de SHA, um pacote npm ou a imagem-base lê a chave SSH ou troca o pacote antes do envio.
- **Probabilidade**: Baixa a média. **Impacto**: Alto. **Risco**: Médio.
- **Mitigação**: actions fixadas por SHA, só as já usadas (P9-W03); o `seals-deliver` não roda `npm`/`node` (P9-W09); no
  `deploy`, o `npm ci` roda **dentro** do `docker build` (isolado do runner) e a chave só é escrita depois do build (P9-W08); sem
  cache do GitHub nos jobs com segredo (P9-W04); segredos só no `env:` do passo que os usa (P9-W05).
- **Residual**: a imagem-base do `Dockerfile` vai por tag, não por digest (fatia própria, ADR-0004); o pacote comprometido dentro
  do build altera a imagem (equivale a DC-01).
- **Status**: aberto (P9.4, P9.5).

### DC-07 [ALTA] Adulteração / Elevação — lista de confiança editada para aceitar uma chave do atacante

- **Vetor**: PR que acrescenta uma chave `active` própria, desfaz uma revogação ou troca o hash de um fecho, seguido de deploy.
- **Probabilidade**: Baixa. **Impacto**: Alto (manifestos forjados passam a valer). **Risco**: Médio.
- **Variante: lista escolhida no receptor.** A lista chega ao receptor de deploy pelo stdin do `deploy`, e quem tem a chave de
  deploy pode mandar outra. **Não é escalada nova:** a mesma chave já implanta imagem arbitrária (DC-02).
- **Mitigação**:
  - CI: regras de transição (`revoked` terminal, `retired` sem volta, hash fixado imutável, nada removido; P9-T03); fixação só
    de fecho já mergeado e válido (P9-T04, P9-T07); lista e manifestos nunca no mesmo PR (P9-T05);
  - Processo: CODEOWNERS do responsável no arquivo (P9-O02); deploy aprovado;
  - Host: as mesmas regras de transição contra a lista **instalada** (`E_TRUST_LIST_TRANSITION`, P9-D14), que valem também para
    a chave vazada e para uma execução antiga;
  - Registro: o `OK DEPLOYED` devolve o sha256 da lista instalada e o resumo o registra (P9-D11); a conferência do livro de
    manifestos (item 5) compara o hash instalado (log do receptor) com o arquivo do repositório no commit implantado.
- **Residual**: conta do GitHub do responsável comprometida (limite declarado, ADR-0004). Quem tem a chave de deploy ainda pode
  **acrescentar** uma chave `active` própria (transição permitida), mas a conferência do livro acusa a divergência. Opção
  futura: amarrar imagens e lista à execução aprovada por um token OIDC do GitHub verificado no host (spec §11.4).
- **Status**: aberto (P9.2, P9.3a).

### DC-08 [ALTA] Informação — log público expõe host, domínio, projeto Supabase ou caminho real

- **Vetor**: mensagens do `ssh`, saída do Docker, `set -x` ou expressões `${{ }}` no `run:` imprimem valores no log público.
- **Probabilidade**: Média. **Impacto**: Médio (ajuda ataque direcionado; fere a política do repositório público). **Risco**:
  Médio.
- **Mitigação**: host, porta, `known_hosts`, URL e domínio só como **segredo** (mascarado), nunca como variável (desvio D-2);
  receptores com saída pública só em código fixo, sem caminho nem valor (P9-R10, P9-D13); proibição estática de `${{ secrets.`/
  `${{ inputs.` no `run:`, de `set -x` e de `ssh -v` (P9-W05); `LogLevel=ERROR`; resumo só com campos públicos (§5.9 da spec).
- **Residual**: o mascaramento do GitHub não cobre valores transformados (base64, recortes); nenhum passo transforma segredo.
- **Status**: aberto (P9.3, P9.4, P9.5).

### DC-05 [MÉDIA] Adulteração — chave de manifestos grava fora da pasta ou um arquivo não verificado

- **Vetor**: `relpath` com `..`, link simbólico na raiz ou na subpasta, FIFO no destino, arquivo que não autentica.
- **Probabilidade**: Baixa. **Impacto**: Médio. **Risco**: Baixo.
- **Mitigação**: gramática fechada do `relpath` (P9-R01); raiz igual ao próprio caminho real, subpasta real (P9-R06); segunda
  verificação `v2` contra a pasta do host antes de gravar (P9-R05); `--permission` com escrita só na raiz de manifestos (P9-R11);
  usuário sem `docker` e sem `sudo`.
- **Status**: aberto (P9.3b).

### DC-06 [MÉDIA] Adulteração — sobrescrita ou remoção de um manifesto existente (RC-04)

- **Vetor**: reentrega com outros bytes, corrida entre duas entregas, verbo de remoção.
- **Mitigação**: não existe verbo de remoção; `link()` exclusivo; bytes idênticos ⇒ `ALREADY_PRESENT`; diferentes ⇒
  `E_EXISTS_DIFFERENT` com o arquivo intacto (P9-R04, P9-R08); no CI, só status `A` (P9-S01).
- **Status**: aberto (P9.2, P9.3b).

### DC-04 [MÉDIA] Adulteração — manifesto forjado ou alterado no PR

- **Vetor**: PR com manifesto não assinado, de outra auditoria, fora de ordem ou com bytes reformatados. Também (revisão do PR #68): o
  PR troca o próprio verificador (o preparo, o núcleo do canal ou o comando) para que ele aprove o que não devia, ou esconde do diff um
  gitlink sob `link-audit-seals/` com um `.gitmodules` de `ignore = all`.
- **Mitigação**: verificador `v2` real com a lista do commit e cadeia completa (P9-S08); forma canônica (P9-S06); nome = corpo
  (P9-S07); o conferente compara o `sha256sum` do resumo com o livro. O job `seals` roda o preparo, o `npm ci` e o comando a partir
  da revisão **base** (uma `git worktree` em `$RUNNER_TEMP`); o PR é só dado. Só enquanto a base não tem o verificador (até a P9.2 estar
  na `main`) ele usa o do PR, com o aviso fixo `SEALS_BOOTSTRAP` no resumo. O diff do preparo usa `--ignore-submodules=none` (o
  gitlink aparece com modo `160000` e é recusado, `SEALS_BAD_MODE`). Como o workflow em si vem do PR no `pull_request`, o CODEOWNERS
  do responsável (P9-O02) cobre `.github/workflows/ci.yml`, `.github/scripts/seals-prepare.sh`, `src/lib/link-audit-seals-channel/**`
  e `scripts/link-audit-seals-check.ts`, além do check obrigatório.
- **Status**: mitigado no código (P9.2); o CODEOWNERS e o check obrigatório são ações do responsável (P9-O02, H-10).

### DC-09 [MÉDIA] Informação — `auditId` ou metadados revelam o cliente

- **Vetor**: `auditId` com nome de empresa ou com o rótulo `AUD-xxx` dos documentos, que o histórico público liga a um cliente
  real.
- **Mitigação**: padrão `^aud-[0-9a-f]{16}$` no CI (P9-S02); geração aleatória na autorização (runbook do custodiante); vínculo só
  no dossiê offline.
- **Residual**: datas, `keyId` e frequência das atestações ficam públicos (sem dado pessoal; aceito pela decisão do responsável).
- **Status**: aberto (P9.2).

### DC-10 [MÉDIA] Falsificação — homem no meio entre o runner e a VPS

- **Vetor**: TOFU (`accept-new`) ou `StrictHostKeyChecking=no` aceitam a chave de um servidor falso, que recebe o pacote e, no
  canal de manifestos, devolve `OK` falso.
- **Mitigação**: `known_hosts` fixado por segredo, conferido pelo responsável no console da VPS (H-09); `StrictHostKeyChecking=yes`
  e `GlobalKnownHostsFile=/dev/null` (P9-W07).
- **Residual**: um `OK` falso só engana o resumo; a conferência do livro contra o servidor acusa a ausência.
- **Status**: aberto (P9.4).

### DC-11 [MÉDIA] Elevação — contornar a proteção do ambiente

- **Vetor**: dispatch de outra branch; workflow alterado num PR para ler segredos; administrador contornando o revisor;
  `pull_request_target`.
- **Mitigação**: *deployment branches* = só `main` e `if: github.ref == 'refs/heads/main'` (P9-W02); segredos só de ambiente; o
  `ci.yml` usa `pull_request`, nunca `_target`; contorno por administrador desligado e CODEOWNERS em `.github/workflows/` (P9-O01,
  P9-O02).
- **Residual**: a mesma pessoa dispara e aprova (Q-4 da spec, risco aceito).
- **Status**: aberto (P9.4; conferência P9-O01).

### DC-13 [MÉDIA] Adulteração — confusão entre homologação e produção

- **Vetor**: imagem de homologação (outra URL do Supabase) rodando em produção pela mesma tag; homologação apontando para o
  projeto ou as pastas de produção; trava de homologação em produção.
- **Mitigação**: tag `<amb>-<sha40>` e conferência das tags (P9-D07); ambiente fixado no wrapper de cada chave; impressão do
  projeto Supabase igual entre build e host, e homologação diferente de produção (P9-D05); pastas de homologação sob prefixo
  (P9-D04); a trava só na sobreposição e proibida em produção (P9-H01, PD-08); secrets `gmn-hml_*`.
- **Status**: aberto (P9.3a, P9.4).

### DC-14 [BAIXA] Repúdio — quem implantou ou entregou o quê

- **Mitigação**: histórico de aprovações do ambiente; resumo do job com execução, commit e hashes; log local dos receptores; o
  custodiante copia a linha para o livro de manifestos (a retenção do GitHub é limitada).
- **Status**: aberto (P9.4, P9.5).

### DC-12 [BAIXA] Negação de serviço — disco do host cheio

- **Vetor**: pacotes grandes repetidos, imagens antigas acumuladas, entregas em massa.
- **Mitigação**: teto de 3 GiB no `upload`, recebimento com um pacote só; `E_DISK_LOW` antes de carregar; tetos de tamanho e de
  quantidade nas entregas; limpeza de tags antigas pelo responsável.
- **Status**: aberto (P9.3).

### DC-15 [MÉDIA] Adulteração — reversão para imagem anterior ao livro (R6-09)

- **Vetor**: commit de reversão ou `docker service rollback` para uma versão anterior ao livro, depois do primeiro `ENROLL`.
- **Mitigação**: regra do runbook e do `PLANO-DE-ROLLBACK.md`; o receptor nunca reverte por conta própria.
- **Residual**: o receptor não sabe se a imagem é anterior ao livro (não há git no host); a revisão do PR de reversão é o controle.
- **Status**: aberto (processo).

### DC-16 [BAIXA] Negação de serviço — job pendente cancelado

- **Vetor**: limite do GitHub: um job pendente do mesmo grupo de concorrência é cancelado por outro mais novo. Com um grupo só
  por ambiente, um deploy cancelaria uma entrega pendente, e vice-versa.
- **Mitigação**: grupos por operação e ambiente (`gmn-<amb>-deploy`, `gmn-<amb>-seals`, P9-W06). Na mesma operação, o mais novo
  substituir o pendente é seguro: o deploy antigo falharia em `NOT_MAIN_HEAD`, e a entrega manda todos os arquivos
  (idempotente). Deploy e entrega correndo juntos: a lista é instalada de forma atômica no fim do deploy, e uma entrega com outra
  lista falha fechada com `E_TRUST_LIST_MISMATCH` e se repete (P9-R13).
- **Status**: aceito.

### DC-17 [BAIXA] Adulteração — conversão de fim de linha ou editor mudam os bytes

- **Mitigação**: `link-audit-seals/** -text`; forma canônica exigida no CI e no receptor; sha256 de ponta a ponta.
- **Status**: aberto (P9.2).

### DC-18 [MÉDIA] Elevação — chave de manifestos troca a lista de confiança

- **Vetor**: se o receptor de manifestos instalasse a lista, a chave dele bastaria para validar uma chave própria.
- **Mitigação**: só o receptor de deploy instala a lista; o de manifestos só a lê e exige o hash do commit (P9-R03); usuários e
  chaves separados (RC-09).
- **Observação**: quem instala a lista é a chave de deploy, que pode escolhê-la. Não é escalada nova, porque a mesma chave já
  implanta imagem arbitrária (DC-02), e a lista só avança por transição válida (DC-07, P9-D14). A separação garante que a chave
  de manifestos **sozinha** não consegue nada sem a chave de assinatura.
- **Status**: aberto (P9.3).

### DC-19 [INFO] Adulteração — administrador da VPS por fora do canal

- **Vetor**: escreve na pasta de manifestos, edita a lista instalada ou a stack, repõe um estado antigo.
- **Mitigação**: limite declarado da D15.5; a próxima entrega acusa lista diferente (`E_TRUST_LIST_MISMATCH`) e o próximo deploy,
  stack diferente; a conferência do livro (itens 2, 3 e 5) acusa o resto.
- **Status**: aceito (limite declarado).

### DC-20 [BAIXA] Negação de serviço — PR de fork com arquivos feitos para travar o parser

- **Vetor**: arquivos enormes, JSON profundo, nomes estranhos.
- **Mitigação**: teto de tamanho antes de ler, teto de quantidade, regex ancorada sem retrocesso catastrófico, porta de texto
  estrita do verificador antes do `JSON.parse`; o job não tem segredo e tem `timeout-minutes`. Desde a revisão do PR #68: um teto
  único de leitura por execução (64 MiB sobre os arquivos novos, a releitura das cadeias, as cabeças dos fechos e as listas;
  esgotado ⇒ `SEALS_TOO_MANY`), o tamanho da lista do commit-base conferido antes de ser lida, e uma falha inesperada numa etapa não
  apaga as recusas já coletadas (spec §5.4, "Implementação").
- **Status**: mitigado no código (P9.2).

### DC-21 [ALTA] Adulteração — execução aprovada antiga reverte a lista de confiança (e a aplicação)

- **Vetor**: um deploy fica esperando aprovação por horas ou dias. Nesse meio tempo, a `main` recebe uma revogação de chave (ou
  uma correção). Aprovar a execução antiga implantaria as imagens e a lista do commit antigo, e desfaria a revogação no servidor
  e no receptor de manifestos.
- **Probabilidade**: Média (uma pessoa, aprovações acumuladas). **Impacto**: Alto (uma chave revogada volta a valer). **Risco**:
  Alto.
- **Mitigação**:
  - Workflow: `github.sha` tem de ser a cabeça atual de `refs/heads/main` (`git ls-remote`, só leitura) no início do job e de
    novo imediatamente antes do comando `deploy` por SSH (`NOT_MAIN_HEAD`, P9-W11). Grupos de concorrência por operação: um
    deploy mais novo substitui o pendente.
  - Host: a lista nova tem de ser transição válida a partir da instalada (`E_TRUST_LIST_TRANSITION`, P9-D14), o que cobre os
    segundos entre a última conferência e a instalação, além da chave vazada.
- **Residual**: imagens de um commit superado nos poucos segundos entre a segunda conferência e o `docker stack deploy`; um deploy
  novo corrige.
- **Status**: aberto (P9.3a, P9.4).

### DC-22 [MÉDIA] Elevação / Informação — movimento lateral a partir do web de homologação pela rede externa do Traefik

- **Vetor**: o web de homologação entra na mesma rede externa (`automacaotrafegopagoredeinterna`) que o web de produção e os
  outros serviços da VPS ligados a ela. Um web de homologação comprometido (por imagem de teste ou por credencial de laboratório
  mais fraca) alcança esses serviços direto, sem passar pelo Traefik, inclusive a porta 3000 do web de produção.
- **Probabilidade**: Baixa. **Impacto**: Médio. **Risco**: Baixo a médio.
- **Mitigação**:
  - Config: a sobreposição não acrescenta rede (P9-H02, P9-H09).
  - Segredos: nenhum secret ou credencial em comum com a produção (P9-H09, P9-O08), então o web de homologação não leva
    credencial de produção; projeto Supabase diferente, conferido pelo receptor (P9-D05).
  - Dados: só sintéticos; Worker em 0; sem Serper.
  - App: o web de produção exige sessão em tudo, menos `/login`.
  - O Traefik e a rede não são alterados (`GUIA-DE-IMPLANTACAO.md` proíbe).
- **Residual**: a mesma exposição de rede do web de produção, sem segmentação; aceito como limite declarado da homologação na
  mesma VPS (spec §5.11).
- **Status**: aberto (P9.4; conferência P9-O08).

## 7. Casos de abuso

- Abrir um PR que acrescenta `seal-0002.json` a uma auditoria alheia, assinado por uma chave revogada, esperando que o CI só olhe o
  formato. O S-10 recusa com `SEAL_V2_SEAL_KEY_REVOKED`.
- Com a chave de manifestos vazada, mandar `put ../../opt/gmn/stack.yml …`. A gramática recusa (`E_COMMAND`) antes de ler o stdin.
- Com a chave de deploy vazada, mandar um pacote com a tag `gmn-web:producao-<sha>` de um commit inexistente e uma imagem com
  `USER root`. O receptor aceita a forma (o portador tem o poder da aplicação, DC-01), mas a stack do host mantém `read_only`,
  `cap_drop: ALL` e nenhuma porta, e o deploy fica no log local e no histórico.
- Disparar o deploy de uma branch de teste com o workflow alterado. O ambiente recusa a branch, e os segredos não são liberados.
- Fazer uma revogação e, no mesmo PR, acrescentar um manifesto da chave nova. `SEALS_AND_TRUST_LIST_TOGETHER`.
- Configurar a homologação com a URL do Supabase de produção para "testar de verdade". `E_HML_PRODUCTION_PROJECT`.
- Aprovar hoje um deploy disparado antes de uma revogação de chave. `NOT_MAIN_HEAD` no início do job e, se escapar, a
  `E_TRUST_LIST_TRANSITION` no host (`revoked` não volta).
- Com a chave de deploy vazada, mandar uma lista que desfaz uma revogação. `E_TRUST_LIST_TRANSITION`.
