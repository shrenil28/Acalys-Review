/**
 * The experiment that must pass before a GitHub publisher is written.
 *
 * The whole publication design rests on one claim about GitHub's behaviour:
 *
 * > If creation succeeds remotely but the response is lost locally, Acalys can
 * > rediscover the exact pending review from provider state alone.
 *
 * GitHub's docs say pending reviews can be created (by omitting `event`),
 * listed, fetched, and submitted later. They do **not** document the
 * lost-response reconciliation case, and inferring it from the endpoint list is
 * exactly the kind of assumption that produces duplicate comments in
 * production.
 *
 * So this is a probe, not a test: it runs against a real App on a real
 * repository, records every raw response, and reports what GitHub actually
 * does. **No publisher is written until it passes**, and if it fails the
 * publication protocol changes rather than the domain — which is what keeping
 * `PublicationEffect` internal bought.
 *
 * # Running it
 *
 *     ACALYS_PROBE_APP_CLIENT_ID=Iv23li... \
 *     ACALYS_PROBE_PRIVATE_KEY_PATH=/path/to/app.private-key.pem \
 *     ACALYS_PROBE_INSTALLATION_ID=12345678 \
 *     ACALYS_PROBE_OWNER=acalys \
 *     ACALYS_PROBE_REPO=scratch \
 *     ACALYS_PROBE_PR=1 \
 *     npx tsx packages/providers/github/scripts/pending-review-probe.ts
 *
 * It refuses to run without all of them rather than falling back to anything
 * fabricated. A probe that quietly mocks the thing it exists to measure is
 * worse than no probe.
 *
 * **It writes to a real pull request.** Use a scratch repository.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { AppJwtSigner } from "../src/auth/jwt.js";
import { GithubAppPrivateKey } from "../src/auth/private-key.js";

interface ProbeConfig {
  readonly appClientId: string;
  readonly privateKeyPath: string;
  readonly installationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

function readConfig(): ProbeConfig {
  const required = [
    "ACALYS_PROBE_APP_CLIENT_ID",
    "ACALYS_PROBE_PRIVATE_KEY_PATH",
    "ACALYS_PROBE_INSTALLATION_ID",
    "ACALYS_PROBE_OWNER",
    "ACALYS_PROBE_REPO",
    "ACALYS_PROBE_PR",
  ] as const;

  const missing = required.filter((name) => (process.env[name] ?? "") === "");
  if (missing.length > 0) {
    throw new Error(
      `Probe cannot run without real credentials. Missing: ${missing.join(", ")}.\n` +
        "This probe exists to measure GitHub's actual behaviour; mocking it would " +
        "defeat its only purpose.",
    );
  }

  return {
    appClientId: process.env["ACALYS_PROBE_APP_CLIENT_ID"] ?? "",
    privateKeyPath: process.env["ACALYS_PROBE_PRIVATE_KEY_PATH"] ?? "",
    installationId: process.env["ACALYS_PROBE_INSTALLATION_ID"] ?? "",
    owner: process.env["ACALYS_PROBE_OWNER"] ?? "",
    repo: process.env["ACALYS_PROBE_REPO"] ?? "",
    pullNumber: Number(process.env["ACALYS_PROBE_PR"] ?? "0"),
  };
}

/** Every request and response, so the design is made from evidence. */
interface Recorded {
  readonly step: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

const transcript: Recorded[] = [];

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

async function call(
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
    url,
    status: response.status,
    body: redactSecrets(parsed),
  });

  // The caller still receives the real body — it needs the token to continue.
  return { status: response.status, body: parsed };
}

async function main(): Promise<void> {
  const config = readConfig();

  const signer = new AppJwtSigner({
    appClientId: config.appClientId,
    privateKey: GithubAppPrivateKey.fromPem(
      readFileSync(config.privateKeyPath, "utf8"),
    ),
    clock: { now: () => new Date().toISOString() as never },
  });

  // 1. Mint the effect identity BEFORE anything is attempted. This is the whole
  //    premise: an identity created after the POST cannot survive a lost
  //    response, because there would be nothing to look for.
  const publicationId = `pub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const marker = `<!-- acalys:publication:${publicationId} -->`;
  process.stdout.write(`Probe identity: ${publicationId}\n`);

  const jwt = signer.sign();
  const tokenResponse = await call(
    "installation-token",
    jwt.token,
    "POST",
    `/app/installations/${config.installationId}/access_tokens`,
  );
  const token = (tokenResponse.body as { token?: string }).token ?? "";
  if (token === "") throw new Error("Could not obtain an installation token");

  const base = `/repos/${config.owner}/${config.repo}/pulls/${String(config.pullNumber)}`;

  // 2. Create a PENDING review — `event` omitted — carrying the marker in the
  //    review BODY. On the body rather than only in inline comments, so
  //    recovery is one list call rather than a scan of every comment.
  const created = await call(
    "create-pending-review",
    token,
    "POST",
    `${base}/reviews`,
    {
      body: `${marker}\nAcalys probe: pending review recovery.`,
    },
  );

  // 3. Deliberately discard the review id. From here the probe pretends it
  //    never saw the response — the exact situation a lost response creates.
  process.stdout.write(
    `Created (status ${String(created.status)}). Discarding the response.\n`,
  );

  // 4–6. A fresh process enumerates provider state and looks for the marker.
  const listed = await call(
    "list-reviews",
    token,
    "GET",
    `${base}/reviews?per_page=100`,
  );
  const reviews = Array.isArray(listed.body)
    ? (listed.body as { id: number; body?: string; state?: string }[])
    : [];
  const recovered = reviews.find((review) =>
    (review.body ?? "").includes(marker),
  );

  if (recovered === undefined) {
    process.stdout.write(
      "\nRESULT: marker NOT recoverable from listed reviews.\n" +
        "The publication protocol must change — see docs/review/phase-1 outcome C/D.\n",
    );
  } else {
    process.stdout.write(
      `\nRecovered review ${String(recovered.id)} in state ${String(recovered.state)}.\n`,
    );

    // 7–9. Confirm the recovered review is the one intended, and inspect it.
    await call(
      "get-review",
      token,
      "GET",
      `${base}/reviews/${String(recovered.id)}`,
    );
    await call(
      "list-review-comments",
      token,
      "GET",
      `${base}/reviews/${String(recovered.id)}/comments`,
    );

    // 10. Submit the recovered review — the operation a replacement worker
    //     must be able to perform without having seen the creation response.
    await call(
      "submit-recovered-review",
      token,
      "POST",
      `${base}/reviews/${String(recovered.id)}/events`,
      { event: "COMMENT" },
    );

    // 11. Exactly one submitted review carrying this marker.
    const after = await call(
      "list-reviews-after",
      token,
      "GET",
      `${base}/reviews?per_page=100`,
    );
    const matching = (
      Array.isArray(after.body)
        ? (after.body as { body?: string; state?: string }[])
        : []
    ).filter((review) => (review.body ?? "").includes(marker));

    process.stdout.write(
      `\nRESULT: ${String(matching.length)} review(s) carry the marker; ` +
        `states: ${matching.map((r) => r.state ?? "?").join(", ")}\n` +
        (matching.length === 1
          ? "Marker reconciliation WORKS. The ledger design holds.\n"
          : "Marker reconciliation produced the wrong count — redesign required.\n"),
    );
  }

  const output = `probe-transcript-${publicationId}.json`;
  writeFileSync(output, JSON.stringify(transcript, null, 2), "utf8");
  process.stdout.write(`\nTranscript written to ${output}\n`);
}

/**
 * Runs only when invoked directly.
 *
 * Without the guard, importing this module to test its redaction *executes the
 * probe* — which throws on missing credentials, and would write to a real pull
 * request if they were present. A script whose side effects fire on import is
 * a script that cannot be tested.
 */
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(basename(process.argv[1]))
) {
  await main();
}
