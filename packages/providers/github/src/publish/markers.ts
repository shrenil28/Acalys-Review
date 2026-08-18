/**
 * The machine-readable identity Acalys attaches to what it publishes.
 *
 * GitHub offers no caller-supplied idempotency key for review creation. P1-E.3
 * measured what that costs: a create whose response is lost can be retried
 * safely only while the review is still pending (the provider answers 422,
 * "User can only have one pending review per pull request"). Once the review is
 * submitted the provider imposes nothing, and a blind retry puts a second
 * review on the pull request.
 *
 * So the marker is not decoration. It is the only thing that makes a
 * publication rediscoverable from provider state, and therefore the only thing
 * that makes recovery-without-duplication possible at all.
 *
 * # Requirements it has to meet, and why each one
 *
 * **On the review body**, not only on individual comments. Recovery is then one
 * list call rather than a scan of every comment on the pull request — and the
 * experiment confirmed GitHub returns the body of a PENDING review in the list
 * response, so the cheap path actually works.
 *
 * **Generated before the POST.** An identity minted from the response cannot
 * survive the response being lost, which is the entire failure mode.
 *
 * **An HTML comment.** Invisible in rendered Markdown, preserved verbatim by
 * GitHub — the experiment confirmed the marker came back byte-identical.
 *
 * **Never parsed as instruction.** Marker text arriving from the provider is
 * untrusted input: anyone can write `<!-- acalys:publication:… -->` in a comment
 * on a public pull request. Matching one proves only that a string is present,
 * which is why reconciliation also compares the content digest before treating
 * a review as ours.
 */

/** Publication-level identity, carried on the review body. */
export function publicationMarker(logicalKey: string): string {
  return `<!-- acalys:publication:${logicalKey} -->`;
}

/** Per-finding identity, carried on an inline comment. */
export function findingMarker(fingerprint: string): string {
  return `<!-- acalys:finding:${fingerprint} -->`;
}

/**
 * Whether a provider-supplied body carries a given publication identity.
 *
 * Exact-substring rather than a regex over "some acalys marker", because the
 * question is always "is this *the* publication we are looking for?" — never
 * "does this look like one of ours?". The second question invites treating an
 * arbitrary user's comment as a publication of ours.
 */
export function carriesPublication(
  body: string | null | undefined,
  logicalKey: string,
): boolean {
  return (body ?? "").includes(publicationMarker(logicalKey));
}

/**
 * The publication identities present in a body, if any.
 *
 * For diagnosis only — reconciliation asks about a specific key. A body
 * carrying more than one identity is itself a signal worth surfacing rather
 * than resolving silently.
 */
export function extractPublicationKeys(
  body: string | null | undefined,
): readonly string[] {
  const found: string[] = [];
  const pattern = /<!--\s*acalys:publication:([^\s>]+?)\s*-->/g;
  for (const match of (body ?? "").matchAll(pattern)) {
    const key = match[1];
    if (key !== undefined) found.push(key);
  }
  return found;
}
