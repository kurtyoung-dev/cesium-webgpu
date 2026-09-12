# Campaign 13 v2 — Maintainer Decisions (§7)

**Status: LANDED** (Batch 1476, tree `a5975c5bfe`, 2026-09-12).

**Date:** 2026-09-12 · **Source:** `CAMPAIGN_13_V2_CLOUD_QUALITY_2026-09-12.md` §7 · **For:** the Fable seat to put to the maintainer

Twenty decisions. Each has 2–4 options with a one-line pro and con; one option is marked **(Recommended)**. Six are marked **LAUNCH SEAL** — they are answerable with no engineering and each blocks a Wave-1 or Wave-2 row, so they should be answered before any lane is dispatched.

Three decisions (**D8**, **D9**, **D13**) are put rather than pushed: the plan's recommendation there is provisional and the reasoning says why.

---

## D1 — Capture-spine strategy · **LAUNCH SEAL**

*Do we single-thread the campaign through `C13-42a` (the unlanded probe-runtime rewrite)?*

- **(a) C13-42a-first.** One runtime, no divergence. — *Con:* a 977-line unlanded rewrite that breaks 21 probes becomes the campaign's single point of failure, and it still cannot produce acceptance (`CHARACTERIZATION_THRESHOLDS = null`, two of seven cells structurally unsatisfiable).
- **(b) Two lanes, with `C13-N01` STAGED — detector + census in Wave 1, routing in Wave 2 after `C13-42a` lands. (Recommended)** The orbital programme starts immediately and nothing is written twice. — *Con:* two runtimes coexist until `C13-42a` lands.
- **(c) Two lanes, `C13-N01` unstaged (the draft's form).** Fastest on paper. — *Con:* routing 60 probes to HEAD's `cells({…})` shape while `C13-42a` changes that shape schedules **26,959 lines across 60 files to be rewritten twice**.
- **(d) Abandon the C13-42 apparatus** and rebuild demo reproduction on the HEAD runtime. One runtime. — *Con:* discards ~4,000 lines of built work and three rulings' worth of contract.

---

## D2 — The M2 `Globe.js` default (currently HELD under `R-2026-09-10-6`)

*When, if ever, do clouds become on by default?*

- **(a) Keep held** until `C13-44` (stipple) plus a measured frame cost. Honours the ruling exactly. — *Con:* the campaign's flagship feature stays invisible for five waves.
- **(b) Revisit at Wave 4: default ON at the new Shell rung, march still off until `C13-44`. (Recommended)** The Shell is sub-millisecond-targeted and is the only rung with a GLSL twin, so the default would be identical on both backends. — *Con:* it makes the product default contingent on a rung that does not exist yet, and the draft's supporting claim — "the Shell structurally cannot stipple" — is **unverified**, being a property of unwritten code (`CLOUD_TIER_PRESETS` has four tiers, 0–3, and no shell entry). This is a *revisit* of the ruling at Wave 4, not a pre-emption of it; Wave 1 does not touch `Globe.js`.
- **(c) Default ON at tier 3 now.** — *Con:* the banked `c13-20260909-calibration-03/R-atmospheric-on-2-run0.png` is a near-black 1600×800 frame with a dense concentric ring/spoke stipple over the whole canvas. No pro survives that.

---

## D3 — Scope of the WebGL parity floor (adjacent to open decision `AR-D13`)

*What does "both renderers to GIS-data-simulator quality" oblige on WebGL?*

- **(a) Shell-only floor, sized XL, including 3 analytic shells over the 3 weather slices. (Recommended)** Satisfies the primary (orbital) goal on both backends at a tractable cost; gives the backend-neutral `Scene/Weather/*` layer its first WebGL consumer; makes clouds eligible for `capture-and-diff.mjs` for the first time; gives `AR-D13` a concrete partial answer. — *Con:* a second shell shader to keep in sync, and the flight-sim bar becomes an explicitly WebGPU-only claim.
- **(b) No WebGL floor.** One implementation to maintain. — *Con:* the stated goal names both renderers, and today WebGL silently no-ops on clouds, weather and god rays.
- **(c) Full WebGL parity** including a GLSL march and god rays. Complete symmetry. — *Con:* `ProceduralClouds.wgsl` is 3,157 lines and the god-ray stack has no GLSL analogue at all; `AR-D13` is open precisely because this is expensive.

*(Note for either (a) or (c): there is no WebGL cloud renderer class, no WebGL weather texture, sampler or uniform anywhere today. The floor is plumbing plus a shader, not a shader.)*

---

## D4 — Re-point `C13-15/16/17/20` off the XL `C13-14` · **LAUNCH SEAL**

*The single highest schedule-value decision in the plan.*

- **(a) Re-point onto `C13-N22`/`C13-N23`/`C13-N27`/`C13-N38`, and defer the quadtree behind the first measured resolution ceiling. (Recommended)** Four rows have been NOT STARTED since 2026-07-23 solely because of this edge; tiling is genuinely unnecessary below ~4096×2048. — *Con:* a second migration later if we exceed that ceiling; and `RULING-2026-08-06 R2` says C13 stays open as-is with no re-scope, so this must be ruled as a **re-sequencing**, not assumed.
- **(b) Keep `C13-14` as the blocker** and do the XL first. Honours R2 literally. — *Con:* an XL blocks four rows and an M.
- **(c) Both in parallel.** No waiting. — *Con:* contends for the same authors and the same single Edge slot.

---

## D5 — Weather texture resolution

*How fine does the global coverage field get, and when?*

- **(a) 1440×721 now (GFS native), sized M. (Recommended)** 5.6× linear detail for a bounded change; no tile schema needed; the data does not support more. — *Con:* a later tiled path will change the sampling again; and the row is **not** the two-constant edit the draft claimed — the seam spec mirrors the dimensions and goes red unless updated in the same batch.
- **(b) Wait for `C13-14` tiles.** One migration only. — *Con:* an XL blocks an M, and the current 156 km/texel is 24× coarser than a full-disc screen pixel — the dominant orbital error once lighting is fixed.
- **(c) 8192×4096.** Maximum headroom. — *Con:* 134 MB for invented detail; no free global source resolves below ~8 km.

---

## D6 — Default data source · **LAUNCH SEAL (the four remaining template checks, not the ruling)**

*Which feed is the engine's default weather provider?*

- **(a) GFS primary + GMGSI imagery referee + ECMWF as a second provider behind the same interface. (Recommended)** GFS is the only free source verified to carry all three layer fractions *and* per-layer cloud top/bottom; US public domain; GMGSI gives the ground-truth referee. **The decoder risk is now measured, not assumed:** two real banked GFS cloud records were parsed this session and **both carry DRS template 5.3** — complex packing with spatial differencing, decodable in pure TypeScript, **no JPEG2000 and no WASM** — with `numPoints = 1,038,240 = 1440 × 721`, which also confirms the native-grid figure. — *Con:* a GRIB2 complex-packing decoder to write and maintain (group splitting with per-group reference values, widths and lengths, then the spatial-difference recursion — not the simple bit-unpack the draft described); US-government availability is a single point of failure; **and four record types are still unchecked** — `MCDC`, `HCDC`, per-layer `PRES` cloud bottom/top, `TMP` cloud top. Run the same one-line check on those before sizing `C13-N24`; if any is template 5.40, that record alone needs a J2K path.
- **(b) ECMWF primary.** CC-BY-4.0 with explicit commercial redistribution — the cleanest licence; `tcc` is one 560 KB range request. — *Con:* no `lcc`/`mcc`/`hcc` in the 0.25° open stream, so three-deck layering must be diagnosed from RH profiles — real modelling work we would own.
- **(c) Imagery-only.** No decoder; highest pattern fidelity. — *Con:* no vertical structure, no forecast, no time-travel; GIBS science layers are colour-mapped PNGs, not values.

---

## D7 — Which resolver is canonical (`C13-N10`)

- **(a) `CLOUD_TIER_PRESETS` wins; `resolveCloudQuality`'s literals are deleted. (Recommended)** Removes the trap; the module's own docstrings already claim this is true while the code contradicts them, so the inertness mutant is trivially available. — *Con:* a one-batch engine change ahead of everything else (mitigated: byte-identical at every current default).
- **(b) Keep both and add a spec pinning them equal.** No behaviour change at all. — *Con:* **a spec that pins two sources equal preserves the trap** rather than removing it — exactly what `lightSampleScale`'s two sources already demonstrate.

---

## D8 — `C13-16-SCREEN-ANISOTROPY-ATTENUATION` *(put, not pushed)*

*Authored 9:1 elongation arrives as ~1.2:1 on screen; cirrus elongation 1.178 against a 1.6 prediction; no U2 point holds a strict 3 % at both configurations.*

- **(a) Raise the authored aspects** so the render matches the intent. Preserves the pre-registered gates. — *Con:* changes authored content to satisfy a measurement, and the correct authored value is unknown.
- **(b) Accept ~1.2:1 on screen and re-derive gates C/D/E from an integrated-image model that **can still fail**. (Recommended — provisional)** Honest about what the renderer does. — *Con:* `R-2026-08-06 R3` forbids re-deriving a gate into one that cannot fail, so the failability proof is the whole cost of this option; **and the record states this "is a maintainer decision, not a probe run", so the recommendation is provisional only.**
- **(c) Defer until after Wave 5.** — *Pro:* per-texel regime data (`C13-N27`) and per-texel genus (`C13-N38`) change the input distribution, so deciding now may waste the decision. — *Con:* `C13-16`'s mixtures half stays blocked.

---

## D9 — Cloud quality vs `C13-41` for the single Edge slot *(put, not pushed — this overrides a standing maintainer preference)*

- **(a) Run the `R-2026-09-02-5` exposure-sweep discriminator first; cloud work stays pure-Node until it returns. (Recommended — by default only)** Honours the funded ruling and the stated preference. — *Con:* Wave 1's Edge legs queue behind it. **The plan schedules as if (a) holds, but makes no argument for it over (b).**
- **(b) Exercise Option C of `R-2026-08-10-1` now** — re-file S3/S4 as C13 rows, close C12, unblock C14, release the C15 aurora R4 hold — and give the slot to clouds. `shadowContrastInvariant` has read outside [0.97, 1.03] in ten reports with 1.4e-5 relative spread, i.e. a stable measurement disagreeing with a pre-registered band, not noise; Option C is on the record as "the ledger-cleanest variant". — *Con:* closes C12 without the maximal gate `R-2026-08-10-1` chose, on a judgement call about noise, and overrides a stated preference.
- **(c) Interleave.** Both progress. — *Con:* the worst option — a prior tranche's entire S5 source-identity preflight was voided by exactly this.

---

## D10 — Ground-truth evidence licensing (`C13-N05`) · **LAUNCH SEAL**

*`C13-N05` banks NASA/NOAA imagery alongside renders in an Apache-2.0 repo.*

- **(a) Bank the reference imagery** (GIBS / GMGSI / NOAA photo library) with attribution recorded in the probe manifest. Fully reproducible offline. — *Con:* redistributes a large third-party imagery corpus from an Apache-2.0 repo.
- **(b) Fetch at probe time; bank only derived metrics, never the reference pixels — with a small pinned fixture set for offline reproducibility. (Recommended)** Keeps the repo clean and the probe reproducible. — *Con:* a live-network dependency for the full referee run.
- Hard exclusions in **both** cases: WMO Atlas photographs (permission required) and any MSFS/DCS/X-Plane screenshot. Record the ESDIS/NOAA acknowledgement strings in the manifest either way.

---

## D11 — Are the external reference bars gates or calibration?

- **(a) Gate all three** — IoU ≥ derived, spectrum slope −5/3 ± 0.3, fractal D 1.35 ± 0.15. Maximum rigour. — *Con:* gating IoU gates the weather feed and the capture hour, not the renderer.
- **(b) Calibration only.** Nothing can block on an external feed. — *Con:* the campaign then has no falsifiable structure bar at all, and a globally uniform fBm passes by default.
- **(c) Gate the spectrum and fractal bars; calibrate the IoU. (Recommended)** The two gated bars are falsifiable statements about our own output and a uniform fBm fails them in a diagnosable way. — *Con:* the only *external* referee stays advisory, so any competitive claim rests on our own statistics plus the peer's self-reported defects (see **D20**).

---

## D12 — Who owns `C13-42d` (renderer reports ready, records no work)?

- **(a) File it as an engine row now with an Opus author.** A renderer reporting `pipelineReady` while doing nothing is a product defect. — *Con:* **on the evidence at HEAD it is not an engine defect**: the harness wraps `featureRenderer.execute` while the live composition calls `executePreparedCloudFrame`, so the counter watches an entry the renderer bypasses.
- **(b) Repair the harness first (`C13-N08a`, Wave 1), re-run `baseline-01`, and open an engine row only if `executeCalls = 0` survives. (Recommended)** Spends Wave 1 on the defect that is actually there. — *Con:* defers a possible engine defect by one row. *(Note: the draft's compound symptom — zero-sized half-res/temporal targets — is the **expected** tier-3 full-res temporal-off configuration and appears in a **successful** banked run. Brief only `executeCalls = 0`.)*
- **(c) Leave it inside the C13-42 instrument cluster** with no owner. — *Con:* it can void the whole capture programme and nobody is looking at it.

---

## D13 — Scope of the archive hold for `C13-N33` (doc re-stamping) *(asking, not recommending)*

- **(a) The hold forbids moving and repointing files; correcting a factually false sentence in place is permitted, so `C13-N33` may proceed in Wave 2. (Recommended — provisional)** Seven cloud docs carry statements this plan shows to be false, two of which **invert a fact**, and a plan written from either would be wrong in a non-obvious way. — *Con:* it is the maintainer's hold and its intended breadth is not recorded.
- **(b) The hold covers any documentation-disposition work; `C13-N33` waits until the user revisits.** Zero risk of over-reach. — *Con:* the two fact-inverting lines stay live as traps for the whole campaign.
- Either way, §6 is written defensively as mark-in-place and `C13-N33` is deliberately **out of Wave 1**, so the answer gates nothing.

---

## D14 — File `C13-47/48/49` and honour the untracked P0 promotions?

*The untracked `CLOUD_REMEDIATION_PRIORITY_2026-09-06.md` promotes `C13-15..17` P1→P0 and `C13-24` P2→P1, and defines nine rows that have status in `CAMPAIGN_STATE.md`, twelve `DEFERRED_WORK.md` entries, `FEATURE_INVENTORY.md`, `TOOLING_CATALOG.md` and three rulings — but no entry in the add-only ID table (`grep -c "C13-4[4-9]"` → 0).*

- **(a) File all nine and ratify the promotions.** One consistent record. — *Con:* the P0 promotions predate the frame-cost and stipple evidence.
- **(b) File all nine; leave priorities at their tracked values, stamping the import "priorities superseded by C13 v2 §5". (Recommended)** The rows must exist in the add-only table regardless — status without an entry is the exact defect the queue flags for `CLOUD-LOW-COVERAGE-CUTOFF`; and this plan already re-points `C13-15..17` and elevates `C13-24` on dependency grounds. — *Con:* leaves a visible disagreement between the imported doc and the queue until the stamp lands.

---

## D15 — `C13-11` part 2 vector jitter

- **(a) Leave `coneJitter` on `hash33`.** No new asset. — *Con:* forfeits the STBN spectrum on the vector path.
- **(b) Bake a second scalar STBN volume (`--seed` already exists). (Recommended)** Reuses the landed, hash-pinned, spectrum-validated generator at ~1 MB. — *Con:* ~1 MB of extra asset.
- **(c) Extend the generator's value term to vectors.** One asset. — *Con:* modifies a generator whose output is already pinned and validated, re-opening a settled artifact.

---

## D16 — Edge-leg ordering vs landing · **LAUNCH SEAL** *(new, 2026-09-12)*

*`R-2026-08-29-1`: "engine, parity and shader changes keep the full bar (behaviour spec + inertness mutant + separate review + **the named Edge leg**)" — i.e. the leg is owed before landing. The draft sequenced L3/L4/L5 to land in the evening window **before** their tranche.*

- **(a) Run the tranche first, land after. (Recommended)** The no-engine-landings-during-a-tranche rule already permits this, since the tranche closes before the landing window opens; the proof bar is complete at landing. — *Con:* an engine batch waits one tranche before landing.
- **(b) Land first, Edge leg after, with the deferral explicitly ruled.** Faster landings. — *Con:* three engine/shader batches land with their proof bar outstanding; it needs a ruling, not a seat decision.

---

## D17 — Re-write Gates C/D and EXIT against the v2 bars · **LAUNCH SEAL** *(new, 2026-09-12)*

*`C13-GATE-D`'s deps are `C13-14..20` and `C13-14` is descoped; `C13-GATE-C`'s deps scatter across Waves 3 and 6 with `C13-41` in an untouched lane; none of the new O/H/A/G/I/P/L/T bars appears in any gate. As filed, the campaign can complete every row and still not close.*

- **(a) Rule the rewrite now (`C13-N46`, Wave 1 ledger row): GATE-D's deps move to `C13-N22/N23/N24/N27`; GATE-C names the rung cost table; EXIT enumerates which bars are gates and which are calibration, per renderer. (Recommended)** The campaign becomes closeable. — *Con:* changes a ratified gate's dependency list, which is a maintainer act.
- **(b) Leave the gates as ratified** and accept that `C13-EXIT` cannot be declared. — *Con:* the exit criterion is unreachable by construction.
- **(c) Rewrite at the end of Wave 5**, when the bars have been exercised. — *Con:* five waves run without knowing what closes them.

---

## D18 — Adaptive quality controller *(new, 2026-09-12)*

*`grep -rn "adaptiveQuality|dynamicResolution|frameBudget"` over the cloud renderer returns nothing. The only scaling input in the plan is camera altitude. On unknown hardware a fixed altitude ladder cannot keep a maximum tier performant.*

- **(a) Build `C13-N42` — frame-budget-aware hysteretic rung selection, default off, with an acceptance that a synthetic 2× cost inflation causes exactly one rung drop and no oscillation over 600 frames. (Recommended)** Delivers "the maximum tier is performant" on hardware we do not own. — *Con:* one more M row in Wave 3, and any auto-downgrade risks an `SR-1` argument if it ever becomes default-on.
- **(b) State plainly in §2 that scaling is manual + altitude-only and per-device tuning is the integrator's job.** No new code. — *Con:* silence on this point reads as coverage; better to say it than to imply it.

---

## D19 — WebGL bar list *(new, 2026-09-12)*

*Two bars the plan assigns to WebGL (H3 deck decorrelation, O6 altitude continuity) were unreachable under a shell-only, single-deck, no-march floor.*

- **(a) Add multi-deck to the WebGL shell (3 analytic shells over the 3 slices) and restate O6 on WebGL as continuity across the 20 km→20,000 km sweep with the shell alone. (Recommended)** Both bars become reachable and still cheap; already written into §1.4. — *Con:* the WebGL shader grows by two more shell evaluations.
- **(b) Remove H3 and O6 from the WebGL obligation** and state which bars WebGL is judged on. Honest and smaller. — *Con:* the parity floor loses its two most diagnostic bars, and a floor with unreachable bars is what gets quietly abandoned at the gate.

---

## D20 — Peer head-to-head instrument *(new, 2026-09-12)*

*Goal 2 is "above and beyond Takram". The plan concedes twice that this "is not measurable today", and as drafted filed nothing to make it measurable.*

- **(a) Fund `C13-N40` (Wave 2, L): stand the peer's published cloud scenes up locally at matched resolution/camera/sun, capture the same statistics the A-bars use plus frame time on this machine, bank a side-by-side. (Recommended)** "Above Takram" becomes a per-statistic claim with a date and a machine; their README-named unfixed defect (ghosting/smearing on a forward run) is the sharpest target, so **T1 becomes the head-to-head bar**. — *Con:* an L row that stands up a third-party renderer, with a licence check and a pinned version; no engine value of its own.
- **(b) Do not fund it; state to the maintainer that goal 2 has no acceptance** and that competitive claims will rest on our own statistics plus the peer's self-reported defects. No cost. — *Con:* one of the four stated goals ships unmeasured, and any "beats Takram" line would be invented — their reference comparison produced no scores and says so twice, and their README disagrees with their own source on two published defaults.
