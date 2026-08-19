import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { heldSlots, withStartupSlot } from "./startup-limit.js";

const run = promisify(execFile);

const WORKER = fileURLToPath(
  new URL("./fixtures/startup-slot-worker.mjs", import.meta.url),
);

/**
 * The property the first limiter could not have satisfied.
 *
 * It was a module-level counter, and vitest gives each test file its own fork
 * that runs one file at a time — so it never blocked. Three green runs followed
 * and were read as evidence it worked; they were evidence that Docker had been
 * restarted.
 *
 * So the limit is asserted across real, separate processes. A probe that ran
 * inside one process would pass against the broken version too.
 */
describe("Startup slots are limited machine-wide", () => {
  // Its own lock root, never the machine's.
  //
  // Sharing it starved a real Postgres suite of permits and made the
  // released-slot assertion read a slot an unrelated suite was holding. A test
  // for a machine-wide lock must not contend on the machine's lock.
  let root: string;
  let ledger: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "acalys-slot-root-"));
  });

  afterEach(() => {
    if (ledger !== undefined) rmSync(ledger, { force: true });
    rmSync(root, { recursive: true, force: true });
    ledger = undefined;
  });

  it("never lets more than the limit run at once, across processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acalys-slot-probe-"));
    ledger = join(directory, "observed.txt");
    writeFileSync(ledger, "");

    // Eight simultaneous processes against a limit of two. Enough that a
    // broken limiter cannot pass by luck: unbounded, all eight overlap.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        run(process.execPath, [
          "--experimental-strip-types",
          WORKER,
          "2",
          ledger ?? "",
          root,
        ]).catch(() => undefined),
      ),
    );

    const intervals = readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(",").map(Number) as [number, number]);

    // Fail-closed: an empty ledger would satisfy every bound below.
    expect(intervals.length, "no worker recorded an interval").toBe(8);

    // Peak overlap, from wall-clock intervals rather than from how many slot
    // directories were held. The first version counted held slots, which a
    // limiter admitting everyone reads as ZERO — so the broken implementation
    // scored better than the working one, and the probe written to catch it
    // would have passed it.
    const events = intervals
      .flatMap(([start, end]) => [
        { at: start, delta: 1 },
        { at: end, delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);

    let concurrent = 0;
    let peak = 0;
    for (const event of events) {
      concurrent += event.delta;
      peak = Math.max(peak, concurrent);
    }

    expect(peak, `peak overlap across 8 processes`).toBeLessThanOrEqual(2);
  }, 120_000);

  it("releases the slot when the work throws", async () => {
    // A startup that fails must not wedge every later run. This is the case the
    // limiter exists for — the runs where something dies abruptly.
    await expect(
      withStartupSlot(2, () => Promise.reject(new Error("boom")), root),
    ).rejects.toThrow("boom");
    expect(heldSlots(2, root)).toBe(0);
  });

  it("actually serialises, rather than admitting everyone at once", async () => {
    // Guards the opposite failure: a limiter that always fails open would pass
    // the bound above whenever the machine happened to be slow.
    const order: string[] = [];
    const hold = (name: string) =>
      withStartupSlot(
        1,
        async () => {
          order.push(`${name}:in`);
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push(`${name}:out`);
        },
        root,
      );

    await Promise.all([hold("a"), hold("b")]);

    // With one slot, neither may enter before the other has left.
    expect(order).not.toEqual(["a:in", "b:in", "a:out", "b:out"]);
    expect(order.indexOf("a:out")).toBeLessThan(order.indexOf("b:in"));
  }, 30_000);
});
