/**
 * What a blind retry actually does.
 *
 * The recovery probe proved that a pending review can be rediscovered after a
 * lost response. It did not answer the question that decides how dangerous
 * getting the protocol wrong is:
 *
 * > If a worker loses the response and retries the create **without**
 * > reconciling first, does GitHub produce a second pending review?
 *
 * The answer changes the design's failure mode, not just its wording:
 *
 *     GitHub rejects the second create   →  a blind retry is self-limiting;
 *                                           reconciliation is correctness, and
 *                                           the provider is a backstop.
 *     GitHub accepts it                  →  a blind retry duplicates a review
 *                                           on someone's pull request, and
 *                                           reconcile-before-create is the only
 *                                           thing standing between a crash and
 *                                           visible duplicate comments.
 *
 * Assuming the first would be exactly the kind of guess this checkpoint exists
 * to refuse. So it is measured.
 *
 * Two retries are attempted, because they are different questions: one reuses
 * the stable publication identity (what Acalys would actually send), the other
 * mints a fresh one (what a naive implementation would send).
 *
 * **It writes to a real pull request**, and cleans up after itself: any review
 * still pending at the end is deleted, so the probe is repeatable and leaves no
 * half-published state on the PR.
 *
 *     source /path/to/app.env
 *     npx tsx packages/providers/github/scripts/duplicate-create-probe.ts
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

interface ReviewSummary {
  readonly id: number;
  readonly state?: string;
  readonly body?: string;
}

function reviews(body: unknown): readonly ReviewSummary[] {
  return Array.isArray(body) ? (body as ReviewSummary[]) : [];
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

  const jwt = signer.sign();
  registerSecret(jwt.token);

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
          `(status ${String(installation.status)}).`,
      );
    }
    installationId = String(resolved);
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
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const stable = `pub_dup_${run}`;
  const naive = `pub_dup_${run}_retry`;
  process.stdout.write(
    `Stable identity: ${stable}\nNaive retry identity: ${naive}\n\n`,
  );

  const createPending = (step: string, publicationId: string) =>
    call(step, token, "POST", `${base}/reviews`, {
      body: `<!-- acalys:publication:${publicationId} -->\nAcalys duplicate-create probe.`,
    });

  // 1. The original create. Its response is assumed lost from here on.
  const first = await createPending("create-first-pending", stable);
  process.stdout.write(`create #1 → ${String(first.status)}\n`);

  // 2. The retry Acalys would send: same stable identity, no reconciliation.
  const sameIdentity = await createPending("retry-same-identity", stable);
  process.stdout.write(
    `create #2 (same identity)  → ${String(sameIdentity.status)}\n`,
  );

  // 3. The retry a naive implementation would send: a fresh identity, which the
  //    provider has no way to associate with the first.
  const freshIdentity = await createPending("retry-fresh-identity", naive);
  process.stdout.write(
    `create #3 (fresh identity) → ${String(freshIdentity.status)}\n`,
  );

  const message = (body: unknown): string =>
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message?: unknown }).message)
      : "";
  if (sameIdentity.status >= 400) {
    process.stdout.write(`   rejected: ${message(sameIdentity.body)}\n`);
  }
  if (freshIdentity.status >= 400) {
    process.stdout.write(`   rejected: ${message(freshIdentity.body)}\n`);
  }

  // 4. What provider state actually contains now.
  const listed = await call(
    "list-reviews",
    token,
    "GET",
    `${base}/reviews?per_page=100`,
  );
  const all = reviews(listed.body);
  const pending = all.filter((review) => review.state === "PENDING");
  const mine = all.filter((review) =>
    (review.body ?? "").includes(`acalys:publication:pub_dup_${run}`),
  );

  process.stdout.write(
    `\nRESULT: ${String(pending.length)} pending review(s); ` +
      `${String(mine.length)} carrying a marker from this run.\n` +
      (pending.length <= 1
        ? "GitHub permits at most one pending review per author — a blind retry " +
          "cannot duplicate the publication unit.\n"
        : "GitHub PERMITTED multiple pending reviews. Reconcile-before-create is " +
          "load-bearing: without it, a crash produces duplicate reviews.\n"),
  );

  // 5. Clean up. A pending review left behind blocks the next run and leaves an
  //    unsubmitted draft attached to a real pull request.
  for (const review of pending) {
    const deleted = await call(
      "delete-pending-review",
      token,
      "DELETE",
      `${base}/reviews/${String(review.id)}`,
    );
    process.stdout.write(
      `cleanup: deleted pending review ${String(review.id)} → ${String(deleted.status)}\n`,
    );
  }

  const after = await call(
    "list-reviews-after-cleanup",
    token,
    "GET",
    `${base}/reviews?per_page=100`,
  );
  const leftover = reviews(after.body).filter(
    (review) => review.state === "PENDING",
  ).length;
  process.stdout.write(`pending reviews remaining: ${String(leftover)}\n`);

  process.stdout.write(`\nTranscript written to ${writeTranscript(stable)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(basename(process.argv[1]))
) {
  await main();
}
