# Examples

The canonical fixtures §83 asks for live at
[`packages/contracts/tests/fixtures/`](../../../../packages/contracts/tests/fixtures/),
not here.

Copying them into the docs would create a second set that drifts the moment a contract
changes — and the copies would be the ones nobody validates. The originals are parsed
against their schemas on every test run, round-tripped through JSON, and checked to fail
when a required field is removed, so a stale fixture breaks the build instead of quietly
misleading a reader.

| Fixture                          | Contract               |
| -------------------------------- | ---------------------- |
| `github-pr-review-target.json`   | `ReviewTarget`         |
| `gitlab-mr-review-target.json`   | `ReviewTarget`         |
| `local-working-tree-target.json` | `ReviewTarget`         |
| `review-request.json`            | `ReviewRequest`        |
| `review-run.json`                | `ReviewRun`            |
| `change-manifest.json`           | `ChangeManifest`       |
| `candidate-finding.json`         | `CandidateFinding`     |
| `verified-finding.json`          | `ReviewFinding`        |
| `static-analysis-evidence.json`  | `Evidence`             |
| `runtime-evidence.json`          | `Evidence`             |
| `config-snapshot.json`           | `ReviewConfigSnapshot` |
| `domain-event.json`              | `DomainEvent`          |

The first two describe **one change, on one repository, at one pair of commits**, as GitHub
and GitLab each report it. `fixtures.test.ts` asserts they normalize to equal domain
structures once provider identity is removed — the proof that §1's boundary holds. They
differ only where they must:

```
GitHub   externalId  "2145998877"
GitLab   externalId  "gid://gitlab/MergeRequest/774411"
```

Generated JSON Schema for every contract is in
[`packages/contracts/generated/schemas/`](../../../../packages/contracts/generated/schemas/).
