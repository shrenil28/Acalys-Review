/**
 * The factual model for configuration governance — states first, parser later.
 *
 * Nothing here reads a file. This module exists so that six distinct states
 * cannot be confused before any code is written that could confuse them:
 *
 * ```
 * source governed by project      a project's own rules admit this file
 * project inherits config         a project takes options from another file
 * project references project      a project depends on another project
 * source not in any known project no project admits it, and we looked
 * project/config unavailable      we could not read or parse the config
 * membership vs coverage          two dimensions, not one ranked list
 * ```
 *
 * The fourth and fifth are the pair this file is really for. "No project claims this
 * file" and "we could not tell which project claims this file" are different
 * facts, and only the first supports a conclusion. Collapsing them is the same
 * mistake as `absent` versus `not_indexed` in L.1 and `no_test_references`
 * versus `not_indexed` in L.4.1, arriving a third time in a new domain.
 *
 * # `governed_by` is a positive relationship only
 *
 * An earlier sketch of this had a `reason` vocabulary spanning both
 * directions:
 *
 * ```
 * included_by_files      included_by_include
 * inherited_via_extends  project_reference
 * excluded_by_pattern    not_in_project        <- these two do not belong
 * ```
 *
 * Writing `file --governed_by(excluded_by_pattern)--> tsconfig` records a
 * governance edge for a file that is specifically *not* governed, and any
 * consumer counting edges would then count it as governed. Exclusion is
 * evidence explaining why no relationship exists, so it lives in the result
 * rather than in the edge.
 *
 * # Three edges, not one
 *
 * A single "config-related" edge would be exactly the generic association this
 * checkpoint exists to avoid — the config equivalent of matching test files by
 * name. They are kept apart because they answer different questions:
 *
 * ```
 * SourceGovernance   which project's rules admit this source file?
 * OptionInheritance  where do this project's options come from?
 * ProjectReference   which projects does this project depend on?
 * ```
 *
 * `pkg/tsconfig.json extends ../../tsconfig.base.json` does not mean a source
 * file is governed by `tsconfig.base.json`. The file is governed by
 * `pkg/tsconfig.json`, which inherits options from the base. Recording the
 * first would make every file in a monorepo governed by the root base config,
 * and "show the reviewer the governing config" would show the wrong one.
 *
 * Likewise a project reference is a project-to-project dependency. It does not
 * make every source file in A governed by B's tsconfig.
 *
 * # Governance can be plural, and that is a fact rather than a defect
 *
 * If a root config's `include` covers `pkg/src/**` and `pkg/tsconfig.json`
 * covers the same files, then both projects genuinely admit them. The model
 * records every governing project rather than picking one, because "nearest
 * tsconfig wins" is how editors feel, not how project membership is defined.
 * A caller that needs one must say which rule it is applying.
 */

import type { FactProvenance } from "./records.js";

/**
 * Why a project's rules admit a source file.
 *
 * Only positive membership. Every member is something TypeScript's own project
 * parsing can establish, so none of them is an inference this code invented.
 */
export const GOVERNANCE_REASONS = [
  /**
   * Named explicitly in the project's `files` array.
   *
   * Establishable without reimplementing anything: `files` is a literal list,
   * so membership is a string comparison against the resolved paths.
   */
  "included_by_files",
  /**
   * Admitted by the project, and not named in `files`.
   *
   * Defined by what it is *not*, because that is what can be proven. The
   * compiler reports the admitted set; subtracting the literal `files` list
   * leaves the ones some pattern admitted. Which pattern is not recoverable
   * and is not claimed.
   */
  "included_by_include",
] as const;

export type GovernanceReason = (typeof GOVERNANCE_REASONS)[number];

/** A project's rules admit this source file. */
export interface SourceGovernance {
  readonly sourcePath: string;
  readonly projectPath: string;
  readonly reason: GovernanceReason;
  readonly provenance: FactProvenance;
}

/**
 * A project takes options from another config file.
 *
 * Separate from governance on purpose — see the commentary above. This is a
 * fact about the *project*, not about any source file, and flattening it into
 * governance would make every file governed by the whole extends chain.
 */
export interface OptionInheritance {
  readonly projectPath: string;
  readonly inheritsFrom: string;
  /**
   * Whether this is the project's own `extends`, or something further up.
   *
   * `pkg -> base-a -> base-b` is recorded as two direct edges, not as
   * `pkg -> base-b` flattened. A planner deciding what to show a reviewer may
   * want the project alone, the project plus its direct base, or the whole
   * chain — and a flattened edge makes the first two unavailable while
   * looking like more information.
   */
  readonly directness: "direct" | "transitive";
  /** 1 for the project's own `extends`, increasing up the chain. */
  readonly depth: number;
  readonly provenance: FactProvenance;
}

/** A project declares a dependency on another project. */
export interface ProjectReference {
  readonly projectPath: string;
  readonly referencesProject: string;
  readonly provenance: FactProvenance;
}

/**
 * Why a source file has no governing project.
 *
 * One member, deliberately. An earlier draft also had `excluded_by_pattern`,
 * and it is not establishable: TypeScript's project parsing returns the set of
 * files a project admits, not why each other file is absent. A file missing
 * from that set may have been excluded, may have matched no `include`, or may
 * sit outside a closed `files` list — and reconstructing which would mean
 * reimplementing the glob semantics whose correctness is the entire reason for
 * using the compiler as the authority.
 *
 * A narrower true answer beats a detailed invented one.
 */
export const NON_GOVERNANCE_REASONS = ["no_project_admits_it"] as const;

export type NonGovernanceReason = (typeof NON_GOVERNANCE_REASONS)[number];

export interface NonGovernanceEvidence {
  readonly reason: NonGovernanceReason;
  readonly detail: string;
}

/**
 * Why governance could not be determined at all.
 *
 * The state that must never be reported as `not_governed`. A config that
 * failed to parse tells us nothing about which files it admits, and answering
 * "this file is governed by nothing" from that is inferring a repository fact
 * from our own failure to read.
 */
export const GOVERNANCE_FAILURES = [
  "config_unparsable",
  "config_semantically_invalid",
  "config_absent",
  "extends_unresolvable",
] as const;

export type GovernanceFailure = (typeof GOVERNANCE_FAILURES)[number];

export interface GovernanceUnavailable {
  readonly failure: GovernanceFailure;
  readonly configPath: string;
  readonly detail: string;
}

/**
 * How much of the project set was actually evaluable.
 *
 * Reported alongside every governance answer rather than instead of one,
 * because membership and coverage are independent dimensions:
 *
 * ```
 *                    coverage complete      coverage incomplete
 * some governance    governed               governed, incomplete
 * no governance      not_governed           undetermined
 * ```
 *
 * The top-right cell is the one an earlier draft of this file could not
 * express. It made `governed` and `unavailable` mutually exclusive, so a
 * malformed config anywhere in a monorepo would erase a governance fact
 * already established by a project that parsed perfectly well.
 *
 * That is the same principle L.4.1 encodes for test evidence, and getting it
 * wrong here would have been the third time in this checkpoint:
 *
 * > an outage may prevent a NEGATIVE conclusion; it must never erase an
 * > independently established POSITIVE fact.
 */
export interface ConfigCoverage {
  /** Projects whose configuration was read and parsed. */
  readonly evaluated: readonly string[];
  /** Projects that could not be, and why. */
  readonly unevaluable: readonly GovernanceUnavailable[];
}

/** Whether every discovered project was evaluable. */
export function isCoverageComplete(coverage: ConfigCoverage): boolean {
  return coverage.unevaluable.length === 0;
}

/**
 * The answer to "which project governs this source file?".
 *
 * Four outcomes, and the type is what keeps three of them from being read as
 * the fourth.
 *
 * `not_governed` is the only one that asserts a repository fact about absence,
 * and it is reachable only with complete coverage — a caller saying "no
 * configuration applies here" must have established that every discovered
 * project was actually read. `undetermined` is what an incomplete evaluation
 * produces instead, and it is not a claim.
 *
 * # A boundary worth stating where it will be read
 *
 * Governance is complete relative to the set of **discovered** projects, not
 * to every tsconfig-shaped file that might exist. Project discovery is a
 * separate problem from project membership: TypeScript answers "which files
 * does this project admit", and answers nothing at all about which projects
 * exist. If discovery is incomplete, `no_project_admits_it` overclaims — so
 * the discovered set travels in {@link ConfigCoverage.evaluated} where a
 * reader can see what the answer was relative to.
 */
export type ConfigGovernanceResult =
  | {
      readonly status: "governed";
      /** Every project whose rules admit it. Plural is a fact, not a bug. */
      readonly relationships: readonly SourceGovernance[];
      /** May be incomplete: positive facts survive a partial outage. */
      readonly coverage: ConfigCoverage;
    }
  | {
      readonly status: "not_governed";
      readonly evidence: readonly NonGovernanceEvidence[];
      /** Complete by construction — see the commentary above. */
      readonly coverage: ConfigCoverage;
    }
  | {
      readonly status: "undetermined";
      /** Incomplete by construction. */
      readonly coverage: ConfigCoverage;
      readonly why: string;
    }
  | {
      readonly status: "not_indexed";
      readonly sourcePath: string;
      readonly why: string;
    };

/**
 * Everything the extractor produces about configuration, for one revision.
 *
 * Held separately from {@link RepositoryIndex} rather than inside it, for a
 * reason that will matter in L.5: **a config change alters analyzer input
 * without altering a single code binding.** The code-symbol digest must not
 * move when only a config moves, and the analyzer-input identity must. Fusing
 * them would force one of those two to be wrong.
 */
export interface ConfigFacts {
  readonly projects: readonly string[];
  readonly governance: readonly SourceGovernance[];
  readonly inheritance: readonly OptionInheritance[];
  readonly references: readonly ProjectReference[];
  readonly failures: readonly GovernanceUnavailable[];
}

/** An empty, successfully-computed set of config facts. */
export const NO_CONFIG_FACTS: ConfigFacts = {
  projects: [],
  governance: [],
  inheritance: [],
  references: [],
  failures: [],
};
