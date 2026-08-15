/**
 * Deterministic serialization (P0.txt §58, §123).
 *
 * Several platform guarantees are hashes, and a hash is only as stable as the
 * bytes fed to it:
 *
 * - a `FindingFingerprint` must match across revisions, processes, and
 *   releases, or incremental review reports every finding as new (§28);
 * - a `ReviewConfigSnapshot.sourceHash` must identify identical config (§39);
 * - artifact and idempotency checksums must agree between the producer and a
 *   consumer running on another machine (§46, §47).
 *
 * `JSON.stringify` cannot provide that. Its key order follows insertion order,
 * so two objects that are deeply equal serialize differently:
 *
 *     JSON.stringify({ a: 1, b: 2 })  // '{"a":1,"b":2}'
 *     JSON.stringify({ b: 2, a: 1 })  // '{"b":2,"a":1}'   ← different hash
 *
 * This module sorts keys recursively by code unit, so equal input always
 * yields identical bytes. It is the **only** place in the package permitted to
 * call `JSON.stringify` — an ESLint rule blocks it everywhere else.
 *
 * Array order is preserved, never sorted: for `evidence[]` and `paths[]` the
 * order is semantically meaningful (§123), so canonicalization must not
 * destroy it. Callers that want order-insensitivity sort before hashing.
 */

import { ValidationError } from "../errors/errors.js";
import type { JsonValue } from "./json.js";

/**
 * Serializes to a canonical string: recursively key-sorted, no insignificant
 * whitespace, stable across runs and machines.
 *
 * @throws {ValidationError} if the value cannot be represented deterministically —
 *   `undefined`, a function, a symbol, `NaN`, `Infinity`, a `bigint`, or a
 *   circular reference. Failing loudly is the point: silently coercing
 *   `Infinity` to `null` (which `JSON.stringify` does) would produce two
 *   different inputs that hash the same.
 */
export function canonicalJson(value: JsonValue): string {
  return write(value, new Set<object>(), "$");
}

function write(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError(
          `Value at ${path} is ${String(value)}, which has no deterministic JSON form`,
          { details: { path } },
        );
      }
      // `JSON.stringify` normalizes -0 to 0 and uses the shortest round-trip
      // representation, which is what we want for stability.
      return JSON.stringify(value);

    case "string":
      return JSON.stringify(value);

    case "undefined":
      throw new ValidationError(
        `Value at ${path} is undefined; omit the key instead (P0.txt §57)`,
        { details: { path } },
      );

    case "bigint":
      throw new ValidationError(
        `Value at ${path} is a bigint, which is not JSON-serializable`,
        { details: { path } },
      );

    case "function":
    case "symbol":
      throw new ValidationError(
        `Value at ${path} is a ${typeof value}; transport contracts carry data only (P0.txt §63)`,
        { details: { path } },
      );

    case "object":
      return writeObject(value, seen, path);
  }

  // Unreachable: the switch covers all eight `typeof` results. Present because
  // `noImplicitReturns` cannot prove that, and an explicit throw is a better
  // terminal than an implicit `undefined` if a future JS type appears.
  throw new ValidationError(
    `Value at ${path} has an unsupported runtime type`,
    { details: { path } },
  );
}

function writeObject(value: object, seen: Set<object>, path: string): string {
  if (seen.has(value)) {
    throw new ValidationError(
      `Circular reference at ${path}; contracts must be acyclic to serialize`,
      { details: { path } },
    );
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) =>
        write(item, seen, `${path}[${index}]`),
      );
      return `[${items.join(",")}]`;
    }

    // A Date here means someone bypassed the Timestamp contract (§6). Catching
    // it as a distinct error is far more useful than serializing it to a
    // string and letting the mistake spread.
    if (value instanceof Date) {
      throw new ValidationError(
        `Value at ${path} is a Date; timestamps cross boundaries as RFC 3339 strings (P0.txt §6)`,
        { details: { path } },
      );
    }

    // Sorted by UTF-16 code unit — the same ordering `Array.prototype.sort`
    // gives by default, and stable across every JS engine.
    const keys = Object.keys(value).sort();
    const entries: string[] = [];

    for (const key of keys) {
      const child = (value as Record<string, unknown>)[key];
      // Mirrors JSON.stringify: an object key whose value is undefined is
      // omitted rather than rejected, which is exactly the `.optional()`
      // convention from §57. Inside an array, undefined is still an error —
      // there it would shift indices.
      if (child === undefined) continue;
      entries.push(
        `${JSON.stringify(key)}:${write(child, seen, `${path}.${key}`)}`,
      );
    }

    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
