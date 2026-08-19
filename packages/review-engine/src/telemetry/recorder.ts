/**
 * Recording measurements, in a way that cannot change what is reviewed.
 *
 * Performance telemetry is **best effort**. A metric sink that is unreachable,
 * slow, or throwing must not alter a single finding — observability that can
 * fail a review has stopped being observability and become a dependency, and
 * the durable review ledger already has its own, stricter guarantees.
 *
 * That is a deliberate split, not laziness:
 *
 * ```
 * review facts     authoritative, transactional, must converge
 * telemetry        best effort, dropped rather than allowed to interfere
 * ```
 *
 * Future billing or audit accounting may need the stricter treatment. It should
 * get its own path rather than quietly promoting this one.
 */

import type { InvocationMeasurement } from "./measurement.js";

export interface Recorder {
  record(measurement: InvocationMeasurement): void;
  readonly measurements: readonly InvocationMeasurement[];
}

/**
 * Discards everything. The OFF half of the non-interference proof.
 *
 * Not a stub for convenience — the proof requires a configuration in which no
 * measurement code runs at all, so that identical output demonstrates
 * instrumentation is inert rather than merely careful.
 */
export const NULL_RECORDER: Recorder = {
  record: () => undefined,
  measurements: [],
};

export function createRecorder(): Recorder {
  const measurements: InvocationMeasurement[] = [];
  return {
    record: (measurement) => {
      measurements.push(measurement);
    },
    get measurements() {
      return measurements;
    },
  };
}

/**
 * Times `work` and records it — and returns `work`'s result untouched.
 *
 * Every failure mode here is deliberately one-way:
 *
 * ```
 * work throws          the error propagates unchanged, and is still recorded
 * recording throws     swallowed; the result is returned
 * ```
 *
 * The first matters most. A timing wrapper that catches an exception to record
 * a duration and then rethrows something else — or worse, does not rethrow —
 * turns a verifier failure into a silent success, which is precisely the class
 * of defect the whole verification boundary exists to prevent.
 */
export async function measure<T>(
  recorder: Recorder,
  describe: Omit<
    InvocationMeasurement,
    "startedAt" | "completedAt" | "wallMs" | "outcome"
  >,
  work: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    safelyRecord(recorder, {
      ...describe,
      startedAt,
      completedAt: Date.now(),
      wallMs: Date.now() - startedAt,
      outcome: "succeeded",
    });
    return result;
  } catch (error) {
    // Recorded, then rethrown unchanged. A failed invocation still consumed
    // time and tokens, and a cost report that omits failures understates
    // exactly the runs worth investigating.
    safelyRecord(recorder, {
      ...describe,
      startedAt,
      completedAt: Date.now(),
      wallMs: Date.now() - startedAt,
      outcome: "failed",
    });
    throw error;
  }
}

function safelyRecord(
  recorder: Recorder,
  measurement: InvocationMeasurement,
): void {
  try {
    recorder.record(measurement);
  } catch {
    // Best effort, by design. There is nowhere useful to report a telemetry
    // failure from inside the thing being measured, and failing the review
    // over it would invert the priority this module exists to state.
  }
}
