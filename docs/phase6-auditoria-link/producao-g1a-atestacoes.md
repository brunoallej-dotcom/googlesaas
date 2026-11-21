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
| AT-G1A-01 | SIM | deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:62 (três destinos distintos entre si e do destino dos dados, fora da VPS e do disco dos dados) e :56, :58, :59 (marcadores próprios dos dois volumes de recibos e do livro) |
| AT-G1A-02 | SIM | deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:81 (diretório novo por rodada, rsync --ignore-existing, sem --delete), :91 (cp -n), :97 (regras para qualquer destino), :106-107 (restauração em pasta nova e mv para _antigo, nunca apagar) |
| AT-G1A-03 | SIM | deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:75 (um rótulo para todas as pastas: pares do mesmo instante, com o web parado), :82 (sha256sum por arquivo em SHA256SUMS), :76 e :91 (cabeças registradas antes e guardadas junto de cada cópia, inclusive a do livro) |
| AT-G1A-04 | SIM | deploy/hostinger/GUIA-DE-IMPLANTACAO.md:84 (install -d -m 0700 -o 10001 -g 10001), :86 (stat -c '%u:%g %a %n', esperado 10001:10001 700), :88 (stat -c '%d %n': recibos e livro em outro dispositivo) |
| AT-G1A-05 | SIM | deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md:16 e :19 (chave do livro e chave de log como Swarm secrets, valores em marcador <id>:<64 hex>), :29 (criação com id em marcador); deploy/hostinger/docker-entrypoint.sh:16-19 (lista fixa); deploy/hostinger/stack.yml:49-51 e :312-317 (*_FILE e secrets externos); credencial e chave da guarda documentadas como Swarm secrets em PROVA-DE-ORIGEM-E-DE-COLETA.md:20-21 e :33, marcadas "entra na G1.b" (fora da stack e da lista do entrypoint por decisão do manager de 21/11/2026) |
| AT-G1A-06 | SIM | deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md:49-52 (volumes e chaves da G1.a ⇒ guarda da G1.b ⇒ primeiro ENROLL); docs/phase6-auditoria-link/onda6c-checklist-producao.md:5; deploy/hostinger/GUIA-DE-IMPLANTACAO.md:102 |
| AT-G1A-07 | SIM | tests/deploy-config.test.ts:375 (variáveis da Fase 6 só como alvo fixo, arquivo de secret ou interpolação; sem material de chave nem IP real) e :335 (pastas novas só por marcador, sem caminho padrão); deploy/hostinger/stack.yml:86 (exemplo de origem por marcador); varredura das 711 linhas acrescentadas pela onda sem IP, e-mail, domínio, nome de cliente nem material de chave |

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
- **Chave de log sem valor:** `operatorRef` = `UNAVAILABLE` (falha fechada para PII); idem para chave fraca, chave que repete id ou
  material da origem ou do livro, e identidade que não parece e-mail. O e-mail nunca é usado como reserva nem há hash sem chave.
  O formato é `<id da chave>:<12 hex>` com o padrão de id das demais chaves da Fase 6 (a regex `k\d+` da §10.2 da spec de observabilidade
  era ilustrativa). `src/lib/logger.ts` e `src/lib/redact.ts` sem diff; o módulo não importa o de origem (a política de chave foi
  reescrita, para não mexer na lista fechada de consumidores do módulo de origem).
- **Mutações à mão:** 21 mutações nas guardas (13 de implantação, 8 do `operatorRef`), todas mortas pelos testes e todas desfeitas.

## Fica para o responsável (implantação)

- Criar as seis pastas no host e registrar o `stat` (G2, EN-12; portão G-3); criar os três secrets da G1.a (PROVA-DE-ORIGEM §2; os da guarda vêm com a G1.b); acrescentar ao
  arquivo de variáveis da implantação os marcadores `GMN_RAIZ_DADOS_*` e as três listas públicas (o arquivo de exemplo do repositório
  não foi alterado nesta onda).
- Definir os destinos reais `<DESTINO_BACKUP_*>` e `<DESTINO_LOGS>`, a chave pública dos logs e agendar as rotinas diárias.
- Implantar só pelo CI, na ordem volumes e chaves (G1.a) ⇒ guarda (G1.b) ⇒ primeiro `ENROLL`.

## Fora do escopo, registrado

Outros documentos de `deploy/hostinger/` não tocados nesta onda (roteiro H1, verificação pós-deploy, relatório de implantação, plano de
migração) ainda citam o domínio provisório real e o nome de uma auditoria-alvo; recomenda-se uma passada de saneamento própria. Os
caminhos padrão `/srv/gmn`, `/opt/gmn` e `/mnt/d/gmn-backups` são o layout já documentado e travado por testes anteriores à G1.a.
