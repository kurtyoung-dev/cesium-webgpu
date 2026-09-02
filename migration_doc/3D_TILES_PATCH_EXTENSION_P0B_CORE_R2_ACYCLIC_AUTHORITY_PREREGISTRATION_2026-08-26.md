# 3D Tiles patch extension P0b-core R2 acyclic-authority preregistration

**Date:** 2026-08-26  
**Status:** amended after design-review NO-GO; frozen pending fresh design rereview  
**Scope:** non-weakening repair of P0B-F01 production-cycle and topology-gate failures  
**Lane:** local-only, browser-free, GPU-free, network-free, no Git, no file deletion, no external publication

## 1. Authority and decision

This R2 supplements, and only where expressly stated replaces, the frozen P0b-core base and R1
preregistrations:

| Authority | SHA-256 |
| --- | --- |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_PREREGISTRATION_2026-08-26.md` | `19f2a41c1f6c48e7f21c6d7545c2a454f99265cae419d8733aacf22b888bfb2f` |
| `3D_TILES_PATCH_EXTENSION_P0B_CORE_R1_PREREGISTRATION_2026-08-26.md` | `b4a2a40b92031e0d13a50ecabe15eafc6588e4240cde427f028935a552de8ccf` |

All clauses not expressly replaced remain binding. R2 does not lower a limit, delete a test, waive
acyclicity, promote a nonclaim, or alter the frozen P0a/Gate D tuples.

The first P0b terminal-review candidate is FAIL / NO-GO. Implementation may resume only inside this
bounded repair. P0B-20 restarts from zero after repair; neither review of the failed tuple counts as a
terminal review of its successor.

## 2. Immutable failed tuple and finding

The failed nine-file candidate is frozen as chronology:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `Tools/patch-prototype/p0b/protocol-v0.mjs` | 7,835 | 259 | `b27e630005656c14360aa4d141fa231501a82f84e821808324fd2e4341838308` |
| `Tools/patch-prototype/p0b/seeded-change-stream-v0.mjs` | 25,973 | 695 | `4b26f7b1732b4b7feae7732e1078f35a42c6893c26e578a62ddea6f44f605867` |
| `Tools/patch-prototype/p0b/reference-producer-v0.mjs` | 35,314 | 1,185 | `46bced1d88c969917806fde20eb510248038a6a93756805c9dcd82b6089097a0` |
| `Tools/patch-prototype/p0b/p0a-publication-adapter-v0.mjs` | 22,385 | 700 | `d787c7dbb7bcd0acfa429f1e970e71b57a12ea0052c11e62ddd24d0ed044318b` |
| `Tools/patch-prototype/p0b/content-addressed-store-v0.mjs` | 24,350 | 824 | `7fb3a86d37edb0e83d6f543f13f0b054aec98e45493cb1eca513aec35b3d2681` |
| `Tools/patch-prototype/p0b/head-service-v0.mjs` | 26,087 | 878 | `eb8640a49d754eafb7fd136c5672b9e044c017403b3a649b3f2f5129f31055fc` |
| `Tools/patch-prototype/p0b/p0b-protocol-persistence.spec.mjs` | 30,104 | 886 | `afd7455f3774490ce26eb87f3430e771f681e4c300f72312f3a86a599b0bdf05` |
| `Tools/patch-prototype/p0b/p0b-hostile-boundary.spec.mjs` | 36,715 | 1,108 | `71f397d2681cddd5da26ac362e1fe8804c17625c6de7ce290dacfc41b1fac4f1` |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | 55,751 | 1,590 | `53ebc0715ed73464f5b358abff49b4a8067cef3cd31385edc72323db689db71c` |

The provisional result reviewed with that tuple was 21,260 bytes, 312 lines, SHA-256
`12bd7b22093f8518cfb4f9f78d6408c93c4432d69e042b31e2fa8c161db90828`.

One fresh protocol reviewer returned PASS / GO after all registered gates. A different fresh security
reviewer returned FAIL / NO-GO, exit 1, with HIGH finding P0B-F01. The measured red governs:

1. `head-service-v0.mjs` imported `p0a-publication-adapter-v0.mjs`;
2. the adapter imported the head service, creating a direct production cycle;
3. the topology test declared both edges expected and performed no cycle traversal;
4. its line-oriented scanner stopped after the first non-import statement;
5. a valid late static import was therefore invisible; and
6. M26/M27 bit tailored string oracles without submitting mutated source to the claimed topology gate.

All functional evidence on the failed tuple remains green but cannot override P0B-F01: PRE and
FORWARD 151/151, normalized inventory 7,298 bytes at
`1b6ac268749b579056e495412c9ce1da2b566847e8475b51e2319dbaeb9ad810`, P0b 63/63, 58/58 registered
mutants, syntax, ESLint, Prettier, caps, and exact hashes.

The first R2 design-review candidate was 18,560 bytes, 286 lines, SHA-256
`64b36e9617aee062043fc5eb164da8f53bd1faae8934d474ac2dcb3dc09df166`. Its fresh reviewer returned
FAIL / NO-GO with three open findings: HIGH under-specified stale-preparation ownership, MEDIUM
unfrozen facade/export contracts, and MEDIUM parser provenance outside the exact tuple. Sections
4.1–4.3 and 7–9 below are the non-weakening response. That review remains immutable chronology and
does not count as implementation authorization or terminal review.

## 3. Why a seventh production module is required

The adapter owns frozen-verifier composition while the head must admit only a store-owned Pass-B
publication. A two-module design cannot simultaneously have the adapter call the head and the head
inspect adapter-owned authority without a cycle.

R2 rejects these superficially smaller repairs:

- exporting or injecting a permit issuer, predicate, callback, registrar, shared secret, or operation
  table that an ordinary caller can supply or acquire;
- trusting a function-valued permit or invoking any caller-provided verifier;
- moving the `live-update-v0.mjs` import outside the sole P0a adapter bridge;
- exposing an unguarded low-level CAS and asking callers to preserve the publication order;
- accepting the existing ESM cycle as harmless because current Node evaluation succeeds;
- retaining a regex/line-prefix scanner as the source of topology truth; or
- counting a mutant as killed when its changed source never reaches the asserted policy gate.

A new `publication-authority-v0.mjs` module is therefore authorized. It co-locates the private permit
registry, mutable head authority, admitted-prior pointer, hint/counter state, and sole synchronous
authority assignment. The head service becomes a head-only facade; the adapter becomes a verifier and
store-readback preparation layer. This creates one explicit, testable DAG.

## 4. Replacement production architecture

### 4.1 P0a adapter — verification preparation only

`p0a-publication-adapter-v0.mjs` remains the sole P0b production importer of the frozen
`live-update-v0.mjs`. It may also import the reference producer, protocol, and immutable store. It must
not import the publication authority or head facade.

The adapter owns module-local verification-context and preparation handles. One preparation call:

1. validates its module-minted context and prior-preparation handle before property inspection;
2. snapshots the producer publication and performs R1 Pass A against the admitted record retained by
   the prior preparation, or `undefined` initially;
3. handles `NO_CHANGE` without store work and returns an opaque replay preparation bound to exact
   candidate head bytes;
4. for `COMMITTABLE`, commits the complete immutable batch and reads every member through the public
   store path;
5. constructs fresh closures and performs R1 Pass B from exact readback bytes;
6. requires exact candidate equality and byte-identical encoded prior between Pass A and Pass B;
7. retains the Pass-B record only inside a new opaque preparation handle; and
8. exposes only bounded frozen scalar projections, fresh byte copies, and already-opaque store receipt
   or preparation handles required by the authority.

The adapter cannot seal a fence, mutate a head, install an active prior, advance a counter, expose a
raw admitted record, or mint a head permit. Its inspectors are non-issuing. Cross-context,
cross-store, forged, proxied, or revoked preparation handles reject with zero caller hooks.

The exact public adapter surface is frozen:

| Export | Kind / JavaScript arity | Contract |
| --- | --- | --- |
| `PublicationError` | frozen constant | unchanged bounded adapter error codes |
| `createP0aVerificationContext` | function / 1 | mint a store-bound opaque verification context |
| `prepareP0aPublication` | function / 3 | `(context, publication, priorPreparation)`; `priorPreparation` is exact or `undefined` initially |
| `inspectP0aPreparation` | function / 1 | return a bounded frozen scalar projection; never the admitted record or bytes |
| `copyP0aPreparationHeadBytes` | function / 1 | return a fresh copy of exact owned candidate head bytes |
| `getP0aPreparationReceipt` | function / 1 | return the already-opaque immutable-store receipt or `undefined` for replay |
| `verifyP0aPreparationBinding` | function / 5 | non-issuing predicate over preparation, context, exact prior, receipt, and candidate bytes |

The adapter owns no currentness oracle. A preparation made from a genuine older prior remains a valid
non-authoritative verifier artifact; calling the adapter directly can never install it. Only the
publication authority decides whether the prior is current and whether a sibling won.

### 4.2 Publication authority — one authority and one linearization point

`publication-authority-v0.mjs` owns all module-local service, publisher, predecessor, fence, read,
commit, attempt, and head-permit identities. It imports the adapter's non-issuing preparation API and
never exports a permit issuer, registry, validation callback, mutable authority, or raw graph.

The service's one authority object contains:

- current head bytes, ETag, immutable closure ID, and canonical tuple;
- head mutation count and epoch;
- admitted active adapter preparation, or `undefined` initially;
- non-authoritative hint bytes and publication success count; and
- append-only in-process state-digest and state-revision histories used by rollback/ABA checks.

The high-level publication path captures one exact authority identity, calls the adapter preparation,
and then:

1. for replay, synchronously confirms the captured authority, head bytes, ETag, generation, state
   digest, active preparation, and fence before returning `NO_CHANGE`; stale replay is `CONFLICT`;
2. for a successor, validates the adapter preparation projection and copies exact head bytes;
3. mints a private permit bound by identity to the publisher, predecessor, service/store, adapter
   preparation, immutable receipt, captured authority, and owned candidate bytes;
4. seals the publication fence only after immutable receipt/closure readback and first permit check;
5. precomputes the success projection, head read projection, no-change projection, hint, histories,
   counters, commit handle, and complete next authority;
6. synchronously rechecks predecessor, precondition, closure, fence, adapter preparation, and permit
   immediately before linearization; and
7. performs exactly one authority-pointer assignment that atomically installs the head and active
   Pass-B preparation, hint, histories, and counters.

`beginP0aPublication` stores the captured authority identity and its exact `activePreparation` in the
opaque attempt. `publishP0aPublication` passes only that exact preparation to the adapter, then
requires the service authority still to be the captured identity both after adapter return and at the
final CAS recheck. The private permit additionally binds both the captured prior preparation and the
new preparation. Two sibling preparations from one predecessor may both be valid verifier artifacts;
exactly one can linearize. After the winner assigns a new authority, the losing attempt returns
`CONFLICT` without asking the adapter to decide currentness and without changing either module.

No public authority API accepts a caller-supplied preparation, context, permit inspector, issuer,
registrar, callback, secret, or operations object. The authority creates and retains its own adapter
context when `createP0aPublisher` succeeds; high-level publication invokes the adapter internally.

Nothing after the sole assignment may allocate, parse, hash, freeze, copy, call another module, invoke
caller code, or predictably fail. A CAS loser changes no authority pointer. It may leave only the
already permitted unreachable immutable batch.

Raw head sealing/CAS APIs remain available through the head facade for negative and protocol tests,
but they require an authority-private permit that only the high-level verified path can mint. A caller
that directly creates a head publisher cannot issue or acquire a permit.

The exact public publication-authority surface is the following 19 functions with fixed JavaScript
arity. The first five are the relocated publication API; the remaining 14 preserve the head API:

| Export | Arity | Export | Arity |
| --- | ---: | --- | ---: |
| `beginP0aPublication` | 1 | `captureHeadPredecessor` | 1 |
| `copyP0aHintBytes` | 1 | `compareAndSwapHead` | 4 |
| `createP0aPublisher` | 2 | `confirmCurrentHead` | 3 |
| `inspectP0aPublisher` | 1 | `copyHeadReadBody` | 1 |
| `publishP0aPublication` | 2 | `createHeadPublisher` | 1 |
|  |  | `createHeadService` | 1 |
|  |  | `inspectHeadPredecessor` | 1 |
|  |  | `inspectHeadService` | 1 |
|  |  | `inspectPublicationFence` | 1 |
|  |  | `projectHeadCommit` | 1 |
|  |  | `projectHeadRead` | 1 |
|  |  | `readHead` | 1 |
|  |  | `readHeadIfNoneMatch` | 2 |
|  |  | `sealPublicationFence` | 5 |

No other public export is permitted. In particular, permit issue/inspect, authority inspection,
adapter-context access, and preparation injection are absent.

### 4.3 Head facade

`head-service-v0.mjs` imports only `publication-authority-v0.mjs` and exposes the preregistered
head-only API surface through statically named wrappers or re-exports. It owns no mutable authority,
permit map, verifier bridge, store state, or caller-supplied callback. Importing head-first and
authority-first must produce the same singleton module authority and public behavior.

Its exact exports and arities are the 14 head functions in §4.2, with no publication API, adapter API,
constant, wildcard export, default export, or extra helper. Existing callers may keep importing those
14 names from `head-service-v0.mjs`; publication callers relocate the five high-level P0a names from
the adapter to `publication-authority-v0.mjs`. All three P0b specs must assert the exact export sets and
arity table rather than changing both implementation and expectation freely.

### 4.4 Exact permitted production graph

All static import and re-export edges must equal this graph after local path normalization:

| Module | Permitted module specifiers |
| --- | --- |
| `protocol-v0.mjs` | none |
| `seeded-change-stream-v0.mjs` | `node:crypto`, `../strict-json.mjs` |
| `reference-producer-v0.mjs` | `node:crypto`, `../strict-json.mjs` |
| `content-addressed-store-v0.mjs` | `node:crypto`, `./protocol-v0.mjs` |
| `p0a-publication-adapter-v0.mjs` | `../live-update-v0.mjs`, `./reference-producer-v0.mjs`, `./protocol-v0.mjs`, `./content-addressed-store-v0.mjs` |
| `publication-authority-v0.mjs` | `node:crypto`, `../strict-json.mjs`, `./protocol-v0.mjs`, `./content-addressed-store-v0.mjs`, `./p0a-publication-adapter-v0.mjs` |
| `head-service-v0.mjs` | `./publication-authority-v0.mjs` |

Graph traversal must process all seven production nodes and prove no strongly connected component has
more than one node and no self-edge exists. The exact topological direction is head facade → authority
→ adapter → producer/store → protocol/strict JSON. No production dynamic import, `require`,
`createRequire`, test-support import, or previously forbidden platform/import class is permitted.

## 5. Parser-backed topology evidence

R2 authorizes `Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` as mechanics-only test
support. It uses the repository's installed ESLint parser path to parse complete ECMAScript modules;
parse unavailability or any fatal parse diagnostic is ERROR, with no regex fallback.

The parser prerequisite is frozen as part of the terminal evidence tuple:

| Artifact | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `package.json` | 8,331 | 212 | `dff0b712bc1a35a4718f5d4c0874d5388971d2f2d9fc9b9ce44738dd9a830ec2` |
| `package-lock.json` | 287,599 | 11,801 | `9e20b60aa0eb9d763d2bae50f2b6f6f1dd480eacf7e4a70d7015084c816b043c` |

The helper imports `Linter` from the direct `eslint` development dependency. The terminal runtime must
report Node `v22.23.2`, `require("eslint/package.json").version === "10.8.1"`, and `npm ls eslint
--depth=0 --json` resolving root ESLint `10.8.1`. Drift in either manifest hash or runtime identity is
STRUCTURAL pending a new parser-provenance review; downloading or updating a package is forbidden.

The helper may return frozen source locations, literal specifiers, normalized local edges, and a
topological traversal. It must not contain the permitted graph, forbidden-specifier policy, expected
exports, mutant outcomes, acceptance assertions, or a production validator.

The topology spec owns those oracles and must prove the parser sees:

- imports before and after ordinary declarations/exports;
- multiple static imports on one physical line;
- multiline import declarations;
- `export ... from` and `export * from` edges;
- a forbidden late `node:fs` or test-support import;
- a local edge that creates a cycle and a self-edge;
- comments, strings, regular expressions, and template text that resemble imports without creating an
  edge; and
- every dynamic import, `require`, or `createRequire` occurrence as forbidden rather than invisible.

The test compares the complete parsed graph to §4.4, performs an independent cycle traversal in the
spec, and asserts each production source is parsed exactly once per gate evaluation.

## 6. Mutation replacements

All 27 carried P0a controls and original P0b M01–M31 remain required. R2 strengthens and adds:

- **M26:** insert a valid late static test-support import after an ordinary export; the mutated source
  map must reach the complete policy gate and reject for the test-support edge.
- **M27:** insert a valid late forbidden platform import; the mutated source map must reach the same
  policy gate and reject for the forbidden specifier.
- **M32_PRODUCTION_IMPORT_CYCLE:** insert one otherwise permitted-looking relative edge that recreates
  a production cycle; the mutated source map must reach graph traversal and reject for the exact
  cycle.

Each mutation keeps one unique source anchor, transforms exactly once, parses as a module, and bites
for its intended semantic reason. Merely matching changed text or successfully importing a mutant is
not a sufficient M26/M27/M32 oracle. The terminal requirement is 27 carried plus 32 P0b controls: 59
total.

## 7. Authorized artifacts and line caps

Only these additions or changed P0b paths are authorized by R2:

| Artifact | R2 role | Maximum physical lines |
| --- | --- | ---: |
| `Tools/patch-prototype/p0b/publication-authority-v0.mjs` | combined private publication/head authority and sole linearization point | 1,600 |
| `Tools/patch-prototype/p0b/head-service-v0.mjs` | head-only facade | 200 |
| `Tools/patch-prototype/p0b/p0a-publication-adapter-v0.mjs` | Pass A/store-readback/Pass B preparation only | 700 |
| `Tools/patch-prototype/p0b/test-support/module-graph-v0.mjs` | parser/graph mechanics only | 350 |
| `Tools/patch-prototype/p0b/p0b-protocol-persistence.spec.mjs` | API and authority regression updates | 2,200 |
| `Tools/patch-prototype/p0b/p0b-hostile-boundary.spec.mjs` | new handle/facade/authority hostile coverage | 1,500 |
| `Tools/patch-prototype/p0b/p0b-topology-mutants.spec.mjs` | complete graph gate plus M26/M27/M32 | 1,600 |
| `migration_doc/3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md` | failed-review chronology and successor result | 700 |

The four unchanged production modules and frozen Gate D tuple must remain byte-identical. No package
manifest or lockfile change is authorized. The direct `eslint` development dependency is the only
permitted parser entry; relying on a newly downloaded package is forbidden.

The successor implementation tuple contains the seven production modules, three P0b specs, and
`test-support/module-graph-v0.mjs`: 11 exact files. The terminal parser-provenance envelope adds the
unchanged `package.json` and `package-lock.json`: 13 exact files. After its first clean terminal
freeze, actual implementation line counts become shrink-only caps.

## 8. R2 acceptance

| ID | Required terminal verdict | Acceptance predicate |
| --- | --- | --- |
| R2A-01 | PASS | Base, R1, P0a, Gate D, four unchanged P0b production modules, failed tuple/result, both failed R2 reviews, package manifests, Node version, and ESLint version rehash/resolve exactly |
| R2A-02 | PASS | The parsed static graph equals §4.4, contains all seven nodes, has no self-edge/cycle, and both import orders initialize one authority |
| R2A-03 | PASS | Adapter remains the sole frozen-verifier importer, imports no head/authority, exposes no admitted record, and cannot mutate publication authority |
| R2A-04 | PASS | Authority owns the only permit registry and the sole authority assignment; no issuer/callback/registrar/secret/operation table is exported or injected |
| R2A-05 | PASS | Direct raw-head, forged, proxied, revoked, cross-store/service/context, stale-attempt, losing-sibling, and reused-permit attempts reject with zero caller hooks and no authority drift; old genuine preparations remain non-authoritative artifacts |
| R2A-06 | PASS | One assignment atomically installs head, active Pass-B preparation, hint, histories, and counters after every fallible artifact and final synchronous recheck |
| R2A-07 | PASS | PRE/FORWARD remain 151/151 with exact normalized inventory; all original P0b semantics and limits remain green |
| R2A-08 | PASS | Parser negative corpus is complete; M26/M27 submit changed source to policy; M32 recreates and detects a cycle; 59/59 total controls bite |
| R2A-09 | PASS | Syntax, Node suites, ESLint, Prettier, exports, parser topology, unique anchors, line caps, exact hashes, and nonclaims are green |
| R2A-10 | PASS | Two fresh independent non-author reviewers rehash the same 13-file terminal envelope, rerun all gates/mutants, inspect the graph and authority boundary, and return clean GO |

P0B-17, P0B-19, and P0B-20 cannot return PASS unless all R2A rows pass. P0B-01 through P0B-16 and
P0B-18 must be rerun, not carried by assertion. A reviewer GO that misses an executable parsed cycle
does not outweigh a later measured red.

## 9. Terminal evidence

The successor result records exact commands, exit codes, durations, counts, bytes, lines, hashes, and
all new red chronology for:

1. all frozen prerequisite and failed-tuple rehashes;
2. PRE/FORWARD plus exact normalized inventory;
3. individual and combined P0b suites;
4. all 59 mutation controls;
5. syntax and ESLint over every P0b `.mjs` artifact;
6. Prettier over every changed/new artifact and all named preregistrations/results;
7. complete-parser negative corpus, exact graph equality, cycle traversal, forbidden dynamic forms,
   unique anchors, sole authority assignment, and export/cap scans;
8. head-first, authority-first, and adapter-first fresh imports;
9. direct bypass, two-writer, stale replay, full-cap replay, and post-linearization no-fail probes; and
10. exact initial and terminal hashes of the same 11-file implementation tuple and 13-file
    parser-provenance envelope.

The failed protocol GO and security NO-GO remain in the result chronology. Two entirely fresh
reviewers judge the successor: one protocol/atomicity reviewer and one hostile/topology reviewer. A
repair author cannot review.

## 10. Unchanged nonclaims

R2 does not implement or prove sockets, HTTP parsing, filesystem persistence, durability, deletion,
GC, transport, signatures, trusted freshness, revocation, restart anti-rollback, external/heavy
closure, Cesium integration, renderer transactions, masks, cache/retirement ownership, WebGL,
WebGPU, pixels, performance, standards promotion, production readiness, or full design §15.0 P0.

Renderer, Cesium, WebGL, and WebGPU work remains NO-GO after an R2 PASS until the separately frozen
external-closure, freshness/revocation, transaction, mask, cache/retirement, collision, and accounting
blockers are resolved. No historical FAIL or ERROR is removed or rescored.
