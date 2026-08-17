import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  readDeliveryHeaders,
  signWebhookBody,
  verifyWebhookSignature,
} from "../src/index.js";

const SECRET = "it's a secret to everybody";
const BODY = '{"action":"opened","number":412}';

/** The signature GitHub would send, computed independently of the verifier. */
const validSignature = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;

describe("Webhook signature verification", () => {
  it("accepts a signature GitHub would have produced", () => {
    // Computed with a bare `createHmac` above rather than with `signWebhookBody`,
    // so this cannot pass against a signer and verifier that agree with each
    // other and disagree with GitHub.
    expect(verifyWebhookSignature(SECRET, BODY, validSignature)).toEqual({
      ok: true,
    });
  });

  it("accepts raw bytes as well as a string", () => {
    // The gateway hands over a Buffer; tests are easier to read with strings.
    // Both must produce the same answer or one of the two paths is untested.
    expect(
      verifyWebhookSignature(SECRET, Buffer.from(BODY, "utf8"), validSignature)
        .ok,
    ).toBe(true);
  });

  it("agrees with its own signer", () => {
    expect(
      verifyWebhookSignature(SECRET, BODY, signWebhookBody(SECRET, BODY)).ok,
    ).toBe(true);
  });

  describe("rejects", () => {
    it("a body that differs by one byte", () => {
      const tampered = BODY.replace("412", "413");
      expect(verifyWebhookSignature(SECRET, tampered, validSignature)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    });

    it("a re-serialized body — the single most common integration bug", () => {
      // `JSON.parse` then `JSON.stringify` is not the identity function. It
      // reorders keys, drops whitespace, and re-escapes unicode. The signature
      // is over the ORIGINAL bytes, so this must fail — and a gateway that
      // "fixes" the failure by disabling verification opens the front door.
      const spaced = '{ "action": "opened", "number": 412 }';
      const reserialized = JSON.stringify(JSON.parse(spaced) as unknown);
      const signedOverOriginal = signWebhookBody(SECRET, spaced);

      expect(reserialized).not.toBe(spaced);
      expect(
        verifyWebhookSignature(SECRET, reserialized, signedOverOriginal).ok,
      ).toBe(false);
      // …while the original bytes verify.
      expect(
        verifyWebhookSignature(SECRET, spaced, signedOverOriginal).ok,
      ).toBe(true);
    });

    it("a signature made with a different secret", () => {
      const forged = signWebhookBody("wrong secret", BODY);
      expect(verifyWebhookSignature(SECRET, BODY, forged)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    });

    it("a missing header", () => {
      expect(verifyWebhookSignature(SECRET, BODY, undefined)).toEqual({
        ok: false,
        reason: "missing_signature",
      });
      expect(verifyWebhookSignature(SECRET, BODY, "")).toEqual({
        ok: false,
        reason: "missing_signature",
      });
    });

    it("an empty secret, rather than accepting a forgeable HMAC", () => {
      // With no secret the digest is computable by anyone who knows the
      // algorithm. A misconfigured deployment must fail loudly, not silently
      // accept every delivery.
      expect(verifyWebhookSignature("", BODY, validSignature)).toEqual({
        ok: false,
        reason: "empty_secret",
      });
    });

    it("an empty body", () => {
      // The HMAC of an empty body is a fixed value an attacker precomputes
      // once and replays forever.
      expect(
        verifyWebhookSignature(SECRET, "", signWebhookBody(SECRET, "")),
      ).toEqual({ ok: false, reason: "empty_body" });
    });

    describe("malformed signatures", () => {
      const digest = validSignature.slice("sha256=".length);

      const cases: readonly (readonly [string, string])[] = [
        ["no algorithm prefix", digest],
        ["the wrong algorithm", `sha1=${digest}`],
        ["an uppercase prefix", `SHA256=${digest}`],
        ["a truncated digest", `sha256=${digest.slice(0, 63)}`],
        ["an over-long digest", `sha256=${digest}0`],
        ["uppercase hex", `sha256=${digest.toUpperCase()}`],
        ["non-hex characters", `sha256=${"z".repeat(64)}`],
        ["an empty digest", "sha256="],
        ["only the prefix separator", "="],
      ];

      it.each(cases)("rejects %s", (_label, header) => {
        // Each is refused as malformed rather than reaching `timingSafeEqual`,
        // which throws on a length mismatch instead of returning false — a
        // thrown exception on the request path is a denial-of-service vector.
        expect(verifyWebhookSignature(SECRET, BODY, header)).toEqual({
          ok: false,
          reason: "malformed_signature",
        });
      });
    });
  });

  it("distinguishes failure reasons for logs, and they are not HTTP-facing", () => {
    // The gateway responds differently to a misconfigured hook and to a bad
    // digest — but the reason must never reach the response body, since it
    // tells an attacker how far they got.
    const missing = verifyWebhookSignature(SECRET, BODY, undefined);
    const wrong = verifyWebhookSignature(
      SECRET,
      BODY,
      signWebhookBody("x", BODY),
    );

    expect(missing.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    expect(missing).not.toEqual(wrong);
  });

  it("verifies a large body without truncating it", () => {
    // A 5 MB payload is within GitHub's limits. A verifier that hashed only a
    // prefix would accept a delivery whose tail was rewritten.
    const large = `{"data":"${"x".repeat(5_000_000)}"}`;
    const signature = signWebhookBody(SECRET, large);

    expect(verifyWebhookSignature(SECRET, large, signature).ok).toBe(true);
    expect(
      verifyWebhookSignature(SECRET, `${large.slice(0, -2)}!"}`, signature).ok,
    ).toBe(false);
  });

  it("is insensitive to where in the body a change occurs", () => {
    // Guards against a comparison that short-circuits: a change in the first
    // byte and one in the last must both be caught.
    const signature = signWebhookBody(SECRET, BODY);
    const first = `!${BODY.slice(1)}`;
    const last = `${BODY.slice(0, -1)}!`;

    expect(verifyWebhookSignature(SECRET, first, signature).ok).toBe(false);
    expect(verifyWebhookSignature(SECRET, last, signature).ok).toBe(false);
  });
});

describe("Delivery headers", () => {
  const headers = {
    [DELIVERY_HEADER]: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    [EVENT_HEADER]: "pull_request",
    [SIGNATURE_HEADER]: validSignature,
  };

  it("reads the three headers a delivery must carry", () => {
    expect(readDeliveryHeaders(headers)).toEqual({
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      event: "pull_request",
      signature: validSignature,
    });
  });

  it("rejects a delivery missing any of them", () => {
    for (const omit of [DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER]) {
      const partial = { ...headers };
      delete (partial as Record<string, unknown>)[omit];
      expect(readDeliveryHeaders(partial), omit).toBeUndefined();
    }
  });

  it("rejects a repeated header rather than guessing which was signed", () => {
    // Node surfaces duplicates as an array. Picking one would mean verifying a
    // different value than the one the attacker intended us to read.
    expect(
      readDeliveryHeaders({
        ...headers,
        [SIGNATURE_HEADER]: [validSignature, "x"],
      }),
    ).toBeUndefined();
  });

  it("bounds the delivery id, because it becomes an idempotency key", () => {
    // An unbounded key poisons the deduplication table; an unrestricted
    // character set reaches a database key with whatever it contains.
    expect(
      readDeliveryHeaders({ ...headers, [DELIVERY_HEADER]: "a".repeat(129) }),
    ).toBeUndefined();
    expect(
      readDeliveryHeaders({ ...headers, [DELIVERY_HEADER]: "id with spaces" }),
    ).toBeUndefined();
    expect(
      readDeliveryHeaders({ ...headers, [DELIVERY_HEADER]: "" }),
    ).toBeUndefined();
  });

  it("bounds the event name", () => {
    expect(
      readDeliveryHeaders({ ...headers, [EVENT_HEADER]: "Pull_Request" }),
    ).toBeUndefined();
    expect(
      readDeliveryHeaders({ ...headers, [EVENT_HEADER]: "../../etc/passwd" }),
    ).toBeUndefined();
  });
});
