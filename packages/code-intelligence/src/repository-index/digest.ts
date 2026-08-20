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
 * boundaries   length-prefixed, so no delimiter can be confused
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
import { describeTenant } from "./identity.js";
import type { RepositoryIndexIdentity } from "./identity.js";
import type {
  DeclarationRecord,
  ModuleRecord,
  RepositoryIndex,
  SymbolRecord,
} from "./records.js";

/**
 * Length-prefixed field encoding.
 *
 * The first version of this joined fields with nothing between them, so
 * `("a", "bc")` and `("ab", "c")` produced the same preimage and two different
 * indexes digested equal. The obvious repair is a separator — but a separator
 * only works while no field can contain it, and these fields hold paths,
 * symbol names, and compiler diagnostic text. Picking a byte nobody uses
 * *today* is a bet on tomorrow's inputs.
 *
 * Length prefixing removes the bet. A reader never has to find a boundary,
 * because every field states its own extent:
 *
 * ```
 * ("a", "bc")   ->   1:a2:bc
 * ("ab", "c")   ->   2:ab1:c
 * ("a:b", "c")  ->   3:a:b1:c      a colon in the value changes nothing
 * ```
 *
 * The property, stated so it can be tested rather than believed:
 *
 * > Distinct canonical tuples cannot share a digest input.
 *
 * `length` is UTF-16 code units — what `String.prototype.length` reports and
 * what any JavaScript reader would count. Not bytes: a byte length would have
 * to name an encoding, and the value is never decoded from the digest anyway.
 */
function encode(value: string): string {
  return `${String(value.length)}:${value}`;
}

/**
 * How a missing optional value is written.
 *
 * `-:` rather than a printable sentinel like `~`. A sentinel drawn from the
 * *value* alphabet reintroduces the problem it was meant to solve: a field
 * whose literal content is `~` would encode to the sentinel and a symbol with
 * `container: "~"` would digest as one with no container. A length is a
 * non-negative integer, so no encoded value can begin with `-`, and the two
 * spaces cannot meet.
 */
const ABSENT = "-:";

/**
 * One canonical line, every field length-prefixed exactly once.
 *
 * Takes `string | undefined` so absence is encoded here rather than by each
 * caller remembering to. A caller that forgot would silently write an empty
 * string, which is a different fact.
 */
const line = (parts: readonly (string | undefined)[]): string =>
  parts.map((part) => (part === undefined ? ABSENT : encode(part))).join("");

function moduleLine(record: ModuleRecord): string {
  return line([
    "module",
    record.moduleId,
    record.path,
    record.language,
    record.role,
    record.coverage,
    record.contentDigest,
    record.coverageDetail,
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
    record.container,
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
    line(["identity", "tenant", describeTenant(identity.tenant)]),
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
