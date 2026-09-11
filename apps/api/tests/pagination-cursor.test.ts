import { describe, expect, it } from "vitest";

import {
  createPaginationCursorCodec,
  InvalidPaginationCursor,
  type PaginationCursorBinding,
} from "../src/pagination-cursor.js";

const ACTIVE = "phase3-pagination-active-secret-000000000000000000000000";
const PREVIOUS = "phase3-pagination-previous-secret-00000000000000000000000";
const ROW_ID = "018f4b20-7c00-7abc-8def-1234567890ab";
const BASE: PaginationCursorBinding = {
  organizationId: "organization-a",
  collection: "repositories",
};

function expectInvalid(run: () => unknown): void {
  expect(run).toThrow(InvalidPaginationCursor);
}

describe("Phase 3 opaque pagination cursor", () => {
  it("round-trips the row id without exposing it on the wire", () => {
    const codec = createPaginationCursorCodec([ACTIVE]);
    const cursor = codec.encode(BASE, ROW_ID);
    expect(cursor).toMatch(/^c1\.[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain(ROW_ID);
    expect(cursor.length).toBeLessThanOrEqual(256);
    expect(codec.decode(BASE, cursor)).toBe(ROW_ID);
  });

  it("rejects tampering", () => {
    const codec = createPaginationCursorCodec([ACTIVE]);
    const cursor = codec.encode(BASE, ROW_ID);
    const last = cursor.at(-1)!;
    const tampered = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expectInvalid(() => codec.decode(BASE, tampered));
  });

  it("binds the cursor to the organization", () => {
    const codec = createPaginationCursorCodec([ACTIVE]);
    const cursor = codec.encode(BASE, ROW_ID);
    expectInvalid(() =>
      codec.decode({ ...BASE, organizationId: "organization-b" }, cursor),
    );
  });

  it("binds the cursor to its collection", () => {
    const codec = createPaginationCursorCodec([ACTIVE]);
    const cursor = codec.encode(BASE, ROW_ID);
    expectInvalid(() =>
      codec.decode({ ...BASE, collection: "knowledge" }, cursor),
    );
  });

  it("binds nested collection cursors to the parent resource", () => {
    const codec = createPaginationCursorCodec([ACTIVE]);
    const binding: PaginationCursorBinding = {
      organizationId: "organization-a",
      collection: "pull_requests",
      resource: "repository-a",
    };
    const cursor = codec.encode(binding, ROW_ID);
    expectInvalid(() => codec.decode({ ...binding, resource: "repository-b" }, cursor));
  });

  it("binds filtered collection cursors to the canonical filter set", () => {
    const codec = createPaginationCursorCodec([ACTIVE]);
    const binding: PaginationCursorBinding = {
      organizationId: "organization-a",
      collection: "findings",
      resource: "review-a",
      query: "severity=high&category=&state=published",
    };
    const cursor = codec.encode(binding, ROW_ID);
    expectInvalid(() =>
      codec.decode({ ...binding, query: "severity=low&category=&state=published" }, cursor),
    );
  });

  it("decodes the previous secret generation during rolling rotation", () => {
    const oldCodec = createPaginationCursorCodec([PREVIOUS]);
    const rotatedCodec = createPaginationCursorCodec([ACTIVE, PREVIOUS]);
    const oldCursor = oldCodec.encode(BASE, ROW_ID);
    expect(rotatedCodec.decode(BASE, oldCursor)).toBe(ROW_ID);
  });

  it("rejects raw UUID cursors and invalid source row ids", () => {
    const codec = createPaginationCursorCodec([ACTIVE]);
    expectInvalid(() => codec.decode(BASE, ROW_ID));
    expect(() => codec.encode(BASE, "not-a-uuid")).toThrow(
      "PAGINATION_CURSOR_SOURCE_INVALID",
    );
  });

  it("fails startup configuration closed for weak or empty secret rings", () => {
    expect(() => createPaginationCursorCodec([])).toThrow("secret ring");
    expect(() => createPaginationCursorCodec(["too-short"])).toThrow(
      "Pagination cursor secrets",
    );
  });
});
