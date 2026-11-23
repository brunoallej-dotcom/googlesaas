/*
 * P9.2 — superfície pública do núcleo do canal de manifestos (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.2–§5.4). O job `seals`
 * usa o comando (`cli.ts`); o receptor de deploy (P9.3a) reaproveita o módulo da lista (parser do arquivo, regra de ambiente e transição); o
 * receptor de manifestos (P9.3b) reaproveita a gramática, as regras por arquivo e as das cadeias.
 */
export { runSealsCheckCli, SEALS_CHECK_EXIT } from './cli';
export { runSealsCheck, type SealsCheckInput, type SealsCheckReport } from './check';
export type { SealsRefusal, SealsRefusalCode, SealsRuleId } from './codes';
export { AUDIT_ID_CHANNEL_PATTERN, CHANNEL_ENVIRONMENTS, classifyChannelPath, SEALS_ROOT, TRUST_LIST_FILE, type ChannelEnvironment, type ChannelPath } from './paths';
export {
  MAX_TRUST_LIST_BYTES,
  parseTrustListFile,
  trustListEnvironmentViolations,
  trustListTransition,
  type TrustListItem,
  type TrustListParse,
  type TrustTransition,
  type TrustTransitionReason,
} from './trust-list';
