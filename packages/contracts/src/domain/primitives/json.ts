/**
 * A closed, recursive description of what may cross a transport boundary
 * (P0.txt §52, §63).
 *
 * Every canonical contract is carried over a queue, an HTTP response, or a
 * database column, so "can this be serialized?" is a type-level question, not
 * a runtime hope. `JsonValue` answers it: anything typed as `JsonValue`
 * survives `structuredClone`, `JSON.stringify`, and a Postgres `jsonb` column
 * without loss.
 *
 * What it deliberately excludes, and why:
 *
 * | Excluded          | Reason |
 * | ----------------- | ------ |
 * | `undefined`       | vanishes inside arrays and object values, so an round-trip is lossy |
 * | functions/classes | §63 — transport contracts must carry data, never behaviour |
 * | `Date`            | §6 — timestamps cross boundaries as RFC 3339 strings |
 * | `NaN`/`Infinity`  | serialize to `null`, silently corrupting numbers |
 * | `bigint`          | throws in `JSON.stringify` |
 * | symbols           | dropped without warning |
 *
 * This is the type that replaces `any` on every metadata-ish field. `any`
 * would let all of the above through unnoticed.
 */

import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/**
 * Runtime counterpart of {@link JsonValue}.
 *
 * Finite-number checking is the part that matters: `z.number()` alone accepts
 * `NaN` and `Infinity`, both of which `JSON.stringify` turns into `null`. A
 * confidence score that silently becomes `null` in transit is exactly the kind
 * of corruption §7 warns about.
 *
 * `__proto__` is rejected outright (§63, prototype pollution): a payload
 * carrying that key can poison `Object.prototype` when merged naively
 * downstream, and no legitimate contract needs it.
 */
/** True for an object literal carrying a real own `__proto__` property. */
function hasProtoKey(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "__proto__")
  );
}

/**
 * Rejects prototype-pollution payloads **before** parsing (§63).
 *
 * The guard has to run against raw input, and getting there took two wrong
 * turns worth recording:
 *
 * 1. A `.refine` on the parsed object never fires. Zod rebuilds a record by
 *    assigning into a fresh object, and `target["__proto__"] = v` invokes the
 *    inherited setter rather than creating an own property — so the key is
 *    already gone when the refine runs.
 * 2. A key schema never fires either. Zod v4 filters `__proto__` out of the
 *    key set itself, so it is never offered for validation.
 *
 * Zod's stripping does make the *output* safe, but stripping is the wrong
 * behaviour for a canonical contract: a payload that silently loses a key is
 * exactly the quiet corruption §7 warns about. We reject instead, loudly.
 *
 * `JSON.parse` is the realistic source — it creates a genuine own `__proto__`
 * property, and anything that later merges such an object naively can poison
 * `Object.prototype`.
 */
const rejectProtoKey = z.unknown().superRefine((value, ctx) => {
  if (hasProtoKey(value)) {
    ctx.addIssue({
      code: "custom",
      message: "'__proto__' is not an allowed key",
    });
  }
});

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine(Number.isFinite, {
      error: "NaN and Infinity are not JSON-serializable",
    }),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    rejectProtoKey.pipe(z.record(z.string(), jsonValueSchema)),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = rejectProtoKey.pipe(
  z.record(z.string(), jsonValueSchema),
);

/**
 * Narrows `unknown` to {@link JsonValue} without throwing.
 *
 * Use at the edges — a database `jsonb` read, a queue payload — where the
 * value is genuinely untyped and a parse failure is an expected outcome
 * rather than a bug.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}
