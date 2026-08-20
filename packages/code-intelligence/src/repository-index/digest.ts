/**
 * A canonical digest, built now so that L.3 has an oracle to be judged by.
 *
 * The property this exists to make checkable:
 *
 * ```
 * digest(full(H2))  ==  digest(incremental(H1 -> H2))
 * ```
 *
 * That equation is worth nothing if the digest depends on anything other than
 * the facts. A digest that varied with `Map` insertion order, or with the
 * order the compiler happened to visit files, would differ between two correct
 * indexes and agree between an index and a subtly wrong one -- the two
 * failures that matter, both at once.
 *
 * So the serialization here is explicit about every choice:
 *
 * ```
 * ordering     canonical, re-applied here rather than assumed
 * fields       enumerated by name, never Object.keys
 * separator    a character that cannot occur inside a field
 * absence      encoded distinctly from empty string
 * versions     part of the preimage, not metadata beside it
 * ```
 *
 * # Why the field list is written out
 *
 * `JSON.stringify(record)` would follow property insertion order and would
 * silently change the digest when a field was added, reordered, or made
 * optional. Worse, it would silently *not* change when a field's meaning
 * changed. Enumerating the fields makes the preimage a deliberate statement
 * about what the digest covers, and adding a field without deciding whether it
 * belongs becomes a visible edit rather than an invisible one.
 */

import { createHash } from "node:crypto";
import type { RepositoryIndexIdentity } from "./identity.js";
import type {
  DeclarationRecord,
  ModuleRecord,
  RepositoryIndex,
  SymbolRecord,
} from "./records.js";

/**
 * The field separator.
 *
 * A unit separator rather than a space, a pipe, or nothing at all. Every
 * printable candidate can occur inside a path, a symbol name, or a diagnostic
 * string -- and joining with no separator at all is worse still, because then
 * `("a", "bc")` and `("ab", "c")` share a preimage and two different indexes
 * digest equal. That is the one thing a digest must never do.
 *
 * Built with `fromCharCode` rather than written as an escape, so nothing here
 * depends on an invisible byte surviving a copy, a diff, or an editor.
 */
const SEP = String.fromCharCode(31);

/**
 * How a missing optional value is written.
 *
 * A distinct token rather than `""`, because a symbol with `container: ""` and
 * a symbol with no container are different facts, and a digest that cannot
 * tell them apart would call two different indexes equal.
 */
const ABSENT = String.fromCharCode(30) + "absent";

const field = (value: string | undefined): string => value ?? ABSENT;

const line = (parts: readonly string[]): string => parts.join(SEP);

function moduleLine(record: ModuleRecord): string {
  return line([
    "module",
    record.moduleId,
    record.path,
    record.language,
    record.role,
    record.coverage,
    record.contentDigest,
    field(record.coverageDetail),
  ]);
}

function symbolLine(record: SymbolRecord): string {
  return line([
    "symbol",
    record.symbolId,
    record.name,
    record.kind,
    record.moduleId,
    record.exported ? "exported" : "local",
    field(record.container),
  ]);
}

function declarationLine(record: DeclarationRecord): string {
  return line([
    "declaration",
    record.declarationId,
    record.symbolId,
    record.moduleId,
    record.kind,
    String(record.startLine),
    String(record.endLine),
    record.resolution,
    record.provenance.source,
    record.provenance.path,
    String(record.provenance.startLine),
    String(record.provenance.endLine),
    record.provenance.extractorVersion,
    record.provenance.revision,
  ]);
}

function identityLines(identity: RepositoryIndexIdentity): readonly string[] {
  return [
    line(["identity", "tenant", identity.tenantId]),
    line(["identity", "provider", identity.provider]),
    line(["identity", "repository", identity.repositoryId]),
    line([
      "identity",
      "revision",
      identity.revision.algorithm,
      identity.revision.value,
    ]),
    line(["identity", "schema", identity.indexSchemaVersion]),
    line(["identity", "extractor", identity.extractorVersion]),
  ];
}

/**
 * The exact bytes the digest is taken over.
 *
 * Exported so a mismatch can be diffed rather than stared at. When two indexes
 * that should be equal are not, the useful question is *which line differs*,
 * and a digest alone cannot answer it.
 */
export function canonicalSerialization(index: RepositoryIndex): string {
  const lines: string[] = [
    ...identityLines(index.identity),
    // Availability is part of the identity of the *answer*: a built index and
    // an unavailable one over the same revision are not the same artifact, and
    // both have zero records when the repository is empty.
    line(["availability", index.availability.kind]),
    line([
      "coverage",
      String(index.coverage.modulesTotal),
      String(index.coverage.modulesIndexed),
      String(index.coverage.modulesFailed),
      String(index.coverage.modulesUnsupported),
      String(index.coverage.modulesExcluded),
    ]),
  ];

  // Re-sorted here rather than trusted. The builder sorts too, but this
  // function is the *definition* of canonical form, and a definition that
  // assumes its input is already canonical defines nothing. It also makes the
  // digest a function of the record set rather than of the array a caller
  // happened to hand over -- which is what lets L.3 use it as an oracle.
  for (const record of [...index.modules].sort(byLine(moduleLine))) {
    lines.push(moduleLine(record));
  }
  for (const record of [...index.symbols].sort(byLine(symbolLine))) {
    lines.push(symbolLine(record));
  }
  for (const record of [...index.declarations].sort(byLine(declarationLine))) {
    lines.push(declarationLine(record));
  }

  return lines.join("\n");
}

function byLine<T>(render: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = render(a);
    const right = render(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

/** SHA-256 over {@link canonicalSerialization}. */
export function indexDigest(index: RepositoryIndex): string {
  return createHash("sha256")
    .update(canonicalSerialization(index), "utf8")
    .digest("hex");
}
