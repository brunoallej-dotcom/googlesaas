# Roteiros de navegador (Onda 6C)

Verificações **reproduzíveis** da Auditoria por Link num Chromium headless real, contra o servidor de produção local (`next start`), com
**dados 100% fictícios** e as **APIs locais reais** (decisões, resultados, evidências). Complementam a suíte `npm test`: ela cobre regras
e renderização estática; estes roteiros cobrem o que só um navegador mostra (foco, teclado, histórico, layout, contraste medido).

## O que NÃO fazem

- Não leem `.env*`, não acessam Redis, Supabase, Serper nem a rede externa (rodam em namespace de rede vazio, via `scripts/run-isolated.sh`).
- Não usam sessão nem credencial reais: o cookie é assinado por um **segredo aleatório gerado a cada execução** (`crypto.randomBytes`),
  para operadores fictícios (`ana@empresa.com`, `bia@empresa.com`) e uma "intrusa" não autorizada.
- Não instalam dependências (CDP puro sobre o `WebSocket` nativo do Node 22) e não alteram `stack.yml`, `Dockerfile` nem volumes.
- Não clicam em nada que dispare coleta (o campo de link só é preenchido para medir a cor do botão; nada é enviado).

## Como rodar

```bash
# 1) build de produção OFFLINE (obrigatório depois de mudar o código; o .next gerado NÃO é para publicar)
scripts/run-isolated.sh --offline-fonts npm run build

# 2) roteiros (um servidor local por roteiro; portas 3987/3988/3989 em loopback)
scripts/browser/run.sh i5        # área operacional Lumos: decisão, finalização, 429 real, histórico, foco
scripts/browser/run.sh i6        # listagem ↔ workspace, ?auditId=, teclado, menu, reflow, movimento reduzido, contraste
scripts/browser/run.sh i7        # (a partir do I7) homologação ponta a ponta: fluxo completo, estados do produto, segurança, UX
scripts/browser/run.sh all       # todos os roteiros presentes; use --build para refazer o build antes
```

Variáveis: `VISUAL_OUT` (capturas PNG e `resultado-<roteiro>.json`; padrão: uma pasta nova `/tmp/gmn-browser-out-XXXXXX`, impressa no início) e `VISUAL_BROWSER` (caminho do Chromium;
senão procura o headless-shell do cache do Playwright e `chromium`/`google-chrome` no `PATH`).

Saída de cada roteiro: `0` tudo aprovado · `1` alguma verificação reprovada · `77` sem Chromium (**SKIPPED**) · `78` falta o build.
O JSON traz, por verificação, `PASS`, `FAIL` ou `SKIPPED` com o detalhe, a versão do Chromium e a do Node.

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `harness.cjs` | servidor local + Chromium + CDP; helpers (`go`, `tab`, `key`, `shot`, `contrast`, `smallTargets`, `noHorizontalScroll`, `a11yLint`…) |
| `contrast.cjs` | medidor de contraste WCAG executado na página (texto e fundos translúcidos/degradês; desabilitados isentos) |
| `a11y-lint.cjs` | verificador PRÓPRIO e reduzido de regras de acessibilidade em página (usado pelo `i7`; não é o axe-core) |
| `tests/helpers/browser-seed-i5.ts` / `browser-seed-i6.ts` | sementes fictícias gravadas em diretório temporário (type-checked pelo `tsc`). Ficam em `tests/helpers` porque usam os serviços de evidências/decisões/resultados, que as regras de isolamento proíbem em `scripts/`; `browser-seed-i6.ts` aceita `with-scored` (I7: acrescenta um resultado PONTUADO selado por fixture rica) |
| `i5-workspace.cjs` · `i6-navigation.cjs` · `i7-homologacao.cjs` (a partir do I7) | os roteiros |
| `run.sh` | executa os roteiros isolados e resume |

## Limites (importante)

- **Um** navegador (Chromium headless) e **um** sistema operacional. Não substituem testes em Firefox/Safari, em dispositivo físico nem com
  **leitor de tela real** (NVDA/JAWS/VoiceOver): isso fica registrado como **SKIPPED**, nunca como aprovado.
- A verificação de acessibilidade em página (`a11yLint`) é um conjunto **próprio e reduzido** de regras (nomes, rótulos, ids, referências
  `aria-*`, marcos, foco). `axe-core` não está disponível offline neste ambiente; o verificador **não** o substitui nem comprova conformidade.
- O contraste é medido sobre o que o navegador desenha (cores computadas); estados não exercitados (ex.: foco de cada controle) não são cobertos.
