# Portões de produção da Fase 6 — atestações da onda G1.a (volumes, segredos e chave de log)

> Spec: `docs/specs/link-audit-production-gates.md` §5.3 (VC-E1 a VC-E8), critérios PG-V01 a PG-V04 e PG-L01; plano:
> `docs/plan/implementation-waves.md`, "Onda G1.a". Decisões da G0 de 20/11/2026 (responsável): logs sem ferramenta paga, com exportação
> diária cifrada e expurgo aos 90 dias (Q8); destino independente para cada volume de recibos e para o livro, cópia diária (Q9); guarda no
> Supabase com chave HMAC própria para o `auditId` (Q1/Q5); ações administrativas continuam em 403 (Q6).
>
> **Nada foi executado na VPS.** Criar as pastas, os secrets e os destinos de backup e de logs, e implantar, são ações do responsável,
> pelo CI. Repositório público: só marcadores, nenhum valor real.

## Atestações

Cada linha aponta o `arquivo:linha` onde o item está cumprido (linhas conferidas no commit desta onda).

| Item | Cumprido | Evidência |
|---|---|---|
| AT-G1A-01 | SIM | deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:62 (três destinos distintos entre si e do destino dos dados, fora da VPS e do disco dos dados) e :56, :58, :59 (marcadores próprios dos dois volumes de recibos e do livro); deploy/hostinger/verificar-pastas-fase6.sh:41-45 (no host, recibos e livro em dispositivos independentes, senão o deploy não segue) |
| AT-G1A-02 | SIM | deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:94 (rodada exclusiva: mkdir sem -p falha se já existir), :96 (cópia numa pasta nova, sem --delete), :113 (mesmas regras no envio remoto), :128 (restaurada nasce como pasta irmã, exclusiva), :135-136 (a viva vai para um caminho irmão, nunca apagada nem sobrescrita), :160 (log só ganha o nome final depois do sucesso; nunca sobrescreve) |
| AT-G1A-03 | SIM | deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:82 e :91 (um rótulo para as seis pastas, com o web parado: pares do mesmo instante), :95 (sha256sum por arquivo da ORIGEM) e :97-98 (a cópia confere arquivo a arquivo e em quantidade), :77 e :99 (cabeças registradas antes e guardadas DENTRO de cada rodada, inclusive a do livro), :81 e :85-90 (set -euo pipefail; trap religa o web e registra a falha) |
| AT-G1A-04 | SIM | deploy/hostinger/GUIA-DE-IMPLANTACAO.md:85 (install -d -m 0700 -o 10001 -g 10001), :87 (stat -c '%u:%g %a %n', esperado 10001:10001 700), :89 (stat -c '%d %n') e :92 (verificar-pastas-fase6.sh: pré-requisito que falha; saída no EN-12); tests/deploy-verificar-pastas.test.ts (pastas coincidentes, link simbólico, aninhadas, modo e mesmo disco ⇒ recusa) |
| AT-G1A-05 | SIM | deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md:16 e :19 (chave do livro e chave de log como Swarm secrets, valores em marcador <id>:<64 hex>), :30 (criação com id em marcador, depois de set +x); deploy/hostinger/docker-entrypoint.sh:16-19 (lista fixa); deploy/hostinger/stack.yml:49-51 e :312-317 (*_FILE e secrets externos); credencial e chave da guarda documentadas como Swarm secrets em PROVA-DE-ORIGEM-E-DE-COLETA.md:20-21 e :34, marcadas "entra na G1.b" (fora da stack e da lista do entrypoint por decisão do manager de 21/11/2026) |
| AT-G1A-06 | SIM | deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md:51-54 (volumes e chaves da G1.a ⇒ guarda da G1.b ⇒ primeiro ENROLL); docs/phase6-auditoria-link/onda6c-checklist-producao.md:5; deploy/hostinger/GUIA-DE-IMPLANTACAO.md:109 |
| AT-G1A-07 | SIM | tests/deploy-config.test.ts:375 (variáveis da Fase 6 só como alvo fixo, arquivo de secret ou interpolação; sem material de chave nem IP real nos arquivos de implantação) e :335 (pastas novas só por marcador, sem caminho padrão); deploy/hostinger/stack.yml:86 (exemplo de origem por marcador); varredura do diff final contra origin/main (método abaixo): 1177 linhas acrescentadas, nenhum IP real, e-mail real, domínio real, nome de cliente nem material de chave |

**Método da varredura (AT-G1A-07).** `git diff origin/main` do commit final; contam-se as linhas acrescentadas (`+`, sem os cabeçalhos
`+++`), que coincidem com a soma das inserções de `git diff --numstat origin/main`. Sobre elas: endereço IPv4 fora de `0.0.0.0` e
`127.0.0.1`; e-mail fora dos domínios de exemplo (`exemplo.com`, `exemplo.invalid`); 64 hexadecimais seguidos (material de chave); e os
nomes reais conhecidos (domínio provisório, nome de auditoria-alvo, pasta de evidências originais). Resultado: zero ocorrências.

## Decisões desta onda (para revisão)

- **Guarda fora da G1.a (decisão do manager, 21/11/2026).** A stack só declara o que o código lê: `GMN_LINK_AUDIT_GUARD_DB_URL`
  (papel `gmn_guard_writer`) e `GMN_LINK_AUDIT_GUARD_KEY` (pseudônimo `audit_ref`), nomes fixados pela G0 (spec dos portões §5.1.7),
  entram no `stack.yml` e na lista do entrypoint **com o código da G1.b**. Aqui ficam só documentados, como referência futura, e um
  teste trava a ausência deles na stack e no entrypoint. A chave de log ainda não compara com a da guarda (a G1.b acrescenta).
- **Deploy desta versão.** A stack declara os três secrets da G1.a como externos e as seis pastas por marcador obrigatório: um deploy exige
  esses três secrets e as seis pastas, e **não** depende de nada da guarda.
- **Aposentadas fora do stack.** `GMN_LINK_AUDIT_*_RETIRED_KEYS` estão na lista do entrypoint, mas não ficam declaradas no `stack.yml`
  (spec VC-E2): um secret vazio é recusado pelo entrypoint. Entram só durante uma rotação (PROVA-DE-ORIGEM §3, item 5).
- **Listas públicas por interpolação.** Os ids revogados e as chaves públicas de atestação são listas públicas (spec VC-E3), não secrets:
  `${VAR:-}` do arquivo de variáveis; vazio = nenhum id revogado e atestação fechada.
- **`stop-first`** no web (R6-09, checklist §7): nunca dois processos web gravando; custo: breve indisponibilidade a cada atualização.
- **Worker:** precisa da `service_role` (grava auditorias e dossiês no Supabase por `gmnRepository`/`getSupabaseAdmin`) e não usa nada
  da Fase 6; continua sem variável `GMN_LINK_AUDIT_*`, sem secret e sem bind novos (travado em teste).
- **Dockerfile:** os seis alvos de montagem são criados só na imagem web (`10001:10001`, `0700`), sem depender da criação implícita com a
  raiz só leitura; a imagem do Worker não muda.
- **Isolamento da chave de origem (CI do PR #54, decisão do manager).** O módulo de observabilidade não cita os nomes das variáveis de
  outras chaves nem importa outro módulo da Fase 6: a lista id/material das chaves de origem e do livro (atuais e aposentadas) chega por
  parâmetro **obrigatório, sem padrão**; lista ausente ou inválida ⇒ `LOG_KEY_UNVERIFIED` e `UNAVAILABLE`. Quem monta a lista é o livro,
  com `phase6SecretKeyMaterials(env)` em `src/lib/link-audit-ledger/config.ts`. **Ponto de composição futuro** (com o `emit` das próximas
  fatias; nada liga o `operatorRef` a rota ou logger nesta onda): `operatorRefSourceFromEnv(phase6SecretKeyMaterials(env), env)`.
- **Chave de log sem valor:** `operatorRef` = `UNAVAILABLE` (falha fechada para PII); idem para chave fraca, chave que repete id ou
  material da origem ou do livro, e identidade que não parece e-mail. O e-mail nunca é usado como reserva nem há hash sem chave.
  O formato é `<id da chave>:<12 hex>` com o padrão de id das demais chaves da Fase 6 (a regex `k\d+` da §10.2 da spec de observabilidade
  era ilustrativa). `src/lib/logger.ts` e `src/lib/redact.ts` sem diff; o módulo não importa o de origem (a política de chave foi
  reescrita, para não mexer na lista fechada de consumidores do módulo de origem).
- **Revisão adversarial do PR #54 (REPROVAR, todos os achados corrigidos):** restauração para pasta irmã (o `mv` para dentro de si mesma
  falhava); rodada de backup exclusiva, conferida contra os hashes da origem, com `set -euo pipefail`, `trap` que religa o web e cabeças
  dentro da rodada; exportação de logs por arquivo `.parcial` renomeado só no sucesso; conferência executável das pastas no host
  (`verificar-pastas-fase6.sh`, pré-requisito que falha, testado com diretórios temporários); `set +x` nos blocos com segredo; e esta
  varredura refeita sobre o diff final. Os blocos do plano de backup foram exercitados num sandbox (docker simulado, pastas temporárias).
- **Mutações à mão:** 28 mutações nas guardas (13 de implantação, 10 do `operatorRef`, 5 do script de conferência das pastas), todas
  mortas pelos testes e todas desfeitas.

## Fica para o responsável (implantação)

- Criar as seis pastas no host, rodar `verificar-pastas-fase6.sh` (saída 0 obrigatória) e registrar a saída e o `stat` (G2, EN-12; portão G-3); criar os três secrets da G1.a (PROVA-DE-ORIGEM §2; os da guarda vêm com a G1.b); acrescentar ao
  arquivo de variáveis da implantação os marcadores `GMN_RAIZ_DADOS_*` e as três listas públicas (o arquivo de exemplo do repositório
  não foi alterado nesta onda).
- Definir os destinos reais `<DESTINO_BACKUP_*>` e `<DESTINO_LOGS>`, a chave pública dos logs e agendar as rotinas diárias.
- Implantar só pelo CI, na ordem volumes e chaves (G1.a) ⇒ guarda (G1.b) ⇒ primeiro `ENROLL`.

## Fora do escopo, registrado

Outros documentos de `deploy/hostinger/` não tocados nesta onda (roteiro H1, verificação pós-deploy, relatório de implantação, plano de
migração) ainda citam o domínio provisório real e o nome de uma auditoria-alvo; recomenda-se uma passada de saneamento própria. Os
caminhos padrão `/srv/gmn`, `/opt/gmn` e `/mnt/d/gmn-backups` são o layout já documentado e travado por testes anteriores à G1.a.
