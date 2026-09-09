# Phase 2 evaluation epoch contract

**Status:** FROZEN before opening any Phase 2 holdout.

The Phase 1 epoch rules remain authoritative. Phase 2 creates a new epoch only
from a frozen source tree and frozen prompt/model-routing configuration.

Required report fields for historical, development and sealed-holdout buckets:

- true positives / eligible positives;
- published false positives;
- published precision and recall;
- false positives per clean PR;
- natural-FP replay publications;
- prompt/input/output/cached tokens;
- model cost per review;
- p50 and p95 review latency;
- count of failed, unknown and schema-invalid model interactions.

The sealed holdout is opened once. Per-case outcomes may not be inspected while
tuning. A holdout that publishes any new false positive fails the epoch even if
recall improves. The next experiment must use a newly specified checkpoint and
a new sealed holdout.
