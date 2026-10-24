# Sun-disc clone reconciliation — 2026-09-02

Auditor: **Ciryon** (read-only reconciliation lane). No edits, builds, browsers or
git state changes were made in any repository; this file is the single artifact
written into the main repo, and it is left unstaged and uncommitted.

Maintainer ruling (2026-09-02): reconcile the two sun-disc clones and bank the
result with a receipt before any engine lane touches the sun disc.

## Subjects

| Repo | HEAD | Working state |
| --- | --- | --- |
| `F:/Dev/GH/cesium-worker-sundisc` | `34fb32c71a` (Batch 1159) | 11 tracked modified + 3 untracked |
| `F:/Dev/GH/cesium-lane-sundisc2` | `41aad98761` (Batch 1172) | 9 tracked modified + 2 untracked — **FROZEN** by maintainer ruling |
| `F:/Dev/GH/cesium-webgpu` (main) | `aa5aabb85b` (Batch 1378) | reference |

## 1. Bank receipt

`F:/Dev/GH/cesium-webgpu-worker-archive/sundisc-reconciliation-2026-09-02/`

Contents: `<clone>.patch` (`git diff --binary HEAD`), `<clone>.status.txt`,
`<clone>.head.txt`, `<clone>/untracked/**` (layout preserved), and
`BANK_RECEIPT.txt` carrying the sha256 of every banked file.

Neither clone held `_lane-out/`, packet files, note files, or
`Tools/visual-regression/output/**` evidence. Verified with
`git status --untracked-files=all --ignored=matching` in both; the banked
`.status.txt` files record the same.

## 2. The two lanes are competing fixes for one defect

Both clones address C12-38 (`NEW-SUN-DISC-CENTRE-DARK-SPOT`). The triage,
recorded in the worker clone's own uncommitted `QUEUE_2026-07-19_CAMPAIGN12.md`
edit, is that the sun billboard blends `ALPHA_BLEND` on both backends
(`Sun.js:474`; `WebGPUEnvironmentRenderer.js:855-857`), the bake writes the
limb-darkening law into **alpha**, and the atmospheric transmittance was applied
to **rgb only** — so a low sun replaced the bright aureole with an extincted,
reddened colour, deepest where alpha peaks (the disc centre).

Four options were recorded. The relevant two:

- **(A) co-fade alpha with the transmittance** — keep `rgb *= T`, add `a *= max(T)`.
- **(B) split the transmittance** — `rgb *= T/max(T)` (hue only), `a *= max(T)`.

`lane-sundisc2` implements **(A)**. `cesium-worker-sundisc` implements **(B)**
via a new `solarDiscTransmittanceSplit`.

**(A) landed on main at Batch 1184 (`4d1825d150`).** (B) never landed.

The arithmetic difference is the whole reconciliation. Under `ALPHA_BLEND` the
disc's contribution is premultiplied `rgb * a`:

- (B) gives `(T/max(T)) * max(T) = T` — exactly one factor of transmittance.
- (A) gives `T * max(T)` — **transmittance counted twice**.

The worker clone's own note states the defect this creates: *"the disc's base RGB
is already display-referred white, so multiplying it by a raw slant-path
transmittance double-counts an attenuation the tonemapped white already
represents, which is why the modelled disc ends up darker than the aureole it is
supposed to be the source of."*

## 3. Reconciliation table

`L` = landed on main at `aa5aabb85b`. "drift" = the change is present on main and
main has since moved further, so the clone blob no longer matches.

| # | File | worker-sundisc change | lane-sundisc2 change | Landed on main? | Relation | Bears on the darkness? | Recommended disposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `packages/engine/Source/Shaders/SunFS.glsl` | replaces `u_atmosphereExtinction` with `u_atmosphereChroma` + `u_atmosphereOcclusion` (option B) | adds `u_atmosphereAlpha`, `a *= u_atmosphereAlpha` (option A) | **L** — sundisc2 blob byte-identical to main (`SunFS.glsl:47,51`) | **Direct conflict.** Mutually exclusive uniform contracts | **YES — primary.** (A) double-counts `T`; (B) does not | **Needs a decision.** Landed (A) vs unlanded (B) |
| 2 | `packages/engine/Source/Scene/Sun.js` | publishes `sunDiscChroma`/`sunDiscOcclusion`; swaps the two uniform closures | publishes `sunAtmosphereAlpha`; adds `u_atmosphereAlpha` closure | **L** — sundisc2 blob byte-identical to main (`Sun.js:140,242-243`) | Direct conflict | YES | Needs a decision (rides with row 1) |
| 3 | `packages/engine/Source/Scene/SolarDiscModel.js` | adds `solarDiscTransmittanceSplit` (**absent from main**) | adds `solarDiscAtmosphereAlpha` | **L (drift)** — on main at `SolarDiscModel.js:730`; main added a `0.0` floor at `:741` | Direct conflict | YES | Needs a decision (rides with row 1) |
| 4 | `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` | renames WGSL `extinction`→`discChroma`, `_sunPad0`→`discOcclusion` | adds WGSL `atmosphereAlpha` at offset 35 | **L (drift)** — `:159` (WGSL), `:681` (pack) | Direct conflict | YES | Needs a decision (rides with row 1) |
| 5 | `packages/engine/Source/Scene/FrameState.js` | declares `sunDiscChroma`, `sunDiscOcclusion` | declares `sunAtmosphereAlpha` | **L (drift)** — `FrameState.js:583` | Direct conflict | Indirect (declaration only) | Needs a decision (rides with row 1) |
| 6 | `packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts` | `sunDiscChroma?`, `sunDiscOcclusion?` | `sunAtmosphereAlpha?` | **L (drift)** — `:525` | Direct conflict | No | Needs a decision (rides with row 1) |
| 7 | `Tools/visual-regression/sun-orbital-limb-extinction.spec.mjs` | +19 lines, pins the split | +202 lines, pins the alpha co-fade | **L** — sundisc2 blob byte-identical to main | Conflict; sundisc2 superseded worker | No (instrument) | Discard worker edit unless (B) is chosen |
| 8 | `Tools/visual-regression/solar-disc-model.spec.mjs` | — | +148 lines, `solarDiscAtmosphereAlpha` cases | **L (drift)** — main `:65,116,163,235` | sundisc2 only | No | Superseded — no action |
| 9 | `migration_doc/SHADER_PAIRS_LOCKSTEP.md` | — | adds the alpha co-fade lockstep pair | **L** | sundisc2 only | No | Superseded — no action |
| 10 | `Tools/visual-regression/sun-atmosphere-alpha-fragment.spec.mjs` (untracked) | — | new spec | **L — byte-identical to main** | sundisc2 only | No | Superseded — no action |
| 11 | `migration_doc/C12_38_SUN_DISC_DAWN_PROBE_EXPECTATION_2026-08-27.md` (untracked) | — | expectation note | **L — byte-identical to main** | sundisc2 only | No | Superseded — no action |
| 12 | `Tools/visual-regression/celestial-uniform-offsets.spec.mjs` | +125 lines: derives WGSL struct offsets from source, equates to packer indices | — | **NO** — worker base blob equals main, so main never took it | worker only | No (instrument) | **Land — but rebase.** Kills the index-36 and inserted-`vec4` mutants; the offset-pinning idea is valuable independently of (A)/(B) |
| 13 | `Tools/visual-regression/sun-hdr-radiance.spec.mjs` | +150 lines: behavioural suite for the split | — | **NO** — base equals main | worker only | No (instrument) | Ride with row 1 — asserts `solarDiscTransmittanceSplit`, which does not exist on main |
| 14 | `Tools/visual-regression/eclipse-state.spec.mjs` | +5 lines | — | **NO** — base equals main | worker only | No | Ride with row 1 |
| 15 | `Tools/visual-regression/probe-sun-disc-dawn.mjs` (untracked) | 1,161-line fork adding a **third sky-reference region** at 2–3 limb radii | — | **Diverged.** Landed Batch 1164 (`fcc8a3afb6`), main now 1,479 lines at Batch 1369 | Worker forked before main's Batch-1369 work | **YES — instrument-critical** | **Merge forward.** See §4 |
| 16 | `Tools/visual-regression/lib/sun-disc-dawn-gate.mjs` (untracked) | 896-line fork | — | Diverged (main 1,220 lines) | same | Yes (instrument) | Merge forward with row 15 |
| 17 | `Tools/visual-regression/sun-disc-dawn-gate.spec.mjs` (untracked) | fork | — | Diverged | same | No | Merge forward with row 15 |
| 18 | `migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md` | rewrites the C12-38 row: option-A ruling record, pre-fix measurements, the station-3 eight-mutant survival result, the floor anomaly | — | **PARTIAL** — main carries the Batch-1164 `TRIAGED 2026-08-25` text but none of the later additions | worker only | No (record) | **Land the record.** It is the only written copy of the pre-fix sweep and the mutation-survival finding |

**Row count: 18.** Landed/superseded: **11** (every `lane-sundisc2` entry, rows
1–11 on the sundisc2 side). Unlanded or diverging: **7** (rows 12–18). Needing a
maintainer decision: **6** (rows 1–6, the (A)-vs-(B) contract; rows 13–14 ride
with it).

### Clone-level verdict

- **`cesium-lane-sundisc2` is fully superseded.** Every one of its 11 entries is
  on main. It holds nothing unlanded. It remains FROZEN by ruling; this audit
  gives no reason to touch it and none to keep it beyond that ruling.
- **`cesium-worker-sundisc` holds real unlanded value**: the sky-reference probe
  region (row 15), the WGSL-offset spec (row 12), the C12-38 record (row 18), and
  the option-(B) implementation (rows 1–6) which is the arithmetic correction to
  what landed. Do not delete it.

## 4. Diagnostic leads — no code change proposed

Measurement under discussion: `Tools/visual-regression/output/sun-disc-dawn-2026-09-02/`
(run `d1eef94d-d90d-418a-9357-e5effc870fdf`, executor Éowyn, exit 3 STRUCTURAL,
no bar derived). WebGL disc region ~0.97 mean luminance, WebGPU ~0.31, same
exposure 0.125, same camera, every above-horizon sample.

**Both backends publish byte-identical engine state.** Read directly from the
artifact for samples 0/2/6/12: `discRadiance` 2 on both, `extinction` identical
on both, plus `useHdr`, `exposure`, `limbPx`, `centerX/Y`, `bakeHaloGain` 0,
`limbDarkening`, `sunBloomActive` true, `skyAtmosphereVisible` true, all equal.
Every CPU-side resolution is therefore at parity and the divergence is
downstream, in the GPU composite. This eliminates `SolarDiscModel`,
`SunHaloAppearance`, `Sun.update` publication and the `discRadiance` path as
sources of the gap.

### Lead 1 (strongest) — the measured region may contain no sun at all

The artifact's own `extinction` maximum channel runs **9.4e-9 → 0.2185** across
the sweep (3.4e-5 at sample 2, the first above-horizon sample). The landed
co-fade sets billboard alpha to `min(1, max(0, r, g, b))`
(`SolarDiscModel.js:741`), published at `Sun.js:242-243`, consumed at
`SunFS.glsl:51` and `WebGPUEnvironmentRenderer.js:159`. At those magnitudes the
billboard's alpha is **~3e-5 to ~0.2**, i.e. the sun billboard is very nearly
erased on *both* backends.

If so, the pixels in the centre and annulus regions are SkyAtmosphere plus sun
bloom, not the disc — and the 3.1x is a **sky/aureole/bloom parity gap misfiled
as a sun-disc row**. This is consistent with the run's other facts: both regions
read the same value (ratio ~1.00, a flat "disc"), the README records the WebGPU
"disc" as *darker than the surrounding sky with no bright core*, and both
backends agree to four decimal places (0.0480/0.0480) at sample 0, where the sun
is below the horizon and nothing is drawn.

### Lead 2 — sun bloom / bright-pass composite

`sunBloomActive` is true on both legs. `solarBrightPassTuning` derives
`brightPassThreshold`/`brightPassOffset` from `discRadiance`
(`SunHaloAppearance.js:279-289`). Those are CPU-resolved and identical, so a gap
here would live in the WebGPU bright-pass/bloom composite or its position
relative to tonemap — the class of near-constant multiplicative offset the data
shows (WebGPU flat at ~0.311–0.323 while WebGL is pinned at its ceiling).

### Lead 3 — the landed fix double-counts the transmittance

`SunFS.glsl:47` applies the full `T` to rgb and `:51` applies `max(T)` to alpha;
the WGSL twins are `WebGPUEnvironmentRenderer.js:156` and `:159`. Premultiplied
contribution is therefore `T * max(T)`. Option (B) in `cesium-worker-sundisc`
keeps it at `T`. This is a genuine defect in landed code and it explains a disc
that reads darker than its own aureole — but it is applied identically on both
backends, so **it does not explain the WebGL/WebGPU delta**. It is a
shared-engine correctness row, matching the run README's finding 2.

### Measurement caveat

Seven of 13 WebGL samples are recorded `centre-clipped` and `annulus-clipped`.
The WebGL leg is saturated at ~0.97, so **3.1x is a lower bound, not a
measurement**; the true ratio is unknown and larger.

### The one Edge measurement that discriminates

Re-run `probe-sun-disc-dawn.mjs` at the same camera, clock sweep and exposure,
**twice: once with `scene.sun.show = false`, once with sun bloom disabled**, both
backends.

- If the ~0.97 / ~0.31 split **survives** with the sun primitive off, Lead 1 is
  confirmed: the gap is SkyAtmosphere/bloom and C12-38 is misfiled.
- If it **collapses** with the sun off but survives with bloom off, the gap is in
  the billboard composite itself.
- If it collapses with bloom off, Lead 2 is confirmed.

Landing row 15's sky-reference region first would make this cheaper: with a third
region outside the disc, one ordinary sweep separates disc from sky without a
second run. Note that the worker's probe fork predates main's Batch-1369
`--exposure`, `DERIVED-PENDING` bar and rescore work, so the region must be
ported forward onto main's probe rather than landed wholesale.

## 5. Incidental findings

- `packages/engine/Source/Shaders/WebGPU/Environment/Sun.wgsl` is **not imported
  anywhere** in `packages/engine/Source` (verified). The live billboard shader is
  the inline `SUN_SHADER_WGSL` at `WebGPUEnvironmentRenderer.js:77`. The
  `Shaders/` copy declares a 28-float uniform struct with no extinction,
  atmosphere-alpha, eclipse or `discRadiance` members and a hardcoded
  `rgba8unorm` bake — editing it would change nothing at runtime. This is
  already documented in `migration_doc/SHADER_PAIRS_LOCKSTEP.md` ("a
  reference/prototype, not the compiled billboard shader"), so it is a known
  trap rather than a new one, but it remains a live footgun for any lane
  dispatched against "the WGSL sun shader".
- The worker clone records that at station-3 review **eight mutations of the fix
  all survived 134 browser-free celestial tests**, and that
  `solarDiscTransmittanceSplit` had zero spec callers. Rows 12 and 13 are the
  pins that closed five of the eight; three remain probe-gated. If option (A) is
  kept rather than (B), the equivalent inertness question for the *landed* code
  has not been asked.
