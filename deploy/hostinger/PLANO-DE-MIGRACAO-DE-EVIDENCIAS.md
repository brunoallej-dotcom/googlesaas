# Plano de migração das evidências (AUD-001) — Windows → VPS

**Princípios:** o original no Windows **nunca é movido, alterado ou apagado**; a cópia é verificada por SHA-256; a VPS recebe uma cópia somente leitura para a aplicação.

## Origem e destino
| | Caminho |
|---|---|
| Origem (Windows) | `<EVIDENCIAS_PRIVADAS>\link-audit\aud-001-autorizacao-01\` (WSL: `<EVIDENCIAS_PRIVADAS_WSL>/link-audit/aud-001-autorizacao-01/`) — contém `MANIFEST.json`, `SHA256SUMS`, `report.json`, `report.v1-superseded.json`, `serper-body.json`, `serper-attempts.json`, `serper-status.json`, `summary.json`… |
| Destino (VPS) | `/srv/gmn/evidence/aud-001-autorizacao-01/` (a pasta `/srv/gmn/evidence` equivale a `...\link-audit\` e é a base `GMN_LINK_AUDIT_EVIDENCE_DIR=/data/evidence`) |

A cópia idêntica em `<EVIDENCIAS_COPIA_LOCAL>\` continua como segunda cópia local (mesmo disco físico ≠ backup independente: veja o plano de backup).

> **Rótulos opacos (repositório público):** `aud-001-autorizacao-01`, `<EVIDENCIAS_PRIVADAS>`, `<EVIDENCIAS_PRIVADAS_WSL>`, `<EVIDENCIAS_COPIA_LOCAL>` e `<CID>` substituem o nome real da pasta, os caminhos locais e o identificador. Os valores reais ficam só no dossiê offline do responsável; troque-os no terminal na hora de executar e nunca os grave em arquivo versionado.

## Passo a passo
> Na VPS, `/srv/gmn/evidence` é `0700` do uid 10001: por isso `rsync --rsync-path='sudo rsync'` e `sudo` nas conferências (o usuário SSH precisa de `sudo`).

1. **Hash do original (WSL)** — somente leitura:
   ```bash
   cd <EVIDENCIAS_PRIVADAS_WSL>/link-audit/aud-001-autorizacao-01
   sha256sum -c SHA256SUMS                                             # todos OK
   find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | tee /tmp/aud-001-origem.sha256 | sha256sum   # hash agregado: ANOTE (LC_ALL=C: a ordem não depende do idioma da máquina)
   ```
2. **Copiar sem apagar nada no destino** (SSH; `--checksum` compara conteúdo; sem `--delete`):
   ```bash
   rsync -a --checksum --chmod=D700,F600 --info=progress2 --rsync-path='sudo rsync' \
     <EVIDENCIAS_PRIVADAS_WSL>/link-audit/aud-001-autorizacao-01/ \
     USUARIO@IP_DA_VPS:/srv/gmn/evidence/aud-001-autorizacao-01/
   ```
3. **Dono e permissões na VPS** (a aplicação roda como uid 10001; a pasta é montada `:ro` no web):
   ```bash
   ssh USUARIO@IP_DA_VPS 'sudo chown -R 10001:10001 /srv/gmn/evidence && sudo chmod -R u=rwX,go= /srv/gmn/evidence'
   ```
   A ACL do Windows (`icacls`) **não** é transportada; a proteção na VPS é `0700` + dono + volume somente leitura.
4. **Verificação na VPS:**
   ```bash
   ssh USUARIO@IP_DA_VPS 'sudo sh -c "cd /srv/gmn/evidence/aud-001-autorizacao-01 && sha256sum -c SHA256SUMS && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum"'
   ```
   O `sha256sum -c` precisa dar **OK em todos**, e o **hash agregado** tem de ser **idêntico** ao anotado no passo 1. Divergência ⇒ parar, não usar a cópia e repetir o `rsync`.
5. **Conferir contagem e tamanhos:** `find . -type f | wc -l` e `du -sb` iguais nos dois lados; comparar também `MANIFEST.json`.
6. **Verificação funcional (depois do deploy autorizado):** em `/auditoria-por-link`, "Auditorias armazenadas" deve listar `aud-001-autorizacao-01` com integridade OK e CID `<CID>`. A leitura é somente leitura: nenhum processamento, nenhum crédito.
7. **Registrar:** data, hashes e quem executou em `docs/` (sem copiar o conteúdo das evidências).

## O que NÃO fazer
- Não executar nenhuma coleta (`link-audit:collect`) na VPS nem reutilizar a autorização `aud-001-autorizacao-01` (já consumida).
- Não montar a pasta de evidências com escrita no web; não colocá-la dentro de `public/`, `src/` ou da imagem.
- Não apagar nem sobrescrever o original; o `rsync` nunca usa `--delete`.

## Opcional: PDFs de auditorias existentes (`.data/audits`, ~1,4 MB)
Se for desejado servir os PDFs já gerados, copie `.data/audits/*.pdf` para `/srv/gmn/audits/` com o mesmo procedimento (hash antes/depois). Sem isso, o download recorre ao bucket privado do Supabase ou regenera o PDF a partir do banco.
