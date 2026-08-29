# Codex handoff — CesiumJS WebGPU fork, state at Batch 1320 (2026-08-29, ~17:35 ET)

**Who this is for.** A Codex (GPT-5.6 "Sol") session taking the orchestrator seat from Claude ("Gandalf") for
this repository. It is self-contained on purpose: the `~/.codex` folder was reset earlier, `CLAUDE.md` at the
repo root is **gitignored** (so a fresh checkout does not carry it — `Tools/provision-worker-clone.mjs`
copies it into worker clones), and the tracked `AGENTS.md` is the router, not the state. Read this file
first, then the documents in §2 in order. Nothing in this file is an authority on its own: the live ledger and
the dispatch queue are.

---

## 1. The project in one screen

- **What:** a fork of CesiumJS (`upstream` = `CesiumGS/cesium`, synced to v1.144) that adds a complete
  **WebGPU** render backend beside WebGL2, behind one abstraction (`GraphicsContext`; `Context.js` = WebGL,
  `WebGPUContext.ts` = WebGPU; scene code is backend-agnostic and reaches backend code only through
  `context.getFeatureRenderer(FeatureRendererKey.X)`). WGSL shaders live in `packages/engine/Source/Shaders/WebGPU/`;
  the renderer in `packages/engine/Source/Renderer/WebGPU/` (234 TS files, ~172k lines). Root `Source/` is a
  build output — never edit it.
- **Where the work is:** `packages/engine/Source/**` (engine), `packages/sandcastle/gallery/**` (demos),
  `Tools/**` (probes, specs, gates — ~940 top-level `.mjs`), `migration_doc/**` (200+ docs; the ledgers).
- **Build / serve / test:** `npx gulp build`, `npm run build-sandcastle`, `node server.js --serve-built
  --port 8094` (default `node server.js` serves a live-esbuild dev bundle and must never be used for
  measurement), `node --test <spec>` for the node specs, `npm test` (Karma) for the Jasmine suites. Edge is the
  only browser with WebGPU under Playwright (never Firefox).
- **Repo identity:** commit author `cesium-webgpu-agent`; push as `kurtyoung-dev` (a 403 means the wrong
  `gh` account is active). Trunk-only; workers get clones (`F:/Dev/GH/cesium-lane-<name>`), never worktrees,
  and never commit — the seat lands everything as squash-style single commits named `Batch NNNN: <narrative>`.

## 2. Read these, in this order (the current authorities)

| # | Document | Why |
|---|---|---|
| 1 | `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` | **The live status ledger.** Sole authority for every `Q-` id. Newest sections are inserted at the top of the dated block; every batch adds a section. |
| 2 | `migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md` | **The dispatch order** for the current work: Wave 1 (in flight), Wave 2–4 (held), the meshlet track (`MS-`), and **§6a Wave DX** (organisation / decomposition / dedup, queued NEXT). §8 lists every maintainer gate `M-01..M-25`; §9 the binding execution notes. |
| 3 | `migration_doc/MAINTAINER_RULINGS_2026-08-28.md` | The rulings, incl. the sixth sitting of 2026-08-29: **R-2026-08-29-1** (proof bar by change class), **R-2026-08-29-2** (wave-end smoke + visual-regression gate), **R-2026-08-29-3** (Wave DX). Older sittings: `MAINTAINER_RULINGS_2026-08-{10,14,17,21,24}.md`. |
| 4 | `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` | Clones, squash landings, worker rules (§7), Codex-specific rules (§8, 8a–8c), read-only-under-review (8d), Tolkien naming (8e), proof bar + wave-end gate + stable citations (8f). |
| 5 | `CLAUDE.md` (repo root, gitignored; in every provisioned clone) | The standing engineering rules: principles 1–10 (parity, feature inventory, dead-code audit, probe-first verification, verified premises), WGSL define/preprocessor/module-cache rules, RTE precision, logging pragmas, quiet hours, branch transparency, evidence repatriation. If it is missing from your checkout, take it from any clone or from `F:/Dev/GH/cesium-webgpu-worker-archive/`. |
| 6 | `migration_doc/DEBUGGING_GUIDE.md` | Probe-first workflow, `CesiumDebug` commands, probe inventory, capture doctrine, the new "Instrument-defect lessons" subsection. |
| 7 | `migration_doc/README.md` | Index of all migration docs (LIVE vs ARCHIVED). Trust it over any doc's self-description. |
| 8 | `migration_doc/TOOLING_CATALOG.md` | Generated per-file census of every `.mjs` (regenerated at each landing by `node Tools/generate-tooling-catalog-launcher.cjs`). **Its analyst prose sections are from 2026-08-15 and are stale against the tree** (that is `DX-14`, parked). |
| 9 | `migration_doc/CAMPAIGN_PORTFOLIO_QUEUE.md`, `QUEUE_2026-08-09_CAMPAIGN18.md`, `QUEUE_2026-08-02_CAMPAIGN15.md`, `QUEUE_2026-07-19_CAMPAIGN12.md`, `QUEUE_2026-07-18_CAMPAIGN11.md`, `QUEUE_2026-07-23_CAMPAIGN13.md`, `QUEUE_2026-08-10_CAMPAIGN16.md` | The campaign queues (C11–C18). Campaign numbering is add-only; **C17 is proposed, not launched; C19 (meshlets) is proposed under gate M-16**. |
| 10 | `migration_doc/FEATURE_INVENTORY.md`, `DEFERRED_WORK.md`, `WEBGPU_DEBUGGING_LOG.md` | Impact analysis, deferred/scaffolded work (check before deleting "dead" code), bug history. |

Research memos behind the current queue (read when a row cites them): design-model performance —
`F:/Dev/GH/cesium-lane-treebeard/_lane-out/REVIEW_DESIGN_MODEL_PERF_CIRDAN.md` (+ Treebeard's report beside it);
Earth at Night — `F:/Dev/GH/cesium-lane-quickbeam/_lane-out/REVIEW_EARTH_AT_NIGHT_CELEBORN.md` (+ Quickbeam's
audit and 65 evidence files). Both are also archived under `F:/Dev/GH/cesium-webgpu-worker-archive/`.

## 3. State right now (tip `0c9955c4c2`, Batch 1320)

> **UPDATE 18:24 ET (Batches 1322-1328):** the maintainer lifted the 8080 hold and the seat landed the window: Q130 (1322, with two seat type fixes; 1323 undid a directory-wide stage that had swept the held sky-box files; 1324 widened the q131 proof's window), Q120 (1325), Q-88 (1326), Q-142 (1327, default-ON, gate M-03 open), DM-07 (1328). §3a below is now history; the rebuild is running; §3b's tranches are the next work, in the order listed. Q-130-b remains banked behind Q-130-c.


Landed today (Batches 1292–1320): the research dispatch queue; Earth at Night demo repairs (Q-146/147,
EAN-03/04) and the default-off star-map/HDR/intensity controls (EAN-01); the Sandcastle2 **origin guard**
(Q-145 — every browser run of the built app must go through `createGuardedPage` / `openSandcastle2Url` in
`Tools/visual-regression/lib/sandcastle2-origin-rewrite.mjs`, because the committed built app redirects to
`localhost:8080` unconditionally); the rebuilt AEC performance probe (DM-01, `Tools/visual-regression/probe-aec-perf.mjs`);
the wave-end gate runbook (Q-152, `npm run wave-end-gate`); the spec-runner census (Q-139,
`npm run spec-census`: 279 node specs, 243 with no runner); the Q-137 scene-aware readiness rule; the Q-135
attestation hash fix; the two rulings; Wave DX; the instrument-defect lessons (DX-05).

### 3a. READY TO LAND — nothing is blocked by review; all six wait only for the maintainer's port-8080 hold

The maintainer has been testing on `localhost:8080` (the dev server, live-esbuild mode, started 08:53). Engine
landings were held so the tree under their session would not rebuild. **When the maintainer says the hold is
lifted**, land these in this order, one commit each, then rebuild:

| Order | Batch | Source of the patch | Review | Notes |
|---|---|---|---|---|
| 1 | **Q130** (Aragorn): Q-130 phongTextured uniformity, Q-131 edge-pipeline binder, Q-132/Q-132b light layout | clone `F:/Dev/GH/cesium-lane-q130` at `c80c7e7dcb` — `git diff HEAD` (12 engine files + 3 specs); **never stage `migration_doc/MAINTAINER_RULINGS_2026-08-17.md`** (CRLF phantom) | Elrond LAND-WITH-FIXES, all applied (B2 comment rewritten) | main moved only on docs since; apply with `git apply --3way` |
| 2 | **Q120** (Gimli): globe pipeline prewarm at the end of `prepareFrame` | clone `F:/Dev/GH/cesium-lane-q120` — stage exactly: `WebGPUGlobeSurfacePipelines.ts`, `WebGPUGlobeSurfaceRenderer.ts`, `WebGPUSceneRenderer.ts`, `GlobeSurfaceTileProviderRendering.js`, `globe-cold-start-readiness.spec.mjs`, `globe-pipeline-prewarm.spec.mjs`, `lib/engine-stub-bundler.mjs`; **for the probe use** `.../handoff-2026-08-29/land-q120/probe-main.mjs` (main's Batch-1294 probe plus the lane's six `pipelineCacheHits` lines — the lane's own copy would revert 1294) | Galadriel LAND-WITH-FIXES, B1–B5 applied | scope decision for the maintainer: prewarm `{28 B, 32 B}` vs "keep all three" |
| 3 | **Q-88**: ocean per-frame ArrayBuffers → cache scratch | `handoff-2026-08-29/land-q88/q88-engine.patch` + `ocean-per-frame-scratch.spec.mjs` | seat-verified + inertness mutant | spec resolves the engine file from `process.cwd()` (run from repo root) |
| 4 | **Q-142**: WebGPU AO uniform-bridge four-fault lockstep | `handoff-2026-08-29/land-q142/q142-engine.patch` + two specs | Sol-authored, seat-verified, naga OK | landing switch `WEBGPU_AO_FULL_SAMPLE_PATTERN` (default `true`) — **gate M-03** decides default-on vs default-off |
| 5 | **DM-07**: pick-emission / pick-pipeline counters (no logic change) | `handoff-2026-08-29/land-dm07/dm07-engine.patch` + `dm07-guide.patch` (3-way; the guide moved at 1308) + spec | Denethor LAND (third review) | unblocks Q-141's brief and tranche C |
| 6 | **Q-130-b**: hardened derivative-uniformity analyzer (after Q130) | `handoff-2026-08-29/land-q130b/` (lib + spec) | 24/25 — the one red is **Q-130-c** (five CSM sample sites under the globe material's module-wide `diagnostic(off, derivative_uniformity)`), an Opus disposition still owed; land with a reasoned allow-list or after Q-130-c |

Per-batch gates (all must pass before commit): `npx tsc --noEmit -p packages/engine` (0 errors that are not
TS2307), `npx eslint <touched>` (0 errors), `npx prettier --check <touched>` (check at real paths —
`.prettierignore` starts with `*`), `node Tools/c16/comment-marker-guard.mjs`, the row's specs by `node --test`,
`node --test Tools/visual-regression/pipeline-key-aliasing.spec.mjs` when a define or pipeline key changed,
`node --test Tools/visual-regression/purpose-header-contract.spec.mjs` when a probe/gate lib was added,
`node Tools/verify-no-doc-shred.mjs` after any `migration_doc` edit, then `git add` → `node
Tools/generate-tooling-catalog-launcher.cjs` → `git add migration_doc/TOOLING_CATALOG.md` → commit → push.
**Build at the seat before landing any batch that adds a `packages/engine/Source` file** (the generated barrel
assumes default exports; see `scripts/build.js` exclusion list).

After the six: `npx gulp build` → `npm run build-sandcastle` → commit the ledger → then the Edge tranches
(§3b). The scratch tools for applying Sol output are in the handoff archive (`apply-regions.mjs`,
`apply-rewrites.mjs`, `extract-fences.mjs`, `naga-check-ao.mjs`).

### 3b. HELD — and exactly what releases each

| Item | Held by | Releases when |
|---|---|---|
| Edge tranche **3e-F** (SC2 sweep re-run, Q-120/130/131/132 legs — use `PointLight`, never `SpotLight` (Q-132b-b NaN), S5 probes, Q-135/Q-137 confirmations) | the rebuild | after §3a + `gulp build` + `build-sandcastle`; served via `node server.js --serve-built --port 8094`; assert served md5 == disk md5 (`Tools/visual-regression/lib/served-build-preflight.mjs`) |
| Edge tranche **A** (Q-148 star-instrument repair + EAN-01 certification + Pippin's browser acceptance incl. Celeborn §2's five-step DevTools script) | the rebuild | same |
| Edge tranche **B** (Q-143 corrected design-model measurement on `probe-aec-perf.mjs`, with DM-02..06 legs) | the rebuild | same; **one Edge job at a time** |
| Edge tranche **C** (Q-141/Q-142 browser legs) | DM-07 + Q-142 landed | after the rebuild |
| First **wave-end gate** run (`npm run wave-end-gate -- --wave wave1`) | the tranches | closes Wave 1 (R-2026-08-29-2); bank the receipt and cite it in the ledger |
| **Q-141** metadata picking under streaming (decouple pick emission from colour-pipeline readiness) | DM-07 landed; Opus-judgement | when Opus capacity exists — it is cross-file engine judgement, not a pasted-Sol shape |
| **DX-14** catalog archive plan (`handoff-2026-08-29/land-dx14/`) | parked: two pasted Sol turns could not route the section into the launcher-managed region | an engineer with the generator open; **maintainer's go still owed**; DX-03/DX-04 wait behind it |
| **DX-01** probe runtime, **DX-07..10** decompositions of the eleven >1,000-line files, **Q-130-c**, **MS-00** mesh-shading spike | Opus capacity / owning lanes | see queue §6a and §6 |
| **DX-12** spec homes measured pass (Q-139-D1) | a fresh build | after the rebuild |
| Held uncommitted in the main tree: `SkyBoxResolutionPolicy.ts` + `skybox-resolution-policy.spec.mjs` + 12 `tycho2t5_80(_diffuse)_4096_*.jpg` | maintainer decision (4096 tier / DR-01) | do not stage until ruled |

### 3c. Maintainer decision sheet (open)

Queue §8: `M-01..M-25` (`M-15` reserved); `M-DX-1` (spec-runner home names), `M-DX-2` (ledger rotation);
`Q-139-D1`; the night-sky sitting `M-06..M-10` (DR-01 A/B/C, moon law, demo instant, C12-vs-C17 home,
twilight floor); `M-03` (Q-142 landing form); `M-16` (meshlet placement: Phase-8b wave vs Campaign 19); `M-17`
(any WGSL mesh-stage scaffold, given **WebGPU has no mesh shaders — not even a proposal — as of 2026-08-29**);
plus the older queue: 4096 tier + DR-01, R9 placement, Q-74-D1, Q-94a, Q-62-D1/D2, SC2-D2, NIGHTFADE-D1,
Q-78-D1, C12-33 countersign, Q-120 prewarm scope.

## 4. Operating rules for the Codex seat

- **Everything you dispatch or do yourself follows CLAUDE.md** — the principles are not optional for Codex.
  The ones that bit hardest today: **Principle 10** (a card, audit or packet is a lead; re-read the cited code
  before acting; today two queue rows were refuted on contact with the code — MS-04, and the first Q-130-b
  feed); **Principle 8** (verify rendering fixes with a probe, never by asking the maintainer); the
  **dead-code audit** (scaffolding is deliberate; check `DEFERRED_WORK.md` before deleting).
- **Landing rules:** quiet hours — no commit/push on weekdays 07:00–19:00 ET (resumes **Monday 2026-08-31**;
  `date` on the machine is authoritative — run it before writing any timestamp); never land engine or
  gallery changes while an Edge tranche runs (tools/docs only); never delete `F:/Dev/GH/cesium-webgpu-visual-evidence`
  or `-staging`; `cesium-lane-sundisc2` stays **FROZEN**; copy any probe evidence into
  `Tools/visual-regression/output/` before resetting or deleting a clone; retire a clone only after its
  packet/review/scratch are archived under `F:/Dev/GH/cesium-webgpu-worker-archive/<clone>/<date>/` and its
  junctions (`node_modules`, `packages/sandcastle/node_modules`) are removed with `rmdir` first.
- **Proof bar (R-2026-08-29-1):** full bar for engine/parity/shader (behaviour spec + inertness mutant +
  separate review + the named Edge leg); tools carry a spec only with logic worth pinning AND a runner home
  (`package.json` `test-*` script); docs/comments/demo text carry review plus a capture. Assert what the
  runtime does, never source text; never let a test supply what the runtime withholds (an injected constant
  made a spec pass today until the seat made it read the real switch).
- **Workers:** clones via `node Tools/provision-worker-clone.mjs F:/Dev/GH/cesium-lane-<name> --source
  F:/Dev/GH/cesium-webgpu` (junctions root and `packages/sandcastle/node_modules`); every worker, reviewer and
  executor gets a unique Tolkien name (registry in the seat memory file `feedback_tolkien_worker_names.md`;
  used names today include Samwise, Frodo, Merry, Pippin, Bilbo, Gimli, Aragorn, Boromir, Legolas, Erestor,
  Elrond, Galadriel, Círdan, Celeborn, Thranduil, Glorfindel, Elendil, Treebeard, Quickbeam, Bregalad,
  Hamfast, Folco, Beorn, Fredegar, Rosie, Ecthelion, Denethor, Finrod, Glóredhel); a lane under review is
  read-only for everyone until the review file exists; reviewers are always a different agent from the author;
  packet claims are "lane claims" in the ledger until reviewed.
- **Directed-turn shape that works (learned today):** paste everything (the card, the exact code regions,
  the review), forbid file reads and commands, ask for **region replacements** (`=== REPLACE <path> === /
  first line verbatim / last line verbatim / === WITH === / … / === END ===`) or whole-file `=== REWRITE`,
  specs in one fenced block, a short REPORT, and "if the premise is wrong say REFUTED with the line". Apply
  with `apply-regions.mjs` / `apply-rewrites.mjs` (both skip echoed template blocks), then gate at the seat.
  What failed: turns allowed to read files (each read is a whole-file `Get-Content -Raw` through PowerShell
  and burns the budget) and cross-file corrections of a returned lane (send those back to the lane that wrote
  the code). Prefer node over PowerShell for any tool invocation.
- **Browser work:** Edge channel only; one Edge job at a time; `--serve-built` and the served-md5 preflight;
  the origin guard for anything that opens the built Sandcastle2 app; **never touch port 8080/8081**;
  Playwright element screenshots only (in-page readbacks are transparent on WebGPU); readiness is
  `Scene.renderReady`, not `tilesLoaded`; interleaved A/B for GPU timing; multi-metric always.
- **Codex CLI on this machine:** `npm i -g @openai/codex@latest` → 0.151.0 at
  `%APPDATA%/npm/node_modules/@openai/codex/bin/codex.js` (shims `codex`, `codex.cmd`); the bundled
  `%LOCALAPPDATA%/OpenAI/Codex/bin/<hash>/codex.exe` (0.147) cannot self-update. `Tools/codex-preflight.mjs`
  and `Tools/codex-mcp-launcher.mjs` still resolve the bundled exe on Windows (they look for `codex.exe`) —
  set `CODEX_CLI_PATH` to the npm `codex.cmd` until **Q-151** lands. "Sol Ultra" = `gpt-5.6-sol` with
  `-c model_reasoning_effort=xhigh`; there is no separate ultra model id.

## 5. Where things are

| What | Where |
|---|---|
| Banked engine/tool patches, reviews, apply tools, research notes, Sol prompts | `F:/Dev/GH/cesium-webgpu-worker-archive/handoff-2026-08-29/` (70 files) |
| Retired-lane archives (packets, reviews, evidence) | `F:/Dev/GH/cesium-webgpu-worker-archive/<clone>/2026-08-29/` |
| Live clones | `cesium-lane-q120`, `-q130` (frozen, ready to land), `-bilbo` (DM-07), `-boromir` (Q-142), `-frodo` (scratch, clean at tip), `-fredegar` (unused), `-treebeard`, `-quickbeam` (research; cited by the queue), `-verify`, `-sundisc2` (FROZEN) |
| Probe evidence repatriated today | `Tools/visual-regression/output/lane-treebeard-2026-08-29/`, `.../lane-quickbeam-2026-08-29/` |
| Certification-grade evidence (immutable) | `F:/Dev/GH/cesium-webgpu-visual-evidence` |
| Claude seat memory (for the record; Codex does not read it) | `C:/Users/Kurt/.claude/projects/f--Dev-GH-cesium-webgpu/memory/` — `MEMORY.md` has the RESUME line; the `feedback_*` files are the distilled rules |

## 6. Known pitfalls that cost time today

- The Claude Bash tool evaluates its command text — a backtick anywhere breaks it; scripts go in files.
  (Codex's own shell is PowerShell; prefer `node` for file operations.)
- Mixed line endings: several files are CRLF; edit scripts must split on `/\r?\n/` and rejoin with the file's
  own EOL, and `diff --strip-trailing-cr` when comparing.
- `TOOLING_CATALOG.md` is regenerated only inside its `BEGIN/END GENERATED CENSUS` markers; prose outside is
  static (and stale since 2026-08-15).
- A new `probe-*.mjs` or `lib/*-gate.mjs` without `// @purpose` + `// @status` breaks
  `purpose-header-contract.spec.mjs` (18/18 today).
- `.prettierignore` starts with `*`: a prettier check on a scratch path silently passes — check real paths.
- The built Sandcastle2 app redirects to 8080 unconditionally: without the origin guard a probe runs on the
  maintainer's server without telling you.
- `MAINTAINER_RULINGS_2026-08-17.md` shows modified in every fresh clone (CRLF phantom, empty diff) — never
  stage it.
- Timestamps: run `date`; the seat's estimates drifted seven hours today and had to be re-labelled.

## 7. When Claude returns

Update `MEMORY.md`'s RESUME line and `feedback_tolkien_worker_names.md` with what Codex landed and named
(the seat's memory is the only place the naming registry lives); append a ledger section per batch as today;
keep this document accurate or supersede it with a dated successor and point the README index at it.
