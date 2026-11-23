/*
 * P9.3b — superfície pública do receptor de manifestos (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.7, §5.8). A entrada fina é
 * `scripts/seal-receiver.ts`, empacotada em `gmn-seal-receiver.cjs` por `scripts/build-receivers-artifact.ts`.
 */
export { parseSealReceiverArgs, type SealReceiverConfig } from './args';
export { CLOSURE_REFUSAL_DETAILS, publicErrorLine, SEAL_RECEIVER_EXIT_CODES, SealReceiverError, V2_REFUSAL_DETAILS, type SealReceiverCode, type SealReceiverOutcome } from './codes';
export { MAX_COMMAND_BYTES, parseSealCommand, type PutCommand, type SealTarget } from './grammar';
export type { PermissionFacts, SealReceiverDeps } from './ports';
export { runSealReceiver, type SealDepsFactory, type SealReceiverInvocation } from './receiver';
