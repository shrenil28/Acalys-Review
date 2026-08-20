import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "../src/lib/clipboard.js";

/**
 * The consequence, not the lint rule.
 *
 * `no-floating-promises` passing is not the point. The defect was that three
 * call sites did this:
 *
 * ```ts
 * navigator.clipboard?.writeText(secret);
 * toast({ title: "Secret copied" });
 * ```
 *
 * and the toast fired whether or not the write succeeded. A user in an insecure
 * context, or with clipboard permission denied, was told their secret had been
 * copied and pasted whatever was there before.
 *
 * These tests assert the property the call sites depend on: a failed copy is
 * reported as a failed copy.
 */
describe("Copying to the clipboard reports whether it worked", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  const withClipboard = (clipboard: unknown): void => {
    Object.defineProperty(globalThis, "navigator", {
      value: clipboard === undefined ? {} : { clipboard },
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "navigator");
    } else {
      Object.defineProperty(globalThis, "navigator", original);
    }
  });

  it("reports success when the write resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard({ writeText });

    expect(await copyToClipboard("secret")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("secret");
  });

  it("reports failure when the write rejects", async () => {
    // Permission denied, or the document not focused. The original code
    // dropped this rejection and the UI announced success.
    withClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
    });

    expect(await copyToClipboard("secret")).toBe(false);
  });

  it("reports failure when there is no Clipboard API at all", async () => {
    // `navigator.clipboard` is undefined outside a secure context. Optional
    // chaining made this silently look like success — the write simply never
    // happened, and nothing said so.
    withClipboard(undefined);

    expect(await copyToClipboard("secret")).toBe(false);
  });

  it("never rejects, so a caller cannot reintroduce the bug", async () => {
    // The contract that makes `void copy(…).then(…)` safe at the call sites:
    // there is no rejection path left to forget to handle.
    withClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await expect(copyToClipboard("x")).resolves.toBe(false);
  });
});
