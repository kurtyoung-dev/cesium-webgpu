# Audit of Gemini's comment-and-documentation plan (2026-09-20) — synthesis

_Tracked 2026-09-26 with its companion [`GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md`](GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md). **Ruled 2026-09-26, every decision as recommended: [`MAINTAINER_RULINGS_2026-09-26.md`](MAINTAINER_RULINGS_2026-09-26.md), `R-2026-09-26-13`…`-22`.** The reader reports G1–G3, the brief and the critique are banked at `cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/audit/`; Gemini's plan, inventory and scripts at `cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/gemini-deliverable/`. The text below is the audit as revised after critique; its tip references are its state when written._

Synthesizer: **Adamanta** (Opus 5.5, read-only). Seat: Gandalf. Written 2026-09-26.
Seat `F:/Dev/GH/cesium-webgpu`. The first pass ran at `a76d42b3f8`. **The tip is now `b263d8ac5e`** (Batch 1537,
01:28 EDT 2026-09-26, `== origin/main`). That batch touches only four `Tools/` spec/receipt files and `TOOLING_CATALOG.md`,
so every engine-source count in this report holds at both commits. "The tip" below means `b263d8ac5e` unless a
figure is labelled `a76d42b3f8`. `git status --porcelain` = 21 lines before and after, and the maintainer's held set
was not touched. Nothing was built, installed or landed. The revision pass used one temp root,
`<os.tmpdir()>/cesium-lane/adamanta/`, for two read-only probe scripts, and removed it at the end (§11).

Subject: `cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/gemini-deliverable/implementation_plan.md` (banked verbatim from Gemini's own workspace)
("the plan"), its `scratch/inventory.json` ("the inventory") and `scratch/{dump_inventory,audit_comments}.mjs`.

Inputs: three reader reports, banked at `cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/audit/` — `G1_INVENTORY_REPRODUCED.md` (Rochallor), `G2_RULES_AND_POLICY.md`
(Stybba), `G3_COLLISIONS_AND_LANDING.md` (Gamgee) — and my own re-measurements at the seat, marked **(Adamanta)**. Where a
figure is a reader's, the reader is named. Decisions for the maintainer are in `GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md` (G1–G10).

---

## 0. Verdict

**Do not adopt the plan. Execute the C16 tail from `QUEUE_2026-08-10_CAMPAIGN16.md`, and bank Gemini's plan and
inventory as evidence.** (Relabelled after critique. The first pass said "adopt as amended", but the amendments
replace the plan's channel, phases, gates and scope. Its inventory is what survives.)

- **The diagnosis is right, and the count reproduces exactly.** The inventory reproduces byte for byte (md5
  `ccc3529d…`, Rochallor). Its guard half is the C16 guard's own census: 179 findings in 83 files. I re-ran
  `node Tools/c16/comment-marker-guard.mjs --json` at the tip and got 179 warnings, 0 errors, 83 files and no stale
  grandfather rows (Adamanta).
- **"100 files / 211 occurrences" is a count of regex hits, not of defects.** It comes to 200 distinct spans in 169
  comments. One hit is a false positive in upstream text. 28 of the 32 hits added by Gemini's extra regex are
  citations of constraints that the fork's own rules require. None of the 211 names an AI model.
- **The remedy conflicts with the fork's written standard in five places:**
  1. It sends knowledge to a new `Documentation/Features/` channel instead of `migration_doc/DEV_NOTES_<subsystem>.md`.
  2. It would replace published API documentation.
  3. It would re-publish stale Principle-7 status text as "permanent".
  4. It skips four of the seven steps of the C16 shard protocol.
  5. It sets two gates that cannot be met as written: `--strict` exit 0, and grandfather cleanup left to a final phase.
- **None of the five proposed documents should be created.** All five sources keep their constraints in the code. The
  small amount of real history goes into existing DEV_NOTES files or existing ledger rows (§5).
- **"Comment-only" is not "artifact-only" in this fork (added after critique).** Three build or runtime transforms
  read comment text: the release pragma strip, the minify-time WGSL comment strip and the unminified GLSL
  `ShaderSource.removeComments`. Bundler magic comments (`webpackIgnore`) also matter. `comment-only-diff` sees none
  of these. I reproduced six edits it certifies as `comment-only` that crash, drop code, or ship a broken module (§11).
  Every such hazard is absent from the corpus today (0 of 330 GLSL files, 0 of 325 WGSL files, 0 of 1,517 JS/TS
  files), so flavour-aware checks start green. They land in B0-tools, and every other batch depends on B0-tools.
- **What to do instead.** Run the 100 files as the Campaign 16 tail, as 11 comment batches plus 2 Tools batches. Every
  batch is Node-only. None needs the Edge slot **once B0-tools' flavour checks are in U1** (§7.3). Land them one at a
  time. Four batches have gates:
  - B5a and B5b wait for W2-L5.
  - One line in B3b waits for W2-L8.
  - One file in B4 waits for Angrim (W2-L11).
  - B6-sky should trail Astra's sky pieces.

  Nothing else in the wave has an ordering constraint with Astra. The Astra audit's collision reader reached the same
  conclusion independently (`cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/R5_COLLISIONS.md` §3 item 3).
- **Premise correction.** The brief and the computed task both call
  `migration_doc/CODEBASE_CODING_AND_COMMENT_STANDARDS_AUDIT_2026-09-14.md` "the maintainer's own 09-14 audit". It is
  **Gemini's earlier audit document**, which the maintainer holds untracked until nine corrections are applied
  (`MAINTAINER_RULINGS_2026-09-16.md` `R-2026-09-16-11`, `MAINTAINER_RULINGS_2026-09-17.md:45-60` `R-2026-09-17-2`:
  "Gemini's audit document LANDS after the nine corrections"). The maintainer's own conclusions on this subject are
  the rulings `R-2026-09-16-11`, `R-2026-09-17-2` (with its do-not-execute list), `R-2026-09-17-6` and `R-2026-09-17-7`.
  §4 reconciles the plan with both the document and the rulings.

---

## 1. The inventory, as measured

### 1.1 Headline counts

| Quantity | Plan claims | Measured at `a76d42b3f8` | Source |
|---|---|---|---|
| Files scanned | 2,872 | 2,872 = **2,215 tracked + 657 gitignored build-generated shader `.js`** (0 hits) | Rochallor |
| Files flagged | 100 | **100** = 83 guard-visible + 17 flagged only by Gemini's extra regex; widgets: 0 | Rochallor; guard re-run (Adamanta) |
| Occurrences | "211 distinct" | 211 raw = **179 guard + 32 extra-regex**; **200 distinct spans** in 169 comments; 199 genuine after the one false positive | Rochallor |
| Guard census | — | 179 / 83, `--strict` exit 1, default exit 0, `--verify-cleanlist` exit 0 (671 entries, 15 grandfather rows, 53 grandfathered findings) | Rochallor, Stybba; census re-run (Adamanta) |
| Trend | — | 199 / 88 at `c325f858c3` (09-13, today's grammar) → 179 / 83 at the tip | Rochallor |
| Decorative glyphs (★ ⚠ ✅) | listed as a category | **0**. The grammar's `decorative-glyph` rule has no hits in scope. Box-drawing banners (`── `) are not in the grammar at all; they are `C16-21` item (1), 999 runs in 99 files | Rochallor; `QUEUE_2026-08-10_CAMPAIGN16.md` row `C16-21` |

### 1.2 What the extra "AI-governance" regex over-flags

All 32 hits were judged individually (Rochallor §3):

- **28 are `CLAUDE.md` citations, and each one names a constraint the fork's rules require.**
  - 13 permanent sentinels
  - 9 backend agnosticism (Principle 2)
  - 2 RTE / f32
  - 2 co-located `.d.ts`
  - 1 ShaderDefine add-only
  - 1 Principle-7 scaffolding

  The fix for each is a phrase-level edit that keeps the constraint and drops the citation. None of them is a
  relocation.
- **3 double-count a grammar `tracker-document` hit:** `TideModel.js:13`, `SnapshotModeService.js:110` and
  `ViewportQuad.js:141`.
- **1 is a genuine leak the grammar cannot see:** `Scene/MVTTileDecoder.js:12` "(see migration_doc R-4)". It has no
  slash, so the `tracker-document` rule does not match it. I re-read the line (Adamanta).
- **0 references to an AI model or agent.** Every model-name alternative (`GEMINI`, `Astra`, `Sol`, `LLM`, `GPT-*`,
  `Copilot`, …) produced no hit. The regex already needed two hand suppressions: the constellation Gemini in
  `BrightStarCatalog.js` and "Jean-Claude" in `I3SDataProvider.js`. That makes the model-name half unsuitable as a lint
  rule, because it will keep needing exceptions.

**Where they sit.** 21 of the 28 citations are in 15 clean-listed files, and 19 of those 21 were written before the
file was certified. Two were written into files that were already certified:

- `WebGPUGlobeSurfaceCameraUB.ts:101` (Batch 1470)
- `GlobeSurfaceShaderSet.js:324` (Batch 1408)

Neither is a ratchet regression, because the grammar has no rule for `CLAUDE.md`. If such a rule landed before the
rewrite, 21 citations in 15 clean-listed files would become errors that day (Rochallor §4). Decision **G5** covers this.

### 1.3 The one false positive (upstream text)

`packages/engine/Source/Core/IonSnapMode.js:4`: `all-caps-fix-label` matches `GUID-77D54C0B-D6FF-13DA-5EC8-3196330F5244`
inside a Bentley MicroStation `{@link https://…|…}` URL.

- `git diff --stat upstream/main -- …/IonSnapMode.js` is empty (re-run, Adamanta), so the file is byte-identical to
  upstream.
- The plan's Phase 1 would edit it, which churns an upstream file and breaks a valid link.
- While the finding stands, the plan's `--strict` exit 0 and `C16-20` leg (1) cannot both be met. Decision **G6** covers
  this.

### 1.4 The plan's arithmetic against its own inventory

Rochallor, Stybba:

- **The file-type table sums to 101, not 100.** The inventory has 55 `.js` files, not 56. The split is Scene 44,
  Core 3, Renderer 5, Services 2, DataSources 1.
- **The phase headings do not match the phase lists.** The headings claim 26 + 38 + 13 + 33 = 110 files. The lists
  link 102 entries, which are 101 distinct paths.
  - `WebGPUGlobeSurfaceCameraUB.ts` is in both Phase 1 and Phase 3. That puts two lanes on one file, against the
    one-defect-one-owner rule.
  - `WebGPUGaussianSplatRenderer.ts` (Phase 3) has 0 hits and is not in the inventory.
- **"26 files / 40 occurrences of JSDoc on public API" is really "hits inside a comment that opens with `/**`".**
  - 15 of the 40 are in `@private`/`@internal` blocks.
  - 12 are in `.ts`/`.d.ts`, which `build-docs` never reads (`Tools/jsdoc/conf.json` `includePattern` `.js` only).
  - 3 are in GLSL.
  - Only 7 source files put tracker text into the built reference: `CustomShader`, `Atmosphere`, `Material`,
    `TideModel`, `SampledPositionKernel`, `WasmFeatureDetection` and `WasmArenaSlots` (Stybba, measured with a
    `jsdoc --pedantic` run into temp, 828 pages).
- **The inventory records the line where the comment opens, not the marker line.** 40 of the 211 are misplaced, by up
  to 109 lines. A worker briefed from `inventory.json` must re-derive every line.

### 1.5 Shipping text the inventory does not cover

- **Marker-bearing string and template literal lines.** `string-literal-marker-scan.mjs` over both roots finds 336 lines
  in 57 files, 56 of which are not among the 100 (Rochallor). This is `C16-R1` and `C16-20` leg (2). The plan drops it,
  although Gemini's own 09-14 document had it.
- **The tide family.** "Maintainer ruling T5/T6" appears in four more files that neither scanner sees (re-derived with
  `git grep -n -i "ruling T[0-9]"`, Adamanta):
  - `HarmonicTideModel.js:13,80`
  - `TidalArguments.js:9,356`
  - `TidalConstituents.js:11,16`
  - `TideConstituentGrid.js:11`

  Stybba found three of them in the built reference. `TideConstituentGrid.js` carries one `@private`.
- **Grammar gaps that are `C16-21` material.** `AUDIT_2026_05_02 B.19` in the WASM bridge headers (Stybba),
  `migration_doc` without a slash, and `ruling T\d`.
- **Non-mechanical rules:** first person, narrative, ALL-CAPS emphasis, banners. The plan names these categories, but
  its 100 / 211 contains none of them.

---

## 2. Corrections to the reader reports (my Principle-10 pass)

1. **Gamgee's "no spec literal lands inside a flagged block" does not hold.** That sweep applied a 16-character floor.
   The C16 protocol forbids any floor (`QUEUE_2026-08-10_CAMPAIGN16.md` step 1: "NO minimum literal length").
   Re-measured (Adamanta):
   - `Tools/visual-regression/sky-light-direction.spec.mjs:245-255` asserts `src.includes("4869.9")` on
     `getSkyAtmosphereLightDirection.glsl`, with the comment "The GLSL comments quote the derived figure directly".
     `4869.9` is at `getSkyAtmosphereLightDirection.glsl:24`, **inside the same `/** … */` block (lines 1-56) that carries
     the flagged `C12-31` markers at `:5` and `:15`.**
   - The same spec at `:486-489` asserts that `SkyAtmosphereVS.glsl` does **not** contain
     `czm_getDynamicAtmosphereLightDirection`. The test reads the whole source, comments included. A natural rewrite of
     the flagged `SkyAtmosphereVS.glsl:31` comment, such as "the sky selector, not czm_getDynamicAtmosphereLightDirection",
     would turn it red.
   - **No npm runner runs this spec.** A `package.json` scan found no script containing it. Its only other listing is
     `TOOLING_CATALOG.md:1412`, as ACTIVE. So a bad rewrite would break it silently.
   - The B6-sky proof must run the spec directly (§7). It also needs a runner home, which is DX row DX-2.
   - Astra's patch edits this spec, but not these two assertions. Astra's `SkyAtmosphereFS.glsl` still contains
     `4869.9` at `:97`.
2. **`build-ts` baseline: green in CI at both commits (corrected after critique).** The two reports disagreed.
   Stybba cited the `C16-02c` row (21 `error TS`, PENDING). Gamgee cited a green seat log (2026-09-04, 0 `error TS`).
   My first pass called it "unmeasured at the tip". That was wrong, because CI measures it on every push:
   - `dev.yml:128-129`: job `release-tests`, step "release build" = `npm run make-zip`. No `continue-on-error` in the
     workflow.
   - `makeZip` = `series(release, …)` (`gulpfile.makezip.js:83-84`). `release` = `series(buildRelease,
     parallel(buildTs, buildDocs))` (`gulpfile.js:620-623`).
   - `buildTs` runs `execSync("npx tsc -p Tools/jsdoc/tsconfig.json")` and `-p Specs/TypeScript/tsconfig.json`
     (`gulpfile.js:1484-1491`). `buildDocs` is `execSync(jsdoc … --pedantic)` (`:425-437`). Both throw on failure.
   - Run `35467592179` (head `a76d42b3f8`): `release-tests` → "release build" = **success**. Run `36220924784` (head
     `b263d8ac5e`): `release-tests` fails only at "release tests (chrome)", so "release build" succeeded there too.
     I read both with `gh run view -R kurtyoung-dev/cesium-webgpu`.

   So `build-ts` and `build-docs` exit 0 at the tip. `C16-02c`'s "21 pre-existing `error TS` … PENDING"
   (`QUEUE_2026-08-10_CAMPAIGN16.md:64`) is stale. The seat can record that as a ledger fact on this CI evidence.
   Decision **G9** is re-framed on it.
3. **`SnapshotModeService` "registration skeleton only" is stale.** I confirmed Stybba's reading. Three freezables are
   live:
   - `WebGPUEnvironmentRenderer.js:2424` ("moon-renderer")
   - `WebGPUVolumetricFogRenderer.ts:887`
   - the bundle manager, through `Scene.js:4630-4633` `bundleMgr.asFreezable()`.

   `WebGPURenderBundleManager.ts:351-360` is only the JSDoc example.
4. **The `WasmArenaSlots` "7 bridges in slots 0-6 with one spare" claim is stale.** Confirmed at the tip:
   - the enum runs `DEFAULT: 0` … `POINT_CLOUD: 7` (`WasmArenaSlots.js:35,56`)
   - `packages/wasm/src/lib.rs:82` has `NUM_SLOTS: usize = 8`

   All eight slots are used and none is spare.
5. **Gamgee cites "`ForkCommentStandard.md` §6 item 2" for the ratchet contract.** §6 is Attribution. The ratchet
   contract is §8 "Enforcement", item 2 (`ForkCommentStandard.md:294-298`). The substance is unchanged.

---

## 3. Conflicts with the fork's rules

| Rule (where it is written) | What the plan does | Consequence |
|---|---|---|
| **Knowledge home.** `ForkCommentStandard.md` §2 (`:44-50`): knowledge "moves verbatim into `migration_doc/DEV_NOTES_<subsystem>.md` … relocated, never deleted". The scope paragraph (`:9-13`) says `migration_doc/` is "where development history is _supposed_ to live". `QUEUE_2026-08-10_CAMPAIGN16.md:12-16` binding gates; protocol step 4 | Invents `Documentation/Features/` and calls `migration_doc` "transitory" | Contradicts the written standard, the binding gate and Gemini's own 09-14 document (§2.3, §17 both name DEV_NOTES). Fourteen `DEV_NOTES_*.md` files already exist. |
| **Only the API reference and `Source/` ship.** `.npmignore:22` excludes `/Documentation` | Premise: Features docs are "permanent documentation" for users, while migration_doc "won't ship" | Backwards. `Documentation/` does not ship in the npm package. What users see is the JSDoc in `.js` files. |
| **JSDoc.** CLAUDE.md "Comment & JSDoc Rules"; `ForkCommentStandard.md` §5: "Do not add JSDoc that did not exist to a file you are only otherwise modernizing, and never delete JSDoc while modernizing" | Replace `TideModel.js`'s derivation and `SampledPositionKernel.js`'s lane layout with "concise upstream-style JSDoc that links to this guide" | The rule is scoped to modernizing, so its letter does not forbid this, but its purpose does. Published reference content is removed. Precedent: Batch 1509 restored 24 stripped public blocks verbatim from upstream. `GEMINI_AUDIT_VERIFICATION_2026-09-17.md:249-253` calls stripped public JSDoc a typings regression. |
| **Principle 7.** A module docstring's "what's shipped / what's a no-op" is load-bearing | Relocates three such blocks | `SnapshotModeService` (stale, §2.3) and `WasmArenaSlots` (stale, §2.4) would be published as permanent fact. `BufferPolygon2DReprojection` "producer half only" (`BufferPolygonMaterial.js:22-31`; the engine never calls it, only a probe does) and `StbnNoiseVolume` "no consumer yet" (`:20-32`; Astra's patch has 0 `stbn` lines, re-checked) are live scaffolding markers that would be hidden. |
| **Principle 9.** A missing follow-up is filed | `SnapshotModeService.js:109-110` points the multi-view limitation at the historical `WEBGPU_MIGRATION_BACKLOG.md` | No `DEFERRED_WORK` row exists (Stybba). The plan moves the prose instead of filing the row. |
| **C16 shard protocol** (`QUEUE_2026-08-10_CAMPAIGN16.md:68-116`, prescriptive) | Keeps steps 3, 5 and 7. Omits step 1 (length-blind anchor sweep), step 4 (DEV_NOTES in the same batch) and step 6 (census delta). Step 2 (non-prefix mutants) applies only where a batch re-anchors a spec | §2.1 shows exactly the defect step 1 exists to catch. |
| **Ratchet mechanics** (`comment-marker-guard.mjs` path-mode stale-row check; `ForkCommentStandard.md` §8 item 3) | Retires grandfather rows in a final Phase 5 | The guard exits 1 on a stale row for any staged file. Each batch must retire its own rows in the same commit, or it cannot commit. All 15 rows belong to inventory files (Gamgee §2.3). |
| **Gate reachability** | `--strict` exit 0. `build-ts` "exit 0". `comment-only-diff --base HEAD` | `--strict` cannot reach 0 while the IonSnapMode false positive stands (decision G6). **Gemini's `build-ts` exit 0 gate is reachable as written**: it is green in CI at the tip (§2.2). `--base HEAD` exits 3 after commit, and fails at the seat because the held `SkyBoxResolutionPolicy.ts` is in scope (Gamgee §2.1). |
| **Directives that are comments** (`ForkCommentStandard.md` §8.4 says "lint directives … count as code") | Five flagged lines are `// lint-debug-pragmas-allow: … (CLAUDE.md)` (`WebGPUDeviceLossRecovery.ts:591,627,651,695,718`, re-read) | `comment-scanner.mjs` `SEMANTIC_COMMENT_RULES` (`:115-259`) has no rule for this directive. `lint-debug-pragmas.mjs:46` keys on the prefix. A rewrite that drops the prefix passes `comment-only-diff` and turns `lint-debug-pragmas` red. The same gap exists for `/// <reference types>` (8 files) and for JSDoc `@type`/`@private` changes (Gamgee §2.1). The plan's gate list has no `lint-debug-pragmas`. |
| **Comment text read by a build or runtime transform** (added after critique; no written rule covers it) | Rewrites comments in 43 files that carry machine-read comment lines (Donnamira's count), including every WGSL, GLSL and pragma-bearing file in the 100 | `comment-only-diff` certifies the source token stream, not the artifacts. Four uncovered transforms: **(a)** `constructRegex` (`scripts/build.js:51-63`, applied to `.js`/`.ts` at `:69-83` in release builds) matches `//>>includeStart('debug', pragmas.debug)` anywhere, **including inside prose**, and strips to the next `includeEnd`. **(b)** `stripWgslComments` (`scripts/build.js:845`) tracks block comments with one boolean (`:847`), but WGSL and the C16 scanner nest them (`comment-scanner.mjs:703-710`). A glob such as `Shaders/WebGPU/**/*.wgsl` in a comment breaks the minified module only (Batch 1534's class). **(c)** `ShaderSource.js:8-21` `removeComments` runs on every builtin (`:36`) and on each combined program (`:166`) in unminified builds. It throws on a one-line `/** … */` (`match.match(/\n/gm)` is null), eats the next function when `//` text sits on a doc block's closing `*/` line, and leaves single-star `/* */` blocks for the `czm_` dependency harvest (`:60`). **(d)** Bundler magic comments: `/* webpackIgnore: true */` at `WasmHeightmapBridge.js:97`, `WasmMatrixBridge.js:71`, `WasmPointCloudBridge.js:88`, `WasmQuantizedMeshBridge.js:75` and `WasmSortBridge.js:219`, all in B3c. Three more sites sit outside the 100: `WasmCullBridge.js:223`, `WasmRTEBridge.js:84`, and `WebGPUNagaTranspiler.ts:118` with `@vite-ignore`. No rule, tool or spec protects them. I reproduced (a)-(d) with synthetic pairs; §11 has the table. |
| **Grammar ownership.** `R-2026-09-17-6` gives instrument and grammar changes to `C16-21` | Adds a governance regex, which is a grammar change, outside C16-21 | Must route through `C16-21`, with the empty-grandfather clause (`R-2026-08-21-18`) respected. |
| **Gemini's remit.** `R-2026-09-17-7`: "bounded docs now (tier-3, Opus-reviewed)" | A 100-file, four-phase engine-source programme | Exceeds the ruled remit. |
| **Upstream divergence** | Edits `IonSnapMode.js` | Churns an upstream-verbatim file to satisfy a false positive. |
| **Principle 11** (no rewrite of files over 100 lines) | Complies in form: chunk edits only | The risk the rule exists for, silent omission, is invisible to `comment-only-diff`. The control is a knowledge-disposition table that maps every removed sentence to a destination, which is how `C16-11`/`C16-12` were accepted. The plan has none. |
| **Line-number citations** | Not considered | `verify-doc-citations` is already red at the tip: 51 dead, and the seat wrapper does not run it. LIVE docs cite `WebGPUContext.ts` 547 times, `GlobeTerrain.wgsl` 208 and `ModelPBRComplete.wgsl` 166 (Gamgee). Rewrites of these files should keep line counts unchanged. |

---

## 4. Against the 09-14 document and the maintainer's rulings

- **Where the 09-20 plan agrees with the 09-14 document.** Both target the C16 residue: shaders, Scene, Renderer/Core.
  The residue shrank from 199/88 to 179/83, and the plan's guard half matches the tip exactly.
- **Where the 09-20 plan contradicts it:**
  - **Relocation home.** 09-14 §2.3 and §17 name `DEV_NOTES_*.md`. 09-20 invents `Documentation/Features/`.
  - **Scope.** 09-20 drops the string-literal leg (57 files) and non-mechanical hygiene. It adds the governance regex
    and five documents.
- **What the tip has already discharged.** The 09-14 "Phase 1" (clean-list regressions) and "Phase 3" (six `new-cap`
  errors) were closed by Batch 1498 `1a2baeaa4a`: eslint 6 → 0, `--verify-cleanlist` 53 → 0 regressed. Its "~50 `any`
  warnings in ~10 files" is wrong: Stybba measured 139 in 19 files at the tip with the tsd-jsdoc half. Neither plan
  should re-open these.
- **Against the rulings:**
  - `R-2026-09-17-6`: the plan honours it in spirit, since it works the C16 residue, but not in form, since it changes
    the grammar outside `C16-21`. The same ruling's "rationales are banked only where a comment carries a *why*" is
    contradicted by moving whole essays.
  - `R-2026-09-17-7`: exceeded (§3).
  - `R-2026-09-17-2` do-not-execute list: the proposed `WasmAcceleration.md` would describe the arena design from the
    09-14 corpus. That risks re-importing the refuted `BUG-03`/`BUG-04` padding remedy (Stybba §4.4). Any lane touching
    the WASM bridges must meet that list.
- **Relationship to the held 09-14 document.** This audit does not substitute for its nine corrections, which remain
  pending under `R-2026-09-17-2`. It adds two facts the maintainer may want recorded when that document is corrected:
  its Phases 1 and 3 are discharged, and its `any` count is 139 in 19 files, not ~50 in ~10.

---

## 5. The five proposed documents

| Proposed doc | Source | Verdict | Reason, and where the content goes instead |
|---|---|---|---|
| `OceanTides.md` | `Core/TideModel.js:9-~130` (+ four sibling tide files the plan missed) | **MERGE INTO EXISTING. No new doc** | About 95% of the block is constraint and science: the `GAMMA2 = 1 + k2 - h2` derivation, the permanent-tide correction, the EGM2008 tide-free datum, the "not a prediction" caveat, and the constants table that pins `TideModel.GM_MOON` and its neighbours line for line. It is published (`TideModel.html`). **It stays in the JSDoc.** Only the ruling ids and the `migration_doc/…` path are removed, and ALL-CAPS heads become sentence case. The *why* ("phase-locked to the scene clock; nothing uses wall time") survives as a constraint sentence without the ruling id. Ruling history with a why goes to **`DEV_NOTES_globe.md`**, which already records rulings T1/T2/T3/T6 at `:671` (Adamanta; Stybba suggested `DEV_NOTES_celestial.md`, which has no tide entries). |
| `SnapshotRendering.md` | `Services/SnapshotModeService.js:1-116` | **MERGE INTO EXISTING. No new doc; re-derive first** | The "Phase 0.7 … registration skeleton only" status is stale (§2.3). Publishing it as permanent documentation would state something false. **Re-derive the status against the three live freezables.** Keep the "known limitation: shared-context multi-view" paragraph in the source as a constraint. File the missing `DEFERRED_WORK` row (Principle 9). Bank the Phase-0.7 text verbatim in **`DEV_NOTES_scene_architecture.md`**. The block is `@private`, so it does not ship. |
| `BufferPrimitives.md` | `Scene/BufferPolygonCollection.js`, `Scene/BufferPolygonMaterial.js` | **DROP** | The architecture is already recorded at `FEATURE_INVENTORY.md:300`. The real fix is label strips of about ten words each: `FEAT-BUFFERPOLYGON-OUTLINE` ×3, `NEW-CLASSIFIER-2D-CV-MORPH` and "(batch-bufferprimitive-parity)". The public `@typedef BufferPolygon2DReprojection` must **keep** "producer half only; the renderer-side bind is not wired" as a constraint sentence, because it is live scaffolding (Principle 7). |
| `WasmAcceleration.md` | `Scene/WasmArenaSlots.js`, `WasmHeightmapBridge.js`, `WasmSortBridge.js` | **DROP (the docblock stays; one stale claim is corrected in place)** | The slot-ID add-only rule (`WasmArenaSlots.js:18-21`) is a constraint that must sit beside the enum, like CLAUDE.md's `ShaderDefine` rule. Correct "7 bridges … one spare" to match `NUM_SLOTS = 8` with all eight slots used (§2.4). `FORK-45` is one fact told eight times: state it once as a constraint and bank any history in **`DEV_NOTES_points_compute.md`**, which already has ten WASM entries. The `BUG-03`/`BUG-04` do-not-execute rows bind this lane. |
| `ComputeInstanceKernels.md` | `Scene/SampledPositionKernel.js:9-60` | **DROP** | This is public API reference (`SampledPositionKernel.html` exists): lane layout, stride `1 + 4 * maxKeyframes`, linear interpolation, HOLD extrapolation. Upstream would keep it in JSDoc. The only history is `(NEW-SAMPLED-POSITION-KERNEL…)` ×2. The follow-up is already `DEFERRED_WORK.md:7946`. Replace the ids with "Hermite and Lagrange interpolation are not implemented". |

**Result: 0 of 5 new documents are warranted.** No new channel is needed (decision **G2**).

---

## 6. What the 2026-09-17/18 waves already did, and what came after

- **Batch 1497 `8b557f7ee9`** recorded the Gemini audit verification: eight rulings, 27 rows, and the do-not-execute
  list.
- **Batch 1498 `1a2baeaa4a`** (Wave 0) turned three red CI gates green:
  - eslint `new-cap` went 6 → 0.
  - **53 clean-list regressions in 8 files** were reworded; their ledger pointers were banked first.
  - The lint-staged nested-config hole was closed, so the guard now runs on engine sources at commit time.

  The eight files were `WebGPUCloudTierPresets.ts`, `WebGPUContext.ts`, `WebGPUProceduralCloudRenderer.ts`,
  `…PickPass.ts`, `…PostFrustumChain.ts`, `cesium-js-types.d.ts`, `CloudVolumetrics.js` and `MetarWeatherSource.ts`.
  Its message records "fifteen grandfather rows and fifty-five grandfathered findings unchanged". The tip has 15 rows
  and 53 findings (Rochallor). **The two went in Batch 1508 `5fa97a5773`** (a code batch). It reworded the
  `Q13-PLAIN-HDR-GAMMA-CORE` comment in the grandfathered `ModelPBRComplete.wgsl`, 28 → 26 (Donnamira; I re-checked
  the removed line in `git show 5fa97a5773`).
- **Batch 1509 `0787ef5ccb`** restored 24 public doc blocks, stripped by a decomposition, verbatim from upstream. This is
  the precedent that removing public JSDoc is a regression.
- **Batches 1499-1508 and 1510-1512** are code and tools fixes. Among the 100 files they touched only
  `WebGPUContext.ts` (1506, buffer mapping) and `ModelPBRComplete.wgsl` (1508, RTE velocity). The markers remain in
  both.
- **Batches 1513-1536:**
  - 1526 touched `ShaderFunction.js` and `ShaderStruct.js` (a code fix); their markers remain.
  - **1534** turned the two machine-read WGSL comment families (the `@chunk` markers and the SUBGROUP sentinels) into
    `//>>` directives, which `comment-only-diff` treats as code.
- **Batch 1537 `b263d8ac5e`** (the new tip) re-pins the rig-registry count in one census spec. It touches no engine
  source.
- **Net effect (corrected after critique).** No inventory file has been comment-*remediated* as a batch since 09-14.
  Two were partly reduced:
  - `WebGPUContext.ts` (4 → 3). It is one of Batch 1498's eight *and* is in the inventory (B4).
  - `ModelPBRComplete.wgsl` (28 → 26, Batch 1508).

  The inventory was taken after both, on 09-20, so it double-counts nothing. The other seven of 1498's eight are not
  in it (re-checked against `inventory.json`). The plan re-opens nothing those waves closed.

---

## 7. Execution plan: 13 landable batches

**Class.** B1–B6-sky are docs/comment class under `R-2026-08-29-1`: review plus proof, no spec, no Edge.
B0-tools and B7 are Tools class: a spec where there is logic, and a runner home.

**People.** One Opus 5.5 tier-2 lead runs the wave, with at most five tier-3 authors at a time. Each batch has a
separate Opus 5.5 station-3 reviewer, briefed to **re-derive every rewritten claim against present-day code**. This is
the `C16-11` precedent, where the reviewer caught 10 stale claims. The optional adversarial Opus 5.5 verifier
(`R-2026-09-11-1`) is recommended for B0-tools, B1 and B5a. B0-tools is added after critique, because it carries
every later batch's proof.

**Landing.** The seat lands one batch at a time, each rebased on the tip. The seat owns the queue-row edits. The
cleanlist and grandfather edits ride in each batch's own commit. They have to be serial, because the wrapper
union-resolves only four paths (the seat's untracked landing kit, `land-w1.sh:45`: `DEFERRED_WORK`, `WEBGPU_DEBUGGING_LOG`, `FEATURE_INVENTORY`,
`package.json`), and the ratchet files are appended at end of file.

**Line numbers.** Every worker re-derives line numbers from the tip, because the inventory records comment-start lines
(§1.4).

### 7.1 Universal proof for every comment batch

| Gate | Command / check | Informative when |
|---|---|---|
| U1 comment-only **in every flavour** (revised after critique) | `node Tools/c16/comment-only-diff.mjs --base <tip> --head <candidate>` exit 0 in the lane clone, **re-run on the post-hook committed tree**, with the B0-tools flavour extension. For each touched file, before and after: **(U1a) JS/TS**: run the exported `constructRegex("debug", false)` and require 0 matches whose anchor does not open its line (baseline 0 of 1,517 files). Also require the release-stripped text to be comment-only equal. **(U1b) WGSL**: the scanner's canonical code of `stripWgslComments(src)` equals that of `src` (baseline 0 of 325 disagree). **(U1c) GLSL**: a `removeComments` vendored byte-equal to `ShaderSource.js:8-21` (a pin test fails if the source drifts) must not throw, must give the same canonical code before and after, and must give the same `czm_` token set (baseline 0 throws and 0 extra `czm_` tokens over 330 files). **(U1d) Magic comments**: the count and bytes of every `webpackIgnore`, `@vite-ignore` and `__PURE__`/`#__PURE__` comment are unchanged. B0-tools' `bundler-magic-comment` rule makes this part of U1 proper. **(U1e) Directives**: `lint-debug-pragmas-allow` and `/// <reference` prefixes are retained as code (G10-A′) | always. Until B0-tools lands, a batch runs U1a-U1e as lane-local scripts, which is G10-B′ |
| U2 guard | `comment-marker-guard.mjs --strict <batch paths>` exit 0. `--verify-cleanlist` exit 0. Census before and after recorded in the row (protocol step 6). Cleanlist appends and grandfather retirements in the **same commit** | always |
| U3 build-docs | `npm run build-docs` exit 0 (`--pedantic`). For a `.js` `/**` edit, the `Build/Documentation` diff is confined to the touched doclets | only `.js` inputs can move it (`Tools/jsdoc/conf.json`) |
| U4 build-ts | Per decision **G9** (strict, revised after critique): `npm run build-ts` **exit 0** (it is green in CI at the tip, §2.2), `compareDeclarations` structurally equal to the B0 base `Source/Cesium.d.ts` (`Tools/lib/compare-declarations.mjs`, lane-local driver), `any`-fallback count not higher | only `.js` inputs can move it |
| U5 anchors | `Tools/c16/spec-anchor-sweep.mjs` over the batch files, **length-blind**, with the counts read (it exits 0 even when it finds anchors). Also `node --test` every spec that reads a batch file but has no npm runner | always |
| U6 knowledge | A knowledge-disposition table mapping every removed sentence to a destination (source constraint, `DEV_NOTES_<subsystem>.md` entry per `DEV_NOTES_FORMAT.md`, or "deleted: stale" with code evidence), in the same batch. A `DEFERRED_WORK` row where Principle 9 applies | always |
| U7 citations | `verify-doc-citations` dead-count delta ≤ 0 (base 51). Rewrites of heavily cited files keep line counts unchanged | always |

### 7.2 The batches

"GF" is grandfather rows retired. "CL+" is cleanlist appends. Each batch's files are listed below the table.

| # | Batch | Files | GF | CL+ | Extra proof beyond U1-U7 | Author (tier-3) | Queue position |
|---|---|---:|---:|---:|---|---|---|
| **B0-tools** | C16-21 narrowing, directive and flavour fixes (Tools class; revised after critique) | 0 engine files, plus `IonSnapMode.js` path appended | 0 | 1 | (a) `all-caps-fix-label` skips tokens inside a URL, with a self-test negative example (census 179 → 178). (b) Per **G10-A′**, **prefix-only** retention for `lint-debug-pragmas-allow` and `/// <reference`: the directive token is code and the reason text stays prose. Whole-comment retention would freeze the five reason texts that G5-A rewrites (F6). (c) A `bundler-magic-comment` semantic rule (`webpackIgnore`, `@vite-ignore`, `__PURE__`), retained whole, since such comments never need rewording. (d) The flavour extension U1a-U1c (release pragma view, `stripWgslComments` view, vendored `removeComments` view with a byte-pin test against `ShaderSource.js:8-21`). (e) Whole-corpus agreement specs, green at the tip: WGSL scanner-vs-stripper in `Tools/build-infra/wgsl-chunk-resolution.spec.mjs` (0 of 325 disagree), GLSL `removeComments` no-throw/no-extra-`czm_` (0 of 330), 0 prose-anchored pragma matches (0 of 1,517 JS/TS). (f) The ASI fix: a dropped comment containing a line terminator canonicalises to a newline, not a space (DX-8). Specs go in `test-c16` and `test-build-infra`, both existing runners, and both stay green. Each new check gets a mutant showing it fires: a one-line GLSL `/** */`, a nested WGSL glob, a prose-quoted pragma, a deleted `webpackIgnore`, a stripped allow prefix | Opus 5.5 (+ adversarial verifier: this batch carries every later batch's proof) | First. **Gate: the `guards` job green at the landing base.** It was red at `a76d42b3f8` (landing-rule test 269, 39 vs 41; `test-build-infra`, `audit-feature-renderers`, `collection-sentinels-check` and `verify-tracked-references` skipped). It is **green at `b263d8ac5e`** (run `36220924784`, job `guards` = success, no step skipped or failed; read after the critique). No collision. **Every later batch depends on B0-tools.** |
| **B1** | Published-API doclets (`.js`) | 10 | 2 | 8 | U3/U4 bind. `tsc-engine` (`BufferPolygonCollection.js` and `BufferPolygonMaterial.js` are `// @ts-check`). Principle 7: keep the "producer half only" (`BufferPolygon2DReprojection`) and "no consumer yet" (`StbnNoiseVolume`) constraints. Per decision **G3** | Opus 5.5 (+ adversarial verifier) | After B0-tools. Independent of Astra and tranche 2. |
| **B2a** | Tides | 1 + 4 outside the inventory | 0 | 5 (none of the five is clean-listed today; re-checked) | U3/U4 bind (`TideModel` `any`-fallbacks, 22 per Stybba, must not rise). The constants table stays line for line. Banking goes to `DEV_NOTES_globe.md` | Opus 5.5 | Any time after B0-tools |
| **B2b** | Snapshot and VPT services | 2 | 0 | 2 | Re-derive the status against the three live freezables (§2.3). File the `DEFERRED_WORK` multi-view row. `VisualPerformanceTargetService.js:38` "skeleton only" re-derived the same way. Build-ts doclet warnings on `SnapshotModeService.js` must not grow. Banking goes to `DEV_NOTES_scene_architecture.md` | Opus 5.5 | Any time after B0-tools |
| **B3a** | Model / glTF / 3D Tiles inline | 11 | 5 | 4 | The reviewer asserts from the diff that no `/**` block was touched. If one was, B1's proof applies. `CLAUDE.md` citations ×4 are handled per decision **G5** | Opus 5.5 (Gemini option under **G7**-B) | Any time after B0-tools |
| **B3b** | Scene / Renderer / DataSources inline | 22 | 0 | 19 | `tsc-engine` (`GlobeSurfaceShaderSet.js` is `@ts-check`). `Snapping.js:407` rides only after W2-L8, or with a rewrite that keeps line counts unchanged | Opus 5.5 (Gemini option under **G7**-B) | The `Snapping.js` line waits for W2-L8. The rest has no constraint. |
| **B3c** | WASM family | 8 | 0 | 8 | U3/U4 bind (`WasmArenaSlots` has 8 `any`-fallbacks). Correct the stale "one spare" claim. `FORK-45` and `AUDIT_2026_05_02 B.19` stated once. **The do-not-execute rows `BUG-03`/`BUG-04` bind this lane.** Banking goes to `DEV_NOTES_points_compute.md`. **U1d binds (added after critique).** The five `/* webpackIgnore: true */` comments (`WasmHeightmapBridge.js:97`, `WasmMatrixBridge.js:71`, `WasmPointCloudBridge.js:88`, `WasmQuantizedMeshBridge.js:75`, `WasmSortBridge.js:219`) stay byte-identical. When the reviewer re-derives `WasmSortBridge.js:214-218` ("EXTERNAL (webpackIgnore) so esbuild no longer INLINES the glue"), the correction may re-attribute esbuild's behaviour to the non-literal `resolveWasmGlueUrl()` specifier. It must keep, as a constraint sentence, that the magic comment exists for webpack consumers of `@cesium/engine` (`resolveWasmGlueUrl.js:9-22`). It must never delete the comment | Opus 5.5 | Any time after B0-tools |
| **B4** | `Renderer/WebGPU` TS and sidecars | 12 | 1 | 4 | `npm run lint-debug-pragmas`, `tsc-engine`, `collection-sentinels-check`, `audit-feature-renderers`. The reviewer confirms every `lint-debug-pragmas-allow` prefix and `/// <reference>` line survives. Rewrites of `WebGPUContext.ts` keep line counts unchanged (547 citation lines). `CLAUDE.md` citations ×19 are handled per **G5**. **Added after critique:** U1e (prefix-only) lets the five `lint-debug-pragmas-allow` reason texts at `WebGPUDeviceLossRecovery.ts:591,627,651,695,718` be reworded while the prefix is proved to survive. U1a binds every sentinel rewrite: a rewritten sentence must not quote `//>>includeStart(…)` syntax. `WebGPUContext.ts` alone carries 24 live pragma lines | Opus 5.5 | `Resource.d.ts` after Angrim / W2-L11. `WebGPUFeatureRenderers.ts` in either order with Astra (hunks 245 lines apart; three-way apply) |
| **B5a** | Model WGSL (grandfathered) | 4 | 5 | 1 | `npm run test-build-infra` (`wgsl-chunk-resolution.spec.mjs`, which after B0-tools includes the whole-corpus stripper agreement test). U1b binds: no nested or glob-bearing block comment (`/**/` inside `/* */`). No `//>>` line touched. Line counts unchanged (166 citation lines). The `── ` section headers are **not** touched: they are `C16-21` item (1) and a karma pin class | Opus 5.5 (+ adversarial verifier) | **After W2-L5 lands.** W2-L5 re-anchors `WebGPUModelPunctualLightRTESpec.js:93` and `WebGPUModelShadowReceiveSpec.js:39`, which are red today on `// ── Punctual lights` (re-checked: 0 occurrences in the shader) |
| **B5b** | Globe WGSL (grandfathered) | 1 | 2 | 0 | As B5a. Line counts unchanged (208 citation lines). Check `IMAGERY_PROJECTION.md` for quoted comment wording (CLAUDE.md requires that document to stay in sync) | Opus 5.5 | **After W2-L5 lands** (`WebGPUGlobeTerrainEnhancedOceanSpec.js:101,121` pins `GlobeTerrain.wgsl:3211`) |
| **B6** | Remaining WGSL compute/collection and non-sky GLSL | 23 | 0 | 23 | `test-build-infra` for the WGSL (U1b). **U1c for the GLSL (added after critique).** The flagged lines in `raySphereIntersectionInterval.glsl` and `RGBToXYZ.glsl` sit in `/** */` doc blocks that `ShaderSource.removeComments` reads at runtime in unminified builds. Keep every doc block multi-line. Never put `//` text (a URL) on a closing `*/` line. Never turn `/**` into `/*` | Opus 5.5 | Any time after B0-tools |
| **B6-sky** | Sky / atmosphere GLSL | 5 | 0 | 5 | **`node --test Tools/visual-regression/sky-light-direction.spec.mjs` directly** (no runner). `4869.9` must survive in `getSkyAtmosphereLightDirection.glsl`, and no comment in `SkyAtmosphereVS.glsl` may name `czm_getDynamicAtmosphereLightDirection` (§2.1). **U1c binds (added after critique).** `getSkyAtmosphereLightDirection.glsl` already names `czm_getDynamicAtmosphereLightDirection` and `czm_computeAtmosphereColor` inside its `/**` block (`:4`, `:20`, `:51`). A `/**` → `/*` change would turn them into dependencies. The default scene's WebGL sky runs through this path in the unminified dev and visual-regression rigs | Opus 5.5 | After B0-tools **and** after Astra's sky pieces land, or with the spec run on both the tip and Astra's tree |
| **B7** | C16-21 grammar close (Tools class) | 0 engine files | 0 | 0 | New rules land **after** the rewrites have taken their census to 0, so no grandfather row is ever added (`R-2026-08-21-18`): `migration_doc` without a slash, `ruling T\d`, `AUDIT_\d{4}_\d{2}_\d{2}`, and the `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` citation rule if **G5**-A. The rule's scope is measured first; any file outside the 100 that the rule would expose joins the same batch. Self-tests pass. `test-c16` green | Opus 5.5 | Last |

**Files per batch** (under `packages/engine/Source/`):

- **B1:** `Scene/Model/CustomShader.js`, `Scene/Model/CustomShaderWGSLPipelineStage.js`, `Scene/Atmosphere.js`,
  `Scene/Material.js`, `Scene/RenderScheduler.js`, `Scene/SampledPositionKernel.js`, `Scene/StbnNoiseVolume.js`,
  `Scene/MVTTileDecoder.js`, `Scene/BufferPolygonCollection.js`, `Scene/BufferPolygonMaterial.js`.
- **B2a:** `Core/TideModel.js`, plus `Core/HarmonicTideModel.js`, `Core/TidalArguments.js`, `Core/TidalConstituents.js`
  and `Core/TideConstituentGrid.js` (outside the inventory; needed so that B7's `ruling T\d` rule lands clean).
- **B2b:** `Services/SnapshotModeService.js`, `Services/VisualPerformanceTargetService.js`.
- **B3a:** `Scene/Model/Model.js`, `Scene/Model/ModelPrimitiveGeometry.js`, `Scene/Model/GeometryPipelineStage.js`,
  `Scene/Model/InstancingPipelineStage.js`, `Scene/Model/MetadataWGSLPipelineStage.js`,
  `Scene/Model/SceneMode2DPipelineStage.js`, `Scene/GltfLoader.js`, `Scene/Cesium3DTile.js`, `Scene/Cesium3DTileset.js`,
  `Scene/parseStructuralMetadata.js`, `Scene/PrimitiveLoadPlan.js`.
- **B3b:**
  - Scene: `Scene/BillboardCollection.js`, `Scene/PointCloud.js`, `Scene/PointCloudEyeDomeLighting.js`,
    `Scene/Polyline.js`, `Scene/DepthPlane.js`, `Scene/EnvironmentRenderer.js`, `Scene/FramebufferOrchestrator.js`,
    `Scene/GlobeSurfaceShaderSet.js`, `Scene/OcclusionCulling.js`, `Scene/SOABoundingSphereLayout.js`,
    `Scene/SSCCInputHelpers.js`, `Scene/SceneTransforms.js`, `Scene/ViewportQuad.js`,
    `Scene/computeLunarOppositionSurge.js`, `Scene/MaterialUniformBuffer.js`, `Scene/Snapping.js`.
  - Renderer: `Renderer/FeatureRendererKey.js`, `Renderer/Sync.js`, `Renderer/ShaderFunction.js`,
    `Renderer/ShaderStruct.js`, `Renderer/Texture3D.js`.
  - DataSources: `DataSources/EntityCluster.js`.
- **B3c:** `Scene/WasmHeightmapBridge.js`, `Scene/WasmMatrixBridge.js`, `Scene/WasmPointCloudBridge.js`,
  `Scene/WasmQuantizedMeshBridge.js`, `Scene/WasmSortBridge.js`, `Scene/WasmArenaSlots.js`,
  `Core/WasmFeatureDetection.js`, `Scene/resolveWasmGlueUrl.js`.
- **B4:**
  - Renderer/WebGPU: `WebGPUDeviceLossRecovery.ts`, `WebGPUContext.ts`, `WebGPUCollectionRendererBase.ts`,
    `WebGPUIndirectDrawManager.ts`, `WebGPUDecoupledScan.ts`, `WebGPUFeatureRenderers.ts`,
    `WebGPUGlobeSurfaceCameraUB.ts`, `WebGPUVectorTileResources.ts`, `WebGPUVolumetricFogRenderer.ts`.
  - Sidecars: `Renderer/UniformState.d.ts`, `Core/ComponentDatatype.d.ts`, `Core/Resource.d.ts`.
- **B5a:** `Shaders/WebGPU/Model/ModelPBRComplete.wgsl`, `Shaders/WebGPU/Model/ModelSilhouetteStage.wgsl`,
  `Shaders/WebGPU/PostProcess/Tonemapping.wgsl`, `Shaders/WebGPU/chunks/structs/EffectsUniforms.wgsl`.
- **B5b:** `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`.
- **B6:**
  - WGSL under `Shaders/WebGPU/`:
    - `Compute/`: `BitonicSortU64`, `ClusterBounds`, `GBufferNormalsFromDepthMSAA`, `EnvCubeMipDownsample`,
      `EnvCubeTemporalBlend`, `OcclusionTest`, `RadiancePrefilter`, `ClusterDebugVisualize`, `DecoupledLookbackScan`,
      `EntityClusterGridGPU`, `PointCloudLODScanCompact`.
    - `Collections/`: `BufferPointMaterial`, `BufferPolygonMaterial`, `BufferPolylineMaterial`.
    - Others: `Advanced/PointCloudEDL`, `FlowFieldAdvect`.
  - GLSL: `Shaders/Builtin/Functions/raySphereIntersectionInterval.glsl`, `Shaders/Builtin/Functions/RGBToXYZ.glsl`,
    `Shaders/VectorCommon.glsl`, and `Shaders/ComputeInstanceWebGL{VS,FS,PickVS,PickFS}.glsl`.
- **B6-sky:** `Shaders/Builtin/Functions/getSkyAtmosphereLightDirection.glsl`,
  `Shaders/Builtin/Functions/getDynamicAtmosphereLightDirection.glsl`, `Shaders/SkyAtmosphereVS.glsl`,
  `Shaders/SkyAtmosphereCommon.glsl`, `Shaders/Model/AtmosphereStageFS.glsl`.
- **Excluded from edits:** `Core/IonSnapMode.js`. It is handled by B0-tools and appended to the cleanlist untouched.

**Bookkeeping check** (derived from Rochallor's per-file table):

- **Coverage:** 10 + 1 + 2 + 11 + 22 + 8 + 12 + 4 + 1 + 23 + 5 + 1 excluded = **100 inventory files, each exactly
  once**.
- **Grandfather rows:** 2 + 5 + 1 + 5 + 2 = **15**, which empties the grandfather file.
- **Cleanlist appends:** 1 + 8 + 5 + 2 + 4 + 19 + 8 + 4 + 1 + 0 + 23 + 5 = **80**. That is the 76 unlisted inventory
  files plus the 4 tide siblings, none of which is clean-listed (re-checked after critique: 0 cleanlist lines for
  each of the five tide files).
- **`CLAUDE.md` citations:** B1 ×1 + B3a ×4 + B3b ×4 + B4 ×19 = **28**.

### 7.3 What the wave closes, and what it does not

**It closes:**

- **`C16-20` leg (1).** The census reaches 0 under the current grammar, and 0 under the new B7 rules.
- **The empty-grandfather clause.**
- **The guard-visible residue of `C16-09` through `C16-12`.**

**It does not close `C16-20` as a whole.** Three items remain open:

- leg (2), the string-literal scan (336 lines in 57 files, `C16-R1`);
- `C16-02c`. CI shows it discharged (§2.2), but the row still reads PENDING, and correcting it is the seat's ledger
  edit;
- `C16-21`'s other deliverables: box-drawing dividers, scope roots, WGSL template literals, `Batch Q23` and `(C-15)`,
  and the third scanner in CI.

**Wave-end gate (`R-2026-08-29-2`), revised after critique.** My first pass said "U1 proves the code bytes are
unchanged". That was false for the artifacts (§3, last row; §11). The corrected rationale is conditional:

- **With U1a-U1e in force** (B0-tools landed under G10-A′, or run lane-locally under G10-B′), every transform the fork
  applies to comment text is checked before and after, on every touched file. That covers the release pragma strip,
  the minified WGSL strip, the unminified GLSL `removeComments` and bundler magic comments. The artifacts are then
  proved unchanged by construction. The wave-end gate rides the next scheduled wave-end Edge job, and the wave needs
  no Edge slot of its own.
- **Without them,** B6 and B6-sky need a WebGL leg on the unminified dev build before the next engine landing after
  them. B6-sky is the default scene's WebGL sky. Otherwise a `ShaderSource` throw could sit under several later
  landings before anyone sees it.

This report recommends the first case. Every comment batch depends on B0-tools, so the second case arises only if
the maintainer rejects both G10 options. See decisions **G8** and **G10**.

---

## 8. Queue placement against Astra and CI wave 2

1. **Now, in parallel with everything else:** record this audit's rulings. B0 baselines are measured in a disposable
   clone at the tip:
   - `build-docs`
   - `build-ts` end to end (expected exit 0, as in CI at the tip): count `any` fallbacks and save `Source/Cesium.d.ts`
     and `Build/Documentation` as the per-batch comparison base
   - the guard census (179 / 83)
   - the string-literal scan (336 / 57)
   - `verify-doc-citations` (51 dead)
   - a length-blind `spec-anchor-sweep` over the 100 files

   Bank Gemini's plan, inventory and scripts in `cesium-webgpu-worker-archive/`, not the tree, following the
   `R-2026-09-17-2` precedent for Gemini corpora.
2. **Land W2-L11 (Angrim) as already planned.** It gates only `Resource.d.ts` in B4.
3. **Land B0-tools first.** Its gate, the `guards` job green at the landing base, is met at `b263d8ac5e` (run
   `36220924784`). Re-check it if another Tools batch lands first. **Then interleave B1, B2a, B2b, B3a, B3b (without
   `Snapping.js`), B3c, B4 (without `Resource.d.ts` until step 2) and B6** with tranche-2 and C15-06 landings, one per
   landing, each rebased. None writes a file that any tranche-2
   lane, ring lane, C15-06 or Astra owns. The one shared file with Astra, `WebGPUFeatureRenderers.ts`, has disjoint
   hunks. Intersection re-measured over the 81 patch paths (Adamanta): overlap = `[WebGPUFeatureRenderers.ts]`.
4. **After W2-L5 lands:** B5a, then B5b. **After W2-L8:** the `Snapping.js` line.
5. **Astra:** the wave does not wait for it (R5 §3 item 3 agrees). **B6-sky** goes after Astra's sky pieces land
   (`SkyAtmosphereFS.glsl`, `SkyAtmosphere.wgsl`, `sky-light-direction.spec.mjs`), or earlier with the sky spec run on
   both trees.
6. **B7** goes last. Then run a `C16-20` leg (1) measurement and let the wave-end gate ride the next Edge job.
7. **Landing windows:** weekdays only after 19:00 ET (quiet hours). Weekends are unrestricted.

---

## 9. DX rows surfaced (evidence inline; propose, do not fix silently)

- **DX-1.** `comment-only-diff` does not treat `// lint-debug-pragmas-allow` or `/// <reference>` as code, although
  `ForkCommentStandard.md` §8.4 says lint directives count as code. Evidence: `comment-scanner.mjs:115-259`,
  `lint-debug-pragmas.mjs:46`, and five such lines among the flagged set. Proposed home: B0-tools (**G10-A′**). The fix
  retains the **prefix only**. Whole-comment retention (`comment-scanner.mjs:880-883`) would freeze the reason text
  (critique F6).
- **DX-2.** `Tools/visual-regression/sky-light-direction.spec.mjs` has no npm runner. It is 1,017 lines, ACTIVE in
  `TOOLING_CATALOG.md:1412`, and it pins comment text in two inventory files (§2.1). Under `R-2026-08-29-1` a spec
  with no runner home is a review blocker. Proposed: measure it at the tip; if green, add it to a runner. Astra's patch
  also edits it, so whichever lands second composes the runner line.
- **DX-3.** `spec-anchor-sweep.spec.mjs` has no runner, and its catalog row says "NO @purpose HEADER" (Gamgee).
- **DX-4.** `Tools/lib/compare-declarations.mjs` has no CLI, so every lane writes its own driver (Gamgee).
- **DX-5 (revised after critique).** The `C16-02c` row says red (21 `error TS`, from the 2026-08-08 log). **It is
  stale.** CI's `release-tests` "release build" (`make-zip` → `release` → `buildTs` + `buildDocs`) succeeded at
  `a76d42b3f8` (run `35467592179`) and at `b263d8ac5e` (run `36220924784`). The seat records the correction on that
  evidence (**G9**).
- **DX-8 (added after critique).** `comment-only-diff` claims ASI protection (`comment-only-diff.mjs:33-39`). But a
  dropped comment canonicalises to one space (`comment-scanner.mjs:883`), so a multi-line block comment after
  `return`/`throw`/`yield` collapsed to one line reads as `comment-only`. There are 0 such sites in scope today
  (Donnamira). Fix in B0-tools (f).
- **DX-9 (added after critique).** Machine-read comment text has no single register. The release pragma strip
  (`scripts/build.js:51-83`), the WGSL minify strip (`:845`), `ShaderSource.removeComments` (`ShaderSource.js:8-21`)
  and bundler magic comments (8 sites, §3) are each known to their own code only. `ForkCommentStandard.md` §8.4 names
  lint directives but none of these. Propose a short "comments that are read by a machine" paragraph in §8.4, and a
  B0-tools cross-reference from the scanner's `SEMANTIC_COMMENT_RULES` header.
- **DX-6.** The guard's `scannedFiles` counts 657 gitignored build outputs, so it depends on build state: 2,872 on a
  built seat, 2,215 unbuilt (Rochallor).
- **DX-7.** `verify-doc-citations` is red at the tip (51 dead) and the landing wrapper does not run it (Gamgee).

---

## 10. What this audit did not measure

Items settled after critique are marked **SETTLED** with the section that settles them, and are kept so the numbering
stays stable.

1. **SETTLED (§2.2).** `build-ts` and `build-docs` are green in CI at `a76d42b3f8` and `b263d8ac5e`. What remains
   unmeasured is the local base `Source/Cesium.d.ts` and the `any`-fallback count at the tip, which B0 saves.
2. **A length-blind `spec-anchor-sweep` over the 100 files.** Gamgee's sweep used a 16-character floor. §2.1's
   two pins were found by hand in one spec. Other short anchors, or anchors built by concatenation, may exist in specs
   I did not open.
3. **Whether each of the 28 `CLAUDE.md` citations carries a *why*** that must survive as a constraint. Only the
   families were classified. Each needs a reviewer read in its batch.
4. **SETTLED by reasoning (Donnamira A12).** GLSL builtin `/** */` blocks do not reach the published docs:
   `Tools/jsdoc/conf.json` accepts `.js` only, its one plugin parses no `.glsl`, and the generated builtins carry the
   block inside a string literal. They *are* read at runtime by `ShaderSource.removeComments` (§3), which is the
   exposure that matters. U1c covers it.
5. **Whether `IMAGERY_PROJECTION.md` quotes comment wording** from `GlobeTerrain.wgsl` or
   `WebGPUGlobeSurfaceCameraUB.ts`.
6. **PARTLY SETTLED (§3, §11).** Four more families were found and reproduced: the release pragma strip reading
   prose, the non-nesting WGSL minify strip, the GLSL `removeComments` reader, and bundler magic comments. I still ran
   no exhaustive census of every tool or runtime path that reads comment text. Candidates not traced include the
   `@license` banner handling of the minifier and `verify-packaged-notices`, `glsl-strip-comments` in the minified
   GLSL path, and any `/*#__PURE__*/` annotation relied on by tree-shaking.
7. **The `any`-fallback count.** Stybba measured 139 in 19 files at the tip with the tsd-jsdoc half. The 09-04 seat log
   has 278 "Defaulting to `any`" lines. The difference (both workspaces, duplicates, or real change) is unreconciled.
8. **SETTLED (§6).** Batch 1508 took `ModelPBRComplete.wgsl` from 28 to 26.
9. **SETTLED (§7.2).** None of the five tide files is clean-listed. B2a appends 5, and the wave appends 80.
10. **SETTLED for `dev` (§2.2, B0-tools row).** At `b263d8ac5e`: `guards` and `variants` are green. `lint` (at "lint
    `*.js`"), `release-tests` (at "release tests (chrome)", after a green "release build"), `coverage` and both
    `node-smoke-test` jobs are red, as they are on the known baseline. `sandcastle-dev` is green. I did not open the
    red jobs' logs, so I have not proved that each failure is the same set as the baseline.
11. **Ring lane I-4's write set, and the form in which Astra will land** (whole, split or re-authored). Both change
    only the timing of B4's `WebGPUContext.ts` and of B6-sky.
12. **Whether the root `cesium` package is published to npm.** If it is, `migration_doc/` ships, because `.npmignore`
    does not exclude it (Stybba).
13. **The non-mechanical categories** (first person, ALL-CAPS emphasis, narrative) inside the 100 files. The 09-14
    document's counts for these were not reproduced.
14. **Which bundle CI's `release-tests` runs** (`--release --webgl-stub`, `dev.yml:131`): minified or unminified GLSL.
    The critic inferred minified and I did not trace it. Either way that job cannot be the backstop for U1c: it is red
    at baseline and stubs WebGL. U1c's corpus spec is the backstop.
15. **Whether `q130-wgsl-derivative-uniformity.spec.mjs` or `built-shader-identity.spec.mjs` would already catch a
    nested WGSL comment.** Not read. The B0-tools whole-corpus agreement test makes the question moot for the wave.
16. **The line-level content of the maintainer's held working-tree diffs.** Only the paths were read.

---

## 11. Changes after critique

Critic: Donnamira (`cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/audit/CRITIQUE_DONNAMIRA.md`), 10 MUST-FIX and 14 ACCEPT. **All ten MUST-FIX items are accepted. None
is rebutted.** Before editing, I re-derived each one at `b263d8ac5e`, read-only, with two probe scripts under
`<os.tmpdir()>/cesium-lane/adamanta/`. The scripts imported `compareSources` (`Tools/c16/comment-only-diff.mjs:84`),
`canonicalizeCode` (`Tools/c16/lib/comment-scanner.mjs:869`), and `constructRegex` and `stripWgslComments` (exported
from `scripts/build.js`). They used a byte copy of `ShaderSource.js:8-21`. The temp root was removed at the end.

**Synthetic reproductions (all six return `comment-only` from `compareSources`):**

| Edit | What actually changes (measured) |
|---|---|
| Own-line `/* webpackIgnore: true */` deleted inside `import(…)` | Magic comment gone. Webpack consumers resolve through a context module |
| GLSL doc block collapsed to one line `/** Selects the light. */` | `removeComments` **throws** `Cannot read properties of null (reading 'length')` |
| GLSL `Reference: https://x.y/z */` on the closing line | `removeComments` output no longer contains `vec3 f()` (the before-text does) |
| WGSL `/* Shaders under Shaders/WebGPU/**/*.wgsl only. */` | `stripWgslComments` emits `"*.wgsl only. */\nfn main() {}\n"` |
| JS prose quoting `` `//>>includeStart('debug', pragmas.debug)` `` above a live pair | Release strip output is ``"// Deliberately outside `"``: the sentinel line and the debug block are both gone |
| `// lint-debug-pragmas-allow:` reason reworded | `comment-only` today. Under whole-comment retention it would be `code-differs` (the F6 freeze) |

**Corpus baselines (tracked files under `packages/engine/Source`):** GLSL 330 files: 0 throws, 0 `czm_` tokens that
survive only in comments. WGSL 325 files: 0 scanner-vs-stripper disagreements. JS/TS 1,517 files: 0 prose-anchored
pragma matches. These agree with the critic's figures.

| Item | Disposition | Where |
|---|---|---|
| F1 U1 flavour-blind | **Accepted.** U1 is redefined as "comment-only in every flavour" (U1a-U1e) | §0, §3 new row, §7.1 U1 |
| F2 `webpackIgnore` | **Accepted.** Five B3c sites confirmed by `git grep`. Three more sites exist outside the 100 (`WasmCullBridge.js:223`, `WasmRTEBridge.js:84`, `WebGPUNagaTranspiler.ts:118`); the new rule covers them too. B3c's row forbids deletion and constrains the `WasmSortBridge.js:214-218` correction | §3, §7.1 U1d, §7.2 B0-tools (c), B3c |
| F3 GLSL runtime reader | **Accepted.** `removeComments` and its call sites at `:36`, `:166` and `:60` confirmed | §3, §7.1 U1c, §7.2 B6, B6-sky |
| F4 WGSL non-nesting stripper | **Accepted.** Boolean at `scripts/build.js:847` confirmed; the spec's real path is `Tools/build-infra/wgsl-chunk-resolution.spec.mjs` (in `test-build-infra`) | §3, §7.1 U1b, §7.2 B0-tools (e), B5a |
| F5 pragma quoted in prose | **Accepted.** `constructRegex` has no line anchor | §3, §7.1 U1a, §7.2 B4 |
| F6 G10 deadlock | **Accepted.** Whole-comment retention confirmed at `comment-scanner.mjs:880-883`. G10 is replaced by A′ (prefix-only retention plus the flavour checks in the shared tool) and B′ (the same checks lane-local) | §7.2 B0-tools (b), `GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md` G10 |
| F7 G9 premise | **Accepted.** Runs `35467592179` and `36220924784` read with `gh run view`. The gulp chain was re-read. The gate is now strict exit 0 | §2.2, §3, §7.1 U4, §8, §9 DX-5, §10 item 1, `GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md` G9 |
| F8 G1 labels | **Accepted.** A is relabelled. B is kept only as an explicitly labelled reversal of `R-2026-09-17-6` | `GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md` G1 |
| F9 re-base | **Accepted.** The header, §6 and §8 cite `b263d8ac5e`. **Resolved since the critique:** the `guards` job for `b263d8ac5e` (run `36220924784`) completed **green**, so B0-tools' gate is met today | header, §6, §7.2 B0-tools, §8 step 3 |
| F10 no-Edge rationale | **Accepted.** §7.3 is now conditional on U1a-U1e. Without them, B6 and B6-sky need a WebGL leg on the unminified dev build before the next engine landing | §7.3, `GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md` G8 |

**ACCEPT items folded in:** A5 (tide siblings unlisted: CL+ 5, wave total 80), A6 (a G5-A sentinel rewrite must not
quote pragma syntax), A11 (§6 correction: `WebGPUContext.ts` is in both sets, and Batch 1508 took 2 grandfathered
findings), A12 (§10 item 4), A14 (DX-8). G3-A's GLSL note (A4) is in `GEMINI_PLAN_AUDIT_DECISIONS_2026-09-26.md`.
