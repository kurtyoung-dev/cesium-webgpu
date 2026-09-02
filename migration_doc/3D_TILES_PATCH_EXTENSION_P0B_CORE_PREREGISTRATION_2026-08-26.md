# 3D Tiles patch extension P0b-core preregistration

**Date:** 2026-08-26  
**Status:** frozen before implementation  
**Scope:** renderer-free, unsigned, process-local prototype only  
**Lane:** local-only, browser-free, GPU-free, network-free, no Git, no deletes, no external publication

## 1. Decision and authority

P0b-core is authorized as the next bounded prototype only after the decomposition gate in this
document passes. It may implement:

1. a deterministic reference producer for the existing unsigned `0.1` control documents;
2. a bounded in-memory content-addressed byte store;
3. a synchronous in-process mutable-head service core with strong-ETag conditional reads and exact
   compare-and-swap semantics; and
4. a deterministic seeded scenario stream that supplies explicit logical time and UUIDv7 identities.

This is not the full P0 described by design §15.0. It closes only the deterministic producer behavior
owned by historical acceptance P0A-23. P0A-19 external/heavy-resource closure remains STRUCTURAL:
base and patch descriptors still name tilesets and payloads that this slice does not traverse.

The current maintainer instruction keeps the campaign active but all work local during quiet hours.
This preregistration grants no authority to commit, switch branches, write Git state, delete anything,
open a browser, run a GPU probe, bind a port, use a network, publish evidence, or change external state.

## 2. Frozen prerequisite

The following six-file P0a-R2 tuple is immutable input to P0b-core. Every P0b gate rehashes it before
running. Any drift is STRUCTURAL and stops the lane.

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0A_R2_BOUNDED_CARRIER_PREREGISTRATION_2026-08-26.md` | 16,190 | 270 | `b10194395a7bd17aac5b441e08352bce95f0295fb4d82db7d036e93494850a3a` |
| `Tools/patch-prototype/README.md` | 13,290 | 300 | `8d9139c7b8290eb03db924fede3cfd328391ae643bb4c78b047528701d4e413c` |
| `Tools/patch-prototype/strict-json.mjs` | 24,831 | 955 | `58a134f7dbf673f3e8c1473bbacdc41dac68e7f7d26d56a634b3d52bb3ccd887` |
| `Tools/patch-prototype/strict-json.spec.mjs` | 32,275 | 981 | `5e78b18ade89f69fc6ec3f609bfda9f4cedf9224f3d9c47c2bd3b20619da7237` |
| `Tools/patch-prototype/live-update-v0.mjs` | 59,541 | 2,216 | `36c8b66a31a6877d22a583ea87c08048db2911b0bcc3e0296ced94783a069d1f` |
| `Tools/patch-prototype/live-update-v0.spec.mjs` | 129,570 | 3,850 | `1ac810a3e72010701dd0ddcc3499a0d652f9d74c703dc8f5ab2a34b7d4fb8196` |

The recorded P0a result is also an immutable cited prerequisite:

- `migration_doc/3D_TILES_PATCH_EXTENSION_P0A_RESULT_2026-08-26.md`
- SHA-256 `d336b945b9a04c58df951c4cb534758497d2ee6c8d1a893d65add9facf37eb92`

P0b production may import only frozen public APIs. It must not import frozen test code or depend on a
test fixture as a validator.

## 3. Gate D — behavior-preserving P0a test decomposition

P0a result §8.3 requires an executable decomposition before any P0b implementation surface is added.
The frozen 3,850-line live spec remains byte-identical and continues to run as the historical oracle.
The forward suite mirrors its 131 test results in split files and continues to run the frozen strict
suite's 20 results, for 151 total.

### 3.1 Frozen PRE inventory

Run:

```text
node --test --test-reporter=tap Tools/patch-prototype/strict-json.spec.mjs Tools/patch-prototype/live-update-v0.spec.mjs
```

The process must exit `0` and report exactly:

- tests: 151;
- pass: 151;
- fail: 0;
- cancelled: 0;
- skipped: 0; and
- todo: 0.

The ordered-name normalizer is fixed:

1. read merged TAP text lines in emitted order;
2. match `^\s*ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$`;
3. append capture group 1 only;
4. join exactly 151 captures using one U+000A between entries and no trailing newline;
5. encode as UTF-8 without a BOM; and
6. SHA-256 the resulting 7,298 bytes.

The required digest is
`1b6ac268749b579056e495412c9ce1da2b566847e8475b51e2319dbaeb9ad810`.
The first capture is `two-second operation deadline is FAIL`; the last is
`strict in-memory mutants bite snapshot, limit-order, depth, and freeze controls`.

The digest is never evaluated unless the test process and all summary counts are green. A partial
`ok` stream cannot masquerade as an inventory match.

### 3.2 Frozen FORWARD inventory

The forward command runs:

1. the unchanged `strict-json.spec.mjs`; and
2. the three new split P0a live-suite mirrors in the artifact table below.

It excludes the frozen monolithic live spec so duplicate execution cannot masquerade as coverage. It
must reproduce the exact PRE process verdict, all seven summary counts, the same 151 normalized names
in the same order, the same 7,298 normalized bytes, and the same SHA-256.

The forward suite preserves all 23 live mutants and the frozen strict suite preserves all four strict
mutants. Every mutant must remain uniquely anchored, importable where applicable, executed exactly
once, and red for its intended reason. A missing, ambiguous, unevaluable, or surviving mutant is not
a pass.

Gate D must receive a fresh independent read-only GO before producer implementation starts. The
reviewer rehashes the frozen tuple, runs PRE and FORWARD, compares the inventories, executes all 27
mutants, checks import topology and line caps, and reports no unresolved CRITICAL, MAJOR, HIGH, FAIL,
ERROR, or STRUCTURAL finding.

## 4. P0b-core trust boundary

### 4.1 Byte-only authoring

Public authoring and configuration values are admitted byte carriers only: `ArrayBuffer`,
`SharedArrayBuffer`, or an `ArrayBufferView`. They are snapshotted through captured intrinsics before
parsing, hashing, sorting, retaining, or returning. General producer entry points do not accept raw
object graphs, Maps, Sets, caller iterables, property bags, callbacks, clocks, random functions, or
filesystem paths.

Authoring bytes are bounded, strict duplicate-aware JSON. The producer decodes them, constructs a
private normalized graph, validates semantic uniqueness, sorts semantically unordered arrays, emits
private serialization bytes, and passes those bytes through the frozen
`canonicalizeJsonBytes`. There is no public graph canonicalizer and no client-side repair claim.

General publication authoring supplies every UUIDv7 and logical timestamp explicitly. Only the
scenario generator may derive them from its admitted seed/configuration bytes.

### 4.2 Opaque module identities

Stores, batches, head services, publishers, publication fences, scenario streams, and admitted priors
are module-minted opaque identities backed by captured WeakMap intrinsics. Forged, proxied,
cross-instance, wrong-kind, and revoked values reject before property inspection. Public observation
is through frozen scalar projections and fresh byte snapshots only.

### 4.3 Unsigned profile

P0b-core emits and verifies only `version: "0.1"` with `freshnessProfile: "unsigned"`. It proves byte
integrity, internal cross-link consistency, determinism, and process-local publication ordering. It
does not prove source authenticity, freshness, rollback resistance across process restart, or that a
head is globally current.

## 5. Deterministic producer contract

### 5.1 Canonical semantic order

Before serialization the producer rejects duplicate identities and sorts:

| Array | Ascending comparator |
| --- | --- |
| `components` | UTF-8 bytes of unique `componentId` |
| `patches` | decoded 16-byte RFC 9562 network order of unique `patchRevisionId` |
| `requiredCapabilities` | UTF-8 bytes of the unique complete capability string |
| `updateLineage` | decoded 16-byte RFC 9562 network order of unique `updateId` |
| immutable publication batch | full lowercase `sha256` digest, then canonical URI |

The current verifier admits one `3d-tiles` component and at most sixteen active patches. The general
ordering law is still executable with reversed authoring input for capabilities, patches, lineage,
and batch entries. Reordered semantically equivalent inputs must produce byte-identical entrypoint,
state, head, base descriptor, patch descriptors, digests, URIs, and publication record.

Canonical form is exactly what the in-memory services return; bytes are never canonicalized only for
hashing and then served in another spelling.

### 5.2 UUIDv7 scenario algorithm

The scenario configuration contains a lowercase 64-hex-character seed and an explicit integer
`epochMs` in the UUIDv7 48-bit timestamp domain. `sha256-counter-uuidv7-v1` derives an identity for
`(logicalTick, role, ordinal)` as follows:

1. reject an out-of-range or duplicate tuple before hashing;
2. set UUID bytes 0 through 5 to unsigned big-endian `epochMs + logicalTick`;
3. hash the UTF-8 domain `3d-tiles-live-update:p0b:uuidv7:v1`, one zero byte, the decoded 32-byte seed,
   unsigned big-endian 64-bit logical tick, the UTF-8 role, one zero byte, and unsigned big-endian
   32-bit ordinal;
4. fill the remaining UUID random fields from the leading digest bits;
5. force RFC 9562 version `7` and variant `10`; and
6. emit lowercase canonical UUID text.

The algorithm is deterministic and domain-separated. It makes no unpredictability, secrecy, or
cryptographic-authentication claim. Ambient `Date.now`, `performance.now`, `Math.random`, locale,
timezone, process identity, directory order, and host enumeration order are forbidden inputs.

### 5.3 Scenario stream

A scenario handle yields fresh canonical event-authoring bytes in monotonically increasing logical
tick order. Equal configuration bytes produce byte-identical event bytes and terminal publication
summaries across fresh module instances. Each event carries explicit source revision, update UUID,
bounded affected-target summary, logical tick, and deterministic patch-versus-rebuild decision.

P0b-core tests the patch-publication path and a deterministic rebuild-decision record. It does not
write a dataset directory, materialize heavy tilesets, claim estimator realism, or claim overload
capacity behavior beyond the fixed bounded stream.

## 6. In-memory content-addressed store

The mutable head is not an immutable-store object. One publication batch contains at most the
entrypoint, canonical state, one base descriptor, and sixteen patch descriptors: 19 immutable
objects.

The store:

- computes `sha256` over an owned byte snapshot internally;
- derives canonical object identity and a quoted strong ETag from those exact bytes;
- never trusts a caller-supplied digest as identity;
- prepares a complete batch without mutating visible state;
- atomically commits either every batch member or none;
- treats same digest plus same bytes as idempotent;
- returns `DIGEST_COLLISION` for same digest plus different bytes and never overwrites existing bytes;
- returns fresh snapshots and never aliases caller or internal storage;
- gives immutable reads `200` with a body, exact-ETag reads `304` with no body, and missing reads `404`;
  and
- never deletes, overwrites, compacts, persists, or garbage-collects an admitted immutable object.

An unreachable immutable batch left by a lost head CAS is allowed and remains bounded by store caps.
This is not a retention, reclamation, or durability claim.

## 7. In-process mutable-head service core

The head service models protocol status and headers but does not parse HTTP, open a socket, or call a
network API.

- Before initialization, read returns `404` with no body.
- Initial creation requires exact absent-head precondition `If-None-Match: *`.
- Replacement requires exactly one matching current quoted strong ETag.
- Missing or malformed precondition returns `428`.
- A nonmatching precondition returns `412`.
- Oversized admitted bytes return `413`.
- A normal read returns `200`, fresh canonical head bytes, the byte-derived strong ETag, and
  `Cache-Control: no-cache, must-revalidate`.
- An exact conditional read returns `304` with no body.
- Immutable reads model `Cache-Control: public, max-age=31536000, immutable`.
- ETag equality holds if and only if head bytes are equal.

One compare-and-swap call performs one synchronous attempt. No hidden retry loop or asynchronous gap
exists between checking and assignment. A higher-level caller may explicitly reconcile and retry at
most three times; P0b-core does not automatically do so.

The successor precondition is the exact current strong ETag plus predecessor generation,
predecessor state digest, and a sealed module-local publication fence. Initial publication instead
uses the absent-head marker plus an initial fence. CAS rechecks the fence, immutable closure, and
predecessor tuple inside the atomic operation.

Stale, ABA, rollback, generation-only, digest-only, same-generation-divergent, wrong-fence, or
cross-service attempts reject without changing head bytes, ETag, active prior, or mutation counters.
Two publishers targeting one predecessor yield exactly one winner. Exact replay returns `NO_CHANGE`
and changes no generation, state revision, head bytes, ETag, prior, or counter.

## 8. P0a adapter and head-last publication

`p0a-publication-adapter-v0.mjs` is the sole P0b production module that imports
`live-update-v0.mjs`. It reconstructs fresh base/patch descriptor closures from owned store bytes;
opaque P0a handles never cross persistence, scenario, or service boundaries.

The load-bearing order is:

1. bound and snapshot authoring/configuration bytes;
2. decode strict JSON, validate identities and limits, sort semantic arrays, and create canonical
   control bytes;
3. reconstruct and seal descriptor closures;
4. call frozen `verifyCandidate` against the exact prior;
5. reject immediately unless the result is `COMMITTABLE` or exact `NO_CHANGE`;
6. for a successor, mint the admitted record with frozen `commitCandidate`, but keep it private;
7. prepare the entire immutable batch;
8. atomically commit the batch and read every member back, verifying URI, digest, byte length, and
   exact bytes;
9. CAS exact head bytes against the exact predecessor and sealed publication fence; and
10. only after CAS succeeds install and expose the admitted prior and emit any non-authoritative
    local hint record.

A failed verification performs no store or head mutation. A failed batch performs no partial store
mutation. A failed CAS may leave only unreachable immutable objects; it cannot install the admitted
prior, advance a counter, or emit an authoritative hint. Hints never mutate or authorize the head.

## 9. Frozen default limits

| Boundary | Default and hard P0b-core maximum |
| --- | ---: |
| authoring/config JSON | 512 KiB per request; strict parser hard limits still govern |
| mutable head bytes | 1,024 bytes |
| immutable object bytes | 1 MiB |
| active patches | 16 |
| objects per publication batch | 19 |
| aggregate publication batch | 19 MiB |
| store object count | 64 |
| store aggregate owned bytes | 32 MiB |
| scenario configuration | 512 bytes |
| scenario generations | 64 |
| scenario events | 64 |
| events per logical tick | 16 |
| emitted scenario bytes | 64 MiB |
| explicit caller CAS retries | 3 |
| hostile-operation test deadline | 2 seconds after worker readiness |

Every minimum, exact maximum, and adjacent rejection is executable. Cardinality and declared-length
limits fire before caller-byte copy; owned aggregate limits fire before hash, sort, or materialization
that would cross the cap. Construction time is excluded from hostile-operation deadlines. Timeout is
FAIL; worker setup/import/protocol failure is ERROR.

## 10. Required artifacts and shrink-only line ratchets

All P0b artifacts are new. The frozen six-file tuple is never edited.

| Artifact | Role | Pre-implementation maximum lines |
| --- | --- | ---: |
| `Tools/patch-prototype/p0b/test-support/p0a-fixtures-v0.mjs` | shared fixture construction only | 1,400 |
| `Tools/patch-prototype/p0b/test-support/worker-harness-v0.mjs` | construction-excluded deadline harness | 650 |
| `Tools/patch-prototype/p0b/test-support/mutation-harness-v0.mjs` | exact-once transform/import harness | 550 |
| `Tools/patch-prototype/p0b/test-support/p0a-r2-inventory-v0.mjs` | frozen PRE inventory and normalizer | 550 |
| `Tools/patch-prototype/p0b/p0a-live-protocol-persistence.spec.mjs` | forward protocol/persistence mirror | 2,400 |
| `Tools/patch-prototype/p0b/p0a-live-hostile-boundary.spec.mjs` | forward hostile/deadline mirror | 1,300 |
| `Tools/patch-prototype/p0b/p0a-live-topology-mutants.spec.mjs` | forward topology and 23 live mutants | 1,500 |
| `Tools/patch-prototype/p0b/p0a-r2-decomposition-inventory.spec.mjs` | PRE/FORWARD parity gate | 600 |
| `Tools/patch-prototype/p0b/protocol-v0.mjs` | constants, stable projections, opaque tokens | 300 |
| `Tools/patch-prototype/p0b/seeded-change-stream-v0.mjs` | deterministic logical stream and UUIDv7 derivation | 700 |
| `Tools/patch-prototype/p0b/reference-producer-v0.mjs` | byte-only canonical producer | 1,200 |
| `Tools/patch-prototype/p0b/p0a-publication-adapter-v0.mjs` | sole frozen-verifier bridge | 700 |
| `Tools/patch-prototype/p0b/content-addressed-store-v0.mjs` | immutable batch/store | 850 |
| `Tools/patch-prototype/p0b/head-service-v0.mjs` | pure conditional-read and synchronous CAS core | 1,200 |
| `Tools/patch-prototype/p0b/p0b-protocol-persistence.spec.mjs` | producer/store/head acceptance | 2,200 |
| `Tools/patch-prototype/p0b/p0b-hostile-boundary.spec.mjs` | bounds, identities, deadline acceptance | 1,500 |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | topology and new mutants | 1,600 |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | terminal result and immutable chronology | 700 |

After the first green decomposition freeze and first green P0b terminal freeze, actual physical line
counts become shrink-only caps for their respective tuples. Raising a cap requires a fresh
architecture review. Line count alone never changes PASS into FAIL, but an unexplained cap breach is
STRUCTURAL.

Production import topology must be acyclic and must not import `.spec`, `test-support`, fixture,
inventory, mutation, worker, filesystem, HTTP, socket, child-process, browser, renderer, WebGL, or
WebGPU modules. Test support may construct bytes and orchestrate workers/mutants; it may not become a
trusted production validator.

## 11. Preregistered acceptance

A valid expectation miss is FAIL. A harness/runtime failure is ERROR. Tuple drift, unavailable
prerequisite, incomplete artifact, missing/nonunique mutant anchor, or unevaluable required claim is
STRUCTURAL. Any one red governs the lane.

| ID | Required terminal verdict | Acceptance predicate |
| --- | --- | --- |
| P0B-D01 | PASS | Frozen six-file P0a tuple and P0a result rehash exactly before and after every decomposition review |
| P0B-D02 | PASS | PRE exits 0 with 151/151 and no cancelled, skipped, or todo result; normalized inventory is exactly 7,298 bytes and the frozen SHA-256 |
| P0B-D03 | PASS | FORWARD exits 0 with the identical 151 hierarchical names, order, outcomes, summary counts, normalized bytes, and SHA-256 |
| P0B-D04 | PASS | All 23 live and four strict carry-forward mutants are unique, executable exactly once, and bite for the same intended reasons |
| P0B-D05 | PASS | Shared support contains construction only; no production validation is moved into fixtures; split specs and import topology meet the frozen architecture |
| P0B-D06 | PASS | A fresh independent reviewer rehashes and reruns Gate D and returns GO with no unresolved high-severity or non-PASS finding |
| P0B-01 | PASS | Every public untrusted data/configuration boundary is bounded bytes or a module-minted handle; forged/proxied/property-bag inputs invoke zero caller hooks |
| P0B-02 | PASS | Semantic permutations and fresh module instances produce byte-identical canonical objects, digests, URIs, head, and publication result |
| P0B-03 | PASS | Fixed seed/configuration reproduces byte-identical UUIDv7 values, event bytes, ordering, and terminal summary without ambient time/random/locale state |
| P0B-04 | PASS | Store identity hashes owned snapshots internally; caller mutation cannot change identity, stored bytes, ETag, or reads |
| P0B-05 | PASS | Batch prepare/commit is all-or-none and bounded; no partial object becomes visible on any failed member |
| P0B-06 | PASS | Same digest/same bytes is idempotent; simulated same digest/different bytes is `DIGEST_COLLISION` and never overwrites |
| P0B-07 | PASS | Immutable conditional reads return exact 200/304/404 behavior, canonical bytes, strong digest-bound ETag, immutable policy, and no aliases |
| P0B-08 | PASS | Head creation/update/read enforce exact 404/200/304/412/413/428 semantics and 304 never carries a body |
| P0B-09 | PASS | Head ETag is strong and derived from exact served head bytes; it changes iff those bytes change and the cache policy requires revalidation |
| P0B-10 | PASS | P0a verification and descriptor-closure readback complete before any head CAS; a rejected candidate mutates nothing |
| P0B-11 | PASS | CAS rechecks exact ETag, predecessor generation, predecessor state digest, immutable closure, and sealed fence in one synchronous operation |
| P0B-12 | PASS | Two writers against one predecessor yield exactly one winner; every loser leaves head, active prior, counters, and hint authority unchanged |
| P0B-13 | PASS | Exact replay returns `NO_CHANGE` and advances no generation, revision, bytes, ETag, prior, or operation counter |
| P0B-14 | PASS | Stale, ABA, rollback, split-brain, partial-tuple, wrong-fence, cross-instance, and forged attempts reject without authority change |
| P0B-15 | PASS | Every frozen exact limit and adjacent value is executable; hostile over-cap operations terminate after worker readiness without excess work |
| P0B-16 | PASS | Error/status projections are deeply immutable, bounded, byte-stable across repeats/permutations, and never echo attacker-controlled markers |
| P0B-17 | PASS | Source topology uniquely enforces byte snapshots, internal digesting, head-last order, module-local identity, and all forbidden-import bans |
| P0B-18 | PASS | Hostile synchronous operations use construction-excluded workers and two-second parent deadlines with FAIL-versus-ERROR classification |
| P0B-19 | PASS | Node suites, every registered mutant, ESLint, Prettier, import checks, inventory checks, line caps, and exact tuple hashes are green |
| P0B-20 | PASS | Two fresh independent non-author reviewers rehash the same terminal P0b tuple, execute all old/new mutants, and return clean GO verdicts |

## 12. Required P0b mutation classes

Each class requires one unique source anchor, an exact-once transform, an importable changed module
where applicable, and an executable expectation that turns red. A surviving or ambiguous mutant is
FAIL or STRUCTURAL according to §11.

1. hash caller bytes before snapshotting;
2. trust caller digest rather than computing byte identity;
3. overwrite an existing object on simulated digest collision;
4. expose a partial immutable batch;
5. mutate a stored snapshot through a caller view;
6. derive an ETag from decoded JSON or different bytes;
7. return a body with `304`;
8. return stale `304` after head bytes change;
9. admit missing preconditions or last-write-wins head mutation;
10. compare CAS by generation only;
11. compare CAS by state digest only;
12. split CAS check and assignment across an asynchronous boundary;
13. skip immutable-closure readback;
14. skip the sealed publication-fence recheck;
15. CAS the head before store commit/readback;
16. install active prior before CAS success;
17. bypass frozen P0a verification;
18. advance a counter or identity on exact replay;
19. allow rollback, ABA, or same-generation divergence;
20. preserve caller insertion order for a semantic array or batch;
21. serialize producer output without frozen canonicalization;
22. use ambient time, randomness, locale, or enumeration order in scenario output;
23. apply a cardinality/byte limit only after copy, hash, sort, or materialization;
24. let a local hint mutate or authorize the head;
25. accept a forged/cross-instance store, service, publisher, fence, or scenario handle;
26. import test support from production;
27. import filesystem, HTTP, socket, child-process, browser, renderer, WebGL, or WebGPU machinery;
28. promote external/heavy-resource closure, signed freshness, durability, or physical GC from a
    STRUCTURAL nonclaim to PASS.

The 27 P0a mutation controls remain mandatory and unchanged in addition to these 28 P0b classes.

## 13. Terminal commands and evidence

The result records exact commands, exit codes, test counts, durations, byte/line counts, hashes,
mutation counts, every stable red chronology, and both independent reviews. Commands must cover:

1. frozen tuple rehash;
2. PRE historical suite and inventory normalization;
3. FORWARD decomposition suite and inventory normalization;
4. all P0b specs;
5. all 27 carried and 28 new mutants;
6. ESLint over every new `.mjs` artifact;
7. Prettier over every new source/spec/document plus the frozen prerequisite documents named by the
   result;
8. forbidden-import and unique-anchor topology scans; and
9. exact terminal tuple hashing.

The first independent review after Gate D is a decomposition-only review and may occur before P0b
production exists. After implementation, two different fresh reviewers are required:

- one reviews protocol semantics, determinism, P0a composition, persistence equivalence, and CAS
  linearization; and
- one reviews hostile bounds, opaque identities, import topology, races, mutants, and nonclaims.

The repair author cannot serve as either terminal reviewer. Reviewers are read-only and do not repair
the tuple they judge.

## 14. Explicit nonclaims and next gate

P0b-core does not implement or prove:

- a socket listener, HTTP parser, proxy/CDN behavior, SSE, TLS, or network disconnect behavior;
- filesystem storage, paths, traversal, symlinks/junctions/reparse points, temp files, atomic rename,
  `fsync`, directory durability, crash recovery, or cross-process locking/fencing;
- deletion, garbage collection, compaction, retention enforcement, publication pins, leases, durable
  outbox behavior, or storage reclamation;
- signatures, trusted time, freshness, anti-rollback across restart, revocation, deployment constants,
  or authoritative currentness;
- complete external base/patch/heavy-resource closure;
- engine integration, traversal, transactions, masks, cache ownership, retirement, query/pick behavior,
  WebGL, WebGPU, pixel parity, standards promotion, or production readiness; or
- full design §15.0 P0 completion.

If P0B-D01 through P0B-D06 pass, producer implementation may begin. If P0B-01 through P0B-20 then
pass on one exact frozen tuple, P0b-core is GO only for its process-local unsigned scope. Renderer,
WebGL, and WebGPU work remains NO-GO until a later preregistration resolves external closure,
freshness/revocation, runtime transaction ownership, mask semantics, cache/retirement ownership,
collision, and accounting blockers.

No failed measurement is replaced or de-scored. Every observed FAIL, ERROR, or STRUCTURAL result is
preserved in the terminal result chronology even if a later tuple turns green.
