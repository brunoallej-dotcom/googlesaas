# Como tratar os scans de segurança do CI

O repositório é privado no plano gratuito: CodeQL, `dependency-review-action`, secret scanning nativo e a aba Security (SARIF) não estão disponíveis. Os três jobs abaixo são gratuitos e rodam só com o log do job.

## O que cada job faz

| Job | Ferramenta | Bloqueia o PR? |
|---|---|---|
| `security` | gitleaks (segredos no histórico) | Sim |
| `sca (npm audit)` | `npm audit --json` + `.github/scripts/npm-audit-gate.mjs` | Sim, para `high`/`critical` fora da lista de exceções |
| `sast (semgrep, não bloqueante)` | Semgrep OSS (`p/typescript`, `p/javascript`, `p/react`, `p/nodejs`), versão fixada | **Não** (`continue-on-error`); só relatório no log |

Todas as Actions estão fixadas por SHA de commit (comentário `# vX.Y.Z` ao lado, formato que o Dependabot atualiza).

Por que `npm audit` e não OSV-Scanner: usa o mesmo banco que já embasa `docs/phase5/dependency-audit.md`, não precisa de ação extra de terceiros e o gate é um script de ~60 linhas, sem dependências, que dá para ler e testar.

## Como tratar um achado

### gitleaks
1. Considere o segredo **vazado**: revogue/rotacione primeiro.
2. Só depois remova do código. Reescrever histórico exige autorização.
3. Falso positivo: crie (ainda não existe no repositório) ou edite `.gitleaksignore` na raiz, com o fingerprint e um comentário com o motivo, revisado em PR.

### SCA
1. Leia a linha `::error::aviso SEM exceção` no log (pacote, versão, severidade, URL do aviso).
2. Prefira corrigir: atualizar a dependência (sem `npm audit fix --force`).
3. Se não houver correção viável, avalie se o pacote roda no servidor ou só no build, e registre a análise em `docs/phase5/dependency-audit.md`.
4. Só então adicione a exceção (abaixo).

### SAST (Semgrep)
1. Leia o relatório no log do job `sast`.
2. Achado real: corrija em PR próprio. Falso positivo: comentário `// nosemgrep: <regra> -- motivo` na linha.

## Como adicionar uma exceção de SCA

Edite `.github/security/npm-audit-exceptions.json` e inclua **todos** os campos:

```json
{ "name": "pacote", "version": "1.2.3", "max_severity": "high",
  "reason": "Por que o risco é aceitável aqui.",
  "reference": "docs/phase5/dependency-audit.md (seção/opção)",
  "review_by": "AAAA-MM-DD" }
```

- Vale **só** para aquela versão instalada e até aquela severidade. Atualizar o pacote ou o aviso piorar derruba o job de propósito: reavalie e atualize a entrada.
- `review_by`: no máximo 90 dias à frente. Após a data o job falha até alguém reavaliar e renovar com justificativa.
- Nunca ignore "tudo": uma entrada por pacote, revisada em PR.
- Remova a exceção quando o pacote for corrigido.

## Quando tornar o Semgrep bloqueante

Remova `continue-on-error: true` do job `sast` e adicione `--error` ao comando quando **todos** valerem:
1. Os achados atuais foram triados: corrigidos ou marcados com `nosemgrep` justificado.
2. Os últimos 10 PRs/execuções em `main` não trouxeram falso positivo novo sem triagem.
3. A severidade bloqueante está definida (sugestão: `--severity ERROR` primeiro).

**Prazo:** triar o primeiro relatório do job `sast` e decidir a passagem para bloqueante até **16/12/2026** (30 dias depois da introdução). Se o prazo vencer sem triagem, registrar o motivo e a nova data no PR que o adiar.

## Limites conhecidos

- As regras `p/...` são baixadas do registro do Semgrep na execução (não ficam fixadas); o binário é fixado por versão no pip, sem hash.
- Falha de rede no `npm audit` faz o job SCA falhar (fail-closed), não passar.
- Não há varredura de imagens Docker nem de IaC neste PR.
