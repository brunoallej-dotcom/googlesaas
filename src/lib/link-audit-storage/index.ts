// Primitivas NEUTRAS de armazenamento e integridade (Onda 6C, I0). Interface do módulo: tudo o que os consumidores (hoje
// `link-audit-decisions`, depois o armazenamento de resultados) podem usar. Nada aqui conhece decisões, evidências ou o motor.
export * from './files';
export * from './receipts';
