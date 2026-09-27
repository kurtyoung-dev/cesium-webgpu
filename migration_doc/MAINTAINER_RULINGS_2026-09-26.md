# Maintainer rulings — 2026-09-26

Taken 2026-09-26 (a **Saturday**; no quiet hours apply), in **one sentence covering twenty-two
decisions**, in reply to the seat's brief of the same night. The seat's source sheet recording the
sentence and the id mapping is stamped `Sat Sep 26 02:33:08 EDT 2026`, taken **before any dispatch**
under these rulings. The decisions answered are the twelve of the read-only audit of Astra's
2026-09-21 → 2026-09-25 cloud work (`D1` … `D12`) and the ten of the audit of Gemini's 2026-09-20
comment-and-documentation plan (`G1` … `G10`). Both audits and both decision sets land as tracked
documents with this file:

| Tracked document | What it is |
|---|---|
| [`ASTRA_WORK_AUDIT_2026-09-25.md`](ASTRA_WORK_AUDIT_2026-09-25.md) | the audit of Astra's stack: 37 units, 81 files, per-unit verdicts, the evidence ids R1–R5, U1–U37, Y1–Y17 |
| [`ASTRA_AUDIT_DECISIONS_2026-09-26.md`](ASTRA_AUDIT_DECISIONS_2026-09-26.md) | D1–D12 with every sound option, the options shown unsafe, a recommendation and what executes it |
| [`ASTRA_LANDING_PLAN_2026-09-26.md`](ASTRA_LANDING_PLAN_2026-09-26.md) | the landing plan the D recommendations imply: phases P0–P2, batches T1 and A1–A3, the fix list F-1…F-19, the Edge queue E1–E10 |
| [`GEMINI_PLAN_AUDIT_2026-09-26.md`](GEMINI_PLAN_AUDIT_2026-09-26.md) | the audit of Gemini's plan: the inventory reproduced, the rule conflicts, the 13-batch C16 tail |
| [`GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md`](GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md) | G1–G10 with their options and recommendations |

**The documents are the argument, not the authority: this file is.** Where this file and a decisions
document disagree on what was ruled, this file wins; where they disagree on a fact, the decisions
document's evidence governs and this file is corrected.

## The sitting

**The maintainer's words, verbatim:**

> *"Go with all the recommended rulings, doc these and the other good options so we have a paper
> trail of the potential options if we need to fall back"*

**What the sentence rules.** Every one of the twenty-two is the decisions document's own
recommendation, adopted as written. Each entry below **quotes** the recommended option from the
decisions document rather than paraphrasing it; where a quotation is abridged, the ellipsis points at
the tracked decisions document's section, which carries the full text.

**What the sentence also asks for, and how this file answers it.** *"doc these and the other good
options"* is read, per the seat's mapping, as: every option a decisions document lists as **sound**
and not recommended is recorded here as a **fallback**, with the cost or condition the document states
for it, so that a later reversal starts from a written position rather than a reconstruction. The
options the audits' readers or critics showed to be **unsafe** are recorded separately under **Not
offered**, with the reason, so that nobody re-proposes them. Neither list is a ruling: a fallback is
taken only by a later ruling that says so.

**Id mapping** (the seat's, deterministic):

| Ruling ids | Decisions | Source |
|---|---|---|
| `R-2026-09-26-1` … `-12` | Astra audit `D1` … `D12`, one-for-one | `ASTRA_AUDIT_DECISIONS_2026-09-26.md` |
| `R-2026-09-26-4` | `D4` is **one** ruling with sub-rows `a1`–`a7` and `b1`–`b6`, each ruled as its row recommends | `ASTRA_AUDIT_DECISIONS_2026-09-26.md` D4a, D4b |
| `R-2026-09-26-9` | `D9` is one ruling with three parts, `D9a`, `D9b` and `D9c` | `ASTRA_AUDIT_DECISIONS_2026-09-26.md` D9 |
| `R-2026-09-26-13` … `-22` | Gemini plan audit `G1` … `G10`, one-for-one; `G9` is the re-framed option A, `G10` is option A′ | `GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md` |
| `R-2026-09-26-23` | not part of the sitting: a maintainer direction given at 19:40 EDT — visual evidence of progress per lane, then the probe-kit harvest *(row added by record round 9)* | this file, last section |

**How the options were tested before they reached the maintainer.** Each audit ran read-only readers,
one synthesiser and one adversarial critic, all Opus 5.5 with explicit effort. The Astra audit: readers
Thorondor, Shadowfax, Snowmane, Hasufel and Windfola (R1–R5), synthesis Asfaloth, critic **Felarof —
17 MUST-FIX findings, all accepted and fixed, none rebutted**. The Gemini audit: readers Rochallor,
Stybba and Gamgee (G1–G3), synthesis Adamanta, critic **Donnamira — 10 MUST-FIX findings, all
accepted, none rebutted**. The critic passes are why several options below are marked "added after
critique" and why others appear under Not offered.

**What these rulings settle, and what they do not.** They settle what is to be done, by whom and in
what order. They perform nothing: every "Executed" line below says **pending** unless the act was
already done before the sitting, and says which. **One item stays owed by the maintainer in person**:
the first-bake threshold that decides between `D4` `a3`(i) and `a3`(ii) (`R-2026-09-26-4`).

**Provenance.** The maintainer's sentence and the mapping come from the seat's source sheet
`rulings-source-2026-09-26.md`; the brief the maintainer answered is `MAINTAINER_BRIEF_2026-09-26.md`.
Both are untracked seat working files, banked verbatim at
`cesium-webgpu-worker-archive/lanes-2026-09-26/rulings-source/`. The audits'
reader reports, critiques and briefs are banked verbatim, with `MANIFEST.md5` files, at
`cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/` and
`cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/audit/`; Gemini's plan, inventory and
scripts at `cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/gemini-deliverable/`; and
Astra's frozen snapshot at `cesium-webgpu-worker-archive/astra-checkpoint-20260925/`.

Recorded 2026-09-26 by the record lane RR-1 (Laura, Opus 5.5).

---

# Part 1 — Astra's cloud work, 2026-09-21 → 2026-09-25 (`D1` … `D12`)

Evidence ids follow the audit: `R1`–`R5` the reader reports, `U1`–`U37` the units, `Y1`–`Y17` the
cross-cutting findings, `C1`–`C7` the common batch set, `P:<n>` a line of the frozen patch
(`cloud-all-current.patch`, md5 `a23f4d79badcf956dd23bdf878bbf3f5`), `RA:`/`CP:` a line of Astra's
two docs in the snapshot. "The landing plan" is `ASTRA_LANDING_PLAN_2026-09-26.md`.

## R-2026-09-26-1 — Landing direction (D1): OPTION A — return, rebase after the seat's Phase-1 lanes, re-cut into class batches

**Ruled** (`ASTRA_AUDIT_DECISIONS_2026-09-26.md` D1, option (A), quoted):

> **(A) Return, rebase, re-cut.** Astra strips U37, clears the fix list (LANDING_PLAN §2) and rebases
> **after** the seat's Phase-1 lanes. Then it re-cuts the stack into class batches:
> A1 — byte-neutral structure, plus the P0 fix; A2a — default work in the LUT bake plus the atmosphere
> opt-ins (it carries D4a a3–a5, a7, so it gets the verifier); A2b / A2c — inert opt-in features;
> A3 — the ruled default-path changes. Each batch carries: the common set C1–C7; an Opus 5.5 reviewer;
> an Opus 5.5 adversarial verifier on every batch that moves default work or the default image — A1,
> A2a, A3 — and on T1 (R-2026-09-11-1); one named two-tree Edge leg.

**Basis** (the decisions document's, evidence ids kept): the stack is not landable as it stands — the
P0 fog break (Y1; R3 F1), 13 + 6 runner reds with one crash that silences L3's protected acceptance
(Y2; R4 H1, H2, H5), the formatter rewriting 44 files and adding 7 reds (Y6; R4 §4), 4 of 5 new specs
inert-survivable (Y5; R4 H4), the failed sparse candidate still present (Y4), unruled default moves
(Y3). (1) It costs least and keeps one owner per file for the three files the seat's queue already owns
(R5 §3). (2) Only the author can re-cut: hunk attribution inside the renderer, `ProceduralClouds.wgsl`
and `CloudLightSampling.wgsl` is file-level only (R1 §1, §5.9). (3) Class batches let each Edge leg
show one kind of change — identity, opt-in delta or ruled default delta. (4) It follows
`R-2026-09-16-1`, which worked: L3, L4 and L5 all landed and Astra's base is their descendant. The four
HOLD units (U23, U26, U29, U30) stay out as features under every option, on the author's own hold and
its visual-validation FAILs (RA:335, RA:377) — **not** a unit-caused hang, which Astra's receipts
place in feature-off controls (RA:335, RA:377, CP:71; critic C5).

**Fallbacks recorded** (each a sound option the decisions document offers, with its stated cost):

- **(B) As (A), but Astra lands first.** Astra's batches land before I-3, I-5, N60, N61 and N13, which
  are re-briefed onto Astra's tree (R5 §3.6–3.7). Costs: the ring Leg-1 frames stop being a baseline,
  so M0 must be re-banked before Leg 2 and before I-5's leg; the §4.6 hang arithmetic of Leg 2 must be
  rewritten with Astra's interval law; N60's pad rename must be re-authored; the N69 budget must be
  written against Astra's march.
- **(C) One all-at-once batch,** after the complete fix list: one reviewer and one Edge session.
  Costs: 37 units ride one leg, so a regression cannot be attributed to a unit; default-moving and
  inert changes ride together; the lane-ordering question of (A) and (B) remains.
- **(D) Reject the stack and keep it archived as reference.** Costs nothing now; discards
  receipt-backed work — irradiance reuse, specialisation, Worley pruning, lighting-cache reuse,
  empty-weather skipping (R2 §2–§3).

**Not offered** (shown unsafe): **landing the patch as-is** — Y1, Y2 and Y6; **the seat cherry-picking
hunks out of the cumulative patch** — the units interleave inside the three largest files (R1 §1).

**Executes.** The seat writes the return brief (`R-2026-09-26-8`) from the landing plan §2 and freezes
each batch as Astra delivers it; seat Opus 5.5 lanes review, verify and run the inertness mutants; the
Edge executor runs E5–E10 (landing plan §5).

Executed: **pending** — the return brief is the first act; Astra's batches wait for the seat's Phase-1
lanes (landing plan §1, P1.1–P1.6).

Authority: charter §1.1.

## R-2026-09-26-2 — The failed sparse candidate U37 (D2): OPTION A — strip it, with a withdrawal record

**Ruled** (D2, option (A), quoted):

> **(A) Strip it, and write a withdrawal record.** Remove the four new files,
> `WebGPUCloudSparseHistory.ts`, `WebGPUCloudSparseUpdates.ts`, `CloudSparseUpdates.wgsl` and
> `cloud-sparse-updates.spec.mjs`, and every sparse hunk, including: the `ShaderDefineHi` bit-7 entry;
> the renderer's sparse wiring and its per-frame inputs; the `cloudSparseHistory` consumer in
> `ProceduralClouds.wgsl`; `CloudVolumetrics.cloudSparseUpdates`; the `cesium-cloud-types.d.ts` field;
> the runner entry; the `sparseRequested` term in the emit gate and in its spec regexes. Write a
> withdrawal record in the shape of the 09-16 `LIGHT_REUSE_WITHDRAWAL.json`, naming both runtime
> folders and the archive manifest.

**Basis:** both A/Bs FAILED Astra's preregistered gates — `runtime-02`, on the final bundle
`a4b74c3a…`, 12.4 % / 12.6 % reduction against ≥ 20 % and p99 byte error 28 / 25 against ≤ 20 (R2 §1;
`result.json` `"status": "FAIL"`), and `runtime-01` on the 4×4 revision. It is the author's own rule
(CP:83: *"If it fails, preserve the evidence, remove only its authored implementation changes, and keep
the append-only shader bit reserved."*). Its spec survives the call-site mutant `enabled: false && …`,
10/10 (R4 M1); even when off it builds a ~200 KB source concatenation every offscreen frame (R3 F7);
8,294,656 B stays resident after disable (R3 F9). The 09-16 precedent removed withdrawn units with a
withdrawal record. Stripping is needed before any re-measurement anyway: no retained number was
measured on the final tree (R2 §5). The evidence is already preserved in
`cesium-webgpu-worker-archive/astra-checkpoint-20260925/` (`MANIFEST.md5`).

**Fallbacks recorded:**

- **(B) Keep it default-off as WIP under `R-2026-09-16-6`,** only after all four of: its spec kills M1;
  the off-path source concatenation is removed; the history is released on disable; both A/Bs are
  recorded in its packet. Stated cost: *"Even then, (B) lands code that failed both of its preregistered
  A/Bs."*

**Not offered:** the decisions document lists no unsafe option. Keeping U37 **without** (B)'s four
preconditions is not an option at all.

**Executes.** Astra strips it as item 1 of the return (fix list F-1). The seat's reviewer verifies:
`git grep -nE 'cloudSparse|CLOUD_SPARSE|CloudSparse|sparseRequested'` returns 0 over engine and Tools;
the stripped cumulative patch passes `git apply --check`; `cloud-march-emission` A2 and E4 are
re-pinned and green. The seat lands the `DEFERRED_WORK` row with the re-attempt conditions taken from
CP:67's gates.

Executed: **pending** — first item of Astra's return.

Authority: charter §1.1.

## R-2026-09-26-3 — `ShaderDefineHi` bit 7 (D3): OPTION A — reserve it in writing in the registry, plus a ledger row

**Ruled** (D3, option (A), quoted):

> **(A) A registry comment line plus a `DEFERRED_WORK` row.** No entry and no consumer. The line is
> something like `// hiDefineBit(7) reserved: sparse cloud updates, withdrawn 2026-09-25 — see
> DEFERRED_WORK …`, landed beside bit 6 when U34 lands. The next claimant takes bit 8.

And, from the same decision (quoted): *"Bit 6 and `qualityFlags` bit 14 stay reserved for Astra until A2c
lands (R5 §3.8). If a seat lane must claim a hi bit before then, Astra renumbers. Renumbering is
allowed while unlanded."*

**Basis:** the registry is where the next claimant will look — CLAUDE.md's "Adding a new define bit"
step 1 sends every lane there to check capacity; a ledger-only row is not seen there. The cost is one
comment line and one of 24 free bits. It honours Astra's stated intent (CP:61) and keeps the archived
evidence (`runtime-02/engine-sparse.wgsl`, `cloud-sparse-ab-only.patch`) replayable. Bit 7 never landed
on `main`, and the pipeline cache folds shader-module identity, so aliasing is impossible structurally
whatever is decided.

**Fallbacks recorded:**

- **(B) A `DEFERRED_WORK` row only.** Cost: the reservation is invisible at the registry, where the
  capacity check happens.
- **(C) Free bit 7.** Cost: a revived sparse attempt renumbers its archived patches.
- **(D) Land `CLOUD_SPARSE_UPDATE: hiDefineBit(7)` as a real entry with no consumer.** Cost, as stated:
  *"The add-only rule then keeps an entry nothing reads, forever"* — a dead entry that Principle 7 would
  then protect.

**Not offered:** none listed.

**Executes.** The seat, in the batch that lands U34 (A2c): the registry comment line, plus the
`DEFERRED_WORK` row from `R-2026-09-26-2`.

Executed: **pending** — rides A2c.

Authority: charter §1.1.

## R-2026-09-26-4 — Default-path byte changes (D4): every row ruled as recommended

One ruling, thirteen rows. **MOVES-G** is the population that never enables clouds; **MOVES-C** is the
population that enables volumetric clouds and sets nothing else. The standing constraint
"defaults unchanged unless ruled" is why every row needed a ruling; **this is that ruling** for each row
below.

### D4a — MOVES-G (never enabled clouds)

| Row | Ruled (the row's recommendation, quoted) | Fallback recorded (the row's other sound option) | What proves it (quoted from the row) |
|---|---|---|---|
| **a1** U19, WebGPU sky linear output when `highDynamicRange` is on and the canvas is SDR | **(i)** *"Accept it as a parity fix. It removes a double tone map and matches GLSL `#ifndef HDR`."* | (ii) *"Gate it behind a sky option that defaults off. That keeps the double tone map for users on HDR displays."* | An Edge leg on the full WebGPU frame: HDR off byte-identical to base over the **full** frame; HDR on shows the intended change; on an HDR-capable display and an SDR one; a slot-55 matrix spec {HDR off, HDR on + SDR canvas, HDR on + HDR canvas} → {0, 1, 0} (R3 §3); the baseline refresh is its own reviewed commit |
| **a2** U19, WebGL sky alpha clamped to [0, 1] | **(i)** *"Accept it. With `ALPHA_BLEND`, an alpha above 1 amplified the source and gave the destination a negative weight."* | (ii) *"Drop the GLSL clamp and keep only the WGSL one. The two backends' alpha then diverges."* | A WebGL HDR leg at ground level and at 30 km (R3 §8) |
| **a3** U9, rewritten irradiance kernel (first bake ≈ 24× more work: 25,165,824 segment evaluations against 1,048,576; no default consumer reads it) | **(i), switching to (ii) if the timing shows a visible startup cost.** *"(i) Accept it, conditional on a first-bake GPU timing."* | (ii) *"Bake the irradiance LUT only when a consumer exists: the cloud `sky-lut` ambient path, or the probes."* — **this fallback is pre-armed**: the ruling itself switches to it on the timing | A `CesiumDebug.gpuPassCost` timestamp on the `computeIrradiance` pass, base against patch (E6). **The threshold is OWED BY THE MAINTAINER** (*"The maintainer sets that threshold."*) |
| **a4** U16, an 8,192-byte scattering-field texture on every WebGPU scene with LUTs | **Accept** — *"It is negligible, and the bake is gated on `multipleScattering`."* | — (single option) | — |
| **a5** U10, a failed LUT dispatch leaves `lutReady` false and retries | **Accept, bounded** — *"Accept it **only with a bounded retry**: N attempts, then latch and log once."* | — (single option) | A spec in which a dispatch reports false: `lutReady` stays false, retries are bounded, and it is never silently marked ready (R3 §8) |
| **a6** U19, `atmosphereLightIntensity ?? 50` replaces `\|\| 50` (explicit 0 now gives a black sky, as WebGL does). **Not MOVES-G** (critic C13); rides with a1 in A3 | **Accept** — *"It is a parity fix for an explicitly set value."* | — (single option) | Its own assertion: an explicit 0 packs 0 and an unset value packs 50 (F-10) |
| **a7** U16, `SkyAtmosphere.multipleScattering = true` now means a physical 32-step field instead of the `MS_SCALE 0.06` term | **(i)** *"Accept it as the option's new meaning."* | (ii) *"Keep the old term for `true`, and put the physical field behind a new value."* | An Edge leg with the option on and off, plus a per-fragment timing |

### D4b — MOVES-C (clouds enabled, no new options)

| Row | Ruled (quoted) | Fallback recorded (quoted, with its stated cost) | What proves it (quoted) |
|---|---|---|---|
| **b1** U8, linear-space composite with a display-gamma 2.2 decode/re-encode on SDR non-sRGB canvases | **(i)** *"Accept it as the new default composite"*, **once the alpha difference is aligned or explained** (native-temporal returns alpha 1.0 where half-res returns `sceneColor.a`) | (ii) *"Gate it behind a dial that defaults off."* | A before/after Edge leg at defaults, on an SDR and an HDR canvas; re-check the premises of `lib/cloud-photometry.mjs`, because the transfer is now linear (X10; R1 §5.7) |
| **b2** U11, the billow envelope on the default CUMULUS / BILLOWY profile and the procedural sky cubemap | **(ii)** *"Put it behind a dial that defaults off, **in A2c**."* … *"So (ii) re-freezes them **once**, with the three-part reason (U11 gated, U20a identity branch, D12 profile threading) and the identity clause restated, and proves default identity **by execution**, not by text (critic C4)."* (full text: D4b row b2) | (i) *"Accept it as the new default look (A3), and record the hash re-freeze as ruled. The ring M0 is re-banked after it."* | A value oracle executing `legacyCloudDensity`, `legacyCloudBaseDensity` and the macro density at defaults against base's values, whose mutant forces the billow on and must go red; the A2c leg shows the dial off byte-identical to T0 at ground, flight and orbit and in the IBL cube with `cloudContributesIBL` |
| **b3** U32b, the IGN scroll becomes linear `5.588238 * frameIndex` on every jittered tier | **(i)** *"Revert to base's golden-ratio phase on the default path until a stripe gate passes."* | (ii) *"Accept it on R4's 64-frame discrepancy test, despite the failed stripe gate."* | — |
| **b4** U3, the march law (clamped fine step, chord-growing sentinel, comb from 0) | *"→ **D9b** decides who owns the march law. Whoever owns it, Astra's batches do not change the default march."* Ruled by `R-2026-09-26-9` (D9b) | see `R-2026-09-26-9` | — |
| **b5** U1 / U2 / U4 / U15, the physical aerial path — **reaches the default at camera heights ≥ 100 km**, settled from source (critic C3) | **(i), falling back to (ii) if E9's orbital cell shows an unintended change.** *"(i) Accept it as the new default orbital aerial. It lands in A3 **after P1.3** (ring Leg 2 on a pre-Astra tree), with an orbital before/after cell in E9, and the ring M0 is re-banked after it."* | (ii) *"Keep base's physical aerial code as the default for unset / `"auto"` / `"physical"`, and put U4's transport and U15's tone behind a new dial that defaults off (A2b). This keeps two physical-aerial implementations in the shader."* — **pre-armed** by the ruling on E9's orbital cell | A Node spec pinning the reach (`resolveTier` and `shouldDefaultPhysicalAerial` at 100 km and 6,608 km with `cloudAerialMode` unset and `"auto"`); E9, an orbital default cell before/after, clouds on, at the ring rig's pose |
| **b6** STRUCT claims (U22, U24, U27, U28, U36's weather ownership, the HOLD plumbing kept under D12(a)) and A2c default-path code (U18's gate, U20a's identity branch, U21's disabled branch, U36's skip) | *"No ruling is needed. The byte-identity legs decide, each with a same-build repeat control (R-2026-09-16-7). A unit whose output is not identical returns."* | — | E5, E7, E8 (landing plan §5) |

**Basis** (the decisions document's, quoted in substance with its ids). **a1**: HDR is on by default on
HDR displays under the `'scene'` policy (base `Scene.js:1514`, `:1523`; `HdrDisplayCapability.ts:379–424`;
critic premise 8), and the change removes a double tone map to match GLSL. **a5**: CLAUDE.md makes retry
exhaustion a permanent `console.error`; `dispatchCompute` returns false only with no `computeEngine` or
no source (P:4579–4649), so an unbounded retry is a per-frame CPU early return, and bounding it is still
right. **b2**: Astra's own assessment is *"less coverage and lower tops"* (RA:167); the 09-16 BILLOW
unit was returned for exactly this kind of default flip; the ring family lives on this density field
(R5 §2.2). **b3**: Astra's own predeclared gate failed, +1.82 % and −1.84 % against a required 25 %
(RA:445); Principle 8: *"A 'fix' that doesn't move the diff is not a fix."* **b5**: base already makes
the physical path the default above 100 km by design (base renderer `:3805–3808`); U4 clips the
integral to `[max(hit.x,0), min(hit.y, cloudDistance)]`, which is what that path is meant to compute
(R2 §4); (ii) doubles the physical-aerial code for no user-visible choice. **No orbital receipt exists
on the final tree** (R2 §5), so (i) rests on E9.

**Not offered** (shown unsafe): **a5 without a bound** — readers showed it can loop every frame (R3
F4c). **b2(ii) as first written** — its proof "the legacy hashes return to base" is impossible, because
the hashes are sha256 of the stripped **source text** of `legacyCloudDensity` /
`legacyCloudBaseDensity` (base `cloud-density-domain.spec.mjs:79–87`, `:700–716`) and U20a and D12
edit those bodies (critic C4); the ruled (ii) is the corrected form above. **b5 "Measure" (whether
U4/U15 reach the default)** — superseded, because the source settles it (critic C3).

**Executes.** Astra implements the gates and reverts as ruled, in the return. The seat lands each
accepted MOVES change in A3; each carries its own Edge leg, and its baseline refresh is its own
reviewed commit (`R-2026-08-29-2`).

Executed: **pending** — a1, a2 and a6 ride A3, a3–a5 and a7 ride A2a, b1 and b5 ride A3, b2 rides A2c, b3 is a revert in the
return. **Owed by the maintainer:** the a3 threshold, before E6's timing is read.

Authority: charter §1.1.

## R-2026-09-26-5 — The TaskProcessor Core fix (D5): OPTION D — its own batch T1 after W2-L11, with the WASM-init race guarded in the same batch

**Ruled** (D5, option (D), quoted):

> **(D) As (A), and guard the WASM-init race in the same T1 batch** (added after critique, C14). A seat
> Opus 5.5 lane adds a settled check before the init path's `postMessage`, plus a spec case in the same
> error-path spec that fires `error` before the config resolves and asserts no post and no detached
> `wasmBinary`. Its inertness mutant makes the new check unreachable and must go red. Same file, same
> proof bar, the same karma leg E2. The reviewer is a different lane from the one that writes the guard.
> The frozen packet stays Astra's bytes; the WASM guard is a second, seat-authored hunk in the same
> batch, frozen with it.

where (A) is quoted as: *"Its own Core batch, T1, after W2-L11 lands. Freeze it from the seat packet,
with an md5 and `git apply --check` at the tip. An independent Opus 5.5 reviewer. **Run** the inertness
mutant `if (false && taskListeners.isSettled())`. An adversarial verifier, because the file is on every
backend's path. A karma Edge leg over the Core/TaskProcessor specs. …"*

**Basis:** a two-file, 59-line change independent of the cloud stack, with sound evidence — the race is
real and the guard cannot drop a legitimate continuation (R3 §7), the spec discriminates at base, 10/2 →
12/0 (R2 §4), and it has a runner home (`test-visual-regression-node`, R3 §7). The W2-L11 ordering is
known (R5 §1a.3). The WASM-init path has the same race and no guard (base `TaskProcessor.js:273–320`);
landing both in one batch pays for one Core proof bar and one karma leg instead of two. The freeze
identity: packet md5 `c4016b889ec06d782c36a50f8888e449`; with `index` lines dropped it equals the
clone's `git diff`, both `c3cb96b14feb04590a22e8c61e76dd52`; `git apply --check` passes at
`b263d8ac5e` (critic C14, re-derived).

**Fallbacks recorded:**

- **(A) T1 without the WASM-init guard** — and file a `DEFERRED_WORK` row for the unguarded race. **This
  fallback is pre-armed by the decisions document:** *"Fall back to (A) if the WASM-init case cannot get
  a discriminating spec in the same batch; then file the `DEFERRED_WORK` row."*
- **(B) Hold it, and land it inside Astra's A1.** Cost: couples a Core fix on every backend's path to a
  cloud batch, and delays a real fix.
- **(C) Do not land it.** Cost: the race wastes worker work and detaches the input of an
  already-rejected task; R3 rates the risk "very low"; the option leaves a real race open.

**Not offered:** none listed.

**Executes.** The seat freezes Astra's packet (Phase 0 item P0.2 — **done before the sitting**, see
"Seat acts" below). A seat Opus 5.5 lane writes the WASM-init guard and its spec case; a different lane
reviews; the adversarial verifier refutes. The Edge executor runs the karma leg E2 after W2-L11 lands.

Executed: **pending** — the freeze is done; T1 waits for W2-L11.

Authority: charter §1.1.

## R-2026-09-26-6 — WebGL twin gaps (D6): OPTION B — record the gap, plus a §D FUTURE row for a WebGL volumetric-cloud path

**Ruled** (D6, option (B), quoted): *"(A), plus a `FEATURE_INVENTORY` §D FUTURE row for a WebGL
volumetric-cloud path, so the gap has a named home (Principle 9)."* — where (A) is *"`DEFERRED_WORK` and
`FEATURE_INVENTORY` §C rows naming the WGSL-only cloud units. A note that the U19 alpha clamp is a real
twin. "WebGPU only." in every new dial's JSDoc."*

**Basis:** `R-2026-09-12-8` (a gap is recorded, not a reason to reject) plus Principle 9's "surface
missing functionality as next work"; the cost is one row. The only GLSL change is the U19 alpha clamp
(R1 §2.4); the cloud units have no WebGL counterpart and no WebGL volumetric-cloud path exists (R1 §2.4;
09-16 X5); `SkyAtmosphere.multipleScattering` is already documented WebGPU-only at base, so U16 opens no
new gap; only 5 of the 14 new dials say "WebGPU" (R1 §2.4).

**Fallbacks recorded:**

- **(A) Record the gap without the §D FUTURE row.** Cost: the missing WebGL path has no named home.
- **(C) Require a WebGL implementation before landing.** Cost, as stated: *"This overturns
  R-2026-09-12-8. With no WebGL volumetric path to twin into, it is a project, not a port (09-16 X5)."*
  Taking it needs a ruling that reverses `R-2026-09-12-8`.

**Not offered:** none listed.

**Executes.** Astra returns the row text and the dial JSDoc in each batch packet; the seat lands the
ledger rows (seat-owned files). The landing plan §4 places the §D row with A1. `FEATURE_INVENTORY.md`
§C.7 already carries the WebGL volumetric-cloud path itself (funded as `C13-N15c`/`C13-N52` under
`R-2026-09-12-8`), so the §D clause is discharged by a §D row for the per-unit WebGL twins beyond that
path.

Executed: **pending** — rows land per batch; the companion record lane may pre-file them.

Authority: charter §1.1.

## R-2026-09-26-7 — `eslint.seatbelt.tsv` (D7): standing rule — no lane edits it; the seat regenerates it at landing

**Ruled** (D7, quoted): *"rule this as standing — "no lane edits `eslint.seatbelt.tsv`; the seat
regenerates it at landing"."* The only sound option, quoted: *"the seat regenerates the rows with its
own lint, on the final landed tree of each batch that touches a seatbelted file, and commits them with
that batch. The run must be on a tree that parses."*

**Basis:** Astra's clone-only edit (renderer `curly` 10 → 9, `no-use-before-define` 6 → 5, R1 §2.10) is
right for the audited bytes — R4 measured the seat's own eslint producing exactly that tightening (R4 §4)
— but it expires: the formatter rewrites the renderer by +233 / −75 (R4 §4) and the rebase moves it
again. A parse-error lint run auto-removes allowance rows (CP:77). The file is seat-owned.

**Fallbacks recorded:** none — the decisions document names this the only sound option.

**Not offered:** **copying Astra's two rows** — valid only for bytes that will not land (R4 §4).

**Executes.** The seat, in each batch. R4's audit clone carries a dirty seatbelt, which is discarded
with the clone.

Executed: **in force from this sitting** as a standing rule (restated under "Standing rules that fall
out" below).

Authority: charter §1.1.

## R-2026-09-26-8 — Astra's next assignment (D8): OPTION A — landing-readiness of this stack first; no new cloud feature until A1 lands

**Ruled** (D8, option (A), quoted):

> **(A) Landing-readiness first.** Astra's next assignment is the return fix list on this stack
> (LANDING_PLAN §2): It works in a fresh clone of the post-Phase-1 tip. It delivers frozen batches
> A1–A3, with a hunk → unit map. Seat Opus 5.5 lanes own the reviewer, the adversarial verifier, the
> call-site inertness mutants and the Edge legs. No new cloud feature until A1 lands. Astra's item 4
> measurement (native 96/8) moves to the seat's N69 owner (D9).

**Basis:** the re-cut needs the author (R1 §1); Principle 10 is served by seat-owned mutants and review;
it stops the unlanded stack growing for a third cycle (*"The old cumulative Astra preview has **not
landed**"*, RA:12; this stack is not landable, audit §0); it keeps one owner per file. Items 2–7 of
Astra's own "Remaining work, in order" (CP:81–89) would all build on the unlanded stack in the same
renderer and shader files.

**Fallbacks recorded:**

- **(B) Astra continues its own list** on top of the unlanded stack, and the stack waits. Cost: the
  stack keeps growing; the rebase cost grows with the seat's queue (R5 §3); nothing lands.
- **(C) The seat's Opus 5.5 lanes take over the stack's landing-readiness entirely,** and Astra moves to
  work that touches none of these files. Cost: the seat must reconstruct hunk → unit attribution without
  the author (the per-packet patches exist but are not against one base, R1 §5.9). Gain: independence
  of review improves.

**Not offered:** **Astra extending the stack while seat lanes edit the same files to prepare it** —
two concurrent owners of one file, which the seat's standing "one defect, one owner" rule forbids.

**Executes.** The seat writes the return brief; Astra is a Codex worker, so its report is a lane claim
until confirmed. Opus 5.5 seat lanes do the review and the proof work.

Executed: **pending** — the return brief (Codex usage permitting) is the seat's first act under these
rulings.

Authority: charter §1.1.

## R-2026-09-26-9 — C13-N69 hang ownership, the C13-N13 march law and `cloudPrimarySteps` (D9): OPTION A on all three parts

**Ruled — D9a** (quoted): *"**(A) The seat's I-3 lane owns N69, and lands before Astra.** Its budget
covers raw `cloudQuality`, any public step dial, and the `chord / maximumStep` interval law.
`primarySampleBudget` counts the real intervals. It runs E4, the native 96/8 A/B, **before** it edits
`resolveCloudPreset`: arm (b), base + the frozen Astra patch, is built at `b263d8ac5e`, because I-5 and
I-3 edit the hunk the patch touches and it will not apply after them. E4 also carries a single-deck arm
(critic C5)."*

**Ruled — D9b** (quoted): *"**(A) The seat's N13 owner takes U3 as input** (its long-chord spec case is
a useful fixture). It lands a law whose sentinel is bounded by the tier budget, after I-3 and after ring
Leg 2. Astra's batches keep base spacing on the default path."*

**Ruled — D9c** (quoted): *"**(A) No public sample-count dial until I-3's budget lands.** I-5's
debug-only, pragma-stripped override covers ablation. Astra may re-propose afterwards, with a cap no
higher than I-3's budget."*

**Basis.** D9a: I-3 is already briefed; the hunk has one owner; E4 needs a lane that owns the machine
and does not come from the author of the suspect change. D9b: one owner of `ProceduralClouds.wgsl`; it
is hang-class; Leg 2's pre-registered arithmetic assumes the base march (R5 §2.1). D9c: raw
`cloudQuality` is still unclamped (R3 F6, R5 §2.1); `cloudPrimarySteps` is public and clamped to 1–512,
2× the 256 that hung the GPU, and ignored whenever `cloudQuality ≠ 64` (R3 F6); I-5's brief says "no
public API". Tier 3 is native 96/8 and `"auto"` resolves to it at or below 50 km (base
`WebGPUCloudTierPresets.ts:168–172`, `:201`), so the hazard reaches every default "clouds on, ground"
cell and **E4 is a hard gate before E5**.

**Fallbacks recorded:**

- **D9a (B) Astra owns N69 inside its stack,** extending the whole-ray budget to the raw and default
  paths. Cost (from the facts): Astra's whole-ray budget is opt-in and forced off for raw quality today
  (R5 §2.1), and the measurement would come from the author of the suspect change.
- **D9b (B) Astra's U3 lands in A3, after I-3,** reworked to the same conditions: a budget-bounded
  sentinel and a truthful counter. Cost: two owners in sequence on `ProceduralClouds.wgsl`'s march law.
- **D9c (B) Keep it public now,** but cap it at the current tier maximum (96) rather than 512, and apply
  it even when `cloudQuality` is set. Stated cost: *"This still contradicts I-5's rule, which is a lane
  rule rather than a ruling."*

**Not offered:** **a public dial capped at 512** — it exceeds the value that hung the GPU (R3 F6; R5 W1);
Astra's own receipt: *"The 384-sample 1080p orbital stress case FAILED with DXGI_ERROR_DEVICE_HUNG and
device loss"* (RA:299) — this dial at three-quarters of its cap (critic C5).

**Executes.** The I-3 lane (Opus 5.5), with E4 run as hang-risk work: bounded deadlines, the lane owns
the machine, never 512 steps at 2048² (R5 §5.2). The N13 owner after it. Astra's return conforms to
both.

Executed: **pending** — I-5 then I-3 are dispatched after these rulings, with E4 as the hard gate.

Authority: charter §1.1.

## R-2026-09-26-10 — The record (D10): OPTION A — Astra's two docs and the decomposition-log patch do not land

**Ruled** (D10, option (A), quoted): *"**(A) Do not land the two docs or the decomposition patch.** They
stay in the archive snapshot. This audit, after the critic, plus the ledger rows (D2, D6) are the
tracked record. The seat writes the ES6 status rows per batch from measured base → after line counts.
R1 §2.7's table is the starting point."*

**Basis:** the checkpoint is contradicted by the final patch in three places — 4×4 tiles, the bundle
hash, "GPU validation pending" — and records neither A/B (R2 §0.3–0.4); its "same-session" header is
overstated for two rows (R2 §0.6); two of its "fixes" repair Astra's own regressions (R2 §2); the ES6
hunk is malformed — 28 "Astra" mentions, 9 dangling `_lane-out/` paths, a table broken by a blank line,
a literal `\n###`, line counts that do not reconcile (R1 §2.9). Packet claims are lane claims until
confirmed. Precedent: Astra's 09-14 handoff stayed untracked. The corrected facts already live in the
audit.

**Fallbacks recorded:**

- **(B) Land Astra's two docs as tracked history, after corrections:** both A/B outcomes; 8×8 tiles;
  bundle `a4b74c3a`; the header of rows 7–8; the self-repair framing; the native failures in the layers
  row; removal of the `_lane-out/` links.

**Not offered:** none listed. Using `decomposition-doc.patch` itself is excluded by the landing plan §4
("Never use `decomposition-doc.patch`").

**Executes.** The seat, in its record round. **This file and the tracked audit are that record.**

Executed: **by this record round** as to the tracked audit; the per-batch ES6 rows are pending with the
batches.

Authority: charter §1.1.

## R-2026-09-26-11 — The shape of the `CloudVolumetrics` API (D11): OPTION C — an ES6 class whose validated dials are own-enumerable instance accessors

**Ruled** (D11, option (C), quoted):

> **(C) Convert to an ES6 class, and define each validated dial as an own enumerable accessor on the
> instance** (added after critique, C15). In the constructor, `Object.defineProperty(this, "cloudX", {
> enumerable: true, get, set })`, with `Check` in the setter. An object spread invokes own enumerable
> getters and copies the values, so `{ ...this.volumetric }` at `CloudCollection.js:367–373` keeps
> working **without touching the forwarding**. House precedent: `AtmosphericConditions.js` builds its
> leaves the same way … A spec pins that every documented dial reaches `_resolveVolumetricConfig()`;
> its mutant makes one accessor non-enumerable and must go red. Cost: instance accessors need explicit
> JSDoc tags to appear in the generated docs; the reviewer confirms with a docs build.

(abridged at the ellipsis; full text: `ASTRA_AUDIT_DECISIONS_2026-09-26.md` D11 (C)). With JSDoc and
"WebGPU only." on every dial; **nine** new dials remain after `R-2026-09-26-2`, `-9` (D9c) and `-12`
(D12(a)), re-derived from the patch's `this.cloud… =` lines (critic C15).

**Basis:** R3 F7 and F10 (14 new dials are plain properties: no JSDoc, no `Check` when set, clamping at
consumption for only 4; an invalid `cloudLayers` throws a `DeveloperError` every frame), R1 §2.9 (the ES6
rule applies above 10 changed lines; `CloudVolumetrics.js` got 46), `R-2026-09-16-6` ("real
`CloudVolumetrics` dials with JSDoc"), and the spread constraint — `_resolveVolumetricConfig` returns
`{ ...this.volumetric, … }` (base `CloudCollection.js:367–373`) and an object spread copies only own
enumerable properties, so prototype accessors would be silently dropped. (C) meets all four and leaves
the one forwarding path every existing dial already takes untouched; its failure mode, a
non-enumerable accessor, is exactly what its spec's mutant exercises.

**Fallbacks recorded:**

- **(A) ES6 class with validating prototype setters,** with `_resolveVolumetricConfig` changed to read
  the dials explicitly and a spec pinning that every documented dial reaches the resolved config.
  Stated cost: *"(A) must rewrite that path to read every dial explicitly, and a missed dial there is
  silent."*
- **(B) Keep plain fields, add JSDoc plus "WebGPU only.", validate `cloudLayers` in the constructor, and
  waive the ES6 rule for this file explicitly.** Stated cost: a value assigned after construction can
  still throw every frame (applies only under D12(c), since `cloudLayers` is not public under D12(a)).

**Not offered:** none listed; prototype accessors **with** the spread forwarding left as-is would
silently drop every dial (the constraint above).

**Executes.** Astra, in the batch that carries each dial (class conversion in A1; dials with their
features — fix list F-11). The seat's reviewer runs the forwarding spec's inertness mutant (one accessor
made non-enumerable) and requires red.

Executed: **pending** — A1 and later.

Authority: charter §1.1.

## R-2026-09-26-12 — The HOLD chain's plumbing (D12): OPTION (a) — keep it as structure; strip the public surface; name the slots as reserved pads

**Ruled** (D12, option (a), quoted):

> **(a) Keep the plumbing as STRUCT; remove what makes the features reachable.** Keep:
> `CloudLayerProfile`, `cloudProfileForDeck`, the profile parameters, `peerTransport`, the peer code in
> U25's module and shader, and slots 220–223 and 228–259 as **named reserved pads** in the layout
> module (the uniform size stays 260 floats). Remove: the three public dials, their `.d.ts` fields, and
> every writer that fills slots 220–223 and 228–259 with anything but zero, so `layerProfilesEnabled`,
> the layer-shadow gate and `peerEnabled` are 0 on every frame. Prove: the A1 byte-identity leg (clouds
> on, default, ground/flight/orbit, with a repeat control); a value oracle that executes
> `cloudProfileForDeck` at defaults and returns the global profile; F-3's `cloud-tier-single-source`
> models `CloudLayerProfile`. `cloud-layer-profiles.spec.mjs` is not homed until U26 returns.

**Basis:** it removes every way to reach the unvalidated features, which is what "out as features"
requires; it leaves the default-path code exactly as the A1 identity leg will capture it, so the leg
proves one tree, not a re-signed one; it keeps the append-only slot rule without a gap in the chain
(220 → 224 → 228–255 → 256–259 → 260, P:9974–10003); it follows Principle 7 and Astra's live goal
(RA:377 names independent layer coverage as the next priority after native cost). The plumbing runs on
the default density and lighting path of kept units (astra `CloudLightSampling.wgsl:629–658` and
callers; `multiScatterLight(…, profile, peerTransport)` on the default march) and is not separable by
file (critic C1). Principle 9: a `DEFERRED_WORK` row names the HOLD chain, with native 96/8 stability
(E4) as its prerequisite and D12(c) as the route back.

**Fallbacks recorded:**

- **(b) Full strip, plumbing included.** Stated cost: re-signs about ten default-path functions in two
  WGSL files, re-pins the spec regexes that read `profile.*`, and re-touches the density and lighting
  path A1 claims is byte-neutral; the slot chain still keeps 220 / 228–259 reserved (append-only); U25's
  shader loses its peer lines; it discards scaffolding for work the author has not abandoned
  (Principle 7).
- **(c) Ship the features as default-off public dials under `R-2026-09-16-6`.** Stated condition:
  *"Sound only **after E4 attributes the hang** (D9a), and only with R-16-6's JSDoc, set-time validation
  (D11), and a spec that kills the call-site mutant M3 (R4 §2). Until then it ships a public path into
  the configuration Astra's own runs could not complete natively."* **This is the named route back**
  for the HOLD features.

**Not offered:** none listed.

**Executes.** Astra, as fix-list item F-18: profile threading in A1; U25's dormant peer code in A2b. The
seat's reviewer verifies `git grep -nE 'cloudLayers\b|cloudLayerShadowSteps|cloudLayerShadowCache' --
packages/engine/Source` returns 0; that no writer puts a non-zero value in slots 220–223 or 228–259; and
that an inertness mutant writing 1 into `layerProfilesEnabled` changes the default oracle. The seat lands
the `DEFERRED_WORK` row with A1.

Executed: **pending** — A1 / A2b.

Authority: charter §1.1.

---

# Part 2 — Gemini's comment-and-documentation plan of 2026-09-20 (`G1` … `G10`)

Evidence is cited as `§n` of `GEMINI_PLAN_AUDIT_2026-09-26.md`, or as `file:line` at the tip
`b263d8ac5e` (Batch 1537), where the audit's revision measured (Batch 1537 changed only three `Tools/`
specs, one `Tools/` receipt library and `TOOLING_CATALOG.md`, so every engine `file:line` equals `a76d42b3f8`). **Premise correction carried
from the decisions document:** `migration_doc/CODEBASE_CODING_AND_COMMENT_STANDARDS_AUDIT_2026-09-14.md`
is **Gemini's earlier audit document**, held untracked behind nine corrections (`R-2026-09-16-11`,
`R-2026-09-17-2`), not the maintainer's own audit; the maintainer's own conclusions on this subject are
`R-2026-09-16-11`, `R-2026-09-17-2`, `R-2026-09-17-6` and `R-2026-09-17-7`.

## R-2026-09-26-13 — Which plan governs (G1): OPTION A — execute the C16 tail from the queue; bank Gemini's plan and inventory as evidence

**Ruled** (G1, option A, quoted):

> **A. Execute the C16 tail from `QUEUE_2026-08-10_CAMPAIGN16.md`, and bank Gemini's plan and inventory
> as evidence.** The queue stays the sole status authority (`R-2026-09-17-6`). The work runs as the 13
> batches in audit §7, against rows `C16-09`..`C16-12`, `C16-20` and `C16-21`, under the shard protocol.
> What survives from Gemini's plan is its inventory, which equals the guard census plus 32 regex hits.
> The channel (G2), the phases, the gates and the scope are all replaced. Gemini's plan, inventory and
> scripts are banked in `cesium-webgpu-worker-archive/`, not in the tree. The 09-14 document's nine
> corrections continue on their own track, as a record (`R-2026-09-17-2`).

**Basis:** it is what the in-force rulings already say — `R-2026-09-17-6` folded this comment mass into
the C16 rows plus `C16-21`, and the queue declares itself "sole status authority for C16". The plan's
guard-visible half is exactly the C16 census, 179 findings in 83 files, re-run at the tip. B would put
an untracked document from an external model into the execution path, one that still owes nine
corrections (none applied as of 09-17) and lacks the protocol steps the audit found missing. "100 files
/ 211 occurrences" is regex hits, not defects: 179 are the guard census; of the 32 extra hits, 28 are
`CLAUDE.md` citations of constraints the fork's rules require, 1 is an upstream-verbatim false positive,
and none names an AI model (§1.1–§1.3).

**Fallbacks recorded:**

- **B. Reverse `R-2026-09-17-6` (and `R-2026-09-17-2`'s record-only status for the 09-14 document).**
  Apply that document's nine corrections plus this audit's (Phases 1 and 3 already discharged by Batch
  1498; `any` fallbacks at 139 in 19 files, not ~50 in ~10), land it, and make it the execution
  authority, executing from its shard table. **Stated as a reversal of two in-force rulings, listed
  only so the choice is explicit;** taking it needs a ruling that says so.

**Not offered** (shown unsafe): **adopting Gemini's plan as written** — five conflicts with the fork's
written rules (§0, §3) and two gates unreachable as written; **the first-pass option A, "adopt as
amended"** — mislabelled, because the amendments replace every structural element of the plan
(critic F8); **B framed as execution "from the 09-14 document's shard table" without being labelled a
reversal** — unsound as framed, because it contradicts `R-2026-09-17-6` and `R-2026-09-17-2` (critic
F8).

**Executes.** The seat: C16 tail batches from the queue, B0-tools first (`R-2026-09-26-20`). The banking
of Gemini's plan, inventory and scripts is **done** (see "Seat acts").

Executed: **pending** as to the tail; the banking is done.

Authority: charter §1.1.

## R-2026-09-26-14 — Where relocated knowledge lives (G2): OPTION A — the existing channels only; `Documentation/Features/` is excluded

**Ruled** (G2, option A, quoted): *"**A. The existing channels only. No new channel.** A constraint is
rewritten in place in the source. History that carries a *why* moves verbatim into
`migration_doc/DEV_NOTES_<subsystem>.md` in the same batch, per `ForkCommentStandard.md` §2 and
`DEV_NOTES_FORMAT.md`. Fourteen such files exist. An open follow-up becomes a `DEFERRED_WORK` row."*

**Basis:** none of the five sources needs a new channel — TideModel stays in JSDoc; Snapshot is
re-derived and banked; BufferPrimitives, Wasm and Kernels are dropped (§5; **0 of 5 proposed documents
warranted**). The written standard, the C16 binding gates and Gemini's own 09-14 document all name
DEV_NOTES.

**Fallbacks recorded:**

- **B. A, plus an upstream-style usage guide when needed.** When a feature has user-facing usage the API
  reference cannot carry, it gets `Documentation/<Name>Guide/README.md`, the upstream convention
  (`CustomShaderGuide`, `FabricGuide`, `OfflineGuide`), linked from JSDoc by the fork's absolute URL,
  gated by markdownlint, prettier and a reviewer link check, **created on demand, never used as a
  relocation target**.

**Not offered** (shown unsafe): **`Documentation/Features/` as proposed** — upstream has no such
directory; `.npmignore:22` excludes `/Documentation`, so the plan's "permanent documentation for users"
premise is backwards; no checked-in verifier covers it; and it would publish stale status text as
permanent (SnapshotModeService §2.3, WasmArenaSlots §2.4).

**Executes.** Every comment batch's knowledge-disposition table (U6, audit §7.1).

Executed: **in force from this sitting** for every comment batch.

Authority: charter §1.1.

## R-2026-09-26-15 — May published-API JSDoc be rewritten (G3): OPTION A — marker-strip in place

**Ruled** (G3, option A, quoted): *"**A. Marker-strip in place.** A published `/**` block may lose only
tracker vocabulary (row, batch, ruling and ledger ids; tracker-document paths), and may have a stale
claim corrected against present-day code. Every technical sentence, tag, type and
`@private`/`@internal` stays. No block is shortened or moved out. Proof: The `build-docs` output diff is
confined to the touched doclets. `compareDeclarations` reports the declarations structurally equal. The
count of `any` fallbacks does not rise."* — with the GLSL note that binds under either option (quoted):
*"In GLSL, a `/**` ↔ `/*` change, a one-line doc block, or `//` text on a closing `*/` line is a runtime
change, because `ShaderSource.removeComments` (`ShaderSource.js:8-21`) reads doc-block shape in
unminified builds. Under either option, GLSL doc blocks keep their shape."*

**Basis:** CLAUDE.md's "preserve ALL existing JSDoc" and `ForkCommentStandard.md` §5 are scoped to
modernizing, so their letter does not decide a comment-only batch; their purpose, and Batch 1509's
restoration of 24 stripped public blocks, argue against shortening published reference material. A
keeps the published derivations and caveats (TideModel's "not a prediction", SampledPositionKernel's
lane layout), removes only what the fork's standard bans, and its proof catches a typings regression
mechanically.

**Fallbacks recorded:**

- **B. As A, plus a maintainer sign-off** on the rendered before/after of each published source file:
  the seven carrying tracker text today (`CustomShader`, `Atmosphere`, `Material`, `TideModel`,
  `SampledPositionKernel`, `WasmFeatureDetection`, `WasmArenaSlots`) and the tide siblings. Stated:
  *"B is the stricter choice if you want your own eyes on the public reference."* Cost: a maintainer
  sitting per file set.

**Not offered** (shown unsafe): **the plan's remedy of replacing published JSDoc with "concise
upstream-style JSDoc that links to this guide"** — it removes published reference content (§3; Batch
1509 precedent; `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` calls stripped public JSDoc a typings
regression).

**Executes.** B1, B2a, B2b, B3c and any `.js` `/**` edit, under U3/U4 (audit §7.1).

Executed: **in force from this sitting** for every comment batch.

Authority: charter §1.1.

## R-2026-09-26-16 — The cleanlist ratchet for the 100 files (G4): OPTION A — append and retire in the certifying batch's own commit

**Ruled** (G4, option A, quoted): *"**A. Append each certified file in the batch that certifies it, in
the same commit, and retire that batch's grandfather rows in the same commit.** Over the wave that is 80
appends and 15 retirements (audit §7.2). The 80 are the 76 unlisted inventory files plus the four tide
siblings, none of which is clean-listed (re-checked after critique). The five files flagged only by
Gemini's regex are appended too: `ComponentDatatype.d.ts`, `Resource.d.ts`, `Sync.js`,
`WebGPUIndirectDrawManager.ts`, `MVTTileDecoder.js`."*

**Basis:** the ratchet itself is already ruled design (`ForkCommentStandard.md` §8 item 2; the
shrink-only ledger of `R-2026-08-21-18`). Clean-listing the five regex-only files costs nothing; no
in-flight lane writes any of the 80; it makes any future grammar-visible regression an error
immediately.

**Fallbacks recorded:**

- **B. As A, except the five regex-only files,** which are appended only after B7's new grammar rules
  land, so their clean-list entry enforces something the day it is added.

**Not offered** (shown unsafe): **deferring appends or grandfather retirements to a final phase** (the
plan's Phase 5) — the guard exits 1 on a stale grandfather row in any commit that stages the file
(audit §3).

**Executes.** Each comment batch, in its own commit, serially (the ratchet files are appended at end of
file).

Executed: **in force from this sitting.**

Authority: charter §1.1.

## R-2026-09-26-17 — Governance-document citations in shipping comments (G5): OPTION A — rewrite the 28 `CLAUDE.md` citations to their constraints, then a narrow `C16-21` rule last

**Ruled** (G5, option A, quoted): *"**A. Rule them out.** Each is rewritten to its constraint: the
constraint sentence stays, the citation goes. Five of them sit on `// lint-debug-pragmas-allow:` lines.
The prefix must survive; only the reason text changes. This is compatible with G10 only under
prefix-only retention (G10-A′) or lane-local checks (G10-B′). Whole-comment retention would freeze the
reason text. A rewritten sentinel sentence must not quote `//>>includeStart(…)` syntax. The release
pragma strip matches it even inside prose and strips the sentinel it describes (audit §3, U1a). A narrow
`C16-21` rule (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) lands in B7, after the last citation is gone, so no
grandfather row is ever added."*

**Basis:** "per CLAUDE.md §2" fails the seamlessness test (`ForkCommentStandard.md` §1) — an upstream
reader cannot resolve it; the constraint loses nothing when stated directly; landing the rule last
respects the empty-grandfather clause. The 28 citations in 20 files each name a real constraint: 13
permanent sentinels, 9 backend agnosticism, 2 RTE, 2 co-located `.d.ts`, 1 ShaderDefine add-only, 1
Principle 7. Under either option, model names (Gemini, Astra, Sol, GPT) stay out of the grammar: 0
hits, and they already needed hand suppressions (the constellation Gemini, "Jean-Claude").

**Fallbacks recorded:**

- **B. Allow them.** Fix only the four real leaks (for example `MVTTileDecoder.js:12` "see
  migration_doc R-4"); grow the grammar only for leak shapes: `migration_doc` without a slash,
  `ruling T\d`, `AUDIT_\d{4}_\d{2}_\d{2}`.

**Not offered** (shown unsafe): **landing a `CLAUDE.md` grammar rule before the rewrites** — 21
citations in 15 clean-listed files would become errors that day (§1.2); **a sentinel rewrite that
quotes pragma syntax in prose** — the release strip deletes the sentinel it describes (critic F5, A6).
Outside both lists, because the decisions document excludes it under either option rather than
showing it unsafe: model names as a lint rule — 0 hits, and it keeps needing exceptions.

**Executes.** B1 ×1, B3a ×4, B3b ×4, B4 ×19; the rule in B7.

Executed: **pending** — rides the tail.

Authority: charter §1.1.

## R-2026-09-26-18 — The upstream false positive `Core/IonSnapMode.js:4` (G6): OPTION A — narrow the grammar; never edit the upstream line

**Ruled** (G6, option A, quoted): *"**A. Narrow the grammar.** `all-caps-fix-label` skips tokens inside a
URL, with a self-test negative example. This lands under `C16-21` in B0-tools, and `IonSnapMode.js` is
appended to the cleanlist untouched."*

**Basis:** narrowing a rule cannot expose anything; the census becomes honest (179 → 178); `C16-20` leg
(1) can then reach a real 0 without a standing exception. The critic re-derived that across the whole
scope the IonSnapMode GUID is the **only** grammar marker inside a URL token, so narrowing leaves no
grandfathered pair stale (critic A7).

**Fallbacks recorded:**

- **B. Record a named exception.** Leave the grammar alone and record the line in `C16-20` leg (1) as a
  named, upstream-verbatim exception. Cost: a standing exception in the final gate.
- **A-variant (the critic's, stated "equally sound"): a `GUID-` family exclusion** in
  `all-caps-fix-label`, matching how the rule already excludes `CC-BY` and `YYYY-MM-DD` by family
  (`marker-grammar.mjs:109-120`; critic A7).

**Not offered** (shown unsafe): **editing the `IonSnapMode.js` line** — the file is byte-identical to
`upstream/main`; the edit breaks a valid link and diverges from upstream.

**Executes.** B0-tools.

Executed: **pending** — B0-tools.

Authority: charter §1.1.

## R-2026-09-26-19 — Who writes the rewrites (G7): OPTION A — Opus 5.5 throughout

**Ruled** (G7, option A, quoted): *"**A. Opus 5.5 throughout.** Opus 5.5 authors every batch. A separate
Opus 5.5 station-3 reviewer checks each one. One Opus 5.5 tier-2 lead runs the wave with at most five
tier-3 authors at a time. The optional adversarial Opus 5.5 verifier is used on B0-tools, B1 and B5a.
B0-tools was added after critique, because it carries every later batch's proof."*

**Basis:** the maintainer asked to lean on Opus 5.5 in the lower tiers (2026-09-25 tiering); the token
saving from B is small, because review dominates and costs the same either way; Gemini's own plan shows
the failure modes this work punishes (a second knowledge home, wrong counts, the anchor-sweep tool
omitted, an unreachable gate, misplaced grandfather retirement);
`reference_antigravity_gemini_worker.md` excludes Gemini from engine and shader judgement.

**Fallbacks recorded:**

- **B. Gemini for the simplest batches only.** Gemini (gemini-3.8-flash-high via
  `run-gemini-worker.sh`) authors **B3a and B3b only** — the pre-listed label strips in `.js` files that
  touch no `/**` block and no directive line — each with an Opus 5.5 reviewer; Opus 5.5 authors the
  rest. Stated: *"B stays within `R-2026-09-17-7` if you prefer it."*

**Not offered:** **Gamgee's broader proposal, which also gave Gemini the non-sky shader batch** —
narrowed out, because shader comments are shader judgement.

**Executes.** The seat, on every dispatch of the tail (model and effort passed explicitly).

Executed: **in force from this sitting.**

Authority: charter §1.1.

## R-2026-09-26-20 — Sequencing against Astra and CI wave 2 (G8): OPTION A — start now, B0-tools first, serialised and interleaved; no Edge slot while the flavour checks are in force

**Ruled** (G8, option A, quoted, abridged): *"**A. Start now and interleave.** After the rulings, B0
baselines are measured in a disposable clone. **B0-tools lands first.** Its gate is the CI `guards` job
green at the landing base. … Every later batch depends on B0-tools. B1, B2a, B2b, B3a, B3b (without
`Snapping.js`), B3c, B4 (without `Resource.d.ts`) and B6 land one at a time between the tranche-2,
C15-06 and Astra landings, each rebased onto the tip. Gated items: B5a and B5b wait for W2-L5. …
`Snapping.js:407` waits for W2-L8, or gets a rewrite that keeps line counts unchanged. `Resource.d.ts`
waits for Angrim (W2-L11). B6-sky follows Astra's sky pieces, or runs `sky-light-direction.spec.mjs` on
both trees. B7 goes last. No Edge slot is used, **provided U1a-U1e are in force** (G10-A′ or G10-B′).
The wave-end gate (`R-2026-08-29-2`) then rides the next scheduled wave-end Edge job."* (full text:
`GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md` G8 A.)

**Basis:** only one of the 100 files is in Astra's 81-path patch (`WebGPUFeatureRenderers.ts`, hunks
about 245 lines apart, re-measured); none is in a tranche-2 lane's write set; the Astra audit's
collision reader found no ordering constraint either (R5 §3 item 3). B0-tools' gate — a green `guards`
job — was red at `a76d42b3f8` and is **green at `b263d8ac5e`** (run `36220924784`).

**Fallbacks recorded:**

- **B. Hold the whole wave until CI tranche 2 and Astra have landed, then run it in one stretch.** The
  same B0-tools-first order and the same U1a-U1e condition apply. Stated cost: *"B is safe but costs
  calendar time for no risk reduction beyond A's four gates."*
- **The conditional Edge fallback** (stated inside A): *"If neither G10 option is taken, B6 and B6-sky
  each need a WebGL leg on the unminified dev build before the next engine landing (audit §7.3)."* Not
  triggered while `R-2026-09-26-22` stands.

**Not offered:** none listed. (A comment batch landing **before** B0-tools is excluded by A itself:
every later batch depends on it.)

**Executes.** The seat's C16 tail lane (Opus 5.5 lead + verifier on B0-tools), serialised with the other
landings.

Executed: **pending** — B0-tools is the first dispatch of the tail.

Authority: charter §1.1.

## R-2026-09-26-21 — The `build-ts` gate (G9, re-framed): OPTION A — strict exit 0 plus structural equality on the batches that can move it

**Ruled** (G9, option A, quoted): *"**A. Strict gate on the batches that can move it.** Per batch: `npm
run build-ts` and `npm run build-docs` **exit 0**. `compareDeclarations` reports `Source/Cesium.d.ts`
structurally equal to the B0 base. The `any`-fallback count is not higher. The `Build/Documentation`
diff is confined to the touched doclets. It runs on batches that edit a `.js` `/**` block (B1, B2a, B2b,
B3c, and B3a/B3b if one is touched) and once at the wave's end. B0 still saves a local base
`Source/Cesium.d.ts` and `Build/Documentation` for the diffs. The seat corrects the `C16-02c` row in the
first landing's ledger edit."*

**Basis (the re-framed premise):** `build-ts` and `build-docs` are **green in CI at the tip** —
`release-tests` → "release build" = `npm run make-zip` (`dev.yml:128-129`, no `continue-on-error`) →
`release` = `series(buildRelease, parallel(buildTs, buildDocs))` (`gulpfile.js:620-623`), both
`execSync` and throwing on error; the step succeeded in run `35467592179` (`a76d42b3f8`) and run
`36220924784` (`b263d8ac5e`). So `C16-02c`'s "21 pre-existing `error TS` … PENDING" is stale. Both
jsdoc configs read `.js` only, so running the builds on `.ts`, `.wgsl` and `.glsl` batches cannot change
their output; CI runs both on every push anyway, as a backstop.

**Fallbacks recorded:**

- **B. As A, but run both builds on every batch,** uninformative runs included. Stated cost: about 5
  minutes per batch proving nothing; *"Choose B if you want the literal "every batch runs all four"
  bar."*

**Not offered** (shown unsafe): **the first-pass framing — `build-ts` "unmeasured at the tip", gated as
"no worse than base"** — its premise was refuted by CI (critic F7), and it is weaker than the evidence
allows.

**Executes.** The comment batches named; the seat's first landing ledger edit corrects `C16-02c`.

Executed: **pending** — the `C16-02c` correction is a queue-row edit owned by the companion record lane
or the first tail landing.

Authority: charter §1.1.

## R-2026-09-26-22 — `comment-only-diff` certifies tokens, not artifacts (G10, re-scoped): OPTION A′ — make the shared tool flavour-aware in B0-tools

**Ruled** (G10, option A′, quoted):

> **A′. Make the shared tool flavour-aware in B0-tools.** **Prefix-only** retention for
> `lint-debug-pragmas-allow` and `/// <reference`: the directive token is code, and the reason text
> stays prose. A `bundler-magic-comment` semantic rule, retained whole. Per-flavour views in the
> comparison: the release pragma view via the exported `constructRegex`, requiring 0 anchors that do not
> open their line; the `stripWgslComments` view for `.wgsl`; and a vendored `removeComments` view for
> `.glsl`, byte-pinned to `ShaderSource.js:8-21` and required not to throw and to keep code and the
> `czm_` token set identical. The ASI fix. Whole-corpus agreement specs in `test-build-infra` (WGSL in
> `Tools/build-infra/wgsl-chunk-resolution.spec.mjs`) and unit specs in `test-c16`. Each gets a mutant
> showing it fires. "Comment-only" then means "comment-only in every flavour" (U1).

**Basis:** six gaps confirmed, each reproduced with a synthetic before/after pair the tool calls
`comment-only` (§3, §11) — a dropped `webpackIgnore`; a one-line GLSL `/** */` that makes
`ShaderSource.removeComments` throw; a URL on a doc-block closing line that eats the next function; a
nested WGSL block comment against the non-nesting minify strip (Batch 1534's class); prose quoting a
`//>>` pragma that the release strip anchors on; and a `lint-debug-pragmas-allow` reason edit. **All six
hazards are absent at the tip** (0 of 330 GLSL, 0 of 325 WGSL, 0 of 1,517 JS/TS files), so every check
starts green. A′ makes the tool match `ForkCommentStandard.md` §8.4 and the fork's real transforms once,
with existing runner homes; it protects every future comment edit, not only this wave; and it is what
makes the no-Edge rationale of `R-2026-09-26-20` true.

**Fallbacks recorded:**

- **B′. Leave the shared tool alone; every comment batch runs the same checks as lane-local scripts**
  (U1a–U1e, audit §7.1); B4 also carries `npm run lint-debug-pragmas` and a reviewer prefix check, and
  B3c a magic-comment count-and-bytes check; the corpus agreement specs are still added in B0-tools.
  Stated cost: *"B′ is sound but duplicates the same scripts across up to 11 lanes. It also leaves the
  next comment campaign unprotected."*

**Not offered** (shown unsafe, both withdrawn after critique): **the first-pass A, whole-comment
retention of `lint-debug-pragmas-allow`** — the scanner keeps a retained comment whole
(`comment-scanner.mjs:880-883`), which would freeze the five reason texts at
`WebGPUDeviceLossRecovery.ts:591,627,651,695,718` that `R-2026-09-26-17` rewrites, so B4 could never pass
U1 (critic F6); **the first-pass B, lane-local checks without the flavour views** — unsound for B3c, B5
and B6 (critic F6).

**Executes.** B0-tools (Opus 5.5 + adversarial verifier), before any comment batch lands.

Executed: **pending** — B0-tools. **Until it lands, no comment batch lands** (`R-2026-09-26-20`).

Authority: charter §1.1.

---

## Standing rules that fall out

These are stated once here so a reader who finds only this section acts correctly.

1. **No lane edits `eslint.seatbelt.tsv`; the seat regenerates it at landing** (`R-2026-09-26-7`). The
   regeneration runs the seat's own lint on the final landed tree of each batch that touches a
   seatbelted file, on a tree that parses, and commits the rows with that batch. Rows written in any
   lane or worker clone are discarded, never copied.
2. **The proof bar per landing batch, as it applies to Astra's batches A1–A3 and T1.**
   `R-2026-09-16-5` — an independent reviewer **and** one named Edge leg per landing batch — binds every
   batch, and `R-2026-08-29-1` (engine, parity and shader changes: behaviour spec + inertness mutant +
   separate review + named Edge leg) sets its class. Applied here by `R-2026-09-26-1`: each batch
   carries the common set C1–C7 (audit §2.1), an Opus 5.5 reviewer, **an Opus 5.5 adversarial verifier
   on A1, A2a, A3 and T1** (`R-2026-09-11-1`), and one named two-tree Edge leg (T1 → E2, A1 → E5,
   A2a → E6, A2b → E7, A2c → E8, A3 → E9, then E10 at wave end). The call-site inertness mutants are
   written and run by the seat's reviewer, not the author (Principle 10). The batch is frozen after the
   formatter, so the reviewed bytes are the landed bytes (C2). Every byte-identity cell carries a
   same-build repeat control (`R-2026-09-16-7`). **E4 is a hard gate before E5**, and every native high
   (tier 3, 96/8) cell runs under the hang protocol until E4 reports (`R-2026-09-26-9`).
3. **The T1 freeze identity** is `c4016b889ec06d782c36a50f8888e449` — the md5 of the seat packet
   `Tools/visual-regression/output/astra-return-audit-20260921/worker-rejected-dispatch.patch` (seat,
   gitignored output). With `index` lines dropped it equals the clone's `git diff`, both
   `c3cb96b14feb04590a22e8c61e76dd52`; `git apply --check` passed at `b263d8ac5e`. T1 lands those bytes
   plus the seat-authored WASM-init hunk, frozen together before review (`R-2026-09-26-5`).
4. **Astra's clone writes no seat-owned file.** `package.json`, `eslint.seatbelt.tsv` and `migration_doc/`
   lines come back as text in each packet (landing plan fix list F-14); the seat re-composes
   `package.json` on the tip current at landing and never applies Astra's hunk (landing plan §4).
5. **No comment batch lands before B0-tools**, and once it lands "comment-only" means "comment-only in
   every flavour" (`R-2026-09-26-20`, `-22`).

## Seat acts taken without a ruling

Recorded here so the paper trail is complete; none needed a ruling, and each is either done or
reversible.

- **The rig-census landing (Batch 1537, `b263d8ac5e`, 01:28 EDT).** The rig registry's size is pinned in
  one census spec, so adding a rig stops turning a contact-sheet grammar test red. With it, CI `guards`
  went green for the first time since Batch 1530 — which is B0-tools' gate (`R-2026-09-26-20`). One of
  the three frozen patches the audit named (`vinitharya.patch`) is therefore landed; `angrim.patch`
  (W2-L11) and `pimpernel-ledger.patch` remain.
- **The runnerless-spec homing (Batch 1538, `37c0f8767e`, 02:32 EDT).** `fog-cheap-coverage-gate.spec.mjs`
  (15/15 at `b263d8ac5e`) and `perf-manager-teardown.spec.mjs` (7/7) joined `test-visual-regression-node`,
  `package.json` only. The first is the guard for the audit's P0 class (Y1): the seat now catches that
  class before any cloud landing. This is landing plan item P0.3.
- **The T1 freeze** (landing plan P0.2): the TaskProcessor packet frozen with the identity in standing
  rule 3.
- **Audit banking** (landing plan P0.1): both audits' reader reports, critiques, briefs and decisions
  banked verbatim with `MANIFEST.md5` at `cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/` and
  `…/gemini-plan-audit/audit/`; Gemini's plan, inventory and scripts at
  `…/gemini-plan-audit/gemini-deliverable/` (the banking `R-2026-09-26-13` orders); Astra's handoff
  snapshot read-only at `cesium-webgpu-worker-archive/astra-checkpoint-20260925/`.
- **Closeout 5, phase 1** (the two-phase harvest of the landed and disposable clones) was running at
  the sitting; **phase 2, the link-aware delete, waits for
  the seat's read of the harvest manifest** (per-package junctions: unlink links only, verify the seat,
  then delete).
- **Closing R4's audit clone** `cesium-lane-hasufel-20260926` (the source sheet's "closing the audit
  clone"): **pending**, by the same harvest-then-link-aware-delete procedure.
- **Also on the table, not ruled here:** the inherited monthly `update-tokens` workflow fails every 25th
  for lack of ion secrets; the seat asked whether to drop its schedule or the file. It stays open with
  the maintainer's other standing items (MQ2 for Campaign 12, ring Q1–Q5, the CI wave-1/2 questions, the
  three `R-2026-09-19-8`/`-9`/`-10` sittings).

## Rulings of earlier sittings now moot in this stack

From the audit's §3.3 (critic C17): which `R-2026-09-16` clauses have no subject in the 2026-09-25 stack.
Re-derived there with `grep -c` over the frozen patch — 0 hits each for `AUTO_TEMPORAL`, `autoTemporal`,
`interleavedRefresh`, `pixelFootprint`, `weatherCoverage`, `projectedDetail`, `ASYNC_PIPELINE`,
`NOISE_COMPUTE`, `WEATHER_SKIPPING` and `cloudWeatherIntervalEmpty`. **Moot means the clause has no
subject in this stack; it is not reversed.** A later stack that re-introduces a named unit meets the
clause again.

| Ruling clause | Status in this stack | Recorded disposition |
|---|---|---|
| `R-2026-09-16-1` (lanes L3/L4/L5 first, Astra rebases) | **Executed.** Batches 1493, 1504 and 1515 are ancestors of `a76d42b3f8` | close |
| `R-2026-09-16-2`, "the resolver KEEPS L3's near-altitude band" | **Holds** (R1 §2.3); its protected acceptance is silenced by the crash (Y2), which fix-list F-3 fixes | open until F-3 lands |
| `R-2026-09-16-2`, "Astra's AUTO_TEMPORAL re-lands on top" | **Moot:** no subject | moot |
| `R-2026-09-16-3`, "slot 175 stays `_padQ`; single-source `CLOUD_UNIFORM_FLOATS`" | **Holds** (Y17) | executed when A1 lands U5 |
| `R-2026-09-16-3`, "`interleavedRefresh` is APPENDED" | **Moot:** no subject | moot |
| `R-2026-09-16-6`, "units 43, 39, 38 ship default-off; 39 and 43 get real dials with JSDoc" | **Moot as to its named units.** The principle carries over: U36 ships default-off, and `R-2026-09-26-11` applies the JSDoc half to every new dial | moot for 38/39/43; the principle governs `R-2026-09-26-11` and D12(c) |
| `R-2026-09-16-7`, "same-build repeat control for units 37 and 47" | **Moot as to its named units** (ASYNC_PIPELINE, NOISE_COMPUTE absent). U34's `createRenderPipelineAsync` is a new subject. The **procedure** is carried into every byte-identity cell (standing rule 2) | moot for 37/47; procedure adopted |
| `R-2026-09-16-4`, `-5`, `-8` … `-12` | Not re-examined clause by clause by the audit; `-5` is restated as standing rule 2 | — |

## Seat decisions taken on measurements after the sitting

*Appended by record round 8 (lead Arahad, Opus 5.5).* The maintainer's sentence ruled D1-D12 and G1-G10.
The lanes those rulings dispatched then raised questions of their own, and the seat (Gandalf) decided them under the
standing rules — the proof bar (`R-2026-08-29-1`), the adversarial verifier (`R-2026-09-11-1`) and this sitting's
standing rules above — rather than on a new sentence from the maintainer.
**None of the entries below is a maintainer ruling, and none carries an `R-` id.** Each names its basis: the receipt
where a measurement decided it (S-1, S-7), and otherwise what it was taken on — a reconciliation of two briefs (S-4),
a lane's recommendation where the data cannot decide (S-2), the absence of a measurement (S-3), a verifier's findings
(S-5) or a lead's own re-run (S-6). The section's title covers it as a whole; not every entry was decided by a
measurement. Each keeps every sound alternative as a fallback with its cost, and lists what was withdrawn and why. **The
maintainer may reverse any of them**; a reversal starts from the fallback named, and the seat records it as a ruling
of its own date.

The seat's source sheet records the questions and their resolution
(`cesium-webgpu-worker-archive/lanes-2026-09-26/rulings-source/rulings-source-2026-09-26-after-mq.md`, md5
`903190d68f2b4be56c04b173886d3c84`, the copy that carries the MQ section; the earlier copy beside it predates that
section). The quotations under each question below are verbatim from it. The questions themselves are in lane I-3's packet
§9 (`cesium-webgpu-worker-archive/lanes-2026-09-26/ring-i3/rumble/LANDING_PACKET_RUMBLE.md`). These are lane I-3's
**MQ1-MQ4**; they are not Campaign 12's MQ2 (the eclipse deck interval of `R-2026-09-19-16`), which stays open with
the maintainer.

### S-1 — MQ1, the march budget on large canvases: (a) accept as landed, with the canvas range in the acceptance

**Question.** The budget of `C13-N69` reduces the default cinematic tier (tier 3, native 96/8; "high", or the default
"auto" at or below 50 km, with no dial) on canvases above **5,859,375 px** with the bake resident: 3024 × 1964 → 94
steps, **3840 × 2160 → 67**, 5K → 38. That is a default change on large displays, raised by the adversarial verifier
(Robin, attack 6) and carried by the lane.

**The options and the resolution, verbatim from the source sheet:**

> Options: (a) accept with the canvas range written into the acceptance (<= 5,859,375 px) — LANE RECOMMENDS until a
> baked frame above R0 is measured; (b) add a 4K baked arm to a later leg and raise the baked side only if it completes
> with margin; (c) re-derive now with W=4, B=2.7e10 (4K inside x1.41; 5K still -> 76; R2 outside x1.43) — costs: no
> baked frame above 9.66e9 measured to complete, and Astra's native multi-deck 96/8 hang at 1080p (1.43e10 baked,
> confounded) would count INSIDE. Robin v2 computes whether any parameterisation keeps 4K inside AND that hang + R2
> outside.

> MQ1 update (seat, after Robin v2 + the ruled E4): the lane's option (c) cost ("Astra's 1080p multi-deck hang would sit
> inside") is not a base-law fact - the ruled E4 measured BASE completing 1080p multi-deck ground and flight at 96/8.

> Seat-computed option (d): W=3, B=2.0e10 -> every measured base survivor inside (R0 ×2.07, 1080p multi-deck ×1.40, 4K
> single-deck ×1.047), every measured base hang outside ×1.45, 5K -> ~57 steps.

> Options (c) and (d) would keep a measured base hang inside the budget and are withdrawn as unsound; (a) "accept as
> landed, with the canvas range (<= 5,859,375 px unbudgeted) written into the acceptance" is the only sound option and
> the seat lands I-3 on it. Fallback recorded: (b) a later leg may raise the baked side only if a larger baked frame
> completes with margin.

**Decided: (a)** — accept as landed, with "≤ 5,859,375 canvas px unbudgeted, with the bake resident" written into the
acceptance. **Receipt that decided it:** the budget leg's arm (vii),
`Tools/visual-regression/output/wave-end/c13-n69-e4-budget-20260926/README.md` — a **3840 × 2160 single-deck tier-3
96/8 frame with no budget lost the device at base** (`DXGI_ERROR_DEVICE_HUNG`, warm frame index 4; one run) and
**completed budgeted to 67/8** on the same machine. Budgeting the 4K default is therefore a fix of a measured base
hang, not a change to a working default. **What (a) also costs:** the opt-in 1080p multi-deck ground and flight
frames (≈1.43e10 baked), which completed at base in E4's arm (a), run budgeted to 90 steps (outside × 1.062; Robin's
second pass, `cesium-webgpu-worker-archive/lanes-2026-09-26/ring-i3/robin-v2/VERIFY_ROBIN_V2.md`), so a measured
survivor is budgeted here as well as under S-2.

**Fallback (sound, not taken): (b)** — a later leg raises the baked side of the budget only if a larger baked frame
**completes with margin** on the tree that would land it; cost: a hang-class leg under the hang protocol.

**Withdrawn as unsound after the measurement:** **(c)** re-derive with W = 4, B ≈ 2.7e10 (4K inside × 1.41), and the
seat-computed **(d)** W = 3, B = 2.0e10 (every measured survivor inside, every measured base hang outside × 1.45, 4K
single-deck inside × 1.047). Both would put the 4K single-deck baked frame **inside** the budget, and arm (vii)
measured that frame hanging at base.

### S-2 — MQ2, raw `cloudQuality` 128 at 2048²: (a) accept that a measured survivor is budgeted (128 → 67)

**Question.** Raw 128 × 8 with live noise at 2048² completed in Leg 1, yet the budget reduces it to 67, because the
live weight that excludes R2 (the same tier-3 frame with live noise, which hung) also excludes it.

**The options and the resolution, verbatim from the source sheet:**

> MQ2 raw 128 at 2048² (a measured survivor) is budgeted 128 -> 67: (a) accept (LANE RECOMMENDS; the data cannot
> separate why R2 hung and raw 128 did not); (b) re-derive after E4 Arm D separates jitter/erosion.

> MQ2: (a) accept (raw 128 budgeted 128 -> 67; re-derive after Arm D separates jitter/erosion - today's R6 shows
> erosion does not move the ring; jitter R1 PRESENT).

The fallback below narrows (b) to the hang, because Arm D measured the ring.

**Decided: (a)**, as the lane recommended: the data cannot separate why R2 hung and raw 128 did not (jitter, erosion,
the tier path, session state or chance — each point was observed once), so the budget stays on the conservative side.
**Receipts:** the lane's derivation (packet §2, the R0/R2 one-axis pair) and the budget leg's **GATE 2** (raw 128
budgeted to 67 with `budgetApplied` true, and completed). The same leg's Arm D measured the **ring**, not the hang: at
96/8 the ring family stayed PRESENT with erosion 0.10 (R6), and every row with live noise ran budgeted at 67 steps.
The jitter-cleared row R1 (PRESENT) is the I-5 leg's, on the other driver
(`Tools/visual-regression/output/wave-end/ring-i5-leg-20260926/README.md`; the two drivers' ring figures are compared
only with their clocks stated, `DEFERRED_WORK.md` `DX-PROBE-PAGERUNARM-SETTLE-RENDERS-AT-NOW`). So no measurement yet
separates jitter or erosion from the hang.

**Fallback, OPEN (sound, not taken): (b)** — re-derive the live weight once an arm separates jitter and erosion **for
the hang** (a live-noise row that is not budgeted, run under the hang protocol); cost: a hang-class leg, and a raw-128
default that may move again.

### S-3 — MQ4, the cost of the cloud-aware god-ray mask pass: (a) cost it as a full march

**Question.** Cloud-aware god rays (opt-in) re-run the march at full canvas for the transmittance mask. Whether the
compiler strips the mask's unused light march is unmeasured.

**The options and the resolution, verbatim from the source sheet:**

> MQ4 mask-pass cost: cloud-aware god rays (opt-in) re-run the march at full canvas. (a) cost as a full march (as
> landed; conservative; tier 3 at 2048² with god rays -> 67) — LANE RECOMMENDS; (b) density-only (one tap per interval)
> if the compiler strips the unused light march — measure first.

> MQ4: (a) cost the mask pass as a full march (conservative); (b) measure later.

**Decided: (a)**, as landed: cost the mask pass as a full march (conservative; tier 3 at 2048² with god rays → 67,
at 1080p unchanged at 96). **Basis:** no measurement exists either way — the budget leg ran with `godRayCloudAware`
false, and the verifier notes that no leg has yet exercised the mask hand-off on a device (Robin v2, N-DEVICE) — so the
decision is the conservative default, taken on the absence of a measurement, not on one.

**Fallback, OPEN (sound, not taken): (b)** — cost it as density-only (one tap per interval), **only after** a god-ray
arm measures the mask pass with and without the mask; cost: one more Edge arm, and the risk that the cheaper model
under-costs a real frame.

### S-4 — MQ3, how the ruled E4 ran: two jobs, the ruled A/B first

**Reconciled at 08:32.** `R-2026-09-26-9` (D9a) ruled an E4 with arm (b), base plus the frozen Astra patch built at
`b263d8ac5e`, and a single-deck arm; the lane's own brief had carried a different E4 (T0/T1 around its patch). The seat
ran **the ruled E4 as its own job** (executor Pearl) and the lane's budget leg as a second job (executor Cottar).
**Receipt:** `Tools/visual-regression/output/wave-end/c13-n69-e4-astra-ab-20260926/README.md` — its base tree
`37c0f8767e` has `packages/` byte-equal to the ruled `b263d8ac5e` (`git diff --stat` empty), so arm (a) is the ruled
base; arm (b) applied the I-2 patch (`roac.patch`, Tools-only and engine-neutral) and Astra's patch there; the
single-deck arm ran on both. **Not run:** the landing plan's arm (c),
U3's step bounds reverted, which was not in the brief. **Fallback:** run arm (c) in a later leg if Astra's return
needs to separate U3 from the rest of the stack; the D9b owner of `C13-N13` takes U3 as input either way.

### S-5 — every comment batch that edits a shader file carries a named Edge leg

**Decided:** `C16-B5a`, `C16-B5b`, `C16-B6` and `C16-B6-sky` each carry a named Edge leg whose scenes turn on a textured
fabric material (BumpMap), shadows received by per-instance-colour primitives and WebGPU OIT. This is a **new seat
decision**, seeded by and wider than the conditional fallback written inside `R-2026-09-26-20` (G8 A: *"If neither G10
option is taken, B6 and B6-sky each need a WebGL leg …"*). That fallback named only B6 and B6-sky and a WebGL leg on
the unminified dev build, and its trigger did not fire — G10 option A′ was taken and has landed. This decision adds
B5a and B5b, names the scenes (including WebGPU OIT), and overrides the ruled "No Edge slot is used" for those four
batches. **Basis:** the adversarial
verifier refuted each of B0-tools' first three versions with pairs the gate had certified (classes A-I, R1-R9, N1-N7),
and the landed v4 fails closed but documents readers it still cannot model
(`cesium-webgpu-worker-archive/lanes-2026-09-26/c16-b0-tools/wilimar-v2-v3/VERIFY_WILIMAR_V3.md`;
`…/hilda-v4/LANDING_PACKET_HILDA.md` §v4). The JS/TS batches B1-B4 and the Tools batch B7 keep the ruled no-Edge rule.
**Fallback:** `R-2026-09-26-20` as ruled — no Edge slot while U1a-U1e are in force; cost: a shader comment edit that
reaches a reader the gate cannot model lands without a rendering check. Recorded in `QUEUE_2026-08-10_CAMPAIGN16.md`
below the tail table.

### S-6 — B0-tools' fourth pass was its last

**Decided:** v4 of `C16-B0-tools` is the final pass; where the tool cannot model a reader it fails closed, and what
it still cannot see is written into `ForkCommentStandard.md` §8 as known limits and into `DEFERRED_WORK.md` as
`C16-COMMENT-GATE-UNMODELLED-SHADER-TEXT-READERS`. **Basis:** the lead's own re-run of the three verification passes' probes,
in which v4 refuses every refuting pair, with 22 mutants red and none surviving
(`cesium-webgpu-worker-archive/lanes-2026-09-26/c16-b0-tools/hilda-v4/LANDING_PACKET_HILDA.md` §v4; landed as Batch
1545). v4 itself was not re-reviewed or re-verified; this decision is what made it the last pass. **Fallback:** a fifth verification pass before
the first shader comment batch; cost: calendar time, with S-5's Edge legs already covering what the gate cannot see.

### S-7 — W2-L11 round 6: the bar it was judged on, and its behaviour changes

**Decided (on the lead's R6.4):** round 6 was judged against three conditions instead of literally identical
decisions across engines — (1) no leak in either engine, (2) no realistic drop, (3) every divergent decision
classified — and its behaviour changes (a)-(d) were accepted: (a) `file:///C:/a → file://evil.invalid/share/x` now
drops; (b) an http(s) parent drops its credentials for a derived `data:`/`mailto:`/`file:///`/opaque-path url; (c) a
protocol-relative endpoint plus an absolute `https:` url on an `http` page gets no token; (d) a self-hosted relative
endpoint now gets its token for derived urls in a browser. The ion token now requires the url's **scheme** to match
the endpoint's, which closes `DEFERRED_WORK.md` `DX-ION-TOKEN-COMPARISON-IGNORES-THE-SCHEME` — a row that had named
this a maintainer call. The FINAL (with Firefoot's F-1 folded in) landed rather than the reviewed r1. **Receipt:**
`Tools/visual-regression/output/wave-end/ci-wave2-l11-r6-20260926/E1/README.md` and
`…/E1/06-DIVERGENCE-CLASSIFICATION.md` — 0 leaks in Chromium (80,582 sends) and Node (87,885), 0 realistic drops, all
10,343 divergences classified (class W 0). **Fallbacks (sound, not taken):** keep hostless urls as `undefined`
(reopens the Chromium `file:///` → `https` divergence); allow an `http` → `https` upgrade on the page-relative arm;
restore the scheme-blind ion comparison (upstream's semantic; cost: the bearer token travels in cleartext to an
`http:` url under an `https:` endpoint); land r1 and carry F-1 as its own batch (Firefoot's option; cost: the F-1 leak,
91 per https page in Firefoot's corpus, stays open for a batch). Source:
`cesium-webgpu-worker-archive/lanes-2026-09-26/w2-l11-r6/arod/LANDING_PACKET_AROD.md` R6.3, R6.4 and R6.9.

### S-8 — the ring plan's questions Q1-Q5: taken on the plan's recommendations

*Appended by record round 9 (lead Gamwich, Opus 5.5).* Record round 8 listed Q1-Q5 as still open; the ring-ledger lane
(Batch 1548) placed the decision in the rows it moves and one rider in `DEFERRED_WORK.md`'s "Ring questions still open to
the maintainer", and left S-8 itself to be entered here. **Basis:** the maintainer asked the seat to handle the ring items
itself; the decision takes the plan's own recommendations and names no measurement.

**The decision, verbatim from the seat's source sheet**
(`cesium-webgpu-worker-archive/lanes-2026-09-26/rulings-source/rulings-source-2026-09-26-after-s8.md`, md5
`c52b2177c0fec82a3445fe1bd0a015a0`):

> S-8 (seat, 2026-09-26 after closeout): ring Q1-Q5 taken on RING_NEXT_STEPS §5 recommendations (Q1 (d) then (c); Q2
> (b); Q3 executed by 1546; Q4 (a) with riders W-8..W-10; Q5 executed, I-1 next) - the maintainer asked the seat to
> handle the two non-disk items before space weather; options recorded verbatim in RING_NEXT_STEPS §5 (banked with the
> ring-plan folder by the ledger lane); reversible before the ring-ledger batch lands.

**The options, verbatim from the ring plan** (`cesium-webgpu-worker-archive/lanes-2026-09-19/ring-plan/RING_NEXT_STEPS.md`
§5; each option's own sentence, the plan's supporting prose left there):

- **Q1** (`R-2026-09-18-3` promoted `C13-N13` on a refuted premise): "(a) Move the promotion to `C13-N60`." — "(b) Leave
  the promotion on `C13-N13`. Not supported by any measurement." — "(c) Move it to a new row that owns the tip's
  off-axis family." — "(d) Suspend the promotion until Leg 2 names the anchor, and meanwhile run I-5 (the missing
  realization override) as the next engine work". Plan: "(d), then (c) with the anchor measured."
- **Q2** (an image witness for `C13-N60`): "(a) Tree bisect" — "(b) Occlusion witness (§4.1 A6): one arm at the tip that
  puts geometry in front of the deck." — "(c) No image witness: fix the precision defect on source evidence alone, as
  `C13-N62` proposes (HiZ occlusion first)." Plan: "(b) inside Leg 2, then (c)."
- **Q3** (the GPU hang): "(a) File and clamp without re-triggering" — "(b) Re-trigger at 512² first" — "(c) Re-trigger
  at 2048²" ("not a sound option"). Plan: "(a), with (b) only if the maintainer wants reproducibility on the record."
- **Q4** (the ledger corrections): "(a) Land now" — "(b) Hold everything until Leg 2 reports." Plan: "(a)."
- **Q5** (which instrument lane first): "I-2 and I-5 in parallel (different files, different classes), I-1 next, I-3
  with I-5 … I-4 optional."

**Executed, as measured:** Q3 by `C13-N69` (Batch 1546); Q4 (a) by the ring ledger with W-1…W-10 (Batch 1548); Q5 by
I-2, I-5 and I-3 (Batches 1541, 1543, 1546) and then I-1 (Batch 1559); Q2 (b) by arm A6 of Edge Leg 2 — the cut is
established and its attribution to the clamp is not (`DEFERRED_WORK.md` `C13-N60`, "Edge Leg 2 appendix"); Q1 (d) — Leg 2
**did not name the anchor**, so the promotion stays suspended and the (c) row is not minted (`C13-N13`). The sheet's
"reversible before the ring-ledger batch lands" has passed with Batch 1548; the maintainer may still reverse, and a
reversal starts from the fallbacks.

**Fallbacks (sound, not taken):** Q1 (a) — move the promotion to `C13-N60`, landing with the W-8…W-10 riders; cost: no
image witness at the tip, and an acceptance written against a baseline the tip no longer shows (W-10). Q1 (c) alone — a
new row now; cost: a symptom with no anchor. Q2 (a) — a tree bisect, worth paying for only if an arm shows the clamp live
and bound; Q2 (c) — the fix on source evidence, `C13-N62`'s HiZ reader first. Q3 (b) — a 512² re-trigger, for
reproducibility on the record. **Offered, but unsupported by the plan itself:** Q1 (b) ("Not supported by any
measurement"). **Not offered:** Q3 (c), "not a sound option" (a system-level TDR on the maintainer's machine).

### S-9 — CI wave-2 Q4, the three environment rows on `coverage`: (a), truthful capability skips

*Appended by record round 9.* **Basis:** the plan's recommendation, as implemented and reviewed (W2-L8, Batch 1549). The
decision, its options and its fallbacks, verbatim from the seat's source sheet
(`cesium-webgpu-worker-archive/lanes-2026-09-26/rulings-source/rulings-source-2026-09-26-after-s10.md`, md5
`d69d6e033e2bb960c9a70b889e0956dd`, "Seat decisions S-9 and S-10 (2026-09-26 13:31 EDT)"; the options are the plan's,
`cesium-webgpu-worker-archive/lanes-2026-09-19/ci-triage-wave2/CI_WAVE2_PLAN.md` §Q4):

> **S-9 = CI wave-2 Q4 (the three ENV rows on `coverage`): option (a), as implemented by W2-L8 (Lumpkin; Rushey LAND).** Options verbatim from the plan: (a) "RECOMMENDED — truthful capability skips. A guard that records a reason and a roster, modelled on the existing WebGPU lane (`Specs/webgpuPolicy.js`, whose `describeRequiresWebGPU` at `:242` already does exactly this, and whose own docstring at `:30-38` explains why an *invisible* skip is the thing to avoid). The WebGPU row can use that helper today; the real-WebGL rows need a sibling. Cost: three specs stop asserting on `coverage` and keep asserting everywhere a context exists." (b) "Try to make Firefox headless produce a WebGL context on the runner (software GL / env flags). Unmeasured, possibly cheap, and strictly better if it works — but it is an experiment, not a lane, and it cannot be verified from this machine." (c) "Move `coverage` to Chrome. Clears all three and loses both the second-engine and (unless replaced) the debug-build signal that wave-1 Q3 deliberately kept." Plan: "(a) now, with (b) as a tracked experiment. Explicitly *not* (c)." Fallbacks kept on the record: (b) as the tracked experiment (the W2-L8 packet's Row B files it); (c) only if the maintainer gives up the second-engine signal. Lane deviation, recorded: row 2 cannot use `describeRequiresWebGPU` (it skips under every `--webgl-stub` run, including the Edge gate legs, and would enrol a fake-device spec in the Scene lane's ledger), so the helper reuses `isWebGPUAvailable` directly (Rushey confirmed at `webgpuPolicy.js:249-250`).

**Executed:** Batch 1549 (W2-L8); the karma leg measured 71/1 → 71/0 in debug with the capability summary executing 2
and skipping 0 on Edge; the tracked experiment (b) is `DEFERRED_WORK.md` `CI-COVERAGE-FIREFOX-NO-WEBGL-CONTEXT`.

### S-10 — CI wave-2 Q6, the four `createAsync` rollback specs: (c), per spec

*Appended by record round 9.* **Basis:** the plan's recommendation, as implemented and reviewed (W2-L6 v2, Batch 1555).
Verbatim from the same sheet (the options are the plan's §Q6):

> **S-10 = CI wave-2 Q6 (the four `createAsync` rollback specs): option (c), as implemented by W2-L6 v2 (Varda; Aule LAND-WITH-FIXES, F1 applied).** Options verbatim: (a) "Gate them on the build-flavour flag. Cheapest. Cost stated plainly: the transactional-rollback contract — the code that runs when construction fails in production — is then asserted only in debug." (b) "Drive the rollback with a failure that exists in both flavours (e.g. through the `CesiumWidget._createAsyncContext` spy `ViewerSpec.js` already installs at `:565`). Keeps real release coverage; more work per spec, and for `Scene/Scene constructor` there may be no non-pragma trigger at all, because `options._constructionFailureForSpecs` is a debug-only *test hook* by design." (c) "RECOMMENDED — per spec, (b) where a non-pragma trigger exists, (a) where the only trigger is a debug-only hook, with a dated tracked row naming which contracts are debug-only. W2-L6's packet must carry that table, one row per spec." As implemented after Aule F1: rows 1, 2, 4 and 5 take route (b) (a spy on a construction step both flavours run; each spec asserts from `window.specsUsingRelease` which route fired); row 3 (terrain conflict) has no release trigger and is skipped in release with `pending()` plus a karma INFO reason line = route (a) with the honest-skip marker; row 6 uses neither. Aule S1: a maintainer ruling of (a) or (c) accepts the patch either way. Fallbacks: (a) wholesale (all four debug-only, cheaper); (b) wholesale (needs a Scene-constructor trigger that does not exist).

**Executed:** Batch 1555 (W2-L6); the karma leg measured release 189/6 → 189/0 and debug 189/0 → 189/0, with both mutants
red. **As landed, v2 took route (b) for every row the plan put in scope** — Aule's F1 found a release trigger for row 3
(`Scene.prototype.setTerrain`), so no row ended debug-only and the lane withdrew its debug-only row (R1); the sheet's
description of row 3 as skipped in release is the pre-F1 state (`cesium-webgpu-worker-archive/lanes-2026-09-26/tranche2-varda/LANDING_PACKET_VARDA.md`
§v2). The decision stands as (c), which permits either route per spec.

### S-11 — W2-L4 and W2-L13 landed although the karma job returned them, on the measured basis

*Appended by record round 9.* **Question.** The tranche-2 karma job returned two lanes whose measured counts differed from
their predictions: W2-L4's debug BEFORE read 66/8 against 7 predicted (and one AFTER run 66/2), and W2-L13's whole-suite
runs read 22/1-22/3 against 22/0. **Basis — the receipt**
(`Tools/visual-regression/output/wave-end/ci-wave2-tranche2-karma-20260926/README.md`): W2-L4's extra failure,
`Scene/PostProcessStage can use a texture uniform` timing out at 5,000 ms, appears on the **unpatched** tree in 2 of 2
debug runs; W2-L13's whole-suite counts vary between runs on **both** trees, and the mismatch reproduces on the
unpatched tree, while its single, pair and engine-mutant legs read as predicted in count. **The decision, verbatim from
both landing messages (Batches 1556 and 1557):** "Seat decision
S-11: landed on that basis; the maintainer may reverse." The seat's sheet records no option list for S-11, so the
fallback below is this record's statement of the alternative, not a quotation. **Fallback:** hold both lanes until the
two flakes are isolated (`DEFERRED_WORK.md` `DX-KARMA-POSTPROCESSSTAGE-TEXTURE-UNIFORM-DEBUG-TIMEOUT` and
`DX-KARMA-GLOBESURFACETILE-WHOLE-SUITE-COUNTS-VARY`); cost: W2-L4's six rows and W2-L13's one stay red in CI
meanwhile. **Measured after landing:** hosted CI at Batch 1557 reads `release-tests` 1 FAILED — W2-L4's `EntityCluster`
row, red on the engine defect the lane filed, as its packet predicted — and `coverage` 2 FAILED (that row and a W2-L11
spec); none of W2-L4's other six rows or W2-L13's row is among the failures in either job (`DEFERRED_WORK.md` record round 9, "Hosted CI
after tranche 2").

### Executed since the sitting (record round 8)

- `R-2026-09-26-5` (T1): **executed** — Batch 1544 (`4f5cf1c21d`), after its karma leg E2.
- `R-2026-09-26-9` (D9): **D9a executed** — I-3's budget landed as Batch 1546 (`861967188c`), closed on its leg, after
  I-5's debug override (Batch 1543, `090dc1cdec`), and the ruled E4 is **done** (S-4). D9a's order (E4 before the
  edit to `resolveCloudPreset`) was met in substance rather than in letter: I-5 had landed at 07:23 EDT, and E4 ran at
  08:32-09:14 EDT on a base tree whose `packages/` equal `b263d8ac5e`'s, before I-3 landed; **D9c holds** — no public
  sample-count dial has landed; **D9b** (the `C13-N13` march law) has not started.
- `R-2026-09-26-22` (G10 A′): **executed** — `C16-B0-tools`, Batch 1545 (`0d3bb132cc`).
- `R-2026-09-26-20` (G8 A): **executing** — B0-tools has landed, B1 is next, and S-5 applies to the shader batches.
- `R-2026-09-26-1` (D1): Phase 1 **in progress** — `angrim` (Batch 1542), T1, I-5 and I-3 landed; `pimpernel-ledger`
  HELD; ring Leg 2 partial; the Astra wave stays HELD pending P2, with E4's single-deck regression named.

### Executed since record round 8 (record round 9)

- `R-2026-09-26-1` (D1): Phase 1 **still in progress** — `pimpernel-ledger` landed as the ring ledger (Batch 1548,
  `ce7bf229ba`); ring Edge Leg 2 ran all its arms and its offline checks followed, and it did **not** name the anchor;
  I-1 landed (Batch 1559, `e578eb6a95`). **P1.6** (`C13-N60`, `N61` and `N13` in one-owner order) has **not started**,
  so P2 — Astra's rebase onto the post-Phase-1 tip — has no tip to name yet (`ASTRA_LANDING_PLAN_2026-09-26.md`, live
  state).
- S-8 executed as recorded under S-8 above; S-9 and S-10 executed by Batches 1549 and 1555; S-11 applied to Batches 1556
  and 1557.
- CI wave 2, tranche 2 (Batches 1549-1557): hosted `release-tests` 45 FAILED plus the `ERROR` banner → **1 FAILED**, and
  `coverage` 39 → **2 FAILED**, runs `36257727602` → `36272051552` (`DEFERRED_WORK.md` record round 9).

### Still open with the maintainer

~~The ring plan's questions **Q1-Q5** (options recorded in `DEFERRED_WORK.md`, record round 8, "Ring questions still
open to the maintainer");~~ *[Record round 9: the ring plan's questions Q1-Q5 were **taken as seat decision S-8,
2026-09-26** (above); the maintainer may reverse.]* the OPEN fallbacks of S-2 and S-3 above; Campaign 12's MQ2; the
`update-tokens` workflow question; the CI wave-1 questions, and the CI wave-2 questions other than Q2 and Q8 (taken by
the seat as routine engineering) and Q4 and Q6 (S-9, S-10); and the three `R-2026-09-19-8`/`-9`/`-10` sittings.

**Raised or re-raised since record round 8 (record round 9), each with the options as the seat set them:**

- **Confirm or reverse S-1 … S-11.** Every seat decision above is the maintainer's to reverse; a reversal starts from the
  fallback it names.
- **The `C13-N22` LOOK unlock trigger.** `R-2026-09-18-4` unlocks the LOOK "once `C13-N13` lands"; after Edge Leg 1 the
  row that should unlock it is under-determined, and Edge Leg 2 did not settle it (`DEFERRED_WORK.md` `C13-N13`, unlock
  rider). Options: (a) keep the trigger on `C13-N13`; (b) move it to the row a ring leg names as owning the tip's family;
  (c) make it a measurement — lane I-1's `ringFamily` reading ABSENT on the tip at the recipe camera.
- **Ring Leg 3.** A proposal, not dispatched: one Edge job with I-1's `ringFamily` as the only instrument and every
  window pre-registered; the seat recommends running it now that I-1 has landed
  (`cesium-webgpu-worker-archive/lanes-2026-09-26/ring-leg3-proposal/brief-ring-leg3-proposal.md`).
- **An owner for `NEW-BULK-VISUALIZER-CLUSTER-TOGGLE`** — the `EntityCluster` engine defect, the only red left in hosted
  `release-tests` and one of two in `coverage` (`DEFERRED_WORK.md` record round 9).
- **The worker naming convention.** The Tolkien name pool has run out twice; the seat's reading of `R-2026-09-26-23`
  (below) extends it to Tolkien place names for the probe-kit harvest wave unless the maintainer names another scheme.
- **Astra's `POST_PHASE1_SHA`** — the tip Astra rebases onto for P2 — waits on P1.6, which has not started (above).
- **The tidewater questions MQ-T1 … MQ-T4** are recorded in the next section and are unchanged.

---

## Open maintainer questions raised by the tidewater intake (MQ-T1 … MQ-T4) — recorded, not ruled

Recorded 2026-09-26 by the tidewater intake lane. **No ruling is taken or implied.** The maintainer's instruction
the intake executes, verbatim: *"As all of the reviews return on the tidewater demo, add the useful tech to our
already open campaigns, this includes any cloud improvements to campaign 13."* The four questions below are quoted
verbatim from the seat's intake plan, §3 (banked at
`cesium-webgpu-worker-archive/lanes-2026-09-26/tidewater-review/INTAKE_PLAN.md`). The rows they gate carry the
question id: `DEFERRED_WORK.md` "2026-09-26 — Tidewater intake" (MQ-T1, MQ-T3, MQ-T4), the `C6-FFT-OCEAN`
riders and `C14_READINESS_REVIEW_2026-08-28.md` §4 `C14-09`…`C14-15` (MQ-T2).

- **MQ-T1 — home for the post-chain and lighting items** (haze/aerial deficit composite, GTAO, TAAU, motion blur, lens flare, ground bounce): attach to C11 (scale/parity), to the proposed C17 (celestial light transport), or open a "Post & effects" bucket. Seat recommendation: C11 rows for CSM/lighting, a new unnumbered "post chain" list under Wave DX's shape for the rest, until a campaign claims them.
- **MQ-T2 — C14 launch.** The tidewater ocean stack is a working reference for C14 W3 and could shorten it materially. R1 holds C14 behind C12 completion (`C13-41`). Options: keep R1 (intake stays pre-launch), or lift R1 for the C13-independent phases W0–W2 + the FFT compute work (the plan's own §6 decision 5 already contemplated an earlier launch of C13-independent phases; O5 ruled against it, R1 later relaxed O5). Seat recommendation: keep R1 as ruled, file the reference rows now, and revisit when `C13-41` returns.
- **MQ-T3 — bathymetry dataset lane** (GEBCO): approve as a C14 W0 prerequisite or defer; it is the gate for the depth-keyed half of the water stack.
- **MQ-T4 — underwater camera:** is a submerged globe camera ever in scope? If not, T6/T7 are "do not take" and the intake files them as reference only.

**Also raised by the review's syntheses, not in the intake plan's §3, and recorded in the rows that need them (no
ruling):** MQ-T5, adopting `webgpu` (Dawn) as a devDependency (`NEW-TIDEWATER-DAWN-KERNEL-RUNNER`); a clock ruling on
persistent foam history against the scene-time sea (`C14-11`); look rulings on the three three.js changes
(`C11-218`, `C11-219`, `C11-220`); and three.js r183's compatibility-mode request (#32762) against our
`featureLevel: "core"` default, which has no row.

---

## R-2026-09-26-23 — visual evidence of progress for each lane; the probe-kit harvest is the next programme

*Recorded by record round 9 (lead Gamwich, Opus 5.5).* A maintainer direction given at 19:40 EDT, after the sitting; the
id is the seat's, the words are the maintainer's, verbatim from the seat's source sheet
(`cesium-webgpu-worker-archive/lanes-2026-09-26/rulings-source/rulings-source-2026-09-26-after-s10.md`, md5
`d69d6e033e2bb960c9a70b889e0956dd`):

> "Lets get some visual evidence of progress for these when they are ready so that we can visually confirm progress.
> After those three wrap up lets move onto making our probes modular, componentized, and take much much much less time
> to build and use. We seriously spend FAR too much time building tests instead of having high quality reusable ones and
> using visual evidence of progress."

**The seat's reading, verbatim from the same sheet:**

> Seat reading: (1) I-1, C15-06 and record round 9 each deliver a visual artefact at wrap-up (I-1: calibration +
> synthetic + refusal contact sheet with the estimator's centre/period overlaid; C15-06: an Edge-rendered chart of the
> ingested RTSW/GOES series with the published activity scalar and flare state, from Pott's leg; record round 9: the day
> sheet of 2026-09-26). (2) The probe-kit harvest and retirement (`DX-108`, PROBE_KIT_PLAN_2026-09-17.md §6.3) launches
> immediately after, as the seat's sole program until the fleet is on the kit. (3) The Tolkien name pool is exhausted;
> the seat extends the convention to Tolkien PLACE names for the harvest wave unless the maintainer names another scheme.

**Executing:** I-1's contact sheet is banked
(`Tools/visual-regression/output/contact-sheets/2026-09-26/i1-ring-instrument/index.html`; `DEFERRED_WORK.md` record
round 9, "I-1's contact sheet"); record round 9's day sheet of 2026-09-26 is its packet's deliverable, beside the docs
patch; `C15-06`'s ingest chart and karma summary page were banked by its Edge leg before that sheet was built and are two
of its rows (the brief's body asks for them "if they exist by then"); its records ride a later round. Reading (3) is a maintainer question ("Still open with the maintainer", above).
