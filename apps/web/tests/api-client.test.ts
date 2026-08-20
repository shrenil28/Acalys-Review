import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/lib/api/client.js";
import { listReviewFindings } from "../src/lib/api/reviewFindings.js";
import { toFindingViews } from "../src/lib/findings.js";
import { dto } from "./fixtures/findings.js";

/** A fetch that answers with a body, without a network. */
const respondWith = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof globalThis.fetch;

const client = (fetchImpl: typeof globalThis.fetch) =>
  createApiClient({ baseUrl: "https://api.test", fetch: fetchImpl });

/**
 * The whole seam, with only the network faked.
 *
 * The point is not that the adapter maps correctly — `findings.test.ts` covers
 * that. It is that a **failed request cannot become an empty result** anywhere
 * along the path, which is the frontend restatement of a rule the backend
 * already enforces: a verifier outage must not read as a clean review.
 *
 * Every one of these produces "nothing to render" to a component that only
 * checks for absence. Only one of them means it.
 */
describe("A failed request never becomes an empty result", () => {
  it("returns findings when the server answers correctly", async () => {
    const result = await listReviewFindings(
      client(respondWith({ items: [dto({ id: "a" }), dto({ id: "b" })] })),
      "review-1",
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(toFindingViews(result.value.items).map((v) => v.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("distinguishes a successful empty review from every failure", async () => {
    // ── The invariant ─────────────────────────────────────────────────────
    //
    // A review that genuinely found nothing is a SUCCESS, and the product says
    // so — "no actionable findings" is a first-class outcome the backend
    // defends. It must be reachable only from an actual answer.
    const empty = await listReviewFindings(
      client(respondWith({ items: [] })),
      "review-1",
    );
    expect(empty).toEqual({ kind: "ok", value: { items: [] } });

    const failures = [
      await listReviewFindings(
        client(vi.fn().mockRejectedValue(new Error("offline")) as never),
        "review-1",
      ),
      await listReviewFindings(client(respondWith({}, 500)), "review-1"),
      await listReviewFindings(client(respondWith({}, 404)), "review-1"),
      await listReviewFindings(
        client(respondWith({ items: [{ id: "broken" }] })),
        "review-1",
      ),
    ];

    // Not one of them is `ok`. A component that switches on `kind` cannot
    // reach the empty-success branch from any of these.
    expect(failures.map((f) => f.kind)).toEqual([
      "transport",
      "rejected",
      "rejected",
      "contract",
    ]);
  });

  it("separates a broken network from a broken contract", async () => {
    // Different remedies: one is a network to investigate, the other is a
    // server and a client that disagree about what they are exchanging.
    const transport = await listReviewFindings(
      client(vi.fn().mockRejectedValue(new Error("DNS failure")) as never),
      "r",
    );
    expect(transport).toMatchObject({ kind: "transport" });

    const notJson = await listReviewFindings(
      client(
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("Unexpected token")),
        }) as never,
      ),
      "r",
    );
    expect(notJson).toMatchObject({ kind: "contract" });
  });

  it("rejects a response carrying a lifecycle the contract forbids", async () => {
    // The exhaustive adapter downstream promises to handle every declared
    // state. Without validation here, a server sending an undeclared one would
    // reach it and throw — the guarantee enforcing a promise the data never
    // made.
    const result = await listReviewFindings(
      client(respondWith({ items: [{ ...dto({}), lifecycle: "invented" }] })),
      "r",
    );
    expect(result.kind).toBe("contract");
  });

  it("names where validation failed, and never what was in it", async () => {
    // A validation failure on a credential-bearing field would otherwise print
    // the credential into an error surface or a log.
    const result = await listReviewFindings(
      client(respondWith({ items: [{ ...dto({}), title: 12345 }] })),
      "r",
    );
    expect(result.kind).toBe("contract");
    if (result.kind !== "contract") throw new Error("unreachable");
    expect(result.detail).toContain("items.0.title");
    expect(result.detail).not.toContain("12345");
  });

  it("sends credentials from the boundary, not from components", async () => {
    const fetchImpl = respondWith({ items: [] });
    await listReviewFindings(
      createApiClient({
        baseUrl: "https://api.test",
        fetch: fetchImpl,
        authorization: () => "Bearer test-token",
      }),
      "review-1",
    );

    const [, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-token",
    );
  });
});

/**
 * The invariant, stated where it can be checked.
 *
 * Four of these produce zero rows. Only one of them means the code is clean,
 * and the page must be able to tell them apart — which it can only do if the
 * result type keeps them apart all the way to the component.
 */
describe("Zero rows has more than one cause", () => {
  it("is reachable as a success only from an actual answer", async () => {
    const outcomes = {
      clean: await listReviewFindings(
        client(respondWith({ items: [] })),
        "r",
      ),
      offline: await listReviewFindings(
        client(vi.fn().mockRejectedValue(new Error("offline")) as never),
        "r",
      ),
      serverError: await listReviewFindings(client(respondWith({}, 503)), "r"),
      malformed: await listReviewFindings(
        client(respondWith({ items: "not an array" })),
        "r",
      ),
      // Every finding superseded: a real answer, and nothing to show. It is
      // still a success, and the page should say "none found" — because
      // nothing IS found.
      allSuperseded: await listReviewFindings(
        client(
          respondWith({
            items: [dto({ id: "a", lifecycle: "superseded" })],
          }),
        ),
        "r",
      ),
    };

    expect(outcomes.clean.kind).toBe("ok");
    expect(outcomes.allSuperseded.kind).toBe("ok");
    expect(outcomes.offline.kind).toBe("transport");
    expect(outcomes.serverError.kind).toBe("rejected");
    expect(outcomes.malformed.kind).toBe("contract");

    // The two successes render zero rows for the same, honest reason.
    if (outcomes.allSuperseded.kind !== "ok") throw new Error("unreachable");
    expect(toFindingViews(outcomes.allSuperseded.value.items)).toEqual([]);
  });
});
