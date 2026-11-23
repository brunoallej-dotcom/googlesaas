# Specs

Spec-Driven Development. Every non-trivial feature has a spec **here** before
or alongside its implementation.

## How to add a new spec

1. Copy `_template.md` to `docs/specs/<feature-name>.md`.
2. Fill in goal, contracts, edge cases, acceptance criteria.
3. Open the implementation PR with the spec included.
4. Update the spec whenever the contract or scope changes.

## Naming

`<feature-name>.md` — kebab-case, matches the slice name under `src/features/`.

## Index

- [link-audit-observability](link-audit-observability.md) — logs estruturados, correlation id, métricas e alertas da Auditoria por Link (Fase 6)
- [link-audit-p1-attestation](link-audit-p1-attestation.md) — produtor P1: atestação offline da coleta com manifesto Ed25519 (Fase 6)
- [ci-deploy-and-seal-delivery](ci-deploy-and-seal-delivery.md) — deploy pelo CI (P-9) por SSH restrito a receptores de comando único, pilha de homologação e entrega dos manifestos selados do P1
- [link-audit-production-gates](link-audit-production-gates.md) — portões de produção da Fase 6 fora do P1: guarda externa, papel administrativo, volumes e chaves, D5, portão consolidado e piloto mínimo

As specs anteriores da Fase 6 ficam em `docs/phase6-auditoria-link/` (mantidas como estão).
