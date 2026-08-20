import { describe, expect, it } from "vitest";

import { FINDING_LIFECYCLE_STATES } from "@acalys/contracts/domain";
import type { FindingDto } from "@acalys/contracts/api/v1";

import { displaySeverity, present, toFindingViews } from "../src/lib/findings.js";
import { dto } from "./fixtures/findings.js";


/**
 * The backend spent months keeping these meanings apart. This is where they
 * become something a developer reads, and therefore where they can be
 * flattened.
 */
describe("Backend meanings survive the trip to the screen", () => {
  it("shows a verified-but-unpublished finding as 'In review' on the internal review surface", () => {
    // A finding can be true and deliberately withheld from the PR/developer
    // publication surface: the publication policy exists so that a real defect
    // need not interrupt anyone. But it remains visible on the internal review
    // surface as "In review", not absent.
    expect(present("verified")).toEqual({
      visibility: "visible",
      status: "In review",
    });
    expect(present("published")).toEqual({
      visibility: "visible",
      status: "Open",
    });
  });

  it("hides a superseded finding, and says why", () => {
    // Already replaced. Showing it produces two rows for one defect — the
    // duplicate-comment failure the reconciliation work exists to prevent,
    // reappearing in the UI. The reason is retained rather than collapsed to
    // an absence.
    expect(present("superseded")).toEqual({
      visibility: "hidden",
      reason: "superseded",
    });

    const views = toFindingViews([
      dto({ id: "a", lifecycle: "published" }),
      dto({ id: "b", lifecycle: "superseded" }),
    ]);
    expect(views.map((view) => view.id)).toEqual(["a"]);
  });

  it("keeps dismissed and resolved apart", () => {
    // "a human decided it does not matter" and "the defect is gone" are
    // different facts about the code, and collapsing them loses the one that
    // says whether anything was fixed.
    expect(present("dismissed")).toEqual({
      visibility: "visible",
      status: "Ignored",
    });
    expect(present("resolved")).toEqual({
      visibility: "visible",
      status: "Fixed",
    });
  });

  it("does not report a stale finding as fixed", () => {
    // The code beneath it moved and it is no longer confirmed. Nobody
    // established that it was fixed, and saying so would be a claim the system
    // cannot support.
    expect(present("stale")).toEqual({
      visibility: "visible",
      status: "In review",
    });
  });

  it("decides every state the contract declares, exactly once", () => {
    // ── Driven from the CONTRACT's list, not a copy ───────────────────────
    //
    // A state added to the backend fails here — at a test naming the omission
    // — rather than arriving in a component that has no case for it.
    const decided = FINDING_LIFECYCLE_STATES.map((state) => [
      state,
      present(state),
    ] as const);

    expect(decided).toHaveLength(6);

    const hidden = decided
      .filter(([, presentation]) => presentation.visibility === "hidden")
      .map(([state]) => state);

    // Exactly one is deliberately invisible. A second becoming hidden is a
    // product decision worth making on purpose.
    expect(hidden).toEqual(["superseded"]);
  });

  it("refuses a lifecycle state the contract does not contain", () => {
    expect(() => present("invented" as FindingDto["lifecycle"])).toThrow(
      /Unhandled finding value/,
    );
  });

  it("maps every severity, and refuses one it does not know", () => {
    expect(displaySeverity("critical")).toBe("Critical");
    expect(displaySeverity("info")).toBe("Info");
    expect(() =>
      displaySeverity("catastrophic" as FindingDto["severity"]),
    ).toThrow(/Unhandled finding value/);
  });

  it("carries the backend's identity through to the row", () => {
    // The engine works hard to keep a finding's identity stable across line
    // movement, so the same defect reconciles to the same row on the next
    // push. Keying a list on an array index would discard that at the last
    // step.
    const [view] = toFindingViews([dto({ id: "stable-id" })]);
    expect(view?.id).toBe("stable-id");
  });
});
