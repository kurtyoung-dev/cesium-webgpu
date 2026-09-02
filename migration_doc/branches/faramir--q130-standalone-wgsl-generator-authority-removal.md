# Faramir — Q130 standalone-WGSL generator-authority removal

- Status: **PHASE 1 REPAIR AFTER THREE REVIEW ROUNDS / ROUND 3 MIXED GO/NO-GO / GENERATOR PRESENT / EXPECTED RED REQUIRED / NOT LANDED**
- Owning finding: Q130 generator carry-forward in
  `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`
- Lane lead: Faramir
- Phase-1 writer: Eomer
- Build, browser, Edge, server, network, install, publication, evidence, process-mutation, Git-write,
  and landing authority: none

## Exact lease and exclusions

Phase 1 may write exactly:

- `scripts/__tests__/shaderSourceToJavaScript.spec.mjs`
- `migration_doc/branches/faramir--q130-standalone-wgsl-generator-authority-removal.md`

`scripts/createWgslStandaloneShaders.js` is read-only in Phase 1 and must remain byte-identical at
20,575 bytes / SHA-256
`49E03F2BD6F81F865A3EAAFAD5DD4C9FE88DD4FBC3665F02D8C0C742A3911AAE` until root observes and
banks the preregistered expected red and explicitly releases Phase 2. Every other path is excluded,
especially `package.json`, `scripts/build.js`, every `.wgsl` source and sibling wrapper, the Q130
analyzer and spec, `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`, root `Source/` build output,
`migration_doc/FEATURE_INVENTORY.md`, and unrelated migration, tool, engine, gallery, asset, evidence,
and campaign files. Concurrent shared-tree changes are foreign and preserved.

## Why removal is the bounded repair

The user explicitly required removal of the stale standalone generator authority. Synchronizing its
fourteen embedded shader copies would preserve a second, manually maintained authority and recreate
the same drift channel on the next source repair. Replacing it with a forwarding shim would preserve
an apparently useful command whose header already names a nonexistent script, despite the absence of
any caller. Deletion removes the duplicate authority without changing the live build path.

The current authority is tracked `.wgsl` source under
`packages/engine/Source/Shaders/WebGPU/`, transformed by
`scripts/build.js::wgslToJavaScript` through `wgslModuleContents` and
`shaderSourceToJavaScript`, producing ignored sibling `.js` wrappers consumed through generated
package barrels and renderer imports. That path supports canonical unminified and canonical minified
wrapper fleets. A fresh clone legitimately has zero ignored wrappers before the build generates them.

## Prior independent pre-removal reviews

Thingol's read-only Q130 generator-authority proposal returned **GO to a bounded removal lane**.
Thingol verified the generator at 20,575 bytes / SHA-256
`49E03F2BD6F81F865A3EAAFAD5DD4C9FE88DD4FBC3665F02D8C0C742A3911AAE`, the pre-Phase-1 serializer
spec at 4,166 bytes / SHA-256
`2BFDF253736DE36698335EE888C5097A670D58311DD8F7DB7D81DAD2A5417334`, all fourteen protected
destinations, the three dangerous drifts below, and all fourteen current wrappers decoding to their
canonical unminified `.wgsl` sources.

Oropher's independent terminal authority census found the removal premise **true but the proof
incomplete until a protected writer census and fresh-clone-safe wrapper gate existed**. Oropher
independently enumerated the same fourteen destinations, generator/spec baselines, no-caller result,
and three dangerous drifts. These are prior read-only reports relayed into this record. They are not
new runtime evidence and do not substitute for the expected-red observation, post-patch validation,
or independent review of the eventual frozen tuple.

### Phase-1 independent review ledger

Beleg is the independent test/negative-control reviewer; Gwindor is the independent
reachability/build-authority reviewer. The entries below are durable transcriptions of their mailbox
verdicts because the exact three-path lease provides no separate reviewer-artifact path.

- **Round 1 — serializer spec 17,130 bytes /
  `29016C87A6695C1B2EF103FB1225E8D040C5CA6B5C3F56AF87E8D6FE19100606`; record 9,008 bytes /
  `AFB6AFD0796FB4EFD9156D07FB65BBF6F8AC4C4F5CB90243694B176BC45C8E98`; generator unchanged.**
  - **Beleg: NO-GO.** Only the 13-of-14 partial-wrapper case was exercised, not every cardinality
    one through thirteen. The writer census scanned only `scripts/**` while claiming coverage of
    any script, so a writer moved under `Tools/**` was invisible.
  - **Gwindor: NO-GO.** Scripts-only discovery also left root launchers and other executable trees
    invisible while the synthetic renamed and single-path controls bypassed live discovery. The
    atomic landing boundary omitted the stale `migration_doc/FEATURE_INVENTORY.md` correction.
- **Round 2 — serializer spec 18,002 bytes /
  `A26CBFD33A819C882247095448BACFC0BAA529CDC58F6A67FC7C28324901910E`; record 9,480 bytes /
  `CC53EDBB167958514D1349C6F8D1CD27F71DCA1FE9F8D59330884E8F51EAA740`; generator unchanged.**
  - **Beleg: NO-GO.** The `Tools/**` moved-copy fixture bypassed discovery through a prebuilt source
    map, so removing the `Tools` root or an admitted extension would survive. Discovery also traversed
    124 mutable visual-regression output files totaling 73,304,917 bytes, making runtime and the
    expected sole red depend on local evidence absent from fresh clones.
  - **Gwindor: NO-GO.** The same prebuilt-map control let `Tools`-root deletion survive, and recursive
    discovery included ignored generated output. The reviewed census was therefore artifact-dependent
    and unbounded at about 100 MB instead of approximately 26.9 MB.
- **Round 3 — physical serializer spec 28,320 bytes /
  `F8D6393A1C66BFDC9AF7C5BDE9DBAB0CBD67441AA83ED22A243F7BA88D9466F1`; record 15,013 bytes /
  `9DCA91C6C9B7C208785BD39A92728A91A1F44AA58CB707F21650B8A2860A1D7C`; generator unchanged.**
  - **Beleg: unconditional GO for the Phase-1 oracle design.** No required finding remained; the
    approval did not constitute the required post-deletion review.
  - **Gwindor: NO-GO.** Six ignored bake artifact roots remained unexcluded, including five ignored
    `.mjs` files physically read from `Tools/moon-albedo-bake/work`; the census was not
    fresh-clone/evidence-independent. The prior two-round ledger also lacked named, per-reviewer
    dispositions and findings or a durable reference to them.

The mixed Round-3 verdict is **NO-GO**. All three reviewed tuples are superseded and none is landing
evidence. This repair preserves the generator byte-for-byte, retains the in-memory filesystem adapter,
adds the six bounded bake artifact roots to exclusion-before-enumeration/read controls, and requires a
new physical freeze plus two fresh independent reviews.

### Phase-1 physical materialization prediction audit

The third Phase-1 repair was preregistered with this predicted postimage tuple:

- serializer spec 28,314 bytes / SHA-256
  `03DB1B41EF3946E5C2B1169EAC7FB85899560AAC352C9BC6BDCDDC0AE3A45FD1`;
- this record 12,419 bytes / SHA-256
  `26485745FAFBACFE50A418EDAA36167B2C607AE65B965077EFB357292DF6014D`; and
- unchanged generator 20,575 bytes / SHA-256
  `49E03F2BD6F81F865A3EAAFAD5DD4C9FE88DD4FBC3665F02D8C0C742A3911AAE`.

After root materialized the accepted literal patch, the observed physical tuple was:

- serializer spec 28,320 bytes / SHA-256
  `F8D6393A1C66BFDC9AF7C5BDE9DBAB0CBD67441AA83ED22A243F7BA88D9466F1`;
- this record at the exact predicted 12,419-byte identity above; and
- generator at the exact unchanged identity above.

The predicted serializer-spec candidate was ephemeral and was not retained. Its byte count and hash
are withdrawn as an instrument/provenance red. No byte-for-byte diff against that vanished candidate
can be reproduced, so no offset, inserted or deleted byte sequence, or character-level cause is
claimed; supplying one would fabricate provenance.

Read-only checks against the physical serializer spec ruled out these bounded explanations:

- it has no UTF-8 BOM, contains 857 LF bytes and zero CR bytes;
- deleting each of its 28,315 possible contiguous six-byte spans produced no predicted hash;
- deleting every combination of six blank-line LF bytes among the 26 blank lines in the newly
  materialized regions tested 230,230 candidates and produced no predicted hash;
- removing the six physical literal backslash bytes at lines 81, 158, 448 and 549 produced 28,314
  bytes / SHA-256 `890F55DAB714EC93209F5EC2669AF766052EAC3BE3A1A11C7481C490E5C6C24D`,
  not the predicted hash; and
- the old collector signature and live call are absent; the new collector, repository adapter and
  in-memory filesystem helper occur once; both new census tests occur once; each of the three
  exclusions occurs four times; and the placeholder census is zero.

The record matched its predicted identity and the generator remained unchanged, which rules out
record or generator drift but does not recover the vanished candidate. The conclusion is limited to
physical structural fidelity to the intended repair shape and the absence of a detected framing,
placeholder or old-topology residue. It does not establish byte equivalence to the vanished candidate
and does not authorize testing, generator deletion or landing. Any review tuple must cite the observed
physical serializer identity and this updated record.

## No-caller and usefulness proof

Both reviews found no package runner, gulp/build caller, source import, or spec caller for
`scripts/createWgslStandaloneShaders.js`. Its header says to run the nonexistent
`scripts/createMissingFeatureShaders.js`; its implementation is an unwired, current-working-directory
relative, unconditional writer of fourteen tracked source files. It provides no capability absent
from the canonical `.wgsl` sources and build transformer. The file is therefore not a live generation
path whose compatibility must be retained.

## Dangerous stale outputs

Running the generator can silently overwrite three reviewed sources with older bytes:

| Protected source | Current canonical bytes / SHA-256 | Embedded bytes / SHA-256 | Regression restored by the embedded copy |
| --- | --- | --- | --- |
| `Classification/ShadowVolumeAppearance.wgsl` | 2,627 / `72FF12B232713C066B6DB993491589227B81EA64AD597E868C1B2F538D1EBBF3` | 1,586 / `031B151ECACE866972CEF8CBBFCFD8C2B82E4C77D692519DFD47EC1497960BF9` | Replaces high/low positions and relative-to-eye transform with one `position: vec3<f32>` and direct model-view/model-view-projection multiplication. |
| `Classification/VectorTile.wgsl` | 1,778 / `74E17794CBB1C65E828122311B68C51D72A6037F7A9F37CB96F91D8369E7ED6A` | 856 / `2CE9F931DF14B2C053D9A5A6B6BCE19979E94A54CAFE8720C1F5D85A0B76DE2E` | Replaces high/low positions and relative-to-eye transform with one `position: vec3<f32>` and direct model-view-projection multiplication. |
| `Voxels/VoxelRayMarch.wgsl` | 1,800 / `6AC941C3F66F43A5EFC1A673366463D2AB618CFFAA6245D981CCDF5BFC4D8A33` | 1,790 / `0F35A719EDB8F0CB47FA34B563BC77D7448715562D8B2DEF0B2D5057A6D30AE8` | Replaces canonical `textureSampleLevel(..., 0.0)` with implicit-derivative `textureSample(...)` inside the ray-march flow. |

The first two are hard fork-RTE regressions. The third reopens the Q130 implicit-sample finding. No
measured red is hidden or reclassified by removing their stale writer.

## Preregistered Phase-1 gates and negative controls

The serializer spec owns a fixed, unique fourteen-path protected census. Its repository assertion
must fail while any `.cjs`, `.js`, `.mjs`, or `.ts` tooling source under the governed `scripts/**`
and `Tools/**` roots combines a file-write primitive with any protected destination; it must not
depend on the historical generator filename. The expected Phase-1 red is exactly the still-present
`scripts/createWgslStandaloneShaders.js` finding over all fourteen paths. Executable roots outside
those two tooling trees are not claimed by this bounded census.

The collector's deterministic repository-relative input contract is exactly:

- roots `scripts/**` and `Tools/**`;
- admitted file extensions `.cjs`, `.js`, `.mjs`, and `.ts`; and
- excluded directory roots `Tools/visual-regression/output/**`,
  `Tools/readme-screenshots/output/**`, `Tools/process-supervisor/target/**`,
  `Tools/moon-albedo-bake/work/**`, `Tools/moon-albedo-bake/out/**`,
  `Tools/skybox-bake/work/**`, `Tools/skybox-bake/out/**`,
  `Tools/star-catalog-bake/work/**`, and `Tools/stbn-bake/out/**`.

Each excluded directory is rejected before directory enumeration or file read at or below that root.
The four bake-local `.gitignore` files identify exactly six additional ignored artifact roots: moon
albedo work and out, skybox work and out, star-catalog work, and STBN out. Gwindor's Round-3 finding
enumerated those same six roots. Faramir's first relay mistakenly called the count seven while listing
only those six; the relay was corrected before this repair. The binding count and test scope are six.

These exclusions bound the source-authority census; they do not assert that mutable visual output,
screenshot output, supervisor targets, bake work/output, or evidence-like artifacts are empty or safe.
The serializer spec itself, `scripts/__tests__/shaderSourceToJavaScript.spec.mjs`, is ignored before
file read because its in-memory adversarial fixtures intentionally contain protected destination and
write-primitive literals.

The writer controls require:

- a renamed full-fleet copy is detected;
- a full-fleet copy moved from `scripts/**` to `Tools/**` is detected;
- a writer naming only one protected path is detected;
- a pure in-memory filesystem adapter drives the collector across fixed fixtures for both roots and
  every admitted extension, and one-at-a-time root and extension omission mutants prove that each
  input is active;
- the serializer spec exclusion is proven before read, while removing that exclusion exposes and
  classifies its synthetic protected writer;
- files beneath every excluded artifact root are absent from both directory-read and file-read
  traces and cannot be classified, while removing each exclusion independently forces traversal,
  read, and an exact protected-writer finding;
- `scripts/build.js` wrapper generation remains valid;
- the legitimate Slang compiler output under `Shaders/WebGPU/Generated/` remains valid;
- a read-only protected-path reference remains valid; and
- shader semantics such as `textureSample` outside a protected destination do not become a writer
  finding.

The wrapper gate derives expected bytes in memory through the existing `wgslModuleContents` and
`shaderSourceToJavaScript` helpers and never imports or executes the destructive generator. It accepts
exactly zero protected wrappers, one complete fourteen-wrapper canonical unminified fleet, or one
complete fourteen-wrapper canonical minified fleet. The controls require every partial cardinality
from one through thirteen, one stale wrapper, an invalid wrapper, mixed minified/unminified fleets,
and wrappers retained across a canonical source change to fail.

These destination and wrapper controls complement, rather than replace, the Q130 derivative-uniformity
analyzer. They do not change its semantic rules, its Q-130-c2 module-assembly boundary, any `.wgsl`
source, or any live renderer consumer.

## Expected-red-before-delete protocol

1. Materialize only the two Phase-1 writable paths and confirm the generator's pinned bytes are
   unchanged.
2. Freeze the two Phase-1 writable files plus the still-present generator.
3. Root, not the worker, runs the focused serializer spec under separately held test authority.
4. The run must fail on the live protected-writer census, naming the generator and all fourteen paths;
   wrapper coherence and every mutation/negative control must remain green. Any other red stops the
   lane and reopens Phase 1.
5. Bank the complete expected-red output without reclassification.
6. Only then may root explicitly release Phase 2, whose sole source mutation is deletion of
   `scripts/createWgslStandaloneShaders.js`. The focused spec must then be rerun and independently
   reviewed over a new frozen tuple.

No deletion, test, build, browser, server, process mutation, Git action, publication, or external
state change occurred in the Phase-1 writer pass.

## Freeze and landing hold

The preimage collision audit found the serializer spec at 4,166 bytes / SHA-256
`2BFDF253736DE36698335EE888C5097A670D58311DD8F7DB7D81DAD2A5417334`, this record absent, and the
generator at the pinned 20,575-byte identity above. After root materializes this exact patch, root
must report the raw byte count and SHA-256 of the modified spec and this record, plus terminally rehash
the still-present generator. This file cannot contain its own raw terminal hash without changing
that hash; the external terminal tuple is therefore the authoritative Phase-1 freeze and must be
attached to the review dispatch.

Landing remains held after Phase 1 and after a Phase-2 green. The source deletion, protected gate,
this record, the owning Q130/FIX_QUEUE status update, and the stale `FEATURE_INVENTORY.md` row that
currently classifies the generator as part of the shipped WGSL build pipeline must be available for
one atomic reviewed landing. The queue and inventory remain outside this worker lease; root owns
their correction. No partial landing may claim the generator-authority finding closed.

## Expected-red oracle attempt A1 — infrastructure ERROR

A1 intended to run this child from the repository root under root's separately held test authority:

```text
CWD: F:\Dev\GH\cesium-webgpu
node --test scripts/__tests__/shaderSourceToJavaScript.spec.mjs
```

The evidence wrapper failed before child spawn. Its relative-only `stable()` helper evaluated
`path.relative(repo, process.execPath)` even though the repository and Node executable are on
different drives. With Node at `C:\Program Files\nodejs\node.exe`, `path.relative` returned an
absolute cross-drive path. Passing that result to `path.join` formed this invalid path:

```text
F:\Dev\GH\cesium-webgpu\C:\Program Files\nodejs\node.exe
```

`fs.statSync` then threw `ENOENT`. The visible message identified
`ENOENT: no such file or directory, stat
'F:\Dev\GH\cesium-webgpu\C:\Program Files\nodejs\node.exe'`. The outer evidence-wrapper execution
exited 1 after 0.419272841 seconds. The pre-census was `[]`; the post-census was `[]`.

This attempt is governed **ERROR**, not the preregistered test **FAIL**. No child was spawned, no TAP
or product/test measurement exists, and the expected protected-writer red remains unobserved. The
generator must remain present and deletion stays held. The wrapper produced no receipt because it
failed before its receipt path. Consequently raw stdout/stderr separation, raw-stream hashes, UTC
start and end timestamps, and the post-snapshot were not captured. Those fields are explicitly
missing and make A1 structurally incomplete as evidence; they are not reconstructed from console
fragments or inferred after the fact.

Immediately before A1, root's hash check reported this exact six-file preflight tuple:

| Witness | Bytes | SHA-256 |
| --- | ---: | --- |
| `scripts/__tests__/shaderSourceToJavaScript.spec.mjs` | 29,234 | `BA8DAF783013C029176645CD18EDCAE778441B934CF7C2D2FCD63E1D7EB7DCA8` |
| `scripts/createWgslStandaloneShaders.js` | 20,575 | `49E03F2BD6F81F865A3EAAFAD5DD4C9FE88DD4FBC3665F02D8C0C742A3911AAE` |
| this record before the A1 append | 17,264 | `CEF8BF71A69D1655EB7C1384C77B4622E255FE0AF654A3B85A5F5BC5DE20A738` |
| `Tools/visual-regression/q130-wgsl-derivative-uniformity.spec.mjs` | 27,114 | `FEE0926EED0E2E6430EBAFA8D95EB43B78E86FA6622AC04420F1BC8389740F5C` |
| `Tools/visual-regression/lib/wgsl-derivative-uniformity.mjs` | 20,923 | `AB0F59DE13092DBB003FC54A710479BD5AB2B8E00B764929F340E66FEA66BD56` |
| `scripts/build.js` | 92,112 | `49B53C6150203BA049271DA55CFFF21E53F37693C41299E3AE31C1DE8541A26E` |

The absence of a captured post-snapshot prevents A1 itself from proving post-attempt byte equality;
the empty post-census proves only that the wrapper observed no matching surviving process. No whole-
tree cleanliness, test behavior, semantic Q130 result, post-deletion green, build, browser, landing,
or closure claim is made. No retry was permitted before this append-only A1 bank. Any retry remains
subject to a fresh read-only completeness review and root's separate execution authority. This record
cannot contain its own terminal identity, so the appended byte count, EOL census and SHA-256 must be
banked externally.

## Expected-red oracle attempt A2 — launch/evidence preregistration

A2 is a preregistered replacement for the failed evidence wrapper, not a retry result. The frozen A1
record preimage is 20,425 bytes / SHA-256
`406DFDEA4E430A2A018442C627C8B41654D6AD815D9C04AD8AB1B679DBEB932D`, UTF-8 without BOM, with 306
LF bytes, zero CR bytes and a terminal LF. Its first 17,264 bytes are byte-identical to the pre-A1
record at SHA-256 `CEF8BF71A69D1655EB7C1384C77B4622E255FE0AF654A3B85A5F5BC5DE20A738`
with 256 LF bytes. The A1 append begins with one separator LF followed by
`## Expected-red oracle attempt A1` and is exactly 3,161 bytes / SHA-256
`896F5D10757A51434B447A209CDE9ADDF9FF4DA72B8C70C2F428D4B70C7128E1` with 50 LF bytes. This A2
append preserves that entire prefix. Because this record cannot contain its own terminal identity,
root must freeze the physical post-A2 record before any execution review or release.

### Executable and repository-path contract

The logical child command remains exactly:

```text
CWD: F:\Dev\GH\cesium-webgpu
node --test scripts/__tests__/shaderSourceToJavaScript.spec.mjs
```

The wrapper must capture the exact original `process.execPath` string as `executablePath` and require
`path.isAbsolute(executablePath)`. That same unchanged string is the only executable path permitted
for stat, hashing and spawn. It must never pass through `path.relative`, `path.join`, `path.resolve`,
realpath substitution or repository rebasing. Spawn uses `shell: false`, repository CWD
`F:\Dev\GH\cesium-webgpu`, and exact arguments
`["--test", "scripts/__tests__/shaderSourceToJavaScript.spec.mjs"]`. The receipt records both the
exact executable path and the stable logical command above.

Filesystem paths and display labels are separate types. `displayLabel(absolutePath)` may produce a
repository-relative label only after containment is proven; otherwise it emits an explicitly external
label. A display label must never feed stat, hash, open, snapshot or spawn. Repository witness inputs
must be nonempty relative paths. Absolute or drive-qualified inputs, NUL bytes and lexical traversal
are rejected before filesystem access. Resolution is against the frozen repository root with
case-aware Windows containment, and existing ancestors must not escape through a symlink, junction or
other reparse point before any witness read.

### Receipt lifecycle and captured fields

Before executable stat/hash or any other risky preflight, the wrapper must:

1. assign the stable A2 attempt ID and claim boundary;
2. capture UTC and monotonic start values;
3. initialize a receipt with `phase2ReleaseEligible: false`; and
4. create and open distinct raw child-stdout and child-stderr artifacts.

Executable validation, executable identity, witness snapshots, process census, spawn, child-event
collection, stream finalization and TAP parsing run inside one `try/catch/finally` lifecycle. The
`finally` path attempts the post-census and post-witness snapshot, captures the UTC and monotonic end,
closes and hashes both raw stream artifacts, maps the terminal status, and writes the terminal receipt.
A pre-spawn exception must therefore still produce zero-byte child streams with their actual empty-
stream SHA-256 values, structured bounded diagnostics, post-attempt census/snapshot attempts, duration
and a receipt. Receipt-finalization failure is itself `ERROR`; no observation is banked without a
terminal receipt whose bytes and SHA-256 are computed externally.

The terminal receipt must contain:

- attempt ID, purpose and the pre-deletion writer-oracle-only claim boundary;
- wrapper source bytes/SHA-256 and the frozen physical post-A2 record identity supplied by root;
- repository root, logical command, exact executable path, and executable pre/post bytes/SHA-256;
- UTC start, spawn-attempt, spawn-success, child-exit, child-close and end timestamps plus monotonic
  duration;
- wrapper PID/PPID, whether spawn was attempted and succeeded, child PID, exact argv/CWD, child exit
  code and signal, timeout state, and `error`/`exit`/`close` event topology;
- separate raw stdout and stderr artifact paths, byte counts and SHA-256 values without reconstructed
  or merged content;
- bounded structured infrastructure diagnostics, including any pre-spawn exception;
- pre/post byte counts and SHA-256 values plus equality decisions for the serializer spec, generator,
  this record, semantic Q130 spec, analyzer library and directly imported `scripts/build.js`;
- pre/post process censuses, the exact census predicate, raw rows and their SHA-256, plus any census
  error; and
- TAP parse completeness, every subtest disposition, topology counts, exact failure identity, writer
  finding and ordered protected-path census, followed by raw child status, governed status, wrapper
  exit, `acceptanceMatch` and `phase2ReleaseEligible`.

The witness set is bounded to those six repository files and the external Node executable. It makes no
whole-tree cleanliness claim. `phase2ReleaseEligible` remains false unless every executable, wrapper,
record, witness, stream, census, child-event, TAP and acceptance predicate is present, internally
consistent and exact. Even a true evidentiary eligibility flag does not release deletion; only root may
issue the separately required explicit Phase-2 release after banking and review.

### Status, exit and acceptance fold

- Executable stat/hash/spawn failure or other wrapper runtime failure is governed `ERROR`, wrapper
  exit 2, `acceptanceMatch: false` and no release.
- A malformed or unbounded witness, incomplete/malformed provenance or TAP, identity drift, missing
  terminal field, or contradictory event/census/stream topology is `STRUCTURAL`, wrapper exit 3,
  `acceptanceMatch: false` and no release.
- The exact preregistered product red is retained as governed `FAIL`, wrapper exit 1 and may set
  `acceptanceMatch: true` only after all other predicates are complete. It is never relabeled `PASS`.
- Any other complete product red remains `FAIL`, wrapper exit 1, `acceptanceMatch: false` and stops the
  lane. An unexpected complete child green retains its raw `PASS` result but does not satisfy this
  expected-red gate; `phase2ReleaseEligible` remains false and deletion stays held.

The only accepted pre-deletion TAP topology is 15 tests, 14 pass, one fail, zero cancelled, zero
skipped and zero todo. The sole failing subtest is
`no script retains write authority over a protected standalone WGSL source`; its assertion message
begins `protected standalone WGSL writers remain:`. Its actual finding is exactly one writer,
`scripts/createWgslStandaloneShaders.js`, naming these protected paths in this order:

```text
chunks/functions/csm_atmosphereCommon.wgsl
Model/ModelAtmosphereStage.wgsl
Model/ModelCPUStylingStage.wgsl
Model/ModelPointCloudStylingStage.wgsl
ViewportQuad.wgsl
Classification/ShadowVolume.wgsl
Classification/ShadowVolumeAppearance.wgsl
CloudNoise.wgsl
Classification/Vector3DTileClampedPolylines.wgsl
Classification/Vector3DTilePolylines.wgsl
Classification/VectorTile.wgsl
Classification/PolylineShadowVolume.wgsl
Voxels/VoxelIntersection.wgsl
Voxels/VoxelRayMarch.wgsl
```

Every serializer, discovery, nine-root exclusion, omission mutant, writer negative control, wrapper
coherence control and shared-build-serializer subtest must be green. Any missing or additional failure,
writer or protected path rejects the acceptance match without de-scoring an observed red.

### Required A2 controls and mutants

- With repository root on `F:` and executable `C:\Program Files\nodejs\node.exe`, the exact cross-drive
  executable string reaches injected stat, hash and spawn unchanged; no repository prefix is added.
- Same-drive external executable `F:\Program Files\node.exe` remains external and unchanged rather
  than being rebased below the repository.
- Repository witness `..\outside` is rejected before stat/read/hash, with every injected filesystem
  read counter remaining zero.
- An injected `ENOENT` for a missing absolute executable produces a complete pre-spawn `ERROR` receipt,
  two correctly hashed zero-byte child streams, zero spawn calls, post-census and post-snapshot
  attempts, wrapper exit 2 and no release.

Those controls must turn red if a mutant joins the executable to the repository, uses a display label
for filesystem I/O, removes repository-witness containment, or initializes the receipt or raw stream
artifacts after executable stat. A2 must not run unless each control is present in the reviewed wrapper
and bites its named mutant.

A2 has not been executed. No child, test, npm, build, browser, network, Git, generator, evidence
publication or process action occurred while authoring this preregistration. A2 remains held until root
freezes the physical post-A2 record, a fresh independent read-only reviewer returns unconditional GO
for that exact identity and wrapper shape, and root separately grants execution authority.

An unexpected complete child green retains raw child status `PASS`, but because it misses the
preregistered expected-red predicate its governed status is `FAIL`, wrapper exit 1,
`acceptanceMatch: false`, `phase2ReleaseEligible: false`, and deletion remains held.

## A2 V2 physical-wrapper supersession -- all execution held

This section is the append-only materialization record for the A2 V2 wrapper. It does not revise the
A1 `ERROR`, the Phase-1 review ledger, the preregistered expected-red topology, any negative control,
or any release sentry above.

The earlier prepared wrapper payload was described in the orchestration history only as 46,076 bytes
with the abbreviated SHA-256 label `2810...A56`. Its first materialization payload was lost before any
physical file was created. It never existed as a complete workspace file, was never rehashed here,
reviewed, self-tested or executed, and cannot be reconstructed from the abbreviated label. That
never-materialized payload is superseded rather than corrected, recovered or treated as evidence.

The replacement wrapper now exists physically at
`Tools/visual-regression/output/q130-wgsl-generator-removal-a2/expected-red-wrapper.mjs` with this
exact identity:

- 48,963 bytes;
- SHA-256 `5A5F50A4BB5D574ACEFBE185A34B39D646700F490D7A31B1310521EF29169214`;
- 1,660 LF bytes, zero CR bytes, no UTF-8 BOM and a terminal LF.

It was materialized through seven ordered, append-only checkpoints:

| Checkpoint | Bytes | LF bytes | Orchestration hash label |
| ---: | ---: | ---: | --- |
| 1 | 7,591 | 238 | `EBCD...0791` |
| 2 | 14,045 | 475 | `A15E...B93F` |
| 3 | 21,627 | 712 | `57AC...6F48` |
| 4 | 28,353 | 949 | `DAD1...0A4D` |
| 5 | 34,617 | 1,186 | `ADD8...06A0` |
| 6 | 41,627 | 1,423 | `EBF2...6A00` |
| 7 | 48,963 | 1,660 | `5A5F50A4BB5D574ACEFBE185A34B39D646700F490D7A31B1310521EF29169214` |

The first six labels are intentionally recorded exactly as the abbreviated lineage labels supplied
by the orchestration handoff. They are not promoted to cryptographic identities; their full hashes
remain in that handoff, and no omitted characters are guessed here. The final checkpoint is the
complete physical wrapper and carries the full independently recomputable identity above.

### Binding scope and holds

- The wrapper is read-only after materialization. This record is the only path modified by this
  supersession pass.
- The A2 launch contract, status fold, accepted TAP topology, exact protected-path order, witness
  boundary, receipt lifecycle, cross-drive controls, containment controls, missing-executable
  control, four required biting mutants and no-op-mutant sentry above remain unchanged.
- `--self-test`, `--run`, the focused serializer spec, the destructive generator, Node, npm, build,
  browser, Edge, server, network, process mutation, publication, evidence and Git execution all
  remain held. No child was spawned, no receipt or raw stream artifact was created, and no product or
  infrastructure result is claimed by materialization.
- `scripts/createWgslStandaloneShaders.js` remains present. Phase 2 deletion remains held, and this
  record does not authorize implementation, deletion, landing or closure.

Before any execution release, root must freeze the physical post-append identity of this record and
terminally rehash the wrapper. Two fresh independent read-only reviewers must then review that exact
two-path tuple: one for semantics, security, spawn fail-closed behavior and A2 acceptance; the other
for test integrity, inert self-test boundaries, biting mutants, removal proof, runner/provenance and
preservation of the prior history. Either hash drift or a conditional verdict is `NO-GO`. Only two
unconditional `GO` verdicts permit root to consider a separately authorized inert self-test; they do
not themselves authorize A2 production execution, generator deletion, evidence publication or
landing.
