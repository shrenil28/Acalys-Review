/**
 * Context the verifier assembles for itself.
 *
 * Independence here is not "a different model". It is a property about
 * derivation:
 *
 * > The verifier's context is derivable **without knowing what the analyzer
 * > selected.**
 *
 * That is deliberately not "the two selections differ". Two planners asked
 * about the same defect should often reach for the same file, and forcing them
 * apart would make the verifier reason about material it did not want. Overlap
 * is fine; *inheritance* is not, because inheriting the analyzer's selection
 * means inheriting its blind spots exactly where they matter — the file it
 * failed to fetch is the file that would have refuted the claim.
 *
 * # The signature is the guarantee
 *
 * {@link planVerificationContext} takes the claim, a repository snapshot and a
 * policy. There is no parameter for the analyzer's context, its snapshot id, or
 * its selected paths — so "the verifier reused the analyzer's context" is not a
 * mistake anyone can make quietly. It requires changing this signature, which
 * is a reviewable act.
 *
 * # What it selects, and why that order
 *
 * ```
 * 1  the claimed location            the claim is about this code
 * 2  every location cited in evidence  the claim's support must be checkable
 * 3  declarations the claimed code depends on
 * 4  tests covering the claimed file  intent, stated more reliably than prose
 * ```
 *
 * Step 2 is what makes verification more than a second opinion: a verifier that
 * cannot open the file an evidence item points at is agreeing on trust.
 */

import { createHash } from "node:crypto";

import { extractFile } from "@acalys/code-intelligence";

import type { VerificationContext } from "./decide.js";
import type { VerificationInput } from "./input.js";

export interface VerificationPolicy {
  readonly version: string;
  /** Ceiling for assembled verification context. */
  readonly maxTokens: number;
  /** Whether tests covering the claimed file are pulled in. */
  readonly includeTests: boolean;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  version: "1",
  maxTokens: 24_000,
  includeTests: true,
};

/**
 * The repository as the verifier may read it.
 *
 * A plain snapshot rather than the analyzer's assembled context. The distinction
 * is the whole point of this module: this is *the code*, not *what someone else
 * decided to show*.
 */
export interface RepositorySnapshot {
  readonly revisionId: string;
  readonly files: ReadonlyMap<string, string>;
}

function resolveSpecifier(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    else if (part === "..") base.pop();
    else base.push(part);
  }
  const joined = base.join("/").replace(/\.[cm]?js$/, "");
  for (const candidate of [
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}/index.ts`,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

function looksLikeTestFor(path: string, subject: string): boolean {
  const base = subject.replace(/\.[cm]?tsx?$/, "").replace(/^.*\//, "");
  const name = path.replace(/^.*\//, "");
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(path) &&
    (name.startsWith(`${base}.`) || name.startsWith(`${base}-`))
  );
}

/**
 * Plans verification context from the claim and the repository.
 *
 * Deterministic: the same claim, snapshot and policy always select the same
 * items in the same order. That is what lets independence be *tested* — the
 * property is that this output is unchanged no matter what the analyzer chose,
 * and a nondeterministic planner could not demonstrate it.
 */
export function planVerificationContext(request: {
  readonly verificationInput: VerificationInput;
  readonly repository: RepositorySnapshot;
  readonly policy?: VerificationPolicy | undefined;
}): VerificationContext {
  const policy = request.policy ?? DEFAULT_VERIFICATION_POLICY;
  const { verificationInput: claim, repository } = request;
  const known = new Set(repository.files.keys());

  const selected = new Map<string, { content: string; reason: string }>();
  let incomplete = false;

  const admit = (path: string, reason: string): void => {
    if (selected.has(path)) return;
    const content = repository.files.get(path);
    if (content === undefined) {
      // Recorded rather than ignored: a verifier missing the file an evidence
      // item points at is agreeing on trust, and the decision has to know.
      incomplete = true;
      return;
    }
    selected.set(path, { content, reason });
  };

  // 1. The claimed location.
  admit(claim.location.path, "claimed_location");

  // 2. Everywhere the evidence points.
  for (const item of claim.evidence) {
    if (item.location !== undefined)
      admit(item.location.path, "cited_by_evidence");
  }

  // 3. What the claimed file depends on.
  const subject = repository.files.get(claim.location.path);
  if (subject !== undefined) {
    for (const edge of extractFile(claim.location.path, subject).imports) {
      const target = resolveSpecifier(
        claim.location.path,
        edge.specifier,
        known,
      );
      if (target !== undefined) admit(target, "declaration_dependency");
    }
  }

  // 4. Tests covering it.
  if (policy.includeTests) {
    for (const path of known) {
      if (looksLikeTestFor(path, claim.location.path))
        admit(path, "covering_test");
    }
  }

  // Sorted, so the selection is a function of the claim rather than of map
  // iteration order.
  const ordered = [...selected.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1,
  );

  const items: { path: string; content: string; reason: string }[] = [];
  let tokens = 0;
  for (const [path, entry] of ordered) {
    const cost = Math.ceil(entry.content.length / 4);
    if (tokens + cost > policy.maxTokens) {
      incomplete = true;
      continue;
    }
    tokens += cost;
    items.push({ path, content: entry.content, reason: entry.reason });
  }

  return {
    items,
    // Over what was actually shown, not over what was intended.
    digest: digestOf(items, policy, repository.revisionId),
    incomplete,
  };
}

function digestOf(
  items: readonly { path: string; content: string; reason: string }[],
  policy: VerificationPolicy,
  revisionId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        revisionId,
        policy: policy.version,
        items: items.map((item) => ({
          path: item.path,
          reason: item.reason,
          content: createHash("sha256")
            .update(item.content, "utf8")
            .digest("hex"),
        })),
      }),
      "utf8",
    )
    .digest("hex");
}
