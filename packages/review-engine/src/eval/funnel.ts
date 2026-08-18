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
import { toVerificationInput } from "../verification/input.js";
import { verifyDeterministically } from "../verification/deterministic.js";
import type { VerificationAttempt } from "../verification/decide.js";
import type { AnalyzerCase, Bucket } from "./corpus.js";
import { runCase } from "./run.js";

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
   * Spurious candidates verification did not verify. The benefit.
   *
   * Counts `rejected` and `inconclusive` alike: both stop the candidate, and
   * insisting on `rejected` would credit the verifier only when it is certain,
   * which is not how the suppression actually works.
   */
  readonly falsePositivesCaught: number;
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
  readonly candidatePrecision: number;
  readonly publishedPrecision: number;
  /** Of the defects planted, how many a developer actually sees. */
  readonly publishedRecall: number;

  /** Context tokens across analysis and verification, per published finding. */
  readonly tokensPerPublishedFinding: number;
  readonly analysisTokens: number;
  readonly verificationTokens: number;
}

const round = (value: number): number => Number(value.toFixed(4));

/**
 * Runs one case through the funnel.
 *
 * The verifier's context is planned from the case's file map — the repository
 * as it is — never from the analyzer's assembled context. That is the
 * independence the type signature already enforces; doing it any other way here
 * would measure a verifier that does not exist.
 */
export async function runFunnelCase(testCase: AnalyzerCase): Promise<{
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
    verificationTokens += context.items.reduce(
      // Same four-characters-per-token approximation the planner uses, so the
      // two halves of the token budget are measured on one scale.
      (total, item) => total + Math.ceil(item.content.length / 4),
      0,
    );

    const attempt = verifyDeterministically(input, context);

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
): Promise<FunnelReport> {
  const journeys: CandidateJourney[] = [];
  let analysisTokens = 0;
  let verificationTokens = 0;

  for (const testCase of cases) {
    const outcome = await runFunnelCase(testCase);
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
    falsePositivesCaught: count(
      (journey) => !journey.wanted && !journey.promoted,
    ),
    truePositivesLost: count((journey) => journey.wanted && !journey.promoted),
    falsePositivesPublished,
    truePositivesPublished,
    candidatePrecision:
      candidates === 0 ? 1 : round(wantedCandidates / candidates),
    publishedPrecision:
      published === 0 ? 1 : round(truePositivesPublished / published),
    publishedRecall:
      plantedTotal === 0 ? 1 : round(truePositivesPublished / plantedTotal),
    tokensPerPublishedFinding:
      published === 0
        ? 0
        : round((analysisTokens + verificationTokens) / published),
    analysisTokens,
    verificationTokens,
  };
}
