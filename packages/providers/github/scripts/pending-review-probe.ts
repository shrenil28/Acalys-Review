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

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { AppJwtSigner } from "../src/auth/jwt.js";
import { GithubAppPrivateKey } from "../src/auth/private-key.js";
import {
  call,
  readConfig,
  registerSecret,
  writeTranscript,
} from "./probe-harness.js";

/**
 * The first line in the diff that a review comment can be anchored to.
 *
 * GitHub accepts inline comments only on lines the diff touches, and rejects
 * anything else with a 422 that reads like a permissions problem. Parsing the
 * patch is the only way to know a line is acceptable without guessing.
 *
 * Returns a RIGHT-side line number, since an added line is unambiguously
 * present in the head revision.
 */
function firstAddedLine(
  body: unknown,
): { readonly path: string; readonly line: number } | undefined {
  if (!Array.isArray(body)) return undefined;

  for (const entry of body as { filename?: string; patch?: string }[]) {
    const patch = entry.patch;
    const path = entry.filename;
    if (patch === undefined || path === undefined) continue;

    let newLine = 0;
    for (const line of patch.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk !== null) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (line.startsWith("+")) return { path, line: newLine };
      // Context lines advance the new-file counter; removals do not.
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine += 1;
    }
  }

  return undefined;
}

async function main(): Promise<void> {
  const config = readConfig();

  const pem = readFileSync(config.privateKeyPath, "utf8");
  registerSecret(pem);

  const signer = new AppJwtSigner({
    appClientId: config.appClientId,
    privateKey: GithubAppPrivateKey.fromPem(pem),
    clock: { now: () => new Date().toISOString() as never },
  });

  // 1. Mint the effect identity BEFORE anything is attempted. This is the whole
  //    premise: an identity created after the POST cannot survive a lost
  //    response, because there would be nothing to look for.
  const publicationId = `pub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const marker = `<!-- acalys:publication:${publicationId} -->`;
  process.stdout.write(`Probe identity: ${publicationId}\n`);

  const jwt = signer.sign();
  registerSecret(jwt.token);

  // Resolve the installation from the repository unless one was given. This is
  // also the first real assertion the probe makes: if the App is not installed
  // on this repository, everything after it would fail in a less obvious way.
  let installationId = config.installationId;
  if (installationId === "") {
    const installation = await call(
      "resolve-installation",
      jwt.token,
      "GET",
      `/repos/${config.owner}/${config.repo}/installation`,
    );
    const resolved = (installation.body as { id?: number }).id;
    if (installation.status !== 200 || resolved === undefined) {
      throw new Error(
        `The App is not installed on ${config.owner}/${config.repo} ` +
          `(status ${String(installation.status)}). Install it there, or set ` +
          "ACALYS_PROBE_INSTALLATION_ID explicitly.",
      );
    }
    installationId = String(resolved);
    process.stdout.write(`Resolved installation ${installationId}\n`);
  }

  const tokenResponse = await call(
    "installation-token",
    jwt.token,
    "POST",
    `/app/installations/${installationId}/access_tokens`,
  );
  const token = (tokenResponse.body as { token?: string }).token ?? "";
  if (token === "") throw new Error("Could not obtain an installation token");
  registerSecret(token);

  const base = `/repos/${config.owner}/${config.repo}/pulls/${String(config.pullNumber)}`;

  // 2a. Find a line the provider will accept an inline comment on.
  //
  //     A review body alone would leave the "were the inline comments
  //     retrievable after recovery?" question unanswered, and that is the half
  //     of the publication that carries the findings. GitHub only accepts
  //     comments on lines present in the diff, so the target is derived from
  //     the diff rather than guessed.
  const files = await call(
    "list-pull-request-files",
    token,
    "GET",
    `${base}/files`,
  );
  const anchor = firstAddedLine(files.body);
  if (anchor === undefined) {
    throw new Error(
      "No added line found in the pull request diff. The probe needs one to " +
        "attach an inline comment; push a change to the probe PR and retry.",
    );
  }
  process.stdout.write(
    `Inline anchor: ${anchor.path}:${String(anchor.line)} (RIGHT)\n`,
  );

  // 2b. Create a PENDING review — `event` omitted — carrying the marker in the
  //     review BODY. On the body rather than only in inline comments, so
  //     recovery is one list call rather than a scan of every comment.
  //
  //     The inline comment carries its own finding marker, because a review and
  //     a finding are separately reconcilable identities: the review is the
  //     publication unit, the finding is what survives across revisions.
  const findingMarker = `<!-- acalys:finding:${publicationId}:f1 -->`;
  const created = await call(
    "create-pending-review",
    token,
    "POST",
    `${base}/reviews`,
    {
      body: `${marker}\nAcalys probe: pending review recovery.`,
      comments: [
        {
          path: anchor.path,
          line: anchor.line,
          side: "RIGHT",
          body: `${findingMarker}\nAcalys probe: deterministic inline finding.`,
        },
      ],
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

  process.stdout.write(
    `\nTranscript written to ${writeTranscript(publicationId)}\n`,
  );
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
