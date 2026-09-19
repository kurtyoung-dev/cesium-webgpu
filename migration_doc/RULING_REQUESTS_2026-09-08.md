# Ruling requests — 2026-09-08

## RR-2026-09-08-1 — Sharp smoke pipeline construction

**Pending; not an approval.** The newly captured `sharp-baseline-01` is an ordinary
native `FAIL 1`: the 4x2 transformed image has four channels instead of the required
three. Independent source review found that both installed Sharp versions execute
`removeAlpha` before `ensureAlpha`, irrespective of JavaScript chaining order;
the smoke put both flags in one pipeline. Fresh bounded 1x1 diagnostic controls
confirmed four channels with both flags and three when removal uses a second
pipeline, without changing the installed inputs. Request permission to finish the
existing resize/extract/ensure-alpha/composite pipeline, then call `removeAlpha`
on its completed PNG in a second Sharp instance. Preserve the existing 4x2x3
assertion, exact 24 RGB bytes, orientation and malformed-input checks, both
resolution contexts in the same process, native-selection checks, and every
historical failure. Rerun under a fresh identity after independent source review;
do not claim the complete pixel oracle has already passed. The separate Windows
root0.35.4-then-nested0.34.5 libvips error remains open: isolated versions and the
reverse order succeeded, but newer-then-older failed. The already approved scoped
dependency update still needs candidate proof and is not accepted by this request.

Evidence is retained in
`tmp/astra-dependency-implementation-20260908/_lane-out/`: the original
`root/sharp-baseline-01-*`, `root/sharp-isolation-*-01.jsonl`,
`root/sharp-isolation-result-01.json` (SHA-256
`29781339e8f074aa54ab2838ab5102bf371f8cbe3e91b657f3db7d85da53882a`),
and `galadriel/GALADRIEL_SHARP_BASELINE_DIAGNOSIS_01.md` (SHA-256
`a701c20741370ff003ca3af27d3a0d30f1244e2ff321931793e0cdd3ce865a3b`).
Authority is charter §1.1; this request does not pause the campaign or prevent
independent work on the approved documentation bridge.

## RR-2026-09-08-2 — Exact documentation comparison corrections

**Pending; not an approval.** Full documentation comparison01 is a retained
native `FAIL 1`. Independent review identifies327 footer-only false-reds because
the comparator excludes actual emitted filenames such as `global.html#ANNOTATIONS`,
and nine JSDoc4 anchor corrections across five named pages: whitespace is trimmed
from labels and unintended trailing `%20` is removed from URLs. Request a fresh,
independently reviewed successor comparator that recognizes HTML before a literal
`#` suffix, preserves the exact-one contextual footer checks, and permits only
the explicitly enumerated old/new anchors and occurrence counts in
ArcGisMapServerImageryProvider(two), ArcGisMapService(one), Cesium3DTileset(two),
GaussianSplat3DTileContent(two), and IntersectionTests(two). All other HTML,
hrefs, labels, file membership, declarations and types.txt bytes remain required
to match; no global whitespace or ordering normalization is proposed. The actual
ordering changes are being repaired in the template, not waived. Add negative
controls for extra/missing/moved footer tokens, fragment-named files with extra
content, changed anchor href/label/count and changes outside the exact listed
anchors. Preserve comparison01 unchanged and perform a new capture/comparison
after source review. This accepts a specific upstream link-rendering correction,
not undocumented API loss, a blanket generator-delta exception or browser proof.

Evidence under `tmp/astra-dependency-implementation-20260908/_lane-out/`:

- `root/docs-candidate-01/full-candidate-comparison-01.json`,369378 bytes,
  SHA256 `0a2ab46f8cf44f4533455809beb3f0e3ace4034c55520be1339ca4b14e865224`.
- `galadriel/GALADRIEL_FULL_DOCS_COMPARISON_DIAGNOSIS_01.md`,7389 bytes,
  SHA256 `4e4d2ed5ec678fcfd7cf7f0b3b57ecda11175cf282b34f59804386d6b5e35ddd`.
- `galadriel/ARWEN_DOCS_FRAGMENT_CLASSIFIER_REVIEW_01.md`,3096 bytes,
  SHA256 `cccf8ca683e7a687a1e0ddafe64fd9f7e31c6e5f9caa6b4908009af458af1b39`.

Authority is charter §1.1. This request does not pause the campaign, authorize a
comparator mutation, or block the separately approved ordering repair and
source-only downstream readiness work.

## RR-2026-09-11-A — Tracked waiver mechanism for authorized quiet-hours lifts

**Pending; not an approval.** On 2026-09-11 the maintainer verbally lifted GitHub quiet hours
for the afternoon following the machine restart. The pre-push hook (`.husky/pre-push`,
enforcing R-2026-08-14-4 via `Tools/landing-rules.mjs`) has no override flag or waiver path;
it rejected in-window commit timestamps unconditionally, forcing Batch 1464 (`765feaba0a`) to
be re-dated and pushed at 19:09 EDT after the window elapsed. Request a tracked, auditable
waiver mechanism (e.g., a signed maintainer waiver token or scoped command flag with explicit
expiry and reason) so that an authorized verbal lift can be executed without subverting the
landing rules or requiring commit re-dating.

Authority is charter §1.1. This request does not alter quiet-hours policy or authorize
unilateral hook bypasses.

## RR-2026-09-13-A — Quarantine-runner convention for red specs

**Pending; not an approval.** On 2026-09-12 lane L2 (Telchar) measured that 7 of the 25 homeless
cloud specs are RED at `bab1ff6e21` — `cloud-coverage-response` (1 failing assertion),
`cloud-ibl-revision` (1), `cloud-march-emission` (3), `cloud-observability-counters` (2),
`cloud-reconstruction-attachments` (6), `cloud-shadow-rte` (1), `eclipse-cloud-ibl-response` (1).
Homing all 25 into `test-cloud-c13` would have turned a green runner red; leaving them homeless
would have left them unguarded. The seat ruled a third way and Batch 1479 (`beb08423b3`) executed
it: the 18 green specs go to `test-cloud-c13`, the 7 red ones to a **new standalone
`test-cloud-c13-quarantine` script deliberately wired into no aggregate and into no wave-end
gate**, and `Tools/spec-runner-census.mjs` gained a `*-quarantine` suffix convention plus a
`quarantined` count so the census reports "0 homeless, 7 quarantined, 2 homed by other lanes" and
never a bare 0. Request ratification of the convention itself as a standing mechanism: that a
measured-red spec may be parked in a `*-quarantine` runner, that such a runner is excluded from
every aggregate and from the wave-end gate by definition, that the census must surface the
quarantined count separately from the homed count, and that a spec leaves quarantine only by a
reviewed script-line move with a stated drift-or-regression verdict. The repair programme is
`C13-N08b`, re-scoped add-only on 2026-09-12; Frór's triage (banked with the L2 harvest) reads 15
A-drift / 0 B-regression across the seven files.

Evidence: `DEFERRED_WORK.md` `C13-N08b` re-scope block (`:789`, `:971-981`);
`QUEUE_2026-07-23_CAMPAIGN13.md` §9 row `C13-N02`; Batch 1479 commit `beb08423b3` (2026-09-12
15:08:27 -0400) and its `package.json` script addition;
`cesium-webgpu-worker-archive/lanes-2026-09-12/cesium-lane-telchar-20260912/_lane-out/TRIAGE_RED_CLOUD_SPECS.md`.

Authority is charter §1.1. This request does not pause any lane and does not change the disposition
of any of the seven specs; the convention is already executing under seat ruling and is recorded
here so the maintainer can ratify, narrow or reverse it.

## RR-2026-09-13-B — A red guard gets a repair row in the next batch, never a standing annotation

**Pending; not an approval.** `probe-fleet-contract.spec.mjs` was RED on main for roughly nine days
before lane L2 repaired it on 2026-09-12. Its C2 failure named four genuinely non-compliant probes
(`probe-aec-perf`, `probe-aec-residency-e1`, `probe-q141-pick-readback`: no watchdog;
`probe-ao-runtime-config`: no watchdog and a `browser.close` outside `finally`), last touched in
Batches 1374/1390/1393/1394 on 2026-09-02/03; its C5 failure was a shrink-only ratchet row claiming
a defect repaired in Batch 1307 whose allowlist entry was never updated. Every landing in the 1470s
recorded the runner as "217/221, same four" and TOLERATED it — an annotation that carried forward
across batches and reviews without opening a repair. Request a standing rule: **when a guard spec
is red at a landing, the landing files a repair row for that red in the same batch and names its
owner; a repeated "same N" annotation is not an acceptable disposition for more than one batch.**
The corollary the same wave measured: the landing gate must run every runner a batch's files are
homed in (see RR-2026-09-13-D), because a runner green at one landing and red at the next with
nobody looking is the same defect in a different place.

Evidence: `DEFERRED_WORK.md:44-46` (the corrected 217/221 baseline and the four names);
lane L2 packet `LANDING_PACKET_TELCHAR.md` §3 and `REVIEW_VAIRE.md` (archive
`lanes-2026-09-12/cesium-lane-telchar-20260912/_lane-out/`); Batch 1479 `beb08423b3`, which
repaired C2 and corrected — did not delete — the C5 reason.

Authority is charter §1.1. This request changes no row's status and asks for a rule, not a waiver.

## RR-2026-09-13-C — A seat gate never runs a suite that reads a maintainer-held file

**Pending; not an approval.** On 2026-09-12 the first L6 landing attempt was refused by its own
landing wrapper because the wrapper listed `npm run test-landing-rules` as a required runner. At
the seat that suite reads the maintainer's HELD, never-staged `Tools/verify-landing-compliance.mjs`
and `Tools/verify-landing-compliance.spec.mjs` (448 insertions of uncommitted work-in-progress) and
fails three tests whose names do not exist at HEAD — "historical grandfathering is exact by
commit-local file and rule", "a source deletion cannot retain an unmatched inherited clean-list
entry", "a renamed marked successor cannot remain warning-only behind a stale inherited path". This
is the same class as the A1m2 catalog-suite red of 2026-09-11. The seat ruled on the spot that a
seat gate never runs a suite that reads a held file, that the reviewers' clean-clone runs are the
evidence for such a suite, and that a lane gate is the lane's own spec commands; `land-w1.sh` now
takes `;`-separated commands or the literal `none`. Request ratification of that rule and of its
consequence: a landing whose only failing gate is a held-file suite is not blocked, provided a
reviewer reproduced the suite in a clean clone and the packet records it.

Evidence: seat landing log of 2026-09-12 (Batch 1480 first attempt); the held files are visible in
the seat worktree's `git status` and were never staged;
`cesium-webgpu-worker-archive/lanes-2026-09-12/cesium-lane-yavanna-20260912/_lane-out/REVIEW_SALMAR.md`
records the clean-clone reproduction (`tvrn` 329/325/4, `test-landing-rules` 344/344).

Authority is charter §1.1. This request does not weaken any landing rule; it names which tree the
rule is measured in.

## RR-2026-09-13-D — The landing gate runs every runner a batch's files are homed in

**Pending; not an approval.** Filed as the mechanised half of RR-2026-09-13-B. On 2026-09-12
`npm run test-cloud-c13` was measured at 84 tests / 53 pass / 31 fail on its original eight-spec
list while every landing in 1469–1477 had gated only on its own lane's runner. Frór's triage
(`TRIAGE_TEST_CLOUD_C13_FROR.md`, banked with the L2 harvest) resolved 28 of the 31 as
ENVIRONMENT — the generated shader-string module `Shaders/WebGPU/Environment/ProceduralClouds.js`
is gitignored build output (`packages/engine/.gitignore:5`) absent on any unbuilt tree — and 3 as
DRIFT against Batch 1471's god-ray energy law; **0 were regressions**, so the "one-day-old landing
regression" framing the lead and the seat both reached was wrong for 28 of 31. The mechanism that
would have answered it in seconds already exists: `runCensus({files})` in the spec census maps a
path set to the runners those paths are homed in, demonstrated on Batch 1471's own path set, which
returns `test-cloud-c13`. Request that the landing gate be required to run **every runner a
batch's changed paths are homed in**, not only the lane's own, with the census as the mapping
authority, and that the wave-end gate run every cloud runner.

Evidence: `TRIAGE_TEST_CLOUD_C13_FROR.md` (archive
`lanes-2026-09-12/cesium-lane-telchar-20260912/_lane-out/`); Batch 1468's own commit body
("65/65 after a build (36/64 on an unbuilt tree)"); `Tools/spec-runner-census.mjs`;
`DX-93` in `QUEUE_2026-08-29_RESEARCH_DISPATCH.md`, which is the tool this request would make
load-bearing.

Authority is charter §1.1. This request neither retroactively invalidates a landed batch nor
changes any row's status.

## RR-2026-09-13-E — Re-decide `C12-29` S3 / `C13-41` under R-2026-09-02-5, now that the discriminator has returned

**Pending; not an approval.** `R-2026-09-02-5` funded an exposure-sweep discriminator to decide
whether `C12-29` S3 — the maximal C12 exit gate under `R-2026-08-10-1`, and through it C14's
transitive blocker — continues, or falls back to that ruling's **Option C** (re-file S3/S4 as C13
rows, close C12, unblock C14, release the R4 aurora hold). **The discriminator ran on 2026-09-03 and
nothing in the tracked record said so** until this batch: a repository-wide grep for
`exposureSweep` or `1.0706` across `migration_doc/` returned **zero hits**. Request the
re-decision the ruling reserved, on the measurement below.

**What ran.** Éowyn job 2, leg 7 of 9:
`PROBE_BASE=8094 node Tools/visual-regression/probe-eclipse-cloud-response.mjs --exposure-sweep`,
**2026-09-03 22:42:57 → 22:47:48 EDT**, tree **`fbea2028cc`** (Batch 1403, worktree clean; served
`Build/CesiumUnminified/Cesium.js` md5 `a039143c1c8f7e8f8bdafb5a8b2defb2` on both ports == disk),
Playwright `msedge` headless, runId `d1470ec7-a426-4a1c-87e0-7def7500f2b2`. **Exit 1 — GATE FAIL.**

**What it decided, and what it did not.**

- **The gate failed on one predicate.** `failedPredicates` `["shadowContrastInvariant"]`,
  `parityFailed` `[]`. `shadowContrastRatioAtDeepest` **1.0341** against the band **[0.97, 1.03]**;
  `atDiscriminating` **1.0145** against a prediction of "visually unchanged, +0.08 %".
- **The sweep itself was measured, and it is the interesting result.** At `cloud.exposure`
  **[0.5, 1, 2, 4]** the ground-shadow ratios were **[1.0706, 1.0997, 1.1212, 1.1348]** against the
  Reinhard-residue prediction **[0.5651, 0.6341, 0.7222, 0.8124]**. `exposureSweepRisesWithExposure`
  is **TRUE** — but it is a **reported-only** predicate and gates nothing. **So the direction the
  residue model predicts is confirmed and its level is refuted**: the measurement sits *above* 1 at
  every exposure while the model puts it *below* 1. That is a discrimination, and it is the
  substance the re-decision turns on.
- **Two of the three predictions PASSED.** Deck: `deckRatios` [1, 0.9032, 0.7982, **0.5139**], the
  deepest rung in band and monotone, `deckPureRatio` 0.6359 in band. IBL: **275 fills predicted =
  275 WebGPU = 275 WebGL**, both in band, no skipped bucket, quiescence 0.6579 on both backends,
  recovery **1.0000 / 1.00007**, determinism delta 0, parity `maxFactorDelta` 0.
- **The deck-free control lane was BLIND, and that is the repairable part.** Structural reason:
  "the deck-free control is not four fresh ABBA configure epochs with pinned lighting and certified
  factors: off-a/on-a/on-b/off-b rung 0-3 custom-light read-back is not the exact diagnostic
  `DirectionalLight`" — **9 predicates unscored**, including `shadowDecrementMatchesGroundDim`,
  `deckFreeGroundDimsByFactor` and `refreshCostMeasured`.
- **`refreshCostMeasured` was FALSE**, which matters because it is **one of `R-2026-08-14-1`'s two
  restored exit conditions**: the WebGPU GPU time is **INVALID** ("pair 0 eclipse: the pre-segment
  GPU readback drain did not close (timedOut=true, undrained=1)"), leaving a wall-clock fallback of
  **38.04 ms/refresh** over 198 refreshes against **WebGL 4.28 ms/refresh**. Even setting the failed
  predicate aside, this run could not have discharged the row's exit gate.

**The decision requested.** Under `R-2026-09-02-5`, either **(a) continue S3** — with the
instrument's deck-free control lane repaired first, since nine predicates including one of the two
restored exit conditions cannot be scored until it is, so a re-run without that repair returns the
same shape of answer; or **(b) take Option C of `R-2026-08-10-1`** — re-file S3/S4 as C13 rows,
close C12, unblock C14 and release the R4 aurora hold. **A re-run is already in flight** on the
post-P0-2 tree `ea651de6d8` (Batch 1483): executor Bandobras, job 13c leg (e), banking to
`Tools/visual-regression/output/eclipse-cloud-response-2026-09-13/`. **Its numbers do not exist yet
and are deliberately not written here; the seat will append them to this request when the leg
returns.** Nothing in this request asks for a band to be widened — `R-2026-08-14-1` restored those
bands deliberately, and widening one to make a first run pass is the failure mode the gate module's
`why` strings exist to expose.

Evidence, both **gitignored and in the seat tree, read-only**:
`Tools/visual-regression/output/eclipse-cloud-response-2026-09-02b/README.txt` (with
`facts-extract.txt`, `probe-output/` and the two deepest-rung PNGs) and
`Tools/visual-regression/output/eowyn-job2-2026-09-02/SUMMARY.md` row 7. Both are copied into this
lane's `_lane-out/SOURCES/` for the reviewer. The same figures are stamped onto the `C13-41` row in
`QUEUE_2026-07-23_CAMPAIGN13.md`, pointed at from `C12-29` in `QUEUE_2026-07-19_CAMPAIGN12.md`,
and summarised in `CAMPAIGN_STATE.md`'s C13 critical-path paragraph.

Authority is charter §1.1. This request changes no row's status, pauses no lane, and does not
pre-empt the in-flight re-run.

### Appended 2026-09-19 — leg (e) was taken, and **both sweeps are now in the record**

_Appended by the batch that carries this line, at the append point this request reserves above:
"**Its numbers do not exist yet and are deliberately not written here; the seat will append them to
this request when the leg returns.**" The leg has returned. Two facts in that reserving sentence are
corrected here rather than edited away: the executor was **Filibert**, not Bandobras — job 13c
stopped mid-leg (b) on 2026-09-13 and its own leg (e) never ran — and the bank is
`Tools/visual-regression/output/eclipse-cloud-response-2026-09-19/`, not the `…-2026-09-13/` path
named above. Both receipts are gitignored and live in the seat tree._

**The two sweeps, side by side. Every figure is quoted from the two runs' own report JSONs.**

| | **Banked sweep** | **Leg (e) re-run** |
|---|---|---|
| Date | 2026-09-03, 22:42:57 → 22:47:48 EDT (wall **4 m 51 s**) | 2026-09-19, 10:59:27 → 11:03:20 EDT (wall **3 m 53 s**) |
| Tree | **`fbea2028cc`** (Batch 1403) — its own receipt's "Clone commit" line | **`ea651de6d8`** (Batch 1483), the tree `R-2026-09-13-1` names, fixed for this run by `R-2026-09-19-3` |
| Instrument | as at `fbea2028cc` — **not** the same instrument as the column to the right: over the probe and the six libraries in its transitive import closure, `lib/cloud-probe-harness.mjs` differs by **289 / 22** (Batches 1478 `e69d3e4fc7` and 1480 `39283ec388`); the probe and the other five libraries are byte-identical | as at `ea651de6d8` **plus one hunk** — the deck-free control repair of Batch 1518 (`3e6feaae24`), permitted by `R-2026-09-19-1`. Clone overlay in the instrument sense only: the receipt also records a provisioner-modified doc path and that `gulp prepare` was not run |
| Served bundle | md5 `a039143c1c8f7e8f8bdafb5a8b2defb2`, disk == served | md5 `3873edb82e25a724e00800ecfb99c811`, disk == served, re-checked **after** the repair was applied |
| Executor · runId | Éowyn job 2 leg 7 · `d1470ec7-a426-4a1c-87e0-7def7500f2b2` | Filibert · `7241daf6-7040-4922-b9ec-b820cab9cb25` |
| Exit | **1 — GATE FAIL** | **1 — GATE FAIL** |
| **Red trigger 1** — `shadowContrastInvariant` | **FIRED**: `false`, `shadowContrastRatioAtDeepest` **1.0341102079879674**, outside [0.97, 1.03] | **DID NOT FIRE**: `true`, `shadowContrastRatioAtDeepest` **0.9893862265081094**, inside the band |
| **Red trigger 2** — deck-free control BLIND | **FIRED**: `deckFreeControlStateIsolated` among nine `unscoredPredicates`; **one** structural reason enumerating **16** per-rung constructor-name read-backs (of the **two** reasons in the row below) | **DID NOT FIRE**: `deckFreeControlStateIsolated` **true**; no deck-free structural reason and no deck-free blind lane |
| `failedPredicates` | `["shadowContrastInvariant"]` | `["deckPureRatioInBand"]` — `deckPureRatio` **0.6457892095024083** against the band **0.625–0.645** |
| `unscoredPredicates` | nine | **one**: `["refreshCostMeasured"]` |
| `structuralReasons` | two | **one**: *"fresh refresh-cost measurement is ineligible: webgpu: pair 0 eclipse: the pre-segment GPU readback drain did not close (timedOut=true, undrained=1)"* |
| `parityFailed` | `[]` | `[]` |
| `exposureSweepRisesWithExposure` (**reported-only**; gates nothing) | `true`; measured [1.0706, 1.0997, 1.1212, 1.1348] — four distinct values, none equal to the ratio above | `false`; measured [0.9893862265081094 × 4] against predicted [0.5651, 0.6341, 0.7222, 0.8124] — **bit-identical at all four rungs, and equal to `shadowContrastRatioAtDeepest` itself**; `offNoShadowSpread` likewise `0` against the banked `0.0182`. Recorded, not explained |

**What this settles.** **Neither of `R-2026-09-13-1`'s two red triggers fired on the ruling's own
tree.** By the close-out plan's own mechanical reading —
[`C12_CLOSEOUT_PLAN_2026-09-19.md`](C12_CLOSEOUT_PLAN_2026-09-19.md) §6, *"Green: trigger 1 false
**and** trigger 2 absent"* — that is the ruling's **GREEN** arm, *"S3 continues"*. **Option C of
`R-2026-08-10-1` has NOT fired**, so none of option (b) above has been taken: C12 is **not**
closed, C14 is **not** unblocked, and the `R4` aurora hold is untouched by this (`C15-01`/`C15-02`
and `C15-05`/`C15-06` stay released by `R-2026-09-17-9` and `R-2026-09-18-1`, neither of which
this append touches).

**What it does not settle — and the run is GATE FAIL, exit 1.** It fails on `deckPureRatioInBand`,
a predicate this ruling names in neither trigger, over the band's upper edge by **0.0008**; and
`refreshCostMeasured` — one of `R-2026-08-14-1`'s two restored exit conditions — is still
**unscored**, blinded by the same readback-drain structural reason the banked run carried verbatim
(the close-out plan's row `S3-N2-REFRESHCOST`). The green arm continues S3; it does not discharge
it. **Why either figure moved between the two trees has not been measured by anyone, and this
append deliberately does not explain it.**

**The request itself.** `RR-2026-09-13-E` asked for a re-decision between (a) continue S3 and (b)
Option C. The measurement points at (a) on the ruling's own mechanics. **Whether to exercise Option
C anyway is the maintainer's decision, and no lane makes it** — see the dated annotation on
`R-2026-09-19-2` in [`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md), which
records that the basis that ruling was adopted on was found false before it was executed.

Receipt for the re-run: `Tools/visual-regression/output/eclipse-cloud-response-2026-09-19/`
(`README.txt`, `preflight.txt`, `comparison-banked-vs-fresh.txt`, `facts-extract.txt`,
`probe-output/eclipse-cloud-response-report.json`), gitignored, in the seat tree.

Authority is charter §1.1. This append records two measurements; it changes no row's status, widens
no band, and closes nothing.
