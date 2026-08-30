# Faramir — worker-handoff verifier explicit-lease repair

- Status: ACTIVE / UNFROZEN
- Tier-2 owner: Faramir
- Active writer: Samwise
- Test designer: Meriadoc
- Preregistered reviewer: Aragorn
- Base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Branch: `sol/verify-handoff-explicit-lease-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-faramir-handoff-verifier-20260829`
- Reap when: the repair is frozen, independently reviewed, locally landed or declined, and its receipt is repatriated; target 2026-09-05.
- Disk budget: 2 GiB.

## Declared path set

- `Tools/verify-worker-handoff.mjs`
- `Tools/verify-worker-handoff.spec.mjs`
- `package.json`

The existing paths were clean and the new spec path was absent at dispatch. The declared set does not overlap another open lease. The worker branch remains at the base; the orchestrator owns all Git operations.

At this snapshot, before the root bookkeeping commit, the worker branch ref and main ref were both at the dispatch base while the clone carried moving, unreviewed working-tree bytes. The bookkeeping commit may advance main without touching the leased implementation paths; every later assembly must audit the then-current main tip separately. Main's `Tools/verify-worker-handoff.mjs` is Git-clean but its raw checkout is 11,010 bytes / SHA-256 `E424EB48B6DFC0B0A423A50315D94F7C17F824D6D16B64F803E08806203290C7`, different from the untouched same-base clone materialization. Treat the root bytes as foreign target input and hold any raw-file transfer, assembly, or landing until root proves the checkout/line-ending cause and target convention. The repair must then be assembled before Théoden's explicitly leased provisioned document can pass mechanical hand-in. Do not review, reset, restore, retire, delete, or reuse this clone until Faramir freezes a tuple and root confirms quiescence.

## Validation authority correction

- Workers may author the temporary-Git-fixture spec but may not execute it: R-2026-08-18-28 reserves every Git write to the orchestrator, including Git writes inside OS-temporary test fixtures.
- Before that correction reached the lane, Samwise ran `node --test Tools/verify-worker-handoff.spec.mjs`: exit 0, 7/7, with Git writes confined to test-owned temporary fixtures. Preserve this as an authority incident, not bankable validation.
- `npm run test-landing-rules` had started under the same withdrawn authorization and was interrupted. It has no terminal exit or TAP result and is `ABORTED`, never green.
- Root independently confirmed the disclosed process-tree PIDs 18272, 16448, 19152, and 11900 were absent after termination. Root must rerun all Git-fixture validation after the candidate freezes.

## Dispatch constraints

- One deliverable: explicitly leased provisioned paths must be treated as authored, while unleased provisioned drift remains excluded.
- Add a non-vacuous Node behavioral spec using isolated temporary Git fixtures and wire it into the existing `test-landing-rules` runner.
- Preserve the tool's current `READY_FOR_REVIEW` vocabulary and exits; do not relabel it as a charter certification verdict.
- No worker Git writes, including inside test-owned temporary fixtures; no dependency installation, build, browser, server, network, evidence publication, or unrelated paths.
- Freeze exact bytes before independent review.
