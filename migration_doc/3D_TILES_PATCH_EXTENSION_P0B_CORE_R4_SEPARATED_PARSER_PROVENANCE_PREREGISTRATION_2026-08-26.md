# 3D Tiles patch extension P0b-core R4 separated parser-provenance preregistration

**Date:** 2026-08-26  
**Status:** amended after design-review NO-GO; frozen pending fresh design rereview  
**Scope:** non-weakening placement repair for P0B-F03 formatter-stable helper-cap failure  
**Lane:** local-only, browser-free, GPU-free, network-free, no deletion, no external publication;
local Git is permitted only after all successor gates and reviews pass

## 1. Authority and decision

R4 supplements, and only where expressly stated replaces, the frozen R3 preregistration:

| Authority | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_R3_TRACKED_PARSER_PROVENANCE_PREREGISTRATION_2026-08-26.md` | 18,989 | 294 | `9cdebb6b34afe794efbe95904434b3005bbb75140a4bb4b287fe08ecc3484d19` |
| pre-R4 `3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | 34,008 | 477 | `9725f43c900c68eb34a1144072941b9011d2eb7720770778b81af7e8c5fba023` |

The final R3 design received independent PASS / GO with R3-D01 through R3-D03 fixed. R4 does not
change its digest, package set, parent-resolution plan, factory/resolver/path binding, controlled
traces, mutation oracles, runtime records, functional gates, nonclaims, or review reset. It changes
only the source-file placement required to implement those approved mechanics readably within hard
caps.

All base, R1, R2, and R3 clauses not expressly replaced remain binding. R4 authorizes no production,
package, dependency, protocol, authority, Gate D, renderer, or Git-policy change.

The first R4 design candidate was 9,182 bytes / 141 lines at
`8979d04d2854bcb7540fef8e87d68235eb4740609ad4cda7e82eefcab3bc5c59`. Its independent reviewer
confirmed the placement, caps, and arithmetic but returned HIGH / FAIL / NO-GO with R4-D01: R4A-01
asked for byte rehashes of three failed historical R3 design versions that were recorded by identity
but never banked as recoverable files. This amendment requires executable rehashes only for available
artifacts and exact cross-comparison of the preserved R3-D01–D03 chronology. The failed R4 design
remains immutable and authorizes no implementation.

## 2. Immutable failed R3 implementation and P0B-F03

The first formatter-stable R3 implementation attempt is frozen as chronology:

| Artifact | Bytes | Lines | SHA-256 | Result |
| --- | ---: | ---: | --- | --- |
| `Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` | 18,022 | 416 | `1ec9a3443e53bba1bf932a7d741f38da219dce30f69f0f54386fbb647888d18c` | FAIL: R3 cap is 350 |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | 64,073 | 1,593 | `7293fa6ecd9e7771d3806cb325fde031d842f9bfc0ed0ab8d7fd7e0e9f4c78b8` | within 1,600 cap; stale lock oracle removed |

`p0b-parser-provenance.spec.mjs` had not been created. The helper passed syntax and ESLint, and its
semantics followed the approved R3 design, but default Prettier produced 416 physical lines. That is a
measured acceptance red. Compacting more than 60 lines into formatter-ignored one-line functions would
meet a number while reducing reviewability and mixing filesystem provenance with the already-frozen
module-graph responsibility. P0B-F03 therefore governs; the attempt is FAIL / NO-GO and cannot be
committed or used as terminal evidence.

## 3. Replacement placement

### 3.1 Restore the graph helper

`Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` must return byte-for-byte to the terminal
R2 identity:

| Bytes | Lines | SHA-256 |
| ---: | ---: | --- |
| 8,456 | 292 | `2c21b6727f76746419c0f44e7496f17ce51dd135205449351c6cd3b54ef60fbc` |

It retains only complete-module parsing, measured parse counts, import/dynamic-form extraction, graph
normalization, and topological traversal. Its doubled-parser negative and all R2 topology behavior
must rerun unchanged.

### 3.2 Dedicated provenance helper

R4 adds `Tools/patch-prototype/p0b/test-support/parser-provenance-v1.mjs`. It owns every R3-approved
provenance mechanic formerly assigned to the graph helper:

- collision-safe `P0B-PARSER-PACKAGE-TREE-V1` framing;
- regular-file enumeration, bytewise UTF-8 path ordering, nested-`node_modules` exclusion, and
  symlink/special/escaping-path rejection;
- exact manifest, entrypoint, whole-tree, count, byte, version, and Node identity records;
- `resolveParserPackagePlan(resolvePackage, rootContext)` with arity two;
- `inspectParserProvenanceWithMechanics(rootContext, resolverFactory,
  measureResolvedPackageFiles)` with arity three; and
- non-injectable `inspectParserProvenance(rootContext = import.meta.url)` with arity zero and the exact
  delegation tail frozen by R3.

The helper returns deeply frozen records and throws an immutable error with `status === "ERROR"` for
unavailable, malformed, unsupported, escaping, drifting, or otherwise unmeasurable prerequisites. It
contains mechanics only: no expected version/hash record, acceptance oracle, mutant result, graph
policy, package install, fallback parser, production validator, or network behavior.

### 3.3 Specs

The existing topology spec keeps the exact R2 graph, parser corpus, 32 mutants, exports, anchors,
arities, and 1,600-line cap while removing only the stale root-lock/runtime oracle from P0B-19. The
new `p0b-parser-provenance.spec.mjs` imports the dedicated helper and owns the frozen five-package
record, tracked `package.json` hash, no-lock assertion, controlled plan/factory/resolver/path traces,
exact public delegation, and R3M-01 through R3M-03. It has exactly two tests, P0B-21 and P0B-22.

## 4. Authorized artifacts and caps

Only these additions or changes are authorized by R4:

| Artifact | R4 role | Maximum physical lines |
| --- | --- | ---: |
| `Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` | exact R2 restoration | exactly 292 |
| `Tools/patch-prototype/p0b/test-support/parser-provenance-v1.mjs` | readable isolated R3 mechanics | 220 |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | remove stale lock/runtime oracle only | 1,600 |
| `Tools/patch-prototype/p0b/p0b-parser-provenance.spec.mjs` | exact runtime record and R3 controls | 300 |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | preserve P0B-F03 and record successor | 700 |
| this preregistration | bounded placement authority | 230 |

All other implementation and prerequisite files remain byte-identical. The successor source envelope
is 14 exact tracked files: seven production modules, four P0b specs, two test-support helpers, and
tracked root `package.json`. `.gitignore` and `.npmrc` remain separately frozen policy prerequisites.

## 5. R4 acceptance

| ID | Required verdict | Acceptance predicate |
| --- | --- | --- |
| R4A-01 | PASS | Current R3 authority, P0B-F03 tuple, prior result, policy files, and frozen prerequisites rehash exactly; recorded R3-D01–D03 hashes/dispositions cross-match R3 and result chronology without claiming unavailable historical bytes were rehashed |
| R4A-02 | PASS | `module-graph-v0.mjs` is exactly 8,456 bytes / 292 lines / `2c21b672...`; its complete corpus, measured counts, and doubled-parser negative remain green |
| R4A-03 | PASS | Dedicated helper implements the exact R3 digest/resolution/measurement contract readably within 220 lines and contains no policy oracle or fallback |
| R4A-04 | PASS | Provenance 2/2 reproduces the exact runtime record; controlled traces bind factory-returned resolver identity through both resolved paths; R3M-01 through R3M-03 bite with identical records |
| R4A-05 | PASS | Topology remains 36/36 and within 1,600 lines; no source under `Tools/patch-prototype/p0b` reads root `package-lock.json` |
| R4A-06 | PASS | PRE/FORWARD remain 151/151; protocol 15/15, hostile 20/20, topology 36/36, provenance 2/2, and serial P0b 73/73 have no skip/cancel/todo |
| R4A-07 | PASS | All 59 prior plus three R3 controls bite; syntax 21/21, ESLint 21/21, and Prettier over every named artifact are green |
| R4A-08 | PASS | An independent digest-v1 implementation reproduces all five package records; exact source/runtime hashes remain stable |
| R4A-09 | PASS | The clean landing clone contains no root lock and reproduces Gate D, 73/73, 62 controls, references, caps, and exact identities |
| R4A-10 | PASS | Two fresh non-author terminal reviewers rehash one successor, rerun assigned gates, close P0B-F02/P0B-F03, and return GO with zero findings |

Any new measured red governs. The passed R3 design review authorizes only this bounded placement; it
does not count as implementation or terminal review.

## 6. Required evidence and review boundary

The result records the exact P0B-F03 tuple, R4 design review, 14-file source envelope, five-package
runtime envelope, graph-helper restoration, all individual/combined suites, 62 controls, syntax,
ESLint, Prettier, independent digest, absence/non-use of the root lock, clean-clone reproduction,
tracked-reference verification, and two fresh stable-tuple terminal reviews.

An independent design reviewer must return GO on frozen R4 before implementation resumes. After
implementation, one fresh reviewer owns protocol/regression replay and one owns
hostile/topology/provenance review. The repair author cannot review. Workers never run Git writes.
Only after every R4 gate and both terminal reviews pass may the orchestrator create a local checkpoint
commit. No push, remote branch, browser, GPU, network, install, deletion, or external publication is
authorized.

## 7. Unchanged nonclaims

R4 does not implement or prove sockets, HTTP, persistence, durability, deletion, GC, transport,
signatures, freshness, revocation, restart anti-rollback, external/heavy closure, Cesium, renderer
transactions, masks, cache/retirement ownership, WebGL, WebGPU, pixels, performance, standards
promotion, production readiness, or full design §15.0 P0. No historical FAIL, ERROR, or reviewer blind
spot is removed or rescored.
