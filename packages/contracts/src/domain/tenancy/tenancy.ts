/**
 * Tenancy and ownership (P0.txt §9, §70).
 *
 * The organization is the root of every ownership chain:
 *
 *     Organization
 *       ├── ProviderConnection*   (how it reaches GitHub/GitLab)
 *       ├── Repository*
 *       ├── Membership* ──> User
 *       ├── ReviewConfig*
 *       └── ReviewRun*
 *
 * The rule that makes this work in practice: **every tenant-bound aggregate
 * carries `organizationId` directly** (§9). It is redundant — a finding's
 * organization is derivable through run → repository → organization — and the
 * redundancy is the point. Authorization, row-level isolation, quota
 * accounting, and tenant deletion all need the tenant *now*, on the row in
 * hand, without a three-table join. A missed join in one query is a
 * cross-tenant data leak; a denormalized column cannot be forgotten.
 *
 * It also makes deletion tractable (§70): "remove everything belonging to this
 * organization" is one predicate per table.
 */

import { z } from "zod";
import {
  membershipIdSchema,
  organizationIdSchema,
  userIdSchema,
  type MembershipId,
  type OrganizationId,
  type UserId,
} from "../identity/ids.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";

/**
 * A tenant.
 *
 * Note what is absent: no provider field, no installation id, no GitHub
 * organization login. An organization may connect several providers at once —
 * a GitHub org and a self-hosted GitLab group under one billing entity — so
 * provider linkage lives in `ProviderConnection`, one row per link, rather
 * than being flattened into the tenant (§10).
 */
export interface Organization {
  readonly id: OrganizationId;
  /** URL-safe unique key within Acalys, e.g. `acme-engineering`. */
  readonly slug: string;
  /** Human-facing name. */
  readonly displayName: string;
  readonly lifecycle: OrganizationLifecycle;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * `suspended` is distinct from `deleted` on purpose: a suspended tenant stops
 * accruing work but keeps its data, which is what billing lapses and abuse
 * investigations need. `deleted` marks a tenant whose purge is pending (§70).
 */
export const ORGANIZATION_LIFECYCLES = [
  "active",
  "suspended",
  "deleted",
] as const;

export type OrganizationLifecycle = (typeof ORGANIZATION_LIFECYCLES)[number];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const organizationSchema = z.strictObject({
  id: organizationIdSchema,
  slug: z.string().min(1).max(TEXT_LIMITS.identifier).regex(SLUG_PATTERN, {
    error:
      "Slug must be lowercase alphanumeric segments joined by '-', e.g. acme-engineering",
  }),
  displayName: z.string().min(1).max(TEXT_LIMITS.title),
  lifecycle: z.enum(ORGANIZATION_LIFECYCLES),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * A person with an Acalys account.
 *
 * Distinct from {@link HumanActor}: a `User` is a stored entity with a
 * lifecycle, while an actor is an attribution stamped onto an event. Most PR
 * authors are actors and never become users.
 *
 * `email` is present because authentication needs it, and it is the one PII
 * field in the domain. It is deliberately **not** part of `Actor`, so it never
 * reaches an event, a published comment, or a queue payload (§63, §70).
 */
export interface User {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const userSchema = z.strictObject({
  id: userIdSchema,
  email: z.email().max(TEXT_LIMITS.identifier),
  displayName: z.string().min(1).max(TEXT_LIMITS.title),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * Roles, coarse by design.
 *
 * Fine-grained permissions belong to a policy engine, not to the tenancy
 * model. Three roles cover Phase 0's needs — who may change configuration, who
 * may only read — and adding a fourth later is cheaper than unwinding a
 * permission matrix baked into the domain.
 */
export const MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** Links a user to an organization. The many-to-many join, made explicit. */
export interface Membership {
  readonly id: MembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const membershipSchema = z.strictObject({
  id: membershipIdSchema,
  organizationId: organizationIdSchema,
  userId: userIdSchema,
  role: z.enum(MEMBERSHIP_ROLES),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * The tenant an operation runs under (§9).
 *
 * Threaded through application services and repository ports so that data
 * access is scoped by construction rather than by remembering to add a
 * `WHERE organization_id = …` to each query. A port method that takes a
 * `TenantContext` cannot be called without answering "for which tenant?".
 */
export interface TenantContext {
  readonly organizationId: OrganizationId;
}

export const tenantContextSchema = z.strictObject({
  organizationId: organizationIdSchema,
});

/** True when both refer to the same tenant. */
export function sameTenant(left: TenantContext, right: TenantContext): boolean {
  return left.organizationId === right.organizationId;
}
