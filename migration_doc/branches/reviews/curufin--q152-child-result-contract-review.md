# Q-152 H0 Wave-Child Result Contract — Independent Terminal Review

- **Reviewer:** Curufin, independent H0 contract reviewer
- **Review date:** 2026-08-29
- **Verdict:** **GO — pure H0 exact tuple only**
- **Required findings:** None

## Frozen boundary

The terminal read-only verification matched the root-supplied boundary exactly:

| Item | Frozen value |
|---|---|
| HEAD | `a64954b94507fa29762964f3d410517ddd765e9e` |
| HEAD tree | `3247f590e9613b34320e6a9abbb676a132d00cd4` |
| Porcelain | Exactly the two untracked paths listed below |

```text
?? Tools/visual-regression/lib/wave-child-result-contract.mjs
?? Tools/visual-regression/wave-child-result-contract.spec.mjs
```

Terminal file identities:

| Path | Bytes | SHA-256 |
|---|---:|---|
| `Tools/visual-regression/lib/wave-child-result-contract.mjs` | 25,463 | `142367925069EFB2C689971D0F792A5ABF93B7F81C75EF96B975912714FB7458` |
| `Tools/visual-regression/wave-child-result-contract.spec.mjs` | 23,152 | `EC6A26B813DDA1EE2CDA900A1ECF4BC32D4B62635E54BDF04926A7DA990572AB` |

The tuple and repository boundary were checked again after the complete source reread. No drift was observed.

## Inspected scope

The substantive review was limited to the two frozen H0 files:

- `Tools/visual-regression/lib/wave-child-result-contract.mjs`
- `Tools/visual-regression/wave-child-result-contract.spec.mjs`

The audit workflow instructions were read before review. Repository inspection outside the two files was limited to the requested read-only HEAD, tree, and porcelain boundary verification.

## Prior-finding carry-forward

| # | Prior finding | Disposition | Closure evidence |
|---:|---|---|---|
| 1 | Lifecycle was not bound to verdict. | **FIXED** | Final lifecycle validation is closed and abnormal termination requires a retained `ERROR` observation; top-level status remains derived from observations (`wave-child-result-contract.mjs:372`, `wave-child-result-contract.mjs:417`, `wave-child-result-contract.mjs:618`). The focused lifecycle cases are specified at `wave-child-result-contract.spec.mjs:189`. |
| 2 | `structuredClone` and accessor getter side effects could affect validation. | **FIXED** | The implementation does not use `structuredClone`. It rejects proxies before traversal, examines property descriptors and rejects accessors without invoking getters (`wave-child-result-contract.mjs:105`, `wave-child-result-contract.mjs:124`, `wave-child-result-contract.mjs:132`). Hostile accessor/proxy controls are present at `wave-child-result-contract.spec.mjs:583`. |
| 3 | Duplicate local `STATUS_RANK` and exit mapping duplicated canonical verdict logic. | **FIXED** | The contract imports `S5_FINAL_STATUSES`, `exitCodeForS5Status`, and `exitCodeForS5StatusOrStructural` from the existing canonical verdict helper (`wave-child-result-contract.mjs:4`). No duplicate exit table or local status-rank table remains. Canonical status/exit cases are specified at `wave-child-result-contract.spec.mjs:149`. |
| 4 | Malformed members surfaced only generic assessment exceptions. | **FIXED** | Malformed arrays and members receive field-specific structural issues, while the public assessment remains nonthrowing. The specification asserts named failures and explicitly excludes the generic exception route (`wave-child-result-contract.spec.mjs:490`). |
| 5 | `Date.parse` accepted noncanonical or normalized timestamps. | **FIXED** | Timestamps require the exact UTC-millisecond form and a value-preserving date roundtrip (`wave-child-result-contract.mjs:265`). The specification rejects both missing milliseconds and an impossible normalized date (`wave-child-result-contract.spec.mjs:315`). |
| 6 | Canonical JSON and SHA calculation had a TOCTOU window from separately assessing and hashing mutable caller input. | **FIXED** | `identifyWaveChildResult` assesses and rebuilds once, retains the immutable result, then derives canonical JSON and SHA from that retained value (`wave-child-result-contract.mjs:663`, `wave-child-result-contract.mjs:694`). Key-order, mutation, and hash-binding controls are specified at `wave-child-result-contract.spec.mjs:411`. |

### Additional required lifecycle predicate

**HARD_STOP timeout binding: PASS.** `HARD_STOP` is a closed termination kind and belongs to the timeout termination set (`wave-child-result-contract.mjs:12`). Lifecycle validation requires `timedOut` to agree with membership in that set (`wave-child-result-contract.mjs:417`). The specification accepts `HARD_STOP` with `timedOut: true` and rejects it with `timedOut: false` (`wave-child-result-contract.spec.mjs:197`).

## Acceptance results

| Predicate | Result | Review basis |
|---|---|---|
| Exact, closed schema | **PASS** | Exact governed key sets are declared for root and nested records (`wave-child-result-contract.mjs:31`). Unknown governed keys are structural, with controls at `wave-child-result-contract.spec.mjs:565`. |
| Hostile input and nonthrowing validation | **PASS** | Proxy, accessor, sparse-array, cycle, unsupported-object, and malformed-member paths are rejected structurally. Public assessment and aggregation retain structural fallbacks rather than propagating hostile-input exceptions (`wave-child-result-contract.mjs:663`, `wave-child-result-contract.mjs:785`; `wave-child-result-contract.spec.mjs:490`, `wave-child-result-contract.spec.mjs:565`, `wave-child-result-contract.spec.mjs:583`). |
| Canonical status/exit consistency | **PASS** | Final status is derived from observations and checked against the supplied status; the exit is obtained from the shared canonical verdict helper (`wave-child-result-contract.mjs:528`, `wave-child-result-contract.mjs:631`). All four final statuses and an exit mismatch are covered at `wave-child-result-contract.spec.mjs:149`. |
| Aggregate order `STRUCTURAL > ERROR > FAIL > PASS` | **PASS** | The fold uses canonical exit ordering and forces any aggregate structural reason to `STRUCTURAL` (`wave-child-result-contract.mjs:748`, `wave-child-result-contract.mjs:856`). The exact precedence is specified at `wave-child-result-contract.spec.mjs:350`. |
| Primitive-red retention | **PASS** | Child assessments remain in the aggregate even when another child or aggregate condition is structural (`wave-child-result-contract.mjs:780`, `wave-child-result-contract.mjs:860`). The completed product-red mutant is specified at `wave-child-result-contract.spec.mjs:374`. |
| Root-supplied provenance contract | **PASS for pure H0** | Source commit, dirty state, source identity, and fingerprints are mandatory contract data (`wave-child-result-contract.mjs:356`); cross-child invocation and provenance conflicts become structural (`wave-child-result-contract.mjs:817`). The actual acquisition and injection of these values by the root runner remains an integration obligation. |
| Deterministic canonical bytes and hash | **PASS** | The implementation reuses the existing `stableStringify` and `sha256` facilities (`wave-child-result-contract.mjs:10`) and derives identity from the retained assessed result. Exact canonical bytes, key-order invariance, and hash sensitivity are specified at `wave-child-result-contract.spec.mjs:411`. |
| Mutation and alias safety | **PASS** | Assessed records are rebuilt and deeply frozen (`wave-child-result-contract.mjs:224`). Caller mutation, retained provenance, nested input aliases, and immutable output are covered at `wave-child-result-contract.spec.mjs:411`, `wave-child-result-contract.spec.mjs:605`, and `wave-child-result-contract.spec.mjs:625`. |
| Exact required-child census | **PASS** | Required IDs must form a nonempty unique list; missing, duplicate, and unexpected children are structural (`wave-child-result-contract.mjs:710`, `wave-child-result-contract.mjs:798`). Controls are present at `wave-child-result-contract.spec.mjs:644`. |
| Purity and dependency surface | **PASS for H0** | The contract imports only the shared verdict helper, shared stable/hash primitives, and `node:util` proxy detection (`wave-child-result-contract.mjs:4`). It has no filesystem, Git, browser, process-control, environment, clock, randomness, server, or orchestration dependency. |
| Comment/JSDoc cleanliness | **PASS** | Comments describe the contract behavior and invariants without campaign history, repair narrative, or malformed JSDoc. |

## Test evidence

**NOT RETESTED in this terminal review.** Runtime execution was expressly prohibited.

Prior evidence reported by Caranthir, carried only as external evidence and not independently rerun here:

- Both focused `node --check` invocations reportedly exited `0`.
- The focused `node --test` invocation reportedly passed `18/18`.

The current verdict rests on the exact frozen tuple, complete static reread, prior-finding carry-forward, and terminal identity verification. It does not relabel the prior runtime report as reviewer-generated evidence.

## Bounded verdict

**GO for the pure H0 contract and specification at the exact frozen tuple above.**

This is not approval to land H0 as an orphan helper. Landing remains held until H0 is assembled atomically with its first real child consumer and an appropriate package runner home. Any byte change to either reviewed file invalidates this verdict and requires a new frozen review.

This verdict makes no claim about:

- Child-native adapters or result emission
- Parent wave-end composition
- Exact runtime child census
- Root acquisition of source provenance
- Immutable runtime result or receipt paths
- Package-script reachability
- Edge, browser, server, or build behavior
- Published evidence or Q-152 certification

## Dependencies and remainders

- A first real child must construct and emit this exact contract without duplicating the child’s existing primitive report.
- Root orchestration must supply and bind invocation identity and source provenance; H0 validates supplied values but cannot establish their origin.
- Parent composition must validate the exact required child set, retain every primitive red, and fold results through this contract.
- Runtime result and receipt paths must be immutable and atomically bound by the integrating runner.
- The focused package runner and its pure-Node integration specifications remain outside this H0 tuple.
- Gated Edge/browser proof, build validation, evidence assembly, and certification review remain separate later work.

## No-action declaration

This was a read-only review. I made no edits, created no files, and did not create the requested review report path. I performed no Git write, Node/test execution, build, browser, server, product/runtime process, network access, installation, deletion, or evidence publication. Only source reads, byte counts, SHA-256 calculations, and the requested read-only Git boundary queries were performed.
