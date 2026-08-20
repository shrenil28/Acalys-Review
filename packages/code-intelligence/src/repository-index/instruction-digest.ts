import { createHash } from "node:crypto";

import type {
  AvailableInstructionArtifact,
  InstructionArtifact,
  InstructionFacts,
  InstructionProvenance,
} from "./instruction-model.js";

const INSTRUCTION_FACTS_SCHEMA = "acalys.instruction-facts/v1";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalProvenance(provenance: InstructionProvenance) {
  return {
    source: provenance.source,
    path: provenance.path,
    revision: provenance.revision,
    extractorVersion: provenance.extractorVersion,
    startLine: provenance.startLine ?? null,
    endLine: provenance.endLine ?? null,
  };
}

function discoveredProvenance(
  artifact: InstructionArtifact,
): InstructionProvenance | undefined {
  const value = propertyOf(artifact, "provenance");
  if (typeof value !== "object" || value === null) return undefined;

  const source = propertyOf(value, "source");
  const path = propertyOf(value, "path");
  const revision = propertyOf(value, "revision");
  const extractorVersion = propertyOf(value, "extractorVersion");
  if (
    (source !== "repository_artifact" && source !== "tool_configuration") ||
    typeof path !== "string" ||
    typeof revision !== "string" ||
    typeof extractorVersion !== "string"
  ) {
    return undefined;
  }

  const startLine = propertyOf(value, "startLine");
  const endLine = propertyOf(value, "endLine");
  return {
    source,
    path,
    revision,
    extractorVersion,
    ...(typeof startLine === "number" ? { startLine } : {}),
    ...(typeof endLine === "number" ? { endLine } : {}),
  };
}

function discoveredString(
  artifact: InstructionArtifact,
  property: "instructionClass" | "trust",
): string | null {
  const value = propertyOf(artifact, property);
  return typeof value === "string" ? value : null;
}

function propertyOf(value: object, property: string): unknown {
  return (value as Readonly<Record<string, unknown>>)[property];
}

function canonicalArtifact(artifact: InstructionArtifact): string {
  if (isAvailableArtifact(artifact)) {
    return JSON.stringify({
      artifactPath: artifact.artifactPath,
      availability: "available",
      instructionClass: artifact.instructionClass,
      trust: artifact.trust,
      scopeRoot: artifact.scopeRoot,
      declaredPriority:
        "declaredPriority" in artifact
          ? (artifact.declaredPriority ?? null)
          : null,
      content: artifact.content,
      provenance: canonicalProvenance(artifact.provenance),
    });
  }

  const provenance = discoveredProvenance(artifact);
  return JSON.stringify({
    artifactPath: artifact.artifactPath,
    availability: "unavailable",
    instructionClass: discoveredString(artifact, "instructionClass"),
    trust: discoveredString(artifact, "trust"),
    scopeRoot: artifact.scopeRoot,
    failure: artifact.availability.failure,
    detail: artifact.availability.detail,
    provenance:
      provenance === undefined ? null : canonicalProvenance(provenance),
  });
}

function isAvailableArtifact(
  artifact: InstructionArtifact,
): artifact is AvailableInstructionArtifact {
  return artifact.availability.kind === "available";
}

/** Canonical, traversal-order-independent representation of instruction facts. */
export function canonicalInstructionFactsSerialization(
  facts: InstructionFacts,
): string {
  return JSON.stringify({
    schema: INSTRUCTION_FACTS_SCHEMA,
    discovery:
      facts.discovery.status === "complete"
        ? { status: "complete" }
        : { status: "incomplete", why: facts.discovery.why },
    artifacts: facts.artifacts.map(canonicalArtifact).sort(compareText),
  });
}

/** SHA-256 identity over the complete canonical instruction-facts state. */
export function instructionFactsDigest(facts: InstructionFacts): string {
  return createHash("sha256")
    .update(canonicalInstructionFactsSerialization(facts), "utf8")
    .digest("hex");
}
