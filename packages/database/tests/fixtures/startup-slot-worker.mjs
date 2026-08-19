/**
 * One process that takes a startup slot and records the interval it occupied.
 *
 * Intervals, not slot counts. An earlier version sampled how many slot
 * directories were held, which a limiter that admits everyone reads as ZERO —
 * so the broken implementation scored better than the working one. Overlap is
 * computed from wall-clock intervals, which is true regardless of how the
 * limiter is implemented or whether it engages at all.
 */
import { appendFileSync } from "node:fs";

const [, , slotsRaw, ledger, root] = process.argv;
const slots = Number(slotsRaw);

const { withStartupSlot } = await import(
  new URL("../startup-limit.ts", import.meta.url).href
);

await withStartupSlot(
  slots,
  async () => {
    const entered = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 250));
    appendFileSync(ledger, `${String(entered)},${String(Date.now())}\n`);
  },
  root,
);
