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
  type WebhookSecretSet,
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

export {
  carriesPublication,
  extractPublicationKeys,
  findingMarker,
  publicationMarker,
} from "./publish/markers.js";
export {
  GithubProviderError,
  GithubReviewPublisher,
  classifyFailure,
  classifyTransportError,
  type GithubRequest,
  type InlineComment,
  type ProviderFailure,
  type ProviderFailureClass,
  type RemoteReview,
  type ReviewContent,
} from "./publish/review-publisher.js";

export {
  DEFAULT_GITHUB_REPOSITORY_READER_LIMITS,
  GithubRepositoryReadError,
  GithubRepositoryReader,
  type GithubBaseFile,
  type GithubChangedFile,
  type GithubRepositoryReaderLimits,
  type GithubRepositoryRequest,
  type GithubRepositoryResponse,
  type GithubRepositoryRevision,
  type GithubRepositorySnapshot,
} from "./source/repository-reader.js";

export {
  createAuthenticatedGithubRepositoryRequest,
  type GithubRepositoryRequestOptions,
} from "./source/authenticated-request.js";
