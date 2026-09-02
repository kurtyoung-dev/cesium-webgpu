# 3D Tiles patch extension P0b-core R6 snapshot/fixture split preregistration

**Date:** 2026-08-27  
**Status:** frozen candidate pending independent design review; no implementation authority  
**Scope:** non-weakening placement, fixture, and total-error repair for P0B-F02 through P0B-F06  
**Lane:** local-only, browser-free, GPU-free, network-free, deletion-free, and externally unpublished;
the separately authorized local Git checkpoint remains gated on complete successor certification

## 1. Authority and decision

R6 supplements R5 and replaces only its helper/spec placement, caps, source arithmetic, failure-wrap
contract, and affected fixture/linking clauses:

| Authority | Bytes | Physical lines | SHA-256 |
| --- | ---: | ---: | --- |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_R5_SPLIT_PACKAGE_TREE_PREREGISTRATION_2026-08-26.md` | 19,399 | 290 | `eea3692c77d8a2a7cf49319e67ff6a7ec103a092a25d739736f14d216497f67d` |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | 43,398 | 602 | `250d3bba7bdcd7750cb7b2580349884b0c59cdb1d17f48fe7eb50f41a062b3d8` |

All base and R1-R5 digest framing, package set, resolver chain, controlled mechanics, exact schemas,
public non-injection boundary, gates, chronology, and nonclaims remain binding unless this document
expressly replaces them. This successor chooses two genuine responsibility splits: stable filesystem
snapshots separate from package projection, and deterministic fixtures separate from adjudicating
spec code. A cap-only raise is rejected because it would leave both mixed responsibilities intact.

This file is a design candidate only. No source or test implementation may begin until a fresh,
independent, read-only reviewer rehashes this exact document and returns unconditional PASS / GO with
no open finding.

## 2. Immutable reds and design chronology

No earlier red is rescored:

| Artifact or finding | Frozen evidence | Disposition |
| --- | --- | --- |
| ignored root-lock oracle, P0B-F02 | clean clone produced 70/71; root `package-lock.json` is ignored, stale, and never tracked | STRUCTURAL / NO-GO |
| R4 combined helper | 10,092 bytes / 315 lines / `f2fd7c89828f0f8fd7cd729fe42e25607623c757c3e11b4a2868c50f73e4f1d3` | FAIL against cap 220 |
| first R5 design | 13,795 / 219 / `eb47d02f71b0921e1ce803ec36e8bef0522aa1e4c215857c964b5a259057ad27` | HIGH / NO-GO: real descriptor reader could remain inert |
| first amended R5 design | 16,604 / 251 / `859499dfae4919adc9955769e300669f90c0904d2c492613137666bdaa0a06bc` | HIGH / NO-GO: cached first traversal could be supplied twice |
| failed R5 tree helper, P0B-F03 | 15,213 / 485 / `7108d6d54457f306469d5b0acedc790a388dbe54bd4dc6fd790fd2495b58f9c9` | FAIL against cap 320 |
| R5 resolver helper | 3,145 / 94 / `1371c339a748c593eb55469176114a74d7b1aa682f384c8c17f80b0f09c4ea6b` | locally green; not terminal authority |
| unfinished provenance scaffold | 11,850 / 339 / `effb1616eca16133c28f5c511c550195db45740ae19bcdf876ca0cbc15f4146a` | zero tests; no P0B-21/P0B-22 claim |
| first R6 candidate | 16,100 / 268 / `d33431579c6ca927394bbe130acd8cb8223314d93ae11845ddddd83d172abc8c` | FAIL / NO-GO: contradictory and forgeable preservation, unproven Proxy totality, an intercepted resolver case, unspecified new seams, a shared trace oracle, and inconsistent immutable-spec count |
| second R6 candidate | 27,557 / 390 / `db8fcc6bc0700008542d90bfa1459ca300514272246ac9a723cf3334352c78f5` | FAIL / NO-GO: a leaked constructor could mint preserved derived state, descriptor-result accessors escaped the stated hook model, a positive check was misclassified as a discriminator, and fixture mutability was misstated |
| third R6 candidate | 27,227 / 376 / `5a9be662510c43e7f6113b227305a10ce884125f3e6f53ae2f99e5c4a14498c8` | FAIL / NO-GO: native `Error.stack` accessors were not normalized, revoked-Proxy totality was untested, and hostile non-string boundary reconstruction could invoke coercion |
| fourth R6 candidate | 28,803 / 394 / `2ed3bb7427f3b730bc23210ac4430407af33c18a23b555075d58cd996aa23db6` | FAIL / NO-GO: out-of-anchor private error references were not forbidden, so an unsupported-entry failure could bypass branding or leave a latent `ReferenceError` and vacuously kill the mutant |

P0B-F04 remains the coercible-hash/shallow-record defect. P0B-F05 remains the same-length drift and
path-type/symlink observation defect. P0B-F06 is the non-total error wrapper: reading
`error.message` or calling `String(error)` can invoke hostile hooks and escape an unfrozen native
error. P0B-F02 through P0B-F06 remain open until the complete R6 terminal gate; design approval alone
closes none of them.

## 3. Snapshot helper

Add `Tools/patch-prototype/p0b/test-support/parser-package-tree-snapshot-v1.mjs`. It owns only:

- module-private immutable parser-provenance ERROR construction, branding, and safe wrapping;
- getter-free exact object, dense-array, stat, tree-record, and mechanics reconstruction;
- normalized containment and UTF-8 bytewise path ordering;
- descriptor-bound file reads, recursive traversal, and nested `node_modules` exclusion;
- symlink, special-node, escaping-path, identity, type, and length rejection;
- defensive tree copies and exact two-pass stability comparison; and
- the fixed real Node filesystem mechanics.

`ParserProvenanceError` and its module-private `WeakSet` brand are not exported. The exact
named-export allowlist, binding kind, and observable arity or type are:

| Export | Kind / `Function.length` | Exact contract |
| --- | --- | --- |
| `ensureParserProvenance` | function / 2 | returns `undefined` when its condition is truthy; otherwise throws a branded frozen ERROR after accepting only a primitive-string message |
| `freezeParserFilesystemMechanics` | function / 1 | getter-free reconstruction of exactly six own data properties `lstat`, `readdir`, `open`, `fstat`, `read`, and `close`, each an arity-one function |
| `inspectStablePackageTreeWithMechanics` | function / 2 | validates one absolute root and an arity-one pass, calls that pass twice, independently reconstructs and compares both results, and returns another defensive copy |
| `parserPackageRelativePath` | function / 3 | validates an absolute root/path plus primitive-string label and returns a `/`-normalized non-root relative path |
| `readPackageTreePassWithMechanics` | function / 2 | performs one complete fixed-order traversal and returns a fresh UTF-8-bytewise-ordered dense tree |
| `realParserFilesystemMechanics` | frozen exact-data object, not a function | exactly the six mechanics keys above, with no accessor, symbol, or extra property and arity one for every value |
| `wrapParserProvenanceFailure` | function / 2 | identity-preserves only an authentic module-branded error; every other value produces a newly reconstructed branded frozen ERROR under §5 |

Tree passes and stable trees are frozen dense arrays of frozen exact R5 tree-record objects. Every
file record owns a fresh `Buffer`; no input-pass Buffer, record, array, descriptor, or caller-thrown
object is retained. A returned Buffer is not claimed intrinsically immutable, but mutating it cannot
affect an earlier comparison, another pass, or another returned tree.
The helper imports only `node:fs` and `isAbsolute`, `join`, and `relative` from `node:path`. It has
no default export and contains no crypto, digest framing, manifest JSON, package record,
version/count/hash projection, `createRequire`, resolver, expected package, mutant, source identity,
install/network behavior, or policy oracle.

## 4. Package façade and resolver

`parser-package-tree-v1.mjs` becomes the package-measurement façade. It owns only v1 domain framing,
U32BE/U64BE encoding, SHA-256, exact primitive package-record reconstruction, root-manifest and
entrypoint projection, metadata validation, counts/digests, and the injectable/public measurement
wrappers. It imports `createHash` from `node:crypto`, `dirname` and `isAbsolute` from `node:path`, and
exactly the seven snapshot bindings listed in §3. Record-specific relative-entrypoint validation
stays in this façade; filesystem containment and absolute-to-relative normalization stay in the
snapshot helper.

Its exact export allowlist remains:

1. `ensureParserProvenance` (re-export);
2. `freezeParserPackageRecord`;
3. `inspectStablePackageTreeWithMechanics` (re-export);
4. `measureResolvedPackageFilesWithMechanics`;
5. `measureResolvedPackageFiles`; and
6. `wrapParserProvenanceFailure` (re-export).

The four-argument measurer freezes the six mechanics once and contains one unique direct edge
equivalent to:

```js
inspectStablePackageTreeWithMechanics(packageRoot, (freshRoot) =>
  readPackageTreePassWithMechanics(freshRoot, mechanicsSnapshot),
);
```

The three-argument public measurer has one unique tail delegating to the four-argument form with
`realParserFilesystemMechanics`. No alternate traversal, pathname read, retry, cache, projection, or
fallback exists.

`parser-provenance-v1.mjs` remains byte-identical at 3,145 / 94 /
`1371c339a748c593eb55469176114a74d7b1aa682f384c8c17f80b0f09c4ea6b`. Its four façade imports,
three exports, arities two/three/zero, resolution chain, resolver-consumption trace, and exact public
tail do not change. It imports neither the snapshot nor fixture helper directly.

## 5. Total immutable failure wrapping

`ParserProvenanceError` remains non-exported but observable through an authentic instance's inherited
`constructor`. That arity-zero constructor executes only `super()`: no value, field, freeze, or brand.
The module-private factory is the sole brand mint and direct `new ParserProvenanceError()` site. It
calls the lexical base without caller `newTarget`, deletes all host own keys, defines the exact schema
below, freezes/validates nested state and error, verifies the exact base prototype, then brands. The
constructor and prototype are frozen.

The module captures/binds `WeakSet.prototype.add`/`has`, `Object.freeze`,
`Object.getOwnPropertyDescriptor`, `Object.getPrototypeOf`, `Object.hasOwn`, `Object.isFrozen`,
and `Reflect.defineProperty`/`deleteProperty`/`ownKeys` at evaluation. Pre-evaluation primordial
poisoning, process termination, nontermination, resource exhaustion, and trap side effects remain
outside the claim.

`Reflect.ownKeys(error)` equals this exact six-string vector:

| Order/key | Exact value | Enumerable |
| ---: | --- | --- |
| 1 `name` | `"ParserProvenanceError"` | true |
| 2 `message` | sanitized primitive outer message | false |
| 3 `code` | `"PARSER_PROVENANCE_ERROR"` | true |
| 4 `status` | `"ERROR"` | true |
| 5 `details` | ensure: frozen dense `[]`; wrapper: frozen dense `[Object.freeze({ message: detail })]` | true |
| 6 `stack` | `"ParserProvenanceError: stack unavailable."` | false |

All six are own data descriptors with `writable: false` and `configurable: false`; no symbol,
accessor, setter, native lazy stack, or extra key remains. The wrapper detail record has exactly one
own enumerable, non-writable, non-configurable primitive-string `message` data property. Both error
forms remain `instanceof Error` and `ParserProvenanceError`.

Instances created through `authentic.constructor`, subclassing, or either `Reflect.construct` form
are unbranded, including frozen instances backed by mutable caller prototypes, and are reconstructed.
Brand membership alone preserves input; no `instanceof`, prototype/public-field, or frozen-state
test does. Authentic branded errors alone are identity-idempotent. Brand lookup precedes boundary
inspection, so a non-string boundary selects fallback without access or coercion.

The sole fallback literal is `Parser provenance failure detail unavailable.`. An unbranded
primitive string is used directly. Otherwise the wrapper makes at most one guarded call through
captured `Object.getOwnPropertyDescriptor(thrownValue, "message")` and accepts only the completed own
data descriptor whose value is a primitive string. Every other result selects the fallback.

The descriptor intrinsic may execute caller code in a Proxy `getOwnPropertyDescriptor` trap and
during conversion of its descriptor-like result, including a `value` getter. The whole intrinsic
call is guarded: any trap, result accessor, invalid descriptor, invariant failure, or revoked-Proxy
throw is contained and selects fallback. The claim is one contained descriptor-protocol operation,
not zero caller hooks. Outside it the wrapper performs no thrown-value property read, getter call,
coercion, `String`, interpolation, `instanceof`, or prototype inspection.

The façade catch uses fixed `Could not measure parser package.` and never interpolates `name`; the
byte-identical resolver retains its fixed messages.

## 6. Exact observation order

The R5 schemas and two fresh complete passes remain unchanged. Every directory uses the immediate
trace:

`lstat-before -> readdir -> lstat-after -> children`

Every admitted file uses:

`lstat -> open -> fstat-before -> descriptor-read -> fstat-after -> lstat-after -> close`

The descriptor closes in `finally`. Directory identity/type must agree before any child traversal;
file identity/type/length must agree at every boundary. Passes are independently copied, compared by
identity, normalized path, and bytes, and copied again for return. There is no sort-after-caller,
single-pass acceptance, retry, or cached-first-pass substitution. The Windows kernel-atomic
swap-and-restore nonclaim remains.

## 7. Fixture helper and owning spec

Add `Tools/patch-prototype/p0b/test-support/parser-provenance-fixtures-v1.mjs`. It imports only
`createRequire` from `node:module` and `join` from `node:path`. Its exact export allowlist and
function arities are:

1. `EXPECTED_PARSER_PACKAGES`;
2. `PARSER_RECORD_KEYS`;
3. `createResolutionFixture(api, rootContext)`, arity two;
4. `createFilesystemMechanicsFixture(variant)`, arity one; and
5. `createPassProjection(bytes, mode = 33188n)`, arity one.

There is no expected-trace export or fixture-local expected-trace constructor.
`PARSER_RECORD_KEYS` is exactly `Object.freeze(["name", "version", "entrypoint", "fileCount",
"totalBytes", "treeSha256", "manifestSha256", "entrypointSha256"])`.
`EXPECTED_PARSER_PACKAGES` is a frozen dense array of five newly reconstructed frozen primitive
records in exact order `eslint`, `espree`, `acorn`, `acorn-jsx`, `eslint-visitor-keys`. Every
record owns exactly those eight data properties in that enumeration order and retains no nested
mutable caller state; its exact values remain the R5 package oracle.
`createResolutionFixture` uses only its caller-supplied primitive-string `rootContext`, never
helper `import.meta.url`. It invokes `api.inspectParserProvenanceWithMechanics` exactly once and
returns a frozen exact-data object with own keys, in order:
`factory`, `measured`, `paths`, `resolved`, `result`, `rootContext`.

- `paths` is a frozen exact-data object whose primitive-string keys alternate each package and its
  `/package.json` specifier in the five-package order; values come directly from
  `createRequire(rootContext).resolve`.
- `factory` is a frozen dense five-entry array of frozen exact `{ id, parentContext }` records.
- `resolved` is a frozen dense ten-entry array of frozen exact
  `{ id, parentContext, specifier }` records.
- `measured` is a frozen dense five-entry array of frozen exact
  `{ name, entryPath, manifestPath }` records.
- `result` is the raw subject result. The fixture does not copy, normalize, freeze, or repair it;
  the owning spec adjudicates its exact values, order, keys, and immutability.

Every trace-record string remains primitive and every `id` a safe positive integer. The local
`resolverFactory(parentContext)`, returned `resolve(specifier)`, and
`measure(name, entryPath, manifestPath)` callables have arities one, one, and three. The returned
resolver is frozen with exactly one own data property, `resolve`. Expected factory, resolution, and
measurement sequences remain spec-owned and are never returned by this fixture.
`createFilesystemMechanicsFixture` accepts exactly the primitive variants `stable`,
`post-read-symlink`, `second-pass-content-drift`, and `second-pass-symlink`. It returns a frozen
exact-data object with own keys, in order:
`root`, `entryPath`, `manifestPath`, `mechanics`, `readTrace`.
`root` is `join(process.cwd(), "p0b-controlled-package")`; the other paths are its `entry.mjs` and
`package.json` children. `readTrace` is a frozen arity-zero function returning a new frozen dense
array of primitive actual-call tokens. It never returns or constructs an expected trace.
`mechanics` is frozen with exactly `lstat`, `readdir`, `open`, `fstat`, `read`, and `close`
own data keys in that order, each an arity-one function:

- `lstat` and `fstat` return new frozen exact records with `kind`, `dev`, `ino`, `mode`,
  `size`, `mtimeNs`, and `ctimeNs`; `kind` is `directory|file|symlink|special` and all other
  fields are primitive bigints.
- `readdir` returns a new frozen dense `["entry.mjs", "package.json"]` array for the root.
- `open` returns a new frozen opaque descriptor with exactly `path` and safe positive `serial`;
  descriptor consumers admit only that object identity.
- `read` returns a fresh Buffer; `close` returns exactly `undefined` and retires the descriptor.
`stable` gives two identical complete passes. `post-read-symlink` changes only the first-pass
`entry.mjs` post-read path observation after both descriptor observations, while `close` still
runs. `second-pass-content-drift` keeps all observations and length identical but changes the
second-pass entry bytes. `second-pass-symlink` changes only the second-pass entry pre-open
observation to `symlink`, so that descriptor is never opened.
`createPassProjection` accepts a Buffer and exactly mode `33188n` or `41471n`. It returns a new
frozen dense two-record array ordered root then `entry.mjs`. Both frozen records own exactly the R5
tree-record keys. The root is a `directory` with mode `16877n` and null content. Mode `33188n`
produces a `file` with a fresh defensive Buffer copy; `41471n` produces a `symlink` with null
content. All identity fields are primitive bigints.
The fixture helper contains no `node:fs`, crypto, test/assert library, sibling import, source read,
data URL, mutation harness, graph scan, source identity/cap, mutant ID/anchor/replacement, assertion,
test registration, verdict/control accounting, expected trace, fallback, install, network, or
product validator. It has exactly one consumer: `p0b-parser-provenance.spec.mjs`.
The owning spec imports exactly those five bindings and retains `PATHS`, frozen source hashes,
mutation registry, loading/linking, assertions, graph checks, gates, verdict accounting, and exactly
two top-level tests with no nested test, skip, todo, or cancellation. It alone owns literal expected
resolver and filesystem token vectors, including the exact directory prefix
`lstat -> readdir -> lstat -> children` and each file sequence
`lstat -> open -> fstat-before -> read -> fstat-after -> lstat-after -> close`. No expected vector is
imported from, calculated by, or shared with the mechanics fixture. The provisional
`PENDING-STABLE-TREE` and wrong scaffold trace are replaced, not accepted.

## 8. Four-image, three-subject linking and controls

The harness reads three mutable subject images—snapshot, façade, resolver—and one immutable fixture
image. It links `snapshot data URL -> façade data URL -> resolver data URL`; fixtures remain
byte-identical, spec-only, and unreachable from every subject. Exactly one anchor in one selected
subject changes; the other two subjects and fixture rehash unchanged. Missing/ambiguous linking,
import/setup failure, fixture or expected-record drift cannot kill a mutant. No temporary file or
cleanup delete is used. Spec-owned literal resolver/filesystem vectors sit outside all four images;
fixtures supply actual calls only and derive no expected trace.

R3M-01..03 remain resolver-only, R5M-01..02 façade-only, and R5M-03..04 snapshot-only.
**R6M-01_TOTAL_ERROR_WRAP** remains one snapshot-only mutant ID. One unique replacement exchanges the
entire R6-only error subsystem—class, factory, brand, captured error intrinsics, ensure/wrapper
functions, and constructor/prototype freezing—for the complete R5 class/ensure/wrapper block:
self-freezing native Error construction, direct `new ParserProvenanceError(message, details)`,
`instanceof` preservation, and unsafe
`typeof error?.message === "string" ? error.message : String(error)` extraction. Each row imports
identical mutant bytes under an independent deterministic data-URL identity:

| Discriminator | Successor outcome and exact hooks | Exact R5-mutant outcome |
| --- | --- | --- |
| `FIXED_STACK_SCHEMA` | ensure/wrapper errors have §5's six-key order, data-only fixed stack, exact details cardinality; `Reflect.set(stack)` false/unchanged | order `stack,message,name,code,status,details`; frozen native stack setter remains live; `Reflect.set` true/changed |
| `ACCESSOR_MECHANICS` | four-argument façade boundary returns new branded frozen fallback ERROR; `message` getter 0, `toString` 0 | getter 1; sentinel escapes |
| `TOSTRING_RESOLVE_PLAN` | direct byte-identical `resolveParserPackagePlan` returns new branded frozen fallback ERROR; `toString` 0 | `toString` 1; sentinel escapes |
| `DERIVED_CONSTRUCTOR` | direct leaked-constructor, subclass, base/caller-`newTarget` `Reflect.construct` instances are unbranded and reconstructed; identity differs and caller-prototype mutation is inert | each is preserved by `instanceof`; caller identity returns |
| `PROXY_DESCRIPTOR_TRAP` | frozen prototype/public-field lookalike Proxy is reconstructed; `getPrototypeOf` 0, descriptor trap 1 contained, `get`/`toString` 0; fallback ERROR | `getPrototypeOf` 1, descriptor trap 0; caller identity returns |
| `DESCRIPTOR_RESULT_GETTER` | plain-prototype Proxy descriptor trap 1 and returned descriptor's throwing `value` getter 1 are contained; direct `get`/`toString` 0; fallback ERROR | `getPrototypeOf` 1, descriptor/result hooks 0; direct `message` get 2; nonfallback detail returns |
| `REVOKED_PROXY` | brand lookup false; guarded descriptor operation's revoked-Proxy `TypeError` contained; fallback ERROR | `instanceof` throws revoked-`getPrototypeOf` `TypeError`, which escapes |
| `NONSTRING_OUTER_MESSAGE` | safe primitive detail retained; hostile boundary `Symbol.toPrimitive` 0; outer message fallback | direct `Error(message)` coercion calls `Symbol.toPrimitive` once with hint `"string"`; sentinel escapes |

An authentic branded error rewrapped with a hostile boundary-message Proxy preserves identity with
zero hooks; this positive sequencing/idempotence prerequisite satisfies no row. Every safe
reconstruction rewraps idempotently. A source tooth forbids private constructor, factory, brand, or
captured-error references outside the anchor; other failures use only
`ensureParserProvenance(false, fixedPrimitiveLiteral)` or the wrapper. Before kills count, both images
execute unsupported-entry setup: successor yields its exact branded six-descriptor ERROR, R5 its
intended ERROR, and neither `ReferenceError`. All eight rows bite independently in the two top-level
provenance tests; totals remain 73 tests/67 controls (`59 + 3 R3 + 4 R5 + 1 R6`).

## 9. Authorized artifacts and caps

This document is the only R6 design-authoring path and freezes after design GO. Implementation may
then add or edit exactly six paths: the snapshot helper, façade, fixture helper, provenance spec,
topology spec, and result. The resolver is an immutable prerequisite, not an editable path.
`module-graph-v0.mjs`, all seven production modules, the two other P0b specs
`p0b-protocol-persistence.spec.mjs` and `p0b-hostile-boundary.spec.mjs`, `package.json`, Gate D,
all P0a files, and the frozen R6 design remain exact.

| Artifact | Maximum physical lines |
| --- | ---: |
| snapshot helper | 340 |
| package façade | 210 |
| resolver helper | 110 |
| three provenance implementation helpers, aggregate | 620 |
| fixture helper | 320 |
| provenance spec | 520 |
| fixture helper plus provenance spec | 800 |
| topology spec | 1,600 |
| result document | 850 |
| this R6 preregistration | 400 |

Physical lines use R5's LF rule; blank lines count. Default Prettier must be stable. The tracked
source envelope remains exactly 17 files: seven production modules, four P0b specs, the five scored
test-support helpers `module-graph-v0.mjs`, `parser-package-tree-snapshot-v1.mjs`,
`parser-package-tree-v1.mjs`, `parser-provenance-v1.mjs`, and
`parser-provenance-fixtures-v1.mjs`, plus `package.json`. The fixed mutation harness remains an
immutable prerequisite outside that historically scored envelope. Syntax and ESLint cover exactly
24 JavaScript files. The provenance spec contributes exactly two tests, preserving serial P0b
73/73; fixture-side test registration is forbidden. Topology assertions are replaced or
data-compacted without weakening to remain within 1,600; unreadable formatter suppression is barred.

## 10. R6 acceptance

1. **R6A-01:** R5, the current result, the available failed R5 source/scaffold tuple, policy files,
   and all frozen prerequisites rehash exactly before implementation. Unavailable historical design
   identities are chronology-cross-checked in R5/result/reviewer records, not falsely claimed as
   recoverable byte images.
2. **R6A-02:** resolver bytes remain exact; every §3, §4, and §7 import/export allowlist, binding
   kind, arity, exact own-key order, primitive type, record/container freeze, defensive Buffer copy,
   opaque-descriptor rule, fixture variant, exclusive-consumer edge, public tail, and forbidden
   dependency passes. `PARSER_RECORD_KEYS` equals the exact eight-key vector in §7;
   `expectedFilesystemTrace` and every equivalent fixture-side expected-trace constructor are
   absent. The spec's independent literal traces prove immediate directory order. All caps,
   aggregates, exact 17/24 source arithmetic, four-image linking, 73 tests, and 67 controls pass.
3. **R6A-03:** P0B-F06 closes only when the private factory is the sole brand mint; every ensure and
   wrapper error has §5's six exact data descriptors, fixed stack, and details cardinality;
   leaked-constructor/subclass/`Reflect.construct` instances remain unbranded; authentic rewrap is
   identity-idempotent; the §8 source/setup teeth pass; and all eight discriminators independently
   reject the whole R5 mutant with registered identities, payloads, fallback, and hook outcomes. The
   authentic-brand positive leg is not a discriminator. Totals remain 73/73 and 67/67.
4. **R6A-04:** P0B-F04/F05 exact schemas, defensive copies, immediate directory order, descriptor
   order, two fresh passes, and all independent drift/type/symlink controls pass; each successor
   type/symlink failure proves the six descriptors, freeze, brand, and identity-preserving rewrap.
5. **R6A-05:** exact Node/package records and v1 digests, counts, entrypoints, resolution chain,
   five-factory/ten-resolver/five-measurement trace, graph, complete parsing, and forbidden forms pass.
6. **R6A-06:** all 67 controls bite with unchanged expected records outside their registered oracle.
7. **R6A-07:** PRE/FORWARD are 151/151; protocol 15/15, hostile 20/20, topology 36/36, provenance
   2/2, and serial P0b 73/73 have no skip, todo, cancellation, or mixed authority.
8. **R6A-08:** the 17-file envelope, 24/24 syntax and ESLint, Prettier, caps, graph direction, export
   surfaces, no root-lock read, and tracked-reference checks pass.
9. **R6A-09:** an independent digest implementation reproduces all five records without importing
   snapshot, façade, resolver, fixtures, or the owning spec.
10. **R6A-10:** a clean landing clone with no root lock reproduces Gate D, 73 tests, 67 controls,
    24 syntax/ESLint checks, exact hashes/caps, tracked references, package identities, traces, and
    §5's exact ensure/wrapper descriptors, all eight total-wrap discriminators, and the
    authentic-brand positive prerequisite. The shared dependency junction is rehashed immediately
    before and after that run.
11. **R6A-11:** two fresh non-author terminal reviewers rehash one stable successor. The
    protocol/regression reviewer and hostile/topology/provenance reviewer rerun their assigned gates,
    explicitly close P0B-F02 through P0B-F06, and return unconditional GO with zero finding.

Any new red governs. PASS requires every row; FAIL, ERROR, STRUCTURAL, missing evidence, hash drift,
conditional approval, or absent reviewer is NO-GO.

## 11. Review boundary and nonclaims

After the prerequisite design GO, implementation may touch only the six exact paths named in §9.
Validation precedes a new exact tuple; authors then freeze and stop. Reviewers are read-only and may
not edit, run Git writes, build, browse, publish, or change external state. A finding reopens
authorship and requires complete affected validation and a fresh tuple. Only both terminal GOs may
permit the separately authorized orchestrator to create a local checkpoint; workers never run Git
writes.

R6 adds no production behavior and proves no socket, HTTP, persistence, durability, deletion, GC,
transport, signature, trusted time, freshness, revocation, restart, external closure, renderer
transaction, mask, cache/retirement, collision, accounting, Cesium, WebGL, WebGPU, pixel,
performance, standards, or production-readiness claim. All R5 nonclaims and all historical
FAIL/ERROR/STRUCTURAL records remain.
