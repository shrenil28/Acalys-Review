-- The publication ledger, completed by what GitHub actually does.
--
-- 0003 created `publication_intents` from a design sketch. P1-E.3 then ran two
-- experiments against a live GitHub App on a real pull request, and the sketch
-- was wrong in ways no amount of reading the API docs would have revealed. This
-- migration is those corrections, and nothing else.
--
-- Full evidence: docs/review/phase-1/e3-experiment.md
--
-- # What the experiments changed
--
-- **A publication is bound to a revision, not to a pull request.** Every review
-- GitHub returned carried a `commit_id`, and every inline comment carried both
-- `commit_id` and `original_commit_id`. A ledger row that cannot say which
-- revision it published against cannot tell "already published" from "published
-- against the code as it was three pushes ago".
--
-- **One provider reference is not enough.** GitHub returns a numeric `id`, a
-- global `node_id`, and the `commit_id` it anchored to. The numeric id is the
-- handle for submitting; the node id is the stable global identity; the commit
-- id is what content verification has to be relative to. Storing only one and
-- calling it "the reference" loses the other two.
--
-- **`published` had no evidence attached.** The state said a worker believed
-- the effect existed. After E.3 there is a defined meaning for confirmed —
-- the effect was *observed* in provider state, submitted, carrying the expected
-- marker — so the row now has to carry when that observation happened. Belief
-- and evidence are different facts, and only the second entails `completed`.
--
-- **A blind retry is dangerous in exactly one window.** GitHub refuses a second
-- PENDING review (422, "User can only have one pending review per pull
-- request") but places no constraint once a review is submitted. So the
-- provider protects the create window and nothing else, and reconciliation is
-- load-bearing after submission. `reconciled_at` records that a lookup actually
-- happened, so "we retried without looking" is visible in the data rather than
-- inferred from an incident.
--
-- # Why the table keeps its name
--
-- `publication_intents`, not `publication_effects`. The ledger records what the
-- system *undertook to make true*, which is knowable at write time; whether the
-- effect exists is not, and `unknown` is a first-class state precisely because
-- of that. Naming the table after the effect would quietly assert the thing the
-- schema exists to admit it cannot know.

-- The provider a row must be reconciled against.
--
-- Denormalized rather than joined through review_runs → review_requests →
-- review_targets. A reconciler's first decision is which adapter to use, and
-- making that require a three-table join means the recovery path depends on
-- rows that a partially-failed run may not have written yet.
ALTER TABLE publication_intents
    ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'
        CHECK (provider IN ('github', 'gitlab'));

ALTER TABLE publication_intents ALTER COLUMN provider DROP DEFAULT;

-- The review target and the revision the publication was made against.
--
-- `revision_id` is the correction the experiment forced: without it, two runs
-- against different pushes of the same pull request are indistinguishable in
-- the ledger, and "is this already published?" silently means "was anything
-- ever published here?".
ALTER TABLE publication_intents
    ADD COLUMN pull_request_id UUID REFERENCES pull_requests(id),
    ADD COLUMN revision_id     UUID REFERENCES pull_request_revisions(id);

-- Provider identity, as three distinct facts rather than one overloaded string.
ALTER TABLE publication_intents
    ADD COLUMN provider_node_id   TEXT,
    ADD COLUMN provider_commit_id TEXT;

-- When the effect was OBSERVED in provider state, not when a worker believed it
-- had succeeded. `completed` entails this column being set for every required
-- intent; a response that was received but never verified does not qualify.
ALTER TABLE publication_intents
    ADD COLUMN confirmed_at TIMESTAMPTZ;

-- When provider state was last enumerated for this row. Distinguishes "retried
-- after looking" from "retried blindly", which is the difference between
-- converging and publishing a duplicate.
ALTER TABLE publication_intents
    ADD COLUMN reconciled_at TIMESTAMPTZ;

-- Retryable and permanent failures need different handling, and collapsing them
-- is how a permanent 403 becomes an infinite retry loop.
ALTER TABLE publication_intents
    ADD COLUMN last_error_class TEXT
        CHECK (last_error_class IN ('retryable', 'permanent', 'ambiguous')),
    ADD COLUMN next_attempt_at TIMESTAMPTZ;

-- A lease, so two publisher workers cannot attempt the same effect at once.
-- Local races are made safe locally; the provider is not asked to arbitrate.
ALTER TABLE publication_intents
    ADD COLUMN claimed_by  TEXT,
    ADD COLUMN claimed_until TIMESTAMPTZ;

-- # Invariants the schema enforces, rather than the application remembering
--
-- `published` means observed. Without this, a worker that received a 200 and
-- crashed before verifying could leave a row claiming publication with no
-- evidence, and the `completed` entailment would be satisfiable by belief.
ALTER TABLE publication_intents
    ADD CONSTRAINT publication_intents_published_is_confirmed
        CHECK (
            state <> 'published'
            OR (provider_reference IS NOT NULL AND confirmed_at IS NOT NULL)
        );

-- `unknown` is only reachable after an attempt. A row that has never been
-- attempted cannot be ambiguous — it is `planned`, and conflating the two is
-- how a never-attempted effect gets reconciled against provider state that
-- could not possibly contain it.
ALTER TABLE publication_intents
    ADD CONSTRAINT publication_intents_unknown_was_attempted
        CHECK (state <> 'unknown' OR attempts > 0);

-- The logical key is globally unique, not merely unique within a run.
--
-- It already embeds the tenant, provider, target, revision and run, so a
-- collision across runs means the key generator dropped one of those scopes —
-- the exact defect that would make two different publications look like one
-- retry of the same publication. Enforced where it cannot be forgotten.
CREATE UNIQUE INDEX publication_intents_logical_key_uq
    ON publication_intents (logical_key);

-- Reconciliation's due queue: unsettled rows whose backoff has elapsed.
CREATE INDEX publication_intents_due_idx
    ON publication_intents (next_attempt_at)
    WHERE state IN ('planned', 'attempting', 'unknown');

-- Finding every row a given provider review carries, which is how a recovered
-- review id is matched back to the ledger.
CREATE INDEX publication_intents_provider_reference_idx
    ON publication_intents (provider, provider_reference)
    WHERE provider_reference IS NOT NULL;
