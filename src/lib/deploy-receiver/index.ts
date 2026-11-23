/*
 * P9.3a — superfície pública do receptor de deploy (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.6, §5.8). A entrada fina é
 * `scripts/deploy-receiver.ts`, empacotada em `gmn-deploy-receiver.cjs` por `scripts/build-receivers-artifact.ts`.
 */
export { parseReceiverArgs, type ReceiverConfig } from './args';
export { HOST_CONFIG_NAMES, POSTDEPLOY_CHECK_IDS, RECEIVER_EXIT_CODES, publicErrorLine, ReceiverError, type ReceiverCode, type ReceiverOutcome } from './codes';
export { MAX_BUNDLE_BYTES, MAX_COMMAND_BYTES, parseReceiverCommand, type DeployEnvironment, type ReceiverCommand } from './grammar';
export { checkHostConfig, parseHostVarsFile, type HostConfig } from './host-vars';
export type { ReceiverDeps } from './ports';
export { LOCK_FILE, runDeployReceiver, type DepsFactory, type ReceiverInvocation } from './receiver';
