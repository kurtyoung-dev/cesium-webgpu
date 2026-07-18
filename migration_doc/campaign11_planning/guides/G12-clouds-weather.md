# Campaign-11 Cluster Guide G12 — `clouds-weather` (cluster 17, 16 items)

**Anchors verified 2026-07-18 against committed HEAD `c643516c04` (Batch 703,
`C11-PLANNING guides G8/G9/G10 complete`).** The register (`CANDIDATE_REGISTER.md` cluster 17)
was swept at `aef553d592` (B698) and the canonical C11-ids live in
`QUEUE_2026-07-18_CAMPAIGN11.md §1.17` (`C11-124..130` + `C11-SEED-10..18`) — reference only, do
not edit the queue. A concurrent C10 worker is editing engine files
(`WebGPUModelPipelineCache.ts` is dirty in `git status` at guide time); **none of this cluster's
anchor files are dirty**, so working-tree greps == HEAD for them. If any cloud/weather file shows
dirty when you start a slice, run `git show HEAD:<path> | grep …` and attribute the dirt to a C10
task before touching anything. **Symbols are the contract; line numbers are hints — re-grep every
anchor by symbol at intake** (several anchors already moved between the B698/B699 guides and B703;
e.g. `executeProceduralClouds` is at `:1489` here, not the `:1402` the DW entry cites).

**Register rows covered (source/register name + canonical C11-id from QUEUE §1.17; the orchestrator
owns final scheduling):**

| C11-id | Register/source name | Pri | Class | Effort | Maturity flag |
| --- | --- | --- | --- | --- | --- |
| `C11-124` | C7-CLOUD-LIGHTNING (reland = C9 W7-1) | P2 | feature | M | schedulable — 2 named fixes, code existed once |
| `C11-125` | C6-CLOUD-STBN-TAAU | P2 | feature | M | **BLOCKED on offline license-clean asset generation (human/maintainer prereq)** |
| `C11-126` | CLOUD-U4-REMOVE-GLOBE-FLAG | P2 | infra | L→S | **PREMISE-STALE — RESOLVED in code (B621+B622); collapses to doc reconciliation** |
| `C11-127` | Q36-WEATHER-PHASE-4-GRIB2 | P2 | feature | L | **BLOCKED — proxy + WASM + no sandbox outbound network** |
| `C11-128` | Live EDR network confirm | P2 | tooling | S | **BLOCKED — needs a networked browser session the sandbox lacks** |
| `C11-129` | WeatherSystem / scene.weather facade (Phase 3) | P2 | feature | M | schedulable — backend-neutral TS facade over shipped core |
| `C11-130` | PRECIP-DATA ground snow-albedo shader consumer | P2 | feature | S | schedulable — producer shipped; needs BOTH-backend globe-shader consumer |
| `C11-SEED-10` | C7-CLOUD-IMPOSTOR-LOD | P3 | perf | L | seed/dossier — dep CLOUD-U4 **now satisfied**; STBN-mask prereq |
| `C11-SEED-11` | CLOUD-LOD-R8-PRECIPITATION-COUPLING | P3 | feature | L | seed/dossier — sequenced after R7 lightning |
| `C11-SEED-12` | CLOUD-LOD-R9-PLANET-SCALE-CLOUD-TILING | P3 | feature | XL | seed/dossier — largest remaining cloud gap |
| `C11-SEED-13` | CLOUD-EXOTIC-E3-SPECIAL remainder | P3 | feature | L | seed/dossier — needs new source infra |
| `C11-SEED-14` | Cloud perf — Tier-2 3D bake (cascaded clipmap) | P3 | perf | XL | seed/dossier — the production volumetric path |
| `C11-SEED-15` | Temporal interpolation + advection (Phase 5) | P3 | feature | M | seed/dossier — **wind-advection repro probe MISSING (build first)** |
| `C11-SEED-16` | Historical-replay headline demo (Phase 4) | P3 | feature | M | seed/dossier — gated on `C11-127` |
| `C11-SEED-17` | profileExtinction (slot 103) per-position optical extinction | P3 | feature | M | seed/dossier — scaffolding fill-in |
| `C11-SEED-18` | NEW-CLOUD-SHADOW-ENVMAP | P3 | feature | S | seed/dossier — env-cube cloud-shadow term |

**Charter constants that bind every item here (never weaken, per CLAUDE.md + the register's
standing-policy block):** no feature removal / default-disable / visual degradation for a metric;
Rule-3 conservatism (unknown demand stays conservative); **opt-in features default OFF and
byte-identical at defaults** (every cloud/weather feature below is default-off — the off-gate is a
hard acceptance criterion, not a nicety); probe-first visual verification (Principle 8 — reproduce
in a `Tools/visual-regression/probe-*.mjs` and READ the PNGs before claiming a fix); premise-verify
first (this cluster is the most stale in the register — one row is already fully resolved, one is
blocked on a human prerequisite, two are environment-blocked); one concern per slice; **no
license-poisoned assets** (the STBN constraint below is a hard licensing wall, not a preference);
moving-altitude route only for perf evidence; land as kurtyoung-dev; ledger row updated in the same
commit.

**Landed-work interaction map (read before ANY slice — these changed the ground under the
register's cloud rows):**

| Landed work | Batch / hash | What changed | Who in this guide must care |
| --- | --- | --- | --- |
| **CLOUD-U4A-SCENE-DEFAULT-COLLECTION** | B621 `8c7b8c7497` (2026-07-05 19:05) | Globe now owns `_defaultCloudCollection = new CloudCollection()` (`Globe.js:91`, getter `:1078`, destroy `:1320`) — resolution **option (A)** from the DW CLOUD-U4 entry | **`C11-126` is RESOLVED, not blocked** — see the item. Every cloud item that reads "gated on globe.showProceduralClouds" is describing a removed API |
| **CLOUD-U4B-REMOVE-GLOBE-SURFACE** | B622 `b9eb70f74c` (2026-07-05 19:40) | Removed the `globe.showProceduralClouds` + `globe.cloud*` user API; `AtmosphericConditions.clouds.*` now proxies onto `globe.defaultCloudCollection.volumetric.*` (`AtmosphericConditions.js:794-935`); `godRayCloudAware` gate no longer ANDs the removed flag (`WebGPUPostProcessStageCollection.ts:964/990`) | `C11-126`, `C11-SEED-10` (its "dep CLOUD-U4" is satisfied), `C11-SEED-14` |
| **C10-01 env-command frustum binning** | B693 `b156079da8` | Default 3D = **ONE frustum** on WebGPU | Any cloud/weather perf probe asserting frustum count; the cloud march runs once/frame either way, but multi-frustum captures from old sessions are pre-B693 history |
| **C10-03 demand-driven scene-color resolve** | B697 `19149cbeae` | Scene-COLOR resolves 9→1/frame, resolve-on-consume | Any cloud composite / env-effects pass that READS scene color must be a registered consumer (the cloud march composites into HDR scene color) |
| **C6-CLOUD-STBN-TAAU LOD half** | B634 | `marchStepGrowth`@144 / `maxRayDistance`@145 shipped (both default no-op) | `C11-125` (the STBN/TAAU half is the remainder), `C11-SEED-10` (step-growth is the cheap orbit lever proving impostors are optional) |
| **PRECIP-DATA (WMO ww→precip + snow accum)** | B444 `adb2b06d22` | `updateSnowAccumulation` produces a snow-cover scalar; mirrored as a weather-renderer uniform | `C11-130` — the producer is shipped, only the globe-shader consumer is missing |
| **Weather ingest P0–P3** | B410/411/416/424/425 | `WeatherProvider` + `EdrWeatherSource`/`MetarWeatherSource`/`WcsCoveragesWeatherSource` + time model + G/B/A channels + mock fixtures | `C11-127/128/129`, `C11-SEED-15/16` all sit on this shipped core |
| **C7-CLOUD-LIGHTNING** | shipped B?? then **reverted pre-land — no commit on main** | in-cloud emissive lightning + flash driver; reverted for a lon/lat block lattice the median gate masked | `C11-124` — this is a clean-slate reland (grep confirms zero lightning code at HEAD) |

---

## G12.0 — Cluster map, maturity ladder, and sequencing spine

**This is the fork's largest content-epic cluster: the deferred halves of the cloud/weather
campaigns C2–C7.** Treat that framing honestly — only three of the sixteen rows are cleanly
schedulable execution work inside a perf-focused campaign; the rest are either resolved, blocked on
a human/environment prerequisite, or research-stage content seeds. The maturity ladder:

- **Already resolved (doc-only):** `C11-126` (CLOUD-U4 landed B621+B622). Close the row; do not
  re-open the epic.
- **Cleanly schedulable execution:** `C11-124` (lightning reland — two named fixes), `C11-129`
  (scene.weather facade — TS API design over shipped core), `C11-130` (snow-albedo globe-shader
  consumer — both backends).
- **Blocked on a HUMAN or MAINTAINER prerequisite (cannot start in-session):** `C11-125` (needs an
  offline EA-SEED FastNoise STBN texture baked on a dev machine), `C11-127` (needs a same-origin
  CORS proxy + GRIB2 WASM decoder + outbound network), `C11-128` (needs a networked browser
  session).
- **P3 content seeds/dossiers:** `C11-SEED-10..18` — write the brief so a worker can start the day
  the maintainer green-lights content scope, but do not schedule speculatively.

**Two architecture facts that touch nearly every item:**

1. **The volumetric cloud march is WebGPU-only. It has NO WebGL twin, and that is correct.** The
   WebGL cloud path is the separate billboard `CloudCollection` renderer (`CloudCollectionFS.glsl`);
   the volumetric raymarcher (`WebGPUProceduralCloudRenderer.ts` + `ProceduralClouds.wgsl`) is a
   fork-added WebGPU feature. Principle 5 (WebGL/WebGPU parity) does **not** demand a GLSL twin for
   cloud-march items (`C11-124/125`, `SEED-10/11/12/14/17/18`) — the DW STBN entry states this
   explicitly ("WebGPU-only, no WebGL twin"). The exception is any feature that lands on the GLOBE
   or SCENE surface rather than in the cloud march — `C11-130` (snow whitens terrain) needs BOTH a
   WGSL (`GlobeTerrain.wgsl`) and a GLSL (`GlobeFS.glsl`) consumer.
2. **Everything here is opt-in and default-off.** `CloudCollection.renderMode` defaults to the
   billboard path; the volumetric config `enabled` defaults false; every new `qualityFlags` bit and
   every new `CloudUniforms` slot below appends add-only with a no-op default. The off-gate
   (`preprocess(defines=0)` / neutral-slot byte-identity) is the primary acceptance oracle for the
   whole cluster, and `probe-cloud-u8-offident.mjs` is the standing byte-identity sentinel.

**Recommended intake order (dependencies in parentheses):**

1. `C11-126` first — it is a 30-minute doc-reconciliation that unblocks the mental model for the
   whole cluster (and satisfies `SEED-10`'s dependency on paper).
2. `C11-130` (snow-albedo) — smallest genuine feature, well-specified, both-backend but bounded.
3. `C11-124` (lightning reland) — well-specified, the anti-tiling-gate fix is reusable tooling.
4. `C11-129` (scene.weather facade) — backend-neutral consolidation; unlocks the demo surface for
   `SEED-16`.
5. `C11-125` (STBN) — only after the maintainer confirms the offline asset can be produced.
6. `C11-127/128` — surface to the maintainer as environment-blocked; do not schedule in the sandbox.
7. `C11-SEED-*` — dossiers; open only on explicit maintainer content-scope appetite.

---

## G12.1 — Schedulable P2 items (`C11-124..130`)

### C11-124 — C7-CLOUD-LIGHTNING (reland = C9 W7-1) — P2, feature, M

**WHAT + WHY.** In-cloud lightning: an emissive scatter term in the volumetric march plus a
flash-driver uniform riding the weather-map precipitation channel and the existing multi-deck storm
cells (storm-demo content). It **shipped during Campaign 7 (2026-07-11) then was reverted in full
before landing — no commit reached main** (`DEFERRED_WORK.md:5237`, the definitive entry; the
Campaign-7 completeness sweep found the revert documented nowhere until that entry). **Verified at
HEAD:** zero lightning code present (`git grep -il "lightning|flashDriver|emissiveScatter"` over
`ProceduralClouds.wgsl` + `WebGPUProceduralCloudRenderer.ts` = empty) — this is a clean-slate reland,
not a diff-restore.

**Why it was reverted (the two concrete fixes the reland OWES):** audit review found a hard-edged
**lon/lat block lattice** in the flash-decay frames — per-cell flash windows quantized on the
weather-map cell grid leave visible rectangular seams while a flash decays (gridScore 0.2271 on the
cyc-3 capture, 0.1396 on cyc-7). The artifact was **masked by the acceptance probe's median-based
anti-tiling gate**: the lattice lives in the bright upper tail of the frame's luminance
distribution, so the median metric passed while the PNGs showed the grid. Reland fixes:
(1) **replace the median-based anti-tiling probe gate with an upper-percentile (95th/99th) gate** so
tail-dwelling lattices fail loudly; (2) **soften/stagger the per-cell flash-window temporal edges**
(per-cell phase jitter + a smooth decay envelope) so the lon/lat decay-frame lattice dissolves
instead of snapping cell-by-cell.

**ARCHITECTURE TODAY (verified at `c643516c04`).** The march + weather seam this rides:
`WebGPUProceduralCloudRenderer.ts` `executeProceduralClouds()` (`:1489`); `CloudUniforms` is
`CLOUD_UNIFORM_FLOATS = 148` (`:71`) grown add-only (the growth ledger is documented at `:60-70`);
the weather texture cache + upload lives at `:782-824` (`WEATHER_TEX_W/H`, `weatherProviderVersion`
dirty tracking); the precip channel is `wsample.a`/`wsample.g` in `ProceduralClouds.wgsl`; multi-deck
storm cells are `CLOUD_QF_MULTI_DECK` (deck bounds at slots 112-119). The exotic-species precedent
for a new opt-in cloud effect (`speciesMode` slots 132-135, `featureMode` 136-139, `specialShadeMode`
140-143) is the template: append 4 add-only slots, gate on a `qualityFlags` bit, WGSL early-outs at
neutral default so `defines=0`/neutral-slot stays byte-identical.

**IMPLEMENTATION WALKTHROUGH.**
1. **Rebuild the probe FIRST (Principle 8), and build the percentile gate as the deliverable's
   spine** — `probe-cloud-lightning.mjs`: a multi-deck storm scene with the flash driver on, capture
   the flash-decay frames (cyc-3, cyc-7 waypoints the DW entry names), and assert an **upper-tail
   (P95/P99) grid-score** below threshold, NOT the median. This gate is the thing that would have
   caught the original bug; write it before writing any shader math. Also assert the default-off
   byte-identity leg (`probe-cloud-u8-offident.mjs` style).
2. **Re-implement the emissive term** as a new opt-in append: 4 add-only `CloudUniforms` slots
   (148→152) for flash intensity/color/decay/driver-scale; a new `qualityFlags` bit; a WGSL emissive
   scatter term in the march that early-outs when the flash intensity is 0.
3. **Fix the temporal edges** — per-cell phase jitter (hash the cell id into the flash window offset)
   + a smooth (smoothstep) decay envelope, so no two adjacent weather-map cells snap on the same
   frame. This is the actual novel work; the rest is mechanical.
4. **Read the flash-decay PNGs yourself** — the diff dropping is not proof; the lattice was
   tail-dwelling, so eyeball the bright regions.

**TRAPS.** (1) The whole revert happened because a metric masked a visible artifact — do not trust a
mean/median diff on this item; the percentile gate is mandatory. (2) Default-off byte-identity is the
charter floor — the emissive term must be a no-op when the driver is 0 (neutral-slot off-gate).
(3) B697 demand-resolve: the emissive term composites into HDR scene color — if you add any read-back
of scene color for a glow bleed, register as a C10-03 consumer or the resolve elision starves it.
(4) This is content for a perf campaign — keep it a single tight slice; do not fold in `SEED-11`
(precip coupling) or `SEED-13` (exotic) while here.

**VERIFICATION RECIPE.** New `probe-cloud-lightning.mjs` (P95/P99 grid-score on cyc-3/cyc-7 decay
frames + PNG read) = acceptance; neutral-slot off-gate byte-identity = charter gate;
`probe-cloud-tour.mjs` + `probe-multideck-parity.mjs` + `probe-weather-channels.mjs` green =
preservation (the flash rides the precip channel + multi-deck). No perf claim (content slice; assert
zero per-frame allocation when the flag is off).

**MODEL-TIER: fable** for the anti-tiling-gate design + temporal-edge softening (genuine judgment on
"what dissolves the lattice"), **opus** for the mechanical slot/WGSL re-add. **Effort M.**

---

### C11-125 — C6-CLOUD-STBN-TAAU — P2, feature, M — **BLOCKED on an offline license-clean asset (human/maintainer prerequisite)**

**WHAT + WHY.** Two orthogonal halves; the **LOD half SHIPPED B634** (geometric in-march step-growth
`marchStepGrowth`@144 + a `maxRayDistance`@145 far cap, both default no-op — verified at
`WebGPUProceduralCloudRenderer.ts:2104-2110` and the WGSL guards `> 1.0`/`> 0.0` in `marchDeck`).
The **DEFERRED headline** (`DEFERRED_WORK.md:17`) is the spatiotemporal-blue-noise rewrite: swap the
current **Bayer/`frameCounter` dither** (structured, bands/shimmers under motion, blocks going more
aggressive than half-res) to a **vector2 STBN sub-pixel jitter + per-pixel march-start dither**, then
the true **1/16 full-res-history TAAU** rewrite. The CLOUD_LOD_RESEARCH verdict
(`CLOUD_LOD_RESEARCH_2026-07-05.md:20/40/93`) confirms STBN is the single most impactful missing axis
("Bayer/frameCounter dither, NOT STBN … structured, not a blue-noise mask; item stands as a genuine
gap") and is the enabler for the orbit impostor (`SEED-10`).

**THE HARD LICENSING WALL (the reason this is blocked, not just deferred).** The jitter/TAAU code is
small; the blocker is the **asset**. The rewrite needs a genuine **128×128×64 `rgba8unorm` array STBN
texture**, and it must be generated **OFFLINE with EA SEED FastNoise (BSD-3-Clause)** —
**NVIDIA's STBN assets are non-commercial-license-poisoned and MUST NOT enter this Apache-2.0 fork**
(the DW entry states this in bold; the CLOUD_LOD_RESEARCH R-STBN lane confirms it). A genuine 3D
void-and-cluster generator run in-session is computationally infeasible (128²×64 = 1M voxels, O(M²)),
and independent-per-slice 2D VAC is white along the time axis (wrong for temporal convergence). So the
asset must be produced on a dev machine with `FastNoise.exe` (Windows) with recorded seeds, then the
**EA BSD-3 notice added to `LICENSE.md`'s Third-Party appendix**. The generation commands + seeds +
atlas-packing spec + WGSL/JS integration plan were written to `scratchpad/RESEARCH_R-STBN_2026-07-06.md`
§3.3/§5/§6 — **verified NOT committed to the repo** (`git ls-files | grep -i stbn` returns only
`probe-cloud-stbn-lod.mjs`). That plan doc is a session scratchpad and may be unrecoverable; if it is,
the R-STBN lane must be re-run before the asset can be baked.

**ARCHITECTURE TODAY (verified).** `CLOUD_QF_JITTER = 1 << 3` already exists and is reserved
(`WebGPUCloudTierPresets.ts:206`, marked "V6") — the STBN swap lands behind THIS bit with the Bayer
path kept as the loading/off fallback (exactly the DW's plan). The current dither is the
Bayer/golden-ratio cone jitter (float slot 76, `bIndex = frameCounter & 15u` per the research doc).
STBN resources would be built in `WebGPUCloudNoiseResources.ts` (the existing cloud-noise/bake
resource owner) as a new device-lifetime texture. The half-res + temporal resolve infra the TAAU
rewrite extends already ships: `CloudUpscale.wgsl` (V9 half-res bilateral) + `CloudTemporalResolve.wgsl`
(V10 temporal reprojection), both imported at `WebGPUProceduralCloudRenderer.ts:50-52`.

**IMPLEMENTATION WALKTHROUGH (post-asset).**
1. **Do NOT start until the maintainer confirms the asset path.** Surface to the orchestrator: "this
   needs a human to run EA SEED FastNoise offline and commit `stbn_128x128x64.png` + a LICENSE.md
   BSD-3 notice; I cannot generate a valid STBN mask in-session." If the R-STBN scratchpad is lost,
   re-run the research lane first.
2. **Slice 1 — jitter swap** (opus once the asset exists): upload the STBN array in
   `WebGPUCloudNoiseResources.ts`; index by `pixel.xy + frame % 64`; feed the existing jitter slot
   behind `CLOUD_QF_JITTER`; keep the Bayer path as the `defines=0`/loading fallback. Off-gate:
   `probe-cloud-stbn-lod.mjs` + `probe-cloud-u8-offident.mjs` byte-identical with the flag off.
   Acceptance: a new `probe-cloud-stbn-jitter.mjs` asserting reduced shimmer under a slow orbit
   sweep (temporal-stability metric across frames, not a single-frame diff).
3. **Slice 2 — 1/16 full-res-history TAAU** (fable design + opus execution): the true amortization
   rewrite per R-STBN §6.7, built on `CloudTemporalResolve.wgsl`. Its own slice; STBN jitter is its
   prerequisite (a good history reprojection needs blue-noise sample distribution).

**TRAPS.** (1) **License is the whole ballgame** — never vendor an NVIDIA STBN asset or a "found
online" blue-noise texture without confirming BSD-3/MIT/PD provenance and recording it in LICENSE.md.
(2) WebGPU-only, no WebGL twin (DW-stated). (3) `CLOUD_QF_JITTER` is add-only/reserved — do not
renumber it. (4) A wrong (white-along-time) mask silently makes TAAU converge to garbage without a
validation error — the temporal-stability probe is the only oracle that catches it.

**VERIFICATION RECIPE.** `probe-cloud-stbn-jitter.mjs` (temporal-stability under motion) +
`probe-cloud-stbn-lod.mjs` (existing LOD-half gate) + `probe-cloud-halfres-parity.mjs` +
`probe-cloud-temporal.mjs` green; off-gate byte-identity with `CLOUD_QF_JITTER` clear. No perf
promotion claim without the moving-altitude route (the whole point is orbit march cost — measure it).

**MODEL-TIER:** asset generation = **maintainer/human**; slice 1 jitter swap = **opus**; slice 2
TAAU = **fable** (design) + **opus** (execution). **Effort M (code) but gated indefinitely on the
asset.**

---

### C11-126 — CLOUD-U4-REMOVE-GLOBE-FLAG — P2, infra — **PREMISE-STALE: RESOLVED IN CODE. Collapses to doc reconciliation (S).**

**WHAT THE REGISTER/DW SAY vs HEAD.** The register (swept B698) lists this P2/infra/L as "BLOCKED on
an unmade architectural decision (premise VALID)", and `DEFERRED_WORK.md:15` (dated 2026-07-05)
records CLOUD-U4 as BLOCKED pending an (A)-vs-(B) product decision, with option (A) = "Scene (or Globe)
owns a managed default VOLUMETRIC `CloudCollection` and AtmosphericConditions.clouds / AtmosphericEffects
/ Weather-ingest / godRayCloudAware are all re-pointed at its `.volumetric`."

**This is STALE. Option (A) LANDED the same evening the BLOCKED note was written**, verified live at
`c643516c04`:
- `Globe.js:91` — `this._defaultCloudCollection = new CloudCollection();` (getter `:1078`, destroy
  `:1320`). Landed **B621 `8c7b8c7497` CLOUD-U4A-SCENE-DEFAULT-COLLECTION** (2026-07-05 19:05).
- The `globe.showProceduralClouds` + `globe.cloud*` user API is **gone from `Globe.js`** (grep for
  those symbols returns only `defaultCloudCollection`). Landed **B622 `b9eb70f74c`
  CLOUD-U4B-REMOVE-GLOBE-SURFACE** (2026-07-05 19:40).
- The four orphan-risk producers the DW entry flagged are all re-pointed: `AtmosphericConditions.js:794-935`
  proxies the ~50 `clouds.*` get/set pairs onto `globe.defaultCloudCollection.volumetric.*`;
  `AtmosphericEffects.ts` genus-bias, the Weather ingest sink (`WeatherProvider.ts`), and the
  `godRayCloudAware` gate (`WebGPUPostProcessStageCollection.ts:964/990`, which now reads
  `scene.godRayCloudAware` alone — no longer ANDed with the removed flag) all consume the managed
  collection.
- The residual `showProceduralClouds` grep hits (`WebGPUProceduralCloudRenderer.ts:398`,
  `CloudCollection.js:373`, `cesium-js-types.d.ts:1166`) are an **internal config-snapshot field name**
  (`config.showProceduralClouds`, derived from `renderMode`), NOT the removed user API — verified by
  reading the surrounding comments ("the field was removed in slice 4B").

**THE C11 DISPOSITION.** There is no epic to schedule. The slice is: (1) strike the BLOCKED status
from `DEFERRED_WORK.md:15`, mark CLOUD-U4-REMOVE-GLOBE-FLAG **RESOLVED (B621+B622, option A)**;
(2) update the register/queue rows (`C11-126` → RESOLVED) so the orchestrator does not schedule the
removal; (3) verify the migration held — run `probe-cloud-u4a-managed.mjs` (in-tree) + the cloud
battery (`probe-cloud-config.mjs`, `probe-cloud-property-edit.mjs`) + confirm the 4 Sandcastle demos
+ the `probe-cloud-*`/`probe-weather-*`/`probe-multideck-*` battery still resolve against
`defaultCloudCollection`. If any probe still references `globe.showProceduralClouds`, that is the only
remaining code work (migrate the probe, not the engine).

**TRAPS.** (1) Do NOT re-run the removal — it is done; re-doing it would double-remove and break the
proxies. (2) Do not delete the internal `config.showProceduralClouds` field name (it is the snapshot's
renderMode-derived boolean, live scaffolding). (3) This is the cluster's canonical premise-stale
lesson: the register was swept at B698 but the fix landed at B621/B622 — always `git log -S` the
symbol before believing a "BLOCKED" status on a cloud row.

**VERIFICATION RECIPE.** `probe-cloud-u4a-managed.mjs` green + the cloud/weather/multideck battery
green + a repo grep proving no engine `globe.showProceduralClouds` reader remains. Doc-diff only.

**MODEL-TIER: opus** (mechanical doc reconciliation + probe sweep). **Effort S** (was L; the epic is
already paid).

---

### C11-127 — Q36-WEATHER-PHASE-4-GRIB2 — P2, feature, L — **BLOCKED: proxy + WASM + no sandbox network**

**WHAT + WHY.** The weather-ingest roadmap's Phase-4 high-fidelity tier: direct GRIB2/NetCDF ingest
(HRRR/GFS/NBM) decoded in a Worker/WASM, feeding the same weather-map texture the shipped EDR/WCS/METAR
sources feed (`WEATHER_DATA_INGEST_ROADMAP.md:149-153`). It is the roadmap's declared "critical-path
weather item" and the north-star data quality — HRRR 3 km ceiling/base/top/VIS + categorical precip.

**Why it is blocked (three walls, none of which a sandbox worker can clear):**
1. **CORS proxy** — NOAA NODD S3 has no permissive browser CORS; Phase 4 "is NOT browser-feasible
   without a proxy" (roadmap "Honest caveats"). Building the same-origin proxy is the unblock and is
   infrastructure work, not a renderer slice.
2. **GRIB2 WASM decoder** — must be built per the WASM strategy (feature-detect, async, JS fallback,
   destroy/free/version/SIMD) + Lambert-Conformal→equirect reprojection isolated in the packer.
3. **No outbound network in the dev sandbox** — CLI `curl`→`http=000`, browser `fetch`→timeout
   (roadmap:27-31). Even the proxy cannot be exercised here.

**ARCHITECTURE TODAY (verified).** The consumer seam is complete and waiting: `WeatherProvider`
(`WeatherProvider.ts:37`) holds an active `WeatherSource` + packer + cache; `getPackedTexture(texW,
texH)` (`:201`) and `fetchField` (`:283`) are the integration points; the three shipped sources
(`EdrWeatherSource:49`, `MetarWeatherSource:220`, `WcsCoveragesWeatherSource:56`) all
`implements WeatherSource` and delegate CRS resample to the shared `WeatherTexPacker` + `CoverageJsonParser`.
A `Grib2FileWeatherSource` slots in as a fourth `WeatherSource` with zero renderer change (the packer
already owns unit conversion + the equirect target).

**DISPOSITION.** Do not schedule in the sandbox. The concrete first step (proxy build) is
maintainer/infrastructure work; surface it as such. What CAN be prepared in-session: a mock-fixture
harness for GRIB2 (mirroring the shipped `/mock-edr` fixture route) so the decoder + reprojection can
be verified offline against a hand-authored small GRIB2 blob once the WASM decoder exists — but that
is a subordinate slice under a decoder that itself needs the proxy story decided first.

**TRAPS.** (1) The "in-browser, no server" claim is false for Phase 4 — do not let a brief imply
otherwise (roadmap caveats). (2) GRIB2 native grids can be multi-MB — resample OFF the render path
(the packer, not per frame). (3) Licensing is non-uniform (NOAA PD ✅, ECMWF CC-BY-4.0 needs
attribution carried in `WeatherField.attribution`, ERA5 is key-gated — defer).

**VERIFICATION RECIPE.** A future `probe-weather-grib2-mock.mjs` (offline fixture ramp reaching the
deck, mirroring `probe-weather-edr-mock.mjs`) once the decoder exists. The LIVE hop is
env-blocked — same wall as `C11-128`.

**MODEL-TIER:** proxy + network = **maintainer/human**; the WASM decoder + packer reprojection =
**opus-or-sol** (well-specified once unblocked). **Effort L, blocked.**

---

### C11-128 — Live EDR network confirm — P2, tooling, S — **BLOCKED: needs a networked browser session**

**WHAT + WHY.** `EdrWeatherSource` is wired and verified END-TO-END OFFLINE (fetch→CoverageJSON
parse→packer→weatherTex→deck) via the `/mock-edr` fixture harness (roadmap:7-13), but the **LIVE NOAA
EDR call, its CORS behavior, and the guessed collection id `automated_gfs` have never been confirmed
against the real service** (`WEATHER_DATA_INGEST_ROADMAP.md:27-31`; register LQ §8.2). The dev sandbox
has no outbound network to external hosts, so this is the one residual the mock harness cannot cover.

**ARCHITECTURE TODAY (verified).** `EdrWeatherSource` (`Scene/Weather/EdrWeatherSource.ts:49`)
implements `WeatherSource`, delegates parse to `CoverageJsonParser.ts`, and is driven by
`WeatherProvider`. The optional same-origin proxy + `AbortSignal` support was built in from Phase 1
(roadmap:136). The endpoint under test: OGC API-EDR `cube` query → CoverageJSON, NWS-MDL,
`https://data-api.mdl.nws.noaa.gov/EDR-API`, parameter `TCDC`.

**DISPOSITION.** Environment-blocked, not code-blocked. Surface to the maintainer: "run
`probe-weather-edr-live.mjs` (to be authored) in a networked Edge session; confirm (a) CORS preflight
passes or a proxy is required, (b) the real collection id (validate `automated_gfs` or discover the
correct GFS collection), (c) the returned grid is subsampled not native-resolution." If CORS fails, the
"no server" claim collapses and this merges into the `C11-127` proxy story. Nothing lands in the
sandbox but the probe skeleton + a written checklist.

**TRAPS.** (1) NWS-MDL EDR is a prototype endpoint — "may vanish without notice"; keep MSC GeoMet
(WCS) as the production fallback and do not build a product on the dev-lab endpoint alone. (2) The
collection id is a GUESS — treat a 404 as expected until confirmed, not a code bug.

**VERIFICATION RECIPE.** `probe-weather-edr-live.mjs` in a networked session (CORS + collection-id +
subsampling assertions). Offline: the existing `probe-weather-edr-mock.mjs` stays the regression gate.

**MODEL-TIER: maintainer/human** (network confirm); probe skeleton = **opus**. **Effort S, env-blocked.**

---

### C11-129 — WeatherSystem / scene.weather facade (Phase 3) — P2, feature, M

**WHAT + WHY.** The weather data core + `globe.weatherProvider` wiring shipped, but there is **no
top-level `scene.weather` facade** consolidating the three overlapping surfaces — clouds
(`CloudCollection`/`CloudVolumetrics`), weather-data ingest (`WeatherProvider`/sources), and
atmospheric-conditions (`AtmosphericConditions` precipitation/effects) — into one public API, and the
**explicit WebGL degradation ladder is unbuilt** (register LQ §8.2). Today a user must reach into
three subsystems to drive "make it storm here"; the facade is the consolidation that makes the whole
weather epic usable and demoable (it is the API surface `SEED-16`'s historical-replay demo needs).

**ARCHITECTURE TODAY (verified).** The pieces to consolidate all exist and are backend-neutral:
`WeatherProvider` (`WeatherProvider.ts:37`, `getPackedTexture`/`fetchField`, time model
`setTimeMode`/`setTime`/`tick`); the source registry (`Edr`/`Metar`/`Wcs`/`Synthetic` all
`implements WeatherSource`); `globe.defaultCloudCollection` (post-U4, `Globe.js:91`) with its
`.volumetric` `CloudVolumetrics`; `AtmosphericConditions.js` precipitation config (`:1188-1193`,
`snowAccumulation` default false) + `AtmosphericEffects.ts` (`precipFromWmoCode:149`,
`precipitationTypeToString:66`, `updateSnowAccumulation:277`). There is NO `scene.weather` symbol
today (grep-clean). The facade is a **Scene-level backend-neutral object** (Principle 2 — no
`Renderer/WebGPU` import, no `isWebGPU` branch) that owns the provider, exposes source-swap, and
routes preset/live/historical modes to the collection + atmospheric-conditions.

**IMPLEMENTATION WALKTHROUGH.**
1. **Design the API first (fable) — this is the judgment work.** Enumerate the consolidated surface:
   `scene.weather.setSource(...)`, `.setTimeMode/.setTime`, `.applyPreset(...)` (the shipped METAR/WMO
   vocabulary), `.enabled`, and the read side. Decide ownership: does `scene.weather` own the provider
   that `globe.weatherProvider` currently holds, or wrap it? (Recommend: `scene.weather` is the public
   facade; `globe.weatherProvider` becomes an internal detail it delegates to — do NOT duplicate
   state.) Write it as a short API-shape memo for maintainer sign-off before wiring (this is a public
   API addition; the shape is a one-way door).
2. **Wire the facade** (opus) as a Scene-owned object delegating to the existing provider + collection
   + atmospheric-conditions. No renderer change — the renderer already consumes
   `config.weatherProvider` (`WebGPUProceduralCloudRenderer.ts:1725`).
3. **The explicit WebGL degradation ladder** — the volumetric cloud response to weather is WebGPU-only;
   on WebGL the facade must degrade to the billboard `CloudCollection` + the atmospheric-conditions
   precipitation particles (which ARE backend-neutral). Document the ladder per mode (live/historical/
   preset) and what each backend renders. This is the "explicit WebGL degradation" the register names.
4. **Probe:** `probe-weather-facade.mjs` — drive `scene.weather` through source-swap + time-mode +
   preset on both backends, assert the deck/particles respond and no renderer branch leaks into Scene.

**TRAPS.** (1) Principle 2 — the facade is Scene code, must be backend-agnostic (no
`context.isWebGPU`); the WebGL/WebGPU split lives below it in the renderer. (2) Do not duplicate
provider state between `scene.weather` and `globe.weatherProvider` — pick one owner. (3) Public API
addition — get the shape signed off; renaming later is a breaking change. (4) The degradation ladder
must not silently no-op on WebGL — a facade that does nothing on WebGL is a feature-parity gap, not a
graceful degrade.

**VERIFICATION RECIPE.** `probe-weather-facade.mjs` (both backends, source-swap + time + preset) +
the existing `probe-weather-presets.mjs`/`probe-weather-time.mjs`/`probe-weather-inspector.mjs` green
+ a grep proving no `isWebGPU`/`Renderer/WebGPU` import entered the Scene facade file. No perf claim.

**MODEL-TIER: fable** (API design + degradation-ladder judgment), **opus** for the wiring. **Effort M.**

---

### C11-130 — PRECIP-DATA ground snow-albedo shader consumer — P2, feature, S

**WHAT + WHY.** B444 shipped the snow-accumulation PRODUCER (`updateSnowAccumulation`,
`AtmosphericEffects.ts:277`, consumed at `:724-728`, mirrored as a weather-renderer uniform at
`WebGPUWeatherRenderer.ts:100`) — a per-frame integrated snow-cover scalar (0..1) driven by WMO
present-weather → precip type. **But no globe shader consumes it** — verified: `git grep -i snow`
over `Shaders/WebGPU/Globe/*` + `GlobeFS.glsl` is **empty**. So snowfall accumulates a number that
nothing renders; the fill-in (register LQ §9.2, Principle-9 follow-up) is the globe-surface consumer
that visibly whitens terrain albedo as snow accumulates.

**ARCHITECTURE TODAY (verified).** Producer: `AtmosphericEffects.ts` `updateSnowAccumulation` (`:277`)
+ the precipitation config gate (`AtmosphericConditions.js:1188-1193`, `snowAccumulation` default
**false** → byte-identical until opted in). Mirror: `WebGPUWeatherRenderer.ts:100` already carries the
`0..1` cover as a uniform ("mirrored here so …"). The MISSING consumer is a globe-surface albedo lerp
gated on the snow-cover scalar + (ideally) elevation/slope masking so snow settles on flat/high ground
not cliffs.

**This is a GLOBE-SURFACE feature, so Principle 5 applies — it needs BOTH backends.** Unlike the
volumetric cloud march (WebGPU-only), snow-on-terrain lands on the globe, so it needs a WGSL consumer
in `GlobeTerrain.wgsl` AND a GLSL consumer in `GlobeFS.glsl`, both gated so `snowAccumulation=false`
(the default) is byte-identical.

**IMPLEMENTATION WALKTHROUGH.**
1. **Premise-verify + probe first.** Confirm the producer still runs at HEAD (`probe-precip-data.mjs`
   / `probe-precip-wiring.mjs` exist — run them). New `probe-snow-albedo.mjs`: enable
   `atmosphericConditions.effects.precipitation` with `snowAccumulation:true` + a snow WMO code over a
   terrain view, ramp the accumulation, and assert terrain pixels lighten toward white on BOTH
   backends; the `snowAccumulation:false` leg stays byte-identical (off-gate).
2. **Thread the scalar to the globe shaders.** The weather renderer already has the uniform; route the
   snow cover into the globe-surface uniform block (a single float; add-only) — mind the
   `GlobeTerrain.wgsl` group-0 UBO (do not grow it past device limits; reuse an existing pad or a
   weather-effects slot). This overlaps the terrain UBO surface that `C9-12`/`FAR-303` are redesigning
   — coordinate; a single float in an existing effects block is the low-risk placement.
3. **Add the albedo lerp** in both `GlobeTerrain.wgsl` and `GlobeFS.glsl`, gated on the scalar > 0,
   with an optional slope/elevation mask (snow on flat high ground). Off-gate: scalar = 0 → no color
   change (byte-identical).
4. **Read the PNGs** on both backends; assert parity within the terrain band.

**TRAPS.** (1) **Both backends** — this is the one item in the cluster that genuinely needs a GLSL
twin (globe surface, not cloud march). A WGSL-only snow effect is a parity gap. (2) Default-off
byte-identity is charter-mandatory (`snowAccumulation` default false). (3) Do not grow the
`GlobeTerrain.wgsl` group-0 UBO if it collides with the `C9-12` static/dynamic split — use an existing
effects slot; check the terrain-imagery cluster's live work. (4) The snow scalar is a global cover
today, not a spatial field — v1 whitens uniformly where precip is active; a per-position snow field
(coupled to the weather-map) is a `SEED-11`-adjacent follow-up, not this slice (one concern).

**VERIFICATION RECIPE.** New `probe-snow-albedo.mjs` (both backends, accumulation ramp + off-gate) +
`probe-precip-data.mjs`/`probe-precip-wiring.mjs` green + `capture-and-diff globe-default` unchanged
(default snow off → zero diff). No perf claim.

**MODEL-TIER: opus** (well-specified producer→consumer wiring; the only judgment is the slope mask,
which can be v2). **Effort S** (M if the slope/elevation mask is pursued in v1).

---

## G12.2 — P3 content-epic seeds / dossiers (`C11-SEED-10..18`)

These are research-stage or content-arc items. Each dossier is written so a worker can start the day
the maintainer green-lights content scope, but **none should be scheduled speculatively in a
perf-focused campaign** — flag them as content seeds to the orchestrator. Maturity is honest: several
have "research complete, zero code."

### C11-SEED-10 — C7-CLOUD-IMPOSTOR-LOD — P3, perf, L

Octahedral impostor LOD for the VOLUMETRIC `CloudCollection` renderMode (`DEFERRED_WORK.md:5235`;
`RESEARCH_R-IMPOSTOR_2026-07-06.md`; research complete, zero code). **Dependency update: the register
lists "dep CLOUD-U4" — that dependency is now SATISFIED** (the VOLUMETRIC renderMode toggle exists
post-B621/B622). **Maturity honesty:** the CLOUD_LOD_RESEARCH decisive finding is that impostors are a
QUALITY/BATTERY tier, **NOT the only orbit bridge** — Takram reaches orbit-viable perf via
step-growth (shipped B634) + STBN + 1/16 TAAU (blocked on `C11-125`'s asset). So sequence impostors
AFTER `C11-125` proves the cheap levers, and reframe as opt-in quality, not a perf necessity. Design:
Phase 1 = single "freeze & reproject" impostor (reuse the half-res `rgba16float` premultiplied target
+ V10 temporal reprojection; re-march only when a Harris-2001 staleness predicate trips — view angle
>~0.5°, sun-delta, weather/wind hash, altitude band) → ~60× march-cost cut at orbit with ~90% existing
infra; Phase 2 = 8×8 octahedron atlas with 3-nearest-frame barycentric blend + premultiplied-alpha
composite + 6-axis lighting basis. Fork wiring: entry `executeProceduralClouds()`
(`WebGPUProceduralCloudRenderer.ts:1489`), append `CloudUniforms` at 148+ (add-only; Batch 634's
144/145 are the current tail), new `qualityFlags` bit `CLOUD_QF_IMPOSTOR`, new add-only `ShaderDefine`,
emit `t̄` depth as a gated 2nd render target so `defines=0` is byte-identical. **STBN-mask prereq**
(same license wall as `C11-125`). **Traps:** frame SELECTION must be per-camera (planet-centric dir),
never per-pixel (per-pixel seams crawl); premultiplied-alpha (straight alpha triple-darkens a
semi-transparent shell); `cloudImpostorMode='off'` default byte-identical; 3D-scene-mode-only; never
display an unbaked cell (fall back to live march). Probes to author: `probe-cloud-impostor-off`
(byte-identical), `-parity` (orbit live-march vs impostor ≤2%), `-motion` (<1 march/frame + sun/weather
re-bake triggers). **Model tier: fable** (staleness predicate + blend design), **opus** (atlas bake +
WGSL). **Effort L (Phase 1 M, Phase 2 L).**

### C11-SEED-11 — CLOUD-LOD-R8-PRECIPITATION-COUPLING — P3, feature, L

Rain shafts + ground wetness coupled to the weather-map precip channel (register LQ C7 §5 +
`CLOUD_LOD_RESEARCH`). Sequenced AFTER R5 (landed B651) + R7 lightning reland (`C11-124`) — the precip
channel + flash driver are the shared substrate. Rain shafts are a march-side effect (WebGPU-only,
cloud-march); ground wetness is a globe-surface albedo/roughness effect (BOTH backends, like `C11-130`
snow — coordinate with it, they are siblings on the terrain-albedo surface). Content-arc item; hold
for a follow-on cloud-content campaign. **Model tier: fable** (design) + **opus** (execution).
**Effort L.**

### C11-SEED-12 — CLOUD-LOD-R9-PLANET-SCALE-CLOUD-TILING — P3, feature, XL

Hierarchical quadtree planet-scale cloud tiling — "the largest remaining cloud gap" (register LQ C7 §5;
`CLOUD_LOD_RESEARCH:47` item 9). Today a single 256×128 weather map covers the whole globe
(`WEATHER_TEX_W/H`), so orbit views get coarse, potentially-repeating cover; Skybolt uses 8096² +
tiling detail + mip LOD. This is the substrate an orbit impostor (`SEED-10`) renders from, so it
sequences with/before impostors for the far field. XL, research-stage (higher-res/streamed coverage +
multi-scale tiling + camera-distance mip select). WebGPU-only (cloud march). **Model tier: fable**
(architecture) then **opus**. **Effort XL** — a dedicated arc, not a campaign slice.

### C11-SEED-13 — CLOUD-EXOTIC-E3-SPECIAL remainder — P3, feature, L

Contrails (line sources) + pyrocumulus (event/data-driven) — the two never-built halves of the
exotic-cloud E3 arc (register LQ §8.3 + C5 #23). B612 landed the noctilucent+nacreous half
(`specialShadeMode` slots 140-143, verified at `WebGPUProceduralCloudRenderer.ts:69`; the exotic
species/features/special families occupy slots 132-143). The remainder **needs new deck/source
infrastructure** (line sources for contrails, event-driven sources for pyrocumulus) that does not
exist — that is the real blocker, not the shading. WebGPU-only. Content-arc; needs the source-infra
design before any shader work. **Model tier: fable** (source-infra design) + **opus**. **Effort L.**

### C11-SEED-14 — Cloud perf — Tier-2 3D bake (view-local cascaded clipmap) — P3, perf, XL

The declared PRODUCTION path for volumetric clouds (register LQ §8.2 Phase 6): a resident global 2D
weather map (shipped) feeding a camera-anchored cascaded-clipmap 3D density bake per frame, modeled on
`WebGPUVolumetricFogRenderer`. The current raymarcher is Tier-1 only (marches the analytic
density field directly). This is the structural perf rework that would make dense volumetric clouds
affordable at scale — and the one genuinely perf-classed item in the P3 tail, so it is the seed most
worth surfacing to a perf campaign. XL, own post-core campaign. WebGPU-only. **Model tier: fable**
(clipmap architecture) + **opus/sol** (compute bake). **Effort XL.**

### C11-SEED-15 — Temporal interpolation + advection (Phase 5) — P3, feature, M — **repro probe MISSING**

A/B weather-DATA keyframe lerp + per-cell U/V wind advection between sparse frames (register LQ §8.2),
distinct from the shipped RENDER-side reprojection (B433) and the shipped DATA time-model
(`WeatherProvider` `setTimeMode`/`tick`, verified). The **DATA keyframe-lerp half is partly covered**
by `probe-weather-time.mjs` (the time model + LRU slice cache, 9/9 green offline). The **per-cell U/V
wind advection half has NO repro probe** — this is the "item-13 Slice W needs its probe built first"
gap the register flags. (Note: the register/assembler's blanket "a weather probe does not exist" is
imprecise — the cluster has ~14 `probe-weather-*` probes; the genuinely-missing ones are wind
advection here, GRIB2 for `C11-127`, live-EDR for `C11-128`, and snow-albedo for `C11-130`.) **Propose:
`probe-weather-advection.mjs`** — drive a `SyntheticWeatherSource("drift")`-style field with a known
U/V wind vector across sparse keyframes and assert the packed field advects (a coverage feature moves
by the expected cell offset between frames) rather than snapping at keyframe boundaries. Build that
RED probe first, then implement per-cell advection in the packer/provider. WebGPU-visible via the deck
but the advection math is backend-neutral (Scene/Weather). **Model tier: fable** (advection model) +
**opus** (packer). **Effort M.**

### C11-SEED-16 — Historical-replay headline demo (Phase 4) — P3, feature, M — gated on `C11-127`

Pre-baked named-storm ERA5/GFS manifest tied to `scene.clock` — the weather epic's north-star
deliverable (register LQ §8.2). Gated on `C11-127` (GRIB2 ingest) for real historical data, and it is
the demo surface `C11-129`'s `scene.weather` facade is built to drive. Could ship a MOCK-fixture
version offline (a hand-authored storm manifest via the existing mock harness) as a demo skeleton
without the live GRIB2 path — that is the only in-sandbox-schedulable slice, and it is a demo, not a
feature. **Model tier: opus** (demo wiring over the facade). **Effort M**, gated.

### C11-SEED-17 — profileExtinction (slot 103) per-position optical extinction — P3, feature, M

B452 activated `profileExtinction` (slot 103) but it is a **per-GENUS scalar** today, not a
per-position field. Verified at HEAD: `ProceduralClouds.wgsl:95` (struct field), `:1209`
(`scale = select(1.0, cloud.profileExtinction, cloud.profileExtinction > 0.0)` — scales the global
`absorptionCoeff` in the light march + view-ray transmittance), packed at
`WebGPUProceduralCloudRenderer.ts:1874-1881` (normalized vs CUMULUS=1.0). The register's framing ("G
only biases shape/density") is slightly stale — the genus scalar DOES bias extinction uniformly now;
the declared fill-in (register LQ §8.2, Principle-9 follow-up) is the **full per-position optical
extinction** varying along the march with local weather-A/density, not a single per-genus constant.
The slot is live scaffolding (Principle 7 — do not remove; the `> 0.0` guard is the neutral fallback).
WebGPU-only. Well-specified fill-in but needs a per-position extinction model design first. **Model
tier: fable** (extinction model) + **opus** (WGSL). **Effort M.**

### C11-SEED-18 — NEW-CLOUD-SHADOW-ENVMAP — P3, feature, S

Env-map ground cloud-shadow term deferred from the 4.1 CLOUD-SHADOWS work (register LQ §9.2):
reflections/env-cube still ignore cloud shadowing (the Beer shadow map shadows terrain + aerial + fog
but not the dynamic environment cubemap). Smallest P3 seed. The env-cube path is
`WebGPUDynamicEnvironmentMapManager.ts` (which already references the cloud gate — grep hit at `:1297`).
The fill-in: apply the existing cloud Beer-shadow term to the env-cube capture so reflections darken
under cloud cover. WebGPU-only (env-cube is a WebGPU path). **Model tier: opus** (well-scoped term
addition). **Effort S.**

---

## G12.3 — Shared traps index (applies across the cluster)

1. **Premise-stale is the cluster norm.** The register was swept at B698; several cloud rows were
   already resolved/moved earlier (CLOUD-U4 at B621/B622). `git log -S <symbol>` before believing any
   "BLOCKED"/"WIP" cloud status.
2. **Default-off byte-identity is a charter floor, not a nicety.** Every feature here is opt-in;
   `probe-cloud-u8-offident.mjs` is the standing sentinel; every new `qualityFlags` bit /
   `CloudUniforms` slot must be add-only with a no-op default.
3. **License wall (STBN).** No NVIDIA STBN, no unprovenanced blue-noise texture. EA SEED FastNoise
   BSD-3, generated OFFLINE, recorded in LICENSE.md. This blocks `C11-125` and `C11-SEED-10`'s masks.
4. **WebGPU-only vs both-backend.** Cloud-march items are WebGPU-only by architecture (no GLSL twin
   owed). Globe/scene-surface items — `C11-130` (snow), `SEED-11` (ground wetness) — land on the globe
   and DO owe a GLSL twin (Principle 5).
5. **Environment-blocked ≠ code-blocked.** `C11-127` (proxy/WASM/network) and `C11-128` (live network)
   cannot be exercised in the sandbox — surface them as maintainer/infra prerequisites, do not fake a
   green.
6. **B697 demand-resolve.** The cloud march + any glow/composite reads HDR scene color — register as a
   C10-03 consumer or the resolve elision starves it (the same failure shape as the open
   `NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING` latent bug).
7. **`CloudUniforms` growth is add-only** (ledger at `WebGPUProceduralCloudRenderer.ts:60-70`, currently
   148). Never reorder; append at the tail; keep the WGSL struct length in lockstep.
8. **Content in a perf campaign.** This entire cluster is content-epic work. Keep every slice tight
   (one concern); resist folding lightning + precip + exotic together; and flag to the orchestrator
   that most of the cluster is arguably Campaign-12 content, not C11 perf.

---

## OPEN QUESTIONS FOR THE ORCHESTRATOR

1. **Which of these are true C11 slices vs Campaign-12 content seeds?** Only three rows are cleanly
   schedulable in a perf-focused campaign: `C11-124` (lightning reland), `C11-129` (scene.weather
   facade), `C11-130` (snow-albedo consumer). `C11-126` is a doc-reconciliation (already resolved).
   The other eleven are blocked (`125/127/128`) or P3 content arcs (`SEED-10..18`). Recommend
   scheduling only the three-plus-doc-fix in C11 and explicitly deferring the P3 content arc to a
   dedicated cloud-content campaign — the register itself contradicts opening content epics in a perf
   campaign whose promotion bar is CPU-p95.

2. **`C11-126` is RESOLVED — confirm the disposition.** CLOUD-U4-REMOVE-GLOBE-FLAG landed as B621
   (option A: Globe-owned `defaultCloudCollection`) + B622 (removed the `globe.showProceduralClouds`/
   `globe.cloud*` API), on 2026-07-05 evening, AFTER the DW "BLOCKED" note earlier the same day. The
   register/queue rows are stale. The only C11 work is doc reconciliation + a probe sweep. Confirm the
   orchestrator wants the row closed rather than re-scheduled as the epic it appears to be.

3. **The STBN asset-generation prerequisite is a HUMAN/MAINTAINER task.** `C11-125` (and the impostor
   masks in `SEED-10`) need a `128×128×64 rgba8unorm` STBN texture baked offline with EA SEED FastNoise
   (BSD-3) on a Windows dev machine, plus a LICENSE.md notice. This cannot happen in-session, and the
   generation plan (`scratchpad/RESEARCH_R-STBN_2026-07-06.md`) is NOT committed to the repo — if it is
   lost, the R-STBN research lane must be re-run first. Does the maintainer want to produce the asset
   (unblocking `125` + `SEED-10`'s quality tier), or should both stay parked?

4. **The missing weather probe.** The register/assembler note that "a weather probe does not exist" is
   imprecise — the cluster has ~14 `probe-weather-*` probes. The genuinely-missing repro probes are:
   `probe-weather-advection.mjs` (per-cell wind advection, `SEED-15`/"item-13 Slice W" — build RED
   first), `probe-weather-grib2-mock.mjs` (`C11-127`, needs the WASM decoder), `probe-weather-edr-live.mjs`
   (`C11-128`, needs a networked session), and `probe-snow-albedo.mjs` (`C11-130`). Confirm the
   orchestrator wants these authored as part of their respective slices.

5. **Maintainer appetite for content-epic scope.** This is the fork's largest content cluster (the
   deferred halves of C2–C7's cloud/weather campaigns) landing in a campaign whose charter is
   default-path CPU-p95 recovery. The one P3 seed that is genuinely PERF-classed is `SEED-14` (Tier-2
   cascaded-clipmap 3D bake — the production volumetric path). If the maintainer wants any cloud work in
   C11 beyond the three schedulable P2s, `SEED-14` is the one with a perf rationale; the rest are
   fidelity/content and belong in a cloud-content arc. Does the campaign want content in scope at all,
   or should G12's output be "close the resolved row, park the rest, schedule the three small P2s"?
