# Decisions for the maintainer — Astra's cloud work of 2026-09-21 → 2026-09-25

_RULED 2026-09-26: see [`MAINTAINER_RULINGS_2026-09-26.md`](MAINTAINER_RULINGS_2026-09-26.md) (`R-2026-09-26-1`…`-12`; every recommendation adopted, every other sound option recorded there as a fallback). This file stays as the full option analysis. "LANDING_PLAN" below is [`ASTRA_LANDING_PLAN_2026-09-26.md`](ASTRA_LANDING_PLAN_2026-09-26.md), the audit is [`ASTRA_WORK_AUDIT_2026-09-25.md`](ASTRA_WORK_AUDIT_2026-09-25.md), and the critique (`CRITIQUE_FELAROF.md`) and reader reports are banked at `cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/`. "Nothing here is ruled" below is this file's state when written._

_Companion to `ASTRA_WORK_AUDIT_2026-09-25.md`, whose evidence ids R1–R5, U1–U37 and Y1–Y17 are used here. Written by Asfaloth
(Opus 5.5) for the seat (Gandalf), 2026-09-26; revised after Felarof's critique (audit §10), which added D12 and options D5(D) and
D11(C) and rewrote D4b b2 and b5. **Nothing here is ruled.**_

**How each decision is laid out:**
- **The question.**
- **The facts it turns on**, each with a reader id.
- **The sound options.** An option a reader showed to be unsafe is not offered; it is listed under "Not offered", with the reason.
- **The recommendation and its basis.**
- **What executes it.**

**Worker tier.** Everywhere below, "seat lane" means an Opus 5.5 worker (model `opus` = `claude-opus-5-5`). The seat passes the model
and the effort explicitly on every dispatch.

---

## D1 — Landing direction for the stack

**Question.** How should Astra's 37-unit cumulative patch reach `main`?

**Facts:**
- **Not landable as it stands:**
  - the P0 fog break (Y1; R3 F1);
  - 13 + 6 runner reds, one a crash that silences L3's protected acceptance (Y2; R4 H1, H2, H5);
  - the formatter rewrites 44 files and adds 7 reds (Y6; R4 §4);
  - 4 of 5 new specs are inert-survivable (Y5; R4 H4);
  - the failed sparse candidate is still present (Y4);
  - default moves are unruled (Y3).
- **The seat cannot re-cut the stack by itself.** Hunk attribution inside the renderer, `ProceduralClouds.wgsl` and
  `CloudLightSampling.wgsl` is file-level only, and the per-packet incremental patches are not all against one base (R1 §1, §5.9).
- **The seat's queued lanes own the same hunks:** I-3 and I-5 in `WebGPUCloudTierPresets.ts`; N60, N61 and N13 in
  `ProceduralClouds.wgsl` (R5 §1b, §2).
- **Precedent, R-2026-09-16-1:** the seat's lanes land first, and Astra rebases.
- **R-2026-09-16-5:** an independent reviewer and one named Edge leg per landing batch.
- **The four HOLD units stay out as features under every option:** U23, U26, U29 and U30. The basis is the author's own hold and
  its visual-validation FAILs (RA:335, RA:377). It is **not** a unit-caused hang: Astra's receipts record the native 96/8 hangs in
  feature-off controls — RA:335, *"the shadow-off control (96/8, peer budget 0)"*; RA:377, the *"initial legacy"* run; CP:71,
  *"matched preceding shaders"* (critic C5). **Their plumbing runs on the default path of kept units; D12 decides it.**

**Sound options:**
- **(A) Return, rebase, re-cut.**
  - Astra strips U37, clears the fix list (LANDING_PLAN §2) and rebases **after** the seat's Phase-1 lanes. Then it re-cuts the stack
    into class batches:
    - A1 — byte-neutral structure, plus the P0 fix;
    - A2a — default work in the LUT bake plus the atmosphere opt-ins (it carries D4a a3–a5, a7, so it gets the verifier);
    - A2b / A2c — inert opt-in features;
    - A3 — the ruled default-path changes.
  - Each batch carries:
    - the common set C1–C7;
    - an Opus 5.5 reviewer;
    - an Opus 5.5 adversarial verifier on every batch that moves default work or the default image — A1, A2a, A3 — and on T1
      (R-2026-09-11-1);
    - one named two-tree Edge leg.
- **(B) As (A), but Astra lands first.**
  - Astra's batches land **before** I-3, I-5, N60, N61 and N13, which are re-briefed onto Astra's tree (R5 §3.6–3.7, the stated
    alternative).
  - Costs:
    - the ring Leg-1 frames stop being a baseline, so M0 must be re-banked before Leg 2 and before I-5's leg;
    - the §4.6 hang arithmetic of Leg 2 must be rewritten with Astra's interval law;
    - N60's pad rename must be re-authored;
    - the N69 budget must be written against Astra's march.
- **(C) One all-at-once batch,** after the complete fix list.
  - One reviewer and one Edge session.
  - Costs:
    - 37 units ride one leg, so a regression cannot be attributed to a unit;
    - default-moving and inert changes ride together;
    - the lane-ordering question of (A) and (B) remains.
- **(D) Reject the stack and keep it archived as reference.**
  - It costs nothing now.
  - It discards receipt-backed work: irradiance reuse, specialisation, Worley pruning, lighting-cache reuse, empty-weather skipping
    (R2 §2–§3).

**Not offered:**
- **Landing the patch as-is.** Y1, Y2 and Y6 show it unsafe.
- **The seat cherry-picking hunks out of the cumulative patch.** R1 §1: the units interleave inside the three largest files.

**Recommendation: (A).** The basis:
1. **Lower cost, more ownership.** It costs the least and keeps "one owner of a file at a time" for the three files the seat's queue
   already owns (R5 §3).
2. **Only the author can re-cut.** The re-cut needs the author's knowledge of which hunk belongs to which unit (R1 §1).
3. **Batching makes risk readable.** Class batches let each Edge leg show one kind of change: identity, opt-in delta, or ruled
   default delta. Under (C), a mixed regression is unreadable.
4. **It follows R-2026-09-16-1,** which worked: L3, L4 and L5 all landed, and Astra's base is their descendant.

**Executes.**
- **The seat** writes the return brief (D8) from LANDING_PLAN §2 and freezes each batch as Astra delivers it.
- **Seat lanes** review, verify and run the inertness mutants.
- **The Edge executor** runs E5–E10 in LANDING_PLAN §5.

---

## D2 — The failed sparse candidate (U37)

**Question.** Strip it per Astra's own rule, or keep it behind its default-off flag?

**Facts:**
- **Both A/Bs FAILED Astra's preregistered gates.**
  - `runtime-02` ran on the final bundle `a4b74c3a…`. Static/moving reduction was 12.4 % / 12.6 % against ≥ 20 %, and p99 byte error
    was 28 / 25 against ≤ 20 (R2 §1; `result.json` re-derived: `"status": "FAIL"`).
  - `runtime-01` ran the 4×4 revision.
  - Device loss, coverage and nonfinite passed.
- **Astra's own rule (CP:83):** *"If it fails, preserve the evidence, remove only its authored implementation changes, and keep the
  append-only shader bit reserved."*
- **Its spec survives the call-site mutant** `enabled: false && …`, 10/10 (R4 M1).
- **Even when off,** every offscreen frame builds a ~200 KB source concatenation (R3 F7).
- **8,294,656 B stays resident** after it is disabled (R3 F9).
- **It adds `sparseRequested` to the widened emit gate** (P:1583–1605), and a new consumer of the r16float depth read (R5 §2.2).
- **Its evidence is already preserved** in `cesium-webgpu-worker-archive/astra-checkpoint-20260925/` (`MANIFEST.md5`).

**Sound options:**
- **(A) Strip it, and write a withdrawal record.**
  - Remove the four new files, `WebGPUCloudSparseHistory.ts`, `WebGPUCloudSparseUpdates.ts`, `CloudSparseUpdates.wgsl` and
    `cloud-sparse-updates.spec.mjs`, and every sparse hunk, including:
    - the `ShaderDefineHi` bit-7 entry;
    - the renderer's sparse wiring and its per-frame inputs;
    - the `cloudSparseHistory` consumer in `ProceduralClouds.wgsl`;
    - `CloudVolumetrics.cloudSparseUpdates`;
    - the `cesium-cloud-types.d.ts` field;
    - the runner entry;
    - the `sparseRequested` term in the emit gate and in its spec regexes.
  - Write a withdrawal record in the shape of the 09-16 `LIGHT_REUSE_WITHDRAWAL.json`, naming both runtime folders and the archive
    manifest.
- **(B) Keep it default-off as WIP under R-2026-09-16-6,** only after all four of these:
  1. its spec kills M1;
  2. the off-path source concatenation is removed;
  3. the history is released on disable;
  4. both A/Bs are recorded in its packet.

  Even then, (B) lands code that failed both of its preregistered A/Bs.

**Recommendation: (A).** The basis:
- It is the author's own rule.
- It failed twice, on two tile sizes.
- Its spec is inert-survivable.
- It costs something on the off path.
- 09-16 precedent: withdrawn units were removed *with* a withdrawal record. `DIRECT_LIGHT_CULL` was flagged for lacking one.
- **Stripping is needed anyway before any re-measurement:** R2 §5 found that no retained number was measured on the final tree, and
  the stripped tree is the one that will land.

**Executes.**
- **Astra strips it,** as item 1 of the return.
- **The seat's reviewer verifies:**
  - `git grep -nE 'cloudSparse|CLOUD_SPARSE|CloudSparse|sparseRequested'` returns 0 over engine and Tools;
  - the stripped cumulative patch passes `git apply --check`;
  - `cloud-march-emission` A2 and E4 are re-pinned and green.
- **The seat** lands the `DEFERRED_WORK` row. It carries the re-attempt conditions, taken from CP:67's gates.

---

## D3 — `ShaderDefineHi` bit 7 (and bit 6, `qualityFlags` bit 14)

**Question.** Should bit 7 stay reserved after the strip, and how?

**Facts:**
- **Bits 6 and 7 are appended** after bit 5, with no renumbering (R1 §2.1, R3 F11).
- **Bit 7 has never landed on `main`.** No module built from `main` was ever keyed on it.
- **CLAUDE.md's add-only rule protects landed entries.** R5 §3.8 notes that a bit may be renumbered while unlanded.
- **The pipeline cache folds shader-module identity,** so aliasing is impossible structurally whatever is decided (CLAUDE.md, "Pipeline-key
  aliasing is handled STRUCTURALLY").
- **The archived evidence is written against bit 7:** `runtime-02/engine-sparse.wgsl` and `cloud-sparse-ab-only.patch`.
- **No queued plan claims a hi bit** (R5 §2.2).
- **Capacity:** the hi word has 31 usable bits. At base, 0–5 are used; U34 takes 6.

**Sound options:**
- **(A) A registry comment line plus a `DEFERRED_WORK` row.** No entry and no consumer.
  - The line is something like `// hiDefineBit(7) reserved: sparse cloud updates, withdrawn 2026-09-25 — see DEFERRED_WORK …`, landed
    beside bit 6 when U34 lands.
  - The next claimant takes bit 8.
- **(B) A `DEFERRED_WORK` row only.**
- **(C) Free bit 7.** A revived sparse attempt renumbers its archived patches.
- **(D) Land `CLOUD_SPARSE_UPDATE: hiDefineBit(7)` as a real entry with no consumer.** The add-only rule then keeps an entry nothing
  reads, forever.

**Recommendation: (A).** The basis:
- **The registry is where the next claimant will look.** CLAUDE.md's "Adding a new define bit" step 1 sends every lane there to check
  capacity, so a comment in the registry is seen by the next claimant. A ledger-only row is not.
- **The cost is small:** one comment line and one of 24 free bits.
- **It honours Astra's stated intent** (CP:61) and keeps the archived evidence replayable.
- **(D) adds a dead entry** that Principle 7 would then protect.

**Also:**
- **Bit 6 and `qualityFlags` bit 14 stay reserved for Astra** until A2c lands (R5 §3.8).
- **If a seat lane must claim a hi bit before then,** Astra renumbers. Renumbering is allowed while unlanded.

**Executes.** The seat, in the batch that lands U34 (A2c): the registry comment line, plus the `DEFERRED_WORK` row from D2.

---

## D4 — Default-path byte changes

**Question.** For each change that moves the default image or default work without a dial: accept it, gate it, or revert it?

**The two populations:**
- **MOVES-G** — users who never enable clouds.
- **MOVES-C** — users who enable volumetric clouds and set nothing else.

**Standing constraint:** "defaults unchanged unless ruled". That is why every row below needs a ruling.

### D4a — MOVES-G (never enabled clouds)

| # | Change | Evidence | Sound options | Recommendation | What proves it |
|---|---|---|---|---|---|
| a1 | U19: the WebGPU sky outputs linear radiance when `highDynamicRange` is on and the canvas is SDR. HDR is on by default on HDR displays under the `'scene'` policy. | R3 F2; P:11447 | (i) Accept it as a parity fix. It removes a double tone map and matches GLSL `#ifndef HDR`. (ii) Gate it behind a sky option that defaults off. That keeps the double tone map for users on HDR displays. | **(i)** | An Edge leg on the full WebGPU frame. HDR off must be byte-identical to base over the **full** frame, not only the top 1920×300. HDR on shows the intended change. Run it on an HDR-capable display and on an SDR one. Add a slot-55 matrix spec: {HDR off, HDR on + SDR canvas, HDR on + HDR canvas} → {0, 1, 0} (R3 §3). The baseline refresh is its own reviewed commit. |
| a2 | U19: the WebGL sky alpha is clamped to [0, 1] | R3 F3; P:7240 | (i) Accept it. With `ALPHA_BLEND`, an alpha above 1 amplified the source and gave the destination a negative weight. (ii) Drop the GLSL clamp and keep only the WGSL one. The two backends' alpha then diverges. | **(i)** | A WebGL HDR leg at ground level and at 30 km (R3 §8). Astra's packet has no WebGL leg. |
| a3 | U9: the irradiance kernel is rewritten. The LUT content changes, and the first bake costs about 24× more: 25,165,824 segment evaluations against 1,048,576. No default consumer reads it. | R3 F4a | (i) Accept it, conditional on a first-bake GPU timing. (ii) Bake the irradiance LUT only when a consumer exists: the cloud `sky-lut` ambient path, or the probes. | **(i), switching to (ii) if the timing shows a visible startup cost.** The maintainer sets that threshold. | A `CesiumDebug.gpuPassCost` timestamp on the `computeIrradiance` pass, base against patch (E6). |
| a4 | U16: an 8,192-byte scattering-field texture is allocated on every WebGPU scene with LUTs | R3 F4b | Accept it. It is negligible, and the bake is gated on `multipleScattering`. | **Accept** | — |
| a5 | U10: a LUT dispatch that reports false now leaves `lutReady` false and retries | R3 F4c | Accept it **only with a bounded retry**: N attempts, then latch and log once. CLAUDE.md makes retry exhaustion a permanent `console.error`. An unbounded retry repeats every frame while a dispatch keeps failing. `dispatchCompute` returns false only when there is no `computeEngine` or no source (P:4579–4649), so each repeat is a per-frame CPU early return rather than a GPU re-bake; bounding it is still right (critic note). | **Accept, bounded** | A spec in which a dispatch reports false: `lutReady` stays false, retries are bounded, and it is never silently marked ready (R3 §8). |
| a6 | U19: `atmosphereLightIntensity ?? 50` replaces `\|\| 50`, so an explicit 0 now gives a black sky, as WebGL already does. **Not MOVES-G** (critic C13): the default is 50 (base `SkyAtmosphere.js:173`), and 0 arrives only from an application setter (base `AtmosphericConditions.js:626–636`). It sits in this table because it rides with a1 in A3 | R3 F4d | Accept it. It is a parity fix for an explicitly set value. | **Accept** | Its own assertion, because the slot-55 matrix does not pin the intensity: an explicit 0 packs 0, and an unset value packs 50 (F-10). |
| a7 | U16: users who already set `SkyAtmosphere.multipleScattering = true` get a physical 32-step field instead of the `MS_SCALE 0.06` term. That is a different sky, and it costs more per fragment. | R3 §3. At base the option is documented as WebGPU-only (base `SkyAtmosphere.js:66–70`). | (i) Accept it as the option's new meaning. (ii) Keep the old term for `true`, and put the physical field behind a new value. | **(i)** | An Edge leg with the option on and off, plus a per-fragment timing. Astra's own README says "FPS and motion are unmeasured". |

**Not offered:** accepting a5 without a bound. Readers showed it can loop every frame (R3 F4c).

### D4b — MOVES-C (clouds enabled, no new options)

| # | Change | Evidence | Sound options | Recommendation | What proves it |
|---|---|---|---|---|---|
| b1 | U8: the composite blends in linear space with a display-gamma 2.2 decode and re-encode on SDR non-sRGB canvases. The native-temporal branch returns alpha 1.0, where the half-res branch returns `sceneColor.a`. | R3 F5; R1 U8 | (i) Accept it as the new default composite. (ii) Gate it behind a dial that defaults off. | **(i)**, once the alpha difference is aligned or explained | A before/after Edge leg at defaults, on an SDR and an HDR canvas. Also re-check the premises of `lib/cloud-photometry.mjs`, because the transfer is now linear (X10; R1 §5.7). |
| b2 | U11: the billow envelope applies to the default CUMULUS / BILLOWY profile, and in the procedural sky cubemap's density (P:7591–7632). The legacy hashes were re-frozen without the "default row is identity" clause. | R1 U11; R4 §1.1, H6; R5 §2.2; RA:167 | (i) Accept it as the new default look (A3), and record the hash re-freeze as ruled. The ring M0 is re-banked after it. (ii) Put it behind a dial that defaults off, **in A2c**. The legacy hashes **cannot** return to base under (ii): they are sha256 of the stripped **source text** of `legacyCloudDensity` / `legacyCloudBaseDensity` (base `cloud-density-domain.spec.mjs:79–87`, `:700–716`), and U20a and U26's plumbing edit the same bodies (Astra's own note, P:1254–1272), while the gate itself adds text. So (ii) re-freezes them **once**, with the three-part reason (U11 gated, U20a identity branch, D12 profile threading) and the identity clause restated, and proves default identity **by execution**, not by text (critic C4). | **(ii)** | A value oracle that executes `legacyCloudDensity`, `legacyCloudBaseDensity` and the macro density at defaults (dial off, exponent 1, no layer profiles) and matches base's values; its mutant forces the billow on and must go red. The A2c leg shows the dial off byte-identical to T0 at ground, flight and orbit, and in the IBL cube with `cloudContributesIBL`; the dial on shows the intended change. |
| b3 | U32b: the IGN scroll becomes linear, `5.588238 * frameIndex`, on every jittered tier | R1 U32; RA:445; R4 §1 | (i) Revert to base's golden-ratio phase on the default path until a stripe gate passes. (ii) Accept it on R4's 64-frame discrepancy test, despite the failed stripe gate. | **(i)** | — |
| b4 | U3: the fine step is clamped, the sentinel grows with the chord, and the comb accumulates from 0 | R4 §1.2; R5 §2.1–2.2 | → **D9b** decides who owns the march law. Whoever owns it, Astra's batches do not change the default march. | — | — |
| b5 | U1 / U2 / U4 / U15: the physical aerial path is replaced (finite camera-to-cloud air, the placeholder guard, and PBR-Neutral tone on SDR). **It reaches the default at camera heights ≥ 100 km** — settled from source, no measurement needed (critic C3): above `CLOUD_AUTO_DISABLE_ALTITUDE_METERS = 100_000` (base `WebGPUCloudTierPresets.ts:309`) `resolveTier` returns tier 1 (`:200`) and clouds still draw; `shouldDefaultPhysicalAerial` is true there (`:364–368`); an unset or `"auto"` `cloudAerialMode` selects it (base renderer `:3818–3823`). The orbital ring rig is on this path. | R1 §5.2; audit §2.2 U4 row | (i) Accept it as the new default orbital aerial. It lands in A3 **after P1.3** (ring Leg 2 on a pre-Astra tree), with an orbital before/after cell in E9, and the ring M0 is re-banked after it. (ii) Keep base's physical aerial code as the default for unset / `"auto"` / `"physical"`, and put U4's transport and U15's tone behind a new dial that defaults off (A2b). This keeps two physical-aerial implementations in the shader. | **(i)**, falling back to (ii) if E9's orbital cell shows an unintended change. Basis: base already makes the physical path the default above 100 km by design (base renderer `:3805–3808`: above the band edge the heuristic term saturates its `clamp(midDist / 60000, 0, 0.85)` for every pixel); U4 clips the integral to `[max(hit.x,0), min(hit.y, cloudDistance)]`, which is what that path is meant to compute (R2 §4); and (ii) doubles the physical-aerial code for no user-visible choice. **No orbital receipt exists on the final tree** (R2 §5), so (i) rests on E9. | A Node spec that pins the reach (`resolveTier` and `shouldDefaultPhysicalAerial` at 100 km and 6,608 km with `cloudAerialMode` unset and `"auto"`). E9: an orbital default cell, before/after, clouds on, at the ring rig's pose. |
| b6 | STRUCT claims: U22, U24, U27, U28, the U36 weather ownership, and the HOLD plumbing kept under D12(a). Also default-path code in A2c: U18's gate change, U20a's identity branch, U21's disabled branch, U36's skip | R1 §1, §5.8; R3 F12; critic C9 | No ruling is needed. The byte-identity legs decide, each with a same-build repeat control (R-2026-09-16-7). A unit whose output is not identical returns. | — | E5, E7, E8 (LANDING_PLAN §5) |

**Recommendation basis for b2 and b3:**
- **b2.** Astra's own assessment is *"less coverage and lower tops"* (RA:167). The 09-16 BILLOW unit was returned for exactly this
  kind of default flip. The ring family lives on this density field (R5 §2.2).
- **b3.** Astra's own predeclared gate failed: +1.82 % and −1.84 % against a required 25 % (RA:445). CLAUDE.md Principle 8: *"A 'fix'
  that doesn't move the diff is not a fix."*

**Executes.**
- **Astra** implements the gates and reverts as ruled, in the return.
- **The seat** lands each accepted MOVES change in A3. Each carries its own Edge leg, and its baseline refresh is its own reviewed
  commit (R-2026-08-29-2).

---

## D5 — The TaskProcessor Core fix

**Question.** Should the TaskProcessor settled-guard land separately, on its own proof bar?

**Facts:**
- **It is not in the frozen patch.** It lives only in the clone's worktree, and equals the seat packet
  `Tools/visual-regression/output/astra-return-audit-20260921/worker-rejected-dispatch.patch` (R1 §0, R2 §0.5).
- **The race is real,** and the guard cannot drop a legitimate continuation (R3 §7).
- **The spec discriminates at base:** the worker regression goes from 10/2 to 12/0 (R2 §4).
- **The spec has a runner home** in `test-visual-regression-node` (R3 §7).
- **Its inertness mutant is reasoned but has not been run** (R3 §7).
- **W2-L11's karma selection covers `Core/TaskProcessor`,** and its brief marks the file read-only (R5 §1a.3).
- **The WASM-init path has the same race** and no guard (R3 §7). Re-derived: in base `TaskProcessor.js:273–320` the init installs
  `onerror` / `onmessageerror` that reject, then awaits the loader config and `canTransferArrayBuffer()`, then posts the config with
  `wasmBinary` as a transferable whether or not the promise has already rejected.
- **Freeze identity** (critic C14, re-derived): the seat packet's md5 is `c4016b889ec06d782c36a50f8888e449`; with `index` lines
  dropped it equals the clone's `git diff` of the two files, both `c3cb96b14feb04590a22e8c61e76dd52`; it passes `git apply --check`
  at `b263d8ac5e`.

**Sound options:**
- **(A) Its own Core batch, T1, after W2-L11 lands.**
  - Freeze it from the seat packet, with an md5 and `git apply --check` at the tip.
  - An independent Opus 5.5 reviewer.
  - **Run** the inertness mutant `if (false && taskListeners.isSettled())`.
  - An adversarial verifier, because the file is on every backend's path.
  - A karma Edge leg over the Core/TaskProcessor specs.
  - File a `DEFERRED_WORK` row for the WASM-init race.
- **(B) Hold it, and land it inside Astra's A1.** That couples a Core fix on every backend's path to a cloud batch, and delays a real
  fix.
- **(C) Do not land it.** The race wastes worker work and detaches the input of an already-rejected task. R3 rates the risk "very
  low". This option leaves a real race open.
- **(D) As (A), and guard the WASM-init race in the same T1 batch** (added after critique, C14).
  - A seat Opus 5.5 lane adds a settled check before the init path's `postMessage`, plus a spec case in the same error-path spec
    that fires `error` before the config resolves and asserts no post and no detached `wasmBinary`.
  - Its inertness mutant makes the new check unreachable and must go red.
  - Same file, same proof bar, the same karma leg E2. The reviewer is a different lane from the one that writes the guard.
  - The frozen packet stays Astra's bytes; the WASM guard is a second, seat-authored hunk in the same batch, frozen with it.

**Recommendation: (D).** The basis:
- Astra's unit is a two-file, 59-line change, independent of the cloud stack, with sound evidence: the guard's reasoning (R3 §7), a
  discriminating spec (R2 §4), and an existing runner.
- The W2-L11 ordering is known (R5 §1a.3).
- The WASM-init race is the same defect in the same file. Landing it in the same batch pays for one Core proof bar and one karma
  leg instead of two, and avoids a `DEFERRED_WORK` row for a known, bounded fix.
- **Fall back to (A)** if the WASM-init case cannot get a discriminating spec in the same batch; then file the `DEFERRED_WORK` row.

**Executes.**
- **The seat** freezes Astra's packet, as Phase 0 item P0.2.
- **A seat Opus 5.5 lane** writes the WASM-init guard and its spec case; **a different lane** reviews; the adversarial verifier
  refutes.
- **The Edge executor** runs the karma leg E2, after W2-L11 lands.

---

## D6 — WebGL twin gaps (Principle 5)

**Question.** How are the WebGL gaps handled?

**Facts:**
- **The only GLSL change is the U19 alpha clamp** (R1 §2.4).
- **The cloud units have no WebGL counterpart,** and no WebGL volumetric-cloud path exists (R1 §2.4; 09-16 X5).
- **`SkyAtmosphere.multipleScattering` is already documented as WebGPU-only** at base (base `SkyAtmosphere.js:66–70`), so U16 opens no
  new gap.
- **No `DEFERRED_WORK` or `FEATURE_INVENTORY` row exists** (R1 §2.4).
- **Only 5 of the 14 new dials say "WebGPU"** (R1 §2.4).
- **The standing ruling, R-2026-09-12-8:** a gap is recorded, not a reason to reject.

**Sound options:**
- **(A) Record the gap.**
  - `DEFERRED_WORK` and `FEATURE_INVENTORY` §C rows naming the WGSL-only cloud units.
  - A note that the U19 alpha clamp is a real twin.
  - "WebGPU only." in every new dial's JSDoc.
- **(B) (A), plus a `FEATURE_INVENTORY` §D FUTURE row for a WebGL volumetric-cloud path,** so the gap has a named home (Principle 9).
- **(C) Require a WebGL implementation before landing.** This overturns R-2026-09-12-8. With no WebGL volumetric path to twin into,
  it is a project, not a port (09-16 X5).

**Recommendation: (B).** The basis: R-2026-09-12-8, plus Principle 9's "surface missing functionality as next work". The cost is one
row.

**Executes.**
- **Astra** returns the row text and the dial JSDoc in each batch packet.
- **The seat** lands the ledger rows. They are seat-owned files.

---

## D7 — The `eslint.seatbelt.tsv` rows

**Question.** What happens to Astra's clone-only seatbelt edit?

**Facts:**
- **The edit.** Renderer `curly` 10 → 9 and `no-use-before-define` 6 → 5 (R1 §2.10).
- **The values are right for the audited bytes.** R4 measured that the seat's own eslint, run on the patched renderer, produces exactly
  this tightening (R4 §4).
- **They expire.** The formatter rewrites the renderer by +233 / −75 (R4 §4), and the rebase moves it again.
- **A parse-error lint run auto-removes allowance rows** (CP:77).
- **The file is seat-owned.**

**The only sound option: the seat regenerates the rows** with its own lint, on the final landed tree of each batch that touches a
seatbelted file, and commits them with that batch. The run must be on a tree that parses.

**Not offered:** copying Astra's two rows. They are valid only for bytes that will not land (R4 §4).

**Recommendation:** rule this as standing — "no lane edits `eslint.seatbelt.tsv`; the seat regenerates it at landing". R4's audit
clone carries a dirty seatbelt, which is discarded with the clone.

**Executes.** The seat, in each batch.

---

## D8 — Astra's next assignment

**Question.** What does Astra do next: its own "Remaining work, in order" (CP:81–89), or the seat's needs?

**Facts:**
- **Item 1 of Astra's list is now settled:** the sparse candidate failed, and D2 strips it.
- **Items 2–7 would all build on the unlanded stack,** in the same renderer and shader files:
  - lighting-cache refresh budgets;
  - HLOD / impostors;
  - startup stalls and native 96/8 device loss;
  - visual work;
  - lighting gaps;
  - weather.
- **None of Astra's volumetric-cloud work has landed in two cycles:**
  - *"The old cumulative Astra preview has **not landed**"* (RA:12);
  - this stack is not landable (audit §0).
- **The seat's queue** includes W2-L11, the ring lanes I-2 and I-5, CI tranche 2, C15-06 and record round 7. Its cloud-adjacent lanes
  own the files Astra's list would touch (R5 §1b).
- **Principle 10:** a spec written from the same brief as the fix is not an independent check. The inertness mutants and the review
  must come from outside the author.

**Sound options:**
- **(A) Landing-readiness first.** Astra's next assignment is the return fix list on this stack (LANDING_PLAN §2):
  - It works in a fresh clone of the post-Phase-1 tip.
  - It delivers frozen batches A1–A3, with a hunk → unit map.
  - Seat Opus 5.5 lanes own the reviewer, the adversarial verifier, the call-site inertness mutants and the Edge legs.
  - No new cloud feature until A1 lands.
  - Astra's item 4 measurement (native 96/8) moves to the seat's N69 owner (D9).
- **(B) Astra continues its own list** on top of the unlanded stack, and the stack waits.
  - The stack keeps growing.
  - The rebase cost grows with the seat's queue (R5 §3).
  - Nothing lands.
- **(C) The seat's Opus 5.5 lanes take over the stack's landing-readiness entirely,** and Astra moves to work that touches none of these
  files.
  - The seat must reconstruct hunk → unit attribution without the author. The per-packet patches exist but are not against one base
    (R1 §5.9).
  - Independence of review improves.

**Not offered:** Astra extending the stack while seat lanes edit the same files to prepare it. That is two concurrent owners of one
file, which the seat's standing rule forbids ("one defect, one owner").

**Recommendation: (A).** The basis:
- The re-cut needs the author (R1 §1).
- Principle 10 is served by seat-owned mutants and review.
- It stops the unlanded stack growing for a third cycle.
- It keeps one owner per file.

**Executes.**
- **The seat** writes the return brief. Astra is a Codex worker, so its report is a lane claim until confirmed.
- **Opus 5.5 seat lanes** do the review and the proof work.

---

## D9 — C13-N69 hang ownership, the C13-N13 march law, and `cloudPrimarySteps`

**Question.** Who owns the hang class, and does a public sample-count dial ship?

**Facts:**
- **Raw `cloudQuality` is still unclamped.** `primarySteps: raw` is unchanged at astra `WebGPUCloudTierPresets.ts:222` (R3 F6, R5 §2.1).
- **I-3 is briefed to own C13-N69** in `resolveCloudPreset`. Astra's hunk sits in the same function (R5 §2.1, W4).
- **`cloudPrimarySteps` is public and clamped to 1–512** (P:4372, re-derived here). That is **2× the 256 that hung the GPU**, and it is
  ignored whenever `cloudQuality ≠ 64` (R3 F6).
- **I-5's brief says "no public API"** (R5 §2.1).
- **Astra's default-path step law raises per-pixel intervals on long chords.** At 96 steps on the tangent chord, 286 intervals and a
  sentinel of 861, against 96 and 288. `primarySampleBudget` under-reports this (R5 §2.1).
- **Astra's whole-ray budget does not cover N69.** It is opt-in and forced off for raw quality (R5 §2.1).
- **Native 96/8 `DXGI_ERROR_DEVICE_HUNG` is unresolved** (CP:71). U3's part in it is a hypothesis (R1 §5.4). Whether it happens at
  base is unsettled (R3 §9.7). Astra's receipts record it in feature-off controls (RA:335, RA:377, CP:71), and `cloudPrimarySteps`
  = 384 hung a 1080p orbit (RA:299).
- **Tier 3 is native 96/8** (base `WebGPUCloudTierPresets.ts:168–172`), and `"auto"` resolves to it at or below 50 km (`:201`), so
  the hazard reaches every default "clouds on, ground" cell in the plan. E4 is therefore a hard gate before E5 (LANDING_PLAN §5).
- **N13 is the seat's own ledger row,** with one owner of `ProceduralClouds.wgsl` at a time (R5 §3.7).

### D9a — N69 ownership

**Sound options:**
- **(A) The seat's I-3 lane owns N69, and lands before Astra.**
  - Its budget covers raw `cloudQuality`, any public step dial, and the `chord / maximumStep` interval law.
  - `primarySampleBudget` counts the real intervals.
  - It runs E4, the native 96/8 A/B, **before** it edits `resolveCloudPreset`: arm (b), base + the frozen Astra patch, is built at
    `b263d8ac5e`, because I-5 and I-3 edit the hunk the patch touches and it will not apply after them. E4 also carries a
    single-deck arm (critic C5).
- **(B) Astra owns N69 inside its stack,** extending the whole-ray budget to the raw and default paths.

**Recommendation: (A).** The basis:
- I-3 is already briefed.
- The hunk has one owner.
- The measurement E4 needs a lane that owns the machine, and does not come from the author of the suspect change.

### D9b — The C13-N13 march law (U3)

**Sound options:**
- **(A) The seat's N13 owner takes U3 as input** (its long-chord spec case is a useful fixture). It lands a law whose sentinel is
  bounded by the tier budget, after I-3 and after ring Leg 2. Astra's batches keep base spacing on the default path.
- **(B) Astra's U3 lands in A3, after I-3,** reworked to the same conditions: a budget-bounded sentinel and a truthful counter.

**Recommendation: (A).** One owner of `ProceduralClouds.wgsl`. It is hang-class. And Leg 2's pre-registered arithmetic assumes the base
march (R5 §2.1).

### D9c — The public `cloudPrimarySteps` dial (U20b)

**Sound options:**
- **(A) No public sample-count dial until I-3's budget lands.** I-5's debug-only, pragma-stripped override covers ablation. Astra may
  re-propose afterwards, with a cap no higher than I-3's budget.
- **(B) Keep it public now,** but cap it at the current tier maximum (96) rather than 512, and apply it even when `cloudQuality` is set.
  This still contradicts I-5's rule, which is a lane rule rather than a ruling.

**Not offered:** a public dial capped at 512. Readers showed it exceeds the value that hung the GPU (R3 F6; R5 W1). Stronger
still, Astra's own receipt: *"The 384-sample 1080p orbital stress case FAILED with DXGI_ERROR_DEVICE_HUNG and device loss"*
(RA:299) — this dial, at three-quarters of its cap (critic C5).

**Recommendation: (A).**

**Executes.**
- **The I-3 lane** (Opus 5.5), with E4 run as hang-risk work: bounded deadlines, the lane owns the machine, and never 512 steps at 2048²
  (R5 §5.2).
- **The N13 owner** after it.
- **Astra's return** conforms to both.

---

## D10 — The record: Astra's two docs and the decomposition-log patch

**Question.** Do `ASTRA_SOLO_24H_CHECKPOINT_2026-09-25.md`, `ASTRA_RETURN_AUDIT_AND_CLOUD_PROGRESS_2026-09-21.md` and
`decomposition-doc.patch` land in `migration_doc/`?

**Facts:**
- **The checkpoint is contradicted by the final patch in three places:** 4×4 tiles, the bundle hash, and "GPU validation pending".
  Neither A/B is recorded in it (R2 §0.3–0.4).
- **Its "same-session" header is overstated for two rows** (R2 §0.6).
- **Two of its "fixes" repair Astra's own regressions** (R2 §2).
- **The ES6 hunk is malformed.** It carries 28 "Astra" mentions and 9 dangling `_lane-out/` paths, a table broken by a blank line, a
  literal `\n###`, and line counts that do not reconcile (R1 §2.9).
- **Standing constraint:** packet claims are lane claims until confirmed.
- **Precedent:** Astra's 09-14 handoff stayed untracked.

**Sound options:**
- **(A) Do not land the two docs or the decomposition patch.**
  - They stay in the archive snapshot.
  - This audit, after the critic, plus the ledger rows (D2, D6) are the tracked record.
  - The seat writes the ES6 status rows per batch from measured base → after line counts. R1 §2.7's table is the starting point.
- **(B) Land Astra's two docs as tracked history, after corrections:**
  - both A/B outcomes;
  - 8×8 tiles;
  - bundle `a4b74c3a`;
  - the header of rows 7–8;
  - the self-repair framing;
  - the native failures in the layers row;
  - removal of the `_lane-out/` links.

**Recommendation: (A).** The basis: the record defects above, the precedent, and the fact that the corrected facts already live in this
audit.

**Executes.** The seat, in its record round.

---

## D11 — The shape of the `CloudVolumetrics` API

**Question.** What shape do the new dials ship in?

**The count.** The patch adds 14 (P:7098–7244). **Nine** remain once U37's `cloudSparseUpdates` (D2), U20b's `cloudPrimarySteps`
(D9c) and the HOLD entry points `cloudLayers`, `cloudLayerShadowSteps` and `cloudLayerShadowCache` (D12(a)) are out: re-derived
from the patch's `this.cloud… =` lines (critic C15).

**Facts:**
- **The 14 new dials are plain properties with `//` comments** (R3 F10). They have:
  - no JSDoc, so they are missing from the generated docs;
  - no `Check` when set;
  - clamping at consumption only, and for only 4 of them.
- **Validation happens at the wrong time.** A non-array `cloudLayers` throws a `TypeError` in the constructor, and an invalid value
  throws a `DeveloperError` **every frame** at render time (R3 F7).
- **The ES6 rule applies.** `CloudVolumetrics.js` got 46 new lines and is still a constructor function (R1 §2.9); the ES6 rule applies
  above 10 changed lines.
- **R-2026-09-16-6 asks for** "real `CloudVolumetrics` dials with JSDoc".
- **Technical constraint, re-derived here.** `CloudCollection._resolveVolumetricConfig` returns `{ ...this.volumetric, … }` (base
  `CloudCollection.js:367–373`). An object spread copies only *own enumerable* properties. **Getters and setters on a class prototype
  would be silently dropped on the way to the renderer.**

**Sound options:**
- **(A) Convert `CloudVolumetrics` to an ES6 class, with validating prototype setters for the new dials.**
  - `Check` at set time; `cloudLayers` is validated when set, which removes the per-frame throw.
  - JSDoc with `@type` / `@default` and "WebGPU only."
  - `_resolveVolumetricConfig` changes to read the dials explicitly, not by spread, with a spec pinning that every documented dial
    reaches the resolved config.
  - Every existing JSDoc is preserved, and every existing test must pass (the ES6 rule).
- **(B) Keep plain fields and add JSDoc plus "WebGPU only.",** validate `cloudLayers` in the constructor, and waive the ES6 rule for this
  file explicitly. A `cloudLayers` value assigned after construction can still throw every frame. (Under D12(a) `cloudLayers` is
  not public, so this residual applies only under D12(c).)
- **(C) Convert to an ES6 class, and define each validated dial as an own enumerable accessor on the instance** (added after
  critique, C15).
  - In the constructor, `Object.defineProperty(this, "cloudX", { enumerable: true, get, set })`, with `Check` in the setter.
  - An object spread invokes own enumerable getters and copies the values, so `{ ...this.volumetric }` at `CloudCollection.js:367–373`
    keeps working **without touching the forwarding**.
  - House precedent: `AtmosphericConditions.js` builds its leaves the same way, `Object.defineProperties(leaf, { …: { enumerable:
    true, get, set } })` (base `:1036–1045` and eight other leaves).
  - A spec pins that every documented dial reaches `_resolveVolumetricConfig()`; its mutant makes one accessor non-enumerable and
    must go red.
  - Cost: instance accessors need explicit JSDoc tags to appear in the generated docs; the reviewer confirms with a docs build.

**Recommendation: (C).** The basis: R3 F7 and F10, R1 §2.9, R-2026-09-16-6, and the spread constraint. (C) meets all of them and
leaves the one forwarding path every existing dial already takes untouched. (A) must rewrite that path to read every dial
explicitly, and a missed dial there is silent; (C)'s failure mode, a non-enumerable accessor, is exactly what its spec's mutant
exercises.

**Executes.**
- **Astra**, in the batch that carries each dial (class conversion in A1; dials with their features).
- **The seat's reviewer** runs the forwarding spec's inertness mutant: one accessor made non-enumerable (under C) or one dial dropped
  from the forwarding (under A), and requires red.

---

## D12 — The HOLD chain's plumbing (U23, U26, U29, U30)

_Added after critique (C1). The first draft said the four HOLD units are "out in every option" but gave no decision or fix item that
takes them out, and their code is not separable by file._

**Question.** The HOLD units stay out as features (D1). What happens to their code, which runs on the default path of units that are
kept?

**Facts** (re-derived in Astra's clone and the patch):
- **Layer-profile plumbing (U26) is on the default density and lighting path.**
  - `struct CloudLayerProfile` and `cloudProfileForDeck` are at astra `CloudLightSampling.wgsl:629–658`. At defaults the function
    returns the global genus values, because `multiDeckEnabled() && cloud.layerProfilesEnabled > 0.5` is false.
  - Its callers are on the default path: astra `ProceduralClouds.wgsl:1320, 1412, 1511, 2195`; `CloudLightSampling.wgsl:70, 210,
    258`.
  - Default-path functions now take a profile: `genusFibreFactor` (`PC:861`), `decodeWeatherChannels` (`PC:1285`),
    `genusForwardG`, `cloudPhase`, `cloudSilverLining`, `effectiveAbsorption`, `beerPowder` (`CLS:463–506`), and
    `multiScatterLight(…, profile, peerTransport)` (`CLS:524`), which the default march calls (`PC:2492–2493`).
  - The uniform struct carries three `CloudLayerProfile` members (astra `PC:320–322`); that type is what crashes
    `cloud-tier-single-source` (R4 red #1).
- **Peer transport (U23, U29, U30) sits inside a retained unit's files.** 28 peer lines in `CloudLightingCache.wgsl` (U25's shader,
  A2b), 12 in `CloudLightSampling.wgsl`, 8 in `ProceduralClouds.wgsl`; the default march passes `peerTransport = (1, 0)` unless the
  peer gate is on (`PC:2472–2497`); `peerEnabled` runs through U25's `WebGPUCloudLightingCache.ts`.
- **Uniform slots.** The append-only chain (P:9974–10003): 220 (`CLOUD_SLOT_LAYER_SHADOWS`, U23) → 224 (lighting cache, U25) → 228–255
  (`CLOUD_SLOT_LAYER_PROFILES`, U26) → 256–259 (`CLOUD_SLOT_PEER_LIGHTING_CACHE`, U29) → 260.
- **Public entry points.** `cloudLayers`, `cloudLayerShadowSteps`, `cloudLayerShadowCache` (P:7098–7244).
- **The hangs are not attributed to these units** (D1; RA:335, RA:377, CP:71).
- **R-2026-09-16-6:** every RETURN/WIP feature ships default-off. **Principle 7:** scaffolding for work the author has not abandoned
  stays; Astra keeps layered clouds as live work: RA:377 names "natural formations/independent layer coverage" as the next priority after native cost.
- **Legacy-density hashes:** the profile threading is one of the three body edits in the re-freeze (P:1254–1272; D4b b2).

**Sound options:**
- **(a) Keep the plumbing as STRUCT; remove what makes the features reachable.**
  - Keep: `CloudLayerProfile`, `cloudProfileForDeck`, the profile parameters, `peerTransport`, the peer code in U25's module and
    shader, and slots 220–223 and 228–259 as **named reserved pads** in the layout module (the uniform size stays 260 floats).
  - Remove: the three public dials, their `.d.ts` fields, and every writer that fills slots 220–223 and 228–259 with anything but
    zero, so `layerProfilesEnabled`, the layer-shadow gate and `peerEnabled` are 0 on every frame.
  - Prove: the A1 byte-identity leg (clouds on, default, ground/flight/orbit, with a repeat control); a value oracle that executes
    `cloudProfileForDeck` at defaults and returns the global profile; F-3's `cloud-tier-single-source` models `CloudLayerProfile`.
  - `cloud-layer-profiles.spec.mjs` is not homed until U26 returns.
- **(b) Full strip, plumbing included.**
  - Re-signs about ten default-path functions in two WGSL files, re-pins the spec regexes that now read `profile.*` (for example
    `cloud-march-transfer`'s `genusErosionDepthScale(profile.fibreStrength)`, R4 red #11; the critic counts six such pins in
    `genus-morphology`, which I did not re-count), and re-touches the density and lighting path that A1 claims is byte-neutral. The slot chain still has to keep
    220 / 228–259 reserved (append-only), and U25's shader loses its peer lines.
  - It discards scaffolding for work the author has not abandoned (Principle 7).
- **(c) Ship the features as default-off public dials under R-2026-09-16-6.**
  - Sound only **after E4 attributes the hang** (D9a), and only with R-16-6's JSDoc, set-time validation (D11), and a spec that
    kills the call-site mutant M3 (R4 §2).
  - Until then it ships a public path into the configuration Astra's own runs could not complete natively.

**Recommendation: (a).** The basis:
- It removes every way to reach the unvalidated features, which is what "out as features" requires.
- It leaves the default-path code exactly as the A1 identity leg will capture it, so the leg proves one tree, not a re-signed one.
- It keeps the append-only slot rule without a gap in the chain.
- It follows Principle 7 and Astra's live goal. (b) spends a re-signature of the default path to delete code that will come back.
- **Principle 9:** a `DEFERRED_WORK` row names the HOLD chain, with native 96/8 stability (E4) as its prerequisite, and D12(c) as the
  route back.

**Executes.**
- **Astra**, as fix-list item F-18: profile threading in A1; U25's dormant peer code in A2b.
- **The seat's reviewer** verifies:
  - `git grep -nE 'cloudLayers\b|cloudLayerShadowSteps|cloudLayerShadowCache' -- packages/engine/Source` returns 0;
  - no writer puts a non-zero value in slots 220–223 or 228–259 (grep the renderer and the uniform modules for the slot constants);
  - an inertness mutant that writes 1 into `layerProfilesEnabled` changes the default oracle, and must be caught.
- **The seat** lands the `DEFERRED_WORK` row with A1.

---

## Seat acts that need no ruling

These can go today. They are Node-only, and none touches an engine file.

- **Bank the audit.** R1–R5, the brief and these three files go to `cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/`, with md5s, as a
  two-phase copy. **[Done 2026-09-26, at that path.]**
- **Freeze the TaskProcessor unit.** Packet md5 `c4016b889ec06d782c36a50f8888e449`; index-stripped md5 `c3cb96b14feb04590a22e8c61e76dd52`
  (equal to the clone's diff); `git apply --check` passes at `b263d8ac5e` (re-derived).
- **Re-check the two remaining frozen patches** (`angrim`, `pimpernel-ledger`) with `git apply --check` at `b263d8ac5e`; Batch 1537
  landed the census patch after R5 measured them.
- **Give `fog-cheap-coverage-gate.spec.mjs` a runner home** in a local runner, after measuring it green at the tip. This guards `main`
  against the P0 class before any cloud landing (R3 F1). **[Done 2026-09-26: Batch 1538, 15/15 at `b263d8ac5e`.]**
- **Give `perf-manager-teardown.spec.mjs` a runner home** the same way (R1 §2.11, R5 §1c). **[Done 2026-09-26: Batch 1538, 7/7 at `b263d8ac5e`.]**
- **Close out R4's audit clone `cesium-lane-hasufel-20260926`** once the critic is finished, using the link-aware junction procedure.
