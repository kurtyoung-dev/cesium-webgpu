# Astra work audit — 2026-09-25

_Tracked 2026-09-26 with its two companions, [`ASTRA_AUDIT_DECISIONS_2026-09-26.md`](ASTRA_AUDIT_DECISIONS_2026-09-26.md) ("DECISIONS" below) and [`ASTRA_LANDING_PLAN_2026-09-26.md`](ASTRA_LANDING_PLAN_2026-09-26.md) ("LANDING_PLAN" below). **Ruled 2026-09-26, every decision as recommended: [`MAINTAINER_RULINGS_2026-09-26.md`](MAINTAINER_RULINGS_2026-09-26.md), `R-2026-09-26-1`…`-12`.** The reader reports R1–R5, the brief and the critique are banked at `cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/`. The text below is the audit as revised after critique; its "CANDIDATE" status and its tip references are its state when written._

_Subject: Astra's (Codex) solo cloud work of 2026-09-21 → 2026-09-25 in clone `cesium-astra-20260921`, frozen by the seat at
`cesium-webgpu-worker-archive/astra-checkpoint-20260925/`. Audited 2026-09-26 by a read-only workflow of five Opus 5.5 readers plus
one synthesiser, against base `a76d42b3f8` (Batch 1536)._

_Status: **CANDIDATE — nothing here is ruled.** §7 lists the decisions D1–D12. The companion `ASTRA_AUDIT_DECISIONS_2026-09-26.md` gives each one with only
the options the readers did not show to be unsafe. The companion `ASTRA_LANDING_PLAN_2026-09-26.md` is the plan if the recommendations are taken.
The critic pass (Felarof, `cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/CRITIQUE_FELAROF.md`) has run; §10 lists each of its findings and what this revision did with it.
Nothing lands before the maintainer rules._

**Synthesiser:** Asfaloth (Opus 5.5). **Seat:** Gandalf (Fable). **Written:** 2026-09-26 ~01:15 EDT (`date` at the seat:
**Saturday**, so no quiet hours; this audit commits nothing either way).
**Base:** `a76d42b3f8` (Batch 1536), the commit the patch is cumulative against; every `base <path>:<n>` cite is at that commit.
**Seat tip:** `b263d8ac5e` (Batch 1537, the rig-census fix, committed 01:28:04 EDT). The first draft of this audit named
`a76d42b3f8` as the tip, which was already stale when it was written (critic C11). Re-derived at `b263d8ac5e` in the revision (§10).
**Subject:** `astra-checkpoint-20260925/cloud-sparse-ab/cloud-all-current.patch`, md5 **`a23f4d79badcf956dd23bdf878bbf3f5`**. I
re-verified it with `md5sum`, and it matches `MANIFEST.md5:89`. It has **81 files, +8,324 / −2,149, and 28 of them are new**. R1,
R4 and R5 each re-derived those figures with `git apply --numstat`.

**Mode: read-only.** Nothing was committed, staged, stashed or checked out in any repository. The readers disclosed four side
effects, none of them to repository content:
- **R1** briefly created an empty file at the `%TEMP%` root and deleted it at once.
- **R2** ran one `git status --porcelain` on Astra's clone without `GIT_OPTIONAL_LOCKS=0`. That can refresh stat data in
  `.git/index`, but it changes no content, staging or worktree file.
- **R4** left its provisioned audit clone `F:/Dev/GH/cesium-lane-hasufel-20260926` behind. The patch is applied there and not
  committed, and R4's own eslint run dirtied `eslint.seatbelt.tsv` in it. The clone is disposable.
- **R3 and R5** removed their temp roots.

I created no temp root.

### Sources

The five reports are banked verbatim, with a `MANIFEST.md5`, under
`cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/` (a seat act, done 2026-09-26 after this audit was written).

| Id | Report | Reader | Subject |
|---|---|---|---|
| R1 | `R1_STRUCTURE_AND_RULES.md` | Thorondor | unit ledger U1–U37; registry, uniform, parity, size, log and comment rules; formatting |
| R2 | `R2_CLAIMS_VS_RECEIPTS.md` | Shadowfax | every Astra claim against its receipt; the sparse A/B; which tree each number was measured on |
| R3 | `R3_ENGINE_RISK.md` | Snowmane | default-path hunks, naga validation of composed WGSL, TaskProcessor, public API |
| R4 | `R4_TESTS_AND_GATES.md` | Hasufel | every runner before and after, in one provisioned clone; pre-commit simulation; call-site inertness mutants |
| R5 | `R5_COLLISIONS.md` | Windfola | file × owner matrix against the seat's queue, semantic collisions, landing order |

**Citation conventions:**
- `R<n> §x` or `R<n> <finding id>` — a reader report.
- `P:<n>` — a line of the frozen patch.
- `base <path>:<n>` — `git show a76d42b3f8:<path>`.
- `astra <path>:<n>` — the file in Astra's clone. R5 proved the clone's 81 files equal base plus patch: 81/81 after line-ending
  normalisation.
- `CP:<n>` — a line of `ASTRA_SOLO_24H_CHECKPOINT_2026-09-25.md`.
- `RA:<n>` — a line of `ASTRA_RETURN_AUDIT_AND_CLOUD_PROGRESS_2026-09-21.md`. Both Astra docs are in the snapshot.
- **(re-derived here)** — a fact I re-ran myself in this pass.

### Live state, measured by me

```
first draft (01:15 EDT):
$ git rev-parse --short HEAD        a76d42b3f8   ← STALE: b263d8ac5e had landed at 01:28:04 (C11)
revision (02:05 EDT, re-derived):
$ git log -1 --format='%h %cd'      b263d8ac5e Sat Sep 26 01:28:04 2026 -0400   (Batch 1537)
$ git status --porcelain | wc -l    21          (the maintainer's held set — untouched)
$ git branch                        * main      (no other local branch)
$ md5sum cloud-all-current.patch    a23f4d79badcf956dd23bdf878bbf3f5
$ git apply --check <astra patch>                                 rc 0 at b263d8ac5e
$ git apply --check decomposition-doc.patch                       rc 0 at b263d8ac5e
$ md5sum worker-rejected-dispatch.patch                           c4016b889ec06d782c36a50f8888e449; --check rc 0 at b263d8ac5e
$ date                              Saturday 2026-09-26 02:05 EDT
```

**What Batch 1537 changes for this audit.** Its five files are the census patch's file set (`capture-seam.spec.mjs`,
`rig-registry.spec.mjs`, `Tools/wave-end-contact-sheet-index.spec.mjs`, `Tools/wave-end-gate-receipt.mjs`) plus one
`TOOLING_CATALOG.md` row. So the census fix has landed, and two frozen patches remain unlanded: `angrim.patch` (W2-L11) and
`pimpernel-ledger.patch`. I did not re-run `--check` on those two at `b263d8ac5e`; R5 measured them at `a76d42b3f8`, and 1537 touches
none of their files. The base counts R4 measured for `test-visual-regression-node` move, because 1537 edited
`rig-registry.spec.mjs`, the CRLF-sensitive spec R4 flagged.

**Branch transparency (CLAUDE.md, unprompted).** Only `main` exists locally, and this audit created no branch. The clones involved:
- `cesium-astra-20260921` is Astra's own. It has been at rest since 23:39 EDT on 09-25. The readers read it and did not write to it.
- `cesium-lane-hasufel-20260926` is R4's audit clone. It is disposable.
- `cesium-astra-20260914` and `cesium-astra-20260910` are older Astra clones. They were not examined here and are closeout
  candidates (LANDING_PLAN §7).

---

## 0. Executive summary

1. **What Astra delivered.**
   - **The patch.** 37 cloud units in one cumulative 81-file patch against the seat tip. R1 §1 numbers them U1–U37; Astra numbered
     none.
   - **The evidence packets.** R2 §6 counted them again from disk:
     - 35 packets dated 09-25, holding 395 PNG copies with 307 unique hashes, all at least 1280×720.
     - Two later sparse packets.
     - **Six** folders dated 09-21. The brief's "three" is wrong.
   - **Three items outside the patch:**
     - A `Core/TaskProcessor.js` race fix with a spec. It lives only in Astra's worktree and equals the seat packet
       `astra-return-audit-20260921/worker-rejected-dispatch.patch`.
     - A decomposition-log patch.
     - An edit to the seat-owned `eslint.seatbelt.tsv`, made in the clone only.
   - **All five readers corrected the brief independently.** `Core/TaskProcessor.js`, `eslint.seatbelt.tsv` and
     `ES6_MODERNIZATION_STATUS.md` are **not** among the 81 files (R1 §0, R2 §0.5, R3 §0, R4 §0, R5 §0). Re-derived here:
     `grep '^diff --git'` finds none of the three.
   - **If only the cumulative patch were taken, the TaskProcessor repair would be lost** (R2 §4).

2. **The rules the 2026-09-16 audit ruled on now hold.**
   - `ShaderDefineHi` is append-only: bits 6 and 7 are added and nothing is renumbered (R1 §2.1, R3 F11).
   - Slot 175 stays L4's `_padQ`. Pads 111, 146 and 147 stay free for C13-N60 (R1 §2.2).
   - L3's C13-N10 near-altitude band is kept, and AUTO_TEMPORAL is not re-landed (R1 §2.3).
   - `CLOUD_UNIFORM_FLOATS` is defined once, at 260 floats (R1 §2.2).
   - There is no `any` and no Scene → `Renderer/WebGPU` import (R1 §2.5–2.6).
   - C16 `--strict` reports 0 markers across 50 engine files (R1 §2.3, R4 §5).
   - The renderer shrank from 5,546 to 5,330 lines, and `ProceduralClouds.wgsl` from 3,363 to 3,056 (R1 §2.7).
   - **No public dial default moved.** All 14 new `CloudVolumetrics` dials default to off or to identity (R1 §1). The
     **documented semantics** of two existing dials do change: U3 rewrites the JSDoc of `cloudMarchStepGrowth` and
     `cloudMaxRayDistance` (P:7192–7214). Nine of the 14 dials remain once U37, U20b and the HOLD entry points are out (D2, D9c,
     D12).

3. **Nothing in the cumulative patch is landable now.** The reasons, heaviest first:
   - **(a) P0, an opt-in non-cloud feature.**
     - The patch declares `fn interleavedGradientNoise` in the shared chunk `CloudDensityDomain.wgsl` (P:7800).
     - The volumetric-fog compute source concatenates that chunk with `VolumetricFog.wgsl`, which already declares the same
       function (base `:538`).
     - **naga rejects the composed fog shader: "redefinition of `interleavedGradientNoise`"** (R3 F1, measured with the seat's
       naga-wasm; the base composition passes).
     - Re-derived here: both declarations exist, and the concatenation is at base `WebGPUVolumetricFogResources.ts:62`. The base
       comment directly above that line says the chunk "shares no symbol names with `VolumetricFog.wgsl`", and the patch breaks
       exactly that.
     - The guard that would catch it, `fog-cheap-coverage-gate.spec.mjs:415`, has **no runner home**. Re-derived here: `git grep`
       finds no `package.json` script for it. **[Done 2026-09-26: Batch 1538 homed it in `test-visual-regression-node`.]**
     - **Who gets the invalid shader module:** any WebGPU scene in which the fog renderer passes its early return. That happens
       when any of three switches is on (base `WebGPUVolumetricFogRenderer.ts:843–852`): `volumetricFog.enabled`,
       `effects.groundFog.enabled`, or `effects.auto` with humid air, because the auto path writes `groundFog.enabled` from the
       weather (base `AtmosphericEffects.ts:615–631`; the gate is `fog > 0.05` at `:466`). `effects.auto` defaults to `false`
       (base `AtmosphericConditions.js:1408`), so the population is opt-in, but it is three switches, not one (critic C12).
   - **(b) Gates.**
     - `test-cloud-c13` goes from **635 pass / 0 fail to 720 / 13** (R4 H2).
     - One of the 13 is a **module-load crash of `cloud-tier-single-source.spec.mjs`**. The crash silences all 35 of its tests,
       including L3's C13-N10 byte-identity acceptance, which R-2026-09-16-2 protects (R4 H1).
     - Quarantine failures go from 4 to **10** (R4 H5).
     - None of these test runners is wired into CI (R4 §3, R5 §1c). **But CI would not have stayed green:** `npm run
       prettier-check` (`prettier --check "**/*"`) is a CI step (`.github/workflows/dev.yml:27`, `prod.yml:32`), and 44 of the
       patch's files fail it (item c). The first draft said CI would have stayed green; that was wrong (critic C6).
     - **The red count is a lower bound.** Five runners whose specs read files Astra modified were never run on the patched tree:
       `test-engine-node`, `test-model-webgpu` (its `pipeline-key-aliasing` reads `WebGPUShaderDefines.ts`, whose private
       `hiDefineBit` Astra moved to a new module, P:6559/6575/12861), `test-readiness`, `test-s5` and `test-blend-parity`
       (critic C7). Nor were the CI steps `eslint` (frozen seatbelt), `test-webgpu-policy`, `collection-sentinels-check`,
       `test-c16` and `test-landing-rules`.
   - **(c) Formatting.** The pre-commit hook would rewrite 44 files, +5,821 / −1,877 lines, and the rewritten tree turns **7 more**
     assertions red. The bytes that landed would not be the bytes that were reviewed (R4 §4, R1 §2.12).
   - **(d) Proof bar.**
     - There is no independent reviewer and no named Edge leg (R-2026-09-16-5).
     - **4 of the 5 new specs survive a call-site inertness mutant.** Each feature can be made unreachable while its spec stays green
       (R4 H4, measured).
   - **(e) Defaults.** No public default moved, but **the default image moves in two populations, with no ruling** (R1 T3; R3 F2–F5;
     R4 H6):
     - users with an HDR display: the WebGPU sky, and the WebGL sky alpha;
     - users who enable clouds and set nothing else: march spacing, composite, billow envelope and the IGN scroll; and, **at
       camera heights of 100 km and above**, the physical aerial path (U1, U2, U4, U15). That last reach is settled from source
       (§2.2 U4 row; critic C3). The orbital ring rig is on it.
   - **(f) The failed sparse candidate is still in the patch** (item 5).

4. **What returns.**
   - **The stack goes back to Astra** for four things: remove the sparse candidate, apply the fixes, rebase, and re-cut into batches.
   - **When:** after the seat's own lanes that own the same hunks (R5 §3), following the R-2026-09-16-1 pattern:
     - I-5, then I-3 (C13-N69), on `WebGPUCloudTierPresets.ts`;
     - C13-N60, N61 and N13 on `ProceduralClouds.wgsl`.
   - **Per-unit verdicts (§2).** There are 39 rows, because U20 and U32 are split. The tally is **9 LAND · 21 LAND-AFTER-FIX · 8
     RETURN · 1 REJECT-AND-STRIP** (revised: U21 moved from LAND to LAND-AFTER-FIX, critic C2).
   - **The HOLD chain** (U23, U26, U29, U30) stays RETURN as features, but its plumbing runs on the default density and lighting
     path of units that are kept, so it needs its own ruling (D12).
   - **What "LAND" means here:** no fix specific to that unit is owed. Every unit still waits for its batch's common gates (§2.1).
   - **Closest to landable: the out-of-patch TaskProcessor fix.** It lands on its own Core proof bar, after W2-L11 (D5).

5. **The sparse candidate, judged by Astra's own restart rule.**
   - **The run.** The only measurement ever taken on the final stack is the sparse A/B `runtime-02`. R2 traced its bundle
     `a4b74c3a…` to exactly this patch generation: 82/82 source-manifest entries and 81/81 post-image blobs match.
   - **It FAILED Astra's own preregistered gates:**
     - Aggregate median reduction: **12.4 %** static-flight (159.947 → 140.085 ms) and **12.6 %** moving (159.689 → 139.624 ms),
       against a gate of ≥ 20 %.
     - Paired reduction: 12.1 % and 12.7 %.
     - p99 byte error: **28 and 25**, against ≤ 20.
     - Re-derived here from `runtime-02/result.json`: the top-level `"status"` is `"FAIL"`, and both cases fail on timing and on
       image.
   - **Gates that passed:** mean error, coverage loss, nonfinite, errors and device loss.
   - **The earlier 4×4 revision, `runtime-01`, failed as well** (R2 §1).
   - **Astra's rule (CP:83):** *"If it fails, preserve the evidence, remove only its authored implementation changes, and keep the
     append-only shader bit reserved."*
   - **Only the first step was done.** The evidence is preserved in the archive snapshot. The removal never happened.
   - **Neither A/B is recorded in either Astra doc.** The checkpoint's sparse section still says 4×4 tiles, says "GPU validation
     pending", and quotes bundle `1cd7dda8…`. The final patch contradicts all three (R2 §0.3–0.4).
   - **Verdict: REJECT-AND-STRIP, with a withdrawal record, and bit 7 reserved in writing (D2, D3).**
   - **Re-measurement is owed either way.** Stripping the candidate changes the generation, and **no retained percentage or image in
     the checkpoint was measured on the final tree** (R2 §5).

6. **Verdict.**
   - **Against the rules the maintainer ruled on,** this stack is better engineered than the 09-16 one.
   - **Much of it is real, receipt-backed progress** (R2 §2–§3):
     - irradiance reuse;
     - shader specialisation;
     - Worley pruning;
     - lighting-cache reuse;
     - empty-weather skipping, kept as an opt-in.
   - **It is not a landing candidate.** It:
     - breaks an opt-in non-cloud feature;
     - silences the one spec that carries L3's protected acceptance;
     - cannot survive the pre-commit formatter;
     - repeats the proof-bar, parity-record and seat-owned-file findings of 09-16 (X3, X5, X2);
     - carries an experiment its author's own rule says to remove;
     - moves the default image in two populations without a ruling.
   - **Every fix is bounded, and none needs a redesign.**

---

## 1. The stack as Astra states it

**Astra's framing, verbatim:**
> *"We made substantial lighting, rendering-correctness and performance progress, but the clouds are still far from flight-sim
> quality."* (CP:7)

> *"It remains unlanded and is not independently certified. … Do not interpret a passing unit test or medium-resolution capture as
> native/default-on acceptance."* (CP:9)

**What the checkpoint contains:**
- a 14-row "Retained work" table (CP:13–31);
- an 8-row performance table (CP:39–48);
- a "What failed" section (CP:69–79);
- **"Remaining work, in order"** (CP:81–89);
- restart instructions (CP:67, :83, :93);
- a sparse integration-pilot appendix (CP:101–105).

The return-audit doc (547 lines) holds the unit-by-unit history.

**The chain, in R1's unit ids.** The order and the timestamps are from R2 §5, which dates each packet by the copy time of its patch,
in UTC.

```
09-21  return audit: TaskProcessor [OUTSIDE PATCH] · U1 aerial finite segment · U2 dark-LUT placeholder
       → U3 bounded march (C13-N13) → U4 finite air → U5 layout module → U6 planetary light → U7 self-shadow
09-25  U8 colour/HDR → U9 ambient irradiance → U10 irradiance reuse → [projected detail — REJECTED, absent]
       → U11 billow → U12 scattering orders → U13 AO → U14 ground bounce → U15 neutral tone → U16 atmosphere MS
       → U17 cellular bake → U18 native temporal → U19 sky HDR → U20 density response + primary steps
       → U21 ray budget → U22 scene-linear → U23 layer shadows (HOLD) → U24 render stability → U25 lighting cache
       → U26 layer profiles (HOLD) → U27 zero-density exits → U28 Worley pruning → U29 peer cache → U30 layer MS
       → U31 directional ambient → U32 sampling/lighting cost (stripe gate FAILED, retained)
       → [log light arithmetic — REJECTED, absent] → U33 reflection-include repair [erosion precheck — REJECTED, absent]
       → U34 shader specialisation (hi bit 6) → U35 lighting reuse key → U36 empty weather
       → [distant local-shadow cache + 4× diagnostic — REJECTED, absent]
       → U37 sparse updates (hi bit 7): A/B runtime-01 FAIL, runtime-02 FAIL   ← HEAD of cloud-all-current.patch
```

**Every rejected experiment is absent from the final patch, checked by its identifiers** (R1 §1, R2 §3):
- projected detail;
- log light arithmetic;
- erosion precheck;
- the local-shadow cache;
- the 4× diagnostic, which was harness interception only.

**Astra's dispositions** (R1 §1):
- **RETAINED:** 32 units.
- **"HOLD, not ready to land", yet present in the patch:** U23 and U26.
- **Retained despite a failed gate:** U32.
- **Retained as an opt-in:** U36. Its cloudy-boundary timing FAILED.
- **Failed experiment, still present:** U37.

**"Remaining work, in order", quoted in full** (CP:81–89):
1. *"Validate or reject the saved sparse-update candidate. If it fails, preserve the evidence, remove only its authored
   implementation changes, and keep the append-only shader bit reserved."*
2. *"Budget lighting-cache refresh per frame and reuse unchanged spatial regions across camera motion. Reduce empty-weather overhead
   in occupied views. Move weather/clearance generation off the main thread and enforce total memory budgets."*
3. *"Finish coverage-preserving volumetric HLOD, impostors and transitions, with projected-size/detail sample allocation."*
4. *"Reduce shader startup stalls and resolve native 96/8 device loss."*
5. *"Resume visual work: resolve dense-view stripes, sharper/nonrepetitive cloud bodies, …"*
6. *"Complete lighting gaps after performance headroom: cloud shadows in atmospheric haze, full directional sky illumination, …
   Moon illumination."*
7. *"Procedural/live/historical weather, trade winds, … independent review, landing and default-on acceptance remain unfinished."*

**Composition, as measured.** R1 §0, R4 §0 and R5 §0 agree.

| Area | Files | New |
|---|---|---|
| `packages/engine/Source/Renderer/WebGPU/` | 35 | **18** (the brief said 17 but listed 18) |
| `packages/engine/Source/Shaders/WebGPU/` (WGSL) | 12 | 4 |
| `packages/engine/Source/Shaders/SkyAtmosphereFS.glsl` | 1 | 0 |
| `packages/engine/Source/Scene/` | 2 | 1 (`CloudType.d.ts`) |
| `Tools/visual-regression/` | 30 | 5. The other 25 are modified: 24 specs plus `probe-cloud-density-domain.mjs`. The brief said 26. |
| `package.json` | 1 | 0 |
| **Total** | **81** | **28** |

**Outside the patch:**
- **The TaskProcessor unit.** `Core/TaskProcessor.js` (+8) and `Tools/visual-regression/task-processor-error-path.spec.mjs` (+51).
  - It exists only in the clone's worktree.
  - It equals the seat packet `Tools/visual-regression/output/astra-return-audit-20260921/worker-rejected-dispatch.patch` once
    `index` lines are dropped (R1 §0).
  - R2 §0.5 confirms the match by blob: post-image `2aad1741…`, and the pre-image is the seat's base blob.
  - Astra itself says so: *"The cumulative patch supersedes previous cloud candidates; TaskProcessor stays separate."* (RA:134)
- **`eslint.seatbelt.tsv`.** Two rows, changed in the clone only.
- **`ES6_MODERNIZATION_STATUS.md`.** +51 lines, equal to `decomposition-doc.patch` (md5 `c362358e…`; R1 §0).
- **Astra's two docs.** They are untracked in the clone.

---

## 2. Per-unit verdicts

**Verdicts:**
- **LAND** — sound as it stands, and owes nothing beyond the batch's common set (§2.1).
- **LAND-AFTER-FIX** — owes a named, bounded fix or proof first.
- **RETURN** — waits on a maintainer ruling, on rework by the author, or on the author's own HOLD before it can be a candidate.
- **REJECT-AND-STRIP** — to be removed from the stack.

**No unit lands before its batch clears §2.1.**

**Default-path classes:**
- **INERT** — nothing runs unless a dial is set.
- **STRUCT** — a default-path refactor whose identical output is claimed but not proven on the final stack.
- **MOVES-C** — changes the default image or work for users who enable volumetric clouds and set nothing else.
- **MOVES-G** — changes the default image or work for users who never enable clouds.
- **HOLD** — held by the author.

### 2.1 The common set every batch owes

Each item below was measured as missing today.

- **C1 — Gates green.**
  - `test-cloud-c13` must return to 0 fail.
  - `test-cloud-c13-quarantine` is gated **by name, not by count**: its red set must be a subset of {`cloud-reconstruction-attachments`
    F1a, F1b, `cloud-shadow-rte:828`}. Base has 4 reds, but the patch turns the fourth (`cloud-observability-counters:674` D8)
    green, so a count gate of "≤ 4" would let one new red through (R4 §3.1 rows at :197–198; critic C8).
  - That means fixing the 13 + 6 reds, whose causes R4 §3.1 lists, plus the 7 reds that appear only after the formatter runs
    (R4 §4.1), plus whatever the runners nobody ran turn up (§0 item 3b; LANDING_PLAN §6 item 5).
- **C2 — Format first, then freeze.**
  - Run `prettier --write` over the 44 files, then re-pin the regexes that pinned the unformatted spelling.
  - Normalise line endings; `WebGPUShaderDefineBits.ts` mixes CRLF and LF.
  - Remove the 4 blank-line-at-EOF warnings.
  - The reviewed bytes must equal the landed bytes (R1 §2.12, R4 §4).
- **C3 — An independent Opus reviewer, plus one named two-tree Edge leg per batch.**
  - R-2026-09-16-5 requires both, and neither exists (R1 §2.3).
  - The adversarial verifier of R-2026-09-11-1 is recommended for the engine batches.
- **C4 — Parity recorded.**
  - Add rows to `DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` §C. The patch touches neither (R1 §2.4).
  - Every dial the batch adds needs "WebGPU only." and JSDoc. Today only 5 of the 14 dials say "WebGPU", and none has JSDoc
    (R1 §2.4, §2.9; R3 F10). R-2026-09-16-6 asks for "real dials with JSDoc".
- **C5 — Seat-owned lines returned as text** (R5 §3.9):
  - the `package.json` values;
  - the seatbelt, regenerated by the seat;
  - ES6 status rows with measured base → after line counts.
- **C6 — Re-measure on the landed generation.** Re-measure any number the batch message cites. None was measured on the final tree
  (R2 §5).
- **C7 — Build and variant smoke before landing.**
  - The stack adds 4 WGSL leaves and two new `.js` modules under `Renderer/WebGPU` that enter the generated index (R1 X7).
  - So: a seat `gulp build`, then `npm run tsc-engine`, then `node Tools/variant-smoke-test.mjs` (R1 §5.6).

### 2.2 The table

| # | Unit (packet under `Tools/visual-regression/output/`) | Class | Verdict | Unit-specific blocking finding / owed proof | Evidence |
|---|---|---|---|---|---|
| U1 | Aerial finite-segment repair (`astra-return-audit-20260921`) | **MOVES-C at ≥ 100 km** (physical path; see U4) | **LAND-AFTER-FIX** (rides U4; batch A3, ruling D4b b5) | U4's `cloudFiniteAirTransport` **replaced** this code. The behaviour carries forward inside U4 | R2 §4; R1 U1 |
| U2 | Dark sky-LUT placeholder identified by its dimensions | **MOVES-C at ≥ 100 km** (physical path; see U4) | **LAND** (batch A3, with U4) | Survives as a `textureDimensions(...).x > 1u` guard (`ProceduralClouds.wgsl:2268,2621`); the spec asserts it at `:834`. Aerial went from 23/2 to 25/0 | R2 §4 |
| U3 | Bounded march, C13-N13 (`astra-cloud-march-20260921`) | **MOVES-C** | **RETURN** | (0) **U21 and U36 are built on it** (see those rows): taking U3 out is a four-part revert plus two re-fits (F-12). (1) The fine step is now clamped to `[thick/(4·steps), clamp(48·thick/steps, 250, 2000)]` m, and the loop sentinel changed from `steps*3` to `ceil(marchLength/fineStep)*3+3`, which grows with the chord. At 96 steps on a 357 km tangent chord that gives 286 intervals and a sentinel of 861, against 96 / 288 at base. At the new public maximum of 512 steps it gives 1,429 / 4,290 (R5 §2.1 arithmetic). (2) `primarySampleBudget` still reports `marchPixels*maxSteps`, so it **under-reports** the work (R5). (3) The comb accumulator now starts from 0, which changes tier-path quantisation, so the ring Leg-1 frames are no longer a baseline (R5 §2.2). (4) Six `cloud-primary-shell` tests are red (R4 reds 3–8). (5) The seat's own N13 row owns this change (D9) | R1 U3; R4 §1.2; R5 §2.1–2.2 |
| U4 | Finite camera-to-cloud air (`astra-cloud-lighting-20260921`) | **MOVES-C at camera heights ≥ 100 km** (settled from source, critic C3) | **LAND-AFTER-FIX** (batch A3, ruling D4b b5) | (1) Spec red #2 at `cloud-aerial-path-length.spec.mjs:1362`: its slice end marker moved, so esbuild now sees a duplicate declaration. A second red at `:1264` appears only after the formatter runs. (2) **It reaches the default.** Above `CLOUD_AUTO_DISABLE_ALTITUDE_METERS = 100_000` (base `WebGPUCloudTierPresets.ts:309`) `resolveTier` returns tier 1 (`:200`) and clouds still draw; nothing else gates them there (the only other readers of the altitude are the leaf default and a comment naming a *future* high-altitude fallback, base `AtmosphericConditions.js:1025–1038`). There `shouldDefaultPhysicalAerial` is true (`:364–368`), and an unset or `"auto"` `cloudAerialMode` selects it (base renderer `:3818–3823`), which sets `QF_AERIAL_LUT`; U4's branch runs under that flag once the LUT is baked (astra `ProceduralClouds.wgsl:2619–2631`). The ring rig (6,608 km, `cloudAerialMode` unset, `rigs/orbital-fulldisc-6608km.mjs:40–60`) is on this path. Astra's own 09-21 aerial capture is consistent: ground and flight BEFORE = AFTER, 4 of 6 pairs differ (R2 §4), on an earlier generation | R1 U4, §5.2; R4 §3.1 #2, §4.1; critic C3 |
| U5 | Shared uniform-layout module (`astra-cloud-layout-20260921`) | none | **LAND** | Fixes the X6 stale mirror: the probe read 176 while the live struct is 260. The specs now import the one constant. **Its chain carries the HOLD slots:** 220 (U23), 228–255 (U26) and 256–259 (U29), with 224 (U25) between them (P:9974–10003); D12 decides what they become | R1 §2.2; R4 §1 (probe row); critic C1 |
| U6 | Local planetary sunlight, `cloudPlanetaryLighting` = false | INERT | **LAND** | Slots 192–195 | R1 U6 |
| U7 | Physical self-shadow, `cloudPhysicalSelfShadow` = false | INERT | **LAND-AFTER-FIX** | `cloud-tier-lighting-dials.spec.mjs:1553` goes red on CRLF, because the mutant's search string contains `\n` | R4 §3.1 #12 |
| U8 | Colour transfer and HDR presentation (`astra-cloud-color-transfer-20260925`) | **MOVES-C** for the composite. The format-aware rebuilds are default-path code but inert unless the canvas format changes | **LAND-AFTER-FIX** (ruling D4b) | (1) The composite now blends in linear space with a display-gamma 2.2 decode/encode on SDR non-sRGB canvases. (2) The native-temporal branch returns alpha 1.0 where the half-res branch returns `sceneColor.a`; align them or explain the difference. (3) The "Float32 history reset fix" repairs Astra's own first attempt, not a defect on the seat base. (4) Whether the format-cache defect exists at base is unproven; one Edge cell settles it. (5) Red at `aerial-path-length:1264` after the formatter runs | R3 F5, F12; R1 U8; R2 §2 (colour row) and could-not-settle #1 |
| U9 | Atmospheric ambient irradiance (`astra-cloud-ambient-20260925`) | **MOVES-G** for LUT content and first-bake cost; the consumer is INERT | **LAND-AFTER-FIX** (ruling D4a) | (1) `computeIrradiance` is rewritten. A bake is now 256×64 texels × 64 directions × 24 segments = **25,165,824** segment evaluations, against 1,048,576 LUT reads at base, about 24× more. (2) The bake runs only on non-Sun parameter changes (P:4246), but it always runs on the first bake. (3) The irradiance LUT has no default consumer outside the opt-in cloud path and probes. (4) First-bake GPU time is **unmeasured** | R3 F4a, §9.4; R2 §2 (ambient row) |
| U10 | Irradiance bake reuse (`astra-cloud-irradiance-cache-20260925`) | STRUCT (bake scheduling) | **LAND-AFTER-FIX** | A failed LUT dispatch now sets `lutReady = false` and retries (P:6842–6915). That is more correct than base, but it retries on **every frame if the dispatch keeps failing**. `dispatchCompute` returns false only when there is no `computeEngine` or no source (P:4579–4649), so each retry is a cheap per-frame CPU early return rather than a GPU re-bake (critic, D4a note). Bounding it is still right: CLAUDE.md makes retry exhaustion a permanent `console.error`. Bound the retry and give it a spec | R3 F4c, §8; R2 §2 (0 bakes on a Sun change, 1 on an intensity change) |
| U11 | Billow envelope (`astra-cloud-billow-profile-20260925`) | **MOVES-C** | **RETURN** as a default change. Under the recommended D4b b2(ii) it becomes LAND-AFTER-FIX **behind a dial in A2c**; under b2(i) it lands in A3 | (1) `cloudBillowBase` applies to the default CUMULUS / BILLOWY profile with no dial; it is also called in the procedural sky cubemap's density (P:7591–7632). (2) The legacy-density hashes are re-frozen **without** the "default row is identity" clause that every earlier re-freeze kept. Those hashes are sha256 of the comment- and whitespace-stripped **source text** of `legacyCloudDensity` / `legacyCloudBaseDensity` (base `cloud-density-domain.spec.mjs:79–87`, `:700–716`), and Astra's re-freeze note names three body edits: U11, U20a and U26 (P:1254–1272). So gating U11 cannot return them to base: the hash is re-frozen once with the three-part reason, and default identity is proven **by executing** the evaluators at defaults (critic C4). (3) Astra's own words: *"the same setting produces less coverage and lower tops"* (RA:167). (4) It changes the density field the ring family sits on | R1 U11; R4 §1.1, H6; R5 §2.2 item 3 |
| U12 | Additive scattering orders | INERT (inside self-shadow) | **LAND** | — | R1 U12 |
| U13 | Cloud-occluded ambient, `cloudAmbientOcclusion` = 0 | INERT | **LAND** | GPU control over 903 rays: median ambient −32.4 %, none brighter | R2 §2 (lighting row) |
| U14 | Shadowed ground-bounce source | INERT (needs AO > 0) | **LAND** | GPU control over 1,128 rays, 314 of them affected | R2 §2 |
| U15 | PBR-Neutral tone for physical SDR clouds | as U4: **MOVES-C at ≥ 100 km** | **LAND-AFTER-FIX** (rides U4; batch A3, ruling D4b b5) | `cloudPbrNeutralTonemap` is applied on U4's branch (astra `ProceduralClouds.wgsl:2629`), so it reaches the default wherever U4 does | R1 U15; critic C3 |
| U16 | Shared atmospheric multiple scattering (`astra-cloud-atmosphere-multiscatter-20260925`) | INERT consumer; an 8,192-byte field is always allocated | **LAND-AFTER-FIX** (ruling D4a) | (1) Users who already set `SkyAtmosphere.multipleScattering = true` get a different sky, with 32 more steps per fragment. (2) Astra's own note says "FPS and motion are unmeasured". (3) The doubled gather (32 → 64 directions, 16 → 32 samples) is **not** default-path work; see adjudication 1 in §3.1 | R3 F4b, §3; R1 U16 |
| U17 | Cellular (Perlin-Worley) bake fix | INERT (opt-in morphology) | **LAND** | Its spec runs executing tests with a reversed-response mutant. "Default value bake unchanged" is **settled by the patch**: the `CloudNoiseBake.wgsl` hunk (P:7513–7590) touches only `perlinFBMSigned` (removed) and `bakeShapePW`; the default entry point `bakeShape` has no hunk (critic premise 12). U17 lands in A2c, not A1 | R4 §1 (noise-mipmaps); R1 U17 |
| U18 | Native temporal filtering (`astra-cloud-native-temporal-20260925`) | INERT when undefined | **LAND-AFTER-FIX** | (1) `cloud-temporal-rte` was **weakened**: its regex no longer proves that `temporalReprojectionSupported` reaches the gate, and the only behavioural cover sits in the spec that now crashes. Restore the call-site pin. (2) Settle the alpha 1.0 question (see U8). (3) Astra: *"This older successful fixture does not clear later native hangs"* (CP:22) | R4 §1 (temporal-rte row); R3 F5 |
| U19 | HDR-to-SDR sky (`astra-cloud-sky-hdr-20260925`) | **MOVES-G** on HDR displays, on both backends | **LAND-AFTER-FIX** (ruling D4a) | (1) WebGPU sky slot 55 is now `highDynamicRange && !hdrCanvasOutput` (P:11447), so the sky skips its own tone map and gamma. That fixes a double tone map and matches GLSL `#ifndef HDR`, but it changes the default sky wherever the `'scene'` policy turns HDR on. (2) The GLSL alpha clamp (P:7240, re-derived here) changes WebGL bytes under HDR. **There is no WebGL leg.** (3) The SDR identity receipt covers only the top 1920×300. (4) `atmosphereLightIntensity ?? 50` now honours an explicit 0. That is **not** MOVES-G: the default is 50 (base `SkyAtmosphere.js:173`), and 0 arrives only from an application setter (base `AtmosphericConditions.js:626–636`) (critic C13) | R3 F2, F3, F4d, §3 |
| U20a | `cloudDensityExponent` | INERT (identity is 1) | **LAND-AFTER-FIX** | Red at `cloud-density-response.spec.mjs:81` after the formatter runs. This spec **kills** its call-site mutant (M5), the only one of the five new specs that does | R4 §2, §4.1 |
| U20b | `cloudPrimarySteps`, a public dial clamped to **1–512** | INERT | **RETURN** (D9) | (1) 512 is **twice the 256 that hung the GPU** under C13-N69. (2) The dial is ignored whenever `cloudQuality != 64`. (3) It contradicts I-5's "no public API" rule, in the hunk region I-3 and I-5 own | R3 F6; R5 §2.1, W1, W4 |
| U21 | Whole-ray budget and stable reflection publication | INERT dial, but **its off branch is on the default march**; a performance fix on the cloud reflection path | **LAND-AFTER-FIX** (revised from LAND, critic C2) | (0) **It is built on U3.** With the dial off, `cloudAdaptiveMarchStepBounds` returns U3's `cloudMarchStepBounds(...)` (astra `CloudDensityDomain.wgsl:241–255`, U3's function at `:221–226`), and it is called on every march, the default included (astra `ProceduralClouds.wgsl:2255`). The loop around it is U3's: accumulator `var t: f32 = 0.0` (`:2273`), sentinel `ceil(marchLength/fineStep)*3+3` (`:2281`), `cloudMarchFineStep(…, remaining)` (`:2314`); base is `var t = tStart`, `steps * 3` and `fineStep = (tEnd − tStart)/steps` (base `:2491`, `:2501`, `:2506`). So once U3 is out, the disabled branch must be re-fitted to the tip's march law (F-12). (1) Revision churn is fixed: it was bumping from 62 to 69 over 8 frames and is now stable. (2) The 384-step orbit completes, though that is one cell. (3) The adaptive budget is forced off for raw quality, so it does **not** address N69 | R2 §2 (ray row); R5 §2.1 |
| U22 | Scene-linear cloud HDR composition, `cloudSceneLinear` off | INERT dial; STRUCT on the WebGPU frame chain | **LAND-AFTER-FIX** | (1) The post-process forwarding moved out of `WebGPUSceneRenderer.ts`, which lost 101 lines. R3 reads the result as byte-neutral when `sceneColorSource` is undefined. (2) The 4 new godray tests **skip on an unbuilt tree**, and nobody has run them. A built-tree run and a default-frame identity capture are owed | R1 U22; R3 F12; R4 §6.1 |
| U23 | Cross-deck peer shadows | HOLD (feature); its peer-transport plumbing is on the default lighting path | **RETURN** (feature); plumbing per D12 | (1) Astra: *"Visual validation FAILED … on HOLD, not ready to land"* (RA:335). (2) **The hang in that receipt is in the feature-off control:** *"in the shadow-off control (96/8, peer budget 0)"* (RA:335). A unit-caused hang is not shown (critic C5). (3) Its code is inside kept units: 28 peer lines in U25's `CloudLightingCache.wgsl`, 12 in `CloudLightSampling.wgsl`, 8 in `ProceduralClouds.wgsl`; the default march calls `multiScatterLight(…, profile, peerTransport)` with `peerTransport = (1, 0)` unless the peer gate is on (astra `ProceduralClouds.wgsl:2472–2497`). Slot 220 | R1 U23; R2 §2 (layers row); critic C1, C5 |
| U24 | Shared `marchDeck` call site and packed deck order | STRUCT | **LAND-AFTER-FIX** | The default march is claimed to be identical; a two-tree byte capture is owed | R1 U24 |
| U25 | Ambient lighting cache, `cloudLightingCache` = false | INERT | **LAND-AFTER-FIX** | (1) `cloud-lighting-cache.spec.mjs` **survives** `if (false) encodeCloudLightingCache(` and stays 27/27 green. (2) The module bypasses `WebGPUShaderModuleCache` (`WebGPUCloudLightingCache.ts:122`) | R4 §2 M2; R1 §2.1 |
| U26 | Explicit altitude/genus layers, `cloudLayers` | HOLD (feature); its profile plumbing is on the default density and lighting path | **RETURN** (feature); plumbing per D12 | (0) **The plumbing is default-path code.** `struct CloudLayerProfile` and `cloudProfileForDeck` (astra `CloudLightSampling.wgsl:629–658`) return the global genus values unless `multiDeckEnabled() && cloud.layerProfilesEnabled > 0.5`; their callers are on the default path (astra `ProceduralClouds.wgsl:1320, 1412, 1511, 2195`; `CloudLightSampling.wgsl:70, 210, 258`), and `genusFibreFactor`, `decodeWeatherChannels`, `genusForwardG`, `cloudPhase`, `cloudSilverLining`, `effectiveAbsorption`, `beerPowder` and `multiScatterLight` now take a profile. Slots 228–255. (1) *"Native is still RED: **initial legacy**, initial mixed, and final mixed high 96/8 runs all hit DXGI_ERROR_DEVICE_HUNG"* (RA:377): the legacy run is a control, so the hang is not attributed to the unit (critic C5). (2) Its spec survives M3, because it never reads the renderer. (3) A non-array value throws a `TypeError` in the constructor, and an invalid one throws a `DeveloperError` **on every frame at render time**. (4) The `CloudLayerProfile` struct is what crashes `cloud-tier-single-source`. The author still owes the line that separates this unit from the shared profile plumbing | R3 F7, F10; R4 §3.1 #1, Q5, Q7 |
| U27 | Conservative zero-density exits | STRUCT | **LAND-AFTER-FIX** | "Exact" output is claimed, with tests only and no timing. Two early-outs change control flow at defaults. A byte capture is owed. Its early-outs sit in the density chain U3's loop drives, so they are re-fitted onto the tip's march law with U21 (F-12) | R2 §2; R5 §2.2 |
| U28 | Worley cell pruning | STRUCT | **LAND** | GPU oracle: 0 mismatches at 9,056 positions; the mutant gives 2,311 mismatches; 82,189 / 9,056 = 9.0756 hashes per position | R2 §2 (exact row) |
| U29 | Peer-layer light cache | HOLD (needs U23) | **RETURN** (feature); plumbing per D12 | It caches U23's transport. Native ground hit `DXGI_ERROR_DEVICE_HUNG` on revision 01. Slots 256–259; `peerEnabled` runs through U25's `WebGPUCloudLightingCache.ts` | RA, peer-cache section; R1 U29; critic C1 |
| U30 | Layered daylight multiple scattering | HOLD (needs U23) | **RETURN** (feature); plumbing per D12 | It acts only through peer visibility, i.e. through `multiScatterLight`'s `peerTransport` parameter | R1 U30 |
| U31 | Directional ambient visibility | INERT (needs AO > 0) | **LAND-AFTER-FIX** | (1) `cloud-tier-lighting-dials.spec.mjs:1982` goes red on CRLF, and its "broken" model is only half broken. (2) Readiness went from 82,468 to 166,585 ms, in single cold runs | R4 §3.1 #13; R2 §2 |
| U32a | Ambient call-site sharing | INERT (physical ambient) | **LAND** | — | R1 U32 |
| U32b | Linear IGN frame scroll, `5.588238 * frameIndex` | **MOVES-C** (every jittered tier) | **RETURN** (D4b) | (1) **Astra's own predeclared stripe gate FAILED**: *"+1.82% at 12 settled frames and −1.84% at 64, versus a required 25% reduction"* (RA:445). It was retained anyway. (2) R4 finds the oracle re-pin consistent with the source, and bounded, because `frameCounter` wraps at 64 | R1 U32; R4 §1 (ray-jitter row) |
| U33 | Reflection-include compile repair; IGN placed in the shared density chunk | shared chunk | **LAND-AFTER-FIX** — carries the **P0** | (1) Against the seat base the repair is net nil: it fixes Astra's own earlier move. (2) The IGN that stays in `CloudDensityDomain.wgsl` **breaks the fog shader** (§0 item 3a). Rename it or take it out of the shared chunk. The fog's own IGN uses a different rotation formula, so the two cannot be swapped. The IGN's only caller in the stack is astra `ProceduralClouds.wgsl:1493`, so once U32b is reverted, returning IGN to its base home with its base body makes U33 net-nil and removes the P0 without a rename (critic A1). (3) Home `fog-cheap-coverage-gate`, and add a naga sweep over every `CloudDensityDomainWGSL` consumer: fog, sky cubemap and cloud | R3 F1, §2; R2 §2 (compilation row) |
| U34 | Baked/physical shader specialisation, **hi bit 6** | INERT at defaults (needs self-shadow) | **LAND-AFTER-FIX** | (1) It calls `device.createShaderModule` directly, **bypassing both `WebGPUShaderModuleCache` and the pipeline cache**. CLAUDE.md: "Do not bypass these when adding shader variants". (2) Eligibility reads raw slots `data[74] & 8193`, `196`, `75`, `128`, `132`, `136` and `140`; it should use named exports from the layout module. (3) Its 454.209 → 244.561 ms (46.16 %) was measured on an **earlier 71-file generation**; re-measure on the stripped stack. (4) The cold async compile took 52.873 s | R1 §2.1, T5; R3 F8; R2 §3 row 1 |
| U35 | Lighting-cache dependency key | INERT (inside the cache) | **LAND-AFTER-FIX** | It is a hand-kept offset table of 64 fields and 140 floats. Pin it to the WGSL struct with a spec, or derive it from the layout module. Nobody has independently re-derived that it is complete | R1 T5; R2 §2, could-not-settle #3 |
| U36 | Empty-weather skipping, `cloudEmptySpaceSkipping` = false, QF bit 14 | INERT dial; STRUCT weather ownership | **LAND-AFTER-FIX** | (1) The spec **survives** both mutants: M4a on the renderer flag and M4b on the WGSL skip. (2) The cloudy boundary runs 4.39 % slower, a FAIL that Astra records. (3) The dial has no comment at all, and the spec depends on the working directory. (4) Worth keeping: the weather fallback texture is now tracked and destroyed, where base leaked it (base renderer `:2688–2701`). (5) **Its skip sits inside U3's loop** (`if (!fine && skipEmptyWeather)`, astra `ProceduralClouds.wgsl:2321`, on U3's `t`-from-0 lattice), so it is re-fitted onto the tip's law and re-measured (F-12, F-15; critic C2) | R4 §2, H12; R2 §3 rows 3–4; R3 §5; R1 §2.4 |
| U37 | Sparse primary updates, revision 02, **hi bit 7** | INERT (off) | **REJECT-AND-STRIP** | (1) Both A/Bs FAILED, and runtime-02 ran on the final bundle. (2) The spec survives `enabled: false && …` (M1, 10/10). (3) Even when off, it concatenates ~200 KB of source on every offscreen frame. (4) 8,294,656 B of history stays resident after the feature is disabled. (5) Astra's own rule says remove it (CP:83). Write a withdrawal record | R2 §1; R4 §2 M1; R3 F7, F9; R1 U37 |

### 2.3 Outside the patch

| Item | Verdict | Finding | Evidence |
|---|---|---|---|
| TaskProcessor settled-guard: `Core/TaskProcessor.js` +8 and a spec +51. It lives in the clone's worktree and equals the seat packet `worker-rejected-dispatch.patch` | **LAND-AFTER-FIX, as its own Core batch (D5)** | See the bullets after this table | R3 §7; R2 §4; R5 §1a.3 |
| `decomposition-doc.patch` (`ES6_MODERNIZATION_STATUS.md`, +51) | **RETURN.** The seat rewrites these rows when it lands the decompositions. | (1) It is malformed: 28 "Astra" mentions, 9 dangling `_lane-out/` paths, a table split by a blank line, and one literal `\n###` line. (2) Its line counts do not reconcile with base: it says the renderer went "5629 → 5628", and base is 5,546 | R1 §2.7, §2.9 |
| `eslint.seatbelt.tsv`, changed in the clone only: renderer `curly` 10 → 9, `no-use-before-define` 6 → 5 | **REJECT-AND-STRIP.** The seat regenerates the rows (D7). | (1) The file is seat-owned. (2) R4 measured that the seat's own eslint, run on the patched renderer, produces exactly this tightening, so the values are right for **those** bytes. (3) They stop being right once the formatter rewrites the renderer (+233 / −75) | R1 §2.10; R4 §4 |
| `package.json` hunk | **Not applied as-is.** The seat re-composes it. | (1) The content is clean and add-only: 5 specs added to `test-cloud-c13`, and a new `test-sky-atmosphere` that gives 3 runnerless sky specs a home. `dupkeys` is clean. (2) It was written in-tree again, the X2 finding. (3) Its context lines include the `test-engine-node` value Angrim owes, so the hunk stops applying once W2-L11 lands. (4) `perf-manager-teardown.spec.mjs` is edited but has no runner home | R1 §2.11; R4 H9; R5 §1a.1, §1c |

**The TaskProcessor guard in detail:**
- **The race is real.** An `error` or `messageerror` that arrives before the probe resolves still lets the task be posted, which
  detaches the caller's transferables.
- **The guard cannot drop a legitimate continuation.** `settled` flips only on paths that have already rejected.
- **The spec discriminates on base:** the worker regression goes from 10/2 to 12/0.
- **The inertness mutant is only reasoned to fail; nobody has run it.**
- **It must land after W2-L11.** W2-L11's karma selection covers `Core/TaskProcessor`, so this unit comes after W2-L11, with its own
  karma leg.
- **Residual:** the WASM-init path has the same race and no guard.

### 2.4 Tally

**9 LAND · 21 LAND-AFTER-FIX · 8 RETURN · 1 REJECT-AND-STRIP**, over 39 rows: 37 units, with U20 and U32 each split in two. The
first draft had 10 / 20; U21 moved from LAND to LAND-AFTER-FIX because it is built on U3 (critic C2).

- **Waiting on a ruling rather than a code fix:** seven of the 21 LAND-AFTER-FIX rows — U8 (D4b b1), U1, U4 and U15 (D4b b5), plus
  the D4a set U9, U16 and U19. U2 is LAND but rides with U4 into A3.
- **Riding on U4:** U1, U2 and U15.
- **The four HOLD units, U23, U26, U29 and U30, are out of every batch as features.** The basis is the author's own hold and its
  visual-validation FAILs (RA:335, RA:377). It is **not** the device hangs: Astra's receipts record those in feature-off controls
  (RA:335 shadow-off control, peer budget 0; RA:377 "initial legacy" run; CP:71 "matched preceding shaders"), so a unit-caused hang
  is not shown (critic C5). **Their plumbing is not out:** it runs on the default path of kept units, and D12 decides whether it
  stays as reserved structure, is stripped, or ships default-off.

---

## 3. Cross-cutting findings, ranked — rule violations first

The ids Y1–Y17 are chosen so they do not collide with the 09-16 audit's X1–X13. §3.2 maps between them.

**Y1 — P0: an opt-in non-cloud feature breaks. Rule: Principle 1, "never break existing behaviour".**
- **What breaks:** WebGPU volumetric fog no longer validates (R3 F1, measured with naga):
  - IGN is now declared in the shared chunk (P:7800);
  - `VolumetricFog.wgsl:538` keeps its own IGN;
  - base `WebGPUVolumetricFogResources.ts:62` concatenates the two.
  - The two declarations and the concatenation are re-derived here.
- **Who is exposed:** scenes with `volumetricFog.enabled`, `effects.groundFog.enabled`, or `effects.auto` in humid air (§0 item 3a;
  critic C12).
- **Controls that pass** (R3 §2): the base fog; Astra's sky cubemap, atmosphere LUT and sky compositions; six preprocessed cloud
  variants.
- **Unsettled:** whether the invalid fog pipeline also invalidates the shared frame encoder (R3 §9.1).
- **Why nothing caught it:** Astra's naga checks covered cloud compositions only, and the one guard that composes the fog source has
  no runner home.

**Y2 — Gates regress, and L3's protected acceptance is silenced. Rules: R-2026-09-16-2, R-2026-08-29-1.**
- **`test-cloud-c13` goes from 635/0 to 720/13** (R4 H1, H2). `cloud-tier-single-source` crashes at load with `unmodelled WGSL type
  "CloudLayerProfile"`, which takes out 35 tests, including L3's C13-N10 byte-identity test and MUTANTs a–g.
- **Quarantine goes from 4 failures to 10** (R4 H5, §3.1 Q2–Q7). Most are in specs the patch never touched; its refactors broke them.
- **Astra's receipts could not have seen reds 1–11** (R4 §3.1):
  - `focused-tests-revision-02.log` covers `cloud-sparse-updates` alone;
  - `comments-revision-02.log` covers one file;
  - `lint-revision-02.log` is empty.
- **Silenced, not rewritten.** This time Astra did not rewrite the C13-N10 test, and the source keeps the band (R1 §2.3). The test
  is silenced rather than replaced.

**Y3 — Defaults moved with no ruling. Standing constraint: "defaults unchanged unless ruled".**
- No public default moved (R1 §1 verdict).
- **MOVES-G, for users who never enable clouds** (R3 F2–F4):
  - U19: the WebGPU sky on HDR displays, and the WebGL alpha clamp under HDR;
  - U9: LUT content and first-bake cost;
  - U16: the 8 KiB allocation;
  - U10: the retry semantics;
  - U20a: `SkyUniforms` grows by 4 floats (`SKY_UNIFORM_FLOATS = 56 + CLOUD_DENSITY_ORIGIN_PHASE_FLOATS + 4`, P:4470–4471) for the
    procedural sky fill that also serves model IBL. Byte identity of that fill is claimed, not shown (critic C9d).
- **Not MOVES-G, although the first draft listed it:** U19's honouring of an explicit zero intensity. The default is 50, and 0 comes
  only from an application setter (critic C13).
- **MOVES-C, for users who enable clouds and set nothing else** (R1 T3; R3 F5; R4 H6; R5 §2.2):
  - U3: the march law;
  - U8: the linear composite;
  - U11: the billow envelope;
  - U32b: the IGN scroll;
  - U1/U2/U4/U15: the physical aerial path, **at camera heights ≥ 100 km** — settled from source (§2.2 U4 row; critic C3);
  - plus the unproven STRUCT identity claims of U22, U24, U27 and U36;
  - plus default-path code whose identity is claimed but not yet covered by any leg (critic C9c): U18's gate change
    `runtime.offscreenActive ?? runtime.halfResActive` (P:4442), U20a's identity branch (astra `CloudDensityDomain.wgsl:216–219`),
    U21's disabled branch, U36's bit-14 skip, and the HOLD chain's profile and peer plumbing (D12).
- D4 takes these one at a time.

**Y4 — A failed experiment is retained against its author's own rule, and the written record contradicts it.**
- **The experiment is still there.** U37 remains in the patch after two FAILED A/Bs (R2 §0, §1). Bit 7's consumers are
  `CloudSparseUpdates.wgsl:1` and `ProceduralClouds.wgsl:2724` (R1 §2.1).
- **The checkpoint is wrong about it** (R2 F3):
  - It records neither A/B.
  - It says 4×4 tiles, but the final code shifts by `>> 3u`. Re-derived here at P:13611: `((pixel.x >> 3u) + (pixel.y >> 3u))`.
  - It quotes bundle `1cd7dda8…`; the final bundle is `a4b74c3a…`.
- **It is not "unvalidated".** CP:93 calls it the *"unvalidated sparse candidate"*. It was validated, and it failed.

**Y5 — The proof bar is met on its first leg only. Rules: R-2026-08-29-1, R-2026-09-16-5. This repeats X3.**
- **No independent review.** There is no independent reviewer and no named Edge leg; every capture is Astra's own (R1 §2.3).
- **Inertness mutants.** **4 of the 5 new specs survive a call-site inertness mutant:** M1 (sparse), M2 (lighting cache), M3 (layer
  profiles) and M4a/M4b (empty weather). Only M5, on density response, is killed (R4 §2).
- **Guards weakened or re-pinned:**
  - `cloud-tier-single-source` MUTANT d now accepts *any* `AssertionError`. It used to pin index 45 and the overrun (R1, R4).
  - `cloud-march-emission` F2's permanent loop sentinel is re-pinned to the chord-proportional form (R1; R4 §1.2).
  - `cloud-temporal-rte` no longer proves that `temporalReprojectionSupported` reaches the gate (R4).
  - The legacy-density hashes are re-frozen without the identity clause (R1; R4 H6).
- **The A2 count assertion was kept.** §3.1 adjudicates this.
- **No mutants of their own:** the new specs `cloud-sparse-updates` and `cloud-layer-profiles` carry none (R1 T7).

**Y6 — The landed bytes would not be the reviewed bytes. Rule: the pre-commit hook.**
- **Formatter.** 44 of 65 eligible files fail `prettier` under the seat's config, 21 of them engine files; at base the count is 0
  (R1 §2.12).
- **What the hook would do.** It rewrites them by +5,821 / −1,877 lines, after which 7 text-shape assertions go red (R4 §4, §4.1).
- **Seatbelt.** The hook's eslint step also rewrites the seat-owned seatbelt (R4 §4).

**Y7 — Parity is recorded nowhere. Rules: Principle 5, R-2026-09-12-8. This repeats X5.**
- **The only GLSL change** is the one-line alpha clamp. That is a WebGL behaviour change under HDR, with no WebGL capture (R1 §2.4,
  R3 F3).
- **No WebGL counterpart.** None exists for the cloud units, and there is no WebGL volumetric-cloud path at all.
- **U16 widens no API gap.** At base, `SkyAtmosphere.multipleScattering` is already documented as *"WebGPU only — … this flag is a
  no-op there"* (base `SkyAtmosphere.js:66–70`, re-derived here).
- **Missing records.** No `DEFERRED_WORK` or `FEATURE_INVENTORY` row exists, and only 5 of the 14 dials say "WebGPU".

**Y8 — The shader-module and pipeline caches are bypassed. Rule: CLAUDE.md, "WGSL Shader Pipeline" section.**
- **Direct module creation.** The specialisation, sparse, lighting-cache and composite modules call
  `device.createShaderModule({code: preprocess(...)})` directly (R1 §2.1, R3 F8):
  - `WebGPUCloudShaderSpecialization.ts:63–65`
  - `WebGPUCloudSparseUpdates.ts:119`
  - `WebGPUCloudLightingCache.ts:122`
- **Define-bit step 2.** The two new `ShaderDefineHi` entries carry `//` comments, where their siblings carry JSDoc.

**Y9 — Seat-owned files were written in the clone. This repeats X2.**
- `package.json`: the change is clean and add-only, but it was written in-tree again.
- `eslint.seatbelt.tsv`: edited in the clone.
- `ES6_MODERNIZATION_STATUS.md`: a malformed hunk (R1 §2.9–2.11, R4 H9).

**Y10 — Public API hygiene. Rules: R-2026-09-16-6, the ES6 rule, the comment rules.**
- **The 14 new dials are plain properties** with `//` comments (R3 F10):
  - no JSDoc, so they are missing from the generated docs;
  - no `Check` when set;
  - no getter or setter;
  - clamping only at consumption, and for only 4 of them.
- **Invalid `cloudLayers` throws on every frame** at render time, rather than when the value is set (R3 F7).
- **`CloudVolumetrics.js` is still a constructor function.** It gained 46 lines, and the ES6 rule asks for a class once a file gets
  more than 10 changed lines (R1 §2.9).
- **The JSDoc rationale for `cloudAerialMode`'s default was deleted** (R1 §2.3).
- **A load-bearing WHY comment was deleted in an extraction** (critic C16). The block above the IBL cloud parameters in
  `runProceduralSkyFill` explained why they are read from `_cloudCache`: *"`FrameState` has no `globe` field, so reading these
  through a `frameState.globe` cast would yield undefined and freeze every param at its constructor default"* (removed at
  P:4487–4494). The parameter reads moved to the new `WebGPUCloudReflectionUniforms.ts` (P:11545+) without it. The comment rules say
  rationale is preserved (F-19).

**Y11 — Log sentinels.**
- **Six new permanent `console.error` calls** report real pipeline and allocation failures, which is correct under the pragma rule.
- **No context id.** None carries one, and Principle 3 prefers `context.log`.
- **P:5645 has no throttle.** It fires on every frame on which `ensureHalfResResources` returns false (R1 §2.8).

**Y12 — Risk: a hang-class workload.** This is not a rule breach, but it is the highest-consequence risk (R3 F6; R4 §1.2; R5 §2.1).
- **What drives it:**
  - raw `cloudQuality` is still unclamped, so C13-N69 is unaddressed;
  - the new public `cloudPrimarySteps` accepts values up to 512;
  - the default-path sentinel now grows with the chord;
  - `primarySampleBudget` under-reports long-chord work.
- **Astra's own record:** *"repeated DXGI_ERROR_DEVICE_HUNG persists at high 96/8, including matched preceding shaders, temporal-off
  and draw-partition diagnostics … Root cause remains unresolved"* (CP:71).
- **Where Astra's receipts put the hangs: in feature-off controls** (critic C5):
  - RA:335, U23: *"in the shadow-off control (96/8, peer budget 0)"*;
  - RA:377, U26: *"initial legacy, initial mixed, and final mixed high 96/8 runs all hit DXGI_ERROR_DEVICE_HUNG"*;
  - CP:71: the hang persists with *"matched preceding shaders, temporal-off and draw-partition diagnostics"*;
  - RA:299: *"The 384-sample 1080p orbital stress case FAILED with DXGI_ERROR_DEVICE_HUNG"*, which is U20b's own dial at a value
    below its 512 cap.
  - So the hang is not shown to be a property of the HOLD units. It may be a property of the stack's shared default march (U3 is a
    candidate) or of base.
- **Where the hazard lands in this plan.** Tier 3 is native 96/8 (base `WebGPUCloudTierPresets.ts:168–172`, `renderResScale` 1.0),
  and `"auto"` resolves to tier 3 at or below 50 km (`:201`). Every "clouds on, default, ground" cell is therefore a native 96/8
  cell. Until E4 reports, every native high cell runs under E4's hang protocol, and E4 is a hard gate before E5 (LANDING_PLAN §5).
- **Unsettled:**
  - whether U3 contributes, which is only a hypothesis (R1 §5.4);
  - whether the hang is present at base (R3 §9.7);
  - whether it needs multi-deck. CP:71 names "multilayer" runs; no receipt tests a single deck at native 96/8.
  - E4 settles all three with a base arm, a patch arm, a U3-reverted arm and a single-deck arm (LANDING_PLAN E4).

**Y13 — The receipts come from earlier generations.**
- **Wrong tree.** Every retained percentage and image was measured on an earlier patch generation, which lacks 2–26 of the final 81
  files. The only run on the final stack is the failed sparse A/B (R2 §5).
- **"Same-session" is overstated for two rows.** For the log-light and erosion rows, two separate runs gave 171.145 and 447.876 ms
  on a byte-identical PNG, a **2.6×** swing (R2 §0.6).
- **Self-repairs, not base defects.** Two of the "fixes" repair Astra's own regressions from the same window: the Float32 history
  reset and the reflection include (R2 §2).
- **The layers row** leaves out that every native attempt failed (R2 §2).

**Y14 — Opt-in hot-path costs** (R3 F7, F9). Both disappear with the strip.
- **When sparse is off:** the sparse inputs concatenate the ~200 KB cloud source on every offscreen frame. That is cheap while it
  stays a cons string.
- **When sparse is on:** the renderer flattens and compares ~200 KB and allocates snapshots on every frame.
- **After disable:** the 8,294,656 B of history stays resident.

**Y15 — Uniform mirrors are back in new places. This is adjacent to X6** (R1 §2.2).
- **Engine code with hard-coded slot indices:**
  - `WebGPUCloudShaderSpecialization.ts:19–21`
  - `WebGPUCloudSparseHistory.ts:72–75`
- **A hand-kept 64-offset table:** `WebGPUCloudLightingDependencies.ts`.
- **Specs with a literal `260`.**
- The registry and layout rules themselves hold (Y17).

**Y16 — File sizes improved on X8** (R1 §2.7).
- **Shrank:** the renderer, 5,546 → 5,330; `ProceduralClouds.wgsl`, 3,363 → 3,056; `SkyAtmosphere.wgsl`, now 939.
- **Grew while already over 1,000 lines:** `WebGPUPostProcessPipeline.ts` (+7) and `WebGPUPerformanceManager.ts` (+12).
- **Specs that grew past 1,000:**
  - `cloud-aerial-path-length`, 784 → **1,917**;
  - `cloud-tier-lighting-dials`, 1,336 → **2,023**.

**Y17 — Clean.** Stated here so these points are not re-argued:
- **ShaderDefineHi** (R1 §2.1, R3 F11):
  - bits 6 and 7 are appended, with nothing renumbered;
  - the lo word and `ShaderSourceId` are untouched;
  - `hiDefineBit` moved into `WebGPUShaderDefineBits.ts` with a type-only back-import, so there is no runtime cycle.
- **Uniform layout** (R1 §2.2):
  - `CLOUD_UNIFORM_FLOATS` = 260, from one source;
  - slot 175 `_padQ` is kept, and slots 111, 146 and 147 are free;
  - `qualityFlags` bit 14 is appended.
- **Code hygiene:**
  - no `any`, `@ts-ignore` or `eslint-disable` on any added line (R1 §2.6, R4 §5);
  - no Scene → WebGPU import (R1 §2.5);
  - C16 `--strict` gives 0 markers, and engine comments carry no Astra, batch or session text (R1 §2.9, R4 §5).
- **Type checks and CI:**
  - scoped `tsc` gives 0 errors beyond the TS2307s for generated modules (R4 §3);
  - of the CI-wired gates the readers ran, none turns red on a patch defect (R4 §3). **Withdrawn as a general claim** (critic C6):
    `prettier-check` is CI-wired and fails on 44 files (Y6); `eslint` with the frozen seatbelt, `test-webgpu-policy`,
    `collection-sentinels-check`, `test-c16` and `test-landing-rules` were not run. The critic settled two more by reading:
    `lint-debug-pragmas` is clean (the only added console calls are six `console.error`, which the script ignores), and
    `audit-feature-renderers` is clean by construction (`FeatureRendererKey.js` is untouched).
- **Ring tools:** the Batch 1530 ring tools are untouched, and their engine pins still hold on Astra's tree: 138/138 (R5 §2.3).

Also measured: test DX defects (R4 H12, reds 12–13, §2).
- Two new specs resolve paths against the working directory.
- Two mutants cannot match CRLF text.
- The new specs are written in a minified style.

### 3.1 Where the readers disagree, and which evidence wins

1. **Does the doubled multiple-scattering gather run on the default bake?**
   - R1 says it sits "in a kernel on the ungated sun-dirty bake"; R3 F4b says the field is baked only when `multipleScattering` is on.
   - Re-derived here:
     - `NUM_MS_GATHER_DIRS` and `NUM_MS_RAY_SAMPLES` are **declared at base but never used**; `git grep` over the shaders finds only
       the declarations.
     - In Astra's tree only `atmosphereScatterRay` and `computeScatteringField` consume them (astra `AtmosphereLUT.wgsl:806–864`).
     - That kernel is dispatched only under `lut.paramsData[23] > 0.5`, inside `!irradianceParamsMatch(lut)` (P:4246–4252).
   - **R3 wins.** The doubled gather is not default-path work.
2. **How often does the irradiance kernel (U9) run?**
   - R1 says it runs "on the ungated sun-dirty LUT path"; R3 says it runs only when non-Sun parameters change.
   - The gate at P:4246 is `if (!irradianceParamsMatch(lut))`, and R2's receipt shows `bakes: 0` on a Sun-direction change.
   - **R3 wins on frequency.** R1's point about content stands: the kernel is rewritten and costs about 24× more per bake.
3. **`cloud-march-emission` A2.**
   - R1 calls it "relaxed"; R4 says the count was kept.
   - Re-derived at P:1583–1605:
     - the title changed;
     - `assert.equal(preprocessed.length, 1, …)` is **kept**;
     - the "it is the HALF-RES one" locator was replaced by a wider gate, `(reconstructionEnabled || nativeTemporalEnabled ||
       sparseRequested)`.
   - **R4 is exact.** What was lost is *which* pipeline emits, not *how many*. The gate changes again once sparse is stripped.
4. **U8's format-aware rebuilds.**
   - The readers:
     - R1 lists "canvas-format rebuild … for every WebGPU scene" among the moved defaults.
     - R3 F12 shows it fires only when `presentationFormat` changes, which never happens on the default path. R3 calls it a fix for
       a latent HDR-canvas toggle bug.
     - R2 finds no receipt that the bug exists at `a76d42b3f8`, because the failing "before" run was Astra's previous candidate.
   - **Adjudication:** it is default-path code, inert unless the format changes (R3). "Fixes a base bug" is a reading, and it stays
     unproven until R2's one HDR-canvas Edge cell runs on a base build.
5. **U11 in the IBL cubemap.**
   - R4 says it is applied unconditionally; R3 says it sits inside `cloudDensityIBL`, which runs only when `cloudMarch = 1`.
   - **Both are true:** it is unconditional inside an opt-in path. R3's scoping governs the default-path claim.
6. **The seatbelt rows.**
   - R1 could not settle whether 9 and 5 are right. R4 measured that the seat's own eslint, run on the patched renderer, produces
     exactly 10 → 9 and 6 → 5.
   - **R4 settles R1 §5.1.** The values are correct for the audited bytes. The problems are where they were written, and how long
     they stay valid.
7. **U32's IGN scroll.**
   - R4 finds the spec edit justified by the source; R1 objects to keeping the change after its gate failed.
   - **These do not conflict.** Both findings stand.
8. **U22's frame chain.**
   - R1 flags it as unproven; R3 reads it as byte-neutral.
   - **R3's reading is the stronger evidence,** but it is a reading, not a capture. The identity leg is still owed.

### 3.2 Did Astra repeat the 2026-09-16 findings?

| 09-16 finding | Now |
|---|---|
| X1 held-file breach | **Not repeated as a breach.** The three frozen patches are disjoint from Astra's (R5 §1a). There is overlap with planned lanes instead (§6). |
| X2 `package.json` written in-tree | **Repeated.** The change is clean and add-only (R1 §2.11), and the seatbelt was also edited in the clone. |
| X3 proof bar | **Repeated.** 4 of the 5 new specs survive inertness mutants, and there is no reviewer and no Edge leg (Y5). |
| X4 C16 ratchet | **Not repeated.** The census is 179/83 before and after, and the cleanlist stays at 671/868 (R4 §3). |
| X5 parity unrecorded | **Repeated** (Y7). |
| X6 layout mirrors | **Mostly fixed,** with new mirrors in engine code (Y15). |
| X7 clean items | **Still clean** (Y17). |
| X8 file size | **Improved** (Y16). |
| X9 default-path risk | **Narrower, but present** (Y3). No public default moved, but MOVES-G is new. |
| X10 photometry library | **Unsettled.** The composite moved to linear space (U8), which changes the transfer premise again (R1 §5.7). |
| X12 contract reds against main | **Not repeated as reds:** `cloud-march-emission` is 33/33. After the formatter, A2 and E4 go red (R4 §4.1). |

### 3.3 Which R-2026-09-16 clauses have no subject in this stack (critic C17)

"The rules hold" (§0 item 2) is true of the clauses this stack can be tested against. Some clauses name units that are not in it.
Re-derived with `grep -c` over the frozen patch: 0 hits each for `AUTO_TEMPORAL`, `autoTemporal`, `interleavedRefresh`,
`pixelFootprint`, `weatherCoverage`, `projectedDetail`, `ASYNC_PIPELINE`, `NOISE_COMPUTE`, `WEATHER_SKIPPING` and
`cloudWeatherIntervalEmpty`. The 09-16 unit names are from `ASTRA_WORK_AUDIT_2026-09-16.md:268–276`.

| Ruling clause | Status in this stack | What the record round writes |
|---|---|---|
| R-16-1 (lanes L3/L4/L5 first, Astra rebases) | **Executed.** Batches 1493, 1504 and 1515 are ancestors of `a76d42b3f8` (re-derived with `git log`); that they are L3, L4 and L5 is the brief's mapping | close |
| R-16-2, "the resolver KEEPS L3's near-altitude band" | **Holds** (R1 §2.3). Its protected acceptance is silenced by the crash (Y2), which F-3 fixes | keep open until F-3 lands |
| R-16-2, "Astra's AUTO_TEMPORAL re-lands on top" | **Moot:** no subject | moot / superseded |
| R-16-3, "slot 175 stays `_padQ`; single-source `CLOUD_UNIFORM_FLOATS`" | **Holds** (Y17) | executed when A1 lands U5 |
| R-16-3, "`interleavedRefresh` is APPENDED" | **Moot:** no subject | moot / superseded |
| R-16-6, "units 43, 39, 38 ship default-off; 39 and 43 get real dials with JSDoc" | **Moot as to its named units.** The principle carries over: U36 (empty-weather skipping, the nearest successor of 09-16 unit 38) ships default-off, and D11 applies the JSDoc half to every new dial | moot for 38/39/43; the principle governs D11 and D12(c) |
| R-16-7, "same-build repeat control for units 37 and 47" | **Moot as to its named units** (ASYNC_PIPELINE, NOISE_COMPUTE absent). U34's `createRenderPipelineAsync` (P:12913–12942) is a new subject, not 09-16 unit 37. The **procedure** is carried into every byte-identity cell here (LANDING_PLAN §3; critic C9a) | moot for 37/47; procedure adopted |
| R-16-4, -5, -8 … -12 | Not re-examined clause by clause in this audit | — |

---

## 4. Astra's own admissions — quoted

From the checkpoint:
> *"It remains unlanded and is not independently certified."* (CP:9)

> *"Empty-weather skipping, cloudy boundary | 153.225 -> 159.951 ms, 4.39% slower … | Performance FAIL. Occupied-region overhead
> must improve before defaults change."* (CP:44)

> *"Status: **implemented, built, GPU validation pending**. … Do not enable or promote it based on unit tests."* (CP:63, on sparse.
> Two later A/Bs failed, and neither was recorded; R2 §0.3.)

> *"Native multilayer 1080p stability: repeated DXGI_ERROR_DEVICE_HUNG persists at high 96/8 … Root cause remains unresolved;
> native/default promotion stays HOLD."* (CP:71)

> *"Sampling stripes: phase changes failed the predeclared 25% stripe-reduction target; 64-frame improvement was only 1.84%."*
> (CP:74)

> *"Lint ledger side effect this session: a parse-error lint run triggered eslint-seatbelt's automatic removal of four existing
> renderer allowance rows. Restored only those rows from the previous successful lint record …"* (CP:77)

> *"Some test/build/capture churn was avoidable and did not translate into visible progress."* (CP:79)

> *"cloud-all-current.patch includes prior retained cloud work plus the **unvalidated sparse candidate**."* (CP:93)

From the return-audit doc:
> *"The cumulative patch supersedes previous cloud candidates; TaskProcessor stays separate."* (RA:134)

> *"Visual validation FAILED. The final actual 1080p layered flight run lost the device with DXGI_ERROR_DEVICE_HUNG before its first
> screenshot … The candidate and cumulative patch in this packet are on HOLD, not ready to land."* (RA:335, U23)

> *"Native is still RED: initial legacy, initial mixed, and final mixed high 96/8 runs all hit DXGI_ERROR_DEVICE_HUNG."* (RA:377,
> U26)

> *"The predeclared stripe target FAILED. High-frequency RMS changed +1.82% at 12 settled frames and -1.84% at 64, versus a required
> 25% reduction."* (RA:445, U32)

> *"Ground and flight now show more separated bodies and rounded shoulders, but the same setting produces less coverage and lower
> tops."* (RA:167, U11)

> *"The 384-sample 1080p orbital stress case FAILED with DXGI_ERROR_DEVICE_HUNG and device loss."* (RA:299)

> *"HDR PNG highlights clip; exposure/display acceptance remains open."* (RA:130, U8)

**What Astra did not say:**
- the fog break (R3);
- the 13 + 6 runner reds (R4 §3.1);
- the 7 extra reds the formatter produces (R4 §4.1);
- that no retained number was measured on the final tree (R2 §5).

**Why it matters:** Astra could not have seen the first three, because they lie outside the focused runs its receipts record. The
fourth is a defect in the record.

---

## 5. Gates as measured at the clone (R4)

**Setup.** R4 measured everything in one fresh clone, `cesium-lane-hasufel-20260926`, provisioned by
`Tools/provision-worker-clone.mjs` → `READY`:
- **Base first**, then **after** a plain `git apply` (rc 0, with four blank-line-at-EOF warnings).
- Node 22.23.2 throughout.

| Runner | Base (tip) | After patch | After the formatter (LF) | CI-wired? |
|---|---|---|---|---|
| `test-cloud-c13` | 663 / **635 pass / 0 fail** / 28 skip | 765 / **720 / 13** / 32 skip | **717 / 16** | no |
| `test-cloud-c13-quarantine` | 150 / 146 / **4** | 151 / 141 / **10** | **139 / 12** | no |
| `test-visual-regression-node` | 906 / 906 | 909 / 909 | 907 / **2** (one is a shim artefact) | no |
| `test-visual-probe-contracts` | 346 / 346 | 346 / 346 | 346 / 346 | no |
| `test-sky-atmosphere` (new) | no such script | 101 / 101 | 101 / 101 | no |
| `test-build-infra` | 195 pass / 1 skip | 195 / 1 | — | **yes** |
| `lint-comment-markers` | rc 0; 179 markers / 83 files | rc 0; 179 / 83 | — | **yes** |
| `comment-marker-guard --verify-cleanlist` | rc 0; 671 entries | rc 0; 671 | — | yes |
| `verify-tracked-references` | PASS | FAIL 16. 14 are UNTRACKED new files that an audit clone may not `git add`; 2 are generated shader modules MISSING from an unbuilt tree. All 16 are artefacts. | — | **yes** |
| scoped `tsc -p` (touched `.ts` + engine `.d.ts`) | 139 × TS2307 (generated modules) | 142 × TS2307; **0 other errors** | — | — |
| `npm run tsc-engine` | skipped (tree not built) | skipped | — | CI, after a build |

**The reds** (R4 §3.1 gives the first failing assertion for each):
- **1** — `cloud-tier-single-source` crashes at load, because `CloudLayerProfile` is unmodelled.
- **2** — `aerial-path-length:1362`: a slice end marker moved, so esbuild sees a duplicate declaration.
- **3–8** — `cloud-primary-shell`: `wgsl-mini-eval` cannot parse the `!` in the empty-weather skip.
- **9** — `cloud-primary-ray:471`: the composition regex does not know about the `CloudLightingCacheWGSL` insert.
- **10–11** — `cloud-march-transfer`, a spec the patch did not touch: `genusForwardG` moved, and `genusErosionDepthScale` changed
  signature.
- **12–13** — `tier-lighting-dials`: these fail on CRLF only.
- **Q1–Q7** — quarantine specs: three causes.
  - compositions that lack `CloudLightSampling` or `CloudLightingCache`;
  - the widened emit gate;
  - a moved call.
- **Fixed:** `cloud-observability-counters` D8 was red at base and is green after.

**The seven reds that appear only after the formatter runs** (R4 §4.1). Each pins the unformatted spelling of an engine line:
- `aerial-path-length:1264`
- `density-response:81`
- `sparse-updates:126`
- `tier-lighting-dials:1701`
- `march-emission` A2 at `:230`
- `march-emission` E4 at `:1042`
- `weather-map-seam:581`, which sits in `test-visual-regression-node`

**The five new specs** each pass on their own when run from the repository root. Two of them fail when run from
`Tools/visual-regression/` (R4 §2).

**What CI would have said: red at `prettier-check`.** None of the failing test runners is wired into a workflow (R4 §3; R5 §1c,
from `git grep 'npm run'` over `.github/workflows`). But `npm run prettier-check` is (`dev.yml:27`, `prod.yml:32`), and the patch
fails it on 44 files. The first draft's "nothing" was wrong (critic C6).

**Runners nobody ran on the patched tree** (critic C7; so "13 + 6" is a lower bound):

| Runner | Spec → the modified file it reads |
|---|---|
| `test-engine-node` | `godray-energy-law` → `WebGPUPostProcessPipeline.ts`; `translucent-cull-render-pass-bracket`, `gpucull-blackframe-isolation-arm-expectations`, `polyline-taa-velocity-emission` → SceneRenderer / SceneFramebuffer; `vector-layer-draping`, `clipping-polygon-rebake-revision-signal`, `buffer-primitive-collection-feature-renderer-teardown` → FeatureRenderers |
| `test-model-webgpu` | `pipeline-key-aliasing` (imports `WebGPUShaderDefines.ts`, base spec `:222`), `globe-pipeline-prewarm`, `globe-material-texture-uniform-binding` → `WebGPUShaderDefines.ts`, whose `hiDefineBit` moved to `WebGPUShaderDefineBits.ts` |
| `test-readiness` | 2 specs (critic's mapping) |
| `test-s5` | 2 specs (critic's mapping) |
| `test-blend-parity` | `webgpu-ao-*` → `WebGPUPostProcessPipeline.ts` |

I re-derived the runner definitions (`package.json` at `b263d8ac5e`, lines 167, 204–206, 212) and the `pipeline-key-aliasing` import;
the rest of the mapping is the critic's `git grep`, not re-run by me.

---

## 6. Collisions and landing order (R5)

**The frozen patches are disjoint from Astra's 81 files.** R5 measured all four patches passing `--check` at `a76d42b3f8`, with
these md5s:
- W2-L11 `angrim.patch` (`2a93187d…`) — **unlanded**;
- census `vinitharya.patch` (`b4783964…`) — **landed since, as `b263d8ac5e`, Batch 1537** (same four files plus a
  `TOOLING_CATALOG.md` row; critic C11);
- ring ledger `pimpernel-ledger.patch` (`7140f89d…`) — **unlanded**.

At `b263d8ac5e` the Astra patch, the TaskProcessor packet and `decomposition-doc.patch` still pass `--check` (re-derived here).

**Mirror run.** In a mirror with Astra's files overlaid, 54 of 55 Node tests pass. The one failure is `prettier` missing from the
mirror, not a collision (R5 §1a).

**Three non-textual couplings remain:**
- **Angrim's `test-engine-node` value.** The value Angrim owes for `test-engine-node` is a **context line** of Astra's `package.json`
  hunk. The seat therefore re-composes that hunk rather than applying it.
- **Ring-ledger citations.** The held ring ledger cites tip lines that Astra moves.
- **W2-L11's karma selection.** It covers `Core/TaskProcessor`.

**Planned lanes:**

| Lane | Overlap with Astra | Kind |
|---|---|---|
| Ring I-3 (C13-N69) | `WebGPUCloudTierPresets.ts` (`resolveCloudPreset`, base `:213–243`; Astra's hunk is at base `:239–251`), `CloudVolumetrics.js` | **Same hunk, and semantic.** I-3's budget must cover three things: raw `cloudQuality`, `cloudPrimarySteps`, **and** the `chord / maximumStep` interval law (R5 §2.1). |
| Ring I-5 (realisation override) | `WebGPUCloudTierPresets.ts`, `WebGPUProceduralCloudRenderer.ts` | **Same hunk, and semantic.** (1) Astra's public `cloudPrimarySteps` contradicts I-5's "no public API" rule. (2) Bits 0 and 13 now also gate the specialised module and empty-weather skipping, so I-5's oracle, "clearing exactly one bit changes nothing else", fails on Astra's tree whenever either opt-in is on (R5 §2.1). |
| C13-N60 / N61 / N13 | `ProceduralClouds.wgsl` (+460 / −767) | Textual and semantic. See the notes after this table. |
| Ring Leg 2 and I-5's Edge leg | tier-path code at defaults | On the generic module, Astra changes the comb accumulator, the step law, the density field (billow) and the noise-mip argument (R5 §2.2's four items). **A fifth, added in this revision (critic C3):** the ring rig sits at 6,608 km with `cloudAerialMode` unset, so it renders the physical aerial path, which U4/U15 rewrite. **The Leg-1 frames are not a baseline for Astra's tree** (R5 §2.2). |
| C12 / S3 receipts taken at the tip | the eclipse gate's captured band | Any receipt taken at the tip after Astra's engine units measures a different march (R5 §2.4). S3's own Edge job is insulated, because it runs on `ea651de6d8`. |
| Gemini comment plan (`inventory.json`, 100 files) | `WebGPUFeatureRenderers.ts` only | **Different hunks:** Gemini's is at `:634`, Astra's at `:879`. They can land in any order. |
| CI tranche 2, C15-06, S3-L3/L4, I-1, I-2, I-4 | none | Only `package.json` composition. W2-L5's import of `WebGPUShaderDefines.js` is unaffected, because `ENHANCED_OCEAN` stays at bit 1 (R5 §1b). |

**The C13-N60 / N61 / N13 collisions in detail:**
- **N60.** N60's pad rename conflicts textually with Astra's struct hunk, which carries `_padJ` / `_padK` as context.
- **N61.** N61's site moves to astra `:2400`, where `curFineStep` now follows a different law.
- **The MSAA1 / N62 binding site** moves into the new `WebGPUCloudCompositeResources.ts:278`.

**R5's order, taken into LANDING_PLAN:**
1. Freeze the TaskProcessor unit.
2. Land the frozen patches (now two: `angrim`, `pimpernel-ledger`).
3. Run ring Leg 2 and I-5's leg on a pre-Astra tree.
4. Bank any C12 / S3 receipts wanted at the tip.
5. Land I-5, then I-3.
6. Land N60 / N61 / N13, with one owner of `ProceduralClouds.wgsl` at a time.
7. **Then** land Astra, rebased.

**The seat's standing work during those steps:**
- In each Astra batch, the seat assembles `package.json`, the seatbelt and the ES6 status rows.
- Bits 6 and 7 and QF bit 14 stay reserved until their disposition is ruled.
- After Astra lands, any lane that edits `lib/wgsl-mini-eval.mjs` owes Astra's eleven mini-eval specs a run (R5 §2.3).

---

## 7. Decisions for the maintainer

The full text is in `ASTRA_AUDIT_DECISIONS_2026-09-26.md`: each decision has only the sound options, a recommendation, and what executes it.

| D | Question | Recommendation |
|---|---|---|
| D1 | Landing direction for the stack | **Return it, rebase it after the seat's lanes, and re-cut it into class batches A1–A3.** Each batch gets an Opus 5.5 reviewer, a verifier and an Edge leg. Do not land it as-is, and do not have the seat cherry-pick hunks. |
| D2 | The failed sparse candidate | **Strip it**, per Astra's own rule, and write a withdrawal record |
| D3 | `ShaderDefineHi` bit 7 (and bit 6, QF bit 14) | **Reserve bit 7 in writing:** a comment line in the registry, landed with bit 6, plus a `DEFERRED_WORK` row. Bit 6 and QF bit 14 stay reserved for Astra until its batches land. |
| D4 | Default-path byte changes | **D4a:** accept the U19 sky fixes on both backends and the LUT changes, each with its named Edge leg. **D4b:** accept U8; put U11 behind a dial in A2c (hashes re-frozen once, identity proven by execution); revert U32b; hand U3 to N13's owner; **b5, now a ruling:** accept U4/U15 as the new default orbital aerial in A3, after the ring leg, with an orbital E9 cell. |
| D5 | The TaskProcessor Core fix | **Its own Core batch, after W2-L11,** on the full proof bar, **with the WASM-init race guarded in the same batch** (option D, added after critique) |
| D6 | WebGL twin gaps | **Record the gap** (`DEFERRED_WORK`, `FEATURE_INVENTORY` §C, and "WebGPU only." on every dial), **plus a §D FUTURE row** for a WebGL volumetric-cloud path |
| D7 | `eslint.seatbelt.tsv` rows | **The seat regenerates them** on the landed tree, in each batch |
| D8 | Astra's next assignment | **Make this stack landing-ready first.** Astra strips, fixes, rebases and re-cuts; seat Opus 5.5 lanes do the review, the inertness mutants and the Edge legs. No new cloud features until A1 lands. |
| D9 | C13-N69 hang ownership (plus the C13-N13 march law and `cloudPrimarySteps`) | **The seat's I-3 lane owns N69 and N13's owner owns the march law,** both ahead of Astra. No public sample-count dial until I-3's budget lands; Astra's own receipt shows `cloudPrimarySteps` = 384 hanging a 1080p orbit (RA:299). |
| D10 | Astra's docs and the decomposition-log patch | **Do not land them.** This audit and the ledger rows are the record; the seat rewrites the ES6 rows. |
| D11 | Shape of the `CloudVolumetrics` API | **An ES6 class whose validated dials are own enumerable accessors on the instance** (option C, added after critique), with JSDoc and "WebGPU only." on every dial. The constraint: `CloudCollection._resolveVolumetricConfig` passes the dials on with `{ ...this.volumetric }` (base `CloudCollection.js:367–373`). An object spread copies only own enumerable properties, invoking own accessors, so instance accessors survive it and prototype accessors would not. A spec pins that every documented dial reaches the resolved config. The count is **9** new dials after D2, D9c and D12(a), not 14. |
| D12 | The HOLD chain's plumbing (U23, U26, U29, U30), which runs on the default path of kept units | **(a) Keep the plumbing as STRUCT under the A1 identity leg; remove the public entry points and the slot writers; name the slots as reserved pads** (added after critique, C1) |

---

## 8. Landing plan — summary

The full plan is in `ASTRA_LANDING_PLAN_2026-09-26.md`. **Nothing lands before the rulings.**

- **Phase 0 — seat acts that need no ruling.** Node only, no Edge.
  - Bank this audit.
  - Freeze the TaskProcessor unit with an md5.
  - Give `fog-cheap-coverage-gate.spec.mjs` a runner home, once it is measured green at the tip. That guards main against the P0
    class today. **[Done 2026-09-26: Batch 1538.]**
- **Phase 1 — the seat's queue:**
  1. The two remaining frozen patches, `angrim` and `pimpernel-ledger` (the census patch landed as Batch 1537).
  2. T1, the TaskProcessor batch, with the WASM-init guard (D5).
  3. Ring Leg 2 and I-5's leg, on a pre-Astra tree.
  4. C12 / S3 receipts at the tip.
  5. I-5, then I-3, together with the native 96/8 A/B (E4). **E4 is a hard gate before E5**, and its patch arm is pinned to
     `b263d8ac5e`, before I-5/I-3 edit the same `resolveCloudPreset` hunk.
  6. N60 / N61 / N13.
- **Phase 2 — Astra's return:** the strip, the fix list (now F-1 … F-19), a rebase in a fresh clone, and the re-cut.
- **Phase 3 — Astra's batches:**
  - **A1** — byte-neutral structure, plus the P0 fix, plus the HOLD chain's profile plumbing as STRUCT (D12).
  - **A2a** — **default work (LUT bake)** plus the atmosphere opt-ins; it gets the adversarial verifier (critic C10).
  - **A2b / A2c** — the inert opt-in features: lighting (with U25's dormant peer code), and march/performance (with the U11 dial).
  - **A3** — the default-path changes, as ruled, now including the physical aerial path U1/U2/U4/U15.
  - The wave-end gate follows A3.
- **Never landed:**
  - U37, which is stripped.
  - The HOLD chain **as features**: no public entry point, no slot writer (D12).
  - U20b, unless D9 re-admits it.
  - U32b, unless a new stripe gate passes.

**One Edge slot.** The queue, E1–E10, is in `ASTRA_LANDING_PLAN_2026-09-26.md` §5.

---

## 9. What this audit did not measure

**No browser ran.** Every rendering claim is **unverified until an Edge job runs it**. Each item below names the measurement that
would settle it.

1. **Does the invalid fog pipeline blank the whole frame, or only the fog?** An Edge run with `volumetricFog.enabled = true` under
   `pushErrorScope("validation")` (R3 §9.1).
2. **Is the SDR sky byte-identical over the full frame?** Astra measured only the top 1920×300 (R3 §9.2).
3. **How large are the HDR-display sky change and the WebGL clamp change?** (R3 §9.3, §8)
   - paired captures with `highDynamicRange` forced on, on both renderers, at ground level and at 30 km;
   - one run on an HDR-capable display.
4. **What does the first irradiance bake cost?** It is 25.2 M segment evaluations. A GPU timestamp through `CesiumDebug.gpuPassCost`
   (R3 §9.4).
5. **Does the 52.9 s async specialised compile starve other pipeline compiles?** An Edge startup trace with self-shadow on (R3 §9.5).
6. **Does the patched tree build and type-check?** `npm run tsc-engine` and a build were not run, because the audit forbids builds
   (R3 §9.6, R4 §6.2). This includes whether the two new `.js` modules work in the webgl-only variant (R1 §5.6).
7. **Native 96/8 `DXGI_ERROR_DEVICE_HUNG`: present at base, or caused by U3's sentinel? Does it need multi-deck?** (R1 §5.4,
   R3 §9.7; critic C5)
   - A two-tree native 1080p high multi-deck A/B: base, and base + the frozen patch pinned at `b263d8ac5e`.
   - A third arm: Astra's tree with U3's step bounds reverted.
   - A fourth arm: single-deck, tier 3, at defaults, on base.
   - **This is hang-risk work.** Bounded deadlines; the lane owns the machine; never 512 steps at 2048² (R5 §5.2).
   - **Until it reports, every native high cell in this plan runs under its hang protocol.** Astra's receipts put the hangs in
     feature-off controls (Y12), so no default-path native cell is known safe.
8. **The 28 godray / primary-ray tests that skip on an unbuilt tree**, 4 of them new godray tests. A built, disposable clone
   (R4 §6.1).
9. **Does the default image move with clouds on, and what does the chord-proportional sentinel cost?**
   - A two-tree capture and a grazing-orbit pass timing (R4 §6.4).
   - The STRUCT identity claims of U22, U24, U27, U28 and U36 also still owe a byte check (R1 §5.8), as do U18's gate change,
     U20a's identity branch, U21's disabled branch, U36's skip, the HOLD plumbing (D12), and the procedural sky fill that serves
     model IBL (`SkyUniforms` + 4). Each byte-identity cell carries a same-build repeat control (R-2026-09-16-7; critic C9).
   - **No longer open:** whether U4/U15 reach the default. They do, at ≥ 100 km (§2.2 U4 row); what remains is the size of the change,
     which E9's orbital cell measures.
9a. **Are the runners nobody ran green on the patched tree?** `test-engine-node`, `test-model-webgpu`, `test-readiness`, `test-s5`,
   `test-blend-parity`, and the CI steps `prettier-check`, `eslint` (frozen seatbelt: does it fail when a renderer count
   *decreases*?), `test-webgpu-policy`, `collection-sentinels-check`, `test-c16`, `test-landing-rules`. Settles it: one run in a
   provisioned clone with the patch applied (critic C6, C7, could-not-settle #1–#2, #4).
10. **The ring questions:**
    - **Does Astra's tree move the off-axis ring family?** Leg 1's M0 recipe on Astra's tree, scored with the same estimator
      (R5 §5.1).
    - **Is `cloudPrimarySteps = 512` hang-class on the tier path?** Tarciryan C's 512² measurement, from a lane that owns the machine
      (R5 §5.2).
    - **What is the frame-average increase in iterations?** Not settled (R5 §5.3).
11. **Does the HDR-canvas format-cache defect exist at base?** That decides whether U8's cache repairs are fixes to base, and so
    candidates for cherry-picking. One Edge cell on a base build (R2, could-not-settle #1).
12. **Does any retained number hold on the final stack?** None was measured there (R2 #2).
    - Re-run the specialisation `integrated-01`, and empty-weather `runtime-01` / `edge-coarse-01`, on the stripped stack with the
      same frozen-input harness.
    - The 171 against 448 ms run-to-run swing is also unexplained (R2 #5).
13. **RTE compliance of the new WGSL.** Nobody audited it this time (R1 §5.10). A reviewer owes an RTE pass on
    `CloudLightingCache.wgsl` and the other new WGSL. `CloudSparseUpdates.wgsl` is being stripped.
14. **Taken on Astra's word, not re-derived:**
    - the 64-field / 140-float lighting-dependency set (R2 #3);
    - the raw GPU readbacks behind the ambient `gpuChecks` booleans, which are not in the packet (R2 #4).
15. **The TaskProcessor unit.** Its inertness mutant was reasoned about, not run (R3 §7). The unit sits outside the frozen snapshot
    and has not yet been frozen independently (R4 §6.5).
16. **Karma interactions.** The changes to `WebGPUSceneRenderer.ts` (−101 lines), `WebGPUPostProcessPipeline.ts` and
    `WebGPUDynamicEnvironmentMapManager.ts`, against specs outside tranche 2 (R5 §5.8).
17. **Is the photometry library's transfer premise still right** now that the composite is linear? (X10; R1 §5.7)
18. **Return-audit capture runs 01 and 02.** The refusal reasons Astra gives do not match the only receipt, and run 01 has no receipt
    in the seat (R2 #6).

---

## 10. Changes after critique

The critic, Felarof (Opus 5.5), wrote `cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/CRITIQUE_FELAROF.md`: 17 MUST-FIX findings (C1–C17) and 13 ACCEPT items (A1–A13). Every
MUST-FIX was **accepted and fixed in place**; none is rebutted. Before each fix I re-derived the finding's premise from the patch,
the base or the clone, as listed in the "Re-derived" column. Where I could not re-derive a part, the column says so.

| # | Finding | Re-derived by me | Disposition | Where |
|---|---|---|---|---|
| C1 | The HOLD chain has no executable disposition; its plumbing runs on the default path | `CloudLightSampling.wgsl:629–658` and callers (astra `ProceduralClouds.wgsl:1320, 1412, 1511, 2195`); `multiScatterLight(…, profile, peerTransport)` at `CLS:524`; peer-line counts 28 / 12 / 8; slot chain P:9974–10003 (220, 224, 228–255, 256–259) | **Fixed.** New D12 (recommend (a): plumbing as STRUCT, entry points and slot writers removed, slots named reserved pads). New F-18. U5, U23, U26, U29, U30 rows and §2.4 rewritten. D11's `cloudLayers` validation applies only under D12(c) | audit §0.4, §2.2, §2.4, §7; DECISIONS D1, D11, D12; LANDING_PLAN §1–§4 |
| C2 | U21 cannot be LAND; taking U3 out breaks U21 and U36 | astra `CloudDensityDomain.wgsl:221–255`; astra `ProceduralClouds.wgsl:2255, 2273, 2281, 2314, 2321`; base `:2491, :2501, :2506` | **Fixed.** U21 → LAND-AFTER-FIX; tally 9 / 21 / 8 / 1. F-12 now names four revert parts and three re-fits (U21, U36, U27) onto the tip's law, which is the post-N13 law once P1.6 lands. F-15 re-measures U36 | audit §0.4, §2.2, §2.4; LANDING_PLAN F-12, F-15 |
| C3 | U1/U2/U4/U15 reach the default at ≥ 100 km | base `WebGPUCloudTierPresets.ts:200, 309, 364–368`; base renderer `:3818–3823`; no other altitude gate (`git grep`); astra `ProceduralClouds.wgsl:2619–2631` and renderer `:3754–3756` (`QF_AERIAL_LUT`); ring rig `:40–60` | **Fixed.** D4b b5 is now a ruling with options (i)/(ii), recommending (i) in A3 after P1.3. U1/U2/U4/U15 moved to A3; orbital cell added to E9; a fifth ring-rig default-path change recorded in §6 (R5 is a reader report, so the addition lives here rather than in R5 §2.2) | audit §0, §2.2, §3 Y3, §6; DECISIONS D4b; LANDING_PLAN §1, §3 |
| C4 | U11 orphaned under b2(ii); "hashes return to base" is impossible | base `cloud-density-domain.spec.mjs:79–87, 700–716`; P:1250–1272 (three-part re-freeze note) | **Fixed.** U11's dial lands in A2c with a dial-off identity cell; the hashes are re-frozen once with the three-part reason; default identity is proven by executing the evaluators | audit U11 row; DECISIONS D4b b2; LANDING_PLAN F-5, F-12, A2c |
| C5 | The native hang is mis-attributed and its hazard not propagated | RA:299, RA:335, RA:377, CP:71 read verbatim; base tier 3 `:168–172`, band `:201` | **Fixed.** D1's HOLD basis restated (author's visual-validation FAIL, not a unit-caused hang). Y12 rewritten. E4 is a hard gate before E5, its patch arm pinned to `b263d8ac5e`, plus a single-deck arm. Native high cells run under E4's protocol until E4 reports. RA:299 cited in D9c | audit §2.4, Y12, §9 item 7; DECISIONS D1, D9c; LANDING_PLAN §3, §5 |
| C6 | "CI would have stayed green" is false: `prettier-check` is a CI gate | `.github/workflows/dev.yml:27`, `prod.yml:32`; `package.json:201` at `b263d8ac5e` | **Fixed.** §0 item 3b, Y17 and §5 corrected. Five CI gates added to LANDING_PLAN §6 item 5, plus `test-c16` and `test-landing-rules` (CI-wired at `dev.yml:83, 85`, also not run) | audit §0, Y17, §5; LANDING_PLAN §6 |
| C7 | Five runners reading modified files were never run | runner definitions at `package.json:167, 204–206, 212` (`b263d8ac5e`); `pipeline-key-aliasing.spec.mjs:222`; `hiDefineBit` move at P:6559/6575/12861. The per-spec mapping is the critic's, not re-run by me | **Fixed.** Added to §5 and LANDING_PLAN §6 item 5; "13 + 6" is stated as a lower bound | audit §0, §5, §9 item 9a; LANDING_PLAN §6 |
| C8 | The quarantine gate must name its reds | R4 §3.1 (lines 197–198 of R4) | **Fixed.** Gate = red set ⊆ {F1a, F1b, `cloud-shadow-rte:828`} | audit §2.1 C1; LANDING_PLAN §6 |
| C9 | Identity legs miss default-path changes | P:4442 (U18 gate); astra `CloudDensityDomain.wgsl:216–219`; P:4470–4471 (`SKY_UNIFORM_FLOATS` + 4); P:11440–11450 (slot 55); R-16-7 text | **Fixed.** Repeat control on every byte-identity cell; HDR-on default-scene cell in E5; clouds-on default identity at ground/flight/orbit in E7 and E8; glTF/IBL cell in A2c's leg; E9 forces HDR on an SDR display for every cell but canvas output | LANDING_PLAN §3, §5 |
| C10 | A2a is default work labelled "opt-in" | D4a rows a3, a4, a5, a7 as written | **Fixed.** A2a relabelled "default work (LUT bake) + atmosphere opt-ins" and given the adversarial verifier | audit §8; LANDING_PLAN §1, §3, §6 |
| C11 | Live state stale | `git log -1 b263d8ac5e` (01:28:04 EDT); 1537's file list; `--check` of the Astra patch, TaskProcessor packet and decomposition patch at `b263d8ac5e`; porcelain 21 | **Fixed.** Header and live state name `b263d8ac5e`; P1.1 is two patches; the `test-visual-regression-node` base count is flagged as moved. I did **not** re-run `--check` for `angrim` / `pimpernel-ledger` at the new tip | audit header, §6; LANDING_PLAN §1 |
| C12 | The fog P0 population is understated | base `WebGPUVolumetricFogRenderer.ts:843–852`; base `AtmosphericEffects.ts:466, 615–631`; base `AtmosphericConditions.js:1408` | **Fixed.** Three switches named | audit §0, Y1 |
| C13 | D4a a6's proof is wrong and a6 is not MOVES-G | base `SkyAtmosphere.js:173`; base `AtmosphericConditions.js:626–636` | **Fixed.** a6 reclassified; proof = an assertion that an explicit 0 packs 0 and unset packs 50 | audit U19 row, Y3; DECISIONS D4a; LANDING_PLAN F-10 |
| C14 | D5 misses option (D) and a freeze identity | base `TaskProcessor.js:273–320` (the init path posts after its awaits whether or not `onerror` fired); packet md5 `c4016b88…`; index-stripped packet md5 = index-stripped clone diff md5 = `c3cb96b14feb04590a22e8c61e76dd52` | **Fixed.** Option (D) added and now recommended; freeze identity added to P0.2 | DECISIONS D5; LANDING_PLAN P0.2, T1 |
| C15 | D11 misses option (C); dial count stale | P:7098–7244 (the 14 dials); base `CloudCollection.js:367–373`; base `AtmosphericConditions.js:1036–1045` (house precedent: `Object.defineProperties` with `enumerable: true`) | **Fixed.** Option (C) added and now recommended; count 14 → 9 | DECISIONS D11; audit §0, §7 |
| C16 | A load-bearing WHY comment was deleted | P:4487–4494 (removed); P:11545–11600 (new file lacks it) | **Fixed.** F-19 restores it | audit Y10; LANDING_PLAN F-19 |
| C17 | Moot R-2026-09-16 clauses not recorded | `grep -c` over the patch: 0 for each of the ten identifiers in §3.3 | **Fixed.** New §3.3 with a moot / holds / executed row per clause | audit §3.3 |

**ACCEPT items folded in as sharpenings:** A1 (U33 can be made net-nil once U32b is reverted; the IGN's only stack caller is
astra `ProceduralClouds.wgsl:1493`, re-derived), A7 (U17 settled by the patch; leg wording corrected), and the D4a a5 note (the
retry is a per-frame CPU early return, U10 row). A2–A6 and A8–A13 needed no change.

**What the revision still could not settle** (added to §9 where new): whether the runners in C7 and the CI steps in C6 are green
(§9 item 9a); whether the native hang needs multi-deck (§9 item 7); the size, not the existence, of the orbital aerial change
(E9); and `--check` of `angrim` / `pimpernel-ledger` at `b263d8ac5e`.

---

*Written by Asfaloth (Opus 5.5), 2026-09-26, from the five reader reports R1–R5; revised the same night after Felarof's critique
(§10).*

*My own re-derivations are marked "(re-derived here)" in the text:*
- *the patch md5 and composition;*
- *the `runtime-02` verdict;*
- *the fog shader's double declaration and the place the two are concatenated;*
- *the trace of the multiple-scattering gather;*
- *the A2 hunk;*
- *the GLSL clamp;*
- *the JSDoc for `SkyAtmosphere.multipleScattering`;*
- *the seat's live state.*

*No repository was written. No git write command, build, browser, install or Python was run, and no temp root was created. In the
revision every git call in the seat and in Astra's clone ran with `GIT_OPTIONAL_LOCKS=0` and was one of `log`, `show`, `grep`,
`diff`, `status --porcelain` or `apply --check`; the patch md5 was re-verified (`a23f4d79…`) before it was read.*
