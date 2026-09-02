# Gandalf — watch-build scheduler race audit

- Status: **HELD RESEARCH RECORD / SOURCE-CONFIRMED WATCH RACES / NO IMPLEMENTATION AUTHORITY**
- Audit role: Gandalf, with independent read-only concurrency analysis by Denethor and adversarial
  test design by Imrahil
- Scope: current WGSL/GLSL generator and development-watch control flow only
- Execution authority: none for implementation, tests, builds, generators, servers, browsers,
  network, evidence publication, process mutation, or Git

This is a research record, not an implementation preregistration, queue row, certification, or
permission to change code. It records what the frozen source tuple establishes and the smallest
later repair boundary that could be preregistered. A new owning queue row, a fresh implementation
preregistration, an explicit non-overlapping lease, and independent review are required before any
code work begins.

## Verdict and claim boundary

Current watcher behavior is **NO-GO** for either of these claims:

1. WGSL or GLSL watch generation is serialized with the rebuild/cache work that consumes it.
2. A completed watcher callback guarantees that every dependent rebuild or cache invalidation saw
   the completed wrapper generation for the triggering source edit.

The audit establishes a source-reachable stale/partial ordering. It did not run a generator, watcher,
build, server, or test, so it does not claim a timed reproduction, affected artifact census, runtime
failure rate, or product regression. A future process-local scheduler can claim only serialization
inside each participating process. It cannot claim repository-wide single-writer authority while
separate `npm start`, `build-watch`, build, release, analysis, or direct-helper processes may write
the same wrapper fleet.

## Confirmed watcher defects

The initial `build()` path correctly awaits GLSL generation and WGSL generation before the build
continues (`gulpfile.js:99-114`). The watch path does not preserve that settlement boundary:

- The GLSL watcher calls `glslToJavaScript(...)` without `await`, then immediately starts the shared
  ESM rebuild and subsequently the optional IIFE and CJS rebuilds (`gulpfile.js:159-170`).
- The WGSL watcher repeats the same fire-and-forget ordering with `wgslToJavaScript(...)`
  (`gulpfile.js:172-184`).
- A third, independently registered source watcher invokes the same ESM/IIFE/CJS contexts and then
  rebuilds workers (`gulpfile.js:186-210`). Its shader exclusions prevent one shader edit from also
  selecting this watcher, but unrelated simultaneous edits can still overlap its callback with a
  shader watcher.

Gulp delegates each `gulp.watch` call to a separate glob-watcher instance and supplies a
callback-style `this.parallel(task)` wrapper (`node_modules/gulp/index.js:28-48`). Glob-watcher
tracks `running` and one `queued` replay inside each individual watcher registration
(`node_modules/glob-watcher/index.js:18-56`), with defaults of a 200 ms delay and `queue: true`
(`node_modules/glob-watcher/lib/normalize-args.js:3-8`). Its async-done boundary observes completion
of the callback-style wrapper. That wrapper passes through Undertaker's parallel composition, Bach,
and now-and-later, which invokes the original task through a nested async-done boundary. Async-done
recognizes callback completion as well as returned Promises, streams, child processes, and
observables (`node_modules/async-done/index.js:51-78`). The original async task's returned Promise
therefore accounts for its awaited rebuilds, but not for a generator Promise that the task invokes
and discards. That discarded work remains outside the completion glob-watcher serializes, and the
three watcher instances still have no shared exclusion around their common rebuild contexts.

The development server has a second watch defect. Its shader watcher registers one async `all`
listener and awaits the selected generator before clearing the three bundle caches
(`server.js:346-372`). Chokidar emits the named event and then `all` synchronously through
`EventEmitter.emit` (`node_modules/chokidar/index.js:454-457`); it does not await the listener's
returned Promise. Multiple shader events can therefore overlap full-fleet generator calls even
though each individual listener body contains `await`.

The same missing-settlement pattern recurs outside the shader path: the add/unlink spec watcher
calls async `createCombinedSpecList()` without awaiting it before `specs.rebuild()`
(`gulpfile.js:212-220`). This recurrence is confirmed but remains outside the proposed shader/source
scheduler lease unless a later owning row explicitly expands scope.

## Generator surface and complete caller census

`wgslToJavaScript` is not one atomic write. It awaits state-file I/O, inventories existing wrapper
files, discovers WGSL sources, reads and writes wrappers through a `Promise.all`, deletes leftover
JavaScript files, and finally writes `chunks/CsmBuiltins.js`
(`scripts/build.js:1139-1167`, `scripts/build.js:1205-1229`,
`scripts/build.js:1237-1259`). A rebuild started immediately after the unawaited function call can
therefore read old wrappers, a partially rewritten fleet, or the interval after the builtins index
was deleted and before it was recreated. This is a source-derived reachability result, not an
executed timing result.

The current source census contains 324 WGSL files and 325 managed JavaScript outputs: one sibling
wrapper for each WGSL file plus `chunks/CsmBuiltins.js`. Every direct executable caller writes this
same output fleet:

| Caller | Settlement | State-file argument | Source |
|---|---|---|---|
| `gulpfile.js::build()` | awaited | `Build/minifyShaders.state` | `gulpfile.js:99-110` |
| Gulp WGSL watcher | **not awaited** | `Build/minifyShaders.state` | `gulpfile.js:172-184` |
| Development-server shader watcher | awaited inside an untracked EventEmitter listener | `Build/minifyShaders.state` | `server.js:360-372` |
| `scripts/run-build-no-tsc.mjs` | awaited | `Build/minifyShaders.state` | `scripts/run-build-no-tsc.mjs:4-12` |
| `scripts/build.js::buildEngine` | awaited | `packages/engine/Build/minifyShaders.state` | `scripts/build.js:1862-1877` |
| `scripts/build.js::buildCesium` | awaited | `packages/engine/Build/minifyWgslBundle.state` | `scripts/build.js:2082-2092` |

This is 6/6 direct executable call sites, 2/2 watcher implementations, and 1/1 WGSL generator
implementation. The three state files record minify freshness independently; they are not locks and
do not coordinate calls using a different state path. Current one-shot startup/build flows await
their calls. Separate processes still have no shared ownership protocol.

## Frozen source boundary

The audit began and terminally rehashed this source tuple. HEAD and tree were read directly from
`.git` metadata without invoking Git. Global dirty-state provenance was not established because
Git commands were prohibited; the exact file and aggregate identities below, rather than a clean
worktree claim, are the review boundary.

| Path or aggregate | Bytes/entries | SHA-256 |
|---|---:|---|
| HEAD commit | — | `b429c5b51871b05e2123ac193f014be775770492` |
| HEAD tree | — | `7d1794d1bf0c590776de237dd123e943d484941d` |
| `gulpfile.js` | 55,310 | `95632F4251BE1C50D49BD05AD97AAA811BCC94DE400377430F7475E8ED472ED5` |
| `server.js` | 24,294 | `BB57ABA60C5634A5961520DB1E2A3083385FB8FE724A0587CAF0A57FA7CCBFA9` |
| `scripts/build.js` | 92,112 | `49B53C6150203BA049271DA55CFFF21E53F37693C41299E3AE31C1DE8541A26E` |
| `scripts/run-build-no-tsc.mjs` | 767 | `8D5C6539DC0EAAA47883B3AA1E70004CBB5DAADF2C95F7292BD442B45105F5AE` |
| `scripts/__tests__/shaderSourceToJavaScript.spec.mjs` | 29,234 | `BA8DAF783013C029176645CD18EDCAE778441B934CF7C2D2FCD63E1D7EB7DCA8` |
| `package.json` | 10,694 | `2A6F6460C7E9F96A03ED1BE4B6D3920033956AC9A3F378398A1ADD7AD30D9D0D` |
| WGSL source manifest | 324 entries / 2,575,286 raw bytes | `6774E84D8C1E7A90885DCCF8AAE8A1C14583994723CF4FE261B29755A8034336` |
| JavaScript wrapper manifest | 325 entries / 2,742,159 raw bytes | `14D50861F511A8D7B13225E3F55AC52C135185A3B88D2BE7396FFC2602668AEF` |

The two aggregate manifests sort paths ordinally relative to
`packages/engine/Source/Shaders/WebGPU` and encode each record as
`path<TAB>bytes<TAB>uppercase-sha256<LF>`. Their manifest byte lengths are 34,304 and 33,761
respectively. All three state files contained the five UTF-8 bytes `false` and shared SHA-256
`FCBCF165908DD18A9E49F7FF27810176DB8E9F63B4352213741664245224F8AA`:

- `Build/minifyShaders.state`
- `packages/engine/Build/minifyShaders.state`
- `packages/engine/Build/minifyWgslBundle.state`

The installed scheduling boundary was also frozen:

| Installed dependency path | Bytes | SHA-256 |
|---|---:|---|
| `node_modules/gulp/package.json` (Gulp 5.0.1) | 1,408 | `A07364A32FC8EF7706F2B3289FA211A39C69163FEC7DE4B27592205F3CA2EF21` |
| `node_modules/gulp/index.js` | 1,422 | `C9C63160D0F825964216D76CBC21321518621C5D9F7AA42A2A4A5876A7F56058` |
| `node_modules/glob-watcher/package.json` (glob-watcher 6.0.0) | 1,123 | `786BC64F55BD03184828B2AB018B0227EDF274E0917F480A09D1CC471AF22B83` |
| `node_modules/glob-watcher/index.js` | 1,213 | `7606B4F540004CA7624207B2EE350052F45C43DE643B05AF763974834B4A93E8` |
| `node_modules/glob-watcher/lib/normalize-args.js` | 618 | `5F31B8FBAE9FC59EDC3C958357AA8250745436680D74351B77CE2DCE5A51A54B` |
| `node_modules/glob-watcher/lib/debounce.js` | 370 | `EBBFC7E06C4B14EFB5278AB862D7EC85B0465B60A89D4BADAEDB22277EA8CADF` |
| `node_modules/undertaker/index.js` | 1,104 | `47AA70458D7FD9BC70059E1E961233C32530E18DB8149EBE9AC2CFD7FEFFE534` |
| `node_modules/undertaker/lib/parallel.js` | 726 | `F07557CF3F83968AC7F62EFCC75DAD6A57974F8773B28084C5864AAAFF38786A` |
| `node_modules/bach/index.js` | 209 | `6E363C51A69E041517D0BDC8433D485DEF52FD1CBCBB42756B46F2067D3996A5` |
| `node_modules/bach/lib/parallel.js` | 511 | `F38D571D72364DB47465AAFA2130F9E73DBB68C6CEE559607EB41FCF049786B2` |
| `node_modules/now-and-later/index.js` | 107 | `1E08D28C9F8C7F4CF23EBA8FFD32C2C04F93632DD0E242C01C628D890A186243` |
| `node_modules/now-and-later/lib/map.js` | 1,644 | `249A7672766788E1CD8B83D95302DA47BE2BA5A538A708F622DDEDADA998538E` |
| `node_modules/async-done/index.js` | 1,582 | `69AACEBF558AEFD415C47905BFF44B08C084B3D22DC3FE1696A1C25CFDA8E701` |
| `node_modules/chokidar/index.js` | 29,452 | `4D1669FF207E874EB6185B8A4F04C1E694120B9EAF6723DDEA1BE7CE5583B164` |

## Why a local `await` is insufficient

Adding `await` only at the WGSL call site would repair the ordering inside that one callback, but it
would not close the full confirmed race:

1. The GLSL watcher has the same dropped Promise.
2. The GLSL, WGSL, and source watchers are distinct glob-watcher instances and can concurrently call
   the same ESM/IIFE/CJS rebuild contexts.
3. The development server's raw chokidar listener has no single-flight boundary.
4. Separate processes still write the same WGSL wrapper fleet without a shared lock.
5. Current SIGINT paths do not first close watcher admission and drain owned work. Gulp disposes
   contexts without awaiting them and immediately exits (`gulpfile.js:233-247`); the server likewise
   starts context disposal before its nested server-close path (`server.js:710-725`).

A WGSL-only `await` is therefore a useful local correction but an insufficient scheduler repair and
an invalid basis for a general watch-safety claim.

## Smallest process-local scheduler

The smallest adequate design is one injected, coalescing coordinator per process. Gulp shares one
coordinator across its GLSL, WGSL, and source callbacks. The server uses another coordinator around
its shader callback. The scheduler has three states:

- `IDLE`
- `RUNNING(activeSnapshot)`
- `RUNNING_WITH_PENDING(activeSnapshot, pendingKinds)`

`request(kind)` accepts `glsl`, `wgsl`, or `source`. Requests made before the scheduled drain
snapshot are batched. A request arriving during active work is accumulated in a fresh pending set;
further equivalent requests join that set instead of creating an unbounded queue. Each cycle clears
its pending snapshot before the first `await`, then runs in deterministic order:

1. GLSL generation when requested.
2. WGSL generation when requested.
3. ESM rebuild.
4. Optional IIFE rebuild.
5. Optional CJS rebuild.
6. Worker rebuild exactly once when the snapshot contains `source`.

An active failure rejects only that snapshot's waiters, skips downstream phases, reports the error
once, resets active state, and continues any later pending snapshot. It must neither swallow the
failure nor poison all future requests. `close()` stops admission and resolves only after admitted
active and pending work settles. Shutdown closes captured watcher handles first, awaits
`scheduler.close()`, awaits context disposal, and only then permits process exit.

The server may use the same generic module with generator and cache-clear callbacks. This does not
make the two processes share a lock. Any future claim broader than per-process watcher serialization
requires a separate, crash-recoverable cross-process ownership design and its own preregistration.

## Exact later lease and exclusions

The later implementation lease is exactly four code paths plus the package runner:

1. `gulpfile.js`
2. `server.js`
3. new `scripts/watchBuildScheduler.js`
4. new `scripts/__tests__/watchBuildScheduler.spec.mjs`
5. `package.json`, solely to add the new spec explicitly to `test-build-infra`

The runner is an explicit file list today (`package.json:154-163`), so a standalone spec without the
fifth-path edit would have no runner home.

The lease excludes:

- `scripts/build.js` and its generator semantics;
- `scripts/__tests__/shaderSourceToJavaScript.spec.mjs`;
- `scripts/createWgslStandaloneShaders.js`;
- all Q130 analyzer, spec, handoff, and queue paths;
- every WGSL source, generated sibling wrapper, `CsmBuiltins.js`, state file, and `Build/**`
  output;
- `package-lock.json`, `node_modules/**`, engine/widget source, other specs, migration records,
  evidence, and every unrelated path; and
- Git, builds, generators, tests, servers, browsers, network, publication, and process mutation
  unless separately authorized for the later lane.

### Collision facts

Faramir's active generator-authority record leases
`scripts/__tests__/shaderSourceToJavaScript.spec.mjs` and its own record, while explicitly excluding
`package.json` and `scripts/build.js`
(`migration_doc/branches/faramir--q130-standalone-wgsl-generator-authority-removal.md:11-25`).
That serializer spec is a foreign live path at 29,234 bytes /
`BA8DAF783013C029176645CD18EDCAE778441B934CF7C2D2FCD63E1D7EB7DCA8`; this audit neither edits nor
reuses it.

The owning fix queue records Q130 Phase A as frozen, still under durable-record review, and not
landed, with Q-130-c2 and the generator carry-forward still open
(`migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:112-118`). `scripts/build.js` remains a
read-only witness in that adjacent work and is excluded from this scheduler boundary.

`package.json` is the required runner-home edit but was also an exact frozen sentry in concurrent
review work during this audit. Root must clear every active package lease/freeze and rehash it before
dispatch. Absence of a direct textual conflict today is not lease authority.

## Deterministic acceptance

All scheduler tests use injected callbacks, deferred Promises, and exact traces. They do not invoke
Gulp, chokidar, the real generators, rebuild contexts, filesystem writers, servers, or processes.

1. **Single WGSL request.** Hold the generator. No rebuild may start before release. After release,
   ESM, optional IIFE, and optional CJS run sequentially and each observes the new wrapper revision.
2. **Event during generation.** While WGSL revision 1 is held, issue multiple WGSL requests and one
   source request for revision 2. No second callback overlaps. Exactly one trailing cycle publishes
   revision 2 and runs workers once.
3. **Event during rebuild.** Hold ESM for cycle 1, then request WGSL revision 2. Cycle 1 finishes its
   rebuild sequence before cycle 2 generation starts; final ESM/IIFE/CJS observations are revision 2.
4. **Same-turn cross-watcher batch.** Synchronous GLSL, WGSL, and source requests become one cycle
   with deterministic generator order, one rebuild sequence, and one worker rebuild.
5. **Generator rejection and recovery.** The failed snapshot rejects with its sentinel and invokes
   no rebuild. A request admitted during the failure runs afterward, and a later valid WGSL request
   succeeds.
6. **Rebuild rejection and recovery.** An ESM rejection prevents IIFE/CJS/workers for that snapshot.
   A later source request completes normally.
7. **Optional contexts.** Missing IIFE and CJS are valid. Shader-only requests never run workers;
   source-containing snapshots run workers once.
8. **Global exclusion.** Across every test, maximum active injected callback count is exactly one.
9. **Shutdown.** `close()` waits for admitted work, rejects post-close requests with a stable closed
   error, and enforces watcher close → scheduler drain → awaited context disposal.
10. **Byte boundary.** Logic-only testing changes no generator, source, wrapper, state-file, or build
    output bytes, and the new spec is named by `npm run test-build-infra`.

Required inertness mutants:

- fire-and-forget generator;
- one scheduler per watcher kind;
- return the active Promise without recording the new kind;
- clear pending state after awaited work;
- rebuild before generation;
- run generators or rebuild contexts through `Promise.all`;
- swallow a rejection or resolve the failed request;
- leave the active latch set after rejection;
- reject or erase later pending waiters with the failed snapshot;
- omit workers or run them for every event;
- resolve `close()` immediately or admit post-close work; and
- add only `await wgslToJavaScript(...)` while leaving the other independent callbacks unchanged.

Inverse controls require valid source-only and shader-only requests to retain their distinct phase
sets, deliberate generator/rebuild failures to remain observable failures rather than green skips,
new requests after failure to recover, optional contexts to remain valid, idle close to resolve, and
post-close admission to reject.

## Superseded physical review history

Two earlier freezes are retained as superseded **NO-GO** records and are ineligible for an
implementation or landing decision:

- `17,574` bytes, SHA-256
  `81106F35B9C502038C2D08E397F5C72292E9A47C2117FA78A31968B5CA097150`. Its review found that the
  aggregate shader manifests were described as ordinal although their hashes used culture-sensitive
  ordering, and that package/version markers did not freeze all load-bearing installed scheduling
  implementations.
- `18,221` bytes, SHA-256
  `297C38904C92E9492892059E4F8372C6E3DDC3BF450D145BA3982DBB77FEEAF1`. Its review independently
  reproduced the corrected ordinal manifests, then found that the completion-account prose reduced
  async-done to returned thenables and that the installed scheduling freeze omitted the directly
  executed glob-watcher debounce, Undertaker, Bach, and now-and-later files.

The first correction changed two non-contiguous semantic regions rather than appending to the first
freeze. This correction likewise changes the completion-account prose and installed dependency table
in place, then adds this review history. Neither transition has an old-prefix/new-append byte lineage;
the complete newly frozen file is the only candidate for the next independent review.

## Prior findings and next authority boundary

- The reported Gulp WGSL watch race is **OPEN and source-confirmed**.
- The identical Gulp GLSL watch race is **OPEN and source-confirmed**.
- The development-server event-overlap race is **OPEN and source-confirmed**.
- The spec-list Promise recurrence is **OPEN**, recorded here, and excluded from the proposed
  shader/source scheduler claim.
- Awaited one-shot WGSL call sites remain **FIXED/clean for this narrow settlement predicate**; this
  record does not certify their output or cross-process exclusion.
- Runtime reproduction, build output, server behavior, browser behavior, and product effect are
  **NOT RETESTED** because execution was prohibited.

No existing queue row owns this watcher repair. Before code, root must create a new owning row that
records the exact per-process claim, cross-process exclusion, five-path lease, acceptance predicates,
mutants, runner home, validation authority, and independent-review requirement. The later writer
must freeze a fresh tuple after collisions clear. A different agent must independently review that
exact implementation tuple before any landing decision.
