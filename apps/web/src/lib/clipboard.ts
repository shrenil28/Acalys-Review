/**
 * Copying to the clipboard, with the failure actually reported.
 *
 * Three call sites did this:
 *
 * ```ts
 * navigator.clipboard?.writeText(secret);
 * toast({ title: "Secret copied" });
 * ```
 *
 * `writeText` returns a promise, and nothing observed it. When the write fails
 * — an insecure context, a denied permission, a document without focus, or no
 * Clipboard API at all — the rejection is dropped and the toast says the secret
 * was copied. The user pastes whatever was on the clipboard before.
 *
 * That is the shape of defect this whole codebase has spent months making
 * impossible on the server: an operation reporting success it never verified.
 *
 * # Never rejects
 *
 * The result is a boolean rather than a thrown error, so a caller cannot
 * reintroduce the same bug by forgetting a `catch`. `void copy(…).then(…)` is
 * then enough, and there is no rejection path left to drop.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Optional chaining because `navigator.clipboard` is undefined outside a
  // secure context — the case the original code silently treated as success.
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) return false;

  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
