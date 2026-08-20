export const L5_FACT_FAMILIES = [
  "structural_index",
  "binding",
  "test_relationship",
  "config_governance",
  "instruction_governance",
] as const;

export type L5FactFamily = (typeof L5_FACT_FAMILIES)[number];

export type L5VerificationDecision =
  "verified" | "rejected" | "inconclusive" | "unavailable";

export interface GoldFinding {
  readonly goldId: string;
  readonly caseId: string;
  readonly matcher: {
    readonly ruleId: string;
    readonly family: string;
    readonly path: string;
    readonly allowedAnchorLines: {
      readonly startLine: number;
      readonly endLine: number;
    };
  };
}

/** The fields frozen by the contract as one candidate's semantic identity. */
export interface CandidateSemanticIdentity {
  readonly caseId: string;
  readonly ruleId: string;
  readonly family: string;
  readonly category: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly analyzerIdentityHint: string;
}

export interface QualityCandidate extends CandidateSemanticIdentity {
  readonly verificationDecision: L5VerificationDecision;
  readonly promoted: boolean;
  readonly published: boolean;
}

export interface MatchPair {
  readonly goldId: string;
  readonly candidateIdentity: CandidateSemanticIdentity;
}

export interface FindingMatchResult {
  readonly matches: readonly MatchPair[];
  readonly unmatchedGoldIds: readonly string[];
  /** A multiset: duplicate identities remain as separate false positives. */
  readonly unmatchedFalsePositiveIdentities: readonly CandidateSemanticIdentity[];
}

export type QualityRatio =
  | {
      readonly kind: "measuredRatio";
      readonly numerator: number;
      readonly denominator: number;
      readonly value: number;
    }
  | {
      readonly kind: "undefinedRatio";
      readonly numerator: number;
      readonly denominator: 0;
      readonly because: string;
    };

export interface QualityCounts {
  readonly cases: number;
  readonly plantedFindings: number;
  readonly candidates: number;
  readonly candidateTruePositives: number;
  readonly candidateFalsePositives: number;
  readonly candidateFalseNegatives: number;
  readonly candidatePrecision: QualityRatio;
  readonly verified: number;
  readonly rejected: number;
  readonly inconclusive: number;
  readonly unavailable: number;
  readonly promoted: number;
  readonly published: number;
  readonly withheld: number;
  readonly publishedTruePositives: number;
  readonly publishedFalsePositives: number;
  readonly publishedFalseNegatives: number;
  readonly publishedPrecision: QualityRatio;
  readonly publishedRecall: QualityRatio;
}

export interface QualityScore {
  readonly counts: QualityCounts;
  readonly candidateMatching: FindingMatchResult;
  readonly publishedMatching: FindingMatchResult;
}

export interface ScoreQualityInput {
  /** Includes clean cases, which cannot be inferred from findings alone. */
  readonly caseIds: readonly string[];
  readonly goldFindings: readonly GoldFinding[];
  readonly candidates: readonly QualityCandidate[];
}

interface IndexedCandidate {
  readonly candidate: QualityCandidate;
  readonly ordinal: number;
  readonly identityKey: string;
}

interface InternalMatchPair extends MatchPair {
  readonly candidateOrdinal: number;
}

interface InternalMatchResult extends FindingMatchResult {
  readonly matches: readonly InternalMatchPair[];
}

function assertLineRange(
  range: { readonly startLine: number; readonly endLine: number },
  label: string,
): void {
  if (
    !Number.isInteger(range.startLine) ||
    !Number.isInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < range.startLine
  ) {
    throw new Error(`${label} must be a positive inclusive line range`);
  }
}

function ratio(
  numerator: number,
  denominator: number,
  because: string,
): QualityRatio {
  return denominator === 0
    ? { kind: "undefinedRatio", numerator, denominator: 0, because }
    : {
        kind: "measuredRatio",
        numerator,
        denominator,
        value: numerator / denominator,
      };
}

export function candidateSemanticIdentity(
  candidate: CandidateSemanticIdentity,
): CandidateSemanticIdentity {
  return {
    caseId: candidate.caseId,
    ruleId: candidate.ruleId,
    family: candidate.family,
    category: candidate.category,
    path: candidate.path,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    analyzerIdentityHint: candidate.analyzerIdentityHint,
  };
}

export function candidateSemanticIdentityKey(
  identity: CandidateSemanticIdentity,
): string {
  return JSON.stringify([
    identity.caseId,
    identity.ruleId,
    identity.family,
    identity.category,
    identity.path,
    identity.startLine,
    identity.endLine,
    identity.analyzerIdentityHint,
  ]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isEligible(gold: GoldFinding, candidate: QualityCandidate): boolean {
  const allowed = gold.matcher.allowedAnchorLines;
  return (
    gold.caseId === candidate.caseId &&
    gold.matcher.ruleId === candidate.ruleId &&
    gold.matcher.family === candidate.family &&
    gold.matcher.path === candidate.path &&
    candidate.startLine >= allowed.startLine &&
    candidate.endLine <= allowed.endLine
  );
}

function maximumCardinality(
  gold: readonly GoldFinding[],
  candidates: readonly IndexedCandidate[],
  excludedCandidateOrdinals: ReadonlySet<number>,
): number {
  const goldByCandidate = new Map<number, number>();

  const augment = (goldIndex: number, seen: Set<number>): boolean => {
    const finding = gold[goldIndex];
    if (finding === undefined) return false;

    for (const indexed of candidates) {
      if (
        excludedCandidateOrdinals.has(indexed.ordinal) ||
        seen.has(indexed.ordinal) ||
        !isEligible(finding, indexed.candidate)
      ) {
        continue;
      }

      seen.add(indexed.ordinal);
      const previousGold = goldByCandidate.get(indexed.ordinal);
      if (previousGold === undefined || augment(previousGold, seen)) {
        goldByCandidate.set(indexed.ordinal, goldIndex);
        return true;
      }
    }
    return false;
  };

  let size = 0;
  for (let goldIndex = 0; goldIndex < gold.length; goldIndex += 1) {
    if (augment(goldIndex, new Set())) size += 1;
  }
  return size;
}

function matchInternally(
  goldFindings: readonly GoldFinding[],
  candidates: readonly QualityCandidate[],
): InternalMatchResult {
  const sortedGold = [...goldFindings].sort((left, right) =>
    compareText(left.goldId, right.goldId),
  );
  const goldIds = new Set<string>();
  for (const gold of sortedGold) {
    if (goldIds.has(gold.goldId)) {
      throw new Error(`duplicate goldId: ${gold.goldId}`);
    }
    goldIds.add(gold.goldId);
    assertLineRange(
      gold.matcher.allowedAnchorLines,
      `gold matcher ${gold.goldId}`,
    );
  }

  const indexedCandidates = candidates
    .map((candidate, ordinal): IndexedCandidate => {
      assertLineRange(candidate, `candidate ${String(ordinal)}`);
      return {
        candidate,
        ordinal,
        identityKey: candidateSemanticIdentityKey(candidate),
      };
    })
    .sort(
      (left, right) =>
        compareText(left.identityKey, right.identityKey) ||
        left.ordinal - right.ordinal,
    );

  const maximum = maximumCardinality(sortedGold, indexedCandidates, new Set());
  const used = new Set<number>();
  const matches: InternalMatchPair[] = [];

  for (let goldIndex = 0; goldIndex < sortedGold.length; goldIndex += 1) {
    const gold = sortedGold[goldIndex];
    if (gold === undefined) continue;
    const matchesStillNeeded = maximum - matches.length;
    if (matchesStillNeeded === 0) break;

    for (const indexed of indexedCandidates) {
      if (used.has(indexed.ordinal) || !isEligible(gold, indexed.candidate)) {
        continue;
      }

      const tentativelyUsed = new Set(used);
      tentativelyUsed.add(indexed.ordinal);
      const remainingGold = sortedGold.slice(goldIndex + 1);
      const remainingMaximum = maximumCardinality(
        remainingGold,
        indexedCandidates,
        tentativelyUsed,
      );
      if (1 + remainingMaximum < matchesStillNeeded) continue;

      used.add(indexed.ordinal);
      matches.push({
        goldId: gold.goldId,
        candidateIdentity: candidateSemanticIdentity(indexed.candidate),
        candidateOrdinal: indexed.ordinal,
      });
      break;
    }
  }

  const matchedGoldIds = new Set(matches.map((match) => match.goldId));
  return {
    matches,
    unmatchedGoldIds: sortedGold
      .filter((gold) => !matchedGoldIds.has(gold.goldId))
      .map((gold) => gold.goldId),
    unmatchedFalsePositiveIdentities: indexedCandidates
      .filter((indexed) => !used.has(indexed.ordinal))
      .map((indexed) => candidateSemanticIdentity(indexed.candidate)),
  };
}

export function matchFindings(
  goldFindings: readonly GoldFinding[],
  candidates: readonly QualityCandidate[],
): FindingMatchResult {
  const result = matchInternally(goldFindings, candidates);
  return {
    matches: result.matches.map(({ goldId, candidateIdentity }) => ({
      goldId,
      candidateIdentity,
    })),
    unmatchedGoldIds: result.unmatchedGoldIds,
    unmatchedFalsePositiveIdentities: result.unmatchedFalsePositiveIdentities,
  };
}

export function scoreQuality(input: ScoreQualityInput): QualityScore {
  const caseIds = new Set(input.caseIds);
  if (caseIds.size !== input.caseIds.length) {
    throw new Error("caseIds must be unique");
  }
  for (const gold of input.goldFindings) {
    if (!caseIds.has(gold.caseId)) {
      throw new Error(`gold finding ${gold.goldId} has an undeclared caseId`);
    }
  }
  for (const candidate of input.candidates) {
    if (!caseIds.has(candidate.caseId)) {
      throw new Error(
        `candidate ${candidateSemanticIdentityKey(candidate)} has an undeclared caseId`,
      );
    }
  }

  const candidateMatching = matchFindings(input.goldFindings, input.candidates);
  const publishedCandidates = input.candidates.filter(
    (candidate) => candidate.published,
  );
  const publishedMatching = matchFindings(
    input.goldFindings,
    publishedCandidates,
  );
  const countDecision = (decision: L5VerificationDecision): number =>
    input.candidates.filter(
      (candidate) => candidate.verificationDecision === decision,
    ).length;

  const candidateTruePositives = candidateMatching.matches.length;
  const candidateFalsePositives =
    candidateMatching.unmatchedFalsePositiveIdentities.length;
  const publishedTruePositives = publishedMatching.matches.length;
  const publishedFalsePositives =
    publishedMatching.unmatchedFalsePositiveIdentities.length;

  return {
    counts: {
      cases: caseIds.size,
      plantedFindings: input.goldFindings.length,
      candidates: input.candidates.length,
      candidateTruePositives,
      candidateFalsePositives,
      candidateFalseNegatives: candidateMatching.unmatchedGoldIds.length,
      candidatePrecision: ratio(
        candidateTruePositives,
        input.candidates.length,
        "no candidates",
      ),
      verified: countDecision("verified"),
      rejected: countDecision("rejected"),
      inconclusive: countDecision("inconclusive"),
      unavailable: countDecision("unavailable"),
      promoted: input.candidates.filter((candidate) => candidate.promoted)
        .length,
      published: publishedCandidates.length,
      withheld: input.candidates.filter(
        (candidate) => candidate.promoted && !candidate.published,
      ).length,
      publishedTruePositives,
      publishedFalsePositives,
      publishedFalseNegatives: publishedMatching.unmatchedGoldIds.length,
      publishedPrecision: ratio(
        publishedTruePositives,
        publishedCandidates.length,
        "no published findings",
      ),
      publishedRecall: ratio(
        publishedTruePositives,
        input.goldFindings.length,
        "no planted findings",
      ),
    },
    candidateMatching,
    publishedMatching,
  };
}

function subtractIdentityMultiset(
  minuend: readonly CandidateSemanticIdentity[],
  subtrahend: readonly CandidateSemanticIdentity[],
): readonly CandidateSemanticIdentity[] {
  const available = new Map<string, number>();
  for (const identity of subtrahend) {
    const key = candidateSemanticIdentityKey(identity);
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  return [...minuend]
    .sort((left, right) =>
      compareText(
        candidateSemanticIdentityKey(left),
        candidateSemanticIdentityKey(right),
      ),
    )
    .filter((identity) => {
      const key = candidateSemanticIdentityKey(identity);
      const remaining = available.get(key) ?? 0;
      if (remaining === 0) return true;
      available.set(key, remaining - 1);
      return false;
    });
}

export interface PairedQualityEffects {
  readonly truePositivesRecovered: readonly string[];
  readonly falsePositivesIntroduced: readonly CandidateSemanticIdentity[];
}

export function comparePublishedQuality(
  control: QualityScore,
  treatment: QualityScore,
): PairedQualityEffects {
  const controlGold = new Set(
    control.publishedMatching.matches.map((match) => match.goldId),
  );
  return {
    truePositivesRecovered: treatment.publishedMatching.matches
      .map((match) => match.goldId)
      .filter((goldId) => !controlGold.has(goldId))
      .sort(compareText),
    falsePositivesIntroduced: subtractIdentityMultiset(
      treatment.publishedMatching.unmatchedFalsePositiveIdentities,
      control.publishedMatching.unmatchedFalsePositiveIdentities,
    ),
  };
}

export type CausalOutcomeIdentity =
  | { readonly kind: "gold"; readonly goldId: string }
  | {
      readonly kind: "falsePositive";
      readonly candidateIdentity: CandidateSemanticIdentity;
    };

export interface CausalOutcomeState {
  readonly candidatePresent: boolean;
  readonly verificationDecision: L5VerificationDecision | undefined;
  readonly promoted: boolean;
  readonly published: boolean;
}

export interface CausalOutcomeObservation {
  readonly identity: CausalOutcomeIdentity;
  readonly state: CausalOutcomeState;
  readonly exposedFamilies: readonly L5FactFamily[];
}

export interface CausalRun {
  readonly outcomes: readonly CausalOutcomeObservation[];
}

export type OutcomeAttribution = "none" | L5FactFamily | "multiple";

export interface CausalAttribution {
  readonly identity: CausalOutcomeIdentity;
  readonly treatmentEffect: boolean;
  readonly exposedFamilies: readonly L5FactFamily[];
  readonly matteredFamilies: readonly L5FactFamily[];
  readonly attribution: OutcomeAttribution;
}

function causalIdentityKey(identity: CausalOutcomeIdentity): string {
  return identity.kind === "gold"
    ? JSON.stringify(["gold", identity.goldId])
    : JSON.stringify([
        "falsePositive",
        candidateSemanticIdentityKey(identity.candidateIdentity),
      ]);
}

function stateKey(state: CausalOutcomeState): string {
  return JSON.stringify([
    state.candidatePresent,
    state.verificationDecision ?? null,
    state.promoted,
    state.published,
  ]);
}

function statesByIdentity(
  run: CausalRun,
): ReadonlyMap<string, readonly string[]> {
  const states = new Map<string, string[]>();
  for (const outcome of run.outcomes) {
    const key = causalIdentityKey(outcome.identity);
    const existing = states.get(key) ?? [];
    existing.push(stateKey(outcome.state));
    states.set(key, existing);
  }
  for (const values of states.values()) values.sort(compareText);
  return states;
}

function sameStates(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const leftStates = left ?? [];
  const rightStates = right ?? [];
  return (
    leftStates.length === rightStates.length &&
    leftStates.every((value, index) => value === rightStates[index])
  );
}

export interface AttributeCausalOutcomesInput {
  readonly control: CausalRun;
  readonly treatment: CausalRun;
  /** A complete record makes omission of structural_index impossible. */
  readonly ablations: Readonly<Record<L5FactFamily, CausalRun>>;
}

export function attributeCausalOutcomes(
  input: AttributeCausalOutcomesInput,
): readonly CausalAttribution[] {
  const controlStates = statesByIdentity(input.control);
  const treatmentStates = statesByIdentity(input.treatment);
  const ablationStates = Object.fromEntries(
    L5_FACT_FAMILIES.map((family) => [
      family,
      statesByIdentity(input.ablations[family]),
    ]),
  ) as Record<L5FactFamily, ReadonlyMap<string, readonly string[]>>;

  const identities = new Map<string, CausalOutcomeIdentity>();
  for (const run of [input.control, input.treatment]) {
    for (const outcome of run.outcomes) {
      identities.set(causalIdentityKey(outcome.identity), outcome.identity);
    }
  }

  return [...identities.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, identity]) => {
      const treatmentEffect = !sameStates(
        treatmentStates.get(key),
        controlStates.get(key),
      );
      const matteredFamilies = L5_FACT_FAMILIES.filter(
        (family) =>
          !sameStates(
            treatmentStates.get(key),
            ablationStates[family].get(key),
          ),
      );
      const exposedFamilies = L5_FACT_FAMILIES.filter((family) =>
        input.treatment.outcomes.some(
          (outcome) =>
            causalIdentityKey(outcome.identity) === key &&
            outcome.exposedFamilies.includes(family),
        ),
      );

      let attribution: OutcomeAttribution = "none";
      if (treatmentEffect) {
        attribution =
          matteredFamilies.length === 1
            ? (matteredFamilies[0] ?? "multiple")
            : "multiple";
      }

      return {
        identity,
        treatmentEffect,
        exposedFamilies,
        matteredFamilies,
        attribution,
      };
    });
}
