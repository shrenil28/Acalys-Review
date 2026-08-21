/**
 * Running the frozen M.1 corpora through the production funnel.
 *
 * This measures; it does not judge. `evaluateM1Gate` renders the verdict from
 * what this produces, and keeping the two apart is the same separation the
 * capability contract requires between analyzer and verifier — anything that
 * both produced the numbers and decided whether they were good enough would be
 * self-certification one level up.
 *
 * # The seal is checked before any case is read
 *
 * A holdout evaluated from a corpus that changed since it was sealed is not a
 * holdout. `assertHoldoutSeal` recomputes the digest and refuses on mismatch,
 * so the first observation cannot silently be of something else.
 *
 * # What "published" means here
 *
 * The full funnel, in the production order:
 *
 * ```
 * runRealAnalysis   -> candidates
 * verifyDeterministically -> verified / rejected / inconclusive
 * promoteVerified   -> ReviewFinding
 * planPublication   -> published / withheld
 * ```
 *
 * A case counts as a published true positive only when the expected finding
 * survives all four stages at the expected location. Counting candidates would
 * measure the analyzer; the gate is about what a reviewer would actually see.
 */

import {
  DEFAULT_PUBLICATION_CONFIG,
  planPublication,
  planVerificationContext,
  promoteVerified,
  verifyDeterministically,
  type CandidateFinding,
  type VerificationAttempt,
} from "@acalys/review-engine";

import { runRealAnalysis } from "../analysis.js";
import {
  M1_DEVELOPMENT_CASES,
  M1_HOLDOUT_CASES,
  M1_HOLDOUT_DIGEST,
  corpusDigest,
  type M1CapabilityCase,
} from "./m1-corpus.js";
import type { M1SplitOutcome } from "./m1-gate.js";

const REPOSITORY_ID = "0192f8a1-0000-7000-8000-00000000m2e0".replace(
  /[^0-9a-f-]/g,
  "0",
);
const REVISION = "a1".repeat(20);

/**
 * Refuses to proceed if the sealed corpus is not the sealed corpus.
 *
 * Called before reading a single holdout case. A digest checked afterwards
 * would confirm what was already measured.
 */
export function assertHoldoutSeal(): void {
  const actual = corpusDigest(M1_HOLDOUT_CASES);
  if (actual !== M1_HOLDOUT_DIGEST) {
    throw new Error(
      `Holdout seal broken: expected ${M1_HOLDOUT_DIGEST}, computed ${actual}. ` +
        "Whatever this measures, it is not the frozen holdout.",
    );
  }
}

export interface M1CaseObservation {
  readonly caseId: string;
  readonly capabilityFamily: string;
  readonly candidates: number;
  readonly expectedCandidate: boolean;
  readonly verified: boolean;
  readonly published: boolean;
  /** Published findings that were not the expected one. */
  readonly unexpectedPublished: number;
}

/** Whether a candidate lands where the case says the defect is. */
function matchesExpectation(
  candidate: CandidateFinding,
  entry: M1CapabilityCase,
): boolean {
  const expected = entry.expectedFindings[0];
  if (expected === undefined) return false;
  return (
    candidate.location.path === expected.path &&
    candidate.location.startLine <= expected.endLine &&
    candidate.location.endLine >= expected.startLine
  );
}

function adjudicate(
  candidate: CandidateFinding,
  files: Readonly<Record<string, string>>,
): VerificationAttempt {
  const input = {
    candidateId: candidate.identityHint,
    repositoryId: REPOSITORY_ID,
    revisionId: REVISION,
    remediation: candidate.remediation,
    claim: {
      statement: candidate.claim,
      steps: candidate.causal.steps,
      trigger: candidate.causal.trigger,
      consequence: candidate.causal.consequence,
    },
    location: candidate.location,
    evidence: candidate.evidence.map((entry) => ({
      type: entry.type,
      observation: entry.observation,
      ...(entry.location === undefined ? {} : { location: entry.location }),
    })),
    proposedSeverity: candidate.proposedSeverity,
  };

  return verifyDeterministically(
    input,
    planVerificationContext({
      verificationInput: input,
      repository: {
        revisionId: REVISION,
        files: new Map(Object.entries(files)),
      },
    }),
  );
}

/** Runs one authored case through the whole funnel. */
export async function observeCase(
  entry: M1CapabilityCase,
): Promise<M1CaseObservation> {
  const analysis = await runRealAnalysis({
    repositoryId: REPOSITORY_ID,
    headSha: REVISION,
    tenantId: "m1-eval",
    source: {
      read: () =>
        Promise.resolve({
          changed: entry.changed.map((change) => ({
            path: change.path,
            content: entry.headFiles[change.path] ?? "",
            changedLines: change.changedLines,
          })),
          repository: new Map(Object.entries(entry.headFiles)),
        }),
    },
  });

  const candidates = analysis.report.findings;

  let verifiedExpected = false;
  let publishedExpected = false;
  let unexpectedPublished = 0;

  for (const candidate of candidates) {
    const attempt = adjudicate(candidate, entry.headFiles);
    if (attempt.status !== "completed" || attempt.decision !== "verified") {
      continue;
    }

    const promotion = promoteVerified([
      {
        candidateId: candidate.identityHint,
        fingerprint: candidate.identityHint,
        severity: attempt.severity,
        category: candidate.category,
        path: candidate.location.path,
        attempt,
      },
    ]);
    if (promotion.kind !== "promoted") continue;

    const plan = planPublication(
      [
        {
          findingId: candidate.identityHint,
          fingerprint: candidate.identityHint,
          severity: attempt.severity,
          category: candidate.category,
          path: candidate.location.path,
        },
      ],
      DEFAULT_PUBLICATION_CONFIG,
    );

    const wouldPublish = plan.publish.length > 0;
    if (matchesExpectation(candidate, entry)) {
      verifiedExpected = true;
      if (wouldPublish) publishedExpected = true;
    } else if (wouldPublish) {
      unexpectedPublished += 1;
    }
  }

  return {
    caseId: entry.id,
    capabilityFamily: entry.capabilityFamily,
    candidates: candidates.length,
    expectedCandidate: candidates.some((candidate) =>
      matchesExpectation(candidate, entry),
    ),
    verified: verifiedExpected,
    published: publishedExpected,
    unexpectedPublished,
  };
}

export interface M1SplitObservation {
  readonly outcome: M1SplitOutcome;
  readonly cases: readonly M1CaseObservation[];
}

async function observeSplit(
  cases: readonly M1CapabilityCase[],
): Promise<M1SplitObservation> {
  const observations: M1CaseObservation[] = [];
  for (const entry of cases) observations.push(await observeCase(entry));

  return {
    outcome: {
      planted: cases.length,
      publishedTruePositives: observations.filter((o) => o.published).length,
      publishedFalsePositives: observations.reduce(
        (total, o) => total + o.unexpectedPublished,
        0,
      ),
    },
    cases: observations,
  };
}

export const observeDevelopment = (): Promise<M1SplitObservation> =>
  observeSplit(M1_DEVELOPMENT_CASES);

/**
 * The sealed holdout. Checks the seal first, always.
 *
 * Every call is a first observation as far as this function is concerned; the
 * discipline that it is only *acted on* once lives in the checkpoint process,
 * not here, because a function cannot know whether its caller has already
 * looked.
 */
export const observeHoldout = (): Promise<M1SplitObservation> => {
  assertHoldoutSeal();
  return observeSplit(M1_HOLDOUT_CASES);
};
