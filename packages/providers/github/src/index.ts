/**
 * @acalys/provider-github — the GitHub adapter.
 *
 * The only package in the platform that understands GitHub's vocabulary
 * (§1, §59). It converts signed webhook deliveries into canonical contracts
 * and returns nothing GitHub-shaped.
 *
 * There is deliberately no `SourceProviderAdapter` interface yet. A single
 * implementation cannot tell you which of its shapes are essential and which
 * are GitHub's accident; the interface is extracted in Phase 2, when GitLab
 * provides the second data point that makes the abstraction real rather than
 * imagined (§131).
 */
export {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_FAILURES,
  SIGNATURE_HEADER,
  type DeliveryHeaders,
  type SignatureFailure,
  type SignatureVerification,
  readDeliveryHeaders,
  signWebhookBody,
  verifyWebhookSignature,
} from "./webhook/signature.js";

export {
  PULL_REQUEST_ACTIONS,
  githubIdSchema,
  githubInstallationEventSchema,
  githubPingEventSchema,
  githubPullRequestEventSchema,
  githubPullRequestSchema,
  githubRepositorySchema,
  githubUserSchema,
  gitShaSchema,
  type GithubInstallationEvent,
  type GithubPingEvent,
  type GithubPullRequest,
  type GithubPullRequestEvent,
  type GithubRepository,
  type GithubUser,
  type PullRequestAction,
} from "./webhook/payloads.js";

export {
  NormalizationError,
  type ResolvedIdentity,
  isHandledAction,
  revisionTriggerFor,
  toActor,
  toPullRequest,
  toRepositoryPath,
  toReviewTarget,
  toRevision,
} from "./normalize/pull-request.js";

export * from "./auth/index.js";
