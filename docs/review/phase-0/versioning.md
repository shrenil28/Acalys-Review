# Versioning

Two version schemes, deliberately independent.

| Scheme          | Question it answers                                                | Where it lives           |
| --------------- | ------------------------------------------------------------------ | ------------------------ |
| `schemaVersion` | can this build read that stored row / queue message?               | a field on durable roots |
| API version     | will this response still fit the client that shipped last quarter? | the URL (`/api/v1`)      |

The independence is the point. A worker refactor that bumps a domain `schemaVersion` must
be **invisible** to `apps/web`, because the UI never sees domain types — only DTOs, whose
compatibility is governed by the API version. That is what lets workers evolve and scale
without touching frontend contracts.

---

## Who carries `schemaVersion` (§7)

Durable or transported **roots** only:

```
ReviewTarget      ReviewRequest    ReviewRun       ChangeManifest
Evidence          CandidateFinding ReviewFinding   ReviewSummary
ReviewConfig      ReviewConfigSnapshot
DomainEvent       Command
```

Nested value objects version **with their parent**. A `SourceLocation` carrying its own
version would imply it can evolve independently of the finding that contains it, and would
force every consumer to handle a matrix of parent/child version pairs that never occurs in
practice.

Integers from `1`. Not semver: there is no "patch" for a stored shape — either this build
understands the row or it does not.

---

## Reading an unknown version

Every versioned schema **rejects** a version above what the build understands:

```ts
schemaVersion: z.number().int().positive().max(REVIEW_RUN_SCHEMA_VERSION, {
  error: "Unsupported ReviewRun schemaVersion; this build understands up to 1",
});
```

Rejecting is deliberate, and the alternative is worse. A build that ignored an unknown
version would parse a v2 row with v1 rules, drop the fields it does not know about, and
then _write it back_ — silently destroying data written by a newer deployment. That is the
classic rolling-deploy corruption, and it is invisible until someone notices missing
fields days later.

Failing loudly means a mixed-version fleet produces errors on the old nodes, which is
noisy, obvious, and recoverable.

---

## Evolving a contract

**Additive** — a new optional field, a new enum member in an _open_ set:

- No version bump. Old readers ignore the field; `undefined` already means absent (§57).
- A new value in a closed union is **not** additive: consumers switch exhaustively on
  those, and adding one breaks them by design (§85).

**Breaking** — removing a field, changing a type, tightening a constraint, adding a
required field:

1. Bump `schemaVersion`.
2. Raise the schema's `max()`.
3. Write a migration or a reader that accepts both versions.
4. Regenerate the JSON Schema artifacts (`npm run schemas:generate`).

Step 4 is enforced: `npm run schemas:check` fails CI if the generated artifacts and the Zod
source disagree.

---

## Closed unions versus open identifiers (§79, §80)

```
closed union        ReviewRunState, FindingSeverity, FindingCategory,
                    EvidenceType, DomainEventType, CommandType
open identifier     tool ids, check ids, rule ids, issue keys, learning ids
```

A closed union is a **platform invariant** a consumer must be able to switch over
exhaustively. An open identifier is extensible by definition — first-party checks
(`acalys.premerge.title`) sit alongside tenant-authored ones
(`org.acme.check.no-direct-sql`), and adding one must never require a schema release.

Open identifiers are validated, not free-form:

```
^[a-z0-9]+(?:[-.][a-z0-9]+)*$    ≤ 128 characters
```

Namespaced so ownership is visible in the value itself. `acalys.*` is the platform's;
`org.<tenant>.*` is a tenant's; `tool.<name>` is an analyzer's.

---

## Generated artifacts (§101)

```
packages/contracts/generated/schemas/
├── manifest.json
├── domain/*.schema.json
├── api/*.schema.json
└── internal/*.schema.json
```

Regenerate with `npm run schemas:generate`; CI runs `npm run schemas:check`.

Four properties, each deliberate:

- **Reproducible.** Serialized through `canonicalJson`, so key order cannot vary between
  machines or Node versions. Without it the drift check would fail on reorderings that
  changed nothing.
- **Stably named.** One file per contract. A single bundled file would make every diff
  touch every contract.
- **Drift-checked.** `--check` reports missing, changed, _and extra_ files. The last
  matters: deleting a contract without regenerating leaves an orphan artifact describing
  something the platform no longer produces.
- **Versioned.** Each file carries `x-acalys-schema-version`, so a consumer knows which
  revision it describes.

### Generation direction

Generation uses `io: "input"`, and the reason is worth recording because the intuitive
choice is wrong.

Every branded id and timestamp ends in a `.transform()`. Branding is a TypeScript-only
device with no JSON counterpart, so on the _output_ side Zod has nothing representable to
emit:

```
io: "output"   "userId": {}                                        ← accepts 42
io: "input"    "userId": { "type": "string", "pattern": "^[0-9a-f]{8}-…" }
```

An artifact whose whole purpose is letting a non-TypeScript consumer validate a payload
must not be the permissive one. Nothing is lost by taking the input side: every transform
in these contracts either brands or normalizes a string, so input and output describe the
same JSON.

This was a real defect, caught by the test that walks every generated artifact for
unconstrained properties. The files looked fine; every one was valid JSON Schema, and the
drift check was green.

---

## The API surface

DTO changes are governed by the **API version**, not by `schemaVersion`. No DTO carries a
`schemaVersion` field — the version is the URL.

Inbound and outbound differ (§56):

```
request bodies    z.object        unknown keys stripped — a client built against a
                                  newer build is not rejected by an older server
responses         z.strictObject  the platform produces them; an unexpected key is
                                  a bug, not forward compatibility
```

A breaking DTO change means `/api/v2`, served alongside `/api/v1` until clients migrate.
`@acalys/api-client` is generated from the route manifest, so a route that changes shape
changes the client by definition — and a route that is _removed_ becomes a compile error at
every call site rather than a 404 at runtime.
