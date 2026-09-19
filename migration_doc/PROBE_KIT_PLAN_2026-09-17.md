# The probe kit, the fleet harvest-and-retire, and the Campaign 15 aurora launch — plan (2026-09-17)

**What this document is.** The plan for three pieces of work the maintainer queued in one sentence on
2026-09-17, to run **after the Gemini fix plan's waves 0–3 land**: (1) componentise the probe fleet
into a small reusable kit, (2) harvest the existing 666-probe fleet for those components and retire
what is left, family by family, and (3) launch Campaign 15's aurora lane on that kit.

> **Directive (maintainer, 2026-09-17 ~21:40 EDT, verbatim):** "Lets queue up the probe modular
> components, cleaning up old useless probes after we harvest them for components, and space weather
> to run after we finish the gemini review fixes."

Context given in the same hour: the goal for the next few weeks is **highly visual improvements**;
Astra is focused on clouds; too much time has gone into `.mjs` probes relative to visual iteration;
probes should be componentised "like legos"; no new tech debt, but no more "making probes all day".

**What this document is NOT.** It is the argument, never the authority. It is not itself a launch
ruling: the four things it asks for were taken as `R-2026-09-17-9` … `-12` at ~22:05 EDT on
2026-09-17 (§7), and [`MAINTAINER_RULINGS_2026-09-17.md`](MAINTAINER_RULINGS_2026-09-17.md) is where
they bind from. It also does not re-plan the aurora science — that is
[`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) and the epic in
[`DEFERRED_WORK.md`](DEFERRED_WORK.md), both already research-verified, and this plan only sequences
them onto the kit.

**Measurement basis.** Every number below was re-measured in a fresh clone at `1a2baeaa4a`
(Batch 1498) on 2026-09-17 by lane Cotton, or is cited to the line it came from. Where a number
disagrees with an existing row, both are given and the disagreement is named. Nothing here was run in
a browser.

---

## 1. The fleet, measured

`Tools/visual-regression` at `1a2baeaa4a`:

| measure | value | method |
| :-- | --: | :-- |
| `probe-*.mjs` at the top level | **673** | directory listing |
| of which **executable probes** (`.spec.mjs` excluded) | **666** | the fleet this plan is about |
| of which **specs that happen to be named `probe-*`** | 7 | `probe-runtime.spec.mjs`, `probe-fleet-contract.spec.mjs`, `probe-aec-perf.spec.mjs`, `probe-descriptor-cells-contract.spec.mjs`, `probe-oit-reachability-runtime-migration.spec.mjs`, `probe-q141-pick-readback.spec.mjs`, `probe-runtime-lifecycle-adoption.spec.mjs` |
| lines in the 666 | **301,541** | mean 453, median 273 |
| probes over 1,000 lines | **54** | 17 over 2,000; largest `probe-c12-29-s5-custom-ellipsoid.mjs` at 6,226 |
| probes under 300 lines | 370 | |
| `*.spec.mjs` at the top level | 313 (282,507 lines) | |
| `Tools/visual-regression/lib/*.mjs` | 124 (125,068 lines) | plus 19 in `Tools/lib/` |
| lib modules with **zero** references anywhere under `Tools/` or `package.json` | **0** | the library half is not the problem |

**How much of the runtime has been adopted.** `lib/probe-runtime.mjs` landed as `DX-01` and grew in
four recorded steps — Batch 1377 (a refused run may not overwrite a banked receipt), Batch 1397 (the
anti-re-accretion residency contract), Batch 1445 (every descriptor driven through the runtime in
Node before Edge), and **Batch 1475**, which added Astra's lifecycle as an **opt-in** so the legacy
probes run exactly as before (`C13-42a`; `git log -- lib/probe-runtime.mjs`, re-read in this lane —
the commonly cited "Batch 1485" is the C13-42 god-ray metrics batch, not this one):

| measure | value |
| :-- | --: |
| probes importing `lib/probe-runtime.mjs` | **28** |
| probes carrying the `@runtime lib/probe-runtime.mjs` residency tag | **28** (the same 28) |
| probes that still call `chromium.launch(` themselves | **631** of 666 |
| probes that define their own pixel diff (`diffPngs` / `pixelDiff` / `diffRgba` / `diffModelPixels`) | **46** |
| probes that build their own `createHash` | 48 |
| probes that read `process.argv` directly | 71 |

**Origin governance, read from the detector rather than from a grep.** `C13-N01` stage 1 (Batch 1479)
shipped `lib/probe-runtime-governance.mjs` precisely so this number is not taken by
`git ls-files | grep -l`, and its queue row says so in as many words. Running that module's own
`analyzeRuntimeGovernance` + `censusRuntimeGovernance` over the 666 at `1a2baeaa4a`:

| detector census | value |
| :-- | --: |
| analyzed | 666 |
| **hard-defaulting their origin** | **585** — 413 by the env-read-with-fallback construct, 172 by a bare hard-coded constant |
| **governed** (importing a governance module) | **32** — runtime 28, edge-slot 0, served-build-preflight 4 |
| cloud + god-ray family | 61 analyzed, **52** hard-defaulting, **9** governed |

**Read against the banked figures carefully.** The last recorded census is `420/665` hard-defaulting
and `24/665` governed at Batch 1480, with the row's own note that "an origin hard-coded with no env
read at all is not counted; widening is stage-2". The stage-2 widening has since landed, so today's
`hardDefaulting` folds both constructs and **585 is not comparable to 420**. The comparable number is
the env-fallback construct alone: **413 today against 420 then — seven fewer, the ratchet holding.**
Governed has gone 24 → 32, and the cloud family 1 → 9 governed as stage-2 routing batch 1 landed
(Batch 1486). Nothing here is a regression; the figure simply must not be quoted flat against the
older one.

For orientation only, and *not* as the governance number: **531** of the 666 contain a
`localhost:8080` literal (528 in a non-comment line; 280 default their base URL to it). The runtime's
own default port is **8094** and its comment reads "`port` is a governed Edge port, never 8080"
(`lib/probe-runtime.mjs`, `CORE_OPTION_DEFAULTS`) — 8080 is the maintainer's own dev server.
`probe-saved-view.mjs` — the template CLAUDE.md Principle 8 step 2 tells every future lane to copy —
is one of them (`:16`, `const BASE = "http://localhost:8080";`), which is why `DX-104` matters more
than the count does: while the template is ungoverned, every new probe inherits the default.

**Who runs a probe.** Nobody, mechanically:

| measure | value |
| :-- | --: |
| distinct `Tools/visual-regression/*.mjs` files named in an `npm` script | 120 — **every one a `.spec.mjs`** |
| of the 666 probes, named in an `npm` script | **0** |
| of the 666 probes, named in a `.github/workflows/*.yml` | **0** (9 workflow files scanned) |
| of the 666 probes, named in a `QUEUE_*` / `FIX_QUEUE_*` / `DEFERRED_WORK` / `CAMPAIGN_STATE` doc | 204 |
| of the 666 probes, named anywhere in `migration_doc/**` | 666 |

A probe is invoked by hand, from a brief or a queue row. That is not a defect to fix — a probe is an
instrument, not a gate — but it is the fact that makes "which probes can be retired?" answerable by
reading rather than by watching CI go red, and it is why the retirement criterion in §4 says *no live
runner* rather than *no references*: every probe is named in `migration_doc`, because every probe was
created by a batch that recorded it.

**Spec homes, re-measured.** `node Tools/spec-runner-census.mjs` at `1a2baeaa4a` prints
`Summary: total specs 383, homed 174 (7 quarantined), orphaned 209`. `DX-94` records
`375 / 166 / 209` measured at Batch 1482 — **the orphan count is unchanged at 209 and the total has
grown by 8**, which is exactly the "a new orphaned spec lands unremarked" behaviour that row
describes. No correction is owed to `DX-94`; this is its ratchet argument, measured again.

**Status vocabulary.** Read through the grammar's own parser (`Tools/lib/purpose-header.mjs`,
`parsePurposeHeader`), across the 666:

| `@status` | probes | lines |
| :-- | --: | --: |
| `ACTIVE` | **523** | 274,537 |
| `INVESTIGATION` | **143** | **27,004** |
| `ARCHIVED-CANDIDATE` | **0** | 0 |

`ARCHIVED-CANDIDATE` has **zero users anywhere in the tree** — including the 16 `.mjs` already sitting
in `Tools/visual-regression/archive/`, every one of which still reads `@status INVESTIGATION`. The
third of the three statuses is dead vocabulary. §4 and `R-2026-09-17-11` are built on that fact.

**Families.** By name prefix, across the 666:

| family | probes | lines | ACTIVE | INVESTIGATION | on the runtime | has `localhost:8080` |
| :-- | --: | --: | --: | --: | --: | --: |
| `cloud` | 60 | 28,624 | 48 | 12 | 9 | 50 |
| `model` | 22 | 6,836 | 19 | 3 | 0 | 20 |
| `globe` | 16 | 6,165 | 14 | 2 | 2 | 10 |
| `polar` | 15 | 1,656 | 2 | **13** | 0 | 14 |
| `c11` | 11 | 9,820 | 11 | 0 | 0 | 8 |
| `voxel` | 11 | 5,937 | 11 | 0 | 0 | 11 |
| `weather` | 11 | 5,485 | 11 | 0 | 0 | 11 |
| `clustered` | 10 | 2,860 | 10 | 0 | 0 | 10 |
| `polyline` | 10 | 3,396 | 9 | 1 | 2 | 7 |
| `wgs84` | 10 | 948 | 1 | **9** | 0 | 10 |
| `c10` | 9 | 2,418 | 7 | 2 | 0 | 9 |
| `env` | 8 | 5,225 | 8 | 0 | 0 | 8 |
| `moon` | 8 | 12,601 | 8 | 0 | 0 | 8 |
| `sun` | 8 | 6,315 | 7 | 1 | 0 | 7 |
| `atmo` | 7 | 2,337 | 7 | 0 | 0 | 5 |
| `bloom` | 7 | 936 | 1 | **6** | 0 | 6 |

**The shape this table shows is the one that changes the procedure.** There are **259 distinct family
prefixes**. The top 16 cover **223 of 666 probes — 33.5 %**. **191 prefixes hold two probes or fewer
and account for 232 probes — 35 %.** A purely family-by-family harvest therefore reaches a third of
the fleet in sixteen lanes and leaves a third as an un-harvestable long tail. §4 splits the procedure
accordingly: families for the head, **status** for the tail.

**All three wave-end runners are outside the contract, and two of them are invisible to the grep that
counts it.** The wave-end gate's children are `Tools/variant-smoke-test.mjs`,
`Tools/visual-regression/sandcastle-smoke.mjs` and `Tools/visual-regression/capture-and-diff.mjs`
(`Tools/wave-end-gate-binding.mjs:465`, `:488`, `:516`). None is inside the `probe-*.mjs` filename
glob the fleet contract selects on, so none carries its watchdog or `finally`-close rules.

`tools-probes-04`'s **44** re-derives exactly: **697 files under `Tools/` call the literal
`chromium.launch(`; 631 are inside the glob; 66 are outside it** — 16 in `archive/`, 3 in
`.spec.mjs`, and 3 the library files that legitimately own the call (`lib/probe-runtime.mjs`,
`lib/probe-fleet-contract.mjs`, `lib/runtime-residency-contract.mjs`) — leaving **44**
(`GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §d, §e A1).

**But 44 is a floor, not the population, and the gap sits exactly where it hurts.**
`capture-and-diff.mjs` resolves a browser type first and calls `browserType.launch({…})` at `:816`;
`variant-smoke-test.mjs` does the same at `:455`. Neither contains the literal string, so **neither is
among the 44** — of the three wave-end children only `sandcastle-smoke.mjs` is. Widening the predicate
to "imports `playwright` **and** calls `<ident>.launch(`" leaves the 631 in-glob unchanged and takes
the outside-non-archive/spec/lib set from 44 to **46**; the two files it adds are those two wave-end
children, and both import **none** of the Edge-slot lock, the served-build preflight,
`build-source-identity` or the runtime.

That is the argument for `DX-107` in one line: **an acceptance keyed on `chromium.launch(` cannot
reach the two files the wave-end gate most needs covered**, so the row is written as behaviour
selection rather than as a list of 44.

<!-- corrected 2026-09-17 from reviewer Diggle's FIX-1, which caught `capture-and-diff.mjs`; applying
the behaviour predicate uniformly also surfaced `variant-smoke-test.mjs`, so the figure is 46, not the
45 the finding proposed. -->


---

## 2. The two jobs, separated

The fleet has been asked to do two jobs at once, and the second job is what makes it expensive.

**Job one — invariants.** RTE correctness, byte-identity at defaults, WebGL↔WebGPU parity, exit
contracts, lifecycle and teardown, determinism. These have a right answer that does not change when
the renderer gets prettier. They are *checks*: they belong in specs and in the probes that produce
the measurement a spec pins, they run without a human in the loop, and they keep every rule the
handbook's pinning doctrine already states.

**Job two — looks.** Whether the aurora reads as an aurora; whether the deck looks like a cumulus
field; whether the limb is right. These have **no threshold that is not an opinion**, and every
attempt to give them one produces the same three artefacts this repository has already paid for: a
pre-registered `expectedMismatch` with a rationale paragraph attached (the mechanism
`Tools/visual-regression/README.md` documents under "Pre-registered expectations"), a threshold
widened until a red turns green, or a probe that measures a proxy for beauty and is then argued with.
The maintainer is the judge of job two and is faster at it than any metric: shown the images, the
answer takes seconds.

**The policy.** Invariants keep specs and probes. Looks are judged by the maintainer on a **contact
sheet** — rigs × renderers × {BEFORE, AFTER}, with the diff and the metric strip shown beside each
pair, no verdict and no threshold on the page. A look, once accepted, is pinned **exactly once** as a
baseline refresh in its own reviewed commit, through the promotion path that already exists
(`capture-and-diff.mjs --update --confirm-baseline-promotion --update-rationale … --reviewed-by …`).
The contact sheet can never turn a gate green; it is the instrument that lets the maintainer say
"yes", and the baseline refresh is what records that he did.

This is a narrowing of Principle 8, not a loosening of it. Principle 8's target is "do not ask the
user to verify what you can verify automatically", and that stands unchanged for every invariant.
What it does not distinguish today is a *verification* from a *judgement*, and the fleet's growth is
what that conflation costs: a lane that must produce a numeric verdict for an aesthetic question
writes a probe to manufacture one.

### 2.1 Governance text, for the seat to land under `R-2026-09-17-10`

Neither file is edited by this lane. Both edits are drafted here, verbatim, for the seat.

**(a) `CLAUDE.md` Principle 8** (`:148`) — insert after the numbered workflow, before
"**Anti-patterns to avoid:**":

> **Invariants are verified; looks are judged.** The workflow above governs anything with a right
> answer: RTE, byte-identity, parity, exit contracts, lifecycle. A question whose answer is an
> aesthetic judgement — does the deck read as cumulus, is the aurora legible from orbit — is NOT
> made automatic by inventing a threshold for it. Render the candidates to a contact sheet
> (`Tools/visual-regression/contact-sheet.mjs`: rigs × renderers × BEFORE/AFTER, with the pixel diff
> and metric strip beside each pair, and no verdict on the page), show it, and let the maintainer
> rule. A look he accepts is pinned exactly once, as a baseline refresh in its own reviewed commit.
> Do not write a probe to manufacture a number for a question the maintainer answers in two seconds,
> and never let a contact sheet's output change a gate's status or an exit code.

**(b) `ORCHESTRATION_HANDBOOK.md` §7 "Acceptance semantics"** (`:318`) — add as a bullet beside
"Proof bar by change class":

> - **Visual acceptance (`R-2026-09-17-10`)** — an aesthetic question is judged on a contact sheet by
>   the maintainer, not gated by a threshold. The sheet carries no verdict, no threshold and no exit
>   code; an accepted look becomes one baseline refresh in its own reviewed commit
>   (`capture-and-diff.mjs --update --confirm-baseline-promotion`). Every invariant beside it keeps
>   the full bar. A probe written to score an aesthetic question is a review finding, not evidence.

---

## 3. The kit

**Design constraint, stated first: this is not a green field, and nothing here rewrites the runtime.**
Four of the six components already exist in prototype form, built for one family, and the cheapest
credible plan is to generalise them rather than to invent beside them.

| component | what already exists | what is missing |
| :-- | :-- | :-- |
| **Rigs** | `lib/cloud-tour-fixtures.mjs` — 2,734 lines of pure data + validators, **15 fixtures and 9 sequences**, each carrying `id`, `gate` (threshold + rationale), `climate`/`region` tags, `anchor`, `localSolarHour`, `volumetric` dials and camera `stations`, with `replayKeyFor()`, `validateFixture()` and `summarizeFixtureCoverage()`. Also `scenes.json` — 10 scenes with `name`/`camera`/`setupFile`/`setupParams`/`thresholds`/`expectedMismatch`. | a family-neutral registry; a schema (`scenes.json:2` declares `"$schema": "./scenes.schema.json"` and **that file does not exist**); one loader both consumers read |
| **Capture** | `lib/probe-runtime.mjs` — `runProbe`, `launchEdge`, `captureElement`, the Edge-slot lock, the served-build preflight, the origin refusal, the receipt/refusal/incident writers and the exit table | a `capture(rig, origin, options)` seam so a rig, not a bespoke `cells()`, is what a capture takes |
| **Diff** | `Tools/lib/png-decode.mjs` (232), `Tools/lib/png-rgba.mjs` (137), `lib/visual-gate-policy.mjs` `evaluatePixelGate` | **no shared image diff** — 46 probes carry their own |
| **Metrics** | `lib/cloud-photometry.mjs` (430), `lib/cloud-spectrum.mjs` (604), `lib/cloud-orbital-ladder-model.mjs` (591) | all three are cloud-shaped; no structure/connected-component metric, which `C15-08` requires by name |
| **Verdict + receipt** | `lib/verdict-exit-gate.mjs` (the frozen `PASS 0 / FAIL 1 / ERROR 2 / STRUCTURAL 3` table), `assembleReceipt`, `Tools/wave-end-gate-receipt.mjs` (957 lines, already emits a markdown artifact table with per-file md5) | a contact-sheet index in the banked layout |
| **Fleet contract** | `lib/probe-fleet-contract.mjs` (1,065) + `lib/runtime-residency-contract.mjs` + `purpose-header-contract.spec.mjs` | selection by **behaviour** rather than by filename (44 by the literal grep, **46** by a behaviour predicate); `ARCHIVED-CANDIDATE` made reachable (0 users) |

**The working prototype of the whole shape already exists and should be read before anything is
designed.** `probe-cloud-orbital-ladder.mjs` (952 lines, landed `C13-N04b`, repaired at Batch 1496)
is a probe on the runtime whose rig is declared constants, whose metrics live in a separate pure
module with its own spec, whose verdicts are a pure function of its cells, and whose descriptor
(`:733`) is ~220 lines of declaration. Its anatomy is what every row below is trying to make cheap:

Line ranges below are this lane's reading of each file at `1a2baeaa4a`; each count is the length of
the range beside it, so a reviewer can check any cell by opening the range.

| probe | lines | header | imports | rig | page-side work | metrics | verdict / exit / banking |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| `probe-cloud-orbital-ladder.mjs` (migrated) | 952 | 49 (`:1`–`:49`) | 31 | **48** (`:81`–`:128`) | 303 (`:129`–`:431`) | 217 (`:432`–`:648`) | 80 verdicts (`:649`) + 224 descriptor (`:729`) — **0 launch / argv / receipt** |
| `probe-cloud-dials.mjs` (migrated) | 434 | 29 | 13 | **67** (`:43`–`:109`, incl. page stubs) | in the descriptor | 113 (`:110`–`:222`) | 19 report + 193 descriptor + cells (`:242`) — **0 launch / argv / receipt** |
| `probe-cloud-genus-morphology.mjs` (not migrated) | 1,339 | 180 | 12 | **92** (`:193`–`:284`) | 682 (`RUN_LANE`, `:285`–`:966`) | 24 (`:967`–`:990`) | **349** — `main()`, `:991`–`:1339` |
| `probe-model-ibl.mjs` (not migrated) | 546 | 71 | 13 | **11** (`:85`–`:95`) | 161 (`:96`–`:256`) | 57 (`:257`–`:313`) | 47 private CRC32/PNG encoder (`:314`–`:360`) + 186 captures/assertions/exit |
| `probe-model-color.mjs` (not migrated) | 355 | 29 | 9 | **8** (`:39`–`:46`) | 118 (`:47`–`:164`) | 63 (`:165`–`:227`) | 5-line adapter over the shared `png-rgba` (`:228`) + 123 captures/assertions/exit |

Two things fall out of that table. First, **the rig is tiny** — 14 to 92 lines in every case — which is
why extracting it is cheap and why sharing it is what makes a new scene a ten-line file rather than a
new probe. Second, **the boilerplate is not tiny and does not survive migration**: the two migrated
probes carry zero launch, argv or receipt code, and the three unmigrated ones carry 128, 233 and 349
lines of it.

The harvest is also worth doing for what it finds. Two defects, re-derived in this lane while
reading five probes:

- `probe-model-ibl.mjs:70` documents its default base as `http://localhost:8134`; `:85` codes
  `process.env.PROBE_BASE || "http://localhost:8080"`. The documentation and the code disagree about
  which server the measurement hits.
- the same probe prints `GATE FAIL (STRUCTURAL — …)` at `:540` and then exits **1** at `:543`/`:545`.
  It has the blindness tier in its vocabulary and routes it to the "saw the subject and it missed the
  bar" code — the exact six-copy divergence `lib/verdict-exit-gate.mjs` was written to end, still live
  in a probe the library never reached. This is one more instance for the `tools-probes-02/-01/-09/-10`
  exit-code lane; it is **attached to that lane, not filed as a new row**.

### 3.1 `DX-101` — the rig registry

One declarative record per rig under `Tools/visual-regression/rigs/<name>.mjs`, a registry/loader in
`lib/rig-registry.mjs`, and `scenes.schema.json` finally written — as the rig schema, so
`scenes.json:2`'s dangling `$schema` resolves. The record's field set is `cloud-tour-fixtures`'
generalised: `id`, page or URL, renderer set, camera (lon/lat/height **or** an ECEF pose with
direction/up — `scenes.json` already needs both), clock, dials/quality, asset or tileset,
`setupFile`/`setupParams`, viewport, readiness predicate, tags, and the optional `gate` +
`expectedMismatch` pair the existing suite already understands.

**`capture-and-diff.mjs` is not modified by this row.** `scenes.json` is *generated* from the rigs
whose tags include `wave-end`, and the spec asserts the regeneration is byte-identical to the file on
disk — so the wave-end gate keeps reading the file it reads today and the rigs become its source.

Seed rigs, from what the fleet already encodes: the 10 `scenes.json` scenes; the 15
`CLOUD_TOUR_FIXTURES`; the 4 ladder rungs (`lib/cloud-orbital-ladder-model.mjs:43`,
`ALTITUDE_LADDER_METRES` = 20 km / 200 km / 2,000 km / 20,000 km); the 3 `probe-saved-view.mjs` views
(`:19`); and a sandcastle-smoke selection over the 343 gallery demo directories.

Acceptance: every rig resolves and validates; ids unique; tags declared and drawn from a frozen
vocabulary; `replayKey` stable across runs and changing when a determinism-relevant field changes;
`scenes.json` regenerates byte-identically. Spec under `test-visual-regression-node`. Inertness
mutant: make the uniqueness check unreachable (`if (false && …)`) and the duplicate-id case must red.

### 3.2 `DX-102` — `lib/image-diff.mjs`

One diff. `{ mismatchPct, changedPx, bbox, diffRgba }`, per-channel tolerance (the suite's existing
16/255 default, stated not hidden), optional mask. It replaces the 46 private copies as each family
is harvested; it does **not** fork a second gate policy — `lib/visual-gate-policy.mjs`
`evaluatePixelGate` keeps deciding what a mismatch *means*, and this module only computes it.
Spec + inertness mutant (a diff that always returns 0 must red the known-different fixture pair).

### 3.3 `DX-103` — `lib/metrics/*.mjs`

Pure functions, one concern per file, each with a `node --test` spec: masks, saturation fraction,
luminance statistics (pre-tonemap, via the existing photometry rule), spectral slope, region means,
and — new, because `C15-08` demands it in writing ("point/structure/connected-component metrics;
never a band mean for a faint sparse additive signal") — **connected components and structure
similarity**. Extracted from `cloud-photometry.mjs`, `cloud-spectrum.mjs`,
`cloud-orbital-ladder-model.mjs`, `probe-model-ibl.mjs` (`topBottomBrightness`, `:288`) and
`probe-model-color.mjs` (`meanModelColor`, `:165`). Two lanes; the cloud extraction must not change a
banked number, so its acceptance is that the ladder model's own spec stays green over the moved code.

### 3.4 `DX-104` — `capture(rig, origin, options)`

`lib/capture.mjs`, on top of the runtime: `launchEdge`, the Edge-slot lock, the served-build
preflight, the origin refusal, `captureElement`. Takes a rig, returns PNG + metrics + receipt. Both
renderers; BEFORE/AFTER origins in one run so a pair is comparable by construction; one browser per
run, closed in `finally`. This is the row that makes the Principle-8 template governed: after it,
"copy `probe-saved-view.mjs`" becomes "declare a rig", and the 8080 default stops propagating.
Needs the Edge slot **once**, for one leg proving a captured pair over two origins. Everything else in
the kit is pure Node.

### 3.5 `DX-105` — `contact-sheet.mjs` (and `DX-106`, the banking)

`Tools/visual-regression/contact-sheet.mjs` renders rigs × renderers × {BEFORE, AFTER} as one static
HTML page under gitignored `output/contact-sheets/<date>/`, with the diff heat-map and a metric strip
beside each pair. **No verdict, no threshold, no exit code beyond "the page was written".** The
maintainer opens it. The page model is a pure function of a manifest, so the spec drives that function
and never a browser.

`DX-106` extends `Tools/wave-end-gate-receipt.mjs` — which already writes the artifact table with
per-file md5 (`:638`) — with a contact-sheet index entry, so a sheet banks in the wave-end layout the
executors currently assemble by hand.

### 3.6 `DX-107` — the fleet contract, by behaviour

**Attaches to `tools-probes-04` and to `DX-02`; does not duplicate either.** Two changes:
select the contract's file set by **behaviour** (a file that calls `chromium.launch(` is in the fleet,
wherever it lives, including the `browserType.launch(` form) so the **46** escapees the behaviour
predicate finds — `capture-and-diff.mjs` (`:816`) and `variant-smoke-test.mjs` (`:455`) among them,
neither reachable by the literal grep that yields 44 — come under the watchdog
and `finally`-close rules; and make `ARCHIVED-CANDIDATE` reachable, since it has 0 users at HEAD and
the charter's retirement exit depends on it. The `@purpose` grammar is **add-only**
(`Tools/lib/purpose-header.mjs`, `PURPOSE_STATUSES`) and this row adds no status word — `ACTIVE`,
`INVESTIGATION`, `ARCHIVED-CANDIDATE` are sufficient because `R-2026-09-17-11` ruled that ARCHIVE
means *moved*.

---

## 4. Harvest and retire

### 4.1 The unit of work

**For the head — one family, one lane, one owner.** A tier-3 lane takes a family and, per probe,
records: its rig(s); its metrics; its **unique assertions** (a clause no spec and no other probe
makes); and who runs it — grepping all four runner surfaces (`package.json` scripts,
`.github/workflows/**`, open queue-row acceptances, and the wave-end gate). It extracts the unique
metrics into `lib/metrics`, writes the family's rigs, migrates the probes worth keeping onto the
runtime + `capture()`, and leaves the rest with their disposition recorded. **One defect, one owner:
a family is owned by exactly one lane for the duration of its harvest**, and no two concurrent lanes
touch the same family.

Order by value: **cloud** (60 probes, 28,624 lines, the subsystem with the most live work and nine
probes already migrated to copy from) → **model** (22) → **globe** (16) → **weather** (11) →
**voxel** (11) → **polar** (15) → then `c11`, `clustered`, `polyline`, `sun`, `moon`, `env`, `atmo`,
`c10`, `wgs84`, `bloom`. Sixteen lanes, 223 probes, 33.5 % of the fleet.

**For the tail — status, not family.** 191 prefixes of ≤2 probes hold 232 probes; there is no family
to harvest. They are dispositioned in bulk by `@status` and by the four-surface runner grep, in
roughly four lanes, and the first cohort is the **143 `INVESTIGATION` probes (27,004 lines)** — which
by the codemod's own mapping means "everything whose conclusion was banked elsewhere"
(`Tools/lib/purpose-header.mjs`, `AUDIT_STATUS_TO_HEADER`). Of those 143, **43** are named in a live
queue/ledger doc and **4** are named by a spec; the rest are cited only in batch records. Three
families are almost entirely this cohort and can be taken whole: `polar` (13 of 15), `wgs84` (9 of
10), `bloom` (6 of 7).

### 4.2 The retirement rule — attached, not invented

**`EXECUTOR_LANE_CHARTER_2026-08-14.md:259` (§3.6) already owns this**, and it already says the right
thing: an `INVESTIGATION` probe is finished only when its conclusion and its retirement form one
linked authorized landing group; **bank the conclusion first, always** (root cause, measurement and
the probe's own name into `WEBGPU_DEBUGGING_LOG.md`); then take one of two exits — **PROMOTE** (turn
it into a spec or standing gate, flip `@status ACTIVE`, wire it where the gates run) or **ARCHIVE**
(move the file to the archive directory, flip `@status ARCHIVED-CANDIDATE`, delete its allowlist row
and any runbook reference in the same landing group). "Done with it, left it where it was" is the
state the charter names as the failure.

**That ritual is currently half-applied, measurably.** 143 probes sit in the third state; 16 files
were moved into `archive/` without the status flip; `ARCHIVED-CANDIDATE` has zero users in the whole
tree. So this plan adds no new rule. It asked the maintainer to settle the one thing §3.6 does not —
whether ARCHIVE means **moved**, which is what the charter says, or **deleted**, which is what
"cleaning up old useless probes" could mean — and `R-2026-09-17-11` settled it as **moved, then
deleted as a separate second step**, for a reason that is not sentiment: a move is revertible with
`git log --follow`, a delete inside the same landing group is a delete nobody reviewed twice, and this
repository has a standing rule that destructive scripts take a positive list.

A probe is **deleted** only when every one of these holds:

1. its rig exists in the registry, and its metrics are in `lib/metrics` with a spec;
2. every **unique assertion** it made is covered by a spec, by a rig + metric, or is recorded in the
   packet as **deliberately dropped, with the reason**;
3. **no live runner** references it — `package.json`, `.github/workflows/**`, an open queue row's
   acceptance, the wave-end gate. A citation in a batch record is provenance, not a runner, and does
   not block a retirement; the citation is repointed at the banked conclusion in the same landing;
4. it has already landed as `ARCHIVED-CANDIDATE` in `archive/`, in a prior batch;
5. it is on a **positive deletion list**, by name, reviewed by an Opus reviewer who is not the author,
   and the list is read back from the file before the delete runs;
6. its evidence is harvested to `cesium-webgpu-worker-archive` and its PNGs/diffs repatriated to
   `Tools/visual-regression/output/` **first** — two-phase, harvest before destroy.

The tooling catalog regenerates in the same batch (`node Tools/generate-tooling-catalog-launcher.cjs`),
and the orphan-count ratchet `DX-94` asks for is what stops the number growing back.

### 4.3 What the harvest is expected to produce

Per family, in the packet: the rigs written, the metrics extracted, the unique-assertion table with a
disposition per row, the runner grep across four surfaces, the probes migrated, the probes flipped to
`ARCHIVED-CANDIDATE`, and the defects found on the way (the two in §3 are the yield from five probes;
five probes is 0.75 % of the fleet).

---

## 5. Campaign 15 aurora, on the kit

The science is settled and is not re-planned here: the epic (`DEFERRED_WORK.md:7300`) and the queue
(`QUEUE_2026-08-02_CAMPAIGN15.md`) carry it, `C15-00` is COMPLETE with every endpoint fetched and
every schema read byte-for-byte on 2026-08-06 under ruling `R4` (queue §2a). Every constraint they
carry stands verbatim: default OFF means zero passes, allocations, jobs, animation, requests, uploads
and bind-group churn; no built-in Kyoto Dst provider and no bundled Dst snapshot (WDC Kyoto's terms
disallow commercial use — a caller-owned numeric override is the only Dst seam); valid live OVATION
owns spatial extent and intensity, and Kp or Bz never multiplies an active OVATION field; geomagnetic
state and solar-flare state stay separate, and a GOES flare alone does not move the oval; the
architecture is the research-verified **ellipsoid-relative RTE layered emission volume over 80–600 km**
with separate 427.8 / 557.7 / 630.0 nm profiles, **not** a sky dome.

What this plan adds is only the **sequencing onto the kit**, and which rows need none of it.

| row | kit dependency | why |
| :-- | :-- | :-- |
| `C15-01` neutral state packet + manual driver | **none** | its own written exit is "pure-Node mutation tests … no network is needed to produce every visual state" (queue `:420`). Startable in parallel with `DX-101`. |
| `C15-02` WMM2025 geomagnetic frame + synthetic oval | **none** | its exit is "CPU reference vectors and mutation tests" distinguishing geomagnetic from geographic latitude, geocentric from geodetic pole, north from south, quiet from storm. Pure Node. |
| `C15-03` shared layered emission kernel | **none for its exit** | its exit is GLSL/WGSL source/contract lock + CPU fixtures at ground/terminator/limb/orbit + a mutation that replaces local-night evaluation with camera-local fade. Also pure Node — the contact sheet is not its gate, it is how the kernel's *look* gets iterated once `C15-04` can draw it. |
| `C15-04` both renderers + performance architecture | **rigs, capture, contact sheet, image-diff, metrics** | first row with pixels. Needs `DX-101`, `DX-102`, `DX-103`, `DX-104`, `DX-105`. |
| `C15-05` OVATION + Kp ingest | none | fixture/schema-mutation work behind the §2a measured contracts and the authority contract already written. |
| `C15-06` RTSW + GOES ingest | none | same; the queue's measured corrections (descending RTSW order, `-9999` fill, per-satellite rows, missing `Z`) are the spec. |
| `C15-07` facade, demo, diagnostics, rights | rigs (demo smoke) | the gallery demo joins the sandcastle rig set. |
| `C15-08` certification | the whole kit + **connected-component metrics** | "never use a band mean for a faint sparse additive signal" is in the row's own text; `DX-103`'s structure metrics exist for it. Wave-end Edge tranche. |

**Three seed rigs**, defined here so `C15-04` has something to iterate against on day one. Each is a
rig record in the `DX-101` format; the numbers are the epic's, not new ones:

1. **`aurora-ground-polar-night`** — ground station inside the northern oval at local magnetic
   midnight, pinned to a winter solstice instant so local night is unambiguous; camera near-horizontal
   to put the curtain against the sky rather than overhead; globe visible for occlusion; synthetic
   `moderate` preset. Tests: curtain morphology, the 427.8 nm lower edge, terrain/globe occlusion.
2. **`aurora-orbit-limb`** — camera above the limb looking across the terminator at ~2,000 km, the
   band where a sky-dome implementation fails and the layered volume does not. Tests: the 80–600 km
   shell geometry, RTE stability at globe scale, the three line layers seen edge-on.
3. **`aurora-midlatitude-storm-kp8`** — the manual `severe` preset driving the oval's
   activity-dependent equatorward expansion, viewed from a mid-latitude ground station that sees
   nothing at quiet. Tests: expansion, the 630.0 nm red upper profile, and **both hemispheres** —
   the southern twin is a separate rig with the same body, because "northern and southern" is in
   `C15-08`'s exit gate and a single-hemisphere rig set would hide a sign error.

Each carries `expectedMismatch: UNMEASURED` on its first run, which is the honest value the suite
already defines for a subsystem never compared in this metric.

---

## 6. Sequencing, lanes and wall time

### 6.1 The trigger

"After the Gemini review fixes" = **after waves 0–3 of `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §f
have landed.** Waves 4–6 are decision-gated (`D7`, `D10`, `D1`, the `A8` retire-or-wire rulings) and
P2 shards; they interleave with everything below rather than blocking it. At the time of writing,
wave 0 landed as Batch 1498 and wave 1 as Batch 1497; wave 2's five engine lanes and wave 3's three
are the remaining bar.

There is one real interaction worth naming: **wave 5 of the fix plan is instrument scope**, and its
"select the probe contract by behaviour" item is `DX-107` here. They are the same work. Whichever
runs first owns it; the other attaches.

### 6.2 The order

```text
waves 0–3 of the Gemini fix plan land
   │
   ├─ KIT WAVE A (pure Node, one Opus lead + 4 tier-3, no Edge)
   │     DX-101 rigs · DX-102 image-diff · DX-103 metrics ×2 · DX-107 contract-by-behaviour
   │
   ├─ C15-01 + C15-02 in parallel (2 Node-only engine lanes, own lead, own reviewer)
   │
   ├─ KIT WAVE B (DX-104 capture + DX-105 contact sheet + DX-106 banking)
   │     └─ ONE Edge job: the captured-pair leg + one rendered sheet
   │
   ├─ HARVEST, rolling — families in tier-3 lanes as their rigs land, ≤5 concurrent,
   │     cloud → model → globe → weather → voxel → polar → the next ten
   │     └─ retirements land per family, one batch behind its harvest
   │
   ├─ C15-03 (Node) → C15-04 on the contact sheet, with the three seed rigs
   │
   ├─ C15-05 / C15-06 ingest (parallel, Node) → C15-07 facade + demo
   │
   ├─ TAIL SWEEP — the 143 INVESTIGATION probes + the ≤2-probe prefixes, ~4 lanes
   │
   └─ C15-08 certification = the wave-end gate for the whole sequence (Edge tranche)
```

### 6.3 Lanes and wall time

Constraints applied: one Edge job at a time; fan-out ≤5 tier-3 per lead; one tier-2 lead per batch;
every engine row owes a separate OPUS-REVIEW; GitHub quiet hours 07:00–19:00 ET on weekdays, so
landings happen in the evening window or at weekends.

| block | lanes | Edge jobs | landing nights (estimate) |
| :-- | --: | --: | --: |
| Kit wave A | 1 lead + 4 tier-3 + 1 reviewer | 0 | 2 |
| Kit wave B | 1 lead + 2 tier-3 + 1 reviewer + 1 executor | **1** | 2 |
| `C15-01`, `C15-02` | 2 tier-3 + 1 reviewer (parallel with the kit) | 0 | 2 |
| Harvest, head (16 families) | 16 tier-3 across 4 waves + 4 reviews | 0 | 6 |
| Harvest, tail + retirements | 4 tier-3 + 2 reviews | 0 | 3 |
| `C15-03` … `C15-07` | 6 tier-3 / tier-2 + reviews | **1** (`C15-04`'s look leg) | 6 |
| `C15-08` certification | 1 lead + 1 executor + 1 adversarial verifier | **1** (tranche) | 2 |
| **total** | **~52 lane dispatches, 3 Edge jobs** | **3** | **~23 landing nights** |

Read that as a **planning estimate with its assumptions on the page**, not a commitment: it assumes
the observed recent cadence (nine batches landed on 2026-09-16; five ordered units in one night), no
red discovered in the harvest that turns into its own campaign, and the Edge slot free when the three
jobs want it — which today it is not, since the L4/L5 cloud legs hold the queue under
`R-2026-09-17-5` and `C13-41`'s S3 discriminator sits in front of them. **The Edge-slot queue, not the
lane count, is what sets the calendar.** The kit is deliberately arranged so that 49 of the ~52
dispatches need no browser at all.

---

## 7. The four rulings — TAKEN 2026-09-17 ~22:05 EDT

All four were put to the maintainer at ~22:05 EDT on 2026-09-17, after this lane's station-3 review
(Diggle, verdict LAND-WITH-FIXES), and **all four were taken as recommended** as
`R-2026-09-17-9` … `-12`. Their authority is
[`MAINTAINER_RULINGS_2026-09-17.md`](MAINTAINER_RULINGS_2026-09-17.md); the sections below are the
argument each was taken on, and the id is given beside each heading. One thing was settled that this
section had left open: `R-2026-09-17-9` fixes **when** `C15-03`…`C15-08` come off the hold — by a
later one-line ruling **once the contact sheet exists** — and states that C12's close is neither
blocked nor forgotten by the release.

### R-A → **TAKEN as `R-2026-09-17-9`** — the C15 aurora hold: release `C15-01` and `C15-02` only

**What `R4`'s condition is, and whether it is met.** `R4` holds `C15-01..08` **until Campaign 12
closes** (`QUEUE_2026-08-02_CAMPAIGN15.md` status block; `CAMPAIGN_STATE.md:241`). **It is not met.**
C12's exit gate is MAXIMAL by `R-2026-08-10-1` — C12 stays open until every `C12-29` slice lands,
including S3, canonically owned by `C13-41` (`CAMPAIGN_STATE.md:55`). `R-2026-09-02-5` funded the S3
exposure-sweep discriminator; `R-2026-09-13-1` made the S3 re-decision **conditional on that re-run**
— red again on `shadowContrastInvariant` outside [0.97, 1.03], or a still-blind deck-free control
lane, executes **Option C** of `R-2026-08-10-1` (re-file S3/S4 as C13 rows, close C12, unblock C14,
**release the R4 aurora hold**); green continues S3. That re-run was leg (e) of job 13c and **never
ran**, so **neither arm has fired** and `RR-2026-09-13-E` stays open (`DEFERRED_WORK.md:2464`).

**Text as taken (`R-2026-09-17-9`; the ruling adds the release condition for `C15-03`…`C15-08`).**

> `C15-01` (neutral state packet + manual driver) and `C15-02` (WMM2025 geomagnetic frame + synthetic
> oval) are released from the `R4` hold and are dispatchable as pure-Node engine lanes.
> `C15-03`…`C15-08`, `C15-06P` and `C15-07H` stay held by `R4` until C12 closes or `R-2026-09-13-1`'s
> Option-C arm fires.
>
> Basis: `R4`'s condition is C12 closure and **this ruling does not claim it is met** — it is a
> narrow, named override of `R4`'s literal text for two rows, not an exercise of Option C, and it
> pre-empts neither arm of `R-2026-09-13-1`. The two rows carry pure-Node exit gates by their own
> written text, take no Edge slot, touch no C12 file and no shader, and produce the deterministic
> packet and geomagnetic frame every later aurora row consumes — the longest-lead items in the lane.
> Releasing them costs the C12 critical path nothing and is reversible: neither row ships a visible
> effect.

**The alternatives, argued.** (a) *Hold everything until C12 closes* — the literal reading; costs the
aurora lane its two longest-lead rows for an indefinite wait on an Edge-slot queue that has three
things in front of it. (b) *Exercise Option C now and release all eight* — available and pre-ratified,
but Option C's stated condition is a **red re-run** that has not happened; taking it today would close
C12 on a judgement about noise rather than on the measurement `R-2026-09-02-5` funded. (c) *the
recommendation* — two rows, named, with the override said out loud.

### R-B → **TAKEN as `R-2026-09-17-10`** — the visual-acceptance protocol

> Invariants (RTE, byte-identity, parity, exit contracts, lifecycle, determinism) keep specs and the
> probes that produce their measurements. **Aesthetic questions are judged by the maintainer on a
> contact sheet**, which carries no verdict, no threshold and no exit code, and which cannot change
> any gate's status. A look the maintainer accepts is pinned **exactly once**, as a baseline refresh
> in its own reviewed commit, through the existing
> `capture-and-diff.mjs --update --confirm-baseline-promotion --update-rationale … --reviewed-by …`
> path. A probe written to manufacture a number for an aesthetic question is a review finding.
> `CLAUDE.md` Principle 8 and `ORCHESTRATION_HANDBOOK.md` §7 are amended with the text drafted in
> `PROBE_KIT_PLAN_2026-09-17.md` §2.1.

Basis: the fleet has 666 executable probes and 301,541 lines, and 46 of them carry a private pixel
diff, because a lane asked to answer "does this look right" with a number writes one. Principle 8's
automation requirement is unchanged for everything with a right answer.

### R-C → **TAKEN as `R-2026-09-17-11`** — the retirement rule

> `EXECUTOR_LANE_CHARTER_2026-08-14.md` §3.6 remains the retirement authority and is not restated.
> Two things it leaves open are settled here. **(1) ARCHIVE means moved, not deleted**: a retired
> probe lands in `Tools/visual-regression/archive/` with `@status ARCHIVED-CANDIDATE`, its allowlist
> row and runbook references removed in the same landing group, after its conclusion is banked in
> `WEBGPU_DEBUGGING_LOG.md`. **Deletion is a separate, later batch**, taken only from a positive
> list — read back from the file, reviewed by an Opus reviewer who is not the author — after the
> archive move has landed and after the probe's evidence is harvested to
> `cesium-webgpu-worker-archive` and its images repatriated to `Tools/visual-regression/output/`.
> **(2) The first retirement cohort is the 143 `@status INVESTIGATION` probes**, and
> `ARCHIVED-CANDIDATE` — which has zero users anywhere in the tree today, including the 16 files
> already sitting in `archive/` — becomes reachable as part of `DX-107`. A probe's appearance in a
> batch record is provenance, not a live runner, and does not block its retirement; the citation is
> repointed at the banked conclusion in the same landing.

Basis: the ritual exists and is half-applied — 143 probes are in the "done with it, left it where it
was" state the charter itself names as the failure, 16 files were moved without the status flip, and
the third status word has never been used. Two-phase, positive-list destruction is the standing rule
for destructive work in this repository.

### R-D → **TAKEN as `R-2026-09-17-12`** — where the kit rows live

> The kit rows are filed as **`DX-101` … `DX-108` in §6a (Wave DX) of
> [`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md)**, under a new
> sub-heading, in that document's existing flat `DX-nn` sequence and row-card format. No new queue
> file and no new id prefix.

Basis, argued against the alternatives: every row the kit depends on or attaches to already lives in
§6a — `DX-01` (the runtime), `DX-02` (anti-re-accretion), `DX-06` (deduplicate by family), `DX-94`
(the orphan ratchet), `DX-96`/`DX-97`. A new file would split one programme across two documents,
which is the **exact defect record round 5 filed `DX-96` and `DX-97` for** ("filed in
`DEFERRED_WORK.md` and named nowhere in this file — the same split-across-two-files defect that caused
the `DX-86`/`DX-87` id collision"). A `DX-PK-nn` prefix would add a second id grammar to a namespace
whose add-only rule already works and whose ids are cited flat everywhere. The C15 rows are **not**
re-filed: `C15-01..08` keep their ids and their home, and §5 attaches to them.

---

## 8. Handoff notes — read first if you are taking a lane here

**The runtime, as it is.** `Tools/visual-regression/lib/probe-runtime.mjs` exports `parseProbeArgs`,
`decideServedBuildRefusal`, `decideOriginRefusal`, `decideRenderReadyRefusal`, `launchEdge`,
`installSandcastle2OriginRewrite`, `sha256`, `captureElement`, `normalizeJson`, `assembleReceipt`,
`buildRuntimeReceipt`, `outcomeOfRun`, `buildIncidentRecord`, `buildMarkdownSummary`, `isEntryPoint`
and `runProbe`, and re-exports the Edge-slot and refusal surfaces. A probe hands `runProbe` a
descriptor (`name`, `title`, `outputSubdirectory`, `args`, `servedArtifacts`, `launchArgs`,
`receiptEnvelope`, optional `workBudgetMs`, `cells`, `receipt`, `verdicts`, `summary`) and gets an
exit code. **`workBudgetMs` is the opt-in to the lifecycle and is deliberately optional** — a
descriptor without it takes the pre-adoption path unchanged, and migrating the legacy probes is
`C13-42a-2`, one family at a time with its own measured budget, not a flag day. Read
`probe-cloud-orbital-ladder.mjs` and `probe-cloud-dials.mjs` before writing a new probe; they are the
two worked examples.

**The fleet contract, as it is.** `lib/probe-fleet-contract.mjs` is a source-text analyzer — it never
launches anything, so its spec runs under plain `node --test`. Every predicate fails **closed**: a
construct it cannot parse is reported as ABSENT, so an exotic-but-correct file lands on a visible
shrink-only allowlist rather than passing silently. It selects by filename today
(`requiresPurposeHeader`, `:1032`), which is what `DX-107` changes. The `@purpose`/`@status` grammar
is `Tools/lib/purpose-header.mjs` and is shared by three consumers; `PURPOSE_STATUSES` is add-only.

**Lane rules.** Fresh clone, never a worktree; no git writes from a worker; scratch space through
`Tools/lib/lane-tmp.mjs` (`withLaneTmp` / `mkLaneTmp` / `laneTmpRoot`) so a killed run leaves one
sweepable root — at HEAD there are **209 `mkdtemp` call sites in 75 files under `Tools/` and
`scripts/` and 5 adopters of the helper**, which is `tools-probes-06`'s row and is why a new lane
must not add a 210th. Temp removed exactly at the end. Evidence repatriated to
`Tools/visual-regression/output/` before any clone is reset or deleted.

**One owner per family.** During its harvest a family belongs to exactly one lane. Two lanes editing
the same family is the condition that produced the one-defect-two-owners incidents this repository
has already recorded.

**Existing rows to attach to, never to duplicate.** `DX-01`, `DX-02`, `DX-06`, `DX-42`, `DX-93`,
`DX-94`, `DX-96`, `DX-97` in `QUEUE_2026-08-29_RESEARCH_DISPATCH.md` §6a; `tools-probes-01/-02/-04/
-06/-09/-10`, `A12` and `A14` in `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §d/§e;
`C13-42a-2` and `C13-42a-3` in `DEFERRED_WORK.md`.

---

## 9. Nonclaims

- **Nothing here was run in a browser, and no capture was taken.** Every number is a source-text or
  directory measurement, or a re-run of an existing pure-Node census (`spec-runner-census.mjs`).
- **The origin-governance census in §1 was produced by driving the detector's own exported functions,
  not by running its spec.** `probe-fleet-contract.spec.mjs` cannot run in a clone with no
  `node_modules` — it imports `acorn` through `lib/page-scope-closure.mjs`, and this lane installs
  nothing. `analyzeRuntimeGovernance` and `censusRuntimeGovernance` from
  `lib/probe-runtime-governance.mjs` were called directly over the 666 instead. That is the same
  predicate but a weaker route than the spec, and whoever takes `DX-108`'s first family should
  re-take the number from the spec on a tree that has its dependencies.
- **This document changed no row's status when it was written.** The four rulings were taken after
  review, on 2026-09-17 at ~22:05 EDT, and the status changes they authorise — `C15-01` and `C15-02`
  released from `R4`, the `DX-101`…`DX-108` rows placed — are recorded in
  [`MAINTAINER_RULINGS_2026-09-17.md`](MAINTAINER_RULINGS_2026-09-17.md), the C15 queue and
  [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md), which are their authorities. This plan is the argument,
  not the authority.
- **The wall-time table in §6.3 is an estimate with its assumptions printed**, not a commitment. The
  Edge-slot queue sets the calendar and this lane does not control it.
- **The kit's component boundaries are a proposal derived from five probes read in full** — three
  cloud, two model — plus the two migrated exemplars and the shared libraries. A sixth probe could
  move a boundary; the harvest's first family is where that gets tested, which is why `cloud` is
  first and not last.
- **The `probe-model-ibl.mjs` findings in §3 are re-derived at `1a2baeaa4a`** (`:70` vs `:85`;
  `:540` vs `:543`) and are attached to the existing exit-code lane rather than filed as new rows.
- The C15 seed rigs in §5 are **rig definitions, not science**. Every physical constraint they
  reference is the epic's, already research-verified; none is derived here.
