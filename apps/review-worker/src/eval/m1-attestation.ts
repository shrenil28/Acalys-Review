/**
 * What each shipped capability attests, as a committed record.
 *
 * Conditions 8 and 9 ask whether a capability has a production-path witness and
 * semantic mutation kills, and whether its repository context is
 * demand-selected. Until now those arrived at the gate as numbers a human had
 * assembled by reading things, and Epoch 4 showed the cost: condition 8 PASSED
 * for a capability with **zero mutations targeting its source**, because the
 * attestation was relayed prose rather than a derivation.
 *
 * So the claims live here, and `m1-attestation.test.ts` checks them against the
 * real mutation manifest: every declared mutation id must exist, and must
 * target a file the capability actually owns. An attestation that names no
 * mutation, or names one pointing somewhere else, fails.
 *
 * This does not change the frozen gate. It changes where its inputs come from.
 */

export interface CapabilityAttestation {
  readonly capability: string;
  /** Rule id the analyzer emits, or `undefined` for verifier-only work. */
  readonly ruleId: string | undefined;
  /** Source files this capability owns, relative to the repository root. */
  readonly sourceFiles: readonly string[];
  /** A test that drives `runRealAnalysis`, not a library call. */
  readonly productionWitness: string;
  /**
   * Mutation ids that kill on this capability's own semantics.
   *
   * Must target a file in `sourceFiles`. Registration mutations live below
   * rather than here: they defend real guarantees, but they target shared
   * production wiring, and letting them count as semantic coverage is how a
   * capability with no mutations of its own can look defended.
   */
  readonly semanticMutationIds: readonly number[];
  /** Mutations that defend this capability's presence in the registry. */
  readonly registrationMutationIds: readonly number[];
  /** Fact families it asked for by name. Empty is legitimate. */
  readonly demandSelectedFactFamilies: readonly string[];
}

export const M1_CAPABILITY_ATTESTATIONS: readonly CapabilityAttestation[] = [
  {
    capability: "exact_optional_property_write",
    ruleId: "acalys.correctness/exact-optional-property-write",
    sourceFiles: [
      "packages/review-engine/src/correctness/exact-optional-write.ts",
      "packages/review-engine/src/verification/exact-optional.ts",
    ],
    productionWitness: "apps/review-worker/tests/m2-wiring.test.ts",
    semanticMutationIds: [
      203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215,
    ],
    registrationMutationIds: [],
    demandSelectedFactFamilies: ["config_governance"],
  },
  {
    capability: "required_parameter_added",
    ruleId: "acalys.correctness/required-parameter-added",
    sourceFiles: [
      "packages/review-engine/src/correctness/api-compatibility.ts",
      "packages/review-engine/src/verification/required-parameter.ts",
    ],
    productionWitness:
      "apps/review-worker/tests/m32-required-parameter.test.ts",
    semanticMutationIds: [244, 245, 246, 247, 248],
    registrationMutationIds: [],
    demandSelectedFactFamilies: ["base_revision"],
  },
  {
    capability: "discarded_replacement_return",
    ruleId: "acalys.correctness/discarded-replacement-return",
    sourceFiles: [
      "packages/review-engine/src/correctness/discarded-replacement.ts",
      "packages/review-engine/src/verification/discarded-replacement.ts",
    ],
    productionWitness:
      "apps/review-worker/tests/m4-discarded-replacement.test.ts",
    semanticMutationIds: [262, 263, 264, 265, 266, 267, 268, 269, 270, 271],
    registrationMutationIds: [],
    demandSelectedFactFamilies: ["base_revision"],
  },
  {
    capability: "public_export_reachability_loss",
    ruleId: "acalys.correctness/public-export-reachability-loss",
    sourceFiles: [
      "packages/review-engine/src/correctness/export-reachability.ts",
      "packages/review-engine/src/verification/export-reachability.ts",
    ],
    productionWitness:
      "apps/review-worker/tests/m34-export-reachability.test.ts",
    semanticMutationIds: [
      238, 239, 250, 254, 255, 256, 278, 279, 280, 281, 282, 283, 284,
    ],
    registrationMutationIds: [286, 287],
    demandSelectedFactFamilies: ["base_revision"],
  },
  {
    capability: "public_boundary_reachability_proposal",
    ruleId: "acalys.correctness/public-boundary-reachability-loss",
    sourceFiles: [
      "packages/review-engine/src/correctness/boundary-reachability.ts",
      "packages/review-engine/src/correctness/boundary-surface.ts",
    ],
    productionWitness:
      "apps/review-worker/tests/m35-boundary-reachability.test.ts",
    // Deliberately empty, and it fails condition 8 because it should.
    //
    // Epoch 4 found a hardcoded line-1 anchor in this capability — the same
    // defect M.3.3 was built to eliminate — and no mutation existed to catch
    // it. The M.3.6 band killed 10 of 10 while covering the verifier only.
    // Writing a number here that pointed at another capability's mutations is
    // exactly the relay this record replaces.
    semanticMutationIds: [],
    registrationMutationIds: [],
    demandSelectedFactFamilies: ["boundary_surface", "base_revision"],
  },
  {
    capability: "public_boundary_consumer_verification",
    ruleId: undefined,
    sourceFiles: [
      "packages/review-engine/src/verification/consumer-boundary.ts",
    ],
    productionWitness:
      "apps/review-worker/tests/m35-boundary-reachability.test.ts",
    semanticMutationIds: [288, 290, 291, 292, 293, 296, 297, 298],
    registrationMutationIds: [],
    demandSelectedFactFamilies: ["boundary_surface"],
  },
];
