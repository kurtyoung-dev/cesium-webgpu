# Landing plan: Astra's cloud work, 2026-09-21 → 2026-09-25

_Companion to `ASTRA_WORK_AUDIT_2026-09-25.md` and `ASTRA_AUDIT_DECISIONS_2026-09-26.md`. Written by Asfaloth (Opus 5.5) for the seat (Gandalf) on
2026-09-26._

_Status: **CANDIDATE.** This plan holds only if D1–D12 take the recommendations. Where a different ruling changes a row, the row says
so. **Nothing in the plan lands before the maintainer rules.** Revised after Felarof's critique (audit §10). Seat tip at revision:
`b263d8ac5e` (Batch 1537)._

_Status: **CANDIDATE → ADOPTED by `R-2026-09-26-1`**
([`MAINTAINER_RULINGS_2026-09-26.md`](MAINTAINER_RULINGS_2026-09-26.md)). The maintainer took every D1–D12 recommendation on
2026-09-26, so every row conditioned on a recommendation reads as taken, and the rows conditioned on a non-recommended option
("only if D5 takes (A)", "under b2(i)", "under b5(ii)") are the recorded fallbacks. The companions are tracked as
[`ASTRA_WORK_AUDIT_2026-09-25.md`](ASTRA_WORK_AUDIT_2026-09-25.md) and
[`ASTRA_AUDIT_DECISIONS_2026-09-26.md`](ASTRA_AUDIT_DECISIONS_2026-09-26.md); the reader reports and the critique are banked at
`cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/`._

**Live state at adoption (2026-09-26, recorded by the record lane).**
- **The tip is `37c0f8767e` (Batch 1538).** Batch 1537 (`b263d8ac5e`) landed the census patch `vinitharya.patch`, so **P1.1 is
  reduced to two frozen patches: `angrim.patch` (W2-L11) and `pimpernel-ledger.patch`.** Batch 1538 homed the two runnerless specs
  in `test-visual-regression-node` (`fog-cheap-coverage-gate` 15/15 and `perf-manager-teardown` 7/7, measured at `b263d8ac5e`),
  which discharges P0.3's required half.
- **P0.1 and P0.2 are done:** the audit is banked, and T1 is frozen at packet md5 `c4016b889ec06d782c36a50f8888e449`.
- **Not re-derived by the record lane:** `git apply --check` of `angrim.patch` and `pimpernel-ledger.patch` at `37c0f8767e`
  (P1.1 requires it before each lands). Batch 1538 touched only `package.json` and `TOOLING_CATALOG.md`.
- The rest of this plan cites `b263d8ac5e` as the tip; those citations are the revision's measurements and are left as written.

Evidence ids follow the audit:
- **R1–R5**: the reader reports.
- **U1–U37**: the units.
- **Y1–Y17**: the cross-cutting findings.
- **C1–C7**: the common batch set.

---

## 0. Constraints that bind every step

**Quiet hours and the pre-push guard.**
- No commit and no push on weekdays between 07:00 and 19:00 ET. Check `date` before each one.
- The tracked pre-push guard rejects commit dates inside the window, and it has no override.
- 2026-09-26 is a Saturday, so the window does not apply today.

**How the seat commits.**
- **By explicit path, or from an empty index.** The seat's tree carries 21 held entries, and none of them may be staged.
- **Squash only.** Freeze before review: record the md5 of the formatted patch before the reviewer is dispatched.

**The Edge slot.**
- One slot, one job at a time.
- **No engine landing while an Edge executor holds the slot.** Only tools and docs land during a tranche.

**Build and type gates.**
- Run `gulp build` at the seat before landing new `Source` files.
- The engine type gate is `npm run tsc-engine`. The root `tsc --noEmit` covers `scripts/` only.
- Run `node Tools/variant-smoke-test.mjs` after a batch that adds `Renderer/WebGPU` `.js` modules.

**Proof bar by class** (R-2026-08-29-1):
- **Engine, parity and shader changes:** a behaviour spec, an inertness mutant, a separate review, and a named Edge leg.
- **Tools:** a spec only where the logic merits one and it has a runner home.
- **Docs:** review, plus one capture if the change is visual.

**Per landing batch** (R-2026-09-16-5): an independent reviewer and one named Edge leg.

**The wave-end gate** (R-2026-08-29-2) closes the Astra wave.

**Workers.**
- All lower-tier seat lanes are Opus 5.5. The model and the effort are passed explicitly on every dispatch.
- The seat assigns names.
- Astra (Codex) delivers packets. **A packet claim is a lane claim until the seat's reviewer confirms it.**

---

## 1. Order at a glance

| Step | What | Class | Waits for | Edge job |
|---|---|---|---|---|
| **P0.1** | Bank the audit: R1–R5, the brief and these three files go to `cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/`, with md5s, as a two-phase copy. **[Done 2026-09-26.]** | records | — | — |
| **P0.2** | Freeze T1: `Tools/visual-regression/output/astra-return-audit-20260921/worker-rejected-dispatch.patch`, md5 `c4016b889ec06d782c36a50f8888e449`; with `index` lines dropped it equals the clone's diff, both `c3cb96b14feb04590a22e8c61e76dd52`; `git apply --check` passes at `b263d8ac5e` (all re-derived). **[Done 2026-09-26.]** | records | — | — |
| **P0.3** | Home `fog-cheap-coverage-gate.spec.mjs` and `perf-manager-teardown.spec.mjs`, each only **after measuring it green at the tip**. Optionally, also create `test-sky-atmosphere` for the three runnerless sky specs, again measured first. **[Done 2026-09-26 for the two specs, by Batch 1538; the optional `test-sky-atmosphere` key was not created.]** | tools (`package.json`, seat) | — | — |
| P1.1 | The two remaining frozen patches: `angrim.patch` (W2-L11) and `pimpernel-ledger.patch` (ring ledger), in either order, each re-checked with `git apply --check` at the tip first. The census patch `vinitharya.patch` **has landed**, as `b263d8ac5e` (Batch 1537, 01:28:04 EDT) | as frozen | their own gates | E1 (W2-L11 karma) |
| P1.2 | **T1: the TaskProcessor settled-guard, plus the WASM-init guard** (D5 option D) | engine (Core) | W2-L11 landed | **E2** |
| P1.3 | Ring Leg 2 and I-5's pre-registered leg, **on a pre-Astra tree** | measurement | — | E3 |
| P1.4 | Any C12 / S3 receipt the maintainer wants taken at the tip (MQ2) | measurement | — | (S3's own job) |
| P1.5 | **E4 first** (the native 96/8 A/B; its patch arm is built at `b263d8ac5e`, before I-5/I-3 touch `resolveCloudPreset`), then I-5, then **I-3 (C13-N69)** | engine | P1.3 | **E4** — a hard gate before E5 |
| P1.6 | C13-N60, N61 and N13, one owner of `ProceduralClouds.wgsl` at a time, in the order the ledger and the maintainer's Q1 set | engine + shader | P1.5 | their own legs |
| **P2** | **Astra's return:** strip, the §2 fix list, rebase in a fresh clone of the post-P1 tip, and the re-cut into A1–A3 | — | P1.6 and the rulings | — |
| **A1** | Structure, byte-neutral at defaults, plus the **P0 fix**, plus the HOLD chain's profile plumbing as STRUCT (D12(a)) | engine + shader | P2 and E4 reported | **E5** |
| **A2a** | **Default work (LUT bake)** plus the atmosphere opt-ins: D4a a3, a4, a5, a7 are MOVES-G (critic C10) | engine + shader | A1 | **E6** |
| **A2b** | Cloud lighting, opt-in (U25's peer code dormant, D12(a)) | engine + shader | A2a | **E7** |
| **A2c** | March and performance, opt-in (hi bit 6, QF bit 14), plus the **U11 dial** (D4b b2(ii)) | engine + shader | A2b | **E8** |
| **A3** | The ruled default-path changes, including the physical aerial path U1/U2/U4/U15 (D4b b5) | engine + shader + GLSL | A2c, D4, and P1.3 | **E9**, then **E10** (wave end) |

**Never in an A batch:**
- **U37** is stripped (D2).
- **U3** goes to the N13 owner (D9b). Taking it out is F-12's four-part revert plus the U21 / U36 / U27 re-fits.
- **U20b** stays out (D9c).
- **U32b** is reverted (D4b), unless a new stripe gate passes.
- **The HOLD chain, U23, U26, U29 and U30, as features:** no public entry point and no slot writer (D12(a), F-18). Its plumbing lands
  as STRUCT in A1 (profile threading) and A2b (U25's peer code), under the identity legs. The features return to Astra as future
  work behind E4 and D12(c).

---

## 2. The fix list returned to Astra (Phase P2)

Each item carries its evidence and the batch it lands in.

**Astra's hands:**
- Astra fixes code and its own specs.
- **The seat's reviewer writes and runs the call-site inertness mutants,** so the check is independent of the author (Principle 10).
- **No edit to `package.json`, `eslint.seatbelt.tsv` or `migration_doc/` in the clone.** Those lines come back as text (F-14).

| F | Fix | Evidence | Batch |
|---|---|---|---|
| F-1 | **Strip U37 sparse** (see the notes after the table). | D2; R1 U37; R2 §1; R4 M1; R3 F7, F9 | before A1 |
| F-2 | **P0: the fog shader.** (1) Take `interleavedGradientNoise` out of the shared `CloudDensityDomain.wgsl` chunk, or rename it, e.g. `cloudInterleavedGradientNoise`. The fog's IGN uses a different rotation formula, so the two are not interchangeable. (2) Add a naga spec that composes **every** `${CloudDensityDomainWGSL}\n…` consumer: fog, sky cubemap, cloud. Its mutant re-inserts the duplicate declaration and must go red. | R3 F1, §2 | A1 |
| F-3 | **Every red in R4 §3.1** (13 in `test-cloud-c13`, Q1–Q7 in quarantine), fixed in the batch that introduces its cause, plus any red the runners in §6 item 5 turn up. `cloud-tier-single-source` must load again and run all 35 tests, with L3's C13-N10 test unchanged; under D12(a) that means modelling `CloudLayerProfile` in the spec's `WGSL_TYPES`, because the struct stays. | R4 H1, H2, H5; critic C1, C7 | per batch |
| F-4 | **Format first (C2).** Then re-pin the 7 regexes that only go red after formatting. Make the mutants portable across CRLF and LF (reds 12–13). Make spec paths independent of the working directory (`cloud-layer-profiles`, `cloud-empty-weather`). | R4 §4.1, §3.1, H12; R1 §2.12 | per batch |
| F-5 | **Restore the weakened guards** (see the notes after the table). | R1 §3 (X3); R4 §1, §1.1, §1.2, H6 | A1 / A2c |
| F-6 | **Make the new specs reach the renderer wiring**, so the call-site mutants die: M2 (lighting cache), M4a and M4b (empty weather); M3 once U26 returns. | R4 §2 | A2b, A2c |
| F-7 | **Route new shader modules through `WebGPUShaderModuleCache` and the pipeline cache** (specialisation, lighting cache, composite). Replace raw slot indices with named layout exports (U34's eligibility test). Pin U35's 64-field table to the WGSL struct with a spec. | R1 §2.1, T5; R3 F8; R2 #3 | A2b, A2c |
| F-8 | **Logging.** Throttle the per-frame `console.error` at P:5645. Carry the context id on the six new permanent errors (`context.log`). | R1 §2.8 | A1 / A2c |
| F-9 | **Bounded LUT retry**, with a spec: dispatch reports false → `lutReady` stays false → bounded retries → one latched `console.error`. Add a dispatch-count spec: three Sun-only invalidations → one irradiance bake. | R3 F4c, §8 | A2a |
| F-10 | **Sky specs.** A slot-55 matrix spec: {0, 1, 0}. A `skyDisplayColor` mini-eval at `w = 0` against the base inline chain. **An intensity assertion** (D4a a6): an explicit `atmosphereLightIntensity = 0` packs 0 and an unset value packs 50; the slot-55 matrix does not pin it (critic C13). | R3 §3 | A3 |
| F-11 | **D11 option (C):** convert `CloudVolumetrics` to a class whose validated dials are **own enumerable accessors on the instance**, so the spread in `_resolveVolumetricConfig` carries them unchanged; a forwarding spec pins that every documented dial reaches the resolved config. Every dial gets JSDoc with `@type`/`@default` and "WebGPU only.". Nine dials after D2, D9c and D12(a). | D11; R3 F7, F10; R1 §2.9; critic C15 | class in A1; dials with their features |
| F-12 | **D4b / D9b.** (1) Put U11 behind a dial that defaults off, **in A2c** (b2(ii)). (2) Revert U32b to base's golden-ratio phase. (3) **Take U3 out, all four parts** (critic C2): base spacing (`fineStep = (tEnd − tStart) / steps`); the base sentinel `steps * 3`; the base comb accumulator `var t = tStart` and the base sample distance (R5 §2.2 item 1; the ring rig is sensitive to this one); and U3's JSDoc rewrites of `cloudMarchStepGrowth` and `cloudMaxRayDistance` (P:7192–7214). (4) **Re-fit onto the tip's march law** — which is the post-N13 law once P1.6 lands, not `a76d42b3f8`'s: U21's disabled branch (today it returns U3's `cloudMarchStepBounds`, astra `CloudDensityDomain.wgsl:241–255`), U36's skip (astra `ProceduralClouds.wgsl:2321`, inside U3's loop), and U27's early-outs. (5) Take U20b out. (6) Align U8's native-temporal alpha 1.0 with the half-res branch's `sceneColor.a`, or document why they differ. | D4b; D9b; D9c; R3 F5; critic C2 | A2c / A3 / re-cut |
| F-13 | **Re-cut into A1–A3** with a unit → hunk map. Freeze each batch with an md5 and `git apply --check` at the tip current at that moment. | R1 §1, §5.9 | P2 |
| F-14 | **Seat-owned lines, returned as text in each packet:** `package.json` values; ES6 status rows with **measured** base → after line counts (R1 §2.7's table is the starting point); `DEFERRED_WORK` / `FEATURE_INVENTORY` row text (D6); the sparse withdrawal record (D2). | R5 §3.9; R1 §2.9–2.11 | per batch |
| F-15 | **Re-measure on the stripped generation** any number a batch message cites: specialisation, empty weather (after its re-fit onto the tip's march law), lighting reuse, Worley. Use the same frozen-input alternating harness, with clocks recorded. | R2 §5, §0.6; critic C2 | per batch |
| F-16 | **File size.** `WebGPUPostProcessPipeline.ts` (+7) and `WebGPUPerformanceManager.ts` (+12) grew while already over 1,000 lines. The specs `cloud-aerial-path-length` (1,917) and `cloud-tier-lighting-dials` (2,023) grew past 1,000. Decompose them, or record the exception in the packet for the seat to rule on. | R1 §2.7 | per batch |
| F-17 | **Correct the checkpoint's facts in the packet** (the packet is untracked; D10). Record both A/B outcomes, the 8×8 tiles, bundle `a4b74c3a`, the "same-session" header on rows 7–8, the self-repair framing, and the native failures in the layers row. | R2 §0.3–0.6, §2 | P2 |
| F-18 | **D12(a): make the HOLD features unreachable, keep their plumbing.** Remove `cloudLayers`, `cloudLayerShadowSteps` and `cloudLayerShadowCache` from `CloudVolumetrics`, `cesium-cloud-types.d.ts` and every renderer reader; remove every writer that puts a non-zero value in slots 220–223 and 228–259, and name those slots as reserved pads in `WebGPUCloudUniformLayout.ts` (the uniform stays 260 floats). Keep `CloudLayerProfile`, `cloudProfileForDeck`, the profile parameters, `peerTransport` and U25's peer code. Add a value oracle: `cloudProfileForDeck` at defaults returns the global profile. **Verified when** `git grep -nE 'cloudLayers\b\|cloudLayerShadowSteps\|cloudLayerShadowCache' -- packages/engine/Source` returns 0 and no slot writer for 220–223 / 228–259 writes anything but 0. | D12; critic C1 | A1 (profile threading) / A2b (peer code) |
| F-19 | **Restore the deleted WHY comment** in `WebGPUCloudReflectionUniforms.ts` above the `cloudCache?.ibl…` reads: why IBL cloud parameters come from `_cloudCache` (`FrameState` has no `globe` field, so a `frameState.globe` cast would freeze every parameter at its default; the cache seeds with the Globe defaults; inert when `cloudMarch` is 0). It was removed at P:4487–4494 and the extracted file lacks it (P:11545+). | CLAUDE.md comment rules; critic C16 | A1 |

**F-1 in detail.**
- **Files to remove:** `WebGPUCloudSparseHistory.ts`, `WebGPUCloudSparseUpdates.ts`, `CloudSparseUpdates.wgsl` and
  `cloud-sparse-updates.spec.mjs`.
- **Hunks to remove:**
  - the `ShaderDefineHi` bit-7 entry;
  - the renderer's sparse wiring and its per-frame source concatenation;
  - the `cloudSparseHistory` consumer (astra `ProceduralClouds.wgsl:2725`);
  - `CloudVolumetrics.cloudSparseUpdates`;
  - the `.d.ts` field;
  - the runner entry;
  - the `sparseRequested` term, in the emit gate and in the regexes of `cloud-march-emission` A2 and E4.
- **Record:** a withdrawal record in the shape of `LIGHT_REUSE_WITHDRAWAL.json`.
- **Verified when:** `git grep -nE 'cloudSparse|CLOUD_SPARSE|CloudSparse|sparseRequested'` returns 0.

**F-5 in detail.**
- **`cloud-tier-single-source` MUTANT d:** restore its positive checks, the walk to index 45 and the overrun by 1.
- **`cloud-temporal-rte`:** restore the call-site pin, so `temporalReprojectionSupported` reaches the gate again.
- **Legacy-density hashes.** They cannot return to base under either D4b option: they hash the stripped **source text** of
  `legacyCloudDensity` / `legacyCloudBaseDensity` (base `cloud-density-domain.spec.mjs:79–87`, `:700–716`), and U20a's identity
  branch and D12's profile threading edit those bodies whatever happens to U11 (critic C4). So: re-freeze **once**, with the
  three-part reason (U11 gated or accepted, U20a, D12) and the "default row is identity" clause restated; and prove default identity
  **by execution** — a value oracle that runs the legacy and macro evaluators at defaults against base's values, whose mutant forces
  the billow on and must go red.
- **F2 loop sentinel:** return it to the tip's law (`steps * 3` today) once U3 is out.

**Rebase expectations for P2.** Astra rebases onto a tip that contains P1.1–P1.6. Measured or derived per R5:

| Tip content | Collision with Astra |
|---|---|
| `angrim.patch`, `pimpernel-ledger.patch`, and Batch 1537 (the census patch, already landed) | None textual (R5 §1a; the Astra patch passes `--check` at `b263d8ac5e`, re-derived). The ledger's line citations become stale anchors once Astra moves the lines, which is expected. |
| T1 (TaskProcessor) | None. It is not in the 81 files. |
| I-5 and I-3 in `WebGPUCloudTierPresets.ts` / renderer | **Expected.** Astra's `resolveCloudPreset` hunk (base `:239–251`) falls away with U20b (D9c), so what is left is Astra's other hunks near I-5's realisation readback in the renderer. Conform to I-3's budget. |
| N60, N61 and N13 in `ProceduralClouds.wgsl` | **Expected.** (1) N60's pad rename of 146/147 against Astra's struct-comment hunk. (2) N61's LOD argument site (astra `:2400`). (3) N13's step law, which Astra no longer carries — **and onto which U21's disabled branch, U36's skip and U27's early-outs are re-fitted** (F-12). |
| CI tranche 2, C15-06, S3-L3/L4, I-1, I-2, I-4 | None (R5 §1b). |
| The Gemini comment plan | `WebGPUFeatureRenderers.ts` only, in different hunks (R5 §1b). |

**One owner note.** If MSAA1 / N62 lands after A1, its owner adds `WebGPUCloudCompositeResources.ts:278` to its file list (R5 §2.2).

---

## 3. The batches

**Every batch** carries the common set C1–C7 (audit §2.1), in addition to its own items.

**The Edge-leg protocol for every batch:**
- Two trees: T0 is the pre-batch tip, and T1 is T0 plus the batch.
- `--serve-built`, with the served md5 equal to the disk md5.
- Edge, never Firefox.
- The device-loss, page-error and console-error gates must be clean.
- **A same-build repeat control on every byte-identity cell** (R-2026-09-16-7; critic C9a): T1 captured twice from the same build,
  byte-compared, before any T0-vs-T1 difference is read. A difference is accepted as GPU nondeterminism only if the repeat
  reproduces it.
- **The hang protocol on every native high (tier 3, 96/8) cell until E4 reports** (critic C5). Tier 3 is native 96/8 (base
  `WebGPUCloudTierPresets.ts:168–172`), and `"auto"` resolves to it at or below 50 km (`:201`), so every "clouds on, default, ground"
  cell is one. Bounded deadlines, one frame at a time, the lane owns the machine. Astra's receipts record hangs in feature-off
  controls (RA:335, RA:377, CP:71), so no such cell is known safe yet.
- **HDR cells without HDR hardware** (critic C9e): WebGPU sky slot 55 keys on `frameState.highDynamicRange && !hdrCanvasOutput`
  (P:11446–11450), so forcing `scene.highDynamicRange = true` on an SDR display reproduces the HDR-display default path. Only a cell
  that tests **canvas output** (`hdrCanvasOutput`) needs an HDR display.

**Evidence** is banked under `Tools/visual-regression/output/<batch>/`.

### T1 — TaskProcessor settled-guard (D5)

- **Class.** Engine, Core, on every backend's path.
- **Content.** `Core/TaskProcessor.js` (+8) and `Tools/visual-regression/task-processor-error-path.spec.mjs` (+51), frozen at P0.2;
  **plus**, under D5 option (D), a seat-authored settled check before the WASM-init `postMessage` (base `TaskProcessor.js:273–320`)
  and a spec case that fires `error` before the config resolves and asserts no post. Both are frozen together before review.
- **Spec that exists.** The error-path spec. On base the worker regression is 10/2; with the fix it is 12/0 (R2 §4). Its runner home is
  `test-visual-regression-node` (R3 §7).
- **Owed:**
  - **Run** the inertness mutant `if (false && taskListeners.isSettled())`, which must go red. R3 reasoned this; nobody has run it.
  - The WASM-init guard's own mutant (the new check made unreachable), which must go red.
  - Only if D5 takes (A) instead: a `DEFERRED_WORK` row for the unguarded WASM-init race (R3 §7).
- **Review.** An independent Opus 5.5 reviewer, plus an **adversarial Opus 5.5 verifier**, because the file is on every backend's path.
- **Edge leg E2.** A karma run in Edge over a selection that includes the `Core/TaskProcessor` specs, after W2-L11 lands. It must show
  no new red against W2-L11's landed karma receipt.

### A1 — structure, byte-neutral at defaults, plus the P0 fix

- **Units** (the exact cut is Astra's, per F-13):
  - **U5**, the layout module.
  - **U24**, `marchDeck` and packed order.
  - **U27**, the zero-density exits.
  - **U28**, Worley pruning.
  - **U22**, the frame-chain refactor plus the off-by-default `cloudSceneLinear` target.
  - **U33 plus F-2**, the P0 fix.
  - **The structural half of U36**: weather-resource ownership, plus the leak fix for the fallback texture.
  - **The structural half of U8**: format-aware rebuilds of post-process, snapshot and identity blit.
  - **The D11 `CloudVolumetrics` class conversion** (option C: instance-own enumerable accessors, the spread forwarding
    untouched), with no behaviour change for existing dials.
  - **The HOLD chain's profile plumbing as STRUCT** (D12(a), F-18): `CloudLayerProfile`, `cloudProfileForDeck`, the profile
    parameters and `peerTransport`, with no public entry point and zero-written reserved slots.
  - **F-19**, the restored `_cloudCache` WHY comment.
- **Specs that exist.** The six below come from R4 §1 and R1 §2.2:
  - the layout-import pins in `cloud-genus-morphology`, `cloud-probe-harness`, `cloud-tier-lighting-dials` and `cloud-primary-shell`;
  - `probe-cloud-density-domain.mjs`;
  - `webgpu-postprocess-effect-survives-recreate` (+3 tests, 25/25);
  - `weather-map-seam`;
  - `cloud-observability-counters` (D10 weather accounting);
  - `webgpu-cloud-godray-current-mask-order` (+4 tests, all of which skip on an unbuilt tree).
- **Owed:**
  - F-2's naga composition spec, with its mutant.
  - `fog-cheap-coverage-gate` homed (P0.3).
  - The godray / primary-ray tests run on a **built** tree with 0 skips (R4 §6.1).
  - `cloud-tier-single-source` loading again, with MUTANT d restored.
  - The forwarding spec for D11, with its mutant: make one accessor non-enumerable and it must go red.
  - F-18's value oracle and grep checks.
  - F-8 on the frame-chain paths.
- **Review.** An Opus 5.5 reviewer, and an **adversarial Opus 5.5 verifier**, because A1 touches the whole WebGPU frame chain and
  carries the P0.
- **Edge leg E5.** It runs only after E4 has reported. It must show the following, T0 against T1, each identity cell with its
  repeat control:
  1. **The default scene, clouds off:** the full frame is byte-identical.
  1a. **The default scene, clouds off, with `highDynamicRange = true` forced** (critic C9b): the full frame is byte-identical. U22
     moves the whole post-process dispatch, and HDR-display users run with HDR on by default (base `Scene.js:1514`, `:1523`;
     `HdrDisplayCapability.ts:379–424`, critic premise 8). Forcing it on an SDR display reproduces that path.
  2. **Clouds on, default configuration,** at ground, flight and orbit: the raw cloud field and the frame are byte-identical. This
     settles the STRUCT claims of U22, U24, U27, U28 and U36 (R1 §5.8) and D12's plumbing. The ground cell is tier 3, native 96/8,
     and runs under the hang protocol.
  3. **`volumetricFog.enabled = true`** on T1: the frame presents, with zero validation errors under `pushErrorScope("validation")`
     (R3 §9.1).
  4. **One HDR-canvas toggle cell on T0 and on T1.** It answers whether T0 shows the `CloudUpscale` attachment mismatch, which would
     make U8's cache repairs base fixes (R2 #1).
  5. **`cloudSceneLinear` on:** the composition target is allocated, and released on disable (R3 §4).
  6. **The Worley GPU oracle, re-run on T1:** 9,056 positions, 0 mismatches (R2 §2).
- **Seat lines.**
  - The `package.json` homes, if not already done at P0.3.
  - The seatbelt, regenerated (D7).
  - ES6 status rows for the `WebGPUSceneRenderer.ts` → `WebGPUSceneRendererPostFrustumChain.ts` extraction and the renderer
    extractions, with measured counts.
  - `ES6_MODERNIZATION_STATUS` also records the class conversion.

### A2a — default work in the LUT bake, plus the atmosphere opt-ins

_Relabelled after critique (C10): the first draft called this batch "opt-in", but its D4a rows a3, a4, a5 and a7 are MOVES-G by
this plan's own classification — the irradiance kernel rewrite and its first-bake cost, the 8 KiB field and new binding, and the
retry semantics all run for users who never enable clouds._

- **Units.**
  - **U9**, the irradiance kernel and its consumer.
  - **U10**, bake reuse plus the bounded retry.
  - **U16**, the multiple-scattering field.
  - These carry the D4a rows a3, a4, a5 and a7.
- **Specs that exist.** The atmosphere parts of `cloud-aerial-path-length`, and `perf-manager-teardown` (9 → 10 handles, homed at P0.3).
- **Owed.**
  - F-9: the bounded-retry spec and the dispatch-count spec. Mutants: remove the bound, which must go red within a bounded time; drop
    the reuse key, which must go red.
- **Review.** An Opus 5.5 reviewer, and an **adversarial Opus 5.5 verifier**, because the batch changes default work (critic C10).
- **Edge leg E6.** It must show:
  1. **The first irradiance bake, timed**, T0 against T1, through `CesiumDebug.gpuPassCost` (R3 §9.4). The maintainer's threshold
     decides a3(i) against a3(ii).
  2. **A Sun-only change** gives 0 irradiance bakes, and an intensity change gives exactly 1 (R2 §2).
  3. **`multipleScattering` on and off**, at ground and at 30 km, with a per-fragment timing (D4a a7).
  4. **With the option off,** the frame is byte-identical to T0.

### A2b — cloud lighting, opt-in

- **Units.**
  - **U6**, **U7**, **U12**, **U13**, **U14**, **U25** (with the HOLD chain's peer code dormant, D12(a)), **U31**, **U32a** and
    **U35**.
  - The physical aerial path U1 / U2 / U4 / U15 is **not** here: it reaches the default at ≥ 100 km (settled, D4b b5) and lands in A3.
- **Specs that exist** (R4 §1–§2):
  - `cloud-tier-lighting-dials` (+24 tests);
  - `cloud-lighting-cache` (27 tests);
  - `cloud-aerial-path-length`.
- **Owed:**
  - F-6: M2 must die.
  - The part of F-7 that covers the lighting-cache module and the U35 table.
  - F-4's CRLF-portable mutants for reds 12 and 13.
  - A spec that the peer code stays unreachable: `peerEnabled` is never written non-zero (F-18).
- **Reviewer duty.** Before the leg, an **RTE pass** over `CloudLightingCache.wgsl` and the other new WGSL (R1 §5.10).
- **Edge leg E7.** It must show:
  1. **Each dial on and off** at the flight rig. Off is byte-identical to T0; on shows the intended delta.
  2. **Lighting-cache reuse:** 0 refreshed voxels on unchanged inputs, re-measured on the stripped stack (R2 §3, row 2).
  3. **Clouds on, default configuration, at ground, flight and orbit:** raw field and frame byte-identical to T0 (critic C9c). This
     covers the lighting refactors that run at defaults — the profile-taking signatures of `cloudPhase`, `beerPowder`,
     `multiScatterLight` and the rest, and the dormant peer path.

### A2c — march and performance, opt-in (claims hi bit 6 and QF bit 14)

- **Units.**
  - **U17**, **U18**, **U20a**, **U21** (re-fitted, F-12), **U34** and **U36**: the dial plus the clearance atlas (re-fitted, F-12).
  - **U11 behind a dial that defaults off** (D4b b2(ii); critic C4), with the legacy hashes re-frozen once, with the three-part
    reason, and default identity proven by execution.
  - **The D3 registry comment** reserving bit 7.
- **Specs that exist.** `cloud-density-response` (kills M5), `cloud-empty-weather`, `cloud-noise-mipmaps`, `cloud-ray-jitter`, and the
  native-temporal test in `cloud-tier-single-source`.
- **Owed:**
  - F-6: M4a and M4b must die.
  - F-5: the `cloud-temporal-rte` pin.
  - The part of F-7 that covers the specialised module. The pipeline cache's `stats.wrongModuleHits` must stay at 0.
  - D11 dials with JSDoc.
  - F-5's legacy-density value oracle (execution, not text), with its mutant.
- **Review.** An Opus 5.5 reviewer.
- **Edge leg E8.** It must show:
  1. **Specialised against generic:** the raw field and the frame are byte-identical on the stripped stack. Also an alternating timing
     with clocks recorded, which re-measures the 46.16 % claim (R2 §3, row 1).
  2. **Empty weather:** re-measure the clear view and the cloudy boundary. This is reported, not gated; the cloudy FAIL is known
     (CP:44).
  3. **Native temporal on and off** at medium.
  4. **U21's 384-step orbit cell**, run under the hang-risk protocol.
  5. **A startup trace with self-shadow on:** does the 52.9 s async compile starve other pipelines (R3 §9.5)?
  6. **Clouds on, default configuration, at ground, flight and orbit** (critic C9c): raw field and frame byte-identical to T0. It
     covers the default-path code this batch changes: U18's gate `runtime.offscreenActive ?? runtime.halfResActive` (P:4442),
     U20a's identity branch (astra `CloudDensityDomain.wgsl:216–219`), U21's re-fitted disabled branch, U36's bit-14 skip, and U11
     with its dial off. The ground cell is tier 3 and runs under the hang protocol.
  7. **U11's dial off in the IBL cube** with `cloudContributesIBL`: byte-identical to T0 (critic C4).
  8. **A default scene with a PBR glTF model** (critic C9d): byte-identical to T0. `SkyUniforms` grows by 4 floats with U20a
     (`SKY_UNIFORM_FLOATS … + 4`, P:4470–4471) in the procedural sky fill that serves model IBL.

### A3 — the ruled default-path changes

- **Units.** Only what D4 accepts:
  - **U19**: D4a rows a1, a2 and a6, on both backends, including the GLSL clamp.
  - **The U8 linear composite** (b1).
  - **U11**, only if D4b takes b2(i); under the recommended b2(ii) it is a dial in A2c.
  - **The physical aerial path, U1 / U2 / U4 / U15** (b5; critic C3). It reaches the default at ≥ 100 km. Under b5(i) it lands
    here, **after P1.3** so the ring Leg-2 baseline is taken on a pre-Astra tree; the ring M0 is re-banked after it. Under b5(ii) its
    new dial lands in A2b instead.
  - **U32b**, only after a new stripe gate passes.
- **Specs that exist.** `eclipse-sky-totality` and `sky-light-direction`, which pin the alpha clamp on both backends (R4 §1), plus the
  three sky specs under `test-sky-atmosphere`.
- **Owed.** F-10: the slot-55 matrix, the `skyDisplayColor` mini-eval, and the intensity assertion (explicit 0 packs 0). Re-check
  the transfer premise of `lib/cloud-photometry.mjs` against the linear composite (X10; R1 §5.7). A Node spec that pins the aerial
  reach: `resolveTier` and `shouldDefaultPhysicalAerial` at 100 km and 6,608 km with `cloudAerialMode` unset and `"auto"`.
  U4's red #2 and its post-formatter red at `aerial-path-length:1264` fixed.
- **Review.** An Opus 5.5 reviewer, and an **adversarial Opus 5.5 verifier**, because A3 changes the default image.
- **Edge leg E9.** It must show:
  1. **The full WebGPU frame with HDR off:** byte-identical to T0 over the **full** frame, not only the top 1920×300 (R3 §9.2).
  2. **HDR on, on an SDR canvas:** the intended change. `highDynamicRange = true` forced on an SDR display reproduces the
     HDR-display default path (slot 55 keys on `highDynamicRange && !hdrCanvasOutput`, P:11446–11450; critic C9e), so this cell does
     **not** need HDR hardware.
  3. **A WebGL HDR leg at ground and at 30 km:** the clamp change (R3 F3). `highDynamicRange` forced; no HDR hardware needed.
  4. **Clouds at defaults, before and after,** on an SDR canvas with HDR forced on and off (b1). Only a cell that tests HDR **canvas
     output** (`hdrCanvasOutput`) needs an HDR-capable display.
  5. **One orbital default cell, before and after** (b5; critic C3): clouds on, `cloudAerialMode` unset, at the ring rig's pose
     (6,608 km). It shows the physical aerial change and nothing else. It is tier 1 under `"auto"`, or tier 3 under the rig's
     `"high"`; a tier-3 run is under the hang protocol.
- **Baseline refresh.** Each refresh is its own reviewed commit (R-2026-08-29-2).
- **Then E10, the wave-end gate:**
  - the variant smoke test;
  - the Sandcastle2 sweep on both renderers;
  - visual-regression capture-and-diff.
  - It is banked under `Tools/visual-regression/output/wave-end/<wave>/`.

---

## 4. `package.json` and the other seat-owned lines

**`package.json`.**
- **Never apply Astra's hunk.** Its context lines include `test-engine-node`, and Angrim owes a new value for that line. The hunk stops
  applying the moment W2-L11 lands (R5 §1a.1).
- **Re-compose each value on the tip current at landing:**
  - **P0.3:** homes for `fog-cheap-coverage-gate` and `perf-manager-teardown`. `test-visual-regression-node` is the natural runner for
    both, and each is measured green first.
  - **Optional at P0.3:** a `test-sky-atmosphere` key for `sky-light-direction`, `sky-shell-star-occlusion` and
    `eclipse-sky-totality`, each measured at the tip first. None of the three has a runner today (R5 §1c).
  - **A2 and A3:** prepend the new specs of each batch to `test-cloud-c13`: `cloud-density-response`, `cloud-lighting-cache` and
    `cloud-empty-weather`.
    - **Never** `cloud-sparse-updates`.
    - `cloud-layer-profiles` only when U26 lands.
  - Run the duplicate-key guard (Batch 1522, `dupkeys.mjs`) after each composition.

**`eslint.seatbelt.tsv`.** The seat regenerates it with its own lint, on each landed tree that touches a seatbelted file (D7). Nothing is
copied from the clone.

**`ES6_MODERNIZATION_STATUS.md`.**
- The seat writes one row per decomposition, from measured `wc -l`, base → after.
- Starting points (R1 §2.7):

  | File | Base → after |
  |---|---|
  | renderer | 5546 → 5330 |
  | `ProceduralClouds.wgsl` | 3363 → 3056 |
  | `WebGPUSceneRenderer.ts` | 5146 → 5052 |
  | `WebGPUDynamicEnvironmentMapManager.ts` | 2923 → 2853 |
  | `cesium-js-types.d.ts` | 1863 → 1810 |
  | `WebGPUShaderDefines.ts` | 1320 → 1313 |
  | `WebGPUSkyAtmosphereRenderer.js` | 1291 → 1241 |
  | `SkyAtmosphere.wgsl` | 1007 → 939 |

- Re-measure these after the rebase.
- **Never use `decomposition-doc.patch`** (D10).

**`DEFERRED_WORK.md` and `FEATURE_INVENTORY.md`** (seat), in the batch named:

| Batch | Rows |
|---|---|
| each A batch | the parity rows (D6), including the §D FUTURE row for a WebGL volumetric-cloud path, landed with A1 |
| A2c | the sparse withdrawal row and the bit-7 reservation (D2, D3) |
| T1 | the WASM-init race (D5), **only if D5 takes (A)**; under the recommended (D) it is fixed in T1 |
| A1 | the HOLD chain, U23 / U26 / U29 / U30 (D12): plumbing landed as STRUCT with reserved slots 220–223 and 228–259, features withheld; prerequisite native 96/8 stability (E4); route back D12(c) |
| A3 | the open stripe-gate item (U32b) |
| A2c | the cloudy-boundary overhead of empty-weather skipping (CP:44) |

**Also:**
- **`TOOLING_CATALOG.md`**, when a batch adds a spec (`verify-tooling-catalog`).
- **`MAINTAINER_RULINGS`** for D1–D12 once they are ruled, plus the moot / superseded rows for R-2026-09-16-2, -3, -6 and -7 (audit §3.3; critic C17). **[Done: [`MAINTAINER_RULINGS_2026-09-26.md`](MAINTAINER_RULINGS_2026-09-26.md), including its moot-clause table.]**
- **`CAMPAIGN_STATE.md`**, if the maintainer makes Astra's return a campaign-level item. **[Recorded 2026-09-26 in its C13 block as a HELD wave pending P2.]**

---

## 5. The Edge queue (one slot)

| Job | Owner lane | Tree(s) | What it must show | Hazard |
|---|---|---|---|---|
| **E1** | W2-L11 (seat queue) | its frozen tree | its own karma acceptance | — |
| **E2** | T1 | post-W2-L11 tip against tip + T1 | no new karma red in the `Core/TaskProcessor` selection | — |
| **E3** | ring (seat queue) | **pre-Astra** tip | Leg 2's arms and I-5's pre-registered prediction, with Leg-1 frames as baseline | — |
| **E4** | **I-3 / N69** | (a) base tip; (b) base + the frozen Astra patch, **built at `b263d8ac5e`**, where it applies (re-derived) — I-5 and I-3 edit the same `resolveCloudPreset` hunk, so it will not apply after them; (c) (b) with U3's step bounds reverted; (d) **single-deck**, tier 3 at defaults, on (a). All built in a disposable clone | Is native 1080p high 96/8 multi-deck `DXGI_ERROR_DEVICE_HUNG` present at base? Does U3 contribute? Does it need multi-deck? Astra's receipts put the hangs in feature-off controls (RA:335, RA:377, CP:71), so arms (a) and (d) matter most (R1 §5.4, R3 §9.7; critic C5) | **Hang risk.** Bounded deadlines, one frame at a time, the lane owns the machine. Never 512 steps at 2048² (R5 §5.2). A background Edge probe carries a machine-crash risk. |
| **E5** | A1 | T0 / T1 | §3 A1 items 1, 1a, 2–6, each identity cell with a repeat control | **Hard-gated on E4.** The clouds-on ground cell is native 96/8 (hang protocol) |
| **E6** | A2a | T0 / T1 | §3 A2a items 1–4 | any native high cell under the hang protocol until E4 reports |
| **E7** | A2b | T0 / T1 | §3 A2b items 1–3 | the clouds-on ground cell is native 96/8 (hang protocol) |
| **E8** | A2c | T0 / T1 | §3 A2c items 1–8 | the 384-step cell is hang-class; the clouds-on ground cell is native 96/8 (hang protocol) |
| **E9** | A3 | T0 / T1; WebGL and WebGPU; `highDynamicRange` forced on an SDR display for every cell except HDR canvas output (critic C9e) | §3 A3 items 1–5, including the orbital aerial cell | only the canvas-output cell needs an HDR display; a tier-3 orbital run is under the hang protocol |
| **E10** | wave end | after A3 | the variant smoke test, the Sandcastle2 sweep on both renderers, capture-and-diff | — |

**What can run early, and must.** E4 needs neither Astra's return nor the rulings. It runs as soon as the I-3 lane has the slot, and
**before** I-5 or I-3 edits `resolveCloudPreset`, because its arm (b) needs the frozen patch to apply. Its result feeds D9, D12(c)
and the hazard column above. **E4 is a hard gate before E5.**

**What is folded into E5.** R2 #1's HDR-canvas base cell and the fog-blanking question (R3 §9.1). Neither needs its own slot.

---

## 6. Reviewer and verifier duties (every A batch and T1)

1. **Freeze before review.** Record the md5 of the formatted batch patch. Reviewed bytes must equal landed bytes (C2).
2. **Brief from behaviour.** The reviewer's brief is written from the behaviour to assert, not from Astra's packet (Principle 10).
3. **Run a call-site inertness mutant for every new mechanism in the batch.** Use R4's in-memory read-shim method; every mutant must
   die. For a module-internal mutant that the shim cannot reach, because the spec bundles TS through esbuild (R4 §6.6), mutate a copy
   of the tree under the lane's temp root instead.
4. **Check the rules:**
   - an RTE pass over new and changed WGSL;
   - no bypass of the shader-module or pipeline cache;
   - `ShaderDefineHi` stays append-only;
   - `CLOUD_UNIFORM_FLOATS` keeps a single source, with no new slot-index mirrors;
   - no `any`;
   - log pragmas and throttles;
   - C16 `--strict`.
5. **Re-run the gates on the frozen batch:**
   - `test-cloud-c13` (0 fail), and `test-cloud-c13-quarantine` gated **by name**: its red set must be a subset of
     {`cloud-reconstruction-attachments` F1a, F1b, `cloud-shadow-rte:828`}. A count gate of "≤ 4" would pass one new red, because
     the patch turns base red D8 green (critic C8);
   - `test-visual-regression-node` (its base counts moved with Batch 1537), `test-sky-atmosphere` and `test-visual-probe-contracts`;
   - **the runners whose specs read files Astra modified** (critic C7): `test-engine-node`, `test-model-webgpu`, `test-readiness`,
     `test-s5` and `test-blend-parity`;
   - **the CI steps** (critic C6): `prettier-check` (CI at `dev.yml:27`, `prod.yml:32`), `eslint` with the frozen seatbelt,
     `test-webgpu-policy`, `audit-feature-renderers`, `collection-sentinels-check`, plus `test-c16` and `test-landing-rules`
     (`dev.yml:83`, `:85`);
   - `npm run tsc-engine` after a build;
   - `lint-debug-pragmas`;
   - `lint-comment-markers` and `comment-marker-guard --verify-cleanlist`;
   - `verify-tracked-references --rev` on the batch commit;
   - the variant smoke test.
6. **The adversarial verifier** (R-2026-09-11-1) on A1, **A2a** (default work in the LUT bake; critic C10), A3 and T1. It is briefed to **refute** the packet and writes `VERIFY_<name>.md`
   with HOLDS or REFUTED. A REFUTED verdict returns the batch before it lands.

---

## 7. Clones and cleanup

**No branch** was created by this audit, and none is needed by this plan. Only `main` exists locally.

**Clones:**

| Clone | What happens to it |
|---|---|
| **`cesium-lane-hasufel-20260926`** (R4's audit clone) | The patch is applied and uncommitted, and the seatbelt is dirty. Close it out once the critic finishes, with the link-aware junction procedure: walk with `lstat`, unlink links only, verify the seat, then delete. Nothing to harvest; R4 transcribed its logs. |
| **`cesium-astra-20260921`** (Astra's) | Keep it until the return brief is dispatched. Astra then works in a **fresh clone of the post-P1 tip**. After that, repatriate its `_lane-out/` evidence into the seat's gitignored `Tools/visual-regression/output/`, harvest it in two phases to `cesium-webgpu-worker-archive`, and close it out. |
| **`cesium-astra-20260914`**, **`cesium-astra-20260910`** (older Astra clones) | Close-out candidates: the 09-16 stack is superseded, and 20260910 is marked "never reuse". Two-phase harvest first. They were not examined in this audit. |

**Temp.** This audit created no temp root. The readers report their temp roots removed, apart from R4's retained clone.
