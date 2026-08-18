/**
 * Shared infrastructure for the E.3 provider probes.
 *
 * Extracted so that every probe records through the *same* hardened recorder.
 * A second probe with its own copy of the redaction logic is a second chance to
 * get redaction wrong, and the one that gets it wrong is the one that writes a
 * live installation token to a file someone attaches to an issue.
 *
 * Nothing here fabricates provider behaviour. The probes exist to measure what
 * GitHub actually does; this module only makes the measurement safe to keep.
 */

import { writeFileSync } from "node:fs";

export interface ProbeConfig {
  readonly appClientId: string;
  readonly privateKeyPath: string;
  /** Optional: resolved from the repository when absent. */
  readonly installationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/**
 * Where each value may come from, most specific first.
 *
 * Operators keep App credentials in a shared env file whose names belong to the
 * App, not to this probe. Requiring a second, probe-specific spelling of the
 * same six values invites a hand-copied mismatch — against a real pull request,
 * a mismatch is a wasted run.
 */
const ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ACALYS_PROBE_APP_CLIENT_ID: ["GITHUB_APP_CLIENT_ID"],
  ACALYS_PROBE_PRIVATE_KEY_PATH: ["GITHUB_APP_PRIVATE_KEY_PATH"],
  ACALYS_PROBE_INSTALLATION_ID: ["GITHUB_INSTALLATION_ID"],
  ACALYS_PROBE_OWNER: ["GITHUB_OWNER"],
  ACALYS_PROBE_REPO: ["GITHUB_REPO"],
  ACALYS_PROBE_PR: ["GITHUB_PULL_NUMBER", "GITHUB_PR"],
};

function read(name: string): string {
  for (const candidate of [name, ...(ENV_ALIASES[name] ?? [])]) {
    const value = (process.env[candidate] ?? "").trim();
    if (value !== "") return value;
  }
  return "";
}

export function readConfig(): ProbeConfig {
  // `ACALYS_PROBE_INSTALLATION_ID` is deliberately absent: it is resolved from
  // the repository below. An installation id is only discoverable by reading it
  // out of a settings URL, and a probe that fails because the operator pasted
  // the wrong one wastes a run against a real pull request.
  const required = [
    "ACALYS_PROBE_APP_CLIENT_ID",
    "ACALYS_PROBE_PRIVATE_KEY_PATH",
    "ACALYS_PROBE_OWNER",
    "ACALYS_PROBE_REPO",
    "ACALYS_PROBE_PR",
  ] as const;

  const missing = required.filter((name) => read(name) === "");
  if (missing.length > 0) {
    throw new Error(
      `Probe cannot run without real credentials. Missing: ${missing.join(", ")}.\n` +
        "This probe exists to measure GitHub's actual behaviour; mocking it would " +
        "defeat its only purpose.",
    );
  }

  const pullNumber = Number(read("ACALYS_PROBE_PR"));
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("The pull request number must be a positive integer.");
  }

  return {
    appClientId: read("ACALYS_PROBE_APP_CLIENT_ID"),
    privateKeyPath: read("ACALYS_PROBE_PRIVATE_KEY_PATH"),
    installationId: read("ACALYS_PROBE_INSTALLATION_ID"),
    owner: read("ACALYS_PROBE_OWNER"),
    repo: read("ACALYS_PROBE_REPO"),
    pullNumber,
  };
}

/** Every request and response, so the design is made from evidence. */
export interface Recorded {
  readonly step: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

const transcript: Recorded[] = [];

/** The transcript so far. Read-only: entries are added by `call`. */
export function recordedCalls(): readonly Recorded[] {
  return transcript;
}

/**
 * Field names whose values are credentials, wherever they appear.
 *
 * The transcript is the point of this probe and also its biggest hazard: the
 * installation-token exchange returns the token *in its response body*, so
 * recording responses verbatim writes a live credential to a file on disk and
 * very likely into a bug report.
 *
 * Raw provider responses are what makes the design evidence-based. Raw
 * credentials are never part of that evidence.
 */
const SECRET_FIELDS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "client_secret",
  "authorization",
  "password",
]);

/**
 * Replaces credential values anywhere in a response, at any depth.
 *
 * Exported so `tests/probe-redaction.test.ts` can prove it — an unverified
 * redaction is worse than none, because it is trusted.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SECRET_FIELDS.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactSecrets(nested),
    ]),
  );
}

/**
 * Credential values seen during this run, scrubbed wherever they appear.
 *
 * Field-name redaction handles the shapes we predicted: `token`,
 * `access_token`, `authorization`. It cannot handle the ones we did not — a
 * token echoed inside an error `message`, embedded in a `documentation_url`, or
 * returned under a field GitHub adds next year. Those are exactly the cases
 * that leak, because nobody wrote a rule for them.
 *
 * So every credential is registered the moment it exists and removed by value
 * from anything recorded. Registration happens at the point of creation, not at
 * the point of logging, which is the difference between a structural guarantee
 * and remembering.
 */
const SECRET_VALUES = new Set<string>();

/**
 * Registers a credential for scrubbing.
 *
 * Short values are refused rather than accepted quietly: scrubbing a two-
 * character string would corrupt every transcript it appeared in, and a
 * credential short enough to hit that limit is not a credential.
 */
export function registerSecret(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < 16) {
    throw new Error(
      "Refusing to register a short value as a secret: scrubbing it would " +
        "corrupt the transcript, and no real credential is this short.",
    );
  }
  SECRET_VALUES.add(trimmed);
  // PEMs arrive with line breaks that JSON escapes; register the escaped form
  // too so a serialized copy cannot slip past a raw-text comparison.
  SECRET_VALUES.add(trimmed.replaceAll("\n", "\\n"));
}

/** Test seam. Never called by the probe itself. */
export function clearRegisteredSecrets(): void {
  SECRET_VALUES.clear();
}

/** Replaces registered credential values anywhere in a structure. */
export function scrubSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    let scrubbed = value;
    for (const secret of SECRET_VALUES) {
      scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
    }
    return scrubbed;
  }
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      scrubSecrets(nested),
    ]),
  );
}

/**
 * Shapes that are credentials whoever produced them.
 *
 * The last line of defence, and the only one that works for a secret nobody
 * registered — a token minted by a code path added later, or one GitHub returns
 * from an endpoint this probe does not yet call.
 */
const CREDENTIAL_PATTERNS: readonly {
  readonly name: string;
  readonly pattern: RegExp;
}[] = [
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "GitHub server-to-server token", pattern: /ghs_[A-Za-z0-9]{20,}/ },
  { name: "PEM private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // A JWT: three base64url segments, the first decoding to a JSON header.
  {
    name: "JWT",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

/**
 * Refuses to emit anything containing credential material.
 *
 * Throwing is the point. A probe that writes a transcript and warns about a
 * leak has already written the leak; the file is the artifact people attach to
 * issues.
 */
export function assertNoCredentials(serialized: string): void {
  for (const secret of SECRET_VALUES) {
    if (serialized.includes(secret)) {
      throw new Error(
        "Refusing to emit: a registered credential survived redaction. " +
          "This is a redaction bug, not an operator mistake.",
      );
    }
  }
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(
        `Refusing to emit: output matches the shape of a ${name}. ` +
          "Register it via registerSecret() at the point it is created.",
      );
    }
  }
}

export async function call(
  step: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = `https://api.github.com${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);

  // Redacted on the way into the transcript, not on the way out. A redaction
  // applied at write time is one a future `console.log(transcript)` bypasses.
  // Note that `headers` is deliberately never recorded at all: the
  // Authorization header is a bearer credential on every single request.
  transcript.push({
    step,
    method,
    url: String(scrubSecrets(url)),
    status: response.status,
    // Both passes, in this order: field-name redaction removes the values we
    // predicted; value scrubbing removes the ones we did not.
    body: scrubSecrets(redactSecrets(parsed)),
  });

  // The caller still receives the real body — it needs the token to continue.
  return { status: response.status, body: parsed };
}

/**
 * Writes the transcript, refusing if anything in it looks like a credential.
 *
 * The check happens before the bytes reach the disk. A file written and then
 * found to contain a credential has already leaked it.
 */
export function writeTranscript(label: string): string {
  const output = `probe-transcript-${label}.json`;
  const serialized = JSON.stringify(transcript, null, 2);
  assertNoCredentials(serialized);
  writeFileSync(output, serialized, "utf8");
  return output;
}
