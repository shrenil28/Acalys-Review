/**
 * Shared shapes for the public API (P0.txt §76).
 *
 * §76's rule: "do not automatically expose internal objects directly over the
 * public API… but avoid pointless duplication." Both halves matter, and the
 * line this package draws is:
 *
 * - A DTO is **projected** from a domain type by an explicit `toDto()`, never
 *   hand-maintained in parallel. Parallel definitions drift, and the drift is
 *   only discovered by a user seeing a field that stopped being populated.
 * - A DTO **omits** what the caller has no business knowing: `attempt`,
 *   `configSnapshotId`, queue state, worker identity, sandbox leases, raw
 *   model output, idempotency keys. That omission is asserted by a test that
 *   walks every DTO schema, not by review discipline.
 *
 * # Why versioning here is separate from `schemaVersion`
 *
 * A domain type carries `schemaVersion` for *durable storage* — can this build
 * read that stored row? The API carries `/v1` in its path for *compatibility* —
 * will this response still fit the client that shipped last quarter? They move
 * independently, and that independence is the point: a worker refactor that
 * bumps a domain `schemaVersion` must be invisible to `apps/web`.
 *
 * So no DTO carries `schemaVersion`. The version is the URL.
 *
 * # Inbound is lenient, outbound is strict (§56)
 *
 * Request bodies are parsed with `z.object` (unknown keys stripped), so a
 * client that sends a field a newer build added is not rejected by an older
 * server. Responses are built with `z.strictObject`, because the platform
 * produces them and an unexpected key there is a bug, not forward
 * compatibility.
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../../domain/primitives/limits.js";
import { RETRYABILITIES } from "../../domain/errors/errors.js";

/** The public API version. Part of the URL, not of any payload. */
export const API_VERSION = "v1" as const;

/**
 * An identifier as it appears on the wire.
 *
 * Deliberately a plain string, not a branded id. Branding is a compile-time
 * guarantee inside the platform; over HTTP every id arrives as text, and
 * exporting brands to `apps/web` would make the UI carry domain machinery it
 * has no use for. The API layer's job is to be *boring* for its consumer.
 */
export const apiIdSchema = z.string().min(1).max(TEXT_LIMITS.identifier);

/** A timestamp as it appears on the wire: RFC 3339 UTC, milliseconds, `Z`. */
export const apiTimestampSchema = z.string().min(1).max(64);

/**
 * The error body every failing response returns.
 *
 * Mirrors {@link SerializedError} and, like it, carries **no** stack, cause,
 * or raw provider payload (§63, §125). `retryability` is included because it
 * is the one piece of internal knowledge a client genuinely needs: it decides
 * whether retrying the request could possibly help.
 */
export interface ApiErrorDto {
  readonly code: string;
  readonly message: string;
  readonly retryability: (typeof RETRYABILITIES)[number];
  /** Field-level detail for a validation failure. */
  readonly fields?: readonly ApiFieldErrorDto[] | undefined;
}

export interface ApiFieldErrorDto {
  /** Dotted path into the request body, e.g. `target.pullRequestId`. */
  readonly path: string;
  readonly message: string;
}

export const apiFieldErrorDtoSchema = z.strictObject({
  path: z.string().max(TEXT_LIMITS.identifier),
  message: z.string().min(1).max(TEXT_LIMITS.summary),
});

export const apiErrorDtoSchema = z.strictObject({
  code: z.string().min(1).max(TEXT_LIMITS.identifier),
  message: z.string().min(1).max(TEXT_LIMITS.summary),
  retryability: z.enum(RETRYABILITIES),
  fields: z.array(apiFieldErrorDtoSchema).max(100).optional(),
});

/**
 * Cursor pagination.
 *
 * Cursor rather than offset because these lists change while they are being
 * read: a review completes, a finding is published. With offsets, a row
 * inserted at the top shifts every page and the reader silently skips an item
 * — precisely the item that just became interesting.
 *
 * The cursor is **opaque** by contract. A client that parses it couples itself
 * to the server's paging strategy, and changing that strategy would then be a
 * breaking API change.
 */
export interface PageDto<TItem> {
  readonly items: readonly TItem[];
  /** Pass as `cursor` to fetch the next page. Absent on the last page. */
  readonly nextCursor?: string | undefined;
}

export function pageDtoSchema<TItemSchema extends z.ZodType>(
  item: TItemSchema,
) {
  return z.strictObject({
    items: z.array(item).max(MAX_PAGE_SIZE),
    nextCursor: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  });
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Query parameters every list endpoint accepts. */
export interface PageQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const pageQuerySchema = z.object({
  cursor: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  // Coerced: query strings arrive as text, and a client should not have to
  // know that `?limit=50` is a number on the other side.
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});
