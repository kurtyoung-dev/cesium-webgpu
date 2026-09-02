# 3D Tiles patch extension — P0a-R2 result

**Date:** 2026-08-26  
**Verdict:** PASS  
**Disposition:** GO for the renderer-free P0a-R2 prototype only  
**Lane:** local-only, browser-free, GPU-free, no Git, no deletes, no external publication  
**Authority:** `3D_TILES_PATCH_EXTENSION_P0A_R2_BOUNDED_CARRIER_PREREGISTRATION_2026-08-26.md`

## 1. Decision

The frozen P0a-R2 bounded-carrier prototype satisfies R2-01 through R2-20. Two fresh independent
reviewers rehashed the same terminal tuple, reran every required local gate and mutant, and returned
no unresolved CRITICAL, MAJOR, HIGH, FAIL, ERROR, or STRUCTURAL finding within R2 scope.

This closes only the renderer-free verifier and local handle prototype. It does not authorize a
producer, mutable head server, CAS, transport, engine integration, WebGL or WebGPU work, standards
registration, campaign certification, or an external write.

The original P0A-19 external-resource closure claim and original P0A-23 producer-behavior claim remain
STRUCTURAL and deferred. No historical red is rescored.

## 2. Frozen terminal tuple

The six reviewed files are immutable:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0A_R2_BOUNDED_CARRIER_PREREGISTRATION_2026-08-26.md` | 16,190 | 270 | `b10194395a7bd17aac5b441e08352bce95f0295fb4d82db7d036e93494850a3a` |
| `Tools/patch-prototype/README.md` | 13,290 | 300 | `8d9139c7b8290eb03db924fede3cfd328391ae643bb4c78b047528701d4e413c` |
| `Tools/patch-prototype/strict-json.mjs` | 24,831 | 955 | `58a134f7dbf673f3e8c1473bbacdc41dac68e7f7d26d56a634b3d52bb3ccd887` |
| `Tools/patch-prototype/strict-json.spec.mjs` | 32,275 | 981 | `5e78b18ade89f69fc6ec3f609bfda9f4cedf9224f3d9c47c2bd3b20619da7237` |
| `Tools/patch-prototype/live-update-v0.mjs` | 59,541 | 2,216 | `36c8b66a31a6877d22a583ea87c08048db2911b0bcc3e0296ced94783a069d1f` |
| `Tools/patch-prototype/live-update-v0.spec.mjs` | 129,570 | 3,850 | `1ac810a3e72010701dd0ddcc3499a0d652f9d74c703dc8f5ab2a34b7d4fb8196` |

Initial and terminal reviewer hashes matched this table. No reviewed file drifted.

## 3. Terminal gates

| Gate | Result |
| --- | --- |
| `node --test Tools/patch-prototype/strict-json.spec.mjs Tools/patch-prototype/live-update-v0.spec.mjs` | PASS, exit 0; 151 tests, 151 passed, 0 failed, 0 skipped, 0 todo |
| `npx --no-install eslint` over the four JavaScript source/spec files | PASS, exit 0 |
| `npx --no-install prettier --check` over the five prototype files and three preregistrations | PASS, exit 0 |
| Registered mutation controls | PASS; 23 live subtests plus four strict controls bit |
| Construction-excluded hostile workers | PASS; operation timeout is FAIL, setup/import/harness/protocol failure is ERROR |

The result document did not exist during tuple review. Its own formatting and hash are recorded after
this document is formatted; that does not alter the six-file reviewed tuple.

## 4. Independent reviews

### 4.1 Reviewer 1 — semantic protocol and persistence

`r2_final_semantic_review` returned PASS / GO after:

- rehashing all six files before and after review;
- independently reproducing 151/151 Node, ESLint exit 0, and full Prettier exit 0;
- mapping R2-01 through R2-20 and all 16 registered mutation classes;
- reviewing canonical JSON, duplicate rejection, physical placement, URI confinement, digest/length
  closure, cross-links, rollback and split-brain behavior;
- reviewing prior persistence, tuple-value commit, sealed descriptor closures, candidate locality,
  immutability, and stable diagnostics; and
- verifying that original P0A-19 and P0A-23 remain deferred rather than promoted.

It reported no unresolved CRITICAL, MAJOR, HIGH, FAIL, ERROR, or STRUCTURAL issue within R2 scope.

### 4.2 Reviewer 2 — hostile bounds, identity, topology, and mutants

`r2_final_security_review` returned PASS / GO after:

- rehashing all six files before and after review;
- independently reproducing all terminal gates;
- executing exact-once transformed topology mutants in memory in addition to the registered runner;
- reviewing construction-excluded deadlines and FAIL-versus-ERROR classification;
- reviewing captured WeakMap and byte-window identities under the registered poisoning controls;
- checking 100,000-property carriers at limits, prior, closure, and candidate boundaries;
- reviewing snapshot, deep-freeze, sealed-handle, tuple-value, diagnostic, and insertion-order
  guarantees; and
- verifying that retained no-delete helpers have no runtime call sites.

It reported no unresolved CRITICAL, MAJOR, HIGH, FAIL, ERROR, or STRUCTURAL issue. It reported one LOW
/ STANDING architecture-review trigger for the 3,850-line live spec. Section 8 records its required
disposition before any P0b work may add surface.

Together these two reviews satisfy R2-20.

## 5. R2 acceptance fold

| ID | Result | Terminal evidence |
| --- | --- | --- |
| R2-01 | PASS | All executable original wire controls remain green; external P0A-19 and producer P0A-23 remain explicitly STRUCTURAL/deferred |
| R2-02 | PASS | Strict positional primitive limits cover defaults, maxima, adjacent rejection, invalid carriers, and pre-byte ordering |
| R2-03 | PASS | Live limits cover exact 512/513-byte edges, duplicates, shape/nesting, all six accepted minima/maxima, and adjacent below/above rejection at exact field paths |
| R2-04 | PASS | Prior bytes cover exact canonical 290 and adjacent 291, duplicates, noncanonical spelling, unknown fields, and every fixed-schema scalar class |
| R2-05 | PASS | Encoded prior structured-clones, reloads through a fresh module, verifies, and commits a successor |
| R2-06 | PASS | Minted records are not reread; forged carriers reject; equivalent restored bytes commit by tuple value; different tuples reject |
| R2-07 | PASS | Candidate identity uses captured WeakMap intrinsics before property inspection and remains module-local |
| R2-08 | PASS | Builders enforce kind, cardinality, per-entry limits, and exact compositional aggregate maxima before copy/hash |
| R2-09 | PASS | Builders snapshot mutable, shared, same/cross-realm typed-array and DataView windows |
| R2-10 | PASS | `seal` is idempotent; add-after-seal and forged/wrong handles reject; sort is consumed by monotonic lookup and its removal changes public verification |
| R2-11 | PASS | Tightened per-entry and combined budgets reject owned snapshots before hashing; missing/unexpected/digest/length controls remain isolated |
| R2-12 | PASS | 100,000 hidden fields reject at all four trust boundaries with zero caller hooks |
| R2-13 | PASS | Raw graph exports are absent; byte canonicalization is order-invariant, fresh, and bounded |
| R2-14 | PASS | Depth 64 evaluates; 65 and 5,000 reject without RangeError; decoded/result/prior graphs are immutable |
| R2-15 | PASS | No public path retains a caller byte view; entrypoint and builder snapshot-removal controls bite |
| R2-16 | PASS | Error projections are stable across repetitions and semantic input permutations without attacker echo |
| R2-17 | PASS | Function-scoped source topology enforces carrier, identity, order, and raw-graph boundaries with unique anchors |
| R2-18 | PASS | Every executable hostile synchronous operation runs after worker readiness under a two-second parent deadline with explicit verdict classification |
| R2-19 | PASS | Node, ESLint, and Prettier terminal gates are green |
| R2-20 | PASS | Two fresh independent reviewers rehashed the terminal tuple, executed gates/mutants, and returned clean GO verdicts |

## 6. Mutation fold

All 16 preregistered transformation classes are evaluable and red when applied:

1. caller view replaces a byte snapshot;
2. builder cardinality or byte guard moves below admission/copy;
3. a sealed payload retains a caller view;
4. closure, prior, or candidate identity becomes visible property inspection;
5. WeakMap `has`, `get`, or `set` becomes dynamic after initialization;
6. caller-authored closure collections or handles are accepted;
7. invalid input is converted or echoed;
8. the 512-byte limits or 290-byte prior cap is removed;
9. UUID, digest, or uint64 regex work moves before exact length checks;
10. commit binds to object identity or accepts a different prior tuple;
11. an arbitrary-graph `canonicalizeJson` or `deepFreeze` export returns;
12. byte canonicalization traverses a caller graph;
13. depth enforcement is removed or a raw RangeError escapes;
14. decoded, result, or prior state becomes mutable;
15. verification enumerates or advances a caller collection; and
16. caller insertion order replaces the sealed sort and changes public verification.

The hard builder aggregate checks are defense in depth: one entry times 1 MiB and 16 entries times 1
MiB already imply the 1/16 MiB maxima. Acceptance therefore proves the exact maxima compositionally,
uses an importable source-order mutant for the redundant hard guard, and uses the independently
tightened verifier budget for the behavioral aggregate red.

## 7. Immutable failure chronology

### 7.1 Original P0a tuple — FAIL / NO-GO

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Original preregistration | 14,256 | `d3044e22981f4b4e5a61d263cff8554ee07d858719515c147555496e7ea75c24` |
| strict-json.mjs | 24,389 | `515cbc5a94efdced433535abf008d9a174c1e1d7f67f1cdeb3f39d7a2438dd9f` |
| strict-json.spec.mjs | 8,856 | `7e2238f9436e33e725468851452f9d7a8a509ddc7a6e20ea70ad29762ef3e894` |
| live-update-v0.mjs | 46,724 | `1ace58feeb8a32229d2c71649f2f55e2d3be34cca7999861c5a7a07c27ffb3a0` |
| live-update-v0.spec.mjs | 20,311 | `45ce26bf8c5c2467f7bc3448952170c44ef012538fad18c2cd3b2b255f82910a` |

Independent review found mutable caller views, unsafe caller limits, unstable malformed-prior
diagnostics, ambiguous URI acceptance, closure work before caps, insertion-order dependence, weak
negative controls, and the P0A-19/P0A-23 overclaims. Green registered tests did not override the red.

### 7.2 R1 repair attempts 1 and 2 — FAIL / NO-GO

Both dispositions remain failed exactly as frozen in the R2 preregistration. Their intermediate file
hash tuples were not banked in a tracked preregistration, so this result records that provenance gap
instead of inventing identities or silently collapsing the attempts.

### 7.3 R1 repair attempt 3 — conflicting review; measured red governs

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Repair preregistration | 9,737 | `6b67212620c9b005797deab86c5c4ebe1d1d59f676e387ff97b1a82c31529d57` |
| README | 10,672 | `d151b1064faeb93a0218a573c301dd9e826c0bf2ba4e43c0b9a9af48aa401109` |
| strict-json.mjs | 28,627 | `d4ad7aba55115225cef3dc45e256ee8b926765961132fdb6f557dbcff3c34a40` |
| strict-json.spec.mjs | 19,208 | `2ecbd3276b8bd4a60af307ee15bfb6677b6ea3f539b8a6097850a584c63e391f` |
| live-update-v0.mjs | 54,707 | `e983229bbad7a2f2752418cd3cbd2918485b1132a27c954077f6d051606ed2d5` |
| live-update-v0.spec.mjs | 62,588 | `c801a8b2d1d055d508c8a14fa00760f6b59aae810ed1d9d48e5a105bcfabcf07` |

This tuple passed 134/134 Node plus format/lint. One reviewer returned PASS / GO. The adversarial
reviewer reproduced unbounded guarded property-bag enumeration, unbounded raw graph exports, and live
topology gaps, returning FAIL / NO-GO plus STRUCTURAL. The measured red governs.

### 7.4 R2 implementation and harness reds

R2 was frozen first at
`b10194395a7bd17aac5b441e08352bce95f0295fb4d82db7d036e93494850a3a`. During implementation:

- the first combined run was 120/126; six reported failures collapsed to three fixture integration
  defects, then 126/126 passed;
- the first expanded live mutant run killed 16/17; the survivor exposed a forged-handle fixture that
  replaced only one of two opaque handles, then the corrected control bit;
- subsequent topology and mutation expansion reached 148/148, then 150/150;
- an adversarial pass found dynamic tuple iteration, incomplete raw-graph transforms, private-sort
  evidence weakness, and mathematically redundant aggregate-guard evidence; repairs preserved each
  prior red rather than rewriting expectations; and
- one later terminal ESLint attempt returned three `no-extend-native` findings in a worker fixture;
  the fixture switched to worker-local `Reflect.defineProperty` and all gates were rerun.

These were pre-freeze implementation/harness tuples without banked complete hash sets. They remain
recorded reds and are not represented as terminal certification attempts.

### 7.5 Stable pre-freeze candidate — 150/150 but NO-GO

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| R2 preregistration | 16,190 | 270 | `b10194395a7bd17aac5b441e08352bce95f0295fb4d82db7d036e93494850a3a` |
| README | 13,290 | 300 | `8d9139c7b8290eb03db924fede3cfd328391ae643bb4c78b047528701d4e413c` |
| strict-json.mjs | 24,831 | 955 | `58a134f7dbf673f3e8c1473bbacdc41dac68e7f7d26d56a634b3d52bb3ccd887` |
| strict-json.spec.mjs | 24,355 | 814 | `f3016d2fafc1f95e88a7eb766fd61293042937f370383eb9a23341088d858ddb` |
| live-update-v0.mjs | 59,541 | 2,216 | `36c8b66a31a6877d22a583ea87c08048db2911b0bcc3e0296ced94783a069d1f` |
| live-update-v0.spec.mjs | 86,409 | 2,683 | `505c60b2cbfe89e93087b9264ac1a7c67623c4d3fc297b6628b401269c74152e` |

Node 150/150, ESLint, and Prettier were green. Independent design audit still returned NO-GO with six
HIGH / STRUCTURAL findings: incomplete live-limit and prior boundary matrices, missing builder
DataView/cross-realm views, missing tightened per-entry verification, incomplete UUID/uint64 mutants,
and hostile synchronous cases outside classified workers.

### 7.6 Stable pre-freeze candidate — 151/151 but NO-GO

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| R2 preregistration | 16,190 | 270 | `b10194395a7bd17aac5b441e08352bce95f0295fb4d82db7d036e93494850a3a` |
| README | 13,290 | 300 | `8d9139c7b8290eb03db924fede3cfd328391ae643bb4c78b047528701d4e413c` |
| strict-json.mjs | 24,831 | 955 | `58a134f7dbf673f3e8c1473bbacdc41dac68e7f7d26d56a634b3d52bb3ccd887` |
| strict-json.spec.mjs | 32,275 | 981 | `5e78b18ade89f69fc6ec3f609bfda9f4cedf9224f3d9c47c2bd3b20619da7237` |
| live-update-v0.mjs | 59,541 | 2,216 | `36c8b66a31a6877d22a583ea87c08048db2911b0bcc3e0296ced94783a069d1f` |
| live-update-v0.spec.mjs | 125,269 | 3,719 | `b685a0852534ccdbc3d22e63e5a7b05636f5f24725918d149066a56eb4cee9f6` |

Node 151/151, ESLint, and Prettier were green. Repair verification still returned NO-GO with two HIGH
/ STRUCTURAL findings: no adjacent below/above numeric rejection for all six live-limit fields, and
the load-bearing 100,000-field live case still used a legacy worker without explicit
FAIL-versus-ERROR classification.

The terminal tuple in §2 is the first R2 candidate to receive pre-freeze design GO and two fresh
independent terminal GO verdicts.

## 8. Architecture review — 3,850-line live spec

Charter §3.5 sets `HOUSE_SCALE_MAX_LINES = 3156` as an architecture-review trigger, not a correctness
verdict. `live-update-v0.spec.mjs` is 3,850 physical lines, so this disposition is required before
P0b adds any surface.

### 8.1 Duplicated validation and shared-schema candidates

The file deliberately repeats some fixture construction across module instances so cross-module,
structured-clone, and worker boundaries are real rather than mocked. It also contains separable
mechanics:

- publication and descriptor-closure fixture generation;
- worker publication payload serialization;
- the construction-excluded worker state machine and verdict projection;
- source-section and unique-order topology assertions;
- in-memory import and exact-once mutation machinery; and
- two inert legacy helper definitions retained under the no-delete instruction.

The worker protocol, fixture schema, and mutation engine are shared-schema/helper candidates. They
must not become trusted production validators; tests should continue to construct independent
expected values.

### 8.2 Policy/mechanism separation

Protocol semantics, hostile-carrier execution, topology policy, and mutation mechanics are separable.
Keeping all four in one file makes the reviewed tuple self-contained, but increases review cost and
makes unrelated acceptance edits collide.

### 8.3 Disposition

The frozen R2 file remains unchanged:

- splitting it now would invalidate the exact reviewed tuple;
- the R2 preregistration permits only the existing five prototype files plus this result;
- the no-delete instruction prevents removing the inert legacy helpers; and
- runtime remains bounded and small for a local suite: 151/151 completed in approximately five to six
  seconds during terminal runs.

No more acceptance surface may be added to this file under R2. Before P0b implementation, its new
preregistration must authorize a behavior-preserving decomposition into at least:

1. shared fixture/worker-test support;
2. protocol and persistence acceptance;
3. hostile-boundary/deadline acceptance; and
4. topology and mutation acceptance.

The decomposition must freeze pre/post test inventories and prove the same mutation classes bite. It
must not move production validation into test helpers or erase the frozen R2 file. Removal of the two
inert helpers waits for explicit delete authorization. This records the trigger disposition before
any P0b surface is added.

## 9. Nonclaims and next boundary

P0a-R2 does not implement or prove:

- publication production or deterministic ordering of semantic producer inputs;
- mutable head serving, CAS, transport, freshness, authenticity, revocation, or replay resistance;
- external/heavy resource closure;
- runtime generation transactions, masks, compositor behavior, cache ownership, or retirement;
- Cesium engine integration;
- WebGL or WebGPU rendering, pick, depth, shadow, classification, or query parity;
- performance, memory, or request-count figures;
- standards registration or compatibility; or
- campaign certification or completion.

The next eligible patch-extension slice is a newly preregistered P0b producer/CAS/head-server
prototype that first performs the §8 decomposition. Renderer and WebGL/WebGPU integration remain
NO-GO until their open design blockers receive separate preregistration and evidence.

No Git command, delete, browser, GPU probe, network action, external write, landing action, or campaign
score change occurred in this result lane.
