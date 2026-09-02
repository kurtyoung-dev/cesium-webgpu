# 3D Tiles patch extension P0a-R2 bounded-carrier preregistration

**Date:** 2026-08-26  
**Status:** FROZEN BEFORE R2 IMPLEMENTATION  
**Scope:** renderer-free local prototype only  
**Authority:** this document narrows the experimental P0a API; it does not revise the original failed
tuples, authorize engine integration, or make a standards claim

## 1. Why R2 exists

The original P0a tuple and three repair attempts remain immutable evidence:

| Tuple | Disposition |
| --- | --- |
| Original P0a | FAIL, with P0A-19 external-resource closure and P0A-23 producer behavior STRUCTURAL |
| Repair attempt 1 | FAIL / NO-GO |
| Repair attempt 2 | FAIL / NO-GO |
| Repair attempt 3 | conflicting review: one PASS / GO, one FAIL / NO-GO plus STRUCTURAL |

The conflicting third review is resolved conservatively. The adversarial reviewer reproduced a
measured red, so the PASS review cannot close R1-16.

The frozen third-attempt tuple was:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Repair preregistration | 9,737 | 6b67212620c9b005797deab86c5c4ebe1d1d59f676e387ff97b1a82c31529d57 |
| README | 10,672 | d151b1064faeb93a0218a573c301dd9e826c0bf2ba4e43c0b9a9af48aa401109 |
| strict-json.mjs | 28,627 | d4ad7aba55115225cef3dc45e256ee8b926765961132fdb6f557dbcff3c34a40 |
| strict-json.spec.mjs | 19,208 | 2ecbd3276b8bd4a60af307ee15bfb6677b6ea3f539b8a6097850a584c63e391f |
| live-update-v0.mjs | 54,707 | e983229bbad7a2f2752418cd3cbd2918485b1132a27c954077f6d051606ed2d5 |
| live-update-v0.spec.mjs | 62,588 | c801a8b2d1d055d508c8a14fa00760f6b59aae810ed1d9d48e5a105bcfabcf07 |

That tuple passed 134 of 134 Node tests, the seven-file Prettier check, and the four-file ESLint
check. Those green gates are retained, but they do not erase the findings below.

### 1.1 Reproduced hostile-property-bag failure

The strict and live guarded `for...in` scanners first force JavaScript to consume the complete
`[[OwnPropertyKeys]]` result. A Proxy advertising 100,000 non-enumerable metadata keys caused:

- strict limits: one `ownKeys` call and 100,004 descriptor calls; and
- live limits/prior: one `ownKeys` call and 100,006 descriptor calls.

Both operations accepted. Work scaled linearly although the loop body could never observe a key on
which to enforce its early stop. Unlimited inert metadata, exhaustive unknown-field rejection, and a
hard hostile-input bound cannot coexist on an arbitrary JavaScript property bag.

### 1.2 Reproduced raw graph API failure

The exported programmatic `canonicalizeJson` and `deepFreeze` APIs:

- leaked raw revoked-Proxy and caller-trap exceptions;
- overflowed the stack on a depth-10,000 array;
- echoed a one-MiB array property name into a 1,048,645-character error; and
- had no hostile-input container, traversal, or output budget.

These APIs are not required for the byte-verification boundary and are removed from the public R2
surface rather than patched with a limit that reflection cannot enforce before `ownKeys` returns.

### 1.3 Why exact native Map is not the R2 hard carrier

Captured native Map size and entry intrinsics prevent caller hook dispatch, but ECMAScript does not
bind iteration work to current live `Map.size`. A heavily churned Map may retain arbitrarily long
deleted-slot history. R2 therefore does not relocate the hard-bound claim from objects to Maps.

## 2. Frozen R2 public boundary

### 2.1 Strict JSON byte APIs only

The strict module publicly exposes:

```js
decodeJsonBytes(bytes, maxBytes?, maxDepth?, maxContainerEntries?, maxStringCodeUnits?)
decodeCanonicalJsonBytes(bytes, maxBytes?, maxDepth?, maxContainerEntries?, maxStringCodeUnits?)
canonicalizeJsonBytes(bytes, maxBytes?, maxDepth?, maxContainerEntries?, maxStringCodeUnits?)
```

The four optional limits are positional numeric primitives. Each defaults to the current hard
default and may only tighten it. Invalid, excessive, object, Proxy, symbol, BigInt, or non-finite
arguments reject as one constant bounded `StrictJsonError(INVALID_LIMIT)` before byte inspection.
`maxDepth` admits integers from zero through 64; the other three strict limits admit integers from
one through their existing hard defaults.

`canonicalizeJsonBytes` snapshots and duplicate-aware parses bounded input, serializes only that
parser-produced graph, and returns a new ordinary fixed `Uint8Array` of canonical RFC 8785 bytes.
`decodeJsonBytes` and `decodeCanonicalJsonBytes` return deeply frozen parser-produced JSON. The
arbitrary-programmatic-graph `canonicalizeJson` and `deepFreeze` exports are absent. Their trusted
internal equivalents may consume only parser-produced graphs or fixed module-owned records.

### 2.2 Local live limits are bounded JSON bytes

`verifyCandidate.options.limits` is either `undefined` or an ArrayBuffer/SharedArrayBuffer/view
containing at most 512 bytes of duplicate-aware JSON. It is local configuration, not a protocol
resource, so noncanonical property order and whitespace are admitted. The root must be an object with
only these optional integer fields:

- maxActivePatches;
- maxBytes;
- maxControlClosureBytes;
- maxContainerEntries;
- maxDepth; and
- maxStringCodeUnits.

Every value may only tighten the existing hard default. A fixed bootstrap parser applies 512 bytes,
depth 2, eight container entries, and 64 decoded string code units before any caller limit exists.
`maxActivePatches` admits integers from zero through 16; the other five live limits admit integers
from one through their existing hard defaults.
Unknown, duplicate, nested, excessive, or malformed limits reject with bounded non-echoing errors.
Permuting fields produces the same normalized limits or byte-identical error projection.

### 2.3 Prior restoration uses canonical bytes

`verifyCandidate.options.prior` and `commitCandidate(prior, candidate)` accept exactly one of:

- `undefined` or `null`, both meaning no admitted predecessor;
- a module-minted admitted record returned by this module instance; or
- canonical UTF-8 prior bytes.

The canonical prior has exactly six string fields in RFC 8785 order:

```text
datasetId, generation, stateByteLength, stateDigest, stateRevisionId, version
```

Its derived maximum is exactly 290 UTF-8 bytes: two 36-character UUIDv7 values, two 20-digit uint64
values, one 71-character digest, version `0.1`, fixed keys, quotes, commas, colon characters, and
braces. Bytes above 290 reject before copy or parse. Duplicate keys, noncanonical bytes, missing or
unknown fields, invalid values, or invalid carriers add stable field diagnostics where safely
available plus `PRIOR_INVALID`.

A private WeakMap stores the normalized fixed six-string tuple for each module-minted admitted
record. The fast path uses captured WeakMap intrinsics and never rereads visible record properties.
`encodePrior(admittedRecord)` returns a new canonical byte snapshot for persistence, structured
clone, another realm, or another module instance. Candidates remain deliberately module-instance
local.

Candidate commit is value-bound: verification stores the normalized predecessor tuple. Any
independently restored, byte-equivalent prior may commit that candidate; a different tuple rejects as
`CANDIDATE_PRIOR_MISMATCH`. A candidate from another module instance always rejects.

### 2.4 Descriptor closures use sealed module handles

Arbitrary Maps, objects, arrays, and iterables are removed from the descriptor-closure boundary. The
module exposes:

```js
createBaseDescriptorClosure()
createPatchDescriptorClosure()
```

Each returns a frozen builder with `add(digest, bytes)` and `seal()` methods closing over module-owned
state. `add` performs, in order:

1. sealed-state check;
2. digest primitive, exact-length, and grammar checks without conversion or echo;
3. duplicate and hard entry-cap checks;
4. intrinsic byte-window admission;
5. per-entry and aggregate hard-byte checks; and
6. one copy to a fixed ordinary Uint8Array.

The base builder admits at most one entry and 1 MiB. The patch builder admits at most 16 entries and
16 MiB. Entry/cardinality/byte errors occur before copying or hashing. `seal()` is idempotent, sorts
at most 16 fixed-length digest labels, freezes the module-owned payload, and returns one opaque frozen
handle registered in a private WeakMap. `add` after sealing rejects.

The existing option names `baseDescriptorBytesByDigest` and `patchDescriptorBytesByDigest` now carry
only the matching sealed handle. Verification begins with captured WeakMap identity lookup; a forged,
proxied, cross-module, or wrong-kind handle rejects without property inspection. Tightened caller
limits are applied to the already-owned snapshots before hashing. The verifier retains no builder,
caller view, iterator, or collection.

Builders and sealed closure handles are local prototype conveniences, not wire records and not
persistent capabilities. A caller rebuilds them from its content store after process or module
restart. P0b may replace them with a language-neutral bounded bundle only under a new preregistration.

### 2.5 Stable diagnostics and terminating-host-code boundary

No R2 diagnostic includes a carrier position, insertion index, attacker key/value text, trap text,
native exception text, or caller conversion result. Live errors remain sorted by path, code, and
constant detail. Strict errors use fixed codes/details and bounded byte offsets.

No JavaScript API can preempt a Proxy trap that never returns. R2 claims that module work is bounded
after each invoked intrinsic or host operation returns, and that terminating trap failures collapse
to stable local errors. The strict byte APIs and module-minted handles are the hostile-input trust
boundary; arbitrary object-graph traversal is not.

## 3. Preregistered R2 acceptance

A valid expectation miss is FAIL. A missing, ambiguous, nonunique, or unevaluable test/mutant is
STRUCTURAL. Test harness failure is ERROR.

| ID | Expected | Case |
| --- | --- | --- |
| R2-01 | PASS | Every executable original wire-semantic control remains green after explicit carrier migration; P0A-19 external-resource closure and P0A-23 producer behavior remain explicitly deferred/STRUCTURAL |
| R2-02 | PASS | Strict positional limits accept defaults and hard maxima, reject values above maxima and every nonnumeric hostile carrier before byte inspection |
| R2-03 | PASS | Live limits bytes enforce the 512-byte bootstrap, duplicate/shape/value rules, hard ceilings, and insertion-order-independent results |
| R2-04 | PASS | Canonical prior bytes enforce the exact 290-byte maximum, duplicate-aware canonical spelling, fixed schema, UUID/digest/uint64 bounds, and PRIOR_INVALID projection |
| R2-05 | PASS | encodePrior output structured-clones and restores through a fresh module instance, then verifies and commits a successor |
| R2-06 | PASS | Minted prior properties are never reread; forged copies and proxies reject; equivalent restored bytes commit by tuple value; different tuples reject |
| R2-07 | PASS | Candidate identity uses captured WeakMap intrinsics before any property/proxy inspection and remains module-instance local |
| R2-08 | PASS | Base/patch builders cap 1/16 entries and 1/16 MiB before copy/hash; duplicate/invalid/over-cap additions have zero byte reads |
| R2-09 | PASS | Builders snapshot mutable, shared, cross-realm, typed-array, and DataView windows; post-add mutation cannot change sealed closure behavior |
| R2-10 | PASS | seal is idempotent, add-after-seal rejects, sorted private payloads make insertion permutations observationally identical, and wrong/forged handles reject without hooks |
| R2-11 | PASS | Tightened per-entry and combined closure budgets reject owned snapshots before hashing; missing/unexpected/digest/length controls remain isolated |
| R2-12 | PASS | A plain object or Proxy carrying 100,000 hidden fields rejects at the limits, prior, closure-handle, and candidate boundaries without ownKeys/descriptor/get/toJSON/coercion hooks |
| R2-13 | PASS | canonicalizeJson and deepFreeze are absent exports; canonicalizeJsonBytes gives identical canonical bytes for property-order variants and stable bounded strict errors |
| R2-14 | PASS | Depth 64 is evaluable; depth 65 and 5,000 reject without RangeError; decoded values and public verifier projections are deeply immutable |
| R2-15 | PASS | No public path retains a caller byte view; the entrypoint in-call mutation and builder snapshot-removal mutants both turn red |
| R2-16 | PASS | Error projections are byte-identical across repeat runs and all semantic input permutations, with no attacker marker in any path/detail/message |
| R2-17 | PASS | Function-scoped source controls ban property-bag scanners, caller collection iteration, bulk reflection, dynamic WeakMap lookup, and raw object-graph exports across the transitive boundary |
| R2-18 | PASS | Each hostile synchronous case runs in a worker with construction excluded and a two-second parent deadline; timeout is FAIL and harness failure is ERROR |
| R2-19 | PASS | Prettier and ESLint pass over every prototype source/spec/document in the R2 tuple |
| R2-20 | PASS | Two independent reviewers rehash the terminal tuple, execute mutants, and return no unresolved CRITICAL, MAJOR, HIGH, FAIL, ERROR, or STRUCTURAL finding in R2 scope |

### 3.1 Required mutants

Each source transformation must match exactly once. A missing or nonunique anchor is STRUCTURAL; a
surviving mutant is FAIL.

1. Replace a byte snapshot with the caller view.
2. Move a builder entry/cardinality/byte cap below byte copying or hashing.
3. Retain a caller byte view in a sealed closure payload.
4. Replace closure/prior/candidate WeakMap identity with visible property inspection.
5. Look up WeakMap `has`, `get`, or `set` dynamically after module initialization.
6. Accept plain-object, Map, array, iterable, or caller-authored closure handles.
7. Echo or convert an invalid digest, limit field, prior field, trap error, or native error.
8. Remove the 512-byte limits or 290-byte prior early cap.
9. Move UUID/digest/uint64 string-length checks below regex, numeric conversion, or canonicalization.
10. Bind commit to caller object identity instead of the registered tuple value, or accept a different tuple.
11. Re-export arbitrary-graph canonicalizeJson or deepFreeze.
12. Replace byte canonicalization with recursive traversal of a caller programmatic graph.
13. Remove max-depth enforcement or allow raw RangeError to escape.
14. Return a mutable decoded/result/prior graph.
15. Advance or enumerate a caller collection at verify time.
16. Return builder entries in caller insertion order where it changes an error/result projection.

## 4. Required artifacts and commands

R2 may change only:

- Tools/patch-prototype/strict-json.mjs;
- Tools/patch-prototype/strict-json.spec.mjs;
- Tools/patch-prototype/live-update-v0.mjs;
- Tools/patch-prototype/live-update-v0.spec.mjs;
- Tools/patch-prototype/README.md;
- this preregistration; and
- one P0a result document under migration_doc.

Required terminal commands:

1. `node --test Tools/patch-prototype/strict-json.spec.mjs Tools/patch-prototype/live-update-v0.spec.mjs`
2. `npx --no-install prettier --check` over the five prototype files, original P0a preregistration,
   R1 repair preregistration, this R2 preregistration, and the result document when present
3. `npx --no-install eslint` over the four JavaScript source/spec files
4. the preregistered mutant runner, including the two-second worker-deadline controls

Formatting may not rewrite an earlier frozen preregistration. The result must preserve every failed
tuple, the conflicting third reviews, exact hashes/gates, R2 terminal evidence, and all deferred
claims.

## 5. Non-claims

R2 remains renderer-free P0a. It does not implement or prove a publication producer, mutable head
server, CAS, transport, freshness, authenticity, revocation, external/heavy resource closure,
runtime transaction, mask compositor, cache ownership, retirement, WebGL, WebGPU, standards
registration, campaign evidence, or certification.

No Git command, delete, browser, GPU probe, engine edit, landing action, external write, or campaign
score change is authorized by this preregistration.
