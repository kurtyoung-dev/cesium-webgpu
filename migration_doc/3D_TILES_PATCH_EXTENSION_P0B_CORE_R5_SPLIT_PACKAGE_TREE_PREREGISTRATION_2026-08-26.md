# 3D Tiles patch extension P0b-core R5 split package-tree preregistration

**Date:** 2026-08-26  
**Status:** amended after design-review NO-GO; frozen pending fresh independent rereview  
**Scope:** non-weakening placement, exact-schema, and stable-measurement repair for P0B-F03,
P0B-F04, and P0B-F05  
**Lane:** local-only, browser-free, GPU-free, network-free, no deletion, and no external publication;
the authorized local Git checkpoint remains gated on complete successor certification

## 1. Authority and decision

R5 supplements, and only where expressly stated replaces, the frozen R3 and R4 preregistrations:

| Authority | Bytes | Physical lines | SHA-256 |
| --- | ---: | ---: | --- |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_R3_TRACKED_PARSER_PROVENANCE_PREREGISTRATION_2026-08-26.md` | 18,989 | 294 | `9cdebb6b34afe794efbe95904434b3005bbb75140a4bb4b287fe08ecc3484d19` |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_R4_SEPARATED_PARSER_PROVENANCE_PREREGISTRATION_2026-08-26.md` | 9,936 | 149 | `f4e75c2fee24c116e2d3f4cf33f2e70ed1412908315aa4b9a72c47588dd827a0` |
| pre-amended-R5 `3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | 39,318 | 546 | `0d3258aaeeeb3e4ca65f1a52bddd10175f58911ff0660563af2f54b818ff3440` |

All base, R1, R2, R3, and R4 clauses remain binding unless this document expressly replaces their
placement, caps, source-count arithmetic, or R4's defective record and filesystem mechanics. The R3
package set, digest framing, resolution chain, controlled traces, exact runtime records, public
non-injection boundary, functional gates, and nonclaims do not change.

This successor selects a two-helper split. A cap-only raise is rejected because later source audit found
correctness defects independent of line count. A third contract helper is rejected because it would
expand the import and review graph without a distinct third responsibility. No implementation may
resume until an independent reviewer freezes this document by exact identity and returns PASS / GO.

## 2. Immutable R4 red and new audit findings

The formatter-stable R4 implementation remains immutable FAIL / NO-GO chronology:

| Artifact | Bytes | Physical lines | SHA-256 | Disposition |
| --- | ---: | ---: | --- | --- |
| `test-support/parser-provenance-v1.mjs` | 10,092 | 315 | `f2fd7c89828f0f8fd7cd729fe42e25607623c757c3e11b4a2868c50f73e4f1d3` | FAIL: R4 cap 220 |
| `test-support/module-graph-v0.mjs` | 8,456 | 292 | `2c21b6727f76746419c0f44e7496f17ce51dd135205449351c6cd3b54ef60fbc` | exact R2 restoration |
| `p0b-topology-mutants.spec.mjs` | 64,073 | 1,593 | `7293fa6ecd9e7771d3806cb325fde031d842f9bfc0ed0ab8d7fd7e0e9f4c78b8` | within cap |

Syntax passed and Prettier was stable for the failed helper. ESLint and the new provenance spec were
not run after the hard cap turned red. R4A-03 therefore remains FAIL; no prior gate is rescored.

Source audit adds two independent defects that a cap raise alone cannot repair:

1. **P0B-F04 (HIGH):** `freezeRecord` applies `RegExp.test` without first requiring primitive
   strings. A coercible object can therefore execute `toString`, satisfy the hash regex, and survive
   the shallow spread/freeze as nested mutable state. This violates R3's exact deeply frozen record
   contract.
2. **P0B-F05 (MEDIUM):** one `lstat` followed by a path-based read and a size comparison does not
   detect a same-length rewrite, nor a path-type or symlink swap across the check/read boundary. R3
   requires drift to reject; a disclaimer that the package tree must be quiescent would weaken that
   requirement.

Both findings govern the successor. They are not STRUCTURAL excuses for the R4 red and cannot be
waived by matching the currently frozen package hashes.

The first frozen R5 candidate was 13,795 bytes / 219 lines at
`eb47d02f71b0921e1ce803ec36e8bef0522aa1e4c215857c964b5a259057ad27`. Its reviewer rehashed every
available premise and returned HIGH / FAIL / NO-GO with R5-D01: the injected two-pass comparator
could reject prepared projections while the real descriptor/path reader remained inert or retained
the old pathname read. A separate Node v22.23.2 Windows feasibility audit confirmed the gap and the
absence of `O_NOFOLLOW`, `O_DIRECTORY`, and `O_SYMLINK` support on this platform. This amendment adds
a controlled low-level boundary consumed by the same real pass, defensive snapshots, independent
mutation cases, and an explicit atomicity nonclaim. The failed R5 identity remains immutable and
authorizes no implementation.

The first amended R5 candidate was 16,604 bytes / 251 lines at
`859499dfae4919adc9955769e300669f90c0904d2c492613137666bdaa0a06bc`. Fresh rereview reproduced every
available premise but returned HIGH / FAIL / NO-GO because R5-D01 remained partially open: the
descriptor mechanics and abstract comparator were proved separately, while a cached first traversal
could be supplied twice. The seam also called its mechanics and projections exact without freezing
their names, signatures, or schemas. This amendment preserves that second failed identity, enumerates
the complete boundary, and makes the full mechanics measurer itself prove two fresh traversals.

## 3. Replacement placement and contracts

### 3.1 Resolution-free package-tree helper

Add `Tools/patch-prototype/p0b/test-support/parser-package-tree-v1.mjs`. It owns only:

- immutable parser-provenance ERROR construction and wrapping;
- exact record-schema validation and primitive-only reconstruction;
- U32BE/U64BE framing, SHA-256, containment, and UTF-8 bytewise ordering;
- descriptor-based regular-file reads, entry identity, two-pass stability comparison, nested
  `node_modules` exclusion, and symlink/special/escaping-path rejection; and
- manifest, entrypoint, whole-tree, file-count, byte-count, version, and entry records.

Its exact export allowlist is:

1. `ensureParserProvenance`;
2. `freezeParserPackageRecord`;
3. `inspectStablePackageTreeWithMechanics`;
4. `measureResolvedPackageFilesWithMechanics`;
5. `measureResolvedPackageFiles`; and
6. `wrapParserProvenanceFailure`.

It imports only Node crypto, filesystem, and path mechanics. It contains no `createRequire`, resolver
plan/factory, expected package/version/hash oracle, mutant result, install, network behavior, graph
policy, or production validator.

### 3.2 Resolver/provenance helper

`Tools/patch-prototype/p0b/test-support/parser-provenance-v1.mjs` owns only `createRequire`, the
parent-relative plan, resolver construction/consumption, and the public wrapper. It imports the exact
four sibling bindings `ensureParserProvenance`, `freezeParserPackageRecord`,
`measureResolvedPackageFiles`, and `wrapParserProvenanceFailure`; both injectable mechanics exports
are test-only and are not imported here.

Its exact export allowlist remains the R3 functions and arities:

1. `resolveParserPackagePlan(resolvePackage, rootContext)`, arity two;
2. `inspectParserProvenanceWithMechanics(rootContext, resolverFactory,
   measureResolvedPackageFiles)`, arity three; and
3. `inspectParserProvenance(rootContext = import.meta.url)`, arity zero.

The exact unique public tail remains delegation to
`inspectParserProvenanceWithMechanics(rootContext, createRequire, measureResolvedPackageFiles)`.
This helper contains no filesystem traversal, path containment, crypto, digest framing, expected
record, fallback, or policy oracle.

### 3.3 Exact-schema reconstruction

`freezeParserPackageRecord` accepts exactly these own data fields and no others: `name`, `version`,
`entrypoint`, `fileCount`, `totalBytes`, `treeSha256`, `manifestSha256`, and
`entrypointSha256`. Accessors and unexpected keys reject. Names, versions, paths, and all hashes must
be primitive strings before regex or path checks; counts must be safe primitive integers. Hashes are
lowercase 64-hex strings. The return value is a newly reconstructed frozen object containing only
those primitive values, never a shallow spread of caller state.

Rejection must not invoke a coercion hook on a non-string hash. Valid returned records have the exact
key set, contain no nested references, and are deeply immutable by construction.

### 3.4 Stable two-pass measurement

Each real tree pass records every visited directory and admitted file by normalized relative path,
kind, and a stable identity tuple from bigint stat data, including device, inode, mode/type, size,
`mtimeNs`, and `ctimeNs`. Each directory is path-`lstat`ed immediately before and after its
enumeration; its identity and directory type must agree at both boundaries. A regular file is
path-`lstat`ed immediately before open, opened once per pass, read through that descriptor, and
checked by descriptor `fstat` before and after the read plus path `lstat` immediately after the read.
Identity, type, and length must agree at every boundary; the descriptor closes in `finally`.
Any observed symlink or special node rejects, and bytes from a mismatched observation are discarded.

`measureResolvedPackageFilesWithMechanics(name, entryPath, manifestPath, filesystemMechanics)` has
arity four and owns that same real pass. `filesystemMechanics` has exactly six own data properties,
each an arity-one function: `lstat`, `readdir`, `open`, `fstat`, `read`, and `close`. Missing, extra,
symbol, accessor, or nonfunction properties reject without invoking getters. The helper reconstructs
a frozen mechanics object before use. Their exact calls are:

1. `lstat(absolutePath) -> StatObservation`;
2. `readdir(absoluteDirectoryPath) -> string[]` of primitive component names;
3. `open(absoluteFilePath) -> opaqueDescriptor`;
4. `fstat(opaqueDescriptor) -> StatObservation`;
5. `read(opaqueDescriptor) -> Buffer`; and
6. `close(opaqueDescriptor) -> undefined`.

`StatObservation` has exactly the own data keys `kind`, `dev`, `ino`, `mode`, `size`, `mtimeNs`, and
`ctimeNs`. `kind` is one of `directory`, `file`, `symlink`, or `special`; all six identity values are
primitive bigints. Fixed real wrappers reconstruct this record from Node bigint stats. All returned
records and arrays are validated through own-property descriptors before value reads; arrays must be
dense, accessor-free, and free of symbol, hole, or extra-key state.

The non-injectable `measureResolvedPackageFiles(name, entryPath, manifestPath)` has arity three and an
exact unique tail delegating to the mechanics form with the module's fixed real filesystem mechanics.
No alternate pathname reader or fallback exists.

`inspectStablePackageTreeWithMechanics(packageRoot, readPass)` invokes the supplied pass exactly
twice. `readPass` is an arity-one function called as `readPass(packageRoot)`. Each call returns a
UTF-8-bytewise relative-path-ordered array of exact own data records with keys `relativePath`, `kind`,
`dev`, `ino`, `mode`, `size`, `mtimeNs`, `ctimeNs`, and `content`. Root uses relative path `.`; paths
are primitive normalized strings; identity fields have the types above; `content` is a Buffer for a
file and `null` otherwise. Accessors, symbols, extras, duplicate/out-of-order paths, or invalid kinds
reject.

Before the second call the inspector copies the first pass's primitives and Buffers; it independently
copies the second pass, compares exact projections and bytes, and returns a third fresh copy. It never
sorts, retries, falls back, accepts one pass, or trusts caller-owned buffers after return. The
mechanics measurer contains one unique direct edge equivalent to
`inspectStablePackageTreeWithMechanics(packageRoot, (freshRoot) =>
readPackageTreePassWithMechanics(freshRoot, mechanicsSnapshot))`: no projection or Buffer is computed
outside that callback. Same-length content drift, add/remove/rename, identity drift, and
file/directory/symlink/type swaps observed at the registered boundaries reject with immutable ERROR.
The public measurer supplies only the fixed real mechanics.

This is detection, not a kernel-atomic namespace snapshot: on Node v22.23.2/Windows it does not claim
no-follow protection against an adversary that swaps and restores a path entirely between observation
boundaries. No such atomicity, malicious concurrent-filesystem, or post-return immutability claim is
part of P0b-core.

## 4. Mutation and fixture integrity

`p0b-parser-provenance.spec.mjs` retains exactly two top-level tests, P0B-21 and P0B-22. Its mutant
harness links both helper source images in memory with unique data URLs: it first creates the selected
package-tree image, then replaces exactly one sibling import specifier in the resolver image with that
URL. Before import it proves exactly one registered mutant anchor changed and rehashes the unchanged
sibling to its frozen source identity. It performs no temporary filesystem write or cleanup delete.
Missing or ambiguous imports, syntax/setup throws, source-hash drift, or records changed outside the
registered oracle cannot kill a mutant.

R3M-01 through R3M-03 remain unchanged and mutate only the resolver helper while the package-tree
copy remains byte-identical. R5 adds:

- **R5M-01_TREE_CONTENT_INERT:** omit the unique raw-content digest update while retaining framed
  lengths. Through an unchanged resolver helper, all non-tree record fields remain exact, all five
  tree digests change, and the expected record rejects. This proves the split helper is consumed.
- **R5M-02_COERCIBLE_SHALLOW_RECORD:** replace the exact primitive/schema reconstruction with the
  R4 regex-coercion plus shallow-spread form. Two independent fixtures are required: an otherwise
  exact record with one coercible hash must reject with exactly zero coercion calls, and a
  primitive-valid record with one unexpected nested field must reject without retaining it. The R4
  mutant must accept or invoke/carry state in each case independently.
- **R5M-03_REAL_FILE_MECHANICS_INERT:** bypass the unique post-read path identity/type assertion in
  the mechanics form while retaining all calls. Deterministic low-level mechanics require the exact
  pre-`lstat` → open → pre-`fstat` → descriptor-read → post-`fstat` → post-`lstat` → close trace and
  independently model a stable twin and a post-read regular-to-symlink/type change. The successor
  accepts the twin and rejects the change; the mutant accepts both and is killed only by that oracle.
- **R5M-04_SINGLE_PASS_STABILITY:** remove or bypass the unique second-pass/comparison call. Two
  independent controlled passes provide (a) identical identity/type/length with different bytes and
  (b) unchanged bytes/length with regular-to-symlink/type identity drift. The registered mutant
  replaces only the unique second read-pass invocation with a copy of the first snapshot. It is run
  through `measureResolvedPackageFilesWithMechanics`: the successor performs two complete fresh
  low-level traversals, while the mutant performs one and returns the same stable package record.
  Standalone, the successor calls twice and rejects each drift case while the mutant calls once and
  accepts. Both the integrated trace and independent drift oracles are required to kill this one ID.

## 5. Authorized artifacts and caps

Only the two helpers, topology spec, new provenance spec, result, and this preregistration may change
or be added. `module-graph-v0.mjs` remains exact R2 bytes. All other R4 source/prerequisite identities
remain unchanged.

| Artifact | Maximum physical lines |
| --- | ---: |
| `parser-package-tree-v1.mjs` | 320 |
| `parser-provenance-v1.mjs` | 110 |
| both provenance helpers, aggregate | 420 |
| `p0b-topology-mutants.spec.mjs` | 1,600 |
| `p0b-parser-provenance.spec.mjs` | 440 |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | 700 |
| this preregistration | 320 |

The R5 document cap rises from the initially proposed 240 to 320 only to preserve both failed design
reviews and preregister the exact load-bearing seam and its non-vacuous controls before implementation.
Physical lines are LF count plus one only when a nonempty file lacks a final LF; blank lines count.

## 6. R5 acceptance

1. **R5A-01:** R3, R4, the failed R4 tuple, pre-amended-R5 result, policy files, and all frozen
   prerequisites rehash exactly before implementation; earlier result/design identities are
   chronology-cross-checked rather than falsely claimed as recoverable historical bytes.
2. **R5A-02:** the graph helper remains exact R2; topology remains 36/36, at most 1,600 lines, and no
   P0b source reads root `package-lock.json`.
3. **R5A-03:** both helper caps, the 420 aggregate cap, exact exports/imports, forbidden-dependency
   separation, public tail, arities, and no-oracle rules pass.
4. **R5A-04:** P0B-F04 closes: strict primitive exact-schema reconstruction rejects coercible hashes,
   accessors, unexpected keys, and nested mutable state without invoking coercion hooks.
5. **R5A-05:** P0B-F05 and R5-D01 close: the exact controlled low-level seam is consumed by the same
   fixed real pass; the integrated stable case proves two fresh complete traversals, and
   descriptor/path identity plus defensively copied passes independently reject the registered
   same-length rewrite and path-type/symlink swap cases without retry, cache, or fallback.
6. **R5A-06:** exact Node/package records, digest-v1 framing, parent/factory/resolver/path traces,
   complete parsing, graph, forbidden forms, measured counts, and doubled-parser negative pass.
7. **R5A-07:** all 59 prior controls, R3M-01 through R3M-03, and R5M-01 through R5M-04 bite: 66/66.
8. **R5A-08:** PRE/FORWARD are 151/151; protocol 15/15, hostile 20/20, topology 36/36, provenance
   2/2, and serial P0b 73/73 have no skip, cancellation, or todo.
9. **R5A-09:** the exact 15-file tracked source envelope is seven production modules, four specs,
   three test-support helpers, and `package.json`; syntax and ESLint are 22/22 and Prettier is green.
10. **R5A-10:** an independent digest implementation reproduces all five package records without
    importing either provenance helper.
11. **R5A-11:** the clean landing clone has no root lock and reproduces Gate D, 73/73, 66 controls,
    exact hashes/caps, tracked references, package identities, and stable two-pass controls.
12. **R5A-12:** two fresh non-author terminal reviewers rehash one stable successor, rerun their
    assigned gates, explicitly close P0B-F02 through P0B-F05, and return unconditional GO with zero
    findings.

Any new red governs. PASS requires every row; FAIL, ERROR, STRUCTURAL, missing evidence, hash drift,
or a conditional review is NO-GO.

## 7. Review, Git boundary, and nonclaims

An independent design reviewer must first rederive this candidate's premises, caps, arithmetic,
schema, TOCTOU controls, and mutation discriminators and return PASS / GO on this exact frozen
identity. Until then this document authorizes no implementation. After implementation,
protocol/regression and
hostile/topology/provenance reviewers must be fresh and non-author. Workers never run Git writes.
Only after all gates and reviews pass may the orchestrator create an authorized local checkpoint.

R5 adds no production behavior and proves no socket, HTTP, persistence, durability, deletion, GC,
transport, signature, freshness, revocation, restart, external closure, renderer transaction, mask,
cache/retirement, collision, accounting, Cesium, WebGL, WebGPU, pixel, performance, standards, or
production-readiness claim. All R4 nonclaims and historical FAIL/ERROR/STRUCTURAL records remain.
