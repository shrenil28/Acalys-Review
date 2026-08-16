import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCHEMA_DIR = fileURLToPath(
  new URL("../generated/schemas", import.meta.url),
);

interface ManifestEntry {
  readonly name: string;
  readonly layer: string;
  readonly schemaVersion: number | null;
  readonly file: string;
}

interface Manifest {
  readonly generatedBy: string;
  readonly sourceOfTruth: string;
  readonly contracts: readonly ManifestEntry[];
}

function read(relative: string): unknown {
  return JSON.parse(
    readFileSync(`${SCHEMA_DIR}/${relative}`, "utf8"),
  ) as unknown;
}

const manifest = read("manifest.json") as Manifest;

/**
 * Walks a JSON Schema, yielding `[pointer, subschema]` for every property.
 *
 * A JSON Pointer rather than a bare name, so a failure names the exact path —
 * `#/properties/author/oneOf/0/properties/userId` is actionable in a way that
 * "userId" is not, when the same field name appears in six places.
 */
function* properties(
  node: unknown,
  pointer = "#",
): Generator<readonly [string, Record<string, unknown>]> {
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;

  const props = schema["properties"];
  if (props !== null && typeof props === "object") {
    for (const [name, child] of Object.entries(props)) {
      yield [`${pointer}/properties/${name}`, child as Record<string, unknown>];
      yield* properties(child, `${pointer}/properties/${name}`);
    }
  }

  for (const key of ["items", "additionalProperties", "not"]) {
    yield* properties(schema[key], `${pointer}/${key}`);
  }
  for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (let index = 0; index < branches.length; index += 1) {
        yield* properties(
          branches[index],
          `${pointer}/${key}/${String(index)}`,
        );
      }
    }
  }
}

describe("Generated JSON Schemas (P0.txt §101)", () => {
  it("lists every contract in the manifest", () => {
    expect(manifest.contracts.length).toBeGreaterThan(40);
    expect(manifest.sourceOfTruth).toBe("packages/contracts/src");
  });

  it.each(manifest.contracts.map((entry) => [entry.name, entry] as const))(
    "%s is a well-formed artifact",
    (_name, entry) => {
      const schema = read(entry.file) as Record<string, unknown>;

      expect(schema["$schema"]).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(schema["$id"]).toContain(entry.name);
      // §101: version information travels with the artifact, so a consumer
      // reading a file knows which revision of the contract it describes.
      expect(schema).toHaveProperty("x-acalys-schema-version");
      expect(schema["x-acalys-schema-version"]).toBe(entry.schemaVersion);
      expect(schema["x-acalys-layer"]).toBe(entry.layer);
    },
  );

  /**
   * The check that caught a real defect.
   *
   * Generation first ran with `io: "output"`, which is the intuitive choice.
   * But every branded id and timestamp ends in a `.transform()`, and branding
   * has no JSON counterpart — so Zod emitted `{}` for each of them: a schema
   * accepting `42` where a UUID belongs. Every artifact was still "valid" JSON
   * Schema, and the drift check was still green.
   *
   * An unconstrained property is the one failure mode these files can have
   * that inspection will not reveal, because the file looks fine.
   */
  it.each(manifest.contracts.map((entry) => [entry.name, entry] as const))(
    "%s constrains every property",
    (_name, entry) => {
      const unconstrained: string[] = [];

      for (const [pointer, subschema] of properties(read(entry.file))) {
        const keys = Object.keys(subschema).filter(
          (key) =>
            !key.startsWith("x-") && key !== "description" && key !== "title",
        );
        if (keys.length === 0) unconstrained.push(pointer);
      }

      expect(
        unconstrained,
        `${entry.name} has properties that accept anything`,
      ).toEqual([]);
    },
  );

  it("describes branded ids as constrained strings, not as anything", () => {
    // The specific regression, stated as itself rather than only as an
    // instance of the general rule above.
    const run = read("domain/review-run.schema.json") as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(run.properties["id"]?.["type"]).toBe("string");
    expect(String(run.properties["id"]?.["pattern"])).toContain("[0-9a-f]{8}");
    expect(run.properties["createdAt"]?.["type"]).toBe("string");
  });

  it("keeps enums closed, so a consumer can switch exhaustively (§79)", () => {
    const finding = read("domain/review-finding.schema.json") as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(finding.properties["severity"]?.["enum"]).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ]);
  });

  it("rejects unknown keys in every domain artifact (§56)", () => {
    // Strictness has to survive generation: an artifact that permitted extra
    // properties would tell an external consumer the opposite of what the
    // platform enforces.
    for (const entry of manifest.contracts.filter(
      (c) => c.layer === "domain",
    )) {
      const schema = read(entry.file) as Record<string, unknown>;
      const branches = Array.isArray(schema["oneOf"])
        ? schema["oneOf"]
        : [schema];

      for (const branch of branches) {
        const object = branch as Record<string, unknown>;
        if (object["type"] !== "object") continue;
        expect(object["additionalProperties"], entry.name).toBe(false);
      }
    }
  });

  it("names files deterministically and uniquely (§101)", () => {
    const files = manifest.contracts.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(file).toMatch(/^(domain|api|internal)\/[a-z0-9-]+\.schema\.json$/);
    }
  });
});
