/**
 * P1-M.3.0 — base revision as a planner input.
 *
 * The property under test throughout is that the four base states stay four.
 * Most of these assertions look like they are about plumbing; they are about
 * the one inference a comparison capability must never make, which is reading
 * its own inability to look as evidence that nothing changed.
 */

import { describe, expect, it } from "vitest";

import {
  generateCandidates,
  type PlannerBaseRevision,
  extractFile,
  type PlannerFactFamilyAvailability,
} from "../src/index.js";

const HEAD = "export function format(id: string, region: string): string {}";
const BASE = "export function format(id: string): string {}";

const ALL_FAMILIES: PlannerFactFamilyAvailability = {
  structural_index: true,
  binding: true,
  test_relationship: true,
  config_governance: true,
  instruction_governance: true,
  base_revision: true,
};

function plan(options: {
  readonly baseRevisions?: readonly PlannerBaseRevision[];
  readonly baseSha?: string;
  readonly families?: PlannerFactFamilyAvailability;
  readonly changedPaths?: readonly string[];
}) {
  const paths = options.changedPaths ?? ["src/format.ts"];
  const sources = new Map(paths.map((path) => [path, HEAD]));

  return generateCandidates({
    changed: paths.map((path) => ({
      path,
      content: HEAD,
      changedLines: [1],
    })),
    repository: [...sources].map(([path, text]) => extractFile(path, text)),
    sources,
    factFamilyAvailability: options.families ?? ALL_FAMILIES,
    ...(options.baseRevisions === undefined
      ? {}
      : { baseRevisions: options.baseRevisions }),
    ...(options.baseSha === undefined ? {} : { baseSha: options.baseSha }),
    baseFactsIdentity: "base-facts-1",
  });
}

const bases = (candidates: ReturnType<typeof plan>) =>
  candidates.filter((candidate) => candidate.kind === "base_revision");

describe("a base that was read", () => {
  it("is offered with its content and a citation naming the base commit", () => {
    const [item] = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [
          {
            path: "src/format.ts",
            resolution: { kind: "present", content: BASE },
          },
        ],
      }),
    );

    expect(item?.content).toBe(BASE);
    expect(item?.reason).toBe("base_revision");
    expect(item?.provenance).toMatchObject({
      source: "base_revision_facts",
      baseSha: "abc123",
      resolution: "present",
      citation: "src/format.ts at base abc123",
    });
  });

  it("is repository source, never something that can instruct the reviewer", () => {
    // A base revision is text the reviewer compares against. If it were
    // carried at instruction trust, a comment in the OLD version of a file
    // would be able to direct the review of the new one.
    const [item] = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [
          {
            path: "src/format.ts",
            resolution: { kind: "present", content: BASE },
          },
        ],
      }),
    );

    expect(item?.trust).toBe("repository_source");
  });
});

describe("the three non-present states each stay distinguishable", () => {
  it.each([
    ["absent" as const, { kind: "absent" as const }],
    ["not_indexed" as const, { kind: "not_indexed" as const }],
  ])("offers %s as an item carrying that state", (expected, resolution) => {
    const [item] = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [{ path: "src/format.ts", resolution }],
      }),
    );

    // The item EXISTS. That is the whole point: emitting nothing would make
    // this indistinguishable from a disabled family and from a budget
    // omission, and those demand the opposite behaviour from this one.
    expect(item).toBeDefined();
    expect(item?.content).toBe("");
    expect(item?.provenance).toMatchObject({ resolution: expected });
  });

  it("carries the reason an unavailable base could not be read", () => {
    const [item] = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [
          {
            path: "src/format.ts",
            resolution: {
              kind: "unavailable",
              because: "object store timeout",
            },
          },
        ],
      }),
    );

    expect(item?.provenance).toMatchObject({
      resolution: "unavailable",
      because: "object store timeout",
    });
  });

  it("does not put a `because` on states that are not failures", () => {
    // `absent` is a positive determination, not a failure with an excuse.
    const [item] = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [
          { path: "src/format.ts", resolution: { kind: "absent" } },
        ],
      }),
    );

    expect(item?.provenance).not.toHaveProperty("because");
  });
});

describe("what is not offered", () => {
  it("offers nothing at all when the fact family is off", () => {
    expect(
      bases(
        plan({
          baseSha: "abc123",
          families: { ...ALL_FAMILIES, base_revision: false },
          baseRevisions: [
            {
              path: "src/format.ts",
              resolution: { kind: "present", content: BASE },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("drops a base for a path that is not under review", () => {
    // The base of a file nobody changed is not evidence about this change.
    // Admitting it would let whole untouched files into the budget at a
    // weight just under the changed hunk.
    expect(
      bases(
        plan({
          baseSha: "abc123",
          changedPaths: ["src/format.ts"],
          baseRevisions: [
            {
              path: "src/unrelated.ts",
              resolution: { kind: "present", content: BASE },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("keeps the first of two resolutions for one path, deterministically", () => {
    const items = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [
          {
            path: "src/format.ts",
            resolution: { kind: "present", content: BASE },
          },
          { path: "src/format.ts", resolution: { kind: "absent" } },
        ],
      }),
    );

    // Two resolutions for one path is a caller defect. Picking the "better"
    // one would hide it; picking the first exposes it consistently.
    expect(items).toHaveLength(1);
    expect(items[0]?.provenance).toMatchObject({ resolution: "present" });
  });
});

describe("renames", () => {
  it("cites the path the base content actually came from", () => {
    const [item] = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [
          {
            path: "src/format.ts",
            basePath: "src/fmt.ts",
            resolution: { kind: "present", content: BASE },
          },
        ],
      }),
    );

    expect(item?.provenance).toMatchObject({ basePath: "src/fmt.ts" });
    expect(
      (item?.provenance as { citation: string } | undefined)?.citation,
    ).toBe("src/format.ts at base abc123 (renamed from src/fmt.ts)");
  });

  it("does not claim a rename when the path did not change", () => {
    const [item] = bases(
      plan({
        baseSha: "abc123",
        baseRevisions: [
          {
            path: "src/format.ts",
            basePath: "src/format.ts",
            resolution: { kind: "present", content: BASE },
          },
        ],
      }),
    );

    expect(
      (item?.provenance as { citation: string } | undefined)?.citation,
    ).toBe("src/format.ts at base abc123");
  });
});

describe("ordering", () => {
  it("offers base revisions in a deterministic path order", () => {
    const items = bases(
      plan({
        baseSha: "abc123",
        changedPaths: ["src/b.ts", "src/a.ts"],
        baseRevisions: [
          { path: "src/b.ts", resolution: { kind: "absent" } },
          { path: "src/a.ts", resolution: { kind: "absent" } },
        ],
      }),
    );

    expect(items.map((item) => item.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
