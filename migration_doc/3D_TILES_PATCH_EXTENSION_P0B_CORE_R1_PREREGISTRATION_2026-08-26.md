# 3D Tiles patch extension P0b-core R1 preregistration

**Date:** 2026-08-26  
**Status:** frozen before P0b production implementation  
**Scope:** non-weakening clarification of source-stream accounting and store-owned verification  
**Lane:** local-only, browser-free, GPU-free, network-free, no Git, no file deletion, no external publication

## 1. Why R1 exists

The frozen P0b-core preregistration has SHA-256
`19f2a41c1f6c48e7f21c6d7545c2a454f99265cae419d8733aacf22b888bfb2f`. No P0b production module
exists yet. Read-only implementation planning found two ambiguities that must be resolved before
implementation begins:

1. the original head-last sequence verifies producer-owned bytes before store commit, while its
   adapter boundary also requires descriptor closures to be reconstructed from owned store bytes;
   and
2. the original 64 MiB emitted-scenario limit is not exactly reachable if a scenario emits only 64
   authoring documents capped at 512 KiB each.

R1 resolves both without lowering a safety boundary or promoting a deferred claim. It adds a second
frozen-verifier pass over exact store readbacks and a deterministic, separately bounded synthetic
source-change payload channel. All base-preregistration clauses not expressly replaced below remain
binding.

P0b production implementation remains blocked until:

- Gate D receives its required fresh independent GO;
- this R1 document is formatted, hashed, and frozen; and
- any conflict between this document and the base preregistration is resolved in favor of this R1
  only for the clauses explicitly named below.

Both earlier Gate D D05 HIGH / NO-GO reviews remain immutable chronology. R1 does not alter or erase
them.

## 2. Replacement for §8 publication order

The base preregistration §8 ordered list is replaced by this two-pass sequence.

### 2.1 Pass A — producer-owned canonical snapshots

1. Bound and snapshot configuration, event-authoring, and source-payload byte carriers.
2. Decode strict JSON, validate identities and limits, sort semantic arrays, and construct canonical
   entrypoint, state, head, base-descriptor, and patch-descriptor bytes.
3. Reconstruct and seal fresh P0a base/patch descriptor closures from the producer-owned canonical
   snapshots.
4. Call frozen `verifyCandidate` against the exact captured prior.
5. If the result is `COMMITTABLE`, call frozen `commitCandidate` and retain the returned admitted
   record only as a tentative private Pass-A value.
6. If the result is `NO_CHANGE`, perform the synchronous current-fence confirmation in §2.4; do not
   prepare or mutate the immutable store.
7. Any rejection or verifier exception mutates no store, head, active prior, hint, or counter.

### 2.2 Store commit and exact readback

1. Prepare the complete bounded immutable batch from the same owned canonical snapshots.
2. Atomically commit the batch or expose none of its members.
3. Read every member through the public immutable-store read path.
4. Require exact URI, digest, byte length, role, and byte equality for entrypoint, state, base
   descriptor, and every patch descriptor.
5. A failed readback leaves the head and active prior unchanged. It may leave only the already
   admitted unreachable immutable batch permitted by the base preregistration.

### 2.3 Pass B — store-owned authority

1. Construct entirely new P0a base/patch descriptor builders.
2. Add only fresh byte snapshots returned by the immutable-store read path; no Pass-A closure handle
   or producer-owned descriptor view is reused.
3. Seal both new closures and call frozen `verifyCandidate` against the same captured prior, using
   exact store-read entrypoint/state/descriptor bytes and the producer-owned candidate head bytes.
4. Require `COMMITTABLE` and exact equality between Pass A and Pass B for:
   - result kind;
   - dataset ID;
   - generation;
   - state byte length;
   - state digest; and
   - state revision ID.
5. Call `commitCandidate` on the Pass-B candidate.
6. Require `encodePrior` bytes for the Pass-A tentative record and Pass-B record to be byte-identical.
7. Discard the Pass-A tentative record from the authority path. Only the private Pass-B record can be
   installed after CAS.

Skipping Pass B, using a Pass-A record as authority, reusing Pass-A closure handles, or accepting any
Pass-A/Pass-B mismatch is FAIL.

### 2.4 CAS and exact replay

1. Precompute the frozen success projection and non-authoritative hint bytes.
2. Perform one synchronous exact head CAS using the captured predecessor, strong ETag, immutable
   receipt, closure ID, and sealed publication fence.
3. Only after CAS succeeds install the Pass-B admitted record, expose the hint, and advance the
   success counter.
4. Nothing after the CAS linearization point may predictably fail, allocate, parse, hash, canonicalize,
   or invoke caller code.

For a Pass-A `NO_CHANGE` result, the adapter synchronously rechecks that the captured service mutation,
head bytes, strong ETag, generation, state digest, active prior, and sealed fence are still current.
Only then may it return `NO_CHANGE`. If any value changed after attempt capture, the result is
`CONFLICT`. A stale replay is never reported as `NO_CHANGE`.

A CAS loser discards both tentative admitted records and changes no active prior, hint, or counter.

## 3. Deterministic source-change payload channel

### 3.1 Opaque event API

`seeded-change-stream-v0.mjs` adds:

```text
SCENARIO_SOURCE_ALGORITHM = "sha256-counter-source-bytes-v1"
nextScenarioEvent(streamHandle) -> opaque event handle or undefined
describeScenarioEvent(eventHandle) -> frozen scalar projection
readScenarioEventAuthoringBytes(eventHandle) -> fresh canonical bytes
readScenarioEventSourceBytes(eventHandle) -> fresh deterministic bytes
```

The prior byte getter semantics remain but operate through the opaque event handle. No iterator,
callback, clock, random function, options object, raw graph, or caller collection is introduced.
Repeated getters return fresh copies of the same logical event; repeated copies do not count as new
logical events or additional aggregate source bytes.

### 3.2 Configuration schema

The strict duplicate-aware canonical scenario configuration remains capped at 512 bytes and contains
exactly:

```json
{
  "entrypointUri": "https://example.test/data/root/tileset.json",
  "epochMs": 1700000000000,
  "eventCount": 4,
  "eventsPerLogicalTick": 2,
  "extensionName": "CESIUM_3d_tiles_patch",
  "headUri": "patch/head.json",
  "rebuildEvery": 4,
  "seed": "0000000000000000000000000000000000000000000000000000000000000000",
  "sourcePayloadBytes": 0,
  "version": "0.1"
}
```

Exact rules:

- `epochMs` is a JSON safe integer in the unsigned 48-bit UUIDv7 timestamp domain;
- `eventCount` is an integer from 1 through 64;
- `eventsPerLogicalTick` is an integer from 1 through 16;
- `rebuildEvery` is an integer from 0 through 64, with zero disabling synthetic rebuild decisions;
- `seed` is exactly 64 lowercase hexadecimal characters;
- `sourcePayloadBytes` is an integer from 0 through 1,048,576;
- `epochMs + lastLogicalTick` must remain in the 48-bit domain; and
- logical tick, source revision, generation, and byte lengths emitted in JSON use canonical uint64
  decimal strings.

### 3.3 Source-byte derivation

For logical tick `T`, event ordinal `E`, and zero-based block counter `B`, each 32-byte block is:

```text
SHA-256(
  UTF8("3d-tiles-live-update:p0b:source-bytes:v1") ||
  00 ||
  decodedSeed32 ||
  uint64be(T) ||
  uint32be(E) ||
  uint32be(B)
)
```

Blocks are concatenated and truncated to exactly `sourcePayloadBytes`. The event-authoring document
contains `sourcePayloadByteLength` and `sourcePayloadDigest`; the reference producer checks the
declared length before copying or hashing the source carrier, snapshots the exact view, then verifies
the digest before making a patch-versus-rebuild decision.

Known-answer vector:

```text
seed: 32 zero bytes
logical tick: 7
event ordinal: 3
length: 40 bytes
bytes: 59a68160c8e9b41bf3e6b13ffe2b7ef13f4f739870eb51e5052b85eafa0e9d97700da9e2d8efec4f
digest: sha256:01653282131ca4788b0d9078943a2449aa435bf34be073b1cf00cbe40c839a78
```

This vector and the UUIDv7 vector in §3.4 are pinned acceptance, not illustrative values.

### 3.4 UUIDv7 clarification

The base preregistration UUID derivation remains binding. The exact permitted roles are:

```text
dataset
base-revision
state-revision
state-invalidation
update
target
patch-revision
patch-invalidation
```

Pinned vector:

```text
seed: 32 zero bytes
epochMs: 1700000000000
logical tick: 7
role: update
ordinal: 3
uuid: 018bcfe5-6807-738d-ab4a-77d996b54b62
```

The derivation is reproducible and domain-separated but makes no unpredictability, secrecy, or
authentication claim.

### 3.5 Event-authoring additions

The exact event-authoring object includes:

```text
sourcePayloadByteLength: canonical uint64 decimal string
sourcePayloadDigest: full lowercase sha256 digest
```

The reference producer API is positional:

```text
produceReferenceChange(producerHandle, authoringBytes, sourcePayloadBytes)
```

The source bytes are producer input only. They are not published as a tileset, patch payload,
replacement closure, or external resource. They do not close, partially satisfy, or weaken the
STRUCTURAL P0A-19 external/heavy-resource-closure deferral.

## 4. Replacement limits and reachability

The base §9 row `emitted scenario bytes | 64 MiB` is replaced by:

| Boundary | Default and hard P0b-core maximum |
| --- | ---: |
| source-change payload per logical event | 1 MiB |
| aggregate source-change payload across one scenario | 64 MiB |

Both are exactly reachable: one event can carry 1 MiB, and 64 distinct events can each carry 1 MiB.
A 1 MiB + 1 carrier rejects from declared length before copy/hash/generation. A 65th event rejects
from cardinality before source generation. The aggregate counter is charged once when each distinct
logical event is minted, never on a fresh-copy getter.

The 19 MiB immutable-batch boundary is independently executable through the direct byte-only store
batch API: nineteen separate 1 MiB admitted byte carriers reach exactly 19 MiB. Its adjacent
compositional crossings are a 1 MiB + 1 member or a twentieth one-byte member; the primitive
per-object or cardinality guard must reject before copy, hash, sort, or materialization. There is no
requirement to invent a separately reachable aggregate-only error when the two primitive maxima
already imply the aggregate ceiling.

The 512 KiB authoring limit is orthogonal to direct immutable-store admission. It does not cap bytes
passed separately to the store's byte-only batch API.

## 5. Acceptance replacements

The following rows replace the same IDs in base §11; every other acceptance row remains unchanged.

| ID | Required terminal verdict | Replacement acceptance predicate |
| --- | --- | --- |
| P0B-03 | PASS | Fixed seed/configuration reproduces byte-identical UUIDv7 identities, event authoring, deterministic source bytes/digests, ordering, and terminal summary across fresh modules without ambient state |
| P0B-10 | PASS | Pass A verifies producer-owned canonical snapshots; store commit/readback then Pass B independently rebuilds closures from returned store bytes, re-verifies, and proves exact candidate/prior equality before CAS |
| P0B-13 | PASS | Exact replay returns `NO_CHANGE` only after synchronous current-fence confirmation and advances no generation, revision, bytes, ETag, prior, hint, or counter; stale replay is `CONFLICT` |
| P0B-15 | PASS | Exact per-event 1 MiB and 64-event/64 MiB source-payload maxima plus adjacent rejection are executable; every other frozen primitive/compositional limit has exact or adjacency coverage as specified in §4 |
| P0B-19 | PASS | Node suites, all 27 carried and 31 P0b mutants, ESLint, Prettier, import checks, inventory checks, line caps, exact tuple hashes, known-answer vectors, and two-pass equivalence are green |

## 6. Additional required mutation classes

The base §12 list of 28 P0b mutation classes gains three classes:

29. skip store-owned Pass-B verification;
30. install or authorize the Pass-A tentative record instead of the Pass-B record; and
31. return `NO_CHANGE` without synchronous current-fence confirmation.

All 31 P0b mutation classes and all 27 carried P0a controls are required: 58 total. The source-payload
generator, known-answer vectors, declared-length-before-copy order, digest verification, and aggregate
accounting must be load-bearing within those classes; a missing or surviving anchor is FAIL or
STRUCTURAL under the base vocabulary.

## 7. Unchanged nonclaims

R1 does not authorize or claim:

- a heavy tileset or patch-payload closure;
- persistence, filesystem storage, crash recovery, deletion, garbage collection, or retention;
- HTTP parsing, sockets, SSE, network behavior, proxy/CDN behavior, or TLS;
- signatures, trusted freshness, anti-rollback across restart, or revocation;
- engine, traversal, transaction, mask, cache, retirement, pick/query, WebGL, WebGPU, or rendered
  behavior;
- standards promotion, production readiness, or full design §15.0 P0 completion.

No failed evidence is erased. The terminal result must preserve the two Gate D D05 NO-GO reviews,
every repair attempt, the planning-time ambiguity that caused R1, and every later FAIL, ERROR, or
STRUCTURAL measurement.
