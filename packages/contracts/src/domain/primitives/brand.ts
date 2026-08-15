/**
 * Nominal typing for values that are structurally identical but semantically
 * incompatible (P0.txt §5).
 *
 * TypeScript is structural: a `RepositoryId` and a `ReviewRunId` are both
 * `string`, so without help the compiler happily accepts one where the other
 * belongs. In a distributed review platform that mistake is silent and
 * expensive — it surfaces as a lookup miss in a worker hours later.
 *
 * Branding attaches a phantom property that exists only in the type system:
 *
 *     const runId: ReviewRunId = repositoryId;
 *     //    ~~~~~ Type 'RepositoryId' is not assignable to type 'ReviewRunId'
 *
 * The brand carrier is a `unique symbol` rather than a string key, so it
 * cannot collide with a real field, cannot be typed by hand, and never appears
 * in `Object.keys`, spreads, or serialized output. A branded value *is* its
 * underlying primitive at runtime — zero cost, fully JSON-serializable.
 */

declare const brandCarrier: unique symbol;

/**
 * `Brand<string, "RepositoryId">` is a string that only a validated
 * `RepositoryId` factory can produce.
 *
 * @typeParam TValue - the underlying runtime representation (usually `string`)
 * @typeParam TName - a unique name; two brands with different names are never
 *   mutually assignable
 */
export type Brand<TValue, TName extends string> = TValue & {
  readonly [brandCarrier]: TName;
};

/**
 * The one sanctioned way to apply a brand.
 *
 * This is a compile-time assertion with no runtime validation. Every branded
 * type ships a validating factory (`repositoryPath()`, `timestamp()`, …) that
 * calls this only after its own checks pass; reaching for it directly at a
 * trust boundary defeats the point of branding.
 *
 * Constrained to string brands, which is every brand in the platform. That is
 * deliberate rather than a limitation: a fully generic signature would need to
 * recover the base type from `TValue & { [brandCarrier]: TName }`, and
 * TypeScript cannot infer reliably through an intersection — the attempt
 * yields either the branded type back or an inference failure. Should a
 * numeric brand ever be needed, it gets its own explicit factory.
 *
 * There is no matching `unbrand`: a branded string already *is* a `string` to
 * the type system, so assigning one to a `string` parameter needs no helper.
 *
 * @internal
 */
export function unsafeBrand<TBranded extends Brand<string, string>>(
  value: string,
): TBranded {
  return value as TBranded;
}
