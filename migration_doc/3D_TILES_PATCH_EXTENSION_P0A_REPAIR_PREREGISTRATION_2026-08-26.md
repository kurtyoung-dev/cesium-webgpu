# 3D Tiles patch extension — P0a repair preregistration

**Date:** 2026-08-26  
**Status:** PREREGISTERED / NOT YET EXECUTED  
**Lane:** local-only, browser-free, no Git, no deletes  
**Path lease:** this document, a result document, and the existing files under
Tools/patch-prototype only

## 1. Why this repair slice exists

The original P0a implementation tuple returned green registered tests but failed independent review.
This repair is preregistered before any implementation byte changes. It does not revise the original
preregistration after the fact and does not turn its failed or structurally unevaluable rows green.

The independently reviewed frozen tuple was:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Original P0a preregistration | 14,256 | d3044e22981f4b4e5a61d263cff8554ee07d858719515c147555496e7ea75c24 |
| strict-json.mjs | 24,389 | 515cbc5a94efdced433535abf008d9a174c1e1d7f67f1cdeb3f39d7a2438dd9f |
| strict-json.spec.mjs | 8,856 | 7e2238f9436e33e725468851452f9d7a8a509ddc7a6e20ea70ad29762ef3e894 |
| live-update-v0.mjs | 46,724 | 1ace58feeb8a32229d2c71649f2f55e2d3be34cca7999861c5a7a07c27ffb3a0 |
| live-update-v0.spec.mjs | 20,311 | 45ce26bf8c5c2467f7bc3448952170c44ef012538fad18c2cd3b2b255f82910a |

The first reviewer returned FAIL / NO-GO. The second returned STRUCTURAL / NO-GO for the complete
matrix and FAIL for executable bounded-verifier behavior. The standing findings are:

1. caller-owned byte views can change between parse and digest/length checks;
2. the exported strict parser accepts caller limits that can overflow recursive descent;
3. malformed prior records can discard already collected stable diagnostics;
4. URI parsing accepts ambiguous repaired or encoded-separator forms;
5. closure maps are materialized and hashed before cardinality and byte bounds;
6. error order depends on caller insertion order;
7. several registered clauses lack isolated negative-control teeth;
8. original P0A-19 overclaims external-tileset inspection; and
9. original P0A-23 claims producer behavior although P0a has no producer.

No measured red is demoted. The frozen tuple remains the failed baseline.

## 2. Corrected scope

### 2.1 Physical nesting only

P0a can reject a nested bootstrap only when that nested object is physically present in
entrypointBytes. External tileset resources are not P0a inputs and are outside its control closure.
The original external/child-tileset implication in P0A-19 is therefore STRUCTURAL and is deferred to
the later runtime/resource-closure slice.

### 2.2 Producer determinism moves to P0b

P0a owns a canonicalizer and verifier, not a publication producer. The original P0A-23 producer claim
is STRUCTURAL. P0a retains only the narrower claim that RFC 8785 object-property insertion order does
not change canonical bytes. Sorting semantically unordered producer inputs and generating a complete
publication are P0b requirements.

### 2.3 Closed prototype byte-map type

Both descriptor closures accept an exact native Map from digest string to byte view. Plain objects,
Map subclasses, custom iterables, and unexpected entries reject. This is an experimental API
tightening with no compatibility commitment.

### 2.4 Closed prototype URI grammar

Every protocol URI in P0a is a simple relative path:

- one or more nonempty slash-separated segments;
- each segment contains only ASCII letters, digits, dot, underscore, tilde, or hyphen;
- a segment cannot be exactly dot or dot-dot;
- maximum length is 2,048 UTF-16 code units; and
- no scheme, leading slash, query, fragment, percent encoding, backslash, whitespace, credential
  syntax, control character, or non-ASCII spelling is accepted.

This is intentionally narrower than a general RFC relative-reference grammar. It eliminates
WHATWG repair behavior and server-dependent decoding from the P0a trust boundary.

## 3. Repair contract

### 3.1 One immutable byte snapshot

Each entrypoint, head, state, base descriptor, and patch descriptor input is copied once into an
ordinary fixed Uint8Array snapshot before parsing, hashing, length checks, or retention. Every
operation for that document uses the snapshot. No caller-owned ArrayBuffer, SharedArrayBuffer, view,
or growable backing store remains reachable from a parsed document or closure map.

The entrypoint option getter is read once. The default discovery parse and the caller-tightened parse
reuse the same snapshot.

### 3.2 Hard parser ceilings

The strict JSON defaults are hard maxima, not suggestions. A supplied limit may only tighten a known
default. Unknown keys, negative values, and values above the hard ceiling reject with
StrictJsonError INVALID_LIMIT. The default maximum depth remains 64.

### 3.3 Closure resource bounds

- baseDescriptorBytesByDigest has at most one entry;
- patchDescriptorBytesByDigest has at most maxActivePatches entries;
- each descriptor is at most maxBytes before it is copied or hashed;
- combined base-plus-patch descriptor bytes are at most maxControlClosureBytes;
- maxControlClosureBytes defaults to 17 MiB and may only be tightened; and
- iteration stops at the first entry beyond the cardinality cap.

The verifier never spreads or fully materializes an oversized caller map. Limit errors reject before
SHA-256 work.

### 3.4 Stable rejection projection

Safely collectable errors are returned in canonical path, code, detail order, independent of caller
Map or options insertion order. Invalid prior shape or field data preserves its field diagnostics,
adds PRIOR_INVALID, and never reaches BigInt conversion or initial-admission logic.

## 4. Preregistered repair acceptance

All tests use Node's test runner and no browser or GPU. A valid expectation miss is FAIL. Invalid or
unevaluable test structure is STRUCTURAL.

| ID | Expected | Case |
| --- | --- | --- |
| R1-01 | PASS | Original strict and live suites remain green without weakening an expectation |
| R1-02 | PASS | SharedArrayBuffer and mutable typed-array inputs are snapshotted; the verifier retains no caller view |
| R1-03 | PASS | maxDepth 64 is evaluable and maxDepth 65, 5,000, and unknown limit keys reject as INVALID_LIMIT |
| R1-04 | PASS | Oversized, over-cardinality, unexpected, custom, and aggregate-oversized closure maps reject before copy/hash |
| R1-05 | PASS | Malformed prior fields return stable MISSING_FIELD or field errors plus PRIOR_INVALID, never a generic stack/BigInt catch |
| R1-06 | PASS | URI invalid controls cover every URI-bearing object and reject space, percent encoding, encoded separators, dot segments, query, fragment, scheme, root, backslash, and non-ASCII forms |
| R1-07 | PASS | Permuting limits and closure-map insertion order produces byte-identical serialized error projections |
| R1-08 | PASS | P0A-08 duplicate patch identity uses distinct descriptor digests, so only the patch-ID guard can satisfy it |
| R1-09 | PASS | P0A-12 separately covers state, base, and patch digest and byte-length mismatches |
| R1-10 | PASS | P0A-13 separately covers head/state generation, descriptor dataset, base-reference, patch-reference, lineage, and transition mismatches |
| R1-11 | PASS | P0A-14 covers malformed prior, replay revision/length mismatch, and successor initialPublication |
| R1-12 | PASS | P0A-15 covers missing and unexpected unreachable closure entries |
| R1-13 | PASS | P0A-24 covers deep immutability of rejection errors and post-verification mutation isolation |
| R1-14 | PASS | The four prototype publication-event tokens and the P0a/P0b/P1 boundaries are documented beside the code |
| R1-15 | PASS | Prettier check and ESLint pass on every prototype source/spec/document subject to those tools |
| R1-16 | PASS | Independent reviewer re-hashes the repaired tuple and returns no unresolved CRITICAL, MAJOR, HIGH, FAIL, ERROR, or STRUCTURAL finding in this corrected scope |

### 4.1 Adversarial teeth

- Replacing a snapshot with the original view must turn R1-02 red.
- Allowing a strict limit above its hard default must turn R1-03 red.
- Spreading a closure Map before its cardinality check must turn R1-04 red.
- Hashing a descriptor before its byte-limit check must turn R1-04 red.
- Returning errors in append order must turn R1-07 red.
- Removing the state/head generation equality check must turn R1-10 red.
- Removing the patchRevisionId uniqueness check must turn R1-08 red.
- Accepting WHATWG-repaired or percent-encoded paths must turn R1-06 red.

## 5. Required artifacts and commands

The repair may change only:

- Tools/patch-prototype/strict-json.mjs
- Tools/patch-prototype/strict-json.spec.mjs
- Tools/patch-prototype/live-update-v0.mjs
- Tools/patch-prototype/live-update-v0.spec.mjs
- Tools/patch-prototype/README.md
- this preregistration and one result document under migration_doc

Required focused commands:

1. node --test Tools/patch-prototype/strict-json.spec.mjs
   Tools/patch-prototype/live-update-v0.spec.mjs
2. npx prettier --check against the five prototype files and the two P0a documents
3. npx eslint against the four JavaScript source/spec files

Formatting may not rewrite the original preregistration. The result document records the failed
baseline, repaired hashes, command output, reviewer verdict, and every deferred structural claim.

## 6. Non-claims

Passing this repair will not make the original P0A-01..24 matrix retroactively PASS. It will establish
only the corrected P0a-R1 contract above. It does not implement a producer, CAS, mutable server,
external-tileset closure, Cesium runtime, WebGL, WebGPU, freshness, authenticity, revocation,
registration, campaign evidence, or certification.

No Git command, delete, browser, GPU probe, engine edit, landing action, or campaign score change is
authorized.
