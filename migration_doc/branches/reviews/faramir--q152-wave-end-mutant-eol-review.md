# Faramir review — Q-152 mutant EOL harness repair

- Status: **COMPLETE / UNCONDITIONAL GO FOR ROOT MATERIALIZATION ONLY**
- Certification or H1/H0 claim: **none**
- Push authority: **none**
- Reviewer: Faramir
- Independent cross-check: Aragorn

## Frozen subject

- Clone: `F:/Dev/GH/cesium-lane-beren-q152-mutant-eol-20260830`
- Branch: `sol/q152-wave-end-mutant-eol-ca0de6918a-2026-08-30`
- Base/HEAD: `ca0de6918af091f2a68078f795b6c4362f159ca0`
- Tree: `0ee9029180924d22a87af8a37c1461d59ba3af06`

| Path | Bytes | SHA-256 | Filtered object |
| --- | ---: | --- | --- |
| `Tools/wave-end-gate.spec.mjs` | 39,365 | `8B3A631D792EF2EBA3245691E6460F54B96A488F9FDA1430751B833EA839AEE9` | `4544db37820f75157b03f7548fb626aae1866706` |
| `migration_doc/branches/beren--q152-wave-end-mutant-eol.md` | 8,949 | `565EBC220C582168E43087CEF883C23B55BC3ECE0E900CE1021ED7D031326CA5` | n/a |

Opening and terminal subject identities matched. The complete specification, handoff, candidate diff, relevant production paths, routed governance, and prior Q-152 safety review history were read. The candidate diff is exactly `+6/-7`, changes only `importBarrierMutant()`, and leaves the production gate unchanged.

The two unrelated modified governance files are provisioner-owned and excluded: `migration_doc/MAINTAINER_RULINGS_2026-08-17.md` and `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`. This report is the only reviewer-authored path.

## Semantic and EOL review

The repair replaces an EOL-sensitive multiline literal with the newline-free predicate `step?.bindability?.phase === "pre-spawn"` and requires exactly one occurrence before replacement. Production source contains exactly one target in `decidePreSpawnBindability`.

The predicate is shared by both barriers: `main` calls it before either an injected or default executor, and `executeStepPlan` calls it before the default child path. Replacing that unique predicate with `false` therefore disables both real enforcement sites. The executed production mutant requires the unmodified gate to remain STRUCTURAL with zero mocked adapter calls, then requires the mutated module to PASS after one mocked adapter call per canonical step.

The spec has 1,244 CRLF sequences and zero bare LF; the production gate has 1,936 CRLF and zero bare LF. The target itself contains no newline. The filtered object above binds logical content across raw EOL materializations. Root must rehash both destination bytes and filtered content after materialization.

## Test integrity and retained reds

Base and candidate each declare the same 29 tests. No test, assertion, negative control, skip guard, or runner wiring was removed or weakened. `package.json` retains this spec in `test-landing-rules`.

- Opening CRLF tuple: exit 1, 25/29 — **FIXED**; the LF-only mutant did not apply.
- Main-only repair: exit 1, 28/29 — **FIXED**; the still-active default-executor barrier proved that mutation incomplete.
- Behavior-green pre-format tuple: 29/29, Prettier exit 1 — **FIXED** by exact-path EOL formatting.
- Frozen tuple: 29/29 with all narrow checks green.

These are retained harness-specification reds, not product failures. No real gate, child, build, server, browser, Edge run, capture, publication, or evidence run occurred.

## Reproduced checks

| Command | Exit/result |
| --- | --- |
| `node --check Tools/wave-end-gate.spec.mjs` | 0 |
| `node --test Tools/wave-end-gate.spec.mjs` | 0; 29/29; zero fail/cancelled/skipped/todo |
| `.\\node_modules\\.bin\\eslint.cmd Tools/wave-end-gate.spec.mjs --no-cache --quiet` | 0 |
| `.\\node_modules\\.bin\\prettier.cmd --check Tools/wave-end-gate.spec.mjs` | 0 |
| `node Tools/c16/comment-marker-guard.mjs Tools/wave-end-gate.spec.mjs` | 0; no in-scope paths |
| `git diff --check -- Tools/wave-end-gate.spec.mjs` | 0 |

An exploratory read-only `git cat-file -s` on the computed but unstored working-object ID returned 128 because that object is not yet in the clone database. `git hash-object --path` computed the filtered ID above without writing it.

## Scope, cross-check, and verdict

All production certification blockers remain open: authoritative provenance, complete served identity, canonical child contracts, descendant quiescence, capture/baseline approval, immutable receipt lifecycle, operational runner/runbook, Edge execution, and a banked wave receipt. The landed safety boundary remains deliberately STRUCTURAL / exit 3 / zero real spawns.

Aragorn independently terminally matched the tuple, EOL census, filtered object, `+6/-7` diff, and 29-test retention, and returned unconditional GO for root materialization only.

**UNCONDITIONAL GO FOR ROOT-CONTROLLED MATERIALIZATION ONLY** of the exact candidate and handoff, with this review record if root banks it. This grants no commit, push, certification, H1/H0, build/browser/server/network/evidence, cleanup, reset, restore, retirement, deletion, or external authority. Logical candidate drift requires fresh validation, freeze, and review.

## Quiescence and actions

Post-validation process census found zero Node process naming this clone or the focused spec. Celebrimbor, Idril, and Aragorn are complete and quiescent.

Faramir authored only this review body; root transports it due the external patch failure. Faramir performed no candidate/handoff edit, Git write, build, browser, server, real gate/child execution, network, evidence, push, clone mutation, or external action.
