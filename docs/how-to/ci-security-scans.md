# Como tratar os scans de segurança do CI

O repositório é privado no plano gratuito: CodeQL, `dependency-review-action`, secret scanning nativo e a aba Security (SARIF) não estão disponíveis. Os três jobs abaixo são gratuitos e rodam só com o log do job.

## O que cada job faz

| Job | Ferramenta | Bloqueia o PR? |
|---|---|---|
| `security` | gitleaks (segredos no histórico) | Sim |
| `sca (npm audit)` | `npm audit --json` + `.github/scripts/npm-audit-gate.mjs` | Sim, para `high`/`critical` fora da lista de exceções |
| `sast (semgrep)` | Semgrep OSS 1.185.0 na imagem oficial fixada por digest (`p/typescript`, `p/javascript`, `p/react`, `p/nodejs`, `p/github-actions`; caminhos `src scripts deploy .github`) | Sim, com **qualquer** achado (todas as severidades), desde 16/11/2026 |

Todas as Actions estão fixadas por SHA de commit (comentário `# vX.Y.Z` ao lado, formato que o Dependabot atualiza).

Por que `npm audit` e não OSV-Scanner: usa o mesmo banco que já embasa `docs/phase5/dependency-audit.md`, não precisa de ação extra de terceiros e o gate é um script sem dependências (~150 linhas) que dá para ler e testar; `tests/ci-npm-audit-gate.test.ts` o exercita com fixtures, sem npm nem rede.

## Como tratar um achado

### gitleaks
1. Considere o segredo **vazado**: revogue/rotacione primeiro.
2. Só depois remova do código. Reescrever histórico exige autorização.
3. Falso positivo: acrescente ao `.gitleaksignore` da raiz (crie se não existir) a impressão digital do log (`commit:arquivo:regra:linha`), com um comentário de justificativa revisado em PR. A entrada cobre só aquele commit; corrija também o texto que disparou, para o próximo commit não disparar de novo. Linhas iniciadas por `#` são comentário.

### SCA
1. Leia a linha `::error::aviso SEM exceção` no log (pacote, versão, severidade, URL do aviso).
2. Prefira corrigir: atualizar a dependência (sem `npm audit fix --force`).
3. Se não houver correção viável, avalie se o pacote roda no servidor ou só no build, e registre a análise em `docs/phase5/dependency-audit.md`.
4. Só então adicione a exceção (abaixo).

### SAST (Semgrep)
1. Leia o relatório no log do job `sast`.
2. Achado real: corrija no próprio PR (ou em PR próprio, se o achado veio de uma regra nova do registro e não do seu diff). Falso positivo: comentário `// nosemgrep: <regra> -- motivo` na linha, revisado em PR.
3. Job vermelho **sem** achado no relatório: falha ao baixar a imagem ou as regras. É falha fechada de propósito; rode o job de novo e, se persistir, investigue antes de qualquer contorno. Nunca volte a pôr `continue-on-error`.

## Como atualizar a imagem do Semgrep

A versão fica no digest de `SEMGREP_IMAGE` (`.github/workflows/ci.yml`); o Dependabot não atualiza imagens dentro de `run:`.
1. Escolha a versão nova nas notas de release do Semgrep.
2. Obtenha o digest do **índice multi-arquitetura** da tag no Docker Hub (`docker buildx imagetools inspect semgrep/semgrep:<versão>`, linha `Digest:`). É uma consulta de rede: siga a regra de autorização do projeto.
3. Troque o digest e o comentário de versão no `ci.yml` num PR próprio; confira no log a linha `Ran N rules on M files` e o número de achados.

## Como adicionar uma exceção de SCA

Edite `.github/security/npm-audit-exceptions.json` e inclua **todos** os campos:

```json
{ "name": "pacote", "version": "1.2.3", "max_severity": "high",
  "reason": "Por que o risco é aceitável aqui.",
  "reference": "docs/phase5/dependency-audit.md (seção/opção)",
  "review_by": "AAAA-MM-DD",
  "advisory": "GHSA-xxxx-xxxx-xxxx" }
```

`advisory` é opcional. Quando presente, a exceção só cobre esse aviso: se o pacote/versão ganhar outro aviso `high`/`critical` (URL em `via` sem esse identificador), o gate volta a falhar. Prefira informá-lo sempre que o aviso tiver GHSA.

- Vale **só** para aquela versão instalada e até aquela severidade. Atualizar o pacote ou o aviso piorar derruba o job de propósito: reavalie e atualize a entrada.
- `review_by`: data real `AAAA-MM-DD`, no máximo 90 dias à frente da execução (o gate valida). Data inválida, vencida ou além de 90 dias faz o job falhar até alguém reavaliar e renovar com justificativa.
- Todos os campos obrigatórios devem ser texto não vazio e `max_severity` um de `info|low|moderate|high|critical`; exceção `null` ou que não seja objeto falha com mensagem clara.
- Nunca ignore "tudo": uma entrada por pacote, revisada em PR.
- Remova a exceção quando o pacote for corrigido.

## Por que o Semgrep virou bloqueante (16/11/2026)

O job nasceu não bloqueante, com prazo até 16/12/2026 para decidir. Os três critérios foram cumpridos antes do prazo:
1. **Achados triados:** não havia nenhum a triar.
2. **Sem falso positivo novo:** as 14 execuções desde a introdução (PRs #16–#21, PRs do Dependabot e pushes na `main`) terminaram com 0 achados (74 regras/294 arquivos na primeira; 85 regras/299 arquivos nas demais).
3. **Severidade bloqueante:** todas (`--error`), e não só `ERROR`, porque a base está limpa em todas as severidades; um falso positivo se resolve com `nosemgrep` justificado.

Para voltar a não bloqueante é preciso um PR com o motivo e uma data de retorno.

## O que o gate rejeita (falha fechada)

Saída do `npm audit` que não seja um objeto, `vulnerabilities` ausente ou que não seja objeto (por exemplo, lista), `metadata.vulnerabilities` ausente/malformada, contagem `high`/`critical` da metadata maior que as entradas analisadas, severidade desconhecida, e qualquer nó do aviso que não esteja no `package-lock.json` (os demais nós não o cobrem).

## Limites conhecidos

- As regras `p/...` são baixadas do registro do Semgrep a cada execução (não ficam fixadas). Uma regra nova publicada no registro pode fazer o job falhar num PR que não mexeu no código apontado; trate como achado normal. Fixá-las exige copiar as regras para o repositório (download do registro e revisão da licença das regras): pendente, depende de autorização.
- O motor é fixado pelo digest da imagem (o índice multi-arquitetura), não mais pelo pip sem hash.
- Falha de rede no `npm audit` faz o job SCA falhar (fail-closed), não passar.
- Não há varredura de imagens Docker nem de IaC neste PR.
