# Decision packet — 2026-08-18 amendments

**What this is.** [`RULING_AUDIT_2026-08-18.md`](RULING_AUDIT_2026-08-18.md) raised **fifteen**
amendments against the twenty-six rulings in
[`MAINTAINER_RULINGS_2026-08-17.md`](MAINTAINER_RULINGS_2026-08-17.md). **Four** have been ruled and
are recorded as `R-2026-08-18-26` through `-29`: `R-12` (Codex wiring → tracked template mirror),
`R-9` (`refreshCostMeasured` → principle affirmed, prerequisite ordered), `R-13` (workers never run
git writes), `R-21` (house scale → frozen ratchet). **Eleven remain undispositioned.** This packet
turns each into a decision brief. It does not re-litigate the four.

**Enumeration, so the count is checkable.** The audit's fifteen amendment headings are `R-12`,
`R-22`, `R-9`, `R-16`, `R-7`, `R-3`, `R-11`, `R-15`, `R-21`, `R-23`, `R-19`, `R-13`, `R-24`, `R-14`,
`R-17`. Removing the four ruled leaves exactly eleven: **`R-15`, `R-19`, `R-7`, `R-22`, `R-3`,
`R-16`, `R-11`, `R-23`, `R-24`, `R-14`, `R-17`.** Note that `R-2026-08-18-28` amends *both* `R-13`
and `R-19`, but it settles only the *commit-actor* question; `R-19`'s amendment also contained a
guard-ordering and a staging-scope finding that no ruling has touched, so `R-19` stays on the list
with its scope narrowed to those two. Its brief says so explicitly rather than reopening the
commit-actor call.

Separately, the "**Corrections applied without a ruling**" block in the rulings file already applied
factual fixes inside `R-16`, `R-22` and `R-11`. Those three briefs therefore cover **only the
residual decisions the corrections did not reach**, and each says which part is already closed.

**Verification posture.** I re-derived the load-bearing facts myself rather than relaying the audit.
Each EVIDENCE block marks every item **VERIFIED** (I read the file or ran the command) or
**RELAYED** (taken from the audit, not independently checked). Line numbers are as they stand in the
working tree today, which carries ~150 uncommitted paths; where a cited line has moved since the
audit I give the current number and say so. `node --test` runs are reported with exact counts.

---

## Reading order and what depends on what

Three groups. Within a group the order is a real dependency, not a preference.

**A — governance foundation.** `A1` decides which document wins when two disagree; `A2` and `A3`
both propose landing edits across documents whose rank is currently contested, and `A3`'s central
hazard (loosening an assertion in the same commit that moves the data it asserts) is a charter §1.2
question that `A1`'s precedence text has to be able to answer. So: **A1 → A2 → A3.**

- **A1 — `R-15`** precedence order, `AGENTS.md` false references, credential subordination.
- **A2 — `R-19` (residual)** which tracked-reference guard is built first; what `git add -A` sweeps in.
- **A3 — `R-7`** the findings-ledger schema migration.

**B — the picking programme.** A strict chain. `B1` fixes the clock and the cap derivation, which
are *inputs* to `B2`'s ε computation, `B3`'s drill cap and `B4`'s age term. `B3` precedes `B4`
because the already-applied `R-11` correction makes the content axis a **stated precondition** of
`B4`'s legacy mapping. `B5` follows `B4` because "which families count as a pick family for
triggering" is answered by `B4`'s CPU-resolvable exemption.

- **B1 — `R-22` (residual)** the frame clock, the cap derivation, and which ε budget is normative.
- **B2 — `R-3`** what the plateau proof is conditional on; whether `PickDepth` comes under it.
- **B3 — `R-16` (residual)** the content term's shape; what synchronous `drillPick` becomes.
- **B4 — `R-11` (residual)** where the freshness term is carried; the location term; sequencing.
- **B5 — `R-23`** prewarm triggers and globe pick-ID parity.

**C — instrument hygiene.** Mutually independent, and independent of A and B. Ordered by what is
blocking a run today.

- **C1 — `R-24`** pre-registration custody (blocks a 2.5 h Edge set).
- **C2 — `R-14`** scratch-file promotion and the expiry clock.
- **C3 — `R-17`** the Moon shader contract — **already executed in the working tree**; two sentences.

**D — carried-forward conflicts.** Four of the audit's ten mutual conflicts survive the four
rulings. Three are folded into the briefs that own them (conflict 2 → B4, conflict 3 → B5,
conflict 9 → A1). The fourth belongs to no amendment and gets its own short section, **D1**.

---

# A1 — `R-2026-08-17-15`: the precedence order, and what `AGENTS.md` currently claims

## The question

When two of this fork's governing documents disagree, which one wins? `R-15` ruled that a single
`[HARD]` precedence order should live in charter §0.4 and that `AGENTS.md` should collapse into a
pure router pointing at it. **The ruling never wrote the order down.** Whoever implements §0.4
therefore picks the winner of every future conflict. Three sub-questions come with it: what breaks
the tie between "a later ruling wins" and "the narrowest scope wins"; whether pointing at
`ORCHESTRATION_HANDBOOK` §3 as the identity authority re-imports the very self-service credential
switch `R-15` rejected; and what to do about two claims `AGENTS.md` already makes that are not true
of the files it names.

## Evidence

- **VERIFIED — charter §0.4 does not exist.** `EXECUTOR_LANE_CHARTER_2026-08-14.md` has `0.1` (:23),
  `0.2` (:30), `0.3` (:38) and then `## 1.` at :44. There is no `0.4`.
- **VERIFIED — `AGENTS.md:22` is false today.** It reads "§0 states the full precedence order in
  detail." §0 states three authorization rules and no ordering.
- **VERIFIED — `AGENTS.md:41` is false today.** It reads "`ORCHESTRATION_HANDBOOK.md` §3 — named by
  charter §2.6 as the authority." Charter §2.6 (:156-162) never mentions the handbook. What §2.6
  actually says is the *safer* text: *"Do not switch `gh`, Git, SSH, or any other account/credential
  solely because this document names a historical convention… leave it unchanged, report the
  mismatch, and ask for explicit direction."*
- **VERIFIED — handbook §3 carries the rejected instruction, under a `[HARD]` heading.**
  `ORCHESTRATION_HANDBOOK.md:129-131`: *"A 403 on push means the wrong gh account is active —
  `gh auth switch`, it is not a permission loss."* Pointing charter §2.6 at handbook §3 imports by
  reference exactly what `R-15` rejected option R4 for installing by copy. **This is live conflict 9.**
- **VERIFIED — the live precedence inversion.** `AGENTS.md:15-24` ranks: (1) instructions, (2)
  rulings, (3) charter, (4) `CLAUDE.md`, (5) "Everything else, including this file." Campaign queue
  rows land in tier 5, *below* `CLAUDE.md`. But `ORCHESTRATION_HANDBOOK.md:9-11` says *"campaign
  queue documents are the SOLE status authorities… the queue row wins"*, `:368-369` orders
  *"maintainer rulings > queue rows > CLAUDE.md > this handbook"*, and `migration_doc/README.md:86`
  repeats *"queue rows remain the sole status authorities."* The landed half of `R-15` has demoted
  queue rows by three ranks on the single ordering this fork uses most.
- **VERIFIED — the tie-break contradicts itself in the landed text.** `AGENTS.md:20` says *"A later
  ruling supersedes an earlier one"* (recency); `AGENTS.md:26` says *"The narrowest authorized scope
  wins"* (specificity). Nothing says which governs when a later broad ruling meets an earlier narrow
  one — which is precisely the shape of the four amendments ruled yesterday.
- **VERIFIED — a fifth claimant exists.** `CLAUDE.md:519` names `.clinerules` *"source of truth for
  project rules."*
- **RELAYED** — that the deleted lane-disjointness rule ("Work only in disjoint authorized paths")
  has no tracked home anywhere. I did not exhaustively search for a home; I did confirm the risk is
  live, since this tree carries ~150 dirty paths across lanes.

## The objective

The goal is that **an agent reading any single entry point reaches the same answer as an agent
reading any other**. Adding a fifth precedence statement to four existing ones does not serve that
goal even if the fifth is the best-worded; it makes drift cheaper to create. The instrument here —
a `[HARD]` charter section — is only worth having if the other four are demoted to pointers in the
same landing. Otherwise this ruling reproduces the defect it was written to end.

## Options

**Option 1 — Write §0.4 with an explicit six-tier order, demote the other four to pointers, and
subordinate handbook §3.**
Order: (1) system/developer/user/current-task instructions; (2) maintainer rulings, newest first;
(3) campaign queue rows *for status only*; (4) the executor charter; (5) `CLAUDE.md`; (6) everything
else, `.clinerules` and this file included. Tie-break stated: **within one tier, the narrowest
authorized scope wins; across tiers, the higher tier wins; between two rulings, the later wins.**
Handbook §3's 403 line is rewritten to *"report the 403 and the active account; switch only when the
current task places that action in scope."*
*Pros:* ends the inversion; preserves the "sole status authority" rank that the handbook and README
both assert; makes the tie-break decidable; discharges conflict 9 by subordination rather than
delegation, so charter §2.6's safer text keeps governing. *Cons:* it edits a tracked `[HARD]`
handbook block, so charter §4.6 non-author review is mandatory; roughly four documents change in one
landing; and a 403 now costs a round trip instead of an auto-switch.

**Option 2 — Write §0.4 but leave the other four statements in place.**
*Pros:* smallest landing; no `[HARD]` edit; nothing else can regress. *Cons:* five statements where
there were four. The `AGENTS.md` inversion stays live, which means an agent that reads only
`AGENTS.md` will overrule a queue row with `CLAUDE.md`. This is the status quo plus one document.

**Option 3 — Do not write §0.4; instead delete the `AGENTS.md` precedence block and route to
`ORCHESTRATION_HANDBOOK.md:368-369`, which already states an order.**
*Pros:* zero new text; the existing order already ranks queue rows correctly; no `[HARD]` charter
promotion needed. *Cons:* handbook:368-369 sits in an *appendix* and is scoped "where this
appendix's sources conflict" — it was never written as the global order. It also omits the charter
and `AGENTS.md` entirely, so two of the current five claimants are unranked. And it leaves handbook
§3's credential instruction unaddressed.

**Option 4 — Rank queue rows in tier 3 but keep `AGENTS.md` as the sole precedence text (no charter
§0.4).**
*Pros:* one file to edit; `AGENTS.md` is the file agents actually read first. *Cons:* `AGENTS.md` is
untracked-but-not-ignored per `R-2026-08-17-2`'s finding; putting the load-bearing order in the file
whose whole purpose is to be a router inverts the router relationship, and a fresh clone that has
not yet received `AGENTS.md` has no order at all.

## Recommendation

**Option 1.** Its cost is real and I am not going to hide it: it touches a tracked `[HARD]` block
and therefore cannot land tonight without a non-author reviewer, and it makes every future 403 a
round trip through the maintainer. That second cost is the one charter §0.2 was written to charge,
so paying it is the point rather than a side effect.

Two things must land in the same commit or Option 1 is not done: **fix `AGENTS.md:22` and `:41`**
(both currently assert something that is not in the file they name — the doc-claims-code-that-is-
not-there class, sitting inside the file written to eliminate contradictions), and **give the
lane-disjointness rule a tracked home in charter §2** before it is deleted from anywhere else. With
~150 dirty paths in this tree, lane disjointness is the one deleted rule whose absence can destroy
another lane's uncommitted work.

If Option 1 cannot get a reviewer in time, the honest fallback is **hold `AGENTS.md` out of the
landing entirely** rather than land a router with two false pointers.

---

# A2 — `R-2026-08-17-19` (residual): which guard gets built first, and what `git add -A` sweeps in

**Already settled, not reopened here.** `R-2026-08-18-28` ruled that workers never run git writes
and the orchestrator commits from its own tree. That closes the commit-*actor* half of `R-19`. Two
findings in the `R-19` amendment are untouched by any ruling and are the subject of this brief.

## The question

`R-19` ordered three landing guards and put **staged-set equality** at the head of the queue. Under
the whole-tree `git add -A` mechanic that the same ruling dictates, the staged set equals the branch
diff set *by construction* — so the guard ordered first cannot fail. Meanwhile a guard that does
find live defects was ordered later. Second question: whole-tree staging guarantees a **superset**
as surely as a path list guarantees a subset, and `_review/` — the orchestrator-provisioned evidence
bundle — is not ignored, so it lands on main through squash-only landing.

## Evidence

- **VERIFIED, and better than the audit knew — `Tools/verify-tracked-references.mjs` now EXISTS.**
  1,195 lines. It runs, exits **1**, and reports **18 violations and 3 advisories** over "32 launch
  targets, 389 relative imports across 95 changed source files."
- **VERIFIED — it finds the live defect the audit named, twice.** Its first two violations are
  `package.json:158 -> Tools/generate-tooling-catalog-launcher.cjs` and `package.json:159 -> …`,
  both "UNTRACKED: present on disk, NOT in the tree — a clone gets nothing." `git ls-files
  --error-unmatch` on that launcher fails; the file is 15,207 bytes on disk. So `npm run
  verify-tooling-catalog` is broken in any clean clone, today.
- **VERIFIED — the guard is itself untracked.** `git ls-files --error-unmatch
  Tools/verify-tracked-references.mjs` fails. The tracked-reference checker is a tracked-reference
  violation.
- **VERIFIED — it already sees the Codex wiring.** Violation 3 is `.mcp.json:8 ->
  Tools/codex-mcp-launcher.mjs`, flagged "(the referring file is itself untracked)". This matters
  for `R-2026-08-18-26`: once `.mcp.json.template` is tracked, the same reference becomes a
  *tracked* file pointing at an untracked launcher, and this guard reds unless the launcher is
  tracked in the same commit.
- **VERIFIED — 15 of the 18 violations are this tree's own in-flight work** (untracked `lib/*.mjs`
  modules referenced from untracked specs: `c12-29-s5-replacement-device-capture.mjs`,
  `weather-capture-doctrine.mjs`, `c12-11-star-catalog-gate.mjs`, `cloud-u2-perf-evidence.mjs`,
  plus two untracked engine sources). **This is the honest cost:** landed as a red gate today it
  blocks every unrelated change until roughly 150 dirty paths land.
- **VERIFIED — the other two guards do not exist.** `Tools/verify-branch-inventory.mjs` and
  `Tools/verify-landing-content.mjs` are absent from disk, while
  `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` section 5 asserts all three as if they exist.
- **VERIFIED — `_review/` is not ignored.** `git check-ignore -v _review/foo.json` exits 1 with no
  output. Under `git add -A` the whole provisioned evidence bundle stages.
- **VERIFIED — porcelain cannot see an ignored omission.** `git status --porcelain` never lists
  ignored paths, so the post-commit check `R-19` specifies is structurally blind to the failure mode
  `R-12`/`R-26` exist to prevent.

## The objective

The goal is that **a clean clone can run what the repo says it can run**. A guard that is green on
day one and every day after does not serve that goal; it serves the appearance of it, and its worst
property is that it will be cited in landing notes as evidence. `verify-tracked-references.mjs`
serves the goal — it is red right now, for true reasons.

## Options

**Option 1 — Reorder: `verify-tracked-references.mjs` first, as an advisory that prints and exits 0,
promoted to exit 1 once the current dirty set lands.**
*Pros:* the guard that finds real defects goes first; the launcher defect surfaces immediately; the
15 in-flight violations do not block unrelated work. *Cons:* an advisory guard is a guard that can
be ignored, and this fork's own recorded failure mode is exactly "softened to a warning afterwards."
Needs a dated promotion trigger or it stays advisory forever.

**Option 2 — Reorder, and land it fail-closed at exit 1 immediately.**
*Pros:* strongest; no promotion to forget; matches the fork's fail-closed instrument doctrine.
*Cons:* it is red today and blocks everything until ~150 dirty paths land, including the picking
programme this packet's B group orders. That is a real schedule cost, not a hypothetical one.

**Option 3 — Land it fail-closed but scoped to `package.json` scripts and launch-target references
only, deferring the relative-import walk.**
*Pros:* catches both known instances (the launcher, the MCP wiring) at exit 1 today; the 15 in-flight
import violations fall outside scope so nothing is blocked; the walk is added when the tree is clean.
*Cons:* the import walk is where most of the value is; scoping it out means a future untracked `lib/`
module ships unnoticed. Two landings instead of one.

**Option 4 — Keep `R-19`'s order (staged-set equality first).**
*Pros:* no change; the guard is cheap and composes with `R-6` layer 3. *Cons:* under `git add -A` it
is near-tautological. It is worth keeping as a **regression anchor against a future path-list
mechanic**, which is a real but different claim from "it detects landing defects." If it is kept
first, the landing notes must say which it is.

## Recommendation

**Option 3, then Option 2 when the tree is clean.** Cost stated plainly: it is two landings rather
than one, and between them a newly-added untracked `lib/` module can still ship. I prefer it to
Option 2 because a gate that reds on 15 items belonging to five other lanes will be argued with, and
this fork's recorded history is that argued-with gates get softened.

Whichever is chosen, three things should land with it:

1. **Track `Tools/verify-tracked-references.mjs` itself** in the same commit, or the guard is its own
   first violation in a clean clone.
2. **Add `_review/` to `.gitignore`**, or provision evidence outside the clone. One line; without it
   whole-tree staging is a defect rather than a guard.
3. **State in the landing note that staged-set equality is a regression anchor, not a live
   detector**, so it is never cited as evidence that a landing was complete.

`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` section 5 must also stop asserting three guards when one
exists.

---

# A3 — `R-2026-08-17-7`: the C13-41 closure record is a schema migration, not an edit

## The question

`R-7` ordered four moves on `migration_doc/FINDING_DISPOSITIONS_2026-08-13.json`: annotate the
`C13-41` record, vacate its closure state, sweep the other entries for the same overturned warrant,
and point at the superseding ruling. **Every one of the four collides with an enforced schema** in
the ledger's only consumer, which is green today. The question is whether to re-issue `R-7` as a
coordinated schema migration (ledger + spec in one commit, with the commit body saying so), or to
find a cheaper shape.

## Evidence

All **VERIFIED** by reading `Tools/visual-regression/finding-ownership-audit.spec.mjs` and running it.

- **`node --test Tools/visual-regression/finding-ownership-audit.spec.mjs` → 8 tests, 8 pass, 0 fail.**
  The ledger is green as it stands.
- **The entry key set is asserted exactly.** `:225-234`, `assert.deepEqual(Object.keys(entry).sort(),
  ["category","disposition","owner","producer","runId","status","summary"])`. An `annotate` or
  `note` key has nowhere to live.
- **`validDispositions` is a two-value set.** `:220-223`, `{"active-repair",
  "closed-by-certifying-pass"}`. There is no `reopened-by-ruling` member.
- **Owner state is derived from disposition and asserted both ways.** `:244-248` computes
  `expectedOwnerState = entry.disposition === "active-repair" ? "active" : "closed"` and asserts
  equality; `:280-282` asserts any non-closed owner state equals `"active"` exactly. There is no
  `reopened` member on either side.
- **The owner key set is asserted exactly, four keys when closed.** `:265-272`,
  `["closureRunId","document","reference","state"]`. No slot for a `supersededBy` pointer.
- **The counts are hard-coded.** `:251-262` asserts exactly **20** `closed-by-certifying-pass` and
  exactly **3** `active-repair`. Re-derived from the ledger: 23 entries total, 20 + 3. Any sweep
  that moves one entry breaks both assertions.
- **The `C13-41` record is as cited.** Owner `C13-41` resolves to `{document:
  "QUEUE_2026-07-23_CAMPAIGN13.md", reference: "C13-41 ACCEPTANCE + LANDING RECONCILIATION", state:
  "closed", closureRunId: "b5e3f63c-94c6-4204-8706-dd30eabd2eaf"}`. **Two** entries carry `owner:
  "C13-41"`, and **both** are `disposition: "closed-by-certifying-pass"` — a second machine-readable
  closure record carrying the same overturned warrant, which `R-7` as written does not vacate.
- **The warrant has no key.** Entries carry no field naming the ruling that justified their closure;
  the justification lives only in free-text `summary`. A sweep is therefore a human reading 20 prose
  strings, with nothing that re-fires when a future gate moves.

## The objective

The goal is that **a closure record stops being trusted the moment its warrant is overturned** —
automatically, not because someone remembered. `R-7`'s four moves are a one-time repair of one
record. The instrument question — how the sweep stops being a human reading 20 strings — is the part
that actually pays, and it costs one required field.

## Options

**Option 1 — Coordinated schema migration in one commit.**
Bump to `cesium-finding-dispositions/v2`; add `reopened` to the owner enum and `reopened-by-ruling`
to `validDispositions`; add optional `supersededBy` and `note` keys to the exact-key assertions; add
a **required `warrantRuling`** field; vacate the owner state **and both `C13-41` entry dispositions**;
replace the literals 20/3 with counts derived from the entry set.
*Pros:* the sweep becomes an assertion the spec runs every CI pass, so a superseded warrant reds
automatically. It fixes the second closure record `R-7` missed. Deriving the counts removes a literal
guaranteed to drift. *Cons:* ~60 lines across ledger and spec plus a back-fill of `warrantRuling` on
all 23 existing entries — and the back-fill means deciding, for each, which ruling warranted it,
which is the same 23-string read the sweep was meant to avoid, done once. It will also go red at
inconvenient times, which is intended behaviour and still a cost.

**Option 2 — Execute `R-7` literally and loosen the colliding assertions in the same commit.**
*Pros:* smallest diff; the ledger reflects reality tonight. *Cons:* this is the shape charter §1.2
calls the clearest breach it exists to prevent — changing the data and the assertion that guards it
in one commit. Even where it is *correct* here, it sets the precedent under a ruling that did not
acknowledge the schema existed.

**Option 3 — Leave the ledger alone; record the supersession only in the ruling series.**
*Pros:* zero risk; the ruling series is already the top-tier authority under A1's order. *Cons:* the
ledger is the machine-readable artifact; leaving a `state: "closed"` with a `closureRunId` in place
means every consumer keeps reading a closure whose warrant is gone. It also leaves the count literals
and the missing warrant key untouched, so the next supersession costs the same.

**Option 4 — Do Option 1's schema work but keep `warrantRuling` optional.**
*Pros:* no 23-entry back-fill; new entries get the field. *Cons:* an optional field means the sweep
assertion covers only the entries that opted in, so it silently under-reports — the exact property
that made the current sweep a prose read.

## Recommendation

**Option 1, with `warrantRuling` required.** The stated cost is the 23-entry back-fill, and it is not
mechanical: for some entries the warranting ruling may be genuinely ambiguous, and where it is, the
honest value is a ruling ID plus a note saying the attribution was reconstructed — not a confident
guess. Budget it as a real read, not a `sed`.

Two corrections to `R-7` fall out of the evidence regardless of which option is picked: **both**
`C13-41` entries must be vacated, not just the owner state; and the `20`/`3` literals must become
derived, because the very first sweep breaks them.

---

# B1 — `R-2026-08-17-22` (residual): the clock, the cap derivation, and which epsilon budget is normative

**Already corrected, not reopened here.** The rulings file's "Corrections applied without a ruling"
block has already fixed two of the audit's four `R-22` findings: the binding condition now names
**all five** coupled rectangles (scissor and cull volume **widen**; returned rect, decode window and
spiral bound **stay** at 3x3, each asserted), and the rate table is to be "republished from one
budget with the normative disc radius named." The aperture constant is confirmed sound. **Three
things remain undecided**: *which* budget, the frame clock, and where the caps come from.

## The question

1. **Which epsilon budget is normative** — the seed's `P >= 2*epsilon` or the state document's
   `ceil(epsilon)+1`? The correction says the table will be republished from one budget with the
   disc radius named, but does not say which, and the two produce materially different headline
   numbers (16.0/32.0 deg/s versus 10.7/21.4 deg/s).
2. **What clock does frame age count on?** `PickReadbackRegion` carries no frame stamp at all, and
   the two available candidates disagree about what drill's iterations see.
3. **Where do the caps 2 and 8 come from?** They are stated as literals; nothing ties them to the
   aperture, so shrinking the aperture later would silently invalidate them.

## Evidence

- **VERIFIED — the model is exactly linear in `k`, so the two published rates cannot share a budget.**
  `PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md:70-82` tabulates, at 30 deg/s: `epsilon = 14.51` px
  at `k=1`, `29.02` at `k=2`, `58.04` at `k=4`, and states "Max angular rate inside a 1 px budget:
  2.07 deg/s @ k=1, 1.03 @ k=2" — ratio exactly 2.0 both times.
- **VERIFIED — I solved the two published figures back to two different budgets.** The slope is
  `14.51/30 = 0.48367` px per (deg/s x k). At half-width `R = 31` (a 63 px aperture): a budget of
  `R/2 = 15.5` px gives `omega_max(k=2) = 15.5 / (2 x 0.48367) = 16.02` deg/s — the published 16.0.
  A budget of `R/3 = 10.333` px gives `omega_max(k=1) = 10.333 / 0.48367 = 21.36` deg/s — the
  published 21.4. **Two budgets presented as one derivation.** The self-consistent pairs are
  **(16.0 @ k=2, 32.0 @ k=1)** under `R/2` and **(10.7 @ k=2, 21.4 @ k=1)** under `R/3`.
- **VERIFIED — "typical orbit drag" is reached by neither published figure.** That regime is 30 deg/s
  in the same table. Only the unstated 32.0 clears it.
- **VERIFIED — the aperture arithmetic reproduces exactly.** 63 px x 4 B = 252 B, padding to
  WebGPU's mandatory 256-byte `bytesPerRow`; 63 rows x 256 B = **16,128 B** per pick; x 60 Hz =
  967,680 B/s = **945.0 KiB/s**. Against 33x33 (33 x 256 = 8,448 B) that is **1.909x** the bytes for
  **3.645x** the pixel area. 65 px would need two rows and an even width cannot be cursor-centred, so
  63 is the unique maximum odd aperture costing one padded row.
- **VERIFIED — there is no clock.** `WebGPUPickFramebuffer.ts:186-200`, `interface
  PickReadbackRegion` carries `logical*`, `copy*`, `resourceGeneration`, `attachmentGeneration` and
  `viewProvenance`. **No frame number.** `_readbackRegionsEqual` (`:568-588`) compares exactly those
  fields — no age term and no owner term.
- **VERIFIED — the two candidate clocks disagree, exactly as the audit says.** The provenance string
  (`Picking.js:1536-1558`) deliberately excludes frame number, with the reason recorded in-code:
  *"Frame number is deliberately absent: continuous rendering with a static view must still warm the
  cache."* So a rendered-frame clock does not advance across drill iterations, while a pick-pass
  counter does — under the latter, iterations 3..N of a drill exceed a 2-frame auto cap and decline.
- **VERIFIED — the cull volume is coupled to the rect, which is why the five-rectangle correction
  matters.** `Picking.js:1629-1635` builds `frameState.cullingVolume` from
  `drawingBufferRectangle.width/height`, and the in-code comment at `:1646-1657` states the
  tightening is what drops pick-time render cost by ~90-95%. Widening only the copy region therefore
  renders 3x3 of real pixels inside a 60 px border of cleared zeros. The correction closes this; the
  cost side of it — that a widened cull volume gives back part of that 90-95% saving — is not stated
  anywhere and should be measured, not assumed.
- **VERIFIED — the neighbouring subsystem already counts age in rendered frames and says why.**
  `PickDepth.js:24-30`: *"Staleness is counted in RENDERED frames (update() calls), not wall time, so
  requestRenderMode / paused scenes keep a valid cache indefinitely — depth can't change without a
  render."*

## The objective

The goal is **a serve that is right**, not a headline rate. The temptation here is real and worth
naming: `R/3` is the budget that produces the more impressive-looking `21.4 @ k=1`, and `R/2` is the
budget that produces the pair reaching "typical orbit drag." Picking either because of the number it
yields is choosing the instrument to satisfy the gate. The question that decides it is physical:
**how much margin does a uniform-ID plateau need before a silhouette crossing can bring a different
surface into the sampled pixel?** The seed answered `2*epsilon` and gave the reason (disocclusion via
silhouette crossing). The state document weakened it to `ceil(epsilon)+1` without recording one.

## Options

### Which budget

**Option 1a — Normative disc radius `P >= 2*epsilon`** (the seed's form). Republish the table as
**(10.7 @ k=2, 21.4 @ k=1)**.
*Pros:* keeps the seed's stated disocclusion margin; the negative control `R-3` already demands
(a factor-2 mutation) is meaningful against it; the headline is honest about what is proven.
*Cons:* the recovered regime shrinks materially — 10.7 deg/s does not reach orbit drag, so the
feature covers settle and inertia tails but not an active drag. That is a smaller win than what was
ruled.

**Option 1b — Normative disc radius `ceil(epsilon)+1`** (the state document's form). Republish as
**(16.0 @ k=2, 32.0 @ k=1)**.
*Pros:* reaches "typical orbit drag" at `k=1`; the larger recovered regime is the one users notice.
*Cons:* the margin has no recorded derivation, and the audit's third finding stands unaddressed
under it: a uniform pick ID does not imply uniform depth, so `epsilon` varies across the plateau
while the predicate computes one value. A thinner margin is exactly where that variance bites.

**Option 1c — Publish both, `2*epsilon` as the shipped default and `ceil(epsilon)+1` behind a named,
JSDoc-disclosed opt-in.**
*Pros:* the conservative bound ships; the aggressive one is available with its weaker warrant stated.
*Cons:* two serve policies in one subsystem is exactly the "three subsystems, three incompatible
staleness policies" defect `PICKING_ARCHITECTURE_STATE_2026-08-17.md` section 2.4 names as the thing
being fixed. I would not ship this.

### Which clock

**Option 2a — Thread `frameState.frameNumber` into `PickReadbackRegion` and count age in RENDERED
frames.**
*Pros:* matches `PickDepth.js:24-30` verbatim, so the two picking-family caches finally agree on what
a frame is; correct under `requestRenderMode`, where a wall clock or a pick counter would expire a
cache that cannot have gone stale. Drill's consequence is then statable in one sentence: every
iteration of a synchronous drill sees the same age, because no frame renders between them.
*Cons:* one new field on a struct compared field-by-field in `_readbackRegionsEqual`, so the equality
function must deliberately *exclude* it (age is a threshold, not an identity term) — an easy thing to
get wrong, and worth its own assertion.

**Option 2b — Count in pick passes (`_updateCount`).**
*Pros:* no new field; the counter exists. *Cons:* it makes drill iterations 3..N exceed a 2-frame cap
and decline, which silently truncates every drill to two results, and it expires caches in a paused
scene where nothing can have changed.

### Where the caps come from

**Option 3a — Derive both caps from the aperture constant.** Express them as a function of
`APERTURE_HALF_WIDTH` and the normative disc radius, so shrinking the aperture recomputes them.
*Pros:* the invalidation the audit warns about becomes impossible; one function, asserted once.
*Cons:* the derived value will not be a round number, and someone will want to round it — which is
the moment the derivation stops being load-bearing.

**Option 3b — Keep literal 2 and 8, with the derivation recorded in a comment beside them and a spec
assertion that recomputes and compares.**
*Pros:* the readable constant survives; the assertion is the real guard. This is the fork's shipped
idiom (`MOON_MIP_SAMPLE_COUNT`, `ECLIPSE_CLOUD_BANDS`, `PRE_REGISTERED_D1_CODES`) — frozen constant
in the lib, spec assertion beside it. *Cons:* two places to keep in agreement, which is what the
assertion is for.

## Recommendation

**1a + 2a + 3b.** State the costs: **1a drops the honest headline to 10.7 deg/s at `k=2`, which does
not reach orbit drag and reads as a smaller feature than what was ruled.** I recommend it anyway
because the alternative buys the better number by adopting a margin nobody has derived, and the
plateau's depth variance is a live unresolved objection that a thinner margin makes worse. If the
maintainer wants the larger regime, the honest route is to **derive** `ceil(epsilon)+1` — show why one
pixel of slack suffices against silhouette crossing at the plateau edge — and then 1b becomes
defensible on its merits rather than on its headline.

Two riders regardless of the choice: **scope the 2-frame cap to the plateau path only**, so an
exact-provenance serve (identical view, identical bytes, provably the same answer) stays unbounded in
age as it is today; and **measure what the widened cull volume costs**, since the tightened volume is
recorded as a 90-95% pick-cost reduction and the five-rectangle correction gives some of it back.

---

# B2 — `R-2026-08-17-3`: what the plateau proof is conditional on, and whether `PickDepth` is in scope

**Depends on B1** — the epsilon that the plateau predicate computes needs both the normative disc
radius and the clock B1 settles.

## The question

`R-3` ruled that serving a cached pick from a moved camera is legitimate when a uniform-ID plateau
proves the answer is unchanged, and stated flatly: *"That is a proof, not a tolerance."* Three
unstated conditions make that sentence conditional rather than absolute. The decision is whether to
(a) restate `R-3` as "a proof conditional on X" and enumerate X, and (b) whether `R-3`'s prohibition
on bare pose-delta tolerances governs **every** GPU-readback pick family — because one such tolerance
already ships, undisclosed, in `PickDepth`.

## Evidence

- **VERIFIED — a bare pose/location tolerance already ships.** `PickDepth.js:18-30`:
  `ASYNC_DEPTH_COORD_TOLERANCE = 4` ("The cached value is only returned when the query is within this
  many pixels of the readback's coordinate — *depth varies slowly across adjacent globe pixels*") and
  `ASYNC_DEPTH_MAX_STALE_FRAMES = 4`. The justification is precisely the argument that fails at a
  silhouette, which is the same failure mode the plateau predicate exists to exclude. `R-3` declares
  bare pose-delta tolerances forbidden while this one is live and undisclosed.
- **VERIFIED — epsilon is not computable at serve time from what the readback holds.** The pick
  readback carries pick IDs only (`WebGPUPickFramebuffer.ts:186-200`, no depth channel). Depth is a
  separate path with its own cache and its own tolerance (previous bullet) and no pose provenance.
  Only the rotation term of the reprojection is depth-independent; pan and dolly need per-pixel depth,
  and Cesium's orbit drag translates the camera.
- **VERIFIED — the fail-closed guard `R-3` makes conditional is a ratified spec, and it is RED in
  this working tree right now.** `node --test Tools/visual-regression/webgpu-pick-center-identity.spec.mjs`
  → **9 tests, 8 pass, 1 fail**. The failure is *"metadata A to B to voxel cannot cross-publish at one
  coordinate"* (`:319`), asserting *"voxel bytes must never satisfy a metadata query"*, actual
  `Uint8Array [10,11,12,13]` where `undefined` was expected. **Attribution matters and I checked it:**
  the spec file itself and `Picking.js` are clean at `4abfabedad`; `WebGPUPickFramebuffer.ts` is the
  only dirty file in that dependency set, so this red belongs to another lane's uncommitted in-flight
  work, **not to main**. I am reporting it, not diagnosing it — it is outside this lane.
- **VERIFIED — `FAR-107` still reads absolutely.**
  `FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:463`: *"Delete stale prior-frame/location/
  property/pass substitution"*, and `:464`: *"stale substitution is never a rollback mode."* `R-3`
  amends both sentences and neither is stamped.
- **RELAYED** — that the seed required `P >= 2*epsilon` for disocclusion reasons while the state
  document requires `ceil(epsilon)+1`. I confirmed the two forms differ and solved their consequences
  (see B1); I did not re-read the seed's disocclusion argument itself.
- **RELAYED** — that a uniform pick ID does not imply uniform depth. This is true by construction
  (one primitive spanning a depth range) and I did not need to verify it in code.

## The objective

The goal is **that a returned hit was rendered from a view the caller would accept**, which is what
the file's own comment says the provenance gate guarantees (`WebGPUPickFramebuffer.ts:597-604`
records this as an open maintainer decision, verbatim). A proof that holds only for rotation is still
a proof — it is just a proof of less than the sentence claims. The risk of leaving the sentence
unconditional is not that this implementation is wrong; it is that a later reader cites `R-3` as a
licence for an unconditional serve in a family where the conditions do not hold. `PickDepth` is that
family, today.

## Options

**Option 1 — Restate as "a proof conditional on X", enumerate X, and capture depth in the same
widened aperture so epsilon uses real per-pixel depth.**
*Pros:* the proof becomes unconditional in fact rather than in wording; it covers orbit drag, which is
the regime users are in; it makes the plateau's depth variance computable instead of assumed.
*Cons:* a second `copyTextureToBuffer` over the same rect, **+16,128 B per pick, taking the total to
about 1.9 MiB/s at 60 Hz** — double the ruled budget — plus depth-plateau logic on the decode side.

**Option 2 — Restate as conditional and restrict the ruled proof to translation-free motion**, where
reprojection is an exact depth-free homography.
*Pros:* free; mathematically airtight; no second readback. *Cons:* it excludes Cesium's default orbit
drag, which translates the camera. The recovered regime shrinks to rotation-only motion — a much
smaller feature than what was ruled, and arguably not the one that was wanted.

**Option 3 — Leave the sentence as ruled and add the conditions only to the implementation notes.**
*Pros:* nothing to re-ratify; the code will be correct regardless. *Cons:* the ruling text is what
later readers cite. This is the mechanism by which `FAR-107`'s specification text got cited as an
implementation — the exact error class the corrections block just punished in `R-16`.

**On `PickDepth` scope, independently:**

**Option 4 — Bring `PickDepth` under an equivalent bound** (a proof-carrying serve, or at minimum a
disclosed `cached(ageFrames)` report).
*Pros:* ends "three subsystems, three incompatible staleness policies"; one policy, one vocabulary.
*Cons:* roughly a day of work, and `PickDepth` has no plateau analogue — a depth plateau is a
different and weaker predicate than an ID plateau.

**Option 5 — Declare `PickDepth` a named, JSDoc-disclosed exception** that reports
`cached(ageFrames)` like everything else, with the exception recorded in `R-3` and a reconciliation
point named (`S6`).
*Pros:* one paragraph now; the tolerance stops being undisclosed, which is the actual defect; the
work is scheduled rather than pretended-away. *Cons:* an exception that ships is an exception that
tends to stay.

## Recommendation

**Option 1 for the wording plus Option 5 for `PickDepth`, with Option 1's depth capture deferred
behind a named condition.** Concretely: restate `R-3` as conditional and enumerate the three
conditions; ship the ruled serve **restricted to the regime where epsilon is computable** (rotation
term only) until the depth capture lands; declare `PickDepth` a disclosed exception with `S6` as the
reconciliation point.

Its cost, stated: **this ships strictly less than `R-3` ruled** — orbit drag is not recovered on day
one — and it adds a second readback later rather than avoiding it. I prefer it to Option 2 because
Option 2 makes the restriction permanent, and to Option 3 because a ruling sentence that overstates
its own scope is the failure this week's corrections were written to stop.

Two riders: **stamp `FAR-107:463-464` with the amendment** — it currently reads as an absolute
prohibition of the thing `R-3` permits — and **name the `webgpu-pick-center-identity.spec.mjs`
re-baseline in `R-3`'s binding conditions**, including the mutated-predicate negative control, since
that spec is the fail-closed guard the plateau serve makes conditional.

---

# B3 — `R-2026-08-17-16` (residual): the content term's shape, and what synchronous `drillPick` becomes

**Already corrected, not reopened here.** The corrections block has replaced the false sentence
("exclusions and mode are already part of the query identity… structurally cannot alias… no special
case is required") with the true one: drill's exclusion is a **content** mutation, so drill is served
by the content term. The iteration sentinel and the `isWebGPU` retirement are both ruled and sound.
**Two decisions remain**: what the content term actually is, and what a synchronous `drillPick`
returns once exclusions really do enter query identity.

**Depends on B1** (drill's cap is only statable once the clock is named).

## The question

A "content term" is a counter that changes when the scene's pickable content changes, so a cached
readback is not served after the content moved. Two shapes are available and they have very different
costs. Separately: once exclusions enter identity, **every** drill iteration after the first is a
guaranteed cache miss, and a miss on a readback backend cannot resolve inside the same synchronous
task. Synchronous `drillPick` would then return at most one object. That is a capability reduction,
and it needs to be a decision rather than a consequence nobody wrote down.

## Evidence

- **VERIFIED — drill excludes by mutating scene state, not by varying a query parameter.**
  `PickingRayHelpers.js:357-384`: `attributes.show = ShowGeometryInstanceAttribute.toValue(false, …)`,
  `object.show = false` for a `Cesium3DTileFeature`, else `primitive.show = false`.
- **VERIFIED — the only thing varying across iterations in the real call is `limit`, and `limit` never
  reaches provenance.** `Picking.js:930-944` builds `pickCallback = (limit) => this.pick(scene,
  windowPosition, width, height, limit)`; the provenance builder `getCenterPixelViewProvenance`
  (`Picking.js:1536-1558`) takes `(scene, owner)` and has no `limit` parameter; the ordinary call site
  at `Picking.js:1666` passes **`getCenterPixelViewProvenance(scene)` with no owner at all**.
- **VERIFIED — the `show` flags the exclusion mutates ARE already provenance inputs, but only when an
  owner is threaded.** `Picking.js:1544-1545` lists `owner?.show` and `owner?.primitive?.show` among
  the provenance parts. So the machinery to notice drill's exclusion exists; the ordinary path simply
  never passes the owner that would activate it.
- **VERIFIED — the voxel path 1,150 lines earlier already does the right thing.**
  `Picking.js:505-512` passes `voxelPrimitive`, `voxelReadbackIdentity.atlasReuseEpoch`,
  `voxelReadbackIdentity.contentRevision` **and** `getCenterPixelViewProvenance(scene,
  voxelPrimitive)`. The pattern the ordinary path is missing is already shipped one family over.
- **VERIFIED — the cache equality carries no content or owner term.**
  `WebGPUPickFramebuffer.ts:568-588` compares logical/copy geometry, two generations and the
  provenance string. Nothing else.
- **VERIFIED — the sentinel finding, and it is worse than "a long loop".**
  `PickingRayHelpers.js:387-393`: `drillPickLoop(pickCallback, limit)` sets `limit =
  Number.MAX_VALUE` when undefined, and `:396-397` loops while the pick returns anything non-empty.
  `addDrillPickedResults` pushes each non-excluded result **before** hiding the primitive
  (`:351-355` push, `:365-384` hide). A stale readback returning the same feature therefore grows
  `results` without bound — unbounded memory, not merely a long loop.
- **VERIFIED — the `isWebGPU` branch is debug-only and is the sole one in the file.**
  `Picking.js:919` `if (scene?._context?.isWebGPU)`, inside `//>>includeStart('debug', pragmas.debug)`
  at `:918`. Retiring it discharges Core Principle 2 at zero runtime risk, and it repairs the
  companion defect that the warning is stripped from exactly the release builds that need it. The
  backend-neutral replacement is available: `GraphicsContext.ts:1013`,
  `get supportsSynchronousReadback(): boolean`.
- **RELAYED** — that a correct scene-wide content counter bumps every frame in any animated scene.
  Structurally obvious; not measured.

## The objective

The goal is **that a pick returns what is on screen now**, and the content axis is the half of that
which nothing currently checks. The temptation to name is different from B1's: the cheapest thing
that makes the *gate* pass is a scene-wide counter, and it will look correct in a static test scene
and be useless in any animated one — a term that changes every frame is equivalent to disabling the
cache, which is equivalent to never serving, which is the undefined the architecture exists to
remove. The instrument (a content term) must be built to the goal (correct serves), not to the test.

## Options — the content term

**Option 1 — Per-owner content revision, threaded like the voxel path.**
Each pickable owner carries a revision bumped at its own write sites; the provenance builder consumes
it when an owner is known.
*Pros:* this is the shipped pattern (`Picking.js:505-512`), so it is a generalization rather than an
invention; it does not invalidate on unrelated scene motion, so the cache keeps working in animated
scenes; it composes with the `owner?.show` parts already in the provenance list.
*Cons:* **the ordinary pick path does not know its owner before the pick** — that is the whole point
of picking — so this works for drill (where the owner is known after iteration 1) and for the voxel
and metadata families, but not for the cold first query. And "name the write sites that must bump it"
is an open-ended audit across every pickable primitive type; miss one and the term is silently
incomplete, which is the same defect class one level down.

**Option 2 — Scene-wide content counter.**
*Pros:* trivially complete — nothing can mutate content without bumping it; ~20 lines. *Cons:* it
bumps every frame in any animated scene, so the cache never serves there. It converts a correctness
term into a cache-off switch precisely in the scenes where picking is hardest.

**Option 3 — Hybrid: scene-wide counter as the fail-closed default, with per-owner refinement added
family by family** (voxel first, since it already exists; then drill; then metadata).
*Pros:* correct on day one for every family; the refinement is additive and each step is separately
verifiable; no open-ended write-site audit blocks the landing. *Cons:* the intermediate state serves
nothing in animated scenes, so the headline benefit arrives late and in pieces. It is also the option
most likely to stop at step one.

## Options — synchronous `drillPick`

**Option A — One capture, N exclusion-applied CPU decodes from that capture.**
Sync drill on a readback backend becomes a single GPU capture plus N decodes that skip already-excluded
IDs, each decoded iteration inheriting that capture's provenance and its age.
*Pros:* preserves the synchronous capability rather than reducing it; the answer is self-consistent
because all N iterations come from one rendered frame; drill's cap is then simply the auto cap
(2 frames under B1's clock), stated once. *Cons:* roughly 100 new lines of decode-side exclusion walk
in `WebGPUPickFramebuffer` — though it reuses the widened aperture `R-22` is adding anyway. And it is
**not equivalent to WebGL's drill**: WebGL re-renders between iterations, so a primitive hidden in
iteration 1 can reveal something that was fully occluded; a single capture cannot show that. The
divergence is bounded and nameable, but it is a divergence and must be documented, not glossed.

**Option B — Accept the reduction: synchronous `drillPick` returns at most one object on a readback
backend, with a documented, feature-detectable unsupported state beyond that.**
*Pros:* honest and cheap; matches `FAR-107`'s stated policy for sync on WebGPU ("may return only an
already-complete result whose entire query/generation identity matches; otherwise it reports a
documented, feature-detectable unsupported state"). *Cons:* it is a capability loss shipped under a
banner of not removing features, and `R-16`'s whole reframe was that drill is not exceptional. Making
drill the one family that returns less would re-create the carve-out the ruling deleted.

**Option C — Keep the current behaviour for sync drill and rely on the debug warning.**
*Pros:* zero work. *Cons:* the current behaviour is the LD-16 defect — the same feature repeatedly, or
empty — and the warning is stripped from release builds. This is the status quo the sentinel was
ordered against.

## Recommendation

**Option 3 for the content term and Option A for sync drill**, with two costs stated up front.

The content-term cost: **Option 3's first step serves nothing in animated scenes.** If that state
persists — if the per-owner refinement never gets scheduled — the fork has paid for a correctness term
by disabling its own cache. Guard against that by naming the first refinement (voxel, which already
exists) in the same ruling, so step two is ordered rather than hoped for.

The drill cost: **Option A is ~100 lines and is not byte-equivalent to WebGL drill.** Occlusion
revealed by hiding a nearer primitive cannot appear in a single capture. That divergence must be
written into the JSDoc and into `SHADER_PAIRS_LOCKSTEP`-style pair documentation, not discovered by a
user. I still prefer it to Option B because a family that silently returns one result where it used to
return many is the harder failure to notice.

Land the **iteration sentinel first**, as ruled — it is a bounded-memory fix independent of everything
above, it lands on both backends per Core Principle 5, and it does not need any of these decisions.

---

# B4 — `R-2026-08-17-11` (residual): where the freshness term is carried, and what `available` means

**Already corrected, not reopened here.** The corrections block has narrowed "no caller can observe a
wrong result" to the **pose** axis and made the content axis a stated precondition of the legacy
mapping. That discharges the audit's first finding and **mutual conflict 1**. The request/response
vocabulary split and the CPU-resolvable exemption are confirmed sound and are not in question.

**Depends on B1** (the age term needs a clock) **and B3** (the content axis is now a precondition of
the legacy mapping, so B3's answer sets B4's schedule).

## The question

Three residuals. **(1) Transport:** the freshness report is specified as a single scalar sidecar,
`Scene.lastPickInfo`, which the next pick of any family overwrites — including the N internal picks a
single `drillPick` performs. **(2) Vocabulary:** the response carries a frame-age term and **no pose
or location term**, so `available` after a large camera swing hands back an ID for a different world
point while reporting only "cached, 7 frames". **(3) Naming and sequencing:** whether `latest` should
be `revalidate`, and whether stage S1 lands ahead of the legacy mapping. **Mutual conflict 2 also
lives here**: `R-11` defines `available` as "return whatever exists now, however stale" while `R-22`
imposes an 8-frame ceiling and calls it "the direct expression of `R-11`."

## Evidence

- **VERIFIED — `Scene.lastPickInfo` does not exist yet.** `grep -rn "lastPickInfo"
  packages/engine/Source/Scene/` returns nothing. This is a design decision about a public shape that
  has not shipped, which is the cheapest possible moment to change it.
- **VERIFIED — `drillPick` calls `this.pick()` N times inside one synchronous call.**
  `Picking.js:930-944` (the callback) driving `drillPickLoop` (`PickingRayHelpers.js:387-397`). A
  scalar sidecar would describe the last inner iteration, not the drill.
- **VERIFIED — this exact defect was already hit, diagnosed and fixed one file away, and the reason is
  written at the constant.** `WebGPUPickFramebuffer.ts:29-34`: *"a multi-property `pickMetadata` sweep
  arms one readback per property inside a single task, so a single-slot cache let only the last-armed
  identity ever publish and starved every earlier one forever"* → `CENTER_PIXEL_CACHE_CAPACITY = 8`,
  LRU-evicted and keyed by identity. The proposed sidecar re-creates, on the disclosure channel, the
  defect the data channel already fixed.
- **VERIFIED — the location bit is free.** `WebGPUPickFramebuffer.ts:568-588` already compares
  `viewProvenance` as part of `_readbackRegionsEqual`; publishing whether it matched costs one boolean
  the comparison has already computed.
- **VERIFIED — the pose/content asymmetry that makes the location term necessary.** The ordinary path
  passes no owner (`Picking.js:1666`) while the provenance builder would consume `owner?.show` and the
  owner model matrix if one were passed (`:1544-1552`). Zero pose delta with changed content is
  therefore reachable, and the response as specified cannot express it.
- **RELAYED** — the `pickHoverAsync` two-slot coalescer and `pickPreciseAsync` queueing behind an
  in-flight pick. I did not re-read those code paths; the `drillPick` case alone is sufficient to
  decide the transport question.

## The objective

The standing directive is *"there must be no mysteries when picking."* A disclosure channel that a
well-behaved consumer silently loses does not satisfy it — and it fails **exactly when picking is
busiest**, which is when the caller most needs to know. The instrument here (one mutable global) is
cheaper than the goal requires, and the fork has already paid once for that exact economy.

## Options — transport

**Option 1 — Freshness rides ON the result for every API that returns an object or a promise**
(`pickAsync`, `pickHoverAsync`, `pickPreciseAsync`, `drillPickAsync`, and a new parameterised entry
point returning `{object, freshness}`); the sidecar is kept **only** for legacy `scene.pick()`, whose
signature genuinely cannot change, and even there it becomes a small keyed LRU in the shape of
`CENTER_PIXEL_CACHE_CAPACITY`.
*Pros:* one additive field, no existing signature changes; the caller who asked gets the answer to
their own question; it matches the shipped return-by-value convention
(`getFeatureRendererReadiness(key)`, `GraphicsContext.ts:2022`); ~10 lines the LRU already costs one
file away. *Cons:* one extra public method and a public shape that is array-valued for drill —
a small API surface increase, taken now rather than after callers depend on the scalar.

**Option 2 — Scalar sidecar as ruled.**
*Pros:* zero signature change anywhere; one property to document. *Cons:* wrong for `drillPick` by
construction, and wrong for any two concurrent queries. It is the defect
`CENTER_PIXEL_CACHE_CAPACITY = 8` exists to record.

**Option 3 — Sidecar, but array-valued, holding the last N reports.**
*Pros:* cheaper than Option 1; drill's N iterations survive. *Cons:* the caller must guess which array
entry is theirs. A global keyed by nothing is still a global; it just fails less obviously.

## Options — the location term and `available`'s ceiling (conflict 2)

**Option 4 — Add `cached({ageFrames, sameProvenance})` and reframe `R-22`'s 8 as a RETENTION bound,
not a SERVE bound.** The ring holds 8 entries (derived from bytes: 8 x 16,128 = 126 KiB); `available`
serves whatever the ring holds and always discloses `ageFrames`.
*Pros:* discharges conflict 2 without either ruling losing; a caller asking for `available` at age 9
gets whatever exists rather than a `cold` — which was the entire point of `available`. It also
discharges `R-22`'s own admission that the 8 was inherited from Snap without derivation, by giving it
one. The location bit is free (previous evidence bullet). *Cons:* `R-22` must be recorded as
**amended** by this, not as expressing it — a small governance cost this packet's A1 order makes
cheap.

**Option 5 — Keep the 8 as a serve ceiling and narrow `available`'s definition to match.**
*Pros:* one number, one meaning; simplest to implement. *Cons:* at 60 Hz, 8 frames is 133 ms — so
`available` reintroduces `undefined` at 133 ms, which is the failure the whole design exists to
remove. The request vocabulary would then have no way to say "I truly do not care how old it is."

## Options — naming and sequencing

**Option 6 — Rename `latest` to `revalidate`.** Free now, breaking after release. `latest` reads as
"the newest one you have" (a cache preference) when it means "go get a fresh one" (a revalidation
directive). *Pro:* removes a name that will be misread. *Con:* it diverges from the HTTP directive set
the vocabulary was praised for matching; the alternative is to adopt `no-cache` / `only-if-cached` /
`default` outright and inherit the whole vocabulary rather than half of it.

**Option 7 — Land stage S1 (repoint `Viewer.js:238` to `pickAsync`) FIRST, ahead of the legacy
mapping.** *Pro:* it fixes the LD-01/LD-02 headline at effort S with zero engine-semantics risk, and
it does not wait on B3's content term. *Con:* it changes `Viewer` behaviour ahead of the picking
architecture it anticipates, so if the architecture changes shape the repoint may need revisiting.

## Recommendation

**Option 1 + Option 4 + Option 6 (rename) + Option 7 (S1 first).**

The costs: **Option 1 adds a public method and makes the drill report array-valued** — a public-shape
change, made now because making it later is breaking. **Option 4 requires recording `R-22` as amended
by `R-11` rather than as expressing it**, which is a documentation obligation someone must actually
discharge. **Option 7 delays the legacy `pick()` → `auto` mapping behind B3's content term**, which
means the ruled headline ("existing callers stop seeing `undefined`") arrives later than `R-11`
implied — but S1 delivers the user-visible half of that headline immediately and without the risk.

On the rename I will state the honest tension rather than pretend it is free: renaming `latest` to
`revalidate` improves clarity but breaks the 1:1 HTTP mapping that the audit specifically confirmed as
the vocabulary's strongest property. If the maintainer values that mapping, the consistent move is to
adopt the HTTP names wholesale (`no-cache` / `only-if-cached` / `default`), not to rename one member.

---

# B5 — `R-2026-08-17-23`: which triggers may prewarm the pick pipeline

**Depends on B4** — whether the depth family (`pickPosition`, `sampleHeight`, `clampToHeight`) counts
as a "pick family" for triggering is the same question as `R-11`'s CPU-resolvable exemption.

## The question

`R-23` forbids prewarming the pick pipeline "by scene construction alone" and offers three candidate
triggers, one of which is "a registered pick-driven input handler." **Every `Viewer` registers one
unconditionally in its constructor**, so that trigger is operationally identical to the thing the
constraint forbids. The decision is which triggers survive. **Mutual conflict 3 also lives here**:
`R-4` and `R-23` legislate `maximumPickWarmupAttempts` in opposite directions, eleven entries apart,
neither referencing the other.

## Evidence

- **VERIFIED — `Viewer` registers two pick-driven handlers with no option guard.**
  `packages/widgets/Source/Viewer/Viewer.js:1167-1174`: `setInputAction(pickAndSelectObject,
  ScreenSpaceEventType.LEFT_CLICK)` and `setInputAction(pickAndTrackObject,
  ScreenSpaceEventType.LEFT_DOUBLE_CLICK)`. I read the surrounding 80 lines — they sit in the
  constructor's main body alongside the unconditional `eventHelper.add` calls, inside no `if`.
- **VERIFIED — and the trigger is undetectable in principle.** `setInputAction` takes an opaque
  callback; nothing can distinguish a picking handler from a non-picking one without executing it.
  This is the declarative-boolean defect option V3 was rejected for, re-entering through the automatic
  path.
- **VERIFIED — the prewarm precedent is real, and the audit's citation correction is right.** The
  flag is `Scene.js:5298`, `this._webgpuPickHoverEnabled = true`, with the in-code comment *"so the
  model renderer builds the dither pipeline variant on the next update tick"*. It is **not** at
  `Picking.js:136-175`, which is the two-slot coalescer.
- **VERIFIED — the globe half is safe only because of a default the ruling never states.**
  `Globe.js:123` `this.pickable = false;` and `:1276` `if (this.pickable) {` guarding the pick-ID
  mint, with `:1266-1275` recording that `createPickId` is the backend-agnostic `GraphicsContext` API
  and works on WebGL too. Making WebGL mint globe pick IDs changes upstream behaviour; Principle 1
  is satisfied **only** because the default is false. That condition belongs in the ruling text.
- **VERIFIED — conflict 3 is live and the constant is triple-pinned.**
  `Tools/visual-regression/lib/c12-29-s5-custom-ellipsoid-gate.mjs:123`,
  `maximumPickWarmupAttempts: 8`; asserted at `c12-29-s5-custom-ellipsoid-gate.spec.mjs:2059`
  (`assert.equal(…, 8)`); the loop's source text is pinned by regex at `:4365`
  (`/while \(warmupResults\.length < contract\.maximumPickWarmupAttempts\)/u`); and the loop itself is
  at `probe-c12-29-s5-custom-ellipsoid.mjs:3952`. `R-4` keeps the 8 and adds route proofs; `R-23`
  retires the retry loop to 1 behind awaited readiness. `R-4` also requires "a fresh S5 run" against a
  gate `R-23` rewrites.
- **RELAYED** — the P-4 figure (2,674 ms colour-pipeline coupling dominating first-pick latency) and
  its assignment to stage S3. Not re-measured.

## The objective

The goal is **that the first pick a user makes is fast**, and the constraint exists because prewarming
at construction makes every non-picking application pay for a pipeline it never uses. A trigger that
fires on every `Viewer` satisfies the letter of the constraint and defeats its purpose. Worth naming
plainly: the audit's own note is that P-4 dominates first-pick latency anyway, so **prewarm was never
going to fix the first pick**. If that holds, the honest framing of `R-23` is "avoid a needless
construction-time cost", not "make the first pick fast" — and the trigger set should be chosen for
detectability, not for coverage.

## Options — the trigger set

**Option 1 — Reduce to FIRST PICK CALL OF ANY FAMILY, plus optionally `Globe.pickable = true`.**
Delete "a registered pick-driven input handler" with the `Viewer.js:1167-1174` evidence recorded so it
cannot be re-proposed.
*Pros:* both survivors are unambiguous explicit intent and both are free to detect; the negative
control becomes assertable (a scene constructed with a `Viewer` and never picked must show **zero**
pick-pipeline compiles). *Cons:* the first pick of a session still pays cold-compile latency. Under
the P-4 finding that is true of every option, but it should be said rather than implied.

**Option 2 — Keep all three triggers as ruled.**
*Pros:* widest prewarm coverage; the first click in a `Viewer` is warm. *Cons:* it is
construction-time prewarm with an extra step, for every `Viewer` ever created, and no assertion can
verify the constraint because the handler's intent is opaque. A binding constraint that cannot be
asserted is a comment.

**Option 3 — Keep the handler trigger but require an explicit opt-in flag on `setInputAction`.**
*Pros:* restores detectability; a handler that declares itself pick-driven is a real signal.
*Cons:* it is a public API change to `ScreenSpaceEventHandler` for a performance hint, and it is the
declarative boolean V3 was rejected for — just relocated to the caller.

## Options — conflict 3 sequencing

**Option 4 — `R-4`'s repairs land and the fresh S5 run executes against the 8-attempt gate FIRST;
`R-23`'s retirement to 1 lands only after the readiness capability (S2) ships, and requires its own
re-run.**
*Pros:* each run validates one change; the `R-4` dispositions are testable in isolation, which is the
entire reason `R-4` ordered a fresh run. *Cons:* one extra S5 family run — six probes at the 645 s
process watchdog, about **1.08 h** of exclusive Edge time on an already-loaded serial lane.

**Option 5 — Land both together and run once.**
*Pros:* saves ~1.08 h of Edge time. *Cons:* if the single run is red, nothing distinguishes an `R-4`
repair defect from an `R-23` readiness defect, and the triple-pinned constant means the spec churn is
entangled with the measurement. That is the confounded-experiment shape the fork's interleaved-A/B
protocol exists to prevent.

## Recommendation

**Option 1 + Option 4.** Costs: **Option 1 leaves the first pick cold** — and I want to be explicit
that this makes `R-23`'s value proposition smaller than it reads, because P-4 dominates that latency
regardless. **Option 4 spends about 1.08 h of exclusive Edge time** to keep two changes separable.
Given that this packet's owed-browser-time picture is already 5.6-9.4 h on one serialized lane, that
hour is a real allocation, not a rounding error — but a confounded S5 run costs the same hour *and*
answers nothing.

Three riders: **state the `Globe.pickable` default-false condition in the ruling** (it is the only
reason the globe half satisfies Principle 1); **name the negative control** — a `Viewer` constructed
and never picked shows zero pick-pipeline compiles — because it is the only thing that actually
enforces the constraint; and **correct the `Picking.js:136-175` citation to `Scene.js:5298`**.

---

# C1 — `R-2026-08-17-24`: what makes the C12-33 pre-registration credible

## The question

`R-24` demoted a self-derived envelope, anchored 72 of 88 bounds to a known-bad control, pre-registered
a ratio `r`, and predicted that the first certifying run will be RED. All four moves are right. The
binding condition names **no custody mechanism** — nothing distinguishes a genuine pre-registration
from "run the ten-run set, look at the spread, then set `r`." The question is which custody mechanism
to require, and whether the run is blocked until it exists.

## Evidence

- **VERIFIED — the subject is uncommitted right now.** `git status --porcelain` reports
  ` M Tools/visual-regression/lib/moon-mip-motion-certification.mjs`,
  ` M Tools/visual-regression/moon-mip-motion-certification.spec.mjs`,
  ` M Tools/visual-regression/probe-moon-mip-motion-edge.mjs`. The C12-33 re-scope is **executed but
  uncommitted**, so the thresholds have no commit for a pre-registration commit to be an ancestor of.
- **VERIFIED — the sha256 machinery already exists in the probe.**
  `probe-moon-mip-motion-edge.mjs:274-275`, `function sha256Bytes(bytes) { return
  createHash("sha256").update(bytes).digest("hex"); }`. The calibration block it would need to hash is
  at `:188`, `export const PAIRED_SENSITIVITY_REQUIREMENTS = Object.freeze([…])`.
- **VERIFIED — `runtimeIdentity` hashes served resources only.** `:1157-1200` builds entries of
  `{url, byteLength, sha256}` for served assets and `{path, byteLength, sha256}` for local ones. It
  carries no hash of the probe source and none of `PAIRED_SENSITIVITY_REQUIREMENTS`. There is no
  producer-source hash anywhere in the report, so no "before" clock exists.
- **VERIFIED — the run cost.** `probe-moon-mip-motion-edge.mjs:62`, `const WATCHDOG_MS = 900_000`.
  A ten-run set is 10 x 900 s = **2.50 h** of exclusive Edge time.
- **VERIFIED — the neighbouring practice is already correct**, which is why this is a pointing problem
  rather than a machinery problem: `MOON_MIP_SAMPLE_COUNT` is a frozen constant asserted against the
  report, and the same idiom appears in `ECLIPSE_CLOUD_BANDS`, `PRE_REGISTERED_D1_CODES` and the
  cloud-march transfer spec. The convention exists; it is simply not aimed at the calibration
  authority.
- **RELAYED** — that git author/committer dates are writer-controlled. True by construction, and
  `R-2026-08-17-1` exists because this fork already knows it.

## The objective

The goal is that **a red result cannot be repaired by moving the bar**. A pre-registration whose only
anchor is a writer-controlled timestamp does not achieve that; it documents an intention. This matters
most precisely here, because `R-24` **predicts a first-run RED** — which is exactly the moment when
the cheapest available action is to adjust `r` and re-run, and nothing would show that it happened.

## Options

**Option 1 — Hash the calibration block into every report and assert it.**
The probe computes sha256 over its frozen calibration block (`PAIRED_SENSITIVITY_REQUIREMENTS`, the
metric and threshold key sets, the lane definitions, and the pre-registered `r`) and writes it as
`preregistrationSha256`. The certification spec asserts every report in the ten-run set carries the
**same** hash and that it equals the hash recomputed from committed source.
*Pros:* ~20 lines reusing the existing `sha256Bytes` helper plus two spec assertions; it makes a
mid-set bar change mechanically visible; it uses the fork's most-replicated convention.
*Cons:* it forecloses mid-set repairs — **a legitimate probe fix invalidates the set and forces a
2.5 h re-run.** That is correct behaviour and it is expensive. It also blocks the run until the
re-scope is committed, which quiet hours push to after 19:00.

**Option 2 — Add `preRegistrationCommit` to the manifest and assert `git merge-base --is-ancestor`.**
*Pros:* cheap; ties the run to a commit. *Cons:* the anchor is a git date, which is writer-controlled,
and the quiet-hours rule systematically makes a constant's commit date post-date its authoring — so
the anchor is weakest in exactly this repo. It proves ordering against a clock the author sets.

**Option 3 — State the pre-registered `r` in the ruling text itself.**
*Pros:* free, and the ruling series is add-only and top-tier under A1's order, so the value becomes
un-editable in practice. Cheapest credible custody available. *Cons:* it covers `r` alone; the rest of
the calibration block (lane definitions, threshold key sets) stays uncovered, and those can be moved
to the same effect.

**Option 4 — Accept the pre-registration as ruled, with no custody mechanism.**
*Pros:* the run starts tonight; 2.5 h is spent once. *Cons:* the resulting certification cannot
distinguish itself from a fitted one. Given that `R-24`'s own value came from demoting a
self-derived envelope, shipping a pre-registration that is credible only by assertion undoes the
ruling's point.

## Recommendation

**Option 3 immediately, plus Option 1 before the ten-run set executes.** Stating `r` in the ruling
costs nothing and can be done in the next ruling entry; the hash is what covers the rest of the block.

The cost, stated: **Option 1 blocks the 2.5 h set until the C12-33 re-scope is committed**, and
committing it is subject to quiet hours, so the earliest start is after 19:00 ET. And once the set is
running, a legitimate probe bug found at run 6 costs the whole set. If the maintainer judges that
unacceptable, the honest fallback is Option 3 alone with the limitation recorded in the certification
report — **not** Option 4, which is Option 3 minus the one free thing.

---

# C2 — `R-2026-08-17-14`: promoting two scratch scripts, and what clock decides when a scratch file expires

## The question

`R-14` promotes `viewer-smoke.mjs` and `co41-loading-check.mjs` out of `output/` with `@status
ACTIVE`, discards `sunbloom-flip-diag.mjs`, and orders a three-leg detector — referenced by a tracked
file **or** `@status ACTIVE` **or** aged past a threshold — to catch future scratch files that should
have been promoted. **All three legs fail against the ruling's own founding cases.** Two questions:
what replaces the detector, and whether the promoted files must be renamed to fall inside the fleet
contract.

## Evidence

All **VERIFIED** by direct inspection.

- **Leg (a), "referenced by a tracked file", fires on the file being discarded.** All three files are
  named in tracked prose at `Tools/visual-regression/archive/README.md:53-56`, in a paragraph whose
  whole purpose is to record that *"They are untracked by design."* The leg fires because a README
  documenting their untracked status mentions them.
- **Leg (b), "`@status ACTIVE`", would have caught neither founding case.** All three headers read
  `@status INVESTIGATION` (`viewer-smoke.mjs:6`, `co41-loading-check.mjs:4`,
  `sunbloom-flip-diag.mjs:6`). The leg keys on the very label whose unreliability created the finding.
- **Leg (c), "aged past a threshold", has no trustworthy clock.** All three files show mtime
  `Aug 16 16:40` — identical, a checkout artifact. `output/` is gitignored, so git carries no dates.
  `touch` resets every clock in one untraceable command and a fresh CI clone sees every file as new,
  so the verdict differs between two machines looking at identical content.
- **Neither promoted file has a watchdog.** `grep -c setTimeout` returns **0** in all three files.
- **Neither promoted name falls inside the governing spec.**
  `probe-fleet-contract.spec.mjs:66-70` globs exactly `f.startsWith("probe-") && f.endsWith(".mjs")
  && !f.endsWith(".spec.mjs")`. `viewer-smoke.mjs` and `co41-loading-check.mjs` match neither that nor
  the purpose-header scope. Promoting them as named lands two permanently-tracked, browser-driving
  guards inside the governed directory while being structurally invisible to the spec that governs it.

## The objective

The goal is **that a browser-driving guard which lives forever is governed forever**. The three-leg
detector is aimed at a different goal — finding files someone forgot — and it is aimed badly. Worth
separating the two: promotion hygiene (a real, cheap fix) and forgotten-file detection (a hard problem
with no trustworthy clock in a gitignored directory).

## Options — the detector

**Option 1 — Replace the mtime leg with a DECLARED expiry.** Require `@expires YYYY-MM-DD` (or
`@created`) in the header block the purpose-header contract already parses; fail when it is absent or
passed. Drop leg (a) entirely as a false-positive generator.
*Pros:* the clock moves into reviewed text, so extending a file's life becomes an explicit edit rather
than an untraceable `touch`; it is machine-identical across clones; ~15 lines of guard plus one header
line per scratch file. *Cons:* you lose the ability to catch an unreferenced, non-ACTIVE, genuinely
forgotten file — which is the lowest-harm case in the set and the only one leg (c) was ever going to
find.

**Option 2 — Option 1, plus have the harness MOVE an expired `output/*.mjs` into `archive/` rather
than failing a guard.**
*Pros:* the default outcome becomes preservation-with-visibility instead of an unowned red that
somebody has to clear; it matches the fork's Principle-7 instinct of preferring preservation to
deletion. *Cons:* an automatic move is a write the harness performs on its own initiative, which needs
its own care in a repo with lane leases; and a file that moves itself can surprise a lane mid-work.

**Option 3 — Keep the three legs as ruled.**
*Pros:* nothing to redesign. *Cons:* 0-for-2 on its founding cases, with a verdict that differs
between two machines looking at identical content.

## Options — the promotion

**Option 4 — Rename on promotion to `probe-viewer-smoke.mjs` and `probe-co41-loading.mjs`, and satisfy
the fleet contract before landing** (terminating watchdog, keep the existing `finally`-close and
`@purpose` header, route unevaluable outcomes to exit 3).
*Pros:* two renames plus ~10 lines of watchdog each; both files land inside the spec that governs
every other long-lived probe; it closes the ungoverned-by-filename class rather than opening it.
*Cons:* ~20 lines added across two files that currently work, and the rename breaks any local muscle
memory or note that references the old names.

**Option 5 — Promote under the current names and add two allowlist rows.**
*Pros:* no rename, no watchdog work. *Cons:* `probe-fleet-contract.spec.mjs:621` documents that list
as closed and shrink-only, so this is a deliberate ratchet violation to save two renames.

**Option 6 — Leave both in `output/` and re-run them by hand when needed.**
*Pros:* zero work; they are honest one-offs. *Cons:* `R-14`'s premise is that they are regression
guards worth keeping, and a gitignored guard is not a guard.

## Recommendation

**Option 1 + Option 4.** Costs: **Option 1 gives up the forgotten-file case entirely** — a file that
is unreferenced, not ACTIVE, and carries no `@expires` will simply never be flagged, and if the
`@expires` requirement is only enforced on new files, existing scratch files stay invisible. Enforce
it on the whole `output/` directory at landing or the guard is decorative. **Option 4 costs ~20 lines
across two working files plus two renames**, which is the price of not creating a second class of
governed-by-nothing probe in the governed directory.

I would take Option 2's auto-move only if the maintainer wants it; it is strictly better on outcomes
and strictly worse on surprise, and in a tree with ~150 dirty paths across lanes, surprise is
expensive.

---

# C3 — `R-2026-08-17-17`: the Moon per-entry-point contract — **already executed**

**This one needs a yes, not a debate.** The amendment has been implemented in the working tree, in
the two-tier shape the audit recommended, and it is green.

- **VERIFIED — committed main is RED exactly as the audit reported.** I ran the `4abfabedad` version
  of the spec from a temporary copy: **5 tests, 4 pass, 1 fail.** (The copy was removed immediately;
  no tracked file was touched.)
- **VERIFIED — the working-tree version is GREEN and restructured per entry point.**
  `node --test Tools/visual-regression/moon-mip-lod-shader.spec.mjs` → **5 tests, 5 pass, 0 fail.**
  The file grew 138 → 215 lines and now extracts both `@fragment` bodies by brace matching
  (`:35-59`), asserting **per body**: exactly one `computeEllipsoidColor` call, the body's own
  `uvDx`/`uvDy` passed into it, `dpdx`/`dpdy` before the body's first `discard`, the longitude unwrap,
  and — the clause that closes the audit's own objection — `assert.doesNotMatch(body,
  /textureSampleGrad\s*\(/, "must sample through the shared helper")`.
- **VERIFIED — the audit's feared regression did not occur.** The whole-file negative clauses were
  **kept** at file scope (`:192-207`: no `textureSampleLevel`, no implicit `textureSample` on `tex` or
  `normalTex`), so they did not become vacuous. A new helper sampling with implicit derivatives would
  still red.
- **VERIFIED — the shader is as described.** `Moon.wgsl` has `@fragment fn fs` at `:520-521` and
  `@fragment fn fsPhysical` at `:617-618`; `computeEllipsoidColor` is declared at `:392` and the two
  `textureSampleGrad` calls are inside it at `:407` and `:433`.
- **VERIFIED — option D is already satisfied.** `Tools/visual-regression/moon-webgl-explicit-gradients.spec.mjs`
  exists, is `@status ACTIVE`, and runs **6 tests, 6 pass, 0 fail**, covering derivatives-before-discard
  on both Moon-path miss discards, longitude unwrap with explicit gradients on both channels, the
  WebGL1 demodernization fallback, and the front/back alpha composite. The lockstep pair registered at
  `SHADER_PAIRS_LOCKSTEP.md:239` therefore has mechanical enforcement on **both** sides.

**Decision required:** confirm the restructured spec lands with the current dirty set. The only
residual worth a sentence is the audit's suggestion to use naga's entry-point IR for real call-graph
reachability instead of brace matching — naga is already imported and called in this spec's fifth test
(`:200-215`). That is a refinement, not a defect: the retained file-scope negative clauses already
cover the hole reachability analysis would close. **Recommendation: yes, land it; leave the naga
call-graph idea as an optional follow-up with no owner and no date.** Cost of that recommendation:
brace matching stays, so a future restructure of `Moon.wgsl` into nested helper bodies could confuse
the extractor — which would show up as a red, not a false green.

---

# Mutual conflicts — which the four rulings closed, and which are still live

The audit recorded **ten** mutual conflicts. Six are discharged; four survive.

## Closed by the four rulings and the un-ruled corrections

| # | Conflict | Closed by | How |
| --- | --- | --- | --- |
| 1 | `R-11` vs `R-16` — "no caller can observe a wrong result" vs LD-16, a confirmed wrong-result defect on the content axis | **Corrections block** | `R-11`'s claim narrowed to the **pose** axis; the content axis made a stated precondition of the legacy mapping. The "land S1 first" half is a sequencing recommendation and is carried in **B4**. |
| 4 | `R-12` vs `R-19` — `.mcp.json` is gitignored, so `git add -A` cannot stage it and porcelain cannot see the omission | **`R-2026-08-18-26`** | Tracked `.mcp.json.template` mirror; `.mcp.json` stays ignored. Nothing needs force-adding, so the conflict dissolves rather than being arbitrated. |
| 5 | `R-13` vs `R-19` — no sandbox configuration satisfies both | **`R-2026-08-18-28`** | Worker stays read-only; the orchestrator commits from its own tree. |
| 6 | `R-13` vs `ORCHESTRATION_HANDBOOK.md:61` `[HARD]` | **`R-2026-08-18-28`** | The handbook's rule governs; `WORKER_ISOLATION` section 7 and `R-13`/`R-19` are amended to match. *The document edits are still owed — that is execution, not an open decision.* |
| 7 | `R-9` vs `R-2026-08-14-1` | **`R-2026-08-18-27`** | `refreshCostMeasured` keeps its eligibility role; a new budget-backed predicate becomes the FAIL-capable one after SOL-4 lands. |
| 8 | `R-21` vs charter section 3.6 — a median-relative bar moves when the mandated retirement ritual archives small probes | **`R-2026-08-18-29`** | Frozen ratchet at 3,156 with a shrink-only allowlist and a >10% median-drift failure. |

## Still live

### Conflict 2 — `R-11` vs `R-22`: what `available` means

`R-11` defines `available` as "return whatever exists now, **however stale**". `R-22` imposes an
8-frame ceiling and describes it as "the direct expression of `R-11`" rather than as a narrowing of
it. At 60 Hz, 8 frames is **133 ms** — so a caller asking for `available` at frame-age 9 gets `cold`,
reintroducing at 133 ms the exact `undefined` the design exists to remove.

**Proposed resolution.** State in `R-22` that it **amends** `R-11`, and reframe the 8 from a **serve**
bound into a **retention** bound — ring depth, derived from bytes: 8 x 16,128 = **126 KiB** (verified
arithmetic, see B1). `available` then serves whatever the ring holds and always discloses
`ageFrames`. This also discharges `R-22`'s own admission that it inherited the 8 from Snap without a
derivation. **Owned by B4; do not rule it separately.**

### Conflict 3 — `R-4` vs `R-23`: `maximumPickWarmupAttempts`

Both legislate the same triple-pinned constant in opposite directions, eleven entries apart, neither
referencing the other. `R-4` keeps 8 and adds route proofs; `R-23` retires the retry loop to 1 behind
awaited readiness. `R-4` also requires "a fresh S5 run" against a gate `R-23` rewrites.

**Proposed resolution.** Sequence explicitly: `R-4`'s repairs land and the fresh S5 run executes
against the **8-attempt** gate first, since that run is what validates `R-4`'s three dispositions in
isolation; `R-23`'s retirement lands only after the readiness capability (S2) ships and requires its
own re-run. **Cost: about 1.08 h of extra exclusive Edge time**, in exchange for knowing which change
caused which result. **Owned by B5.**

### Conflict 9 — `R-15` vs charter section 0.2: the credential switch

`R-15` rejected option R4 for re-installing a self-service credential-switch instruction against
charter section 0.2, then adopted an option naming `ORCHESTRATION_HANDBOOK` section 3 as the
identity/auth authority — and handbook `:129-131` `[HARD]` reads *"A 403 on push means the wrong gh
account is active — `gh auth switch`, it is not a permission loss."* Charter section 2.6 as it stands
on disk (`:156-162`) is the safer text.

**Proposed resolution.** **Subordinate rather than delegate.** Amend handbook section 3 to *"report
the 403 and the active account; switch only when the current task places that action in scope,"* so
the pointer stops importing the rejected instruction. This touches a tracked `[HARD]` block and
therefore needs charter section 4.6 non-author review. **Owned by A1.**

### Conflict 10 — `R-6` layer 1 vs layer 2: rule and exception, not parallel layers

`R-6` asserts its three layers "do not conflict." Layer 2's entire subject — a doc-only commit
narrating code work — is layer 1's rejection set. Layer 1 rejects it unconditionally; layer 2 admits
it on producing a SHA. **This conflict belongs to no amendment in the eleven**, so it needs its own
disposition.

**Independently re-derived.** Over the newest 200 commits I isolated the newest **19 doc-only
commits** (every touched path under `migration_doc/`) and classified their bodies with a coarse
keyword test for code/spec/gate/probe work claims: **13 of 19 = 68%** would be rejected by layer 1 as
stated. The audit reported 14/19 = 74% with its own classifier. Different classifiers, same
conclusion: **layer 1 as written rejects a large majority of this fork's own doc-only commits**,
including, per the audit, the charter itself. My figure is the lower bound of the two and is enough to
settle the question.

**Proposed resolution.** Collapse layers 1 and 2 into one rule: *a doc-only commit making a
first-person perfective work claim must carry a `Lands: <sha>` trailer resolving to a commit that
touches a non-`migration_doc/` path; absent the trailer it is rejected.* That removes the prose
classifier entirely and drops the false-positive rate to zero by construction. Layer 3 (staged-set
equality) is unaffected and stays — noting A2's finding that under `git add -A` it is a regression
anchor rather than a live detector.

*Honest cost:* the `Lands:` trailer is a manual step on every doc commit that narrates code work, and
a wrong SHA is only caught if something resolves it — so the rule needs a resolver, not just a
convention. That resolver is ~20 lines and belongs in the same landing.

---

# Residuals from the four already-ruled amendments

Not for re-litigation. One item is genuinely uncovered and should not be lost.

**`R-2026-08-18-29` covers the house-scale bar only; the `R-21` amendment's P10 half is untouched.**
`R-21` also ordered the prohibited-canvas-reader detector ported into `probe-fleet-contract.spec.mjs`
over the known probe population, naming **neither the ratchet nor the violation count** — the one
fact the fork's allowlisted-vs-not convention turns on.

**Re-derived on the live tree.** The fleet is **634** `probe-*.mjs` files (the audit counted 633; it
grew by one). **387** of them contain both `drawImage` and `getImageData` (the audit found 386). That
co-occurrence is an upper bound on offenders, not a count of them — the detector types the *receiver*,
and many of those 387 will be reading a 2D canvas the page owns rather than a WebGPU swap chain. But
it is emphatically **not zero**, and `R-25` has already split `screenshot` out of the prohibited set,
which is what keeps `co41-loading-check.mjs`'s element-screenshot-then-decode green.

Consequently the C6/C10/D5 form ("there is NO allowlist for this rule… the fleet is clean of it") is
almost certainly unavailable, and shipping it would red the spec on landing and block every unrelated
change. **Proposed disposition, one line to rule:** run the extracted receiver-typing layer over all
634 probes **before** landing, state the count in the ruling, and ship the C2-shaped companion — a
pinned `lib/probe-fleet-prohibited-reader-allowlist.mjs` with a reason plus git-derived add-date per
row and the three shrink-only ratchet assertions — so the list can only shrink and a **new** offender
reds immediately.

`HOUSE_SCALE_MAX_LINES` is **not yet in the tree** (`grep` finds no such identifier), so `R-29` is
ruled but unimplemented. One collision hazard worth knowing before someone greps for it:
`cloud-reconstruction-attachments.spec.mjs:904` already defines an unrelated `MARCH_WGSL_LINES = 3156`.

---

# Out-of-lane finding, reported not acted on

`node --test Tools/visual-regression/webgpu-pick-center-identity.spec.mjs` is **RED in this working
tree**: 9 tests, 8 pass, **1 fail** — *"metadata A to B to voxel cannot cross-publish at one
coordinate"* (`:319`), asserting *"voxel bytes must never satisfy a metadata query"*, actual
`Uint8Array [10,11,12,13]` where `undefined` was expected.

Attribution, checked: the spec file and `Picking.js` are both clean at `4abfabedad`;
`packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts` is the only dirty file in that
dependency set. **The red therefore belongs to another lane's uncommitted in-flight work, not to
main.** It is a fail-closed FAR-107 identity guard on the same subsystem the B group's five briefs
govern, so it is load-bearing for that programme — but diagnosing it is outside this lane and outside
this packet's path lease.

---

# Summary — the eleven decisions and their recommended answers

| # | Ruling | Decision | Recommended | Its cost |
| --- | --- | --- | --- | --- |
| A1 | `R-15` | The precedence order, `AGENTS.md`'s two false references, the credential pointer | Write six-tier section 0.4, demote four claimants to pointers, subordinate handbook section 3 | Edits a tracked `[HARD]` block (needs non-author review); a 403 costs a round trip |
| A2 | `R-19` | Guard order; `git add -A` scope | `verify-tracked-references.mjs` first, scoped fail-closed now, full walk when the tree is clean | Two landings; an untracked `lib/` module can still slip between them |
| A3 | `R-7` | Ledger repair vs schema migration | Schema migration, `warrantRuling` **required** | 23-entry back-fill that is a real read, not a `sed` |
| B1 | `R-22` | Epsilon budget, the clock, cap derivation | `2*epsilon`; rendered-frame clock; literals with a recomputing assertion | Honest headline drops to **10.7 deg/s at k=2** — orbit drag not reached |
| B2 | `R-3` | Conditionality; `PickDepth` scope | Restate as conditional; ship rotation-regime first; `PickDepth` a disclosed exception with S6 as reconciliation | Ships less than `R-3` ruled; depth capture (+16,128 B/pick) deferred |
| B3 | `R-16` | Content-term shape; sync drill | Hybrid content term (scene-wide, refined per-owner); one capture + N decodes for sync drill | Step one serves nothing in animated scenes; drill is not byte-equivalent to WebGL |
| B4 | `R-11` | Transport; location term; naming; sequencing | Freshness on the result; `cached({ageFrames, sameProvenance})`; 8 as retention; S1 first | New public method, array-valued drill report; legacy mapping delayed |
| B5 | `R-23` | Trigger set; conflict 3 sequencing | First pick of any family (+ `Globe.pickable`); `R-4` run first at 8 attempts | First pick stays cold; ~1.08 h extra Edge time |
| C1 | `R-24` | Pre-registration custody | State `r` in the ruling **and** hash the calibration block | Blocks the 2.5 h set until the re-scope is committed; a mid-set fix costs the whole set |
| C2 | `R-14` | Expiry clock; promotion naming | Declared `@expires`; rename to `probe-*` and meet the fleet contract | Forgotten-file case is given up; ~20 lines across two working files |
| C3 | `R-17` | Already executed | **Yes — land it** | Brace matching stays; a future nested-helper restructure would red, not falsely green |

**Owed browser time is unchanged by this packet** and remains the binding constraint: the audit's
figure is 5.6-9.4 h realistic on one serialized Edge lane, with a ~12.4 h ceiling. Three of the
recommendations above add to it (B5's separated S5 run, C1's re-run risk, B2's re-baseline of the
pick-identity spec) and none subtract from it.
