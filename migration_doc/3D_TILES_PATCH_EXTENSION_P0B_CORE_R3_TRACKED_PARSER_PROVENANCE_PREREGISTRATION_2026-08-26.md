# 3D Tiles patch extension P0b-core R3 tracked parser-provenance preregistration

**Date:** 2026-08-26  
**Status:** amended after three design-review NO-GOs; frozen pending fresh design rereview  
**Scope:** non-weakening repair of P0B-F02 clean-clone parser-provenance failure  
**Lane:** local-only, browser-free, GPU-free, network-free, no deletion, no external publication;
local Git is permitted only after all successor gates and reviews pass

## 1. Authority and decision

R3 supplements, and only where expressly stated replaces, the frozen P0b-core R2 preregistration:

| Authority | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_R2_ACYCLIC_AUTHORITY_PREREGISTRATION_2026-08-26.md` | 23,930 | 364 | `a4d4bc0f331a738ce8bb4f9b05a286422cafa612d0835281377eec277558dcfc` |
| pre-R3 `3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | 31,343 | 443 | `78f11f376043bc0d131617c8bdcba2b0f58bd28ec942fbf765fc8bdfb682eaad` |

All base, R1, and R2 clauses remain binding except R2 §§5, 7, 8, and 9 where they require, count,
or describe the ignored root `package-lock.json`. R3 replaces only that parser-provenance mechanism
and the corresponding terminal evidence count. It does not alter production behavior, topology,
exports, authority ownership, functional acceptance, mutation requirements, nonclaims, or any
frozen Gate D/P0a prerequisite.

The R2 successor received two terminal GO reviews in the source worktree. A later clean landing-clone
run produced a new measured red. P0B-F02 therefore governs and the pre-R3 successor is STRUCTURAL /
NO-GO for landing. Neither earlier GO counts as terminal review of the R3 successor.

The first R3 design candidate was 12,761 bytes / 211 lines at
`4cfb154b31bd1f334f361129988b3858e529565aace0e8c2d04ff2c1a4cf6782`. Its independent reviewer
reproduced every runtime hash but returned HIGH / FAIL / NO-GO: the flattened installation made
root-relative and prescribed parent-relative resolution produce identical entrypoints, so hashes did
not prove the claimed parent calls. R3-D01 remains immutable chronology. Sections 4.2–4.3 and 5–7
below add a controlled resolution trace and biting root-only inertness mutant before fresh rereview.

The first amendment was 15,264 bytes / 243 lines at
`ce2be391200b991dea3acd3f4723f02948ce7695eaf17c06ecdc2de920bbf849`. A fresh reviewer returned HIGH
/ FAIL / NO-GO with R3-D02: its injected plan callback proved the plan's parent tokens, but the
different internal filesystem callback could still ignore its received parent and resolve from root.
Because the flat installation again returned identical records, R3M-01 could remain green. The
current amendment factors that actual resolver-factory boundary into the controlled mechanics and
adds R3M-02; both failed designs remain immutable and authorize no implementation.

The second amendment was 17,138 bytes / 273 lines at
`cce6d417260500c67e806664699a372ec17a147c8f79f2070883d4f6dd53a506`. Its fresh reviewer returned
HIGH / FAIL / NO-GO with R3-D03: a candidate could construct the correct parent-bound resolver, discard
it, and give a root-bound resolver to a controlled measurer that deliberately ignored resolver
identity. The current amendment makes the mechanics consume the factory-returned resolver directly,
passes only resolved paths to measurement, adds R3M-03, and freezes the public delegation tail. All
three failed designs remain immutable chronology.

## 2. Immutable pre-R3 tuple and P0B-F02

The 11 implementation files from the R2 terminal tuple remain frozen. The two files relevant to R3
are:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | 64,494 | 1,597 | `b8d426af09f8f754a8d15cf313eeda5a82ec539eb5f7a2689b29935c40ba9ac4` |
| `Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` | 8,456 | 292 | `2c21b6727f76746419c0f44e7496f17ce51dd135205449351c6cd3b54ef60fbc` |

The pre-R3 terminal parser envelope additionally named `package.json` and an ignored local
`package-lock.json`, yielding the previously reviewed 13 identities. Their exact hashes remain
immutable chronology; R3 does not rewrite that review record.

The clean landing clone was created from base
`aa9409432dae07ce65341304a6b2b2b226d62309` on local branch
`sol/p0b-r2-patch-extension-baa9409432-2026-08-26`. Thirty-four intended files were copied and
staged with zero source-hash mismatch, while a local `node_modules` junction supplied the existing
offline dependency installation. Gate D remained exact and green. The serial combined P0b run was
70/71: P0B-19 threw `ENOENT` while reading root `package-lock.json`.

P0B-F02 is a real provenance and reproducibility defect rather than a missing staging action:

1. `.gitignore:43` expressly ignores `package-lock.json`;
2. `.npmrc` sets `package-lock=false`;
3. Git history and `HEAD` contain no tracked root lockfile;
4. the ignored local lock identifies Cesium `1.143.0` and ESLint `10.5.0`, while tracked
   `package.json` identifies Cesium `1.144.0` and the executed runtime is ESLint `10.8.1`;
5. a clean tracked checkout therefore cannot satisfy the P0B-19 file read; and
6. the ignored stale lock did not prove the identity of the parser code actually loaded by the
   helper.

The relevant tracked policy identities are frozen prerequisites:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `.gitignore` | 2,789 | 98 | `ede92651c5be49c6b4063a4bb47c99ccff1977b94dde01dd1ec0c81a70d9a1cf` |
| `.npmrc` | 20 | 1 | `8ca46f4a9b6f2c70f6f24cb886a542c36bcb6972aa770aae035bd8df5407d3c9` |
| `package.json` | 8,331 | 212 | `dff0b712bc1a35a4718f5d4c0874d5388971d2f2d9fc9b9ce44738dd9a830ec2` |

## 3. Rejected repairs

R3 rejects force-adding or copying the stale ignored lock, generating or downloading a replacement,
skipping P0B-19, treating the red as clone-only infrastructure, relaxing exact identities to semver
ranges, replacing the complete parser with a scanner or new package, and carrying the earlier reviews
over changed bytes. A repository-wide lockfile-policy change requires its own lane and is outside R3.

## 4. Replacement parser-provenance contract

### 4.1 Tracked source and policy envelope

The successor source envelope contains the same seven production modules, three existing P0b specs,
new `p0b-parser-provenance.spec.mjs`, `test-support/module-graph-v0.mjs`, and tracked root
`package.json`: 13 exact files. Only the topology spec, mechanics helper, and new provenance spec may
change or be added. The clean landing clone must obtain all source identities from the staged/committed
tree; no root lockfile, generated manifest, downloaded package, or copied ignored file may be used.
Reviewers separately rehash unchanged `.gitignore` and `.npmrc`.

### 4.2 Resolution boundary

The mechanics helper gains three exact functions:

- `resolveParserPackagePlan(resolvePackage, rootContext)` with arity two;
- `inspectParserProvenanceWithMechanics(rootContext, resolverFactory, measureResolvedPackageFiles)` with
  arity three; and
- `inspectParserProvenance(rootContext = import.meta.url)` with arity zero.

The plan invokes its callback exactly five times and uses each returned private `entryPath` as the
next parent: helper/root context → `eslint`; ESLint entry context → `espree`; and Espree entry context
→ `acorn`, `acorn-jsx`, and `eslint-visitor-keys`. The callback returns `{ entryPath, record }`; the
plan returns only a frozen ordered record array.

`inspectParserProvenanceWithMechanics` supplies the plan callback. For every call it must invoke
`resolverFactory(parentContext)` exactly once, invoke `.resolve(name)` and
`.resolve(`${name}/package.json`)` on that exact returned resolver, and pass only the package name plus
those two resolved paths to `measureResolvedPackageFiles` exactly once. The internal filesystem
measurer accepts `(name, entryPath, manifestPath)` and may only validate/read/hash those paths; it has
no resolver, resolver factory, parent context, package plan, or path-resolution authority.

The public inspector's exact unique tail is structurally frozen as delegation to
`inspectParserProvenanceWithMechanics(rootContext, createRequire, measureResolvedPackageFiles)`. Callers
of the public inspector can select only the root context; they cannot inject a factory, resolver,
measurer, package plan, expected record, or fallback. The provenance spec asserts that exact tail and
the helper's final source hash.

For each package, the inspector returns one deeply frozen record containing package name, exact
version, package-relative resolved entrypoint, regular-file count, total regular-file bytes,
whole-package tree SHA-256, manifest SHA-256, and entrypoint SHA-256. It returns Node version beside
the ordered five-record array. Expected values and policy remain in the topology spec; the helper
remains mechanics-only.

Resolution failure, an entry outside its package root, missing metadata, malformed JSON, unsupported
filesystem entry, byte/hash drift, version drift, or import/parse failure is STRUCTURAL or ERROR.
There is no fallback parser, install, range acceptance, scanner, or partial PASS.

### 4.3 Discriminating parent-resolution control

The new provenance spec supplies a controlled resolver whose returned entries and records are
identical for a package name regardless of parent while an independent call log records the received
parent token. The required trace is exactly:

1. `eslint` from the supplied root token;
2. `espree` from the returned ESLint entry token; and
3. `acorn`, `acorn-jsx`, and `eslint-visitor-keys` from the returned Espree entry token.

The controlled mechanics use a resolver factory that returns a distinct frozen resolver object for
each factory call. Its `.resolve()` method records resolver identity, parent token, and specifier, then
returns fixed entry/manifest path tokens by package name regardless of parent. The controlled
filesystem measurer records exactly those path tokens and emits fixed `{ entryPath, record }` values.
Returned records are deliberately identical under correct and wrong-parent behavior, while factory,
resolver-consumption, and measurer-path logs remain independently discriminating.

- **R3M-01_ROOT_ONLY_PARSER_PLAN** replaces the complete parent-relative plan block in copied helper
  source with root-relative calls. The factory log becomes root-only and must reject while records
  remain identical.
- **R3M-02_ROOT_ONLY_RESOLVER_FACTORY** leaves the plan correct but replaces the unique
  `resolverFactory(parentContext)` construction inside the actual mechanics callback with
  `resolverFactory(rootContext)`. The same controlled factory must record a root-only construction
  trace and reject while records remain identical.
- **R3M-03_DISCARD_PARENT_RESOLVER** preserves correct plan and factory traces but replaces the unique
  pair of `.resolve()` calls on the factory-returned resolver with calls on
  `createRequire(rootContext)`. Factory traces and records remain identical, but the controlled
  resolver-consumption log is empty/wrong and resolved-path provenance must reject.

Each mutation imports its changed helper, reaches `inspectParserProvenanceWithMechanics`, has one
unique exact source anchor, transforms once, and is killed only by its incorrect parent/factory trace.
Text difference, hash drift, thrown setup, or changed records is not a sufficient oracle. The exact
public delegation tail separately proves the non-injectable wrapper reaches these mechanics. Together
the controls close R3-D01 through R3-D03 without a filesystem fixture or public production injection
surface.

### 4.4 Collision-safe package-tree digest v1

Package root is the directory containing the manifest resolved through the parent boundary. The
inspector recursively enumerates regular files without following symlinks and skips directories named
exactly `node_modules`; every load-bearing dependency is resolved and measured separately.

It rejects symlinks, special entries, empty paths, absolute or root-escaping paths, and paths
containing NUL. Relative separators become `/`; UTF-8 path bytes sort with bytewise `Buffer.compare`.

The SHA-256 input is exactly:

```text
ASCII("P0B-PARSER-PACKAGE-TREE-V1")
U32BE(packageNameUtf8.length)
packageNameUtf8
U32BE(fileCount)

for each sorted file:
  0x01
  U32BE(relativePathUtf8.length)
  relativePathUtf8
  U64BE(content.length)
  raw content bytes

0xFF
```

`U32BE` and `U64BE` are unsigned big-endian integers. Manifest and entrypoint hashes are ordinary
SHA-256 over exact raw bytes.

### 4.5 Frozen initial runtime envelope

| Package | Version | Entrypoint | Files | Bytes | Tree SHA-256 v1 |
| --- | --- | --- | ---: | ---: | --- |
| `eslint` | `10.8.1` | `lib/api.js` | 420 | 2,922,901 | `263283cb4327a4c27ed8666c54c2a263b80a184ab67ac378b8777118c49cf95e` |
| `espree` | `11.2.0` | `dist/espree.cjs` | 13 | 95,658 | `f5582f7f707d809131a93a0fd9f66a2550ffe473832218712f9b050f9cbf01c1` |
| `acorn` | `8.18.0` | `dist/acorn.js` | 10 | 565,327 | `a49216c73bac2fdbdcceb7dfb80290760b14e261b3556ba112faa50b3fde62e1` |
| `acorn-jsx` | `5.3.2` | `index.js` | 6 | 24,385 | `25b3635d532061643606977772a286eb2088ce951a5f39c684c53712e34007e1` |
| `eslint-visitor-keys` | `5.0.1` | `dist/eslint-visitor-keys.cjs` | 9 | 31,942 | `760a5a890f06683cd00948bc9d38f52f8797ed3ab28500330f3a908ba9926818` |

| Package | Manifest SHA-256 | Entrypoint SHA-256 |
| --- | --- | --- |
| `eslint` | `cbf0be968a215b6e5c00c8cd1207bc65d6fc26dee0cfbbb15fee95f845a80d5e` | `d970a38ce77982fe2c68c6eef1f5f852925f63f9276c14d43033bc18c1f842a2` |
| `espree` | `23ed9eb09d6076011884a14deb09ad608968eaa01f69344b91207c810a1bebd2` | `00ad93bce4a8af52aeaab7b8198c1ed072c9cf1b5cbb2d44e3d2fdc00562c059` |
| `acorn` | `5c1ed7259579a7899b303f514b0194adcb9fe474fc7d136a84c6a45f10eefc84` | `fc3ed7b81e58464715d0291402892f22c3d86ea75302645a330390f85d8015c9` |
| `acorn-jsx` | `5e123a5ee3b16fd10fe4b44ef70ff7885f05117fb9ae75f72a0d821f919d423d` | `5ab23edca59b840bc26ba711131a5b649540b70da53d70ae1bbcdb13480c1aa1` |
| `eslint-visitor-keys` | `13f8b0207958a2d504740826e8245bc2b023248136275550907a5569d8659242` | `ae65d53f994f6caaa8bba35b190ef5ba209a2bc9d8dff86a45b0b68fa0700a86` |

The runtime must report Node `v22.23.2` and these exact package versions. The helper continues to use
ESLint's `Linter`, parse each complete module exactly once, and expose measured counts. The graph
oracle, independent cycle traversal, forbidden-form corpus, doubled-parser negative, M26/M27/M32,
exports, and arities remain.

## 5. Authorized artifacts and caps

| Artifact | R3 role | Maximum physical lines |
| --- | --- | ---: |
| `Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` | collision-safe parser-provenance mechanics | 350 |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | remove the stale lockfile oracle while retaining all R2 topology evidence | 1,600 |
| `Tools/patch-prototype/p0b/p0b-parser-provenance.spec.mjs` | exact runtime record, controlled mechanics traces, and R3M-01 through R3M-03 | 300 |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | P0B-F02 chronology and successor evidence | 700 |
| this preregistration | frozen repair authority | 300 |

All other R2 implementation files retain exact bytes and actual shrink-only caps. R3 authorizes no
manifest, lockfile, dependency, production, API, authority, protocol, functional, Gate D, or nonclaim
change.

## 6. R3 acceptance

| ID | Required terminal verdict | Acceptance predicate |
| --- | --- | --- |
| R3A-01 | PASS | R2 prerequisites, all 11 pre-R3 files, result chronology, policy files, and tracked `package.json` rehash before repair |
| R3A-02 | PASS | Git proves root `package-lock.json` is untracked and ignored; the successor clean clone contains and reads no root lock |
| R3A-03 | PASS | The inspector resolves the exact five-package chain and returns the frozen Node/version/path/count/byte/hash record without fallback |
| R3A-04 | PASS | Controlled mechanics bind factory object → two resolve calls → measured paths; R3M-01 through R3M-03 return identical records but wrong plan/factory/consumption traces and reject |
| R3A-05 | PASS | Graph, acyclicity, forbidden forms, measured parses, doubled-parser negative, exports, arities, anchors, and caps remain green |
| R3A-06 | PASS | PRE/FORWARD remain 151/151; protocol 15/15, hostile 20/20, topology 36/36, provenance 2/2, serial P0b 73/73, no skips/cancellations/todos |
| R3A-07 | PASS | All 59 prior controls plus R3M-01 through R3M-03 bite; syntax 20/20, ESLint 20/20, and Prettier over every named artifact remain green |
| R3A-08 | PASS | The clean landing clone reproduces Gate D, P0b gates, exact source hashes, and parser identities without a root lock |
| R3A-09 | PASS | Two fresh independent non-author reviewers rehash one successor, rerun assigned gates, close P0B-F02, and return GO with zero findings |

P0B-19, new P0B-21/P0B-22, and P0B-20 cannot pass unless all rows pass. All other P0b IDs rerun rather
than carry by assertion. Any new measured red supersedes a reviewer GO.

## 7. Required terminal evidence

The result records exact commands, exits, counts, bytes, lines, and hashes for the immutable 70/71
failure; all three failed R3 design reviews; the 13-file source and five-package runtime envelopes;
absence and non-use of the root lock; all five resolutions, controlled plan/factory/consumption/path
traces, R3M-01 through R3M-03, exact public delegation, and an independent digest-v1 recalculation;
PRE/FORWARD, all P0b suites, 62 controls, syntax, ESLint, Prettier, graph, authority/hostile probes,
tracked-reference verification; and two fresh terminal reviews over stable bytes.

It preserves both R2 GOs and explains why the later red governs. It does not relabel P0B-F02 as
infrastructure, erase 70/71, or claim that copying an ignored artifact closes it.

## 8. Review and Git boundary

An independent design reviewer must return GO on frozen R3 before implementation. After implementation,
one fresh reviewer owns protocol/regression replay and one owns hostile/topology/provenance review.
The repair author cannot review.

Only after all R3 gates and both reviews pass may the orchestrator update the clean landing clone and
create a local checkpoint commit. Workers never run Git writes. No push, remote branch, browser, GPU,
network, dependency install, deletion, or external publication is authorized.

## 9. Unchanged nonclaims

R3 does not implement or prove sockets, HTTP, filesystem persistence, durability, deletion, GC,
transport, signatures, freshness, revocation, restart anti-rollback, external/heavy closure, Cesium,
renderer transactions, masks, cache/retirement ownership, WebGL, WebGPU, pixels, performance,
standards promotion, production readiness, or full design §15.0 P0. No historical FAIL, ERROR, or
reviewer blind spot is removed or rescored.
