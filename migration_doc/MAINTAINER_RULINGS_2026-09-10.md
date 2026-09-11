# Maintainer rulings — 2026-09-10

Recorded from maintainer rulings and seat return decisions given to the root seat
(Gandalf, Fable 5.1).

## R-2026-09-10-1 — Universal enforcement of the previousViewProjection tail rule (2026-09-05 D4)

The maintainer ruled that the `previousViewProjection` tail rule is "enforced
universally". `AR-D12` is DECIDED under this arm. `AR-067` and `AR-194` lose
their "after the ruling" hold and become dispatchable. The enforcement lane
covers all 57 of 72 shaders declaring `CameraUniforms` with
`previousViewProjection` that currently place the field mid-struct (verified at
HEAD over 324 WGSL files: 85 declare `CameraUniforms`, 72 carry the field,
15 tail-placed, 57 mid-struct).

Authority is charter §0.4 and CLAUDE.md's "64-Bit Precision & RTE" section (CLAUDE.md:235, DP-H41). This ruling does not
authorize in-place reordering without a migration lane, does not waive the
verification spec requirement, and does not alter the UBO layout for shaders
outside `CameraUniforms`.

## R-2026-09-10-2 — RenderCommand adoption confirmed (2026-09-05 D5)

The maintainer ruled that `RenderCommand` adoption stands, confirming the
direction recorded in CLAUDE.md. The abstraction is adopted with the requirement
that `buildRenderCommand` be supported on both backends with compatibility
exemptions and a concrete migrated feature as proof.

Authority is charter §0.4 and CLAUDE.md's "RenderCommand (Backend-Agnostic commandList)" section (CLAUDE.md:217, ruling D5). This does not waive
per-feature review, does not authorize wholesale removal of `DrawCommand`
dispatch prior to backend parity proof, and does not alter WebGL fallback
command generation.

## R-2026-09-10-3 — Relocation of uncommitted workspace (2026-09-10 R3)

Astra's uncommitted workspace was relocated from the seat worktree to
`F:/Dev/GH/cesium-astra-20260910` to eliminate index-corruption hazards and
unreviewed churn at the seat. The seat worktree was restored to clean Batch 1450
state, with the migration receipt verified at `_transplant/RECEIPT` in the target
clone (`VERIFIED=1`).

Authority is charter §2.4 and `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`. This
relocation does not commit or land any Astra changeset, does not waive
independent review for Campaign 13 work, and does not authorize unreviewed
merges into main.

## R-2026-09-10-4 — Gemini 3.8 Flash High tier-3 worker role (2026-09-10 R4)

Gemini 3.8 Flash High via the antigravity CLI (`agy`) joins the worker pyramid
as a tier-3 worker for documentation, ledger maintenance, and bounded tasks.
The worker operates strictly through a wrapper under the seat or a lead, never as
an autonomous orchestrator, without Git write permissions, and with all
deliverables subject to independent Opus station-3 review.

Authority is charter §4.6 and `GEMINI.md` (untracked; pending the R-5 governance batch). This does not authorize Gemini workers
to execute Git writes, run browsers or servers, modify engine or shader code, or
perform landing merges.

## R-2026-09-10-5 — Governance updates adopted and archive sweep held (2026-09-10 R5)

The maintainer adopted CLAUDE.md's two new principles — "File Editing Discipline: never rewrite
files > 100 lines" and "Command Execution Preference: node commands first" — along with `GEMINI.md`
as a batch. Both are unlanded at Batch 1453; in Astra's draft
(`F:/Dev/GH/cesium-astra-20260910/CLAUDE.md:181`, `:187`) they are numbered 10 and 11, which collides
with the existing Principle 10 "Brief From Verified Premises" (`:569`). The collision is resolved
when the governance batch lands; cite the two by title until then. The proposed 34-document archive sweep
is HELD under the standing 2026-06-30 maintainer archival hold on the canonical doc
set.

Authority is charter §0.4. This does not authorize moving or deleting canonical
documents under `migration_doc/`, does not waive `verify-readme-index.mjs`
compliance, and does not alter the priority of existing tracked queues.

## R-2026-09-10-6 — Globe.js cloud default-on hunk held (2026-09-10 R6)

The `Scene/Globe.js` volumetric cloud default-on hunk (`enableVolumetric: true`
at tier-3 "high") is HELD when Astra's Campaign 13 engine work is reviewed.
Appearance defects (stippled lattice over uniform dark navy, missing atmosphere/sun)
and unmeasured frame-time cost preclude default rollout until a ≥1280×720 non-refused
capture and performance benchmarks are accepted.

Authority is CLAUDE.md Principle 8 and `F:/Dev/GH/cesium-astra-20260910/migration_doc/branches/ASTRA_CLOUD_DEFAULT_2026-09-06.md` (untracked; Astra's relocated clone). This
does not reject the underlying volumetric cloud shaders or C13 engine repairs,
which remain eligible for landing with the default toggle held off.

## R-2026-09-10-7 — Harvest and closeout of landed-lane clones (2026-09-10 R7)

The maintainer approved the closeout and retirement of 65 landed-lane clones,
harvested to `F:/Dev/GH/cesium-webgpu-worker-archive/lanes-2026-09-10/` and deleted
from the active filesystem to recover disk capacity and avoid stale workspace
confusion.

Authority is `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §8c and charter §4. This
does not authorize deleting active, unlanded, or in-flight worker clones (including
Hundar, Uldor round 3, Amdir round 3, and the S1 wave lanes).

## R-2026-09-10-8 — Borthand F6 inventory disposition: SCAFFOLDED

On Borthand finding F6 (`WebGPUStorageBufferPool`), the seat took disposition (b) of
`RETURN_AUDIT_2026-09-10.md` §6 M3: "executed" is the binding criterion for impact scoping in the feature
inventory. Because the consuming shader reads sit behind a pragma-stripped
sentinel and are dead in a release build, `FEATURE_INVENTORY.md:562` is updated
from `(SHIPPED)` to `SCAFFOLDED`.

Authority is charter §1.1 and `RETURN_AUDIT_2026-09-10.md` §6 decision M3. This
does not delete the module or its scaffolding infrastructure, which remains
preserved per Principle 7.
