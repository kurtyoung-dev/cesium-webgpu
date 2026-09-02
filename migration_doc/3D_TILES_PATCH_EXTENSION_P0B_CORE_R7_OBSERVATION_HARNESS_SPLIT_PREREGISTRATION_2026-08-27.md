# 3D Tiles patch extension P0b-core R7 observation-harness split preregistration

**Date:** 2026-08-27  
**Status:** design candidate pending two fresh independent reviews; no implementation authority  
**Scope:** non-weakening provenance test-mechanism split after the R6 spec-cap structural red  
**Lane:** local-only, browser-free, GPU-free, network-free, deletion-free, and externally unpublished;
the separately authorized local Git checkpoint remains gated on complete successor certification

## 1. Authority and decision

R7 supplements the exact R6 design and replaces only provenance source/image/mutation plumbing
placement, the affected graph and inventory arithmetic, implementation paths, and caps:

| Authority | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| R6 snapshot/fixture split preregistration | 29,579 | 400 | `41253a6aeddf40f04e0a2d76a377e633e8c7f0bfd95fa9be8ca63c1f23290deb` |
| R5 split-package-tree preregistration | 19,399 | 290 | `eea3692c77d8a2a7cf49319e67ff6a7ec103a092a25d739736f14d216497f67d` |
| current P0b result | 43,398 | 602 | `250d3bba7bdcd7750cb7b2580349884b0c59cdb1d17f48fe7eb50f41a062b3d8` |

All R6 error, filesystem, fixture, oracle, mutation, image, gate, chronology, and nonclaim clauses
remain binding unless R7 expressly replaces them. P0B-F02 through P0B-F06 remain OPEN. R7 design
approval closes none of them and authorizes neither certification nor a checkpoint.

The R6 design is frozen and is not edited. No R7 implementation may begin until two fresh,
independent, read-only reviewers rehash this exact candidate and both return unconditional PASS / GO
with zero open finding. Any red governs.

## 2. Immutable implementation reds and prerequisites

No R6 red is rescored:

| Artifact | Frozen evidence | Disposition |
| --- | --- | --- |
| Aulë snapshot draft | 14,689 / 392 / `7b40186bdfc863b5b4b19a9ce21bdf077f8f6d3996deaae9c34c365ec080c1d6` | FAIL against cap 340 |
| first fixture helper | 8,897 / 298 / `6904df499ad1ee2b33bbd0379c55ec14234ffb3e214cc3a0a8b5a4e0f626865c` | FAIL: exported `readTrace` function was not frozen |
| Gimli topology draft | 74,460 / 1,900 / `e2f9249912de8b55b96afe2ccda5cb271495536c086117a2dfedb693ce9582ec` | FAIL against cap 1,600 |
| Dáin topology draft | 70,883 / 1,740 / `d5c8fdb6fcec7c04ff864c6387546034ccc6b4b12abfb052e8659ddc1a903874` | FAIL against cap 1,600 |
| Turgon topology candidate | 69,927 / 1,598 / `2d860d171dd5542be532517c1cc6dd92435057d5bda38ce201a08479d90e2af4` | conditional 35/36; sole red is the sibling provenance cap |
| Legolas semantic spec | 35,651 / 1,122 / `d120396918a7565b4b66f7ad939df805e039eac8539fbce9dea7a2eee8fa116f` | FAIL against effective cap 501; all prior semantic assertions passed |
| Finrod spec stop | 33,912 / 940 / `38a9a55f5c64db98fb21964a58dfb3d41a056f2371a2108d9dfc443c28b710b2` | FAIL against effective cap 501 |
| Nerdanel spec stop | 32,907 / 884 / `36dfd80c83166d841d22cb38ed38536e63e723d72f7093a682d0eeee6a8c947b` | FAIL against effective cap 501; further reduction required weakening, opaque packing, or a new responsibility split |
| first R7 design candidate | 17,839 / 257 / `09ce8c8cc108b33f88a6317419993ea0f52d2d6425296f03effe8cea0a9e9ebf` | FAIL / NO-GO: cross-graph URL/namespace isolation was not exact, inverse input controls were absent, and the non-binding combined ceiling was mislabeled stronger |
| second R7 design candidate | 19,508 / 273 / `6f8b85976f35171a4a2633ccfb3af6ca4f53067645a35a7e532440fa0021f062` | FAIL / NO-GO: frozen-fixture oracle ownership contradicted sole-spec wording, affected-edge scope was mislabeled global, and tag reservation lacked failed-import, concurrency, and coercible-non-string teeth |

Two earlier Legolas executions are chronology-only: first 0/2 for a wrong post-read trace plus an
unidentified arity error, then 0/2 after identifying arity-zero callbacks in P0B-21 and R5M-04.
Their byte images were not frozen and are not falsely claimed recoverable. The later exact Legolas
tuple reached both test ends and failed only its two line-cap teeth. All intermediate FAILs remain.

The exact immutable implementation prerequisites are:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| snapshot helper | 13,557 | 340 | `d02bf1d98fcc7b83b4ee047218779d330ee05a7434b24cf7998118f8106a71e3` |
| package façade | 6,336 | 183 | `c14c64c66de473cfacd37a1143fa24f4a9a530eec8fdc776858d166db581bc91` |
| resolver helper | 3,145 | 94 | `1371c339a748c593eb55469176114a74d7b1aa682f384c8c17f80b0f09c4ea6b` |
| fixture helper | 8,925 | 299 | `d30319cc6cd4482a755fb701572e05ea67bcc8aecdb211fd7c77734c7ea6c3f0` |
| mutation harness | 2,309 | 74 | `7ac9b7b3b47ea8deb3f15c7a9c10d53e09df5e9d6f1c9e0e1d12cf44537d8f14` |
| module-graph helper | 8,456 | 292 | `2c21b6727f76746419c0f44e7496f17ce51dd135205449351c6cd3b54ef60fbc` |

## 3. Genuine responsibility split

Add `Tools/patch-prototype/p0b/test-support/parser-provenance-harness-v1.mjs`. It owns only generic
source loading, actual identity measurement, one-subject exact replacement, deterministic data-URL
linking/import, and opaque returned/thrown capture. It is control-plane test support, never a source
image or an oracle.

A cap-only raise is rejected. The R6 spec mixed adjudication with about 90 lines of reusable source
loading, hashing, linking, mutation, module identity, and raw outcome mechanics. R7 moves that genuine
mechanism responsibility behind one exact interface while the spec remains the sole adjudicator.

The harness imports exactly:

- `createHash` from `node:crypto`;
- `readFileSync` from `node:fs`; and
- `moduleDataUrl` and `replaceExactlyOnce` from `./mutation-harness-v0.mjs`.

It has no default export and exactly these named exports:

| Export | `Function.length` | Exact purpose |
| --- | ---: | --- |
| `captureParserOutcome` | 1 | invokes one synchronous action once and returns its raw returned or thrown value opaquely |
| `loadParserProvenanceSourcePacket` | 1 | reads exact image/reference path maps and reports actual sources and identities |
| `materializeParserProvenanceMutation` | 3 | asynchronously creates one unchanged or exactly-one-subject four-image module graph under one tag |

`captureParserOutcome(action)` returns a frozen exact-data object with keys `kind`, `value`;
`kind` is primitive `"returned"|"thrown"`. It never freezes, spreads, coerces, stringifies,
inspects, applies `instanceof` to, reads `.message` from, or obtains the prototype of `value`.

## 4. Source packet and identity schema

`loadParserProvenanceSourcePacket(paths)` getter-freely reconstructs one caller-owned exact-data map
with keys `images`, `references`; extra, symbol, or accessor properties are rejected without invoking
getters. `images` has exact order `snapshot`, `facade`, `resolver`, `fixture`.
`references` has exact order `r6Design`, `r7Design`, `gitignore`, `graph`, `mutationHarness`, `npmrc`,
`own`, `package`, `provenanceHarness`, `topology`. Path values are trusted test-owned file references;
the harness makes no hostile-path-input claim.

It returns a module-branded, deeply frozen exact object with keys `sources`, `identities`. Each owns
exact nested maps `images`, `references` in those orders. Source values are primitive strings. Every
identity is a frozen exact record with own keys `bytes`, `lines`, `sha256`; values are a safe integer,
a safe positive integer under the LF physical-line rule, and a lowercase primitive SHA-256 string.
No expected byte, line, hash, path, record, trace, error, control, or verdict value exists here.

`materializeParserProvenanceMutation(packet, mutation, tag)` accepts only a branded packet, primitive
tag matching `^[a-z0-9][a-z0-9._-]*$`, and either `null` for an unchanged successor or an exact-data mutation with keys
`subject`, `anchor`, `replacement`. `subject` is primitive `snapshot|facade|resolver`; the other two
values are primitive strings treated opaquely. Mutation reconstruction rejects every extra, symbol,
or accessor property without invoking getters. Packet, mutation, subject, and tag validation completes
before linking/import. Exactly one selected raw source is replaced exactly once. Missing or ambiguous
replacement is a setup failure, never a mutant kill.

The module owns a private used-tag set. Primitive type and grammar validation precede lookup. The
unused check and insertion execute synchronously in one uninterrupted call stack, with no `await`
between them, before any link/import. Reservation is permanent even when later linking/import
rejects; no success or failure path releases or reuses it. Every later duplicate rejects at that
gate before linking/import. Each image fragment is exactly
`p0b-r7-${tag}-${image}`, making the accepted tag/image pair injective under the frozen mutation
harness grammar. The function builds one uniquely tagged `snapshot -> facade -> resolver` chain and
one unchanged, uniquely tagged fixture data URL. The fixture is unreachable from every subject. It returns a frozen
exact object with keys `apis`, `canonicalIdentities`, `mutationIdentities`, `linkedIdentities`, `tag`,
`urls`; all image maps use exact order `snapshot`, `facade`, `resolver`, `fixture`. `apis` retains raw
module namespaces without freezing or inspection. Identity records use §4's exact schema.
`canonicalIdentities` measure packet bytes, `mutationIdentities` measure post-replacement/pre-link
bytes, and `linkedIdentities` separately measure import-rewritten bytes. `urls` are primitive strings.

The harness never imports a subject or fixture statically. It contains no `node:test`, assertion
library, `createRequire`, parser package oracle, expected trace, expected hook count, mutant/control
ID, anchor/replacement literal, error fallback/schema literal, Proxy discriminator, module-graph
policy, product import, Git, install, network, temporary file, cleanup, browser, GPU, or deletion.

## 5. Spec-owned adjudication and experiment order

`p0b-parser-provenance.spec.mjs` imports exactly `node:assert/strict`, `node:test`, the five exact R6
fixture bindings, and the three R7 harness bindings. It no longer imports the mutation harness
directly and never imports snapshot, façade, or resolver statically.

The frozen fixture remains the sole data home for its inherited `PARSER_RECORD_KEYS` and
`EXPECTED_PARSER_PACKAGES`; its derived private `PACKAGE_BY_NAME` remains byte-exact. The spec is the
sole adjudicator, not the sole data home. It independently owns the literal fixture source identity
(bytes, physical lines, and SHA-256), and rejects before package comparison if that source tooth
differs. It also owns every expected source identity outside the inherited fixture dataset,
resolver/filesystem trace, error descriptor/fallback, hook vector, mutation/control ID, anchor,
replacement, assertion, kill decision, control accounting value, and test registration. No new
package record/digest oracle enters the fixture or harness. The spec passes anchors and replacements
to the harness as opaque data; the harness never names or interprets them.

The source-path pin keys `harness` and any ambiguous equivalent are forbidden. The exact distinct
keys are `mutationHarness` and `provenanceHarness`. The spec asserts the complete §4 path, source,
identity, descriptor, freeze, graph, and forbidden-surface contracts independently.

The existing four-image rule remains exact: snapshot, façade, and resolver are mutable subjects;
fixture is the immutable fourth image; the R7 harness is never an image. Static fixture bindings own
ordinary deterministic fixtures. Each materialized graph uses its own unchanged fixture namespace
only for that graph's actual observations. No error, fixture object, counter, or brand crosses graphs.

For each of the eight R6 discriminator rows, the spec creates a freshly tagged successor graph and a
freshly tagged graph containing the same whole-R5 mutant bytes. Across those 16 graphs it proves 16
distinct tags; 64 globally unique flattened image URLs; per-image URL and module-namespace set sizes
of 16; façade re-export identity with snapshot; and resolver preservation of a snapshot-branded error
through its public failure boundary. It also proves canonical-to-mutation changed-source cardinality
zero for successors and exactly one for mutants, unchanged fixture bytes, and separate linked-byte
identities. Each mutant row retains an independent deterministic module identity.

Before the first experiment, spec-owned inverse rows prove pre-link/import rejection of an unbranded
deep-frozen packet lookalike; outer/nested path maps and mutations with extra, symbol, or accessor
properties (getter count zero); forbidden fixture subject; empty or grammar-invalid tag; and a
coercible non-string tag carrying `Symbol.toPrimitive` and `toString` hooks, both with count zero. A
deterministic syntax-invalid import followed by a same-tag retry proves the original reservation
survives rejection: the retry returns the exact duplicate-tag setup error before link/import and its
spec-owned top-level import sentinel remains zero. Two concurrent calls use one tag and distinct
otherwise-valid snapshot replacements with separate spec-owned top-level sentinels; exactly one
fulfills, the other returns the exact duplicate-tag setup error, and exactly one sentinel increments,
proving synchronous atomic reservation and exactly one importer. Two distinct delimiter-bearing
allowed tags produce disjoint, injective URL sets. These are prerequisites inside the existing two
tests, not new control IDs or mutant kills.

Before a row may add the single R6M-01 ID to its killed set, both graphs must:

1. complete unsupported-entry setup with successor's exact branded six-descriptor ERROR, R5's
   intended ERROR, and no `ReferenceError` or generic setup escape;
2. complete authentic hostile-boundary rewrap with identity preserved and every boundary hook zero;
3. complete the row's exact literal hook/outcome assertions; and
4. rewrap every safe successor reconstruction idempotently.

The authentic check is a positive prerequisite, never a ninth discriminator or control. Setup,
linking, import, harness, fixture, source-pin, or expected-record failure cannot kill a mutant.

The R6 whole-error replacement and source teeth remain spec-owned: one begin/end anchor pair encloses
the entire class/factory/brand/captured-intrinsic/ensure/wrapper/freeze subsystem; private error names
occur only inside it; the successor has one direct `new ParserProvenanceError()`; and unsupported
entry has one fixed-primitive `ensureParserProvenance(false, ...)` outside it. The R5M-04 standalone
callback explicitly names both unreachable second-pass targets.

Exactly two top-level provenance tests remain. R3M-01..03, R5M-01..04, and one R6M-01 ID with eight
independent discriminator graphs remain. Serial totals stay 73 tests and 67 controls.

## 6. Graph, inventories, and frozen surfaces

The exact R7-affected provenance-subgraph test-support edges are:

- façade -> snapshot;
- resolver -> façade;
- provenance spec -> fixture;
- provenance spec -> provenance harness;
- provenance harness -> mutation harness; and
- topology spec -> mutation harness and module-graph helper.

Every inherited test-support edge outside that affected subgraph remains exact under its immutable
prerequisite. This includes protocol spec -> mutation harness and P0a live-topology spec -> P0a
fixture, mutation harness, and worker harness. The R7A-05 whole-graph proof covers both the affected
subgraph and all inherited edges; the list above is not mislabeled as the complete global graph.

Fixture and provenance harness each have exactly one static consumer, the provenance spec. Production
imports no test support. The provenance harness imports no fixture or subject. The mutation harness,
module-graph helper, snapshot, façade, resolver, fixture, all seven production modules, protocol and
hostile specs, Gate D, P0a files, `package.json`, and R6 design remain byte-exact.

The scored source envelope becomes exactly 18 files: seven production modules, four P0b specs, six
scored supports (`module-graph-v0.mjs`, snapshot, façade, resolver, fixture, provenance harness), and
`package.json`. The fixed mutation harness remains an immutable prerequisite outside that historical
envelope. Syntax and ESLint cover exactly 25 JavaScript files. Source images remain exactly four.

## 7. Authorized artifacts and caps

Before design GO, this document is the sole authorized R7 authoring path. After both design GOs it
freezes, and implementation may add or edit exactly four paths: provenance harness, provenance spec,
topology spec, and the current result document. Every other path remains exact.

| Artifact | Maximum physical lines |
| --- | ---: |
| provenance harness | 220 |
| provenance spec | 820 |
| frozen fixture + provenance harness + provenance spec | 1,340 |
| topology spec | 1,680 |
| result document | 850 |
| this R7 preregistration | 320 |

The R6 snapshot 340, façade 210, resolver 110, three-helper aggregate 620, fixture 320, and every
other inherited cap remain binding. Fixture is frozen at 299 lines. Harness and spec individual caps
permit a readable mechanism/adjudication tradeoff; 1,340 is the explicit non-binding combined
reporting ceiling. With fixture frozen at 299, all individual maxima total 1,339, so it adds no hidden
effective cap. Observed R6 geometry projects harness 170-200, spec 800-815, and total about 1,310.

The topology increase is limited to the new scored artifact, imports/exports/arities, two sole-consumer
edges, four-image boundary, 18/25 arithmetic, and combined-envelope reporting. It is not source-behavior room.
Topology may retain at most its 24 inherited readable `prettier-ignore` markers and adds zero; default
Prettier must be stable. No assertion, corpus, graph edge, mutant, anchor, or control may be removed.

## 8. R7 acceptance

1. **R7A-01:** R6/R5 designs, current result, policies, all frozen prerequisites, stable helpers,
   topology candidate, current cap-red spec, and every recoverable §2 tuple rehash exactly before
   implementation. Chronology-only executions are cross-checked without invented byte identities.
2. **R7A-02:** the harness meets §§3-4 exactly: three exports/arities, import allowlist, packet brand,
   key orders, primitive source/identity schema, exact one-subject mutation, four-image linking,
   canonical/mutation/linked identity separation, opaque outcome capture, exact tag grammar, every
   pre-import inverse control, coercion-free non-string rejection, permanent failed-import
   reservation, atomic same-tag concurrency with exactly one importer, injective allowed tags, and
   forbidden surfaces.
3. **R7A-03:** the spec remains the sole adjudicator; the immutable fixture remains only the inherited
   package-oracle data home, guarded by the independent spec-owned literal fixture-source identity
   tooth. No new oracle enters fixture or harness, and IDs/anchors/replacements/hook vectors enter
   neither. All 64 URLs, per-image 16-namespace sets, same-chain re-export/brand behavior,
   changed-source cardinalities, setup prerequisites, authentic positives, and eight independent R6
   rows pass without vacuous kill or cross-graph state.
4. **R7A-04:** exact package records/digests, five-factory/ten-resolution/five-measurement sequence,
   literal immediate-directory and descriptor traces, two fresh passes, drift/symlink/type controls,
   defensive buffers, exact error descriptors/freezes/branding, and all R3/R5/R6 controls pass.
5. **R7A-05:** topology proves the exact graph, one-consumer edges, four images, 18-file envelope,
   25-file syntax/ESLint inventory, caps/aggregates, resolver identity, no root-lock read, no fixture
   expected trace, no new formatter suppression, and all 32 independent mutants without weakening.
6. **R7A-06:** PRE and FORWARD are 151/151; protocol 15/15, hostile 20/20, topology 36/36,
   provenance 2/2, serial P0b 73/73, and controls 67/67 have no skip, todo, cancellation, mixed
   authority, setup kill, or missing expected record. Syntax/ESLint are 25/25 and Prettier is green.
7. **R7A-07:** an independent digest implementation reproduces all five package records without
   importing snapshot, façade, resolver, fixture, provenance harness, or the owning spec.
8. **R7A-08:** a clean landing clone with no root lock reproduces Gate D, 73 tests, 67 controls,
   25 syntax/ESLint checks, exact tuples/caps/graph/traces/packages, 16 paired image identities, all
   eight total-wrap rows, and authentic positives. The dependency junction rehashes before/after.
9. **R7A-09:** two fresh non-author terminal reviewers rehash one stable successor, rerun their
   assigned protocol/regression and hostile/topology/provenance gates, explicitly close P0B-F02
   through P0B-F06, and return unconditional GO with zero finding.

Any FAIL, ERROR, STRUCTURAL, missing evidence, hash drift, conditional approval, or absent reviewer is
NO-GO. No red is de-scored, demoted, quarantined, or replaced by a later green.

## 9. Review boundary and nonclaims

Authors freeze and stop after one complete validation tuple. Reviewers are read-only and may not edit,
run Git writes, build, browse, publish, delete, or change external state. A finding reopens authorship
and requires complete affected validation and a fresh tuple. Only both terminal GOs may permit the
separately authorized orchestrator to create a local checkpoint; workers never run Git writes.

R7 adds no production behavior and proves no socket, HTTP, persistence, durability, deletion, GC,
transport, signature, trusted-time, freshness, revocation, restart, external-closure, renderer,
transaction, mask, cache/retirement, collision, accounting, Cesium, WebGL, WebGPU, pixel, performance,
standards, or production-readiness claim. All R6/R5 nonclaims and all historical reds remain.
