/**
 * Where the backend's meanings become something a developer reads.
 *
 * The engine distinguishes six lifecycle states; the security pages render
 * four. That is a lossy transformation in the direction this project has spent
 * months preventing, so it happens **here**, once, exhaustively — not as a
 * conditional inside a component where the next state added quietly picks a
 * side.
 *
 * # Visibility is not a status
 *
 * An earlier version returned `null` for `superseded`, which threw away the
 * reason along with the row. Whether a finding belongs on a surface and how it
 * should read are two different questions:
 *
 * ```
 * visibility   a decision about THIS SURFACE
 * status       how the state reads, once it is shown
 * ```
 *
 * Keeping them apart means a hidden finding can still say why it is hidden,
 * which a debug view can show and a test can assert.
 *
 * # The two rows that carry the weight
 *
 * **`verified` must not read as `published`.** A finding can be true and
 * deliberately withheld — the publication policy exists precisely so a real
 * defect need not interrupt anyone. Rendering it as `Open` would present a
 * decision the product made as a demand on the reader.
 *
 * **`superseded` must not be displayed.** It has already been replaced;
 * showing it produces two rows for one defect, which is the duplicate-comment
 * failure the reconciliation work exists to prevent, reappearing in the UI.
 */

import type { FindingDto } from "@acalys/contracts/api/v1";

import type { FindingStatus, Severity } from "@/data/security";

/** Refuses a value the union says cannot exist. */
function assertNever(value: never): never {
  throw new Error(`Unhandled finding value: ${String(value)}`);
}

export type FindingPresentation =
  | { readonly visibility: "visible"; readonly status: FindingStatus }
  | { readonly visibility: "hidden"; readonly reason: "superseded" };

/**
 * How a lifecycle state should appear on the findings surfaces.
 *
 * Total over the contract's own union: adding a state to the backend makes this
 * switch fail to compile, rather than producing a row nobody decided about.
 */
export function present(
  lifecycle: FindingDto["lifecycle"],
): FindingPresentation {
  switch (lifecycle) {
    case "verified":
      // True, and nobody has been told. Not `Open`: that would present a
      // withheld finding as one demanding attention.
      return { visibility: "visible", status: "In review" };
    case "published":
      return { visibility: "visible", status: "Open" };
    case "resolved":
      return { visibility: "visible", status: "Fixed" };
    case "dismissed":
      return { visibility: "visible", status: "Ignored" };
    case "stale":
      // The code beneath it moved and it is no longer confirmed. Not `Fixed` —
      // nobody established that it was fixed — and not `Open`, because it is no
      // longer being asserted.
      return { visibility: "visible", status: "In review" };
    case "superseded":
      return { visibility: "hidden", reason: "superseded" };
    default:
      return assertNever(lifecycle);
  }
}

/**
 * Backend severity to the label the UI already uses.
 *
 * A case change, written as a total function rather than a capitalisation
 * helper, so a severity added to the contract fails here instead of rendering
 * as an unstyled string.
 */
export function displaySeverity(severity: FindingDto["severity"]): Severity {
  switch (severity) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    case "info":
      return "Info";
    default:
      return assertNever(severity);
  }
}

/**
 * A finding as the security pages consume it.
 *
 * `id` is carried through deliberately. The backend spent considerable effort
 * making a finding's identity stable across line movement so the same defect
 * reconciles to the same row on the next push; keying a list on an array index
 * or a title would discard that at the last step.
 */
export interface FindingView {
  readonly id: string;
  readonly severity: Severity;
  readonly status: FindingStatus;
  readonly category: FindingDto["category"];
  readonly title: string;
  readonly explanation: string;
  readonly file: string;
  readonly line: number;
  readonly detectedAt: string;
}

/** Everything the surface should show, in the order the server sent it. */
export function toFindingViews(
  findings: readonly FindingDto[],
): readonly FindingView[] {
  const views: FindingView[] = [];
  for (const finding of findings) {
    const presentation = present(finding.lifecycle);
    if (presentation.visibility === "hidden") continue;
    views.push({
      id: finding.id,
      severity: displaySeverity(finding.severity),
      status: presentation.status,
      category: finding.category,
      title: finding.title,
      explanation: finding.explanation,
      file: finding.path,
      line: finding.startLine,
      detectedAt: finding.createdAt,
    });
  }
  return views;
}
