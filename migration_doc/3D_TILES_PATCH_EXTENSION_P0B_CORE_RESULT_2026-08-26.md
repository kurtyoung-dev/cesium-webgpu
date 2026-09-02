# 3D Tiles patch extension — P0b-core result

**Date:** 2026-08-26  
**Terminal verdict:** STRUCTURAL  
**Disposition:** NO-GO pending a reviewed R6 placement successor to the R5 cap failure; the R2 source-worktree GO and original nine-file FAIL remain immutable  
**Scope:** renderer-free, unsigned, process-local producer/store/head prototype only  
**Lane:** local-only, browser-free, GPU-free, network-free, no file deletion, no external publication; local Git checkpoint separately authorized after certification  
**Authority:** P0b-core base plus non-weakening R1, R2, R3, R4, and R5 preregistrations

## 1. Decision state

The first author-side candidate was green on every registered executable gate, but terminal review
found a real production import cycle and a topology scanner that could not see valid late imports.
P0B-17, P0B-19, and P0B-20 remain FAIL for that exact tuple. A conflicting protocol GO does not
override the measured red.

The exact failed tuple remains frozen in §4. R2 adds a seventh production authority module, pure
adapter preparation, a head facade, parser-backed graph evidence, 32 P0b mutants, and the 13-file
terminal provenance envelope frozen in §4.1. R2 design review first returned NO-GO on three
specification gaps; the amended R2 received fresh PASS / GO before implementation.

The repaired successor passed Gate D, 71/71 combined P0b tests, 59/59 controls, complete syntax,
ESLint, Prettier, graph, export, cap, import-order, and hostile-authority gates. Two fresh non-author
reviewers independently rehashed the same 13 files before and after their work and returned PASS /
GO, exit 0, with no open finding. P0B-17, P0B-19, and P0B-20 are PASS for the successor only; the
failed tuple and both of its conflicting reviews are not rescored.

A later clean landing-clone smoke produced 70/71 because P0B-19 required an ignored root
`package-lock.json` that has never existed in Git and was stale against both tracked `package.json`
and the executed ESLint runtime. That new measured red governs landing and is P0B-F02. The R2 GOs
remain valid evidence for their exact on-disk tuple but do not authorize a checkpoint. R3 replaces
only the parser-provenance mechanism. R4's separated implementation remained above its hard helper
cap. R5's fully specified split-helper design has independent GO; its implementation and two fresh
terminal reviews are pending.

The successor closes only deterministic byte authoring, an in-memory immutable content-addressed
store, a process-local mutable-head core, and a two-pass bridge through the frozen P0a verifier. It
does not authorize transport, persistence, rendering, Cesium integration, WebGL, WebGPU, standards
promotion, production use, or an external publication. A local Git checkpoint does not broaden this
technical verdict.

## 2. Frozen authorities and prerequisites

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_PREREGISTRATION_2026-08-26.md` | 27,275 | 457 | `19f2a41c1f6c48e7f21c6d7545c2a454f99265cae419d8733aacf22b888bfb2f` |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_R1_PREREGISTRATION_2026-08-26.md` | 13,408 | 298 | `b4a2a40b92031e0d13a50ecabe15eafc6588e4240cde427f028935a552de8ccf` |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_R2_ACYCLIC_AUTHORITY_PREREGISTRATION_2026-08-26.md` | 23,930 | 364 | `a4d4bc0f331a738ce8bb4f9b05a286422cafa612d0835281377eec277558dcfc` |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_R3_TRACKED_PARSER_PROVENANCE_PREREGISTRATION_2026-08-26.md` | 18,989 | 294 | `9cdebb6b34afe794efbe95904434b3005bbb75140a4bb4b287fe08ecc3484d19` |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_R4_SEPARATED_PARSER_PROVENANCE_PREREGISTRATION_2026-08-26.md` | 9,936 | 149 | `f4e75c2fee24c116e2d3f4cf33f2e70ed1412908315aa4b9a72c47588dd827a0` |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_R5_SPLIT_PACKAGE_TREE_PREREGISTRATION_2026-08-26.md` | 19,399 | 290 | `eea3692c77d8a2a7cf49319e67ff6a7ec103a092a25d739736f14d216497f67d` |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0A_RESULT_2026-08-26.md` | 18,362 | 300 | `d336b945b9a04c58df951c4cb534758497d2ee6c8d1a893d65add9facf37eb92` |

The frozen P0a-R2 prerequisite remains the exact six-file tuple recorded by that result:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0A_R2_BOUNDED_CARRIER_PREREGISTRATION_2026-08-26.md` | 16,190 | 270 | `b10194395a7bd17aac5b441e08352bce95f0295fb4d82db7d036e93494850a3a` |
| `Tools/patch-prototype/README.md` | 13,290 | 300 | `8d9139c7b8290eb03db924fede3cfd328391ae643bb4c78b047528701d4e413c` |
| `Tools/patch-prototype/strict-json.mjs` | 24,831 | 955 | `58a134f7dbf673f3e8c1473bbacdc41dac68e7f7d26d56a634b3d52bb3ccd887` |
| `Tools/patch-prototype/strict-json.spec.mjs` | 32,275 | 981 | `5e78b18ade89f69fc6ec3f609bfda9f4cedf9224f3d9c47c2bd3b20619da7237` |
| `Tools/patch-prototype/live-update-v0.mjs` | 59,541 | 2,216 | `36c8b66a31a6877d22a583ea87c08048db2911b0bcc3e0296ced94783a069d1f` |
| `Tools/patch-prototype/live-update-v0.spec.mjs` | 129,570 | 3,850 | `1ac810a3e72010701dd0ddcc3499a0d652f9d74c703dc8f5ab2a34b7d4fb8196` |

No frozen P0a file was edited.

## 3. Frozen Gate D decomposition tuple

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `Tools/patch-prototype/p0b/test-support/p0a-fixtures-v0.mjs` | 8,060 | 268 | `834acb9477a1b1f385cd86cbd55906fdebf0c3da207237f3798466aa52eda7e4` |
| `Tools/patch-prototype/p0b/test-support/worker-harness-v0.mjs` | 10,594 | 351 | `cf1010ae730be00498a3c280b40f193e7bd7acdad8a10be6cca9d182f2846423` |
| `Tools/patch-prototype/p0b/test-support/mutation-harness-v0.mjs` | 2,309 | 74 | `7ac9b7b3b47ea8deb3f15c7a9c10d53e09df5e9d6f1c9e0e1d12cf44537d8f14` |
| `Tools/patch-prototype/p0b/test-support/p0a-r2-inventory-v0.mjs` | 5,887 | 191 | `621ae10554f447e1b5337fc526ed9cf2fe5b694a348234f6678b62c02379b890` |
| `Tools/patch-prototype/p0b/p0a-live-protocol-persistence.spec.mjs` | 31,472 | 933 | `648c414580f8ebf7c28083dfba061a9ca9aeec78e248e1fe190b355c6f54b1e8` |
| `Tools/patch-prototype/p0b/p0a-live-hostile-boundary.spec.mjs` | 39,727 | 1,197 | `60803673723d7fb21c734c01e3f7f24eb3f57ca5be28d63d35bbeacd94394ea3` |
| `Tools/patch-prototype/p0b/p0a-live-topology-mutants.spec.mjs` | 30,030 | 875 | `95a25e4c294c05e6fcbb74a608d09993b5fc02576e0b141404f02a07e2e07c34` |
| `Tools/patch-prototype/p0b/p0a-r2-decomposition-inventory.spec.mjs` | 597 | 13 | `85ec1001f7e0de5e4035f4e4e044bdaed6a737b7a1f04586c6d63955ced03253` |

PRE and FORWARD each produce 151 identical hierarchical test names and outcomes. Their normalized
inventory is exactly 7,298 bytes with SHA-256
`1b6ac268749b579056e495412c9ce1da2b566847e8475b51e2319dbaeb9ad810`.

## 4. Failed P0b terminal review tuple

These nine files are the exact stable tuple judged by both first terminal reviewers:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `Tools/patch-prototype/p0b/protocol-v0.mjs` | 7,835 | 259 | `b27e630005656c14360aa4d141fa231501a82f84e821808324fd2e4341838308` |
| `Tools/patch-prototype/p0b/seeded-change-stream-v0.mjs` | 25,973 | 695 | `4b26f7b1732b4b7feae7732e1078f35a42c6893c26e578a62ddea6f44f605867` |
| `Tools/patch-prototype/p0b/reference-producer-v0.mjs` | 35,314 | 1,185 | `46bced1d88c969917806fde20eb510248038a6a93756805c9dcd82b6089097a0` |
| `Tools/patch-prototype/p0b/p0a-publication-adapter-v0.mjs` | 22,385 | 700 | `d787c7dbb7bcd0acfa429f1e970e71b57a12ea0052c11e62ddd24d0ed044318b` |
| `Tools/patch-prototype/p0b/content-addressed-store-v0.mjs` | 24,350 | 824 | `7fb3a86d37edb0e83d6f543f13f0b054aec98e45493cb1eca513aec35b3d2681` |
| `Tools/patch-prototype/p0b/head-service-v0.mjs` | 26,087 | 878 | `eb8640a49d754eafb7fd136c5672b9e044c017403b3a649b3f2f5129f31055fc` |
| `Tools/patch-prototype/p0b/p0b-protocol-persistence.spec.mjs` | 30,104 | 886 | `afd7455f3774490ce26eb87f3430e771f681e4c300f72312f3a86a599b0bdf05` |
| `Tools/patch-prototype/p0b/p0b-hostile-boundary.spec.mjs` | 36,715 | 1,108 | `71f397d2681cddd5da26ac362e1fe8804c17625c6de7ce290dacfc41b1fac4f1` |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | 55,751 | 1,590 | `53ebc0715ed73464f5b358abff49b4a8067cef3cd31385edc72323db689db71c` |

All source and test files are below their shrink-only preregistered caps. The adapter is exactly at its
700-line cap; the topology/mutant spec is 10 lines below its 1,600-line cap.

### 4.1 Frozen R2 successor envelope

The successor terminal reviews froze these 11 implementation files plus the two parser-provenance
manifests. The first four production modules are byte-identical to the failed tuple; all other
implementation identities are the repaired R2 candidate.

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `Tools/patch-prototype/p0b/protocol-v0.mjs` | 7,835 | 259 | `b27e630005656c14360aa4d141fa231501a82f84e821808324fd2e4341838308` |
| `Tools/patch-prototype/p0b/seeded-change-stream-v0.mjs` | 25,973 | 695 | `4b26f7b1732b4b7feae7732e1078f35a42c6893c26e578a62ddea6f44f605867` |
| `Tools/patch-prototype/p0b/reference-producer-v0.mjs` | 35,314 | 1,185 | `46bced1d88c969917806fde20eb510248038a6a93756805c9dcd82b6089097a0` |
| `Tools/patch-prototype/p0b/content-addressed-store-v0.mjs` | 24,350 | 824 | `7fb3a86d37edb0e83d6f543f13f0b054aec98e45493cb1eca513aec35b3d2681` |
| `Tools/patch-prototype/p0b/p0a-publication-adapter-v0.mjs` | 17,783 | 578 | `723dd6e2d1676911c7b6ff8a56f29161da46e7a1e52cda3ab913938e39c14e30` |
| `Tools/patch-prototype/p0b/publication-authority-v0.mjs` | 43,520 | 1,422 | `46ee64158cde08539c55a546f18c46da1015ca6f2357a2e490d534d384420122` |
| `Tools/patch-prototype/p0b/head-service-v0.mjs` | 550 | 19 | `68d85058eece5c6fb3dcdf370857f846a74da57a7df867b3aa137e986b19dc32` |
| `Tools/patch-prototype/p0b/p0b-protocol-persistence.spec.mjs` | 46,433 | 1,416 | `fb3ca171b77a900e97dbf99cc5c609fc03da565ec1e1eaa8835215f461f74ac5` |
| `Tools/patch-prototype/p0b/p0b-hostile-boundary.spec.mjs` | 46,935 | 1,432 | `1a49e59b6c08d29ed266a4a38fc39066d22474c7caeaa68364613a1576b34dc2` |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | 64,494 | 1,597 | `b8d426af09f8f754a8d15cf313eeda5a82ec539eb5f7a2689b29935c40ba9ac4` |
| `Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` | 8,456 | 292 | `2c21b6727f76746419c0f44e7496f17ce51dd135205449351c6cd3b54ef60fbc` |
| `package.json` | 8,331 | 212 | `dff0b712bc1a35a4718f5d4c0874d5388971d2f2d9fc9b9ce44738dd9a830ec2` |
| `package-lock.json` | 287,599 | 11,801 | `9e20b60aa0eb9d763d2bae50f2b6f6f1dd480eacf7e4a70d7015084c816b043c` |

The terminal runtime was Node v22.23.2 with direct root ESLint 10.8.1. Both reviewers observed the
same 13 identities before and after review with zero mismatch.

## 5. Author-side terminal gates

| Gate | Result |
| --- | --- |
| `node --test --test-reporter=tap Tools/patch-prototype/strict-json.spec.mjs Tools/patch-prototype/live-update-v0.spec.mjs` | PASS, exit 0; PRE 151/151, no cancelled/skipped/todo |
| `node --test --test-reporter=tap Tools/patch-prototype/strict-json.spec.mjs Tools/patch-prototype/p0b/p0a-r2-decomposition-inventory.spec.mjs` | PASS, exit 0; FORWARD 151/151, no cancelled/skipped/todo |
| `node Tools/patch-prototype/p0b/test-support/p0a-r2-inventory-v0.mjs` | PASS, exit 0; both exits 0; 151 names; 7,298 normalized bytes; frozen normalized hash |
| `node --test Tools/patch-prototype/p0b/p0b-protocol-persistence.spec.mjs` | PASS, exit 0; 15/15 |
| `node --test Tools/patch-prototype/p0b/p0b-hostile-boundary.spec.mjs` | PASS, exit 0; 20/20 |
| `node --test Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | PASS, exit 0; 36/36 |
| One serial combined `node --test` invocation over all three P0b specs | PASS, exit 0; 71/71 in approximately 23.9 seconds; no cancelled/skipped/todo |
| `node --check` over every P0b `.mjs` artifact | PASS, exit 0; 19/19 files |
| `npx --no-install eslint` over every P0b `.mjs` artifact | PASS, exit 0; 19/19 files |
| `npx --no-install prettier --check` over every P0b `.mjs` artifact and named campaign documents | PASS, exit 0 |
| Exact parsed graph, forbidden dynamic forms, measured parse counts, cycle traversal, unique anchors, sole authority assignment/tail, exports/arities, import order, and line-cap gates | PASS |
| Exact terminal tuple and frozen prerequisite rehash | PASS; all bytes, lines, and hashes match §§2–4.1 before and after both reviews |
| Required mutations | PASS; 27/27 carried P0a controls and 32/32 P0b controls bite, 59/59 total |

Independent root and reviewer probes also reproduced head-first, authority-first, and adapter-first
singleton imports; CREATED then UPDATED publication; exact replay and stale-attempt behavior with no
authority drift; stable zero-hook hostile publication rejection; forged, revoked, and consumed permit
rejection; exactly one winner for two writers on one predecessor; compound error precedence; the
exact assignment-then-return tail; and full-cap immutable-store replay without hashing while an
adjacent new identity rejects without hashing.

## 6. Gate D acceptance fold

| ID | Result | Terminal evidence |
| --- | --- | --- |
| P0B-D01 | PASS | Frozen P0a six-file tuple and P0a result rehashed exactly; no frozen file changed |
| P0B-D02 | PASS | PRE is 151/151; normalized inventory is 7,298 bytes at the frozen hash |
| P0B-D03 | PASS | FORWARD has identical names, order, outcomes, counts, normalized bytes, and hash |
| P0B-D04 | PASS | All 23 live and four strict controls remain unique, exact-once, executable, and red under mutation |
| P0B-D05 | PASS | Shared support is construction/mechanics only; no production validator moved into fixtures; topology scans pass |
| P0B-D06 | PASS | Fresh decomposition reviewer 3 returned PASS / GO after the two immutable D05 NO-GO findings were repaired |

## 7. P0b acceptance fold

This table is the repaired R2 successor fold. Section 4 and §§9.1–9.2 remain the immutable failed
tuple fold and review history.

| ID | Result | Terminal evidence |
| --- | --- | --- |
| P0B-01 | PASS | Public untrusted carriers are bounded bytes or minted handles; forged/proxied/property-bag controls invoke zero caller hooks |
| P0B-02 | PASS | Semantic permutations and fresh modules reproduce exact canonical bytes, digests, URIs, heads, and results |
| P0B-03 | PASS | Seed/configuration reproduce UUIDv7, event documents, source bytes/digests, order, and summary; both pinned vectors match |
| P0B-04 | PASS | Store snapshots before internal hashing; caller mutation cannot alter identity, bytes, ETag, or reads |
| P0B-05 | PASS | Bounded batch prepare/commit is atomic; failed members expose no partial batch |
| P0B-06 | PASS | Same digest/same bytes is idempotent; simulated same digest/different bytes rejects without overwrite |
| P0B-07 | PASS | Immutable reads implement exact 200/304/404 projections, strong ETags, immutable policy, fresh bytes, and no aliases |
| P0B-08 | PASS | In-process head create/update/read enforce exact 404/200/304/412/413/428 projections; 304 has no body |
| P0B-09 | PASS | Strong ETag is derived from exact served head bytes and changes exactly with those bytes; policy requires revalidation |
| P0B-10 | PASS | Pass A, store commit/readback, fresh store-owned Pass B, exact candidate/prior equality, and private permit precede CAS |
| P0B-11 | PASS | One synchronous CAS rechecks ETag, predecessor generation/digest, immutable closure, sealed fence, and private Pass-B permit |
| P0B-12 | PASS | Two same-predecessor writers yield one winner; loser changes no head, prior, hint, or counter authority |
| P0B-13 | PASS | Exact replay is `NO_CHANGE` only after synchronous current-fence confirmation; stale replay is `CONFLICT`; neither advances authority |
| P0B-14 | PASS | Stale, ABA, rollback, split-brain, partial tuple, wrong fence, cross-instance, and forged attempts reject without authority drift |
| P0B-15 | PASS | Every frozen exact/adjacent limit executes, including 1 MiB/event, 64 events/64 MiB, 19 MiB batch, and full 64-object store replay |
| P0B-16 | PASS | Status/error projections are deeply immutable, bounded, stable across repetitions/permutations, and omit attacker markers |
| P0B-17 | PASS | Parsed seven-node production graph is exact and acyclic; head imports only authority, authority owns publication/head state, adapter imports no head/authority, and all three fresh import orders share one singleton |
| P0B-18 | PASS | Hostile synchronous operations use construction-excluded workers and two-second parent deadlines with explicit FAIL/ERROR classification |
| P0B-19 | PASS | Complete ESLint parsing, hostile dynamic-form corpus, measured exactly-once counts, exact graph/caps/exports/anchors, changed-source M26/M27, and executable M32 all pass |
| P0B-20 | PASS | Two fresh non-author reviewers independently rehashed and reran the same 13-file successor and returned PASS / GO, exit 0, with no open finding |

## 8. Mutation fold

All 32 P0b transformations are unique, imported or otherwise evaluated exactly once, and bite:

1. hash before snapshot;
2. trust caller digest;
3. overwrite a digest collision;
4. expose a partial batch;
5. retain a caller byte view;
6. derive head ETag from the wrong bytes;
7. put a body on immutable `304`;
8. return stale head `304`;
9. omit a mutation precondition;
10. compare CAS by generation only;
11. compare CAS by state digest only;
12. split CAS across an asynchronous boundary;
13. skip immutable-closure readback;
14. skip sealed-fence recheck;
15. mutate head before store commit/readback;
16. install prior before CAS success;
17. bypass the frozen verifier;
18. advance authority on exact replay;
19. admit rollback, ABA, or same-generation divergence;
20. preserve caller insertion order;
21. emit noncanonical producer output;
22. use ambient scenario time/state;
23. enforce a limit late;
24. let a hint authorize head state;
25. accept a forged store/service/publisher/fence/scenario handle;
26. import test support from production;
27. import a forbidden filesystem/network/browser/renderer module;
28. promote a STRUCTURAL nonclaim;
29. skip store-owned Pass B;
30. install the Pass-A tentative record; and
31. return `NO_CHANGE` without current-fence confirmation; and
32. import the head facade from publication authority and recreate a production cycle.

The unchanged 23 live and four strict P0a controls also bite through the exact frozen Gate D
inventory. No carried red was de-scored or quarantined.

## 9. Independent terminal reviews

### 9.1 Reviewer 1 — protocol, determinism, persistence, and CAS

`p0b_terminal_protocol_review` rehashed all prerequisites and the nine-file tuple before and after,
reproduced PRE/FORWARD 151/151, Gate D's exact fingerprint, P0b 63/63, 58/58 registered mutants,
syntax, ESLint, Prettier, caps, and targeted authority probes, then returned PASS / GO with no candidate
finding. It also recorded two corrected reviewer-harness ERRORs: a malformed `*` precondition encoding
and comparison of a rejection `kind` to its `code`.

That GO missed the actual production cycle and therefore cannot certify P0B-17, P0B-19, or P0B-20.

### 9.2 Reviewer 2 — hostile bounds, identities, topology, races, and mutants

`p0b_terminal_security_review` independently reproduced the same green registered surface and exact
initial/terminal hashes, then performed a complete graph traversal. It returned FAIL / NO-GO, exit 1,
with HIGH / OPEN P0B-F01:

- head line 22 imports the adapter and adapter line 13 imports head;
- only one of six production nodes was topologically processable;
- the registered expected graph explicitly allowed both cycle edges and did no cycle check;
- a valid static import after an export was invisible to the line-oriented scanner; and
- M26/M27 bit without submitting changed source to the asserted policy gate.

It folded P0B-17 FAIL, P0B-19 FAIL, and P0B-20 FAIL. That verdict governs the tuple.

### 9.3 R2 reviewer 1 — protocol, atomicity, and precedence

`p0b_r2_protocol_reviewer` was a fresh non-author reviewer. It rehashed the 13-file successor before
and after review with zero mismatch; reproduced Gate D PRE/FORWARD 151/151, the exact 7,298-byte
inventory, the 15/20/36 individual suites, combined 71/71, 59/59 controls, all syntax/lint/format and
cap gates; and ran an independent 18-check authority probe.

The probe covered two-writer loss, stale attempt consumption, replay, rollback, hostile publication
with zero hooks and drift, compound error precedence, and the sole assignment followed only by
`return result`. The reviewer found no HIGH, MEDIUM, LOW, or STRUCTURAL issue and returned PASS / GO,
exit 0.

### 9.4 R2 reviewer 2 — hostile identities, parser topology, and mutations

`p0b_r2_hostile_reviewer` independently rehashed and reran the same 13-file successor. During its
preliminary pass it found two MEDIUM evidence defects: indirect `require` forms were invisible, and
the helper reported a constructed parse count of one instead of measuring parser invocations. Those
findings remained open while the author repaired the helper and corpus.

Against the final frozen tuple, the reviewer proved alias/call/global/computed `require`,
direct/alias/member/computed `createRequire`, and dynamic import are detected while lexical decoys are
clean. It also proved the double-parse negative reports seven counts of two and is rejected. The exact
seven-node graph is acyclic, each production file is measured once, M01–M32 bite, reused consumed
authority rejects without drift, and the assignment tail is exact. Both MEDIUM findings and
carry-forward P0B-F01 are FIXED on the successor. The reviewer returned PASS / GO, exit 0, with no
open finding.

## 10. Immutable failure chronology

### 10.1 Gate D decomposition reviews

The first decomposition candidate preserved PRE/FORWARD 151/151 but received FAIL / NO-GO with a HIGH
D05 finding: the shared fixture module carried assertion, verifier, admission, or oracle behavior.
That behavior was removed from shared construction support.

The second candidate again received FAIL / NO-GO with a HIGH D05 finding: the worker harness exported
`assertWorkerPass`, moving an acceptance oracle into shared support. The export and shared oracle were
removed. A third fresh reviewer then returned PASS / GO. Both earlier reds remain governing history
for their exact candidates and are not rescored.

Implementation also observed extraction, runner, and formatting reds before exact PRE/FORWARD parity
was reached. They were repaired without editing the frozen historical P0a suite.

### 10.2 R1 planning ambiguity

Read-only planning found that the base publication sequence did not unambiguously separate
producer-owned verification from store-owned authority, and that 64 MiB was unreachable through the
original authoring-only accounting. Production implementation remained blocked while R1 froze the
two-pass sequence and the independently bounded deterministic source-payload channel.

### 10.3 Producer and seeded stream

- A monolithic patch exceeded the Windows command-size boundary; smaller bounded patches were used.
- The seeded stream first exceeded its 700-line cap at 813 pre-format and 834 formatted lines; it was
  reduced to 695 without weakening behavior.
- A bounded patch had a context mismatch and made no change.
- The source known-answer vector initially emitted zero bytes because an already-bound setter was
  invoked with an extra `.call`; the binding was corrected.
- Valid zero-byte and one-byte sources later failed for the same double-call pattern on a bound length
  getter; the producer was corrected.
- A hostile primordial harness replaced `URL` before retaining the prototype and returned ERROR; the
  harness was repaired.
- Full ambient primordial poisoning remains an explicit fail-closed SES-style dependency nonclaim;
  it is not promoted to a production guarantee.

### 10.4 Immutable store

The first exact 64-object/32 MiB replay attempt rejected at the cap. An initial idempotence repair then
received independent NO-GO findings because a new object at full capacity hashed before rejection,
post-import `Hash.digest` poisoning could forge a digest, poisoned `Array.push` received private
records, forced late `Object.freeze` failure could install state before throwing, and typed-array
getter poisoning reached the path.

The terminal repair performs bounded exact-byte comparison before hash at saturation, captures and
brand-calls load-bearing intrinsics, passes no private record to ambient callbacks, validates receipt
body/URI/ETag/closure/epoch coherence, and precomputes every fallible artifact before the sole state
assignment. Intermediate repairs also produced a duplicate `mapSize` declaration, a wrongly uncurried
buffer getter, and a Prettier red; each was preserved and repaired.

### 10.5 Head service and P0a adapter

Independent review returned NO-GO when raw head APIs could seal and CAS an arbitrary one-object store
receipt without P0a Pass A/Pass B evidence. The terminal design requires an adapter-private,
non-issuable Pass-B permit at both seal and immediately before CAS. The adapter exports only a
non-issuing inspection predicate; direct bypass and forged permits reject without proxy traps.

The head module also produced a Prettier red and a hostile-replay red under intrinsic poisoning. The
adapter formatted to 739 lines, breaching its 700-line cap, before compaction reached exactly 700. A
moving-producer probe and the store's transient duplicate declaration temporarily blocked the
positive head gate. Each red was repaired and retained here.

### 10.6 Protocol/persistence acceptance

The first milestone reached 5/5. Expansion reached 9/10 when a test incorrectly required the
immutable store to remain unchanged after a late ABA CAS loss. The preregistration permits unreachable
immutable objects; the corrected oracle instead requires unchanged head, active prior, hint, and
counters. The suite then reached 10/10. It also produced a Prettier red, a PowerShell tuple-parser
ERROR, and a guessed hash-suffix mismatch before exact evidence was recorded.

### 10.7 Hostile-boundary acceptance

The first runnable suite was 5/7: a 17-patch fixture hit the target guard before its intended boundary,
and query-isolated worker modules broke the intended shared handle identity. Both fixture defects were
repaired. A Prettier red and a PowerShell tuple-report parser ERROR were also observed before the final
18/18 result.

### 10.8 Topology and mutation acceptance

Initial M15/M16 harness errors, weak M21/M22 oracles, Gate D path-discovery errors, a patch-transport
regex parse ERROR, and two import-scanner false negatives were repaired. The formatted spec then
breached its 1,600-line cap at 1,654 lines and ESLint reported four unused imports. Compaction and
import cleanup produced the terminal 1,590-line, 35/35 tuple with all 31 P0b mutants biting.

### 10.9 Tooling and evidence-command errors

The native patch helper repeatedly failed to write on Windows, so the approved apply-patch executable
fallback was used. Several read-only PowerShell hash, brace-count, static-regex, quoting, and negative
`rg` harnesses returned parser or harness errors before corrected commands produced evidence. These
are ERROR chronology for those commands; they do not replace the later clean gates.

### 10.10 Conflicting terminal reviews and P0B-F01

Both reviewers judged the same stable nine-file tuple and reproduced all registered green evidence.
The first returned GO; the second exposed the cycle and scanner false negative and returned HIGH /
FAIL / NO-GO. This is not a flaky measurement or tuple drift. The security review's valid expectation
miss governs and the first GO remains immutable evidence of a review blind spot.

### 10.11 R2 preregistration reviews

The first R2 design candidate was 18,560 bytes / 286 lines at
`64b36e9617aee062043fc5eb164da8f53bd1faae893d474ac2dcb3dc09df166`. Independent review returned FAIL
/ NO-GO: stale preparation ownership was under-specified, facade/export names and arities were not
frozen, and parser provenance was outside the exact tuple.

The amended R2 at `a4d4bc0f331a738ce8bb4f9b05a286422cafa612d0835281377eec277558dcfc`
assigns currentness only to one publication authority, freezes exact adapter/authority/facade APIs,
and pins package manifests plus Node/ESLint identity in a 13-file envelope. A different fresh reviewer
returned PASS / GO with all three findings fixed. This authorizes bounded repair, not a terminal PASS.

### 10.12 R2 implementation and terminal repair

The adapter/head cycle was removed by making the adapter preparation-only, moving all mutable
publication and head state into one authority module, and reducing head service to a 14-export facade.
The first authority integration probe exposed a real raw replay bypass: `sealPublicationFence`
returned authoritative `NO_CHANGE` before validating the private permit. The check order was repaired;
the identical probe then returned `CLOSURE_INVALID` with zero state drift.

The first protocol-suite migration retained an obsolete cross-store expectation and ran 11/12. The
R2 behavior rejects the cross-store publisher immediately as `INVALID_HANDLE`; the corrected suite
reached 13/13. Preliminary protocol review then required registered adapter-first import evidence,
valid-context hostile-publication evidence, and compound error precedence. The expanded frozen suite
reached 15/15.

The hostile suite first ran 17/18 because a query-isolated head facade retained its ordinary static
authority import; the foreign-service fixture was corrected to mint from the foreign authority. Its
first expanded run was 19/20 because one local wrong-kind fixture name was stale. The final suite is
20/20.

The parser/topology suite initially inherited the failed six-node graph, stale authority anchors,
and raw-head mutant drivers that the repaired private boundary correctly rejected. After the controls
were moved through genuine high-level preparation paths, M01–M32 bit. Preliminary hostile review then
found indirect `require` evasion and fabricated parse counts. Complete AST detection, measured counters,
and a double-parse negative repaired both. The formatted topology spec reached 1,791 lines against its
1,600 cap before policy-preserving fixture/registry compaction produced the frozen 1,597-line, 36/36
candidate. Expected Prettier, quoting, wildcard, executable-path, and patch-transport errors were
corrected and rerun; none is promoted into implementation evidence.

### 10.13 R3 clean-clone finding and design reviews

The clean landing clone was based at `aa9409432dae07ce65341304a6b2b2b226d62309`. It contained the
exact 34-file checkpoint candidate and used the existing offline `node_modules` installation through
a local junction. Gate D remained exact. The serial P0b command ran 70/71: P0B-19 threw `ENOENT` for
root `package-lock.json`. Repository policy deliberately ignores that file and sets
`package-lock=false`; Git has no tracked/history copy. The ignored local file described Cesium
1.143.0 and ESLint 10.5.0, not tracked Cesium 1.144.0 or executed ESLint 10.8.1. Force-adding or
copying it would have hidden the missing file without proving the parser actually used.

R3 design review then preserved three successive HIGH / FAIL / NO-GO tuples:

1. `4cfb154b31bd1f334f361129988b3858e529565aace0e8c2d04ff2c1a4cf6782` proved exact package bytes but
   could not discriminate parent-relative from root-relative resolution in a flattened install;
2. `ce2be391200b991dea3acd3f4723f02948ce7695eaf17c06ecdc2de920bbf849` traced the plan callback but
   left the internal filesystem callback free to ignore its parent; and
3. `cce6d417260500c67e806664699a372ec17a147c8f79f2070883d4f6dd53a506` traced resolver construction
   but did not bind the returned resolver to the paths consumed by measurement.

The final 18,989-byte / 294-line R3 design at
`9cdebb6b34afe794efbe95904434b3005bbb75140a4bb4b287fe08ecc3484d19` binds the complete chain:
parent plan → resolver factory → factory-returned resolver identity → both resolved paths →
resolution-free measurement. R3M-01 through R3M-03 keep package records identical while making only
the wrong plan/factory/consumption trace red. A fresh reviewer independently rehashed that design,
marked R3-D01 through R3-D03 FIXED, and returned PASS / GO with zero open findings. This is design
authorization only; implementation evidence remains pending.

### 10.14 R3 implementation cap and R4 placement review

The first default-Prettier-stable R3 implementation put both graph analysis and package provenance in
`module-graph-v0.mjs`. Syntax and ESLint were green, but the file was 18,022 bytes / 416 lines at
`1ec9a3443e53bba1bf932a7d741f38da219dce30f69f0f54386fbb647888d18c`, exceeding its hard 350-line
cap by 66. The concurrent topology edit was 64,073 bytes / 1,593 lines at
`7293fa6ecd9e7771d3806cb325fde031d842f9bfc0ed0ab8d7fd7e0e9f4c78b8`; it remained within cap and
removed only the stale lock/runtime oracle. The new provenance spec did not yet exist. P0B-F03 is a
measured FAIL / NO-GO. It is not repaired by formatter-ignore compaction of unrelated graph behavior.

R4 separates responsibilities: restore the graph helper exactly to its R2 identity and place the
unchanged approved provenance mechanics in a dedicated 220-line helper. Its first design candidate
was 9,182 bytes / 141 lines at
`8979d04d2854bcb7540fef8e87d68235eb4740609ad4cda7e82eefcab3bc5c59`. Independent review confirmed
the placement and arithmetic but returned HIGH / FAIL / NO-GO because R4A-01 required rehashing three
historical R3 design versions whose bytes were never banked.

The amended R4 at `f4e75c2fee24c116e2d3f4cf33f2e70ed1412908315aa4b9a72c47588dd827a0`
requires byte rehashes only for available artifacts and exact cross-comparison of the recorded
R3-D01–D03 identities/dispositions. A fresh reviewer reproduced the R3 authority, pre-R4 result,
P0B-F03 files, policy prerequisites, recoverable R2 helper, and chronology cross-check; marked R4-D01
FIXED; and returned PASS / GO with no open finding. This authorizes only the bounded R4 placement and
does not close P0B-F02/P0B-F03 without terminal evidence.

The bounded R4 implementation restored `module-graph-v0.mjs` exactly to 8,456 bytes / 292 lines /
`2c21b6727f76746419c0f44e7496f17ce51dd135205449351c6cd3b54ef60fbc`. After one readable
default-Prettier consolidation pass, the dedicated helper remained 10,092 bytes / 315 lines /
`f2fd7c89828f0f8fd7cd729fe42e25607623c757c3e11b4a2868c50f73e4f1d3`, 95 lines above R4A-03's
hard 220-line cap. Node syntax passed and Prettier was stable; ESLint and the new provenance spec were
not run after the binding cap turned red. R4A-03 is FAIL / NO-GO for that exact tuple. P0B-F03 remains
open, no production or prior-test identity is rescored, and implementation is paused pending a
preregistered and independently reviewed successor placement.

### 10.15 R4 mechanics audit and R5 boundary

An independent adversarial audit rehashed the exact `f2fd7c89...` helper and returned NO-GO with two
additional findings. P0B-F04 is HIGH: record validation applied the hash regular expression without
first requiring primitive strings, then shallow-froze spread caller data. A coercible hash object was
accepted in all five records while the nested object remained mutable; the reproduction reported
`{"accepted":5,"hashType":"object","nestedFrozen":false,"recordFrozen":true}`. P0B-F05 is MEDIUM:
pathname `lstat` followed by pathname recursion/read did not detect same-length rewrites and left a
symlink/type-swap window, so the stated drift and no-symlink guarantees were incomplete.

The successor must therefore do more than change a cap. It must reconstruct an exact primitive record
schema, reject unexpected/coercible fields, and implement stable two-pass or equivalent identity-checked
measurement that detects same-length content changes and path-type/symlink swaps. Dedicated biting
controls must prove both repairs. Separating package-tree measurement from resolver orchestration is
the preferred review boundary; its exact caps, arithmetic, and authority remain pending a frozen R5
preregistration and fresh independent design GO.

### 10.16 First R5 design review and platform feasibility

The first frozen R5 candidate was 13,795 bytes / 219 lines /
`eb47d02f71b0921e1ce803ec36e8bef0522aa1e4c215857c964b5a259057ad27`. Its fresh reviewer rehashed
all available premises and returned HIGH / FAIL / NO-GO with R5-D01: the injected two-pass comparator
could reject prepared projections even if the real descriptor/path reader remained inert. That made
the proposed P0B-F05 closure vacuous at the capability boundary.

A separate Node v22.23.2 Windows feasibility audit also returned NO-GO. It confirmed getter-free
schema inspection, bigint stats, descriptor reads, defensive buffer copies, and in-memory data-URL
linking are feasible, but Windows exposes no `O_NOFOLLOW`, `O_DIRECTORY`, or `O_SYMLINK`. The amended
design therefore binds controlled low-level mechanics to the same fixed real pass, names lossless
`mtimeNs`/`ctimeNs` identities, separates coercion and drift subcases, defensively copies both passes,
and disclaims an impossible kernel-atomic swap-and-restore guarantee while retaining fail-closed
rejection at every observed boundary. The failed R5 identity remains immutable and authorizes no
implementation; the amended candidate requires fresh review.

### 10.17 Final R5 seam specification and design GO

The first amended R5 candidate was 16,604 bytes / 251 lines /
`859499dfae4919adc9955769e300669f90c0904d2c492613137666bdaa0a06bc`. Fresh rereview returned HIGH /
FAIL / NO-GO because R5-D01 remained partially open: component controls proved the descriptor reader
and comparator separately, but a cached first traversal could still be supplied twice. The six
mechanics and pass-projection contracts were also called exact without enumerated names, signatures,
or schemas. That identity remains immutable and authorizes no implementation.

The final R5 at `eea3692c77d8a2a7cf49319e67ff6a7ec103a092a25d739736f14d216497f67d`
freezes all six arity-one mechanics, getter-free stat/projection schemas, the direct fresh-traversal
callback, defensive copies, independent mutation subcases, and integrated R5M-04 evidence through
the complete mechanics measurer. A fresh reviewer read the actual newest 2026-08-24 rulings, rehashed
all available authorities and runtime package records, marked both R5-D01 findings FIXED at design
level, and returned PASS / GO with no open design finding. R5 targets 15 source files, 73 tests, 66
controls, 22 syntax/ESLint files, and a 420-line aggregate helper cap. This authorizes implementation
only; P0B-F02 through P0B-F05 remain open until terminal evidence.

### 10.18 R5 implementation cap result

Celebrimbor's resolver/orchestration helper stabilized at 3,145 bytes / 94 lines /
`1371c339a748c593eb55469176114a74d7b1aa682f384c8c17f80b0f09c4ea6b`. Syntax, ESLint, Prettier,
exact imports/exports/arities, and an in-memory five-factory/ten-resolver/five-measurement trace passed.

Aulë's first readable tree-helper publication was 15,971 bytes / 515 lines /
`f9a482e8...9af2`: syntax and ESLint passed while Prettier check was red. One bounded consolidation and
default-format pass produced an intermediate namespace-lint red, which was repaired without changing
scope. The final helper is 15,213 bytes / 485 lines /
`7108d6d54457f306469d5b0acedc790a388dbe54bd4dc6fd790fd2495b58f9c9`; syntax, ESLint, and Prettier
all pass, but it exceeds R5's hard 320-line cap by 165. R5A-03 is FAIL / NO-GO and P0B-F03 remains
open. The provenance spec was not frozen or executed after that binding red. Implementation stopped;
no terminal, clean-clone, or checkpoint evidence is claimed for this tuple.

Galadriel paused the unformatted implementation scaffold at 11,850 bytes / 339 lines /
`effb1616eca16133c28f5c511c550195db45740ae19bcdf876ca0cbc15f4146a`. It deliberately retains
`PENDING-STABLE-TREE`, contains zero top-level tests, and makes no P0B-21/P0B-22 or quality-gate claim.

### 10.19 R5 source audit and P0B-F06

A fresh source auditor rehashed the exact failed R5 tuple and independently reproduced the five
package records, collision-safe digests, two descriptor traversals, all registered drift rejection,
coercible-record rejection, defensive copies, and the resolver chain. It nevertheless returned
NO-GO with P0B-F06 (MEDIUM): `wrapParserProvenanceFailure` read `error.message` and then used
`String(error)`. A thrown object with a throwing message getter escaped as a native `Error` with
`frozen === false`, `status === undefined`, and message `message-getter-fired`, rather than an
immutable `status === "ERROR"` result. R6 must inspect descriptors without invoking getters or
coercion, use a fixed fallback, and add a biting two-case control through both mechanics and resolver
wrappers.

The audit also found that the unfinished scaffold's expected trace placed a directory's
post-enumeration `lstat` after child traversal. The binding implementation/design order is immediate:
directory `lstat` → `readdir` → directory `lstat` → children. R6 fixtures must encode that order and
must not inherit the scaffold's provisional trace.

## 11. Nonclaims and next boundary

P0b-core does not implement or prove:

- sockets, HTTP parsing, proxies/CDNs, SSE, TLS, or disconnect behavior;
- filesystem persistence, paths, atomic rename, durability, crash recovery, or cross-process fencing;
- deletion, physical garbage collection, compaction, retention, leases, pins, durable outbox, or
  storage reclamation;
- signatures, trusted time, freshness, restart anti-rollback, revocation, or deployment constants;
- external base, patch-payload, or heavy-resource closure, including original P0A-19;
- renderer/runtime generation transactions, invalidation masks, compositor behavior, cache ownership,
  retirement, collision policy, memory/accounting closure, or query/pick behavior;
- Cesium engine integration, WebGL, WebGPU, pixel parity, performance, memory, or request-count claims;
- standards registration, compatibility guarantees, production readiness, or full design §15.0 P0.

Even after a clean P0B-20 result, GO is limited to the process-local unsigned scope above. Renderer,
WebGL, and WebGPU work remains NO-GO until a later preregistration resolves external closure,
freshness/revocation, runtime transaction ownership, mask semantics, cache/retirement ownership,
collision, and accounting blockers.

## 12. Result-document closure

This result document is outside both the failed nine-file tuple and the R2 13-file successor envelope.
It remains within its 700-line cap and must pass Prettier. The exact review-time result identity before
the two terminal verdicts was 23,860 bytes / 349 lines /
`6132ef67c8358135795e3e1106dbd11086e5bdb40f5b7e9031c3f99364e611b0`; the earlier provisional
identity was 21,260 bytes / 312 lines /
`12bd7b22093f8518cfb4f9f78d6408c93c4432d69e042b31e2fa8c161db90828`. The post-verdict result
identity is recorded in the landing/checkpoint manifest rather than self-referentially inside this
file. Editing this chronology does not mutate or rescore either reviewed tuple.
