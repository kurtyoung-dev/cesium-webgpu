# CAMPAIGN_STATE — the campaign-status authority

**Authority as of 2026-09-02; supersedes the CLAUDE.md campaign section.** Ruled by
`R-2026-09-02-14` (`MAINTAINER_RULINGS_2026-09-02.md`): CLAUDE.md's "Active Remediation
Campaign" block reduces to a pointer at this file, and this tracked document — not the
gitignored one — is the **sole campaign-status authority** from here on (§1 below). This file
keeps its other original role too: `CLAUDE.md` is gitignored with no git history
(`.gitignore:6`), so its GitHub-quiet-hours and branch-transparency HARD rules are mirrored here
as they were by the 2026-08-09 handover audit (`HANDOVER_AUDIT_2026-08-09.md` FIX 1) — those two
rules are unaffected by this wave's ruling and stay in §2/§3, now fully restated (not merely
mirrored) in [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) §3 as well; on any
disagreement between the two, the fuller, more recently touched copy wins and the other is
stale.

**Precedence for §1, stated once because every block below relies on it:** a campaign's own
queue document (`QUEUE_*_CAMPAIGN*.md`) is the **row-level** authority — task status,
acceptance, dependencies. This file is the **campaign-level** authority — launched-or-not,
critical path, holds, governing ruling. Dispatch/priority boards
([`CAMPAIGN_PORTFOLIO_QUEUE.md`](CAMPAIGN_PORTFOLIO_QUEUE.md),
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md)) are sequencing
views only, refreshed on their own cadence and known to drift (see the corrections appendix). On
any conflict: queue row wins over this file, this file wins over a dispatch board. Above all of
them: a maintainer ruling in `MAINTAINER_RULINGS_*.md` outranks this file on a live dispute
(`DEFERRED_WORK.md:8872` — "the precedence is: maintainer rulings, then queue rows, then
CLAUDE.md/`CAMPAIGN_STATE.md`, then this file").

**Portfolio shape:** eight reserved campaign identities, C11–C18, one of which (C15) contains two
independently governed lanes (Aurora, GSPLAT). C14 and C15-Aurora are held; C17 is proposed and
unlaunched; the rest are executing or closing out (`CAMPAIGN_PORTFOLIO_QUEUE.md` §0).
[`CLOSEOUT_PLAN_2026-08-07.md`](CLOSEOUT_PLAN_2026-08-07.md) is that grouping's superseded
predecessor — a 2026-08-07 snapshot, substantially executed, kept only for history; on any status
conflict `CAMPAIGN_PORTFOLIO_QUEUE.md` and the row-level queues win.

---

## 1. Campaign status

### C11 — Parity, correctness-reds, and scale architecture

**Launched.** Open; governed by its own recorded wave order (`QUEUE_2026-07-18_CAMPAIGN11.md`).
**Critical path:** the `C11-137` C8-upstream-contract certification gate, ratified as the
campaign's dead-last exit gate — the deterministic focused/unit lane is the close bar, the full
real-scene suite is a recorded follow-up, not a close-blocker (queue §"EXIT GATE — `C11-137`").
**Hold:** `C11-137` certification is HELD by maintainer ruling (2026-07-23) until the W2–W8 body
executes. `C11-180` (WebGL async shader lifecycle) is PARTIAL — core + bounded fog-companion
scheduling landed, broader structural first-use variants remain (queue row `C11-180`). `C11-181`
(globe shader variant eviction/reference correctness) is **COMPLETE** — administrative close
2026-08-09, close authority `DEFERRED_WORK.md`, landed Batch 1063 `21c9489185`, 2026-08-20 (queue
row `C11-181`, line 2123) — see the corrections appendix; the prior CLAUDE.md text called this row
open and was wrong. The C11-163 CELESTIAL-WATER-REFLECTION epic is ARMED (`R-2026-08-28-10`), its
4 sub-decisions resolved (`R-2026-08-28-11`); slice 1 landed Batch 1271 (2026-08-29); slices 2/3
(star splat, S5a shadow map) remain open. Cloud/weather rows live in Campaign 13;
`C11-79/80/115-impl/160/161/175/176a/b/c` transferred to Campaign 12, IDs retained as aliases.

### C12 — Celestial appearance

**Launched** 2026-07-23 (`QUEUE_2026-07-19_CAMPAIGN12.md`). **Exit gate is MAXIMAL**
(`R-2026-08-10-1`): C12 stays open until every `C12-29` slice lands, including S3. **Critical
path:** `C12-29` S3 (canonically owned by `C13-41`, C13's queue) plus S5's final seven-lane
certification matrix. S3 was recorded COMPLETE/EDGE-VERIFIED 2026-08-12, then **VACATED** —
`R-2026-08-14-1` restored its `shadowContrastInvariant`/`refreshCostMeasured` gates and
`R-2026-08-17-7` flipped its machine-readable state `closed` → `reopened` (queue row `C12-29`,
"S3 CLOSURE VACATED"). **Latest ruling** `R-2026-09-02-5`: fund the S3 exit-condition-2
exposure-sweep discriminator first (Sonnet instrument + Opus review, then Edge); Option C of
`R-2026-08-10-1` (re-file S3/S4 as C13 rows, close C12, unblock C14, release the R4 aurora hold)
is the fallback if that sweep stays red. S4 is COMPLETE/EDGE VERIFIED (2026-08-12). `C12-33`
(Moon mip/LOD) is certified (20 Edge runs, 2026-08-24) with two residual maintainer debts (a
banking-schema gap, an unsigned countersign) — not machine work. **G1** (skybox fade) stays RED
at close by ruling, carried to proposed-C17 as `CLT-D10` (`R-2026-08-21-14`). **G3** (star-asset
upgrade): `R-2026-09-02-7` answers the queue's open `Q-77` — chroma/dust criteria are unreachable
by any bundled variant, so G3's red is by construction; the 4096-px skybox tier ships as an
opt-in externally-fetched asset via the resolution-policy seam, gated on a licence determination,
not installed as a bundled asset. Gates M-06..M-10 close under that ruling.

### C13 — Planetary volumetric clouds, RTE, weather realism

**Launched / executing** since 2026-07-23 (`QUEUE_2026-07-23_CAMPAIGN13.md`); Gate B (planetary
correctness) CLOSED 2026-08-07 (Batch 866); Gates A, C, D open (`DEFERRED_WORK.md`
"RULING-2026-08-06", ruling R2).

**v2.1 plan ratified 2026-09-12** — see
[`CAMPAIGN_13_V2_CLOUD_QUALITY_2026-09-12.md`](CAMPAIGN_13_V2_CLOUD_QUALITY_2026-09-12.md); **twenty
decisions all ruled** (`R-2026-09-12-1`…`-12` plus eight defaults); **seven waves**, ≈92 rows.

**Critical path, corrected:** `C13-41` (C12-29 S3's canonical owner), reopened by `R-2026-08-14-1` —
its restored exit condition is the SOL-4 banked refresh cost plus the 1.0496
`shadowContrastInvariant` mechanism (queue row `C13-41`) — **and now first in the Edge queue**
under `R-2026-09-12-7`: the exposure-sweep discriminator (`R-2026-09-02-5`) takes the single Edge
slot after the P0-2 gate and **all cloud work is pure-Node until it returns**. Still C14's
transitive blocker (see C14 below). **The discriminator has returned once already** (added
2026-09-13): it ran as Éowyn job 2 leg 7 on **2026-09-03** at tree `fbea2028cc` and came back
**exit 1, GATE FAIL** — the CO-22 sweep was measured and **its direction matched while its level did
not** (measured above 1 at every exposure, the residue model below 1), `shadowContrastInvariant`
read 1.0341 against the band [0.97, 1.03], the deck-free control lane was BLIND (9 predicates
unscored) and `refreshCostMeasured` was FALSE. **A re-run on `ea651de6d8` is in flight** (executor
Bandobras, job 13c leg (e), banking to
`Tools/visual-regression/output/eclipse-cloud-response-2026-09-13/`), and **the maintainer's
re-decision under `R-2026-09-02-5` is OWED** — requested as `RR-2026-09-13-E`. Numbers and bank
paths: the `C13-41` row's execution stamp in
[`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md).
<!-- corrected 2026-09-16, R-2026-09-12-10 -->
*[corrected 2026-09-16, record round 5. The sentence above reads "**A re-run on `ea651de6d8` is in
flight** (executor Bandobras, job 13c leg (e), …)". **That re-run never happened.** Job 13c stopped
mid-leg (b) at the 2026-09-13 16:05 EDT wind-down; legs (c), (b3) and (e) were never run
(`STOP_CHECKPOINT_2026-09-13.md` §5). The maintainer has since ruled the re-decision **conditional on
that re-run** — `R-2026-09-13-1` — so neither arm of the conditional has fired and `RR-2026-09-13-E`
is still open. The `C13-41` row and the whole conditional are unchanged in substance; only the
"in flight" claim is retired.]*

**Wave A (2026-09-11):** D1 (Batch 1466), C1 (Batch 1467), C2 (Batch 1468), and C3 (Batch 1471)
LANDED — **unchanged**.

**`C13-42a` LANDED 2026-09-12** (lane Minardil / reviewer Calimehtar / verifier HOLDS; patch
`4b5e96d3f1c322cd62ea2e78b92a2f06`, 15 files) as a staged **opt-in** adoption — a probe declares
`workBudgetMs` to get the lifecycle, and the **18** that declare none keep their pre-adoption
behaviour (`C13-42a-2` migrates them). The two cap sites are wired and `MAX_SERVED_RESPONSES`
is retired; the Edge job's leg 1 is now blocked on the **`C13-41` slot**, not on `C13-42a`.
`CHARACTERIZATION_THRESHOLDS` is **still null** until calibration captures run, so a first complete run
is CALIBRATION, not acceptance.

**Follow-ups and their order:** `C13-42a-3` **item 8 before** `C13-42a-2` (seat sequencing,
2026-09-12). *[corrected 2026-09-13: item 8 is no longer pending — it **CLOSED 2026-09-12 in Batch
1478** (`e69d3e4fc7`, lane L1 / Durin), so `C13-42a-2` and `C13-N01` stage 2 are unblocked. The
other seven `C13-42a-3` residuals remain OPEN. Ledger:
`DEFERRED_WORK.md:178-181`, `### NEW-C13-42A-RESIDUALS (C13-42a-3)`.]*

**Wave 1 of C13 v2 — the four Node-only lanes LANDED, 2026-09-12** (added 2026-09-13; this file was
last amended at Batch 1476 and did not carry them). Batch numbers, hashes and times are the git
commit dates:

| Batch | Hash | Committed (EDT) | Lane | Rows |
| --- | --- | --- | --- | --- |
| **1478** | `e69d3e4fc7` | 2026-09-12 14:09:11 | **L1** Durin | `C13-N08a`, `C13-42b`, `C13-42a-3` item 8 |
| **1479** | `beb08423b3` | 2026-09-12 15:08:27 | **L2** Telchar | `C13-N01` stage 1, `C13-N02`, the fleet-contract remediation |
| **1480** | `39283ec388` | 2026-09-12 15:16:28 | **L6** Yavanna | `C13-N09`, `C13-N04`, `C13-N03`, `C13-N04b` in part, `C13-N07a` held |
| **1481** | `9f3723b0b3` | 2026-09-12 15:30:28 | **L8** Eönwë | `C13-N32`, `C13-N36`, `C13-N46`, `C13-N34`, `C13-N48` |

**Still in flight, Node-only, frozen and reviewed but NOT landed:** **L3** (Ulmo — `C13-N10`,
`C13-N11` uniform plumbing, `C13-N20` predicate), **L4** (Manwë — `C13-N11` WGSL half, `C13-N20`,
`C13-N21`) and **L5** (Ossë — `C13-N22`). Each owes its named Edge leg **before** landing under
`R-2026-09-12-4`, and the landing order is HARD: **L3 → L4** (L4's WGSL reads uniform slots L3's
packer writes) and L5 after L3. **L7** (`C13-N06` pass 1) has not been dispatched: it *is* a
measurement, so it waits for the slot outright.

**L5 (Ossë) — `C13-N22`, the 1440 × 721 weather field — lands in the batch that carries this line (2026-09-19), completing the three frozen Wave-1 engine lanes after L3 (Batch 1493) and L4 (Batch 1504).** It lands as lane Moro's re-expression onto the tip (`osse-on-tip.patch` v3, whose engine and spec files are byte-identical to the reviewed v2, md5 `3910bf3b636ba386f3f189e5d352ff66`; the delta against the device-tested freeze `ba7a1c86aa94f72454ee158e0af0a179` is comment-only, proven twice independently, with the renderer byte-identical). **Edge leg 4 ran 2026-09-18** (executor Ferumbras; receipt `Tools/visual-regression/output/wave-end/c13v2-wave1-engine-legs-2026-09-18/L5/`) and is adjudicated **STRUCTURAL / LAND-WITH-LEDGER-NOTES** (Marmadoc; adversarial verifier Marmadas HOLDS), under the standard L4's legs set on 2026-09-17: the field is proven live on device and image-effective (43.18 % of cloud pixels change against a control byte-identical to BEFORE; no new antimeridian or polar artifact), and the recipe's spectral discriminator returned a **NULL** whose cause — the orbital march's ring aliasing, `C13-N13` — is another open row's. **`C13-N22` therefore lands with its image-side acceptance explicitly OPEN and UNDISCHARGED** (its other named instrument, `C13-N05` IoU, does not exist — W2), re-homed as a **LOOK** under `R-2026-09-17-10` behind `C13-N13` — a contact sheet at the recipe's camera with a real EDR provider, no verdict and no threshold, and **no further Edge leg owed for the spectral statistic** (maintainer decision 2026-09-18, to be recorded as `R-2026-09-18-4`). **`C13-N13` is PROMOTED ahead of the remaining W2/W3 rows as the next cloud engine row** (maintainer decision 2026-09-18, to be recorded as `R-2026-09-18-3`). `PERF-C13-N22-WIDENED-WEATHER-RESOURCE-UNMEASURED` and `DX-REMOVEALL-DESTROYS-LAYERS-WHILE-TILES-STILL-HOLD-THEM` are filed alongside; the performance measurement is **required before `C13-N23`**, which carries it as an added dependency (maintainer decision 2026-09-18, to be recorded as `R-2026-09-18-5`). **Edge leg 1 and the wave-end gate remain owed, so Wave 1 does NOT close on this landing.** *(The block above listing L3/L4/L5 as "in flight, frozen and NOT landed" is superseded: L3 landed at Batch 1493, L4 at Batch 1504, L5 here.)*

**Edge leg 1 is OWED** and is the wave's first browser debt: the two cloud scenes' WebGPU baselines
from `Tools/visual-regression/scenes-cloud-pending.json` (tracked in Batch 1480, deliberately not
in `scenes.json`), `C13-N04b`'s first ladder run, one run of each of the four probes lane L2
repaired so their new watchdog bounds are calibrated rather than read off source, and the
`test-cloud-c13` mask-order rerun after a build (`C13-N58`).

**Wave-1 exit stays the manual three-step** permitted by `R-2026-09-02-3`: Batch 1481 made
`Tools/wave-end-gate.mjs` able to *reach* a receipt, but the first real receipt needs the browser
and is owed, so `C13-N48` is DONE-pending-first-receipt and no wave closes on the runner yet.

**Solo-row classification, Batch 1482** (`77789c120b`, 2026-09-13 12:53:15 EDT) — the companion
[`CAMPAIGN_13_V2_SOLO_ROWS_2026-09-12.md`](CAMPAIGN_13_V2_SOLO_ROWS_2026-09-12.md) and the handoff
page [`SOLO_WORKER_HANDOFF_2026-09-13.md`](SOLO_WORKER_HANDOFF_2026-09-13.md) classify every C13 v2
row for solo dispatch (**11 SOLO-NOW, 3 SOLO-AFTER-TEMPLATE** — one of which, `DX-84`, is already
specified in full, giving **12 dispatchable rows** — and **110 NOT-SOLO**) under seat rulings
`R-HANDOFF-1`…`-11`. **Classification only:** it launches nothing, rules nothing and changes no
row's disposition; the row-level authority stays the campaign queue.
<!-- corrected 2026-09-16, R-2026-09-12-10 -->
*[corrected 2026-09-16, record round 5. The counts in the paragraph above — "**11 SOLO-NOW, 3
SOLO-AFTER-TEMPLATE** … giving **12 dispatchable rows** — and **110 NOT-SOLO**" under
"`R-HANDOFF-1`…`-11`" — were **superseded the same afternoon** by the roster re-cut of Batch 1487
under `R-2026-09-13-8`: **156** distinct rows, **19 ASTRA-SOLO**, **2 GEMINI-SOLO**, **135
NOT-SOLO** of which **111** wait on a seat act, under `R-HANDOFF-12`, which supersedes
`R-HANDOFF-3`, `-7` and `-10`. The "classification only" sentence still holds.]*

**Batches 1485–1487 landed 2026-09-13** (added 2026-09-16 by record round 5; times are the git
commit dates). All three are Node-only and none is an engine landing:

| Batch | Hash | Committed (EDT) | Lane | What |
| --- | --- | --- | --- | --- |
| **1485** | `b466e7ca80` | 2026-09-13 15:41:45 | Curumo (reviewer Baran) | `C13-42f` Node half — the C13-42 god-ray metrics become computable from a capture; Edge acceptance still OWED |
| **1486** | `0e4b898129` | 2026-09-13 16:04:28 | Huan (reviewer Bereg) | `C13-N01` **stage 2, family batch 1** — the first eight cloud probes routed through the probe runtime; equivalence leg OWED |
| **1487** | `c325f858c3` | 2026-09-13 17:19:36 | Everard (critic Estella, reviewer Fastolph) | the **solo-roster re-cut** under `R-2026-09-13-8` |

**The 2026-09-16 audit and the direction it produced.** `ASTRA_WORK_AUDIT_2026-09-16.md` — landing
as a tracked `migration_doc/` document in Batch 1492 (2026-09-16), with its own README index
row — (synthesiser Hildigrim, from nine independent read-only audits, base `c325f858c3`) measured the
solo programme's output: **17 assigned-row packets across three clones** (Aldarion 8, Anarion 3,
Arien 6) plus four measurement/record units, and separately a **43-unit cumulative volumetric-cloud
preview** in a fourth clone. Its verdicts: **16 of the 17 packets land**, all Node-only and
tools-class, with **17/17 freeze md5s matching line 1 of their FREEZE file**; **`C13-N07a`'s partial
does not** and returns to a BLOCKED row (`R-2026-09-16-12`); and **the cloud stack is not landable
in any slice** — its head unit is RETURN by its own author, the dependency graph is one linear
chain, and 12 of the 43 units carry a RETURN. The stack's engineering is largely sound (RTE clean;
`ShaderDefine`/`ShaderDefineHi`/`ShaderSourceId` untouched; no TypeScript `any`; no
`Scene → Renderer/WebGPU` import; `tsc --noEmit` 0 errors over 2,258 files); **the deficits are in
the guards and the record**, and three of them need a seat act rather than a rework — 22 of Astra's
76 dirty paths are held by the three frozen lanes, `package.json:207`/`:209` were appended in-tree,
and the C16 cleanlist ratchet goes **18 REGRESSED / 6 files → 60 / 13** against a `main` that is
**already red** on that gate and on six `new-cap` eslint errors.

**The ruled direction is `R-2026-09-16-1`, Option A: the three frozen lanes land first, then Astra's
cloud stack rebases onto the result in a fresh clone.** Measured both ways: the three lane patches
stack on seat HEAD with **4 failed hunks, all `package.json` + `QUEUE`** — both already the seat's
union step — against **29 of 111 hunks rejecting** in the other direction; **16 of 26** union paths
resolve to "keep Astra's file"; and **six of the lanes' own acceptance specs are red inside Astra's
tree**. Eleven consequences of that direction were ruled in the same sitting
([`MAINTAINER_RULINGS_2026-09-16.md`](MAINTAINER_RULINGS_2026-09-16.md), `R-2026-09-16-2`…`-12`),
including one prerequisite that must land **before** Manwë's leg 3b runs (`R-2026-09-16-4`).

**Edge legs, under `R-2026-09-13-6` (engine legs first, amending `R-2026-09-12-7`'s tail):** **L3
Ulmo's Edge leg 2 started 2026-09-16 and is IN PROGRESS** — no receipt exists under
`Tools/visual-regression/output/wave-end/` at the time this was written, so no result is claimed
here. L4 Manwë's legs 3a/3b/3c and L5 Ossë's leg 4 follow, then L6's leg 1 captures its baselines on
the landed engine. **Edge leg 1 remains owed** (paragraph above), and two further browser debts were
added by the 2026-09-13 landings: `C13-42f`'s acceptance and `C13-N01` stage 2's equivalence leg.

**P0-2 is still OPEN.** Job 13c stopped mid-leg (b) on 2026-09-13: leg (a) variant smoke GREEN, the
`sample-height-from-3d-tiles` spot-check at settle 25000 **WebGPU 3/3 PASS and WebGL 3/3 PASS on the
fixed tree** — the P0-2 red is cleared on that tree — but the Sandcastle2 sweep's `webgl-h2` segment
was killed at ~241/686 and legs (c), (b3) and (e) never ran
(`STOP_CHECKPOINT_2026-09-13.md` §5; receipts under
`Tools/visual-regression/output/wave-end/wave-p0-2-2026-09-13/`). Because the close is a three-part
act (`R-2026-09-13-4`), the local branch `backup-inwindow-1405-1429-20260905` and the served sync
clone `cesium-lane-sync-1145-20260904` @ `5be896fe3a` both still stand.

**The solo programme's status as of 2026-09-16:** Astra's 16 landable packets land tonight under
`R-2026-09-16-10`; **the cloud stack is held for the rebase** behind the three lanes; and Gemini's
audit doc is held behind nine corrections (`R-2026-09-16-11`), with its `_lane-out/` archived to
`cesium-webgpu-worker-archive/lanes-2026-09-16/` rather than tracked.

**`AR-D13` answered** as full WebGL parity (`R-2026-09-12-8`); the WebGL workstream is
`C13-N15a`–`C13-N15d` (Wave 4) and WS-C2 (Wave 7).

**Authorship unchanged** — `R-2026-08-24-3` narrows without replacing the 2026-07-24 Option-B ruling:
Codex Sol may build bounded C13 instrument/harness work under an Opus lead with separate Opus review;
engine-semantic changes stay Opus-authored.

### C14 — Dynamic ocean & wind

**Not launched.** Ratified identity, ratified plan (`OCEAN_DYNAMICS_PLAN_2026-07-24.md`).
**Hold:** `R1` (`DEFERRED_WORK.md` "RULING-2026-08-06") binds the O5 "done" bar pragmatically to
C12 complete + C13 Gate B green; Gate B closed at Batch 866, so the sole remaining bar is **C12
completion** — which is transitively `C13-41` (see C12/C13 above). C11-137 certification and the
rest of C11/C13 do **not** gate C14 (`R2`).

### C15 — Aurora + Space Weather (two independently governed lanes)

**Aurora (`C15-01..08`): planned, research-verified, implementation not started.** `C15-00` is
complete (R4 endpoint spot-check executed 2026-08-06, queue §2a). `C15-01..08` are **HELD** by
`R4` until C12 closes; the queue document is explicitly not a launch ruling for these rows
(`QUEUE_2026-08-02_CAMPAIGN15.md` status block).

**Amended 2026-09-17 (`R-2026-09-17-9`, [`MAINTAINER_RULINGS_2026-09-17.md`](MAINTAINER_RULINGS_2026-09-17.md)):**
**`C15-01` and `C15-02` are RELEASED from the R4 hold and dispatchable as pure-Node lanes**, pending
dispatch. The ruling is a **named narrow override for those two rows** and says plainly that R4 condition
- C12 closure - is **NOT** met: C12 exit gate stays MAXIMAL (`R-2026-08-10-1`), its critical path is still
`C12-29` S3 via `C13-41`, and `R-2026-09-13-1` neither arm has fired because job 13c leg (e) never ran
(`RR-2026-09-13-E` open, `DEFERRED_WORK.md:2464`). It is **not** an exercise of Option C and pre-empts
neither arm. `C15-03`..`C15-08`, `C15-06P` and `C15-07H` stay HELD and come off by a later one-line ruling
once the contact sheet exists (`DX-105`). Sequencing onto the probe kit, and the `DX-101`..`DX-108` rows it
depends on: [`PROBE_KIT_PLAN_2026-09-17.md`](PROBE_KIT_PLAN_2026-09-17.md) section 5 and
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md) section 6a.1
(`R-2026-09-17-12`).

**2026-09-18 — `C15-01` is dispatched, frozen and reviewed under that release.** Lane Stoor built the
backend-neutral state packet and deterministic manual driver at
`packages/engine/Source/Scene/SpaceWeather/` on `1a2baeaa4a`: 18 Node tests homed in
`test-visual-regression-node`, a karma twin owed to the wave's Edge job, eleven mutants each RED.
Station 3 (Harfoot) returned **LAND-WITH-FIXES** the same day and the lane re-froze as v2 with all of
them applied — enum key widening removed, a step-hold test added that turns the reviewer's two
ordering mutants RED, and the geomagnetic-frame epoch made a validation requirement. Awaiting landing.
`C15-02` (lane Bucca) runs concurrently against the interface `C15-01` published.

**GSPLAT (`C15-G0..G8`, §6, ruling R6, 2026-08-06): ACTIVE, not under the R4 hold.** `G0` scoping
COMPLETE (Batch 863); `G1`–`G5` LANDED (Batches 868–895: harness → scene-logic extraction → first
real WebGPU splat pixels → WASM radix sort → spherical harmonics); `G6` PARTIAL (mechanism fixed
Batch 888/889, the row's own written multi-frustum exit gate has not executed); `G7` **ran for the
first time 2026-09-02** (Éowyn, first Edge job of the wave, `R-2026-09-02-1`/`-25`) —
STRUCTURAL/exit 3, two WebGPU reds filed as follow-on rows `C15-G7a`/`C15-G7b` (queue row
`C15-G7`); `G8` (terminal parity gate) PENDING, blocked on `G6`+`G7` closing. `G9` (tower
frame-variance mechanism) is **CLOSED as NOT REPRODUCED** (`R-2026-08-24-5`) — its harness stays
armed and unblocks G8's tower leg.

**Aurora row `C15-02` IMPLEMENTED 2026-09-18 (lane Bucca) — frozen for review, not
landed.** `R-2026-09-17-9` released `C15-01` and `C15-02` from the `R4` hold as a narrow
override; the remaining aurora rows `C15-03..08` stay held. `C15-02` delivers the
centred-dipole geomagnetic frame and the synthetic activity-dependent oval as pure CPU
Scene modules under `packages/engine/Source/Scene/SpaceWeather/`, with the row's four exit
discriminations asserted on output numbers and four inertness mutants red. The karma leg is
owed to the wave's Edge validation job; nothing renders an aurora until `C15-03`/`C15-04`.
Detail lives in the row and in `DEFERRED_WORK.md` under `EPIC-AURORA-SPACE-WEATHER`.

**2026-09-19 — `C15-05` and `C15-06` are RELEASED from the `R4` hold by `R-2026-09-18-1`**
([`MAINTAINER_RULINGS_2026-09-18.md`](MAINTAINER_RULINGS_2026-09-18.md)), a **second named narrow
override** of the same shape as `R-2026-09-17-9` and, like it, **not** an exercise of Option C and no
claim that `R4`'s condition is met. Both are **pure-Node** ingest lanes, started **after the CI fix
lands**, with their **fixtures re-captured first** — the queue's §2a schemas were measured
2026-08-06 against live feeds. **`C15-05` publishes its source-authority contract first; `C15-06` is
built against it.** Neither lane is dispatched. `C15-03`, `C15-04`, `C15-06P`, `C15-07`, `C15-07H`
and `C15-08` were left held by that ruling; `R-2026-09-19-5`
([`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md)) lifts the `R4` hold as part
of Option C, and the batch that executes Option C is what rewrites those six cells.

### C16 — Comment remediation & attribution

**Launched** by maintainer directive 2026-08-10 (`QUEUE_2026-08-10_CAMPAIGN16.md`). Audit
baseline: 6,450 violation blocks / 556 files (workflow `wf_c6df8ba5-f04`, HISTORICAL). Scope:
`packages/engine/Source`, `packages/widgets/Source` — comments become seamless with upstream (no
batch/campaign/tracker IDs; those live in commit messages and `migration_doc/**` only),
JSDoc-clean. **Shards `C16-09`..`C16-12` are all PARTIAL**, each with landed sub-shards and a
shrinking tail (queue ledger has per-shard detail). The three-way file hold on
`WebGPUPointCloudRenderer.ts`/`WebGPUBufferPointRenderer.ts` was released 2026-09-02
(`R-2026-09-02-4`); a same-day sub-shard took both to zero. **`C16-20`** (final gate) is PENDING
but certifiable in-repo from checked-in instruments (census=0, string-literal scan, build-docs,
this file's own update — see queue row `C16-20` for the full precondition list, which names a
CLAUDE.md/CAMPAIGN_STATE.md/README update as one of its own legs — this document discharges
that leg for C16-20). `C16-R1` (embedded-WGSL/string-literal blind spot) and `C16-R2` (`FORK-NN`
id class) are both ruled and landed.

### C17 — Celestial Light Transport (proposed)

**Not launched.** Holds the C17 identity by ruling (`R-2026-08-10-7`, "CLT epic renumbers to
proposed C17"); plan is `CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md`. Carries C12's G1
shell-extent question as `CLT-D10` (see C12 above). `CLT-B3` is a locally complete, authorized
bug-fix unit with landing + terminator-specific browser acceptance owed, tracked independently
of the full epic's launch state.

### C18 — Voxel, point cloud & splat modernization

**Launched** by maintainer directive 2026-08-09 (`QUEUE_2026-08-09_CAMPAIGN18.md`). Four waves:
**V** (verification honesty) — `V1` DONE, `V2` IN FLIGHT (browser closure open), `V3` PENDING.
**P** (point-cloud correctness) — `P1`/`P3`/`P4` PENDING, `P2`/`P5` IN FLIGHT. **A** (additive
adoption) — `A1..A6` PENDING, self-contained/dispatchable now. **S** (splat rows) — GATED
post-`C15-G8` (queue §4, ownership row); the sole exception is `C18-S0` (gsplat licence vetting),
DONE and ungated. C18 owns no C11/C15 row (`C11-13`, `C11-86`, `C11-100`, `C11-108`, the C11 W7
voxel cluster, and FORK-41 stay tracked where they are — queue §5).

### Wave DX — organisation, decomposition, tooling (not a numbered campaign)

Maintainer-directed wave inside
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md) (`DX-01`..
`DX-30`). Scope: probe-fleet runtime consolidation, decomposition of the eleven >1,000-line
WebGPU files, spec-home assignment, anti-re-accretion tooling, and this doc-truth sweep
(`DX-22`/`DX-23`/`DX-24`). Dispatch order (queue §"Dispatch order"): `DX-19` → `DX-20` → `DX-14`
→ `DX-01` → `DX-12` → `DX-13` → `DX-02` → `DX-06` → `DX-16..18` → `DX-07..09` → `DX-03/04` →
`DX-10` → `DX-21` → **`DX-22`, `DX-23`, `DX-24`** → `DX-27` → `DX-26` → `DX-25`. `DX-19`/`DX-20`
(branch and sibling-repo salvage) are DONE (Batches 1362/1363/1365) and are the current authority
for branch/worktree/sibling-repo state — see §3a below, which this wave's audit superseded.

**Added 2026-09-17 (`R-2026-09-17-12`):** section 6a.1 of the same queue carries `DX-101`..`DX-108` - the
probe kit (rig registry, image diff, metrics, capture seam, contact sheet, banking, fleet contract by
behaviour) and the fleet harvest-and-retire. No new file and no new campaign identity; the argument is
[`PROBE_KIT_PLAN_2026-09-17.md`](PROBE_KIT_PLAN_2026-09-17.md). Trigger: after waves 0-3 of the
Gemini-audit fix plan land. `R-2026-09-17-10` (visual acceptance) and `R-2026-09-17-11` (retirement:
archive first, delete later from a positive list) ungate `DX-105` and `DX-108`.

### Gemini-audit fix plan — waves 0-6 (not a numbered campaign)

**Launched 2026-09-17.** The verified result of the external (Gemini) codebase audit is
[`GEMINI_AUDIT_VERIFICATION_2026-09-17.md`](GEMINI_AUDIT_VERIFICATION_2026-09-17.md); its rulings are
[`MAINTAINER_RULINGS_2026-09-17.md`](MAINTAINER_RULINGS_2026-09-17.md) (`R-2026-09-17-1` … `-8`), and its
rows are the dated 2026-09-17 section of [`DEFERRED_WORK.md`](DEFERRED_WORK.md) — 3 P0, 24 P1 and 136 P2
as thirteen class tables. **Critical path:** W0 (both red CI gates, one lane) → W1 (this record) → W2 (the
five one-line engine lanes, unblocked by `R-2026-09-17-4`) → W3, of which only the previous-frame RTE lane
needs the Edge slot and therefore queues behind the L4/L5 cloud legs (`R-2026-09-17-5`); W5 (instrument
scope, `C16-21`) is the highest leverage per line and needs no slot. **Holds:** `D7` (DrawCommand parity),
`D10` (the AR-090 chunk stack) and `D4` (a targeted second pass over the coverage gaps) are open and are
prompted by the seat before their waves. **Standing constraint for any reader of the archived corpus:** the
do-not-execute list in the rulings file binds, and the corpus itself is untracked and is not a premise.

**CI state, added 2026-09-18 (lane CI-INSTALL, Marroc).** W0's own root `package.json` `overrides`
pin made `npm install` refuse to run (`EOVERRIDE`), so **every job of `dev`, `deploy` and
`sandcastle-dev` has failed at its first step on every push from Batch 1498 to Batch 1512** and the
three gates W0 reported green have not been machine-confirmed since. The manifest fix and a guard on
the rule ship as their own batch; the first green install will surface whatever was already red at
Batch 1497, which is signal this plan has been missing rather than a new regression.

### Research dispatch queue — design-model perf, Earth-at-Night, meshlets

[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md) is a **dispatch
order, not a status authority** (its own §"Authority"). The live status authority for every `Q-`
id is [`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`](FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md); the
campaign rows named above stay owned by their own queues. The meshlet/mesh-shading track
(`MS-00..26`) is **HELD** by ratified gate M6 until `C11-168`'s dense-tileset lane is satisfied —
not yet, per `QUEUE_2026-07-18_CAMPAIGN11.md` row `C11-168` ("W1 — PARTIAL / VALID CAUSAL
DEFICIT, ROOT CAUSE OPEN") — and its campaign placement (a Phase-8b wave vs. new Campaign 19 vs.
a C18 wave) awaits maintainer gate **M-16**; nothing about it is launched. Wave 1 of this queue (17 ruling-free/measurement-first rows) is mid-execution; its closure is the manual three-step permitted by `R-2026-09-02-3`. **That three-step ran 2026-09-03/04 (Éowyn, job 2 item 10, banked at `Tools/visual-regression/output/wave-end/2026-09-02/`) and NO STEP WAS GREEN, so the wave is NOT CLOSED under `R-2026-08-29-2`:** (a) variant smoke exit 1 — all three variant bundles absent from the served clone, nothing loaded; (b) the Sandcastle2 sweep exit 1 on both renderers — **0 of 338 certified either side**, because the ungenerated editor typings (`/packages/engine/index.d.ts`, `/packages/widgets/index.d.ts`) 404 on the app origin and the console-error gate fails every demo on that one 404; (c) capture-and-diff exit 1, summary FAIL (3 PASS / 1 FAIL / 6 NON_CERTIFYING), **though its cross-backend parity leg passed 10/10 at max 1.52 %** with `promotionPerformed: false`. The gate re-runs on a tree built with `npx gulp buildAllVariants` **and** the TypeScript-definitions step; until it does, the wave stays open. Two real WebGPU faults surfaced under step (b) and are filed as their own rows (`elevation-band-material`, `frustum-dev`); the baseline incompleteness under step (c) is filed separately. **No row's status is changed by this note.**

**Wave-end gate — batches 1379–1404 (2026-09-04, Éowyn job 3).** Under the same rule
(`R-2026-08-29-2`), distinct from the DX Wave-1 gate above: the wave that closed with Batch 1404
(1379–1404) had its wave-end gate run 2026-09-04 (Éowyn, standing Edge executor, `R-2026-09-02-1`,
job 3), on the pre-merge tree `e7360fa234` (Batch 1407), served-tree preflight PASS (disk md5
matches :8080/:8081/:8082/:8094 before and after every leg). Evidence directory:
`Tools/visual-regression/output/wave-end/2026-09-04/` (`SUMMARY.md` + one `README.txt` per leg).
Per step: **(a) variant smoke — GREEN** — `node Tools/variant-smoke-test.mjs` exit 0; dual /
webgl-only / webgpu-only all PASS, 0 console errors each, a rendered frame each. **(b) Sandcastle2
sweep, both renderers — RED (engine)** — both exit 1; **WebGL 332/338 certified** (6 failed: 4
`rendererGate` + 2 external-CORS-only); **WebGPU 323/338 certified** (15 failed: 3 GPU
validation errors — `display-conditions-dev`, `elevation-band-material`, `frustum-dev` — + 11
`rendererGate` + 1 external-CORS-only); the 12 unique `rendererGate` ids are **not yet classified**
harness-vs-engine — `AR-888` owns that measurement, and Éowyn's own leg verdict of "RED (engine)"
above is recorded as the executor's, not ratified here. Zero typings-404s on either renderer (the
2026-09-03 served-tree blocker is resolved). **(c) capture-and-diff — RED (baseline provenance,
not a rendering regression)** — exit 1, summary NON_CERTIFYING (scenes PASS 4 / FAIL 0 /
NON_CERTIFYING 6); **cross-backend parity itself is 10/10 PASS at max 1.484 %**, WebGPU error gate
clean, and the `globe-default` uniform darkening this same gate reported at 91.32 % / 91.22 % on
the job-2 run above is **gone** on this tree (PASS at 0.055 % / 0.011 %, meanLum 101.801/101.736
vs baseline 101.811/101.738); no baseline was refreshed (`promotion.performed=false`). **Per the
ruling's own terms — the wave closes only if all three steps are GREEN — this wave does NOT
close: (a) is green, (b) and (c) are not.** No row's status is changed by this note.

**Architecture-review dispatch view (2026-09-03).**
[`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`](QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md) is the dispatch
view for the architecture review — the rows produced from
[`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) after the 2026-09-03 lens
re-run (its §3 survey blocks, §4 reversals, unowned §3 items, landscape gaps G1–G8, maintainer
decisions, Éowyn measurement rows). **Status authority unchanged:** the campaign queues,
`DEFERRED_WORK.md` and `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` keep every id they own; the new
queue launches, rules, schedules and funds nothing, and its `AR-` ids are add-only.

**Wave P0-1 (Batches 1415–1428): COMPLETE.** All five dispatched rows — `AR-002`, `AR-751`,
`AR-831`/`AR-833`, `AR-832`/`AR-834`, `AR-009` — met their Edge acceptance across Éowyn jobs 6–8
(`Tools/visual-regression/output/wave-p0-1-edge-2026-09-05/`, `-job7/`, `-job8/`); `AR-751` and
`AR-831`/`AR-833` needed a round-2 engine fix and `AR-009` needed two probe-only fix rounds before
their own Edge legs measured green. Row-level detail (root causes, batch numbers, measured numbers)
lives in `QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`'s own rows, not restated here.

**Wave P0-2 (Batches 1438–1442, catalog 1443): LANDED and PUSHED, 2026-09-05.** Five lanes under
tier-2 lead Haldan, each carrying `VERDICT: LAND` from its own Opus reviewer — `AR-757` (Aerin /
Bregolas, 1438), `AR-754` and `AR-001`'s non-polyline half (Uldor / Guilin, 1439), `AR-752` and its
newly minted measurement `AR-M38` (Ulfang / Edrahil, 1440), `AR-714`/`AR-715`/`AR-716` (Rian /
Belegund, 1441), `AR-890` with `AR-887` held (Huor / Hareth, 1442). **The Edge legs are OWED as
Éowyn job 9** — five probes, one job — so no row in this wave is fully accepted yet; `AR-887`'s hold
turns on leg 1, which has never been run at all. Two maintainer rulings, 2026-09-05: **R1** —
`AR-001`'s non-polyline half lands now, acceptance pending `AR-M01`, and `AR-837`'s "before `AR-001`
lands" clause is satisfied by taking the matrix's BEFORE leg on the pre-batch tree `08cb6fd4b2` and
its AFTER leg on the tip; **R2** — `AR-D09` DECIDED: implement `Polyline.disableDepthTestDistance`
on WebGL, minted as `AR-896`, with the 18 held WebGPU polyline sites landing after it as one batch.
Dispatched the same day: sync-parity wave **S1** (lead Hundar) and `AR-837` (lane Amdir, reviewer
Earwen). Row-level detail lives in `QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`'s own rows, not here;
the wave's process findings are `DX-61`–`DX-64` plus extensions to `DX-58` and doc-audit `G-31`.
Wave P0-2 engine rows are all MET (Éowyn job 12, 2026-09-10). The wave-end gate (Éowyn job 13,
`R-2026-08-29-2`) is INCOMPLETE: preflight PASS on `6483bc70bb`, variant smoke GREEN, Sandcastle2
leg NOT RUN (segment 1 reached 306/343 at settle 25000 with one external-CORS failure before the seat
stopped it for the machine restart; capture-and-diff and the settle control not started) — job 13b
owed. *[updated 2026-09-13: **job 13b RAN** 2026-09-11 22:13 → 2026-09-12 12:10 EDT on the Batch
1472 tree `5be896fe3a` and **STOPPED ON A RED**. Evidence:
`Tools/visual-regression/output/wave-end/wave-p0-2-2026-09-11/` (`README.md` +
`BISECT_sample-height.md`, gitignored, seat tree). Preflight PASS (disk md5
`7879c86c208f7330980d4d9f24c08b95` reproduced on :8080/:8082/:8094; all four variant bundles
present; typings served 200; `verify-built-shader-identity` exit 0). **(a) variant smoke GREEN**
(exit 0, all three variants, 0 console errors each). **(b) Sandcastle2 sweep RED (engine)** at a
disclosed `SANDCASTLE_SETTLE_MS=25000` — so its counts are NOT comparable to the 2026-09-04
baseline's 8000 — **WebGL 343/343 attempted with 4 failures** (3 external-CORS, 1 engine:
`webgpu-async-resource-monitor`, the one id `AR-888` had already classified NOT-harness);
**WebGPU 271/343 attempted, 4 failures all external-network, ZERO GPU-validation errors**, with all
three 2026-09-04 WebGPU validation faults (`elevation-band-material`, `frustum-dev`,
`display-conditions-dev`) and all three 2026-09-04 WebGL `rendererGate` demos now certifying; 72
WebGPU demos unrun because the blocking defect is demo 100 of half 2. **(c) capture-and-diff and
(b3) the settle control NOT RUN**; no baseline was refreshed and `--update` was never passed.
**Blocking RED: `sample-height-from-3d-tiles`, WebGPU.** A bisect was attempted and **abandoned on
measurement** — the failure presented as probabilistic and the known-BAD tip itself passed 1 of 3,
so seven earlier verdicts are retracted and bisection cannot discriminate a rate at honest cost.
**Root cause then proven directly by an instrumented engine lane** (Oromë, resumed as Azaghâl): on
WebGPU the `*MostDetailed` height queries route through the offscreen ray render, whose `PickDepth`
never receives a depth texture, so `getDepth` returns `undefined` for every point and
`clampToHeightMostDetailed` writes `undefined` per upstream's contract until `Cartesian3.pack`
throws — i.e. **the demo never worked on WebGPU and the observed "rate" was harness timing**, which
also retires the 2026-09-04 both-renderers certification of that demo. A second serialization cause
was measured (WebGPU bakes the projection into `mvpRelativeToEye` before any frustum slice exists,
and the orthographic pick camera makes the RGBA8 `czm_packDepth` a 30.15 m quantum). **The fix LANDED and was PUSHED as Batch 1483**
(`ea651de6d8`, 2026-09-13 13:28:13 −0400, 20 paths) — leads Oromë (root cause, checkpointed
before the 2026-09-12 machine reset) and Azaghâl (the fix), tier-3 Castamir. Reviewer Rorimac
returned LAND-WITH-FIXES and the adversarial verifier **Fortinbras HOLDS**: **27 WebGPU runs on the fixed tree with zero failures** against the
known-broken control's 0/5 at the same settle, accuracy re-measured at **mean 0.0025 m / max
0.0056 m over 30 points** versus WebGL (from 2103 m mean before), served md5 asserted equal to disk
md5 on every leg. Evidence:
`Tools/visual-regression/output/sample-height-webgpu/verify-fortinbras/` (gitignored, seat tree)
and `VERIFY_FORTINBRAS.md` in the lane's `_lane-out/`. **That verification also produced a gate
finding that is not about this defect at all** and is filed as `DX-95`: at
`SANDCASTLE_SETTLE_MS=8000` the **known-broken control tree scored a vacuous PASS** on this demo,
because a per-demo PASS in the Sandcastle sweep is the absence of a console error rather than
positive evidence that the demo reached its certified state. Until that is repaired, a PASS taken
at a short settle is not evidence the demo works.]*

**Wave P0-2, continued — the fleet-contract guard earned its keep on this very batch** (added
2026-09-13): Batch 1483's **first landing
attempt was REFUSED at the seat's `probe-fleet-contract` C2 gate**, because the lane's new probe
shipped without a watchdog and without a `finally`-scoped close — the same contract lane L2
repaired in Batch 1479 after it had been red for nine days. It was fixed, re-frozen and landed.
A guard that is repaired rather than annotated stops the next instance; this is the first measured
instance of that, and it is the argument behind `RR-2026-09-13-B`.

**Wave P0-2 — order from here** (added 2026-09-13; the fix is landed, the legs are not): **Batch 1483 discharged the engine
defect**, and the remaining P0-2 close inputs are the wave-end gate's **WebGPU leg (job 13c,
executor Bandobras, running on a fresh built clone of `ea651de6d8`)** — the leg-(b) remainder
including the 72 previously-unrun demos and the czml transient-CDN re-run — plus legs **(c)**
capture-and-diff and **(b3)** the settle control on that same tree → **P0-2 closes** → and only then does `C13-41`'s exposure-sweep discriminator take the single Edge slot
under `R-2026-09-12-7`, with all cloud work staying pure-Node until it returns — which is why C13
Wave 1's L3/L4/L5 Edge legs and Edge leg 1 are queued behind it. **P0-2 stays OPEN.**

*[Corrected 2026-09-19 by `R-2026-09-19-14`
([`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md)). **The sequencing sentence
immediately above — "P0-2 closes → and only then does `C13-41`'s exposure-sweep discriminator take
the single Edge slot" — is STRUCK.** `C13-41`'s discriminator **takes the slot on its own merits;
P0-2's remaining legs do not stand in front of it**, and the ORDER clause of the discriminator's own
brief is struck with it — that brief is re-issued, not reused, when the job is dispatched. The
sentence was stale on both halves and was measurably so before this correction: C13 Wave 1's L3, L4
and L5 Edge legs all **ran ahead of the discriminator** on 2026-09-16, -17 and -18, and six Edge jobs
have taken the slot since 2026-09-16 **without P0-2 closing**. What survives above is the
description of what P0-2 still owes — legs (b)-remainder, (c) and (b3) — and that **P0-2 stays
OPEN**; what does not survive is the claim that anything queues behind it. The written ordering of
the contended slot is §2b of [`C12_CLOSEOUT_PLAN_2026-09-19.md`](C12_CLOSEOUT_PLAN_2026-09-19.md).]*

**Return and campaign state, 2026-09-10 (Batches 1449–1453 pushed).** The seat returned from pause
with Batches 1449–1453 landed and pushed to origin. Uncommitted seat work was relocated to
`F:/Dev/GH/cesium-astra-20260910` (seat worktree restored to clean Batch 1450, R3). Maintainer
rulings R-2026-09-10-1 through R-2026-09-10-8 established: D4 `previousViewProjection` tail rule
enforced universally (`AR-D12` DECIDED, `AR-067`/`AR-194` unblocked); D5 `RenderCommand` adoption
confirmed; Gemini 3.8 Flash High joins as tier-3 worker under `GEMINI.md` with Opus review and no git
writes (R4); governance updates adopted with the 34-doc archive sweep held (R5); the `Globe.js`
volumetric cloud default-on hunk held (R6); and 65 landed worker clones harvested to archive and
deleted (R7). In-flight lanes at the return: sync-parity wave **S1** (lead Hundar), **Uldor round 3**
(arrow-head profile parity repair, status landing), and **Amdir round 3** (matrix pick/visibility
instrument revision).

### Upstream sync — CesiumJS 1.145 (not a numbered campaign)

**LANDED.** The fork is synced to CesiumJS 1.145 at merge commit `33398505e6`, **Batch 1408**
(parents `e7360fa234` fork / `488b114e16` `upstream/main`, merge-base `6d5d8b1f07`), landed
2026-09-04. Verification: **Éowyn job 4, FIT TO FAST-FORWARD** (evidence:
`Tools/visual-regression/output/sync-1145-verification-2026-09-04/`); leg 1b (Sandcastle2 sweep) and
leg 2 (draped-polyline width gate B) remain owed, tracked as `UPSTREAM-SYNC-1.145-06`/`-07` items,
neither a RED against the pre-merge baseline.
[`UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md`](UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md) is the plan that
was executed, built from one aborted dry-run merge (32 conflicted files, 79 conflict hunks, 164
paths); the real merge resolved 33 conflicted files / 80 hunks (one file drifted between the dry run
and the landing). Its rows are the `UPSTREAM-SYNC-1.145-*` family in
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md), which carry
status — this file does not, and neither does the plan. `-00` through `-05` and `-08` are LANDED,
`-06` is VERIFIED (partial, see above), `-07` (the WGSL parity twins the sync opens) is OPEN with one
item closed (Penlod, Batch 1410, reviewer Gundor). Two maintainer calls the sync surfaced are
recorded as `M-26`/`M-27` in that queue's §8: the CLA-check migration (status quo/Google Sheets kept
in the merge) and extending CLAUDE.md's `ShaderDefine` add-only rule to the WebGL globe shader-set
key. Two procedural facts the plan established and the merge confirmed: the sync is the **one
sanctioned merge commit** against the otherwise squash-only landing rule (verified: exactly two
parents), and CLAUDE.md's sync-procedure `--theirs` default was **wrong for 13 of the 24 conflicted
`.js` files**, which the fork had converted to ES6 classes while upstream is still prototype-based
(plan §3) — worked around in this merge by the new `PORT-INTO-CLASS` class and guarded going forward
by the ES6-shape guard (`-08`, landed); **amending the procedure itself is still open as `AR-D23`.**

**Wave S1 (sync parity, UPSTREAM-SYNC-1.145-07): CLOSED.** All five lanes LANDED: L4 (Batch 1462),
L1 (Batch 1463), L2 (Batch 1465), L3 (Batch 1470), and L5 (Batch 1472). S1 is CLOSED except the Edge
legs (Éowyn job 15) which remain owed.

**2026-09-05 — Batches 1405–1429 re-landed under new hashes (redate, not a content change).** The
pre-push hook refuses an in-window commit date, so after the quiet-hours window the maintainer chose
to re-create Batches 1405–1408 (which re-created every later first-parent commit through 1429 too);
trees, messages and batch numbers are unchanged, only the 25 hashes are new — this section's merge
commit (`33398505e6`, was `ffb8161c08`) and fork parent (`e7360fa234`, was `40341305f4`) are the
re-landed values. The old→new map (25 rows) is banked at
`F:/Dev/GH/cesium-webgpu-worker-archive/scratchpad-2026-09-05/redate-map.txt`. **Rule going
forward:** a document that cites a landed commit's hash may only be written/edited after that
commit is pushed — a hash cited before the push is exactly the kind of citation a future redate
invalidates.

### Standing principles that block work (not row-specific)

- **Performance work must not remove, default-disable, bypass, or visually degrade a feature to
  win a metric.** Safety containment is correctness work, not a performance win. (CLAUDE.md Core
  Principle 2/6 area; restated as `SR-1` in `QUEUE_2026-08-29_RESEARCH_DISPATCH.md` §0.2.)
- **Idle-soak FPS is invalid under request-render mode.** Use the Node/Edge moving-altitude
  campaign (`DEBUGGING_GUIDE.md#canonical-moving-altitude-campaign-2026-07-14`) with clean and
  API-instrumented lanes kept separate; do not substitute Python tooling. (Restated as `SR-9` in
  the same §0.2.)

### How to update

The campaign queue documents named above stay the **row-level** authorities. This file is the
**campaign-level** authority. **Update this file in the same commit as any change that flips a
campaign-level fact**: a launch, a hold lifted or applied, a critical-path handoff, or a new
campaign ratified. A row completing inside an already-described critical path does not require an
edit here; the critical path itself changing does.

### Appendix — corrections to the previous CLAUDE.md text

Checked against the authorities above on 2026-09-02:

1. **`C11-181` was described as open; it is COMPLETE.** CLAUDE.md read _"`C11-181` is
   LANDED+VERIFIED but NOT COMPLETE... the queue row is the authority and keeps it open."_ The
   named row (`QUEUE_2026-07-18_CAMPAIGN11.md:2123`) reads **COMPLETE**, administratively closed
   2026-08-09, close authority `DEFERRED_WORK.md` landed Batch 1063 (2026-08-20). This exact
   contradiction was independently found and recorded by a prior audit
   (`AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md` §"G-4 — derived orientation docs contradict
   the status authorities") and was never corrected in the tracked mirror. Corrected in the C11
   block above.
2. **The GSPLAT track was described only as "authored" through `C15-G8`.** CLAUDE.md read
   _"`C15-G0` scoping complete (Batch 863), `C15-G1..G8` authored."_ At authoring time (Batch
   ~863) that was accurate; by 2026-09-02 five rows (`G1..G5`) are landed, `G6` is partial, `G7`
   has run once, and `G9` — a row CLAUDE.md never named — is closed. Corrected in the C15 block
   above.
3. **C12's exit-gate framing was accurate but has since gained a superseding ruling.** CLAUDE.md's
   "the remaining C12 blockers are the reopened `C13-41` row, S5 and the recorded exit tail" is
   still true, but `R-2026-09-02-5` (2026-09-02, same day as this refresh) names the concrete
   next step (the exposure-sweep discriminator) and a fallback (Option C). Not a contradiction —
   an update, folded into the C12 block above.
4. **G3's disposition changed from "work not done" to "red by design."** CLAUDE.md's C12 prose
   did not mention G3. `R-2026-09-02-7` answers the C12 queue's open `Q-77`: the chroma/dust
   criteria are unreachable by any bundled star-catalog asset, so G3's red is accepted by
   construction rather than owed further work. Folded into the C12 block above.

---

## 2. GitHub Quiet Hours — HARD RULE (maintainer, 2026-08)

_Mirrored verbatim from `CLAUDE.md`; unaffected by this wave's campaign-status ruling. Also fully
restated in `ORCHESTRATION_HANDBOOK.md` §3._

On WEEKDAYS between 07:00 and 19:00 US Eastern: **no `git commit`, no `git push`, no visible
GitHub activity of any kind.** Commits carry visible timestamps even if pushed later, so do not
commit during the window either — hold work as uncommitted worktree state / exported patches and
land in batches after 19:00 ET. Weekends and 19:00–07:00 are unrestricted. Check `date` before
every commit/push; the machine clock is authoritative. Local-only work (builds, probes, workers,
edits) is unaffected.

> **History note (handover audit FIX 37, 2026-08-09):** in-window weekday commits exist
> prior to the Batch-977 attestation. They are **not precedent** — the rule as written
> governs. Whether a waiver existed is an open maintainer ask.

> **Now enforced mechanically (ruling R-2026-08-14-4, `SOL-D4-HARDENING`):** `.husky/pre-push`
> refuses a push inside the window — Eastern offset resolved from the tz database, never
> hardcoded — and also enforces the `Batch NNNN:` prefix (monotonic), a non-empty body and the
> `Co-Authored-By:` trailer; merge / upstream-sync commits skip the three message rules.
> `npm run verify-landing` is the after-the-fact detector that makes a `--no-verify` bypass
> visible, and additionally checks each commit's own timestamps against the window. Rules and
> specs: `Tools/landing-rules.mjs`, `npm run test-landing-rules`;
> [`EXECUTOR_LANE_CHARTER_2026-08-14.md`](EXECUTOR_LANE_CHARTER_2026-08-14.md) §6.

## 3. Branch Transparency — CRITICAL

_Mirrored verbatim from `CLAUDE.md`; unaffected by this wave's campaign-status ruling. Also fully
restated in `ORCHESTRATION_HANDBOOK.md` §3._

The user's working model is "trunk-only — no long-lived branches." Surface branch state
proactively whenever a work package is being scoped, started, paused, or closed. Do not let safety
branches, worktree branches, or agent branches accumulate silently.

**Always tell the user, unprompted, when:**

1. **Starting a work package** — list any pre-existing local or origin branches besides `main`
   ("Heads-up: `pre-upstream-merge`, `feature/foo` are still around from prior work — want me to
   audit and clean before starting?"). Run `git branch -a` to check; do not assume.
2. **Creating a new branch or worktree** — name it, say why, and commit upfront to a deletion
   plan ("I'll create `safety-pre-batch-69-2026-04-26` as a rollback ref; I'll delete it after
   the batch lands on main and verifies green").
3. **A sub-agent spawns a worktree branch** — surface the branch name in your reply, even if the
   agent ran in the background.
4. **Finishing a work package** — re-list all branches and explicitly ask whether to delete the
   now-redundant safety/feature/worktree branches before declaring the package done.
5. **At the start of every new conversation** if `git branch -a` shows anything besides `main`
   (and its remote tracker), open with a one-liner inventory.

Use git-stash usage conventions when labeling refs (timestamped, descriptive).

> **Mirror note (2026-08-09):** the `CLAUDE.md` original links this last sentence to a
> session-local memory file outside the repository, which no successor can read. The
> convention it points at is restated in
> [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) §3: never bare `git stash`;
> always `git stash push -m "YYYY-MM-DD_HH:MM_claude_<reason>"`; prefer
> `git show HEAD:<file>` or a worktree over stashing for comparisons; never drop unlabeled
> stashes without maintainer confirmation.

### 3a. Declared out-of-repo worktrees and evidence paths

_Superseded 2026-09-02._ This subsection previously carried a hand-maintained table of worktrees
and clones dated 2026-08-14 (fix SOL-12). That table is now stale: Wave DX's `DX-19` (branch and
worktree salvage audit) and `DX-20` (sibling-repository census) ran 2026-09-02, retiring six
worktrees and nine branch heads and twenty of the twenty-two sibling repositories (~24.5 GB
reclaimed), and refreshed the live inventory into
[`branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md`](branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md) —
read that file for current branch/worktree/clone state, not this one. The append-only evidence
library `F:\Dev\GH\cesium-webgpu-visual-evidence` (not a git repository; holds immutable
publications the queues cite by manifest SHA-256) is unaffected by that sweep and stays kept.

⚠ **Still OPEN, and not answered by `DX-19`/`DX-20`** (those audited branches, worktrees and
sibling repositories, not this question): the 2026-08-02 stash decision, and maintainer ask
**R-d** — the disposition of the 2026-08-14 range's quiet-hours, co-author-trailer and
batch-numbering breaches (24/98 commits landed inside the weekday window, 0/98 carry the
trailer, numbering stopped after Batch 1027). See
[`SOL_WEEK_AUDIT_2026-08-14.md`](SOL_WEEK_AUDIT_2026-08-14.md) for the finding; no ruling has
closed it as of 2026-09-02.
