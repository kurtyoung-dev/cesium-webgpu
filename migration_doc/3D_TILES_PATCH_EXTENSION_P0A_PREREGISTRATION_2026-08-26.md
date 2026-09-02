# 3D Tiles patch extension — P0a preregistration

**Date:** 2026-08-26  
**Status:** PREREGISTERED / NOT YET EXECUTED  
**Lane:** local-only, browser-free, no Git, no deletes  
**Path lease:** this document and new files under `Tools/patch-prototype/**` only

## 1. Decision

The full extension is **not ready for engine integration, renderer work, registration in
`Cesium3DTileset.supportedExtensions`, or a standards/certification claim**. A bounded P0a wire
prototype is authorized because it can resolve protocol questions without touching current campaign
integration points.

P0a is a strict, pure verifier for an experimental 3D Tiles vendor-extension publication. It proves
only byte integrity, cross-object identity, bounded selector closure, and monotonic state admission.
It does **not** prove freshness, publisher authenticity, revocation, rendering correctness, or
performance.

The prototype extension label used by fixtures is `CESIUM_3d_tiles_patch`. The verifier receives the
label as an input rather than hard-coding it. The label is experimental, is not registered or added
to any supported-extension table, and carries no compatibility commitment.

## 2. Audit basis and disposition

The implementation is based on these frozen byte snapshots:

| Document | Bytes | SHA-256 |
| --- | ---: | --- |
| `3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md` | 339,912 | `1618d77c13de7c003efd9bc6e5621b5f90104876ff883ff70235801cb061fdc3` |
| `3D_TILES_PATCH_EXTENSION_AUDIT_2026-08-16.md` | 53,560 | `d17a162bb5754b2c29990e5275652f248b64c5c37f6ce373940525fada34c085` |
| `3D_TILES_PATCH_EXTENSION_REAUDIT_2026-08-16.md` | 88,884 | `418276ee68e48a7de3b2a593b9d9fe3ccb801c5783e479b9cf7f96768a181da7` |

An independent reread classified the six CRITICAL re-audit findings as follows:

| Finding | Disposition | P0a consequence |
| --- | --- | --- |
| Freshness selector is unauthenticated and entrypoint binding is circular | CONFIRMED | `signed` and `revocation` reject as unsupported; no anti-downgrade claim |
| Revocation has no bounded absence under head withholding/replay | CONFIRMED, scoped to clients that have not already applied the revocation | No revocation records or absence claim |
| `D_max` request derivation contradicts complete state-control closure | CONFIRMED | P0a fetches the complete descriptor control closure before admission and makes no `D_max` request claim |
| Signed-head expiry conflicts with mostly-304 economics | CONFIRMED | No signed-head implementation |
| Per-bin depth does not bound global manifest size | CONFIRMED | Explicit global active-patch cap; no per-bin-to-global inference |
| Worked examples use undeclared per-target exposure priors | PARTLY CONFIRMED | No optimizer or winner; exposure-prior schema remains open |

No CRITICAL finding was refuted. The other 51 re-audit findings remain open/not retested unless a
later independent review closes them.

The existing `Cesium3DTilesInvalidationFeed` family is prior art only. It marks currently loaded,
single-content tiles `EXPIRED`; it has no authoritative head/state, canonical digest closure,
future-load selector index, atomic generation commit, rollback, multi-content coverage, or retention
law. Its producer adapter's fallback ID is also not FNV-1a-64 as documented: the implementation
multiplies by `2^40 + 257`, not the FNV-1a prime `2^40 + 435`. P0a does not reuse that identity or
canonicalization code.

## 3. Standards boundary

The wire candidate and the Cesium runtime are separate products.

The backend-neutral extension surface owns:

- top-level bootstrap placement and optional/required behavior;
- raw-byte parsing, canonical protocol objects, digest and integer grammars;
- head, state, base, descriptor, selector, and closure identities;
- monotonic admission, idempotence, and same-generation split-brain rejection; and
- conformance vectors independent of Cesium, WebGL, and WebGPU.

The later Cesium runtime surface owns:

- resource transport and reconciliation;
- the generation transaction and one frame-boundary commit;
- traversal and future-loaded selector coverage;
- complementary base/replacement masks and the compositor subtree;
- cache pinning, bounded double residency, retirement, statistics, and context/device loss; and
- color, depth, pick, shadow, classification, query, WebGL, and WebGPU parity.

P0a implements only the first list's smallest coherent subset.

## 4. Frozen P0a contract

### 4.1 Inputs and pure API

```js
verifyCandidate({
  extensionName,
  entrypointUri,
  entrypointBytes,
  headBytes,
  stateBytes,
  baseDescriptorBytesByDigest,
  patchDescriptorBytesByDigest,
  prior,
  limits,
})
```

The result is one of:

- `NOT_APPLICABLE`: the top-level bootstrap is absent. No head or closure input is inspected.
- `NO_CHANGE`: the verified state is byte-identical to the admitted prior state.
- `COMMITTABLE`: verification succeeded and an opaque candidate is returned.
- `REJECTED`: no state mutation occurred and stable error codes describe every safely collectable
  defect.

`commitCandidate(prior, candidate)` is a separate pure operation. It accepts only an opaque candidate
minted by this verifier instance and returns a new immutable admitted-state record. Verification never
mutates `prior`; rejection must leave a byte-for-byte serialized prior unchanged.

### 4.2 3D Tiles placement

- The bootstrap appears once at `entrypoint.extensions[extensionName]`.
- `extensionName` appears exactly once in entrypoint `extensionsUsed`.
- P0a is unsigned and optional, so `extensionsRequired` must not contain it.
- Nested occurrences reject. This prevents silently accepting an ignored control plane in an external
  or child tileset.
- Removing the bootstrap produces `NOT_APPLICABLE` and leaves ordinary 3D Tiles behavior untouched.
- The entry tileset remains ordinary 3D Tiles JSON. It is parsed with duplicate-key rejection but is
  not required to be RFC 8785 canonical. Every separately served protocol object is canonical.

The bootstrap fields are exactly:

```json
{
  "datasetId": "<lowercase UUIDv7>",
  "fallback": "staleBase",
  "freshnessProfile": "unsigned",
  "headUri": "patch/head.json",
  "version": "0.1"
}
```

`signed` and `revocation` are recognized tokens but reject with `UNSUPPORTED_FRESHNESS_PROFILE`.

### 4.3 P0a object model

P0a admits:

- one `3d-tiles@0.1` component;
- one immutable base descriptor bound by `sha256:` digest;
- zero through 16 active `replaceRegion@0.1` patch descriptors;
- disjoint closed region-prism write sets; and
- a complete state-control closure supplied as exact raw bytes before candidate admission.

P0a does not admit tombstones, revocations, fallbacks, dependency graphs, multi-component states,
typed sparse codecs, transport deltas, compaction, optimizer decisions, or executable payload data.
Heavy replacement tileset resources are named by digest but remain outside the P0a fetch/renderer
scope.

The global cap of 16 is a prototype resource bound, not `D_max` and not a claim that per-bin depth
bounds global state size.

### 4.4 Byte, identity, and URI rules

- Protocol bytes are UTF-8 without BOM and parse under a duplicate-aware, bounded JSON parser.
- Protocol objects must already be RFC 8785 canonical. The verifier rejects; it never repairs.
- The only digest grammar is `sha256:` followed by exactly 64 lowercase hexadecimal digits.
- Digests cover the exact received bytes.
- `generation` and `sequence`, where present, are canonical decimal strings in uint64 range. JSON
  numbers, signs, whitespace, and leading zeros other than the single string `"0"` reject.
- Dataset, state, patch, base-revision, update, and invalidation IDs are canonical lowercase UUIDv7.
- Semantically unordered arrays have explicit ascending identity comparators and reject duplicates or
  noncanonical order.
- P0a restricts every protocol URI to a same-origin relative reference. Absolute, protocol-relative,
  cross-origin, fragment-bearing, credential-bearing, or root-escaping references reject. This is a
  prototype restriction, not a final standard decision.
- A URI resolves against the protocol document that contains it. Resolution and origin confinement
  are checked before any lookup.

### 4.5 Replace-region mask rules

The only selector/write set is a closed non-wrapping region prism:

```json
{
  "region": ["west", "south", "east", "north", "minimumHeight", "maximumHeight"]
}
```

Wire values are finite JSON numbers. Longitudes are in `[-pi, pi]`, latitudes in `[-pi/2, pi/2]`,
`west < east`, `south < north`, and `minimumHeight <= maximumHeight`. Antimeridian wrapping is not in
P0a. Two active prisms conflict when their closed intervals overlap or merely touch on all three
axes. Array order never establishes precedence.

`transition.reason` uses a prototype publication-event enumeration rather than the superseded
`3DTILES_temporal` feature-change vocabulary. A separate optional, non-authoritative
`semanticChange` field may carry one of `creation`, `demolition`, `modification`, `union`, or
`division` when that statement is true. Neither field authorizes content.

## 5. Preregistered acceptance matrix

Every test is browser-free and runs directly with Node's test runner. A valid expectation miss is
`FAIL`; invalid or unevaluable test structure is `STRUCTURAL`. P0a does not publish campaign evidence
or certification artifacts.

| ID | Expected result | Case |
| --- | --- | --- |
| P0A-01 | `NOT_APPLICABLE` | Bootstrap absent; poison closure inputs prove they were not read |
| P0A-02 | `COMMITTABLE` | Canonical zero-patch publication verifies and commits once |
| P0A-03 | `COMMITTABLE` | Canonical one-patch publication verifies full base/descriptor cross-links |
| P0A-04 | `NO_CHANGE` | Exact replay advances no generation and returns no new candidate |
| P0A-05 | `COMMITTABLE` | Higher generation with correct parent state admits |
| P0A-06 | `REJECTED` | Duplicate JSON key at each protocol-object class |
| P0A-07 | `REJECTED` | Noncanonical object keys, numeric spelling, whitespace, or unordered semantic array |
| P0A-08 | `REJECTED` | Duplicate identity in components, patches, capabilities, or lineage |
| P0A-09 | `REJECTED` | Numeric, signed, leading-zero, negative, or overflowing uint64 |
| P0A-10 | `REJECTED` | Uppercase, wrong-version, or malformed UUID |
| P0A-11 | `REJECTED` | Unknown, uppercase, truncated, unprefixed, or mixed digest suite |
| P0A-12 | `REJECTED` | State/base/descriptor bytes do not match advertised digest or byte length |
| P0A-13 | `REJECTED` | Dataset, state, generation, base, patch, or transition cross-link mismatch |
| P0A-14 | `REJECTED` | Lower generation rollback or same-generation/different-digest split-brain |
| P0A-15 | `REJECTED` | Missing base or patch descriptor from the complete control closure |
| P0A-16 | `REJECTED` | Closed masks overlap or touch, including boundary-only contact |
| P0A-17 | `REJECTED` | Mask nonfinite/range/order defect or unsupported antimeridian wrap |
| P0A-18 | `REJECTED` | Absolute, cross-origin, fragment, credentials, or escaping URI |
| P0A-19 | `REJECTED` | Nested bootstrap or missing/duplicate `extensionsUsed` declaration |
| P0A-20 | `REJECTED` | Extension appears in `extensionsRequired` under unsigned P0a |
| P0A-21 | `REJECTED` | Signed or revocation profile |
| P0A-22 | `REJECTED` | More than the global active-patch cap |
| P0A-23 | deterministic | Reordered producer inputs yield the same producer-authored canonical bytes |
| P0A-24 | immutable | Every public result/prior/candidate projection resists caller mutation |

### 5.1 Required mutants

- Bypass canonical-byte comparison: P0A-07 must fail.
- Replace duplicate-aware parsing with ordinary `JSON.parse`: P0A-06 must fail.
- Force generation comparison to equality: P0A-05 and P0A-14 must fail.
- Compare generation strings lexicographically: the `"9"` to `"10"` case must fail.
- Skip exact-byte digest verification: P0A-12 must fail.
- Treat touching masks as disjoint: P0A-16 must fail.
- Read closure inputs before bootstrap discovery: P0A-01 must fail.
- Accept a verifier-external candidate: `commitCandidate` must throw a programmer-facing error.

## 6. Explicitly deferred work

P0b may add an in-memory content-addressed store, compare-and-swap mutable head, conditional GET,
seeded producer, scenario generator, and non-authoritative hint reconciliation after P0a passes
independent review.

P1 may begin engine integration only after a new preregistration resolves or bounds:

- bootstrap trust and signed-head freshness;
- the revocation/offline availability tradeoff;
- descriptor closure and rederived request/compaction bounds;
- a global active-state/sharding bound;
- per-bin exposure-prior schema or its removal;
- mask target, height semantics, antimeridian behavior, boundary ownership, and content-group identity;
- nested/external tileset behavior; and
- current C11/C12/C18 collision boundaries.

P1 must use one backend-neutral semantic transaction with backend-specific execution only. Before any
runtime claim, tests must cover both WebGL and WebGPU for color, depth, pick, shadow,
classification, queries, most-detailed traversal, future-loaded content, multi-content, constant-count
mask edits, cache pressure, context/device loss, and atomic mask-plus-replacement swap. Current
clipping code's constant-position-count change detection and WebGPU merged-extent cap must be repaired
or rejected before activation; warning-and-partial-clipping is not an admissible state.

## 7. Handoff constraints

- No Git command, branch operation, commit, stash, reset, restore, or status inspection is authorized.
- No browser or GPU evidence is authorized for P0a.
- No deletion or garbage-collection mutation is authorized; P0a has no physical store.
- No source under `packages/engine/**` or shared campaign tooling may change in this slice.
- All files remain local and uncommitted through quiet hours and until the maintainer changes the
  explicit no-Git instruction.
- Passing P0a tests will mean only that this bounded prototype contract passed. It will not certify
  the full design, a 3D Tiles standard extension, Cesium runtime integration, WebGL/WebGPU behavior,
  or an open campaign row.
