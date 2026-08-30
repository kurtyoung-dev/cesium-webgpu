# Faramir — worker-handoff verifier explicit-lease repair

- Status: FROZEN / SOURCE REVIEWED / FINAL BOOKKEEPING REVIEW OWED
- Tier-2 owner: Faramir
- Writer: Samwise (quiescent)
- Test designer: Meriadoc
- Preregistered reviewer: Aragorn
- Base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Branch: `sol/verify-handoff-explicit-lease-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-faramir-handoff-verifier-20260829`
- Reap when: the repair is frozen, independently reviewed, locally landed or declined, and its receipt is repatriated; target 2026-09-05.
- Disk budget: 2 GiB.
- Push authority: none; local landing only.

## Declared path set

- `Tools/verify-worker-handoff.mjs`
- `Tools/verify-worker-handoff.spec.mjs`
- `package.json`

The existing paths were clean and the new spec path was absent at dispatch. The declared set does not overlap another open lease. The worker branch remains at the base; the orchestrator owns all Git operations.

Main advanced from the dispatch base only through the Batch 1330 bookkeeping paths before assembly. Root proved that the clean-checkout raw-byte divergence was line-ending materialization: filtered object identities matched the common base while main used LF and provisioned clones used CRLF. Root therefore applied the reviewed semantic patch rather than copying raw files, then rehashed the destination. All three destination files exactly match the frozen LF tuple below. Do not reset, restore, retire, delete, or reuse the clone until the local landing receipt is tracked and root confirms final quiescence.

## Validation authority correction

- Workers may author the temporary-Git-fixture spec but may not execute it: R-2026-08-18-28 reserves every Git write to the orchestrator, including Git writes inside OS-temporary test fixtures.
- Before that correction reached the lane, Samwise ran `node --test Tools/verify-worker-handoff.spec.mjs`: exit 0, 7/7, with Git writes confined to test-owned temporary fixtures. Preserve this as an authority incident, not bankable validation.
- `npm run test-landing-rules` had started under the same withdrawn authorization and was interrupted. It has no terminal exit or TAP result and is `ABORTED`, never green.
- Root independently confirmed the disclosed process-tree PIDs 18272, 16448, 19152, and 11900 were absent after termination. Root reran all Git-fixture validation after each later candidate freeze; the final results are below.

## Frozen tuple, review, and root validation

The writer stopped before review. Aragorn independently rehashed the initial semantic tuple, reviewed the complete diff, and returned GO with no unresolved source finding. Root's mandatory Prettier check then found the new spec nonconforming, invalidated that exact-tuple review, and formatted only the spec. Aragorn's next exact review proved the two-byte delta was formatter-only and returned GO. Imrahil then returned NO-GO because moved worker HEAD lacked a direct negative control, the literal source-review artifact was not tracked, and push authority was unstated. Samwise added only the moved-HEAD control; root materialized it, confirmed Prettier made no further change, and reran the complete validation. Aragorn re-read the final tuple, proved the eighth test non-vacuous, terminally rehashed, and returned unconditional GO.

- `Tools/verify-worker-handoff.mjs`: 11,179 bytes; SHA-256 `2A3CA3C56E1E825298D5208DDFBE241B25F0A09E34B1AD64C230C74CFD6EDE2B`
- `Tools/verify-worker-handoff.spec.mjs`: 7,447 bytes; SHA-256 `05C9D3BC5473DA6E7C6C9EE7E2AA7B15E44E71F668238DC8036338F02E9E610D`
- `package.json`: 10,629 bytes; SHA-256 `C2575461545E96164CABDF8CEFF3BD87E79106733ADD6879316E8B49C44EFFFC`

Root banked Aragorn's literal final source-review report without reviewer-authored file writes:

- `migration_doc/branches/reviews/aragorn--handoff-verifier-review.md`: 3,911 bytes; SHA-256 `5C72F8C7C9BD749DA1A7B1E12FBB9A0DEE28E1F43E25C1E0933E8BDFD5A67889`
- Reviewer terminal states: Aragorn and Imrahil quiescent, with no live child process.

The existing `migration_doc/branches/reviews/imrahil--batch-1331-bookkeeping-review.md`
is a superseded advisory review for final closure: it reviewed the predecessor 5,504-byte
handoff at SHA-256 `E5AE7D6E343B1CCD094F6653BF235C921C401F2C05C43EB4DA1FDA805ADAF9DF`,
not this handoff's current bytes. The final bookkeeping report at that same path will carry the
exact tuple it reviewed and its decision. This handoff deliberately does not cite that final
report's hash, which would make the closure claim self-referential.

Root-authorized validation against that exact tuple:

- `node --check Tools/verify-worker-handoff.mjs`: exit 0.
- `node --check Tools/verify-worker-handoff.spec.mjs`: exit 0.
- `node --test Tools/verify-worker-handoff.spec.mjs`: exit 0, 8/8 passed.
- `npm run test-landing-rules`: exit 0, 179/179 passed.
- `npx prettier --check` on the complete candidate paths: exit 0.
- `git diff --check` on the three leased paths: exit 0.
- Test-owned temporary fixture cleanup: zero matching leftovers.

The positive integration control used Théoden's frozen clone and the exact lease `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`. The repaired verifier exited 0 with `READY_FOR_REVIEW` and reported that one path as authored. The pre-repair verifier had exited 1 with an empty authored set against the same clone. These are readiness checks, not certification verdicts.

## Dispatch constraints

- One deliverable: explicitly leased provisioned paths must be treated as authored, while unleased provisioned drift remains excluded.
- Add a non-vacuous Node behavioral spec using isolated temporary Git fixtures and wire it into the existing `test-landing-rules` runner.
- Preserve the tool's current `READY_FOR_REVIEW` vocabulary and exits; do not relabel it as a charter certification verdict.
- No worker Git writes, including inside test-owned temporary fixtures; no dependency installation, build, browser, server, network, evidence publication, or unrelated paths.
- Freeze exact bytes before independent review.
