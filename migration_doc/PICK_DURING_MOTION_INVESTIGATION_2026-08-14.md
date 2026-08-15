# Pick-During-Motion Investigation (R-2026-08-14-3)

**Provenance:** maintainer ruling R-2026-08-14-3 upgraded audit finding S6(b) from a
patch decision to a full investigation ("We should know the issue so we can improve
our picking and still hit our goals"). Read-only Opus lane, 2026-08-14. This document
is the investigation of record; the fix lands later as its own reviewed batches per
the staged plan in §c. Full lane report preserved in the session task outputs; this
is the complete technical content.

---

## (a) Archaeology — how the gate got here

- **Era 0 (≤ 2026-07-15):** no gate at all. `end()` served `_lastReadPixels`
  unconditionally — tolerant to the point of wrongness (would decode a readback from
  a different cursor, camera, or attachment). Sibling paths carried explicit numeric
  tolerances: `CENTER_PIXEL_COORD_TOLERANCE = 2` px + 4-frame staleness (Batch 285),
  `PickDepth` ±4 px + 4 frames.
- **Era 1 (2026-07-16, `5136ec75de`, Batch 663):** the rewrite introduced exact-region
  equality; the 26-agent audit caught the hover regression PRE-LANDING and the fix
  went in the same commit as **`AUDIT-P0-SYNC-PICK-REGION-DRIFT`** (C9 queue:143):
  the containment gate — serve if the query's center lies inside the cached region,
  same attachment generation. The stricter interim gate was called "an undisclosed
  semantics change" and reverted. The tolerant path worked for **28 days**. Its
  tolerance was purely geometric (±2 px cursor drift on the 3×3 rect) with **no
  camera-pose term** — which is exactly why it also served stale bytes under camera
  motion.
- **Era 2 (2026-08-12, `739a04cf19`, Batch 1028, C18-V2):** introduced
  `getCenterPixelViewProvenance` and threaded exact view-provenance equality into
  four gates (exact-match `:568`, containment `:599`, publish `:670`, center-pixel
  `:969`), and **deleted** `CENTER_PIXEL_COORD_TOLERANCE`. The motivating wrong-pick
  was the **voxel identity** hazard (its own spec: "camera motion cannot reuse voxel
  A as the selected owner for voxel B") — correct reasoning for typed center-pixel
  voxel/metadata reads, where a neighboring pixel is a genuinely different value.
  **The error was applying it uniformly to the ordinary object-pick cache**, where
  the failure mode is a MISSING pick, not a wrong value — silently repealing the
  audit-P0 tolerance with a one-line commit body. DEFERRED_WORK:56-65 already flags
  S6(b)/S13 as OPEN against the landing.

**Second-order defect (new finding):** the publish-side clause
(`_ordinaryPickViewProvenance !== region.viewProvenance` at `:670`) means **no
readback ever publishes while the camera moves** — the cache freezes at the last
pose where two consecutive picks shared provenance, so readback age `k` is
UNBOUNDED, not "one frame" as the docstring claims. The clause is provably
**redundant**: both consumers already gate on `cached.viewProvenance`. Removing it
changes zero served results and bounds `k` to mapAsync latency. *The single
highest-value line in the whole investigation.*

**Also surfaced:** `frustum.near/far` sit in the provenance yet move no pixel
(over-strict: scene-driven near/far churn invalidates the cache on a static
camera); the ordinary path passes no owner matrix, so a **moving primitive under a
static camera still serves a stale cache** — a wrong-pick class the current gate
does NOT close; and `PickDepth` retains the old ±4 px/4-frame window with no
provenance term, so `pickPosition` is today LOOSER under motion than `pick` —
backwards.

## (b) Failure-mode physics

First-order screen displacement of a cached pick under pose delta, with
`f = (dbHeight/2)·proj[5]` (recoverable at runtime, no FOV assumption):

```
ε ≤ f·|ω⊥|·(1 + ρ²/f²)   rotation — DEPTH-INDEPENDENT (dominates)
  + f·|ΔC⊥|/d            lateral pan (∝1/d)
  + ρ·|ΔC∥|/d            dolly (zero at center)
  + ρ·|Δf|/f             FOV change
```

At 1920×1080/60° (f = 1662.8 px): **1 px of pick error = 0.0345° of rotation**
(0.0172° at DPR 2). Evaluated (d = 500 m, 60 Hz, center):

| Case | ω̇ | ε @ k=1 | k=2 | k=4 |
|---|---|---|---|---|
| micro settle | 0.2°/s | 0.10 | 0.19 | 0.39 |
| inertia deep tail | 1°/s | 0.48 | 0.97 | 1.93 |
| inertia mid tail | 5°/s | 2.42 | 4.84 | 9.67 |
| slow drag (0.1°/frame) | 6°/s | 2.90 | 5.80 | 11.61 |
| typical orbit drag | 30°/s | 14.51 | 29.02 | 58.04 |
| flyTo mid-flight (composite, d=5 km) | — | 20.46 | 40.91 | 81.82 |

Correctness thresholds: 1 px, or half the pick-rect radius = **0.5 px** at the
default 3×3. Max angular rate inside a 1 px budget: **2.07°/s @ k=1, 1.03 @ k=2**.

**The honest headline: a pure pose-delta bound opens only below ≈1–2°/s** — it
recovers the inertia tail and micro-motion, and recovers NOTHING during an actual
drag (29 px at k=2) or flyTo (41 px). Any promise that bounded tolerance alone
restores pick-during-motion is a promise real camera motion never honors.

**The better bound — identity plateau:** the wrong-pick only materializes when a
DIFFERENT pickId reaches the cursor pixel, which is observable in the cached bytes.
Define P = largest Chebyshev radius around the cursor over which the cached pickId
is uniform. Claim (with proof sketch in the lane report): **P ≥ 2ε is sufficient**
to serve safely (the 2ε covers disocclusion via silhouette crossing). Data-driven:
fails closed exactly at silhouettes/thin features, opens wide over uniform surfaces
(globe, terrain, large tileset features — the common hover targets). A **33×33**
capture (8.4 KB vs today's 768 B) covers everything through slow drag (~7°/s) and
the whole inertia decay; fails closed above — the honest and correct answer for
flicks and flyTo.

## (c) Design — staged recommendation

**P0 (XS, strictly safe):** delete the redundant publish-side provenance clause
(`:670`); fix the two lying docstrings (`:681-688`, `:721-727`). Zero served-result
change; bounds k. Everything else is void without it.

| Stage | Content | Size | What it buys |
|---|---|---|---|
| 1 | **Widget adoption of the SHIPPED async pick APIs** — `Viewer.pickEntity` click-selection → `pickAsync`; Inspector hover → `pickHoverAsync`. These APIs exist, are SHIPPED (incl. a two-slot latest-wins hover scheduler), and have **zero consumers** (grep-verified across widgets + Apps). Today the widgets use SYNC pick for clicks — the cold case its own docs call unreliable. | S | Fixes the worst user-visible symptom (click-during-inertia selects nothing) with zero engine-semantics risk |
| 2 | **Structured provenance + identity-plateau reuse (Design 1′)** — replace the joined provenance string with a structured pose record; serve iff `2ε ≤ P` AND ε under a hard ceiling; ordinary object-pick domain ONLY. Wider capture (33×33) with the returned rect unchanged; the sub-rect extraction machinery already exists. Cull-cone widening cost MUST be measured, not assumed. | M | Recovers hover over real targets through slow drag + the whole inertia decay; fails closed at silhouettes and >7°/s |
| 3 | **Per-frame pre-arm + pointermove coalescing**, gated on recent-sync-pick, explicit budget + telemetry (the env-refresh scheduler is the budget pattern to copy). Today `handleMouseMove` dispatches inside the DOM listener with no rAF coalescing — a 1000 Hz mouse fires up to ~16 pick mini-frames per rendered frame, all but one dropped. Coalescing makes this a net cost REDUCTION. | M | Makes k=1 a guarantee; defer until Stage 2's numbers are measured |

**Rejected as engine pattern:** deferred-confirm sync pick (no correction channel
exists on `scene.pick`, and adding one breaks upstream shape) — its value is
captured at the consumer level by Stage 1. **Held exact, deliberately:** the
center-pixel domain (`pickVoxel`/`pickMetadata`) — Batch 1028's reasoning is
CORRECT there; a stale serve would fabricate voxel-convergence evidence (the
strongest single argument for the domain split). **Riders filed:** re-derive
`PickDepth`'s window to match Stage 2 (today's inversion is backwards); apply the
S13 fix's shape to `_readbackInFlight` or Stage 3 starves identically; close the
moving-primitive-under-static-camera gap (owner matrix into provenance) with a
dedicated control test.

**Sequencing:** Stage 2 must NOT land before the C18-V2 Edge closure run, or the
baseline provenance is muddied. Spec `webgpu-pick-center-identity.mjs:399`
currently RATIFIES fail-closed-on-motion while the audit files it as a defect —
Stage 2 must update that spec's stated intent in writing, not merely its inputs.

## Acceptance plan (condensed; full text in the lane report)

Offline: bound-monotonicity vs the (b) table within 1%; the **wrong-pick negative
control** (A|B silhouette 1 px from cursor, swept δθ — result must be `[]` or `[B]`,
NEVER `[A]`; the factor-2 plateau mutation must fire it) + the positive control
(64 px uniform target serves through the derived bound); publish-under-motion pin
for P0; domain isolation (tolerant serve must not change any center-pixel read);
moving-primitive fail-closed control. Browser: `probe-pick-during-motion.mjs`,
both backends, WebGL as per-frame ground truth, ω̇ sweep {0.2,1,5,6,30,120}°/s —
gates: zero wrong picks at every rate (load-bearing); ≥90% hit-rate at ≤1°/s over
a uniform feature (today: 0%); fine-detail 0% at high rates RECORDED, never
widened for; off-leg byte-identical; C18-V1 exit convention; **measure and bank k**
(never measured); 3×3-vs-33×33 cost leg interleaved A/B.

## (d) Goals check

All 14 enumerated goals served (upstream hover/selection semantics, drillPick,
pickPosition consistency, voxel/metadata exactness, the C18 Wave-V scenes, probe
honesty conventions, voxel-convergence law, pick-ID ownership shape, S13
compatibility, backend agnosticism, ledger honesty). Two caveats stated plainly:
(i) NO design recovers picking at typical drag rates — the physics forbids it
without a synchronous readback WebGPU cannot provide; fail-closed + the async path
IS the correct answer there; (ii) the PickDepth inversion is pre-existing and files
as its own row rather than riding silently.
