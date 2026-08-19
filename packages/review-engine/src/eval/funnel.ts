/**
 * The corpus, run through the whole funnel rather than the analyzer alone.
 *
 * The existing eval stops at `CandidateFinding`. That measures the analyzer,
 * which is worth measuring — and it cannot answer the question the product is
 * actually built around:
 *
 * > Does independent verification earn its cost?
 *
 * Verification is not free. It spends tokens, adds latency, and can reject a
 * true finding. It is worth having only if it removes more false positives than
 * true positives it loses, and neither number is visible from a report that
 * ends at candidate generation.
 *
 * So this runs each case the whole way:
 *
 * ```
 * CandidateFinding[]        the analyzer's hypotheses
 *      ↓  verification      independently planned context, per claim
 * VerificationAttempt[]
 *      ↓  promotion         verified only
 * ReviewFinding[]
 *      ↓  publication policy
 * published / withheld
 * ```
 *
 * # The four numbers that decide the answer
 *
 * ```
 * caught     a spurious candidate verification did NOT verify   the benefit
 * lost       a real defect verification did NOT verify          the cost
 * survived   a spurious candidate that reached publication      the residue
 * published  a real defect that reached publication             the product
 * ```
 *
 * `caught > lost` is the whole case for the verifier existing. If it is ever
 * false, the honest response is to remove verification rather than to tune the
 * corpus until the ratio improves.
 *
 * # What this deliberately does not do
 *
 * It does not touch the database. Persistence is proven by the Postgres funnel
 * suite; mixing the two would make a quality regression and a storage bug
 * produce the same red number. The stages here are the same pure kernels the
 * worker calls — `promoteVerified`, `planPublication` — so what is measured is
 * the decision logic the product ships, not a reimplementation of it.
 */

import type { CorrectnessFamily } from "../finding.js";
import {
  DEFAULT_PUBLICATION_CONFIG,
  planPublication,
  type PublicationConfig,
} from "../publication/policy.js";
import {
  promoteVerified,
  type VerifiedCandidate,
} from "../publication/promote.js";
import {
  DEFAULT_VERIFICATION_POLICY,
  planVerificationContext,
} from "../verification/plan-context.js";
import { assessCompetence } from "../verification/competence.js";
import {
  NULL_RECORDER,
  measure,
  type Recorder,
  type WorkProfile,
} from "../telemetry/index.js";
import { toVerificationInput } from "../verification/input.js";
import { verifyDeterministically } from "../verification/deterministic.js";
import type { VerificationAttempt } from "../verification/decide.js";
import type { AnalyzerCase, Bucket } from "./corpus.js";
import { runCase } from "./run.js";

/**
 * How each side established the fact that decided the claim.
 *
 * Descriptive, and deliberately not a score. The useful question when several
 * components agree is not *how many agreed* but *did they agree by different
 * means* — and without this recorded, "three stages concurred" and "three
 * stages called the same broken helper" are indistinguishable after the fact.
 *
 * `shared` is not automatically bad. Sometimes the compiler is the
 * authoritative evidence and both sides should use it; what matters is that the
 * eval can tell the two situations apart. Turning this into
 * `independenceScore = 0.73` would create something to optimize before anyone
 * knows what it means.
 */
export interface DecisionDerivation {
  /** How the analyzer settled it. */
  readonly candidate: string;
  /** How verification settled it. */
  readonly verification: string;
  /** Named when both used the same channel; `undefined` when they did not. */
  readonly shared: string | undefined;
}

/**
 * What each capability uses to settle its disputed fact.
 *
 * The analyzer proposes every one of these from `@acalys/code-intelligence`'s
 * symbol graph, so the interesting column is the verifier's.
 */
const VERIFICATION_DERIVATION: Readonly<Record<string, string>> = {
  async_value_use: "typescript_checker",
  condition_value_semantics: "typescript_checker",
  signature_compatibility: "typescript_diagnostics",
  exception_flow: "ast_consequence_analysis",
};

const CANDIDATE_DERIVATION = "code_intelligence_symbol_graph";

/** One candidate, and everything that happened to it. */
export interface CandidateJourney {
  readonly caseId: string;
  readonly bucket: Bucket;
  readonly family: CorrectnessFamily;
  /**
   * Whether the corpus expected this family here.
   *
   * The ground truth the whole report is graded against, and deliberately
   * coarse: family-level, because a corpus that graded on exact line numbers
   * would call a correct finding wrong for pointing one line off.
   */
  readonly wanted: boolean;
  readonly attempt: VerificationAttempt;
  readonly promoted: boolean;
  readonly published: boolean;
  /**
   * Whether the two sides reached this verdict by the same route.
   *
   * `undefined` when the candidate never reached a capability.
   */
  readonly derivation: DecisionDerivation | undefined;
}

export interface FunnelReport {
  readonly cases: number;
  readonly journeys: readonly CandidateJourney[];

  readonly candidates: number;
  readonly verified: number;
  readonly rejected: number;
  readonly inconclusive: number;
  readonly unavailable: number;

  readonly promoted: number;
  readonly published: number;
  readonly withheld: number;

  /**
   * Analyzer false positives the verifier **refuted**.
   *
   * Split from the ones it merely declined to confirm, because the two are
   * different strengths of evidence and collapsing them overstates the
   * verifier:
   *
   * ```
   * refuted    "I established this claim is false"
   * abstained  "I found enough disagreement not to stand behind it"
   * ```
   *
   * Both stop publication, and only the first is the verifier proving the
   * analyzer wrong. Reporting one number called "caught" credits the stronger
   * claim for the weaker work.
   */
  readonly falsePositivesRefuted: number;
  /** Analyzer false positives that ended `inconclusive`. Also stopped. */
  readonly falsePositivesAbstained: number;
  /** Refuted plus abstained: everything that did not reach a developer. */
  readonly falsePositivesFiltered: number;
  /** Real defects verification did not verify. The cost. */
  readonly truePositivesLost: number;
  /** Spurious candidates that reached publication anyway. The residue. */
  readonly falsePositivesPublished: number;
  /** Real defects that reached publication. The product. */
  readonly truePositivesPublished: number;

  /**
   * Precision at the candidate boundary and at the published boundary.
   *
   * Reported as a pair because the delta between them *is* the verifier's
   * contribution. A single end-to-end number would hide whether the analyzer or
   * the verifier produced it.
   */
  readonly candidatePrecision: Ratio;
  readonly publishedPrecision: Ratio;
  /** Of the defects planted, how many a developer actually sees. */
  readonly publishedRecall: Ratio;

  /**
   * Where every unpublished expected defect died.
   *
   * Sums to `planted - truePositivesPublished`, which is asserted rather than
   * assumed: an attribution that does not account for every loss is one that
   * hides the losses it cannot explain.
   */
  readonly losses: LossAttribution;
  readonly planted: number;

  /**
   * Of the false positives the analyzer produced, how many verification
   * stopped by any means. `undefined` when the corpus contains none to stop.
   */
  readonly falsePositiveFilterRate: Ratio;
  /** And how many it actually refuted. The stronger claim, measured apart. */
  readonly falsePositiveRefutationRate: Ratio;

  /** Context tokens across analysis and verification, per published finding. */
  readonly tokensPerPublishedFinding: Ratio;
  readonly analysisTokens: number;
  readonly verificationTokens: number;

  /**
   * Verdicts where analyzer and verifier used the same decisive channel.
   *
   * Watched, not minimized. It is how the shadowed-parameter false positive
   * survived two independent components: both searched for a declaration by
   * name, so the second one agreeing carried no information. Recording it means
   * a future recurrence is diagnosable as "both depended on X" rather than
   * "both happened to be wrong".
   */
  readonly correlatedDerivations: number;

  /**
   * How much work the competence router decided was necessary.
   *
   * Carried in the quality report because it is the bridge to economics: once
   * a model-backed verifier exists, `deepVerificationRequired` is what says
   * whether the cheap deterministic layer is avoiding expensive work or merely
   * preceding it.
   */
  readonly work: WorkProfile;
}

/**
 * A ratio that admits it has no denominator.
 *
 * `0 / 0` is not `0`. The distinction is not pedantry here: the first funnel
 * report showed `falsePositivesCaught = 0` against a corpus containing **no
 * false positives at all**, and rendered as `0` it reads as "verification
 * caught nothing" — an argument for deleting the verifier. It actually meant
 * "verification was never asked", which is an argument about the corpus.
 *
 * Every ratio in this report is therefore `number | undefined`, and a consumer
 * has to decide what to print for `undefined` rather than being handed a zero
 * that looks like a measurement.
 */
export type Ratio = number | undefined;

const round = (value: number): number => Number(value.toFixed(4));

const ratio = (numerator: number, denominator: number): Ratio =>
  denominator === 0 ? undefined : round(numerator / denominator);

/**
 * Where an expected defect died.
 *
 * A single `publishedRecall = 0.5` is not actionable: it is equally consistent
 * with a planner that fetched nothing, an analyzer that saw nothing, a verifier
 * that refused, a verifier that could not tell, an outage, and a policy that
 * withheld. Those have six different fixes and three different owners.
 *
 * Every loss is attributed to exactly one stage, at the first point the defect
 * stopped moving.
 */
export const LOSS_STAGES = [
  /** No candidate was produced. Analyzer or planner. */
  "not_proposed",
  /** Verification affirmatively refuted it. The expensive kind of wrong. */
  "verifier_refuted",
  /** Verification could not settle it. Verifier reach, not analyzer accuracy. */
  "verifier_abstained",
  /** Verification could not run. Operational, never quality. */
  "verification_unavailable",
  /** Verified and promoted, and policy chose not to interrupt anyone. */
  "policy_withheld",
] as const;

export type LossStage = (typeof LOSS_STAGES)[number];

export type LossAttribution = Readonly<Record<LossStage, number>>;

/**
 * Runs one case through the funnel.
 *
 * The verifier's context is planned from the case's file map — the repository
 * as it is — never from the analyzer's assembled context. That is the
 * independence the type signature already enforces; doing it any other way here
 * would measure a verifier that does not exist.
 */
export async function runFunnelCase(
  testCase: AnalyzerCase,
  /**
   * Where measurements go. Defaults to a recorder that discards everything.
   *
   * The default is not a convenience: the non-interference proof needs a
   * configuration in which measurement genuinely does nothing, so that
   * identical output shows instrumentation is inert rather than merely
   * careful.
   */
  recorder: Recorder = NULL_RECORDER,
): Promise<{
  readonly journeys: readonly CandidateJourney[];
  readonly analysisTokens: number;
  readonly verificationTokens: number;
}> {
  const analysis = await runCase(testCase);

  const snapshot = {
    revisionId: `eval:${testCase.id}`,
    files: new Map(Object.entries(testCase.files)),
  };

  const candidates: VerifiedCandidate[] = [];
  const journeys: Omit<CandidateJourney, "promoted" | "published">[] = [];
  let verificationTokens = 0;

  for (const [index, finding] of analysis.findings.entries()) {
    const candidateId = `${testCase.id}#${String(index)}`;
    const { input } = toVerificationInput(candidateId, finding, {
      repositoryId: "eval",
      revisionId: snapshot.revisionId,
    });

    const context = planVerificationContext({
      verificationInput: input,
      repository: snapshot,
      policy: DEFAULT_VERIFICATION_POLICY,
    });
    const contextTokens = context.items.reduce(
      // Same four-characters-per-token approximation the planner uses, so the
      // two halves of the token budget are measured on one scale. An ESTIMATE,
      // and named that way everywhere: `inputTokens` is reserved for usage a
      // provider reports.
      (total, item) => total + Math.ceil(item.content.length / 4),
      0,
    );
    verificationTokens += contextTokens;

    const attempt = await measure(
      recorder,
      {
        runId: `eval:${testCase.id}`,
        stage: "verification",
        // Logical identity: one candidate, one verification. A retry of this
        // same claim would raise `attempt`, not mint a new invocation.
        invocationId: candidateId,
        candidateId,
        implementationKind: "deterministic",
        procedureId: "acalys.verifier.re-derivation",
        procedureVersion: "1.0.0",
        attempt: 1,
        context: {
          items: context.items.length,
          characters: context.items.reduce(
            (total, item) => total + item.content.length,
            0,
          ),
          tokenEstimate: contextTokens,
          omittedItems: 0,
          assemblyMs: 0,
        },
        inference: undefined,
      },
      () => verifyDeterministically(input, context),
    );

    const competence = assessCompetence(input);
    const verification =
      competence.kind === "supported"
        ? (VERIFICATION_DERIVATION[competence.capability] ?? "unknown")
        : "none";
    const derivation: DecisionDerivation = {
      candidate: CANDIDATE_DERIVATION,
      verification,
      // Named rather than flagged: "both used the TypeScript checker" is a
      // different situation from "both used a name search", and only the label
      // survives being read six months later.
      shared:
        verification === CANDIDATE_DERIVATION
          ? CANDIDATE_DERIVATION
          : undefined,
    };

    candidates.push({
      candidateId,
      fingerprint: finding.identityHint,
      severity: finding.proposedSeverity,
      category: finding.category,
      path: finding.location.path,
      attempt,
    });
    journeys.push({
      caseId: testCase.id,
      bucket: testCase.bucket,
      family: finding.family,
      wanted: testCase.expect.includes(finding.family),
      attempt,
      derivation,
    });
  }

  const gate = promoteVerified(candidates);
  const promotedFingerprints =
    gate.kind === "promoted"
      ? new Set(gate.findings.map((finding) => finding.fingerprint))
      : new Set<string>();

  const plan =
    gate.kind === "promoted"
      ? planPublication(gate.findings, EVAL_PUBLICATION_CONFIG)
      : { publish: [] as { fingerprint: string }[] };
  const publishedFingerprints = new Set(
    plan.publish.map((finding) => finding.fingerprint),
  );

  return {
    journeys: journeys.map((journey, index) => {
      const fingerprint = candidates[index]?.fingerprint ?? "";
      return {
        ...journey,
        promoted: promotedFingerprints.has(fingerprint),
        published: publishedFingerprints.has(fingerprint),
      };
    }),
    analysisTokens: analysis.contextTokens,
    verificationTokens,
  };
}

/**
 * Publication configuration for the corpus.
 *
 * Deliberately permissive — no severity floor, no path exclusions, a budget no
 * case reaches. Policy suppression is a product decision and is tested on its
 * own; letting it fire here would mix "the reviewer was wrong" with "the
 * reviewer was configured to stay quiet", and only the first is a quality
 * problem.
 */
export const EVAL_PUBLICATION_CONFIG: PublicationConfig = {
  ...DEFAULT_PUBLICATION_CONFIG,
  minimumSeverity: "info",
  maxComments: 100,
};

export async function evaluateFunnel(
  cases: readonly AnalyzerCase[],
  recorder: Recorder = NULL_RECORDER,
): Promise<FunnelReport> {
  const journeys: CandidateJourney[] = [];
  let analysisTokens = 0;
  let verificationTokens = 0;

  for (const testCase of cases) {
    const outcome = await runFunnelCase(testCase, recorder);
    journeys.push(...outcome.journeys);
    analysisTokens += outcome.analysisTokens;
    verificationTokens += outcome.verificationTokens;
  }

  const count = (predicate: (journey: CandidateJourney) => boolean): number =>
    journeys.filter(predicate).length;

  const decided = (decision: string) =>
    count(
      (journey) =>
        journey.attempt.status === "completed" &&
        journey.attempt.decision === decision,
    );

  const candidates = journeys.length;
  const published = count((journey) => journey.published);
  const truePositivesPublished = count(
    (journey) => journey.published && journey.wanted,
  );
  const falsePositivesPublished = count(
    (journey) => journey.published && !journey.wanted,
  );
  const wantedCandidates = count((journey) => journey.wanted);

  // Ground truth: every family the corpus planted, across every case.
  const plantedTotal = cases.reduce(
    (total, testCase) => total + testCase.expect.length,
    0,
  );

  // ── Loss attribution ──────────────────────────────────────────────────
  //
  // Walked per expected family rather than per candidate, because a defect the
  // analyzer never proposed has no candidate to attribute. Each expected family
  // is charged to the first stage at which it stopped.
  const losses: Record<LossStage, number> = {
    not_proposed: 0,
    verifier_refuted: 0,
    verifier_abstained: 0,
    verification_unavailable: 0,
    policy_withheld: 0,
  };

  for (const testCase of cases) {
    for (const family of testCase.expect) {
      const forFamily = journeys.filter(
        (journey) =>
          journey.caseId === testCase.id && journey.family === family,
      );

      if (forFamily.some((journey) => journey.published)) continue;
      if (forFamily.length === 0) {
        losses.not_proposed += 1;
        continue;
      }

      // A family may produce several candidates; charge the loss to the one
      // that got furthest, so a single bad duplicate does not mask the fact
      // that another candidate almost made it.
      const rank = (journey: CandidateJourney): number =>
        journey.promoted
          ? 4
          : journey.attempt.status === "unavailable"
            ? 1
            : journey.attempt.decision === "inconclusive"
              ? 3
              : 2;
      const furthest = [...forFamily].sort((a, b) => rank(b) - rank(a))[0];
      if (furthest === undefined) continue;

      if (furthest.promoted) losses.policy_withheld += 1;
      else if (furthest.attempt.status === "unavailable")
        losses.verification_unavailable += 1;
      else if (furthest.attempt.decision === "inconclusive")
        losses.verifier_abstained += 1;
      else losses.verifier_refuted += 1;
    }
  }

  const spuriousCandidates = count((journey) => !journey.wanted);

  return {
    cases: cases.length,
    journeys,
    candidates,
    verified: decided("verified"),
    rejected: decided("rejected"),
    inconclusive: decided("inconclusive"),
    unavailable: count((journey) => journey.attempt.status === "unavailable"),
    promoted: count((journey) => journey.promoted),
    published,
    withheld: count((journey) => journey.promoted && !journey.published),
    falsePositivesRefuted: count(
      (journey) =>
        !journey.wanted &&
        journey.attempt.status === "completed" &&
        journey.attempt.decision === "rejected",
    ),
    falsePositivesAbstained: count(
      (journey) =>
        !journey.wanted &&
        journey.attempt.status === "completed" &&
        journey.attempt.decision === "inconclusive",
    ),
    falsePositivesFiltered: count(
      (journey) => !journey.wanted && !journey.promoted,
    ),
    truePositivesLost: count((journey) => journey.wanted && !journey.promoted),
    falsePositivesPublished,
    truePositivesPublished,
    candidatePrecision: ratio(wantedCandidates, candidates),
    publishedPrecision: ratio(truePositivesPublished, published),
    publishedRecall: ratio(truePositivesPublished, plantedTotal),
    losses,
    planted: plantedTotal,
    // `undefined`, not zero, when the analyzer produced nothing false to stop.
    falsePositiveFilterRate: ratio(
      count((journey) => !journey.wanted && !journey.promoted),
      spuriousCandidates,
    ),
    falsePositiveRefutationRate: ratio(
      count(
        (journey) =>
          !journey.wanted &&
          journey.attempt.status === "completed" &&
          journey.attempt.decision === "rejected",
      ),
      spuriousCandidates,
    ),
    tokensPerPublishedFinding: ratio(
      analysisTokens + verificationTokens,
      published,
    ),
    analysisTokens,
    verificationTokens,
    correlatedDerivations: count(
      (journey) => journey.derivation?.shared !== undefined,
    ),
    work: {
      candidatesTotal: candidates,
      competenceSupported: count(
        (journey) => journey.derivation?.verification !== "none",
      ),
      competenceUnsupported: count(
        (journey) => journey.derivation?.verification === "none",
      ),
      // Everything, today. The number that will matter is the next one.
      deterministicallySettled: candidates,
      // Reserved for a verifier that costs something. Zero is a real count
      // here: no candidate was deferred to an expensive procedure, because
      // there is no expensive procedure.
      deepVerificationRequired: 0,
    },
  };
}
