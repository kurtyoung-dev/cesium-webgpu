# Maintainer rulings — 2026-09-07

Recorded from the maintainer's explicit reply `1. A / 2. A / 3. A` to the
three-option decision brief. These are bounded approvals, not passing results.

## R-2026-09-07-1 — GodRay exact-message assertion correction

Approve option1A: change only the failing ownership-refusal assertion in
`Tools/visual-regression/c13-42-reproduction-harness.spec.mjs` to match the exact
existing Error.message property. Preserve production behavior, all29 tests,
render/frame non-advance and later assertions. Independently review and rerun the
complete29-test suite against frozen inputs. Preserve HRN29-SOURCE-CHECK-01's
28/29 FAIL; no historical result is rescored. This answers charter §1.1's pending
C13-42 request, not the separate GPU/upload/browser/visual prerequisites.

## R-2026-09-07-2 — Staged dependency repair in the current workspace

Approve option2A: reconcile `package-lock.json` from the existing root/workspace
manifests, review the exact dependency delta, and perform a controlled installation
in the current workspace. Preserve the manifests; this is not an unrestricted
upgrade campaign. Establish recovery before replacing installed dependencies;
review install-time scripts and enable only what is needed. Verify package/tool
resolution before releasing a fresh app rebuild. Serialize installation against
test/build evidence that depends on that tree. No isolated-copy option, unrelated
configuration changes, security bypass, or automatic browser acceptance is implied.

## R-2026-09-07-3 — Ratify the existing AEC test correction

Approve option3A: ratify the reviewed candidate that checks the actual cell-name
binding, ordering, filename and executed screenshot use, with wrong-selector,
wrong-path/decoy and inertness controls. Prepare a current source/dependency
snapshot and release a fresh49-test run after review. Preserve the preceding
47/48 FAIL and all existing behavior/resource requirements. This answers the
separate charter §1.1 request; it does not retroactively authorize the earlier
root-only dispatch or declare the unrun candidate accepted. E1/browser/performance
acceptance remains separate.

## Shared boundary

No commits or pushes are included in any selected option. Unrelated dirty work
and all failed-run artifacts remain intact. Root owns every Git command; workers
operate under disjoint leases. The implementation and evidence record is
[the approved-unblocks wave](branches/ASTRA_APPROVED_UNBLOCKS_2026-09-07.md).

## R-2026-09-07-4 — Preserve visual progress from feature branches

The maintainer asks that, as features and branches finish, progress screenshots
be captured where there is visible progress and copied from the branch into
`F:/Dev/GH/cesium-webgpu/Tools/visual-regression/output` to preserve history.
Use the gated browser lane and unique feature/run folders, preserve existing
images, and retain source/build identity and capture context. Verify copied image
hashes before any authorized branch retirement. Distinguish progress-only images
from independently validated evidence; do not invent visual progress for source-
only work. This supplements the existing evidence-repatriation rule and does not
waive build/browser prerequisites or authorize branch deletion, commits or pushes.
The maintainer separately requested that this preference be recorded in persistent
project memory; it is also recorded in CODEX_SOL_OPERATING_BRIEF.md.

## R-2026-09-07-5 — Second GodRay exact-message assertion correction

The maintainer explicitly approved fixing the separately reported second stale
ownership-message assertion. Correct only that expected Error.message; preserve
production behavior, all29 tests and later assertions. Independently review and
rerun the full suite against current frozen inputs. Retain both prior28/29 FAIL
captures unchanged. This does not release GPU/browser/visual certification.

## R-2026-09-07-6 — Reasoned package-manifest updates

The maintainer requests dependency specifics and states that updating package.json
is acceptable when there is a specific reason. The earlier unchanged-manifest
boundary is therefore not a blanket ongoing prohibition on justified updates.
Identify the affected chain, reason, proposed version and compatibility checks.
This turn explains the choices without mutating dependencies during the HRN
capture. No forced upgrade, component removal, security waiver, unsupported fork
or broad test-runner migration is inferred. Existing installation recovery,
script review, testing and independent-review requirements remain in force.
