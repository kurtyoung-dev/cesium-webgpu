# Capture foundation — source-only landing record

Owner: DX-01 development-unblocking follow-up. Planned Batch 1449 on main,
parent `dce08bc07b72d6706f5e07005aa0dcbf6859c716`. Root alone may stage and
commit after independent evidence review and final rehash. No push is authorized.
This record is not a claim that a pending commit already exists.

## Exact source scope

| File | Tested working bytes | SHA-256 |
| --- | ---: | --- |
| `Tools/lib/bounded-command.mjs` | 18485 | `a2b5f4c272922cdf9c51703b6786f5c4a8619f5132ca33511b0bb1497f540ec6` |
| `Tools/lib/bounded-command.spec.mjs` | 17460 | `da9161dd521293a2d144c6759798b625e7eacbde0097ad2418c45b3c4a630493` |
| `Tools/visual-regression/run-source-check.mjs` | 6233 | `29a060900ab6bda7d04139b1f3de8824190cb9b96d1686832d5e3cbdb6c97fe1` |
| `Tools/visual-regression/run-source-check.spec.mjs` | 8375 | `5d690705c7ad567a8ecdf6a5b2f16037530d756e3bb83cd0b13a1474303ab09e` |

The source-check adapter is the recorder's first consumer. Both reuse the
existing tracked build-source-identity, refusal and verdict helpers. No browser,
slot, lifecycle, renderer, scanner or product dependency is introduced. Git's
normal text normalization may give committed LF blobs different byte hashes;
the table identifies the actual tested Windows working files, not hypothetical
cross-platform checkout bytes.

## Observed validation

Galadriel's exact tuple03 independent source review is GO. Its 21 inputs remain
unchanged, carrying the recorded scoped syntax, Prettier and ESLint results.
The independently accepted bounded Windows smoke retains native nonzero/tails,
deadline, collision and capped-output facts. It proves no process-tree sandbox.

Root refreshed both unchanged focused suites on 2026-09-06 using the accepted
adapter: recorder14/14 and adapter14/14, ordinary native/public/outer0, no skipped,
cancelled or TODO tests. Each binds15 adapter labels; the complete14-input root
union, including both plans and prior independent reviews, is unchanged. Stdout
is complete3157/2851 bytes, respectively; both stderr streams are complete/empty.
No timeout, forced termination or stream-drain error occurred.

Evidence under `tmp/astra-dev-unblock-20260906/_lane-out/root/`:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `recorder-prelanding-01/command.jsonl` | 19997 | `589ef6acb840a7b6b2f0d0b1a6820ade1bb0d196e445b13c6d69832c1ef407bf` |
| `recorder-prelanding-01/source-check.json` | 8743 | `ddc0ca60b03a7aad7345c7d01031a2ce0c84af1616b5d71b03324f1fa561f857` |
| `adapter-prelanding-01/command.jsonl` | 19364 | `96e4967de17991f450d06ca2af5d3d92df708e39316c037c782f3de02625a1d9` |
| `adapter-prelanding-01/source-check.json` | 8811 | `a467e363e5bceb0435b6fadd8232643ab63d9a00329a6f46f191d92101306add` |

The release, complete outer returns and postchecks are retained beside those
directories. These local immutable artifacts are not an external campaign
evidence publication. Prior failed and incomplete captures remain preserved.
Elendil independently accepted the fresh source-only evidence after recomputing
all28 test names/results, both15-label before/after/current folds, the14-entry
release and the unchanged21-entry source-review tuple. His full3982-byte report,
`ELENDIL_CORE_CAPTURE_PRELANDING_EVIDENCE_REVIEW_01.md`, hashes to
`91926b89a236866e4a8a86961a0affbe8f17071c63b3e86ade039e7acf50fa57`.
Root read it in full, reviewed the dependency-disjoint four-path scope and actual
hooks, and accepts this source-only landing group. Actual hook/commit outcome
remains pending until Git finishes; no hook may be bypassed.

## Use and remaining boundaries

Import `runBoundedCommand` for an authorized argv-only child with bounded output
and deadlines. Use `captureSourceCheck` or its CLI with one explicit `.spec.mjs`,
a caller-complete input list and a new artifact directory. Raw facts are retained
before summaries; callers still own authorization, dependency completeness and
interpretation. Neither helper supplies security isolation or descendant-quiescence
proof. Recorder output explicitly retains unknown descendant state when unobserved.

The focused specs can be invoked directly with Node's test runner. Runner-family
registration remains a separate root-owned integration step: current package.json
mixes registrations from unfinished lanes and is deliberately excluded. This slice
does not clear A01 browser cutover, fleet failures, AO's pause, shared-reader reds,
cloud/god-ray correctness, Rust certification or build/served-output freshness.
